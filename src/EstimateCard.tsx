import { useEffect, useState } from 'react';
import { Clock3, Coins, ArrowUpRight, LoaderCircle, Sparkles } from 'lucide-react';
import { api, errorMessage } from './api';
import type { ProjectKind, ProjectEstimate, AgentDelivery } from './types';

export default function EstimateCard({prompt,kind,model,agentDelivery='web'}:{prompt:string;kind:ProjectKind;model?:string|null;agentDelivery?:AgentDelivery}) {
  const [estimate,setEstimate]=useState<ProjectEstimate|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{
    let disposed=false;setEstimate(null);setError(null);
    if(prompt.trim().length<10){setBusy(false);return;}
    setBusy(true);
    const timer=setTimeout(async()=>{try{const result=await api.estimate(prompt.trim(),kind,agentDelivery);if(!disposed)setEstimate(result);}catch(failure){if(!disposed)setError(errorMessage(failure));}finally{if(!disposed)setBusy(false);}},550);
    return()=>{disposed=true;clearTimeout(timer);};
  },[prompt,kind,model,agentDelivery]);
  const duration=estimate?estimate.timeSeconds.max<60?`${estimate.timeSeconds.min}–${estimate.timeSeconds.max}초`:`약 ${Math.max(1,Math.ceil(estimate.timeSeconds.min/60))}–${Math.ceil(estimate.timeSeconds.max/60)}분`:'';
  const amount=estimate?.provider==='codex'?'구독 사용량 적용':estimate?.cost.status==='estimated'?`$${estimate.cost.min?.toFixed(2)}–$${estimate.cost.max?.toFixed(2)}`:estimate?.cost.status==='not-applicable'?'$0 · 템플릿':estimate?.modelRouting==='automatic'?'모델별 비용 미산정':'단가 확인 필요';
  return <section className="estimate-card" aria-label="예상 비용과 시간" aria-live="polite">
    <div className="estimate-intro"><span><Sparkles size={15}/></span><div><b>만들기 전에, 한눈에.</b><p>{busy?'아이디어의 작업 범위를 계산하고 있어요.':estimate?'현재 연결 방식에 맞춘 초기 예상치예요.':'아이디어를 10자 이상 입력하면 예상치를 보여드려요.'}</p></div>{busy&&<LoaderCircle className="spin" size={16}/>}</div>
    {estimate&&<><div className="estimate-metrics"><div><span><Coins size={14}/>모델 사용료</span><b>{amount}</b></div><div><span><Clock3 size={14}/>생성·검증 {kind==='mobile-app'?'· APK':''}</span><b>{duration}</b></div><div><span><ArrowUpRight size={14}/>결과물</span><b>{kind==='mobile-app'?'Android 앱 + 소스':kind==='ai-agent'?(agentDelivery==='mcp'?'MCP 서버 + 연결 설정':agentDelivery==='api'?'API + 호출 문서':'에이전트 웹사이트'):'웹 앱 + 소스'}</b></div></div><details><summary>포함 범위와 비용 기준</summary><p className="estimate-caveat">예상 범위이며 확정 견적·지출 상한이 아닙니다. 호스팅·외부 디자인·스토어 비용과 심사 시간은 별도예요.</p><ul>{estimate.assumptions.map((text,index)=><li key={index}>{text}</li>)}</ul><div className="estimate-exclusions">{estimate.excludedCosts.map(item=><p key={item.id}><b>{item.label}</b>{item.detail}</p>)}</div></details></>}
    {error&&<p className="form-error" role="alert">견적을 가져오지 못했어요. {error}</p>}
  </section>;
}
