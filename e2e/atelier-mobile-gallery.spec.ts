import { test, expect } from '@playwright/test';

test('mobile case study connects its design reference, working phone and downloadable APK', async ({ page, request }, testInfo) => {
  const sampleResponse = await request.get('/examples/atelier-mobile/sample.json');
  expect(sampleResponse.ok()).toBeTruthy();
  const sample = await sampleResponse.json();
  expect(sample.verified).toBe(true);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#new');
  const gallery = page.getByRole('region', { name: '디자인에서 APK까지 모바일 앱 검증 샘플' });
  await expect(gallery).toBeVisible();
  await expect(gallery).toContainText('이번 Codex 작업에서');
  const iframe = page.locator('iframe[title="Atelier 모바일 앱 검증 샘플"]');
  const phone = page.frameLocator('iframe[title="Atelier 모바일 앱 검증 샘플"]');
  await expect(iframe).not.toHaveAttribute('sandbox', /allow-same-origin/);
  await iframe.scrollIntoViewIfNeeded();
  await expect(iframe).toBeInViewport({ ratio: .99 });
  await expect.poll(() => phone.locator('body').evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 390, height: 844 });
  await expect.poll(() => phone.locator('img').first().evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await phone.locator('#open-design').click();
  await phone.locator('input[name="width"]').fill('40');
  await expect(phone.locator('input[name="width"]')).toHaveValue('40');
  await phone.locator('[data-view="pattern"]').click();
  await expect(phone.locator('body')).toContainText('40');
  await gallery.screenshot({ path: testInfo.outputPath('atelier-mobile-gallery-desktop.png') });

  await gallery.getByRole('tab', { name: '디자인 레퍼런스' }).click();
  const reference = gallery.getByRole('img', { name: /세 화면의 모바일 디자인 레퍼런스/ });
  await expect(reference).toBeVisible();
  await expect(reference).toHaveAttribute('src', '/examples/atelier-mobile/reference-v1.png');
  await expect.poll(() => reference.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(1000);
  await gallery.getByRole('tab', { name: '작동하는 앱' }).click();
  await expect(phone.locator('input[name="width"]')).toHaveValue('40');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await iframe.scrollIntoViewIfNeeded();
  await expect(iframe).toBeInViewport({ ratio: .99 });
  await gallery.screenshot({ path: testInfo.outputPath('atelier-mobile-gallery-mobile.png') });
  const download = await request.get('/examples/atelier-mobile/atelier-mobile.apk');
  expect(download.ok()).toBeTruthy();
  const apk = await download.body();
  expect(apk.subarray(0, 2).toString()).toBe('PK');
  expect(apk.includes(Buffer.from('classes.dex'))).toBeTruthy();
  const zip = await request.get('/examples/atelier-mobile/source.zip');
  expect(zip.ok()).toBeTruthy(); expect((await zip.body()).subarray(0, 2).toString()).toBe('PK');
  const prompt = await request.get('/examples/atelier-mobile/image-prompt.json');
  expect(prompt.ok()).toBeTruthy(); expect((await prompt.json()).prompt).toBeTruthy();
  await gallery.getByRole('button', { name: '이 아이디어로 모바일 앱 만들기' }).click();
  await expect(page.getByRole('button', { name: '모바일 앱', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('만들고 싶은 프로젝트 설명')).toHaveValue(sample.prompt);
  expect(errors).toEqual([]);
});

test('mobile gallery stays hidden when its verified sample is unavailable', async ({ page }) => {
  await page.route('**/examples/atelier-mobile/sample.json', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.goto('/#new');
  await expect(page.getByRole('region', { name: '디자인에서 APK까지 모바일 앱 검증 샘플' })).toHaveCount(0);
  await expect(page.getByLabel('만들고 싶은 프로젝트 설명')).toBeVisible();
});
