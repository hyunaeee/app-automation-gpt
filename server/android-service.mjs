// Optional SDK-equipped build host for a Vercel deployment. Run behind HTTPS.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildAndroidApk, inspectAndroidToolchain } from './android-builder.mjs';
const token=process.env.ANDROID_BUILDER_TOKEN;
if(!token || token.length<32)throw new Error('ANDROID_BUILDER_TOKEN must contain at least 32 characters.');
const digest=value=>crypto.createHash('sha256').update(value).digest();
const root=path.resolve(process.env.ANDROID_BUILD_DATA||'.data/android-service');
http.createServer(async(req,res)=>{
  try{
    if(!crypto.timingSafeEqual(digest(req.headers.authorization||''),digest(`Bearer ${token}`))){res.writeHead(401);return res.end();}
    if(req.method==='GET'&&req.url==='/health'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({available:(await inspectAndroidToolchain()).available}));}
    if(req.method!=='POST'||req.url!=='/build'){res.writeHead(404);return res.end();}
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>650000)throw Object.assign(new Error('Too large'),{status:413});chunks.push(chunk);}
    const input=JSON.parse(Buffer.concat(chunks).toString());
    if(!/^[a-f0-9-]{36}$/i.test(input.projectId||''))throw Object.assign(new Error('Invalid project'),{status:400});
    const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
    const built=await buildAndroidApk({...input,directory:path.join(root,input.projectId),signal:controller.signal});
    res.writeHead(200,{'Content-Type':'application/vnd.android.package-archive','Content-Length':built.size,'X-APK-SHA256':built.sha256,'Cache-Control':'no-store'});res.end(await fs.readFile(built.path));
  }catch(error){if(!res.headersSent)res.writeHead(error.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'APK build failed',code:error.code||'BUILD_FAILED'}));}
}).listen(Number(process.env.ANDROID_BUILDER_PORT||3002),process.env.ANDROID_BUILDER_HOST||'127.0.0.1',()=>console.log('Launchpad Android builder ready'));
