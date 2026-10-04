import test from 'node:test';
import assert from 'node:assert/strict';
import { openAIProvider } from '../server/provider.mjs';
import { fashionAssets, fashionPlan } from '../server/fashion-template.mjs';

const marker = '/* Launchpad AI design layer */';
const prompt = '가방과 의류 디자인의 치수 도면, 원단 재료 수량과 제작 비용을 계산하는 앱';
const project = { id: 'fashion-provider-test', kind: 'web-app', prompt, plan: fashionPlan(prompt) };
const stylesheet = files => files.find(file => file.path === 'public/styles.css');

test('fashion refinement returns only CSS and preserves the working HTML, calculation code and original files', async () => {
  const files = [...fashionAssets(project), { path: 'server.mjs', content: 'private server content' }];
  const original = structuredClone(files), signal = new AbortController().signal;
  const css = 'body { color: #22372b; }\n@media (max-width: 600px) { .workspace { gap: 12px; } }';
  const errors = ['본문 대비를 개선하세요.'];
  let request;
  const provider = openAIProvider({ requestJson: async (...args) => {
    request = args;
    return { css, files: [{ path: 'public/app.js', content: 'untrusted replacement' }] };
  } });
  const result = await provider.code({ project, files, errors, signal });
  assert.equal(request[4], 'fashion_styles');
  assert.equal(request[2], signal);
  assert.deepEqual(request[3], { type: 'object', properties: { css: { type: 'string' } }, required: ['css'], additionalProperties: false });
  assert.deepEqual(JSON.parse(request[1]), { idea: prompt, plan: project.plan.summary, stylesheet: stylesheet(files).content, failedChecks: errors });
  assert.doesNotMatch(request[1], /private server content|function estimateFashion/);
  assert.deepEqual(result, [{ path: 'public/styles.css', language: 'css', content: stylesheet(original).content + '\n' + marker + '\n' + css }]);
  const merged = files.map(file => result.find(update => update.path === file.path) || file);
  for (const path of ['public/index.html', 'public/app.js', 'server.mjs']) {
    assert.deepEqual(merged.find(file => file.path === path), original.find(file => file.path === path));
  }
  assert.deepEqual(files, original, 'Provider must not mutate the supplied scaffold.');
});

test('a repeated fashion refinement replaces the previous AI layer while retaining the original stylesheet', async () => {
  const files = fashionAssets(project), base = stylesheet(files).content;
  const oldCss = '.old-design-layer { color: tomato; }';
  const newCss = '.new-design-layer { color: darkgreen; }';
  let iteration = 0;
  const provider = openAIProvider({ requestJson: async () => ({ css: iteration++ ? newCss : oldCss }) });
  const first = await provider.code({ project, files, errors: [] });
  const revisedFiles = files.map(file => first.find(update => update.path === file.path) || file);
  const second = await provider.code({ project, files: revisedFiles, errors: [] });
  // Whitespace before the marker is harmless; the complete trusted base stays intact.
  assert.ok(second[0].content.startsWith(base));
  assert.equal(second[0].content.split(marker).length - 1, 1);
  assert.ok(second[0].content.endsWith(newCss));
  assert.doesNotMatch(second[0].content, /old-design-layer/);
  assert.deepEqual(first.map(file => file.path), ['public/styles.css']);
  assert.deepEqual(second.map(file => file.path), ['public/styles.css']);
});

test('fashion refinement rejects missing, empty, non-text, oversized and external-resource CSS', async t => {
  const invalid = [
    ['missing', undefined], ['null', null], ['empty', ''], ['whitespace', ' \n\t'],
    ['number', 42], ['object', { body: { color: 'red' } }],
    ['oversized', 'x'.repeat(20001)],
    ['import', '@import "https://example.com/style.css";'],
    ['mixed-case import', '@ImPoRt "style.css";'],
    ['remote url', 'body { background: url(https://example.com/image.png); }'],
    ['relative url', 'body { background: URL  (/private-resource); }'],
    ['data url', 'body { background: url(data:image/svg+xml;base64,AAAA); }'],
  ];
  for (const [name, css] of invalid) await t.test(name, async () => {
    const files = fashionAssets(project), original = structuredClone(files);
    const provider = openAIProvider({ requestJson: async () => ({ css }) });
    await assert.rejects(provider.code({ project, files, errors: [] }), /허용된 스타일 형식/);
    assert.deepEqual(files, original);
  });
});

test('fashion refinement requires a trusted stylesheet before invoking the model', async () => {
  let called = false;
  const provider = openAIProvider({ requestJson: async () => { called = true; return { css: 'body { color: red; }' }; } });
  await assert.rejects(provider.code({ project, files: fashionAssets(project).filter(file => file.path !== 'public/styles.css'), errors: [] }), /기준 스타일/);
  assert.equal(called, false);
});
