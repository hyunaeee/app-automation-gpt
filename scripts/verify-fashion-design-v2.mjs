import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const directory=path.resolve('samples/fashion-design');
const url=process.env.FASHION_V2_PREVIEW_URL||'http://127.0.0.1:3004/';
const screenshots=path.join(directory,'screenshots');
await fs.mkdir(screenshots,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
const errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const numeric=async selector=>Number((await page.locator(selector).innerText()).replace(/[^0-9.]/g,''));
const check=async(name,action)=>{try{await action();checks.push({name,passed:true});console.log('PASS '+name);}catch(error){checks.push({name,passed:false,detail:error.message.slice(0,300)});console.log('FAIL '+name+' '+error.message.slice(0,300));}};
try{
  await page.goto(url);
  await page.locator('#total-cost').waitFor();
  await check('실제 AI 제품 이미지가 기본 화면에 로드됨',async()=>{
    await expect(page.locator('#design-image')).toBeVisible();
    await page.locator('#design-image').evaluate(image=>image.decode());
    assert.ok(await page.locator('#design-image').evaluate(image=>image.naturalWidth>500&&image.naturalHeight>500));
    assert.match(await page.locator('#image-disclosure').innerText(),/AI 생성 이미지/);
    assert.match(await page.locator('#image-disclosure').innerText(),/치수 자동 반영 아님/);
    assert.ok(await page.locator('[data-view=image]').evaluate(button=>button.classList.contains('active')));
  });
  await page.screenshot({path:path.join(screenshots,'desktop-v2.png'),fullPage:true});
  await check('기본 산술: 제작비 83,000원, 겉감 0.9m 유지',async()=>{assert.equal(await numeric('#total-cost'),83000);assert.equal(await numeric('#fabric-meters'),0.9);});
  const initialImage=await page.locator('#design-image').getAttribute('src');
  await check('명시 치수 파싱은 계산을 바꾸고 정적 이미지 변경으로 오인시키지 않음',async()=>{
    await page.locator('#description').fill('네이비 토트백. 가로 40cm, 세로 35cm, 폭 15cm, 손잡이 길이 60cm.');
    await page.locator('#parse-brief').click();
    assert.equal(await page.locator('[name=width]').inputValue(),'40');
    assert.equal(await numeric('#total-cost'),86000);
    assert.ok((await page.locator('#design-image').getAttribute('src'))===initialImage);
    assert.match(await page.locator('#image-disclosure').innerText(),/치수 자동 반영 아님/);
  });
  await check('치수 개념도와 원단 배치 탭이 실제 계산을 표시',async()=>{
    await page.locator('[data-view=diagram]').click();
    assert.match(await page.locator('#drawing-canvas').innerText(),/40 cm/);
    assert.match(await page.locator('#drawing-canvas').innerText(),/35 cm/);
    await expect(page.locator('#image-disclosure')).toBeHidden();
    await page.locator('[data-view=layout]').click();
    assert.match(await page.locator('#drawing-canvas').innerText(),/배치 길이 0.79m/);
  });
  await check('이미지 탭에서도 치수 SVG 다운로드가 동작',async()=>{
    await page.locator('[data-view=image]').click();
    const pending=page.waitForEvent('download');
    await page.locator('#download-svg').click();
    const file=await(await pending).path();
    const content=await fs.readFile(file,'utf8');
    assert.ok(content.startsWith('<svg'));
    assert.match(content,/40 cm/);
    assert.ok(!content.includes('data:image'));
  });
  await check('브리프 다운로드는 입력 치수와 계산 한계를 포함',async()=>{
    const pending=page.waitForEvent('download');
    await page.locator('#download-brief').click();
    const file=await(await pending).path();
    const brief=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(brief.design.width,40);
    assert.equal(brief.estimate.total,86000);
    assert.match(brief.limitations.join(' '),/봉제용 실물 패턴이 아닙니다/);
  });
  await check('부품보다 좁은 원단은 비용과 두 다운로드 차단',async()=>{
    await page.locator('[name=fabricWidth]').fill('37');
    await expect(page.locator('#download-brief')).toBeDisabled();
    await expect(page.locator('#download-svg')).toBeDisabled();
    assert.match(await page.locator('#drawing-canvas').innerText(),/원단 폭 37cm/);
    assert.equal(await page.locator('#total-cost').innerText(),'—');
    await page.locator('[name=fabricWidth]').fill('150');
    await expect(page.locator('#design-image')).toBeVisible();
  });
  await check('저장·새로고침·다시 열기·수정·삭제가 유지',async()=>{
    await page.locator('#project-name').fill('리디자인 검증 토트백');
    await page.locator('#save-project').click();
    await page.reload();
    await page.locator('#projects-nav').click();
    await page.locator('[data-load]').filter({hasText:'리디자인 검증 토트백'}).click();
    assert.equal(await page.locator('[name=width]').inputValue(),'40');
    await page.locator('#project-name').fill('수정한 검증 토트백');
    await page.locator('#save-project').click();
    await page.locator('#projects-nav').click();
    assert.equal(await page.locator('[data-load]').count(),1);
    await expect(page.locator('[data-load]')).toContainText('수정한 검증 토트백');
    await page.locator('[data-delete]').click();
    assert.equal(await page.locator('[data-load]').count(),0);
    await page.locator('#close-dialog').click();
  });
  await check('상의는 별도로 생성한 상의 이미지와 도면을 표시',async()=>{
    await page.locator('[data-kind=top]').click();
    await page.locator('#design-image').evaluate(image=>image.decode());
    assert.ok((await page.locator('#design-image').getAttribute('src'))!==initialImage);
    await expect(page.locator('#design-image')).toHaveAttribute('alt',/상의/);
    await expect(page.locator('#notice')).toBeHidden({timeout:8000});
    await page.screenshot({path:path.join(screenshots,'top-v2.png'),fullPage:true});
    await page.locator('[data-view=diagram]').click();
    assert.match(await page.locator('#drawing-canvas').innerText(),/몸판 단면/);
  });
  await check('단가 변경에 따른 계산 결과가 이전과 동일',async()=>{
    await page.locator('#new-project').click();
    await page.locator('#cost-edit-toggle').click();
    await page.locator('[name=fabricPrice]').fill('24000');
    assert.equal(await numeric('#total-cost'),93800);
  });
  await page.locator('#new-project').click();
  await check('320·390·768·1024·1440px 가로 넘침 없음',async()=>{
    for(const width of [320,390,768,1024,1440]){
      await page.setViewportSize({width,height:900});
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    }
  });
  await page.setViewportSize({width:390,height:844});
  await page.reload();
  await page.locator('#design-image').evaluate(image=>image.decode());
  await page.screenshot({path:path.join(screenshots,'mobile-v2.png'),fullPage:true});
  await check('모바일에서 이미지가 입력 패널보다 먼저 표시',async()=>{
    const bounds=await page.evaluate(()=>({image:document.querySelector('.design-panel').getBoundingClientRect().top,form:document.querySelector('.spec-panel').getBoundingClientRect().top}));
    assert.ok(bounds.image<bounds.form);
  });
  await check('브라우저 JavaScript 오류 없음',async()=>assert.deepEqual(errors,[]));
}finally{await browser.close();}
console.log(JSON.stringify({verifiedAt:new Date().toISOString(),previewUrl:url,checks},null,2));
if(checks.some(check=>!check.passed))process.exitCode=1;
