import { normalizeAgentDelivery } from './agent-delivery.mjs';

const kinds = new Set(['web-app', 'ai-agent', 'mobile-app']);
const providers = new Set(['local', 'openai', 'codex']);
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validRate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000;
const validRates = value => isObject(value) && validRate(value.inputUsdPerMillion) && validRate(value.outputUsdPerMillion);
const fail = message => Object.assign(new Error(message), { status: 400 });
const retriesFor = value => Number.isFinite(value) ? Math.max(0, Math.min(3, Math.floor(value))) : 2;
const roundedRange = (min, max) => ({ min: Math.floor(min * 1000000) / 1000000, max: Math.ceil(max * 1000000) / 1000000 });

/** Keep environment access outside estimateProject so identical inputs stay deterministic. */
export function estimateOptionsFromEnv(env = {}) {
  const rates = Object.create(null), configurationWarnings = [];
  if (env.ESTIMATE_MODEL_RATES_JSON) {
    try {
      const parsed = JSON.parse(env.ESTIMATE_MODEL_RATES_JSON);
      if (!isObject(parsed)) throw new Error('Not a rate map');
      for (const [key, value] of Object.entries(parsed)) {
        const [provider, model, ...extra] = key.split('/');
        if (extra.length || provider !== 'openai' || !validModel(model) || !validRates(value)) {
          configurationWarnings.push('올바르지 않은 모델 단가 설정을 제외했습니다.'); continue;
        }
        rates[key] = { inputUsdPerMillion: value.inputUsdPerMillion, outputUsdPerMillion: value.outputUsdPerMillion };
      }
    } catch { configurationWarnings.push('모델 단가 설정을 읽지 못해 비용을 계산하지 않았습니다.'); }
  }
  const configuredRetries = env.MAX_RETRIES === undefined || env.MAX_RETRIES === '' ? 2 : Number(env.MAX_RETRIES);
  return { rates, maxRetries: retriesFor(configuredRetries), configurationWarnings: [...new Set(configurationWarnings)] };
}

function classify(text, kind) {
  const groups = [/대시보드|dashboard|차트|통계/i, /로그인|회원가입|authentication/i, /검색|필터|filter/i,
    /캘린더|달력|calendar/i, /결제|payment/i, /실시간|협업|collaboration/i,
    /에이전트|요약|분석|\bAI\b|agent/i, /이미지|사진|갤러리|gallery/i, /알림|푸시|notification/i, /관리자|admin/i];
  const score = groups.filter(regex => regex.test(text)).length + (text.length > 400 ? 1 : 0) +
    (text.length > 1200 ? 1 : 0) + (kind === 'mobile-app' ? 1 : 0);
  return score <= 2 ? 'small' : score <= 5 ? 'medium' : 'large';
}

/**
 * Planning envelope, not a quote, spending cap, or delivery guarantee.
 * No network calls, key access, current-account balance lookup, or fixed vendor prices.
 * Rates use exact provider/model keys and USD per one million tokens.
 */
export function estimateProject({ prompt, kind = 'web-app', agentDelivery: requestedDelivery, provider = 'local', model = null, modelRouting } = {}, options = {}) {
  if (typeof prompt !== 'string' || prompt.trim().length < 10 || prompt.trim().length > 4000) throw fail('견적을 확인할 아이디어를 10자 이상 4,000자 이하로 입력해 주세요.');
  if (!kinds.has(kind)) throw fail('지원하는 프로젝트 유형을 선택해 주세요.');
  const agentDelivery = normalizeAgentDelivery(kind, requestedDelivery);
  if (!providers.has(provider)) throw fail('지원하는 AI 연결 방식을 선택해 주세요.');
  if (modelRouting !== undefined && modelRouting !== 'automatic') throw fail('지원하는 모델 선택 방식을 확인해 주세요.');
  if (provider !== 'local' && !(provider === 'codex' && model === null) && !validModel(model)) throw fail('견적에 사용할 모델 ID를 확인해 주세요.');
  const text = prompt.trim(), complexity = classify(text, kind), maxRetries = retriesFor(options.maxRetries);
  const ai = provider !== 'local', subscription = provider === 'codex';
  const automaticallyRouted = ai && modelRouting === 'automatic';
  const points = [...text], nonAscii = points.filter(char => char.codePointAt(0) > 127).length;
  const promptTokens = Math.ceil((points.length - nonAscii) / 4 + nonAscii / 1.5);
  const scale = { small: { input: [5000, 18000], output: [3500, 14000], seconds: [90, 360] },
    medium: { input: [7000, 26000], output: [4500, 18000], seconds: [120, 540] },
    large: { input: [10000, 36000], output: [6000, 24000], seconds: [180, 780] } }[complexity];
  const modelCalls = ai ? { min: 2, max: 2 + maxRetries } : { min: 0, max: 0 };
  const tokens = ai ? {
    input: { min: scale.input[0] + promptTokens * 2, max: Math.ceil(scale.input[1] * (1 + maxRetries * 0.8)) + promptTokens * modelCalls.max },
    output: { min: scale.output[0], max: scale.output[1] * (1 + maxRetries) },
  } : { input: { min: 0, max: 0 }, output: { min: 0, max: 0 } };
  const generationSeconds = ai ? { min: scale.seconds[0], max: scale.seconds[1] + maxRetries * 120 } : { min: 10, max: 45 };
  const androidBuildSeconds = kind === 'mobile-app' ? { min: 60, max: 300 } : { min: 0, max: 0 };
  const timeSeconds = { min: generationSeconds.min + androidBuildSeconds.min, max: generationSeconds.max + androidBuildSeconds.max };
  const key = `${provider}/${model}`;
  const rate = isObject(options.rates) && Object.hasOwn(options.rates, key) && validRates(options.rates[key]) ? options.rates[key] : null;
  let cost = { currency: 'USD', status: 'unpriced', min: null, max: null, rateSource: 'none' };
  if (!ai) cost = { currency: 'USD', status: 'not-applicable', min: 0, max: 0, rateSource: 'none' };
  else if (rate && !subscription && !automaticallyRouted) cost = { currency: 'USD', status: 'estimated',
    ...roundedRange((tokens.input.min * rate.inputUsdPerMillion + tokens.output.min * rate.outputUsdPerMillion) / 1000000,
      (tokens.input.max * rate.inputUsdPerMillion + tokens.output.max * rate.outputUsdPerMillion) / 1000000), rateSource: 'configured' };
  const excludedCosts = [
    { id: 'hosting', label: 'Vercel 실행·저장·배포', detail: 'Sandbox, Blob, 호스팅, 전송량과 유지 비용은 포함하지 않습니다. 실제 배포 요금제에 따라 달라집니다.' },
    { id: 'subscription', label: '구독·로그인', detail: subscription ? '로컬 Codex CLI의 ChatGPT 로그인과 구독 한도로 생성합니다. 현재 계정 잔액과 사용 한도는 조회하지 않았으며 API 단가로 환산하지 않습니다.' : 'Google 계정 로그인과 ChatGPT 구독은 OpenAI API 결제와 별개입니다. 계정 구독료나 구독 사용량은 이 API 견적에 포함하지 않습니다.' },
    { id: 'design', label: '외부 디자인 서비스', detail: 'Stitch·v0·Figma 등 별도 서비스의 생성·호출·구독 비용은 포함하지 않습니다.' },
    ...(automaticallyRouted ? [{ id: 'images', label: '이미지 생성', detail: '필요한 경우 선택되는 이미지 모델의 비용과 생성 시간은 별도입니다. 이미지 크기·품질·장수와 실제 사용 가능한 모델에 따라 달라집니다.' }] : []),
    ...(kind === 'mobile-app' ? [{ id: 'android', label: 'Android APK 빌드', detail: 'APK 빌드 서버의 실행·보관·다운로드 비용은 별도입니다. 초기 SDK 설치와 스토어 등록 비용은 포함하지 않습니다.' }] : []),
  ];
  const assumptions = [
    '현재 지원하는 MVP 템플릿 범위의 대략적인 예상치입니다. 전체 맞춤 개발 견적이나 완성 보장이 아닙니다.',
    ...(agentDelivery ? [{ web: '결과물은 브라우저에서 사용하는 AI 에이전트 웹 앱입니다.', api: '결과물은 외부 프로그램에서 호출하는 HTTP API 에이전트입니다. 사용 안내와 연결 검증을 포함하며 실제 운영 호출 비용은 별도입니다.', mcp: '결과물은 MCP 클라이언트에 연결하는 에이전트 서버입니다. 클라이언트 설정과 실제 사용 시 모델·호스팅 비용은 별도입니다.' }[agentDelivery]] : []),
    '예상 시간과 토큰은 실측 통계가 아닌 보수적인 규칙 기반 범위입니다. 대기열·네트워크·모델 상태에 따라 범위를 넘을 수 있습니다.',
    ai ? `계획 1회와 코드 생성 1회, 자동 오류 수정 최대 ${maxRetries}회를 가정합니다. 재생성 버튼과 추가 디자인 작업은 별도입니다.` : '로컬 템플릿 모드에서는 모델 API를 호출하지 않습니다. 실행 환경 비용은 별도입니다.',
    ai ? '캐시·추론 토큰·별도 도구 호출·할인·무료 한도·세금·환율은 반영하지 않았습니다. 표시된 최대값은 지출 제한이 아닙니다.' : '생성 이후 사용자가 실행하는 AI 도구나 배포 유지 비용은 포함하지 않습니다.',
    ...(kind === 'mobile-app' ? ['모바일은 기기에 데이터를 보관하는 Android WebView 앱 기준입니다. 빌드 서버가 준비되어 있다고 가정하며 첫 SDK 설치와 실제 기기 검토 시간은 제외합니다.'] : []),
    ...(automaticallyRouted && !subscription ? ['계획·코드 작성·오류 수정에 사용할 모델을 작업 시점에 자동 선택하므로 기본 모델 하나의 단가로 총비용을 계산하지 않습니다. 비용 미산정은 무료라는 뜻이 아닙니다.', '표시된 호출 수·토큰·시간은 텍스트 생성 단계의 범위이며, 필요한 이미지 생성과 모델 선택 중 발생하는 추가 대기 시간은 제외합니다.'] : []),
    ...(!ai || rate || subscription || automaticallyRouted ? [] : ['현재 모델의 검증된 단가가 등록되지 않아 비용은 미산정입니다. 무료라는 뜻이 아닙니다.']),
    ...(subscription ? ['Codex 구독 실행은 로컬 컴퓨터에서만 지원합니다. 이 예상치는 API 청구액이나 구독 잔액을 뜻하지 않습니다.', '표시된 호출 수는 계획·코드·수정 단계 수입니다. CLI 내부 호출로 실제 구독 사용량은 달라질 수 있으며 생성된 앱의 AI 실행에는 별도의 OpenAI API 키가 필요합니다.'] : []),
    ...(Array.isArray(options.configurationWarnings) ? options.configurationWarnings.filter(value => typeof value === 'string') : []),
  ];
  return { kind, ...(agentDelivery ? { agentDelivery } : {}), provider, model: ai ? model : null, ...(automaticallyRouted ? { modelRouting: 'automatic' } : {}), complexity, modelCalls, tokens, timeSeconds,
    timeBreakdown: { generationSeconds, androidBuildSeconds }, cost, excludedCosts, assumptions };
}
