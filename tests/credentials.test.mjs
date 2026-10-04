import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { localPlan } from '../server/templates.mjs';
import { createCredentialManager } from '../server/credentials.mjs';

const keyA = 'sk-proj-person-a-private-key-123456';
const keyB = 'sk-proj-person-b-private-key-654321';
const memoryStore = () => { const values = new Map(); return { values, read:async id => values.get(id), write:async (id, value) => values.set(id, structuredClone(value)) }; };

function client(base) {
  const cookies = new Map();
  return async (route, method = 'GET', input) => {
    const response = await fetch(base + route, { method, headers:{ 'content-type':'application/json', cookie:[...cookies].map(([name,value]) => `${name}=${value}`).join('; ') }, ...(input === undefined ? {} : { body:JSON.stringify(input) }) });
    for (const header of response.headers.getSetCookie()) { const [name, ...value] = header.split(';')[0].split('='); cookies.set(name, value.join('=')); }
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { response, data, text, cookies };
  };
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'launchpad-credentials-'));
  const used = [];
  const engine = await createApp({ dataDir, apiKey:'', providerFactory:connection => ({
    plan:async ({ prompt, kind }) => { used.push({apiKey:connection.apiKey, model:connection.model}); return localPlan(prompt, kind); },
    code:async ({ files }) => files.filter(file => file.path === 'public/app.js'),
  }), ...options });
  const server = engine.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await engine.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive:true, force:true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const finish = async (request, id) => { for (let i = 0; i < 150; i++) { const { data } = await request(`/api/projects/${id}`); if (!['queued', 'running'].includes(data.status)) return data; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Workflow timeout'); };
  return { engine, dataDir, used, a:client(base), b:client(base), finish };
}

test('personal keys are encrypted, scoped to a signed browser identity, and expire without exposing secrets', async () => {
  let now = Date.now(); const store = memoryStore();
  const manager = createCredentialManager({ secret:'s'.repeat(40), store, secure:true, now:() => now });
  const req = { headers:{} }, headers = new Map(), res = { getHeader:name => headers.get(name), setHeader:(name,value) => headers.set(name,value) };
  const connected = await manager.connect(req, res, { apiKey:keyA, model:'gpt-4.1-mini' });
  assert.match(headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict/); assert.match(headers.get('Set-Cookie'), /Secure/);
  assert.ok(!headers.get('Set-Cookie').includes(keyA));
  assert.ok(!JSON.stringify([...store.values]).includes(keyA));
  assert.equal((await manager.resolve(req)).apiKey, keyA);
  const response = manager.publicStatus(connected); assert.equal(response.validated, false); assert.ok(!JSON.stringify(response).includes(keyA));
  assert.equal(manager.owner({ headers:{cookie:req.headers.cookie + 'tamper'} }), null);
  const otherId = '0e3c5975-b38a-4b99-9962-1a6e761e3a77'; store.values.set(otherId, store.values.get(connected.ownerId));
  assert.equal(await manager.readOwner(otherId), null, 'AES associated data prevents moving an encrypted key to another owner');
  now += 13 * 3600000; assert.equal(await manager.resolve(req), null);
  assert.equal(manager.owner(req), connected.ownerId, 'Project identity survives key expiry');
});

test('two local clients use their own keys, cannot access each other’s projects, and disconnect retains source but disables paid launches', { timeout:20000 }, async t => {
  const { a, b, finish, dataDir, used } = await fixture(t);
  assert.equal((await a('/api/credentials')).data.connected, false);
  assert.equal((await a('/api/credentials', 'PUT', { apiKey:'invalid' })).response.status, 400);
  assert.equal((await a('/api/credentials', 'PUT', { apiKey:keyA, model:'personal-model-a' })).data.connected, true);
  await b('/api/credentials', 'PUT', { apiKey:keyB, model:'personal-model-b' });
  assert.equal((await a('/api/config')).data.model, 'personal-model-a');
  assert.equal((await b('/api/config')).data.model, 'personal-model-b');
  const projectA = (await a('/api/projects', 'POST', { prompt:'개인 기록을 관리하는 텍스트 에이전트', kind:'ai-agent' })).data;
  const projectB = (await b('/api/projects', 'POST', { prompt:'다른 사람을 위한 할 일 관리 웹 앱', kind:'web-app' })).data;
  const done = await finish(a, projectA.id); assert.equal(done.status, 'completed', done.error);
  assert.ok(new URL(done.previewUrl).searchParams.has('access'));
  assert.equal((await fetch(new URL(done.previewUrl).origin+'/api/config')).status,403,'Personal-key preview cannot be used by guessing the port');
  assert.equal((await finish(b, projectB.id)).status, 'completed');
  assert.deepEqual(used.map(value => value.apiKey).sort(), [keyA,keyB].sort());
  assert.deepEqual((await a('/api/projects')).data.map(project => project.id), [projectA.id]);
  assert.deepEqual((await b('/api/projects')).data.map(project => project.id), [projectB.id]);
  for (const [action, method] of [['','GET'], ['/events','GET'], ['/download','GET'], ['/cancel','POST'], ['/retry','POST'], ['/launch','POST']]) assert.equal((await b(`/api/projects/${projectA.id}${action}`, method, method === 'POST' ? {} : undefined)).response.status, 404);
  assert.equal((await a(`/api/projects/${projectA.id}/download`)).response.status, 200);
  for (const content of [await readFile(path.join(dataDir,'projects.json'),'utf8'), ...await Promise.all((await readdir(path.join(dataDir,'credentials'))).map(file => readFile(path.join(dataDir,'credentials',file),'utf8')))]) for (const key of [keyA,keyB]) assert.ok(!content.includes(key), 'No plaintext key in metadata or credential vault');
  await a('/api/credentials', 'DELETE');
  assert.equal((await a('/api/credentials')).data.connected, false);
  assert.equal((await a(`/api/projects/${projectA.id}`)).data.status, 'completed');
  assert.equal((await a(`/api/projects/${projectA.id}`)).data.previewUrl, null);
  assert.equal((await a(`/api/projects/${projectA.id}/launch`, 'POST', {})).response.status, 409);
  assert.equal((await a(`/api/projects/${projectA.id}/download`)).response.status, 200);
  assert.equal((await b('/api/credentials')).data.connected, true);
  await a('/api/credentials', 'PUT', { apiKey:keyA });
  assert.equal((await a(`/api/projects/${projectA.id}/launch`, 'POST', {})).response.status, 200);
});

test('a disconnected personal project cannot retry using a configured shared API key', async t => {
  let personalCalls = 0, sharedCalls = 0;
  const { a, finish } = await fixture(t, { apiKey:'shared-key', provider:{ plan:async () => { sharedCalls++; throw new Error('Shared provider must not be used'); } }, providerFactory:() => ({ plan:async () => { personalCalls++; throw new Error('Personal provider test failure'); } }) });
  await a('/api/credentials', 'PUT', { apiKey:keyA });
  const project = (await a('/api/projects', 'POST', { prompt:'개인 키로 만드는 실패 복구 프로젝트', kind:'web-app' })).data;
  assert.equal((await finish(a, project.id)).status, 'failed');
  await a('/api/credentials', 'DELETE');
  const retry = await a(`/api/projects/${project.id}/retry`, 'POST', {});
  assert.equal(retry.response.status, 409); assert.match(retry.data.error, /다시 연결/);
  assert.equal(personalCalls, 1); assert.equal(sharedCalls, 0);
});

test('a personal preview launch rechecks revocation after starting its runtime', async t => {
  const store=memoryStore();
  const manager=createCredentialManager({secret:'r'.repeat(40),store,secure:false});
  const originalRead=manager.readOwner; let armed=false, reads=0;
  manager.readOwner=async id => armed && ++reads>1 ? null : originalRead(id);
  const {a,finish}=await fixture(t,{credentialManager:manager});
  await a('/api/credentials','PUT',{apiKey:keyA});
  const project=(await a('/api/projects','POST',{prompt:'연결 변경 시 중단되는 개인 텍스트 에이전트',kind:'ai-agent'})).data;
  assert.equal((await finish(a,project.id)).status,'completed');
  await a('/api/credentials','PUT',{apiKey:keyB}); // Stops the old runtime before relaunch.
  armed=true;
  const launched=await a(`/api/projects/${project.id}/launch`,'POST',{});
  assert.equal(launched.response.status,409); assert.match(launched.data.error,/연결이 변경/);
  assert.equal(reads,2,'Revocation is checked before and after process startup');
  assert.equal((await a(`/api/projects/${project.id}`)).data.previewUrl,null);
});
