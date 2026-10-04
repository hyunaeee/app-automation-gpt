import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const directory=path.resolve('samples/atelier-mobile');
const url=process.env.ATELIER_MOBILE_URL||'http://127.0.0.1:62010/';
const files=['public/index.html','public/app.js','public/styles.css','public/design-assets.js'];
const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,crypto.createHash('sha256').update(await fs.readFile(path.join(directory,'app',file))).digest('hex')])));
const before=await hashes();
const project=JSON.parse(await fs.readFile(path.join(directory,'app/project.json'),'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:390,height:844}});
const checks=[],screenshots=[],errors=[],remote=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).origin!==new URL(url).origin)remote.push(request.url());});
await fs.mkdir(path.join(directory,'screenshots'),{recursive:true});
const numeric=async selector=>Number((await page.locator(selector).innerText()).replace(/[^0-9.]/g,''));
const check=async(name,action)=>{try{await action();checks.push({name,passed:true,detail:'실제 Chrome 화면 조작으로 확인'});console.log('PASS '+name);}catch(error){checks.push({name,passed:false,detail:error.message.slice(0,500)});console.log('FAIL '+name+' '+error.message.slice(0,250));}};
const capture=async name=>{await page.screenshot({path:path.join(directory,'screenshots',name+'.png'),fullPage:false});screenshots.push({name,path:'screenshots/'+name+'.png',...page.viewportSize()});};
const nav=async tab=>page.locator('[data-tab='+tab+']').click();
const ctaVisible=async selector=>{
  await expect(page.locator(selector)).toBeInViewport({ratio:1});
  const bounds=await page.evaluate(selector=>{const a=document.querySelector(selector).getBoundingClientRect(),n=document.querySelector('.bottom-nav').getBoundingClientRect();return{buttonBottom:a.bottom,navTop:n.top};},selector);
  assert.ok(bounds.buttonBottom<=bounds.navTop,'Primary action must be above the bottom navigation.');
};
try{
  await page.goto(url);
  await check('이미지 레퍼런스 기반 Studio와 실제 제품 이미지 로드',async()=>{
    await page.locator('#open-design img').evaluate(image=>image.decode());
    await expect(page.getByRole('heading',{name:'Make it yours.',exact:true})).toBeVisible();
    assert.ok(await page.locator('#open-design img').evaluate(image=>image.naturalWidth>500));
    await expect(page.locator('.bottom-nav')).toContainText('Studio');
    await expect(page.locator('.bottom-nav')).toContainText('Library');
    await expect(page.locator('.bottom-nav')).toContainText('Materials');
  });
  await capture('studio');
  await page.locator('#open-design').click();
  await check('Design와Pattern 전환 및 이미지의 실측 한계 표시',async()=>{
    await page.locator('#design-image').evaluate(image=>image.decode());
    await expect(page.locator('#image-note')).toContainText('정적 AI 이미지');
    await page.locator('[data-view=pattern]').click();
    await expect(page.locator('#design-visual svg')).toContainText('36 cm');
    await expect(page.locator('#image-note')).toContainText('봉제용 패턴이 아닙니다');
    await page.locator('[data-view=design]').click();
  });
  await check('상세 CTA가 하단 내비게이션 위에 항상 표시',async()=>ctaVisible('#see-estimate'));
  await capture('design');
  await page.locator('#see-estimate').click();
  await check('기본 비용83,000원·겉감0.90m·안감0.40m 산출',async()=>{
    assert.equal(await numeric('#total-cost'),83000);
    await expect(page.locator('[data-material=canvas]')).toContainText('0.90 m');
    await expect(page.locator('[data-material=lining]')).toContainText('0.40 m');
  });
  await check('견적 저장·업체찾기 CTA가 하단 내비게이션 위에 표시',async()=>{await ctaVisible('#save-design');await ctaVisible('#find-maker');});
  await capture('estimate');
  await check('제작업체 찾기는 실제 입력 브리프와 선택 가능한 검색어 제공',async()=>{
    await page.locator('#find-maker').click();
    await expect(page.locator('#maker-query')).toHaveValue(/가방.*제작 업체/);
    await expect(page.locator('#maker-brief')).toHaveValue(/36 × 32 × 12 cm/);
    await expect(page.locator('#maker-brief')).toHaveValue(/83,000/);
    await expect(page.locator('#sheet')).toContainText('자동 문의 전송 기능은 아닙니다');
    await page.locator('#copy-query').click();
    await expect(page.locator('#copy-status')).toContainText(/복사|선택/);
    await page.locator('#close-sheet').click();
  });
  await check('디자인 저장→Library→새로고침→다시 열기',async()=>{
    await page.locator('#save-design').click();
    await nav('library');
    await expect(page.locator('[data-load]')).toHaveCount(1);
    await page.reload();
    await nav('library');
    await expect(page.locator('[data-load]')).toHaveCount(1);
    await page.locator('[data-load]').click();
    await expect(page.locator('[name=width]')).toHaveValue('36');
  });
  await check('명시 치수 수정→Pattern 갱신→저장본 업데이트',async()=>{
    await page.locator('[name=width]').fill('40');
    await page.locator('[data-view=pattern]').click();
    await expect(page.locator('#design-visual svg')).toContainText('40 cm');
    await page.locator('#see-estimate').click();
    await page.locator('#save-design').click();
    await nav('library');
    await expect(page.locator('[data-load]')).toHaveCount(1);
    await expect(page.locator('[data-load]')).toContainText('40 × 32 cm');
    await page.locator('[data-load]').click();
  });
  await check('빈 치수→Studio·Materials 이동 후에도 crash나NaN 없음',async()=>{
    await page.locator('[name=width]').fill('');
    await expect(page.locator('#see-estimate')).toBeDisabled();
    await nav('studio');
    await expect(page.locator('#open-design')).toBeVisible();
    await nav('materials');
    await expect(page.locator('#materials-total')).toHaveText('—');
    await expect(page.locator('#apply-materials')).toBeDisabled();
    assert.ok(!(await page.locator('body').innerText()).includes('NaN'));
    await nav('studio');
    await page.locator('#open-design').click();
    await page.locator('[name=width]').fill('36');
    await expect(page.locator('#see-estimate')).toBeEnabled();
  });
  await check('Materials 단가 수정은 산술 결과를 정확히 갱신',async()=>{
    await nav('materials');
    await page.locator('[name=fabricPrice]').fill('24000');
    assert.equal(await numeric('#materials-total'),93800);
    await page.locator('#apply-materials').click();
    await page.locator('#see-estimate').click();
    assert.equal(await numeric('#total-cost'),93800);
  });
  await check('통화 변경 시 공임·개발비를 포함한 모든 단위 갱신',async()=>{
    await nav('materials');
    await page.locator('#currency').selectOption('USD');
    for(const name of ['fabricPrice','liningPrice','hardwarePrice','labor','development']){
      const unit=await page.locator('[name='+name+']').evaluate(input=>input.closest('.field').querySelector('small').textContent);
      assert.ok(unit.includes('USD'),name+' must use the selected currency.');
    }
    assert.equal(await page.locator('[name=fabricPrice]').inputValue(),'24000');
    await expect(page.locator('.production-settings')).toContainText('환율 변환되지 않습니다');
    await page.locator('#currency').selectOption('KRW');
  });
  await check('원단 폭 오류와 소수 제작 수량을 검출하고 복구',async()=>{
    await page.locator('[name=fabricWidth]').fill('37');
    await expect(page.locator('#input-error')).toContainText('원단 폭 37cm');
    await expect(page.locator('#apply-materials')).toBeDisabled();
    await page.locator('[name=fabricWidth]').fill('150');
    await page.locator('[name=quantity]').fill('1.5');
    await expect(page.locator('#input-error')).toContainText('정수');
    await page.locator('[name=quantity]').fill('1');
    await expect(page.locator('#apply-materials')).toBeEnabled();
  });
  await check('새 자연어 브리프의 종류·치수·이름 파싱',async()=>{
    await nav('studio');
    await page.locator('#new-design').click();
    await page.locator('#brief-name').fill('My linen top');
    await page.locator('[data-kind=top]').click();
    await page.locator('#brief-description').fill('내추럴 리넨 상의. 가로 56cm, 총장 66cm, 소매 길이 24cm로 만들고 싶어요.');
    await expect(page.locator('#sheet')).toContainText('로컬 규칙 기반');
    await page.locator('#apply-brief').click();
    await expect(page.locator('.page-header h1')).toHaveText('My linen top');
    await expect(page.locator('[name=width]')).toHaveValue('56');
    await expect(page.locator('[name=height]')).toHaveValue('66');
    await expect(page.locator('[name=sleeveLength]')).toHaveValue('24');
    await expect(page.locator('#design-image')).toHaveAttribute('alt',/상의/);
    await page.locator('[data-view=pattern]').click();
    await expect(page.locator('#design-visual svg')).toContainText('몸판 단면 56 cm');
  });
  await check('새 디자인 추가·검색·삭제·삭제 후 새로고침 유지',async()=>{
    await page.locator('#see-estimate').click();
    await page.locator('#save-design').click();
    await nav('library');
    await expect(page.locator('[data-load]')).toHaveCount(2);
    await page.locator('#library-search').fill('linen');
    await expect(page.locator('.saved-row:visible')).toHaveCount(1);
    await page.locator('.saved-row:visible [data-delete]').click();
    await page.locator('#confirm-delete').click();
    await expect(page.locator('[data-load]')).toHaveCount(1);
    await page.reload();
    await nav('library');
    await expect(page.locator('[data-load]')).toHaveCount(1);
  });
  await page.locator('[data-load]').click();
  await nav('library');
  await capture('library');
  await nav('materials');
  await capture('materials');
  await check('320·390·430px 모든 화면의 가로 넘침과 고정 CTA 확인',async()=>{
    for(const width of [320,390,430]){
      await page.setViewportSize({width,height:844});
      for(const tab of ['studio','library','materials']){
        await nav(tab);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),tab+' overflow at '+width);
      }
      await nav('studio');await page.locator('#open-design').click();await ctaVisible('#see-estimate');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
      await page.locator('#see-estimate').click();await ctaVisible('#save-design');await ctaVisible('#find-maker');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    }
  });
  await page.reload();await page.setViewportSize({width:430,height:932});await capture('studio-430');
  await page.setViewportSize({width:320,height:740});await capture('studio-320');
  await page.setViewportSize({width:1200,height:1000});await capture('desktop');
  await check('데스크톱에서는 앱이 480px 이하로 중앙 배치',async()=>{
    const bounds=await page.locator('.app-surface').boundingBox();assert.ok(bounds.width<=480);assert.ok(Math.abs(bounds.x-(1200-bounds.width)/2)<1);
  });
  await check('오프라인 동작: 외부 요청·네트워크 코드 없음',async()=>{
    assert.deepEqual(remote,[]);
    const script=await fs.readFile(path.join(directory,'app/public/app.js'),'utf8');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|https?:\/\//.test(script));
  });
  await check('브라우저 JavaScript 오류 없음',async()=>assert.deepEqual(errors,[]));
  await check('검증 중 앱 소스 변경 없음',async()=>assert.deepEqual(await hashes(),before));
}finally{
  await browser.close();
  const report={verifiedAt:new Date().toISOString(),projectId:project.id,name:project.name,url,designReference:{path:'design/reference-v1.png',sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(directory,'design/reference-v1.png'))).digest('hex')},checks,screenshots,sourceFileSha256:await hashes()};
  await fs.writeFile(path.join(directory,'browser-report.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify({passed:checks.filter(check=>check.passed).length,total:checks.length,report:'samples/atelier-mobile/browser-report.json'}));
if(checks.some(check=>!check.passed))process.exitCode=1;
