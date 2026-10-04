const deliveries = new Set(['web', 'api', 'mcp']);
const fail = message => Object.assign(new Error(message), { status: 400 });

/** Omission remains compatible with existing web-based AI agent projects. */
export function normalizeAgentDelivery(kind, value) {
  if (kind !== 'ai-agent') {
    if (value !== undefined) throw fail('결과물 방식은 AI 에이전트에서만 선택할 수 있습니다.');
    return undefined;
  }
  if (value === undefined) return 'web';
  if (!deliveries.has(value)) throw fail('AI 에이전트 결과물은 웹 앱, HTTP API, MCP 서버 중에서 선택해 주세요.');
  return value;
}
