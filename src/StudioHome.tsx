import type { RefObject } from 'react';
import { ArrowRight, ArrowUpRight, ArrowUp, Blocks, Check, Code2, Database, GitBranch, LayoutGrid, LoaderCircle, LockKeyhole, ShieldCheck, Sparkles, Terminal, WandSparkles, Smartphone, MessagesSquare } from 'lucide-react';
import { EmptyProjects, Mark, ProjectCard, templates } from './components';
import type { AppConfig, Project, ProjectKind, AgentDelivery, WorkflowMode } from './types';
import type { Page } from './components';
import EstimateCard from './EstimateCard';
import ExamplesGallery from './ExamplesGallery';
import AtelierCaseStudy from './AtelierCaseStudy';
import AtelierMobileCaseStudy from './AtelierMobileCaseStudy';

type Props = {
  config: AppConfig | null;
  projects: Project[];
  loading: boolean;
  prompt: string;
  kind: ProjectKind;
  agentDelivery:AgentDelivery;
  setAgentDelivery:(value:AgentDelivery)=>void;
  workflowMode: WorkflowMode;
  setWorkflowMode: (value:WorkflowMode)=>void;
  creating: boolean;
  createError: string | null;
  textarea: RefObject<HTMLTextAreaElement | null>;
  setPrompt: (value: string) => void;
  setKind: (kind: ProjectKind) => void;
  setCreateError: (error: string | null) => void;
  createProject: () => Promise<void>;
  selectTemplate: (template: typeof templates[number]) => void;
  navigate: (page: Page) => void;
  openProject: (id: string) => void;
};

export default function StudioHome({ config, projects, loading, prompt, kind, agentDelivery, setAgentDelivery, workflowMode, setWorkflowMode, creating, createError, textarea, setPrompt, setKind, setCreateError, createProject, selectTemplate, navigate, openProject }: Props) {
  return (
    <div className="home-page page-container">
      <section className="creation-stage">
        <div className="studio-grid" aria-hidden="true"><i /><i /><i /></div>
        <header className="studio-hero">
          <h1 className="studio-headline">Build what you have in mind.</h1>
        </header>

        <section className="composer-section" aria-label="아이디어로 프로젝트 만들기">
          <div className="workflow-choice" role="group" aria-label="진행 방식">
            <button type="button" aria-label="한 번에 자동으로" aria-pressed={workflowMode==='auto'} className={workflowMode==='auto'?'selected':''} disabled={creating} onClick={()=>setWorkflowMode('auto')}>
              <span className="workflow-choice-icon"><WandSparkles size={19}/></span><span><b>한 번에 자동으로 <small>추천</small></b><span>기획부터 테스트까지 알아서 진행해요</span></span><i>{workflowMode==='auto'&&<Check size={12}/>}</i>
            </button>
            <button type="button" aria-label="단계별로 확인" aria-pressed={workflowMode==='guided'} className={workflowMode==='guided'?'selected':''} disabled={creating} onClick={()=>setWorkflowMode('guided')}>
              <span className="workflow-choice-icon"><MessagesSquare size={19}/></span><span><b>단계별로 확인</b><span>기획 · 기능 · 설계, 함께 결정해요</span></span><i>{workflowMode==='guided'&&<Check size={12}/>}</i>
            </button>
          </div>
          <form className={`prompt-composer ${creating ? 'busy' : ''}`} onSubmit={event => { event.preventDefault(); void createProject(); }}>
            <div className="composer-top">
              <div className="kind-tabs" role="group" aria-label="프로젝트 유형">
                <button className={kind === 'web-app' ? 'selected' : ''} type="button" aria-pressed={kind === 'web-app'} onClick={() => setKind('web-app')}><LayoutGrid size={14} />웹 앱</button>
                <button className={kind === 'mobile-app' ? 'selected' : ''} type="button" aria-pressed={kind === 'mobile-app'} onClick={() => setKind('mobile-app')}><Smartphone size={14} />모바일 앱</button>
                <button className={kind === 'ai-agent' ? 'selected' : ''} type="button" aria-pressed={kind === 'ai-agent'} onClick={() => setKind('ai-agent')}><Sparkles size={14} />AI 에이전트</button>
              </div>
              <span className="composer-tip"><WandSparkles size={13} />시작은 한 문장이면 충분해요</span>
            </div>
            {kind==='ai-agent'&&<div className="agent-delivery-options" role="group" aria-label="에이전트 제공 방식">{([{id:'web',label:'웹사이트',detail:'주소를 열어 바로 사용'}, {id:'api',label:'API',detail:'다른 서비스에서 호출'}, {id:'mcp',label:'MCP',detail:'Codex 등 AI 도구에 연결'}] as const).map(option=><button key={option.id} type="button" aria-pressed={agentDelivery===option.id} className={agentDelivery===option.id?'selected':''} onClick={()=>setAgentDelivery(option.id)}><b>{option.label}</b><span>{option.detail}</span>{agentDelivery===option.id&&<Check size={13}/>}</button>)}</div>}
            <label className="sr-only" htmlFor="project-prompt">만들고 싶은 프로젝트 설명</label>
            <textarea
              ref={textarea}
              id="project-prompt"
              value={prompt}
              maxLength={4000}
              onChange={event => { setPrompt(event.target.value); if (createError) setCreateError(null); }}
              onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void createProject(); } }}
              placeholder={kind === 'mobile-app' ? '내 손안에, 어떤 앱을 만들어볼까요?\n예: 좋은 습관을 기록하고 완료하는 나만의 Android 앱' : kind === 'web-app' ? '어떤 아이디어를 현실로 만들어볼까요?\n예: 매일 읽은 책과 생각을 기록하는 나만의 독서 앱' : '어떤 일을 맡기고 싶으신가요?\n예: 긴 회의록에서 핵심 내용과 할 일을 정리하는 AI 비서'}
              disabled={creating}
            />
            <div className="composer-bottom">
              <div className="composer-engine"><span /><span>{config?.mode === 'openai' ? 'AI ENGINE' : 'TEMPLATE ENGINE'}</span><span className="engine-divider" /><span className="composer-key"><kbd>Ctrl</kbd> + <kbd>Enter</kbd></span></div>
              <button className="create-button" type="submit" disabled={creating || !config}>
                <span>{creating ? '프로젝트 준비 중' : '프로젝트 만들기'}</span>
                {creating ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={17} />}
              </button>
            </div>
          </form>
          {createError && <p className="form-error" role="alert">{createError}</p>}
          <EstimateCard prompt={prompt} kind={kind} agentDelivery={agentDelivery} model={config?.model}/>
          {workflowMode==='guided'&&<p className="workflow-estimate-note"><MessagesSquare size={13}/>3번의 확인 후 구현·테스트는 자동으로 진행돼요. 검토 대기 시간과 추가 수정 요청은 예상 시간·비용에서 제외됩니다.</p>}
          <div className="composer-under">
            <div className="suggestions">
              <span>영감이 필요하다면</span>
              <button onClick={() => selectTemplate(templates[0])}><Blocks size={13} />프로젝트 보드<ArrowUpRight size={12} /></button>
              <button onClick={() => selectTemplate(templates[1])}><Check size={13} />습관 트래커<ArrowUpRight size={12} /></button>
              <button onClick={() => selectTemplate(templates[2])}><Sparkles size={13} />AI 요약 비서<ArrowUpRight size={12} /></button>
            </div>
          </div>
        </section>
        <div className="included-features"><span>{kind==='mobile-app'?<Smartphone size={13}/>:<LockKeyhole size={13} />}{kind==='mobile-app'?'Android APK':'회원가입·로그인'}</span><i /><span><Database size={13} />{kind==='mobile-app'?'기기 오프라인 저장':'데이터 저장'}</span><i /><span><ShieldCheck size={14} />{kind==='mobile-app'?'기기 미리보기':'실제 실행 검증'}</span><i /><span><Code2 size={14} />소스 코드까지</span></div>
      </section>

      <button className="flow-overview" onClick={() => navigate('workflow')} aria-label="전체 워크플로 보기">
        <div className="flow-intro"><span className="flow-intro-icon"><GitBranch size={18} /></span><div><h2>한 번의 입력, 하나로 이어지는 개발.</h2><p>당신의 아이디어를 8단계로 완성합니다.</p></div></div>
        <div className="flow-steps"><span><span className="flow-node"><Blocks size={13} /></span>계획</span><i /><span><span className="flow-node"><Code2 size={13} /></span>구현</span><i /><span><span className="flow-node"><Terminal size={13} /></span>검증</span><i /><span className="flow-finish"><span className="flow-node"><Check size={13} /></span>완성</span></div>
        <ArrowUpRight className="flow-more" size={18} />
      </button>

      <AtelierCaseStudy onUse={idea=>{setPrompt(idea);setKind('web-app');setCreateError(null);textarea.current?.focus();textarea.current?.scrollIntoView({block:'center',behavior:'smooth'});}}/>
      <AtelierMobileCaseStudy onUse={idea=>{setPrompt(idea);setKind('mobile-app');setCreateError(null);textarea.current?.focus();textarea.current?.scrollIntoView({block:'center',behavior:'smooth'});}}/>
      <ExamplesGallery onUse={(idea,type)=>{setPrompt(idea);setKind(type);setCreateError(null);textarea.current?.focus();textarea.current?.scrollIntoView({block:'center',behavior:'smooth'});}}/>

      <section className="recent-section">
        <div className="section-heading"><div><div className="section-kicker">YOUR WORKSPACE</div><h2>이어서 만들어볼까요 <span className="heading-count">{projects.length.toString().padStart(2, '0')}</span></h2></div><button className="text-button" onClick={() => navigate('projects')}>모든 프로젝트 <ArrowRight size={15} /></button></div>
        {loading ? <div className="inline-loading"><LoaderCircle size={16} className="spin" />프로젝트 불러오는 중</div> : projects.length ? <div className="project-grid">{projects.slice(0, 3).map(project => <ProjectCard key={project.id} project={project} onOpen={() => openProject(project.id)} />)}</div> : <EmptyProjects compact onNew={() => { textarea.current?.focus(); textarea.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }} />}
      </section>
      <footer className="page-footer"><span><Mark small />Launchpad</span><span>Less friction. More creation.</span><span>MADE FOR WHAT'S NEXT <ArrowUpRight size={12} /></span></footer>
    </div>
  );
}
