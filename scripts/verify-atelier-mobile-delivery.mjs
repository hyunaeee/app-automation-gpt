import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const workspace=fileURLToPath(new URL('../',import.meta.url));
const root=path.join(workspace,'samples/atelier-mobile');
const base=process.env.ATELIER_WORKSPACE_URL||'http://127.0.0.1:3001';
const expected=JSON.parse(await fs.readFile(path.join(workspace,'.data/atelier-mobile-project.json'),'utf8'));
const checks=[];
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
async function get(route){const response=await fetch(base+route,{signal:AbortSignal.timeout(10000)});assert.equal(response.status,200,route);return response;}
async function check(name,run){await run();checks.push({name,passed:true});}
await check('저장한 모바일 프로젝트와 소스 일치',async()=>{const actual=await(await get('/api/projects/'+expected.id)).json();assert.equal(actual.kind,'mobile-app');assert.equal(actual.status,'completed');assert.deepEqual(actual.files,expected.files);});
await check('프로젝트 APK 다운로드 및 무결성',async()=>{const status=await(await get(`/api/projects/${expected.id}/android`)).json();assert.equal(status.status,'ready');const response=await get(`/api/projects/${expected.id}/android/apk`);assert.match(response.headers.get('content-disposition'),/attachment/i);assert.equal(digest(Buffer.from(await response.arrayBuffer())),expected.android.sha256);});
await check('갤러리 앱과 검증한 소스 일치',async()=>{const actual=await(await get('/examples/atelier-mobile/sample.json')).json();assert.equal(actual.verified,true);assert.deepEqual(actual.files,expected.files.filter(file=>file.path.startsWith('public/')));});
await check('갤러리 APK와 프로젝트 APK 동일',async()=>{const response=await get('/examples/atelier-mobile/atelier-mobile.apk');assert.equal(digest(Buffer.from(await response.arrayBuffer())),expected.android.sha256);});
await check('소스 ZIP 제공',async()=>{const response=await get('/examples/atelier-mobile/source.zip');const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),'PK');assert.equal(digest(bytes),digest(await fs.readFile(path.join(root,'source.zip'))));});
await check('레퍼런스 원본과 프롬프트 제공',async()=>{const response=await get('/examples/atelier-mobile/reference-v1.png');assert.equal(digest(Buffer.from(await response.arrayBuffer())),digest(await fs.readFile(path.join(root,'design/reference-v1.png'))));const prompt=await(await get('/examples/atelier-mobile/image-prompt.json')).json();assert.equal(prompt.mode,'built-in image_gen');assert.ok(prompt.prompt.includes('ui-mockup'));assert.equal(prompt.source,undefined);});
const report={verifiedAt:new Date().toISOString(),projectId:expected.id,base,checks};
await fs.writeFile(path.join(root,'delivery-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
