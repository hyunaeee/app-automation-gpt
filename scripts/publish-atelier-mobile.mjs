import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../server/processes.mjs';
import { createZip } from '../server/zip.mjs';
import { validateDesignAssetFile } from '../server/visual-assets.mjs';
import { androidSourceFiles, validateAndroidApk } from '../server/android-builder.mjs';
import { mobileSourceHash } from '../server/mobile-builds.mjs';

const workspace=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const root=path.join(workspace,'samples/atelier-mobile');
const publicRoot=path.join(workspace,'public/examples/atelier-mobile');
const snapshot=path.join(workspace,'.data/atelier-mobile-project.json');
const readJSON=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const digest=content=>crypto.createHash('sha256').update(content).digest('hex');
const allowed=['package.json','server.mjs','project.json','public/index.html','public/app.js','public/styles.css','public/design-assets.js','README.md'];
const language=name=>name.endsWith('.js')||name.endsWith('.mjs')?'javascript':name.endsWith('.css')?'css':name.endsWith('.html')?'html':name.endsWith('.json')?'json':'markdown';

if(process.argv.includes('--install')){
  const active=await new Promise(resolve=>{
    const socket=net.connect({host:'127.0.0.1',port:3001});
    const finish=value=>{socket.destroy();resolve(value);};
    socket.setTimeout(1000);socket.once('connect',()=>finish(true));socket.once('timeout',()=>finish(true));socket.once('error',error=>finish(error.code!=='ECONNREFUSED'));
  });
  if(active)throw new Error('Stop the local workspace server before importing the verified sample.');
  const project=await readJSON(snapshot);
  if(!/^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(project.id)||project.android?.filename!=='atelier-mobile.apk')throw new Error('Invalid prepared sample paths.');
  const checked=await validateAndroidApk(path.join(root,'atelier-mobile.apk'));
  if(checked.sha256!==project.android.sha256)throw new Error('APK changed after verification.');
  const metadata=path.join(workspace,'.data/projects.json');
  const projects=await readJSON(metadata);
  if(projects.some(p=>['queued','running'].includes(p.status)))throw new Error('A project run is still active; import after it finishes.');
  await fs.copyFile(metadata,metadata+'.before-atelier-mobile');
  for(const file of project.files){
    if(!allowed.includes(file.path))throw new Error('Unexpected sample path');
    const target=path.join(workspace,'.data/projects',project.id,file.path);
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.content);
  }
  const androidRoot=path.join(workspace,'.data/android',project.id);
  await fs.mkdir(androidRoot,{recursive:true});
  await fs.copyFile(path.join(root,'atelier-mobile.apk'),path.join(androidRoot,project.android.filename));
  const debugKey=`.android-debug-${project.id}.keystore`;
  await fs.copyFile(path.join(workspace,'.data/atelier-mobile-android',project.id,debugKey),path.join(androidRoot,debugKey));
  await fs.writeFile(path.join(androidRoot,'build.json'),JSON.stringify(project.android,null,2));
  const all=[project,...projects.filter(p=>p.id!==project.id)];
  await fs.writeFile(metadata+'.tmp',JSON.stringify(all,null,2));await fs.rename(metadata+'.tmp',metadata);
  console.log(JSON.stringify({installed:project.id,name:project.name,apk:project.android.filename}));
  process.exit(0);
}

const brief=await readJSON(path.join(root,'design/brief.json'));
const imagePrompt=await readJSON(path.join(root,'design/image-prompt.json'));
const {source:_localImageSource,...uiImagePrompt}=imagePrompt;
const totePrompt=await readJSON(path.join(root,'design/tote-image-prompt.json'));
const publicImagePrompt={...uiImagePrompt,supportingAssets:[totePrompt]};
const browser=await readJSON(path.join(root,'browser-report.json'));
const apk=await readJSON(path.join(root,'apk-build-report.json'));
if(!Array.isArray(browser.checks)||!browser.checks.length||browser.checks.some(check=>check.passed!==true))throw new Error('Browser verification is incomplete.');
if(!apk.signatureVerified)throw new Error('A verified APK signature is required.');
const config=await readJSON(path.join(root,'app/project.json'));
if(config.kind!=='mobile-app'||!/^([0-9a-f]{8}-)([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(config.id))throw new Error('Invalid mobile project metadata.');
const files=[];
for(const filename of allowed){
  const content=await fs.readFile(path.join(root,'app',filename),'utf8');
  const file={path:filename,content,language:language(filename)};
  if(filename==='public/design-assets.js')validateDesignAssetFile(file);
  if(filename.startsWith('public/')){
    for(const report of [browser,apk])if(report.sourceFileSha256?.[filename]!==digest(content))throw new Error('Sample changed after verification: '+filename);
  }
  files.push(file);
}
if(apk.projectId!==config.id)throw new Error('APK belongs to another sample.');
const artifact=await validateAndroidApk(path.join(root,'atelier-mobile.apk'));
if(artifact.sha256!==apk.sha256)throw new Error('APK digest mismatch.');
const runtimeChecks=await validateProject(path.join(root,'app'),{kind:'mobile-app'});
if(runtimeChecks.some(check=>!check.passed))throw new Error('Runtime validation failed: '+JSON.stringify(runtimeChecks));
const now=new Date().toISOString();
const emulator=apk.runtimeVerification?.status==='verified'?apk.runtimeVerification:await readJSON(path.join(root,'emulator-report.json')).catch(()=>apk.runtimeVerification||null);
const checks=[...runtimeChecks,...browser.checks,{name:'Android APK 컴파일 및 개발 서명',passed:true,detail:`${artifact.size} bytes · SHA256 ${artifact.sha256}`}];
const plan={name:config.name,summary:'이미지로 먼저 설계한 모바일 화면을 바탕으로 구현한 오프라인 가방·의류 디자인 스튜디오입니다. 치수 편집, 참고 도면, 재료 견적, 기기 내 저장을 제공합니다.',audience:'첫 샘플 제작을 준비하는 개인 디자이너와 소규모 브랜드',features:brief.functionalScope.map(name=>({name,description:name,priority:'core'})),assumptions:brief.limitations,stack:[{name:'HTML / CSS / JavaScript',role:'레퍼런스 기반 모바일 화면과 입력·계산 로직'},{name:'SVG',role:'입력값을 반영하는 참고 치수 도면'},{name:'localStorage',role:'기기에 디자인과 단가 저장'},{name:'Android WebView',role:'오프라인 앱 자산을 포함한 실제 APK'},{name:'Node.js',role:'개발 시 독립 미리보기 서버'}],fileTree:files.map(file=>file.path)};
const stageDefinitions=[['requirements','요구사항 분석','기존 가방·의류 제작 아이디어를 모바일 기능으로 정리했습니다.'],['features','기능 정의','치수·견적·저장·문의 자료를 작동하는 기능으로 구현했습니다.'],['architecture','구조 설계','내장 이미지 모델로 3화면 레퍼런스를 먼저 만들고 색상·타이포·배치를 정했습니다.'],['scaffold','프로젝트 생성','독립 실행 앱과 Android 패키지 구조를 준비했습니다.'],['coding','코드 구현','생성한 UI 레퍼런스를 확인한 뒤 모바일 코드를 작성했습니다.'],['validation','테스트',`${browser.checks.length}개 브라우저 검사와 APK 서명·구조 검증을 통과했습니다.`],['debugging','오류 수정','최종 소스의 문법·실행·화면 검증 결과를 확인했습니다.'],['delivery','결과물 완성','동작하는 앱, 레퍼런스 이미지, 소스 ZIP, 설치용 APK를 보관했습니다.']];
const project={id:config.id,name:config.name,prompt:brief.originalIdea+' 모바일 앱으로 만들고, 앱 디자인 이미지를 먼저 생성한 뒤 그 레퍼런스를 기반으로 구현해 주세요.',kind:'mobile-app',workflowMode:'auto',review:null,reviewHistory:[],approvedStages:[],status:'completed',createdAt:imagePrompt.createdAt,updatedAt:now,mode:'openai',authMode:'codex-subscription',credentialSource:'subscription',stages:stageDefinitions.map(([id,label,detail])=>({id,label,detail,status:'completed'})),logs:stageDefinitions.map(([stage,,message])=>({id:crypto.randomUUID(),stage,message,level:'success',timestamp:now})),plan,files,checks,previewUrl:null,error:null,retryCount:0,modelUsage:[{stage:'architecture',capability:'image',model:null,status:'completed',detail:'Codex 내장 image_gen으로 UI 레퍼런스 1장을 먼저 생성했습니다. 정확한 이미지 모델 ID는 도구 응답에 없습니다.',timestamp:imagePrompt.createdAt},{stage:'coding',capability:'coding',model:null,status:'completed',detail:'이 Codex 작업에서 이미지 레퍼런스를 읽고 구현한 샘플입니다. 앱 서비스의 자동 생성 실행 기록과는 별도입니다.',timestamp:now},{stage:'validation',capability:'validation',model:null,status:'completed',detail:'Chrome 브라우저 기능 검사, Node 실행 검사, Android SDK 컴파일 및 서명 검증',timestamp:now}],android:{status:'ready',filename:'atelier-mobile.apk',sourceHash:mobileSourceHash({files}),size:artifact.size,sha256:artifact.sha256,builtAt:apk.builtAt,mode:'debug',signatureVerified:true,logs:['Android SDK 컴파일 · apksigner 검증 · zipalign 검증 완료'],message:'설치용 APK가 준비됐어요.'}};
const designFiles=[];
for(const filename of ['reference-v1.png','image-prompt.json','brief.json','tote-photo-v1.png','tote-photo-v1.jpg','tote-image-prompt.json'])designFiles.push({path:'design/'+filename,content:filename==='image-prompt.json'?JSON.stringify(publicImagePrompt,null,2):await fs.readFile(path.join(root,'design',filename))});
const zip=createZip([...files,...androidSourceFiles({projectId:project.id,name:project.name,files}),...designFiles]);
const sample={name:project.name,prompt:brief.originalIdea,files:files.filter(file=>file.path.startsWith('public/')),verified:true,verifiedAt:now,authMode:project.authMode,referenceImage:'/examples/atelier-mobile/reference-v1.png',generation:'Built-in image_gen UI reference first, then Codex implementation, browser verification and a real Android debug build.'};
await fs.mkdir(publicRoot,{recursive:true});
await fs.writeFile(path.join(root,'source.zip'),zip);
await fs.writeFile(path.join(publicRoot,'source.zip'),zip);
await fs.writeFile(path.join(publicRoot,'sample.json'),JSON.stringify(sample));
for(const [source,destination]of [['design/reference-v1.png','reference-v1.png'],['atelier-mobile.apk','atelier-mobile.apk']])await fs.copyFile(path.join(root,source),path.join(publicRoot,destination));
await fs.writeFile(path.join(publicRoot,'image-prompt.json'),JSON.stringify(publicImagePrompt,null,2));
project.modelUsage[0].detail+=' 레퍼런스에 맞춘 토트백 제품 사진 1장도 내장 image_gen으로 생성해 연결했습니다.';
await fs.writeFile(snapshot,JSON.stringify(project,null,2));
const report={name:project.name,projectId:project.id,verifiedAt:now,workflow:brief.workflow,reference:'design/reference-v1.png',prompt:'design/image-prompt.json',supportingAssetPrompt:'design/tote-image-prompt.json',runtimeChecks,browser,apk:{projectId:apk.projectId,applicationId:apk.applicationId,sha256:artifact.sha256,size:artifact.size,signatureVerified:true,builtAt:apk.builtAt},emulator,limitations:brief.limitations,sourceFileSha256:browser.sourceFileSha256};
await fs.writeFile(path.join(root,'run-report.json'),JSON.stringify(report,null,2));
const screenGallery='<h2>03 · 실제 앱 화면</h2><div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start">'+['studio','design','estimate'].map(name=>`<a href="screenshots/${name}.png"><img src="screenshots/${name}.png" alt="${name} 실제 모바일 앱 화면"></a>`).join('')+'</div><h2>04 · 검증 결과</h2>';
await fs.writeFile(path.join(root,'report.html'),reportHTML(report).replace('<h2>03 · 검증 결과</h2>',screenGallery));
console.log(JSON.stringify({prepared:project.id,runtimeChecks:runtimeChecks.length,browserChecks:browser.checks.length,apkBytes:artifact.size,zipBytes:zip.length}));

function reportHTML(report){
  const escape=value=>String(value).replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atelier · Mobile case study</title><style>body{margin:0;background:#f8f5ee;color:#292923;font:16px/1.75 system-ui,sans-serif}main{max-width:1040px;margin:64px auto;padding:0 24px}h1{font:clamp(38px,6vw,68px)/1.1 Georgia,serif;letter-spacing:-2px}h2{margin-top:56px;font-size:24px}.kicker{color:#a85438;letter-spacing:3px;font-size:12px}img{width:100%;border-radius:14px}a{color:#a85438}.links{display:flex;gap:20px;flex-wrap:wrap}ol{padding-left:22px}li{margin:12px 0}.subtle{color:#6c6b64;font-size:14px}.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.checks div{border-top:1px solid #dcd7cf;padding:12px 0}code{overflow-wrap:anywhere;font-size:12px}</style><main><p class="kicker">ATELIER / MOBILE BUILD STUDY</p><h1>Design first.<br>Then make it real.</h1><p>이미지로 앱 화면을 먼저 설계하고, 그 레퍼런스를 실제 작동하는 Android 앱으로 옮겼습니다.</p><div class="links"><a href="atelier-mobile.apk" download>Android APK 다운로드</a><a href="source.zip" download>앱 + Android 소스 ZIP</a><a href="design/image-prompt.json">이미지 생성 프롬프트</a><a href="run-report.json">전체 검증 기록</a></div><h2>01 · 먼저 만든 이미지 레퍼런스</h2><img src="design/reference-v1.png" alt="Studio, Design, Estimate 모바일 화면 레퍼런스"><p class="subtle">Codex 내장 image_gen 생성 · ${escape(imagePrompt.createdAt)}</p><h2>02 · 이미지에서 실제 기능으로</h2><ol>${brief.workflow.map(item=>'<li>'+escape(item)+'</li>').join('')}</ol><h2>03 · 검증 결과</h2><div class="checks">${checks.map(check=>'<div>✓ '+escape(check.name)+'</div>').join('')}</div><p>Android 개발 서명 확인 · ${artifact.size.toLocaleString()} bytes</p><p><code>SHA256 ${artifact.sha256}</code></p><h2>샘플의 범위</h2><ul>${brief.limitations.map(item=>'<li>'+escape(item)+'</li>').join('')}</ul><p class="subtle">이 샘플은 Codex 작업에서 제작·검증했습니다. 앱 서비스의 모든 향후 생성에 이미지 레퍼런스 단계가 자동 적용되었다는 의미는 아닙니다.</p></main></html>`;
}
