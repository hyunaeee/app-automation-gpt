import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRouter, routingOptionsFromEnv, subscriptionCapabilities } from '../server/model-router.mjs';
import { openAIProvider } from '../server/provider.mjs';
import { localPlan } from '../server/templates.mjs';

const inventory=(ids,status=200)=>new Response(JSON.stringify({data:ids.map(id=>({id,object:'model'}))}),{status});
const accessible=['gpt-6-astra','gpt-6.1-sol','gpt-6-luna','gpt-4.1-mini','gpt-4.1','gpt-image-2.5-flare','gpt-image-2.5-sunburst'];

test('verified inventory selects efficient planning, balanced coding and supported image models; private cache is isolated',async()=>{
  let calls=0;
  const router=createModelRouter({apiKey:'test-key',env:{},fetchImpl:async(url,init)=>{calls++;assert.equal(url,'https://api.openai.com/v1/models');assert.equal(init.method,'GET');assert.equal(init.headers.Authorization,'Bearer test-key');return inventory([...accessible,'gpt-realtime','arbitrary-unknown']);}});
  const result=await router.resolve();
  assert.deepEqual(result.roles,{planner:'gpt-6-luna',coder:'gpt-6.1-sol',debugger:'gpt-6.1-sol',image:'gpt-image-2.5-flare'});
  assert.equal(result.hasImage,true);assert.equal(result.inventoryStatus,'verified');assert.doesNotMatch(JSON.stringify(result),/test-key|arbitrary-unknown|gpt-realtime/);
  result.roles.coder='tampered';assert.equal((await router.resolve()).roles.coder,'gpt-6.1-sol');assert.equal(calls,1);
  const other=createModelRouter({apiKey:'other-key',env:{},fetchImpl:async()=>inventory(['gpt-4.1-mini'])});
  assert.equal((await other.resolve()).hasImage,false);assert.equal((await other.resolve()).roles.planner,'gpt-4.1-mini');
});

test('explicit base and role models are respected; unavailable explicit text models fail without switching',async()=>{
  const router=createModelRouter({apiKey:'key',model:'gpt-4.1',env:{OPENAI_DEBUGGER_MODEL:'gpt-6-astra',OPENAI_IMAGE_MODEL:'gpt-image-2.5-sunburst'},fetchImpl:async()=>inventory(accessible)});
  assert.deepEqual((await router.resolve()).roles,{planner:'gpt-4.1',coder:'gpt-4.1',debugger:'gpt-6-astra',image:'gpt-image-2.5-sunburst'});
  const denied=createModelRouter({apiKey:'key',env:{OPENAI_CODER_MODEL:'gpt-6-astra'},fetchImpl:async()=>inventory(['gpt-4.1-mini'])});
  await assert.rejects(denied.resolve(),{status:409});
  assert.throws(()=>createModelRouter({apiKey:'key',env:{OPENAI_PLANNER_MODEL:'gpt-image-2.5-flare'}}),{status:400});
  assert.deepEqual(routingOptionsFromEnv({OPENAI_PLANNER_MODEL:'gpt-6-luna'}),{planner:'gpt-6-luna',coder:null,debugger:null,image:null});
});

test('failed discovery never upgrades or retries auth failures and invalid explicit images stay unavailable',async()=>{
  for(const status of [401,403]){
    let calls=0;const router=createModelRouter({apiKey:'do-not-expose',env:{},fetchImpl:async()=>{calls++;return new Response('secret-upstream',{status});}});
    await assert.rejects(router.resolve(),error=>error.status===status&&!/do-not-expose|secret-upstream/.test(error.message));assert.equal(calls,1);
  }
  const fallback=await createModelRouter({apiKey:'key',env:{},fetchImpl:async()=>new Response('down',{status:503})}).resolve();
  assert.equal(fallback.inventoryStatus,'unavailable');assert.deepEqual(fallback.roles,{planner:'gpt-4.1-mini',coder:'gpt-4.1-mini',debugger:'gpt-4.1-mini',image:null});assert.equal(fallback.hasImage,false);
  for(const image of ['invalid-image','gpt-image-2']){
    const result=await createModelRouter({apiKey:'key',env:{OPENAI_IMAGE_MODEL:image},fetchImpl:async()=>inventory(accessible)}).resolve();
    assert.equal(result.hasImage,false);assert.equal(result.roles.image,null);
  }
  let calls=0;const none=await createModelRouter({env:{},fetchImpl:async()=>{calls++;throw Error();}}).resolve();assert.equal(none.hasImage,false);assert.equal(calls,0);
  const controller=new AbortController();controller.abort();await assert.rejects(createModelRouter({apiKey:'key'}).resolve({signal:controller.signal}));
});

test('planner/coder/debugger requests use routed models and report actual model IDs without exposing privileged files',async()=>{
  const calls=[],events=[],plan=localPlan('독서 기록과 상태를 관리하는 앱','web-app');
  const fetchImpl=async(url,init)=>{
    if(url.endsWith('/models'))return inventory(accessible);
    const body=JSON.parse(init.body);calls.push(body);
    const output=body.text.format.name==='project_plan'?plan:{files:[{path:'public/styles.css',content:'body{color:green}'}]};
    return new Response(JSON.stringify({model:body.model+'-snapshot',status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}]}));
  };
  const router=createModelRouter({apiKey:'key',env:{},fetchImpl});
  const provider=openAIProvider({apiKey:'key',router,fetchImpl}),onModelUsed=event=>events.push(event);
  await provider.plan({prompt:'독서 기록과 상태를 관리하는 앱',kind:'web-app',onModelUsed});
  const project={kind:'web-app',prompt:'독서 기록 앱',plan,visualPlan:{needed:true,prompt:'책 표지 일러스트',dataUrl:'private-binary'}},files=[{path:'public/styles.css',content:'body{}'},{path:'public/design-assets.js',content:'private-image-data'}];
  await provider.code({project,files,errors:[],onModelUsed});await provider.code({project,files,errors:[{name:'syntax',detail:'failed'}],onModelUsed});
  assert.deepEqual(calls.map(call=>call.model),['gpt-6-luna','gpt-6.1-sol','gpt-6.1-sol']);
  assert.deepEqual(calls.map(call=>call.reasoning.effort),['medium','medium','high']);
  assert.deepEqual(events.map(event=>[event.stage,event.capability,event.model,event.status]),[['requirements','planning','gpt-6-luna-snapshot','completed'],['coding','coding','gpt-6.1-sol-snapshot','completed'],['debugging','debugging','gpt-6.1-sol-snapshot','completed']]);
  assert.deepEqual(JSON.parse(calls[1].input).visualPlan,{needed:true,prompt:'책 표지 일러스트'});assert.doesNotMatch(calls[1].input,/private-image-data|private-binary/);
  assert.match(calls[1].instructions,/data-launchpad-image/);
});

test('text request auth failure emits failure and does not retry another model',async()=>{
  let calls=0;const events=[];
  const provider=openAIProvider({apiKey:'secret-key',router:{resolve:async()=>({roles:{planner:'gpt-6-luna'}})},fetchImpl:async()=>{calls++;return new Response('secret-upstream',{status:403});}});
  await assert.rejects(provider.plan({prompt:'앱 만들기',kind:'web-app',onModelUsed:event=>events.push(event)}),error=>error.status===403&&!/secret/.test(error.message));
  assert.equal(calls,1);assert.equal(events[0].status,'failed');assert.equal(events[0].model,'gpt-6-luna');
  const subscription=subscriptionCapabilities();assert.equal(subscription.hasImage,false);assert.equal(subscription.roles.planner,null);assert.equal(subscription.source,'subscription');
});
