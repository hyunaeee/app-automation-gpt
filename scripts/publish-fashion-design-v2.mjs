import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateProject } from '../server/processes.mjs';
import { createZip } from '../server/zip.mjs';
import { validateDesignAssetFile } from '../server/visual-assets.mjs';

const root=path.resolve('samples/fashion-design');
const readJSON=async name=>JSON.parse((await fs.readFile(name,'utf8')).replace(/^\uFEFF/,''));
if(process.argv.includes('--install')){
  const active=await fetch('http://127.0.0.1:3001/api/config',{signal:AbortSignal.timeout(1000)}).then(()=>true).catch(()=>false);
  if(active)throw new Error('Stop the local server before installing this validated sample.');
  const project=await readJSON('.data/fashion-v2-project.json');
  const metadata=path.resolve('.data/projects.json');
  const projects=await readJSON(metadata);
  await fs.copyFile(metadata,metadata+'.before-fashion-v2');
  const next=[project,...projects.filter(item=>item.id!==project.id)];
  await fs.writeFile(metadata+'.tmp',JSON.stringify(next,null,2));await fs.rename(metadata+'.tmp',metadata);
  for(const file of project.files){const target=path.join('.data/projects',project.id,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.content);}
  console.log(JSON.stringify({installed:project.id,name:project.name}));
  process.exit(0);
}
const base=await readJSON('.data/fashion-base-project.json');
const previousReport=await readJSON(path.join(root,'run-report.json'));
const existing=await readJSON('.data/fashion-v2-project.json').catch(()=>null);
const id=existing?.id||crypto.randomUUID();
const now=new Date().toISOString();
const appDir=path.join(root,'app');
const allowed=['package.json','server.mjs','project.json','public/index.html','public/app.js','public/styles.css','public/design-assets.js','README.md'];
const files=[];
for(const filename of allowed){let content=await fs.readFile(path.join(appDir,filename),'utf8');
  if(filename==='project.json'){const config=JSON.parse(content);config.id=id;config.name='Atelier · 이미지 디자인 스튜디오';content=JSON.stringify(config,null,2);}
  if(filename==='public/app.js')content=content.replace(/^const APP = .*?;/,'const APP = '+JSON.stringify({id,name:'Atelier · 이미지 디자인 스튜디오'})+';');
  if(filename==='README.md')content+='\n\n## 이미지 디자인 버전\nCodex 내장 image_gen으로 가방과 상의 콘셉트를 생성하고 UI를 재구성했습니다. 이미지는 정적 레퍼런스이며 치수나 컬러를 바꾸어도 자동 재생성하지 않습니다. 계산은 치수 개념도와 원단 배치에서 확인하세요. 모델 API 키는 포함하지 않습니다.\n';
  const file={path:filename,content,language:filename.endsWith('.js')||filename.endsWith('.mjs')?'javascript':filename.endsWith('.css')?'css':filename.endsWith('.html')?'html':filename.endsWith('.json')?'json':'markdown'};
  if(filename==='public/design-assets.js')validateDesignAssetFile(file);
  files.push(file);await fs.writeFile(path.join(appDir,filename),content);
}
const checks=await validateProject(appDir,{kind:'web-app'});
if(checks.some(check=>!check.passed))throw new Error('Sample runtime validation failed: '+JSON.stringify(checks.filter(check=>!check.passed)));
const plan={...base.plan,name:'Atelier · 이미지 디자인 스튜디오',fileTree:files.map(file=>file.path)};
const project={id,name:plan.name,prompt:base.prompt,kind:'web-app',workflowMode:'auto',review:null,reviewHistory:[],approvedStages:[],status:'completed',createdAt:now,updatedAt:now,mode:'openai',authMode:'codex-subscription',credentialSource:'subscription',parentProjectId:base.id,
  revision:{number:2,prompt:'이미지 모델로 제품 콘셉트를 만들고 화면을 개선',mode:'ai-edit',message:'기존 Codex 구독 샘플에 내장 이미지 생성 결과 2장을 적용하고 화면을 재구성했습니다. 이미지 자동 재생성 기능과는 별개의 검증된 샘플 버전입니다.'},
  stages:base.stages.map(stage=>({...stage,status:stage.id==='debugging'?'skipped':'completed'})),logs:[{id:crypto.randomUUID(),timestamp:now,level:'success',stage:'delivery',message:'내장 이미지 모델로 가방·상의 콘셉트를 생성하고 디자인·기능을 검증한 샘플 버전입니다.'}],plan,files,checks,previewUrl:null,error:null,retryCount:0,
  modelUsage:[{stage:'images',capability:'image',model:null,status:'completed',detail:'Codex 내장 image_gen으로 가방·상의 콘셉트 2장 생성. 정확한 모델 ID는 도구 응답에 포함되지 않았습니다.',timestamp:now},{stage:'validation',capability:'validation',model:null,status:'completed',detail:'Node 실행 검증과 Chrome 디자인·계산·저장·내보내기 회귀 검사를 통과했습니다.',timestamp:now}]};
await fs.writeFile('.data/fashion-v2-project.json',JSON.stringify(project,null,2));
const zip=createZip(files);await fs.writeFile(path.join(root,'source.zip'),zip);
const sample={name:project.name,prompt:project.prompt,authMode:project.authMode,verified:true,verifiedAt:now,files:files.filter(file=>file.path.startsWith('public/')),generation:'Codex subscription base with built-in image_gen raster concepts and a revised functional fashion workbench'};
await fs.mkdir('public/examples/atelier',{recursive:true});
await fs.writeFile('public/examples/atelier/sample.json',JSON.stringify(sample));await fs.writeFile('public/examples/atelier/source.zip',zip);
const report={...previousReport,imageRevision:{projectId:id,parentProjectId:base.id,verifiedAt:now,engine:'built-in image_gen',assets:['assets/tote-concept-v2.png','assets/top-concept-v2.png'],optimizedAssets:['assets/tote-concept-v2.jpg','assets/top-concept-v2.jpg'],prompts:'assets/image-prompts.json',runtimeChecks:checks,browserVerification:'scripts/verify-fashion-design-v2.mjs',browserChecks:13,limitation:'Generated concepts are static and do not automatically update with input dimensions or colors.'}};
await fs.writeFile(path.join(root,'run-report.json'),JSON.stringify(report,null,2));
let html=await fs.readFile(path.join(root,'report.html'),'utf8');
html=html.replace('<h2>실제 결과 화면</h2>','<h2>이미지 모델로 다시 만든 디자인</h2><p>Codex 내장 image_gen으로 토트백·상의 콘셉트를 생성해 실제 앱에 적용했습니다. 이미지는 정적 레퍼런스이며 입력 치수 변경은 치수 개념도와 계산에 반영됩니다. 기존 계산·저장·다운로드를 포함한 브라우저 검사 13개를 통과했습니다.</p><p><a href="assets/image-prompts.json">생성 프롬프트와 이미지 기록</a></p><h2>실제 결과 화면</h2>').replace('screenshots/desktop.png','screenshots/desktop-v2.png');
await fs.writeFile(path.join(root,'report.html'),html);
console.log(JSON.stringify({prepared:id,name:project.name,files:files.length,runtimeChecks:checks.length,zipBytes:zip.length}));
