import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, CheckCircle2, ChevronRight, Circle, Clock3, Code2, Copy, Download, ExternalLink, FileCode2, FolderOpen, Layers, ListChecks, LoaderCircle, Play, RotateCcw, ScrollText, ShieldCheck, Sparkles, Square, Terminal, TriangleAlert, X } from 'lucide-react';
import { api, errorMessage, safePreviewUrl } from './api';
import { StatusBadge, Tag } from './components';
import type { AppConfig, Project, StageStatus } from './types';
import MobilePreview from './MobilePreview';
import RevisionComposer from './RevisionComposer';
import AgentDeliveryPanel from './AgentDeliveryPanel';
import WorkflowReview, { ReviewHistory } from './WorkflowReview';
import ModelActivity from './ModelActivity';

type DetailTab = 'overview' | 'files' | 'checks' | 'logs';

function StageIcon({ status }: { status: StageStatus }) {
  if (status === 'completed') return <Check size={14} strokeWidth={2.5} />;
  if (status === 'running') return <LoaderCircle size={15} className="spin" />;
  if (status === 'failed') return <X size={14} />;
  if (status === 'skipped') return <ArrowRight size={13} />;
  return <Circle size={6} fill="currentColor" />;
}

export default function ProjectDetail({ projectId, onProjectChange, onOpenProject, onBack, config }: { projectId: string; onProjectChange: (project: Project) => void; onOpenProject:(id:string)=>void; onBack: () => void; config: AppConfig | null }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [activeFile, setActiveFile] = useState('');
  const [action, setAction] = useState<'cancel' | 'retry' | 'launch' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const logsBottom = useRef<HTMLDivElement>(null);
  const [previewLink, setPreviewLink] = useState<string | null>(null);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setProject(null); setError(null); setPreviewLink(null); setActiveFile(''); setTab('overview');
    const update = async () => {
      try {
        const result = await api.project(projectId);
        if (disposed) return;
        setProject(result); onProjectChange(result); setError(null);
        setPreviewLink(safePreviewUrl(result.previewUrl));
        if (['queued', 'running'].includes(result.status)) timer = setTimeout(() => { void update(); }, 1300);
        else if (result.status==='awaiting_approval') timer = setTimeout(() => { void update(); }, 10000);
      } catch (err) {
        if (disposed) return;
        setError(errorMessage(err));
        timer = setTimeout(() => { void update(); }, 5000);
      }
    };
    void update();
    return () => { disposed = true; clearTimeout(timer); };
  }, [projectId, onProjectChange, refreshKey]);

  useEffect(() => { if (tab === 'logs') logsBottom.current?.scrollIntoView({ block: 'nearest' }); }, [tab, project?.logs.length]);
  useEffect(() => () => { if (copyTimeout.current) clearTimeout(copyTimeout.current); }, []);

  const perform = async (operation: 'cancel' | 'retry' | 'launch') => {
    if (!project || action) return;
    setAction(operation); setActionError(null);
    try {
      if (operation === 'launch') {
        const result = await api.launch(project.id);
        const safeUrl = safePreviewUrl(result.url);
        if (!safeUrl) throw new Error('유효한 미리보기 주소를 받지 못했습니다.');
        setPreviewLink(safeUrl);
      } else {
        const result = await api[operation](project.id); setProject(result); onProjectChange(result);
        if (operation === 'retry') setRefreshKey(key => key + 1);
      }
    } catch (err) { setActionError(errorMessage(err)); }
    finally { setAction(null); }
  };

  const file = project?.files.find(item => item.path === activeFile) || project?.files[0];
  const copyFile = async () => {
    if (!file) return;
    try { await navigator.clipboard.writeText(file.content); setCopied(true); copyTimeout.current = setTimeout(() => setCopied(false), 1800); }
    catch { setActionError('클립보드에 접근할 수 없어요. 코드 영역에서 직접 복사해 주세요.'); }
  };

  if (!project) return <div className="page-container inner-page"><button className="back-button" onClick={onBack}><ArrowLeft size={16} />내 프로젝트로</button>{error ? <div className="detail-load-error" role="alert"><TriangleAlert size={28} /><h2>프로젝트를 불러오지 못했어요</h2><p>{error}</p><button className="primary-button" onClick={() => setRefreshKey(key => key + 1)}><RotateCcw size={15} />다시 시도</button></div> : <div className="center-loading"><LoaderCircle size={24} className="spin" /><p>프로젝트를 불러오고 있어요.</p></div>}</div>;

  const running = project.status === 'running' || project.status === 'queued';
  const awaiting = project.status === 'awaiting_approval';
  const completed = project.status === 'completed';
  const doneCount = project.stages.filter(stage => ['completed', 'skipped'].includes(stage.status)).length;
  const activeStage = project.stages.find(stage => stage.status === 'running');
  const passedChecks = project.checks.filter(check => check.passed).length;
  const lastLog = project.logs[project.logs.length - 1];

  return <div className="page-container detail-page">
    <button className="back-button" onClick={onBack}><ArrowLeft size={15} />내 프로젝트로</button>
    <div className="detail-heading"><div><div className="detail-eyebrow"><span>{project.kind === 'ai-agent' ? 'AI AGENT' : project.kind === 'mobile-app' ? 'ANDROID APPLICATION' : 'WEB APPLICATION'}</span><span className="dot-separator">/</span><span>{new Date(project.createdAt).toLocaleDateString('ko-KR')}</span></div><h1>{project.name}</h1><div className="detail-meta"><StatusBadge project={project} /><span>{project.mode === 'local' ? '로컬 템플릿 모드' : project.authMode==='codex-subscription'?'Codex 구독으로 생성':'OpenAI로 생성'}</span><span className="dot-separator">·</span><span>수정 시도 {project.retryCount}회</span><span className="workflow-mode-label">{project.workflowMode === 'guided' ? '단계별로 확인' : '한 번에 자동으로'}</span></div></div><div className="detail-actions">{running || awaiting ? <button className="secondary-button" onClick={() => { void perform('cancel'); }} disabled={!!action}>{action === 'cancel' ? <LoaderCircle className="spin" size={14} /> : <Square size={13} />}생성 중지</button> : ['failed', 'cancelled'].includes(project.status) ? <button className="primary-button" onClick={() => { void perform('retry'); }} disabled={!!action}>{action === 'retry' ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}다시 만들기</button> : null}{completed && <><a className="secondary-button" href={`/api/projects/${encodeURIComponent(project.id)}/download`} download><Download size={15} />소스 다운로드</a>{previewLink && project.kind !== 'mobile-app' && <a className="primary-button" href={previewLink} target="_blank" rel="noopener noreferrer">앱 열기 <ArrowUpRight size={17} /></a>}</>}</div></div>
    {(actionError || error) && <div className="detail-error" role="alert"><TriangleAlert size={16} /><span>{actionError || error}</span><button className="icon-button" onClick={() => { setActionError(null); setError(null); }} aria-label="오류 메시지 닫기"><X size={15} /></button></div>}
    {project.error && <div className="detail-error" role="alert"><TriangleAlert size={17} /><div><b>생성 중 확인이 필요한 문제가 발생했어요.</b><p>{project.error}</p></div></div>}
    {project.revision&&<p className="revision-origin">버전 {project.revision.number} · {project.revision.message} {project.parentProjectId&&<a href={`#project/${project.parentProjectId}`} onClick={event=>{event.preventDefault();onOpenProject(project.parentProjectId!);}}>이전 버전 보기</a>}</p>}
    {project.mode === 'local' && project.kind !== 'mobile-app' && <div className="local-mode-notice"><Sparkles size={15} /><p><b>로컬 템플릿으로 만든 MVP예요.</b> 기획에 표시된 템플릿 기능을 실행합니다. 외부 서비스 연결과 AI 추론은 별도의 설정이 필요해요.</p></div>}
    <div className="detail-layout">
      <aside className="pipeline-panel"><div className="pipeline-heading"><div><WorkflowIcon /><h2>개발 워크플로</h2></div><span>{doneCount}/{project.stages.length || 8}</span></div><div className="pipeline-progress"><span style={{ width: `${doneCount / (project.stages.length || 8) * 100}%` }} /></div><ol className="pipeline-stages">{project.stages.map((stage, index) => <li className={awaiting && project.review?.stage === stage.id ? 'reviewing' : stage.status} key={stage.id}><span className="pipeline-stage-icon">{awaiting && project.review?.stage === stage.id ? <Clock3 size={14}/> : <StageIcon status={stage.status} />}</span><div><span className="pipeline-stage-step">STEP {String(index + 1).padStart(2, '0')}</span><h3>{stage.label}</h3><p>{awaiting && project.review?.stage === stage.id ? '확인 대기' : stage.status === 'running' ? stage.detail || '작업을 진행하고 있어요' : stage.status === 'skipped' ? '추가 수정 없이 통과했어요' : stage.status === 'completed' ? '완료' : stage.status === 'failed' ? '확인이 필요해요' : '준비 중'}</p></div>{stage.status === 'running' && <span className="stage-live-dot" />}</li>)}</ol><div className="pipeline-bottom"><ShieldCheck size={15} /><span>실제 생성과 검증 결과를 표시해요</span></div></aside>
      <div className="detail-workspace">
        {awaiting && <WorkflowReview key={project.review?.id} project={project} config={config} disabled={!!action} onReviewed={result=>{setProject(result);onProjectChange(result);setRefreshKey(key=>key+1);}}/>}
        <ReviewHistory project={project}/>
        <ModelActivity project={project}/>
        {!awaiting && <div className={`workspace-status ${completed ? 'complete' : ''}`}><span className="workspace-status-icon">{completed ? <CheckCheck size={25} /> : running ? <Sparkles size={23} /> : <Clock3 size={22} />}</span><div><span className="workspace-status-eyebrow">{completed ? 'READY FOR YOUR NEXT STEP' : running ? 'YOUR IDEA IS TAKING SHAPE' : 'WORKFLOW PAUSED'}</span><h2>{completed ? '아이디어가 첫 번째 앱이 되었어요.' : running ? activeStage ? `${activeStage.label}, 진행하고 있어요.` : '당신의 아이디어를 준비하고 있어요.' : project.status === 'cancelled' ? '프로젝트 생성이 중지되었어요.' : '잠시 멈춰서 확인이 필요해요.'}</h2><p>{completed ? '실행해 보고, 소스 코드를 자유롭게 확장해 보세요.' : running ? lastLog?.message || '진행 상황과 생성되는 결과를 여기서 확인할 수 있어요.' : '기록된 로그를 확인하고 다시 시도할 수 있어요.'}</p></div>{running && <LoaderCircle className="spin workspace-status-spinner" size={20} />}</div>}
        {completed && project.kind === 'mobile-app' && <MobilePreview project={project} />}
        {completed && project.kind === 'ai-agent' && <AgentDeliveryPanel project={project} previewUrl={previewLink}/>}
        {completed&&<RevisionComposer key={project.id} project={project} config={config} onCreated={next=>{onProjectChange(next);onOpenProject(next.id);}}/>}
        <div className="detail-tabs" role="tablist" aria-label="프로젝트 상세"><button role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><Layers size={15} />프로젝트 개요</button><button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><Code2 size={16} />소스 코드<span>{project.files.length}</span></button><button role="tab" aria-selected={tab === 'checks'} className={tab === 'checks' ? 'active' : ''} onClick={() => setTab('checks')}><ListChecks size={16} />검증 결과{project.checks.length > 0 && <span>{passedChecks}/{project.checks.length}</span>}</button><button role="tab" aria-selected={tab === 'logs'} className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}><ScrollText size={15} />실행 로그</button></div>
        <div className="detail-tab-content" role="tabpanel">
          {tab === 'overview' && <div className="overview-content"><section className="prompt-summary"><span className="content-eyebrow">THE ORIGINAL IDEA</span><p>“{project.prompt}”</p></section>{project.plan ? <><section className="plan-summary"><div className="content-section-title"><h3>아이디어를 이렇게 구체화했어요</h3><Tag>{project.kind === 'ai-agent' ? 'AI 에이전트' : project.kind === 'mobile-app' ? 'Android 앱' : '웹 앱'}</Tag></div><p>{project.plan.summary}</p><div className="audience-line"><span>이런 분을 위해</span><b>{project.plan.audience}</b></div></section><section className="features-section"><div className="content-section-title"><h3>핵심 기능</h3><span className="muted-label">{project.plan.features.length}개의 기능</span></div><div className="feature-list">{project.plan.features.map((feature, index) => <div className="feature-row" key={`${feature.name}-${index}`}><span className="feature-check"><Check size={13} /></span><div><h4>{feature.name}</h4><p>{feature.description}</p></div><Tag tone={feature.priority === 'core' ? 'green' : ''}>{feature.priority === 'core' ? '핵심' : '확장'}</Tag></div>)}</div></section><section className="stack-section"><div className="content-section-title"><h3>기술 스택</h3></div><div className="stack-list">{project.plan.stack.map((stack, index) => <div key={`${stack.name}-${index}`}><Code2 size={16} /><b>{stack.name}</b><span>{stack.role}</span></div>)}</div></section>{project.plan.assumptions.length > 0 && <section className="assumptions-section"><h3><Sparkles size={15} />이렇게 가정하고 시작했어요</h3><ul>{project.plan.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></section>}</> : <div className="tab-empty"><Layers size={27} /><h3>{running ? '프로젝트의 밑그림을 그리고 있어요' : '아직 생성된 계획이 없어요'}</h3><p>{running ? '분석이 끝나면 기능, 구조와 기술 스택이 여기에 나타나요.' : '다시 만들기를 눌러 프로젝트를 시작할 수 있어요.'}</p></div>}{completed && project.kind !== 'mobile-app' && <section className="preview-section"><div className="preview-top"><span><ExternalLink size={20} /></span><div><h3>이제 직접 사용해 보세요</h3><p>별도 창에서 실행되는 실제 결과물을 확인하세요.</p></div></div><div className="preview-controls">{previewLink && <a href={previewLink} target="_blank" rel="noopener noreferrer" className="primary-button"><Play size={14} />미리보기 열기 <ArrowUpRight size={15} /></a>}<button className="secondary-button" onClick={() => { void perform('launch'); }} disabled={!!action}>{action === 'launch' ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}{previewLink ? '실행 서버 다시 시작' : '앱 실행하기'}</button></div>{previewLink && <p className="preview-address">{new URL(previewLink).origin}<span>{previewLink.startsWith('https:') ? '보호된 클라우드 미리보기' : '로컬 실행 · 공개되지 않음'}</span></p>}</section>}</div>}
          {tab === 'files' && (project.files.length ? <div className="file-explorer"><div className="file-tree"><div className="file-tree-heading"><FolderOpen size={14} />PROJECT FILES</div>{project.files.map(item => <button key={item.path} className={file?.path === item.path ? 'active' : ''} onClick={() => { setActiveFile(item.path); setCopied(false); }}><FileCode2 size={14} /><span>{item.path}</span></button>)}</div><div className="code-panel"><div className="code-heading"><span><FileCode2 size={14} />{file?.path}</span><button className="icon-button" onClick={() => { void copyFile(); }} aria-label={copied ? '복사 완료' : '파일 내용 복사'}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></div><pre className="source-code"><code>{file?.content}</code></pre><div className="code-footer"><span>{file?.language}</span><span>{file?.content.split('\n').length} lines</span></div></div></div> : <div className="tab-empty"><FileCode2 size={28} /><h3>코드가 준비되면 여기에 나타나요</h3><p>프로젝트 생성 이후 실제 파일의 내용을 확인할 수 있어요.</p></div>)}
          {tab === 'checks' && <div className="checks-content">{project.checks.length ? <><div className="checks-summary"><span className={passedChecks === project.checks.length ? 'all-pass' : 'has-failure'}>{passedChecks === project.checks.length ? <ShieldCheck size={31} /> : <TriangleAlert size={29} />}</span><div><h3>{passedChecks === project.checks.length ? '실제 실행 검증을 통과했어요' : '검증 결과를 확인해 주세요'}</h3><p>{project.checks.length}개의 검사 중 {passedChecks}개 통과</p></div></div><div className="check-list">{project.checks.map((check, index) => <div className={`check-row ${check.passed ? 'pass' : 'fail'}`} key={`${check.name}-${index}`}>{check.passed ? <CheckCircle2 size={18} /> : <TriangleAlert size={18} />}<div><h4>{check.name}</h4><p>{check.detail}</p></div><Tag tone={check.passed ? 'green' : 'red'}>{check.passed ? '통과' : '실패'}</Tag></div>)}</div><p className="checks-note"><ShieldCheck size={14} />기본 동작 검증 결과예요. 공개 서비스 운영 전에는 추가 보안·사용성 점검이 필요해요.</p></> : <div className="tab-empty"><ShieldCheck size={29} /><h3>코드를 만들고, 실제로 확인해요</h3><p>검증 단계가 시작되면 문법과 기능 검사 결과가 표시돼요.</p></div>}</div>}
          {tab === 'logs' && <div className="logs-content"><div className="logs-heading"><span><Terminal size={15} />WORKFLOW LOGS</span><span>{project.logs.length} events{running && <span className="log-live"><i />LIVE</span>}</span></div><div className="logs-list" aria-live="polite">{project.logs.length ? project.logs.map(log => <div className={`log-entry ${log.level}`} key={log.id}><time>{new Date(log.timestamp).toLocaleTimeString('ko-KR', { hour12: false })}</time><span className="log-level">{log.level === 'success' ? <Check size={13} /> : log.level === 'error' ? <X size={13} /> : log.level === 'warn' ? <TriangleAlert size={12} /> : <ChevronRight size={13} />}</span><div><span className="log-stage">{log.stage}</span><p>{log.message}</p></div></div>) : <div className="logs-empty">워크플로가 시작되면 실제 로그를 표시합니다.</div>}<div ref={logsBottom} /></div></div>}
        </div>
      </div>
    </div>
  </div>;
}

function WorkflowIcon() { return <span className="workflow-tiny-icon"><i /><i /><i /></span>; }

