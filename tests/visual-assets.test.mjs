import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDesignAssetFile,validateDesignAssetFile,validateImageDataUrl,attachDesignAssets,inferVisualPlan,DESIGN_ASSET_PATH } from '../server/visual-assets.mjs';
import { createApp } from '../server/app.mjs';
import { localPlan } from '../server/templates.mjs';
import { prepareRevision } from '../server/revisions.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
test('generated raster assets are strictly bounded and contain only trusted renderer code',()=>{
  const asset=createDesignAssetFile({hero:png});
  assert.deepEqual(validateDesignAssetFile(asset),asset);
  for(const value of ['data:image/svg+xml;base64,PHN2Zy8+','https://attacker.invalid/img.png','data:image/png;base64,AAAAAAAAAAAAAAAAAAAA','data:image/png;base64,'+'A'.repeat(5_000_000)])assert.throws(()=>validateImageDataUrl(value));
  assert.throws(()=>validateDesignAssetFile({...asset,content:asset.content+'alert(1)'}));
  assert.throws(()=>createDesignAssetFile({unexpected:png}));
  const files=[{path:'public/index.html',content:'<html><head></head><body><main></main></body></html>'}];
  const connected=attachDesignAssets(files,asset);
  assert.equal(connected[0].content.match(/design-assets.js/g).length,1);
  assert.deepEqual(attachDesignAssets(connected,asset),connected);
});
test('images are requested only for visual tasks and not for ordinary boards or MCP agents',()=>{
  assert.equal(inferVisualPlan({kind:'web-app',prompt:'개인 독서 메모를 기록하는 앱을 만들어줘'}),null);
  assert.equal(inferVisualPlan({kind:'ai-agent',agentDelivery:'mcp',prompt:'이미지를 생성하는 MCP'}),null);
  assert.equal(inferVisualPlan({kind:'web-app',prompt:'가방 디자인 도면과 재료비 계산 앱'}).needed,true);
  assert.equal(inferVisualPlan({kind:'mobile-app',prompt:'제품 사진을 생성하는 앱'}).needed,true);
});
test('workflow calls image provider at the right time, serves the asset and preserves it in revisions',{timeout:20000},async t=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'launchpad-visual-'));
  const calls=[];
  const provider={
    async plan({prompt,kind,onModelUsed}){calls.push('plan');await onModelUsed({stage:'requirements',capability:'planning',model:'test-planner',status:'completed'});return localPlan(prompt,kind);},
    async code({files,onModelUsed}){calls.push('code');await onModelUsed({stage:'coding',capability:'coding',model:'test-coder',status:'completed'});return files.filter(file=>file.path==='public/styles.css');},
    async image({needed,onModelUsed}){assert.equal(needed,true);calls.push('image');await onModelUsed({stage:'images',capability:'image',model:'test-image',status:'completed'});return {status:'completed',dataUrl:png,model:'test-image',mimeType:'image/png'};}
  };
  const engine=await createApp({dataDir,provider,apiKey:'',providerName:'openai',disableAutoAndroid:true});
  t.after(async()=>{await engine.shutdown();await rm(dataDir,{recursive:true,force:true});});
  const project=await engine.createProject({prompt:'가방 디자인 도면과 재료 비용을 계산하는 앱',kind:'web-app',workflowMode:'guided'});
  await engine.runProject(project.id);
  assert.equal(project.status,'awaiting_approval');assert.deepEqual(calls,['plan']);
  // The API's approval guards are covered by workflow-review tests; drive the trusted engine here.
  for(const stage of ['requirements','features','architecture']){
    assert.equal(project.review.stage,stage);project.approvedStages.push(stage);project.review=null;project.status='queued';await engine.runProject(project.id);
  }
  assert.equal(project.status,'completed',project.error);assert.deepEqual(calls,['plan','code','image']);
  const asset=project.files.find(file=>file.path===DESIGN_ASSET_PATH);assert.ok(asset);
  const response=await fetch(new URL('/design-assets.js',project.previewUrl));assert.equal(response.status,200);assert.equal(await response.text(),asset.content);
  assert.deepEqual(project.modelUsage.map(item=>item.capability),['planning','coding','image','validation']);
  assert.equal(prepareRevision(project,'레이아웃을 더 넓게 수정해줘',true).revisionSeed.designAssetFile.content,asset.content);
});
