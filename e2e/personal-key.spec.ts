import { test, expect } from '@playwright/test';

test('personal API connection persists masked, stays browser-specific, and disconnects', async ({ page, browser, baseURL }) => {
  // A synthetic key exercises storage and UI only; this test never invokes inference.
  const testKey = 'sk-test-e2e-personal-connection-1234567890';
  const other = await browser.newContext();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const input = page.getByLabel('OpenAI API 키', { exact: true });
    await expect(input).toHaveAttribute('type', 'password');
    await input.fill(testKey);
    await page.getByLabel('사용할 모델').fill('gpt-4.1-mini');
    await page.getByRole('button', { name: '개인 키 연결', exact: true }).click();
    await expect(page.getByText('개인 키 연결됨', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(page.getByText('sk-••••7890', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage, cookie: document.cookie }))).not.toContain(testKey);
    const cookie = (await page.context().cookies()).find(value => value.name === 'launchpad_person');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.value).not.toContain(testKey);

    const separateStatus = await other.request.get(`${baseURL}/api/credentials`);
    expect((await separateStatus.json()).source).not.toBe('personal');

    await page.reload();
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await expect(page.getByText('sk-••••7890', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '연결 해제', exact: true }).click();
    await expect(page.getByText('개인 키 연결됨', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('연결과 이 키를 사용하던 실행을 종료');
    expect((await (await page.request.get('/api/credentials')).json()).source).not.toBe('personal');
  } finally {
    await page.request.delete('/api/credentials');
    await other.close();
  }
});
