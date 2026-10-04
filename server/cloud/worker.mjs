import { once } from 'node:events';
import crypto from 'node:crypto';
import { createApp } from '../app.mjs';
import { createBlobStore, isProjectId } from './store.mjs';
import { autoBuildCloudAndroid } from './android-worker.mjs';
import { workerInitialOptions, publishWorkerSnapshot, requestPausedSandboxStop } from './workflow-state.mjs';

const id = process.env.LAUNCHPAD_RECORD_ID;
const runId = process.env.LAUNCHPAD_RUN_ID;
if (!isProjectId(id) || !runId) throw new Error('A valid cloud project and run ID are required.');
if (process.env.AI_PROVIDER && process.env.AI_PROVIDER !== 'openai') throw new Error('AI_PROVIDER=openai is required.');
const store = createBlobStore();
const initial = await store.read(id);
if (!initial || initial.value.execution.runId !== runId || initial.value.execution.credentialRevoked || ['cancelled', 'failed', 'awaiting_approval'].includes(initial.value.project.status)) process.exit(0);
const record = initial.value;
const mode = process.argv[2] === 'launch' ? 'launch' : 'generate';
const connection = record.project.credentialSource === 'personal' ? { source:'personal',provider:'openai', ownerId:record.project.ownerId, apiKey:process.env.OPENAI_API_KEY || '', model:process.env.OPENAI_MODEL || record.project.model, expiresAt:Number(process.env.PERSONAL_KEY_EXPIRES_AT) } : undefined;
if (connection && (!connection.apiKey || connection.expiresAt <= Date.now())) throw new Error('Personal API key connection is missing or expired.');

async function publish(project) {
  if (!await publishWorkerSnapshot(store, id, runId, project)) throw new Error('Workflow execution is no longer current.');
}

let engine;
let server;
try {
  engine = await createApp({
    dataDir: '/vercel/sandbox/launchpad/.data', apiKey: process.env.OPENAI_API_KEY || '', model: process.env.OPENAI_MODEL,
    maxRetries: Number(process.env.MAX_RETRIES ?? 2), previewHost: '0.0.0.0', previewPort: 3000,
    publicOrigin: process.env.PUBLIC_ORIGIN, previewAccessToken: record.execution.previewToken, onProjectUpdate: publish,
    ...workerInitialOptions(record, mode), internalOwnerId:record.project.ownerId, internalConnection:connection,disableAutoAndroid:true,
  });
  server = engine.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  if (mode === 'generate') {
    if (!record.execution.resumeFromReview) await engine.createProject({ id, prompt: record.project.prompt, kind: record.project.kind, agentDelivery:record.project.agentDelivery, workflowMode:record.project.workflowMode,
      ...(record.project.revision ? { parentProjectId:record.project.parentProjectId, revision:record.project.revision, revisionSeed:record.execution.revisionSeed } : {}) }, connection,record.project.ownerId);
    await engine.runProject(id, connection);
    if(record.project.kind==='mobile-app' && engine.store.get(id)?.status==='completed'){
      await autoBuildCloudAndroid(store,id,runId);
    }
    if (['failed', 'cancelled', 'awaiting_approval'].includes(engine.store.get(id)?.status)) {
      await engine.shutdown(); server.close();
    }
    if (engine.store.get(id)?.status === 'awaiting_approval') {
      // The checkpoint has already been durably published. A narrow control
      // callback stops the VM; normal project polling retries if it is unavailable.
      await requestPausedSandboxStop({ id, runId, origin: process.env.LAUNCHPAD_CONTROL_ORIGIN, token: process.env.LAUNCHPAD_CONTROL_TOKEN });
    }
  }
  else {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${id}/launch`, { method: 'POST' });
    if (!response.ok) throw new Error('저장된 프로젝트의 미리보기를 다시 실행하지 못했습니다.');
    const launched = await response.json();
    await store.update(id, current => current.execution.runId !== runId ? null : ({ ...current, project: { ...current.project, previewUrl: launched.url, updatedAt: new Date().toISOString() } }));
  }
} catch (error) {
  await store.update(id, current => {
    if (current.execution.runId !== runId || current.execution.credentialRevoked || ['cancelled', 'awaiting_approval', 'completed'].includes(current.project.status)) return null;
    current.project.status = 'failed'; current.project.error = 'Sandbox 작업 실행에 실패했습니다. 서버 로그와 API 설정을 확인하세요.';
    current.project.updatedAt = new Date().toISOString();
    current.project.logs.push({ id: crypto.randomUUID(), timestamp: current.project.updatedAt, level: 'error', stage: 'workflow', message: current.project.error });
    return current;
  }).catch(() => {});
  await store.release(record.execution.slot, runId).catch(() => {});
  console.error('Cloud worker failed:', error.message);
  if (engine) await engine.shutdown();
  if (server) server.close();
  process.exitCode = 1;
}
