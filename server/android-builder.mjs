import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const JAVA_TEMPLATE = readFileSync(new URL('./android-template/MainActivity.java', import.meta.url), 'utf8');
const EXT = process.platform === 'win32' ? '.exe' : '';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SOURCE_LIMIT = 10 * 1024 * 1024;
let activeBuild = false;

export class AndroidBuildError extends Error {
  constructor(message, code = 'ANDROID_BUILD_FAILED', status = 500) {
    super(message); this.name = 'AndroidBuildError'; this.code = code; this.status = status;
  }
}

const exists = async target => { try { return (await fs.stat(target)).isFile(); } catch { return false; } };
const folders = async target => { try { return (await fs.readdir(target, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { return []; } };
const newest = items => [...items].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const cancelled = () => new AndroidBuildError('APK 빌드가 취소되었습니다.', 'ANDROID_BUILD_CANCELLED', 409);
const sanitizeLog = text => String(text).replace(/\u001b\[[0-9;]*m/g, '').replace(/(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,})/g, '[redacted]').replace(/((?:token|api[_-]?key|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]').slice(-12000);

/** Readiness is based on installed, local tools; this function never downloads packages. */
export async function inspectAndroidToolchain({ env = process.env, home = os.homedir() } = {}) {
  const sdkCandidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT,
    path.join(home, 'AppData/Local/Android/Sdk'), path.join(home, 'Library/Android/sdk'),
    path.join(home, 'Android/Sdk'), '/opt/android-sdk', '/opt/android'].filter(Boolean);
  const javaCandidates = [env.JAVA_HOME, path.join(home, '.jdks/jdk17'),
    path.join(home, '.jdks/jdk21'), '/usr/lib/jvm/java-17-openjdk-amd64', '/usr/lib/jvm/java-21-openjdk-amd64'].filter(Boolean);
  // JAVA_HOME is preferred; PATH is only used to locate an installed JDK, never as a shell command.
  for (const segment of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (segment) javaCandidates.push(path.dirname(segment));
  }
  let javaHome;
  for (const candidate of javaCandidates) {
    let version;
    try { version = Number((await fs.readFile(path.join(candidate, 'release'), 'utf8')).match(/^JAVA_VERSION="(\d+)/m)?.[1]); } catch {}
    if (version >= 17 && (await Promise.all(['javac', 'java', 'jar', 'keytool'].map(tool => exists(path.join(candidate, 'bin', `${tool}${EXT}`))))).every(Boolean)) { javaHome = path.resolve(candidate); break; }
  }
  let sdkPath, buildToolsPath, buildToolsVersion;
  for (const candidate of sdkCandidates) {
    for (const version of newest(await folders(path.join(candidate, 'build-tools')))) {
      if (Number.parseInt(version, 10) < 34) continue;
      const target = path.join(candidate, 'build-tools', version);
      const needed = [`aapt2${EXT}`, `zipalign${EXT}`, 'lib/d8.jar', 'lib/apksigner.jar'];
      if ((await Promise.all(needed.map(file => exists(path.join(target, file))))).every(Boolean)) {
        sdkPath = path.resolve(candidate); buildToolsPath = path.resolve(target); buildToolsVersion = version; break;
      }
    }
    if (sdkPath) break;
  }
  // Pin API 34 so the exported project and generated package share the same target behavior.
  const apiLevel = 34;
  const androidJar = sdkPath && path.join(sdkPath, 'platforms', `android-${apiLevel}`, 'android.jar');
  const missing = [!javaHome && 'JDK 17 이상(JAVA_HOME)', !sdkPath && 'Android SDK Build Tools 34 이상(ANDROID_HOME)', !(androidJar && await exists(androidJar)) && 'Android SDK Platform 34'].filter(Boolean);
  if (missing.length) return { available: false, code: 'ANDROID_TOOLCHAIN_UNAVAILABLE', reason: `${missing.join(', ')}을 빌드 서버에 설치해 주세요.`, missing };
  return { available: true, sdkPath, javaHome, apiLevel, buildToolsVersion, buildToolsPath, androidJar };
}

export function androidSourceFiles({ projectId, name, files }) {
  if (!UUID.test(projectId || '')) throw new AndroidBuildError('유효한 프로젝트 ID가 필요합니다.', 'ANDROID_INVALID_PROJECT', 400);
  if (!Array.isArray(files) || files.length > 128) throw new AndroidBuildError('모바일 앱 파일 형식이 올바르지 않습니다.', 'ANDROID_INVALID_ASSETS', 400);
  const assets = [], seen = new Set(); let total = 0;
  for (const file of files) {
    // Other project files (server code, .env, credentials) are intentionally never packaged.
    if (typeof file?.path !== 'string' || !file.path.startsWith('public/')) continue;
    const relative = file.path.slice(7);
    if (!/^[A-Za-z0-9_./-]+\.(?:html|js|css|json|svg|png|jpe?g|gif|webp|woff2|txt)$/i.test(relative)
      || relative.includes('..') || relative.includes('//') || relative.startsWith('/') || seen.has(relative)
      || !(typeof file.content === 'string' || Buffer.isBuffer(file.content))) {
      throw new AndroidBuildError('허용되지 않는 모바일 앱 파일 경로 또는 내용입니다.', 'ANDROID_INVALID_ASSETS', 400);
    }
    const size = Buffer.byteLength(file.content); total += size;
    if (size > 5 * 1024 * 1024 || total > SOURCE_LIMIT) throw new AndroidBuildError('모바일 앱 파일은 총 10MB 이하여야 합니다.', 'ANDROID_ASSETS_TOO_LARGE', 413);
    seen.add(relative); assets.push({ path: `android/app/src/main/assets/web/${relative}`, content: file.content });
  }
  if (!seen.has('index.html')) throw new AndroidBuildError('public/index.html 파일이 필요합니다.', 'ANDROID_INVALID_ASSETS', 400);
  const applicationId = `com.launchpad.p${projectId.replaceAll('-', '').toLowerCase()}`;
  const label = String(name || 'Launchpad App').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);
  const stringValue = xml(label.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('"', '\\"'));
  const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  <uses-sdk android:minSdkVersion="23" android:targetSdkVersion="34"/>\n  <application android:label="@string/app_name" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:allowBackup="false" android:usesCleartextTraffic="false" android:supportsRtl="true">\n    <activity android:name="${applicationId}.MainActivity" android:exported="true" android:windowSoftInputMode="adjustResize">\n      <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>\n    </activity>\n  </application>\n</manifest>\n`;
  return [
    { path: 'android/settings.gradle', content: `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS); repositories { google(); mavenCentral() } }\nrootProject.name = 'LaunchpadApp'\ninclude ':app'\n` },
    { path: 'android/build.gradle', content: "plugins { id 'com.android.application' version '8.3.2' apply false }\n" },
    { path: 'android/gradle.properties', content: 'org.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8\nandroid.useAndroidX=false\n' },
    { path: 'android/app/build.gradle', content: `plugins { id 'com.android.application' }\nandroid {\n  namespace '${applicationId}'\n  compileSdk 34\n  defaultConfig { applicationId '${applicationId}'; minSdk 23; targetSdk 34; versionCode 1; versionName '1.0.0' }\n  compileOptions { sourceCompatibility JavaVersion.VERSION_1_8; targetCompatibility JavaVersion.VERSION_1_8 }\n}\n` },
    { path: 'android/app/src/main/AndroidManifest.xml', content: manifest },
    { path: 'android/app/src/main/res/values/strings.xml', content: `<resources><string name="app_name" formatted="false">"${stringValue}"</string></resources>\n` },
    { path: `android/app/src/main/java/${applicationId.replaceAll('.', '/')}/MainActivity.java`, content: JAVA_TEMPLATE.replaceAll('__APPLICATION_ID__', applicationId) },
    { path: 'android/.gitignore', content: '.gradle/\nlocal.properties\n**/build/\n*.jks\n*.keystore\n' },
    { path: 'android/README.md', content: `# Android source\n\nThis app contains the generated web assets in a native Android WebView. It runs offline and stores data on the device. Network access, native JavaScript bridges, file access and external navigation are disabled.\n\nOpen this folder in Android Studio, select JDK 17, install Android SDK Platform 34 and Build Tools 34.0.0, and build the debug APK. Alternatively, with Gradle 8.4 installed, run:\n\n\`\`\`sh\ngradle :app:assembleDebug\n\`\`\`\n\nAndroid Studio can generate the Gradle wrapper. This export has no bundled Gradle distribution or signing keys. Output: app/build/outputs/apk/debug/app-debug.apk. Debug APKs are for testing; configure your own release signing and current store requirements before publishing.\n` },
    ...assets,
  ];
}

function runTool(command, args, { cwd, env, signal, onLog, timeoutMs = 120000 }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stopped = false, done = false;
    const stop = () => {
      if (stopped || done) return; stopped = true;
      if (child.pid && process.platform === 'win32') {
        spawn(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      } else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const timer = setTimeout(stop, timeoutMs);
    const cleanup = () => { done = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    const collect = chunk => { const text = sanitizeLog(chunk.toString()); output = (output + text).slice(-12000); onLog?.(text); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', error => { cleanup(); reject(new AndroidBuildError(`Android 빌드 도구를 실행하지 못했습니다: ${error.code || 'unknown'}`, 'ANDROID_TOOL_ERROR')); });
    child.on('close', code => {
      cleanup();
      if (signal?.aborted) reject(cancelled());
      else if (stopped) reject(new AndroidBuildError('Android 빌드 시간이 초과되었습니다.', 'ANDROID_BUILD_TIMEOUT', 504));
      else if (code !== 0) reject(new AndroidBuildError(`Android 빌드 도구 오류(${path.basename(command)}): ${output}`, 'ANDROID_BUILD_FAILED'));
      else resolve(output);
    });
  });
}

/** Structural validation complements apksigner verification; an arbitrary ZIP is never an APK. */
export async function validateAndroidApk(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 256 || stat.size > 100 * 1024 * 1024) throw new AndroidBuildError('APK 파일 크기가 올바르지 않습니다.', 'ANDROID_INVALID_APK');
  const data = await fs.readFile(filePath);
  if (data.length < 256 || data.length > 100 * 1024 * 1024) throw new AndroidBuildError('APK 파일 크기가 올바르지 않습니다.', 'ANDROID_INVALID_APK');
  let end = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50 && offset + 22 + data.readUInt16LE(offset + 20) === data.length) { end = offset; break; }
  }
  if (end < 0) throw new AndroidBuildError('APK ZIP 구조가 올바르지 않습니다.', 'ANDROID_INVALID_APK');
  const count = data.readUInt16LE(end + 10), entries = new Map();
  let cursor = data.readUInt32LE(end + 16);
  try {
    for (let index = 0; index < count; index++) {
      if (data.readUInt32LE(cursor) !== 0x02014b50) throw new Error('directory');
      const length = data.readUInt16LE(cursor + 28), extra = data.readUInt16LE(cursor + 30), comment = data.readUInt16LE(cursor + 32);
      const name = data.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
      if (entries.has(name) || name.includes('..') || name.includes('\\') || name.includes('\0') || name.startsWith('/')) throw new Error('name');
      entries.set(name, { method: data.readUInt16LE(cursor + 10), size: data.readUInt32LE(cursor + 20), unpacked: data.readUInt32LE(cursor + 24), offset: data.readUInt32LE(cursor + 42) });
      cursor += 46 + length + extra + comment;
    }
    const unpack = name => {
      const entry = entries.get(name);
      if (!entry || entry.unpacked > 10 * 1024 * 1024 || data.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error('entry');
      const begin = entry.offset + 30 + data.readUInt16LE(entry.offset + 26) + data.readUInt16LE(entry.offset + 28);
      const content = data.subarray(begin, begin + entry.size);
      return entry.method === 0 ? content : entry.method === 8 ? inflateRawSync(content, { maxOutputLength: 10 * 1024 * 1024 }) : Buffer.alloc(0);
    };
    if (unpack('AndroidManifest.xml').readUInt32LE(0) !== 0x00080003 || !unpack('classes.dex').subarray(0, 4).equals(Buffer.from('dex\n'))
      || unpack('resources.arsc').readUInt32LE(0) !== 0x000c0002 || !entries.has('assets/web/index.html')) throw new Error('required');
  } catch { throw new AndroidBuildError('실행 가능한 Android APK 구조가 아닙니다.', 'ANDROID_INVALID_APK'); }
  return { size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), entries: [...entries.keys()] };
}

export async function buildAndroidApk({ projectId, name, files, directory, signal, onLog }) {
  if (signal?.aborted) throw cancelled();
  if (activeBuild) throw new AndroidBuildError('다른 APK를 빌드 중입니다. 잠시 후 다시 시도해 주세요.', 'ANDROID_BUILD_BUSY', 429);
  const sources = androidSourceFiles({ projectId, name, files });
  const toolchain = await inspectAndroidToolchain();
  if (!toolchain.available) throw new AndroidBuildError(toolchain.reason, 'ANDROID_TOOLCHAIN_UNAVAILABLE', 503);
  // Check again after asynchronous tool discovery to enforce a one-job process limit.
  if (activeBuild) throw new AndroidBuildError('다른 APK를 빌드 중입니다. 잠시 후 다시 시도해 주세요.', 'ANDROID_BUILD_BUSY', 429);
  activeBuild = true;
  let logs = '';
  const log = text => { logs = (logs + sanitizeLog(text)).slice(-12000); onLog?.(sanitizeLog(text)); };
  try {
    if (!directory || !path.isAbsolute(directory)) throw new AndroidBuildError('APK 빌드 경로는 절대 경로여야 합니다.', 'ANDROID_INVALID_DIRECTORY', 400);
    await fs.mkdir(directory, { recursive: true });
    const workspace = await fs.mkdtemp(path.join(await fs.realpath(directory), 'apk-'));
    for (const source of sources) {
      const destination = path.join(workspace, source.path);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, source.content, { flag: 'wx' });
    }
    const sourceRoot = path.join(workspace, 'android/app/src/main');
    const work = path.join(workspace, 'build');
    await fs.mkdir(work);
    const androidJar = toolchain.androidJar;
    for (const folder of ['classes', 'dex']) await fs.mkdir(path.join(work, folder));
    const applicationId = `com.launchpad.p${projectId.replaceAll('-', '').toLowerCase()}`;
    // Modern Gradle injects applicationId; raw aapt2 needs it in its intermediate manifest.
    const buildManifest = path.join(work, 'AndroidManifest.xml');
    await fs.writeFile(buildManifest, (await fs.readFile(path.join(sourceRoot, 'AndroidManifest.xml'), 'utf8')).replace('<manifest ', `<manifest package="${applicationId}" `));
    const java = path.join(toolchain.javaHome, 'bin', `java${EXT}`);
    const bin = command => path.join(toolchain.javaHome, 'bin', `${command}${EXT}`);
    const sdkbin = command => path.join(toolchain.buildToolsPath, `${command}${EXT}`);
    const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    env.JAVA_HOME = toolchain.javaHome; env.ANDROID_HOME = toolchain.sdkPath;
    const run = (command, args) => runTool(command, args, { cwd: workspace, env, signal, onLog: log });
    log('Android 리소스를 패키징합니다.\n');
    await run(sdkbin('aapt2'), ['compile', '--dir', path.join(sourceRoot, 'res'), '-o', path.join(work, 'resources.zip')]);
    await run(sdkbin('aapt2'), ['link', '-o', path.join(work, 'unsigned.apk'), '-I', androidJar, '--manifest', buildManifest, '-R', path.join(work, 'resources.zip'), '--auto-add-overlay', '--version-code', '1', '--version-name', '1.0.0']);
    log('신뢰된 Android WebView 런타임을 컴파일합니다.\n');
    await run(bin('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-bootclasspath', androidJar, '-d', path.join(work, 'classes'), path.join(sourceRoot, 'java', applicationId.replaceAll('.', '/'), 'MainActivity.java')]);
    await run(bin('jar'), ['cf', path.join(work, 'classes.jar'), '-C', path.join(work, 'classes'), '.']);
    await run(java, ['-Xmx768m', '-cp', path.join(toolchain.buildToolsPath, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--min-api', '23', '--lib', androidJar, '--output', path.join(work, 'dex'), path.join(work, 'classes.jar')]);
    // jar normalizes asset separators to '/', including on Windows SDK versions whose
    // aapt2 -A output otherwise embeds literal backslashes that AssetManager cannot load.
    await run(bin('jar'), ['uf', path.join(work, 'unsigned.apk'), '-C', path.join(work, 'dex'), 'classes.dex', '-C', sourceRoot, 'assets']);
    await run(sdkbin('zipalign'), ['-f', '4', path.join(work, 'unsigned.apk'), path.join(work, 'aligned.apk')]);
    log('개발용 키로 APK에 서명합니다.\n');
    // Reuse a project's local debug key so a rebuild can update the installed app.
    // It stays outside the exported source list and never carries production credentials.
    const keyFile = path.join(await fs.realpath(directory), `.android-debug-${projectId}.keystore`);
    if (!await exists(keyFile)) await run(bin('keytool'), ['-genkeypair', '-keystore', keyFile, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Launchpad,C=US', '-noprompt']);
    const filename = `launchpad-${projectId.slice(0, 8)}-debug.apk`;
    const artifact = path.join(workspace, filename);
    const signer = path.join(toolchain.buildToolsPath, 'lib/apksigner.jar');
    await run(java, ['-jar', signer, 'sign', '--ks', keyFile, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', artifact, path.join(work, 'aligned.apk')]);
    await run(java, ['-jar', signer, 'verify', '--verbose', artifact]);
    await run(sdkbin('zipalign'), ['-c', '4', artifact]);
    const validation = await validateAndroidApk(artifact);
    if (signal?.aborted) throw cancelled();
    log('APK 서명과 패키지 검증을 통과했습니다.\n');
    return { path: artifact, filename, size: validation.size, sha256: validation.sha256, applicationId, mode: 'debug', signatureVerified: true, builtAt: new Date().toISOString(), logs };
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw cancelled();
    if (error instanceof AndroidBuildError) throw error;
    throw new AndroidBuildError(`APK 빌드에 실패했습니다: ${sanitizeLog(error.message)}`);
  } finally { activeBuild = false; }
}
