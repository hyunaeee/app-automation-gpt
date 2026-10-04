import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareCloudAndroid, autoBuildCloudAndroid, runCloudAndroid } from '../server/cloud/android-worker.mjs';
import { createCloudHandler } from '../server/cloud/handler.mjs';

const id='11111111-1111-4111-8111-111111111111',runId='generation-run';
function fixture() {
  let record={project:{id,kind:'mobile-app',status:'completed',previewUrl:'https://preview.example',error:null,files:[{path:'public/index.html',content:'<h1>Offline app</h1>'}]},execution:{runId}};
  const store={
    async read(){return {value:structuredClone(record),etag:'test'};},
    async update(_id,mutate){const next=await mutate(structuredClone(record));if(next)record=next;return structuredClone(record);},
  };
  const uploads=[],deleted=[];
  const blobs={async put(name){uploads.push(name);},async del(name){deleted.push(name);}};
  return {store,blobs,uploads,deleted,get record(){return structuredClone(record);}};
}
async function fakeArtifact(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'launchpad-android-races-')),file=path.join(directory,'test.apk');
  await writeFile(file,'test-only orchestration artifact');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {path:file,filename:'test.apk',size:32,sha256:'test-sha',builtAt:new Date().toISOString()};
}
async function serverFor(t,store) {
  const googleAuth={configured:true,verify:()=>({ownerId:'test-owner'}),owner:()=> 'test-owner'};
  const server=http.createServer(createCloudHandler({store,googleAuth,runner:{},env:{SESSION_SECRET:'s'.repeat(40),BLOB_READ_WRITE_TOKEN:'test-only-token',NODE_ENV:'test'}}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

test('automatic APK work skips existing jobs and never replaces a completed generation with an APK failure',async()=>{
  const f=fixture(),manual=await prepareCloudAndroid(f.store,id);let started=0;
  await autoBuildCloudAndroid(f.store,id,runId,{run:async()=>{started++;}});
  assert.equal(started,0);assert.equal(f.record.execution.androidJobId,manual.execution.androidJobId);
  await f.store.update(id,current=>{current.project.android.status='ready';return current;});
  await autoBuildCloudAndroid(f.store,id,runId,{run:async()=>{started++;}});
  assert.equal(started,0);
  await f.store.update(id,current=>{delete current.project.android;return current;});
  await autoBuildCloudAndroid(f.store,id,'stale-generation',{run:async()=>{started++;}});
  assert.equal(started,0);
  await autoBuildCloudAndroid(f.store,id,runId,{run:async()=>{throw new Error('packaging unavailable');}});
  assert.equal(f.record.project.status,'completed');assert.equal(f.record.project.previewUrl,'https://preview.example');assert.equal(f.record.project.error,null);assert.equal(f.record.project.android.status,'failed');
});

test('automatic APK claim storage failures remain separate from the completed generation',async()=>{
  const f=fixture(),originalUpdate=f.store.update;let attempts=0;
  f.store.update=async(...args)=>{if(attempts++===0)throw Object.assign(new Error('another request won'),{status:409});return originalUpdate(...args);};
  await autoBuildCloudAndroid(f.store,id,runId);
  assert.equal(f.record.project.status,'completed');assert.equal(f.record.project.android.status,'failed');assert.equal(f.record.project.previewUrl,'https://preview.example');
});

test('a build superseded before upload creates no orphan Blob and cannot change the replacement job',async t=>{
  const f=fixture(),artifact=await fakeArtifact(t),job=await prepareCloudAndroid(f.store,id);
  await runCloudAndroid(f.store,id,job.execution.androidJobId,{blobs:f.blobs,builder:async()=>{
    await f.store.update(id,current=>{current.execution.androidJobId='replacement-job';current.project.android.message='replacement-owned';return current;});return artifact;
  }});
  assert.deepEqual(f.uploads,[]);assert.deepEqual(f.deleted,[]);assert.equal(f.record.execution.androidJobId,'replacement-job');assert.equal(f.record.project.android.message,'replacement-owned');
});

test('changed source invalidates an in-flight APK even when the job ID has not changed',async t=>{
  const f=fixture(),artifact=await fakeArtifact(t),job=await prepareCloudAndroid(f.store,id);
  await runCloudAndroid(f.store,id,job.execution.androidJobId,{blobs:f.blobs,builder:async()=>{
    await f.store.update(id,current=>{current.project.files[0].content='<h1>New source</h1>';return current;});return artifact;
  }});
  assert.deepEqual(f.uploads,[]);assert.notEqual(f.record.project.android.status,'ready');
});

test('a build losing its claim during upload deletes its new Blob without replacing the active APK job',async t=>{
  const f=fixture(),artifact=await fakeArtifact(t),job=await prepareCloudAndroid(f.store,id);
  f.blobs.put=async pathname=>{f.uploads.push(pathname);await f.store.update(id,current=>{current.execution.androidJobId='newer-job';current.project.android.message='newer job is still building';return current;});};
  await runCloudAndroid(f.store,id,job.execution.androidJobId,{blobs:f.blobs,builder:async()=>artifact});
  assert.equal(f.uploads.length,1);assert.deepEqual(f.deleted,f.uploads);assert.equal(f.record.execution.androidJobId,'newer-job');assert.equal(f.record.project.android.status,'building');assert.equal(f.record.project.android.message,'newer job is still building');
  assert.equal(f.record.execution.androidArtifact,undefined);
});

test('a timed-out job cannot resurrect as ready even if its old job ID is still present',async t=>{
  const f=fixture(),artifact=await fakeArtifact(t),job=await prepareCloudAndroid(f.store,id);
  f.blobs.put=async pathname=>{f.uploads.push(pathname);await f.store.update(id,current=>{current.project.android={status:'failed',message:'timed out'};return current;});};
  await runCloudAndroid(f.store,id,job.execution.androidJobId,{blobs:f.blobs,builder:async()=>artifact});
  assert.equal(f.record.project.android.status,'failed');assert.equal(f.record.project.android.message,'timed out');assert.deepEqual(f.deleted,f.uploads);assert.equal(f.record.project.status,'completed');
});

test('HTTP APK timeout invalidates the job and a late builder does not upload its artifact',async t=>{
  const f=fixture(),artifact=await fakeArtifact(t),job=await prepareCloudAndroid(f.store,id),base=await serverFor(t,f.store);
  await f.store.update(id,current=>{current.project.android.startedAt=new Date(Date.now()-360000).toISOString();return current;});
  let release,entered;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const running=runCloudAndroid(f.store,id,job.execution.androidJobId,{blobs:f.blobs,builder:async()=>{entered();await gate;return artifact;}});
  await started;
  const response=await fetch(`${base}/api/projects/${id}/android`);assert.equal(response.status,200);assert.equal((await response.json()).status,'failed');
  assert.equal(f.record.execution.androidJobId,undefined);release();await running;
  assert.equal(f.record.project.android.status,'failed');assert.equal(f.record.project.status,'completed');assert.deepEqual(f.uploads,[]);
});

test('an APK still owning its job and source commits successfully and remains downloadable',async t=>{
  const f=fixture(),artifact=await fakeArtifact(t),job=await prepareCloudAndroid(f.store,id);
  await runCloudAndroid(f.store,id,job.execution.androidJobId,{blobs:f.blobs,builder:async()=>artifact});
  assert.equal(f.record.project.android.status,'ready');assert.equal(f.record.execution.androidArtifact,f.uploads[0]);assert.equal(f.record.project.status,'completed');assert.deepEqual(f.deleted,[]);
});
