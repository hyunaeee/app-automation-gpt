import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGoogleAuth } from '../server/google-auth.mjs';

const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrongPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'google-key-1', alg: 'RS256', use: 'sig' };
const secret = 'test-application-session-secret-32-characters';
const clientId = 'test-client.apps.googleusercontent.com';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const decodeCookie = cookie => JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString());
const asCookies = response => [response.getHeader('Set-Cookie')].flat().filter(Boolean);
const cookieNamed = (response, name) => asCookies(response).find(value => value.startsWith(`${name}=`));
const cookieHeader = value => value.split(';')[0];
const signToken = (claims, header = {}, privateKey = pair.privateKey) => {
  const input = `${encode({ alg: 'RS256', kid: 'google-key-1', typ: 'JWT', ...header })}.${encode(claims)}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
};
function response() {
  const headers = new Map();
  return {
    headers, getHeader: name => headers.get(name.toLowerCase()), setHeader: (name, value) => headers.set(name.toLowerCase(), value),
    redirect(status, location) { this.status = status; this.location = location; },
  };
}
function fixture(options = {}) {
  let time = Date.UTC(2026, 9, 3), nonce = '', jwtHeader = {}, signingKey = pair.privateKey;
  const overrides = {}, requests = [];
  let keys = [publicJwk];
  const claims = () => ({ iss: 'https://accounts.google.com', aud: clientId, sub: 'google-person-001', nonce,
    exp: Math.floor(time / 1000) + 3600, iat: Math.floor(time / 1000), email: 'person@example.com', email_verified: true,
    name: '홍길동', picture: 'https://lh3.googleusercontent.com/a/profile', ...overrides });
  const settings = { clientId, clientSecret: 'test-client-secret-never-return', publicAppUrl: 'https://launchpad.example', secret,
    now: () => time, fetch: async (url, input) => {
      requests.push({ url, input });
      if (url === 'https://oauth2.googleapis.com/token') return Response.json({ id_token: signToken(claims(), jwtHeader, signingKey), access_token: 'private-oauth-token', refresh_token: 'private-refresh-token' });
      assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
      return Response.json({ keys }, { headers: { 'cache-control': 'public, max-age=3600' } });
    }, ...options };
  const auth = createGoogleAuth(settings);
  function start() {
    const res = response(); auth.start({ headers: { host: 'attacker.example' }, query: { next: 'https://attacker.example' } }, res);
    const target = new URL(res.location); nonce = target.searchParams.get('nonce');
    return { res, target, cookie: cookieHeader(cookieNamed(res, 'launchpad_google_flow')), state: target.searchParams.get('state') };
  }
  async function finish(flow = start(), query = {}) {
    const res = response();
    const user = await auth.callback({ headers: { cookie: flow.cookie }, query: { code: 'single-use-authorization-code', state: flow.state, ...query } }, res);
    return { res, user, cookie: cookieHeader(cookieNamed(res, 'launchpad_google')) };
  }
  return { auth, settings, start, finish, requests, overrides, claims,
    advance: milliseconds => { time += milliseconds; }, header: value => { jwtHeader = value; },
    signingKey: value => { signingKey = value; }, keys: value => { keys = value; } };
}

test('Google login remains disabled without complete server credentials and a trusted public origin', () => {
  for (const options of [{ clientId: '' }, { clientSecret: '' }, { secret: 'too-short' }, { publicAppUrl: '' },
    { publicAppUrl: 'http://remote.example' }, { publicAppUrl: 'https://app.example/child' },
    { publicAppUrl: 'https://user:pass@app.example' }, { publicAppUrl: 'https://app.example?next=bad' }]) {
    const { auth, requests } = fixture(options);
    assert.equal(auth.configured, false);
    assert.deepEqual(auth.status({ headers: {} }), { enabled: false, authenticated: false, user: null });
    assert.throws(() => auth.start({}, response()), { status: 503 });
    assert.equal(requests.length, 0);
  }
});

test('authorization uses state, nonce, PKCE, HttpOnly Lax cookie, and fixed redirects without requesting offline tokens', () => {
  const { auth, start } = fixture(); const { res, target } = start();
  const cookie = cookieNamed(res, 'launchpad_google_flow'), flow = decodeCookie(cookie);
  assert.equal(auth.redirectUri, 'https://launchpad.example/api/auth/google/callback');
  assert.equal(res.status, 302);
  assert.equal(target.origin, 'https://accounts.google.com');
  assert.equal(target.searchParams.get('redirect_uri'), auth.redirectUri);
  assert.equal(target.searchParams.get('response_type'), 'code');
  assert.equal(target.searchParams.get('scope'), 'openid email profile');
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('code_challenge'), crypto.createHash('sha256').update(flow.verifier).digest('base64url'));
  assert.equal(target.searchParams.get('state'), flow.state); assert.equal(target.searchParams.get('nonce'), flow.nonce);
  assert.equal(target.searchParams.has('client_secret'), false); assert.equal(target.searchParams.has('access_type'), false);
  assert.match(cookie, /HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  assert.equal(res.getHeader('Cache-Control'), 'no-store');
  assert.notEqual(start().state, target.searchParams.get('state'));
  const local = fixture({ publicAppUrl: 'http://127.0.0.1:3001' }).start();
  assert.doesNotMatch(cookieNamed(local.res, 'launchpad_google_flow'), /Secure/);
});

test('successful verified login sets a twelve-hour application session without retaining Google tokens', async () => {
  const fixtureA = fixture(); const flow = fixtureA.start(); const { res, user, cookie } = await fixtureA.finish(flow);
  assert.equal(res.status, 303); assert.equal(res.location, 'https://launchpad.example/#new');
  assert.match(user.ownerId, /^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.deepEqual(fixtureA.auth.status({ headers: { cookie } }), { enabled: true, authenticated: true, user });
  const headers = JSON.stringify([...res.headers]);
  assert.doesNotMatch(headers, /private-oauth-token|private-refresh-token|single-use-authorization-code|test-client-secret/);
  assert.match(cookieNamed(res, 'launchpad_google'), /Max-Age=43200; Secure$/);
  assert.match(cookieNamed(res, 'launchpad_google_flow'), /Max-Age=0;/);
  const tokenRequest = fixtureA.requests.find(value => value.url.includes('/token'));
  const body = new URLSearchParams(tokenRequest.input.body);
  assert.equal(body.get('code_verifier'), decodeCookie(cookieNamed(flow.res, 'launchpad_google_flow')).verifier);
  assert.equal(body.get('client_secret'), fixtureA.settings.clientSecret);
  assert.equal(tokenRequest.input.redirect, 'error');
  assert.equal(fixtureA.auth.verify({ headers: { cookie: cookie + 'x' } }), null);
  assert.equal(fixtureA.auth.verify({ headers: { cookie: `${cookie}; ${cookie}` } }), null);
  assert.equal(createGoogleAuth({ ...fixtureA.settings, clientId: 'different-client' }).verify({ headers: { cookie } }), null);
  fixtureA.advance(12 * 3600000 + 1);
  assert.equal(fixtureA.auth.verify({ headers: { cookie } }), null);
});

test('owner identity follows the verified Google subject across email changes and canonical issuer aliases', async () => {
  const first = fixture(), second = fixture();
  second.overrides.email = 'new-address@example.com'; second.overrides.iss = 'accounts.google.com';
  assert.equal((await first.finish()).user.ownerId, (await second.finish()).user.ownerId);
  const third = fixture(); third.overrides.sub = 'different-google-person';
  assert.notEqual((await first.finish()).user.ownerId, (await third.finish()).user.ownerId);
});

test('invalid or expired transaction cookies and mismatched state are rejected before any token exchange', async () => {
  const f = fixture(), flow = f.start();
  for (const request of [{ cookie: '' }, { cookie: flow.cookie + 'tampered' }, { cookie: flow.cookie, state: 'wrong-state' },
    { cookie: flow.cookie, state: [flow.state, flow.state] }]) {
    const res = response();
    await assert.rejects(f.auth.callback({ headers: { cookie: request.cookie }, query: { code: 'code', state: request.state ?? flow.state } }, res), { status: 401 });
    assert.match(cookieNamed(res, 'launchpad_google_flow'), /Max-Age=0;/);
    assert.equal(cookieNamed(res, 'launchpad_google'), undefined);
  }
  await assert.rejects(f.finish(flow, { error: 'access_denied' }), { status: 401 });
  await assert.rejects(f.finish(flow, { iss: 'https://attacker.example' }), { status: 401 });
  f.advance(601000);
  await assert.rejects(f.finish(flow), { status: 401 });
  assert.equal(f.requests.length, 0);
});

test('signed ID tokens must match issuer, audience, expiry, nonce, verified email, and subject', async t => {
  for (const [name, changes] of [
    ['issuer', { iss: 'https://attacker.example' }], ['audience', { aud: 'another-client' }],
    ['multi-audience presenter', { aud: [clientId, 'other'] }], ['presenter', { azp: 'other' }],
    ['expiry', { exp: 1 }], ['future issued time', { iat: 9999999999 }], ['future not-before', { nbf: 9999999999 }],
    ['nonce', { nonce: 'replayed-nonce' }], ['unverified email', { email_verified: false }],
    ['string verification flag', { email_verified: 'true' }], ['invalid email', { email: 'not-an-email' }],
    ['missing subject', { sub: '' }], ['invalid subject', { sub: 'has a space' }],
  ]) await t.test(name, async () => {
    const f = fixture(); Object.assign(f.overrides, changes);
    await assert.rejects(f.finish(), { status: 401 });
  });
});

test('wrong signatures, unsupported algorithms, and unknown signing keys cannot establish sessions', async () => {
  for (const setup of [f => f.signingKey(wrongPair.privateKey), f => f.header({ alg: 'HS256' }),
    f => f.header({ kid: 'unknown-key' }), f => f.header({ crit: ['exp'] })]) {
    const f = fixture(); setup(f); await assert.rejects(f.finish(), { status: 401 });
  }
});

test('JWKS cache is reused and supports provider signing-key rotation after the refresh cooldown', async () => {
  const f = fixture(); await f.finish(); await f.finish();
  assert.equal(f.requests.filter(value => value.url.includes('/certs')).length, 1);
  f.header({ kid: 'rotated-key' }); f.keys([{ ...publicJwk, kid: 'rotated-key' }]); f.advance(31000);
  await f.finish();
  assert.equal(f.requests.filter(value => value.url.includes('/certs')).length, 2);
});

test('an optional account allowlist is enforced at login and on existing sessions', async () => {
  await assert.rejects(fixture({ allowedEmails: 'another@example.com' }).finish(), { status: 403 });
  const f = fixture({ allowedEmails: ' Person@Example.com ' }), { cookie } = await f.finish();
  assert.equal(f.auth.verify({ headers: { cookie } }).email, 'person@example.com');
  const changed = createGoogleAuth({ ...f.settings, allowedEmails: ['another@example.com'] });
  assert.equal(changed.verify({ headers: { cookie } }), null);
});

test('profile output limits names and accepts only HTTPS Google profile pictures', async () => {
  const f = fixture(); f.overrides.name = '\u0000' + 'a'.repeat(300); f.overrides.picture = 'https://attacker.example/track';
  const { user } = await f.finish(); assert.equal(user.name.length, 100); assert.equal(user.picture, null);
});

test('logout clears both cookies while preserving other response cookies', () => {
  const f = fixture(), res = response(); res.setHeader('Set-Cookie', 'other=value; HttpOnly');
  f.auth.logout({}, res);
  assert.equal(asCookies(res).length, 3); assert.equal(asCookies(res)[0], 'other=value; HttpOnly');
  assert.match(cookieNamed(res, 'launchpad_google'), /Max-Age=0;/);
  assert.match(cookieNamed(res, 'launchpad_google_flow'), /Max-Age=0;/);
});

test('provider failures are reported without reflecting secrets or remote error content', async () => {
  const f = fixture({ fetch: async () => { throw new Error('leaked-client-secret-provider-error'); } });
  await assert.rejects(f.finish(), error => error.status === 502 && !error.message.includes('leaked-client-secret'));
});
