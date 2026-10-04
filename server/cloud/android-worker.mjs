import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as blob from '@vercel/blob';
import { createBlobStore, isProjectId } from './store.mjs';
import { buildMobileArtifact, mobileSourceHash } from '../mobile-builds.mjs';

export async function prepareCloudAndroid(store,id,{automatic=false,runId}={}) {
  const jobId=crypto.randomUUID();
  const record=await store.update(id,current=>{
    if(automatic && (current.execution.runId!==runId || current.project.status!=='completed' || ['building','ready'].includes(current.project.android?.status)))return null;
    if(current.project.kind!=='mobile-app'||current.project.status!=='completed')throw Object.assign(new Error('완성된 모바일 앱이 필요합니다.'),{status:409});
    if(current.project.android?.status==='building' && Date.now()-Date.parse(current.project.android.startedAt)<300000)throw Object.assign(new Error('APK를 빌드 중입니다.'),{status:409});
    current.execution.androidJobId=jobId;
    current.project.android={status:'building',startedAt:new Date().toISOString(),sourceHash:mobileSourceHash(current.project),logs:[],message:'Android 빌드 시작 중'};
    return current;
  });
  return automatic && record?.execution.androidJobId!==jobId ? null : record;
}

// APK packaging is optional after successful generation. A packaging failure
// must never escape into the generation worker's failure/shutdown handler.
export async function autoBuildCloudAndroid(store,id,runId,{run=runCloudAndroid}={}) {
  let job;
  try {
    job=await prepareCloudAndroid(store,id,{automatic:true,runId});
    if(!job)return;
    await run(store,id,job.execution.androidJobId);
  } catch {
    await store.update(id,current=>{
      if(current.execution.runId!==runId || current.project.status!=='completed' || current.project.android?.status==='ready')return null;
      if(job ? current.execution.androidJobId!==job.execution.androidJobId : current.project.android?.status==='building')return null;
      current.project.android={status:'failed',logs:[],message:'APK 자동 빌드를 시작하지 못했습니다. 앱과 소스는 사용할 수 있으며 APK 빌드를 다시 시도할 수 있습니다.'};
      return current;
    }).catch(()=>{});
  }
}

const ownsBuild=(record,jobId,sourceHash)=>record?.execution.androidJobId===jobId && record.project.status==='completed' && record.project.android?.status==='building' && record.project.android.sourceHash===sourceHash && mobileSourceHash(record.project)===sourceHash;
export async function runCloudAndroid(store,id,jobId,{env=process.env,builder=buildMobileArtifact,blobs=blob}={}) {
  const found=await store.read(id);if(!found||found.value.execution.androidJobId!==jobId)return;
  const project=found.value.project,sourceHash=mobileSourceHash(project),logs=[];
  if(!ownsBuild(found.value,jobId,sourceHash))return;
  const pathname=`launchpad/v1/android/${id}/${jobId}.apk`;
  let uploaded=false;
  const cleanup=async()=>{if(uploaded)await blobs.del(pathname,{token:env.BLOB_READ_WRITE_TOKEN});};
  try{
    const artifact=await builder(project,path.join('/tmp/launchpad-android',id),{env,onLog:line=>{logs.push(line.trim());if(logs.length>30)logs.shift();}});
    const contents=await fs.readFile(artifact.path);
    if(!ownsBuild((await store.read(id))?.value,jobId,sourceHash))return;
    await blobs.put(pathname,contents,{token:env.BLOB_READ_WRITE_TOKEN,access:'private',addRandomSuffix:false,contentType:'application/vnd.android.package-archive'});uploaded=true;
    const committed=await store.update(id,current=>{if(!ownsBuild(current,jobId,sourceHash))return null;current.execution.androidArtifact=pathname;current.project.android={status:'ready',sourceHash,filename:artifact.filename,size:artifact.size,sha256:artifact.sha256,mode:'debug',builtAt:artifact.builtAt,logs,message:'설치용 APK가 준비됐어요.'};return current;});
    if(committed?.execution.androidArtifact!==pathname || committed.project.android?.status!=='ready')await cleanup();
  }catch(error){
    // An uncertain storage failure may have committed successfully. Check the
    // reference before deleting an uploaded artifact that a user can download.
    const current=await store.read(id).catch(()=>null);
    if(uploaded && current && !(current.value.execution.androidArtifact===pathname && current.value.project.android?.status==='ready'))await cleanup().catch(()=>{});
    await store.update(id,current=>{if(!ownsBuild(current,jobId,sourceHash))return null;current.project.android={status:'failed',sourceHash,logs,message:error.code==='ANDROID_TOOLCHAIN_UNAVAILABLE'?'Android 빌드 서버를 연결해 주세요. 배포 설정에서 ANDROID_BUILDER_URL과 토큰이 필요합니다.':error.message.slice(0,1800)};return current;});
  }
}

if(process.argv[1]?.replaceAll('\\','/').endsWith('/cloud/android-worker.mjs')){
  const id=process.env.LAUNCHPAD_RECORD_ID,jobId=process.env.LAUNCHPAD_ANDROID_JOB_ID;
  if(!isProjectId(id)||!jobId)throw new Error('Android job identity required');
  await runCloudAndroid(createBlobStore(),id,jobId);
}
