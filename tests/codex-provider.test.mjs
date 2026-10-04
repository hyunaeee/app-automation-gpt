import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter, once } from 'node:events';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createCodexRequest, codexProvider } from '../server/codex-provider.mjs';
import { createApp } from '../server/app.mjs';
import { createCloudHandler } from '../server/cloud/handler.mjs';
import { localPlan } from '../server/templates.mjs';
import { estimateProject } from '../server/estimate.mjs';

function mockRunner(result, login='Logged in using ChatGPT', exit=0) {
  const calls=[];
  return {calls,async runner(executable,args,options){
    calls.push({executable,args:[...args],...options});
    if(options.signal.aborted)throw options.signal.reason;
    if(args[0]==='login')return {code:0,text:login};
    if(exit)return {code:exit,text:'private-upstream-secret'};
    await fs.writeFile(args[args.indexOf('-o')+1],typeof result==='string'?result:JSON.stringify(result));
    return {code:0,text:'private progress output that must stay off public DTOs'};
  }};
}

test('Codex uses ChatGPT login, stdin, an isolated directory and schema output without API keys or a default-model override',async()=>{
  const mock=mockRunner({message:'완료'}),schema={type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false};
  const request=createCodexRequest({runner:mock.runner,executable:'C:/Program Files/Codex/codex.exe',env:{Path:'system-path',CODEX_HOME:'existing-auth-directory',OPENAI_API_KEY:'sk-secret',CODEX_API_KEY:'secret',BLOB_READ_WRITE_TOKEN:'private-blob'}});
  assert.deepEqual(await request('Trusted instructions','untrusted user idea',undefined,schema),{message:'완료'});
  assert.equal(mock.calls.length,2);const call=mock.calls[1];
  assert.deepEqual(mock.calls[0].args,['login','status']);assert.equal(call.executable,'C:/Program Files/Codex/codex.exe');
  assert.equal(call.args.includes('--model'),false);assert.equal(call.args.at(-1),'-');assert.match(call.input,/Trusted instructions[\s\S]*untrusted user idea/);
  assert.ok(call.args.includes('--ignore-user-config'));assert.ok(call.args.includes('--ephemeral'));assert.equal(call.args[call.args.indexOf('--sandbox')+1],'read-only');
  assert.equal(call.env.CODEX_HOME,'existing-auth-directory');assert.equal(call.env.OPENAI_API_KEY,undefined);assert.equal(call.env.CODEX_API_KEY,undefined);assert.equal(call.env.BLOB_READ_WRITE_TOKEN,undefined);
  assert.ok(call.args.includes('shell_tool'));assert.ok(call.args.includes('plugins'));assert.ok(call.args.includes('web_search="disabled"'));
  assert.ok(path.basename(call.cwd).startsWith('launchpad-codex-'));await assert.rejects(fs.stat(call.cwd),{code:'ENOENT'});
});

test('Codex adapter reuses planner validation and honors only an explicitly configured model',async()=>{
  const mock=mockRunner(localPlan('독서 기록을 분석하고 정리하는 에이전트','ai-agent'));
  const provider=codexProvider({runner:mock.runner,model:'explicit-codex-model'});
  const plan=await provider.plan({prompt:'독서 기록을 분석하고 정리하는 에이전트',kind:'ai-agent',agentDelivery:'web',signal:new AbortController().signal});
  assert.ok(plan.name);assert.equal(mock.calls[1].args[mock.calls[1].args.indexOf('--model')+1],'explicit-codex-model');
});

test('API-key or missing Codex login cannot silently consume paid API credits',async()=>{
  for(const login of ['Logged in using an API key','Not logged in']) {
    const mock=mockRunner({},login),request=createCodexRequest({runner:mock.runner});
    await assert.rejects(request('instructions','idea',undefined,{}),/ChatGPT 로그인/);
    assert.equal(mock.calls.length,1);await assert.rejects(fs.stat(mock.calls[0].cwd),{code:'ENOENT'});
  }
});

test('Codex failures and malformed output stay actionable without exposing process output',async()=>{
  for(const mock of [mockRunner({},'Logged in using ChatGPT',1),mockRunner('not JSON private-upstream-secret')]) {
    await assert.rejects(createCodexRequest({runner:mock.runner})('instructions','idea',undefined,{}),error=>{
      assert.doesNotMatch(error.message,/private-upstream-secret/);assert.match(error.message,/Codex/);return true;
    });
  }
});

test('Codex cancellation propagates to its process runner and cleans the isolated directory',async()=>{
  const controller=new AbortController();let cwd,started;const entered=new Promise(resolve=>{started=resolve;});
  const request=createCodexRequest({runner:async(_executable,_args,options)=>{cwd=options.cwd;started();return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}});
  const running=request('instructions','idea',controller.signal,{});await entered;controller.abort();
  await assert.rejects(running,/취소/);await assert.rejects(fs.stat(cwd),{code:'ENOENT'});
});

function mockCliProcess(t, { ignoreTerm = false } = {}) {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const kills = [];
  let cwd;
  const spawnMock = t.mock.method(childProcess, 'spawn', (_executable, _args, options) => {
    cwd = options.cwd;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = (signal = 'SIGTERM') => {
      kills.push(signal);
      if (!ignoreTerm || signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null));
      return true;
    };
    started();
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); });
  return { entered, kills, cwd: () => cwd };
}

test('Codex process cancellation escalates to SIGKILL when graceful termination is ignored', { timeout: 6000 }, async t => {
  const mock = mockCliProcess(t, { ignoreTerm: true }), controller = new AbortController();
  const running = createCodexRequest()('instructions', 'idea', controller.signal, {});
  const rejected = assert.rejects(running, /취소/);
  await mock.entered;
  controller.abort();
  await rejected;
  assert.deepEqual(mock.kills, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(fs.stat(mock.cwd()), { code: 'ENOENT' });
});

test('Codex process timeout terminates the child and clears force-kill work after close', { timeout: 6000 }, async t => {
  const mock = mockCliProcess(t);
  await assert.rejects(createCodexRequest({ timeoutMs: 1000 })('instructions', 'idea', undefined, {}), /시간이 초과/);
  assert.deepEqual(mock.kills, ['SIGTERM']);
  await assert.rejects(fs.stat(mock.cwd()), { code: 'ENOENT' });
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.deepEqual(mock.kills, ['SIGTERM'], 'a closed child must not receive the delayed force kill');
});

test('local config identifies Codex subscription while Vercel refuses local subscription credentials',async t=>{
  const dataDir=await fs.mkdtemp(path.join(tmpdir(),'launchpad-codex-config-'));
  const engine=await createApp({dataDir,providerName:'codex',apiKey:'must-not-be-used',provider:{},googleAuth:{configured:false,owner:()=>null}});
  const server=engine.app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await engine.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,config=await(await fetch(base+'/api/config')).json();
  assert.equal(config.provider,'openai');assert.equal(config.credentialSource,'subscription');assert.equal(config.authMode,'codex-subscription');assert.equal(config.model,'codex-default');
  const estimate=await(await fetch(base+'/api/estimate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'구독으로 만드는 작업 관리 앱',kind:'web-app'})})).json();
  assert.equal(estimate.provider,'codex');assert.equal(estimate.cost.status,'unpriced');assert.equal(estimate.cost.max,null);
  assert.throws(()=>createCloudHandler({env:{AI_PROVIDER:'codex'}}),/로컬 컴퓨터/);
  assert.throws(()=>createCloudHandler({env:{AI_PROVIDER:'gemini'}}),/제공자 설정/);
});

test('Codex subscription estimates do not price subscription usage using API token rates',()=>{
  const value=estimateProject({prompt:'작업 내용을 정리하는 에이전트 만들기',kind:'ai-agent',agentDelivery:'mcp',provider:'codex',model:null},{rates:{'codex/null':{inputUsdPerMillion:1,outputUsdPerMillion:2}}});
  assert.equal(value.cost.status,'unpriced');assert.equal(value.cost.min,null);assert.equal(value.agentDelivery,'mcp');assert.ok(value.assumptions.some(text=>text.includes('별도의 OpenAI API 키')));
});

test('Codex task roles adjust supported reasoning while preserving the CLI default and honest usage metadata',async()=>{
  const mock=mockRunner({ok:true}),events=[];
  const request=createCodexRequest({runner:mock.runner,model:''});
  await request('instructions','idea',undefined,{},'repair',{role:'debugger',stage:'debugging',capability:'debugging',onModelUsed:event=>events.push(event)});
  assert.equal(mock.calls[1].args.includes('--model'),false);assert.ok(mock.calls[1].args.includes('model_reasoning_effort="high"'));
  assert.equal(events[0].model,null);assert.equal(events[0].capability,'debugging');assert.equal(events[0].status,'completed');assert.match(events[0].detail,/CLI 기본 모델/);
});

test('Codex capabilities never claim an API image model or generate images with subscription credentials',async()=>{
  const mock=mockRunner({ok:true}),provider=codexProvider({runner:mock.runner,model:'explicit-codex-model'}),events=[];
  const capabilities=await provider.capabilities();assert.equal(capabilities.source,'subscription');assert.equal(capabilities.hasImage,false);assert.equal(capabilities.roles.image,null);assert.equal(capabilities.roles.coder,'explicit-codex-model');
  const image=await provider.image({needed:true,prompt:'가방 제품 이미지를 만들어줘',onModelUsed:event=>events.push(event)});
  assert.equal(image.status,'skipped');assert.equal(events[0].status,'skipped');assert.equal(mock.calls.length,0);
});
