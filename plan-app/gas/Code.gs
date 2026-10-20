/**
 * 畠山コーチング｜お客様のプランの保存先（Google Apps Script）
 *
 * - プランの中身は、このスクリプトの持ち主の Google ドライブに JSON ファイルで保存する（共有しない）
 * - 読むのは誰でもできる（お客様のページが読み込む）。保存はパスワードが必要
 * - パスワードはコードに書かない。「プロジェクトの設定 → スクリプト プロパティ」の PLAN_PASSWORD に入れる
 *
 * 公開：デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *       次のユーザーとして実行「自分」／アクセスできるユーザー「全員」
 */

const FOLDER_NAME = '畠山コーチング_プラン';
const MAX_FAILS = 10;           // この回数パスワードを間違えると…
const LOCK_MS = 15 * 60 * 1000; // …15分保存を止める
const MAX_SIZE = 200 * 1024;    // プラン1件の上限

function doGet(e) {
  const id = e && e.parameter && e.parameter.id;
  if (!validId(id)) return out({ ok: false, error: 'bad_request' });
  const file = findFile(id);
  if (!file) return out({ ok: true, plan: null });
  return out({ ok: true, plan: JSON.parse(file.getBlob().getDataAsString('UTF-8')), updatedAt: file.getLastUpdated().getTime() });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (_) { return out({ ok: false, error: 'bad_request' }); }
  if (!body || !validId(body.id)) return out({ ok: false, error: 'bad_request' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return out({ ok: false, error: 'busy' });
  try {
    const auth = checkPassword(body.password);
    if (!auth.ok) return out(auth);

    if (body.action === 'check') return out({ ok: true });
    if (body.action === 'save') {
      if (!body.plan || typeof body.plan !== 'object') return out({ ok: false, error: 'bad_request' });
      const json = JSON.stringify(body.plan);
      if (json.length > MAX_SIZE) return out({ ok: false, error: 'too_large' });
      const file = findFile(body.id);
      if (file) file.setContent(json);
      else folder().createFile(body.id + '.json', json, 'application/json');
      return out({ ok: true, updatedAt: Date.now() });
    }
    return out({ ok: false, error: 'bad_request' });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- パスワード

function checkPassword(password) {
  const props = PropertiesService.getScriptProperties();
  const real = props.getProperty('PLAN_PASSWORD');
  if (!real) return { ok: false, error: 'not_configured' };

  const now = Date.now();
  let fails = { count: 0, until: 0 };
  try { fails = JSON.parse(props.getProperty('FAILS') || '') || fails; } catch (_) { /* 初回 */ }
  if (fails.until > now && fails.count >= MAX_FAILS) return { ok: false, error: 'locked' };

  if (typeof password !== 'string' || digest(password) !== digest(real)) {
    const next = fails.until > now ? { count: fails.count + 1, until: fails.until } : { count: 1, until: now + LOCK_MS };
    props.setProperty('FAILS', JSON.stringify(next));
    Utilities.sleep(800);
    return { ok: false, error: 'bad_password' };
  }
  if (fails.count) props.deleteProperty('FAILS');
  return { ok: true };
}

function digest(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

// ---------------------------------------------------------------- ドライブ

function folder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (_) { /* 消されていたら作り直す */ } }
  const f = DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}

function findFile(id) {
  const it = folder().getFilesByName(id + '.json');
  return it.hasNext() ? it.next() : null;
}

const validId = (id) => typeof id === 'string' && /^[a-z0-9_-]{1,40}$/.test(id);

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** 最初に一度だけ、エディタで実行して権限を許可する（ドライブにフォルダができる） */
function setup() {
  Logger.log('保存先フォルダ：' + folder().getUrl());
  Logger.log(PropertiesService.getScriptProperties().getProperty('PLAN_PASSWORD') ? 'パスワード：設定済み' : 'パスワード：未設定（スクリプト プロパティに PLAN_PASSWORD を追加してください）');
}
