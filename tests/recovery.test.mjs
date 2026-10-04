import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { localPlan } from '../server/templates.mjs';

async function setup(t, provider, settings = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'launchpad-recovery-'));
  const engine = await createApp({ dataDir, apiKey: '', provider, ...settings });
  const server = engine.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await engine.shutdown();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  async function api(route, body) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  async function finish(id) {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const { data } = await api('/api/projects/' + id);
      if (!['running', 'queued'].includes(data.status)) return data;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error('Timed out waiting for workflow');
  }
  return { engine, dataDir, api, finish };
}

test('validation failure is repaired with real error evidence and revalidated', { timeout: 35_000 }, async (t) => {
  const receivedErrors = [];
  let originalJs;
  const provider = {
    plan: async ({ prompt, kind }) => localPlan(prompt, kind),
    code: async ({ files, errors }) => {
      receivedErrors.push(errors);
      if (!originalJs) originalJs = files.find(file => file.path === 'public/app.js').content;
      return [{ path: 'public/app.js', content: errors.length ? originalJs : 'const broken = ;' }];
    },
  };
  const { api, finish } = await setup(t, provider);
  const { data: created } = await api('/api/projects', { prompt: '검증 가능한 작업 관리 앱을 만들어줘', kind: 'web-app' });
  const project = await finish(created.id);
  assert.equal(project.status, 'completed', project.error);
  assert.equal(project.mode, 'openai');
  assert.equal(project.retryCount, 1);
  assert.equal(project.stages.find(stage => stage.id === 'debugging').status, 'completed');
  assert.equal(receivedErrors.length, 2);
  assert.ok(receivedErrors[1].some(check => !check.passed));
  assert.ok(project.checks.every(check => check.passed));
  assert.ok(project.logs.some(log => /오류|수정|재검|실패/.test(log.message)));
});

test('persistent code errors stop after the configured repair limit', { timeout: 35_000 }, async (t) => {
  let codeCalls = 0;
  const { api, finish } = await setup(t, {
    plan: async ({ prompt, kind }) => localPlan(prompt, kind),
    code: async () => { codeCalls++; return [{ path: 'public/app.js', content: 'const broken = ;' }]; },
  }, { maxRetries: 1 });
  const { data: created } = await api('/api/projects', { prompt: '할 일을 관리하는 간단한 앱을 만들어줘', kind: 'web-app' });
  const project = await finish(created.id);
  assert.equal(project.status, 'failed');
  assert.equal(codeCalls, 2);
  assert.equal(project.retryCount, 1);
  assert.ok(project.checks.some(check => !check.passed));
  assert.equal(project.previewUrl, null);
});

test('provider failure remains visible, then an explicit retry can recover', { timeout: 35_000 }, async (t) => {
  let planningCalls = 0;
  const { api, finish } = await setup(t, {
    plan: async ({ prompt, kind }) => {
      if (++planningCalls === 1) throw new Error('Provider unavailable for test');
      return localPlan(prompt, kind);
    },
    code: async ({ files }) => files.filter(file => file.path.startsWith('public/')),
  });
  const { data: created } = await api('/api/projects', { prompt: '나만의 메모를 관리하는 앱을 만들어줘', kind: 'web-app' });
  const failed = await finish(created.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Provider unavailable/);
  assert.equal(failed.previewUrl, null);
  const retry = await api(`/api/projects/${created.id}/retry`, {});
  assert.equal(retry.status, 202);
  const complete = await finish(created.id);
  assert.equal(complete.status, 'completed', complete.error);
  assert.equal(planningCalls, 2);
});

test('cancel propagates to the in-flight provider and does not publish a result', { timeout: 10_000 }, async (t) => {
  let notifyStarted;
  let wasAborted = false;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const { api, finish } = await setup(t, {
    plan: async ({ signal }) => new Promise((_resolve, reject) => {
      const abort = () => { wasAborted = true; reject(new Error('Aborted')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      notifyStarted();
    }),
    code: async () => { throw new Error('Coding must never start after cancellation'); },
  });
  const { data: created } = await api('/api/projects', { prompt: '취소 가능한 작업 관리 앱을 만들어줘', kind: 'web-app' });
  await started;
  const cancel = await api(`/api/projects/${created.id}/cancel`, {});
  assert.equal(cancel.status, 200);
  const project = await finish(created.id);
  assert.equal(project.status, 'cancelled');
  assert.equal(project.previewUrl, null);
  assert.ok(wasAborted);
});

test('model output cannot overwrite the trusted runtime or traverse project paths', { timeout: 10_000 }, async (t) => {
  const { api, finish } = await setup(t, {
    plan: async ({ prompt, kind }) => localPlan(prompt, kind),
    code: async () => [{ path: '../escaped.mjs', content: 'bad' }, { path: 'server.mjs', content: 'bad' }],
  });
  const { data: created } = await api('/api/projects', { prompt: '파일 격리를 확인하는 간단한 작업 앱', kind: 'web-app' });
  const project = await finish(created.id);
  assert.equal(project.status, 'failed');
  assert.ok(project.error);
  assert.equal(project.previewUrl, null);
});
