import crypto from 'node:crypto';
import { createBlobStore, isProjectId } from './store.mjs';
import { createSandboxRunner } from './sandbox.mjs';
import { createAuth } from './auth.mjs';
import { createZip } from '../zip.mjs';
import { TEMPLATE_FILES } from '../templates.mjs';
import { createCredentialManager, createBlobCredentialStore } from '../credentials.mjs';
import { createGoogleAuth } from '../google-auth.mjs';
import { androidSourceFiles } from '../android-builder.mjs';
import { prepareCloudAndroid } from './android-worker.mjs';
import { estimateProject, estimateOptionsFromEnv } from '../estimate.mjs';
import { prepareRevision, revisionMetadata } from '../revisions.mjs';
import { normalizeAgentDelivery } from '../agent-delivery.mjs';
import { normalizeWorkflowMode, applyReviewDecision } from '../workflow-review.mjs';
import { streamBody, projectListSummary } from './response.mjs';
import * as blob from '@vercel/blob';

const stages = [['requirements', '요구사항 분석'], ['features', '기능 정의'], ['architecture', '구조 설계'], ['scaffold', '프로젝트 생성'], ['coding', '코드 구현'], ['validation', '테스트'], ['debugging', '오류 수정'], ['delivery', '결과물 완성']];
const error = (status, message) => Object.assign(new Error(message), { status });
const timestamp = () => new Date().toISOString();
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  return streamBody(res, JSON.stringify(value));
}
async function body(req) {
  let value = req.body;
  if (value === undefined) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 30000) throw error(413, '요청이 너무 큽니다.'); chunks.push(Buffer.from(chunk)); }
    value = Buffer.concat(chunks).toString('utf8');
  }
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    if (Buffer.byteLength(value) > 30000) throw error(413, '요청이 너무 큽니다.');
    try { value = JSON.parse(String(value) || '{}'); } catch { throw error(400, '올바른 JSON이 필요합니다.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(400, 'JSON 객체가 필요합니다.');
  return value;
}
function initialProject(prompt, kind, mode, id = crypto.randomUUID(), requestedDelivery, requestedWorkflowMode) {
  const now = timestamp();
  const agentDelivery = normalizeAgentDelivery(kind, requestedDelivery);
  return { id, name: '새 프로젝트', prompt, kind, ...(agentDelivery === undefined ? {} : { agentDelivery }), workflowMode: normalizeWorkflowMode(requestedWorkflowMode), approvedStages: [], review: null, reviewHistory: [], status: 'queued', createdAt: now, updatedAt: now, mode,
    stages: stages.map(([stage, label]) => ({ id: stage, label, status: 'pending' })),
    logs: [{ id: crypto.randomUUID(), timestamp: now, level: 'info', stage: 'workflow', message: '클라우드 실행 환경을 준비합니다.' }],
    plan: null, files: [], checks: [], previewUrl: null, error: null, retryCount: 0 };
}
function finishWithFailure(project, message) {
  project.status = 'failed'; project.error = message; project.previewUrl = null; project.updatedAt = timestamp();
  for (const stage of project.stages) if (stage.status === 'running') { stage.status = 'failed'; stage.detail = message; stage.completedAt = project.updatedAt; }
  project.logs.push({ id: crypto.randomUUID(), timestamp: project.updatedAt, level: 'error', stage: 'workflow', message });
  return project;
}

export function createCloudHandler(options = {}) {
  const originalEnv=options.env||process.env;
  const providerName=originalEnv.AI_PROVIDER||'openai';
  if(providerName==='codex')throw error(400,'Codex 구독 실행은 로컬 컴퓨터에서만 지원합니다. Vercel에서는 OpenAI API 키를 연결해 주세요.');
  if(providerName!=='openai')throw error(400,'지원하지 않는 AI 제공자 설정입니다. AI_PROVIDER=openai로 설정해 주세요.');
  const env={...originalEnv,AI_PROVIDER:providerName};
  const store = options.store || createBlobStore({ token: env.BLOB_READ_WRITE_TOKEN });
  const runner = options.runner || createSandboxRunner({ env });
  const auth = options.auth || createAuth({ password: env.WORKSPACE_PASSWORD, secret: env.SESSION_SECRET, secure: env.NODE_ENV !== 'test' });
  const googleAuth = options.googleAuth || createGoogleAuth({clientId:env.GOOGLE_CLIENT_ID,clientSecret:env.GOOGLE_CLIENT_SECRET,publicAppUrl:env.PUBLIC_APP_URL,secret:env.SESSION_SECRET,allowedEmails:env.GOOGLE_ALLOWED_EMAILS});
  const authenticated = req => googleAuth.configured ? Boolean(googleAuth.verify(req)) : auth.verify(req);
  const credentialManager = options.credentialManager || createCredentialManager({ secret: env.SESSION_SECRET, store: options.credentialStore || createBlobCredentialStore({ token: env.BLOB_READ_WRITE_TOKEN }), secure: env.NODE_ENV !== 'test', defaultModel: env.OPENAI_MODEL || 'gpt-4.1-mini', ownerResolver:req=>googleAuth.owner(req) });
  const mode = env.OPENAI_API_KEY ? 'openai' : 'local';
  const maxRetries = Math.max(0, Math.min(Number(env.MAX_RETRIES ?? 2), 3));
  const timeout = runner.timeout || 1800000;
  const maxConcurrent = Math.max(1, Math.min(Number(env.MAX_CONCURRENT_PROJECTS) || 3, 10));

  function pauseCallbackUrl() {
    const configured = env.PUBLIC_APP_URL || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined);
    if (!configured) return undefined;
    try {
      const url = new URL(configured);
      if (url.protocol !== 'https:' || url.username || url.password) return undefined;
      return url.origin;
    } catch { return undefined; }
  }
  async function stopPaused(record) {
    // Persisted checkpoints survive sandbox deadlines. Stop only this immutable
    // execution; a concurrent approval may already be preparing a replacement.
    if (record.project.status !== 'awaiting_approval') return record;
    // A transient lease-write failure must not keep a waiting VM billable.
    // reserve() can also reclaim slots whose project is awaiting approval.
    await store.release(record.execution.slot, record.execution.runId).catch(() => {});
    if (!record.execution.name || record.execution.pauseStoppedAt) return record;
    try { await runner.stop(record.execution); }
    catch { return record; }
    return await store.update(record.project.id, current => {
      if (current.execution.runId !== record.execution.runId || current.project.status !== 'awaiting_approval') return null;
      current.execution.pauseStoppedAt = timestamp();
      return current;
    }) || record;
  }

  async function reconcile(record) {
    if (record.project.kind === 'ai-agent') record.project.agentDelivery = normalizeAgentDelivery(record.project.kind, record.project.agentDelivery);
    record.project.workflowMode = normalizeWorkflowMode(record.project.workflowMode);
    if (record.project.status === 'awaiting_approval') return stopPaused(record);
    if (['failed', 'cancelled'].includes(record.project.status) && record.execution?.name) {
      await runner.stop(record.execution).catch(() => {});
      return record;
    }
    if (record.project.status === 'completed' && record.project.previewUrl && Date.parse(record.execution.expiresAt) < Date.now()) {
      return await store.update(record.project.id, current => {
        if (current.execution.runId !== record.execution.runId || current.project.status !== 'completed' || Date.parse(current.execution.expiresAt) >= Date.now()) return null;
        current.project.previewUrl = null; current.project.updatedAt = timestamp();
        return current;
      }) || record;
    }
    if (!['queued', 'running'].includes(record.project.status)) return record;
    const expired = Date.parse(record.execution.expiresAt) < Date.now();
    let stopped = false;
    if (!expired && record.execution.name) {
      try { stopped = ['failed', 'stopped'].includes((await runner.inspect(record.execution)).status); }
      catch { /* A transient provider error must not overwrite a live project. The deadline remains authoritative. */ }
    }
    if (!expired && !stopped) return record;
    const updated = await store.update(record.project.id, current => {
      if (current.execution.runId !== record.execution.runId || !['queued', 'running'].includes(current.project.status)) return null;
      current.project = finishWithFailure(current.project, 'Sandbox 실행 시간이 끝났거나 프로세스가 중단되었습니다. 프로젝트를 다시 생성해 주세요.');
      return current;
    });
    await store.release(record.execution.slot, record.execution.runId);
    await runner.stop(record.execution).catch(() => {});
    return updated || record;
  }
  async function begin(project, previous, connection, revisionSeed, resumeFromReview = false) {
    if (connection) { project.ownerId = connection.ownerId; project.credentialSource = 'personal'; project.model = connection.model; project.mode = 'openai'; }
    const runId = crypto.randomUUID();
    let record = { project, execution: { runId, previewToken: crypto.randomBytes(32).toString('hex'), controlToken: crypto.randomBytes(32).toString('hex'), controlOrigin: pauseCallbackUrl(), name: null, url: null, expiresAt: new Date(Date.now() + timeout).toISOString(), slot: null, ...(revisionSeed ? { revisionSeed } : {}), ...(resumeFromReview ? { resumeFromReview: true } : {}) } };
    if (previous) {
      // Conditional write makes simultaneous retries mutually exclusive.
      await store.write(record, previous.etag);
    } else await store.write(record);
    try {
      const slot = await store.reserve(runId, project.id, record.execution.expiresAt, maxConcurrent);
      record = await store.update(project.id, current => {
        if (current.execution.runId !== runId || current.project.status !== 'queued') return null;
        current.execution.slot = slot;
        return current;
      });
      if (!record || record.execution.runId !== runId || record.project.status !== 'queued') {
        await store.release(slot, runId);
        return record?.project || project;
      }
      await runner.create(record, async (ready, checkOnly = false) => {
        const current = await store.read(project.id);
        if (!current || current.value.execution.runId !== runId || !['queued', 'running'].includes(current.value.project.status) || current.value.execution.credentialRevoked) return false;
        if (connection && (await credentialManager.readOwner(connection.ownerId))?.revision !== connection.revision) return false;
        if (!checkOnly) {
          record = { ...current.value, execution: { ...current.value.execution, ...ready.execution } };
          await store.write(record, current.etag);
        }
        return true;
      }, connection);
      const current = await store.read(project.id);
      return current?.value.project || record.project;
    } catch (failure) {
      await store.update(project.id, current => {
        if (current.execution.runId !== runId || !['queued', 'running'].includes(current.project.status)) return null;
        current.project = finishWithFailure(current.project, failure.status === 429 ? failure.message : '클라우드 실행 환경을 준비하지 못했습니다. Vercel Sandbox·Blob 연결과 서버 환경 변수를 확인하세요.');
        return current;
      });
      await store.release(record.execution.slot, runId);
      throw failure.status ? failure : error(502, '클라우드 실행 환경 준비에 실패했습니다. 저장된 프로젝트의 오류와 Vercel 로그를 확인하세요.');
    }
  }
  const accessible = (req, project) => !project.ownerId || project.ownerId === credentialManager.owner(req);
  async function requireConnection(req, project) {
    const connection = await credentialManager.resolve(req);
    if(connection?.provider && connection.provider!=='openai')throw error(409,'OpenAI API 키를 다시 연결해 주세요.');
    if (project?.credentialSource === 'personal' && (!connection || connection.ownerId !== project.ownerId)) throw error(409, '이 프로젝트의 개인 API 키를 다시 연결해 주세요.');
    return connection;
  }
  async function stopPersonal(ownerId) {
    if (!ownerId) return;
    const records = (await store.list()).filter(record => record.project.ownerId === ownerId);
    for (const record of records) {
      const updated = await store.update(record.project.id, current => {
        if (current.project.ownerId !== ownerId) return null;
        if (['queued', 'running', 'awaiting_approval'].includes(current.project.status)) {
          current.project.status = 'cancelled';
          current.project.review = null;
          for (const stage of current.project.stages) if (stage.status === 'running') { stage.status = 'failed'; stage.detail = '개인 API 키 연결이 변경되어 실행을 중단했습니다.'; stage.completedAt = timestamp(); }
        }
        current.project.previewUrl = null; current.project.updatedAt = timestamp();
        // Old snapshots must fail the worker run check if the sandbox is resumed.
        current.execution.credentialRevoked = true;
        current.execution.previewToken = crypto.randomBytes(32).toString('hex');
        return current;
      });
      await runner.stop(updated.execution);
      await store.release(updated.execution.slot, updated.execution.runId);
    }
  }

  return async function handler(req, res) {
    try {
      const host = req.headers.host || '';
      const googleCallback=req.method==='GET'&&new URL(req.url,'https://launchpad.invalid').pathname==='/api/auth/google/callback';
      if (!googleCallback && req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw error(403, '허용되지 않은 출처입니다.'); }
        if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== host) throw error(403, '외부 출처 요청은 허용되지 않습니다.');
      }
      if (!googleCallback && req.headers['sec-fetch-site'] === 'cross-site') throw error(403, '외부 사이트의 요청은 허용되지 않습니다.');
      const pathname = new URL(req.url, 'https://launchpad.invalid').pathname.replace(/\/$/, '') || '/';
      const pauseCallback = pathname.match(/^\/api\/internal\/projects\/([^/]+)\/pause$/);
      if (pauseCallback) {
        if (req.method !== 'POST') throw error(405, '허용되지 않은 메서드입니다.');
        const input = await body(req);
        const id = pauseCallback[1];
        if (!isProjectId(id)) throw error(404, '요청한 작업을 찾을 수 없습니다.');
        const found = await store.read(id);
        const provided = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
        const expected = Buffer.from(found?.value.execution.controlToken || '');
        if (!expected.length || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) throw error(401, '작업 인증이 필요합니다.');
        const record = found.value;
        if (input.runId !== record.execution.runId || record.project.status !== 'awaiting_approval') throw error(409, '현재 대기 중인 작업이 아닙니다.');
        const stopped = await stopPaused(record);
        if (stopped.execution.runId !== record.execution.runId) throw error(409, '이미 다음 실행으로 전환된 작업입니다.');
        return json(res, stopped.execution.name && !stopped.execution.pauseStoppedAt ? 503 : 200, { stopped: Boolean(stopped.execution.pauseStoppedAt) });
      }
      if(!res.redirect)res.redirect=(status,location)=>{res.writeHead(status,{Location:location});res.end();};
      if (pathname === '/api/auth/google/start' && req.method === 'GET') return googleAuth.start(req,res);
      if (pathname === '/api/auth/google/callback' && req.method === 'GET') { try { return await googleAuth.callback(req,res); } catch { res.writeHead(303,{Location:'/?auth_error=google#new','Cache-Control':'no-store'}); return res.end(); } }
      if (pathname === '/api/auth/session' && req.method === 'GET') return json(res, 200, { authenticated: authenticated(req), required: true, configured: googleAuth.configured || auth.configured, google:googleAuth.configured, user:googleAuth.verify(req) });
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        if (googleAuth.configured) throw error(400,'Google 계정으로 로그인해 주세요.');
        if (!auth.configured) throw error(503, '서버에 WORKSPACE_PASSWORD(12자 이상)와 SESSION_SECRET(32자 이상)을 설정해 주세요.');
        const cookie = auth.login((await body(req)).password);
        if (!cookie) throw error(401, '워크스페이스 비밀번호를 확인해 주세요.');
        return json(res, 200, { authenticated: true }, { 'Set-Cookie': cookie });
      }
      if (pathname === '/api/auth/logout' && req.method === 'POST') { googleAuth.logout(req,res); res.setHeader('Set-Cookie',[...(res.getHeader('Set-Cookie') || []),auth.logout()]); return json(res, 200, { authenticated: false }); }
      if (pathname === '/api/config' && req.method === 'GET') {
        const connection = authenticated(req) ? await credentialManager.resolve(req) : null;
        return json(res, 200, { mode:connection ? 'openai' : mode, model:connection?.model || (mode === 'openai' ? (env.OPENAI_MODEL || 'gpt-4.1-mini') : null), ...((connection || mode === 'openai') ? { modelRouting: 'automatic' } : {}), credentialSource:connection ? 'personal' : mode === 'openai' ? 'server' : 'none',provider:connection?.provider||providerName, maxRetries, version: '0.2.0', deployment: 'vercel', requiresAuth: true });
      }
      if ((!auth.configured && !googleAuth.configured) || !env.BLOB_READ_WRITE_TOKEN) throw error(503, 'Vercel 서버 환경 변수가 준비되지 않았습니다. 배포 문서를 확인해 주세요.');
      if (!authenticated(req)) throw error(401, '워크스페이스 로그인이 필요합니다.');
      if (pathname === '/api/estimate' && req.method === 'POST') {
        const input = await body(req), connection = await requireConnection(req);
        return json(res, 200, estimateProject({ prompt: input.prompt, kind: input.kind, agentDelivery:input.agentDelivery, provider: connection?.provider || (mode === 'openai' ? providerName : 'local'), model: connection?.model || (mode === 'openai' ? env.OPENAI_MODEL || 'gpt-4.1-mini' : null), ...((connection || mode === 'openai') ? { modelRouting: 'automatic' } : {}) }, { ...estimateOptionsFromEnv(originalEnv), maxRetries }));
      }
      const mobileRoute=pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/android(?:\/(build|apk|source))?$/i);
      if(mobileRoute){
        const [,id,action]=mobileRoute;const found=await store.read(id);
        if(!found||!accessible(req,found.value.project))throw error(404,'프로젝트를 찾을 수 없습니다.');
        const record=found.value,project=record.project;
        if(project.kind!=='mobile-app')throw error(400,'모바일 앱 프로젝트가 필요합니다.');
        if(!action&&req.method==='GET'){
          if(project.android?.status==='building'&&Date.now()-Date.parse(project.android.startedAt)>300000){
            const updated=await store.update(id,current=>{
              if(current.execution.androidJobId!==record.execution.androidJobId || current.project.android?.status!=='building' || Date.now()-Date.parse(current.project.android.startedAt)<=300000)return null;
              delete current.execution.androidJobId;
              current.project.android={status:'failed',logs:[],message:'APK 빌드 시간이 초과되었습니다. 다시 빌드해 주세요.'};return current;
            });
            return json(res,200,updated.project.android);
          }
          return json(res,200,project.android||{status:'idle',logs:[]});
        }
        if(action==='build'&&req.method==='POST'){
          const job=await prepareCloudAndroid(store,id);
          try{await runner.buildAndroid(job);}catch{await store.update(id,current=>{if(current.execution.androidJobId!==job.execution.androidJobId)return null;current.project.android={status:'failed',logs:[],message:'Android 빌드 실행 환경을 시작하지 못했습니다.'};return current;});throw error(503,'Android 빌드 실행 환경을 시작하지 못했습니다.');}
          return json(res,202,job.project.android);
        }
        if(action==='source'&&req.method==='GET'&&project.status==='completed'){
          res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="launchpad-${id.slice(0,8)}-android.zip"`,'Cache-Control':'no-store'});return streamBody(res,createZip(androidSourceFiles({projectId:id,name:project.name,files:project.files.filter(file=>file.path.startsWith('public/'))})));
        }
        if(action==='apk'&&req.method==='GET'){
          if(project.android?.status!=='ready'||!record.execution.androidArtifact)throw error(409,'APK를 먼저 빌드해 주세요.');
          const artifact=await (options.blobs||blob).get(record.execution.androidArtifact,{token:env.BLOB_READ_WRITE_TOKEN,access:'private',useCache:false});if(!artifact)throw error(404,'APK를 찾을 수 없습니다. 다시 빌드해 주세요.');
          const data=Buffer.from(await new Response(artifact.stream).arrayBuffer());
          if(crypto.createHash('sha256').update(data).digest('hex')!==project.android.sha256)throw error(502,'APK 무결성 검사에 실패했습니다.');
          res.writeHead(200,{'Content-Type':'application/vnd.android.package-archive','Content-Disposition':`attachment; filename="launchpad-${id.slice(0,8)}-debug.apk"`,'Cache-Control':'no-store'});return streamBody(res,data);
        }
        throw error(405,'허용되지 않은 APK 요청입니다.');
      }
      if (pathname === '/api/credentials') {
        if (req.method === 'GET') { credentialManager.ensure(req, res); return json(res, 200, credentialManager.publicStatus(await credentialManager.resolve(req), { apiKey:env.OPENAI_API_KEY, model:env.OPENAI_MODEL,provider:providerName })); }
        if (req.method === 'PUT') { const connection = await credentialManager.connect(req, res, await body(req)); await stopPersonal(connection.ownerId); return json(res, 200, credentialManager.publicStatus(connection)); }
        if (req.method === 'DELETE') { const ownerId = await credentialManager.disconnect(req); await stopPersonal(ownerId); return json(res, 200, credentialManager.publicStatus(null, { apiKey:env.OPENAI_API_KEY, model:env.OPENAI_MODEL,provider:providerName })); }
        throw error(405, '허용되지 않은 메서드입니다.');
      }
      if (pathname === '/api/projects' && req.method === 'GET') {
        const records = (await store.list()).filter(record => accessible(req, record.project));
        const current = await Promise.all(records.map(reconcile));
        return json(res, 200, current.map(record => projectListSummary(record.project)));
      }
      if (pathname === '/api/projects' && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.prompt !== 'string' || input.prompt.trim().length < 10 || input.prompt.trim().length > 4000) throw error(400, '요구사항을 10~4000자로 입력해 주세요.');
        if (!['web-app', 'ai-agent', 'mobile-app'].includes(input.kind)) throw error(400, '올바른 프로젝트 유형을 선택해 주세요.');
        const project=initialProject(input.prompt.trim(), input.kind, mode, undefined, input.agentDelivery, input.workflowMode); const ownerId=googleAuth.owner(req); if(ownerId) project.ownerId=ownerId;
        return json(res, 202, await begin(project, undefined, await requireConnection(req)));
      }
      const matched = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(cancel|retry|revise|review|launch|download|events))?$/);
      if (!matched || !isProjectId(matched[1])) throw error(404, '요청한 API를 찾을 수 없습니다.');
      const [, id, action] = matched;
      let found = await store.read(id); if (!found) throw error(404, '프로젝트를 찾을 수 없습니다.');
      if (!accessible(req, found.value.project)) throw error(404, '프로젝트를 찾을 수 없습니다.');
      let record = await reconcile(found.value);
      if (!action && req.method === 'GET') return json(res, 200, record.project);
      if (action === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        return streamBody(res,`event: project\ndata: ${JSON.stringify(record.project)}\n\n`);
      }
      if (action === 'download' && req.method === 'GET') {
        if (record.project.status !== 'completed' || !record.project.files.length) throw error(409, '검증을 마친 프로젝트만 다운로드할 수 있습니다.');
        const zip = createZip(record.project.files.filter(file => TEMPLATE_FILES.includes(file.path)));
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="launchpad-${id.slice(0, 8)}.zip"`, 'Cache-Control': 'no-store' });
        return streamBody(res,zip);
      }
      if (req.method !== 'POST') throw error(405, '허용되지 않은 메서드입니다.');
      if (action === 'review') {
        const input = await body(req);
        const connection = await requireConnection(req, record.project);
        if (input.action === 'revise' && !(connection || mode === 'openai')) throw error(409, '기획 수정에는 OpenAI API 연결이 필요합니다. 키를 연결한 뒤 다시 요청해 주세요.');
        // Re-read after reconciliation and use the exact version as the resume
        // claim. Two confirmations can never start two paid worker executions.
        found = await store.read(id);
        if (!found || !accessible(req, found.value.project)) throw error(404, '프로젝트를 찾을 수 없습니다.');
        const project = structuredClone(found.value.project);
        applyReviewDecision(project, input);
        await runner.stop(found.value.execution);
        await store.release(found.value.execution.slot, found.value.execution.runId);
        return json(res, 202, await begin(project, found, connection, found.value.execution.revisionSeed, true));
      }
      if (action === 'revise') {
        const connection = await requireConnection(req, record.project);
        const revision = prepareRevision(record.project, (await body(req)).prompt, Boolean(connection || mode === 'openai'));
        const project = initialProject(revision.revision.prompt, record.project.kind, mode, undefined, revision.agentDelivery, record.project.workflowMode);
        project.parentProjectId = revision.parentProjectId; project.revision = revision.revision;
        const ownerId = record.project.ownerId || googleAuth.owner(req); if (ownerId) project.ownerId = ownerId;
        return json(res, 202, await begin(project, undefined, connection, revision.revisionSeed));
      }
      if (action === 'cancel') {
        if (!['queued', 'running', 'awaiting_approval'].includes(record.project.status)) return json(res, 200, record.project);
        record = await store.update(id, current => {
          if (!['queued', 'running', 'awaiting_approval'].includes(current.project.status)) return null;
          current.project.status = 'cancelled'; current.project.updatedAt = timestamp(); current.project.previewUrl = null;
          current.project.review = null;
          for (const stage of current.project.stages) if (stage.status === 'running') { stage.status = 'failed'; stage.detail = '사용자가 취소했습니다.'; stage.completedAt = current.project.updatedAt; }
          current.project.logs.push({ id: crypto.randomUUID(), timestamp: current.project.updatedAt, level: 'warn', stage: 'workflow', message: '사용자가 생성을 취소했습니다.' });
          return current;
        });
        await runner.stop(record.execution); await store.release(record.execution.slot, record.execution.runId);
        return json(res, 200, record.project);
      }
      if (action === 'retry') {
        if (!['failed', 'cancelled'].includes(record.project.status)) throw error(409, '실패하거나 취소된 프로젝트만 다시 생성할 수 있습니다.');
        const connection = await requireConnection(req, record.project);
        await runner.stop(record.execution);
        found = await store.read(id);
        if (!['failed', 'cancelled'].includes(found.value.project.status)) throw error(409, '이미 다시 생성 중입니다.');
        const project = initialProject(record.project.prompt, record.project.kind, mode, id, record.project.agentDelivery, record.project.workflowMode);
        project.reviewHistory = structuredClone(record.project.reviewHistory || []);
        if(record.project.ownerId) project.ownerId=record.project.ownerId;
        if (record.project.revision) {
          project.parentProjectId = record.project.parentProjectId;
          project.revision = revisionMetadata(record.project.revision.number, project.prompt, Boolean(connection || mode === 'openai'));
        }
        project.createdAt = record.project.createdAt;
        return json(res, 202, await begin(project, found, connection, found.value.execution.revisionSeed));
      }
      if (action === 'launch') {
        if (record.project.status !== 'completed') throw error(409, '완료된 프로젝트만 실행할 수 있습니다.');
        // Opening a shared project must never donate the current browser's key
        // to an execution that is visible to the rest of the workspace.
        const connection = record.project.credentialSource === 'personal' ? await requireConnection(req, record.project) : null;
        const launchId = crypto.randomUUID();
        record = await store.update(id, current => {
          if (current.project.status !== 'completed') throw error(409, '완료된 프로젝트만 실행할 수 있습니다.');
          if (Date.parse(current.execution.launchingUntil) > Date.now()) throw error(409, '미리보기를 시작하고 있습니다. 잠시 후 다시 시도해 주세요.');
          current.execution.launchId = launchId; current.execution.launchingUntil = new Date(Date.now() + 60000).toISOString();
          return current;
        });
        try {
          const result = await runner.launch(record, connection);
          if (connection && (await credentialManager.readOwner(connection.ownerId))?.revision !== connection.revision) {
            await runner.stop(record.execution);
            throw error(409, '개인 API 키 연결이 변경되어 미리보기를 중단했습니다. 다시 연결해 주세요.');
          }
          await store.update(id, current => current.execution.runId !== record.execution.runId || current.execution.launchId !== launchId ? null : ({ ...current, execution: { ...current.execution, launchingUntil: null, credentialRevoked:false, ...(connection ? { credentialRevision:connection.revision } : {}), expiresAt: result.expiresAt, url: result.baseUrl || current.execution.url }, project: { ...current.project, previewUrl: result.url, updatedAt: timestamp() } }));
          return json(res, 200, { url: result.url });
        } catch (failure) {
          await store.update(id, current => current.execution.launchId !== launchId ? null : ({ ...current, execution: { ...current.execution, launchingUntil: null } }));
          throw failure;
        }
      }
      throw error(404, '요청한 API를 찾을 수 없습니다.');
    } catch (failure) {
      if (!failure.status) console.error('Cloud API failed:', failure.name, failure.message);
      const status = failure.name === 'BlobPreconditionFailedError' ? 409 : failure.status || 500;
      return json(res, status, { error: failure.status ? failure.message : status === 409 ? '다른 요청이 프로젝트를 변경했습니다. 새로고침 후 다시 시도해 주세요.' : '클라우드 요청에 실패했습니다. Vercel 로그와 저장소 설정을 확인해 주세요.' });
    }
  };
}
