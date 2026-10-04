import { useState } from 'react';
import { ArrowUpRight, GitBranch, LoaderCircle } from 'lucide-react';
import { api, errorMessage } from './api';
import type { Project, AppConfig } from './types';

export default function RevisionComposer({project,config,onCreated}:{project:Project;config:AppConfig|null;onCreated:(project:Project)=>void}) {
  const [prompt,setPrompt]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const canEdit=config?.mode==='openai';
  const submit=async()=>{if(busy||prompt.trim().length<10)return;setBusy(true);setError(null);try{onCreated(await api.revise(project.id,prompt.trim()));}catch(failure){setError(errorMessage(failure));}finally{setBusy(false);}};
  return <section className="revision-composer" aria-label="자연어로 앱 수정"><div className="revision-heading"><span><GitBranch size={19}/></span><div><span className="section-kicker">MAKE IT MORE YOU</span><h3>써보니, 더 좋은 생각이 났나요?</h3></div></div><p>바꾸고 싶은 점을 말해 주세요. 지금 버전을 보관하고 다음 버전을 만듭니다.</p><form onSubmit={event=>{event.preventDefault();void submit();}}><label className="sr-only" htmlFor="revision-prompt">바꾸고 싶은 내용</label><textarea id="revision-prompt" value={prompt} maxLength={4000} disabled={busy} onChange={event=>setPrompt(event.target.value)} placeholder="예: 배경을 밝게 바꾸고, 완료한 기록만 모아보는 탭을 추가해 줘"/><div><span>{canEdit?'이전 화면과 요청을 함께 전달해 AI가 수정해요.':'현재는 템플릿 복사만 가능해요. 맞춤 수정은 설정에서 AI를 연결해 주세요.'}</span><button className="primary-button" disabled={busy||prompt.trim().length<10}>{busy?<LoaderCircle size={15} className="spin"/>:<ArrowUpRight size={15}/>} {canEdit?'새 버전 만들기':'템플릿 사본 만들기'}</button></div></form>{error&&<p className="form-error" role="alert">{error}</p>}<small>새 버전은 별도 앱으로 만들어집니다. 이전 앱의 사용자 데이터와 설치 서명은 자동 이전되지 않아요.</small></section>;
}
