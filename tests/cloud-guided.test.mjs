import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createBlobStore } from '../server/cloud/store.mjs';
import { createCloudHandler } from '../server/cloud/handler.mjs';
import { workerInitialOptions, publishWorkerSnapshot, requestPausedSandboxStop } from '../server/cloud/workflow-state.mjs';
import { applyReviewDecision, pauseForReview } from '../server/workflow-review.mjs';
import { createApp } from '../server/app.mjs';
import { registry } from '../server/templates.mjs';

function memoryBlob() {
  const records = new Map(); let revision = 0;
  return {
    async get(key) { const record = records.get(key); return record ? { stream: new Blob([record.contents]).stream(), blob: { etag: record.etag } } : null; },
    async put(key, contents, options) {
      const previous = records.get(key);
      if ((previous && !options.allowOverwrite) || (options.ifMatch && previous?.etag !== options.ifMatch)) throw Object.assign(new Error('stale write'), { name: 'BlobPreconditionFailedError' });
      const etag = `version-${++revision}`; records.set(key, { contents, etag }); return { etag };
    },
    async list({ prefix }) { return { blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(pathname => ({ pathname })), hasMore: false }; },
  };
}

async function fixture(t, { apiKey = 'shared-test-key', credentialManager, onCreate } = {}) {
  const store = createBlobStore({ blob: memoryBlob() }); const created = [], stopped = [];
  const runner = {
    timeout: 300000,
    async create(record, ready, connection) {
      created.push({ record: structuredClone(record), connection });
      record.execution.name = `sandbox-${record.execution.runId}`; record.execution.url = 'https://preview.example';
      if (!await ready(record)) return;
      if (onCreate) await onCreate(record, store);
      else await store.update(record.project.id, current => ({ ...current, project: { ...current.project, status: 'running' } }));
    },
    async inspect() { return { status: 'running' }; },
    async stop(execution) { stopped.push(execution.runId); },
  };
  const env = { WORKSPACE_PASSWORD: 'guided-workspace-password', SESSION_SECRET: 's'.repeat(40), BLOB_READ_WRITE_TOKEN: 'test-blob', NODE_ENV: 'test', OPENAI_API_KEY: apiKey, PUBLIC_APP_URL: 'https://app.example' };
  const server = http.createServer(createCloudHandler({ store, runner, env, ...(credentialManager ? { credentialManager } : {}) }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: env.WORKSPACE_PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(route, input, headers = {}) {
    const response = await fetch(base + route, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, data: await response.json() };
  }
  async function create(input = {}) {
    const result = await request('/api/projects', { prompt: '내 디자인 아이디어를 기획하고 저장하는 앱', kind: 'web-app', workflowMode: 'guided', ...input });
    assert.equal(result.status, 202); return result.data;
  }
  async function pause(id, stage = 'requirements') {
    return await store.update(id, current => {
      current.project.plan = { name: '검토할 디자인 앱', summary: '이전 명세가 유지되어야 합니다.', features: [{ name: '도면 관리', description: '치수 입력을 저장합니다.' }] };
      current.project.stages.find(item => item.id === stage).status = 'completed';
      pauseForReview(current.project, stage); return current;
    });
  }
  return { store, runner, request, create, pause, created, stopped, base };
}

test('guided cloud review preserves checkpoints, claims one resume, and rejects stale approvals', async t => {
  const f = await fixture(t); const project = await f.create(); const paused = await f.pause(project.id);
  const reviewId = paused.project.review.id; const firstRun = paused.execution.runId;
  await f.store.update(project.id, current => ({ ...current, execution: { ...current.execution, expiresAt: new Date(0).toISOString() } }));
  const read = await f.request(`/api/projects/${project.id}`);
  assert.equal(read.data.status, 'awaiting_approval', 'Waiting for a person never expires with a worker deadline');
  assert.ok(f.stopped.includes(firstRun));
  assert.ok((await f.store.read(project.id)).value.execution.pauseStoppedAt);
  const results = await Promise.all([1, 2].map(() => f.request(`/api/projects/${project.id}/review`, { reviewId, action: 'approve' })));
  assert.deepEqual(results.map(result => result.status).sort(), [202, 409]);
  assert.equal(f.created.length, 2, 'Only one replacement worker may start');
  const resumed = f.created.at(-1).record;
  assert.notEqual(resumed.execution.runId, firstRun);
  assert.equal(resumed.execution.resumeFromReview, true);
  assert.equal(resumed.project.workflowMode, 'guided');
  assert.deepEqual(resumed.project.plan, paused.project.plan);
  assert.deepEqual(resumed.project.approvedStages, ['requirements']);
  assert.equal(resumed.project.stages[0].status, 'completed');
  assert.equal(resumed.project.review, null);
  assert.equal((await f.request(`/api/projects/${project.id}/review`, { reviewId, action: 'approve' })).status, 409);
  assert.equal(JSON.stringify(results).includes(resumed.execution.controlToken), false);
});

test('guided feedback needs AI, is validated before mutation, and replans from retained context', async t => {
  const f = await fixture(t); const project = await f.create(); const paused = await f.pause(project.id, 'architecture');
  const reviewId = paused.project.review.id;
  assert.equal((await f.request(`/api/projects/${project.id}/review`, { reviewId, action: 'revise', feedback: '짧음' })).status, 400);
  assert.equal((await f.store.read(project.id)).value.project.review.id, reviewId);
  const feedback = '가방뿐 아니라 옷 도면도 만들고 재료 소요량을 계산해 주세요.';
  assert.equal((await f.request(`/api/projects/${project.id}/review`, { reviewId, action: 'revise', feedback })).status, 202);
  const next = f.created.at(-1).record.project;
  assert.deepEqual(next.plan, paused.project.plan);
  assert.ok(next.stages.every(stage => stage.status === 'pending'));
  assert.deepEqual(next.approvedStages, []);
  assert.equal(next.reviewHistory.at(-1).feedback, feedback);
  const local = await fixture(t, { apiKey: '' }); const localProject = await local.create(); const localPaused = await local.pause(localProject.id);
  assert.equal((await local.request(`/api/projects/${localProject.id}/review`, { reviewId: localPaused.project.review.id, action: 'revise', feedback })).status, 409);
  assert.equal((await local.store.read(localProject.id)).value.project.status, 'awaiting_approval');
});

test('paused cloud projects cancel safely and retry with fresh approvals and the same workflow mode', async t => {
  const f = await fixture(t); const project = await f.create(); const paused = await f.pause(project.id);
  assert.equal((await f.request(`/api/projects/${project.id}/cancel`, {})).data.status, 'cancelled');
  assert.equal((await f.store.read(project.id)).value.project.review, null);
  assert.equal((await f.request(`/api/projects/${project.id}/review`, { reviewId: paused.project.review.id, action: 'approve' })).status, 409);
  assert.equal((await f.request(`/api/projects/${project.id}/retry`, {})).status, 202);
  const retried = f.created.at(-1).record.project;
  assert.equal(retried.workflowMode, 'guided'); assert.deepEqual(retried.approvedStages, []); assert.equal(retried.review, null);
  assert.ok(retried.stages.every(stage => stage.status === 'pending'));
  assert.equal((await f.request('/api/projects', { prompt: '잘못된 진행 방식으로 프로젝트 만들기', kind: 'web-app', workflowMode: 'unknown' })).status, 400);
  const automatic = await f.create({ workflowMode: undefined }); assert.equal(automatic.workflowMode, 'auto');
});

test('cloud revision inherits guided mode and retains its private source seed across approval', async t => {
  const f = await fixture(t); const parent = await f.create(); const template = registry.get(parent.kind);
  await f.store.update(parent.id, async current => {
    current.project.plan = await template.plan(current.project.prompt, current.project.kind);
    current.project.files = await template.generate(current.project); current.project.status = 'completed'; return current;
  });
  const revision = await f.request(`/api/projects/${parent.id}/revise`, { prompt: '원단 색상을 선택하는 화면을 추가해 주세요.', workflowMode: 'auto' });
  assert.equal(revision.status, 202); assert.equal(revision.data.workflowMode, 'guided');
  const paused = await f.pause(revision.data.id);
  assert.equal((await f.request(`/api/projects/${revision.data.id}/review`, { reviewId: paused.project.review.id, action: 'approve' })).status, 202);
  const next = f.created.at(-1).record;
  const imported = workerInitialOptions(next, 'generate');
  assert.equal(imported.initialRevisionSeeds[next.project.id].parentProjectId, parent.id);
  assert.equal(imported.initialRevisionSeeds[next.project.id].files.length, 3);
  assert.equal(JSON.stringify(revision.data).includes('revisionSeed'), false);
});

test('cancellation while reserving a cloud worker never gets overwritten by bootstrap', async t => {
  const f = await fixture(t); const originalReserve = f.store.reserve;
  let continueReserve, reservationReached;
  const reached = new Promise(resolve => { reservationReached = resolve; });
  const gate = new Promise(resolve => { continueReserve = resolve; });
  f.store.reserve = async (...args) => { const slot = await originalReserve(...args); reservationReached(args[1]); await gate; return slot; };
  const creation = f.request('/api/projects', { prompt: '생성 대기 중에 취소할 수 있는 디자인 앱', kind: 'web-app', workflowMode: 'guided' });
  const id = await reached;
  assert.equal((await f.request(`/api/projects/${id}/cancel`, {})).data.status, 'cancelled');
  continueReserve();
  assert.equal((await creation).data.status, 'cancelled');
  assert.equal((await f.store.read(id)).value.project.status, 'cancelled');
  assert.equal(f.created.length, 0);
});

test('cloud review requires project ownership and the original personal credential', async t => {
  const ownerId = crypto.randomUUID(); let connected = true;
  const credential = { ownerId, source: 'personal', provider: 'openai', model: 'test-model', revision: 'key-version', apiKey: 'personal-test-key', expiresAt: Date.now() + 600000 };
  const credentialManager = {
    owner: req => req.headers['x-owner'],
    resolve: async req => connected && req.headers['x-owner'] === ownerId ? credential : null,
    readOwner: async () => connected ? credential : null,
  };
  const f = await fixture(t, { credentialManager });
  const result = await f.request('/api/projects', { prompt: '개인 키로 만드는 단계별 디자인 앱', kind: 'web-app', workflowMode: 'guided' }, { 'x-owner': ownerId });
  assert.equal(result.status, 202); const paused = await f.pause(result.data.id);
  const input = { reviewId: paused.project.review.id, action: 'approve' };
  assert.equal((await f.request(`/api/projects/${result.data.id}/review`, input, { 'x-owner': 'other' })).status, 404);
  connected = false;
  assert.equal((await f.request(`/api/projects/${result.data.id}/review`, input, { 'x-owner': ownerId })).status, 409);
  assert.equal(f.created.length, 1);
  assert.equal((await fetch(`${f.base}/api/projects/${result.data.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
});

test('worker pause callback is secret-scoped and cannot stop a replacement execution', async t => {
  const f = await fixture(t); const project = await f.create(); const paused = await f.pause(project.id);
  const route = `/api/internal/projects/${project.id}/pause`;
  assert.equal((await f.request(route, { runId: paused.execution.runId })).status, 401);
  assert.equal((await f.request(route, { runId: paused.execution.runId }, { authorization: `Bearer ${paused.execution.controlToken}` })).status, 200);
  assert.equal((await f.store.read(project.id)).value.project.status, 'awaiting_approval');
  const input = { reviewId: paused.project.review.id, action: 'approve' };
  assert.equal((await f.request(`/api/projects/${project.id}/review`, input)).status, 202);
  const before = f.stopped.length;
  assert.equal((await f.request(route, { runId: paused.execution.runId }, { authorization: `Bearer ${paused.execution.controlToken}` })).status, 401);
  assert.equal(f.stopped.length, before);
  const calls = [];
  assert.equal(await requestPausedSandboxStop({ id: project.id, runId: 'current', origin: 'https://app.example', token: 'scoped-worker-secret', fetcher: async (url, init) => { calls.push({ url, init }); return new Response('{}'); } }), true);
  assert.equal(calls[0].url.pathname, route); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer scoped-worker-secret');
  assert.equal(await requestPausedSandboxStop({ id: project.id, runId: 'current', origin: 'http://other.example', token: 'secret', fetcher: () => { throw new Error('must not send'); } }), false);
});

test('an in-flight old pause callback cannot stop or mark a newly approved cloud execution', async t => {
  const f = await fixture(t); const project = await f.create(); const paused = await f.pause(project.id);
  const originalStop = f.runner.stop; let stopEntered, releaseOldStop;
  const entered = new Promise(resolve => { stopEntered = resolve; });
  const gate = new Promise(resolve => { releaseOldStop = resolve; }); let first = true;
  f.runner.stop = async execution => { await originalStop(execution); if (first) { first = false; stopEntered(); await gate; } };
  const callback = f.request(`/api/internal/projects/${project.id}/pause`, { runId: paused.execution.runId }, { authorization: `Bearer ${paused.execution.controlToken}` });
  await entered;
  assert.equal((await f.request(`/api/projects/${project.id}/review`, { reviewId: paused.project.review.id, action: 'approve' })).status, 202);
  const replacement = (await f.store.read(project.id)).value;
  releaseOldStop();
  assert.equal((await callback).status, 409);
  const current = (await f.store.read(project.id)).value;
  assert.equal(current.execution.runId, replacement.execution.runId);
  assert.equal(current.project.status, 'running'); assert.equal(current.execution.pauseStoppedAt, undefined);
  assert.ok(f.stopped.every(runId => runId === paused.execution.runId));
});

test('a temporary lease cleanup failure cannot prevent a paused Sandbox from stopping', async t => {
  const f = await fixture(t); const project = await f.create(); const paused = await f.pause(project.id);
  f.store.release = async () => { throw new Error('transient lease write failure'); };
  const callback = await f.request(`/api/internal/projects/${project.id}/pause`, { runId: paused.execution.runId }, { authorization: `Bearer ${paused.execution.controlToken}` });
  assert.equal(callback.status, 200); assert.ok(f.stopped.includes(paused.execution.runId));
  assert.equal((await f.store.read(project.id)).value.project.status, 'awaiting_approval');
  assert.equal(await publishWorkerSnapshot(f.store, project.id, paused.execution.runId, paused.project), true);
});

test('durable worker publication releases waiting slots and fences stale, cancelled, and revoked runs', async () => {
  const store = createBlobStore({ blob: memoryBlob() }); const id = crypto.randomUUID(); const runId = crypto.randomUUID();
  const base = { project: { id, status: 'running', createdAt: new Date().toISOString(), workflowMode: 'guided', review: null }, execution: { runId, slot: 0 } };
  await store.write(base);
  await store.reserve(runId, id, new Date(Date.now() + 600000).toISOString(), 1);
  const paused = { ...base.project, status: 'awaiting_approval', review: { id: crypto.randomUUID(), stage: 'requirements' } };
  assert.equal(await publishWorkerSnapshot(store, id, runId, paused), true);
  assert.equal(await publishWorkerSnapshot(store, id, runId, { ...paused, status: 'running', review: null }), false);
  assert.equal((await store.read(id)).value.project.status, 'awaiting_approval');
  await store.update(id, current => ({ ...current, execution: { ...current.execution, runId: 'replacement' }, project: { ...current.project, status: 'queued', review: null } }));
  assert.equal(await publishWorkerSnapshot(store, id, runId, { ...base.project, status: 'completed' }), false);
  assert.equal(await store.reserve('replacement', id, new Date(Date.now() + 600000).toISOString(), 1), 0, 'Paused worker lease was released before waiting for approval');
  await store.update(id, current => ({ ...current, project: { ...current.project, status: 'cancelled' } }));
  assert.equal(await publishWorkerSnapshot(store, id, 'replacement', base.project), false);
  await store.update(id, current => ({ ...current, project: { ...current.project, status: 'running' }, execution: { ...current.execution, credentialRevoked: true } }));
  assert.equal(await publishWorkerSnapshot(store, id, 'replacement', base.project), false);
});

test('a new cloud worker rehydrates approved planning without repeating the model call', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'launchpad-guided-cloud-'));
  let first, resumed;
  t.after(async () => {
    await first?.shutdown(); await resumed?.shutdown();
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), 'launchpad-guided-cloud-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  first = await createApp({ dataDir: path.join(directory, 'first'), apiKey: '', disableAutoAndroid: true });
  const project = await first.createProject({ prompt: '가방 도면을 기획하고 재료를 계산하는 앱', kind: 'web-app', workflowMode: 'guided' });
  await first.runProject(project.id);
  assert.equal(project.status, 'awaiting_approval');
  const checkpoint = structuredClone(project);
  applyReviewDecision(checkpoint, { reviewId: checkpoint.review.id, action: 'approve' });
  const record = { project: checkpoint, execution: { resumeFromReview: true } };
  const restored = workerInitialOptions(record, 'generate');
  assert.deepEqual(restored.resumeIds, [project.id]);
  let modelCalls = 0;
  resumed = await createApp({ ...restored, dataDir: path.join(directory, 'replacement'), disableAutoAndroid: true, provider: { async plan() { modelCalls++; throw new Error('Approved planning must not execute again'); } } });
  await resumed.runProject(project.id);
  const next = resumed.store.get(project.id);
  assert.equal(next.status, 'awaiting_approval'); assert.equal(next.review.stage, 'features'); assert.equal(modelCalls, 0);
  assert.deepEqual(next.plan, project.plan); assert.deepEqual(next.approvedStages, ['requirements']);
});
