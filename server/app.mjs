import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registry, TEMPLATE_FILES, getTemplateFiles } from './templates.mjs';
import { openAIProvider, validateAssets, validatePlan } from './provider.mjs';
import { startRuntime, stopProcess, validateProject } from './processes.mjs';
import { createZip } from './zip.mjs';
import { createCredentialManager, createLocalCredentialStore, localCredentialSecret } from './credentials.mjs';
import { createGoogleAuth } from './google-auth.mjs';
import { createMobileBuilds } from './mobile-builds.mjs';
import { androidSourceFiles } from './android-builder.mjs';
import { estimateProject, estimateOptionsFromEnv } from './estimate.mjs';
import { prepareRevision, validateRevisionSeed, revisionMetadata, revisionPrompt, applyRevisionSeed } from './revisions.mjs';
import { normalizeAgentDelivery } from './agent-delivery.mjs';
import { codexProvider } from './codex-provider.mjs';
import { normalizeWorkflowMode, pauseForReview, applyReviewDecision, reviewPlanningPrompt } from './workflow-review.mjs';
import { DESIGN_ASSET_PATH, inferVisualPlan, createDesignAssetFile, attachDesignAssets } from './visual-assets.mjs';
import { projectListSummary } from './cloud/response.mjs';

const stageDefinitions = [ ['requirements', '요구사항 분석'], ['features', '기능 정의'], ['architecture', '구조 설계'], ['scaffold', '프로젝트 생성'], ['coding', '코드 구현'], ['validation', '테스트'], ['debugging', '오류 수정'], ['delivery', '결과물 완성'] ];
const stages = () => stageDefinitions.map(([id, label]) => ({ id, label, status: 'pending' }));
const now = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const httpError = (status, message) => Object.assign(new Error(message), { status });
const root = fileURLToPath(new URL('../', import.meta.url));

export async function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(root, '.data'));
  const projectsDir = path.join(dataDir, 'projects'); await fs.mkdir(projectsDir, {recursive:true});
  const selectedProvider=options.providerName || process.env.AI_PROVIDER || 'openai';
  if(!['openai','codex'].includes(selectedProvider))throw httpError(400,'지원하지 않는 AI 제공자 설정입니다. OpenAI API 또는 로컬 Codex 구독 실행을 선택해 주세요.');
  const subscription=selectedProvider==='codex',providerName='openai';
  const apiKey = subscription ? '' : options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const model = subscription ? options.codexModel || process.env.CODEX_MODEL || 'codex-default' : options.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const maxRetries = Math.max(0, Math.min(3, Number.isFinite(options.maxRetries) ? options.maxRetries : 2));
  const provider = options.provider || (subscription ? codexProvider({model:options.codexModel || process.env.CODEX_MODEL}) : apiKey ? openAIProvider({apiKey, model}) : null);
  const googleAuth = options.googleAuth || createGoogleAuth();
  const credentialManager = options.credentialManager || createCredentialManager({
    secret: await localCredentialSecret(dataDir, options.credentialSecret || process.env.SESSION_SECRET),
    store: createLocalCredentialStore(dataDir), secure: false, defaultModel: subscription ? process.env.OPENAI_MODEL || 'gpt-4.1-mini' : model, ownerResolver: req => googleAuth.owner(req),
  });
  const personalProvider = options.providerFactory || openAIProvider;
  const mode = provider ? 'openai' : 'local';
  const store = new Map(), runs = new Map(), previews = new Map(), listeners = new Map(), launches = new Map(), previewTokens = new Map();
  let closed = false;
  const metadata = path.join(dataDir, 'projects.json');
  let saved = [];
  try { saved = JSON.parse(await fs.readFile(metadata, 'utf8')); } catch(error) { if (error.code !== 'ENOENT') throw new Error(`프로젝트 저장소를 읽지 못했습니다: ${error.message}`); }
  const importedIds = new Set((options.initialProjects || []).map(project => project?.id));
  const resumeIds = new Set(options.resumeIds || []);
  for (const p of [...saved, ...(options.initialProjects || [])]) {
    if (!p || !/^[\da-f-]{36}$/i.test(p.id)) continue;
    const project = clone(p); project.previewUrl = null;
    if (project.kind === 'ai-agent') project.agentDelivery = normalizeAgentDelivery(project.kind, project.agentDelivery);
    project.workflowMode = normalizeWorkflowMode(project.workflowMode);
    project.review ??= null; project.reviewHistory ??= []; project.approvedStages ??= [];
    project.modelUsage ??= [];
    const importedResume = importedIds.has(project.id) && resumeIds.has(project.id) && project.status === 'queued';
    if (['running', 'queued'].includes(project.status) && !importedResume) {
      project.status = 'failed'; project.error = '서버가 종료되어 작업이 중단되었습니다. 다시 실행해 주세요.';
      for (const stage of project.stages) if (stage.status === 'running') { stage.status = 'failed'; stage.detail = project.error; stage.completedAt = now(); }
    }
    if (importedResume && project.revision) {
      const seed = validateRevisionSeed(options.initialRevisionSeeds?.[project.id]);
      if (seed.parentProjectId !== project.parentProjectId) throw httpError(409, '새 버전의 이전 프로젝트 정보가 일치하지 않습니다.');
      const projectDirectory = path.join(projectsDir, project.id); await fs.mkdir(projectDirectory, {recursive:true});
      await fs.writeFile(path.join(projectDirectory, '.revision-seed.json'), JSON.stringify(seed));
    }
    store.set(project.id, project);
  }
  let writes = Promise.resolve();
  const mobileBuilds=createMobileBuilds({dataDir,onUpdate:persist,...(options.androidBuild?{build:options.androidBuild}:{})});
  async function persist(project) {
    project.updatedAt = now(); const snapshot = clone(project); const all = JSON.stringify([...store.values()], null, 2);
    writes = writes.catch(() => {}).then(async () => { await fs.writeFile(metadata + '.tmp', all); await fs.rename(metadata + '.tmp', metadata); });
    await writes;
    if (options.onProjectUpdate) await options.onProjectUpdate(snapshot);
    for (const listener of listeners.get(project.id) || []) listener(snapshot);
  }
  const log = (project, stage, message, level = 'info') => { project.logs.push({ id: crypto.randomUUID(), timestamp: now(), stage, message, level }); if (project.logs.length > 300) project.logs.splice(0, project.logs.length - 300); };
  const directory = project => path.join(projectsDir, project.id);
  async function writeFiles(project) {
    for (const file of project.files) {
      if (!TEMPLATE_FILES.includes(file.path)) throw new Error('허용되지 않은 프로젝트 파일 경로입니다.');
      const target = path.join(directory(project), file.path); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.content);
    }
  }
  function getProject(id) { const project = store.get(id); if (!project) throw httpError(404, '프로젝트를 찾을 수 없습니다.'); return project; }
  async function setStage(project, id, status, detail) {
    const stage = project.stages.find(item => item.id === id); stage.status = status;
    if (status === 'running') { stage.startedAt = now(); delete stage.completedAt; }
    if (['completed', 'failed', 'skipped'].includes(status)) stage.completedAt = now();
    if (detail) stage.detail = detail;
    await persist(project);
  }
  async function launchProjectProcess(project, signal, connection) {
    if (project.credentialSource === 'personal' && project.kind === 'ai-agent' && (!connection?.apiKey || connection.ownerId !== project.ownerId || connection.expiresAt <= Date.now())) throw httpError(409, '이 프로젝트의 개인 API 키를 다시 연결해 주세요.');
    const verifyConnection = async () => {
      if (project.credentialSource === 'personal' && connection && !options.internalConnection && (await credentialManager.readOwner(connection.ownerId))?.revision !== connection.revision) throw httpError(409, '개인 API 키 연결이 변경되어 미리보기를 중단했습니다. 다시 연결해 주세요.');
    };
    await verifyConnection();
    const current = previews.get(project.id); if (current && current.child.exitCode === null && !current.child.killed) return current.url;
    if (project.credentialSource === 'personal' && !previewTokens.has(project.id)) previewTokens.set(project.id, crypto.randomBytes(32).toString('hex'));
    await writeFiles(project);
    const runtime = await startRuntime(directory(project), {
      signal, apiKey: project.kind === 'ai-agent' ? (project.credentialSource === 'personal' ? connection.apiKey : apiKey) : undefined, model: connection?.model || model, provider:connection?.provider || providerName,
      host: options.previewHost || '127.0.0.1', port: options.previewPort || 0, publicOrigin: options.publicOrigin, previewAccessToken: options.previewAccessToken || previewTokens.get(project.id),
    });
    previews.set(project.id, runtime);
    try { await verifyConnection(); }
    catch (error) {
      await stopProcess(runtime.child);
      if (previews.get(project.id) === runtime) previews.delete(project.id);
      project.previewUrl = null;
      throw error;
    }
    if (project.credentialSource === 'personal' && connection?.expiresAt) {
      const expiry = setTimeout(() => { stopProcess(runtime.child).catch(() => {}); }, Math.max(1, connection.expiresAt - Date.now())); expiry.unref();
      runtime.child.once('exit', () => clearTimeout(expiry));
    }
    runtime.child.once('exit', () => {
      if (previews.get(project.id) !== runtime) return;
      previews.delete(project.id); project.previewUrl = null;
      if (!closed && project.status === 'completed') { log(project, 'delivery', '미리보기 프로세스가 종료되었습니다. 앱 실행으로 다시 시작할 수 있습니다.', 'warn'); persist(project).catch(() => {}); }
    });
    project.previewUrl = runtime.url; return runtime.url;
  }
  function launchProject(project, signal, connection) {
    if (launches.has(project.id)) return launches.get(project.id);
    const launch = launchProjectProcess(project, signal, connection).finally(() => launches.delete(project.id));
    launches.set(project.id, launch); return launch;
  }
  async function execute(project, controller, connection) {
    const activeProvider = project.credentialSource === 'personal' ? personalProvider(connection) : provider;
    const signal = controller.signal;
    const onModelUsed = async event => {
      project.modelUsage = [...(project.modelUsage || []), {...event,timestamp:now()}].slice(-60);
      log(project, event.stage || 'coding', `${event.capability}: ${event.model || (event.capability==='validation'?'실행 도구':'연결된 기본 모델')} · ${event.detail || event.status}`, event.status==='failed'?'error':event.status==='skipped'?'warn':'info');
      await persist(project);
    };
    const ensureActive = async () => {
      if (signal.aborted || closed) throw signal.reason || new Error('작업이 중단되었습니다.');
      if (connection && !options.internalConnection && (await credentialManager.readOwner(connection.ownerId))?.revision !== connection.revision) throw new Error('개인 API 키 연결이 변경되었거나 만료되었습니다. 다시 연결해 주세요.');
    };
    const step = async (id, message, action) => {
      await ensureActive(); log(project, id, message); await setStage(project, id, 'running', message);
      const result = await action(); await ensureActive(); await setStage(project, id, 'completed'); return result;
    };
    try {
      const seed = project.revision ? validateRevisionSeed(JSON.parse(await fs.readFile(path.join(directory(project), '.revision-seed.json'), 'utf8'))) : null;
      const basePrompt = seed ? revisionPrompt(project, seed) : project.prompt;
      const prompt = reviewPlanningPrompt(project, basePrompt);
      if (seed) project.revision = revisionMetadata(project.revision.number, project.prompt, Boolean(activeProvider));
      const codingProject = () => ({ ...clone(project), prompt, visualPlan:inferVisualPlan({...project,prompt:seed?seed.parentPrompt:project.prompt}) });
      const scaffold = async template => {
        const files = await template.generate(project);
        return seed ? applyRevisionSeed(files, seed, project) : files;
      };
      project.status = 'running'; project.error = null; await persist(project);
      const template = registry.get(project.kind);
      if (!template) throw new Error('등록되지 않은 프로젝트 템플릿입니다.');
      const planningStep = async (id, message, action) => {
        if (project.stages.find(stage => stage.id === id)?.status !== 'completed') await step(id, message, action);
        await ensureActive();
        if (!pauseForReview(project, id)) return false;
        log(project, id, '다음 단계로 진행하기 전에 계획을 확인해 주세요.');
        await persist(project);
        return true;
      };
      if (await planningStep('requirements', activeProvider ? 'AI Planner가 요구사항과 MVP 범위를 분석합니다.' : '로컬 키워드 규칙으로 요구사항에 맞는 템플릿을 선택합니다.', async () => {
        project.plan = validatePlan(activeProvider ? await activeProvider.plan({prompt, kind:project.kind, agentDelivery:project.agentDelivery, signal,onModelUsed}) : seed ? seed.parentPlan : await template.plan(project.prompt, project.kind, {agentDelivery:project.agentDelivery}));
        project.name = project.plan.name; log(project, 'requirements', `${project.plan.name}: ${project.plan.summary}`, 'success');
        if (seed) log(project, 'requirements', project.revision.message, activeProvider ? 'info' : 'warn');
      })) return;
      if (await planningStep('features', project.kind === 'mobile-app' ? '기기 저장, 기록 관리, 모바일 화면의 기능 명세를 확정합니다.' : '로그인, 사용자별 데이터, 핵심 화면의 기능 명세를 확정합니다.', async () => { log(project, 'features', project.plan.features.map(feature => feature.name).join(' · '), 'success'); })) return;
      if (await planningStep('architecture', '신뢰된 Node 서버와 독립 브라우저 자산으로 실행 구조를 정의합니다.', async () => { project.plan.fileTree = getTemplateFiles(project); log(project, 'architecture', '서버 코드는 검증된 템플릿을 사용하며 모델은 HTML·CSS·브라우저 JavaScript만 작성합니다.', 'success'); })) return;
      await step('scaffold', '실행 가능한 프로젝트 파일을 생성합니다.', async () => { project.files = await scaffold(template); await writeFiles(project); log(project, 'scaffold', `${project.files.length}개 파일을 실제 디스크에 생성했습니다.`, 'success'); });
      await step('coding', activeProvider ? 'Coding Agent가 계획에 맞게 브라우저 코드를 작성합니다.' : '로컬 템플릿의 로그인·CRUD·반응형 화면을 구성합니다.', async () => {
        if (activeProvider) {
          const assets = validateAssets(await activeProvider.code({project:codingProject(), agentDelivery:project.agentDelivery, files:clone(project.files), errors:[], signal,onModelUsed}));
          project.files = project.files.map(file => assets.find(asset => asset.path === file.path) || file); await writeFiles(project);
        }
        const visualPlan = inferVisualPlan({...project,prompt:seed?`${seed.parentPrompt}\n${project.prompt}`:project.prompt});
        if (visualPlan) {
          await ensureActive();
          log(project,'coding',visualPlan.reason);
          const image = activeProvider?.image ? await activeProvider.image({prompt:visualPlan.prompt,needed:true,signal,onModelUsed}) : {status:'skipped',reason:'연결된 생성 엔진에 이미지 모델이 없습니다.'};
          if (image.status==='completed') {
            project.files=attachDesignAssets(project.files,createDesignAssetFile({[visualPlan.slot]:image.dataUrl}));
            if(!project.plan.fileTree.includes(DESIGN_ASSET_PATH)) project.plan.fileTree.push(DESIGN_ASSET_PATH);
            log(project,'coding','이미지 모델이 만든 콘셉트 이미지를 앱에 연결했습니다.','success');
          } else if (!activeProvider?.image) await onModelUsed({stage:'images',capability:'image',model:null,status:'skipped',detail:image.reason});
        }
        const existingAsset=project.files.find(file=>file.path===DESIGN_ASSET_PATH);
        if(existingAsset)project.files=attachDesignAssets(project.files,existingAsset);
        await writeFiles(project);
        log(project, 'coding', `${project.files.length}개 소스 파일이 준비되었습니다.`, 'success');
      });
      await ensureActive(); await setStage(project, 'validation', 'running', '실제 프로세스를 실행해 문법·인증·데이터 CRUD를 검증합니다.');
      project.checks = await validateProject(directory(project), { signal, kind:project.kind, agentDelivery:project.agentDelivery }); await ensureActive();
      for (const check of project.checks) log(project, 'validation', `${check.passed ? '통과' : '실패'}: ${check.name} — ${check.detail}`, check.passed ? 'success' : 'error');
      await persist(project);
      let failures = project.checks.filter(check => !check.passed);
      if (failures.length) {
        await setStage(project, 'validation', 'failed', `${failures.length}개 검사에서 오류가 발견되었습니다.`);
        await setStage(project, 'debugging', 'running', '실패한 검사 로그를 분석하여 브라우저 코드를 수정합니다.');
        while (failures.length && project.retryCount < maxRetries) {
          await ensureActive(); project.retryCount += 1;
          log(project, 'debugging', `${project.retryCount}/${maxRetries}차 수정: ${failures.map(check => check.name).join(', ')}`, 'warn'); await persist(project);
          if (activeProvider) {
            const assets = validateAssets(await activeProvider.code({project:codingProject(), agentDelivery:project.agentDelivery, files:clone(project.files), errors:clone(failures), signal,onModelUsed}));
            project.files = project.files.map(file => assets.find(asset => asset.path === file.path) || file);
          } else {
            project.files = await scaffold(template); log(project, 'debugging', seed ? '로컬 모드: 이전 버전의 브라우저 소스를 유지하고 실행 파일을 다시 생성합니다.' : '로컬 모드: 신뢰된 템플릿을 다시 생성하여 파일 손상을 복구합니다.');
          }
          const retainedAsset=project.files.find(file=>file.path===DESIGN_ASSET_PATH);
          if(retainedAsset)project.files=attachDesignAssets(project.files,retainedAsset);
          await writeFiles(project); await ensureActive(); project.checks = await validateProject(directory(project), {signal, kind:project.kind, agentDelivery:project.agentDelivery});
          failures = project.checks.filter(check => !check.passed);
          for (const check of project.checks) log(project, 'debugging', `${check.passed ? '통과' : '실패'}: ${check.name} — ${check.detail}`, check.passed ? 'success' : 'error');
          await persist(project);
        }
        if (failures.length) { await setStage(project, 'debugging', 'failed', `최대 ${maxRetries}회 수정 후 검증을 통과하지 못했습니다.`); throw new Error(`자동 수정 후에도 ${failures.length}개 검사가 실패했습니다. 검사 결과와 소스를 확인해 주세요.`); }
        await setStage(project, 'debugging', 'completed', `${project.retryCount}회 수정 후 모든 자동 검사를 통과했습니다.`);
      } else await setStage(project, 'debugging', 'skipped', '모든 자동 검사를 통과하여 수정이 필요하지 않습니다.');
      await setStage(project, 'validation', 'completed', `${project.checks.length}개 실제 자동 검사 통과. 브라우저 UI 전체 및 모든 업무 요구사항은 별도 검토가 필요합니다.`);
      await onModelUsed({stage:'validation',capability:'validation',model:null,status:'completed',detail:`실제 앱 프로세스에서 ${project.checks.length}개 자동 검사를 통과했습니다.`});
      await step('delivery', '검증을 통과한 앱을 실행하고 소스 다운로드를 준비합니다.', async () => { await launchProject(project, signal, connection); log(project, 'delivery', '앱 프로세스 실행 완료. 소스 ZIP에는 계정·세션·API 키를 포함하지 않습니다.', 'success'); });
      await ensureActive(); project.status = 'completed'; await persist(project);
      if(project.kind==='mobile-app' && !options.internalOwnerId && !options.disableAutoAndroid) void mobileBuilds.start(project).catch(()=>{});
    } catch(error) {
      project.status = signal.aborted ? 'cancelled' : 'failed'; project.error = signal.aborted ? null : error.message;
      for (const stage of project.stages) if (stage.status === 'running') { stage.status = 'failed'; stage.completedAt = now(); stage.detail = signal.aborted ? '사용자가 실행을 중단했습니다.' : error.message; }
      log(project, project.stages.find(stage => stage.status === 'failed')?.id || 'requirements', signal.aborted ? '프로젝트 생성이 취소되었습니다.' : error.message, signal.aborted ? 'warn' : 'error');
      if (previews.has(project.id)) { await stopProcess(previews.get(project.id).child); previews.delete(project.id); project.previewUrl = null; }
      await persist(project);
    }
  }
  function runProject(id, connection) {
    const project = getProject(id); if (runs.has(id)) return runs.get(id).promise;
    if (project.status !== 'queued') return Promise.resolve(project);
    if (project.credentialSource === 'personal' && (!connection?.apiKey || connection.ownerId !== project.ownerId || connection.expiresAt <= Date.now())) throw httpError(409, '이 프로젝트의 개인 API 키를 다시 연결해 주세요.');
    const controller = new AbortController();
    const expiry = connection?.expiresAt ? setTimeout(() => controller.abort(new Error('개인 API 키 연결이 만료되었습니다.')), Math.max(1, connection.expiresAt - Date.now())) : null; expiry?.unref();
    const promise = execute(project, controller, connection).finally(() => { clearTimeout(expiry); runs.delete(id); });
    runs.set(id, { controller, promise });
    promise.catch(error => { console.error('Workflow persistence failure:', error.message); });
    return promise;
  }
  async function createProject(input, connection, ownerId) {
    if (closed) throw httpError(503, '서버가 종료 중입니다.');
    if(connection?.provider && connection.provider!=='openai')throw httpError(409,'OpenAI API 키를 다시 연결해 주세요.');
    const revisionSeed = input?.revision ? validateRevisionSeed(input.revisionSeed) : null;
    if (!input || typeof input.prompt !== 'string' || input.prompt.trim().length < (revisionSeed ? 5 : 10) || input.prompt.trim().length > 4000) throw httpError(400, revisionSeed ? '수정할 내용을 5자 이상 4,000자 이하로 입력해 주세요.' : '아이디어는 10자 이상 4,000자 이하로 입력해 주세요.');
    if (!registry.has(input.kind)) throw httpError(400, '지원하지 않는 프로젝트 유형입니다.');
    const agentDelivery = normalizeAgentDelivery(input.kind, input.agentDelivery);
    const workflowMode = normalizeWorkflowMode(input.workflowMode);
    const id = input.id || crypto.randomUUID(); if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw httpError(400, '프로젝트 ID가 올바르지 않습니다.');
    if (store.has(id)) throw httpError(409, '이미 존재하는 프로젝트 ID입니다.');
    const project = { id, name: '새 프로젝트', prompt: input.prompt.trim(), kind: input.kind, workflowMode, review: null, reviewHistory: [], approvedStages: [], status: 'queued', createdAt: now(), updatedAt: now(), mode, stages: stages(), logs: [], modelUsage: [], plan: null, files: [], checks: [], previewUrl: null, error: null, retryCount: 0 };
    if (agentDelivery !== undefined) project.agentDelivery = agentDelivery;
    project.authMode=connection ? 'api-key' : subscription ? 'codex-subscription' : provider ? 'api-key' : 'none';
    if (subscription && !connection) project.model=model;
    if (revisionSeed) {
      if (input.parentProjectId !== revisionSeed.parentProjectId || !Number.isSafeInteger(input.revision.number) || input.revision.number < 2) throw httpError(400, '새 버전 정보가 올바르지 않습니다.');
      project.parentProjectId = revisionSeed.parentProjectId;
      project.revision = revisionMetadata(input.revision.number, project.prompt, Boolean(connection || provider));
      await fs.mkdir(directory(project), { recursive: true });
      await fs.writeFile(path.join(directory(project), '.revision-seed.json'), JSON.stringify(revisionSeed));
    }
    if (ownerId) project.ownerId = ownerId;
    if (connection?.source === 'personal') { project.ownerId = connection.ownerId; project.credentialSource = 'personal'; project.model = connection.model; project.mode = 'openai'; }
    store.set(id, project); await persist(project); queueMicrotask(() => { if (!closed) runProject(id, connection); }); return project;
  }
  function accessible(req, project) { return !project.ownerId || project.ownerId === credentialManager.owner(req) || (options.internalOwnerId && options.internalOwnerId === project.ownerId); }
  function ownedProject(req) { const project = getProject(req.params.id); if (!accessible(req, project)) throw httpError(404, '프로젝트를 찾을 수 없습니다.'); return project; }
  async function requestConnection(req, project) {
    const connection = options.internalConnection || await credentialManager.resolve(req);
    if(connection?.provider && connection.provider!=='openai')throw httpError(409,'OpenAI API 키를 다시 연결해 주세요.');
    if (project?.credentialSource === 'personal' && (!connection?.apiKey || connection.ownerId !== project.ownerId || connection.expiresAt <= Date.now())) throw httpError(409, '이 프로젝트의 개인 API 키를 다시 연결해 주세요.');
    return connection;
  }
  async function stopPersonal(ownerId) {
    for (const project of store.values()) {
      if (project.ownerId !== ownerId || !ownerId) continue;
      const run = runs.get(project.id); if (run) { run.controller.abort(new Error('개인 API 키 연결을 해제했습니다.')); await run.promise; }
      if (launches.has(project.id)) await launches.get(project.id).catch(() => {});
      if (previews.has(project.id)) { await stopProcess(previews.get(project.id).child); previews.delete(project.id); }
      previewTokens.delete(project.id);
      project.previewUrl = null; await persist(project);
    }
  }
  const app = express(); app.disable('x-powered-by');
  const allowedOrigins = new Set(options.allowedOrigins || ['http://127.0.0.1:5173', 'http://localhost:5173']);
  app.use('/api', (req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return res.status(403).json({error:'허용되지 않은 호스트입니다.'});
    const origin = req.headers.origin;
    const googleCallback=req.method==='GET'&&new URL(req.originalUrl,'http://localhost').pathname==='/api/auth/google/callback';
    if (!googleCallback && origin && origin !== `http://${host}` && !allowedOrigins.has(origin)) return res.status(403).json({error:'허용되지 않은 출처입니다.'});
    if (!googleCallback && req.headers['sec-fetch-site'] === 'cross-site' && !allowedOrigins.has(origin)) return res.status(403).json({error:'외부 사이트에서 접근할 수 없습니다.'});
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  app.use(express.json({limit:'64kb'}));
  app.get('/api/auth/google/start', (req, res) => googleAuth.start(req, res));
  app.get('/api/auth/google/callback', async (req, res) => { try { await googleAuth.callback(req, res); } catch { res.redirect('/?auth_error=google#new'); } });
  app.get('/api/auth/session', (req, res) => { const session=googleAuth.status(req); res.json({ authenticated:!session.enabled || session.authenticated, required:session.enabled, google:session.enabled, user:session.user }); });
  app.post('/api/auth/logout', (req, res) => { googleAuth.logout(req, res); res.json({authenticated:false}); });
  app.use('/api', (req, res, next) => { if (googleAuth.configured && !googleAuth.verify(req) && !options.internalOwnerId) return res.status(401).json({error:'Google 계정으로 로그인해 주세요.'}); next(); });
  app.get('/api/config', async (req, res) => { const connection = await credentialManager.resolve(req); res.json({mode:connection ? 'openai' : mode,model:connection?.model || (provider ? model : null),credentialSource:connection ? 'personal' : subscription ? 'subscription' : provider ? 'server' : 'none',authMode:connection ? 'api-key' : subscription ? 'codex-subscription' : provider ? 'api-key' : 'none',provider:connection?.provider||providerName,maxRetries,modelRouting:(connection || provider)?'automatic':undefined,version:'0.2.0'}); });
  app.post('/api/estimate', async (req, res) => {
    const connection = await requestConnection(req);
    res.json(estimateProject({ modelRouting:(connection || (provider && !subscription)) ? 'automatic' : undefined, prompt: req.body?.prompt, kind: req.body?.kind, agentDelivery:req.body?.agentDelivery, provider: connection?.provider || (subscription ? 'codex' : provider ? providerName : 'local'), model: connection?.model || (provider ? model : null) }, { ...estimateOptionsFromEnv(process.env), maxRetries }));
  });
  app.get('/api/credentials', async (req, res) => { credentialManager.ensure(req, res); res.json(credentialManager.publicStatus(await credentialManager.resolve(req), { apiKey, model, provider:providerName })); });
  app.put('/api/credentials', async (req, res) => { const connection = await credentialManager.connect(req, res, req.body); await stopPersonal(connection.ownerId); res.json(credentialManager.publicStatus(connection)); });
  app.delete('/api/credentials', async (req, res) => { const ownerId = await credentialManager.disconnect(req); await stopPersonal(ownerId); res.json(credentialManager.publicStatus(null, { apiKey, model, provider:providerName })); });
  app.get('/api/projects', (req, res) => res.json([...store.values()].filter(project => accessible(req, project)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(projectListSummary)));
  app.post('/api/projects', async (req, res) => { const project = await createProject({prompt:req.body?.prompt,kind:req.body?.kind,agentDelivery:req.body?.agentDelivery,workflowMode:req.body?.workflowMode}, await requestConnection(req), googleAuth.owner(req)); res.status(202).json(project); });
  app.get('/api/projects/:id', (req, res) => res.json(ownedProject(req)));
  app.post('/api/projects/:id/review', async (req, res) => {
    const project = ownedProject(req);
    if (project.status !== 'awaiting_approval') throw httpError(409, '현재 확인을 기다리는 프로젝트가 아닙니다.');
    // A published pause may still be finishing its persistence callback. Release that run before resuming.
    if (runs.has(project.id)) await runs.get(project.id).promise;
    const connection = await requestConnection(req, project);
    const activeAI = Boolean(connection || provider);
    if ((req.body?.action === 'revise' || project.mode === 'openai') && !activeAI) throw httpError(409, '계획을 수정하거나 AI 생성을 이어가려면 AI 연결이 필요합니다. 로컬 모드에서는 현재 계획을 승인할 수 있습니다.');
    applyReviewDecision(project, req.body);
    project.authMode = connection ? 'api-key' : subscription ? 'codex-subscription' : provider ? 'api-key' : 'none';
    if (connection) { project.ownerId = connection.ownerId; project.credentialSource = 'personal'; project.model = connection.model; project.mode = 'openai'; }
    else project.mode = mode;
    log(project, 'workflow', req.body.action === 'revise' ? '수정 의견을 반영해 계획 단계부터 다시 검토합니다.' : '계획을 승인하여 다음 단계로 진행합니다.');
    await persist(project);
    runProject(project.id, connection);
    res.status(202).json(project);
  });
  app.post('/api/projects/:id/revise', async (req, res) => {
    const parent = ownedProject(req), connection = await requestConnection(req, parent);
    const revision = prepareRevision(parent, req.body?.prompt, Boolean(connection || provider));
    const project = await createProject({ prompt: revision.revision.prompt, kind: parent.kind, ...revision }, connection, parent.ownerId || googleAuth.owner(req));
    res.status(202).json(project);
  });
  app.get('/api/projects/:id/android', async (req,res)=>{const project=ownedProject(req);if(project.kind!=='mobile-app')throw httpError(400,'모바일 앱 프로젝트가 필요합니다.');res.json(await mobileBuilds.status(project));});
  app.post('/api/projects/:id/android/build',async(req,res)=>{const project=ownedProject(req);if(project.kind!=='mobile-app'||project.status!=='completed')throw httpError(409,'완성된 모바일 앱부터 빌드할 수 있습니다.');res.status(202).json(await mobileBuilds.start(project));});
  app.get('/api/projects/:id/android/apk',async(req,res)=>{const project=ownedProject(req);const artifact=await mobileBuilds.artifact(project);res.download(artifact.path,artifact.filename,{dotfiles:'allow'});});
  app.get('/api/projects/:id/android/source',(req,res)=>{const project=ownedProject(req);if(project.kind!=='mobile-app'||project.status!=='completed')throw httpError(409,'완성된 모바일 앱이 필요합니다.');res.setHeader('Content-Type','application/zip');res.setHeader('Content-Disposition',`attachment; filename="launchpad-${project.id.slice(0,8)}-android.zip"`);res.send(createZip(androidSourceFiles({projectId:project.id,name:project.name,files:project.files.filter(file=>file.path.startsWith('public/'))})));});
  app.post('/api/projects/:id/cancel', async (req, res) => {
    const project = ownedProject(req); const run = runs.get(project.id);
    if (project.status === 'awaiting_approval') {
      if (run) await run.promise;
      if (project.status !== 'awaiting_approval') throw httpError(409, '프로젝트 상태가 변경되었습니다. 다시 확인해 주세요.');
      project.status = 'cancelled'; project.review = null; project.error = null;
      log(project, 'workflow', '확인을 기다리던 프로젝트 생성을 취소했습니다.', 'warn');
      await persist(project); return res.json(project);
    }
    if (!run || !['queued','running'].includes(project.status)) throw httpError(409, '실행 중인 프로젝트만 취소할 수 있습니다.');
    run.controller.abort(new Error('사용자가 취소했습니다.')); await run.promise; res.json(project);
  });
  app.post('/api/projects/:id/retry', async (req, res) => {
    const project = ownedProject(req); if (runs.has(project.id) || !['failed','cancelled'].includes(project.status)) throw httpError(409, '실패하거나 취소된 프로젝트만 다시 실행할 수 있습니다.');
    const connection = await requestConnection(req, project);
    project.status = 'queued'; project.error = null; project.stages = stages(); project.checks = []; project.retryCount = 0; project.review = null; project.approvedStages = [];
    project.authMode=connection ? 'api-key' : subscription ? 'codex-subscription' : provider ? 'api-key' : 'none';
    if (connection) { project.ownerId = connection.ownerId; project.credentialSource = 'personal'; project.model = connection.model; project.mode = 'openai'; } else project.mode = mode;
    await persist(project); runProject(project.id, connection); res.status(202).json(project);
  });
  app.post('/api/projects/:id/launch', async (req, res) => { const project = ownedProject(req); if (project.status !== 'completed') throw httpError(409, '완성된 프로젝트만 실행할 수 있습니다.'); const connection = project.credentialSource === 'personal' ? await requestConnection(req, project.kind === 'ai-agent' ? project : undefined) : null; const url = await launchProject(project, undefined, connection); await persist(project); res.json({url}); });
  app.get('/api/projects/:id/download', (req, res) => { const project = ownedProject(req); if (project.status !== 'completed') throw httpError(409, '검증을 통과한 프로젝트만 다운로드할 수 있습니다.'); res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Disposition',`attachment; filename="launchpad-${project.id.slice(0,8)}.zip"`); res.send(createZip(project.files.filter(file => TEMPLATE_FILES.includes(file.path)))); });
  app.get('/api/projects/:id/events', (req, res) => {
    const project = ownedProject(req); res.setHeader('Content-Type','text/event-stream'); res.setHeader('Connection','keep-alive'); res.flushHeaders();
    const send = value => res.write(`event: project\ndata: ${JSON.stringify(value)}\n\n`); send(project);
    if (!listeners.has(project.id)) listeners.set(project.id, new Set()); listeners.get(project.id).add(send);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000); heartbeat.unref();
    req.on('close', () => { clearInterval(heartbeat); listeners.get(project.id)?.delete(send); });
  });
  app.use('/api', (req,res) => res.status(404).json({error:'API를 찾을 수 없습니다.'}));
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', async (req,res,next) => { try { await fs.access(path.join(root,'dist/index.html')); res.sendFile(path.join(root,'dist/index.html')); } catch { next(); } });
  app.use((error,req,res,next) => { if (res.headersSent) return next(error); res.status(error.status || 500).json({error:error.type === 'entity.parse.failed' ? '올바른 JSON을 입력해 주세요.' : error.message || '서버 오류가 발생했습니다.'}); });
  async function shutdown() {
    if (closed) return; closed = true;
    await mobileBuilds.shutdown();
    for (const run of runs.values()) run.controller.abort(new Error('서버가 종료되었습니다.'));
    await Promise.allSettled([...runs.values()].map(run => run.promise));
    await Promise.allSettled([...launches.values()]);
    await Promise.allSettled([...previews.values()].map(runtime => stopProcess(runtime.child))); previews.clear();
    await writes;
  }
  return { app, shutdown, store, templates: registry, createProject, runProject };
}
