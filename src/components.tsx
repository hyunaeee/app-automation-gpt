import { ArrowUp, ArrowUpRight, Check, ChevronRight, Circle, Code2, FileCode2, LayoutGrid, LoaderCircle, MessageSquare, MoreHorizontal, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Project, ProjectKind } from './types';

export type Page = 'new' | 'projects' | 'workflow' | 'templates';
export const stageDescriptions = [
  { title: '요구사항 분석', text: '한 줄의 아이디어에서 목적과 사용자를 파악합니다.', icon: '01', agent: 'Planner' },
  { title: '기능 정의', text: '핵심 기능과 합리적인 기본값을 정리합니다.', icon: '02', agent: 'Planner' },
  { title: '구조 설계', text: '기술 스택, 데이터와 파일 구조를 설계합니다.', icon: '03', agent: 'Architect' },
  { title: '프로젝트 생성', text: '실행 환경과 기본 파일을 준비합니다.', icon: '04', agent: 'Coding Agent' },
  { title: '코드 구현', text: '화면, 로그인과 데이터 기능을 연결합니다.', icon: '05', agent: 'Coding Agent' },
  { title: '테스트', text: '문법, 인증과 데이터 기능을 실제로 검증합니다.', icon: '06', agent: 'Validation Agent' },
  { title: '오류 수정', text: '실패 로그를 바탕으로 제한된 횟수 안에서 수정합니다.', icon: '07', agent: 'Debugging Flow' },
  { title: '결과물 생성', text: '실행 링크와 수정 가능한 소스 코드를 제공합니다.', icon: '08', agent: 'Delivery' },
];

export const templates: { id: string; title: string; description: string; category: string; kind: ProjectKind; prompt: string; visual: 'kanban' | 'habit' | 'agent' }[] = [
  { id: 'team', title: '나의 작은 프로젝트 보드', description: '할 일을 한눈에, 프로젝트는 가볍게.', category: '생산성', kind: 'web-app', prompt: '나의 프로젝트와 할 일을 관리하는 작업 보드 앱을 만들어줘. 로그인하고 개인 할 일을 추가, 수정, 삭제하고 진행 상태별로 확인하고 싶어.', visual: 'kanban' },
  { id: 'habit', title: '매일 쌓이는 좋은 습관', description: '작은 실천이 눈에 보이는 변화로.', category: '모바일 · Android', kind: 'mobile-app', prompt: '매일의 작은 습관을 기기에 기록하고 달성 여부를 체크하는 오프라인 Android 앱을 만들어줘. 습관 추가, 수정, 삭제와 진행 상태를 확인하고 싶어.', visual: 'habit' },
  { id: 'agent', title: '나만의 똑똑한 AI 비서', description: '반복되는 업무는 에이전트에게.', category: 'AI 에이전트', kind: 'ai-agent', prompt: '긴 글을 붙여넣으면 핵심 내용을 정리해주는 AI 요약 에이전트를 만들어줘. 로그인하고 요약 결과를 저장해서 다시 확인하고 싶어.', visual: 'agent' },
];

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path d="m17.8 2.5 2.9 8.8 8.8 2.9-8.8 2.9-2.9 8.8-2.9-8.8-8.8-2.9 8.8-2.9 2.9-8.8Z" fill="currentColor" />
        <path d="m7 21 1.6 4.4L13 27l-4.4 1.6L7 33l-1.6-4.4L1 27l4.4-1.6L7 21Z" fill="currentColor" opacity=".55" transform="translate(1 -3) scale(.85)" />
      </svg>
    </span>
  );
}

export function Tag({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`tag ${tone}`}>{children}</span>; }

const statusLabel = { queued: '대기 중', running: '만드는 중', awaiting_approval: '확인 대기', completed: '완성', failed: '확인 필요', cancelled: '취소됨' };
export function StatusBadge({ project }: { project: Project }) {
  return <span className={`status-badge ${project.status}`}>{project.status === 'running' || project.status === 'queued' ? <LoaderCircle size={12} className="spin" /> : project.status === 'completed' ? <Check size={12} /> : <Circle size={7} fill="currentColor" />}{statusLabel[project.status]}</span>;
}

export function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const count = project.stages.filter(stage => stage.status === 'completed' || stage.status === 'skipped').length;
  return (
    <button className="project-card" onClick={onOpen}>
      <div className="project-card-top">
        <span className={`project-symbol ${project.kind === 'ai-agent' ? 'purple' : ''}`}>
          {project.kind === 'ai-agent' ? <Sparkles size={20} /> : <LayoutGrid size={20} />}
        </span>
        <StatusBadge project={project} />
      </div>
      <h3>{project.name}</h3>
      <p>{project.prompt}</p>
      <div className="project-card-bottom">
        <span>{project.kind === 'ai-agent' ? 'AI 에이전트' : project.kind === 'mobile-app' ? 'Android 앱' : '웹 애플리케이션'}<span className="dot-separator">/</span>{new Date(project.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}</span>
        <ArrowUpRight size={17} />
      </div>
      {['running','awaiting_approval'].includes(project.status) && <div className="project-mini-progress"><span style={{ width: `${count / 8 * 100}%` }} /></div>}
    </button>
  );
}

export function TemplateVisual({ variant }: { variant: 'kanban' | 'habit' | 'agent' }) {
  return (
    <div className={`template-visual ${variant}`} aria-hidden="true">
      {variant === 'kanban' && (
        <div className="lp-preview-window lp-preview-board">
          <div className="lp-preview-toolbar">
            <span className="lp-preview-logo"><LayoutGrid size={10} /></span>
            <b>Forma</b>
            <span className="lp-preview-breadcrumb">/ Workspace</span>
            <MoreHorizontal size={12} />
          </div>
          <div className="lp-preview-board-heading">
            <div><span>MY WORKSPACE</span><h4>Make great things.</h4></div>
            <span className="lp-preview-new">+ New task</span>
          </div>
          <div className="lp-preview-columns">
            {[
              { name: 'To do', task: 'Explore new ideas', tag: 'Design', second: 'Gather inspiration' },
              { name: 'In progress', task: 'Build something new', tag: 'Product', second: 'Refine the details' },
              { name: 'Done', task: 'The first little step', tag: 'Research', second: 'Find your direction' },
            ].map((column, index) => (
              <div className={`lp-preview-column column-${index}`} key={column.name}>
                <div className="lp-preview-column-label"><i />{column.name}<span>2</span></div>
                <div className="lp-preview-task">
                  <span className="lp-preview-task-tag">{column.tag}</span>
                  <b>{column.task}</b>
                  <div className="lp-preview-task-meta"><span>Jun {12 + index}</span><i>{['J', 'M', 'H'][index]}</i></div>
                </div>
                <div className="lp-preview-task lp-preview-task-small"><b>{column.second}</b><span className="lp-preview-task-line" /></div>
              </div>
            ))}
          </div>
        </div>
      )}
      {variant === 'habit' && (
        <div className="lp-preview-window lp-preview-habit">
          <div className="lp-preview-habit-nav"><span>morrow<span>®</span></span><span>Good things, every day.</span><span className="lp-preview-profile">Y</span></div>
          <div className="lp-preview-habit-heading"><div><span>MONDAY, JUNE 16</span><h4>A little better,<br />every day.</h4></div><span className="lp-preview-sun">✳</span></div>
          <div className="lp-preview-habit-content">
            <div className="lp-preview-habit-stats"><span>Your weekly rhythm</span><div className="lp-preview-bars">{[45, 68, 55, 90, 74, 100, 62].map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div><div className="lp-preview-days">{'MTWTFSS'.split('').map((day, index) => <span key={index}>{day}</span>)}</div></div>
            <div className="lp-preview-habit-list"><span>TODAY’S INTENTIONS</span><div><i><Check size={8} /></i>Read 20 pages</div><div><i><Check size={8} /></i>A moment to breathe</div><div><i />Move your body</div><span className="lp-preview-habit-streak">✦ 7 day streak. Keep going!</span></div>
          </div>
        </div>
      )}
      {variant === 'agent' && (
        <div className="lp-preview-window lp-preview-agent">
          <div className="lp-preview-agent-sidebar"><span><Sparkles size={13} /></span><MessageSquare size={11} /><FileCode2 size={11} /><span className="lp-preview-agent-avatar">Y</span></div>
          <div className="lp-preview-agent-main">
            <div className="lp-preview-agent-header"><b>Orbit<span> AI</span></b><span><i />Ready to help</span></div>
            <div className="lp-preview-agent-greeting"><span className="lp-preview-orbit-icon"><Sparkles size={19} /></span><h4>A little less busy.<br />A lot more brilliant.</h4></div>
            <div className="lp-preview-agent-message">Help me find the big picture.<ArrowUpRight size={9} /></div>
            <div className="lp-preview-agent-reply"><Sparkles size={10} /><div><b>Here’s what matters most.</b><i /><i /></div><Check size={10} /></div>
            <div className="lp-preview-agent-input"><span>Ask anything, start something.</span><span><ArrowUp size={10} /></span></div>
          </div>
        </div>
      )}
    </div>
  );
}

export function TemplateCard({ template, onSelect }: { template: typeof templates[number]; onSelect: () => void }) {
  return <button className="template-card" onClick={onSelect}>
    <TemplateVisual variant={template.visual} />
    <div className="template-card-info"><div><span className={`template-category ${template.visual}`}>{template.category}</span><h3>{template.title}</h3><p>{template.description}</p></div><span className="template-arrow"><ArrowUpRight size={17} /></span></div>
  </button>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && node) {
        const elements = [...node.querySelectorAll<HTMLElement>('button, a[href], input, textarea, [tabindex="0"]')];
        const first = elements[0]; const last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handler); document.body.style.overflow = overflow; before?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1}><div className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="닫기"><X size={20} /></button></div>{children}</div></div>;
}

export function EmptyProjects({ onNew, compact = false }: { onNew: () => void; compact?: boolean }) {
  return <div className={`empty-projects ${compact ? 'compact' : ''}`}><div className="empty-icon"><FileCode2 size={22} /><span><Plus size={10} /></span></div><div><h3>첫 번째 아이디어를 기다리고 있어요</h3><p>만들고 싶은 것을 입력하면, 여기에 프로젝트가 쌓여요.</p></div><button className="text-button" onClick={onNew}>첫 프로젝트 만들기 <ChevronRight size={15} /></button></div>;
}

export function AgentMini({ role, name, icon }: { role: string; name: string; icon: 'plan' | 'code' | 'test' }) {
  return <div className={`agent-mini ${icon}`}><span className="agent-mini-icon">{icon === 'plan' ? <MessageSquare size={16} /> : icon === 'code' ? <Code2 size={17} /> : <Check size={18} />}</span><div><b>{name}</b><span>{role}</span></div></div>;
}
