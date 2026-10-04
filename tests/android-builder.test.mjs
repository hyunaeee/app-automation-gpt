import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { androidSourceFiles, inspectAndroidToolchain, buildAndroidApk, validateAndroidApk } from '../server/android-builder.mjs';
import { createZip } from '../server/zip.mjs';

const projectId = 'a08f73d6-5d45-4028-8e9a-cc26cbd13a61';
const files = [
  { path: 'public/index.html', content: '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="styles.css"><body><h1>Android APK smoke test</h1><script src="app.js"></script></body></html>' },
  { path: 'public/app.js', content: 'document.body.dataset.ready="true";localStorage.setItem("ready","yes")' },
  { path: 'public/styles.css', content: 'body{font-family:sans-serif;padding:24px;background:#101116;color:white}' },
];

test('Android source bundles offline public assets only and uses a trusted native shell', () => {
  const sources = androidSourceFiles({ projectId, name: '나의 앱 & <test>', files: [...files, { path: '.env', content: 'SECRET=not-exported' }, { path: 'server.mjs', content: 'not-exported' }] });
  const byPath = Object.fromEntries(sources.map(file => [file.path, file.content]));
  const manifest = byPath['android/app/src/main/AndroidManifest.xml'];
  assert.match(manifest, /com\.launchpad\.pa08f73d65d4540288e9acc26cbd13a61/);
  assert.doesNotMatch(manifest, /uses-permission/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(byPath['android/app/src/main/res/values/strings.xml'], /&amp; &lt;test&gt;/);
  const source = sources.find(file => file.path.endsWith('/MainActivity.java')).content;
  assert.match(source, /settings\.setAllowFileAccess\(false\)/);
  assert.match(source, /settings\.setAllowContentAccess\(false\)/);
  assert.match(source, /connect-src 'none'/);
  assert.match(source, /return !isLocal\(request\.getUrl\(\)\)/);
  assert.doesNotMatch(source, /addJavascriptInterface|127\.0\.0\.1|localhost/);
  assert.equal(byPath['android/app/src/main/assets/web/app.js'], files[1].content);
  assert.doesNotMatch(JSON.stringify(sources), /not-exported/);
  assert.ok(sources.every(file => !file.path.endsWith('.keystore')));
});

test('Android assets reject traversal, executables, duplicates, oversized input and unsafe IDs', () => {
  for (const invalid of ['public/../escape.js', 'public/a/../../escape.js', 'public/app.exe', 'public//app.js', 'public/app\\test.js']) {
    assert.throws(() => androidSourceFiles({ projectId, files: [...files, { path: invalid, content: '' }] }), error => error.code === 'ANDROID_INVALID_ASSETS');
  }
  assert.throws(() => androidSourceFiles({ projectId: '../escape', files }), error => error.code === 'ANDROID_INVALID_PROJECT');
  assert.throws(() => androidSourceFiles({ projectId, files: [...files, files[1]] }), error => error.code === 'ANDROID_INVALID_ASSETS');
  assert.throws(() => androidSourceFiles({ projectId, files: files.slice(1) }), error => error.code === 'ANDROID_INVALID_ASSETS');
  assert.throws(() => androidSourceFiles({ projectId, files: [{ path: 'public/index.html', content: 'x'.repeat(6 * 1024 * 1024) }] }), error => error.status === 413);
});

test('Missing Android toolchain reports actionable readiness without downloading or pretending to build', async () => {
  const status = await inspectAndroidToolchain({ env: {}, home: path.join(os.tmpdir(), 'launchpad-no-android-toolchain') });
  // System-wide Linux SDKs may exist on a CI host; if so the reported paths must be real.
  if (status.available) { assert.ok(status.androidJar); assert.ok(status.javaHome); }
  else { assert.equal(status.code, 'ANDROID_TOOLCHAIN_UNAVAILABLE'); assert.ok(status.missing.length); assert.match(status.reason, /설치/); }
});

test('APK validation rejects plain archives and a cancelled job cannot start', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'launchpad-invalid-apk-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fake = path.join(directory, 'fake.apk');
  await fs.writeFile(fake, createZip(files));
  await assert.rejects(validateAndroidApk(fake), error => error.code === 'ANDROID_INVALID_APK');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(buildAndroidApk({ projectId, files, directory, signal: controller.signal }), error => error.code === 'ANDROID_BUILD_CANCELLED');
});

test('Installed SDK builds a signed APK with real DEX, compiled manifest and bundled offline assets', { skip: process.env.RUN_ANDROID_BUILD_TEST !== '1', timeout: 180000 }, async t => {
  const readiness = await inspectAndroidToolchain();
  assert.equal(readiness.available, true, readiness.reason);
  const directory = path.resolve('.data/android-build-verification');
  const result = await buildAndroidApk({ projectId, name: '앱 & <테스트>', files, directory });
  assert.equal(result.signatureVerified, true);
  assert.equal(result.mode, 'debug');
  assert.ok(result.size > 1000);
  const validation = await validateAndroidApk(result.path);
  assert.equal(validation.sha256, result.sha256);
  assert.ok(validation.entries.includes('classes.dex'));
  assert.ok(validation.entries.includes('assets/web/app.js'));
  assert.ok(!validation.entries.some(entry => /\.env|\.keystore|server\.mjs/.test(entry)));
  t.diagnostic(`Verified real debug APK: ${result.path} (${result.size} bytes; sha256 ${result.sha256})`);
});
