import { test, expect } from '@playwright/test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

test('a workspace link opens a protected preview across sites without a cookie redirect failure', async ({ page, context }) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'launchpad-preview-browser-'));
  const engine = await createApp({ dataDir, apiKey: '', previewAccessToken: 'browser-test-preview-access-token' });
  let source: http.Server | undefined;
  try {
    const created = await engine.createProject({ prompt: '개인 독서 기록을 추가하고 관리하는 앱을 만들어줘', kind: 'web-app' });
    await engine.runProject(created.id);
    const project = engine.store.get(created.id);
    expect(project.status).toBe('completed');
    expect(new URL(project.previewUrl).hostname).toBe('localhost');
    source = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<a href="${project.previewUrl}" target="_blank" rel="noopener">앱 실행</a>`);
    });
    source.listen(0, '127.0.0.1'); await once(source, 'listening');
    const address = source.address() as { port: number };
    // 127.0.0.1 and localhost are different sites, like the workspace and Sandbox domains.
    await page.goto(`http://127.0.0.1:${address.port}`);
    const opened = context.waitForEvent('page');
    await page.getByRole('link', { name: '앱 실행' }).click();
    const preview = await opened;
    await expect(preview.getByRole('heading', { name: '처음 오셨나요?' })).toBeVisible();
    await expect(preview).toHaveURL(new URL(project.previewUrl).origin + '/');
    const cookies = await context.cookies(project.previewUrl);
    expect(cookies.find(cookie => cookie.name.endsWith('_access'))?.sameSite).toBe('Lax');
    expect(cookies.find(cookie => cookie.name.endsWith('_access'))?.httpOnly).toBe(true);
    await preview.close();
  } finally {
    await engine.shutdown();
    if (source) await new Promise<void>(resolve => source!.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
