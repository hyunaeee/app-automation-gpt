import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight, Boxes, ChevronDown, ChevronRight, CircleHelp, Code2, Folder, GitBranch, LayoutGrid, LoaderCircle, LockKeyhole, LogOut, Menu, Plus, Search, Settings2, ShieldCheck, Sparkles, Workflow, X } from 'lucide-react';
import { api, errorMessage } from './api';
import { AgentMini, EmptyProjects, Mark, Modal, ProjectCard, TemplateCard, stageDescriptions, templates } from './components';
import type { Page } from './components';
import type { AppConfig, Project, ProjectKind, AgentDelivery, WorkflowMode } from './types';
import ProjectDetail from './ProjectDetail';
import StudioHome from './StudioHome';
import ModelConnection from './ModelConnection';
import { GoogleConnection } from './GoogleConnection';
import type { AuthSession } from './types';

const pageNames: Record<Page, string> = { new: '새 프로젝트', projects: '내 프로젝트', workflow: '워크플로', templates: '템플릿' };

function routeFromHash(): { page: Page; projectId: string | null } {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('project/')) {
    try { return { page: 'projects', projectId: decodeURIComponent(hash.slice(8)) || null }; }
    catch { return { page: 'projects', projectId: null }; }
  }
  return { page: Object.hasOwn(pageNames, hash) ? hash as Page : 'new', projectId: null };
}

export default function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [modal, setModal] = useState<'settings' | 'help' | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<ProjectKind>('web-app');
  const [agentDelivery,setAgentDelivery]=useState<AgentDelivery>('web');
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>('auto');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextConfig, nextProjects] = await Promise.all([api.config(), api.projects()]);
      setConfig(nextConfig); setProjects(nextProjects); setConnectionError(null);
    } catch (error) { setConnectionError(errorMessage(error)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void api.authSession().then(setAuth).catch(error => { setAuthError(errorMessage(error)); }); }, []);
  useEffect(() => { if (auth?.authenticated) void refresh(); }, [refresh, auth]);
  useEffect(() => {
    const expired = () => { setAuth(current=>({ authenticated: false, required: true,google:current?.google })); setConfig(null); setProjects([]); setModal(null); setLoading(true); };
    window.addEventListener('launchpad:auth-expired', expired);
    return () => window.removeEventListener('launchpad:auth-expired', expired);
  }, []);
  useEffect(() => {
    const handler = () => { setRoute(routeFromHash()); setMobileMenu(false); window.scrollTo({ top: 0, behavior: 'instant' }); };
    window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler);
  }, []);
  useEffect(() => {
    if (!projects.some(project => ['queued', 'running', 'awaiting_approval'].includes(project.status))) return;
    const active = projects.some(project => ['queued', 'running'].includes(project.status));
    const timer = window.setInterval(() => { void api.projects().then(setProjects).catch(() => undefined); }, active ? 2400 : 10000);
    return () => window.clearInterval(timer);
  }, [projects]);

  const navigate = (page: Page) => { window.location.hash = page; setMobileMenu(false); };
  const openProject = (id: string) => { window.location.hash = `project/${encodeURIComponent(id)}`; };
  const onProjectChange = useCallback((project: Project) => { setProjects(current => [project, ...current.filter(item => item.id !== project.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }, []);
  const closeModal = useCallback(() => setModal(null), []);
  const selectTemplate = (template: typeof templates[number]) => { setPrompt(template.prompt); setKind(template.kind); setCreateError(null); navigate('new'); window.setTimeout(() => textarea.current?.focus(), 80); };
  const createProject = async () => {
    if (creating) return;
    if (!config) { setCreateError('먼저 서버 연결을 확인해 주세요.'); return; }
    if (prompt.trim().length < 10) { setCreateError('만들고 싶은 앱을 10자 이상으로 설명해 주세요.'); textarea.current?.focus(); return; }
    setCreating(true); setCreateError(null);
    try { const project = await api.create(prompt.trim(), kind, agentDelivery, workflowMode); onProjectChange(project); openProject(project.id); }
    catch (error) { setCreateError(errorMessage(error)); }
    finally { setCreating(false); }
  };

  if (!auth || !auth.authenticated) return <LoginScreen google={auth?.google || false} checking={!auth && !authError} required={auth?.required ?? true} connectionError={authError} onLogin={async password => { await api.login(password); const nextAuth = await api.authSession(); setAuth(nextAuth); }} onRetry={() => { setAuthError(null); void api.authSession().then(setAuth).catch(error => setAuthError(errorMessage(error))); }} />;

  return <div className="app-shell">
    {mobileMenu && <div className="sidebar-scrim" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'open' : ''}`}>
      <a className="brand" href="#new" aria-label="Launchpad 홈"><Mark /><span>Launchpad<span className="brand-period">.</span></span></a>
      <button className="workspace-selector" onClick={() => setModal('settings')}><span className="workspace-avatar">L</span><span><b>My workspace</b><small>Creation studio</small></span><ChevronDown size={13} /></button>
      <div className="nav-label">STUDIO</div>
      <nav aria-label="주 메뉴">
        <button className={`nav-item ${route.page === 'new' ? 'active' : ''}`} onClick={() => navigate('new')}><Plus size={18} /><span>새 프로젝트</span><span className="nav-key"><Plus size={11} /></span></button>
        <button className={`nav-item ${route.page === 'projects' ? 'active' : ''}`} onClick={() => navigate('projects')}><Folder size={18} /><span>내 프로젝트</span><span className="nav-count">{projects.length}</span></button>
        <button className={`nav-item ${route.page === 'workflow' ? 'active' : ''}`} onClick={() => navigate('workflow')}><Workflow size={18} /><span>워크플로</span></button>
        <button className={`nav-item ${route.page === 'templates' ? 'active' : ''}`} onClick={() => navigate('templates')}><LayoutGrid size={18} /><span>템플릿</span></button>
      </nav>
      <div className="sidebar-note"><span className="sidebar-note-orbit" aria-hidden="true"><i /><i /><Sparkles size={20} /></span><span className="note-eyebrow">FROM ZERO TO ONE</span><h3>그다음 멋진 아이디어,<br />여기서 시작해요.</h3><button onClick={() => setModal('help')}>Launchpad 알아보기 <ArrowUpRight size={13} /></button></div>
      <div className="sidebar-bottom"><button className="nav-item" onClick={() => setModal('settings')}><Settings2 size={17} /><span>설정</span></button><button className="nav-item" onClick={() => setModal('help')}><CircleHelp size={17} /><span>도움말 및 가이드</span><ArrowUpRight size={14} /></button><div className="sidebar-profile"><span className="profile-avatar">L</span><div><b>{auth.user?.name || '나의 워크스페이스'}</b><span>{auth.user ? 'Google account' : 'Personal workspace'}</span></div><span className="profile-dot" /></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu-button" onClick={() => setMobileMenu(true)} aria-label="메뉴 열기"><Menu size={20} /></button><span>My workspace</span><ChevronRight size={13} /><b>{route.projectId ? '프로젝트' : pageNames[route.page]}</b></div><div className="topbar-right"><span className={`connection-dot ${config ? 'connected' : ''}`} /><span className="topbar-mode">{config ? config.authMode === 'codex-subscription' ? 'Codex 구독 사용 중' : config.mode === 'openai' ? config.credentialSource === 'personal' ? '개인 API 키 사용 중' : '공용 API 키 사용 중' : '로컬 템플릿 모드' : loading ? '연결 확인 중' : '서버 연결 필요'}</span><span className="topbar-divider" /><button className="guide-button" onClick={() => setModal('help')}>시작 가이드 <ArrowUpRight size={14} /></button></div></header>
      <main>
        {connectionError && <div className="connection-banner" role="alert"><span>서버에 연결하지 못했어요. {connectionError}</span><button onClick={() => { setLoading(true); void refresh(); }}>다시 연결 <ArrowRight size={13} /></button></div>}
        {route.projectId ? <ProjectDetail projectId={route.projectId} onProjectChange={onProjectChange} onOpenProject={openProject} onBack={() => navigate('projects')} config={config} /> : route.page === 'new' ? <StudioHome config={config} projects={projects} loading={loading} prompt={prompt} kind={kind} agentDelivery={agentDelivery} setAgentDelivery={setAgentDelivery} workflowMode={workflowMode} setWorkflowMode={setWorkflowMode} creating={creating} createError={createError} textarea={textarea} setPrompt={setPrompt} setKind={setKind} setCreateError={setCreateError} createProject={createProject} selectTemplate={selectTemplate} navigate={navigate} openProject={openProject} /> : route.page === 'projects' ? <ProjectsPage projects={projects} loading={loading} onNew={() => navigate('new')} onOpen={openProject} /> : route.page === 'templates' ? <TemplatesPage onSelect={selectTemplate} /> : <WorkflowPage config={config} onStart={() => navigate('new')} />}
      </main>
    </div>
    {modal === 'settings' && <Modal title="AI 연결 및 설정" onClose={closeModal}>
      <div className="modal-content">
        <GoogleConnection session={auth} /><ModelConnection onChange={refresh} config={config} />
        <details className="workspace-details">
          <summary>워크스페이스 정보 <Settings2 size={14} /></summary>
          <dl className="config-list">
            <div><dt>생성 모드</dt><dd>{config?.mode === 'openai' ? 'OpenAI' : '로컬 템플릿'}</dd></div>
            <div><dt>모델</dt><dd>{config?.model==='codex-default'?'Codex 기본 모델':config?.model || '템플릿 엔진'}</dd></div>
            <div><dt>최대 자동 수정</dt><dd>{config ? `${config.maxRetries}회` : '확인 중'}</dd></div>
            <div><dt>워크스페이스</dt><dd>{auth.google ? 'Google 계정으로 보호됨' : auth.required ? '비밀번호로 보호됨' : '이 컴퓨터에서 실행 중'}</dd></div>
          </dl>
        </details>
        <button className="secondary-button full-width settings-done" onClick={closeModal}>완료</button>
        {auth.required && <button className="text-button logout-button" onClick={() => { void api.logout().then(() => { closeModal(); setProjects([]); setConfig(null); setAuth({ authenticated: false, required: true,google:auth.google }); }).catch(error => setConnectionError(errorMessage(error))); }}><LogOut size={15} />워크스페이스 로그아웃</button>}
      </div>
    </Modal>}
    {modal === 'help' && <Modal title="첫 아이디어를 앱으로 만드는 방법" onClose={closeModal}><div className="modal-content"><div className="help-heading"><span className="help-spark"><Sparkles size={26} /></span><h3>코딩 경험이 없어도 괜찮아요.</h3><p>만들고 싶은 것과 누가 사용할지만 알려주세요.</p></div><ol className="help-steps"><li><span>1</span><div><b>아이디어를 한두 문장으로</b><p>“매일 읽은 책을 기록하고 관리하는 나만의 독서 앱”처럼 입력해 보세요.</p></div></li><li><span>2</span><div><b>나에게 맞는 진행 방식 선택</b><p>자동 모드는 결과물까지 이어서 진행해요. 단계별 모드는 기획·기능·설계를 확인하거나 수정한 뒤 구현을 시작해요.</p></div></li><li><span>3</span><div><b>완성된 앱을 실행하고 가져가기</b><p>미리보기에서 회원가입 후 사용해 보고, 전체 소스를 ZIP으로 내려받을 수 있어요.</p></div></li></ol><div className="subtle-callout"><Code2 size={18} /><p>결과물은 로컬 또는 Vercel Sandbox에서 실행되는 MVP입니다. 로컬 모드는 기본 템플릿을, AI 모드는 맞춤 계획과 화면을 생성합니다. 생성된 앱의 영구 공개 배포와 외부 서비스 연결은 별도 설정이 필요해요.</p></div><button className="primary-button full-width" onClick={() => { closeModal(); navigate('new'); }}>아이디어 시작하기 <ArrowRight size={16} /></button></div></Modal>}
  </div>;
}

function LoginScreen({ checking, required, google, connectionError, onLogin, onRetry }: { google:boolean; checking: boolean; required: boolean; connectionError: string | null; onLogin: (password: string) => Promise<void>; onRetry: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = async () => { setBusy(true); setError(null); try { await onLogin(password); setPassword(''); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };
  return <div className="login-page"><a className="brand login-brand" href="#new"><Mark /><span>Launchpad<span className="brand-period">.</span></span></a><div className="login-card"><span className="login-symbol"><Sparkles size={28} /></span><div className="eyebrow">A LITTLE IDEA. A BIG BEGINNING.</div><h1>다음 아이디어가<br />시작되는 곳.</h1><p className="login-subtitle">당신의 AI 개발팀이 기다리고 있어요.</p>{checking ? <div className="login-loading"><LoaderCircle size={19} className="spin" />워크스페이스 연결 중</div> : connectionError ? <div className="login-connection-error"><p role="alert">{connectionError}</p><button className="primary-button full-width" onClick={onRetry}>다시 연결 <ArrowRight size={16} /></button></div> : google ? <><a className="google-login-button" href="/api/auth/google/start"><span className="google-letter">G</span>Google 계정으로 계속하기</a>{new URLSearchParams(window.location.search).has('auth_error') && <p className="form-error" role="alert">Google 로그인을 완료하지 못했어요. 다시 시도해 주세요.</p>}<p className="login-hint">내 프로젝트와 AI 연결을 계정에 보관하세요.</p></> : required ? <form onSubmit={event => { event.preventDefault(); void login(); }}><label htmlFor="workspace-password">워크스페이스 비밀번호</label><div className="password-field"><LockKeyhole size={16} /><input id="workspace-password" type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="공유받은 비밀번호를 입력해 주세요" /></div>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button full-width" type="submit" disabled={busy || !password}>{busy ? <LoaderCircle size={16} className="spin" /> : null}워크스페이스 시작하기 <ArrowRight size={17} /></button><p className="login-hint"><ShieldCheck size={13} />이 워크스페이스는 비밀번호로 보호되고 있어요.</p></form> : <button className="primary-button full-width" onClick={onRetry}>워크스페이스 연결 <ArrowRight size={16} /></button>}</div><span className="login-footer">From your first thought to your first app.</span></div>;
}

function ProjectsPage({ projects, loading, onNew, onOpen }: { projects: Project[]; loading: boolean; onNew: () => void; onOpen: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | ProjectKind>('all');
  const filtered = projects.filter(project => (filter === 'all' || project.kind === filter) && `${project.name} ${project.prompt}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="page-container inner-page"><div className="page-title-row"><div><div className="eyebrow"><span />YOUR CREATIONS</div><h1>아이디어가 자라는 공간</h1><p>작은 시작부터 실행 가능한 프로젝트까지, 모두 여기에.</p></div><button className="primary-button" onClick={onNew}><Plus size={17} />새 프로젝트</button></div><div className="project-toolbar"><div className="filter-tabs">{([['all', '전체'], ['web-app', '웹 앱'], ['mobile-app','모바일 앱'], ['ai-agent', 'AI 에이전트']] as const).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}<span>{projects.filter(p => value === 'all' || p.kind === value).length}</span></button>)}</div><label className="search-field"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="프로젝트 검색" aria-label="프로젝트 검색" />{search && <button onClick={() => setSearch('')} aria-label="검색 지우기"><X size={14} /></button>}</label></div>{loading ? <div className="center-loading"><LoaderCircle size={22} className="spin" /><p>프로젝트를 불러오고 있어요.</p></div> : filtered.length ? <div className="project-grid">{filtered.map(project => <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project.id)} />)}</div> : projects.length ? <div className="no-results"><Search size={27} /><h3>일치하는 프로젝트가 없어요</h3><p>다른 검색어를 입력하거나 필터를 바꿔 보세요.</p><button className="text-button" onClick={() => { setSearch(''); setFilter('all'); }}>필터 초기화 <ArrowRight size={15} /></button></div> : <EmptyProjects onNew={onNew} />}</div>;
}

function TemplatesPage({ onSelect }: { onSelect: (template: typeof templates[number]) => void }) {
  const [filter, setFilter] = useState<'all' | ProjectKind>('all');
  return <div className="page-container inner-page"><div className="page-title-row"><div><div className="eyebrow"><span />A PLACE TO START</div><h1>다음 아이디어의 출발점.</h1><p>마음에 드는 템플릿을 고르고, 당신의 아이디어를 더해 보세요.</p></div><span className="template-page-spark">✳</span></div><div className="project-toolbar"><div className="filter-tabs">{([['all', '모든 템플릿'], ['web-app', '웹 앱'], ['mobile-app','모바일 앱'], ['ai-agent', 'AI 에이전트']] as const).map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><span className="muted-label">아이디어 템플릿 {templates.filter(t => filter === 'all' || t.kind === filter).length}개</span></div><div className="template-grid expanded">{templates.filter(template => filter === 'all' || template.kind === filter).map(template => <TemplateCard key={template.id} template={template} onSelect={() => onSelect(template)} />)}</div><div className="template-explanation"><Sparkles size={21} /><div><h3>좋은 아이디어는, 당신의 이야기에서 시작돼요.</h3><p>템플릿을 선택하면 설명란에 예시가 채워져요. 원하는 기능을 더하거나 바꾼 다음 프로젝트를 만들어 보세요. 카드 이미지는 영감을 위한 예시이며, 실제 결과물은 생성 모드에 따라 달라집니다.</p></div></div></div>;
}

function WorkflowPage({ config, onStart }: { config: AppConfig | null; onStart: () => void }) {
  return <div className="page-container inner-page workflow-page"><div className="page-title-row"><div><div className="eyebrow"><span />MEET YOUR AI TEAM</div><h1>생각에서 실행까지, 자연스럽게.</h1><p>한 번에 맡기거나, 기획·기능·설계를 함께 확인하며 진행할 수 있어요.</p></div><button className="primary-button" onClick={onStart}>직접 만들어보기 <ArrowRight size={16} /></button></div><div className="workflow-team"><AgentMini name="Planner" role="아이디어를 구체적으로" icon="plan" /><ArrowRight size={18} /><AgentMini name="Coding Agent" role="계획을 코드로" icon="code" /><ArrowRight size={18} /><AgentMini name="Validation Agent" role="실행하고 검증하기" icon="test" /></div><div className="workflow-grid">{stageDescriptions.map((stage, index) => <article className="workflow-stage" key={stage.icon}><span className="workflow-stage-number">{stage.icon}</span><div><span className="workflow-stage-agent">{stage.agent}</span><h3>{stage.title}</h3><p>{stage.text}</p></div>{index < 7 && <ArrowDown className="workflow-stage-arrow" size={16} />}</article>)}</div><div className="workflow-notes"><article><span><GitBranch size={21} /></span><h3>오류가 나도, 다음 단계로</h3><p>검증에 실패하면 로그를 분석해 최대 {config?.maxRetries ?? 2}회까지 자동 수정을 시도해요. 테스트가 통과하면 수정 단계를 건너뛰고 결과물을 준비합니다.</p></article><article><span><Boxes size={21} /></span><h3>함께 확장할 수 있는 구조</h3><p>계획 · 생성 · 검증을 독립된 모듈로 구성했어요. 소스 코드의 템플릿과 검증 도구를 확장해 새로운 프로젝트 유형을 추가할 수 있습니다.</p></article><article><span><ShieldCheck size={21} /></span><h3>실행 가능한 기본기부터</h3><p>로그인, 데이터 저장, 실제 기능 테스트를 포함합니다. {config?.mode === 'openai' ? 'AI가 만든 화면은 분리된 실행 환경에서 미리볼 수 있어요.' : '로컬 모드에서는 검증된 템플릿을 사용하며, 복잡한 기능은 추가 개발이 필요해요.'}</p></article></div></div>;
}

