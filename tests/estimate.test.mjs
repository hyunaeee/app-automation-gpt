import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateProject, estimateOptionsFromEnv } from '../server/estimate.mjs';

const input = { prompt: '독서한 책과 감상을 기록하는 앱을 만들어요.', kind: 'web-app', provider: 'openai', model: 'example-model' };

test('unpriced models return an honest unknown cost and bounded workflow estimates without claiming free usage', () => {
  const result = estimateProject(input);
  assert.deepEqual(result.modelCalls, { min: 2, max: 4 });
  assert.equal(result.cost.status, 'unpriced'); assert.equal(result.cost.min, null); assert.equal(result.cost.max, null);
  assert.equal(result.cost.rateSource, 'none');
  assert.ok(result.tokens.input.min > 0); assert.ok(result.tokens.output.max > result.tokens.output.min);
  assert.ok(result.timeSeconds.min > 0); assert.ok(result.timeSeconds.max >= result.timeSeconds.min);
  assert.ok(result.assumptions.some(value => value.includes('무료라는 뜻이 아닙니다')));
  assert.ok(result.assumptions.some(value => value.includes('실측 통계가 아닌')));
  assert.ok(result.excludedCosts.some(value => value.id === 'hosting'));
  assert.ok(result.excludedCosts.some(value => value.id === 'design'));
  assert.equal(result.prompt, undefined, 'The estimate does not echo potentially private prompt text');
});

test('configured exact-model rates price only model tokens and do not leak onto other providers or models', () => {
  // These are synthetic test rates, not vendor pricing.
  const options = { rates: { 'openai/example-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 6 } }, maxRetries: 1 };
  const result = estimateProject(input, options);
  assert.equal(result.cost.status, 'estimated'); assert.equal(result.cost.rateSource, 'configured');
  const min = (result.tokens.input.min * 2 + result.tokens.output.min * 6) / 1000000;
  const max = (result.tokens.input.max * 2 + result.tokens.output.max * 6) / 1000000;
  assert.ok(result.cost.min <= min); assert.ok(min - result.cost.min < 0.0000011);
  assert.ok(result.cost.max >= max); assert.ok(result.cost.max - max < 0.0000011);
  assert.equal(estimateProject({ ...input, model: 'different-model' }, options).cost.status, 'unpriced');
  assert.throws(() => estimateProject({ ...input, provider: 'gemini' }, options), error => error.status === 400);
});

test('automatic routing never prices multiple stages using a single fallback model rate', () => {
  const options = { rates: { 'openai/example-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 6 } } };
  const routed = estimateProject({ ...input, modelRouting: 'automatic' }, options);
  assert.equal(routed.modelRouting, 'automatic');
  assert.deepEqual(routed.cost, { currency: 'USD', status: 'unpriced', min: null, max: null, rateSource: 'none' });
  assert.ok(routed.assumptions.some(value => value.includes('기본 모델 하나의 단가')));
  assert.ok(routed.excludedCosts.some(value => value.id === 'images' && value.detail.includes('생성 시간')));
  assert.equal(estimateProject(input, options).cost.status, 'estimated', 'Explicit single-model estimates remain available to callers that do not use routing');
  const local = estimateProject({ ...input, provider: 'local', model: null, modelRouting: 'automatic' }, options);
  assert.equal(local.cost.status, 'not-applicable'); assert.equal(local.modelRouting, undefined);
  assert.throws(() => estimateProject({ ...input, modelRouting: 'unsupported' }), error => error.status === 400);
});

test('local generation avoids model charges but still exposes hosting and Android build costs separately', () => {
  const local = estimateProject({ ...input, provider: 'local', model: null });
  assert.deepEqual(local.modelCalls, { min: 0, max: 0 });
  assert.deepEqual(local.tokens, { input: { min: 0, max: 0 }, output: { min: 0, max: 0 } });
  assert.equal(local.cost.status, 'not-applicable'); assert.equal(local.cost.min, 0); assert.equal(local.cost.max, 0);
  const mobile = estimateProject({ ...input, kind: 'mobile-app', provider: 'local', model: null });
  assert.ok(mobile.timeSeconds.min > local.timeSeconds.min);
  assert.ok(mobile.timeBreakdown.androidBuildSeconds.max > 0);
  assert.equal(mobile.timeSeconds.max, mobile.timeBreakdown.generationSeconds.max + mobile.timeBreakdown.androidBuildSeconds.max);
  assert.ok(mobile.excludedCosts.some(value => value.id === 'android'));
  assert.ok(mobile.assumptions.some(value => value.includes('빌드 서버가 준비')));
});

test('repair bounds affect calls, tokens and duration without becoming an unlimited retry estimate', () => {
  const noRepair = estimateProject(input, { maxRetries: 0 });
  const oneRepair = estimateProject(input, { maxRetries: 1 });
  const capped = estimateProject(input, { maxRetries: 999 });
  assert.deepEqual(noRepair.modelCalls, { min: 2, max: 2 });
  assert.equal(oneRepair.modelCalls.max, 3); assert.equal(capped.modelCalls.max, 5);
  assert.ok(oneRepair.tokens.input.max > noRepair.tokens.input.max);
  assert.ok(oneRepair.tokens.output.max > noRepair.tokens.output.max);
  assert.ok(oneRepair.timeSeconds.max > noRepair.timeSeconds.max);
  assert.equal(estimateProject(input, { maxRetries: -3 }).modelCalls.max, 2);
  assert.equal(estimateProject(input, { maxRetries: NaN }).modelCalls.max, 4);
});

test('more complex descriptions widen resource estimates without promising unsupported features', () => {
  const small = estimateProject(input);
  const large = estimateProject({ ...input, prompt: '회원가입과 로그인, 대시보드, 차트 통계, 검색과 필터, 캘린더와 결제, 실시간 협업과 관리자 화면이 있는 앱' });
  assert.equal(small.complexity, 'small'); assert.equal(large.complexity, 'large');
  assert.ok(large.tokens.input.max > small.tokens.input.max);
  assert.ok(large.timeSeconds.max > small.timeSeconds.max);
  assert.ok(large.assumptions.some(value => value.includes('MVP 템플릿 범위')));
});

test('unsupported providers are rejected and account subscriptions are separate from OpenAI API estimates', () => {
  for (const provider of ['gemini', 'gemini-cli']) assert.throws(() => estimateProject({ ...input, provider }), error => error.status === 400);
  const result = estimateProject(input);
  assert.equal(result.cost.status, 'unpriced'); assert.equal(result.cost.min, null);
  assert.match(result.excludedCosts.find(value => value.id === 'subscription').detail, /ChatGPT 구독.*OpenAI API.*별개/);
});

test('environment parsing rejects invalid or incomplete prices without echoing configuration values', () => {
  const env = { MAX_RETRIES: '3', ESTIMATE_MODEL_RATES_JSON: JSON.stringify({
    'openai/example-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 3 },
    'gemini/unsupported-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 3 },
    'openai/missing-price': { inputUsdPerMillion: 1 },
    'openai/negative-price': { inputUsdPerMillion: -1, outputUsdPerMillion: 1 },
    'openai/string-price': { inputUsdPerMillion: 'private-value-must-not-echo', outputUsdPerMillion: 1 },
    '__proto__': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
  }) };
  const options = estimateOptionsFromEnv(env);
  assert.deepEqual(Object.keys(options.rates), ['openai/example-model']);
  assert.equal(options.maxRetries, 3); assert.ok(options.configurationWarnings.length > 0);
  assert.doesNotMatch(JSON.stringify(options), /private-value/);
  assert.equal(estimateProject(input, options).cost.status, 'estimated');
  for (const setting of ['{private-malformed-value', '[]', 'null']) {
    const fallback = estimateOptionsFromEnv({ ESTIMATE_MODEL_RATES_JSON: setting });
    assert.equal(estimateProject(input, fallback).cost.status, 'unpriced');
    assert.ok(fallback.configurationWarnings.length > 0);
    assert.doesNotMatch(JSON.stringify(fallback), /private-malformed-value/);
  }
});

test('estimates are deterministic, do not mutate input rates, and reject unsupported project settings', () => {
  const options = { rates: { 'openai/example-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } };
  const before = JSON.stringify({ input, options });
  assert.deepEqual(estimateProject(input, options), estimateProject(input, options));
  assert.equal(JSON.stringify({ input, options }), before);
  for (const invalid of [{ ...input, prompt: '' }, { ...input, prompt: 'x'.repeat(4001) },
    { ...input, kind: 'unsupported' }, { ...input, provider: 'other' }, { ...input, model: '' }]) {
    assert.throws(() => estimateProject(invalid), error => error.status === 400);
  }
});
