import test from 'node:test';
import assert from 'node:assert/strict';
import { openAIProvider, validateAssets, validatePlan } from '../server/provider.mjs';
import { localPlan } from '../server/templates.mjs';
const fixedRouter=model=>({resolve:async()=>({roles:{planner:model,coder:model,debugger:model,image:null},hasImage:false})});

test('Responses adapter sends server-only credentials and parses text after reasoning items', async (t) => {
  const expected = localPlan('매일 독서 기록을 관리하는 앱', 'web-app');
  let payload;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.Authorization, 'Bearer test-secret-not-a-real-key');
    payload = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: 'completed', output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(expected) }] },
    ] }));
  });
  const provider = openAIProvider({ apiKey: 'test-secret-not-a-real-key', model: 'test-codex-model', router:fixedRouter('test-codex-model') });
  const result = await provider.plan({ prompt: '매일 독서 기록을 관리하는 앱', kind: 'web-app', signal: new AbortController().signal });
  assert.equal(result.name, expected.name);
  assert.equal(payload.model, 'test-codex-model');
  assert.ok(payload.text.format.type.startsWith('json'));
  assert.ok(!payload.input.includes('test-secret-not-a-real-key'));
});

test('Responses adapter surfaces refusal, incomplete output, HTTP failure and invalid JSON', async (t) => {
  let response;
  t.mock.method(globalThis, 'fetch', async () => response);
  const provider = openAIProvider({ apiKey: 'never-expose-this-key', model: 'test-model', router:fixedRouter('test-model') });
  for (const failure of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'Cannot answer' }] }] },
    { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{broken' }] }] },
    { httpError: true },
  ]) {
    response = failure.httpError ? new Response('private upstream failure', { status: 429 }) : new Response(JSON.stringify(failure));
    await assert.rejects(provider.plan({ prompt: '테스트 앱 생성', kind: 'web-app', signal: new AbortController().signal }), error => {
      assert.ok(!error.message.includes('never-expose-this-key'));
      assert.ok(!error.message.includes('private upstream'));
      return true;
    });
  }
});

test('model file allowlist rejects traversal, runtime replacement, duplicates and oversized content', () => {
  for (const files of [
    [{ path: '../server.mjs', content: 'x' }],
    [{ path: 'server.mjs', content: 'x' }],
    [{ path: 'public/app.js', content: 'x' }, { path: 'public/app.js', content: 'y' }],
    [{ path: 'public/app.js', content: 'x'.repeat(150001) }],
    [{ path: 'public/app.js', content: '' }],
  ]) assert.throws(() => validateAssets(files));
  assert.throws(() => validatePlan({ name: 'Invalid plan' }));
});
