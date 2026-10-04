import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { createCloudHandler } from '../server/cloud/handler.mjs';
import { createBlobStore } from '../server/cloud/store.mjs';
import { createBlobCredentialStore } from '../server/credentials.mjs';
import { localPlan } from '../server/templates.mjs';

const users = {
  a: { ownerId: '11111111-1111-8111-8111-111111111111', name: 'A 사용자', email: 'a@example.com', picture: null },
  b: { ownerId: '22222222-2222-8222-8222-222222222222', name: 'B 사용자', email: 'b@example.com', picture: null },
};
const keyA = 'sk-proj-google-account-a-test-key-1234';
const keyB = 'sk-proj-google-account-b-test-key-5678';

// The cryptographic Google flow is covered by google-auth.test.mjs. This stub
// isolates application routing and owner isolation without external OAuth calls.
function googleStub() {
  let callbacks = 0;
  const verify = req => {
    const account = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('test_google_account='))?.split('=')[1];
    return users[account] || null;
  };
  return {
    configured: true, verify, owner: req => verify(req)?.ownerId || null,
    status(req) { const user = verify(req); return { enabled: true, authenticated: Boolean(user), user }; },
    start(_req, res) { res.redirect(302, 'https://accounts.google.com/test-authorize'); },
    callback(req, res) {
      callbacks++;
      const query = req.query || Object.fromEntries(new URL(req.url, 'https://local.invalid').searchParams);
      if (!users[query.account]) throw new Error('private-provider-error-must-not-be-reflected');
      res.setHeader('Set-Cookie', ['test_google_account=' + query.account + '; Path=/; HttpOnly; SameSite=Lax']);
      res.redirect(303, '/#new');
      return users[query.account];
    },
    logout(_req, res) { res.setHeader('Set-Cookie', ['test_google_account=; Path=/; HttpOnly; Max-Age=0']); },
    get callbacks() { return callbacks; },
  };
}

function client(base, account) {
  const cookies = new Map(account ? [['test_google_account', account]] : []);
  const request = async (route, method = 'GET', input, headers = {}) => {
    const response = await fetch(base + route, { method, redirect: 'manual', headers: { 'content-type': 'application/json',
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '), ...headers },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, ...value] = cookie.split(';')[0].split('=');
      if (value.join('')) cookies.set(name, value.join('=')); else cookies.delete(name);
    }
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, data, text };
  };
  request.cookies = cookies;
  return request;
}

async function localFixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'launchpad-google-integration-'));
  const googleAuth = googleStub();
  const engine = await createApp({ dataDir, apiKey: '', googleAuth, disableAutoAndroid: true,
    providerFactory: () => ({ plan: async ({ prompt, kind }) => localPlan(prompt, kind), code: async ({ files }) => files.filter(file => file.path === 'public/app.js') }),
  });
  const server = engine.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await engine.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { engine, googleAuth, dataDir, base, a: client(base, 'a'), aSecondDevice: client(base, 'a'), b: client(base, 'b'), anonymous: client(base) };
}

function fakeBlob() {
  const records = new Map(); let revision = 0;
  return {
    records,
    async get(key) { const record = records.get(key); return record ? { stream: new Blob([record.contents]).stream(), blob: { etag: record.etag } } : null; },
    async put(key, contents, options) {
      const current = records.get(key);
      if ((current && !options.allowOverwrite) || (options.ifMatch && options.ifMatch !== current?.etag)) throw Object.assign(new Error('precondition failed'), { name: 'BlobPreconditionFailedError' });
      const etag = `etag-${++revision}`; records.set(key, { contents, etag }); return { pathname: key, etag };
    },
    async list({ prefix }) { return { blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(pathname => ({ pathname })), hasMore: false }; },
  };
}

async function cloudFixture(t) {
  const googleAuth = googleStub(), blobs = fakeBlob(), store = createBlobStore({ blob: blobs });
  const used = [], stopped = [];
  const runner = {
    timeout: 300000,
    async create(record, ready, connection) {
      used.push({ record: structuredClone(record), connection: connection ? { ...connection } : null });
      record.execution.name = `test-sandbox-${record.project.id}`; record.execution.url = 'https://test-preview.example';
      if (await ready(record)) await store.update(record.project.id, current => ({ ...current, project: { ...current.project, status: 'running' } }));
    },
    async inspect() { return { status: 'running' }; }, async stop(execution) { stopped.push(execution.name); },
    async launch() { return { url: 'https://test-preview.example', expiresAt: new Date(Date.now() + 300000).toISOString() }; },
  };
  const env = { SESSION_SECRET: 'q'.repeat(40), BLOB_READ_WRITE_TOKEN: 'fake-private-blob-token', NODE_ENV: 'test' };
  const server = http.createServer(createCloudHandler({ googleAuth, store, runner, env,
    credentialStore: createBlobCredentialStore({ sdk: blobs, token: 'fake-private-blob-token' }),
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { googleAuth, blobs, store, runner, used, stopped, base, a: client(base, 'a'), aSecondDevice: client(base, 'a'), b: client(base, 'b'), anonymous: client(base) };
}

async function finish(request, id) {
  for (let i = 0; i < 200; i++) {
    const { response, data } = await request(`/api/projects/${id}`); assert.equal(response.status, 200);
    if (!['queued', 'running'].includes(data.status)) return data;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Local workflow did not finish');
}

async function assertProtectedRoutes(f) {
  const session = await f.anonymous('/api/auth/session');
  assert.equal(session.data.authenticated, false); assert.equal(session.data.required, true); assert.equal(session.data.google, true);
  for (const [route, method, body] of [['/api/projects', 'GET'], ['/api/credentials', 'GET'],
    ['/api/projects', 'POST', { prompt: '인증 없이 만들 수 없어야 하는 앱', kind: 'web-app' }],
    ['/api/credentials', 'PUT', { apiKey: keyA }]]) assert.equal((await f.anonymous(route, method, body)).response.status, 401);
  assert.equal((await f.a('/api/auth/session')).data.user.ownerId, users.a.ownerId);
  assert.equal((await f.a('/api/projects', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).response.status, 403);
}

async function assertIsolatedRoutes(other, id) {
  for (const [suffix, method] of [['', 'GET'], ['/events', 'GET'], ['/download', 'GET'], ['/cancel', 'POST'],
    ['/retry', 'POST'], ['/launch', 'POST'], ['/android', 'GET'], ['/android/build', 'POST'],
    ['/android/source', 'GET'], ['/android/apk', 'GET']]) {
    const result = await other(`/api/projects/${id}${suffix}`, method, method === 'POST' ? {} : undefined);
    assert.equal(result.response.status, 404, `Another Google account must not access ${suffix || 'project'}`);
  }
}

test('local Google accounts protect routes and retain separate project ownership without personal API keys', { timeout: 20000 }, async t => {
  const f = await localFixture(t); await assertProtectedRoutes(f);
  const a = (await f.a('/api/projects', 'POST', { prompt: 'A 계정으로 생성하는 독서 기록 앱', kind: 'web-app' })).data;
  const b = (await f.b('/api/projects', 'POST', { prompt: 'B 계정으로 생성하는 운동 기록 앱', kind: 'web-app' })).data;
  assert.equal(a.ownerId, users.a.ownerId); assert.equal(b.ownerId, users.b.ownerId);
  assert.equal(a.credentialSource, undefined); assert.equal(b.credentialSource, undefined);
  await assertIsolatedRoutes(f.b, a.id); await assertIsolatedRoutes(f.a, b.id);
  assert.equal((await finish(f.a, a.id)).status, 'completed'); assert.equal((await finish(f.b, b.id)).status, 'completed');
  assert.deepEqual((await f.a('/api/projects')).data.map(item => item.id), [a.id]);
  assert.deepEqual((await f.aSecondDevice('/api/projects')).data.map(item => item.id), [a.id]);
  assert.deepEqual((await f.b('/api/projects')).data.map(item => item.id), [b.id]);
  assert.equal((await f.a(`/api/projects/${a.id}/download`)).response.status, 200);
});

test('local API keys follow the Google account across browsers, remain encrypted, and never transfer to another account', async t => {
  const f = await localFixture(t);
  await f.a('/api/credentials', 'PUT', { apiKey: keyA, model: 'account-a-model' });
  const fromOtherBrowser = await f.aSecondDevice('/api/credentials');
  assert.equal(fromOtherBrowser.data.connected, true); assert.equal(fromOtherBrowser.data.model, 'account-a-model');
  assert.equal((await f.b('/api/credentials')).data.connected, false);
  await f.b('/api/credentials', 'PUT', { apiKey: keyB, model: 'account-b-model' });
  assert.equal((await f.a('/api/config')).data.model, 'account-a-model');
  assert.equal((await f.b('/api/config')).data.model, 'account-b-model');
  const names = await readdir(path.join(f.dataDir, 'credentials'));
  assert.deepEqual(names.sort(), [`${users.a.ownerId}.json`, `${users.b.ownerId}.json`].sort());
  for (const name of names) assert.doesNotMatch(await readFile(path.join(f.dataDir, 'credentials', name), 'utf8'), /sk-proj-google-account/);
  assert.equal(f.a.cookies.has('launchpad_person'), false, 'Authenticated accounts do not need a separate browser identity');
  await f.a('/api/auth/logout', 'POST', {});
  assert.equal((await f.a('/api/credentials')).response.status, 401);
  assert.equal((await f.aSecondDevice('/api/credentials')).data.connected, true);
  await f.aSecondDevice('/api/credentials', 'DELETE');
  assert.equal((await f.aSecondDevice('/api/credentials')).data.connected, false);
  assert.equal((await f.b('/api/credentials')).data.connected, true);
});

test('cloud Google accounts protect project and APK routes without requiring a shared workspace password or BYOK', async t => {
  const f = await cloudFixture(t); await assertProtectedRoutes(f);
  const a = (await f.a('/api/projects', 'POST', { prompt: 'A 계정의 클라우드 프로젝트 만들기', kind: 'web-app' })).data;
  const b = (await f.b('/api/projects', 'POST', { prompt: 'B 계정의 클라우드 프로젝트 만들기', kind: 'web-app' })).data;
  assert.equal(a.ownerId, users.a.ownerId); assert.equal(b.ownerId, users.b.ownerId);
  assert.equal(a.mode, 'local'); assert.equal(b.mode, 'local');
  assert.equal(f.used[0].connection, null); assert.equal(f.used[1].connection, null);
  await assertIsolatedRoutes(f.b, a.id); await assertIsolatedRoutes(f.a, b.id);
  assert.deepEqual((await f.a('/api/projects')).data.map(item => item.id), [a.id]);
  assert.deepEqual((await f.aSecondDevice('/api/projects')).data.map(item => item.id), [a.id]);
  assert.deepEqual((await f.b('/api/projects')).data.map(item => item.id), [b.id]);
  await f.a(`/api/projects/${a.id}/cancel`, 'POST', {});
  const retried = await f.a(`/api/projects/${a.id}/retry`, 'POST', {});
  assert.equal(retried.response.status, 202); assert.equal(retried.data.ownerId, users.a.ownerId);
  assert.equal((await f.b(`/api/projects/${a.id}`)).response.status, 404);
});

test('cloud Google account credentials stay encrypted and account-scoped across devices and sandbox dispatch', async t => {
  const f = await cloudFixture(t);
  await f.a('/api/credentials', 'PUT', { apiKey: keyA, model: 'account-a-model' });
  assert.equal((await f.aSecondDevice('/api/credentials')).data.connected, true);
  assert.equal((await f.b('/api/credentials')).data.connected, false);
  await f.b('/api/credentials', 'PUT', { apiKey: keyB, model: 'account-b-model' });
  const project = (await f.aSecondDevice('/api/projects', 'POST', { prompt: '같은 계정의 다른 브라우저에서 만들기', kind: 'ai-agent' })).data;
  assert.equal(project.ownerId, users.a.ownerId); assert.equal(project.credentialSource, 'personal');
  assert.equal(f.used[0].connection.apiKey, keyA); assert.equal(f.used[0].connection.ownerId, users.a.ownerId);
  for (const { contents } of f.blobs.records.values()) assert.doesNotMatch(contents, /sk-proj-google-account/);
  await f.a('/api/auth/logout', 'POST', {});
  assert.equal((await f.a('/api/projects')).response.status, 401);
  assert.equal((await f.aSecondDevice('/api/credentials')).data.connected, true);
  await f.aSecondDevice('/api/credentials', 'DELETE');
  assert.equal((await f.aSecondDevice(`/api/projects/${project.id}`)).data.status, 'cancelled');
  assert.equal((await f.b('/api/credentials')).data.connected, true);
  assert.equal((await f.b(`/api/projects/${project.id}`)).response.status, 404);
});

for (const [name, fixture] of [['local', localFixture], ['cloud', cloudFixture]]) {
  test(`${name} permits only the Google callback cross-site GET through OAuth routing and masks callback errors`, async t => {
    const f = await fixture(t);
    const start = await f.anonymous('/api/auth/google/start');
    assert.equal(start.response.status, 302); assert.equal(new URL(start.response.headers.get('location')).hostname, 'accounts.google.com');
    const success = await f.anonymous('/api/auth/google/callback?account=a&state=unit-test-state', 'GET', undefined, { 'sec-fetch-site': 'cross-site' });
    assert.equal(success.response.status, 303); assert.equal(f.googleAuth.callbacks, 1);
    assert.equal((await f.anonymous('/api/auth/session')).data.user.ownerId, users.a.ownerId);
    const rejected = await f.anonymous('/api/auth/google/callback?account=unknown&state=unit-test-state', 'GET', undefined, { 'sec-fetch-site': 'cross-site' });
    assert.ok([302, 303].includes(rejected.response.status));
    assert.match(rejected.response.headers.get('location'), /auth_error=google/);
    assert.doesNotMatch(rejected.text, /private-provider-error/);
    assert.equal((await f.anonymous('/api/auth/google/callback', 'POST', {}, { 'sec-fetch-site': 'cross-site' })).response.status, 403);
    assert.equal((await f.anonymous('/api/projects', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).response.status, 403);
  });
}
