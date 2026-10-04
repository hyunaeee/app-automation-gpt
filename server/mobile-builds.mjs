import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildAndroidApk, inspectAndroidToolchain, validateAndroidApk } from './android-builder.mjs';

export const mobileSourceHash = project => crypto.createHash('sha256').update(JSON.stringify(project.files.filter(file=>file.path.startsWith('public/')))).digest('hex');
export async function mobileBuildCapability(env=process.env) {
  if(env.ANDROID_BUILDER_URL && env.ANDROID_BUILDER_TOKEN) return {available:true,mode:'remote'};
  const result=await inspectAndroidToolchain({env}); return {available:result.available,mode:'local',reason:result.reason};
}
export async function buildMobileArtifact(project, directory, {signal,onLog,env=process.env}={}) {
  if(!env.ANDROID_BUILDER_URL) return buildAndroidApk({projectId:project.id,name:project.name,files:project.files.filter(file=>file.path.startsWith('public/')),directory,signal,onLog});
  const endpoint=new URL(env.ANDROID_BUILDER_URL);
  if(endpoint.protocol!=='https:' && !(endpoint.protocol==='http:' && ['localhost','127.0.0.1'].includes(endpoint.hostname))) throw new Error('Android 빌드 서버에는 HTTPS 주소가 필요합니다.');
  if(!env.ANDROID_BUILDER_TOKEN || env.ANDROID_BUILDER_TOKEN.length<32) throw new Error('Android 빌드 서버 토큰을 설정해 주세요.');
  onLog?.('연결된 Android 빌드 서버에서 APK를 컴파일합니다.\n');
  const response=await fetch(new URL('/build',endpoint),{method:'POST',headers:{Authorization:`Bearer ${env.ANDROID_BUILDER_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({projectId:project.id,name:project.name,files:project.files.filter(file=>file.path.startsWith('public/'))}),signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(240000)])});
  if(!response.ok) throw new Error(`Android 빌드 서버가 요청을 완료하지 못했습니다 (HTTP ${response.status}). 빌드 서버 로그를 확인하세요.`);
  const reader=response.body.getReader(); const chunks=[]; let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>40*1024*1024){await reader.cancel();throw new Error('APK 크기 제한을 초과했습니다.');}chunks.push(Buffer.from(value));}
  await fs.mkdir(directory,{recursive:true}); const filename=`launchpad-${project.id.slice(0,8)}-debug.apk`,artifact=path.join(directory,filename);
  await fs.writeFile(artifact,Buffer.concat(chunks)); const result=await validateAndroidApk(artifact);
  if(response.headers.get('x-apk-sha256')!==result.sha256) throw new Error('APK 전송 무결성 검사에 실패했습니다.');
  return {...result,path:artifact,filename,mode:'debug',signatureVerified:false,builtAt:new Date().toISOString()};
}

export function createMobileBuilds({dataDir,onUpdate,build=buildMobileArtifact}={}) {
  const jobs=new Map(); let closed=false; let queue=Promise.resolve();
  const folder=project=>path.join(dataDir,'android',project.id);
  async function publish(project,status){project.android=status;if(onUpdate)await onUpdate(project);await fs.mkdir(folder(project),{recursive:true});await fs.writeFile(path.join(folder(project),'build.json'),JSON.stringify(status));return status;}
  async function status(project){
    let value=project.android;
    if(!value){try{value=JSON.parse(await fs.readFile(path.join(folder(project),'build.json'),'utf8'));}catch{}}
    if(value?.sourceHash && value.sourceHash!==mobileSourceHash(project)) return {status:'idle',logs:[],message:'앱 코드가 변경되었습니다. APK를 다시 빌드해 주세요.'};
    if(value?.status==='building' && !jobs.has(project.id)) return {status:'failed',logs:value.logs||[],message:'서버가 재시작되어 APK 빌드가 중단되었습니다. 다시 빌드해 주세요.'};
    if(value?.status==='ready'){try{await fs.access(path.join(folder(project),value.filename));}catch{return {status:'failed',logs:[],message:'APK 파일이 없습니다. 다시 빌드해 주세요.'};}}
    return value||{status:'idle',logs:[]};
  }
  async function start(project){
    if(closed)throw new Error('서버가 종료 중입니다.');
    if(jobs.has(project.id))return status(project);
    const sourceHash=mobileSourceHash(project),current=await status(project);if(current.status==='ready')return current;
    if(jobs.has(project.id))return status(project);
    const controller=new AbortController(); const logs=[]; const initial={status:'building',sourceHash,logs,startedAt:new Date().toISOString(),message:'Android 빌드 대기 중'};
    let initialized;
    const task=queue.catch(()=>{}).then(async()=>{
      await initialized;
      if(controller.signal.aborted)throw new Error('APK 빌드가 중단되었습니다.');
      const result=await build(project,folder(project),{signal:controller.signal,onLog:line=>{logs.push(line.trim());if(logs.length>30)logs.shift();}});
      const stablePath=path.join(folder(project),result.filename);
      if(path.resolve(result.path)!==path.resolve(stablePath))await fs.copyFile(result.path,stablePath);
      return publish(project,{status:'ready',sourceHash,filename:result.filename,size:result.size,sha256:result.sha256,builtAt:result.builtAt,mode:'debug',signatureVerified:result.signatureVerified,logs:[...logs],message:'설치용 APK가 준비됐어요.'});
    }).catch(async error=>publish(project,{status:'failed',sourceHash,logs:[...logs],message:error.code==='ANDROID_TOOLCHAIN_UNAVAILABLE'?'Android 빌드 도구 또는 외부 빌드 서버를 연결해 주세요.':error.message.slice(0,1800)})).finally(()=>jobs.delete(project.id));
    jobs.set(project.id,{task,controller});queue=task;
    initialized=publish(project,initial);await initialized;return initial;
  }
  return {status,start,async artifact(project){const state=await status(project);if(state.status!=='ready')throw Object.assign(new Error('APK 빌드를 먼저 완료해 주세요.'),{status:409});const file=path.join(folder(project),state.filename);const checked=await validateAndroidApk(file);if(checked.sha256!==state.sha256)throw new Error('APK 무결성 검사에 실패했습니다.');return {path:file,...state};},async shutdown(){closed=true;for(const job of jobs.values())job.controller.abort();await Promise.allSettled([...jobs.values()].map(job=>job.task));}};
}
