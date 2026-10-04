// Trusted, shared execution core for the web, bearer API, and local MCP transports.
export const AGENT_TOOLS = Object.freeze(['analyze', 'checklist', 'ai']);
const invalid = message => Object.assign(new Error(message), { status: 400 });

export async function runAgent(input, tool = 'analyze', config = {}, options = {}) {
  if (typeof input !== 'string' || !input.trim() || input.length > 20000) throw invalid('작업할 텍스트는 1~20,000자로 입력해 주세요.');
  if (!AGENT_TOOLS.includes(tool)) throw invalid('지원하지 않는 도구입니다. analyze, checklist, ai 중 하나를 선택해 주세요.');
  input = input.trim();
  if (tool === 'ai') {
    const env = options.env || process.env;
    if (!env.OPENAI_API_KEY) throw Object.assign(new Error('AI 실행에는 서버의 OPENAI_API_KEY 설정이 필요합니다. 로컬 도구는 바로 사용할 수 있습니다.'), { status: 503 });
    const response = await (options.fetcher || fetch)('https://api.openai.com/v1/responses', {
      method: 'POST', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.OPENAI_MODEL || 'gpt-4.1-mini', max_output_tokens: 4000, instructions: 'You are a helpful Korean-language text assistant. Answer according to the project purpose below. No external tools are available; do not claim to use any. Project purpose: ' + String(config.summary || '').slice(0, 5000), input }),
    });
    if (!response.ok) throw Object.assign(new Error(`OpenAI 요청 실패 (HTTP ${response.status}). 서버 API 설정과 사용 한도를 확인하세요.`), { status: 502 });
    const result = await response.json();
    const output = result.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n');
    if (result.status !== 'completed' || !output) throw Object.assign(new Error('OpenAI 응답이 완성되지 않았습니다. 다시 시도하세요.'), { status: 502 });
    return { output, mode: 'openai', tool };
  }
  const sentences = input.split(/(?<=[.!?。])\s+|\n+/).map(value => value.trim()).filter(Boolean);
  if (tool === 'checklist') return { output: sentences.map((value, i) => `${i + 1}. ${value.replace(/^[-*\d.\s]+/, '')}`).join('\n'), mode: 'local', tool };
  const words = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const counts = new Map();
  for (const word of words) if (word.length > 1) counts.set(word, (counts.get(word) || 0) + 1);
  const keywords = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word, count]) => `${word} (${count})`).join(', ');
  return { output: `문자 수: ${input.length}\n단어 수: ${words.length}\n문장 수: ${sentences.length}\n자주 등장한 단어: ${keywords || '없음'}\n\n첫 문장 발췌:\n${sentences.slice(0, 3).join('\n')}`, mode: 'local', tool };
}
