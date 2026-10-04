// Run only after build-atelier-mobile.mjs, with an already running dedicated test emulator.
// This script never starts, resets or shuts down a device, and only installs/launches this sample package.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {inspectAndroidToolchain} from '../server/android-builder.mjs';
import {readMobileSample} from './build-atelier-mobile.mjs';

const execute=promisify(execFile),root=fileURLToPath(new URL('../samples/atelier-mobile/',import.meta.url));
const reportPath=path.join(root,'apk-build-report.json'),artifactPath=path.join(root,'atelier-mobile.apk');
const serial=process.argv.find(value=>value.startsWith('--serial='))?.slice(9)||'emulator-5562';
if(!/^emulator-\d+$/.test(serial))throw new Error('Select a dedicated Android emulator serial, such as emulator-5562.');
const report=JSON.parse(await fs.readFile(reportPath,'utf8'));
if(report.status!=='completed'||!report.signatureVerified||!/^com\.launchpad\.p[a-f0-9]{32}$/.test(report.applicationId))throw new Error('Build and verify the mobile APK first.');
if(crypto.createHash('sha256').update(await fs.readFile(artifactPath)).digest('hex')!==report.sha256)throw new Error('APK hash does not match the build report.');
if((await readMobileSample()).snapshotHash!==report.snapshotHash)throw new Error('The app source changed after this APK was built. Rebuild before testing.');
const toolchain=await inspectAndroidToolchain();if(!toolchain.available)throw new Error(toolchain.reason);
const adbPath=path.join(toolchain.sdkPath,'platform-tools',process.platform==='win32'?'adb.exe':'adb');
const environment=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','HOME','ANDROID_ADB_SERVER_PORT'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
const adb=async(args,options={})=>(await execute(adbPath,['-s',serial,...args],{windowsHide:true,timeout:60000,maxBuffer:8*1024*1024,encoding:'utf8',env:environment,...options})).stdout;
if((await adb(['shell','getprop','sys.boot_completed'])).trim()!=='1')throw new Error('The selected emulator is not fully booted.');
const api=(await adb(['shell','getprop','ro.build.version.sdk'])).trim();
const installed=await adb(['install','-r',artifactPath]);if(!/Success/.test(installed))throw new Error('APK installation did not succeed.');
await adb(['shell','input','keyevent','KEYCODE_WAKEUP']);await adb(['shell','wm','dismiss-keyguard']);
await adb(['shell','am','force-stop',report.applicationId]);
const started=await adb(['shell','am','start','-W','-n',`${report.applicationId}/${report.applicationId}.MainActivity`]);
if(!/Status:\s*ok/.test(started))throw new Error('Android activity did not launch successfully.');
// A short rendering interval allows the bundled WebView scripts and local images to paint.
await new Promise(resolve=>setTimeout(resolve,2000));
const pid=(await adb(['shell','pidof',report.applicationId])).trim();if(!/^\d+$/.test(pid))throw new Error('The application process is not running.');
// Android 16 places current focus in the full window dump rather than its windows section.
const windows=await adb(['shell','dumpsys','window']);
if(!windows.split(/\r?\n/).some(line=>/mCurrentFocus|mFocusedApp|mTopFocusedDisplayId/.test(line)&&line.includes(report.applicationId)))throw new Error('The tested application is not the foreground activity.');
const screenshot=await adb(['exec-out','screencap','-p'],{encoding:'buffer'});
if(!screenshot.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Android screenshot output is not a PNG.');
const screenshotDirectory=path.join(root,'screenshots');await fs.mkdir(screenshotDirectory,{recursive:true});
await fs.writeFile(path.join(screenshotDirectory,'android-home.png'),screenshot);
const runtimeLog=await adb(['logcat','-d',`--pid=${pid}`,'-v','brief']);
await fs.writeFile(path.join(root,'android-runtime.log'),runtimeLog.slice(-24000));
if(/FATAL EXCEPTION|Uncaught (?:ReferenceError|SyntaxError|TypeError)/.test(runtimeLog))throw new Error('Android application logs contain a fatal or uncaught JavaScript error.');
const checks=[{name:'android-install',passed:true,detail:'The verified APK installed successfully in the dedicated emulator.'},
  {name:'android-launch',passed:true,detail:'Activity startup returned Status: ok and the application owns the foreground window.'},
  {name:'android-runtime-errors',passed:true,detail:'No fatal exception or uncaught JavaScript error was found in this process log.'}];
report.runtimeVerification={status:'needs-visual-review',verifiedAt:new Date().toISOString(),device:{serial,apiLevel:Number(api),headless:true},checks,screenshot:'screenshots/android-home.png',log:'android-runtime.log',
  detail:'Inspect the screenshot to confirm the intended home UI and bundled product image. Process startup alone does not verify image rendering.'};
await fs.writeFile(reportPath+'.tmp',JSON.stringify(report,null,2)+'\n');await fs.rename(reportPath+'.tmp',reportPath);
console.log(JSON.stringify(report.runtimeVerification,null,2));
