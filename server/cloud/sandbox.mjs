import { Sandbox } from '@vercel/sandbox';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORKSPACE = '/vercel/sandbox/launchpad';
const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sourceFiles(directory = SOURCE_ROOT, relative = 'server') {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name); const filename = `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await sourceFiles(full, filename));
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.java')) result.push({ path: `${WORKSPACE}/${filename}`, content: await fs.readFile(full) });
  }
  return result;
}

export function createSandboxRunner({ sdk = Sandbox, env = process.env, fetcher = fetch, bundle = sourceFiles } = {}) {
  const timeout = Math.max(300000, Math.min(Number(env.SANDBOX_TIMEOUT_MS) || 1800000, 2700000));
  const credentials = env.VERCEL_TOKEN && env.VERCEL_PROJECT_ID && env.VERCEL_TEAM_ID
    ? { token: env.VERCEL_TOKEN, projectId: env.VERCEL_PROJECT_ID, teamId: env.VERCEL_TEAM_ID } : {};
  const expires = sandbox => (sandbox.expiresAt || new Date(Date.now() + timeout)).toISOString();
  const previewUrl = (record, url) => `${url}/?access=${encodeURIComponent(record.execution.previewToken)}`;
  const workerEnv = (record, connection) => Object.fromEntries(Object.entries({
    NODE_ENV: 'production', LAUNCHPAD_RECORD_ID: record.project.id, LAUNCHPAD_RUN_ID: record.execution.runId,
    LAUNCHPAD_CONTROL_ORIGIN: record.execution.controlOrigin, LAUNCHPAD_CONTROL_TOKEN: record.execution.controlToken,
    PUBLIC_ORIGIN: record.execution.url, BLOB_READ_WRITE_TOKEN: env.BLOB_READ_WRITE_TOKEN,
    OPENAI_API_KEY: connection?.apiKey || (record.project.credentialSource === 'personal' ? undefined : env.OPENAI_API_KEY), OPENAI_MODEL: connection?.model || env.OPENAI_MODEL || 'gpt-4.1-mini',
    OPENAI_PLANNER_MODEL: env.OPENAI_PLANNER_MODEL, OPENAI_CODER_MODEL: env.OPENAI_CODER_MODEL,
    OPENAI_DEBUGGER_MODEL: env.OPENAI_DEBUGGER_MODEL, OPENAI_IMAGE_MODEL: env.OPENAI_IMAGE_MODEL,
    PERSONAL_KEY_EXPIRES_AT: connection ? String(connection.expiresAt) : undefined,
    AI_PROVIDER:connection?.provider||env.AI_PROVIDER||'openai',
    ANDROID_BUILDER_URL:env.ANDROID_BUILDER_URL,ANDROID_BUILDER_TOKEN:env.ANDROID_BUILDER_TOKEN,
    MAX_RETRIES: String(Math.max(0, Math.min(Number(env.MAX_RETRIES ?? 2), 3))),
  }).filter(([, value]) => typeof value === 'string'));
  async function startWorker(sandbox, record, mode, connection) {
    if (record.project.credentialSource === 'personal' && (!connection?.apiKey || connection.ownerId !== record.project.ownerId || connection.expiresAt <= Date.now())) throw Object.assign(new Error('이 프로젝트의 개인 API 키를 다시 연결해 주세요.'), { status:409 });
    return sandbox.runCommand({ cmd: 'node', args: ['server/cloud/worker.mjs', mode], cwd: WORKSPACE, env: workerEnv(record, connection), detached: true });
  }
  return {
    timeout,
    async buildAndroid(record){
      const sandbox=await sdk.get({...credentials,name:record.execution.name,resume:true});
      await sandbox.writeFiles(await bundle());
      return sandbox.runCommand({cmd:'node',args:['server/cloud/android-worker.mjs'],cwd:WORKSPACE,detached:true,env:Object.fromEntries(Object.entries({LAUNCHPAD_RECORD_ID:record.project.id,LAUNCHPAD_ANDROID_JOB_ID:record.execution.androidJobId,BLOB_READ_WRITE_TOKEN:env.BLOB_READ_WRITE_TOKEN,ANDROID_BUILDER_URL:env.ANDROID_BUILDER_URL,ANDROID_BUILDER_TOKEN:env.ANDROID_BUILDER_TOKEN}).filter(([,value])=>typeof value==='string'))});
    },
    async create(record, onReady, connection) {
      let sandbox;
      try {
        sandbox = await sdk.create({ ...credentials, name: `launchpad-${record.project.id.slice(0, 8)}-${record.execution.runId.slice(0, 8)}`, runtime: 'node22', ports: [3000], timeout, persistent: true, keepLastSnapshots: { count: 1, deleteEvicted: true } });
        record.execution = { ...record.execution, name: sandbox.name, url: sandbox.domain(3000), expiresAt: expires(sandbox), ...(connection ? { credentialRevision:connection.revision } : {}) };
        if (await onReady(record) === false) { await sandbox.stop(); return record; }
        const files = await bundle();
        files.push({ path: `${WORKSPACE}/package.json`, content: Buffer.from(JSON.stringify({ private: true, type: 'module', dependencies: { express: '5.1.0', '@vercel/blob': '2.8.0', '@modelcontextprotocol/sdk': '1.32.0', zod: '4.6.5' } })) });
        await sandbox.writeFiles(files);
        const installed = await sandbox.runCommand({ cmd: 'npm', args: ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: WORKSPACE, timeoutMs: 120000 });
        if (installed.exitCode !== 0) throw new Error('Sandbox 실행 의존성을 준비하지 못했습니다. Vercel Sandbox의 네트워크·실행 로그를 확인하세요.');
        // A cancelled or superseded run must never start after bootstrap finishes.
        const latest = await onReady(record, true);
        if (latest === false) { await sandbox.stop(); return record; }
        await startWorker(sandbox, record, 'generate', connection);
        return record;
      } catch (error) {
        if (sandbox) await sandbox.stop().catch(() => {});
        throw error;
      }
    },
    async inspect(execution) {
      if (!execution?.name) return { status: 'pending' };
      const sandbox = await sdk.get({ ...credentials, name: execution.name, resume: false });
      return { status: sandbox.status, expiresAt: sandbox.expiresAt?.toISOString() };
    },
    async stop(execution) {
      if (!execution?.name) return;
      const sandbox = await sdk.get({ ...credentials, name: execution.name, resume: false });
      if (!['stopped', 'failed'].includes(sandbox.status)) await sandbox.stop();
    },
    async launch(record, connection) {
      if (!record.execution?.name) throw Object.assign(new Error('실행 환경이 없습니다. 프로젝트를 다시 생성해 주세요.'), { status: 409 });
      if (record.project.credentialSource === 'personal' && (!connection?.apiKey || connection.ownerId !== record.project.ownerId || connection.expiresAt <= Date.now())) throw Object.assign(new Error('이 프로젝트의 개인 API 키를 다시 연결해 주세요.'), { status:409 });
      const sandbox = await sdk.get({ ...credentials, name: record.execution.name, resume: true });
      const url = sandbox.domain(3000);
      if (connection && (record.execution.credentialRevoked || record.execution.credentialRevision !== connection.revision)) {
        // A resumed snapshot can restore old process environments. Terminate only
        // this project's trusted worker/runtime before supplying a replacement key.
        const script = `const fs=require('node:fs');for(const name of fs.readdirSync('/proc')){if(!/^\\d+$/.test(name)||Number(name)===process.pid)continue;try{const cmd=fs.readFileSync('/proc/'+name+'/cmdline','utf8');const cwd=fs.readlinkSync('/proc/'+name+'/cwd');if(cmd.includes('server/cloud/worker.mjs')||cwd===${JSON.stringify(`${WORKSPACE}/.data/projects/${record.project.id}`)})process.kill(Number(name),'SIGKILL')}catch{}}`;
        await sandbox.runCommand({ cmd:'node', args:['-e', script], cwd:WORKSPACE, timeoutMs:10000 });
      }
      try { const health = await fetcher(`${url}/api/health`, { signal: AbortSignal.timeout(3000) }); if (health.ok) return { url: previewUrl(record, url), baseUrl: url, expiresAt: expires(sandbox) }; } catch {}
      const next = { ...record, execution: { ...record.execution, url } };
      await startWorker(sandbox, next, 'launch', connection);
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        try { const health = await fetcher(`${url}/api/health`, { signal: AbortSignal.timeout(2500) }); if (health.ok) return { url: previewUrl(record, url), baseUrl: url, expiresAt: expires(sandbox) }; } catch {}
        await sleep(500);
      }
      throw Object.assign(new Error('미리보기 재시작이 지연되고 있습니다. 잠시 후 다시 실행해 주세요.'), { status: 503 });
    },
  };
}
