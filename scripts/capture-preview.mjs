import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
await fs.mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:3001');
  await page.locator('textarea').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'artifacts/launchpad-desktop.png', fullPage: true, animations: 'disabled' });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await mobile.goto('http://127.0.0.1:3001');
  await mobile.locator('textarea').waitFor();
  await mobile.evaluate(() => document.fonts.ready);
  await mobile.screenshot({ path: 'artifacts/launchpad-mobile.png', fullPage: true, animations: 'disabled' });
  console.log('Screenshots saved to artifacts/launchpad-desktop.png and launchpad-mobile.png');
} finally { await browser.close(); }
