import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const directory=path.resolve('samples/fashion-design');
const reportPath=path.join(directory,'run-report.json');
const report=JSON.parse(await fs.readFile(reportPath,'utf8'));
const project=await(await fetch('http://127.0.0.1:3001/api/projects/'+report.finalRun.projectId)).json();
if(project.status!=='completed')throw new Error('Project not completed: '+project.status+' '+(project.error||''));
let url=project.previewUrl;
if(!url)url=(await(await fetch('http://127.0.0.1:3001/api/projects/'+project.id+'/launch',{method:'POST'})).json()).url;
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const checks=[];
async function check(name,fn){try{await fn();checks.push({name,passed:true});console.log('PASS '+name);}catch(error){checks.push({name,passed:false,detail:error.message});console.log('FAIL '+name+' '+error.message.slice(0,200));}}
const numeric=async selector=>Number((await page.locator(selector).innerText()).replace(/[^0-9.]/g,''));
await fs.mkdir(path.join(directory,'screenshots'),{recursive:true});
try {
  await page.goto(url);await page.locator('#total-cost').waitFor();
  await page.screenshot({path:path.join(directory,'screenshots/desktop.png'),fullPage:true});
  await check('기본 토트백 비용 83,000원·겉감 0.9m',async()=>{assert.equal(await numeric('#total-cost'),83000);assert.equal(await numeric('#fabric-meters'),0.9);});
  await check('자연어의 명시 치수를 도면에 반영',async()=>{await page.locator('#description').fill('네이비 토트 가방 가로 42cm, 세로 35cm, 깊이 10cm, 손잡이 길이 60cm');await page.locator('#parse-brief').click();assert.equal(await page.locator('[name=width]').inputValue(),'42');assert.equal(await page.locator('[name=height]').inputValue(),'35');assert.match(await page.locator('#drawing-canvas').innerText(),/42 cm/);});
  await check('단가 2배 변경 시 재료비만 정확히 증가',async()=>{await page.locator('#new-project').click();await page.locator('.cost-edit-toggle').click();await page.locator('[name=fabricPrice]').fill('24000');assert.equal(await numeric('#total-cost'),93800);});
  await check('재단 불가능한 폭은 산출·다운로드 차단',async()=>{await page.locator('[name=fabricWidth]').fill('37');assert.match(await page.locator('#drawing-canvas').innerText(),/원단 폭/);assert.equal(await page.locator('#download-brief').isDisabled(),true);assert.equal(await page.locator('#download-svg').isDisabled(),true);});
  await check('프로젝트 저장·새로고침·다시 열기',async()=>{await page.locator('#new-project').click();await page.locator('#project-name').fill('검증한 토트백');await page.locator('[name=width]').fill('40');await page.locator('#save-project').click();await page.reload();await page.locator('#projects-nav').click();await page.locator('[data-load]').filter({hasText:'검증한 토트백'}).click();assert.equal(await page.locator('[name=width]').inputValue(),'40');});
  await check('제작 브리프에 치수·계산·한계를 내보내기',async()=>{const pending=page.waitForEvent('download');await page.locator('#download-brief').click();const download=await pending;const target=path.join(directory,'sample-brief.json');await download.saveAs(target);const brief=JSON.parse(await fs.readFile(target,'utf8'));assert.equal(brief.design.width,40);assert.ok(brief.estimate.total>0);assert.ok(brief.limitations.length>0);});
  await check('실제 SVG 도면 파일 다운로드',async()=>{const pending=page.waitForEvent('download');await page.locator('#download-svg').click();const download=await pending;const target=path.join(directory,'sample-concept.svg');await download.saveAs(target);const svg=await fs.readFile(target,'utf8');assert.ok(svg.startsWith('<svg'));assert.match(svg,/40 cm/);});
  await check('상의 전환과 계산 갱신',async()=>{await page.locator('[data-kind=top]').click();assert.match(await page.locator('#drawing-canvas').innerText(),/몸판|총장/);assert.ok(await numeric('#total-cost')>0);await page.locator('[data-view=layout]').click();assert.ok(await page.locator('#drawing-canvas svg').count());});
  await check('업체 찾기는 검색 연결임을 표시',async()=>{const href=await page.locator('#maker-link').getAttribute('href');assert.ok(href.startsWith('https://search.naver.com/'));assert.match(await page.locator('.maker-card').innerText(),/검색|계약|연결/);});
  await check('저장한 프로젝트 삭제',async()=>{await page.locator('#projects-nav').click();await page.locator('[data-delete]').click();assert.equal(await page.locator('[data-load]').count(),0);await page.keyboard.press('Escape');});
  await page.locator('#new-project').click();
  await page.setViewportSize({width:390,height:844});
  await check('모바일 390px에서 가로 넘침 없음',async()=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));});
  await page.screenshot({path:path.join(directory,'screenshots/mobile.png'),fullPage:true});
  await check('브라우저 JavaScript 오류 없음',async()=>assert.deepEqual(errors,[]));
} finally {
  await browser.close();
  report.finalRun={...report.finalRun,status:project.status,name:project.name,completedAt:project.updatedAt,automaticChecks:project.checks,plan:project.plan};
  report.browserChecks=checks;report.verifiedAt=new Date().toISOString();
  await fs.writeFile(reportPath,JSON.stringify(report,null,2));
}
if(checks.some(c=>!c.passed))process.exitCode=1;
