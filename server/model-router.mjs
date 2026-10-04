// The model inventory lists access, not endpoint capabilities. Keep automatic choices in this reviewed allowlist.
export const TEXT_MODELS = Object.freeze(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano']);
export const IMAGE_MODELS = Object.freeze(['gpt-image-2.5-flare', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08', 'gpt-image-2', 'gpt-image-2-2026-04-21']);
const preferences = {
  planner: ['gpt-6-luna', 'gpt-4.1-mini', 'gpt-6.1-sol', 'gpt-4.1', 'gpt-4.1-nano'],
  coder: ['gpt-6.1-sol', 'gpt-4.1', 'gpt-6-luna', 'gpt-4.1-mini', 'gpt-4.1-nano'],
  debugger: ['gpt-6.1-sol', 'gpt-4.1', 'gpt-6-luna', 'gpt-4.1-mini', 'gpt-4.1-nano'],
  image: IMAGE_MODELS,
};
const failure = (status, message) => Object.assign(new Error(message), { status });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value);
const copy = value => structuredClone(value);
const combineSignal = (signal, timeout) => AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]);

export function routingOptionsFromEnv(env = process.env) {
  return Object.fromEntries(['planner', 'coder', 'debugger', 'image'].map(role => [role, env[`OPENAI_${role.toUpperCase()}_MODEL`] || null]));
}

export function createModelRouter({ apiKey, model = 'gpt-4.1-mini', env = process.env, roleModels = routingOptionsFromEnv(env), fetchImpl = (...args) => fetch(...args), cacheMs = 300000 } = {}) {
  if (!validId(model)) throw failure(400, '기본 모델 ID 형식을 확인해 주세요.');
  for (const role of Object.keys(preferences)) {
    const configured = roleModels[role];
    if (role !== 'image' && configured && (!validId(configured) || !TEXT_MODELS.includes(configured))) throw failure(400, `${role} 역할에 지원되는 모델을 설정해 주세요.`);
  }
  let cached, cachedAt = 0;
  const fallback = status => ({ source: 'api', inventoryStatus: status,
    roles: { planner: apiKey ? roleModels.planner || model : null, coder: apiKey ? roleModels.coder || model : null, debugger: apiKey ? roleModels.debugger || model : null, image: null },
    hasImage: false, availableTextModels: [], availableImageModels: [],
    limitations: [status === 'not-configured' ? '이미지 생성과 계정 모델 조회에는 별도의 OpenAI API 키가 필요합니다.' : '계정 모델 목록을 확인하지 못해 설정된 텍스트 모델만 사용합니다. 이미지 모델은 자동 선택하지 않습니다.', '역할별 모델과 이미지 사용료는 실제 사용량에 따라 달라지며 현재 금액은 미산정입니다.'] });
  return {
    async resolve({ signal, refresh = false } = {}) {
      if (signal?.aborted) throw signal.reason;
      if (!apiKey) return fallback('not-configured');
      if (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)) throw failure(401, 'OpenAI API 키 형식을 확인해 주세요.');
      if (!refresh && cached && Date.now() - cachedAt < cacheMs) return copy(cached);
      let response, result;
      try {
        response = await fetchImpl('https://api.openai.com/v1/models', { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal: combineSignal(signal, 10000), redirect: 'error' });
        if ([401, 403].includes(response.status)) throw failure(response.status, 'OpenAI 모델 목록에 접근할 수 없습니다. API 키와 계정 권한을 확인해 주세요.');
        if (!response.ok) throw failure(503, '모델 목록을 조회하지 못했습니다.');
        result = await response.json();
        if (!Array.isArray(result.data) || result.data.length > 20000) throw failure(503, '모델 목록 형식이 올바르지 않습니다.');
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if ([401, 403].includes(error.status)) { cached = null; throw error; }
        return fallback('unavailable');
      }
      const today = new Date().toISOString().slice(0, 10);
      const available = new Set(result.data.filter(item => validId(item?.id) && (!item.shutdown_date || item.shutdown_date > today)).map(item => item.id));
      const roles = {};
      const imageUnavailable = Boolean(roleModels.image && (!IMAGE_MODELS.includes(roleModels.image) || !available.has(roleModels.image)));
      for (const role of Object.keys(preferences)) {
        const configured = roleModels[role];
        if (role === 'image' && imageUnavailable) { roles.image = null; continue; }
        if (configured && !available.has(configured)) throw failure(409, `${role} 역할에 설정된 모델을 이 API 계정에서 찾을 수 없습니다. 다른 모델로 자동 대체하지 않습니다.`);
        const explicitBase = role !== 'image' && model !== 'gpt-4.1-mini' && available.has(model) ? model : null;
        roles[role] = configured || explicitBase || preferences[role].find(candidate => available.has(candidate)) || (role !== 'image' && available.has(model) ? model : null);
      }
      cached = { source: 'api', inventoryStatus: 'verified', roles, hasImage: Boolean(roles.image),
        availableTextModels: TEXT_MODELS.filter(id => available.has(id)), availableImageModels: IMAGE_MODELS.filter(id => available.has(id)),
        limitations: [...(imageUnavailable?['설정된 이미지 모델이 지원 목록 또는 계정 목록에 없어 이미지 생성을 사용하지 않습니다.']:[]),'모델 목록은 계정 노출 여부를 확인합니다. 실제 요청의 한도·조직 검증·엔드포인트 권한은 실행 시 확인됩니다.', '역할별 모델과 이미지 사용료는 실제 사용량에 따라 달라지며 현재 금액은 미산정입니다.'] };
      cachedAt = Date.now(); return copy(cached);
    },
  };
}

export function subscriptionCapabilities(model = null) {
  return { source: 'subscription', inventoryStatus: 'not-applicable', roles: { planner: model || null, coder: model || null, debugger: model || null, image: null },
    hasImage: false, availableTextModels: [], availableImageModels: [],
    limitations: ['Codex CLI에 명시한 모델 또는 CLI 기본 모델로 실행합니다. API 계정의 모델 목록을 조회하거나 임의로 구독 모델을 변경하지 않습니다.', 'Codex 구독 실행은 이 앱의 이미지 API 권한을 제공하지 않습니다. 이미지 생성에는 별도의 OpenAI API 키가 필요합니다.'] };
}
