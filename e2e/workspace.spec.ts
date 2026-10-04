import { test, expect } from '@playwright/test';

test('workspace is responsive, accepts an idea, and creates a real project', async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Launchpad', { exact: true }).first()).toBeVisible();
  const composer = page.locator('textarea').first();
  await expect(composer).toBeVisible();
  await composer.fill('독서 기록을 추가하고 완료 여부를 체크하는 개인 독서 관리 앱을 만들어줘');
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/projects') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /프로젝트 만들기/ }).first().click();
  const response = await createdResponse;
  expect(response.status()).toBe(202);
  const created = await response.json();
  let projectName = created.name;
  await expect.poll(async () => {
    const result = await request.get(`/api/projects/${created.id}`);
    const project = await result.json();
    projectName = project.name;
    return project.status;
  }, { timeout: 30_000 }).toBe('completed');
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/소스|다운로드/).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('mobile workspace fits viewport and the prompt remains usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('textarea').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator('textarea').first().fill('할 일을 정리하는 나만의 앱');
  await expect(page.getByRole('button', { name: /프로젝트 만들기/ }).first()).toBeEnabled();
});

test('cloud login view displays errors and opens the workspace after successful authentication', async ({ page }) => {
  let authenticated = false;
  await page.route('**/api/auth/session', route => route.fulfill({ json: { authenticated, required: true } }));
  await page.route('**/api/auth/login', async route => {
    const { password } = route.request().postDataJSON();
    authenticated = password === 'correct-test-password';
    await route.fulfill({ status: authenticated ? 200 : 401, json: authenticated ? { authenticated: true } : { error: '워크스페이스 비밀번호를 확인해 주세요.' } });
  });
  await page.goto('/');
  await page.getByLabel('워크스페이스 비밀번호').fill('incorrect');
  await page.getByRole('button', { name: '워크스페이스 시작하기' }).click();
  await expect(page.getByRole('alert')).toContainText('비밀번호를 확인');
  await page.getByLabel('워크스페이스 비밀번호').fill('correct-test-password');
  await page.getByRole('button', { name: '워크스페이스 시작하기' }).click();
  await expect(page.locator('textarea').first()).toBeVisible();
  const saved = await page.evaluate(() => JSON.stringify(localStorage));
  expect(saved).not.toContain('correct-test-password');
});
