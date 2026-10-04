import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, Download, Maximize2, RotateCcw, X } from 'lucide-react';
import type { GeneratedFile } from './types';

type Sample={name:string;prompt:string;files:GeneratedFile[];verified:boolean;authMode:string};
export function previewDocument(files:GeneratedFile[]) {
  const get=(path:string)=>files.find(file=>file.path===path)?.content||'';
  const parsed=new DOMParser().parseFromString(get('public/index.html'),'text/html');
  parsed.querySelectorAll('script,link,base,meta[http-equiv]').forEach(node=>node.remove());
  const nonce=crypto.randomUUID().replaceAll('-','');
  const bridge="(()=>{const data=Object.create(null);Object.defineProperty(window,'localStorage',{value:{getItem:k=>data[k]??null,setItem:(k,v)=>{data[k]=String(v)},removeItem:k=>{delete data[k]},clear:()=>{for(const k of Object.keys(data))delete data[k]},key:i=>Object.keys(data)[i]??null,get length(){return Object.keys(data).length}}})})();";
  const script=(code:string)=>`<script nonce="${nonce}">${code.replace(/<\/script/gi,'<\\/script')}</script>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>${get('public/styles.css').replace(/<\/style/gi,'<\\/style')}</style></head><body>${parsed.body.innerHTML}${script(bridge)}${script(get('public/design-assets.js'))}${script(get('public/app.js'))}</body></html>`;
}
export default function AtelierCaseStudy({onUse}:{onUse:(prompt:string)=>void}){
  const [sample,setSample]=useState<Sample|null>(null),[expanded,setExpanded]=useState(false),[revision,setRevision]=useState(0);
  const preview=useRef<HTMLDivElement>(null),[scale,setScale]=useState(.5);
  useEffect(()=>{if(!sample||!preview.current)return;const observer=new ResizeObserver(entries=>{const width=entries[0]?.contentRect.width;if(width)setScale(Math.min(1,width/1280))});observer.observe(preview.current);return()=>observer.disconnect();},[sample]);
  useEffect(()=>{let active=true;void fetch('/examples/atelier/sample.json').then(r=>r.ok?r.json():null).then(value=>{if(active&&value?.verified&&Array.isArray(value.files))setSample(value);}).catch(()=>{});return()=>{active=false};},[]);
  useEffect(()=>{if(!expanded)return;const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')setExpanded(false)};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey)},[expanded]);
  const source=useMemo(()=>sample?previewDocument(sample.files):'',[sample]);
  if(!sample)return null;
  return <section className="atelier-case" aria-label="패션 제작 앱 실제 검증 샘플">
    <div className="atelier-case-heading"><div><span className="section-kicker">BUILT. TESTED. READY TO EXPLORE.</span><h2>한 문장에서, 첫 제작 샘플까지.</h2><p>직접 생성하고 검증한 가방·의류 제작 워크벤치</p></div><span className="atelier-tested"><Check size={13}/>이미지 모델 적용 · 기능 검증</span></div>
    <div className="atelier-case-body"><div className="atelier-story"><span className="atelier-story-label">THE BRIEF</span><blockquote>“{sample.prompt}”</blockquote><ol><li><b>01 · 처음의 결과</b><span>일반 작업 관리 앱으로 생성되어 핵심 요구사항을 놓쳤습니다.</span></li><li><b>02 · 기능 확장</b><span>치수 개념도, 원단 배치, 재료량과 제작비 계산을 추가했습니다.</span></li><li><b>03 · 이미지로 구체화</b><span>이미지 모델로 가방·상의 콘셉트를 만들고 계산·저장·내보내기를 검증했습니다.</span></li></ol><button className="text-button" onClick={()=>onUse(sample.prompt)}>이 아이디어로 새로 만들기 <ArrowUpRight size={14}/></button><a className="text-button" href="/examples/atelier/source.zip" download><Download size={14}/>검증한 샘플 소스</a><p className="atelier-scope">입력 치수 기반 개념도와 가정 단가 견적입니다. 실제 실측·생산 패턴·업체 확정 견적을 대신하지 않습니다.</p></div><div className="atelier-showcase"><div className="atelier-preview-bar"><span><i/>ATELIER / LIVE SAMPLE</span><div><button onClick={()=>setRevision(v=>v+1)} aria-label="패션 샘플 초기화"><RotateCcw size={14}/></button><button onClick={()=>setExpanded(true)}><Maximize2 size={14}/>크게 보기</button></div></div><div ref={preview} className="atelier-preview-viewport" style={{height:1440*scale}}><iframe style={{width:1280,height:1440,transform:`scale(${scale})`,transformOrigin:'top left'}} key={revision} title="패션 제작 앱 검증 샘플" srcDoc={source} sandbox="allow-scripts allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"/></div><p>실제 생성된 화면입니다. 크게 보기에서 편하게 사용할 수 있어요. 체험 중 저장한 기록은 샘플을 새로 열면 초기화됩니다.</p></div></div>
    {expanded&&<div className="atelier-fullscreen" role="dialog" aria-modal="true" aria-label="패션 제작 샘플 크게 보기"><header><span>ATELIER · 검증한 결과물</span><button autoFocus onClick={()=>setExpanded(false)}><X size={17}/>닫기</button></header><iframe title="패션 제작 앱 전체 화면" srcDoc={source} sandbox="allow-scripts allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"/></div>}
  </section>;
}
