import { test, expect } from '@playwright/test';

test('an example fills the idea, shows an estimate, and revision keeps the original project',async({page,request})=>{
  await page.goto('/#new');
  await page.getByRole('button',{name:'이 기획으로 시작하기',exact:true}).click();
  await expect(page.getByLabel('만들고 싶은 프로젝트 설명')).toHaveValue(/개인 프로젝트/);
  const estimate=page.getByRole('region',{name:'예상 비용과 시간'});
  await expect(estimate.getByText('$0 · 템플릿',{exact:true})).toBeVisible();
  const creation=page.waitForResponse(response=>response.url().endsWith('/api/projects')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'프로젝트 만들기',exact:true}).click();
  const original=await(await creation).json();
  await expect(page.getByRole('heading',{name:'써보니, 더 좋은 생각이 났나요?',exact:true})).toBeVisible({timeout:30_000});
  const before=await(await request.get(`/api/projects/${original.id}`)).json();
  await page.getByLabel('바꾸고 싶은 내용',{exact:true}).fill('완료된 할 일만 보이는 탭을 추가하고 밝은 배경으로 바꿔줘');
  const revision=page.waitForResponse(response=>response.url().endsWith(`/api/projects/${original.id}/revise`));
  await page.getByRole('button',{name:'템플릿 사본 만들기',exact:true}).click();
  const next=await(await revision).json();
  expect(next.id).not.toBe(original.id);expect(next.parentProjectId).toBe(original.id);expect(next.revision.mode).toBe('template-copy');
  await expect(page.getByRole('link',{name:'이전 버전 보기',exact:true})).toBeVisible();
  await expect.poll(async()=>(await(await request.get(`/api/projects/${next.id}`)).json()).status).toBe('completed');
  const after=await(await request.get(`/api/projects/${original.id}`)).json();expect(after.files).toEqual(before.files);
});

test('Google identity view directs to the configured OAuth route without claiming API quota',async({page})=>{
  await page.route('**/api/auth/session',route=>route.fulfill({json:{authenticated:false,required:true,google:true,configured:true}}));
  await page.goto('/');
  await expect(page.getByRole('link',{name:/Google 계정으로/})).toHaveAttribute('href','/api/auth/google/start');
  await expect(page.getByLabel('워크스페이스 비밀번호')).toHaveCount(0);
});
