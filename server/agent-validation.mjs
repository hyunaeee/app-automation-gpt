import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Runs the generated MCP process and tests its actual protocol without model credentials. */
export async function validateMcpDirectory(directory, { signal } = {}) {
  const checks = [], client = new Client({ name: 'launchpad-validator', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(directory, 'agent-mcp.mjs')], cwd: path.resolve(directory), stderr: 'pipe', env: Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE'].filter(key => typeof process.env[key] === 'string').map(key => [key,process.env[key]])) });
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const abort = () => { void transport.close(); };
  let timer;
  try {
    combined.throwIfAborted();
    combined.addEventListener('abort', abort, { once: true });
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('MCP 검증 제한 시간(20초)을 초과했습니다.')); }, 20000); });
    await Promise.race([client.connect(transport), deadline]);
    transport.stderr?.on('data', () => {});
    checks.push({ name: 'MCP stdio 초기화', passed: true, detail: '공식 SDK 클라이언트가 생성된 프로세스와 initialize 핸드셰이크를 완료했습니다.' });
    const options = { signal: combined, timeout: 8000 };
    const list = await client.listTools({}, options);
    const names = list.tools.map(tool => tool.name).sort();
    const complete = JSON.stringify(names) === JSON.stringify(['ai','analyze','checklist']) && list.tools.every(tool => tool.inputSchema?.properties?.input?.type === 'string');
    checks.push({ name: 'MCP tools/list', passed: complete, detail: complete ? 'analyze·checklist·ai와 실제 입력 스키마를 조회했습니다.' : '도구 목록 또는 입력 스키마가 계약과 다릅니다.' });
    const analysis = await client.callTool({ name: 'analyze', arguments: { input: '검증 문장입니다.' } }, undefined, options);
    checks.push({ name: 'MCP tools/call 분석', passed: !analysis.isError && analysis.content?.some(part => part.type === 'text' && part.text.includes('문자 수:')), detail: '별도 stdio 프로세스에서 로컬 텍스트 분석을 호출했습니다.' });
    const checklist = await client.callTool({ name: 'checklist', arguments: { input: '첫 작업\n둘째 작업' } }, undefined, options);
    checks.push({ name: 'MCP tools/call 체크리스트', passed: !checklist.isError && checklist.content?.some(part => part.type === 'text' && part.text === '1. 첫 작업\n2. 둘째 작업'), detail: '두 항목의 변환 결과를 확인했습니다. 모델 API는 호출하지 않았습니다.' });
  } catch (error) {
    checks.push({ name: 'MCP stdio 실행', passed: false, detail: error?.name === 'AbortError' || signal?.aborted ? '검증이 취소되었습니다.' : String(error?.message || 'MCP 연결 실패').slice(0, 250) });
  } finally {
    clearTimeout(timer); combined.removeEventListener('abort', abort);
    await client.close().catch(() => {}); await transport.close().catch(() => {});
  }
  return checks;
}
