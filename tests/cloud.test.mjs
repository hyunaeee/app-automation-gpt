import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createAuth } from '../server/cloud/auth.mjs';
import { createBlobStore } from '../server/cloud/store.mjs';
import { createCloudHandler } from '../server/cloud/handler.mjs';
import { createBlobCredentialStore } from '../server/credentials.mjs';

test('Vercel workspace sessions require correct password, expire, and reject tampering', () => {
  let time = Date.now();
  const settings = { password: 'crew-workspace-password', secret: 's'.repeat(40), now: () => time };
  const auth = createAuth(settings);
  assert.equal(auth.configured, true);
  assert.equal(createAuth({}).configured, false);
  assert.equal(auth.login('bad'), null);
  const cookie = auth.login(settings.password);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  const raw = cookie.split(';')[0];
  assert.equal(auth.verify({ headers: { cookie: raw } }), true);
  assert.equal(auth.verify({ headers: { cookie: raw + 'corruption' } }), false);
  assert.equal(auth.verify({ headers: { cookie: 'launchpad_workspace=broken.invalid' } }), false);
  assert.equal(createAuth({ ...settings, password: 'new-workspace-password' }).verify({ headers: { cookie: raw } }), false);
  time += 13 * 3600000;
  assert.equal(auth.verify({ headers: { cookie: raw } }), false);
  assert.match(auth.logout(), /Max-Age=0/);
});

function fakeBlob() {
  const records = new Map();
  let revision = 0;
  const calls = [];
  return {
    records, calls,
    async get(key, options) {
      calls.push({ type: 'get', key, options });
      const record = records.get(key);
      return record ? { stream: new Blob([record.contents]).stream(), blob: { etag: record.etag } } : null;
    },
    async put(key, contents, options) {
      calls.push({ type: 'put', key, options });
      const current = records.get(key);
      if ((current && !options.allowOverwrite) || (options.ifMatch && options.ifMatch !== current?.etag)) {
        throw Object.assign(new Error('precondition failed'), { name: 'BlobPreconditionFailedError' });
      }
      const etag = `etag-${++revision}`;
      records.set(key, { contents, etag });
      return { pathname: key, etag };
    },
    async list({ prefix }) { return { blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(pathname => ({ pathname })), hasMore: false }; },
  };
}

test('cloud snapshots are private and stale conditional writes cannot overwrite newer state', async () => {
  const blob = fakeBlob();
  const store = createBlobStore({ blob, token: 'test-blob-token' });
  const id = crypto.randomUUID();
  const record = { project: { id, status: 'queued', createdAt: new Date().toISOString() }, execution: { runId: 'run-a' } };
  await store.write(record);
  const initial = await store.read(id);
  await store.update(id, current => ({ ...current, project: { ...current.project, status: 'cancelled' } }));
  await assert.rejects(store.write(record, initial.etag), { name: 'BlobPreconditionFailedError' });
  assert.equal((await store.read(id)).value.project.status, 'cancelled');
  assert.equal((await store.list()).length, 1);
  assert.ok(blob.calls.filter(call => ['get', 'put'].includes(call.type)).every(call => call.options.access === 'private'));
  assert.ok(blob.calls.filter(call => call.type === 'get').every(call => call.options.useCache === false));
  assert.throws(() => store.read('../../secret'));
});

test('cloud creation slots enforce limits and an old worker cannot release a replacement lease', async () => {
  const blob = fakeBlob();
  const store = createBlobStore({ blob });
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const expires = new Date(Date.now() + 600000).toISOString();
  await store.write({ project: { id: first, status: 'running', createdAt: new Date().toISOString() } });
  await store.write({ project: { id: second, status: 'queued', createdAt: new Date().toISOString() } });
  assert.equal(await store.reserve('run-first', first, expires, 1), 0);
  await assert.rejects(store.reserve('run-second', second, expires, 1), error => error.status === 429);
  await store.release(0, 'run-first');
  assert.equal(await store.reserve('run-second', second, expires, 1), 0);
  await store.release(0, 'run-first');
  await assert.rejects(store.reserve('run-third', first, expires, 1), error => error.status === 429);
});

test('Vercel HTTP contract authenticates, creates, cancels and retries with injected cloud infrastructure', async (t) => {
  const store = createBlobStore({ blob: fakeBlob() });
  let stopCalls = 0;
  const runner = {
    timeout: 300000,
    async create(record, ready) {
      record.execution.name = 'test-sandbox';
      record.execution.url = 'https://example.vercel.run';
      await ready(record);
      await store.update(record.project.id, current => ({ ...current, project: { ...current.project, status: 'running' } }));
    },
    async inspect() { return { status: 'running' }; },
    async stop() { stopCalls++; },
    async launch() { return { url: 'https://example.vercel.run', expiresAt: new Date(Date.now() + 300000).toISOString() }; },
  };
  const env = { WORKSPACE_PASSWORD: 'workspace-test-password', SESSION_SECRET: 'q'.repeat(40), BLOB_READ_WRITE_TOKEN: 'test-blob-key', OPENAI_API_KEY: 'test-model-key', NODE_ENV: 'test' };
  const server = http.createServer(createCloudHandler({ store, runner, env }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  async function request(route, input, extraHeaders = {}) {
    const response = await fetch(base + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extraHeaders },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { response, data: await response.json() };
  }
  assert.equal((await request('/api/projects')).response.status, 401);
  const session = await request('/api/auth/session');
  assert.equal(session.data.authenticated, false);
  assert.equal(session.data.required, true);
  assert.equal((await request('/api/auth/login', { password: 'incorrect' })).response.status, 401);
  const login = await request('/api/auth/login', { password: env.WORKSPACE_PASSWORD });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/auth/session')).data.authenticated, true);
  const created = await request('/api/projects', { prompt: '크루를 위한 개인 일정 메모 앱 만들기', kind: 'web-app' });
  assert.equal(created.response.status, 202);
  assert.equal(created.data.status, 'running');
  assert.ok(!JSON.stringify(created.data).includes('test-model-key'));
  assert.equal(created.data.execution, undefined);
  const firstRun = (await store.read(created.data.id)).value.execution.runId;
  assert.equal((await request('/api/projects')).data.length, 1);
  assert.equal((await request(`/api/projects/${created.data.id}/cancel`, {})).data.status, 'cancelled');
  assert.ok(stopCalls >= 1);
  const retried = await request(`/api/projects/${created.data.id}/retry`, {});
  assert.equal(retried.response.status, 202);
  assert.equal(retried.data.id, created.data.id);
  assert.notEqual((await store.read(created.data.id)).value.execution.runId, firstRun);
  assert.equal((await request('/api/projects', { prompt: '설명은 있어도 요청 출처가 다른 앱', kind: 'web-app' }, { origin: 'https://other.example' })).response.status, 403);
  assert.equal((await request('/api/auth/logout', {})).response.status, 200);
});

test('Vercel personal keys stay encrypted in private Blob and are routed only to the owning browser’s sandbox', async t => {
  const blob = fakeBlob(), store = createBlobStore({ blob }), used = [], stopped = [];
  const runner = {
    timeout:300000,
    async create(record, ready, connection) {
      used.push({connection, record:structuredClone(record)});
      record.execution.name = `sandbox-${record.project.id}`; record.execution.url = 'https://example.vercel.run';
      if (!await ready(record)) return;
      await store.update(record.project.id, current => ({ ...current, project:{ ...current.project, status:'running' } }));
    },
    async inspect() { return {status:'running'}; },
    async stop(execution) { stopped.push(execution.name); },
    async launch(record, connection) { used.push({connection, record:structuredClone(record)}); return {url:'https://example.vercel.run/?access=test', expiresAt:new Date(Date.now()+300000).toISOString()}; },
  };
  const env = { WORKSPACE_PASSWORD:'workspace-test-password', SESSION_SECRET:'q'.repeat(40), BLOB_READ_WRITE_TOKEN:'test-blob-key', OPENAI_API_KEY:'shared-api-key-must-not-be-used', NODE_ENV:'test' };
  const server = http.createServer(createCloudHandler({ store, runner, env, credentialStore:createBlobCredentialStore({ sdk:blob, token:'test-blob-key' }) }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    const cookies = new Map();
    return async (route, method='GET', input) => {
      const response = await fetch(base+route, { method, headers:{'content-type':'application/json', cookie:[...cookies].map(([key,value]) => `${key}=${value}`).join('; ')}, ...(input === undefined ? {} : {body:JSON.stringify(input)}) });
      for (const header of response.headers.getSetCookie()) { const [name,...value] = header.split(';')[0].split('='); cookies.set(name,value.join('=')); }
      const text = await response.text(); let data; try {data=JSON.parse(text);} catch {data=text;}
      return {response,data,text};
    };
  }
  const a=client(), b=client(), keyA='sk-proj-cloud-person-a-123456', keyB='sk-proj-cloud-person-b-654321';
  assert.equal((await a('/api/credentials')).response.status,401);
  for (const c of [a,b]) assert.equal((await c('/api/auth/login','POST',{password:env.WORKSPACE_PASSWORD})).response.status,200);
  assert.equal((await a('/api/credentials','PUT',{apiKey:keyA,model:'personal-model-a'})).data.connected,true);
  await b('/api/credentials','PUT',{apiKey:keyB,model:'personal-model-b'});
  const projectA=(await a('/api/projects','POST',{prompt:'개인 키로 만드는 텍스트 에이전트',kind:'ai-agent'})).data;
  const projectB=(await b('/api/projects','POST',{prompt:'다른 사람을 위한 개인 관리 프로젝트',kind:'web-app'})).data;
  assert.equal(projectA.mode,'openai'); assert.equal(projectA.model,'personal-model-a');
  assert.deepEqual(used.map(item => item.connection.apiKey),[keyA,keyB]);
  assert.deepEqual((await a('/api/projects')).data.map(project => project.id),[projectA.id]);
  assert.deepEqual((await b('/api/projects')).data.map(project => project.id),[projectB.id]);
  for (const [action,method] of [['','GET'],['/events','GET'],['/download','GET'],['/cancel','POST'],['/retry','POST'],['/launch','POST']]) assert.equal((await b(`/api/projects/${projectA.id}${action}`,method,method==='POST'?{}:undefined)).response.status,404);
  for (const value of blob.records.values()) for (const key of [keyA,keyB]) assert.ok(!value.contents.includes(key),'Private Blob records contain only encrypted credentials');
  for (const entry of used) assert.ok(!JSON.stringify(entry.record).includes('sk-proj-'));
  assert.ok(blob.calls.filter(call => call.key?.includes('/credentials/')).every(call => call.options.access==='private'));
  await a('/api/credentials','DELETE');
  assert.equal((await a(`/api/projects/${projectA.id}`)).data.status,'cancelled');
  assert.equal((await b(`/api/projects/${projectB.id}`)).data.status,'running');
  assert.equal((await a(`/api/projects/${projectA.id}/retry`,'POST',{})).response.status,409);
  assert.ok(stopped.includes(`sandbox-${projectA.id}`));
  await a('/api/credentials','PUT',{apiKey:keyA,model:'personal-model-next'});
  assert.equal((await a(`/api/projects/${projectA.id}/retry`,'POST',{})).response.status,202);
  assert.equal(used.at(-1).connection.model,'personal-model-next');
  await store.update(projectA.id,record => ({...record,project:{...record.project,status:'completed'}}));
  await a('/api/credentials','DELETE');
  assert.equal((await a(`/api/projects/${projectA.id}/launch`,'POST',{})).response.status,409);
  // A browser may open an older shared project while a personal key is connected.
  // That key must not be injected into a sandbox accessible to other members.
  const sharedClient=client();
  await sharedClient('/api/auth/login','POST',{password:env.WORKSPACE_PASSWORD});
  const shared=(await sharedClient('/api/projects','POST',{prompt:'워크스페이스 공용 텍스트 에이전트',kind:'ai-agent'})).data;
  assert.equal(shared.ownerId,undefined);
  await store.update(shared.id,current => ({...current,project:{...current.project,status:'completed'}}));
  assert.equal((await b('/api/credentials')).data.connected,true);
  assert.equal((await b(`/api/projects/${shared.id}/launch`,'POST',{})).response.status,200);
  assert.equal(used.at(-1).connection,null,'Opening a shared preview never receives the current browser’s personal key');
  assert.equal(used.at(-1).record.project.ownerId,undefined);
  await b('/api/credentials','DELETE');
  assert.ok(!stopped.includes(`sandbox-${shared.id}`),'Shared execution stays independent of a browser’s key lifecycle');
});
