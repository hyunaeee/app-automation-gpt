import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createSandboxRunner } from '../server/cloud/sandbox.mjs';

const WORKSPACE = '/vercel/sandbox/launchpad';
const ORIGIN = 'https://test-preview.vercel.run';
const expiry = new Date('2030-01-02T03:04:05Z');
const secrets = {
  WORKSPACE_PASSWORD: 'workspace-secret-never-in-worker',
  SESSION_SECRET: 'session-secret-never-in-worker',
  VERCEL_TOKEN: 'vercel-secret-only-sdk',
  VERCEL_PROJECT_ID: 'project-id-only-sdk',
  VERCEL_TEAM_ID: 'team-id-only-sdk',
  BLOB_READ_WRITE_TOKEN: 'blob-token-for-worker',
  OPENAI_API_KEY: 'openai-key-for-worker',
  OPENAI_MODEL: 'configured-codex-model',
  OPENAI_PLANNER_MODEL: 'configured-planning-model',
  OPENAI_CODER_MODEL: 'configured-coding-model',
  OPENAI_DEBUGGER_MODEL: 'configured-debugging-model',
  OPENAI_IMAGE_MODEL: 'configured-image-model',
  MAX_RETRIES: '0',
};

function record() {
  return {
    project: { id: crypto.randomUUID(), status: 'queued', prompt: '일정 기록을 관리하는 개인용 앱', kind: 'web-app' },
    execution: { runId: crypto.randomUUID(), previewToken: 'preview-access-token', name: null, url: null, expiresAt: null },
  };
}

// Mirrors the installed Sandbox 3.5.1 public API: create/get return Sandbox;
// non-detached runCommand resolves a finished command, detached resolves a command.
function fixture({ installExitCode = 0, fetcher = async () => new Response('{}'), workerFailure } = {}) {
  const events = [], commands = [], getCalls = [], createCalls = [];
  let uploaded = [];
  const sandbox = {
    name: 'test-persistent-sandbox', expiresAt: expiry, status: 'running',
    domain(port) { assert.equal(port, 3000); return ORIGIN; },
    async writeFiles(files) { events.push('upload'); uploaded = files; },
    async runCommand(command) {
      commands.push(command);
      if (command.cmd === 'npm') { events.push('install'); return { exitCode: installExitCode }; }
      events.push('worker');
      if (workerFailure) throw workerFailure;
      return { cmdId: 'detached-command-id', exitCode: null };
    },
    async stop() { events.push('stop'); return { status: 'stopped' }; },
  };
  const sdk = {
    async create(options) { createCalls.push(options); events.push('create'); return sandbox; },
    async get(options) { getCalls.push(options); return sandbox; },
  };
  const runner = createSandboxRunner({
    sdk, env: secrets, fetcher,
    bundle: async () => [{ path: `${WORKSPACE}/server/cloud/worker.mjs`, content: Buffer.from('// trusted worker source') }],
  });
  return { runner, sandbox, events, commands, getCalls, createCalls, get uploaded() { return uploaded; } };
}

test('Sandbox bootstrap uploads trusted source and starts a detached worker with only required secrets', async () => {
  const f = fixture(); const input = record(); const readyCalls = [];
  const result = await f.runner.create(input, async (snapshot, checkOnly) => {
    readyCalls.push({ snapshot: structuredClone(snapshot), checkOnly: Boolean(checkOnly) });
    f.events.push(checkOnly ? 'check-current-run' : 'publish-sandbox');
    return true;
  });
  assert.equal(result.execution.name, f.sandbox.name);
  assert.equal(result.execution.url, ORIGIN);
  assert.equal(result.execution.expiresAt, expiry.toISOString());
  assert.deepEqual(f.events, ['create', 'publish-sandbox', 'upload', 'install', 'check-current-run', 'worker']);
  assert.deepEqual(readyCalls.map(call => call.checkOnly), [false, true]);

  const create = f.createCalls[0];
  assert.equal(create.token, secrets.VERCEL_TOKEN);
  assert.equal(create.projectId, secrets.VERCEL_PROJECT_ID);
  assert.equal(create.teamId, secrets.VERCEL_TEAM_ID);
  assert.equal(create.persistent, true);
  assert.deepEqual(create.ports, [3000]);
  assert.equal(create.runtime, 'node22');
  assert.equal(create.env, undefined);

  assert.ok(f.uploaded.some(file => file.path.endsWith('/server/cloud/worker.mjs')));
  const manifest = JSON.parse(f.uploaded.find(file => file.path === `${WORKSPACE}/package.json`).content.toString());
  assert.ok(manifest.dependencies.express);
  assert.ok(manifest.dependencies['@vercel/blob']);
  const uploadedText = f.uploaded.map(file => file.content.toString()).join('\n');
  for (const value of Object.values(secrets)) {
    if (value === '0') continue;
    assert.ok(!uploadedText.includes(value), 'Upload must contain source only, not environment credentials');
  }
  assert.ok(!uploadedText.includes(input.execution.previewToken));

  const install = f.commands.find(command => command.cmd === 'npm');
  assert.ok(install.args.includes('--ignore-scripts'));
  assert.ok(install.args.includes('--omit=dev'));
  assert.equal(install.cwd, WORKSPACE);
  assert.equal(install.timeoutMs, 120000);
  const worker = f.commands.find(command => command.cmd === 'node');
  assert.deepEqual(worker.args, ['server/cloud/worker.mjs', 'generate']);
  assert.equal(worker.cwd, WORKSPACE);
  assert.equal(worker.detached, true);
  assert.equal(worker.env.LAUNCHPAD_RECORD_ID, input.project.id);
  assert.equal(worker.env.LAUNCHPAD_RUN_ID, input.execution.runId);
  assert.equal(worker.env.PUBLIC_ORIGIN, ORIGIN);
  assert.equal(worker.env.OPENAI_API_KEY, secrets.OPENAI_API_KEY);
  assert.equal(worker.env.BLOB_READ_WRITE_TOKEN, secrets.BLOB_READ_WRITE_TOKEN);
  assert.equal(worker.env.OPENAI_MODEL, secrets.OPENAI_MODEL);
  for (const role of ['PLANNER', 'CODER', 'DEBUGGER', 'IMAGE']) assert.equal(worker.env[`OPENAI_${role}_MODEL`], secrets[`OPENAI_${role}_MODEL`]);
  assert.equal(worker.env.MAX_RETRIES, '0');
  for (const key of ['WORKSPACE_PASSWORD', 'SESSION_SECRET', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID']) assert.equal(worker.env[key], undefined);
});

test('a cancelled or superseded Sandbox run never starts its worker after bootstrap', async () => {
  const f = fixture(); const input = record();
  await f.runner.create(input, async (_, checkOnly) => !checkOnly);
  assert.equal(f.commands.filter(command => command.cmd === 'node').length, 0);
  assert.deepEqual(f.events, ['create', 'upload', 'install', 'stop']);
});

test('Sandbox bootstrap or detached-worker failure stops the created environment', async () => {
  const brokenInstall = fixture({ installExitCode: 1 });
  await assert.rejects(brokenInstall.runner.create(record(), async () => true), /의존성을 준비하지 못했습니다/);
  assert.deepEqual(brokenInstall.events, ['create', 'upload', 'install', 'stop']);
  assert.equal(brokenInstall.commands.some(command => command.cmd === 'node'), false);

  const brokenWorker = fixture({ workerFailure: new Error('worker could not be started') });
  await assert.rejects(brokenWorker.runner.create(record(), async () => true), /worker could not be started/);
  assert.equal(brokenWorker.events.at(-1), 'stop');
});

test('Sandbox launch resumes explicitly and returns an access-gated preview URL', async () => {
  const requests = [];
  const f = fixture({ fetcher: async (url, init) => { requests.push({ url, init }); return new Response('{}'); } });
  const input = record(); input.execution.name = f.sandbox.name;
  const result = await f.runner.launch(input);
  assert.deepEqual(f.getCalls[0], { token: secrets.VERCEL_TOKEN, projectId: secrets.VERCEL_PROJECT_ID, teamId: secrets.VERCEL_TEAM_ID, name: f.sandbox.name, resume: true });
  assert.equal(result.url, `${ORIGIN}/?access=${input.execution.previewToken}`);
  assert.equal(result.baseUrl, ORIGIN);
  assert.equal(result.expiresAt, expiry.toISOString());
  assert.equal(requests[0].url, `${ORIGIN}/api/health`);
  assert.ok(requests[0].init.signal instanceof AbortSignal);
  assert.equal(f.commands.length, 0, 'A healthy preview must not spawn another worker');
});

test('Sandbox launch restarts a missing preview worker and waits for actual health', async () => {
  let healthCalls = 0;
  const f = fixture({ fetcher: async () => new Response('{}', { status: ++healthCalls === 1 ? 503 : 200 }) });
  const input = record(); input.execution.name = f.sandbox.name; input.execution.url = 'https://expired-preview.vercel.run';
  const result = await f.runner.launch(input);
  assert.equal(healthCalls, 2);
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.commands[0].args, ['server/cloud/worker.mjs', 'launch']);
  assert.equal(f.commands[0].detached, true);
  assert.equal(f.commands[0].env.PUBLIC_ORIGIN, ORIGIN);
  assert.equal(result.url, `${ORIGIN}/?access=${input.execution.previewToken}`);
});

test('Sandbox inspection and stopping never resume a dormant environment', async () => {
  const f = fixture();
  assert.deepEqual(await f.runner.inspect({}), { status: 'pending' });
  assert.equal(f.getCalls.length, 0);
  assert.deepEqual(await f.runner.inspect({ name: f.sandbox.name }), { status: 'running', expiresAt: expiry.toISOString() });
  await f.runner.stop({ name: f.sandbox.name });
  assert.ok(f.getCalls.every(call => call.resume === false));
  assert.equal(f.events.filter(event => event === 'stop').length, 1);
  f.sandbox.status = 'stopped';
  await f.runner.stop({ name: f.sandbox.name });
  assert.equal(f.events.filter(event => event === 'stop').length, 1);
  await assert.rejects(f.runner.launch(record()), error => error.status === 409);
});

test('personal Sandbox runs receive only the owner’s key and cannot resume with a shared fallback', async () => {
  const f=fixture(), input=record();
  input.project.ownerId=crypto.randomUUID(); input.project.credentialSource='personal';
  const connection={ownerId:input.project.ownerId, apiKey:'sk-proj-personal-owner-key', model:'personal-model', revision:crypto.randomUUID(), expiresAt:Date.now()+600000};
  await f.runner.create(input,async () => true,connection);
  const command=f.commands.find(item => item.cmd==='node');
  assert.equal(command.env.OPENAI_API_KEY,connection.apiKey); assert.equal(command.env.OPENAI_MODEL,connection.model);
  assert.equal(command.env.OPENAI_PLANNER_MODEL,secrets.OPENAI_PLANNER_MODEL,'Role models are preserved while the account key remains isolated');
  assert.notEqual(command.env.OPENAI_API_KEY,secrets.OPENAI_API_KEY);
  assert.equal(command.env.PERSONAL_KEY_EXPIRES_AT,String(connection.expiresAt));
  assert.ok(!JSON.stringify(input).includes(connection.apiKey));
  await assert.rejects(f.runner.launch(input),error => error.status===409);
  await assert.rejects(f.runner.launch(input,{...connection,ownerId:crypto.randomUUID()}),error => error.status===409);
  await assert.rejects(f.runner.launch(input,{...connection,expiresAt:Date.now()-1}),error => error.status===409);
});

test('personal Sandbox key replacement removes old restored processes before starting a new worker', async () => {
  let calls=0; const f=fixture({fetcher:async () => new Response('{}',{status:++calls===1?503:200})}), input=record();
  input.project.ownerId=crypto.randomUUID(); input.project.credentialSource='personal'; input.execution.name=f.sandbox.name;
  input.execution.credentialRevoked=true; input.execution.credentialRevision='old-revision';
  const connection={ownerId:input.project.ownerId,apiKey:'sk-proj-replacement-personal-key',model:'personal-model',revision:'new-revision',expiresAt:Date.now()+600000};
  await f.runner.launch(input,connection);
  assert.equal(f.commands.length,2); assert.equal(f.commands[0].args[0],'-e');
  assert.ok(f.commands[0].args[1].includes('/.data/projects/'+input.project.id));
  assert.deepEqual(f.commands[1].args,['server/cloud/worker.mjs','launch']);
  assert.equal(f.commands[1].env.OPENAI_API_KEY,connection.apiKey);
});
