import { useRef, useState } from 'react';
import { ArrowRight, Check, CheckCheck, ChevronDown, FileCode2, LoaderCircle, MessageSquare, Send, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from './api';
import type { AppConfig, Project, ReviewStage } from './types';

const stages: ReviewStage[] = ['requirements', 'features', 'architecture'];
const labels: Record<ReviewStage,string> = {requirements:'기획',features:'기능',architecture:'설계'};
const descriptions: Record<ReviewStage,string> = {
  requirements:'어떤 앱을, 누구를 위해 만들지 정리했어요. 방향이 맞는지 확인해 주세요.',
  features:'앱에 들어갈 기능을 정리했어요. 꼭 필요한 기능과 추가 기능을 살펴보세요.',
  architecture:'기능을 구현할 기술과 파일 구성을 정리했어요. 확인하면 코드 작성과 테스트를 시작해요.',
};

export default function WorkflowReview({project,config,disabled=false,onReviewed}:{project:Project;config:AppConfig|null;disabled?:boolean;onReviewed:(project:Project)=>void}) {
  const [feedback,setFeedback]=useState('');
  const [editing,setEditing]=useState(false);
  const [busy,setBusy]=useState<'approve'|'revise'|null>(null);
  const [error,setError]=useState<string|null>(null);
  const lock=useRef(false);
  const review=project.review;
  const plan=project.plan;
  if(!review||!plan) return null;
  const stage=review.stage;
  const canRevise=config?.mode==='openai';
  const submit=async(action:'approve'|'revise')=>{
    if(lock.current||disabled) return;
    lock.current=true;setBusy(action);setError(null);
    try { const result=await api.review(project.id,review.id,action,action==='revise'?feedback.trim():undefined);onReviewed(result); }
    catch(err){setError(errorMessage(err));}
    finally{lock.current=false;setBusy(null);}
  };
  return <section className="review-panel" aria-labelledby="review-heading">
    <div className="review-topline"><span><MessageSquare size={14}/>함께 만드는 중</span><span>{stages.indexOf(stage)+1} / 3</span></div>
    <div className="review-progress" aria-label="검토 순서">{stages.map((id,index)=><span key={id} className={id===stage?'current':index<stages.indexOf(stage)?'done':''}><i>{index<stages.indexOf(stage)?<Check size={11}/>:index+1}</i>{labels[id]} 확인</span>)}</div>
    <h2 id="review-heading">{stage==='architecture'?'설계를':`${labels[stage]}을`} 확인해 주세요</h2>
    <p className="review-description">{descriptions[stage]}</p>
    <div className="review-document">
      {stage==='requirements'&&<><span className="content-eyebrow">PROJECT BRIEF</span><h3>{plan.name}</h3><p>{plan.summary}</p><div className="review-audience"><span>이런 분을 위해</span><b>{plan.audience}</b></div>{plan.assumptions.length>0&&<div className="review-assumptions"><h4>이렇게 가정했어요</h4><ul>{plan.assumptions.map((item,index)=><li key={index}>{item}</li>)}</ul></div>}</>}
      {stage==='features'&&<><span className="content-eyebrow">FEATURE SCOPE</span><div className="review-feature-list">{plan.features.map((feature,index)=><div key={index}><span className={`review-priority ${feature.priority}`}>{feature.priority==='core'?'핵심':'추가'}</span><div><h3>{feature.name}</h3><p>{feature.description}</p></div></div>)}</div></>}
      {stage==='architecture'&&<><span className="content-eyebrow">BUILD BLUEPRINT</span><div className="review-stack">{plan.stack.map((item,index)=><div key={index}><b>{item.name}</b><span>{item.role}</span></div>)}</div><details className="review-filetree"><summary><FileCode2 size={14}/>프로젝트 파일 구성 <ChevronDown size={14}/></summary><ul>{plan.fileTree.map((file,index)=><li key={index}>{file}</li>)}</ul></details><p className="review-build-note"><ShieldCheck size={15}/>확인 후 프로젝트 생성 → 코드 구현 → 테스트 → 오류 수정 → 결과물 생성까지 이어서 진행합니다.</p></>}
    </div>
    {editing&&<form className="review-feedback" onSubmit={event=>{event.preventDefault();void submit('revise');}}>
      <label htmlFor="review-feedback">어떤 부분을 바꿀까요?</label>
      <textarea id="review-feedback" value={feedback} onChange={event=>setFeedback(event.target.value)} minLength={5} maxLength={4000} required disabled={!!busy||disabled||!canRevise} placeholder="예: 개인용보다 팀이 함께 쓰는 앱으로 바꿔줘. 초대와 권한 관리가 필요해."/>
      <div className="review-feedback-bottom"><p>수정 의견을 반영해 기획부터 다시 확인해요. AI 사용량이 추가될 수 있어요.</p><button className="secondary-button" type="submit" disabled={!canRevise||!!busy||disabled||feedback.trim().length<5}>{busy==='revise'?<LoaderCircle className="spin" size={14}/>:<Send size={14}/>}수정 요청 보내기</button></div>
    </form>}
    {error&&<p className="form-error" role="alert">{error}</p>}
    {!canRevise&&<p className="review-connection-note">현재는 템플릿을 검토하고 있어요. 자연어로 기획을 수정하려면 설정에서 OpenAI API 또는 로컬 Codex 구독을 연결해 주세요.</p>}
    <div className="review-actions"><button type="button" className="text-button" onClick={()=>setEditing(value=>!value)} disabled={!!busy||disabled||!canRevise}><MessageSquare size={15}/>{editing?'수정 의견 접기':'수정 의견 남기기'}</button><button type="button" className="primary-button" onClick={()=>{void submit('approve');}} disabled={!!busy||disabled}>{busy==='approve'?<LoaderCircle className="spin" size={16}/>:stage==='architecture'?<CheckCheck size={16}/>:null}확인하고 다음 단계 <ArrowRight size={16}/></button></div>
    <p className="review-pause-note">확인하기 전에는 다음 단계로 넘어가지 않아요. 나중에 돌아와도 여기서 이어갈 수 있어요.</p>
  </section>;
}

export function ReviewHistory({project}:{project:Project}) {
  if(!project.reviewHistory?.length) return null;
  return <details className="review-history"><summary><CheckCheck size={14}/>검토 기록 <span>{project.reviewHistory.length}</span><ChevronDown size={14}/></summary><ol>{project.reviewHistory.map((item,index)=><li key={index}><span className={`review-history-mark ${item.action}`}>{item.action==='approve'?<Check size={12}/>:<MessageSquare size={12}/>}</span><div><b>{labels[item.stage]} {item.action==='approve'?'확인 완료':'수정 요청'}</b>{item.feedback&&<p>{item.feedback}</p>}<time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('ko-KR')}</time></div></li>)}</ol></details>;
}
