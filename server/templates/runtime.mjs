import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8'));
const dataPath = process.env.APP_DATA_FILE || path.join(root, '.runtime', 'data.json');
await fs.mkdir(path.dirname(dataPath), { recursive: true });
let db = { users: [], sessions: [], items: [], tokens: [] };
try { db = JSON.parse(await fs.readFile(dataPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
db.tokens ||= [];
const apiDelivery = config.kind === 'ai-agent' && config.agentDelivery === 'api';
const runAgent = config.kind === 'ai-agent' ? (await import('./agent-core.mjs')).runAgent : null;
let writes = Promise.resolve();
const save = () => {
  const contents = JSON.stringify(db, null, 2);
  writes = writes.then(async () => { await fs.writeFile(dataPath + '.tmp', contents); await fs.rename(dataPath + '.tmp', dataPath); });
  return writes;
};
const cookieName = 'lp_' + crypto.createHash('sha256').update(config.id || config.name).digest('hex').slice(0, 12);
const secureCookie = process.env.PUBLIC_ORIGIN?.startsWith('https://') ? '; Secure' : '';
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest();
const accessToken = process.env.PREVIEW_ACCESS_TOKEN || '';
const accessCookieName = cookieName + '_access';
const accessCookieValue = accessToken ? crypto.createHmac('sha256', accessToken).update('preview-access-cookie').digest('hex') : '';
const hash = (password, salt) => new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(key.toString('hex'))));
const json = (res, status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
const publicUser = user => ({ id: user.id, email: user.email, name: user.name });
const session = req => {
  const raw = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.split('=')[1];
  if (!raw) return null;
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const active = db.sessions.find(s => s.tokenHash === tokenHash && s.expiresAt > Date.now());
  return active ? db.users.find(u => u.id === active.userId) || null : null;
};
const body = async req => {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 100_000) throw Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 }); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw Object.assign(new Error('올바른 JSON 객체가 필요합니다.'), { status: 400 }); }
};
const text = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const signIn = async (res, user) => {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions = db.sessions.filter(s => s.expiresAt > Date.now());
  db.sessions.push({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), userId: user.id, expiresAt: Date.now() + 7 * 86400000 });
  await save();
  return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureCookie}` });
};
const publicToken = token => ({ id: token.id, name: token.name, scope: 'agent:run', createdAt: token.createdAt, expiresAt: token.expiresAt, revokedAt: token.revokedAt || null });
function bearerUser(req) {
  const match = /^Bearer (lpa_[a-f0-9]{64})$/i.exec(req.headers.authorization || '');
  if (!match) return null;
  const suppliedHash = digest(match[1]);
  const token = db.tokens.find(value => value.projectId === config.id && !value.revokedAt && value.expiresAt > Date.now() && /^[a-f0-9]{64}$/.test(value.tokenHash) && crypto.timingSafeEqual(Buffer.from(value.tokenHash, 'hex'), suppliedHash));
  return token && db.users.find(value => value.id === token.userId);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
  try {
    const host = req.headers.host || '';
    const publicOrigin = process.env.PUBLIC_ORIGIN || '';
    const publicHost = publicOrigin ? new URL(publicOrigin).host : '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && host !== publicHost) return json(res, 403, { error: '허용되지 않은 호스트입니다.' });
    const url = new URL(req.url, `http://${host}`);
    if (req.headers.origin && req.headers.origin !== `http://${host}` && req.headers.origin !== publicOrigin) return json(res, 403, { error: '외부 출처 요청은 허용되지 않습니다.' });
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, name: config.name });
    // Machine calls authenticate using a project-scoped token, independently of
    // the browser-only preview cookie. No other route bypasses that gate.
    if (apiDelivery && url.pathname === '/v1/agent/run') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST 메서드가 필요합니다.' }, { Allow: 'POST' });
      if (!bearerUser(req)) return json(res, 401, { error: '유효한 에이전트 API 토큰이 필요합니다.' }, { 'WWW-Authenticate': 'Bearer' });
      const input = await body(req);
      return json(res, 200, await runAgent(input.input, input.tool, config));
    }
    if (apiDelivery && req.method === 'GET' && url.pathname === '/openapi.json') return json(res, 200, JSON.parse(await fs.readFile(path.join(root, 'openapi.json'), 'utf8')));
    if (accessToken) {
      if (req.method === 'GET' && (url.pathname === '/' || (apiDelivery && url.pathname === '/console')) && url.searchParams.has('access')) {
        if (!crypto.timingSafeEqual(digest(url.searchParams.get('access')), digest(accessToken))) return json(res, 403, { error: '미리보기 접근 링크가 올바르지 않습니다.' });
        // The workspace and preview use different sites; Lax permits this top-level GET redirect.
        res.writeHead(303, { Location: url.pathname, 'Cache-Control': 'no-store', 'Set-Cookie': `${accessCookieName}=${accessCookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secureCookie}` }); return res.end();
      }
      const supplied = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(accessCookieName + '='))?.slice(accessCookieName.length + 1);
      if (!supplied || !crypto.timingSafeEqual(digest(supplied), digest(accessCookieValue))) return json(res, 403, { error: 'Launchpad 워크스페이스의 앱 실행 버튼으로 미리보기를 열어 주세요.' });
    }
    if (url.pathname === '/api/config') return json(res, 200, { ...config, aiAvailable: Boolean(process.env.OPENAI_API_KEY) });
    if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
      const input = await body(req); const email = text(input.email, 254).toLowerCase(); const password = typeof input.password === 'string' ? input.password : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 256) return json(res, 400, { error: '유효한 이메일과 8~256자 비밀번호가 필요합니다.' });
      if (db.users.some(u => u.email === email)) return json(res, 409, { error: '이미 등록된 이메일입니다.' });
      const salt = crypto.randomBytes(16).toString('hex'); const passwordHash = await hash(password, salt);
      if (db.users.some(u => u.email === email)) return json(res, 409, { error: '이미 등록된 이메일입니다.' });
      const user = { id: crypto.randomUUID(), email, name: text(input.name, 80) || email.split('@')[0], salt, passwordHash };
      db.users.push(user); return await signIn(res, user);
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const input = await body(req); const email = text(input.email, 254).toLowerCase();
      const user = db.users.find(u => u.email === email); const password = typeof input.password === 'string' ? input.password : '';
      if (!user || password.length > 256 || !crypto.timingSafeEqual(Buffer.from(await hash(password, user.salt), 'hex'), Buffer.from(user.passwordHash, 'hex'))) return json(res, 401, { error: '이메일 또는 비밀번호를 확인해 주세요.' });
      return await signIn(res, user);
    }
    const user = session(req);
    if (url.pathname === '/api/auth/me') return user ? json(res, 200, { user: publicUser(user) }) : json(res, 401, { error: '로그인이 필요합니다.' });
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const raw = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.split('=')[1];
      if (raw) { const tokenHash = crypto.createHash('sha256').update(raw).digest('hex'); db.sessions = db.sessions.filter(s => s.tokenHash !== tokenHash); await save(); }
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}` });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!user) return json(res, 401, { error: '로그인이 필요합니다.' });
      if (apiDelivery && url.pathname === '/api/tokens') {
        if (req.method === 'GET') return json(res, 200, db.tokens.filter(value => value.userId === user.id && value.projectId === config.id).map(publicToken));
        if (req.method === 'POST') {
          const input = await body(req), expiresInSeconds = input.expiresInSeconds ?? 86400;
          if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 30 * 86400) return json(res, 400, { error: '토큰 유효기간은 60초~30일 사이의 초 단위 정수로 지정해 주세요.' });
          if (db.tokens.filter(value => value.userId === user.id && value.projectId === config.id && !value.revokedAt && value.expiresAt > Date.now()).length >= 10) return json(res, 409, { error: '활성 토큰은 최대 10개입니다. 기존 토큰을 해지해 주세요.' });
          // Prune expired/revoked metadata before issuing; only a hash is persisted.
          db.tokens = db.tokens.filter(value => !value.revokedAt && value.expiresAt > Date.now());
          const raw = 'lpa_' + crypto.randomBytes(32).toString('hex'), now = Date.now();
          const token = { id: crypto.randomUUID(), projectId: config.id, userId: user.id, name: text(input.name, 80) || '새 API 토큰', tokenHash: digest(raw).toString('hex'), createdAt: now, expiresAt: now + expiresInSeconds * 1000 };
          db.tokens.push(token); await save();
          return json(res, 201, { ...publicToken(token), token: raw });
        }
      }
      const tokenMatch = apiDelivery && url.pathname.match(/^\/api\/tokens\/([a-f0-9-]{36})$/i);
      if (tokenMatch && req.method === 'DELETE') {
        const token = db.tokens.find(value => value.id === tokenMatch[1] && value.userId === user.id && value.projectId === config.id);
        if (!token) return json(res, 404, { error: '토큰을 찾을 수 없습니다.' });
        token.revokedAt = Date.now(); await save(); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/items' && req.method === 'GET') return json(res, 200, db.items.filter(item => item.userId === user.id));
      if (url.pathname === '/api/items' && req.method === 'POST') {
        const input = await body(req); if (!text(input.title, 200)) return json(res, 400, { error: '제목을 입력해 주세요.' });
        const now = new Date().toISOString(); const item = { id: crypto.randomUUID(), userId: user.id, title: text(input.title, 200), description: text(input.description, 10000), status: 'todo', createdAt: now, updatedAt: now };
        db.items.unshift(item); await save(); return json(res, 201, item);
      }
      const itemMatch = url.pathname.match(/^\/api\/items\/([\w-]+)$/);
      if (itemMatch && ['PATCH', 'DELETE'].includes(req.method)) {
        const item = db.items.find(i => i.id === itemMatch[1] && i.userId === user.id); if (!item) return json(res, 404, { error: '항목을 찾을 수 없습니다.' });
        if (req.method === 'DELETE') { db.items = db.items.filter(i => i.id !== item.id); await save(); return json(res, 200, { ok: true }); }
        const input = await body(req);
        if ('title' in input && !text(input.title, 200)) return json(res, 400, { error: '제목은 비워둘 수 없습니다.' });
        if ('title' in input) item.title = text(input.title, 200);
        if ('description' in input) item.description = text(input.description, 10000);
        if (['todo', 'in-progress', 'done'].includes(input.status)) item.status = input.status;
        item.updatedAt = new Date().toISOString(); await save(); return json(res, 200, item);
      }
      if (url.pathname === '/api/agent/run' && req.method === 'POST' && config.kind === 'ai-agent') {
        const input = await body(req);
        return json(res, 200, await runAgent(input.input, input.tool, config));
      }
      return json(res, 404, { error: 'API를 찾을 수 없습니다.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '허용되지 않은 메서드입니다.' });
    const filename = ({ '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/design-assets.js': 'design-assets.js', ...(apiDelivery ? { '/console': 'agent-console.html', '/agent-console.js': 'agent-console.js' } : {}) })[url.pathname];
    if (!filename) return json(res, 404, { error: '파일을 찾을 수 없습니다.' });
    const file = await fs.readFile(path.join(root, 'public', filename));
    res.writeHead(200, { 'Content-Type': filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch (error) { json(res, error.status || 500, { error: error.status ? error.message : '요청 처리 중 오류가 발생했습니다.' }); }
});
server.listen(Number(process.env.PORT || 0), process.env.HOST || '127.0.0.1', () => {
  const port = server.address().port;
  process.stdout.write(JSON.stringify({ ready: true, port }) + '\n');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { writes.finally(() => process.exit(0)); }));
