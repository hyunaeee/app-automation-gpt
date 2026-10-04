import fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runAgent } from './agent-core.mjs';

// Resolve relative to this file, never to the MCP client's working directory.
const config = JSON.parse(await fs.readFile(new URL('./project.json', import.meta.url), 'utf8'));
const server = new McpServer({ name: `launchpad-${config.id}`, version: '1.0.0' }, { instructions: `${config.name}: ${config.summary}. Local text tools do not use a language model. The ai tool requires a server-side OPENAI_API_KEY.` });
const descriptions = {
  analyze: '텍스트의 문자·단어·문장 수와 빈출 단어를 로컬 규칙으로 분석합니다. 외부 요청이 없습니다.',
  checklist: '문장과 줄을 번호가 있는 체크리스트로 변환합니다. 로컬 규칙 기반이며 외부 요청이 없습니다.',
  ai: '프로젝트 목적에 맞춰 OpenAI Responses API로 텍스트 요청을 처리합니다. 서버 API 키와 API 사용료가 필요합니다. 외부 작업 도구는 실행하지 않습니다.',
};
for (const [tool, description] of Object.entries(descriptions)) {
  server.registerTool(tool, {
    title: tool === 'analyze' ? '텍스트 분석' : tool === 'checklist' ? '체크리스트 변환' : 'OpenAI 텍스트 요청',
    description, inputSchema: { input: z.string().trim().min(1).max(20000) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: tool !== 'ai', openWorldHint: tool === 'ai' },
  }, async ({ input }, extra) => {
    try {
      const result = await runAgent(input, tool, config, { signal: extra.signal });
      return { content: [{ type: 'text', text: result.output }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.status ? error.message : '도구 실행에 실패했습니다. 서버 연결 상태를 확인하세요.' }] };
    }
  });
}
// stdout belongs exclusively to the MCP JSON-RPC transport.
await server.connect(new StdioServerTransport());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close().finally(() => process.exit(0)); });
