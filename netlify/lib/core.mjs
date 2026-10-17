/**
 * 顧客管理 API の本体（保存先に依存しない部分）
 *
 * 保存先：Netlify Blobs（ストア名 "kanri"）
 *   c/{id}        … お客様1人分 { client, weeks: { [週番号]: 記録 } }
 *   _auth/fails   … ログイン失敗の回数
 *
 * 環境変数（Netlify のサイト設定 → Environment variables）
 *   APP_PASSWORD … ログイン用パスワード
 *   TOKEN_SECRET … トークン署名用の秘密鍵（長いランダム文字列）
 */
import crypto from 'node:crypto';

const TOKEN_TTL_MS = 30 * 86400000;
const LOGIN_MAX_FAILS = 10;      // この回数失敗すると…
const LOGIN_LOCK_MS = 15 * 60000; // …15分ログインを止める
const STATUSES = ['入金待ち', '進行中', '終了', '継続相談'];

const CLIENT_FIELDS = {
  id: 'id', name: 'text', lineName: 'text', goal: 'text',
  startDate: 'date', paidDate: 'date', checkinDow: 'dow', meetingDow: 'dow',
  status: 'status', memo: 'text',
  eval0: 'date', eval4: 'date', eval8: 'date', eval12: 'date',
  finalDone: 'date', finalPlan: 'text',
};
const WEEK_FIELDS = {
  clientId: 'id', week: 'week', weights: 'weights', checks: 'checks',
  checkinDone: 'bool', meetingDate: 'date', formVideos: 'int', mealDays: 'int',
  reportSent: 'bool', memo: 'text',
};
const EMPTY_CLIENT = {
  name: '', lineName: '', goal: '', startDate: '', paidDate: '', checkinDow: '', meetingDow: '',
  status: '入金待ち', memo: '', eval0: '', eval4: '', eval8: '', eval12: '', finalDone: '', finalPlan: '',
};
const EMPTY_WEEK = {
  weights: [], checks: '', checkinDone: false, meetingDate: '', formVideos: 0, mealDays: 0, reportSent: false, memo: '',
};

class ApiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// ---------------------------------------------------------------- 入口

/** @param body リクエスト JSON  @param ctx { store, env } */
export async function handle(body, ctx) {
  try {
    if (!body || typeof body !== 'object') throw new ApiError('bad_request');
    if (!ctx.env.APP_PASSWORD || !ctx.env.TOKEN_SECRET) throw new ApiError('not_configured');
    if (body.action === 'login') return await login(body.password, ctx);
    if (!verifyToken(body.token, ctx.env.TOKEN_SECRET)) return { ok: false, error: 'unauthorized' };

    switch (body.action) {
      case 'getAll':       return await getAll(ctx.store);
      case 'saveClient':   return await saveClient(body.client, ctx.store);
      case 'deleteClient': return await deleteClient(body.id, ctx.store);
      case 'saveWeek':     return await saveWeek(body.week, ctx.store);
      default:             throw new ApiError('bad_request');
    }
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.code };
    console.error(err);
    return { ok: false, error: 'server_error' };
  }
}

// ---------------------------------------------------------------- 認証

async function login(password, { store, env }) {
  const fails = (await store.get('_auth/fails', { type: 'json' })) || { count: 0, until: 0 };
  const now = Date.now();
  if (fails.until > now && fails.count >= LOGIN_MAX_FAILS) return { ok: false, error: 'locked' };

  if (typeof password !== 'string' || !safeEqual(sha256(password), sha256(env.APP_PASSWORD))) {
    const next = fails.until > now ? { count: fails.count + 1, until: fails.until } : { count: 1, until: now + LOGIN_LOCK_MS };
    await store.setJSON('_auth/fails', next);
    await new Promise((r) => setTimeout(r, 800));
    return { ok: false, error: 'bad_password' };
  }
  if (fails.count) await store.delete('_auth/fails');

  const exp = now + TOKEN_TTL_MS;
  const payload = b64url(JSON.stringify({ exp, n: crypto.randomUUID() }));
  return { ok: true, token: payload + '.' + sign(payload, env.TOKEN_SECRET), exp };
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string' || token.length > 512) return false;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return false;
  if (!safeEqual(sign(payload, secret), sig)) return false;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof body.exp === 'number' && body.exp > Date.now();
  } catch (_) {
    return false;
  }
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();
function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- 処理

async function getAll(store) {
  const { blobs } = await store.list({ prefix: 'c/' });
  const docs = await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' })));
  const clients = [], weeks = [];
  for (const d of docs) {
    if (!d || !d.client) continue;
    clients.push(d.client);
    for (const w of Object.values(d.weeks || {})) weeks.push(w);
  }
  return { ok: true, clients, weeks };
}

async function saveClient(input, store) {
  if (!input || typeof input !== 'object') throw new ApiError('bad_request');
  const patch = pick(CLIENT_FIELDS, input);
  const now = new Date().toISOString();
  if (!patch.id) {
    if (!patch.name) throw new ApiError('bad_request');
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const client = { id, ...EMPTY_CLIENT, ...patch, id, createdAt: now, updatedAt: now };
    const res = await store.setJSON('c/' + id, { client, weeks: {} }, { onlyIfNew: true });
    if (!res.modified) throw new ApiError('conflict');
    return { ok: true, client };
  }
  const doc = await update(store, patch.id, (d) => {
    d.client = { ...d.client, ...patch, updatedAt: now };
    return d;
  });
  return { ok: true, client: doc.client };
}

async function deleteClient(id, store) {
  id = cast('id', id);
  if (!id) throw new ApiError('bad_request');
  await store.delete('c/' + id);
  return { ok: true };
}

async function saveWeek(input, store) {
  if (!input || typeof input !== 'object') throw new ApiError('bad_request');
  const patch = pick(WEEK_FIELDS, input);
  if (!patch.clientId || !patch.week) throw new ApiError('bad_request');
  const now = new Date().toISOString();
  const doc = await update(store, patch.clientId, (d) => {
    d.weeks = d.weeks || {};
    d.weeks[patch.week] = { clientId: patch.clientId, week: patch.week, ...EMPTY_WEEK, ...d.weeks[patch.week], ...patch, updatedAt: now };
    return d;
  });
  return { ok: true, week: doc.weeks[patch.week] };
}

/** 読んで→変更して→「読んだ時から変わっていなければ」書く。同時保存は読み直してやり直す */
async function update(store, id, fn) {
  const key = 'c/' + id;
  for (let i = 0; i < 10; i++) {
    if (i) await new Promise((r) => setTimeout(r, 20 + Math.random() * 60 * i));
    const cur = await store.getWithMetadata(key, { type: 'json' });
    if (!cur || !cur.data) throw new ApiError('not_found');
    const next = fn(structuredClone(cur.data));
    const res = await store.setJSON(key, next, { onlyIfMatch: cur.etag });
    if (res.modified) return next;
  }
  throw new ApiError('conflict');
}

// ---------------------------------------------------------------- 型と検証

function pick(fields, input) {
  const out = {};
  for (const [f, type] of Object.entries(fields)) {
    if (Object.prototype.hasOwnProperty.call(input, f)) out[f] = cast(type, input[f]);
  }
  return out;
}

function cast(type, v) {
  if (v == null) v = '';
  switch (type) {
    case 'id': {
      const s = String(v);
      if (s && !/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new ApiError('bad_request');
      return s;
    }
    case 'text': return String(v).slice(0, 5000);
    case 'date': {
      const s = String(v);
      if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ApiError('bad_request');
      return s;
    }
    case 'dow': {
      if (v === '') return '';
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 6) throw new ApiError('bad_request');
      return n;
    }
    case 'status':
      if (!STATUSES.includes(String(v))) throw new ApiError('bad_request');
      return String(v);
    case 'week': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 12) throw new ApiError('bad_request');
      return n;
    }
    case 'int': return Math.max(0, Math.min(99, Math.floor(Number(v) || 0)));
    case 'bool': return v === true || v === 1 || v === '1' || v === 'true';
    case 'checks': {
      const s = String(v);
      if (!/^[01]{0,7}$/.test(s)) throw new ApiError('bad_request');
      return s;
    }
    case 'weights':
      if (!Array.isArray(v)) throw new ApiError('bad_request');
      return v.slice(0, 14).map(Number)
        .filter((n) => Number.isFinite(n) && n >= 20 && n <= 400)
        .map((n) => Math.round(n * 100) / 100);
    default: return String(v);
  }
}
