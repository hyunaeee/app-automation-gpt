import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'launchpad-test-'));
  const engine = await createApp({ dataDir, apiKey: '', ...options });
  const server = engine.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await engine.shutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { base, dataDir, ...engine };
}

async function request(base, route, body, extra = {}) {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...extra,
  });
  return { response, data: await response.json() };
}

async function finish(base, id) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { data } = await request(base, `/api/projects/${id}`);
    if (!['queued', 'running'].includes(data.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Workflow did not finish within 30 seconds');
}

test('web-app idea produces validated, runnable, downloadable and persisted source', { timeout: 45_000 }, async (t) => {
  const { base } = await fixture(t);
  const config = await request(base, '/api/config');
  assert.equal(config.data.mode, 'local');
  const created = await request(base, '/api/projects', {
    prompt: '크루원들이 함께 할 일을 기록하고 완료할 수 있는 작업 관리 앱을 만들어줘', kind: 'web-app',
  });
  assert.equal(created.response.status, 202);
  const project = await finish(base, created.data.id);
  assert.equal(project.status, 'completed', JSON.stringify(project.error || project.checks));
  assert.equal(project.mode, 'local');
  assert.equal(project.stages.length, 8);
  assert.ok(project.stages.every((stage) => ['completed', 'skipped'].includes(stage.status)));
  assert.ok(project.checks.length >= 3);
  assert.ok(project.checks.every((check) => check.passed), JSON.stringify(project.checks));
  assert.ok(project.files.some((file) => file.path.endsWith('server.mjs')));
  assert.ok(project.plan.assumptions.length > 0);
  assert.ok(project.logs.length > 4);
  assert.ok(project.previewUrl);
  const preview = await fetch(project.previewUrl);
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /<html/i);
  const list = await request(base, '/api/projects');
  assert.ok(list.data.some((item) => item.id === project.id));
  const zip = await fetch(`${base}/api/projects/${project.id}/download`);
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get('content-type'), /zip/);
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.ok(!bytes.includes(Buffer.from('OPENAI_API_KEY=sk-')));
});

test('generated app authenticates users, persists items, and isolates ownership', { timeout: 45_000 }, async (t) => {
  const { base } = await fixture(t);
  const { data: created } = await request(base, '/api/projects', { prompt: '로그인이 있는 나만의 독서 기록 관리 앱', kind: 'web-app' });
  const project = await finish(base, created.id);
  assert.equal(project.status, 'completed', project.error);
  const origin = new URL(project.previewUrl).origin;
  const anon = await request(origin, '/api/items');
  assert.equal(anon.response.status, 401);
  const signup = await request(origin, '/api/auth/signup', { name: '테스터', email: 'reader@example.com', password: 'test-password-123' });
  assert.ok([200, 201].includes(signup.response.status), JSON.stringify(signup.data));
  const cookie = signup.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.match(signup.response.headers.get('set-cookie'), /HttpOnly/i);
  const headers = { 'content-type': 'application/json', cookie };
  const item = await request(origin, '/api/items', { title: '첫 번째 책', description: '테스트 메모' }, { headers });
  assert.ok([200, 201].includes(item.response.status), JSON.stringify(item.data));
  const entries = await request(origin, '/api/items', undefined, { headers });
  assert.ok(JSON.stringify(entries.data).includes('첫 번째 책'));
  const other = await request(origin, '/api/auth/signup', { name: '다른 사용자', email: 'other@example.com', password: 'test-password-456' });
  const otherCookie = other.response.headers.get('set-cookie')?.split(';')[0];
  const otherItems = await request(origin, '/api/items', undefined, { headers: { cookie: otherCookie } });
  assert.ok(!JSON.stringify(otherItems.data).includes('첫 번째 책'));
  const forbiddenPatch = await request(origin, `/api/items/${item.data.id}`, { title: '다른 사용자 수정' }, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: otherCookie } });
  assert.equal(forbiddenPatch.response.status, 404);
  const patched = await request(origin, `/api/items/${item.data.id}`, { status: 'done' }, { method: 'PATCH', headers });
  assert.equal(patched.response.status, 200);
  assert.equal(patched.data.status, 'done');
  const badLogin = await request(origin, '/api/auth/login', { email: 'reader@example.com', password: 'incorrect-password' });
  assert.equal(badLogin.response.status, 401);
  const logout = await request(origin, '/api/auth/logout', {}, { headers });
  assert.equal(logout.response.status, 200);
  const after = await request(origin, '/api/items', undefined, { headers });
  assert.equal(after.response.status, 401);
  const login = await request(origin, '/api/auth/login', { email: 'reader@example.com', password: 'test-password-123' });
  assert.equal(login.response.status, 200);
  const loginCookie = login.response.headers.get('set-cookie')?.split(';')[0];
  const existing = await request(origin, '/api/items', undefined, { headers: { cookie: loginCookie } });
  assert.ok(JSON.stringify(existing.data).includes('첫 번째 책'));
  const removed = await request(origin, `/api/items/${item.data.id}`, undefined, { method: 'DELETE', headers: { cookie: loginCookie } });
  assert.equal(removed.response.status, 200);
});

test('AI-agent template generates a runnable authenticated text-tool project', { timeout: 45_000 }, async (t) => {
  const { base } = await fixture(t);
  const { data: created } = await request(base, '/api/projects', { prompt: '입력한 회의록에서 할 일을 정리하는 AI 에이전트', kind: 'ai-agent' });
  const project = await finish(base, created.id);
  assert.equal(project.status, 'completed', JSON.stringify(project.error || project.checks));
  assert.equal(project.kind, 'ai-agent');
  const origin = new URL(project.previewUrl).origin;
  const { response } = await request(origin, '/api/auth/signup', { name: '테스터', email: 'agent@example.com', password: 'test-password-123' });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const result = await request(origin, '/api/agent/run', { input: '회의 정리. 금요일까지 디자인 수정. 다음 주 사용자 테스트 진행.' }, { headers: { 'content-type': 'application/json', cookie } });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.ok(JSON.stringify(result.data).length > 30);
});

test('controller rejects invalid inputs, cross-origin mutations and unknown resources', async (t) => {
  const { base } = await fixture(t);
  for (const input of [{ prompt: '', kind: 'web-app' }, { prompt: '만들기', kind: 'arbitrary' }, { prompt: 'x'.repeat(25_000), kind: 'web-app' }]) {
    const result = await request(base, '/api/projects', input);
    assert.ok(result.response.status >= 400, JSON.stringify(input).slice(0, 100));
  }
  const forbidden = await request(base, '/api/projects', { prompt: '만들어줘 로그인 앱', kind: 'web-app' }, { headers: { 'content-type': 'application/json', origin: 'https://unrelated.example' } });
  assert.equal(forbidden.response.status, 403);
  const missing = await request(base, '/api/projects/does-not-exist');
  assert.equal(missing.response.status, 404);
});

test('protected previews require a workspace-issued access link before signup or API use', { timeout: 45_000 }, async (t) => {
  const { base } = await fixture(t, { previewAccessToken: 'preview-access-token-for-integration-test' });
  const { data: created } = await request(base, '/api/projects', { prompt: '로그인이 있는 개인 할 일 관리 앱', kind: 'web-app' });
  const project = await finish(base, created.id);
  assert.equal(project.status, 'completed', project.error);
  const origin = new URL(project.previewUrl).origin;
  assert.equal((await fetch(origin)).status, 403);
  assert.equal((await request(origin, '/api/auth/signup', { email: 'noaccess@example.com', password: 'test-password-123' })).response.status, 403);
  const open = await fetch(project.previewUrl, { redirect: 'manual' });
  assert.equal(open.status, 303);
  assert.match(open.headers.get('set-cookie'), /SameSite=Lax/);
  const accessCookie = open.headers.get('set-cookie')?.split(';')[0];
  assert.ok(accessCookie);
  const page = await fetch(origin, { headers: { cookie: accessCookie } });
  assert.equal(page.status, 200);
  const config = await request(origin, '/api/config', undefined, { headers: { cookie: accessCookie } });
  assert.ok(!JSON.stringify(config.data).includes('preview-access-token-for-integration-test'));
});

test('project source and generated user records survive a controller restart', { timeout: 45_000 }, async (t) => {
  const first = await fixture(t);
  const { data: created } = await request(first.base, '/api/projects', { prompt: '저장한 메모를 다시 볼 수 있는 개인 노트 앱', kind: 'web-app' });
  const completed = await finish(first.base, created.id);
  assert.equal(completed.status, 'completed', completed.error);
  const origin = new URL(completed.previewUrl).origin;
  const signup = await request(origin, '/api/auth/signup', { name: '지속성 검사', email: 'persist@example.com', password: 'persist-password-123' });
  const cookie = signup.response.headers.get('set-cookie').split(';')[0];
  await request(origin, '/api/items', { title: '재시작 후 남아야 하는 메모' }, { headers: { 'content-type': 'application/json', cookie } });
  await first.shutdown();
  const second = await createApp({ dataDir: first.dataDir, apiKey: '' });
  const server = second.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const restored = await request(base, `/api/projects/${created.id}`);
    assert.equal(restored.data.status, 'completed');
    assert.equal(restored.data.files.length, completed.files.length);
    const launch = await request(base, `/api/projects/${created.id}/launch`, {});
    assert.equal(launch.response.status, 200);
    const nextOrigin = new URL(launch.data.url).origin;
    const login = await request(nextOrigin, '/api/auth/login', { email: 'persist@example.com', password: 'persist-password-123' });
    assert.equal(login.response.status, 200);
    const newCookie = login.response.headers.get('set-cookie').split(';')[0];
    const items = await request(nextOrigin, '/api/items', undefined, { headers: { cookie: newCookie } });
    assert.ok(items.data.some(item => item.title === '재시작 후 남아야 하는 메모'));
  } finally {
    await second.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
