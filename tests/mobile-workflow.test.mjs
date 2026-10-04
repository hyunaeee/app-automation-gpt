import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { createMobileBuilds } from '../server/mobile-builds.mjs';

test('mobile workflow validates offline source and preserves downloads when an APK builder is unavailable',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'launchpad-mobile-test-'));
  const engine=await createApp({dataDir,apiKey:'',androidBuild:async()=>{throw Object.assign(new Error('SDK missing'),{code:'ANDROID_TOOLCHAIN_UNAVAILABLE'});}});
  const server=engine.app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await engine.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dataDir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(`${base}/api/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'매일 좋은 습관을 기록하고 완료하는 모바일 앱',kind:'mobile-app'})});
  assert.equal(response.status,202);const created=await response.json();
  let project;for(let count=0;count<200;count++){project=await(await fetch(`${base}/api/projects/${created.id}`)).json();if(!['queued','running'].includes(project.status))break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(project.status,'completed',project.error);
  assert.ok(project.checks.length>=5);assert.ok(project.checks.every(check=>check.passed));
  assert.match(project.files.find(file=>file.path==='public/app.js').content,/localStorage/);
  assert.ok(project.plan.assumptions.some(value=>value.includes('오프라인')||value.includes('동기화')));
  let status;for(let count=0;count<100;count++){status=await(await fetch(`${base}/api/projects/${created.id}/android`)).json();if(status.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,25));}
  assert.equal(status.status,'failed');assert.match(status.message,/빌드 도구/);
  assert.equal((await fetch(`${base}/api/projects/${created.id}/android/apk`)).status,409);
  const source=await fetch(`${base}/api/projects/${created.id}/android/source`);assert.equal(source.status,200);
  const archive=Buffer.from(await source.arrayBuffer());assert.equal(archive.readUInt32LE(0),0x04034b50);
  assert.ok(archive.includes(Buffer.from('MainActivity.java')));assert.ok(!archive.includes(Buffer.from('debug.keystore')));
});

test('concurrent APK requests share a job and initial persistence finishes before the compiler starts',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'launchpad-build-queue-'));
  let builds=0,initialPersisted=false;const events=[];
  const manager=createMobileBuilds({dataDir,onUpdate:async project=>{if(project.android.status==='building'){await new Promise(resolve=>setTimeout(resolve,20));initialPersisted=true;}events.push(project.android.status);},build:async()=>{builds++;assert.equal(initialPersisted,true);throw new Error('intentional compiler failure');}});
  t.after(async()=>{await manager.shutdown();await fs.rm(dataDir,{recursive:true,force:true});});
  const project={id:'fa585d76-cac6-4181-b3d8-03a5938fc1d5',files:[{path:'public/index.html',content:'hello'}]};
  await Promise.all([manager.start(project),manager.start(project)]);
  for(let i=0;i<50&&(await manager.status(project)).status==='building';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(builds,1);assert.deepEqual(events,['building','failed']);assert.equal((await manager.status(project)).status,'failed');
});
