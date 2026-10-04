import { IMAGE_MODELS, createModelRouter } from './model-router.mjs';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const error = (status, message) => Object.assign(new Error(message), {status});

export function validateImageData(value) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw error(502, '이미지 응답 크기 또는 형식이 올바르지 않습니다.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value) throw error(502, '이미지 응답 크기 또는 형식이 올바르지 않습니다.');
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.subarray(12,16).toString('ascii') === 'IHDR';
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  if (!png && !jpeg) throw error(502, 'PNG 또는 JPEG 이미지 응답이 필요합니다.');
  if (png && (!bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16)>4096 || bytes.readUInt32BE(20)>4096)) throw error(502, '이미지 해상도가 허용 범위를 벗어났습니다.');
  const mimeType = png ? 'image/png' : 'image/jpeg';
  return { dataUrl: `data:${mimeType};base64,${value}`, mimeType, bytes: bytes.length };
}

async function boundedJson(response) {
  const limit = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 65536;
  if (Number(response.headers.get('content-length')) > limit) throw error(502, '이미지 응답 크기가 너무 큽니다.');
  const reader = response.body?.getReader();
  if (!reader) throw error(502, '이미지 응답이 비어 있습니다.');
  let size=0; const chunks=[];
  try {
    while (true) { const {value,done}=await reader.read(); if(done)break; size+=value.length; if(size>limit)throw error(502,'이미지 응답 크기가 너무 큽니다.');chunks.push(Buffer.from(value)); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error(502,'이미지 응답 형식이 올바르지 않습니다.'); }
  } finally { await reader.cancel().catch(()=>{}); }
}

export function openAIImageProvider({apiKey, model, fetchImpl=(...args)=>fetch(...args), router=createModelRouter({apiKey,fetchImpl,...(model ? {roleModels:{image:model}} : {})})}={}) {
  return {
    async generate({prompt,needed=false,signal,onModelUsed}={}) {
      const emit = event => onModelUsed?.({stage:'images',capability:'image',...event});
      if (needed !== true || !apiKey) {
        const reason = needed !== true ? '이 프로젝트에는 이미지 생성이 필요하지 않아 건너뛰었습니다.' : '별도의 OpenAI API 키가 없어 이미지 생성을 건너뛰었습니다.';
        await emit({model:null,status:'skipped',detail:reason});return {status:'skipped',model:null,reason};
      }
      if (typeof prompt !== 'string' || prompt.trim().length < 5 || prompt.length > 6000) throw error(400,'이미지 설명을 5자 이상 6,000자 이하로 입력해 주세요.');
      let selected = null;
      try {
        const capabilities=await router.resolve({signal});selected=capabilities.roles.image;
        if (!capabilities.hasImage || !selected) {
          const reason='계정에서 사용 가능한 이미지 모델이 확인되지 않아 이미지 생성을 건너뛰었습니다.';
          await emit({model:null,status:'skipped',detail:reason});return {status:'skipped',model:null,reason};
        }
        if (!IMAGE_MODELS.includes(selected)) throw error(400,'지원하지 않는 이미지 모델입니다.');
        const response=await fetchImpl('https://api.openai.com/v1/images/generations',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
          signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(180000)]),
          body:JSON.stringify({model:selected,prompt:prompt.trim(),n:1,size:'1024x1024',quality:'medium',output_format:'jpeg',output_compression:80})});
        if(!response.ok)throw error(response.status,`OpenAI 이미지 요청 실패 (HTTP ${response.status}). API 권한과 사용 한도를 확인해 주세요.`);
        const result=await boundedJson(response);
        if(result.error || !Array.isArray(result.data) || result.data.length!==1)throw error(502,'이미지 모델이 완성된 이미지 한 장을 반환하지 않았습니다.');
        const image=validateImageData(result.data[0]?.b64_json);
        await emit({model:selected,status:'completed',detail:'이미지 API에서 새 시각 자산 한 장을 생성했습니다. 이미지 사용료는 별도입니다.'});
        return {status:'completed',model:selected,...image};
      } catch(failure) {
        await emit({model:selected,status:'failed',detail:signal?.aborted?'이미지 생성이 취소되었습니다.':'이미지 생성을 완료하지 못했습니다. 다른 모델로 자동 재시도하지 않습니다.'});
        if(signal?.aborted)throw error(499,'이미지 생성이 취소되었습니다.');
        if(failure.status)throw failure;
        throw error(502,'이미지 생성 요청을 완료하지 못했습니다. 연결 상태와 API 설정을 확인해 주세요.');
      }
    },
  };
}
