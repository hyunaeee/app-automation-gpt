import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as blob from '@vercel/blob';

const COOKIE = 'launchpad_person';
const DURATION = 12 * 3600000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const validOwner = value => /^[0-9a-f-]{36}$/i.test(value || '');
const hash = value => crypto.createHash('sha256').update(value).digest();

export async function localCredentialSecret(dataDir, supplied) {
  if (typeof supplied === 'string' && supplied.length >= 32) return supplied;
  const filename = path.join(dataDir, 'credential-secret');
  try { return await fs.readFile(filename, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const secret = crypto.randomBytes(48).toString('base64url');
  try { await fs.writeFile(filename, secret, { flag: 'wx', mode: 0o600 }); return secret; }
  catch (error) { if (error.code !== 'EEXIST') throw error; return fs.readFile(filename, 'utf8'); }
}

export function createLocalCredentialStore(dataDir) {
  const directory = path.join(dataDir, 'credentials');
  const file = id => { if (!validOwner(id)) throw fail(400, '잘못된 사용자 식별자입니다.'); return path.join(directory, `${id}.json`); };
  let writes = Promise.resolve();
  return {
    async read(id) { await writes; try { return JSON.parse(await fs.readFile(file(id), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    async write(id, value) {
      const filename = file(id);
      const task = writes.catch(() => {}).then(async () => { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(filename + '.tmp', JSON.stringify(value), { mode: 0o600 }); await fs.rename(filename + '.tmp', filename); });
      writes = task; await task;
    },
  };
}

export function createBlobCredentialStore({ token, sdk = blob } = {}) {
  const filename = id => { if (!validOwner(id)) throw fail(400, '잘못된 사용자 식별자입니다.'); return `launchpad/v1/credentials/${id}.json`; };
  return {
    async read(id) { const result = await sdk.get(filename(id), { token, access: 'private', useCache: false }); return result ? JSON.parse(await new Response(result.stream).text()) : null; },
    async write(id, value) { await sdk.put(filename(id), JSON.stringify(value), { token, access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 }); },
  };
}

export function createCredentialManager({ secret, store, secure = true, defaultModel = 'gpt-4.1-mini', now = Date.now, ownerResolver } = {}) {
  const configured = typeof secret === 'string' && secret.length >= 32;
  const encryptionKey = configured ? hash(`launchpad-credential-v1:${secret}`) : null;
  const sign = value => crypto.createHmac('sha256', secret).update(value).digest('base64url');
  const cookie = value => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`;
  function owner(req) {
    if (!configured) return null;
    const accountOwner = ownerResolver?.(req);
    if (validOwner(accountOwner)) return accountOwner;
    const raw = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const [id, signature] = (raw || '').split('.');
    if (!validOwner(id) || !signature || !crypto.timingSafeEqual(hash(signature), hash(sign(id)))) return null;
    return id;
  }
  function ensure(req, res) {
    if (!configured) throw fail(503, '개인 API 키 암호화를 위한 SESSION_SECRET 설정이 필요합니다.');
    const existing = owner(req); if (existing) return existing;
    const id = crypto.randomUUID();
    const value = cookie(`${id}.${sign(id)}`);
    const previous = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', previous ? [...(Array.isArray(previous) ? previous : [previous]), value] : value);
    req.headers.cookie = `${req.headers.cookie ? req.headers.cookie + '; ' : ''}${value.split(';')[0]}`;
    return id;
  }
  function encrypt(id, value) {
    const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, nonce);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { v: 1, nonce: nonce.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  }
  async function readOwner(id) {
    if (!id || !configured) return null;
    const value = await store.read(id); if (!value?.ciphertext) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(value.nonce, 'base64url'));
      decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
      const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64url')), decipher.final()]).toString());
      if (parsed.expiresAt <= now() || (parsed.provider && parsed.provider !== 'openai')) return null;
      return { ...parsed, ownerId: id, source: 'personal' };
    } catch { return null; }
  }
  const publicStatus = (connection, fallback = {}) => ({
    connected: Boolean(connection), source: connection ? 'personal' : fallback.apiKey ? 'server' : 'none',
    model: connection?.model || fallback.model || defaultModel,
    maskedKey: connection ? `sk-••••${connection.apiKey.slice(-4)}` : null,
    expiresAt: connection ? new Date(connection.expiresAt).toISOString() : null,
    storage: 'encrypted-server', validated: false,
    provider:connection?.provider || fallback.provider || 'openai',
  });
  return {
    configured, owner, ensure, readOwner, publicStatus,
    resolve: req => readOwner(owner(req)),
    async connect(req, res, input) {
      const provider=input?.provider || 'openai';if(provider!=='openai')throw fail(400,'현재 OpenAI API 연결만 지원합니다.');
      const pattern=/^sk-[A-Za-z0-9_-]{12,500}$/;
      if (typeof input?.apiKey !== 'string' || !pattern.test(input.apiKey.trim())) throw fail(400, '올바른 OpenAI API 키를 입력해 주세요.');
      const model = input.model === undefined ? defaultModel : input.model;
      if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,99}$/.test(model)) throw fail(400, '올바른 모델 ID를 입력해 주세요.');
      const id = ensure(req, res), value = { apiKey: input.apiKey.trim(), provider, model, expiresAt: now() + DURATION, revision: crypto.randomUUID() };
      await store.write(id, encrypt(id, value));
      return { ...value, ownerId: id, source: 'personal' };
    },
    async disconnect(req) { const id = owner(req); if (id) await store.write(id, { v: 1, disconnectedAt: now() }); return id; },
  };
}
