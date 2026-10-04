// Usage: node scripts/build-atelier-mobile.mjs [--check]
// Uses installed SDK tools only. Signing keys and intermediate files stay under .data/.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { androidSourceFiles, inspectAndroidToolchain, buildAndroidApk, validateAndroidApk } from '../server/android-builder.mjs';
import { mobileSourceHash } from '../server/mobile-builds.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const sampleDirectory = path.join(repository, 'samples/atelier-mobile');
const appDirectory = path.join(sampleDirectory, 'app');
const artifactPath = path.join(sampleDirectory, 'atelier-mobile.apk');
const reportPath = path.join(sampleDirectory, 'apk-build-report.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => { const relative=path.relative(parent,child); return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative); };
const readJSON = async filename => JSON.parse((await fs.readFile(filename,'utf8')).replace(/^\uFEFF/,''));

export async function readMobileSample(directory = appDirectory) {
  const realApp=await fs.realpath(directory),realPublic=await fs.realpath(path.join(realApp,'public'));
  if (!inside(realApp,realPublic)) throw new Error('The public directory must stay inside the sample app.');
  const metadataFile=path.join(realApp,'project.json');
  if ((await fs.stat(metadataFile)).size>65536) throw new Error('Project metadata is too large.');
  const metadata=await readJSON(metadataFile);
  if (metadata.kind!=='mobile-app'||typeof metadata.name!=='string'||!metadata.name.trim()||metadata.name.length>100) throw new Error('project.json must identify a named mobile-app project.');
  const files=[];
  async function visit(folder) {
    for (const entry of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('Symbolic links cannot be packaged in the mobile sample.');
      const filename=path.join(folder,entry.name),realFile=await fs.realpath(filename);
      if (!inside(realPublic,realFile)) throw new Error('An asset escapes the public directory.');
      if (entry.isDirectory()) { await visit(filename); continue; }
      if (!entry.isFile()) throw new Error('Only regular public asset files are supported.');
      if ((await fs.stat(filename)).size>5*1024*1024) throw new Error('An asset exceeds the 5MB limit.');
      files.push({path:'public/'+path.relative(realPublic,realFile).split(path.sep).join('/'),content:await fs.readFile(realFile)});
      if(files.length>128)throw new Error('The mobile sample has too many assets.');
    }
  }
  await visit(realPublic);
  for(const required of ['public/index.html','public/app.js','public/styles.css'])if(!files.some(file=>file.path===required))throw new Error(`${required} is not ready.`);
  // Reuse the native builder's complete allowlist, UUID, individual-file and total-size checks.
  androidSourceFiles({projectId:metadata.id,name:metadata.name,files});
  const assets=files.map(file=>({path:file.path,bytes:file.content.length,sha256:sha256(file.content)}));
  const canonicalOrder=['public/index.html','public/app.js','public/styles.css','public/design-assets.js'];
  const ordered=[...files].sort((a,b)=>(canonicalOrder.indexOf(a.path)<0?999:canonicalOrder.indexOf(a.path))-(canonicalOrder.indexOf(b.path)<0?999:canonicalOrder.indexOf(b.path))||a.path.localeCompare(b.path));
  const projectFiles=ordered.map(file=>({path:file.path,content:file.content.toString('utf8'),language:file.path.endsWith('.html')?'html':file.path.endsWith('.css')?'css':file.path.endsWith('.js')?'javascript':'text'}));
  return {metadata,files,assets,sourceHash:mobileSourceHash({files:projectFiles}),snapshotHash:sha256(JSON.stringify({id:metadata.id,name:metadata.name,kind:metadata.kind,assets}))};
}

export async function inspectMobileBuild() {
  const toolchain=await inspectAndroidToolchain();
  try {
    const source=await readMobileSample();
    return {ready:toolchain.available,appReady:true,toolchain,projectId:source.metadata.id,name:source.metadata.name,assets:source.assets,sourceHash:source.sourceHash};
  } catch(error) {
    return {ready:false,appReady:false,toolchain,reason:error.code==='ENOENT'?'The mobile sample app is not ready yet.':error.message};
  }
}

async function verifyCopiedArtifact(toolchain, filename, expectedApplicationId) {
  const extension=process.platform==='win32'?'.exe':'';
  const env=Object.fromEntries(['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','LANG'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
  const options={windowsHide:true,timeout:30000,maxBuffer:512*1024,env};
  const signature=await execute(path.join(toolchain.javaHome,'bin',`java${extension}`),['-jar',path.join(toolchain.buildToolsPath,'lib/apksigner.jar'),'verify','--verbose','--print-certs',filename],options);
  const certificateDN=signature.stdout.match(/^Signer #1 certificate DN:\s*(.+)$/m)?.[1]?.trim();
  if (!certificateDN||!certificateDN.includes('CN=Android Debug')||!certificateDN.includes('O=Launchpad')) throw new Error('APK signature does not use the expected local development certificate.');
  const packageInfo=await execute(path.join(toolchain.buildToolsPath,`aapt2${extension}`),['dump','badging',filename],options);
  const applicationId=packageInfo.stdout.match(/^package: name='([^']+)'/m)?.[1];
  if(applicationId!==expectedApplicationId)throw new Error('Packaged application ID does not match project metadata.');
  return {signature:{verified:true,mode:'debug',certificateDN,certificateSha256:signature.stdout.match(/^Signer #1 certificate SHA-256 digest:\s*(.+)$/m)?.[1]?.trim()||null,output:signature.stdout.trim()},applicationId};
}

export async function buildAtelierMobile({signal,onLog=text=>process.stderr.write(text)}={}) {
  // Reading and validating the finished app precedes every build, so an incomplete sample cannot start compilation.
  const source=await readMobileSample(),toolchain=await inspectAndroidToolchain();
  if(!toolchain.available)throw new Error(toolchain.reason);
  const built=await buildAndroidApk({projectId:source.metadata.id,name:source.metadata.name,files:source.files,
    directory:path.join(repository,'.data/atelier-mobile-android',source.metadata.id),signal,onLog});
  if(!built.signatureVerified||built.mode!=='debug')throw new Error('The native builder did not verify a debug signature.');
  if((await readMobileSample()).snapshotHash!==source.snapshotHash)throw new Error('Sample assets changed during compilation. Rebuild after the app is ready.');
  const structure=await validateAndroidApk(built.path);
  const missing=source.assets.filter(asset=>!structure.entries.includes('assets/web/'+asset.path.slice(7)));
  if(missing.length)throw new Error('The APK is missing one or more bundled public assets.');
  const temporaryArtifact=artifactPath+'.tmp';
  await fs.copyFile(built.path,temporaryArtifact);
  const copied=await validateAndroidApk(temporaryArtifact);
  if(copied.sha256!==built.sha256)throw new Error('Copied APK failed SHA-256 verification.');
  const checked=await verifyCopiedArtifact(toolchain,temporaryArtifact,built.applicationId);
  await fs.rename(temporaryArtifact,artifactPath);
  const report={status:'completed',projectId:source.metadata.id,filename:'atelier-mobile.apk',sha256:copied.sha256,size:copied.size,builtAt:built.builtAt,signatureVerified:true,mode:'debug',applicationId:checked.applicationId,
    project:{id:source.metadata.id,name:source.metadata.name,kind:'mobile-app'},
    artifact:{path:'atelier-mobile.apk',size:copied.size,sha256:copied.sha256,applicationId:checked.applicationId,mode:'debug'},
    signature:checked.signature,sourceHash:source.sourceHash,snapshotHash:source.snapshotHash,sourceFileSha256:Object.fromEntries(source.assets.map(asset=>[asset.path,asset.sha256])),assets:source.assets,
    checks:[{name:'native-apk-structure',passed:true,detail:'Compiled AndroidManifest.xml, classes.dex and resources.arsc verified.'},
      {name:'bundled-offline-assets',passed:true,detail:`All ${source.assets.length} public assets are packaged under assets/web/.`},
      {name:'debug-signature',passed:true,detail:'apksigner verify --verbose --print-certs succeeded with the expected development certificate.'},
      {name:'artifact-integrity',passed:true,detail:'The exported APK SHA-256 equals the verified build artifact.'}],
    toolchain:{apiLevel:toolchain.apiLevel,buildToolsVersion:toolchain.buildToolsVersion},
    runtimeVerification:{status:'not-run',detail:'Compilation and signature checks do not certify Android UI behavior. Record emulator or device checks separately.'},
    limitations:['Development-signed APK for installation and testing; not a Play Store release build.','The application packages device-local web assets. Browser and Android local storage are independent.'],logs:built.logs};
  await fs.writeFile(reportPath+'.tmp',JSON.stringify(report,null,2)+'\n');await fs.rename(reportPath+'.tmp',reportPath);
  return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    if(process.argv.includes('--check'))console.log(JSON.stringify(await inspectMobileBuild(),null,2));
    else {
      const controller=new AbortController(),stop=()=>controller.abort(new Error('Build cancelled.'));
      process.once('SIGINT',stop);process.once('SIGTERM',stop);
      try { const result=await buildAtelierMobile({signal:AbortSignal.any([controller.signal,AbortSignal.timeout(240000)])});console.log(JSON.stringify({status:result.status,artifact:artifactPath,report:reportPath,sha256:result.artifact.sha256,signatureVerified:result.signature.verified},null,2)); }
      finally { process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop); }
    }
  } catch(error) { console.error(JSON.stringify({status:'failed',message:error.message}));process.exitCode=1; }
}
