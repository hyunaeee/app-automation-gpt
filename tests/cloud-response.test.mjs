import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createCloudHandler } from '../server/cloud/handler.mjs';
import { projectListSummary } from '../server/cloud/response.mjs';

test('project list summaries omit artifact bytes while preserving card and workflow state', () => {
  const project = { id: crypto.randomUUID(), name: '이미지 프로젝트', prompt: '가방을 디자인하는 앱', status: 'awaiting_approval',
    workflowMode: 'guided', review: { id: crypto.randomUUID(), stage: 'requirements' },
    stages: [{ id: 'requirements', status: 'completed' }], files: [{ path: 'public/design-assets.js', content: 'private-image-bytes' }],
    logs: [{ message: 'private-execution-log' }], plan: { summary: 'private-plan' }, checks: [{ detail: 'private-check' }],
    modelUsage: [{ model: 'private-model-history' }], reviewHistory: [{ feedback: 'private-review-feedback' }] };
  const before = structuredClone(project); const result = projectListSummary(project);
  assert.equal(result.summaryOnly, true); assert.equal(result.name, project.name); assert.equal(result.status, 'awaiting_approval');
  assert.deepEqual(result.stages, project.stages); assert.deepEqual(result.review, project.review);
  assert.deepEqual(result.files, []); assert.deepEqual(result.logs, []); assert.equal(result.plan, null);
  assert.doesNotMatch(JSON.stringify(result), /private-/); assert.deepEqual(project, before);
});

test('cloud detail, events, and ZIP preserve large image assets through chunked responses', async t => {
  const id = crypto.randomUUID(); const content = 'data:image/png;base64,' + 'a'.repeat(5 * 1024 * 1024) + '\n// 원단 디자인 🧵';
  const project = { id, kind: 'web-app', name: '대형 이미지 자산', prompt: '사용자가 요청한 패션 디자인 이미지', status: 'completed',
    workflowMode: 'auto', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), previewUrl: null,
    files: [{ path: 'public/design-assets.js', language: 'javascript', content }], stages: [], checks: [], logs: [], plan: null };
  const record = { project, execution: { runId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 600000).toISOString() } };
  const store = { read: async () => ({ value: structuredClone(record), etag: 'fixed' }), list: async () => [structuredClone(record)] };
  const handler = createCloudHandler({ store, runner: {}, env: { AI_PROVIDER: 'openai', BLOB_READ_WRITE_TOKEN: 'private-storage', NODE_ENV: 'test' },
    auth: { configured: true, verify: () => true }, googleAuth: { configured: false, verify: () => null, owner: () => undefined }, credentialManager: { resolve: async () => null } });
  const writes = new Map();
  const server = http.createServer((req, res) => {
    const originalWrite = res.write.bind(res); let count = 0;
    res.write = (...args) => { count++; writes.set(req.url, count); return originalWrite(...args); };
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const listResponse = await fetch(`${base}/api/projects`); const listText = await listResponse.text();
  assert.ok(Buffer.byteLength(listText) < 2000); assert.equal(JSON.parse(listText)[0].summaryOnly, true);
  const route = `/api/projects/${id}`;
  const detail = await fetch(base + route);
  assert.equal(detail.headers.get('transfer-encoding'), 'chunked'); assert.equal(detail.headers.get('content-length'), null);
  assert.equal((await detail.json()).files[0].content, content); assert.ok(writes.get(route) > 50);
  const events = await fetch(base + route + '/events'); const eventText = await events.text();
  assert.ok(eventText.startsWith('event: project\ndata: '));
  assert.equal(JSON.parse(eventText.slice('event: project\ndata: '.length).trim()).files[0].content, content);
  assert.ok(writes.get(route + '/events') > 50);
  const download = await fetch(base + route + '/download'); const zip = Buffer.from(await download.arrayBuffer());
  assert.equal(download.headers.get('content-type'), 'application/zip'); assert.equal(zip.subarray(0, 2).toString(), 'PK');
  assert.ok(zip.includes(Buffer.from(content))); assert.ok(writes.get(route + '/download') > 50);
});
