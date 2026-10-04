import { test, expect } from '@playwright/test';

test('guided creation preserves three planning reviews before automatic implementation', async ({page,request},testInfo) => {
  test.setTimeout(90_000);
  const config=await(await request.get('/api/config')).json();
  test.skip(config.mode!=='local','This regression uses local templates and never consumes API or subscription credits. Run with PLAYWRIGHT_PORT=3003.');
  const pageErrors:string[]=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto('/#new');
  await page.getByRole('button',{name:/단계별로 확인/}).click();
  await page.getByLabel('만들고 싶은 프로젝트 설명').fill('매일 읽은 책과 독서 메모를 개인 공간에 기록하는 앱을 만들어줘.');
  const createdResponse=page.waitForResponse(response=>response.url().endsWith('/api/projects')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'프로젝트 만들기',exact:true}).click();
  const creation=await createdResponse;
  expect(creation.status()).toBe(202);
  expect(creation.request().postDataJSON().workflowMode).toBe('guided');
  const created=await creation.json();
  expect(created.workflowMode).toBe('guided');
  const projectUrl='/api/projects/'+created.id;
  const detail=async()=>await(await page.request.get(projectUrl)).json();
  await expect(page.getByRole('heading',{name:'기획을 확인해 주세요',exact:true})).toBeVisible({timeout:30_000});
  let project=await detail();
  expect(project.status).toBe('awaiting_approval');
  expect(project.review.stage).toBe('requirements');
  expect(project.files).toEqual([]);
  expect(project.previewUrl).toBeNull();
  const firstReviewId=project.review.id;
  expect(firstReviewId).toBeTruthy();
  for(const id of ['scaffold','coding','validation','delivery']) expect(project.stages.find((stage:{id:string})=>stage.id===id).status).toBe('pending');

  await page.reload();
  await expect(page.getByRole('heading',{name:'기획을 확인해 주세요',exact:true})).toBeVisible();
  project=await detail();
  expect(project.status).toBe('awaiting_approval');
  expect(project.review.id).toBe(firstReviewId);
  expect(project.files).toEqual([]);
  await expect(page.getByRole('button',{name:'수정 의견 남기기',exact:true})).toBeDisabled();
  await page.setViewportSize({width:1440,height:1050});
  await page.screenshot({path:testInfo.outputPath('guided-planning-review.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect.poll(()=>page.locator('.sidebar').evaluate(element=>element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await expect(page.getByRole('button',{name:'확인하고 다음 단계',exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('guided-planning-review-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1050});

  // Without an AI connection, feedback must never silently claim to alter the plan.
  const unavailableRevision=await page.request.post(projectUrl+'/review',{data:{reviewId:firstReviewId,action:'revise',feedback:'개인 독서 기록에 별점 기능을 추가해 주세요.'}});
  expect(unavailableRevision.status()).toBe(409);
  expect((await detail()).review.id).toBe(firstReviewId);

  const approve=async()=>{
    const response=page.waitForResponse(result=>result.url().endsWith(projectUrl+'/review')&&result.request().method()==='POST');
    await page.getByRole('button',{name:'확인하고 다음 단계',exact:true}).click();
    expect((await response).ok()).toBeTruthy();
  };
  await approve();
  await expect(page.getByRole('heading',{name:'기능을 확인해 주세요',exact:true})).toBeVisible({timeout:30_000});
  project=await detail();
  expect(project.status).toBe('awaiting_approval');
  expect(project.review.stage).toBe('features');
  expect(project.review.id).not.toBe(firstReviewId);
  expect(project.approvedStages).toEqual(['requirements']);
  expect(project.files).toEqual([]);
  const secondReviewId=project.review.id;
  const staleApproval=await page.request.post(projectUrl+'/review',{data:{reviewId:firstReviewId,action:'approve'}});
  expect(staleApproval.status()).toBe(409);
  expect((await detail()).review.id).toBe(secondReviewId);
  await expect(page.getByRole('heading',{name:'기능을 확인해 주세요',exact:true})).toBeVisible();

  await approve();
  await expect(page.getByRole('heading',{name:'설계를 확인해 주세요',exact:true})).toBeVisible({timeout:30_000});
  project=await detail();
  expect(project.review.stage).toBe('architecture');
  expect(project.approvedStages).toEqual(['requirements','features']);
  expect(project.files).toEqual([]);
  expect(project.plan.fileTree.length).toBeGreaterThan(0);
  const thirdReviewId=project.review.id;

  await approve();
  await expect(page.getByRole('heading',{name:'아이디어가 첫 번째 앱이 되었어요.',exact:true})).toBeVisible({timeout:40_000});
  project=await detail();
  expect(project.status).toBe('completed');
  expect(project.approvedStages).toEqual(['requirements','features','architecture']);
  expect(project.review).toBeFalsy();
  expect(project.files.length).toBeGreaterThan(0);
  expect(project.checks.length).toBeGreaterThan(0);
  expect(project.checks.every((check:{passed:boolean})=>check.passed)).toBe(true);
  expect(project.previewUrl).toMatch(/^http:\/\/(?:127\.0\.0\.1|localhost):/);
  expect(project.reviewHistory.filter((entry:{action:string})=>entry.action==='approve').map((entry:{stage:string})=>entry.stage)).toEqual(['requirements','features','architecture']);
  await expect(page.getByRole('link',{name:'소스 다운로드',exact:true})).toBeVisible();
  const repeatedApproval=await page.request.post(projectUrl+'/review',{data:{reviewId:thirdReviewId,action:'approve'}});
  expect(repeatedApproval.status()).toBe(409);
  expect(pageErrors).toEqual([]);
});
