import crypto from 'node:crypto';

// Endpoints from https://accounts.google.com/.well-known/openid-configuration.
// These fixed HTTPS endpoints never come from request headers or token claims.
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUER = 'https://accounts.google.com';
const SESSION_COOKIE = 'launchpad_google';
const FLOW_COOKIE = 'launchpad_google_flow';
const SESSION_SECONDS = 12 * 3600;
const FLOW_SECONDS = 10 * 60;
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest();
const equal = (left, right) => crypto.timingSafeEqual(digest(left), digest(right));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const validIssuer = value => value === ISSUER || value === 'accounts.google.com';

function appOrigin(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return url.origin;
  } catch { return null; }
}

function appendCookie(res, value) {
  const previous = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', previous ? [...(Array.isArray(previous) ? previous : [previous]), value] : value);
}

function cookieValue(req, name) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string' || header.length > 32768) return null;
  // Duplicate security cookies are ambiguous and can result from cookie tossing.
  const matches = header.split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

function ownerForSubject(subject) {
  const bytes = digest(`launchpad-google-owner-v1\0${ISSUER}\0${subject}`).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // UUIDv8: application-defined deterministic identity.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safePicture(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com')) ? url.href : null;
  } catch { return null; }
}

/** Google account identity only. This does not grant access to subscription credits. */
export function createGoogleAuth({
  clientId = process.env.GOOGLE_CLIENT_ID,
  clientSecret = process.env.GOOGLE_CLIENT_SECRET,
  publicAppUrl = process.env.PUBLIC_APP_URL,
  secret = process.env.SESSION_SECRET,
  allowedEmails = process.env.GOOGLE_ALLOWED_EMAILS || '',
  now = Date.now,
  fetch: fetcher = globalThis.fetch,
} = {}) {
  const origin = appOrigin(publicAppUrl);
  const configured = typeof clientId === 'string' && clientId.trim().length > 0 &&
    typeof clientSecret === 'string' && clientSecret.trim().length > 0 &&
    typeof secret === 'string' && secret.length >= 32 && Boolean(origin);
  const redirectUri = origin ? `${origin}/api/auth/google/callback` : null;
  const secure = origin?.startsWith('https:') || false;
  const emails = new Set((Array.isArray(allowedEmails) ? allowedEmails : String(allowedEmails).split(','))
    .map(value => String(value).trim().toLowerCase()).filter(Boolean));
  const sign = (kind, payload) => crypto.createHmac('sha256', secret).update(`launchpad-google-v1:${kind}:${clientId}:${payload}`).digest('base64url');
  const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const pack = (kind, data) => { const payload = base64url(data); return `${payload}.${sign(kind, payload)}`; };
  let jwksCache = null, jwksPending = null;

  function unpack(kind, value) {
    if (!configured || typeof value !== 'string' || value.length > 8000) return null;
    const parts = value.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)) || !equal(parts[1], sign(kind, parts[0]))) return null;
    try {
      const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      return object(data) && data.v === 1 && Number.isFinite(data.exp) && data.exp > now() &&
        Number.isFinite(data.iat) && data.iat <= now() + 60000 && data.iat < data.exp ? data : null;
    } catch { return null; }
  }

  function verify(req) {
    const data = unpack('session', cookieValue(req, SESSION_COOKIE));
    if (!data || data.exp - data.iat > SESSION_SECONDS * 1000 || !object(data.user)) return null;
    const user = data.user;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(user.ownerId || '') ||
      typeof user.email !== 'string' || typeof user.name !== 'string' || (emails.size && !emails.has(user.email.toLowerCase()))) return null;
    return { ownerId: user.ownerId, name: user.name, email: user.email, picture: safePicture(user.picture) };
  }

  async function requestJson(url, options, message) {
    try {
      const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Remote response was not successful');
      const text = await response.text();
      if (text.length > 128000) throw new Error('Remote response was too large');
      const data = JSON.parse(text);
      if (!object(data)) throw new Error('Remote response was not an object');
      return { data, response };
    } catch { throw fail(502, message); }
  }

  async function jwks(refresh = false) {
    if (!refresh && jwksCache?.expires > now()) return jwksCache.keys;
    if (!jwksPending) jwksPending = (async () => {
      const { data, response } = await requestJson(JWKS_URL, { headers: { accept: 'application/json' } }, 'Google 로그인 검증 정보를 불러오지 못했습니다. 다시 시도해 주세요.');
      if (!Array.isArray(data.keys) || !data.keys.length || data.keys.length > 100) throw fail(502, 'Google 로그인 검증 정보가 올바르지 않습니다.');
      const maxAge = Number(response.headers.get('cache-control')?.match(/(?:^|[,\s])max-age=(\d+)/i)?.[1] ?? 300);
      jwksCache = { keys: data.keys, expires: now() + Math.min(Math.max(maxAge, 0), 3600) * 1000, fetchedAt: now() };
      return data.keys;
    })().finally(() => { jwksPending = null; });
    return jwksPending;
  }

  async function verifyIdToken(token, nonce) {
    const invalid = () => fail(401, 'Google 계정 인증을 확인하지 못했습니다. 다시 로그인해 주세요.');
    if (typeof token !== 'string' || token.length > 24000) throw invalid();
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { throw invalid(); }
    if (!object(header) || !object(claims) || header.alg !== 'RS256' || typeof header.kid !== 'string' ||
      header.kid.length < 1 || header.kid.length > 256 || header.crit !== undefined || (header.typ !== undefined && header.typ !== 'JWT')) throw invalid();
    const keyMatches = key => object(key) && key.kid === header.kid && key.kty === 'RSA' &&
      (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig') && (!key.key_ops || key.key_ops.includes('verify'));
    let keys = await jwks(), key = keys.find(keyMatches);
    // A short cooldown avoids arbitrary kid values causing unbounded JWKS requests.
    if (!key && now() - jwksCache.fetchedAt >= 30000) { keys = await jwks(true); key = keys.find(keyMatches); }
    if (!key) throw invalid();
    try {
      const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
      if (!crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) throw invalid();
    } catch { throw invalid(); }
    const seconds = Math.floor(now() / 1000);
    const audience = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.length > 0 && claims.aud.every(value => typeof value === 'string') && claims.aud.includes(clientId));
    if (!validIssuer(claims.iss) || !audience || (claims.azp !== undefined && claims.azp !== clientId) ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) ||
      !Number.isInteger(claims.exp) || claims.exp <= seconds || !Number.isInteger(claims.iat) ||
      claims.iat > seconds + 60 || claims.iat >= claims.exp ||
      (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > seconds + 60)) ||
      typeof claims.nonce !== 'string' || !equal(claims.nonce, nonce) ||
      typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(claims.sub) ||
      claims.email_verified !== true || typeof claims.email !== 'string' ||
      claims.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) throw invalid();
    if (emails.size && !emails.has(claims.email.toLowerCase())) throw fail(403, '이 Google 계정은 워크스페이스에 접근할 수 없습니다.');
    const name = typeof claims.name === 'string' ? claims.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) : '';
    return { ownerId: ownerForSubject(claims.sub), email: claims.email, name: name || claims.email.split('@')[0], picture: safePicture(claims.picture) };
  }

  function requireConfigured() { if (!configured) throw fail(503, 'Google 로그인이 아직 설정되지 않았습니다. 관리자 설정을 확인해 주세요.'); }

  return {
    configured,
    redirectUri,
    verify,
    owner: req => verify(req)?.ownerId || null,
    status(req) { const user = verify(req); return { enabled: configured, authenticated: Boolean(user), user }; },
    start(_req, res) {
      requireConfigured();
      const state = crypto.randomBytes(32).toString('base64url');
      const nonce = crypto.randomBytes(32).toString('base64url');
      const verifier = crypto.randomBytes(48).toString('base64url');
      appendCookie(res, cookie(FLOW_COOKIE, pack('flow', { v: 1, state, nonce, verifier, iat: now(), exp: now() + FLOW_SECONDS * 1000 }), FLOW_SECONDS));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const target = new URL(AUTHORIZE_URL);
      target.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: 'openid email profile', state, nonce, code_challenge: digest(verifier).toString('base64url'),
        code_challenge_method: 'S256', prompt: 'select_account' }).toString();
      res.redirect(302, target.href);
    },
    async callback(req, res) {
      requireConfigured();
      const flow = unpack('flow', cookieValue(req, FLOW_COOKIE));
      appendCookie(res, cookie(FLOW_COOKIE, '', 0));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const query = req.query || Object.fromEntries(new URL(req.originalUrl || req.url || '/', origin).searchParams);
      if (!flow || flow.exp - flow.iat > FLOW_SECONDS * 1000 || typeof query.state !== 'string' || !equal(query.state, flow.state) ||
        typeof flow.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(flow.verifier) || typeof flow.nonce !== 'string' ||
        (query.iss !== undefined && !validIssuer(query.iss))) throw fail(401, '로그인 요청이 만료되었거나 일치하지 않습니다. 다시 로그인해 주세요.');
      if (query.error !== undefined) throw fail(401, 'Google 로그인이 취소되었습니다. 다시 로그인할 수 있습니다.');
      if (typeof query.code !== 'string' || !query.code.length || query.code.length > 4096) throw fail(400, 'Google 로그인 응답이 올바르지 않습니다.');
      const { data } = await requestJson(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ code: query.code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: flow.verifier }).toString() }, 'Google 로그인에 실패했습니다. 다시 시도해 주세요.');
      const user = await verifyIdToken(data.id_token, flow.nonce);
      appendCookie(res, cookie(SESSION_COOKIE, pack('session', { v: 1, user, iat: now(), exp: now() + SESSION_SECONDS * 1000 }), SESSION_SECONDS));
      // OAuth tokens stay in this request; only a signed application session is retained.
      res.redirect(303, `${origin}/#new`);
      return user;
    },
    logout(_req, res) {
      appendCookie(res, cookie(SESSION_COOKIE, '', 0));
      appendCookie(res, cookie(FLOW_COOKIE, '', 0));
      res.setHeader('Cache-Control', 'no-store');
    },
  };
}
