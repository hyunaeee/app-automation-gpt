import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { createCloudHandler } from '../server/cloud/handler.mjs';
import { createBlobStore } from '../server/cloud/store.mjs';
import { createBlobCredentialStore } from '../server/credentials.mjs';
import { localPlan, registry } from '../server/templates.mjs';
import { prepareRevision } from '../server/revisions.mjs';

const ownerA = '11111111-1111-8111-8111-111111111111', ownerB = '22222222-2222-8222-8222-222222222222';
const key = 'sk-test-revision-private-api-key-12345';
const prompt = '개인 독서 기록과 상태를 관리하는 앱';
const changes = '화면을밝게'; // The 5-character revision minimum differs from a new idea.
function authStub() {
  const verify = req => req.headers.cookie?.includes('account=a') ? { ownerId: ownerA } : req.headers.cookie?.includes('account=b') ? { ownerId: ownerB } : null;
  return { configured: true, verify, owner: req => verify(req)?.ownerId || null,
    status: req => ({ enabled: true, authenticated: Boolean(verify(req)), user: verify(req) }),
    start() {}, callback() {}, logout() {} };
}
function client(base, account = 'a') {
  return async (route, method = 'GET', input) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', cookie: `account=${account}` }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { response, data, text };
  };
}
async function localFixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'launchpad-revisions-'));
  const engine = await createApp({ dataDir, apiKey: '', googleAuth: authStub(), disableAutoAndroid: true, ...options });
  const server = engine.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await engine.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { engine, dataDir, a: client(base), b: client(base, 'b'), anonymous: client(base, 'none') };
}
async function complete(f, id) { await f.engine.runProject(id); const project = f.engine.store.get(id); assert.equal(project.status, 'completed', project.error); return structuredClone(project); }
function fakeBlob() {
  const records = new Map(); let version = 0;
  return { records,
    async get(key) { const entry = records.get(key); return entry ? { stream: new Blob([entry.contents]).stream(), blob: { etag: entry.etag } } : null; },
    async put(key, contents, options) { const current = records.get(key); if ((current && !options.allowOverwrite) || (options.ifMatch && options.ifMatch !== current?.etag)) throw Object.assign(new Error('conditional write'), { name: 'BlobPreconditionFailedError' }); const etag = `revision-${++version}`; records.set(key, { contents, etag }); return { pathname: key, etag }; },
    async list({ prefix }) { return { blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(pathname => ({ pathname })), hasMore: false }; },
  };
}
async function cloudFixture(t) {
  const blobs = fakeBlob(), store = createBlobStore({ blob: blobs }), dispatched = [];
  const runner = { timeout: 300000,
    async create(record, ready, connection) { dispatched.push(structuredClone({ record, connection })); record.execution.name = 'revision-sandbox'; await ready(record); },
    async inspect() { return { status: 'running' }; }, async stop() {} };
  const env = { SESSION_SECRET: 's'.repeat(40), BLOB_READ_WRITE_TOKEN: 'private-test-blob', NODE_ENV: 'test',
    ESTIMATE_MODEL_RATES_JSON: JSON.stringify({ 'openai/test-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } }) };
  const server = http.createServer(createCloudHandler({ store, runner, env, googleAuth: authStub(), credentialStore: createBlobCredentialStore({ sdk: blobs }) }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, dispatched, blobs, a: client(base), b: client(base, 'b'), anonymous: client(base, 'none') };
}
async function cloudParent(f) {
  const created = (await f.a('/api/projects', 'POST', { prompt, kind: 'web-app' })).data;
  const plan = localPlan(prompt, 'web-app'), parent = { ...created, name: plan.name, status: 'completed', plan };
  parent.files = await registry.get('web-app').generate(parent);
  await f.store.update(parent.id, record => ({ ...record, project: parent }));
  return parent;
}

test('AI revision receives the previous browser source and specification while original files and user data remain independent', { timeout: 25000 }, async t => {
  const plans = [], coding = [];
  const provider = {
    async plan({ prompt: received, kind }) { plans.push(received); return localPlan(prompt, kind); },
    async code(input) { coding.push(structuredClone({ project: input.project, files: input.files })); const css = input.files.find(file => file.path === 'public/styles.css'); return [{ ...css, content: css.content + (input.project.revision ? '\n/* applied-revision */' : '\n/* original-design */') }]; },
  };
  const f = await localFixture(t, { provider, providerName: 'openai', model: 'test-model' });
  const created = (await f.a('/api/projects', 'POST', { prompt, kind: 'web-app' })).data, parent = await complete(f, created.id);
  const privatePath = path.join(f.dataDir, 'projects', parent.id, '.runtime'); await mkdir(privatePath, { recursive: true });
  await writeFile(path.join(privatePath, 'private-user-export.json'), JSON.stringify({ account: 'private-user', apiKey: 'not-a-source-file' }));
  const result = await f.a(`/api/projects/${parent.id}/revise`, 'POST', { prompt: changes, ownerId: ownerB, revisionSeed: { injected: true } });
  assert.equal(result.response.status, 202); const child = await complete(f, result.data.id);
  assert.notEqual(child.id, parent.id); assert.equal(child.parentProjectId, parent.id); assert.equal(child.ownerId, ownerA);
  assert.equal(child.revision.number, 2); assert.equal(child.revision.mode, 'ai-edit'); assert.equal(child.prompt, changes);
  assert.equal(plans.length, 2); const context = JSON.parse(plans[1]); assert.equal(context.originalRequest, prompt); assert.equal(context.changeRequest, changes);
  assert.deepEqual(context.previousSpecification.features, parent.plan.features);
  assert.match(coding[1].files.find(file => file.path === 'public/styles.css').content, /original-design/);
  assert.match(child.files.find(file => file.path === 'public/styles.css').content, /original-design[\s\S]*applied-revision/);
  assert.deepEqual(f.engine.store.get(parent.id).files, parent.files);
  const newConfig = JSON.parse(child.files.find(file => file.path === 'project.json').content); assert.equal(newConfig.id, child.id);
  await assert.rejects(readFile(path.join(f.dataDir, 'projects', child.id, '.runtime', 'private-user-export.json')), { code: 'ENOENT' });
  assert.equal(child.revisionSeed, undefined); assert.doesNotMatch(JSON.stringify(child), /not-a-source-file|private-user-export|parentPlan/);
  const zip = await f.a(`/api/projects/${child.id}/download`); assert.equal(zip.response.status, 200); assert.doesNotMatch(zip.text, /\.revision-seed\.json|private-user-export/);
  assert.equal((await f.b(`/api/projects/${parent.id}/revise`, 'POST', { prompt: changes })).response.status, 404);
  assert.equal((await f.a(`/api/projects/${parent.id}/revise`, 'POST', { prompt: '짧게' })).response.status, 400);
});

test('local mobile revision transparently copies the previous UI into a new storage namespace', { timeout: 25000 }, async t => {
  const f = await localFixture(t);
  const parent = await complete(f, (await f.a('/api/projects', 'POST', { prompt, kind: 'mobile-app' })).data.id);
  const requested = await f.a(`/api/projects/${parent.id}/revise`, 'POST', { prompt: changes });
  assert.equal(requested.response.status, 202); const child = await complete(f, requested.data.id);
  assert.equal(child.revision.mode, 'template-copy'); assert.match(child.revision.message, /AI 연결 후/); assert.match(child.revision.message, /데이터는 이전하지/);
  for (const file of parent.files.filter(file => file.path.startsWith('public/'))) assert.equal(child.files.find(value => value.path === file.path).content, file.content.replaceAll(parent.id, child.id));
  assert.match(child.files.find(file => file.path === 'public/app.js').content, new RegExp(child.id));
  assert.doesNotMatch(child.files.find(file => file.path === 'public/app.js').content, new RegExp(parent.id));
  assert.deepEqual(f.engine.store.get(parent.id).files, parent.files);
  const grandchild = await complete(f, (await f.a(`/api/projects/${child.id}/revise`, 'POST', { prompt: '카드를 더 크게 해줘' })).data.id);
  assert.equal(grandchild.revision.number, 3); assert.equal(grandchild.parentProjectId, child.id);
  f.engine.store.get(parent.id).status = 'failed';
  assert.equal((await f.a(`/api/projects/${parent.id}/revise`, 'POST', { prompt: changes })).response.status, 409);
});

test('internal worker creation accepts a validated private seed and exposes metadata only', { timeout: 20000 }, async t => {
  const f = await localFixture(t);
  const parent = { id: '33333333-3333-8333-8333-333333333333', status: 'completed', prompt, kind: 'web-app', plan: localPlan(prompt, 'web-app') };
  parent.files = await registry.get(parent.kind).generate(parent);
  parent.plan.features[0].apiKey = 'feature-extra-must-be-stripped';
  parent.files.push({ path: '.runtime/data.json', content: 'private-data-never-copied' });
  const revision = prepareRevision(parent, changes, false);
  const child = await f.engine.createProject({ prompt: changes, kind: parent.kind, ...revision }, undefined, ownerA);
  await complete(f, child.id);
  const storedSeed = await readFile(path.join(f.dataDir, 'projects', child.id, '.revision-seed.json'), 'utf8');
  assert.doesNotMatch(storedSeed, /feature-extra|private-data/); assert.equal(JSON.parse(storedSeed).files.length, 3);
  assert.doesNotMatch((await f.a(`/api/projects/${child.id}`)).text, /revisionSeed|parentPlan/);
});

test('ordinary project creation ignores client-supplied internal revision seeds and ownership', { timeout: 15000 }, async t => {
  const f=await localFixture(t);
  const request=await f.a('/api/projects','POST',{prompt,kind:'web-app',id:ownerB,ownerId:ownerB,parentProjectId:ownerB,revision:{number:9,prompt:'injected'},revisionSeed:{parentPrompt:'private injected content'}});
  assert.equal(request.response.status,202);const project=await complete(f,request.data.id);
  assert.notEqual(project.id,ownerB);assert.equal(project.ownerId,ownerA);assert.equal(project.parentProjectId,undefined);assert.equal(project.revision,undefined);
  await assert.rejects(readFile(path.join(f.dataDir,'projects',project.id,'.revision-seed.json')),{code:'ENOENT'});
  assert.doesNotMatch(JSON.stringify(project),/private injected content/);
});

test('cloud revision privately dispatches source, preserves owner and original version, and keeps seed across retries', async t => {
  const f = await cloudFixture(t), parent = await cloudParent(f);
  const result = await f.a(`/api/projects/${parent.id}/revise`, 'POST', { prompt: changes });
  assert.equal(result.response.status, 202); const child = result.data;
  assert.equal(child.parentProjectId, parent.id); assert.equal(child.ownerId, ownerA); assert.equal(child.revision.number, 2); assert.equal(child.revision.mode, 'template-copy');
  assert.doesNotMatch(result.text, /revisionSeed|parentPlan|previewToken/);
  const dispatched = f.dispatched.at(-1).record;
  assert.deepEqual(dispatched.execution.revisionSeed.files.map(file => file.path).sort(), ['public/app.js', 'public/index.html', 'public/styles.css']);
  assert.equal(dispatched.execution.revisionSeed.parentPrompt, prompt);
  assert.deepEqual((await f.store.read(parent.id)).value.project, parent);
  assert.equal((await f.b(`/api/projects/${parent.id}/revise`, 'POST', { prompt: changes })).response.status, 404);
  assert.equal((await f.a(`/api/projects/${child.id}/revise`, 'POST', { prompt: changes })).response.status, 409);
  await f.store.update(child.id, record => ({ ...record, project: { ...record.project, status: 'failed' } }));
  const retried = await f.a(`/api/projects/${child.id}/retry`, 'POST', {});
  assert.equal(retried.response.status, 202); assert.equal(retried.data.revision.number, 2); assert.equal(retried.data.parentProjectId, parent.id); assert.equal(retried.data.ownerId, ownerA);
  assert.deepEqual(f.dispatched.at(-1).record.execution.revisionSeed, dispatched.execution.revisionSeed);
  assert.doesNotMatch((await f.a('/api/projects')).text, /revisionSeed|parentPlan|previewToken/);
  assert.equal((await f.a(`/api/projects/${parent.id}/revise`, 'POST', { prompt: 'x'.repeat(4001) })).response.status, 400);
});

for (const [name, fixture] of [['local', localFixture], ['cloud', cloudFixture]]) {
  test(`${name} project and estimate requests normalize agent delivery and reject unsupported combinations`, async t => {
    const f=await fixture(t);
    for(const route of ['/api/projects','/api/estimate']) {
      for(const input of [{kind:'ai-agent',agentDelivery:'plugin'},{kind:'ai-agent',agentDelivery:null},{kind:'web-app',agentDelivery:'api'},{kind:'mobile-app',agentDelivery:'web'}]) {
        assert.equal((await f.a(route,'POST',{prompt,...input})).response.status,400,`${route} must reject ${JSON.stringify(input)}`);
      }
    }
    for(const delivery of [undefined,'api','mcp']) {
      const input={prompt,kind:'ai-agent',...(delivery?{agentDelivery:delivery}:{})};
      const created=await f.a('/api/projects','POST',input);assert.equal(created.response.status,202);assert.equal(created.data.agentDelivery,delivery||'web');
      assert.equal((await f.a(`/api/projects/${created.data.id}`)).data.agentDelivery,delivery||'web');
      const estimate=await f.a('/api/estimate','POST',input);assert.equal(estimate.response.status,200);assert.equal(estimate.data.agentDelivery,delivery||'web');
    }
  });

  test(`${name} estimates use the current account provider, reject spoofed pricing choices, and make no generation calls`, async t => {
    const f = await fixture(t);
    assert.equal((await f.anonymous('/api/estimate', 'POST', { prompt, kind: 'web-app' })).response.status, 401);
    const local = await f.a('/api/estimate', 'POST', { prompt, kind: 'mobile-app', provider: 'gemini', model: 'spoofed' });
    assert.equal(local.response.status, 200); assert.equal(local.data.provider, 'local'); assert.equal(local.data.model, null); assert.equal(local.data.modelCalls.max, 0);
    assert.equal((await f.a('/api/credentials', 'PUT', { apiKey: key, provider: 'openai', model: 'test-model' })).response.status, 200);
    const personal = await f.a('/api/estimate', 'POST', { prompt, kind: 'web-app', provider: 'local' });
    assert.equal(personal.response.status, 200); assert.equal(personal.data.provider, 'openai'); assert.equal(personal.data.model, 'test-model'); assert.equal(personal.data.modelCalls.min, 2);
    if (name === 'cloud') { assert.equal(personal.data.cost.status, 'unpriced'); assert.equal(personal.data.cost.max, null); assert.equal(personal.data.modelRouting, 'automatic'); assert.equal(f.dispatched.length, 0); }
    assert.doesNotMatch(personal.text, /sk-test-revision|apiKey/);
    assert.equal((await f.b('/api/estimate', 'POST', { prompt, kind: 'web-app' })).data.provider, 'local');
    assert.equal((await f.a('/api/estimate', 'POST', { prompt: '짧게', kind: 'web-app' })).response.status, 400);
    assert.deepEqual((await f.a('/api/projects')).data, []);
  });
}

test('local planner, coder, persisted projects, revisions and retry retain an API agent delivery choice', {timeout:25000}, async t=>{
  const planned=[],coded=[];
  const provider={async plan(input){planned.push(input.agentDelivery);return localPlan(input.prompt,input.kind,{agentDelivery:input.agentDelivery});},async code(input){coded.push([input.agentDelivery,input.project.agentDelivery]);return input.files.filter(file=>['public/index.html','public/app.js','public/styles.css'].includes(file.path));}};
  const f=await localFixture(t,{provider});
  const parent=await complete(f,(await f.a('/api/projects','POST',{prompt,kind:'ai-agent',agentDelivery:'api'})).data.id);
  assert.equal(parent.agentDelivery,'api');assert.deepEqual(planned,['api']);assert.deepEqual(coded,[['api','api']]);
  const child=await complete(f,(await f.a(`/api/projects/${parent.id}/revise`,'POST',{prompt:changes,agentDelivery:'mcp'})).data.id);
  assert.equal(child.agentDelivery,'api','A revision preserves its parent delivery instead of accepting an unimplemented conversion');
  f.engine.store.get(child.id).status='failed';
  const retried=await f.a(`/api/projects/${child.id}/retry`,'POST',{});assert.equal(retried.response.status,202);assert.equal(retried.data.agentDelivery,'api');
  await complete(f,child.id);
  assert.ok(planned.every(value=>value==='api'));assert.ok(coded.every(value=>value[0]==='api'&&value[1]==='api'));
  const saved=JSON.parse(await readFile(path.join(f.dataDir,'projects.json'),'utf8'));
  assert.ok(saved.filter(value=>[parent.id,child.id].includes(value.id)).every(value=>value.agentDelivery==='api'));
});

test('cloud dispatch, retry and seeded revisions retain MCP delivery independently of client revision input',async t=>{
  const f=await cloudFixture(t);
  const created=(await f.a('/api/projects','POST',{prompt,kind:'ai-agent',agentDelivery:'mcp'})).data;
  assert.equal(f.dispatched.at(-1).record.project.agentDelivery,'mcp');
  await f.store.update(created.id,record=>({...record,project:{...record.project,status:'failed'}}));
  const retried=await f.a(`/api/projects/${created.id}/retry`,'POST',{});assert.equal(retried.response.status,202);assert.equal(retried.data.agentDelivery,'mcp');
  assert.equal(f.dispatched.at(-1).record.project.agentDelivery,'mcp');
  const parent={...retried.data,status:'completed',plan:localPlan(prompt,'ai-agent',{agentDelivery:'mcp'})};parent.files=await registry.get('ai-agent').generate(parent);
  await f.store.update(parent.id,record=>({...record,project:parent}));
  const revised=await f.a(`/api/projects/${parent.id}/revise`,'POST',{prompt:changes,agentDelivery:'web'});
  assert.equal(revised.response.status,202);assert.equal(revised.data.agentDelivery,'mcp');assert.equal(revised.data.parentProjectId,parent.id);
  assert.equal(f.dispatched.at(-1).record.project.agentDelivery,'mcp');assert.equal(f.dispatched.at(-1).record.execution.revisionSeed.parentProjectId,parent.id);
});
