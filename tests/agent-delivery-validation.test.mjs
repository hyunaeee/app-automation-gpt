import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentDelivery } from '../server/agent-delivery.mjs';
import { estimateProject } from '../server/estimate.mjs';

const input = {
  prompt: '업무 기록을 분석하고 다음 작업을 정리하는 AI 에이전트를 만들어요.',
  kind: 'ai-agent',
  provider: 'openai',
  model: 'example-model',
};
const deliveries = ['web', 'api', 'mcp'];
const invalidDeliveries = [null, '', 'WEB', ' api ', 'mobile', 0, false, [], {}, ['web']];
const isBadRequest = error => error.status === 400;

test('omitted AI agent delivery stays compatible with the web default', () => {
  assert.equal(normalizeAgentDelivery('ai-agent', undefined), 'web');
  const omitted = estimateProject(input);
  assert.equal(omitted.agentDelivery, 'web');
  assert.deepEqual(omitted, estimateProject({ ...input, agentDelivery: 'web' }));
});

test('delivery validation accepts only the three exact supported AI agent outputs', () => {
  for (const delivery of deliveries) {
    assert.equal(normalizeAgentDelivery('ai-agent', delivery), delivery);
    assert.equal(estimateProject({ ...input, agentDelivery: delivery }).agentDelivery, delivery);
  }
  for (const delivery of invalidDeliveries) {
    assert.throws(() => normalizeAgentDelivery('ai-agent', delivery), isBadRequest);
    assert.throws(() => estimateProject({ ...input, agentDelivery: delivery }), isBadRequest);
  }
});

test('non-agent projects do not silently accept an agent delivery setting', () => {
  for (const kind of ['web-app', 'mobile-app']) {
    assert.equal(normalizeAgentDelivery(kind, undefined), undefined);
    assert.equal(estimateProject({ ...input, kind }).agentDelivery, undefined);
    for (const delivery of [...deliveries, ...invalidDeliveries]) {
      assert.throws(() => normalizeAgentDelivery(kind, delivery), isBadRequest);
      assert.throws(() => estimateProject({ ...input, kind, agentDelivery: delivery }), isBadRequest);
    }
  }
});

test('agent estimates explain the selected web, API, or MCP output', () => {
  const estimates = deliveries.map(agentDelivery => estimateProject({ ...input, agentDelivery }));
  for (const [index, outputName] of [/web|웹/i, /API/i, /MCP/i].entries()) {
    assert.ok(estimates[index].assumptions.some(value => outputName.test(value)));
  }
  assert.equal(new Set(estimates.map(result => JSON.stringify(result.assumptions))).size, 3);
});

test('delivery selection preserves bounded generation and pricing estimates', () => {
  // Synthetic rates verify the estimator's math without making paid model calls.
  const options = {
    rates: { 'openai/example-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 6 } },
    maxRetries: 1,
  };
  for (const provider of ['openai', 'local']) {
    const estimates = deliveries.map(agentDelivery => estimateProject({ ...input, provider, agentDelivery }, options));
    const baseline = estimates[0];
    assert.deepEqual(baseline.modelCalls, provider === 'local' ? { min: 0, max: 0 } : { min: 2, max: 3 });
    assert.equal(baseline.cost.status, { openai: 'estimated', local: 'not-applicable' }[provider]);
    for (const result of estimates.slice(1)) {
      for (const field of ['complexity', 'modelCalls', 'tokens', 'timeSeconds', 'timeBreakdown', 'cost', 'excludedCosts']) {
        assert.deepEqual(result[field], baseline[field], `${provider}/${result.agentDelivery} must preserve ${field}`);
      }
    }
  }
});
