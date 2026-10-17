/**
 * 畠山祐輔さん 顧客管理ダッシュボード — API（Google Apps Script）
 *
 * このスクリプトは顧客データを置くスプレッドシートに「コンテナバインド」で作成する。
 * （拡張機能 → Apps Script から作成）
 *
 * スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）
 *   APP_PASSWORD   … ログイン用パスワード（必須・手動で設定）
 *   TOKEN_SECRET   … トークン署名用の秘密鍵（初回アクセス時に自動生成）
 *   SPREADSHEET_ID … 任意。スタンドアロンで動かす場合のみ設定
 *
 * Webアプリとしてデプロイ：実行ユーザー「自分」／アクセス「全員」
 * （データはパスワード＋トークンで保護。スプレッドシート自体は共有しない）
 */

const TZ = 'Asia/Tokyo';
const TOKEN_TTL_DAYS = 30;
const LOGIN_MAX_FAILS = 10;      // この回数失敗すると…
const LOGIN_LOCK_SECONDS = 900;  // …15分ログインを止める

const STATUSES = ['入金待ち', '進行中', '終了', '継続相談'];

const TABLES = {
  clients: {
    sheet: 'Clients',
    key: ['id'],
    fields: {
      id: 'id', name: 'text', lineName: 'text', goal: 'text',
      startDate: 'date', paidDate: 'date', checkinDow: 'dow', meetingDow: 'dow',
      status: 'status', memo: 'text',
      eval0: 'date', eval4: 'date', eval8: 'date', eval12: 'date',
      finalDone: 'date', finalPlan: 'text',
      createdAt: 'ts', updatedAt: 'ts',
    },
  },
  weeks: {
    sheet: 'Weeks',
    key: ['clientId', 'week'],
    fields: {
      clientId: 'id', week: 'week', weights: 'weights', checks: 'checks',
      checkinDone: 'bool', meetingDate: 'date', formVideos: 'int', mealDays: 'int',
      reportSent: 'bool', memo: 'text', updatedAt: 'ts',
    },
  },
};

// ---------------------------------------------------------------- 入口

function doGet() {
  return json_({ ok: true, service: 'hatakeyama-kanri' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (_) {
    return json_({ ok: false, error: 'bad_request' });
  }
  try {
    if (req.action === 'login') return json_(login_(req.password));
    if (!verifyToken_(req.token)) return json_({ ok: false, error: 'unauthorized' });

    switch (req.action) {
      case 'getAll':       return json_(getAll_());
      case 'saveClient':   return json_(withLock_(() => saveClient_(req.client)));
      case 'deleteClient': return json_(withLock_(() => deleteClient_(req.id)));
      case 'saveWeek':     return json_(withLock_(() => saveWeek_(req.week)));
      default:             return json_({ ok: false, error: 'bad_request' });
    }
  } catch (err) {
    if (!(err && err.code)) console.error(err);
    const code = err && err.code ? err.code : 'server_error';
    return json_({ ok: false, error: code });
  }
}

// ---------------------------------------------------------------- 認証

function login_(password) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('APP_PASSWORD');
  if (!expected) return { ok: false, error: 'not_configured' };

  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('login_fails') || 0);
  if (fails >= LOGIN_MAX_FAILS) return { ok: false, error: 'locked' };

  if (typeof password !== 'string' || !safeEqual_(sha256_(password), sha256_(expected))) {
    cache.put('login_fails', String(fails + 1), LOGIN_LOCK_SECONDS);
    Utilities.sleep(800);
    return { ok: false, error: 'bad_password' };
  }
  cache.remove('login_fails');

  const exp = Date.now() + TOKEN_TTL_DAYS * 86400000;
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({ exp: exp, n: Utilities.getUuid() }));
  return { ok: true, token: payload + '.' + sign_(payload), exp: exp };
}

function verifyToken_(token) {
  if (typeof token !== 'string' || token.length > 512) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  if (!safeEqual_(sign_(parts[0]), parts[1])) return false;
  try {
    const body = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
    return typeof body.exp === 'number' && body.exp > Date.now();
  } catch (_) {
    return false;
  }
}

function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, tokenSecret_()));
}

function tokenSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('TOKEN_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', secret);
  }
  return secret;
}

function sha256_(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- 処理

function getAll_() {
  return { ok: true, clients: readAll_(TABLES.clients), weeks: readAll_(TABLES.weeks) };
}

function saveClient_(input) {
  if (!input || typeof input !== 'object') throw err_('bad_request');
  const def = TABLES.clients;
  const patch = pick_(def, input);
  const now = new Date().toISOString();
  patch.updatedAt = now;
  if (!patch.id) {
    if (!patch.name) throw err_('bad_request');
    patch.id = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    patch.createdAt = now;
    if (!patch.status) patch.status = '入金待ち';
  }
  return { ok: true, client: upsert_(def, patch) };
}

function deleteClient_(id) {
  id = cast_('id', id);
  if (!id) throw err_('bad_request');
  deleteWhere_(TABLES.weeks, function (r) { return r.clientId === id; });
  deleteWhere_(TABLES.clients, function (r) { return r.id === id; });
  return { ok: true };
}

function saveWeek_(input) {
  if (!input || typeof input !== 'object') throw err_('bad_request');
  const def = TABLES.weeks;
  const patch = pick_(def, input);
  if (!patch.clientId || !patch.week) throw err_('bad_request');
  const exists = readAll_(TABLES.clients).some(function (c) { return c.id === patch.clientId; });
  if (!exists) throw err_('not_found');
  patch.updatedAt = new Date().toISOString();
  return { ok: true, week: upsert_(def, patch) };
}

// ---------------------------------------------------------------- シート操作

function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

/** シートを用意し、列名→列番号(0始まり) を返す。足りない列は末尾に追加する。 */
function table_(def) {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(def.sheet);
  const names = Object.keys(def.fields);
  if (!sh) {
    sh = ss.insertSheet(def.sheet);
    sh.getRange(1, 1, sh.getMaxRows(), names.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, names.length).setValues([names]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  names.forEach(function (n) {
    if (header.indexOf(n) === -1) {
      header.push(n);
      sh.getRange(1, header.length).setValue(n).setFontWeight('bold');
    }
  });
  const idx = {};
  header.forEach(function (h, i) { if (h) idx[h] = i; });
  return { sh: sh, header: header, idx: idx };
}

function rows_(t) {
  const n = t.sh.getLastRow() - 1;
  if (n < 1) return [];
  return t.sh.getRange(2, 1, n, t.header.length).getValues();
}

function toObj_(def, t, row) {
  const o = {};
  Object.keys(def.fields).forEach(function (f) {
    o[f] = decode_(def.fields[f], row[t.idx[f]]);
  });
  return o;
}

function readAll_(def) {
  const t = table_(def);
  return rows_(t).map(function (r) { return toObj_(def, t, r); })
    .filter(function (o) { return def.key.every(function (k) { return o[k] !== '' && o[k] != null; }); });
}

function upsert_(def, patch) {
  const t = table_(def);
  const rows = rows_(t);
  let at = -1;
  for (let i = 0; i < rows.length; i++) {
    const o = toObj_(def, t, rows[i]);
    if (def.key.every(function (k) { return o[k] === patch[k]; })) { at = i; break; }
  }
  const row = at >= 0 ? rows[at].slice() : t.header.map(function () { return ''; });
  // 既存の値は文字列に正規化してから書き戻す（日付型への自動変換を防ぐ）
  Object.keys(def.fields).forEach(function (f) {
    const i = t.idx[f];
    row[i] = f in patch ? encode_(def.fields[f], patch[f]) : encode_(def.fields[f], decode_(def.fields[f], row[i]));
  });
  const rowNo = at >= 0 ? at + 2 : t.sh.getLastRow() + 1;
  t.sh.getRange(rowNo, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  return toObj_(def, t, row);
}

function deleteWhere_(def, pred) {
  const t = table_(def);
  const rows = rows_(t);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (pred(toObj_(def, t, rows[i]))) t.sh.deleteRow(i + 2);
  }
}

// ---------------------------------------------------------------- 型と検証

/** 入力から定義済みの項目だけを取り出し、型を検証する */
function pick_(def, input) {
  const out = {};
  Object.keys(def.fields).forEach(function (f) {
    const type = def.fields[f];
    if (type === 'ts') return;
    if (Object.prototype.hasOwnProperty.call(input, f)) out[f] = cast_(type, input[f]);
  });
  return out;
}

function cast_(type, v) {
  if (v == null) v = '';
  switch (type) {
    case 'id': {
      const s = String(v);
      if (s && !/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw err_('bad_request');
      return s;
    }
    case 'text': return String(v).slice(0, 5000);
    case 'date': {
      const s = String(v);
      if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw err_('bad_request');
      return s;
    }
    case 'dow': {
      if (v === '') return '';
      const n = Number(v);
      if (!(n >= 0 && n <= 6 && Math.floor(n) === n)) throw err_('bad_request');
      return n;
    }
    case 'status':
      if (STATUSES.indexOf(String(v)) === -1) throw err_('bad_request');
      return String(v);
    case 'week': {
      const n = Number(v);
      if (!(n >= 1 && n <= 12 && Math.floor(n) === n)) throw err_('bad_request');
      return n;
    }
    case 'int': {
      const n = Math.floor(Number(v) || 0);
      return Math.max(0, Math.min(99, n));
    }
    case 'bool': return v === true || v === 1 || v === '1' || v === 'true';
    case 'checks': {
      const s = String(v);
      if (!/^[01]{0,7}$/.test(s)) throw err_('bad_request');
      return s;
    }
    case 'weights': {
      if (!Array.isArray(v)) throw err_('bad_request');
      return v.slice(0, 14).map(Number)
        .filter(function (n) { return isFinite(n) && n >= 20 && n <= 400; })
        .map(function (n) { return Math.round(n * 100) / 100; });
    }
    default: return String(v);
  }
}

/** 値 → セルに書く文字列 */
function encode_(type, v) {
  switch (type) {
    case 'bool': return v ? '1' : '';
    case 'weights': return v && v.length ? JSON.stringify(v) : '';
    case 'text': {
      const s = String(v == null ? '' : v);
      return /^[=+@]/.test(s) ? "'" + s : s; // 数式として解釈させない
    }
    default: return v === '' || v == null ? '' : String(v);
  }
}

/** セルの値 → 値 */
function decode_(type, cell) {
  if (cell instanceof Date) cell = Utilities.formatDate(cell, TZ, type === 'ts' ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd');
  const s = cell == null ? '' : String(cell);
  switch (type) {
    case 'dow':
    case 'week': return s === '' ? '' : Number(s);
    case 'int': return Number(s) || 0;
    case 'bool': return s === '1' || s.toUpperCase() === 'TRUE';
    case 'weights':
      try { return s ? JSON.parse(s) : []; } catch (_) { return []; }
    case 'text': return s.replace(/^'(?=[=+@])/, '');
    default: return s;
  }
}

// ---------------------------------------------------------------- 補助

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function err_(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- 手動で実行する関数

/** 初期設定の確認。エディタから一度実行して権限を承認する。 */
function setup() {
  table_(TABLES.clients);
  table_(TABLES.weeks);
  tokenSecret_();
  const pw = PropertiesService.getScriptProperties().getProperty('APP_PASSWORD');
  console.log(pw ? 'OK：シートとトークン鍵を用意しました。' : '注意：スクリプトプロパティ APP_PASSWORD を設定してください。');
}

/** すべての端末をログアウトさせる（スマホ紛失時など）。 */
function resetAllSessions() {
  PropertiesService.getScriptProperties().deleteProperty('TOKEN_SECRET');
  tokenSecret_();
  console.log('すべてのログインを無効にしました。');
}
