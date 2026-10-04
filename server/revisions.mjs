import { BROWSER_PATHS, validateAssets, validatePlan } from './provider.mjs';
import { normalizeAgentDelivery } from './agent-delivery.mjs';
import { normalizeWorkflowMode } from './workflow-review.mjs';
import { DESIGN_ASSET_PATH, validateDesignAssetFile, attachDesignAssets } from './visual-assets.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const validId = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);

export function revisionMetadata(number, prompt, usesAI) {
  return { number, prompt, mode: usesAI ? 'ai-edit' : 'template-copy', message: usesAI
    ? '이전 화면과 기능을 바탕으로 수정 요청을 반영한 새 버전을 생성합니다. 기존 앱의 계정과 사용자 데이터는 이전하지 않습니다.'
    : '로컬 모드는 이전 화면을 새 프로젝트로 복제합니다. 자유로운 수정 요청은 AI 연결 후 반영할 수 있습니다. 기존 앱의 계정과 사용자 데이터는 이전하지 않습니다.' };
}

/** Select source and specification only: never inherit credentials, logs or runtime data. */
export function validateRevisionSeed(value) {
  if (!value || !validId(value.parentProjectId) || typeof value.parentPrompt !== 'string' || value.parentPrompt.length > 4000) throw fail(409, '이전 버전의 수정 정보를 찾을 수 없습니다.');
  const files = validateAssets(value.files);
  if (files.length !== BROWSER_PATHS.size) throw fail(409, '이전 버전의 HTML, CSS, JavaScript 파일이 모두 필요합니다.');
  const plan = validatePlan(value.parentPlan);
  const parentPlan = { name: plan.name, summary: plan.summary, audience: plan.audience,
    features: plan.features.map(({ name, description, priority }) => ({ name, description, priority })),
    assumptions: [...plan.assumptions], stack: plan.stack.map(({ name, role }) => ({ name, role })), fileTree: [...plan.fileTree] };
  return { parentProjectId: value.parentProjectId, parentPrompt: value.parentPrompt, parentPlan, files, ...(value.designAssetFile ? {designAssetFile:validateDesignAssetFile(value.designAssetFile)} : {}) };
}

export function prepareRevision(parent, prompt, usesAI) {
  if (parent.status !== 'completed') throw fail(409, '완성된 프로젝트만 새 버전으로 수정할 수 있습니다.');
  if (typeof prompt !== 'string' || prompt.trim().length < 5 || prompt.trim().length > 4000) throw fail(400, '수정할 내용을 5자 이상 4,000자 이하로 입력해 주세요.');
  const seed = validateRevisionSeed({ parentProjectId: parent.id, parentPrompt: parent.prompt, parentPlan: parent.plan,
    files: (parent.files || []).filter(file => BROWSER_PATHS.has(file.path)), designAssetFile:(parent.files || []).find(file=>file.path===DESIGN_ASSET_PATH) });
  const number = Number.isSafeInteger(parent.revision?.number) && parent.revision.number > 0 ? parent.revision.number + 1 : 2;
  const agentDelivery = normalizeAgentDelivery(parent.kind, parent.agentDelivery);
  return { parentProjectId: parent.id, workflowMode: normalizeWorkflowMode(parent.workflowMode), ...(agentDelivery === undefined ? {} : { agentDelivery }), revision: revisionMetadata(number, prompt.trim(), usesAI), revisionSeed: seed };
}

export function revisionPrompt(project, seed) {
  return JSON.stringify({ task: 'Revise the existing app using the supplied working browser files. Preserve all existing behavior except the requested changes. Keep the trusted platform constraints and explain unsupported changes. This is a new independent version with no existing user data.',
    originalRequest: seed.parentPrompt, previousSpecification: seed.parentPlan, changeRequest: project.prompt,
    ...(project.kind === 'ai-agent' ? { agentDelivery: normalizeAgentDelivery(project.kind, project.agentDelivery) } : {}) });
}

export function applyRevisionSeed(files, seed, project) {
  // A mobile app's localStorage namespace belongs to its new project ID.
  const replacements = seed.files.map(file => ({ ...file, content: project.kind === 'mobile-app' ? file.content.replaceAll(seed.parentProjectId, project.id) : file.content }));
  const result = files.map(file => replacements.find(candidate => candidate.path === file.path) || file);
  return seed.designAssetFile ? attachDesignAssets(result,seed.designAssetFile) : result;
}
