/**
 * 顧客管理 API の本体（保存先に依存しない部分）
 *
 * 保存先：Netlify Blobs（ストア名 "kanri"）
 *   c/{id}        … お客様1人分 { client, weeks: { [週番号]: 記録 } }
 *   k/{formKey}   … お客様用リンクの鍵 → { clientId }
 *   p/{clientId}/{期}/{週}/{front|side|back} … チェックインの写真（JPEG）
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
// お客様がリンクから送る週次チェックイン
const CHECKIN_FIELDS = {
  weights: 'weights', checks: 'checks', condition: 'condition', clientWin: 'text', clientNote: 'text',
  ratings: 'ratings', trainDays: 'int7', mealsSent: 'int7', videosSent: 'int2', nextMeeting: 'text', measures: 'measures',
  reflection: 'text', renewIntent: 'renew',
};
const CONDITIONS = ['', '良い', '普通', 'いまいち'];
const RATING_KEYS = ['train', 'diet', 'sleep', 'energy'];
const RENEW = ['', '続けたい', '相談したい', '今回で終了'];
const PHOTO_SLOTS = ['front', 'side', 'back'];
const PHOTO_MAX = 1.5 * 1024 * 1024; // 1枚あたり（端末で縮小してから送る）
const EMPTY_CLIENT = {
  name: '', lineName: '', goal: '', startDate: '', paidDate: '', checkinDow: '', meetingDow: '',
  status: '入金待ち', memo: '', eval0: '', eval4: '', eval8: '', eval12: '', finalDone: '', finalPlan: '',
};
const EMPTY_WEEK = {
  weights: [], checks: '', checkinDone: false, meetingDate: '', formVideos: 0, mealDays: 0, reportSent: false, memo: '',
  condition: '', clientWin: '', clientNote: '', submittedAt: '',
  ratings: {}, trainDays: 0, mealsSent: 0, videosSent: 0, nextMeeting: '', measures: {}, reflection: '', renewIntent: '', photos: {},
};
const TZ_OFFSET_MS = 9 * 3600000; // 週の判定は日本時間

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

    // お客様用リンク（ログイン不要。鍵で1人分だけ読み書きできる）
    switch (body.action) {
      case 'formGet':           return await formGet(body.key, ctx.store);
      case 'formIntake':        return await formIntake(body.key, body.answers, ctx.store);
      case 'formCheckin':       return await formCheckin(body.key, body.checkin, ctx.store);
      case 'formPhoto':         return await formPhoto(body.key, body.week, body.slot, body.data, ctx.store);
    }

    if (!verifyToken(body.token, ctx.env.TOKEN_SECRET)) return { ok: false, error: 'unauthorized' };

    switch (body.action) {
      case 'getAll':       return await getAll(ctx.store);
      case 'saveClient':   return await saveClient(body.client, ctx.store);
      case 'deleteClient': return await deleteClient(body.id, ctx.store);
      case 'saveWeek':     return await saveWeek(body.week, ctx.store);
      case 'issueFormKey': return await issueFormKey(body.id, ctx.store);
      case 'renewClient':  return await renewClient(body.id, body.paidDate, ctx.store);
      case 'getPhoto':     return await getPhoto(body.path, ctx.store);
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
    return { ok: true, client: (await issueFormKey(id, store)).client };
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
  const doc = await store.get('c/' + id, { type: 'json' });
  if (doc && doc.client && doc.client.formKey) await store.delete('k/' + doc.client.formKey);
  const { blobs } = await store.list({ prefix: `p/${id}/` });
  await Promise.all(blobs.map((b) => store.delete(b.key)));
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

/**
 * 更新（次の12週）の入金を確認したとき：いまの期間を履歴（client.cycles）に移して、新しい期間を始める。
 * 開始日は空にするので、管理画面で決め直す。
 */
async function renewClient(id, paidDate, store) {
  id = cast('id', id);
  paidDate = cast('date', paidDate);
  if (!id || !paidDate) throw new ApiError('bad_request');
  const now = new Date().toISOString();
  const doc = await update(store, id, (d) => {
    const c = { ...d.client };
    if (c.startDate) {
      const cycles = Array.isArray(c.cycles) ? c.cycles.slice() : [];
      cycles.push({
        paidDate: c.paidDate, startDate: c.startDate, goal: c.goal,
        eval0: c.eval0, eval4: c.eval4, eval8: c.eval8, eval12: c.eval12,
        finalDone: c.finalDone, finalPlan: c.finalPlan, weeks: d.weeks || {}, closedAt: now,
      });
      c.cycles = cycles.slice(-20);
      d.weeks = {};
      for (const k of ['eval0', 'eval4', 'eval8', 'eval12', 'finalDone', 'finalPlan', 'startDate']) c[k] = '';
    }
    c.paidDate = paidDate;
    c.status = '進行中';
    c.updatedAt = now;
    d.client = c;
    return d;
  });
  return { ok: true, client: doc.client };
}

// ---------------------------------------------------------------- お客様用リンク

/** 鍵を新しく発行する（古いリンクは使えなくなる） */
async function issueFormKey(id, store) {
  id = cast('id', id);
  if (!id) throw new ApiError('bad_request');
  const key = crypto.randomBytes(18).toString('base64url');
  await store.setJSON('k/' + key, { clientId: id });
  let old = '';
  const doc = await update(store, id, (d) => {
    old = d.client.formKey || '';
    d.client = { ...d.client, formKey: key, updatedAt: new Date().toISOString() };
    return d;
  });
  if (old) await store.delete('k/' + old);
  return { ok: true, client: doc.client };
}

async function clientIdByKey(key, store) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(key)) throw new ApiError('invalid_link');
  const k = await store.get('k/' + key, { type: 'json' });
  if (!k || !k.clientId) throw new ApiError('invalid_link');
  return k.clientId;
}

/** 日本時間の今日が第何週か（開始前 0、終了後 13） */
function currentWeek(startDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate || '');
  if (!m) return null;
  const start = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const now = new Date(Date.now() + TZ_OFFSET_MS);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dd = Math.round((today - start) / 86400000);
  return dd < 0 ? 0 : Math.min(Math.floor(dd / 7) + 1, 13);
}

/** お客様に見せるのは本人の最小限の情報だけ */
async function formGet(key, store) {
  const id = await clientIdByKey(key, store);
  const doc = await store.get('c/' + id, { type: 'json' });
  if (!doc || !doc.client || doc.client.formKey !== key) throw new ApiError('invalid_link');
  const c = doc.client;
  const weeks = {};
  for (const [n, w] of Object.entries(doc.weeks || {})) {
    if (!w.submittedAt) continue;
    weeks[n] = { submittedAt: w.submittedAt, photos: Object.keys(w.photos || {}) };
    for (const f of Object.keys(CHECKIN_FIELDS)) weeks[n][f] = w[f];
  }
  return {
    ok: true,
    client: { name: c.name, startDate: c.startDate, checkinDow: c.checkinDow, intakeDone: !!(c.intake && c.intake.submittedAt) },
    intake: c.intake ? c.intake.answers : null,
    currentWeek: currentWeek(c.startDate),
    weeks,
  };
}

async function formIntake(key, answers, store) {
  const id = await clientIdByKey(key, store);
  const clean = cleanAnswers(answers);
  if (!Object.keys(clean).length) throw new ApiError('bad_request');
  const now = new Date().toISOString();
  await update(store, id, (d) => {
    if (d.client.formKey !== key) throw new ApiError('invalid_link');
    const c = { ...d.client, intake: { answers: clean, submittedAt: now }, updatedAt: now };
    // 空いている項目は回答から自動で埋める（畠山さんが入力済みの値は上書きしない）
    if (!c.goal && clean.goal_12w) c.goal = String(clean.goal_12w).slice(0, 5000);
    const dow = Number(clean.checkin_dow);
    if (c.checkinDow === '' && clean.checkin_dow !== '' && Number.isInteger(dow) && dow >= 0 && dow <= 6) c.checkinDow = dow;
    d.client = c;
    return d;
  });
  return { ok: true };
}

async function formCheckin(key, input, store) {
  const id = await clientIdByKey(key, store);
  if (!input || typeof input !== 'object') throw new ApiError('bad_request');
  const week = cast('week', input.week);
  const patch = pick(CHECKIN_FIELDS, input);
  const now = new Date().toISOString();
  const doc = await update(store, id, (d) => {
    if (d.client.formKey !== key) throw new ApiError('invalid_link');
    const cur = currentWeek(d.client.startDate);
    if (!cur) throw new ApiError('not_started');
    if (week > Math.min(cur, 12)) throw new ApiError('bad_request'); // 先の週には出せない
    d.weeks = d.weeks || {};
    const prev = { ...EMPTY_WEEK, ...d.weeks[week] };
    const next = { clientId: id, week, ...prev, ...patch, checkinDone: true, submittedAt: now, updatedAt: now };
    // お客様の申告で、畠山さんがまだ入れていない数を埋める（入力済みなら上書きしない）
    if (!prev.formVideos && patch.videosSent) next.formVideos = patch.videosSent;
    if (!prev.mealDays && patch.mealsSent) next.mealDays = patch.mealsSent;
    d.weeks[week] = next;
    if (patch.renewIntent) d.client = { ...d.client, renewIntent: patch.renewIntent, renewIntentAt: now, updatedAt: now };
    return d;
  });
  return { ok: true, submittedAt: doc.weeks[week].submittedAt };
}

/** チェックインの写真を1枚保存（同じ枠は上書き） */
async function formPhoto(key, weekIn, slot, data, store) {
  const id = await clientIdByKey(key, store);
  const week = cast('week', weekIn);
  if (!PHOTO_SLOTS.includes(slot) || typeof data !== 'string') throw new ApiError('bad_request');
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) throw new ApiError('bad_request');
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > PHOTO_MAX || buf[0] !== 0xff || buf[1] !== 0xd8) throw new ApiError('bad_request'); // JPEG のみ
  const cur0 = await store.get('c/' + id, { type: 'json' });
  if (!cur0 || cur0.client.formKey !== key) throw new ApiError('invalid_link');
  const cur = currentWeek(cur0.client.startDate);
  if (!cur) throw new ApiError('not_started');
  if (week > Math.min(cur, 12)) throw new ApiError('bad_request');
  const cycle = (Array.isArray(cur0.client.cycles) ? cur0.client.cycles.length : 0) + 1;
  const path = `p/${id}/${cycle}/${week}/${slot}`;
  await store.set(path, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), { metadata: { type: 'image/jpeg' } });
  await update(store, id, (d) => {
    d.weeks = d.weeks || {};
    const w = { clientId: id, week, ...EMPTY_WEEK, ...d.weeks[week] };
    w.photos = { ...(w.photos || {}), [slot]: path };
    w.updatedAt = new Date().toISOString();
    d.weeks[week] = w;
    return d;
  });
  return { ok: true, slot };
}

/** 管理画面から写真を見る（ログイン必須） */
async function getPhoto(path, store) {
  if (typeof path !== 'string' || !/^p\/[A-Za-z0-9_-]{1,64}\/\d{1,3}\/\d{1,2}\/(front|side|back)$/.test(path)) throw new ApiError('bad_request');
  const buf = await store.get(path, { type: 'arrayBuffer' });
  if (!buf) throw new ApiError('not_found');
  return { ok: true, data: 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64') };
}

/** ヒアリング回答：キーと長さを制限して保存する */
function cleanAnswers(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new ApiError('bad_request');
  const out = {};
  for (const [k, v] of Object.entries(a).slice(0, 80)) {
    if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
    if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => String(x).slice(0, 200));
    else if (v != null) out[k] = String(v).slice(0, 3000).trim();
  }
  return out;
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
    case 'int7': return Math.max(0, Math.min(7, Math.floor(Number(v) || 0)));
    case 'int2': return Math.max(0, Math.min(2, Math.floor(Number(v) || 0)));
    case 'renew':
      if (!RENEW.includes(String(v))) throw new ApiError('bad_request');
      return String(v);
    case 'ratings': {
      const out = {};
      if (v && typeof v === 'object') for (const k of RATING_KEYS) { const n = Math.floor(Number(v[k])); if (n >= 1 && n <= 5) out[k] = n; }
      return out;
    }
    case 'measures': {
      const out = {};
      const lim = { waist: [30, 250], hip: [30, 250], bodyFat: [2, 70] };
      if (v && typeof v === 'object') for (const [k, [lo, hi]] of Object.entries(lim)) { const n = Number(v[k]); if (v[k] !== '' && v[k] != null && Number.isFinite(n) && n >= lo && n <= hi) out[k] = Math.round(n * 10) / 10; }
      return out;
    }
    case 'condition':
      if (!CONDITIONS.includes(String(v))) throw new ApiError('bad_request');
      return String(v);
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
