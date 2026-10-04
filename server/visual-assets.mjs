import { isFashionProject } from './fashion-template.mjs';

export const DESIGN_ASSET_PATH = 'public/design-assets.js';
const prefix = 'globalThis.__LAUNCHPAD_DESIGN_ASSETS__ = ';
const suffix = ';\n';
const maxImageBytes = 3 * 1024 * 1024;

export function validateImageDataUrl(value) {
  if (typeof value !== 'string' || value.length > maxImageBytes * 1.4) throw new Error('이미지 파일 크기가 허용 범위를 벗어났습니다.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('지원하지 않는 이미지 형식입니다.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length < 12 || bytes.length > maxImageBytes || bytes.toString('base64') !== match[2]) throw new Error('이미지 데이터가 올바르지 않습니다.');
  const signature = match[1] === 'png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  if (!signature) throw new Error('이미지 헤더와 파일 형식이 일치하지 않습니다.');
  return value;
}

// The renderer is trusted application code. Models can only supply image bytes, never this script.
const renderer = `(() => {
  const assets = globalThis.__LAUNCHPAD_DESIGN_ASSETS__;
  if (!assets.hero) return;
  const mount = () => {
    let targets = [...document.querySelectorAll('img[data-launchpad-image="hero"]')];
    if (!targets.length && !document.querySelector('#design-image')) {
      const workspace = document.querySelector('.design-panel') || document.querySelector('main');
      if (!workspace || !workspace.children.length) return;
      let figure = workspace.querySelector('[data-launchpad-visual]');
      if (!figure) {
        figure = document.createElement('figure'); figure.setAttribute('data-launchpad-visual','');
        figure.style.cssText='margin:18px 20px 24px;border-radius:14px;overflow:hidden;background:#f3eee6;border:1px solid #ddd4c7';
        const image = document.createElement('img');image.setAttribute('data-launchpad-image','hero');image.alt='AI가 생성한 디자인 콘셉트 이미지';image.style.cssText='width:100%;max-height:560px;display:block;object-fit:contain';
        const caption = document.createElement('figcaption');caption.textContent='AI 생성 콘셉트 · 입력 치수의 자동 실측이나 생산 도면이 아닙니다.';caption.style.cssText='padding:12px 16px;color:#62594f;font:12px/1.7 system-ui';
        figure.append(image,caption);workspace.prepend(figure);
      }
      targets = [...figure.querySelectorAll('img')];
    }
    for (const image of targets) if (image.getAttribute('src') !== assets.hero) image.setAttribute('src',assets.hero);
  };
  const start = () => {mount();new MutationObserver(mount).observe(document.body,{childList:true,subtree:true});};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();\n`;

export function createDesignAssetFile(assets) {
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) throw new Error('이미지 자산 목록이 올바르지 않습니다.');
  const entries = Object.entries(assets);
  if (!entries.length || entries.length > 3 || entries.some(([key]) => !['hero','bag','top'].includes(key))) throw new Error('허용되지 않은 이미지 자산입니다.');
  const clean = Object.fromEntries(entries.map(([key,value])=>[key,validateImageDataUrl(value)]));
  if (JSON.stringify(clean).length > 9 * 1024 * 1024) throw new Error('이미지 자산 전체 크기가 너무 큽니다.');
  return {path:DESIGN_ASSET_PATH,language:'javascript',content:prefix+JSON.stringify(clean)+suffix+renderer};
}

export function validateDesignAssetFile(file) {
  if (!file || file.path !== DESIGN_ASSET_PATH || typeof file.content !== 'string' || !file.content.startsWith(prefix) || !file.content.endsWith(suffix+renderer)) throw new Error('신뢰된 이미지 자산 파일 형식이 아닙니다.');
  const data = JSON.parse(file.content.slice(prefix.length,-(suffix+renderer).length));
  return createDesignAssetFile(data);
}

export function attachDesignAssets(files, assetFile) {
  const asset = validateDesignAssetFile(assetFile);
  const tag = '<script src="design-assets.js"></script>';
  let attached = false;
  const result = files.filter(file=>file.path!==DESIGN_ASSET_PATH).map(file=>{
    if(file.path!=='public/index.html') return file;
    let html=file.content.replace(/<script\b[^>]*\bsrc=["']\/?design-assets\.js["'][^>]*>\s*<\/script>/gi,'');
    if(!/<\/head>/i.test(html)) throw new Error('이미지를 연결할 HTML 문서가 없습니다.');
    html=html.replace(/<\/head>/i,tag+'</head>');attached=true;
    return {...file,content:html};
  });
  if(!attached)throw new Error('이미지를 연결할 HTML 파일이 없습니다.');
  return [...result,asset];
}

export function inferVisualPlan(project) {
  const source = String(project.prompt || '');
  if(project.kind==='ai-agent' && ['api','mcp'].includes(project.agentDelivery)) return null;
  const fashion = isFashionProject(source,project.kind);
  const explicit = /(?:이미지|일러스트|제품\s*사진|비주얼|히어로\s*사진|image|illustration|product\s*photo).{0,35}(?:생성|만들|디자인|generate|create)|(?:생성|만들).{0,25}(?:이미지|일러스트)|hero\s*image/i.test(source);
  if(!fashion&&!explicit)return null;
  return {
    needed:true,slot:fashion?'bag':'hero',reason:fashion?'가방·의류 디자인을 이해할 콘셉트 이미지가 필요합니다.':'요구사항에 이미지 또는 일러스트 생성이 포함되어 있습니다.',
    prompt: `Create a high-quality ${fashion?'natural canvas tote bag fashion product concept photograph, warm ivory studio, believable fabric and construction, full bag with two long handles, 3/4 view':'editorial visual for a web or mobile application'}. Use tasteful composition, clear subject and soft light. No UI screenshot, text, logo, watermark, measurements, diagram or production pattern. This is a static visual concept, not a physical measurement. User idea (context only): ${source.slice(0,3000)}. Project summary: ${String(project.plan?.summary||'').slice(0,1000)}`,
  };
}
