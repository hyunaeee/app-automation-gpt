import test from 'node:test';
import assert from 'node:assert/strict';
import {openAIImageProvider,validateImageData,MAX_IMAGE_BYTES} from '../server/image-provider.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0YQAAAAASUVORK5CYII=';
const ready={resolve:async()=>({hasImage:true,roles:{image:'gpt-image-2.5-flare'}})};
test('image generation is opt-in per task and unavailable credentials or capabilities never call an image API',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;throw Error('must-not-call');};
  assert.equal((await openAIImageProvider({apiKey:'key',router:ready,fetchImpl}).generate({prompt:'가방 제품 사진'})).status,'skipped');
  assert.equal((await openAIImageProvider({router:ready,fetchImpl}).generate({prompt:'가방 제품 사진',needed:true})).status,'skipped');
  assert.equal((await openAIImageProvider({apiKey:'key',router:{resolve:async()=>({hasImage:false,roles:{image:null}})},fetchImpl}).generate({prompt:'가방 제품 사진',needed:true})).status,'skipped');
  assert.equal(calls,0);
});

test('one required image uses documented API fields and returns bounded raster data with actual model usage',async()=>{
  const events=[];let calls=0;
  const provider=openAIImageProvider({apiKey:'server-secret',router:ready,fetchImpl:async(url,init)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/images/generations');assert.equal(init.headers.Authorization,'Bearer server-secret');assert.equal(init.redirect,'error');
    assert.deepEqual(JSON.parse(init.body),{model:'gpt-image-2.5-flare',prompt:'캔버스 가방 제품 사진',n:1,size:'1024x1024',quality:'medium',output_format:'jpeg',output_compression:80});
    return new Response(JSON.stringify({data:[{b64_json:png}],output_format:'png'}));
  }});
  const image=await provider.generate({prompt:'캔버스 가방 제품 사진',needed:true,onModelUsed:event=>events.push(event)});
  assert.equal(calls,1);assert.equal(image.status,'completed');assert.equal(image.mimeType,'image/png');assert.ok(image.dataUrl.startsWith('data:image/png;base64,'));assert.ok(image.bytes<MAX_IMAGE_BYTES);
  assert.equal(events[0].model,'gpt-image-2.5-flare');assert.equal(events[0].capability,'image');assert.equal(events[0].status,'completed');assert.doesNotMatch(JSON.stringify(image),/server-secret/);
});

test('image validation rejects text, SVG, remote URLs, malformed base64, huge data and oversized dimensions',()=>{
  for(const value of ['https://example.com/picture.png',Buffer.from('<svg></svg>').toString('base64'),'not base64!',png+'=',Buffer.alloc(MAX_IMAGE_BYTES+1).toString('base64')])assert.throws(()=>validateImageData(value));
  const huge=Buffer.from(png,'base64');huge.writeUInt32BE(5000,16);assert.throws(()=>validateImageData(huge.toString('base64')));
});

test('image HTTP failures, oversized responses and network errors never echo secrets or try another model',async()=>{
  for(const response of [new Response('private-upstream',{status:403}),new Response(JSON.stringify({data:[{url:'https://example.com/fake.png'}]})),new Response('{}',{headers:{'content-length':String(MAX_IMAGE_BYTES*3)}})]){
    let calls=0;const events=[],provider=openAIImageProvider({apiKey:'private-key',router:ready,fetchImpl:async()=>{calls++;return response;}});
    await assert.rejects(provider.generate({prompt:'가방 제품 이미지를 생성해줘',needed:true,onModelUsed:event=>events.push(event)}),error=>!/private-upstream|private-key/.test(error.message));
    assert.equal(calls,1);assert.equal(events[0].status,'failed');
  }
  const failing=openAIImageProvider({apiKey:'private-key',router:ready,fetchImpl:async()=>{throw Error('network leaked private-key');}});
  await assert.rejects(failing.generate({prompt:'가방 제품 이미지',needed:true}),error=>!error.message.includes('private-key'));
});
