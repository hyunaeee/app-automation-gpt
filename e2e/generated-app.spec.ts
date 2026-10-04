import { test, expect } from '@playwright/test';

test('generated app supports signup, adding a record, completion and logout in the browser', async ({ request, page }) => {
  const response = await request.post('/api/projects', { data: { prompt: '매일 읽은 책을 기록하는 개인 독서 앱', kind: 'web-app' } });
  expect(response.status()).toBe(202);
  const created = await response.json();
  let preview = '';
  await expect.poll(async () => {
    const detail = await request.get(`/api/projects/${created.id}`);
    const project = await detail.json();
    preview = project.previewUrl;
    return project.status;
  }).toBe('completed');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(preview);
  await page.getByLabel('이름', { exact: true }).fill('테스트 독자');
  await page.getByLabel('이메일', { exact: true }).fill('browser-reader@example.com');
  await page.getByLabel('비밀번호', { exact: true }).fill('browser-test-password');
  await page.getByRole('button', { name: '내 공간 만들기' }).click();
  await expect(page.getByRole('heading', { name: /테스트 독자님의 공간/ })).toBeVisible();
  await page.getByLabel('제목', { exact: true }).fill('작은 아이디어를 실행하는 법');
  await page.getByLabel('내용', { exact: true }).fill('첫 장부터 한 걸음씩');
  await page.getByRole('button', { name: '기록 추가' }).click();
  await expect(page.getByRole('heading', { name: '작은 아이디어를 실행하는 법' })).toBeVisible();
  await page.getByLabel('진행 상태').selectOption('done');
  await expect(page.locator('.item .status')).toHaveText('완료');
  await page.reload();
  await expect(page.getByRole('heading', { name: '작은 아이디어를 실행하는 법' })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByLabel('이메일', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
