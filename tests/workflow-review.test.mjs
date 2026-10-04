import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { localPlan } from '../server/templates.mjs';
import { normalizeWorkflowMode, pauseForReview, applyReviewDecision } from '../server/workflow-review.mjs';

const ownerA = '11111111-1111-8111-8111-111111111111';
const ownerB = '22222222-2222-8222-8222-222222222222';
const prompt = '개인 독서 기록과 읽기 상태를 관리하는 앱';
function auth() {
  const owner = req => req.headers.cookie === 'account=a' ? ownerA : req.headers.cookie === 'account=b' ? ownerB : null;
  return { configured: true, owner, verify: req => owner(req) ? {ownerId:owner(req)} : null,
    status: req => ({enabled:true,authenticated:Boolean(owner(req)),user:null}), start(){},callback(){},logout(){} };
}
function fakeProvider() {
  const plans = [], coding = [];
  return { plans, coding, async plan(input) { plans.push(input); return {...localPlan(prompt,input.kind,{agentDelivery:input.agentDelivery}),name:`계획 ${plans.length}`}; },
    async code(input) { coding.push(input); return input.files.filter(file=>file.path==='public/styles.css'); } };
}
async function fixture(t, options={}) {
  const dataDir = await mkdtemp(path.join(tmpdir(),'launchpad-review-'));
  const settings = { dataDir, apiKey:'', providerName:'openai', googleAuth:auth(), disableAutoAndroid:true, ...options };
  let engine, server;
  const open = async overrides => {
    engine = await createApp({...settings,...overrides}); server=engine.app.listen(0,'127.0.0.1'); await once(server,'listening');
  };
  const close = async () => { await engine.shutdown(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); };
  await open();
  t.after(async()=>{await close();await rm(dataDir,{recursive:true,force:true});});
  return {get engine(){return engine;},dataDir,async restart(overrides={}){await close();await open(overrides);},
    async request(route,method='GET',body,account='a') {
      const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{'content-type':'application/json',cookie:`account=${account}`},...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:response.status,data:await response.json()};
    },
    async settled(id) {await engine.runProject(id);return structuredClone(engine.store.get(id));},
  };
}
const create = async (f, input={}) => { const result=await f.request('/api/projects','POST',{prompt,kind:'web-app',workflowMode:'guided',...input});assert.equal(result.status,202,JSON.stringify(result.data));return f.settled(result.data.id); };
const review = (f,p,action='approve',feedback) => f.request(`/api/projects/${p.id}/review`,'POST',{reviewId:p.review.id,action,...(feedback===undefined?{}:{feedback})});

test('workflow mode defaults to auto and review helper validates before mutation',()=>{
  assert.equal(normalizeWorkflowMode(), 'auto');
  for(const value of [null,'manual','',1])assert.throws(()=>normalizeWorkflowMode(value),{status:400});
  const project={workflowMode:'guided',status:'running',stages:[{id:'requirements',label:'기획',status:'completed'}],reviewHistory:[],approvedStages:[]};
  assert.equal(pauseForReview(project,'requirements'),true);
  const original=structuredClone(project);assert.equal(pauseForReview(project,'requirements'),true);assert.deepEqual(project,original);
  for(const input of [{reviewId:'stale',action:'approve'},{reviewId:project.review.id,action:'unknown'},{reviewId:project.review.id,action:'revise',feedback:'짧음'},{reviewId:project.review.id,action:'revise',feedback:'x'.repeat(4001)}]){
    assert.throws(()=>applyReviewDecision(project,input));assert.deepEqual(project,original);
  }
  applyReviewDecision(project,{reviewId:project.review.id,action:'approve'});
  assert.equal(project.status,'queued');assert.deepEqual(project.approvedStages,['requirements']);assert.equal(project.review,null);
  assert.equal(pauseForReview(project,'requirements'),false);
});

test('guided mode pauses at three durable checkpoints, rejects duplicate or foreign approval and generates once', {timeout:25000}, async t=>{
  const provider=fakeProvider(),f=await fixture(t,{provider});
  let project=await create(f), first=structuredClone(project);
  assert.equal(project.status,'awaiting_approval');assert.equal(project.review.stage,'requirements');assert.equal(project.files.length,0);
  assert.equal((await f.request(`/api/projects/${project.id}/review`,'POST',{reviewId:project.review.id,action:'approve'},'b')).status,404);
  assert.equal((await review(f,project)).status,202);
  assert.equal((await review(f,first)).status,409);
  project=await f.settled(project.id);assert.equal(project.review.stage,'features');assert.equal(project.files.length,0);
  assert.equal(project.stages.find(stage=>stage.id==='requirements').startedAt,first.stages[0].startedAt);
  assert.equal((await review(f,project)).status,202);
  project=await f.settled(project.id);assert.equal(project.review.stage,'architecture');assert.equal(project.files.length,0);
  assert.ok(project.plan.fileTree.includes('server.mjs'));
  assert.equal((await review(f,project)).status,202);
  project=await f.settled(project.id);assert.equal(project.status,'completed',project.error);
  assert.equal(provider.plans.length,1);assert.equal(provider.coding.length,1);
  assert.equal(project.review,null);assert.deepEqual(project.approvedStages,['requirements','features','architecture']);
  assert.deepEqual(project.reviewHistory.map(({stage,action})=>[stage,action]),[['requirements','approve'],['features','approve'],['architecture','approve']]);
  const child=await f.request(`/api/projects/${project.id}/revise`,'POST',{prompt:'화면을 더 밝게 해줘',workflowMode:'auto'});
  assert.equal(child.status,202);const revised=await f.settled(child.data.id);
  assert.equal(revised.workflowMode,'guided');assert.equal(revised.review.stage,'requirements');assert.deepEqual(revised.approvedStages,[]);
});

test('AI review feedback replans from the original idea and previous plan and invalidates all earlier approvals',async t=>{
  const provider=fakeProvider(),f=await fixture(t,{provider});
  const first=await create(f);await review(f,first);const second=await f.settled(first.id);
  const feedback='독서 목표와 월별 진행률 기능을 강조해 주세요';
  assert.equal((await review(f,second,'revise',feedback)).status,202);
  const revised=await f.settled(first.id);
  assert.equal(revised.review.stage,'requirements');assert.notEqual(revised.review.id,first.review.id);
  assert.deepEqual(revised.approvedStages,[]);assert.equal(revised.stages.find(stage=>stage.id==='features').status,'pending');
  assert.equal(revised.name,'계획 2');assert.equal(revised.files.length,0);assert.equal(provider.coding.length,0);
  const context=JSON.parse(provider.plans[1].prompt);
  assert.equal(context.originalIdea,prompt);assert.equal(context.previousSpecification.name,'계획 1');
  assert.deepEqual(context.reviewFeedback,[{stage:'features',feedback}]);
  assert.equal((await review(f,first)).status,409);assert.equal((await review(f,second)).status,409);
  assert.equal(revised.reviewHistory.at(-1).feedback,feedback);
});

test('concurrent approval requests claim one checkpoint and launch exactly one next stage',async t=>{
  const provider=fakeProvider(),f=await fixture(t,{provider}),project=await create(f);
  const responses=await Promise.all([review(f,project),review(f,project)]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[202,409]);
  const next=await f.settled(project.id);
  assert.equal(next.status,'awaiting_approval');assert.equal(next.review.stage,'features');
  assert.equal(next.reviewHistory.length,1);assert.deepEqual(next.approvedStages,['requirements']);
  assert.equal(next.logs.filter(log=>log.stage==='features'&&log.message.includes('명세를 확정')).length,1);
  assert.equal(provider.plans.length,1);assert.equal(provider.coding.length,0);
});

test('a saved pending review survives restart and resumes without a repeated planner call',async t=>{
  const provider=fakeProvider(),f=await fixture(t,{provider});const project=await create(f);
  const disk=JSON.parse(await readFile(path.join(f.dataDir,'projects.json'),'utf8'));
  assert.equal(disk[0].review.id,project.review.id);
  await f.restart();const reloaded=(await f.request(`/api/projects/${project.id}`)).data;
  assert.equal(reloaded.status,'awaiting_approval');assert.deepEqual(reloaded.review,project.review);
  await f.settled(project.id);assert.equal(provider.plans.length,1);
  assert.equal((await review(f,reloaded)).status,202);
  assert.equal((await f.settled(project.id)).review.stage,'features');assert.equal(provider.plans.length,1);
});

test('local review cannot revise without AI and cancellation/retry resets approval checkpoints',async t=>{
  const f=await fixture(t);const first=await create(f);
  assert.equal((await review(f,first,'revise','기능을 더 단순하게 해줘')).status,409);
  assert.deepEqual(f.engine.store.get(first.id),first);
  await review(f,first);const second=await f.settled(first.id);
  assert.equal((await f.request(`/api/projects/${first.id}/cancel`,'POST',{})).status,200);
  assert.equal(f.engine.store.get(first.id).status,'cancelled');assert.equal(f.engine.store.get(first.id).review,null);
  assert.equal((await f.request(`/api/projects/${first.id}/retry`,'POST',{})).status,202);
  const retried=await f.settled(first.id);assert.equal(retried.review.stage,'requirements');assert.deepEqual(retried.approvedStages,[]);
  assert.equal((await review(f,second)).status,409);
});

test('missing or expired personal credentials leave the exact approval checkpoint unchanged',async t=>{
  const provider=fakeProvider();let connection={source:'personal',provider:'openai',ownerId:ownerA,apiKey:'sk-test',model:'test-model',expiresAt:Date.now()+60000,revision:1};
  const credentialManager={resolve:async()=>connection,readOwner:async()=>connection,owner:req=>auth().owner(req)};
  const f=await fixture(t,{credentialManager,providerFactory:()=>provider});const project=await create(f);
  const saved=connection;connection=null;
  assert.equal((await review(f,project)).status,409);assert.deepEqual(f.engine.store.get(project.id),project);
  connection={...saved,expiresAt:Date.now()-1};
  assert.equal((await review(f,project,'revise','기능 명세를 다시 정리해줘')).status,409);assert.deepEqual(f.engine.store.get(project.id),project);
  assert.equal(provider.plans.length,1);
});

test('trusted imported queued checkpoints resume without planning again; ordinary interrupted queues fail',async t=>{
  const provider=fakeProvider(),f=await fixture(t,{provider});const paused=await create(f);
  const queued=structuredClone(paused);applyReviewDecision(queued,{reviewId:queued.review.id,action:'approve'});
  await f.restart({initialProjects:[queued]});assert.equal(f.engine.store.get(queued.id).status,'failed');
  await f.restart({initialProjects:[queued],resumeIds:[queued.id]});
  const resumed=await f.settled(queued.id);assert.equal(resumed.status,'awaiting_approval');assert.equal(resumed.review.stage,'features');
  assert.deepEqual(resumed.approvedStages,['requirements']);assert.equal(provider.plans.length,1);
});

test('legacy create defaults to auto and invalid workflow modes cannot start a project', {timeout:20000}, async t=>{
  const f=await fixture(t);
  for(const value of [null,'manual',true])assert.equal((await f.request('/api/projects','POST',{prompt,kind:'web-app',workflowMode:value})).status,400);
  assert.equal(f.engine.store.size,0);
  const created=await f.request('/api/projects','POST',{prompt,kind:'web-app'});assert.equal(created.status,202);
  const project=await f.settled(created.data.id);assert.equal(project.workflowMode,'auto');assert.equal(project.status,'completed',project.error);
  assert.equal(project.review,null);assert.deepEqual(project.reviewHistory,[]);
});
