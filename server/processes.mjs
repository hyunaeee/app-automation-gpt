import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function minimalEnv(extra = {}) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'PATH']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}
export async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500); timer.unref();
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill();
  });
}
export function startRuntime(directory, { signal, dataFile, apiKey, model, provider='openai', host = '127.0.0.1', port = 0, publicOrigin, previewAccessToken } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('취소되었습니다.'));
    const extra = { PORT: String(port), HOST: host };
    if (publicOrigin) extra.PUBLIC_ORIGIN = publicOrigin;
    if (previewAccessToken) extra.PREVIEW_ACCESS_TOKEN = previewAccessToken;
    if (dataFile) extra.APP_DATA_FILE = dataFile;
    if (provider !== 'openai') return reject(new Error('현재 OpenAI 연결만 지원합니다.'));
    if (apiKey) { extra.OPENAI_API_KEY = apiKey; extra.OPENAI_MODEL = model || 'gpt-4.1-mini'; }
    const child = spawn(process.execPath, ['server.mjs'], { cwd: directory, env: minimalEnv(extra), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const abort = () => { child.kill(); if (!settled) finish(signal.reason || new Error('취소되었습니다.')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('생성 앱이 15초 내에 준비되지 않았습니다.')); }, 15000);
    function finish(error, port) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const origin = publicOrigin || `http://localhost:${port}`;
      if (error) reject(error); else resolve({ child, port, url: previewAccessToken ? `${origin}/?access=${encodeURIComponent(previewAccessToken)}` : origin });
    }
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { stdout += data.toString(); for (const line of stdout.split('\n')) { try { const value = JSON.parse(line); if (value.ready && Number.isInteger(value.port) && value.port > 0) finish(null, value.port); } catch {} } if (stdout.length > 10000) stdout = stdout.slice(-5000); });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-3000); });
    child.once('error', error => finish(error)); child.once('exit', code => { if (!settled) finish(new Error(`생성 앱 실행 실패 (${code}): ${stderr}`)); });
  });
}
async function checkSyntax(directory, filename, signal) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--check', filename], { cwd: directory, env: minimalEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const abort = () => child.kill(); signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(() => child.kill(), 10000);
    child.stderr.on('data', data => { output = (output + data.toString()).slice(-1500); });
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ name: `${filename} 문법 검사`, passed: false, detail: error.message }); });
    child.once('exit', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ name: `${filename} 문법 검사`, passed: code === 0, detail: code === 0 ? 'node --check 통과' : output || '문법 검사가 중단되었습니다.' }); });
  });
}
export async function validateProject(directory, { signal, kind, agentDelivery='web' } = {}) {
  const syntaxFiles=['server.mjs', 'public/app.js', ...(kind==='ai-agent'?['agent-core.mjs']:[]), ...(agentDelivery==='mcp'?['agent-mcp.mjs']:[]), ...(agentDelivery==='api'?['public/agent-console.js']:[])];
  const checks = await Promise.all(syntaxFiles.map(filename => checkSyntax(directory, filename, signal)));
  if (signal?.aborted) throw signal.reason;
  if (checks.some(check => !check.passed)) return checks;
  const dataFile = path.join(directory, '.validation', crypto.randomUUID() + '.json');
  let runtime;
  const check = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });
  try {
    runtime = await startRuntime(directory, { signal, dataFile });
    const base = `http://127.0.0.1:${runtime.port}`;
    const request = async (route, method = 'GET', input, cookie, headers={}) => {
      const response = await fetch(base + route, { method, headers: { ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: input !== undefined ? JSON.stringify(input) : undefined, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
      let value; try { value = await response.json(); } catch {}
      return { response, value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const health = await request('/api/health'); check('앱 실행', health.response.status === 200 && health.value.ok, '독립 Node 프로세스의 health API 응답 확인');
    const page = await fetch(base + '/', { signal: AbortSignal.timeout(5000) }); const html = await page.text();
    const js = await fetch(base + '/app.js', { signal: AbortSignal.timeout(5000) }); const css = await fetch(base + '/styles.css', { signal: AbortSignal.timeout(5000) });
    check('브라우저 진입 파일', page.ok && js.ok && css.ok && /<script[^>]+src=["']\/?app\.js["']/i.test(html) && !/<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html), 'HTML·JS·CSS 제공 및 CSP 호환 외부 스크립트 진입점 검사 (UI 동작 검사는 별도)');
    if (kind === 'mobile-app') {
      const source = await js.text(), stylesheet = await css.text();
      check('오프라인 자산 구성', !/\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//.test(source) && !/@import|url\(\s*["']?https?:/i.test(stylesheet), '앱 코드에 네트워크 호출·외부 CSS 의존성이 없는지 검사');
      check('기기 저장소 연결', /localStorage/.test(source), '기기 저장 코드 포함 확인. 기록 추가·수정·삭제의 실제 화면 동작은 미리보기에서 확인하세요.');
      return checks;
    }
    const anonymous = await request('/api/items'); check('인증 보호', anonymous.response.status === 401, '미로그인 데이터 접근 HTTP 401 확인');
    const signup = await request('/api/auth/signup', 'POST', { name: '검증 사용자', email: 'validation@example.test', password: 'Validation-123!' });
    check('회원가입과 보안 쿠키', signup.response.status === 200 && signup.cookie && /HttpOnly/.test(signup.response.headers.get('set-cookie') || '') && /SameSite=Strict/.test(signup.response.headers.get('set-cookie') || ''), '회원가입 및 HttpOnly·SameSite=Strict 세션 쿠키 확인');
    const wrong = await request('/api/auth/login', 'POST', { email: 'validation@example.test', password: 'wrong-password' }); check('잘못된 비밀번호 거부', wrong.response.status === 401, '틀린 비밀번호 HTTP 401 확인');
    const login = await request('/api/auth/login', 'POST', { email: 'validation@example.test', password: 'Validation-123!' }); check('로그인', login.response.status === 200 && login.cookie, '가입한 계정으로 실제 로그인 성공');
    const cookie = login.cookie;
    const created = await request('/api/items', 'POST', { title: '검증 기록', description: '한글 데이터 저장 확인' }, cookie);
    const list = await request('/api/items', 'GET', undefined, cookie); check('기록 생성과 조회', created.response.status === 201 && Array.isArray(list.value) && list.value.some(item => item.id === created.value.id && item.description === '한글 데이터 저장 확인'), '인증된 사용자의 한글 기록 저장·조회 확인');
    const changed = await request('/api/items/' + created.value.id, 'PATCH', { title: '수정된 기록', status: 'done' }, cookie); check('기록 수정', changed.response.ok && changed.value.title === '수정된 기록' && changed.value.status === 'done', '제목과 완료 상태 PATCH 확인');
    const other = await request('/api/auth/signup', 'POST', { name: '다른 사용자', email: 'other@example.test', password: 'Validation-123!' });
    const others = await request('/api/items', 'GET', undefined, other.cookie); const denied = await request('/api/items/' + created.value.id, 'PATCH', { title: '침범' }, other.cookie);
    check('사용자별 데이터 격리', Array.isArray(others.value) && !others.value.some(item => item.id === created.value.id) && denied.response.status === 404, '다른 계정에서 기존 기록 조회 및 수정 차단 확인');
    const config = await request('/api/config');
    if (config.value.kind === 'ai-agent') { const run = await request('/api/agent/run', 'POST', {input: '첫 작업\n두 번째 작업', tool: 'checklist'}, cookie); check('에이전트 도구 실행', run.response.ok && run.value.mode === 'local' && run.value.output.includes('1. 첫 작업'), '로컬 체크리스트 도구의 실제 결과 확인'); }
    if (agentDelivery==='api') {
      const token=await request('/api/tokens','POST',{name:'Validation'},cookie);
      check('API 호출 토큰 발급',token.response.status===201&&typeof token.value?.token==='string','로그인한 사용자의 만료 시간이 있는 호출 토큰 발급');
      const payload={input:'첫 작업\n두 번째 작업',tool:'checklist'};
      const unauthorized=await request('/v1/agent/run','POST',payload,cookie);
      const run=await request('/v1/agent/run','POST',payload,undefined,{Authorization:`Bearer ${token.value?.token}`});
      check('Bearer API 실제 호출',unauthorized.response.status===401&&run.response.ok&&run.value.output?.includes('1. 첫 작업'),'쿠키 단독 호출 거부 및 Bearer 토큰으로 도구 결과 수신');
      const schema=await request('/openapi.json');
      check('OpenAPI 호출 명세',schema.response.ok&&schema.value.paths?.['/v1/agent/run']?.post,'생성된 HTTP API의 기계가 읽을 수 있는 명세 제공');
      await request('/api/tokens/'+token.value?.id,'DELETE',undefined,cookie);
      const revoked=await request('/v1/agent/run','POST',payload,undefined,{Authorization:`Bearer ${token.value?.token}`});
      check('API 토큰 해지',revoked.response.status===401,'해지한 토큰으로 새 요청을 차단');
    }
    if (agentDelivery==='mcp') {
      const {validateMcpDirectory}=await import('./agent-validation.mjs');
      checks.push(...await validateMcpDirectory(directory,{signal}));
    }
    const deleted = await request('/api/items/' + created.value.id, 'DELETE', undefined, cookie); const after = await request('/api/items', 'GET', undefined, cookie);
    check('기록 삭제', deleted.response.ok && !after.value.some(item => item.id === created.value.id), 'DELETE 이후 목록에서 제거 확인');
    await request('/api/auth/logout', 'POST', undefined, cookie); const logout = await request('/api/auth/me', 'GET', undefined, cookie); check('로그아웃', logout.response.status === 401, '로그아웃 후 이전 세션 재사용 차단 확인');
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    check('실행 검증', false, error.message);
  } finally {
    await stopProcess(runtime?.child);
    await fs.rm(dataFile, { force: true }).catch(() => {});
    await fs.rm(dataFile + '.tmp', { force: true }).catch(() => {});
  }
  return checks;
}
