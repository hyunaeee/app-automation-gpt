import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Check, Code2, LoaderCircle, RotateCcw, Signal, Smartphone, Wifi, BatteryFull } from 'lucide-react';
import { api, errorMessage } from './api';
import type { AndroidBuild, Project } from './types';

function previewDocument(project:Project, saved:Record<string,string>) {
  const files=new Map(project.files.map(file=>[file.path,file.content]));
  const document=new DOMParser().parseFromString(files.get('public/index.html')||'<div id="app"></div>','text/html');
  document.querySelectorAll('script,link,base,meta[http-equiv]').forEach(node=>node.remove());
  const nonce=crypto.randomUUID().replaceAll('-','');
  const json=(value:unknown)=>JSON.stringify(value).replace(/</g,'\\u003c');
  const bridge=`(()=>{const state=Object.assign(Object.create(null),${json(saved)});const publish=()=>parent.postMessage({type:'launchpad:mobile-storage',projectId:${json(project.id)},state},'*');const storage={getItem:key=>Object.hasOwn(state,String(key))?state[String(key)]:null,setItem:(key,value)=>{key=String(key);value=String(value);if(value.length>500000||JSON.stringify(state).length+value.length>1000000)throw new DOMException('Storage full','QuotaExceededError');state[key]=value;publish();},removeItem:key=>{delete state[String(key)];publish();},clear:()=>{Object.keys(state).forEach(key=>delete state[key]);publish();},key:index=>Object.keys(state)[index]??null,get length(){return Object.keys(state).length}};Object.defineProperty(window,'localStorage',{value:storage});})();`;
  const script=(value:string)=>`<script nonce="${nonce}">${value.replace(/<\/script/gi,'<\\/script')}</script>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>${(files.get('public/styles.css')||'').replace(/<\/style/gi,'<\\/style')}</style></head><body>${document.body.innerHTML}${script(bridge)}${script(files.get('public/design-assets.js')||'')}${script(files.get('public/app.js')||'')}</body></html>`;
}

export default function MobilePreview({project}:{project:Project}) {
  const frame=useRef<HTMLIFrameElement>(null);
  const storageKey=`launchpad-mobile-preview:${project.id}`;
  const [revision,setRevision]=useState(0);
  const [device,setDevice]=useState<'compact'|'large'>('compact');
  const [build,setBuild]=useState<AndroidBuild>(project.android||{status:'idle',logs:[]});
  const [error,setError]=useState<string|null>(null);
  const [starting,setStarting]=useState(false);
  const [pollKey,setPollKey]=useState(0);
  const source=useMemo(()=>{
    let saved={};try{saved=JSON.parse(localStorage.getItem(storageKey)||'{}');}catch{}
    return previewDocument(project,saved);
  // Refreshing the preview is explicit; status polling does not reset the app.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[project.id,project.files,revision,storageKey]);
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      if(event.source!==frame.current?.contentWindow||event.data?.type!=='launchpad:mobile-storage'||event.data.projectId!==project.id)return;
      const state=event.data.state;if(!state||typeof state!=='object'||Array.isArray(state))return;
      const entries=Object.entries(state);if(entries.length>100||entries.some(([key,value])=>key.length>500||typeof value!=='string'))return;
      const serialized=JSON.stringify(state);if(serialized.length>1000000)return;
      try{localStorage.setItem(storageKey,serialized);}catch{setError('미리보기 기록을 브라우저에 저장하지 못했어요.');}
    };
    window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);
  },[project.id,storageKey]);
  useEffect(()=>{
    let disposed=false;let timer:ReturnType<typeof setTimeout>;
    const update=async()=>{try{const next=await api.android(project.id);if(disposed)return;setBuild(next);if(next.status==='building'||next.status==='idle')timer=setTimeout(()=>void update(),2000);}catch(failure){if(!disposed)setError(errorMessage(failure));}};
    void update();return()=>{disposed=true;clearTimeout(timer);};
  },[project.id,pollKey]);
  const compile=async()=>{setStarting(true);setError(null);try{setBuild(await api.buildAndroid(project.id));setPollKey(key=>key+1);}catch(failure){setError(errorMessage(failure));}finally{setStarting(false);}};
  return <section className="mobile-studio" aria-label="모바일 앱 미리보기와 APK">
    <div className="mobile-studio-toolbar"><div><Smartphone size={16}/><b>기기 미리보기</b><span>LIVE PREVIEW</span></div><div className="device-switch"><button className={device==='compact'?'active':''} onClick={()=>setDevice('compact')}>컴팩트</button><button className={device==='large'?'active':''} onClick={()=>setDevice('large')}>와이드</button><button aria-label="모바일 미리보기 새로고침" onClick={()=>setRevision(value=>value+1)}><RotateCcw size={13}/></button></div></div>
    <div className="mobile-studio-body"><div className={`device-stage ${device}`}><div className="device-orbit" aria-hidden="true"/><div className="device-frame"><div className="device-status"><b>9:41</b><span className="device-camera"/><span><Signal size={12}/><Wifi size={12}/><BatteryFull size={15}/></span></div><iframe ref={frame} key={`${project.id}:${revision}`} title={`${project.name} 모바일 미리보기`} srcDoc={source} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer"/><div className="device-chin"><i/></div></div><span className="device-caption"><span/>직접 눌러서 사용해 보세요</span></div>
    <aside className="mobile-delivery"><div className="delivery-icon"><Smartphone size={22}/></div><span className="section-kicker">FROM IDEA TO YOUR POCKET</span><h2>이제, 내 휴대폰으로.</h2><p>지금 보고 있는 앱을<br/>Android에 설치해 보세요.</p><div className={`apk-build-status ${build.status}`}><span>{build.status==='building'?<LoaderCircle size={17} className="spin"/>:build.status==='ready'?<Check size={17}/>:<Code2 size={17}/>}</span><div><b>{build.status==='ready'?'APK 준비 완료':build.status==='building'?'설치 파일을 만들고 있어요':build.status==='failed'?'APK 빌드를 확인해 주세요':'Android 설치 파일'}</b><p>{build.message||'완성된 앱을 APK로 패키징합니다.'}</p></div></div>
      {build.status==='ready'?<a className="primary-button full-width apk-download" href={`/api/projects/${project.id}/android/apk`} download><ArrowDownToLine size={16}/>APK 다운로드<span>{build.size?(build.size<1048576?`${Math.ceil(build.size/1024)} KB`:`${(build.size/1024/1024).toFixed(1)} MB`):''}</span></a>:<button className="primary-button full-width" onClick={()=>void compile()} disabled={starting||build.status==='building'}>{build.status==='building'?<LoaderCircle size={15} className="spin"/>:<ArrowDownToLine size={15}/>} {build.status==='failed'?'APK 다시 빌드':'APK 만들기'}</button>}
      <a className="text-button android-source-link" href={`/api/projects/${project.id}/android/source`} download><Code2 size={14}/>Android 소스 다운로드</a>
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="mobile-delivery-note"><b>작은 앱, 어디서든 가볍게.</b><p>인터넷 없이 기기에 기록을 저장합니다. 미리보기와 설치한 앱의 데이터는 따로 보관됩니다.</p></div><p className="mobile-preview-disclosure">웹 기반 기기 미리보기입니다. 실제 Android OS·센서·네이티브 기능을 에뮬레이션하지 않습니다. APK는 테스트 설치용 debug 서명이며, 스토어 배포에는 별도 서명이 필요합니다.</p>
      {build.logs.length>0&&<details className="apk-logs"><summary>APK 빌드 로그</summary><pre>{build.logs.join('\n')}</pre></details>}
    </aside></div>
  </section>;
}
