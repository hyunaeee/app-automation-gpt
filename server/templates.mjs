import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mobilePlan, generateMobileAssets } from './mobile-template.mjs';
import { normalizeAgentDelivery } from './agent-delivery.mjs';
import { consoleHtml, consoleJs } from './templates/agent-console.mjs';
import { isFashionProject, fashionPlan, fashionAssets } from './fashion-template.mjs';

const BASE_FILES = ['package.json', 'server.mjs', 'project.json', 'public/index.html', 'public/app.js', 'public/styles.css', 'README.md'];
const DELIVERY_FILES = { web: [], api: ['openapi.json', 'public/agent-console.html', 'public/agent-console.js'], mcp: ['agent-mcp.mjs', 'mcp.config.json'] };
export const TEMPLATE_FILES = [...BASE_FILES, 'agent-core.mjs', 'public/design-assets.js', ...DELIVERY_FILES.api, ...DELIVERY_FILES.mcp];
export function getTemplateFiles(project) {
  if (project.kind !== 'ai-agent') return [...BASE_FILES];
  return [...BASE_FILES, 'agent-core.mjs', ...DELIVERY_FILES[normalizeAgentDelivery(project.kind, project.agentDelivery)]];
}
export const registry = new Map();
export function registerTemplate(kind, template) {
  if (!/^[a-z][a-z-]+$/.test(kind) || typeof template?.plan !== 'function' || typeof template?.generate !== 'function') throw new Error('A template requires kind, plan() and generate().');
  registry.set(kind, template);
}

const rules = [
  { regex: /독서|책|도서|reading|book/i, name: '나의 독서 기록', noun: '독서 기록', audience: '읽은 책과 생각을 정리하는 사람', description: '책 제목과 감상을 기록하고 독서 진행 상태를 관리합니다.' },
  { regex: /여행|trip|travel/i, name: '트립 플래너', noun: '여행 계획', audience: '여행 일정을 정리하는 사람', description: '여행지와 일정 메모를 저장하고 준비 상태를 관리합니다.' },
  { regex: /운동|헬스|fitness|workout/i, name: '데일리 피트니스', noun: '운동 기록', audience: '운동 습관을 꾸준히 기록하는 사람', description: '운동 이름과 내용을 기록하고 완료 상태를 관리합니다.' },
  { regex: /고객|CRM|영업/i, name: '고객 관리 워크스페이스', noun: '고객 메모', audience: '고객과 영업 메모를 관리하는 소규모 팀', description: '고객 이름과 상담 메모를 저장하고 후속 작업을 관리합니다.' },
  { regex: /레시피|요리|recipe/i, name: '나의 레시피 노트', noun: '레시피', audience: '요리법을 정리하는 사람', description: '레시피 이름과 조리 메모를 저장하고 관리합니다.' },
];

export function localPlan(prompt, kind, options = {}) {
  const matched = rules.find(rule => rule.regex.test(prompt));
  const domain = matched || { name: '아이디어 워크스페이스', noun: '작업', audience: '개인 프로젝트와 작업을 정리하는 사람', description: '작업과 메모를 저장하고 진행 상태를 관리합니다.' };
  const agent = kind === 'ai-agent';
  const delivery = agent ? normalizeAgentDelivery(kind, options.agentDelivery) : undefined;
  return {
    name: agent ? '텍스트 에이전트 스튜디오' : domain.name,
    summary: agent ? '로그인과 작업 기록을 포함한 텍스트 분석 에이전트입니다. 로컬에서는 문자·단어 집계와 체크리스트 변환을 실행합니다.' : domain.description,
    audience: agent ? '텍스트를 분석하고 결과를 보관하는 사람' : domain.audience,
    features: [
      { name: '회원가입과 로그인', description: '이메일 가입, scrypt 비밀번호 해싱, HttpOnly 세션 및 로그아웃', priority: 'core' },
      { name: agent ? '작업 결과 보관' : `${domain.noun} 관리`, description: '사용자별 생성·조회·수정·삭제 및 진행 상태 저장', priority: 'core' },
      ...(agent ? [{ name: '텍스트 도구 실행', description: '로컬 텍스트 통계 및 체크리스트 변환. 서버 API 키 설정 시 AI 도구 사용 가능', priority: 'core' }] : [{ name: '검색과 상태 필터', description: '제목·메모 검색과 진행 상태별 필터', priority: 'core' }]),
      ...(delivery === 'api' ? [{ name: '인증된 HTTP API', description: '만료·해지 가능한 프로젝트 전용 Bearer 토큰, 실행 API와 OpenAPI 호출 명세', priority: 'core' }] : delivery === 'mcp' ? [{ name: '로컬 MCP 서버', description: '공식 SDK stdio 연결의 tools/list·tools/call과 클라이언트 연결 예제', priority: 'core' }] : []),
      { name: '반응형 화면', description: '데스크톱과 모바일에서 동작하는 웹 화면', priority: 'extra' },
    ],
    assumptions: [
      '로컬 모드는 키워드에 맞는 템플릿을 선택합니다. 자유로운 요구사항을 이해하거나 임의 기능을 구현하는 AI 생성 모드가 아닙니다.',
      `원문 요구사항: ${prompt}`,
      'MVP 범위는 개인별 계정과 기록 관리입니다. 결제, 이메일 발송, 외부 서비스 연동, 계정 복구는 포함하지 않습니다.',
      '데이터는 이 컴퓨터의 JSON 파일에 저장됩니다. 배포 전 운영용 데이터베이스와 보안 설정이 필요합니다.',
      ...(delivery === 'api' ? ['HTTP API는 별도 앱 로그인으로 발급한 토큰을 사용합니다. 웹 미리보기 URL은 임시 실행 환경이며 상시 API 호스팅과 사용량 제한은 별도 구성입니다.'] : delivery === 'mcp' ? ['MCP는 내려받은 소스를 클라이언트에서 로컬 stdio 프로세스로 실행합니다. 원격 MCP URL·자동 OAuth·구독 연결은 제공하지 않습니다.'] : []),
    ],
    stack: [ { name: 'Node.js 22+', role: '의존성 없는 HTTP API와 파일 저장' }, { name: 'HTML · CSS · JavaScript', role: '반응형 브라우저 UI' }, { name: 'scrypt · HttpOnly', role: '비밀번호 해싱과 서버 세션' } ],
    fileTree: getTemplateFiles({ kind, agentDelivery: options.agentDelivery }),
  };
}

const indexHtml = `<!doctype html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Launchpad 앱</title><link rel="stylesheet" href="/styles.css"></head>
<body><div id="app"><p class="loading">앱을 불러오는 중입니다…</p></div><script type="module" src="/app.js"></script></body></html>`;

const appJs = String.raw`const root = document.querySelector('#app');
let config; let user = null; let items = []; let authMode = 'signup'; let filter = 'all'; let search = '';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '요청에 실패했습니다.'); return data;
}
function alertError(error) { const target = document.querySelector('#message'); if (target) { target.textContent = error.message; target.hidden = false; } }
function shell(content) { root.innerHTML = '<header><a class="brand" href="/"><span class="logo">✦</span>' + escape(config.name) + '</a><span class="tag">' + (config.kind === 'ai-agent' ? 'AGENT STUDIO' : 'WORKSPACE') + '</span>' + (user ? '<span class="account">' + escape(user.name) + '</span><button id="logout" class="quiet">로그아웃</button>' : '') + '</header><main>' + content + '</main><footer>당신의 아이디어에서 시작된 작은 가능성 · Built with Launchpad</footer>'; document.querySelector('#logout')?.addEventListener('click', async () => { try { await api('/api/auth/logout', {method:'POST'}); user = null; renderAuth(); } catch(error) { alertError(error); } }); }
function renderAuth() {
  shell('<section class="auth-layout"><div class="intro"><p class="eyebrow">A LITTLE SPACE FOR YOUR IDEAS</p><h1>좋은 아이디어를,<br><span>매일의 기록으로.</span></h1><p class="subtitle">' + escape(config.summary) + '</p><div class="intro-features"><p>✓ 나만의 안전한 워크스페이스</p><p>✓ 기록하고, 정리하고, 완성하기</p><p>✓ 작은 화면에서도 편안하게</p></div></div><form id="auth" class="panel auth"><div class="mini-logo">✦</div><h2>' + (authMode === 'signup' ? '처음 오셨나요?' : '다시 만나서 반가워요') + '</h2><p class="muted">' + (authMode === 'signup' ? '새 계정으로 시작해 보세요.' : '이메일로 워크스페이스에 로그인하세요.') + '</p>' + (authMode === 'signup' ? '<label>이름<input name="name" placeholder="어떻게 불러드릴까요?" maxlength="80" required autocomplete="name"></label>' : '') + '<label>이메일<input name="email" type="email" placeholder="you@example.com" required autocomplete="email"></label><label>비밀번호<input name="password" type="password" placeholder="8자 이상 입력하세요" minlength="8" maxlength="256" required autocomplete="' + (authMode === 'signup' ? 'new-password' : 'current-password') + '"></label><p id="message" class="error" hidden></p><button class="primary" type="submit">' + (authMode === 'signup' ? '내 공간 만들기 →' : '로그인 →') + '</button><button type="button" id="switch" class="switch">' + (authMode === 'signup' ? '이미 계정이 있어요 · 로그인' : '아직 계정이 없어요 · 회원가입') + '</button></form></section>');
  document.querySelector('#switch').addEventListener('click', () => { authMode = authMode === 'signup' ? 'login' : 'signup'; renderAuth(); });
  document.querySelector('#auth').addEventListener('submit', async event => { event.preventDefault(); const submit = event.target.querySelector('[type="submit"]'); submit.disabled = true; try { const result = await api('/api/auth/' + authMode, { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); user = result.user; await loadItems(); renderWorkspace(); } catch(error) { alertError(error); } finally { submit.disabled = false; } });
}
async function loadItems() { items = await api('/api/items'); }
function renderWorkspace() {
  const done = items.filter(item => item.status === 'done').length;
  shell('<section class="workspace"><div class="page-heading"><div><p class="eyebrow">YOUR PERSONAL WORKSPACE</p><h1>' + escape(user.name) + '님의 공간<span class="dot">.</span></h1><p class="muted">작은 기록이 모여 더 큰 결과가 됩니다.</p></div><span class="date">' + new Date().toLocaleDateString('ko-KR') + '</span></div><div class="stats"><article><span>전체 기록</span><strong>' + items.length + '</strong></article><article><span>진행 중</span><strong>' + items.filter(item => item.status === 'in-progress').length + '</strong></article><article><span>완료한 기록</span><strong class="green">' + done + '</strong></article></div>' + (config.kind === 'ai-agent' ? '<section class="panel agent"><p class="eyebrow">TEXT AGENT</p><h2>반복 작업을 가볍게</h2><p class="muted">로컬 도구는 텍스트를 규칙에 따라 분석합니다. AI 도구는 서버 API 키가 필요합니다.</p><form id="agent"><textarea name="input" placeholder="분석하거나 정리할 텍스트를 붙여 넣으세요…" required maxlength="20000"></textarea><div class="row"><select name="tool"><option value="analyze">로컬 · 텍스트 통계</option><option value="checklist">로컬 · 체크리스트 변환</option>' + (config.aiAvailable ? '<option value="ai">AI · 자연어 요청</option>' : '') + '</select><button class="primary">도구 실행 →</button></div></form><pre id="agent-result" hidden></pre><button id="save-agent" class="quiet" hidden>결과를 기록으로 저장</button></section>' : '') + '<div class="content-grid"><section class="records"><div class="records-title"><h2>나의 기록 <span class="count">' + items.length + '</span></h2></div><div class="toolbar"><input id="search" type="search" placeholder="제목과 내용을 검색하세요" value="' + escape(search) + '"><select id="filter"><option value="all">모든 상태</option><option value="todo">시작 전</option><option value="in-progress">진행 중</option><option value="done">완료</option></select></div><div id="items"></div></section><form id="create" class="panel create"><p class="eyebrow">NEW RECORD</p><h2>새로운 기록</h2><label>제목<input name="title" placeholder="무엇을 기록할까요?" required maxlength="200"></label><label>내용<textarea name="description" placeholder="아이디어나 세부 내용을 자유롭게 적어보세요." maxlength="10000"></textarea></label><button class="primary">기록 추가 +</button></form></div><p id="message" class="error" hidden></p></section>');
  document.querySelector('#filter').value = filter;
  document.querySelector('#search').addEventListener('input', event => { search = event.target.value; renderItems(); });
  document.querySelector('#filter').addEventListener('change', event => { filter = event.target.value; renderItems(); });
  document.querySelector('#create').addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/items', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.target))) }); await loadItems(); renderWorkspace(); } catch(error) { alertError(error); } });
  document.querySelector('#agent')?.addEventListener('submit', async event => { event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; button.textContent = '실행 중…'; try { const result = await api('/api/agent/run', {method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(event.target)))}); const output = document.querySelector('#agent-result'); output.textContent = result.output; output.hidden = false; document.querySelector('#save-agent').hidden = false; } catch(error) { alertError(error); } finally { button.disabled = false; button.textContent = '도구 실행 →'; } });
  document.querySelector('#save-agent')?.addEventListener('click', async () => { try { await api('/api/items', {method:'POST', body:JSON.stringify({title:'에이전트 실행 결과', description:document.querySelector('#agent-result').textContent})}); await loadItems(); renderWorkspace(); } catch(error) { alertError(error); } });
  renderItems();
}
function renderItems() {
  const visible = items.filter(item => (filter === 'all' || item.status === filter) && (item.title + ' ' + item.description).toLowerCase().includes(search.toLowerCase()));
  document.querySelector('#items').innerHTML = visible.length ? visible.map(item => '<article class="item"><div class="item-heading"><span class="status ' + item.status + '">' + ({todo:'시작 전','in-progress':'진행 중',done:'완료'}[item.status]) + '</span><time>' + new Date(item.createdAt).toLocaleDateString('ko-KR') + '</time></div><h3>' + escape(item.title) + '</h3><p>' + escape(item.description || '아직 작성된 내용이 없습니다.') + '</p><div class="item-actions"><select aria-label="진행 상태" data-status="' + item.id + '"><option value="todo" ' + (item.status === 'todo' ? 'selected' : '') + '>시작 전</option><option value="in-progress" ' + (item.status === 'in-progress' ? 'selected' : '') + '>진행 중</option><option value="done" ' + (item.status === 'done' ? 'selected' : '') + '>완료</option></select><button class="quiet" data-edit="' + item.id + '">수정</button><button class="quiet danger" data-delete="' + item.id + '">삭제</button></div></article>').join('') : '<div class="empty"><span>✧</span><h3>' + (items.length ? '검색 결과가 없습니다.' : '아직 비어 있는, 가능성의 공간') + '</h3><p>첫 번째 기록을 추가해 보세요.</p></div>';
  document.querySelectorAll('[data-status]').forEach(select => select.addEventListener('change', () => updateItem(select.dataset.status, {status: select.value})));
  document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', async () => { if (!confirm('이 기록을 삭제할까요?')) return; try { await api('/api/items/' + button.dataset.delete, {method:'DELETE'}); await loadItems(); renderWorkspace(); } catch(error) { alertError(error); } }));
  document.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => { const item = items.find(value => value.id === button.dataset.edit); const title = prompt('제목 수정', item.title); if (title === null) return; const description = prompt('내용 수정', item.description); if (description === null) return; updateItem(item.id, { title, description }); }));
}
async function updateItem(id, values) { try { await api('/api/items/' + id, {method:'PATCH', body:JSON.stringify(values)}); await loadItems(); renderWorkspace(); } catch(error) { alertError(error); } }
try { config = await api('/api/config'); document.title = config.name; try { user = (await api('/api/auth/me')).user; } catch {} if (user) { await loadItems(); renderWorkspace(); } else renderAuth(); } catch(error) { root.textContent = '앱을 불러오지 못했습니다: ' + error.message; }
`;

const styles = `@import url('');
:root{font-family:Inter,Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#23352b;background:#f8faf7;font-synthesis:none}*{box-sizing:border-box}body{margin:0}button,input,textarea,select{font:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.55}header{height:82px;border-bottom:1px solid #e4eae3;padding:0 6%;display:flex;align-items:center;gap:20px;background:#fff}.brand{font-weight:750;font-size:19px;text-decoration:none;color:inherit;display:flex;align-items:center;gap:12px}.logo,.mini-logo{color:#568651;background:#edf3e9;border-radius:12px;padding:8px 11px;font-size:23px}.tag{font-size:10px;letter-spacing:1.3px;border:1px solid #dfe7dc;border-radius:5px;padding:5px 8px;color:#789171}.account{margin-left:auto;font-size:13px}main{max-width:1250px;margin:auto;padding:58px 40px;min-height:calc(100vh - 148px)}footer{text-align:center;font-size:11px;color:#a0aa9e;padding:25px;border-top:1px solid #e7ece4}.auth-layout{display:grid;grid-template-columns:1.2fr 1fr;align-items:center;gap:90px;min-height:650px}.eyebrow{font-size:10px;letter-spacing:2px;color:#83977d;font-weight:750}.intro h1{font-size:48px;line-height:1.45;letter-spacing:-2px;font-weight:750}.intro h1 span{color:#6c8b59}.subtitle{line-height:1.9;color:#788172;max-width:440px;font-size:15px}.intro-features{margin-top:38px;font-size:13px;color:#647b5b}.intro-features p{margin:18px 0}.panel{border:1px solid #e2e9dd;border-radius:20px;background:#fff;padding:32px;box-shadow:0 10px 35px #2c462d04}.auth{padding:38px}.mini-logo{display:inline-block}h2{font-size:22px;letter-spacing:-.7px}label{display:block;font-size:12px;font-weight:600;margin:23px 0 0}input,textarea,select{display:block;width:100%;border:1px solid #e0e6db;border-radius:8px;padding:12px 13px;background:#fcfdfb;outline:none;color:#334932;transition:border .2s}input:focus,textarea:focus,select:focus{border-color:#7d9a67;box-shadow:0 0 0 3px #edf3e6}input,textarea{margin-top:9px;font-size:13px}textarea{min-height:140px;resize:vertical;line-height:1.7}input::placeholder,textarea::placeholder{color:#adb5a5}.primary{background:#6f8b54;border:1px solid #6f8b54;color:white;border-radius:8px;padding:13px 18px;font-size:13px;font-weight:650}.auth .primary,.create .primary{width:100%;margin-top:25px}.primary:hover{background:#5f7947}.switch{border:0;background:none;width:100%;font-size:12px;color:#829076;margin-top:25px}.muted{color:#89927f;font-size:13px;line-height:1.8}.error{color:#aa4336;font-size:13px;background:#fff0e9;border-radius:8px;padding:14px;white-space:pre-wrap}.quiet{border:0;background:transparent;color:#87917b;font-size:12px;padding:7px}.danger{color:#b57668}.page-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:36px}.page-heading h1{font-size:36px;letter-spacing:-1.4px;margin:12px 0}.dot{color:#73944f}.date{font-size:12px;color:#8c9684}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:36px}.stats article{border:1px solid #e3e9df;background:#fff;border-radius:14px;padding:25px}.stats span{font-size:12px;color:#8a967f}.stats strong{display:block;font-size:32px;font-weight:650;margin-top:12px}.green{color:#71944e}.content-grid{display:grid;grid-template-columns:1.8fr 1fr;gap:30px}.records-title{display:flex;align-items:center}.records-title h2{font-size:19px}.count{font-size:11px;background:#e8f0e0;color:#75905e;border-radius:5px;padding:4px 8px;margin-left:7px}.toolbar{display:flex;gap:12px;margin:8px 0 20px}.toolbar input{margin:0}.toolbar select{width:130px;font-size:12px}.create{align-self:start}.create h2{font-size:20px}.item{background:#fff;border:1px solid #e2e8dd;border-radius:14px;padding:23px;margin-bottom:16px}.item-heading{display:flex;justify-content:space-between;align-items:center}.status{font-size:10px;border-radius:4px;padding:5px 8px;background:#f1f3ec;color:#93987d}.status.in-progress{background:#fff2d8;color:#aa904e}.status.done{background:#e8f2e1;color:#76955c}time{color:#a1aa96;font-size:10px}.item h3{font-size:16px;margin:17px 0 9px}.item>p{font-size:13px;color:#8a9381;line-height:1.7;white-space:pre-wrap;word-break:break-word}.item-actions{display:flex;gap:9px;align-items:center;margin-top:20px;border-top:1px solid #f0f3ec;padding-top:13px}.item-actions select{width:110px;padding:6px;font-size:11px;margin-right:auto}.empty{text-align:center;background:#fff;border:1px dashed #d9e4d1;border-radius:14px;padding:65px 20px;color:#95a489}.empty span{font-size:40px;color:#a6ba94}.empty h3{font-size:15px;font-weight:500}.empty p{font-size:12px}.agent{margin-bottom:36px}.agent textarea{min-height:140px}.row{display:flex;gap:16px;justify-content:space-between;margin-top:15px}.row select{width:250px}pre{white-space:pre-wrap;word-break:break-word;line-height:1.8;background:#f4f7ef;border-radius:10px;padding:25px;font-family:inherit;font-size:13px}.loading{text-align:center;padding:20vh 0;color:#849478}@media(max-width:800px){header{height:auto;min-height:72px;padding:18px 5%;flex-wrap:wrap;gap:10px}.tag{display:none}.brand{font-size:16px}.account{font-size:11px}main{padding:30px 20px}.auth-layout{grid-template-columns:1fr;gap:30px;min-height:0}.intro h1{font-size:34px}.intro-features{display:none}.auth{padding:26px}.content-grid{grid-template-columns:1fr}.create{grid-row:1}.stats{gap:10px}.stats article{padding:17px}.stats strong{font-size:26px}.page-heading h1{font-size:27px}.date{display:none}.panel{padding:24px}.row{flex-wrap:wrap}.row select{width:100%}.row button{width:100%}}`;

export async function generateTemplate(project) {
  const runtime = await fs.readFile(fileURLToPath(new URL('./templates/runtime.mjs', import.meta.url)), 'utf8');
  const delivery = normalizeAgentDelivery(project.kind, project.agentDelivery);
  const fashion = isFashionProject(project.prompt || '', project.kind);
  const config = { id: project.id, name: project.plan.name, kind: project.kind, summary: project.plan.summary, ...(delivery ? { agentDelivery: delivery } : {}), ...(fashion ? { templateId: 'fashion' } : {}) };
  const files = [
    { path: 'package.json', content: JSON.stringify({ name: `launchpad-${project.id.slice(0, 8)}`, version: '1.0.0', private: true, type: 'module', engines: { node: '>=22' }, scripts: { start: 'node server.mjs', check: 'node --check server.mjs && node --check public/app.js' } }, null, 2), language: 'json' },
    { path: 'server.mjs', content: runtime, language: 'javascript' },
    { path: 'project.json', content: JSON.stringify(config, null, 2), language: 'json' },
    { path: 'public/index.html', content: indexHtml, language: 'html' },
    { path: 'public/app.js', content: appJs, language: 'javascript' },
    { path: 'public/styles.css', content: styles.replace("@import url('');\n", ''), language: 'css' },
    { path: 'README.md', content: `# ${project.plan.name}\n\n${project.plan.summary}\n\n## 실행\n\nNode.js 22 이상에서:\n\n\`\`\`sh\nnode server.mjs\n\`\`\`\n\n터미널에 출력된 port로 http://127.0.0.1:PORT 를 여세요. 고정 포트는 PORT 환경변수로 지정합니다. 외부 패키지 설치가 필요 없습니다.\n\n## 데이터와 계정\n\n처음에는 회원가입이 필요합니다. 비밀번호는 scrypt로 해싱되고 세션 쿠키는 HttpOnly, SameSite=Strict로 설정됩니다. 계정과 기록은 .runtime/data.json에 저장됩니다. 다른 사용자의 기록에는 접근할 수 없습니다.\n\n이 프로젝트는 로컬 MVP입니다. 공개 배포 전 HTTPS, 운영 데이터베이스, 로그인 속도 제한, 비밀번호 재설정, 이메일 인증, 백업 등을 추가하세요.\n\n## 에이전트\n\n에이전트 유형에서는 로컬 텍스트 집계와 체크리스트 도구를 사용할 수 있습니다. AI 도구를 쓰려면 서버 시작 환경에 OPENAI_API_KEY를 설정하고 필요하면 OPENAI_MODEL을 지정하세요. 비밀 키를 브라우저 코드에 넣지 마세요.\n\n## 검증 범위\n\n생성 시 Node 문법, 정적 자산 제공, 회원가입·로그인·로그아웃, 잘못된 비밀번호 거부, 사용자별 CRUD 및 격리 검사를 실행합니다. 브라우저 UI 전체 또는 임의 업무 요구사항의 충족을 보증하지 않습니다.\n`, language: 'markdown' },
  ];
  if (project.kind === 'ai-agent') {
    const core = await fs.readFile(new URL('./templates/agent-core.mjs', import.meta.url), 'utf8');
    files.push({ path: 'agent-core.mjs', content: core, language: 'javascript' });
    const packageFile = files.find(file => file.path === 'package.json');
    const pkg = JSON.parse(packageFile.content);
    pkg.scripts.check += ' && node --check agent-core.mjs';
    if (delivery === 'api') {
      const spec = {
        openapi: '3.1.0', info: { title: config.name + ' Agent API', version: '1.0.0', description: '프로젝트 전용 Bearer 토큰을 /console에서 발급하세요. 웹 세션이나 Launchpad 로그인 토큰을 사용하지 않습니다. 모델 도구는 서버의 OpenAI API 키가 필요합니다.' },
        servers: [{ url: '/' }],
        paths: { '/v1/agent/run': { post: { operationId: 'runAgent', summary: '에이전트 텍스트 도구 실행', security: [{ agentToken: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['input'], properties: { input: { type: 'string', minLength: 1, maxLength: 20000 }, tool: { type: 'string', enum: ['analyze', 'checklist', 'ai'], default: 'analyze' } } } } } }, responses: { '200': { description: '도구 실행 결과', content: { 'application/json': { schema: { type: 'object', required: ['output','mode','tool'], properties: { output: { type: 'string' }, mode: { type: 'string', enum: ['local','openai'] }, tool: { type: 'string', enum: ['analyze','checklist','ai'] } } } } } }, '400': { description: '잘못된 입력 또는 도구' }, '401': { description: '토큰 누락·만료·해지 또는 다른 프로젝트 토큰' }, '502': { description: 'OpenAI 요청 실패' }, '503': { description: 'OpenAI 서버 키 미설정' } } } } },
        components: { securitySchemes: { agentToken: { type: 'http', scheme: 'bearer', bearerFormat: 'lpa_ token', description: '생성 앱 계정의 /api/tokens에서 발급. agent:run 범위만 허용.' } } },
      };
      files.push({ path: 'openapi.json', content: JSON.stringify(spec, null, 2), language: 'json' }, { path: 'public/agent-console.html', content: consoleHtml, language: 'html' }, { path: 'public/agent-console.js', content: consoleJs, language: 'javascript' });
      pkg.scripts.check += ' && node --check public/agent-console.js';
      // This local template includes the entry link; the fixed /console route
      // remains available even if a model replaces the three editable assets.
      const app = files.find(file => file.path === 'public/app.js');
      app.content = app.content.replace("'<section class=\"workspace\">", "'<section class=\"workspace\"><p><a href=\"/console\">API 토큰 · 호출 콘솔 ↗</a></p>");
    }
    if (delivery === 'mcp') {
      files.push({ path: 'agent-mcp.mjs', content: await fs.readFile(new URL('./templates/agent-mcp.mjs', import.meta.url), 'utf8'), language: 'javascript' });
      files.push({ path: 'mcp.config.json', content: JSON.stringify({ mcpServers: { [`launchpad-${project.id.slice(0,8)}`]: { command: 'node', args: ['/ABSOLUTE/PATH/TO/PROJECT/agent-mcp.mjs'] } } }, null, 2), language: 'json' });
      pkg.dependencies = { '@modelcontextprotocol/sdk': '1.32.0', zod: '4.6.5' };
      pkg.scripts.mcp = 'node agent-mcp.mjs';
      pkg.scripts.check += ' && node --check agent-mcp.mjs';
    }
    packageFile.content = JSON.stringify(pkg, null, 2);
    const readme = files.find(file => file.path === 'README.md');
    const instructions = delivery === 'api'
      ? `## HTTP API 연결\n\n웹 서버를 시작하고 /console에서 이 생성 앱의 계정으로 가입·로그인하세요. 토큰을 발급하면 원문은 한 번만 표시됩니다. 서버에는 SHA-256 해시·계정·프로젝트·유효기간만 저장합니다. 기본 유효기간은 1일이며 60초~30일을 지정할 수 있습니다. 계정별 활성 토큰은 최대 10개입니다.\n\n- POST /api/tokens: 로그인 세션으로 { name, expiresInSeconds } 발급\n- GET /api/tokens: 본인 토큰 메타데이터만 조회\n- DELETE /api/tokens/:id: 본인 토큰 즉시 해지\n- POST /v1/agent/run: Authorization: Bearer YOUR_AGENT_TOKEN과 { input, tool }\n- GET /openapi.json: OpenAPI 3.1 명세\n\n기계 호출은 미리보기 쿠키 없이 Bearer 토큰만 사용합니다. 이 토큰으로 다른 프로젝트나 계정 데이터에 접근할 수 없습니다. analyze/checklist는 로컬 실행, ai는 OpenAI API 호출입니다. 토큰을 발급하는 브라우저 경로는 기존 미리보기·로그인 접근 제한을 그대로 적용합니다. 공개 운영에는 HTTPS·호출 제한·비용 제한·영속 DB를 추가하세요. Sandbox 미리보기 주소는 만료될 수 있는 임시 실행 주소입니다.\n`
      : delivery === 'mcp'
        ? `## MCP 클라이언트 연결 (로컬 stdio)\n\nNode.js 22 이상에서 npm install --ignore-scripts를 실행하세요. 공식 @modelcontextprotocol/sdk 1.32.0과 zod 4.6.5를 설치합니다. mcp.config.json의 /ABSOLUTE/PATH/TO/PROJECT/agent-mcp.mjs를 내려받은 프로젝트의 실제 절대 경로로 바꾸고, 사용 중인 MCP 클라이언트의 로컬 서버 설정에 등록하세요. Windows JSON 경로의 역슬래시는 이스케이프하거나 슬래시를 쓰세요. 클라이언트별 설정 형식·로컬 명령 허용 여부를 확인해야 합니다.\n\n클라이언트가 node agent-mcp.mjs를 자식 프로세스로 실행하고 initialize → tools/list → tools/call로 연결합니다. 사용 가능한 도구는 analyze, checklist, ai이며 모두 { input: string }을 받습니다. 터미널에서 직접 시작하면 JSON-RPC 입력을 기다리는 것이 정상입니다. stdout은 프로토콜 전용입니다.\n\nAI 도구는 MCP 프로세스 환경에 OPENAI_API_KEY를 안전하게 주입해야 하며 필요하면 OPENAI_MODEL을 지정합니다. 키는 이 ZIP이나 예제 설정에 포함되어 있지 않습니다. 로컬 도구는 키가 필요 없습니다. 임의 명령·파일 접근·외부 도구 실행은 제공하지 않습니다. 이것은 로컬 stdio 서버이며 원격 HTTP MCP URL·자동 OAuth·ChatGPT 구독 연결을 제공하지 않습니다. Launchpad 웹 미리보기 주소를 MCP 서버 URL로 등록할 수 없습니다. 웹 미리보기와 MCP는 같은 agent-core.mjs를 사용하지만 연결 방식과 실행 프로세스가 다릅니다.\n\n공식 SDK: https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x · https://ts.sdk.modelcontextprotocol.io/server\n`
        : '## 웹 에이전트\n\n앱에 가입·로그인하고 웹 화면에서 도구를 실행하세요. 웹·HTTP API·MCP 결과물은 같은 agent-core.mjs 계약을 사용하지만, 이 결과물은 웹 방식으로 생성되어 API 토큰·MCP 엔드포인트를 노출하지 않습니다.\n';
    readme.content += '\n' + instructions;
    if (delivery === 'mcp') readme.content = readme.content.replace('외부 패키지 설치가 필요 없습니다.', '웹 화면 자체는 외부 패키지 없이 실행됩니다. MCP 연결은 아래 안내에 따라 공식 SDK 의존성을 설치해야 합니다.');
  }
  if (fashion) {
    const assets = fashionAssets(project);
    const readme = files.find(file => file.path === 'README.md');
    readme.content = `# ${project.plan.name}\n\n${project.plan.summary}\n\n## 실행\n\nNode.js 22 이상에서 npm start를 실행하고 출력된 로컬 포트를 브라우저에서 여세요. 외부 패키지가 필요 없습니다.\n\n## 패션 제작 기획 초안\n\n가방·상의 종류와 치수·원단 폭·단가를 입력하면 브라우저의 규칙 기반 계산으로 직사각형 부품 배치, 필요한 원단과 안감, 부자재·공임·개발비의 예상 비용을 확인할 수 있습니다. 현재 초안은 브라우저 로컬 저장소에 보관됩니다. 이 화면은 앱 계정 가입·로그인을 사용하지 않으며 서버의 계정별 기록 API와 별개입니다. 로컬 저장소를 지우면 초안도 사라집니다.\n\n표시 도면은 제작 기획용 개략도와 직사각형 배치 예상입니다. 실제 봉제 패턴·재단 가능성·핏·제조 품질을 검증하지 않습니다. 소재 특성·그레인·이음·봉제 공정 등 생산 전 전문가의 확인이 필요하며 표시 비용은 입력한 단가에 따른 추정치입니다. 외부 디자인 서비스·제조 견적·발주를 호출하지 않습니다.\n\n모델로 수정한 버전은 생성 시 제공된 기능과 검증 결과를 함께 확인하세요. 계정 API 테스트는 신뢰된 서버 기반의 동작만 확인하며 개별 패션 UI의 모든 기능을 보증하지 않습니다.\n`;
    return files.map(file => assets.find(asset => asset.path === file.path) || file);
  }
  return files;
}
registerTemplate('web-app', { plan: (prompt, kind, options) => isFashionProject(prompt, kind) ? { ...fashionPlan(prompt), fileTree: getTemplateFiles({ kind }) } : localPlan(prompt, kind, options), generate: generateTemplate });
registerTemplate('ai-agent', { plan: localPlan, generate: generateTemplate });
registerTemplate('mobile-app', { plan: mobilePlan, generate: async project => {
  const base = await generateTemplate(project), assets = generateMobileAssets(project);
  return base.map(file => assets.find(asset => asset.path === file.path) || (file.path === 'README.md' ? { ...file, content: `# ${project.plan.name}\n\nAndroid WebView 기반 오프라인 모바일 앱입니다. public/의 자산을 APK에 포함합니다. 서버는 웹 미리보기용이며 APK에는 필요하지 않습니다. 기록은 기기에 저장되며 클라우드 계정·동기화는 지원하지 않습니다.\n\n웹 미리보기: Node.js 22 이상에서 npm start. Android 소스는 Launchpad의 Android 소스 다운로드를 이용하세요.\n` } : file));
} });
