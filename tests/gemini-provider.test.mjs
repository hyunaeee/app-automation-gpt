import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiProvider, GEMINI_DEFAULT_MODEL } from '../server/gemini-provider.mjs';
import { localPlan, TEMPLATE_FILES } from '../server/templates.mjs';
import { mobilePlan, generateMobileAssets } from '../server/mobile-template.mjs';

const key = 'AIza-test-server-secret-not-a-real-key';
const completion = value => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(value) }] } }] });
const planInput = { prompt: '독서 기록을 정리하는 간단한 앱', kind: 'web-app' };

test('Gemini adapter uses server-only key headers, fixed HTTPS REST endpoint, and current structured JSON output', async t => {
  const expected = localPlan(planInput.prompt, planInput.kind); let payload;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_DEFAULT_MODEL}:generateContent`);
    assert.ok(!url.includes(key)); assert.equal(new URL(url).search, '');
    assert.equal(init.headers['x-goog-api-key'], key); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    payload = JSON.parse(init.body);
    const split = JSON.stringify(expected); const middle = Math.floor(split.length / 2);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { thought: true, text: 'Private intermediate reasoning which is not JSON output.' },
      { text: split.slice(0, middle) }, { text: split.slice(middle) },
    ] } }] });
  });
  const output = await geminiProvider({ apiKey: key }).plan(planInput);
  assert.equal(GEMINI_DEFAULT_MODEL, 'gemini-3.8-flash');
  assert.deepEqual(output, { ...expected, fileTree: [...TEMPLATE_FILES] });
  assert.equal(payload.contents[0].role, 'user'); assert.equal(payload.contents[0].parts[0].text, planInput.prompt);
  assert.equal(payload.generationConfig.responseFormat.text.mimeType, 'application/json');
  assert.equal(payload.generationConfig.responseFormat.text.schema.type, 'object');
  assert.equal(payload.generationConfig.candidateCount, 1);
  assert.equal(payload.generationConfig.maxOutputTokens, 16000);
  assert.ok(!JSON.stringify(payload).includes(key));
  assert.match(payload.systemInstruction.parts[0].text, /Node\.js HTTP server/);
  assert.match(payload.systemInstruction.parts[0].text, /Do not ask questions/);
  assert.equal(payload.tools, undefined);
});

test('mobile planning describes actual offline capabilities and returns browser files only', async t => {
  const expected = mobilePlan('독서 노트를 관리하는 앱'); let payload;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { payload = JSON.parse(init.body); return Response.json(completion(expected)); });
  const output = await geminiProvider({ apiKey: key }).plan({ prompt: '독서 노트를 관리하는 앱', kind: 'mobile-app' });
  assert.deepEqual(output.fileTree, ['public/index.html', 'public/app.js', 'public/styles.css']);
  const instructions = payload.systemInstruction.parts[0].text;
  assert.match(instructions, /offline Android WebView/); assert.match(instructions, /localStorage/);
  assert.match(instructions, /local display-name profile is not authentication/);
  assert.match(instructions, /preview is not an Android OS emulator/);
  assert.match(instructions, /No cloud authentication/);
});

test('mobile coding preserves relative offline assets, local data, and excludes privileged files from model input', async t => {
  const project = { id: 'mobile-test', kind: 'mobile-app', prompt: '나의 기록 앱', plan: mobilePlan('나의 기록 앱') };
  const assets = generateMobileAssets(project); let payload;
  t.mock.method(globalThis, 'fetch', async (_url, init) => { payload = JSON.parse(init.body); return Response.json(completion({ files: assets })); });
  const output = await geminiProvider({ apiKey: key }).code({ project,
    files: [...assets, { path: 'server.mjs', content: 'do-not-send-server' }, { path: '.env', content: 'private-key-do-not-send' }],
    errors: [{ name: 'offline storage', passed: false, detail: 'must retain existing items' }],
  });
  assert.deepEqual(output, assets);
  const context = JSON.parse(payload.contents[0].parts[0].text), instructions = payload.systemInstruction.parts[0].text;
  assert.equal(context.currentFiles.length, 3); assert.equal(context.failedChecks.length, 1);
  assert.doesNotMatch(payload.contents[0].parts[0].text, /do-not-send-server|private-key-do-not-send/);
  assert.match(instructions, /relative classic script src "app\.js"/);
  assert.match(instructions, /No fetch, XMLHttpRequest, WebSocket/);
  assert.match(instructions, /retain the existing unique per-project storage key/);
  assert.match(instructions, /Repair the specific failing checks/);
});

test('web and agent coding maintain existing authenticated server API contracts', async t => {
  const returned = { files: [{ path: 'public/app.js', content: 'document.body.textContent = "안녕하세요";' }] }; let payload;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(url, /models\/gemini-2\.5-flash:generateContent$/);
    payload = JSON.parse(init.body); return Response.json(completion(returned));
  });
  const provider = geminiProvider({ apiKey: key, model: 'models/gemini-2.5-flash' });
  const result = await provider.code({ project: { kind: 'ai-agent', prompt: '텍스트 정리 에이전트', plan: localPlan('텍스트 정리 에이전트', 'ai-agent') }, files: [], errors: [] });
  assert.equal(result[0].language, 'javascript');
  assert.match(payload.systemInstruction.parts[0].text, /POST \/api\/auth\/signup/);
  assert.match(payload.systemInstruction.parts[0].text, /POST \/api\/agent\/run/);
  assert.match(payload.systemInstruction.parts[0].text, /module script src \/app\.js/);
  assert.deepEqual(payload.generationConfig.responseFormat.text.schema.properties.files.items.properties.path.enum, ['public/index.html', 'public/app.js', 'public/styles.css']);
});

test('Gemini blocks safety failures, incomplete candidates, unexpected tool output, and malformed responses', async t => {
  let response; t.mock.method(globalThis, 'fetch', async () => response);
  const provider = geminiProvider({ apiKey: key });
  const valid = localPlan(planInput.prompt, planInput.kind);
  const failures = [
    { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'private-error-do-not-echo' } },
    { error: { message: 'private-error-do-not-echo' } },
    { candidates: [] }, { candidates: [{ content: { parts: [{ text: JSON.stringify(valid) }] } }] },
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: JSON.stringify(valid) }] } }] },
    { candidates: [{ finishReason: 'SAFETY' }] }, { candidates: [{ finishReason: 'RECITATION' }] },
    { candidates: [{ finishReason: 'STOP', safetyRatings: [{ blocked: true }], content: { parts: [{ text: JSON.stringify(valid) }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'shell' } }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{broken-private-error-do-not-echo' }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: JSON.stringify(valid) }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [null] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'a'.repeat(500001) }] } }] },
    { candidates: [...completion(valid).candidates, ...completion(valid).candidates] },
  ];
  for (const failure of failures) {
    response = Response.json(failure);
    await assert.rejects(provider.plan(planInput), error => { assert.doesNotMatch(error.message, /private-error-do-not-echo|AIza-test-server-secret/); return true; });
  }
  response = new Response('private-error-do-not-echo', { status: 429 });
  await assert.rejects(provider.plan(planInput), error => /HTTP 429/.test(error.message) && !error.message.includes('private-error'));
  response = new Response('private-error-do-not-echo');
  await assert.rejects(provider.plan(planInput), error => !error.message.includes('private-error'));
});

test('Gemini output still passes platform semantic validation and file allowlisting', async t => {
  let value; t.mock.method(globalThis, 'fetch', async () => Response.json(completion(value)));
  const provider = geminiProvider({ apiKey: key });
  value = { name: 'incomplete-plan' };
  await assert.rejects(provider.plan(planInput), /Planner/);
  const project = { kind: 'web-app', prompt: '나의 웹 앱', plan: localPlan('나의 웹 앱', 'web-app') };
  for (const files of [[{ path: '../outside.txt', content: 'bad' }], [{ path: 'server.mjs', content: 'bad' }],
    [{ path: 'public/app.js', content: 'x' }, { path: 'public/app.js', content: 'y' }]]) {
    value = { files }; await assert.rejects(provider.code({ project, files: [] }), /Coding Agent/);
  }
  value = { ...localPlan(planInput.prompt, planInput.kind), fileTree: ['../do-not-trust'] };
  assert.deepEqual((await provider.plan(planInput)).fileTree, TEMPLATE_FILES);
});

test('Gemini cancellation and network failures never reflect upstream secrets', async t => {
  const controller = new AbortController();
  let called = 0;
  t.mock.method(globalThis, 'fetch', async () => { called++; throw new Error('private-network-secret'); });
  const provider = geminiProvider({ apiKey: key });
  await assert.rejects(provider.plan(planInput), error => !error.message.includes('private-network-secret'));
  controller.abort(new Error('private-abort-reason'));
  await assert.rejects(provider.plan({ ...planInput, signal: controller.signal }), error => error.name === 'AbortError' && !error.message.includes('private-abort-reason'));
  assert.equal(called, 1, 'An already cancelled request must not reach the provider');
});

test('invalid key headers or model paths are rejected before sending a request', () => {
  for (const model of ['../outside', 'https://attacker.example/model', 'model?key=secret', 'model:method', '', null]) assert.throws(() => geminiProvider({ apiKey: key, model }), /모델 ID/);
  for (const apiKey of ['', undefined, 'x\r\nInjected: value', 'x'.repeat(1025)]) assert.throws(() => geminiProvider({ apiKey }), /API 키/);
});
