import crypto from 'node:crypto';

const COOKIE = 'launchpad_workspace';
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest();
const equal = (left, right) => crypto.timingSafeEqual(digest(left), digest(right));
const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

export function createAuth({ password, secret, secure = true, now = Date.now } = {}) {
  const configured = typeof password === 'string' && password.length >= 12 && typeof secret === 'string' && secret.length >= 32;
  function cookie(value, maxAge) { return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`; }
  return {
    configured,
    verify(req) {
      if (!configured) return false;
      const raw = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      const [payload, signature] = (raw || '').split('.');
      if (!payload || !signature || !equal(signature, sign(payload, secret))) return false;
      try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return Number.isFinite(data.exp) && data.exp > now() && equal(data.rev, sign(password, secret)); }
      catch { return false; }
    },
    login(input) {
      if (!configured || typeof input !== 'string' || !equal(input, password)) return null;
      const payload = Buffer.from(JSON.stringify({ exp: now() + 12 * 3600000, rev: sign(password, secret), nonce: crypto.randomBytes(12).toString('hex') })).toString('base64url');
      return cookie(`${payload}.${sign(payload, secret)}`, 12 * 3600);
    },
    logout: () => cookie('', 0),
  };
}
