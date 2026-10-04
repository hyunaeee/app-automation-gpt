import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('samples/fashion-design');
const report=JSON.parse(await fs.readFile(path.join(root,'run-report.json'),'utf8'));
if(!report.browserChecks?.length||report.browserChecks.some(check=>!check.passed))throw new Error('All sample browser checks must pass before publishing the sample.');
const project=await(await fetch('http://127.0.0.1:3001/api/projects/'+report.finalRun.projectId)).json();
if(project.status!=='completed')throw new Error('Completed project required.');
const appDir=path.join(root,'app');
const allowed=new Set(['package.json','server.mjs','project.json','public/index.html','public/app.js','public/styles.css','README.md']);
for(const file of project.files){if(!allowed.has(file.path))throw new Error('Unexpected sample file');const target=path.join(appDir,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,file.content);}
const response=await fetch('http://127.0.0.1:3001/api/projects/'+project.id+'/download');
if(!response.ok)throw new Error('Source download failed.');
const zip=Buffer.from(await response.arrayBuffer());
await fs.writeFile(path.join(root,'source.zip'),zip);
const sample={name:project.name,prompt:project.prompt,authMode:report.finalRun.authMode,verified:true,verifiedAt:report.verifiedAt,files:project.files.filter(file=>file.path.startsWith('public/')),generation:'Trusted functionality with Codex subscription planning and CSS design refinement'};
for(const location of ['public/examples/atelier','dist/examples/atelier']){await fs.mkdir(location,{recursive:true});await fs.writeFile(path.join(location,'sample.json'),JSON.stringify(sample));await fs.writeFile(path.join(location,'source.zip'),zip);}
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const html=`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>패션 제작 앱 검증 기록</title><style>body{font:16px/1.8 system-ui,sans-serif;background:#f4f5ec;color:#203831;margin:0}main{max-width:1000px;margin:60px auto;padding:0 24px}h1{font-size:38px;line-height:1.4}h2{font-size:22px;margin-top:40px}p{max-width:850px}a{color:#355e47}table{border-collapse:collapse;width:100%;background:#fffef8}td,th{padding:13px;text-align:left;border-bottom:1px solid #d9decf}img{max-width:100%;border:1px solid #d9decf;border-radius:12px}blockquote{border-left:3px solid #9aaf6b;margin:25px 0;padding:12px 24px}small{color:#667460}</style><main><small>LAUNCHPAD · 실제 실행과 검증 기록</small><h1>${esc(project.name)}</h1><blockquote>${esc(project.prompt)}</blockquote><p>ChatGPT로 로그인한 로컬 Codex 구독을 사용해 기획과 디자인 코드를 생성했습니다. 치수·원단 배치·비용 계산과 조작 기능은 검증된 패션 템플릿을 사용합니다.</p><p><a href="source.zip" download>실행 가능한 소스 다운로드</a> · <a href="sample-brief.json" download>검증 중 내보낸 제작 브리프</a> · <a href="sample-concept.svg">치수 개념도</a> · <a href="run-report.json">전체 검증 기록</a></p><h2>발견한 문제와 개선</h2><p>처음에는 일반 작업 관리 앱이 생성되어 핵심 요구사항을 놓쳤습니다. 패션 기능을 추가한 뒤 구독 생성에서 긴 전체 코드 작성이 5분 제한에 걸렸습니다. 계산 코드를 보존하고 AI가 디자인 변경만 작성하도록 범위를 줄인 후 다시 생성했습니다.</p><h2>브라우저 검증</h2><table><tr><th>검사</th><th>결과</th></tr>${report.browserChecks.map(check=>`<tr><td>${esc(check.name)}</td><td>${check.passed?'통과':'실패'}</td></tr>`).join('')}</table><h2>사용 범위</h2><p>${report.limitations.map(esc).join(' · ')}. 기본 치수·시접·손실률·단가·공임은 사용자가 검토하는 가정입니다. 업체 찾기는 검색 연결이며 자동 발주·계약 중개를 포함하지 않습니다.</p><h2>실제 결과 화면</h2><img src="screenshots/desktop.png" alt="실제로 생성된 패션 제작 앱 화면"><p><small>검증일 ${esc(report.verifiedAt)}</small></p></main></html>`;
await fs.writeFile(path.join(root,'report.html'),html);
console.log(JSON.stringify({saved:root,projectId:project.id,verifiedChecks:report.browserChecks.length}));
