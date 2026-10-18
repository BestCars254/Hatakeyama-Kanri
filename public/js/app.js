(function () {
  'use strict';

  // ================================================================ 定数

  const API_URL = '/api';
  const TOKEN_KEY = 'hk_token';
  const CACHE_KEY = 'hk_cache';
  const WEEKS = 12;
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  const ST = { WAIT: '入金待ち', ACTIVE: '進行中', DONE: '終了', CONSULT: '継続相談' };
  const STATUSES = [ST.WAIT, ST.ACTIVE, ST.DONE, ST.CONSULT];
  const CHECK_ITEMS = window.CHECK_ITEMS; // js/questions.js
  const INTAKE = window.INTAKE;
  const RECENT_MS = 3 * 86400000; // 「お客様からの提出」に出す期間
  const EVALS = [
    { key: 'eval0', week: 1, label: '開始時' },
    { key: 'eval4', week: 4, label: '4週' },
    { key: 'eval8', week: 8, label: '8週' },
    { key: 'eval12', week: 12, label: '12週' },
  ];
  const FORM_MAX = 2;
  const MEAL_TARGET = 3;
  const OVERDUE_SHOWN = 8;
  const ERRORS = {
    bad_password: 'パスワードが違います。',
    locked: 'ログインの失敗が続いたため、15分ほど時間をおいてください。',
    not_configured: 'サーバーの設定が済んでいません（Netlify の環境変数 APP_PASSWORD・TOKEN_SECRET）。',
    network: '通信できませんでした。電波状況を確認して、もう一度お試しください。',
    conflict: '同時に保存されました。画面を更新して、もう一度保存してください。',
    unauthorized: 'ログインの有効期限が切れました。もう一度ログインしてください。',
    not_found: 'お客様が見つかりませんでした。画面を更新してください。',
  };

  const state = {
    clients: [],
    weeks: {},        // clientId -> { [week]: record }
    ready: false,
    dirty: false,     // フォーム入力中は自動の再描画を止める
    loading: false,
    syncedAt: null,
    selWeek: {},      // clientId -> 選択中の週
    tasks: {},        // 表示中のタスク（id → task）
  };
  const $app = document.getElementById('app');
  let chart = null;

  // ================================================================ 小物

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* 保存できなくても動く */ }
  }

  function san(name) {
    const n = String(name || '').trim();
    return /(さん|様|さま)$/.test(n) ? n : n + 'さん';
  }

  // 日付はすべて端末のローカル日付（日本時間を想定）の 'YYYY-MM-DD' で扱う
  function pd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function fd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function diffDays(a, b) { return Math.round((a - b) / 86400000); }
  function same(a, b) { return a && b && a.getTime() === b.getTime(); }
  function md(d) { return d ? (d.getMonth() + 1) + '/' + d.getDate() : '—'; }
  function mdw(d) { return d ? md(d) + '（' + DOW[d.getDay()] + '）' : '—'; }
  function mdwS(s) { return mdw(pd(s)); }

  // ================================================================ スケジュール計算

  /** 開始日から 12 週の枠を作る。cur = 今日が何週目か（開始前 0、終了後 13） */
  function sched(c) {
    const start = pd(c.startDate);
    if (!start) return null;
    const dd = diffDays(today(), start);
    const cur = dd < 0 ? 0 : Math.min(Math.floor(dd / 7) + 1, WEEKS + 1);
    return { start, end: addDays(start, WEEKS * 7 - 1), cur };
  }
  function weekStart(s, n) { return addDays(s.start, 7 * (n - 1)); }
  function weekEnd(s, n) { return addDays(s.start, 7 * n - 1); }
  /** 第 n 週のうち、指定曜日にあたる日（曜日未設定なら null） */
  function dowInWeek(s, n, dow) {
    if (dow === '' || dow == null) return null;
    const ws = weekStart(s, n);
    return addDays(ws, (Number(dow) - ws.getDay() + 7) % 7);
  }
  function evalDue(c, s, ev) {
    if (ev.key === 'eval0') return s.start;
    return dowInWeek(s, ev.week, c.checkinDow) || weekEnd(s, ev.week);
  }
  function rec(cid, n) { return (state.weeks[cid] || {})[n] || null; }

  function avgW(r) {
    const ws = (r && r.weights) || [];
    if (!ws.length) return null;
    return ws.reduce((a, b) => a + b, 0) / ws.length;
  }
  function hasScore(r) { return !!(r && r.checks && r.checks.length === 7); }
  function scoreOf(r) { return hasScore(r) ? r.checks.split('').filter((x) => x === '1').length : null; }
  function scoreLabel(n) { return n >= 5 ? '継続' : n >= 3 ? '1つだけ改善' : '計画をシンプルに'; }
  function scoreLv(n) { return n >= 5 ? 1 : n >= 3 ? 2 : 3; }
  const kg = (v) => (v == null ? '—' : v.toFixed(1) + 'kg');

  /** 各セル（週×項目）の状態：done / miss / todo / none */
  function cellState(c, s, w, kind) {
    const t = today();
    const r = rec(c.id, w) || {};
    if (kind === 'eval') {
      const ev = EVALS.find((e) => e.week === w);
      if (!ev) return 'none';
      if (c[ev.key]) return 'done';
      return evalDue(c, s, ev) < t ? 'miss' : 'todo';
    }
    if (kind === 'checkin') {
      if (r.checkinDone) return 'done';
      const d = dowInWeek(s, w, c.checkinDow) || weekEnd(s, w);
      return d < t ? 'miss' : 'todo';
    }
    if (kind === 'meeting') {
      if (r.meetingDate) return 'done';
      if (w < s.cur) return 'miss';
      const p = dowInWeek(s, w, c.meetingDow);
      return w === s.cur && p && p < t ? 'miss' : 'todo';
    }
    if (kind === 'report') {
      if (r.reportSent) return 'done';
      return w < s.cur ? 'miss' : 'todo';
    }
    return 'none';
  }

  function stats(c) {
    const s = sched(c);
    const out = { s, meet: 0, rep: 0, chk: 0, evals: EVALS.filter((e) => c[e.key]).length,
      missMeet: 0, missRep: 0, missChk: 0, missEval: 0, latestW: null, latestS: null };
    for (let w = 1; w <= WEEKS; w++) {
      const r = rec(c.id, w);
      if (r && r.meetingDate) out.meet++;
      if (r && r.reportSent) out.rep++;
      if (r && r.checkinDone) out.chk++;
      if (s && w <= s.cur) {
        if (cellState(c, s, w, 'meeting') === 'miss') out.missMeet++;
        if (cellState(c, s, w, 'report') === 'miss') out.missRep++;
        if (cellState(c, s, w, 'checkin') === 'miss') out.missChk++;
        if (cellState(c, s, w, 'eval') === 'miss') out.missEval++;
      }
    }
    for (let w = WEEKS; w >= 1; w--) {
      const r = rec(c.id, w);
      if (!out.latestW && avgW(r) != null) out.latestW = { w, v: avgW(r) };
      if (!out.latestS && hasScore(r)) out.latestS = { w, v: scoreOf(r) };
    }
    return out;
  }

  function nextCheckin(c, s) {
    if (!s || c.checkinDow === '') return null;
    const t = today();
    for (let w = Math.max(s.cur, 1); w <= WEEKS; w++) {
      const d = dowInWeek(s, w, c.checkinDow);
      const r = rec(c.id, w);
      if (d >= t && !(r && r.checkinDone)) return d;
    }
    return null;
  }
  function nextMeeting(c, s) {
    if (!s) return null;
    const t = today();
    for (let w = Math.max(s.cur, 1); w <= WEEKS; w++) {
      const r = rec(c.id, w);
      if (r && r.meetingDate) continue;
      const d = dowInWeek(s, w, c.meetingDow);
      if (d) { if (d >= t) return mdw(d); continue; }
      return w === s.cur ? '今週中（日程未定）' : w + '週目（日程未定）';
    }
    return null;
  }

  // ================================================================ やることリスト

  function buildTasks() {
    const t = today();
    const out = { overdue: [], today: [], week: [] };
    const bucket = (d) => (d < t ? 'overdue' : same(d, t) ? 'today' : 'week');
    const order = { checkin: 1, meeting: 2, eval: 3, report: 4, final: 5, go: 6 };

    for (const c of state.clients) {
      if (c.status !== ST.ACTIVE) continue;
      const add = (b, task) => out[b].push(Object.assign({ c, id: c.id + ':' + task.kind + ':' + (task.w || task.key || '') }, task));
      const s = sched(c);
      if (!s) { add('overdue', { kind: 'go', key: 'nostart', text: '開始日が未設定', href: '#/edit/' + c.id, date: t }); continue; }
      if (s.cur === 0) {
        if (diffDays(s.start, t) <= 7) add('week', { kind: 'go', key: 'prestart', text: '開始日 ' + mdw(s.start), href: '#/c/' + c.id, date: s.start });
        continue;
      }
      const last = Math.min(s.cur, WEEKS);
      for (let w = 1; w <= last; w++) {
        const r = rec(c.id, w) || {};
        const isCur = w === s.cur;
        const wEnd = weekEnd(s, w);

        // チェックイン
        if (!r.checkinDone) {
          const d = dowInWeek(s, w, c.checkinDow);
          if (!d) {
            if (isCur) add(same(wEnd, t) ? 'today' : 'week', { kind: 'checkin', w, date: wEnd, text: 'チェックイン（曜日未設定）' });
          } else {
            const b = bucket(d);
            const text = b === 'overdue' ? `チェックイン未記録（${w}週目・${mdw(d)}）`
              : b === 'today' ? `チェックイン日（${DOW[d.getDay()]}）` : `チェックイン ${mdw(d)}`;
            add(b, { kind: 'checkin', w, date: d, text });
          }
        }

        // 個別面談（週1回）
        if (!r.meetingDate) {
          const p = dowInWeek(s, w, c.meetingDow);
          if (!isCur) add('overdue', { kind: 'meeting', w, date: wEnd, text: `面談未実施（${w}週目）` });
          else if (p && p < t) add('overdue', { kind: 'meeting', w, date: p, text: `面談未実施（予定 ${mdw(p)}）` });
          else if (p && same(p, t)) add('today', { kind: 'meeting', w, date: p, text: `面談日（${DOW[p.getDay()]}）` });
          else if (same(wEnd, t)) add('today', { kind: 'meeting', w, date: wEnd, text: '面談 今週分が未実施（今週最終日）' });
          else add('week', { kind: 'meeting', w, date: p || wEnd, text: `面談 ${w}週目（${p ? mdw(p) : '日程未定'}）` });
        }

        // 週間レポート
        if (!r.reportSent) {
          if (!isCur) add('overdue', { kind: 'report', w, date: wEnd, text: `週間レポート未送付（${w}週目）` });
          else if (same(wEnd, t)) add('today', { kind: 'report', w, date: wEnd, text: '週間レポート 未送付（今週最終日）' });
          else add('week', { kind: 'report', w, date: wEnd, text: `週間レポート ${w}週目（〜${mdw(wEnd)}）` });
        }

        // 目標・身体評価
        for (const ev of EVALS) {
          if (ev.week !== w || c[ev.key]) continue;
          const d = evalDue(c, s, ev);
          const b = bucket(d);
          const name = ev.key === 'eval0' ? '開始時の身体評価' : `${ev.week}週目の身体評価`;
          add(b, { kind: 'eval', key: ev.key, date: d, text: b === 'today' ? name : `${name}（${mdw(d)}）` });
        }
      }

      // 最終評価（11週目から表示）
      if (s.cur >= 11 && !c.finalDone) {
        const b = bucket(s.end);
        add(b, { kind: 'final', key: 'final', date: s.end, text: `最終評価（12週の変化と今後の計画）〜${mdw(s.end)}` });
      }
      if (s.cur > WEEKS) {
        add('overdue', { kind: 'go', key: 'ended', date: s.end, text: `12週が終了（${md(s.end)}）→ 状態を更新`, href: '#/edit/' + c.id });
      }
    }
    const sort = (a, b) => (a.date - b.date) || (order[a.kind] - order[b.kind]) || a.c.name.localeCompare(b.c.name, 'ja');
    out.overdue.sort(sort);
    // 同じお客様・同じ項目の遅れは1行にまとめる（タップで一番古い週を済にする）
    const seen = {};
    out.overdue = out.overdue.filter((x) => {
      if (!['checkin', 'meeting', 'report'].includes(x.kind)) return true;
      const k = x.c.id + ':' + x.kind;
      if (seen[k]) { seen[k].more = (seen[k].more || 0) + 1; return false; }
      seen[k] = x;
      return true;
    });
    out.overdue.forEach((x) => { if (x.more) x.text += `　ほか${x.more}週`; });
    out.today.sort((a, b) => (order[a.kind] - order[b.kind]) || a.c.name.localeCompare(b.c.name, 'ja'));
    out.week.sort(sort);
    return out;
  }

  // ================================================================ API

  function getToken() {
    try {
      const o = JSON.parse(lsGet(TOKEN_KEY) || 'null');
      if (o && o.token && o.exp > Date.now()) return o.token;
    } catch (_) { /* 壊れていたら捨てる */ }
    return null;
  }

  async function api(action, payload) {
    const body = Object.assign({ action }, payload || {});
    if (action !== 'login') body.token = getToken();
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (_) { throw new Error('network'); }
    let data;
    try { data = await res.json(); } catch (_) { throw new Error('network'); }
    if (!data.ok) {
      if (data.error === 'unauthorized') { logout(); toast(ERRORS.unauthorized); }
      throw new Error(data.error || 'server');
    }
    return data;
  }
  const errText = (e) => ERRORS[e && e.message] || 'エラーが発生しました。時間をおいてもう一度お試しください。';

  function setData(d) {
    state.clients = (d.clients || []).slice();
    state.weeks = {};
    for (const w of d.weeks || []) (state.weeks[w.clientId] = state.weeks[w.clientId] || {})[w.week] = w;
    state.ready = true;
  }
  function saveCache() {
    const weeks = [];
    Object.values(state.weeks).forEach((o) => weeks.push(...Object.values(o)));
    lsSet(CACHE_KEY, JSON.stringify({ clients: state.clients, weeks, at: Date.now() }));
  }

  async function refresh(opts) {
    if (state.loading) return;
    state.loading = true;
    setSyncing(true);
    try {
      const d = await api('getAll');
      setData(d);
      state.syncedAt = new Date();
      saveCache();
      if (!state.dirty || (opts && opts.force)) render();
    } catch (e) {
      if (getToken()) toast(errText(e));
    } finally {
      state.loading = false;
      setSyncing(false);
    }
  }
  function setSyncing(on) {
    const b = document.querySelector('[data-act="refresh"]');
    if (!b) return;
    if (on) { b.dataset.label = b.innerHTML; b.disabled = true; b.style.opacity = '.5'; }
    else { b.disabled = false; b.style.opacity = ''; }
  }

  function logout() {
    lsSet(TOKEN_KEY, null);
    lsSet(CACHE_KEY, null);
    state.clients = []; state.weeks = {}; state.ready = false;
    render();
  }

  /** 週の記録を部分更新（画面は先に変える。失敗したら戻す） */
  async function patchWeek(cid, w, patch, quiet) {
    const map = state.weeks[cid] = state.weeks[cid] || {};
    const before = map[w] ? Object.assign({}, map[w]) : null;
    map[w] = Object.assign({ clientId: cid, week: w, weights: [], checks: '', checkinDone: false, meetingDate: '',
      formVideos: 0, mealDays: 0, reportSent: false, memo: '' }, map[w] || {}, patch);
    try {
      const d = await api('saveWeek', { week: Object.assign({ clientId: cid, week: w }, patch) });
      map[w] = d.week;
      saveCache();
      return before;
    } catch (e) {
      if (before) map[w] = before; else delete map[w];
      if (!quiet) toast(errText(e));
      throw e;
    }
  }
  async function patchClient(id, patch, quiet) {
    const c = state.clients.find((x) => x.id === id);
    const before = c ? Object.assign({}, c) : null;
    if (c) Object.assign(c, patch);
    try {
      const d = await api('saveClient', { client: Object.assign({ id }, patch) });
      const i = state.clients.findIndex((x) => x.id === id);
      if (i >= 0) state.clients[i] = d.client;
      saveCache();
      return before;
    } catch (e) {
      if (c && before) Object.assign(c, before);
      if (!quiet) toast(errText(e));
      throw e;
    }
  }

  /** 全データを JSON ファイルで保存する（スプレッドシートの代わりの控え） */
  function downloadBackup() {
    const weeks = [];
    Object.values(state.weeks).forEach((o) => weeks.push(...Object.values(o)));
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), clients: state.clients, weeks }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kanri-backup-${fd(today())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ================================================================ トースト

  let toastTimer = null;
  function toast(msg, undo) {
    const el = document.getElementById('toast');
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (undo ? '<button type="button">元に戻す</button>' : '');
    el.hidden = false;
    if (undo) el.querySelector('button').onclick = () => { el.hidden = true; undo(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 6000 : 3500);
  }

  // ================================================================ 描画：共通
  // 情報の並びは RafaCoach の管理アプリ（数字 → 対応が必要 → タップでシート → 詳細）。
  // 見た目と操作は Apple の HIG（iOS）に合わせる：ナビゲーションバー＋大きなタイトル、
  // 設定アプリ型のグループ、リマインダー型の丸いチェック、ステッパー、スイッチ、シート、浮いたタブバー。

  const PRICE = 330000; // 3ヶ月プラン（税込）
  const ui = { filter: 'all', q: '', sheet: null };
  let T = null;

  const I = { // SF Symbols に似せた線のアイコン
    house: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h4.5v-5.5h3V20H18V9.5"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.3"/><path d="M3 19.5c.6-3.4 3-5.4 6-5.4s5.4 2 6 5.4"/><circle cx="17.2" cy="9" r="2.5"/><path d="M16 14.3c2.6 0 4.5 1.8 5 5.2"/></svg>',
    yen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 7.5 12 12l3.5-4.5M12 12v5M9 12.5h6M9 15h6"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    back: '<svg viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:20px"><path d="M10 2 2 10l8 8"/></svg>',
    chev: '<svg viewBox="0 0 9 15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m1.5 1.5 6 6-6 6"/></svg>',
    check: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m2.5 7.3 3 3 6-6.6"/></svg>',
    search: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7.5" cy="7.5" r="5.5"/><path d="m11.5 11.5 4.5 4.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="M12 6.5v7" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.4" fill="#fff"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="m7.5 12.3 3 3 6-6.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m2 2 8 8M10 2l-8 8"/></svg>',
    msg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.5c-5 0-9 3.2-9 7.2 0 3.6 3.2 6.6 7.5 7.1.3.1.7.2.8.5.1.2.1.6 0 .9l-.1.8c0 .2-.2.9.8.5s5.4-3.2 7.4-5.5c1.3-1.4 2-2.9 2-4.3 0-4-4-7.2-9-7.2z"/></svg>',
    person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c.8-4 3.8-6.2 7.5-6.2s6.7 2.2 7.5 6.2"/></svg>',
  };
  const chev = `<span class="chev">${I.chev}</span>`;

  function render() {
    if (chart) { chart.destroy(); chart = null; }
    state.dirty = false;
    T = null;
    document.body.classList.remove('sheet-open');
    if (!getToken()) return renderLogin();
    if (!state.ready) { $app.innerHTML = '<div class="loading"><span class="spin"></span></div>'; return; }
    const [a, b, c, d] = location.hash.replace(/^#\/?/, '').split('/');
    if (a === 'c' && b && c === 'w' && Number(d) >= 1 && Number(d) <= WEEKS) return renderWeekEdit(decodeURIComponent(b), Number(d));
    if (a === 'c' && b) return renderDetail(decodeURIComponent(b));
    if (a === 'new') return renderNew();
    if (a === 'edit' && b) return renderEdit(decodeURIComponent(b));
    if (a === 'clients') return renderClients();
    if (a === 'money') return renderMoney();
    if (a === 'menu') return renderMenu();
    return renderHome();
  }

  /** ナビゲーションバー。large=true でトップレベル（大きなタイトルを下に出す） */
  function navbar(o) {
    return `<header class="nav${o.solid ? ' solid' : ''}"><div class="nav-bar">
      <div class="nav-l">${o.back ? `<a class="nav-btn" href="${o.back}">${I.back}<span>${esc(o.backLabel || '戻る')}</span></a>` : ''}</div>
      <div class="nav-title">${esc(o.title)}</div>
      <div class="nav-r">${o.right || ''}</div>
    </div></header>`;
  }
  const addBtn = `<a class="nav-btn icon" href="#/new" aria-label="お客様を追加">${I.plus}</a>`;
  function largeTitle(title, small, sub) {
    return `<div class="large">${small ? `<small>${esc(small)}</small>` : ''}<h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>`;
  }
  function tabbar(cur) {
    const it = (href, key, ic, label) => `<a href="${href}" class="${cur === key ? 'on' : ''}"${cur === key ? ' aria-current="page"' : ''}>${ic}<span>${label}</span></a>`;
    return `<nav class="tabbar" aria-label="メイン">${it('#/', 'home', I.house, 'ホーム')}${it('#/clients', 'clients', I.people, 'お客様')}${it('#/money', 'money', I.yen, '売上')}${it('#/menu', 'menu', I.gear, '設定')}</nav>`;
  }
  function group(header, inner, footer, cls) {
    return `<section class="group">${header ? `<h2 class="gh${cls ? ' ' + cls : ''}">${header}</h2>` : ''}<div class="list">${inner}</div>${footer ? `<p class="gf">${footer}</p>` : ''}</section>`;
  }
  const kv = (k, v, cls) => `<div class="cell"><span class="cell-main"><span class="t">${k}</span></span><span class="v ${cls || ''}">${v}</span></div>`;

  // ---------- お客様ごとの「いま必要なこと」 ----------
  const SHORT = { checkin: 'チェックイン', meeting: '面談', report: 'レポート', eval: '身体評価', final: '最終評価' };
  function tasksOf(cid) {
    if (!T) T = buildTasks();
    const pick = (arr) => arr.filter((x) => x.c.id === cid);
    return { overdue: pick(T.overdue), today: pick(T.today) };
  }
  /** level: late（遅れ）/ today（今日）/ info（気づき） */
  function issues(c) {
    const t = today();
    const out = [];
    const intake = c.intake && c.intake.submittedAt;
    const since = (d) => (d ? Math.max(0, diffDays(t, d)) : 0);
    if (c.status === ST.WAIT) {
      if (!c.paidDate) {
        const cr = c.createdAt ? new Date(c.createdAt) : t;
        out.push({ short: '入金待ち', long: '入金の確認', days: since(new Date(cr.getFullYear(), cr.getMonth(), cr.getDate())), level: 'late' });
      } else if (!c.startDate) {
        out.push({ short: '開始日', long: '開始日の決定', days: since(pd(c.paidDate)), level: 'late' });
      }
      if (!intake) out.push({ short: 'ヒアリング', long: 'ヒアリングの回答', level: 'info' });
      return out;
    }
    if (c.status !== ST.ACTIVE) return out;
    const tk = tasksOf(c.id);
    for (const x of tk.overdue) {
      if (x.kind === 'go') out.push({ short: x.key === 'ended' ? '12週終了' : '開始日', long: x.key === 'ended' ? '状態の更新' : '開始日の設定', days: since(x.date), level: 'late' });
      else out.push({ short: SHORT[x.kind], long: SHORT[x.kind], days: since(x.date), level: 'late' });
    }
    for (const x of tk.today) if (x.kind !== 'go') out.push({ short: SHORT[x.kind], long: SHORT[x.kind], level: 'today' });
    if (!intake) out.push({ short: 'ヒアリング', long: 'ヒアリングの回答', level: 'info' });
    return out;
  }
  const needsYou = (iss) => iss.some((i) => i.level !== 'info');
  const maxDays = (iss) => Math.max(0, ...iss.map((i) => i.days || 0));
  function badge(iss) {
    const late = iss.filter((i) => i.level === 'late').sort((a, b) => (b.days || 0) - (a.days || 0));
    if (late.length) return `<span class="badge late">${esc(late[0].short)}${late[0].days ? ` ${late[0].days}日` : ''}</span>`;
    const td = iss.find((i) => i.level === 'today');
    if (td) return `<span class="badge today">${esc(td.short)} 今日</span>`;
    const info = iss.find((i) => i.level === 'info');
    if (info) return `<span class="badge info">${esc(info.short)}未</span>`;
    return '<span class="badge ok">順調</span>';
  }
  function lateText(iss) {
    const late = iss.filter((i) => i.level === 'late');
    if (!late.length) return '';
    const m = maxDays(late);
    return `${[...new Set(late.map((i) => i.long))].join('・')}${m ? `（${m}日前から）` : ''}`;
  }
  function subLine(c) {
    const s = sched(c);
    if (c.status === ST.WAIT) return c.paidDate ? `入金済 ${mdwS(c.paidDate)}・開始日未定` : '入金待ち';
    if (c.status === ST.DONE) return '終了';
    if (c.status === ST.CONSULT) return '継続相談';
    if (!s) return '開始日未定';
    if (s.cur === 0) return `${mdw(s.start)}に開始`;
    if (s.cur > WEEKS) return '12週終了';
    return `${s.cur}週目／12週・チェックイン${c.checkinDow === '' ? '未設定' : DOW[c.checkinDow] + '曜'}`;
  }
  function clientCell(c, iss) {
    return `<button type="button" class="cell" data-act="sheet" data-id="${esc(c.id)}">
      <span class="cell-main"><span class="t b">${esc(san(c.name))}</span><span class="s">${esc(subLine(c))}</span></span>
      ${badge(iss)}${chev}</button>`;
  }

  // ================================================================ ログイン

  function renderLogin(msg) {
    $app.innerHTML = `
      <section class="login"><form id="loginForm" autocomplete="on">
        <div class="login-ic">${I.person}</div>
        <h1>顧客管理</h1><p>畠山祐輔さん・関係者専用</p>
        <input type="text" name="username" value="hatakeyama-kanri" autocomplete="username" hidden>
        ${group('', `<label class="cell"><span class="lab">パスワード</span><input id="pw" type="password" name="password" autocomplete="current-password" placeholder="必須" required></label>`)}
        ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
        <div class="btns"><button class="btn filled" type="submit">ログイン</button></div>
      </form></section>`;
    const f = document.getElementById('loginForm');
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        const d = await api('login', { password: f.password.value });
        lsSet(TOKEN_KEY, JSON.stringify({ token: d.token, exp: d.exp }));
        state.ready = false;
        render();
        await refresh({ force: true });
      } catch (e) { renderLogin(errText(e)); }
    });
    setTimeout(() => { const p = document.getElementById('pw'); if (p) p.focus(); }, 50);
  }

  // ================================================================ ホーム

  function paidIn(y, m) { return state.clients.filter((c) => { const d = pd(c.paidDate); return d && d.getFullYear() === y && d.getMonth() === m; }); }
  const yen = (n) => '¥' + n.toLocaleString('ja-JP');

  function renderHome() {
    const t = today();
    const n = { active: 0, wait: 0, done: 0, late: 0 };
    for (const c of state.clients) {
      if (c.status === ST.ACTIVE) n.active++; else if (c.status === ST.WAIT) n.wait++; else n.done++;
      if (issues(c).some((i) => i.level === 'late')) n.late++;
    }
    const paid = paidIn(t.getFullYear(), t.getMonth());
    const list = state.clients.filter((c) => c.status === ST.ACTIVE || c.status === ST.WAIT).map((c) => ({ c, iss: issues(c) }));
    const need = list.filter((x) => needsYou(x.iss)).sort((a, b) => maxDays(b.iss) - maxDays(a.iss));
    const fine = list.filter((x) => !needsYou(x.iss));
    const subs = recentSubmissions();
    const sum = (key, label, v, color, cls) => `<a class="sum${cls ? ' ' + cls : ''}" href="#/clients" data-act="filter" data-v="${key}"><span><i class="dot" style="background:${color}"></i>${label}</span><b>${v}</b></a>`;

    $app.innerHTML = `
      ${navbar({ title: 'ホーム', right: addBtn })}
      <main class="page">
        ${largeTitle('ホーム', `${t.getMonth() + 1}月${t.getDate()}日 ${DOW[t.getDay()]}曜日`)}
        <div class="summary">
          ${sum(ST.ACTIVE, '進行中', n.active, 'var(--tint)')}${sum(ST.WAIT, '入金待ち', n.wait, 'var(--teal)')}
          ${sum(ST.DONE, '終了', n.done, 'var(--gray)')}${sum('late', '遅れ', n.late, 'var(--brown)', n.late ? 'late' : '')}
        </div>
        ${group('', `<a class="cell" href="#/money"><span class="cell-main"><span class="t">${t.getMonth() + 1}月の入金</span></span><span class="v strong">${yen(paid.length * PRICE)}（${paid.length}名）</span>${chev}</a>`)}
        ${need.length ? `<div class="notice"><span class="ic">${I.warn}</span><div><b>${need.length}名が対応を待っています</b><span>上から順に、タップして済にしてください。</span></div></div>`
          : '<div class="notice ok"><span class="ic">' + I.ok + '</span><div><b>今日やることはすべて済んでいます</b></div></div>'}
        ${subs.length ? group('お客様から届いた', subs.map((x) => `<a class="cell" href="#/c/${encodeURIComponent(x.c.id)}">
            <span class="cell-main"><span class="t b">${esc(san(x.c.name))}</span><span class="s">${esc(x.text)}・${esc(dt(x.at))}</span></span><span class="badge new">新着</span>${chev}</a>`).join('')) : ''}
        ${need.length ? group(`対応が必要（${need.length}）`, need.map((x) => clientCell(x.c, x.iss)).join('')) : ''}
        ${fine.length ? group(`順調（${fine.length}）`, fine.map((x) => clientCell(x.c, x.iss)).join('')) : ''}
        ${state.clients.length ? '' : group('', '<div class="empty">まだお客様がいません。右上の＋から追加できます。</div>')}
      </main>
      ${ui.sheet ? sheet(ui.sheet) : ''}
      ${tabbar('home')}`;
    if (ui.sheet) document.body.classList.add('sheet-open');
  }

  function recentSubmissions() {
    const since = Date.now() - RECENT_MS;
    const out = [];
    for (const c of state.clients) {
      if (c.intake && c.intake.submittedAt && Date.parse(c.intake.submittedAt) > since) out.push({ c, at: c.intake.submittedAt, text: 'ヒアリングに回答' });
      for (const r of Object.values(state.weeks[c.id] || {})) if (r.submittedAt && Date.parse(r.submittedAt) > since) out.push({ c, at: r.submittedAt, text: `${r.week}週目のチェックイン` });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }
  function dt(iso) { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }

  // ---------- 今週のタスク（リマインダー型） ----------
  function weekTasks(c) {
    const s = sched(c);
    const t = today();
    if (c.status === ST.WAIT) return [{ act: 'tg-paid', done: !!c.paidDate, label: '入金を確認した', sub: c.paidDate ? `${mdwS(c.paidDate)}に確認` : '確認すると売上に入ります' }];
    if (c.status !== ST.ACTIVE || !s || s.cur < 1) return [];
    const w = Math.min(s.cur, WEEKS);
    const r = rec(c.id, w) || {};
    const ci = dowInWeek(s, w, c.checkinDow);
    const mt = dowInWeek(s, w, c.meetingDow);
    const out = [
      { act: 'tg-checkin', w, done: !!r.checkinDone, label: 'チェックインを受け取った',
        sub: r.submittedAt ? `お客様から届いた（${dt(r.submittedAt)}）` : ci ? `予定 ${mdw(ci)}` : 'チェックイン曜日が未設定', late: !r.checkinDone && ci && ci < t },
      { act: 'tg-meeting', w, done: !!r.meetingDate, label: '個別面談（60分）', sub: r.meetingDate ? `${mdwS(r.meetingDate)}に実施` : mt ? `予定 ${mdw(mt)}` : '今週中', late: !r.meetingDate && mt && mt < t },
      { act: 'tg-report', w, done: !!r.reportSent, label: '週間レポートを送った', sub: '振り返りと改善提案' },
    ];
    for (const ev of EVALS) {
      if (ev.week !== w) continue;
      const due = evalDue(c, s, ev);
      out.push({ act: 'tg-eval', key: ev.key, w, done: !!c[ev.key], label: `${ev.label === '開始時' ? '開始時' : ev.week + '週目'}の身体評価`, sub: c[ev.key] ? `${mdwS(c[ev.key])}に実施` : `予定 ${mdw(due)}`, late: !c[ev.key] && due < t });
    }
    if (s.cur >= 11) out.push({ act: 'tg-final', w, done: !!c.finalDone, label: '最終評価', sub: c.finalDone ? `${mdwS(c.finalDone)}に実施` : `〜${mdw(s.end)}`, late: !c.finalDone && s.end < t });
    return out;
  }
  function taskCells(c) {
    return weekTasks(c).map((x) => `
      <button type="button" class="cell${x.done ? ' done' : ''}" role="checkbox" aria-checked="${x.done}" data-act="${x.act}" data-id="${esc(c.id)}"${x.w ? ` data-w="${x.w}"` : ''}${x.key ? ` data-key="${x.key}"` : ''}>
        <span class="circle${x.done ? ' on' : x.late ? ' late' : ''}">${I.check}</span>
        <span class="cell-main"><span class="t">${esc(x.label)}</span><span class="s${x.late ? ' late-t' : ''}">${esc(x.sub)}${x.late ? '・遅れ' : ''}</span></span>
      </button>`).join('');
  }

  // ---------- LINE ----------
  function formUrl(c) { return `${location.origin}/form.html#${c.formKey}`; }
  function msgIntake(c) {
    const head0 = c.paidDate ? 'ご入金を確認しました。ありがとうございます。' : 'このたびはお申し込みありがとうございます。';
    return `${san(c.name)}\n${head0}畠山です。\n\n開始前に、こちらの事前ヒアリングにご回答をお願いします（5分ほど）。\n${formUrl(c)}\n\nこのリンクは、開始後の毎週のチェックインにも使います。ブックマークしておいてください。`;
  }
  function msgCheckin(c) { return `${san(c.name)}\n今週のチェックインをお願いします。\n${formUrl(c)}`; }
  function mainMessage(c) {
    const intake = c.intake && c.intake.submittedAt;
    return !intake || c.status !== ST.ACTIVE ? { text: msgIntake(c), label: intake ? 'リンクをLINEで送る' : 'ヒアリングをLINEで送る' } : { text: msgCheckin(c), label: 'チェックインのお願いをLINEで送る' };
  }
  const lineHref = (text) => `https://line.me/R/share?text=${encodeURIComponent(text)}`;

  // ---------- シート ----------
  function sheet(id) {
    const c = state.clients.find((x) => x.id === id);
    if (!c) return '';
    const iss = issues(c);
    const late = lateText(iss);
    const m = c.formKey ? mainMessage(c) : null;
    const tasks = taskCells(c);
    return `<div class="sheet-bg" data-act="close-sheet"></div>
      <section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(san(c.name))}">
        <div class="grip"></div>
        <div class="sheet-h"><div><h2>${esc(san(c.name))}</h2><p>${esc(subLine(c))}</p></div>
          <button type="button" class="xbtn" data-act="close-sheet" aria-label="閉じる">${I.x}</button></div>
        ${late ? `<div class="notice"><span class="ic">${I.warn}</span><div><b>遅れています</b><span>${esc(late)}</span></div></div>` : ''}
        ${tasks ? group('今週のタスク', tasks) : ''}
        ${group('', kv('ヒアリング', c.intake && c.intake.submittedAt ? '回答済み' : '未回答', c.intake && c.intake.submittedAt ? 'ok-t' : 'late-t'))}
        <div class="btns">
          ${m ? `<a class="btn line" href="${lineHref(m.text)}" target="_blank" rel="noopener noreferrer">${I.msg}${m.label}</a>` : ''}
          <a class="btn gray" href="#/c/${encodeURIComponent(c.id)}">詳細を見る</a>
        </div>
      </section>`;
  }

  // ================================================================ お客様一覧

  function renderClients() {
    const q = ui.q.trim().toLowerCase();
    const f = ui.filter;
    const arr = state.clients.map((c) => ({ c, iss: issues(c) })).filter(({ c, iss }) => {
      if (q && !(`${c.name} ${c.lineName}`.toLowerCase().includes(q))) return false;
      if (f === 'late') return iss.some((i) => i.level === 'late');
      if (f === ST.DONE) return c.status === ST.DONE || c.status === ST.CONSULT;
      if (f !== 'all') return c.status === f;
      return true;
    }).sort((a, b) => maxDays(b.iss) - maxDays(a.iss) || (a.c.startDate || '9').localeCompare(b.c.startDate || '9'));
    const segs = [['all', 'すべて'], [ST.ACTIVE, '進行中'], [ST.WAIT, '入金待ち'], [ST.DONE, '終了'], ['late', '遅れ']];
    $app.innerHTML = `
      ${navbar({ title: 'お客様', right: addBtn })}
      <main class="page">
        ${largeTitle('お客様')}
        <label class="search">${I.search}<input type="search" id="q" placeholder="検索" value="${esc(ui.q)}" autocomplete="off" enterkeyhint="search"></label>
        <div class="seg" role="tablist">${segs.map(([k, l]) => `<button type="button" role="tab" aria-selected="${f === k}" class="${f === k ? 'on' : ''}" data-act="filter" data-v="${k}">${l}</button>`).join('')}</div>
        ${group('', arr.map((x) => clientCell(x.c, x.iss)).join('') || '<div class="empty">該当するお客様はいません</div>', `${arr.length}名`)}
      </main>
      ${ui.sheet ? sheet(ui.sheet) : ''}
      ${tabbar('clients')}`;
    if (ui.sheet) document.body.classList.add('sheet-open');
    const qi = document.getElementById('q');
    qi.addEventListener('input', () => {
      ui.q = qi.value;
      const pos = qi.selectionStart;
      renderClients();
      const n2 = document.getElementById('q'); n2.focus(); n2.setSelectionRange(pos, pos);
    });
  }

  // ================================================================ 売上

  function renderMoney() {
    const t = today();
    const months = [];
    for (let i = 0; i < 12; i++) { const d = new Date(t.getFullYear(), t.getMonth() - i, 1); months.push({ d, list: paidIn(d.getFullYear(), d.getMonth()) }); }
    const total = state.clients.filter((c) => c.paidDate).length;
    $app.innerHTML = `
      ${navbar({ title: '売上' })}
      <main class="page">
        ${largeTitle('売上')}
        <div class="money"><small>${t.getMonth() + 1}月の入金</small><b>${yen(months[0].list.length * PRICE)}</b><small>${months[0].list.length}名</small></div>
        ${group('月ごと', months.map(({ d, list }) => `<div class="cell"><span class="cell-main"><span class="t">${d.getFullYear()}年${d.getMonth() + 1}月</span>
          ${list.length ? `<span class="s">${list.map((c) => esc(san(c.name))).join('、')}</span>` : ''}</span><span class="v${list.length ? ' strong' : ''}">${yen(list.length * PRICE)}</span></div>`).join(''),
          `入金確認日をもとに、3ヶ月プラン（税込33万円）× 人数で計算しています。累計 ${total}名・${yen(total * PRICE)}。`)}
      </main>
      ${tabbar('money')}`;
  }

  // ================================================================ 設定

  function renderMenu() {
    $app.innerHTML = `
      ${navbar({ title: '設定' })}
      <main class="page">
        ${largeTitle('設定', '', state.syncedAt ? `${state.syncedAt.getHours()}:${String(state.syncedAt.getMinutes()).padStart(2, '0')}に更新` : '')}
        ${group('', `<button type="button" class="cell tint" data-act="refresh"><span class="cell-main"><span class="t">最新の状態に更新</span></span></button>
          <button type="button" class="cell tint" data-act="backup"><span class="cell-main"><span class="t">バックアップを保存</span><span class="s">すべてのデータをファイルで保存します</span></span></button>`)}
        ${group('プラン', kv('内容', '3ヶ月（12週）完全オンライン') + kv('料金', '30万円（税込33万円）') + kv('支払い', '銀行振込・入金確認後に開始') + kv('初回', 'カウンセリング60分') + kv('継続', '個別相談'))}
        ${group('お客様との約束', kv('個別面談', '週1回60分×12回') + kv('身体評価', '開始時・4週・8週・12週') + kv('フォーム添削', '動画 週2本まで') + kv('食事記録の確認', '週3日分') + kv('週間レポート', '週1回') + kv('LINE返信', '原則2営業日以内'), '日曜・祝日はLINEの返信をしません。')}
        ${group('', '<button type="button" class="cell danger center" data-act="logout"><span class="cell-main"><span class="t">ログアウト</span></span></button>')}
      </main>
      ${tabbar('menu')}`;
  }

  // ================================================================ お客様の詳細

  function renderDetail(id) {
    const c = state.clients.find((x) => x.id === id);
    if (!c) { location.hash = '#/'; return; }
    const s = sched(c);
    const iss = issues(c);
    const st = stats(c);
    const t = today();
    const w = s && s.cur >= 1 ? Math.min(s.cur, WEEKS) : null;
    const r = w ? rec(c.id, w) || {} : {};
    const nc = nextCheckin(c, s);
    const late = lateText(iss);
    const dowName = (d) => (d === '' || d == null ? '未設定' : DOW[d] + '曜');
    const slash = (d) => (d ? d.replace(/-/g, '/') : '');
    const m = c.formKey ? mainMessage(c) : null;
    const intake = c.intake && c.intake.submittedAt;
    const tasks = taskCells(c);

    $app.innerHTML = `
      ${navbar({ title: san(c.name), back: '#/', backLabel: 'ホーム', right: `<a class="nav-btn" href="#/edit/${encodeURIComponent(id)}">編集</a>` })}
      <main class="page">
        ${largeTitle(san(c.name), '', subLine(c))}
        ${late ? `<div class="notice"><span class="ic">${I.warn}</span><div><b>遅れています</b><span>${esc(late)}</span></div></div>`
          : c.status === ST.ACTIVE && s && s.cur >= 1 ? `<div class="notice ok"><span class="ic">${I.ok}</span><div><b>順調です</b></div></div>` : ''}

        ${tasks ? group(w ? `${w}週目のタスク` : 'タスク', tasks) : ''}
        ${w ? group('今週の記録', `
          <div class="cell"><span class="cell-main"><span class="t">フォーム添削</span><span class="s">上限 ${FORM_MAX}本</span></span>
            <span class="val">${r.formVideos || 0}本</span>${stepper(c.id, w, 'formVideos', FORM_MAX)}</div>
          <div class="cell"><span class="cell-main"><span class="t">食事記録の確認</span><span class="s">目安 ${MEAL_TARGET}日</span></span>
            <span class="val">${r.mealDays || 0}日</span>${stepper(c.id, w, 'mealDays', 7)}</div>`) : ''}

        <section class="group"><h2 class="gh">お客様に送る</h2>
          ${c.formKey ? `<div class="list"><a class="cell" href="${formUrl(c)}" target="_blank" rel="noopener noreferrer"><span class="cell-main"><span class="t tint-t" style="color:var(--tint)">お客様用ページを開く</span><span class="s">${esc(formUrl(c).replace(/^https?:\/\//, ''))}</span></span>${chev}</a>
            ${intake && c.status === ST.ACTIVE ? `<a class="cell" href="${lineHref(msgIntake(c))}" target="_blank" rel="noopener noreferrer"><span class="cell-main"><span class="t" style="color:var(--tint)">ヒアリングをもう一度送る</span></span>${chev}</a>` : ''}</div>
            <div class="btns"><a class="btn line" href="${lineHref(m.text)}" target="_blank" rel="noopener noreferrer">${I.msg}${m.label}</a></div>`
            : `<div class="list"><button class="cell tint" type="button" data-act="issuekey"><span class="cell-main"><span class="t">お客様用リンクを作る</span></span></button></div>`}
        </section>

        ${group('情報', [
          kv('進み具合', s && s.cur >= 1 ? `${Math.min(s.cur, WEEKS)}週目／12週` : '開始前', 'strong'),
          kv('入金確認日', c.paidDate ? slash(c.paidDate) : '未確認', c.paidDate ? '' : 'late-t'),
          kv('開始日', c.startDate ? slash(c.startDate) : '未設定', c.startDate ? '' : 'late-t'),
          kv('終了予定日', s ? slash(fd(s.end)) : '—'),
          kv('次のチェックイン', nc ? `${slash(fd(nc))}（${DOW[nc.getDay()]}）` : '—'),
          kv('チェックイン曜日', dowName(c.checkinDow)),
          kv('面談曜日', dowName(c.meetingDow)),
          kv('LINE名', esc(c.lineName || '—')),
          c.goal ? kv('目標', esc(c.goal)) : '',
          c.memo ? kv('メモ', esc(c.memo)) : '',
        ].join(''), `約束の達成：面談 ${st.meet}/12・身体評価 ${st.evals}/4・レポート ${st.rep}/12・チェックイン ${st.chk}/12`)}

        ${group('事前ヒアリング', intakeCell(c))}

        ${group('身体評価', EVALS.map((ev) => {
          const due = s ? evalDue(c, s, ev) : null;
          const miss = !c[ev.key] && due && due < t;
          return `<div class="cell"><span class="cell-main"><span class="t">${ev.label}</span><span class="s${miss ? ' late-t' : ''}">予定 ${mdw(due)}${miss ? '・遅れ' : ''}</span></span>
            <input type="date" value="${esc(c[ev.key] || '')}" data-act="evaldate" data-key="${ev.key}" aria-label="${ev.label}の実施日"></div>`;
        }).join(''), '実施した日を入れてください。')}
        ${s && (s.cur >= 11 || c.finalDone || c.finalPlan) ? finalGroup(c, s) : ''}

        ${historyGroup(c, s)}

        ${c.status === ST.ACTIVE || c.status === ST.DONE || c.status === ST.CONSULT ? group('状態', [
          c.status === ST.ACTIVE && s && s.cur >= 11 ? `<button type="button" class="cell tint" data-act="status" data-v="${ST.CONSULT}"><span class="cell-main"><span class="t">継続の相談に進む</span></span></button>` : '',
          c.status === ST.ACTIVE ? `<button type="button" class="cell tint" data-act="status" data-v="${ST.DONE}"><span class="cell-main"><span class="t">終了にする</span></span></button>` : '',
          c.status !== ST.ACTIVE ? `<button type="button" class="cell tint" data-act="status" data-v="${ST.ACTIVE}"><span class="cell-main"><span class="t">進行中に戻す</span></span></button>` : '',
        ].join('')) : ''}
        ${group('', `<button type="button" class="cell danger center" data-act="delete" data-id="${esc(c.id)}"><span class="cell-main"><span class="t">このお客様を削除</span></span></button>`)}
      </main>
      ${tabbar('')}`;
    drawChart(c);
  }

  function stepper(cid, w, name, max) {
    return `<span class="stepper"><button type="button" data-act="step" data-id="${esc(cid)}" data-name="${name}" data-d="-1" data-max="${max}" data-w="${w}" aria-label="減らす">−</button><i></i>
      <button type="button" data-act="step" data-id="${esc(cid)}" data-name="${name}" data-d="1" data-max="${max}" data-w="${w}" aria-label="増やす">＋</button></span>`;
  }

  function intakeCell(c) {
    if (!(c.intake && c.intake.submittedAt)) return '<div class="cell"><span class="cell-main"><span class="t" style="color:var(--label2)">まだ回答がありません</span></span></div>';
    const a = c.intake.answers || {};
    const qs = INTAKE.sections.flatMap((sec) => sec.questions);
    const val = (q) => (q.type === 'radio' ? a[q.id + '__label'] || a[q.id] : a[q.id] ? a[q.id] + (q.unit ? ' ' + q.unit : '') : '') || '—';
    const known = new Set(qs.map((q) => q.id));
    const extra = Object.keys(a).filter((k) => !known.has(k) && !k.endsWith('__label'));
    return `<details class="cell"><summary><span class="cell-main"><span class="t">回答を見る</span><span class="s">${dt(c.intake.submittedAt)}に回答</span></span>${chev}</summary>
      <dl class="qa">${qs.map((q) => `<dt>${esc(q.label)}</dt><dd>${esc(val(q))}</dd>`).join('')}${extra.map((k) => `<dt>${esc(k)}</dt><dd>${esc(a[k + '__label'] || a[k])}</dd>`).join('')}</dl></details>`;
  }

  function historyGroup(c, s) {
    const cells = [];
    for (let w = WEEKS; w >= 1; w--) {
      const r = rec(c.id, w);
      const has = r && (r.weights.length || r.checks || r.checkinDone || r.memo || r.meetingDate || r.submittedAt);
      if (!has && !(s && w === Math.min(s.cur, WEEKS))) continue;
      const rr = r || {};
      const n = scoreOf(rr);
      const meta = [n == null ? '' : `チェックシート ${n}/7（${scoreLabel(n)}）`, rr.condition ? `体調 ${rr.condition}` : '', rr.meetingDate ? '面談✓' : '', rr.reportSent ? 'レポート✓' : ''].filter(Boolean).join('・');
      cells.push(`<a class="cell" href="#/c/${encodeURIComponent(c.id)}/w/${w}">
        <span class="cell-main"><span class="t b">${w}週目 <span style="font-weight:400;color:var(--label2);font-size:.88rem">${s ? `${md(weekStart(s, w))}〜${md(weekEnd(s, w))}` : ''}</span></span>
          ${meta ? `<span class="s">${esc(meta)}</span>` : '<span class="s">まだ記録がありません</span>'}
          ${rr.clientNote ? `<span class="quote">「${esc(rr.clientNote)}」</span>` : ''}${rr.clientWin ? `<span class="quote">👍 ${esc(rr.clientWin)}</span>` : ''}</span>
        <span class="wk-kg">${avgW(rr) == null ? '' : avgW(rr).toFixed(1) + ' kg'}</span>${chev}</a>`);
    }
    const hasW = Object.values(state.weeks[c.id] || {}).some((r) => avgW(r) != null);
    return group('チェックインの履歴', `${hasW ? `<div class="cell chart-cell"><div class="row"><b>体重の推移</b><span id="chg" class="s" style="color:var(--label2)"></span></div>
        <div class="chart-box"><canvas id="chart" aria-label="週平均体重の推移"></canvas></div><p id="chartMsg" class="gf" style="padding:6px 0 0"></p></div>` : ''}
      ${cells.join('') || '<div class="cell"><span class="cell-main"><span class="t" style="color:var(--label2)">まだ記録がありません</span></span></div>'}`, '週をタップすると記録を入力・修正できます。');
  }

  function finalGroup(c, s) {
    const recs = [];
    for (let w = 1; w <= WEEKS; w++) recs.push(rec(c.id, w));
    const withW = recs.map((r, i) => ({ w: i + 1, v: avgW(r) })).filter((x) => x.v != null);
    const first = withW[0];
    const lastW = withW[withW.length - 1];
    const diff = first && lastW && lastW.w !== first.w ? lastW.v - first.v : null;
    return `<form id="finalForm">${group(`最終評価（〜${mdw(s.end)}）`, `
      ${kv('体重の変化', `${first ? kg(first.v) : '—'} → ${lastW ? kg(lastW.v) : '—'}${diff == null ? '' : `（${diff > 0 ? '+' : ''}${diff.toFixed(1)}kg）`}`)}
      <div class="cell"><textarea name="finalPlan" rows="4" placeholder="12週の変化と今後の計画（継続の相談も）" aria-label="12週の変化と今後の計画">${esc(c.finalPlan || '')}</textarea></div>
      <label class="cell"><span class="cell-main"><span class="t">実施日</span></span><input type="date" name="finalDone" value="${esc(c.finalDone || '')}"></label>
      <button class="cell tint center" type="submit"><span class="cell-main"><span class="t">保存</span></span></button>`)}</form>`;
  }

  async function loadChartJs() {
    if (window.Chart) return window.Chart;
    await new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
      sc.onload = resolve; sc.onerror = reject;
      document.head.appendChild(sc);
    });
    return window.Chart;
  }
  async function drawChart(c) {
    const cv = document.getElementById('chart');
    if (!cv) return;
    const pts = [];
    for (let w = 1; w <= WEEKS; w++) { const v = avgW(rec(c.id, w)); if (v != null) pts.push({ w, v: Math.round(v * 10) / 10 }); }
    const chg = document.getElementById('chg');
    if (pts.length >= 2 && chg) { const d = pts[pts.length - 1].v - pts[0].v; chg.textContent = `${d > 0 ? '+' : ''}${d.toFixed(1)} kg`; }
    const msg = document.getElementById('chartMsg');
    if (msg) msg.textContent = `${pts.length}週分（${pts[0].w}週目 → ${pts[pts.length - 1].w}週目）`;
    let Chart;
    try { Chart = await loadChartJs(); } catch (_) { if (msg) msg.textContent = 'グラフを読み込めませんでした。'; return; }
    if (!cv.isConnected) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    if (chart) chart.destroy();
    chart = new Chart(cv, {
      type: 'line',
      data: { labels: pts.map((p) => p.w + '週'), datasets: [{ data: pts.map((p) => p.v), borderColor: v('--tint'), backgroundColor: 'rgba(0,122,255,.10)', fill: true,
        tension: 0.3, pointRadius: 3.5, pointBackgroundColor: v('--bg2'), pointBorderWidth: 2, borderWidth: 2.5 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { ticks: { color: v('--label2'), font: { size: 11 } }, grid: { display: false } }, y: { ticks: { color: v('--label2'), font: { size: 11 } }, grid: { color: v('--sep') } } } },
    });
  }

  // ================================================================ 週の記録

  function renderWeekEdit(id, w) {
    const c = state.clients.find((x) => x.id === id);
    if (!c) { location.hash = '#/'; return; }
    const s = sched(c);
    const r = rec(c.id, w) || {};
    const weights = (r.weights || []).slice();
    while (weights.length < 3) weights.push('');
    const checks = (r.checks || '').padEnd(7, '0');
    $app.innerHTML = `
      ${navbar({ title: `${w}週目`, back: '#/c/' + encodeURIComponent(id), backLabel: san(c.name).slice(0, 8), solid: true })}
      <main class="page">
        ${largeTitle(`${w}週目の記録`, '', s ? `${md(weekStart(s, w))}〜${md(weekEnd(s, w))}` : '')}
        ${r.submittedAt ? group(`お客様から届いた（${esc(dt(r.submittedAt))}）`, [
          r.condition ? kv('体調', esc(r.condition)) : '',
          r.clientWin ? `<div class="cell"><span class="cell-main"><span class="s">うまくいったこと</span><span class="t">${esc(r.clientWin)}</span></span></div>` : '',
          r.clientNote ? `<div class="cell"><span class="cell-main"><span class="s">困っていること・質問</span><span class="t">${esc(r.clientNote)}</span></span></div>` : '',
        ].join('') || kv('内容', '体重とチェックシート'), '体重とチェックシートは下に反映済みです。') : ''}
        <form id="weekForm" novalidate>
          ${group('体重（kg）', `<div class="cell"><div class="weights" id="weights">${weights.map((v) => `<input type="number" inputmode="decimal" step="0.1" min="20" max="400" value="${esc(v)}" aria-label="体重">`).join('')}</div></div>
            <div class="cell"><span class="cell-main"><span class="t">週平均</span></span><span class="v strong" id="avg">—</span></div>
            <button type="button" class="cell tint" data-act="addweight"><span class="cell-main"><span class="t">入力欄を追加</span></span></button>`)}
          ${group('チェックシート', CHECK_ITEMS.map((txt, i) => `<label class="cell"><span class="cell-main"><span class="t">${esc(txt)}</span></span><input type="checkbox" class="tick" name="ck${i}"${checks[i] === '1' ? ' checked' : ''}></label>`).join('')
            + '<div class="cell score-row"><span class="cell-main"><span class="t" id="score">未入力</span></span></div>', '5個以上「継続」、3〜4個「1つだけ改善」、0〜2個「計画をシンプルに」')}
          ${group('この週のこと', `
            <label class="cell"><span class="cell-main"><span class="t">チェックインを受け取った</span></span><input type="checkbox" class="switch" name="checkinDone"${r.checkinDone ? ' checked' : ''}></label>
            <label class="cell"><span class="cell-main"><span class="t">週間レポートを送った</span></span><input type="checkbox" class="switch" name="reportSent"${r.reportSent ? ' checked' : ''}></label>
            <label class="cell"><span class="cell-main"><span class="t">面談の実施日</span></span><input type="date" name="meetingDate" value="${esc(r.meetingDate || '')}"></label>
            <label class="cell"><span class="lab">フォーム添削（本）</span><input type="number" name="formVideos" min="0" max="${FORM_MAX}" inputmode="numeric" value="${r.formVideos || 0}"></label>
            <label class="cell"><span class="lab">食事記録の確認（日）</span><input type="number" name="mealDays" min="0" max="7" inputmode="numeric" value="${r.mealDays || 0}"></label>`)}
          ${group('メモ', `<div class="cell"><textarea name="memo" rows="3" placeholder="メモ" aria-label="メモ">${esc(r.memo || '')}</textarea></div>`)}
          <div class="btns"><button class="btn filled" type="submit">保存</button></div>
        </form>
      </main>
      ${tabbar('')}`;
    bindWeekForm(c, w);
  }

  function bindWeekForm(c, w) {
    const f = document.getElementById('weekForm');
    const r = rec(c.id, w) || {};
    let checksTouched = hasScore(r);
    const readWeights = () => [...f.querySelectorAll('#weights input')].map((i) => parseFloat(i.value)).filter((n) => isFinite(n) && n >= 20 && n <= 400);
    const update = () => {
      const ws = readWeights();
      document.getElementById('avg').textContent = ws.length ? kg(ws.reduce((a, b) => a + b, 0) / ws.length) + `（${ws.length}回）` : '—';
      const n = CHECK_ITEMS.filter((_, i) => f['ck' + i].checked).length;
      const sc = document.getElementById('score');
      if (!checksTouched) { sc.className = 't'; sc.textContent = '未入力'; return; }
      sc.className = 't lv' + scoreLv(n);
      sc.textContent = `${n}/7　${scoreLabel(n)}`;
    };
    f.addEventListener('input', (e) => { state.dirty = true; if (/^ck\d$/.test(e.target.name)) checksTouched = true; update(); });
    f.addEventListener('change', (e) => { if (/^ck\d$/.test(e.target.name)) { checksTouched = true; update(); } });
    update();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      const patch = {
        weights: readWeights(), checkinDone: f.checkinDone.checked, meetingDate: f.meetingDate.value || '',
        formVideos: Number(f.formVideos.value) || 0, mealDays: Number(f.mealDays.value) || 0, reportSent: f.reportSent.checked, memo: f.memo.value,
      };
      if (checksTouched) patch.checks = CHECK_ITEMS.map((_, i) => (f['ck' + i].checked ? '1' : '0')).join('');
      try {
        await patchWeek(c.id, w, patch);
        toast(`${w}週目を保存しました`);
        location.hash = '#/c/' + encodeURIComponent(c.id);
      } catch (_) { btn.disabled = false; btn.textContent = '保存'; }
    });
  }

  // ================================================================ 追加・編集

  function renderNew() {
    $app.innerHTML = `
      ${navbar({ title: 'お客様を追加', back: '#/', backLabel: 'キャンセル', solid: true })}
      <main class="page">
        ${largeTitle('お客様を追加')}
        <form id="newForm" novalidate>
          ${group('', `<label class="cell"><span class="lab">名前</span><input type="text" name="name" autocomplete="off" placeholder="田中 太郎"></label>
            <label class="cell"><span class="lab">LINE名</span><input type="text" name="lineName" autocomplete="off" placeholder="必須"></label>
            <label class="cell"><span class="cell-main"><span class="t">入金確認日</span><span class="s">まだなら空欄でOK</span></span><input type="date" name="paidDate"></label>`,
            '追加すると、お客様に送る事前ヒアリングのリンクと案内文ができます。開始日などは入金確認後に「編集」で入れます。')}
          <p class="err" id="editErr"></p>
          <div class="btns"><button class="btn filled" type="submit">追加</button></div>
        </form>
      </main>`;
    const f = document.getElementById('newForm');
    f.addEventListener('input', () => { state.dirty = true; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('editErr');
      const name = f.name.value.trim(), lineName = f.lineName.value.trim();
      if (!name || !lineName) { err.textContent = '名前とLINE名を入力してください。'; (name ? f.lineName : f.name).focus(); return; }
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        const d = await api('saveClient', { client: { name, lineName, paidDate: f.paidDate.value, status: ST.WAIT } });
        state.clients.push(d.client);
        saveCache();
        toast('追加しました。リンクをLINEで送ってください');
        location.hash = '#/c/' + encodeURIComponent(d.client.id);
      } catch (ex) { err.textContent = errText(ex); btn.disabled = false; btn.textContent = '追加'; }
    });
    setTimeout(() => f.name.focus(), 50);
  }

  function renderEdit(id) {
    const c = state.clients.find((x) => x.id === id);
    if (!c) { location.hash = '#/'; return; }
    const dowOpts = (sel) => '<option value="">未設定</option>' + DOW.map((d, i) => `<option value="${i}"${String(sel) === String(i) ? ' selected' : ''}>${d}曜</option>`).join('');
    $app.innerHTML = `
      ${navbar({ title: '編集', back: '#/c/' + encodeURIComponent(id), backLabel: 'キャンセル', solid: true })}
      <main class="page">
        ${largeTitle('編集', '', san(c.name))}
        <form id="editForm" novalidate>
          ${group('', `<label class="cell"><span class="lab">名前</span><input type="text" name="name" value="${esc(c.name)}" autocomplete="off"></label>
            <label class="cell"><span class="lab">LINE名</span><input type="text" name="lineName" value="${esc(c.lineName)}" autocomplete="off"></label>`)}
          ${group('日程', `<label class="cell"><span class="cell-main"><span class="t">入金確認日</span></span><input type="date" name="paidDate" value="${esc(c.paidDate)}"></label>
            <label class="cell"><span class="cell-main"><span class="t">開始日</span></span><input type="date" name="startDate" value="${esc(c.startDate)}"></label>
            <label class="cell"><span class="lab">チェックイン曜日</span><select name="checkinDow">${dowOpts(c.checkinDow)}</select></label>
            <label class="cell"><span class="lab">面談曜日</span><select name="meetingDow">${dowOpts(c.meetingDow)}</select></label>`, '<span id="endHint"></span>')}
          ${group('', `<label class="cell"><span class="lab">状態</span><select name="status">${STATUSES.map((s) => `<option${s === c.status ? ' selected' : ''}>${s}</option>`).join('')}</select></label>`)}
          ${group('目標', `<div class="cell"><textarea name="goal" rows="2" placeholder="目標" aria-label="目標">${esc(c.goal)}</textarea></div>`)}
          ${group('メモ', `<div class="cell"><textarea name="memo" rows="3" placeholder="メモ" aria-label="メモ">${esc(c.memo)}</textarea></div>`)}
          <p class="err" id="editErr"></p>
          <div class="btns"><button class="btn filled" type="submit">保存</button></div>
        </form>
      </main>`;
    const f = document.getElementById('editForm');
    const endHint = () => {
      const st = pd(f.startDate.value);
      document.getElementById('endHint').textContent = st ? `終了予定日：${mdw(addDays(st, WEEKS * 7 - 1))}（12週）` : '開始日を入れると、終了予定日と毎週の予定が自動で出ます。';
    };
    endHint();
    f.addEventListener('input', (e) => {
      state.dirty = true;
      if (e.target.name === 'startDate') endHint();
      if ((e.target.name === 'paidDate' || e.target.name === 'startDate') && f.status.value === ST.WAIT && f.paidDate.value && f.startDate.value) f.status.value = ST.ACTIVE;
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('editErr');
      const name = f.name.value.trim();
      if (!name) { err.textContent = '名前を入力してください。'; return; }
      if (f.status.value === ST.ACTIVE && !f.startDate.value) { err.textContent = '「進行中」にするには開始日が必要です。'; return; }
      const data = { id: c.id, name, lineName: f.lineName.value.trim(), paidDate: f.paidDate.value, startDate: f.startDate.value,
        checkinDow: f.checkinDow.value, meetingDow: f.meetingDow.value, goal: f.goal.value, status: f.status.value, memo: f.memo.value };
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        const d = await api('saveClient', { client: data });
        const i = state.clients.findIndex((x) => x.id === d.client.id);
        if (i >= 0) state.clients[i] = d.client;
        saveCache();
        toast('保存しました');
        location.hash = '#/c/' + encodeURIComponent(d.client.id);
      } catch (ex) { err.textContent = errText(ex); btn.disabled = false; btn.textContent = '保存'; }
    });
  }

  // ================================================================ 操作

  function keepScroll(fn) { const y = window.scrollY; fn(); window.scrollTo(0, y); }

  $app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT') return;
    const act = el.dataset.act;
    const cid = el.dataset.id || decodeURIComponent((location.hash.split('/')[2] || ''));
    const c = state.clients.find((x) => x.id === cid);

    if (act === 'sheet') { ui.sheet = el.dataset.id; return keepScroll(render); }
    if (act === 'close-sheet') { ui.sheet = null; return keepScroll(render); }
    if (act === 'filter') { e.preventDefault(); ui.filter = el.dataset.v; ui.sheet = null; if (location.hash !== '#/clients') location.hash = '#/clients'; else keepScroll(render); return; }
    if (act === 'refresh') return refresh({ force: true });
    if (act === 'backup') return downloadBackup();
    if (act === 'logout') { if (confirm('ログアウトしますか？')) logout(); return; }

    if (act.startsWith('tg-') && c) {
      const w = Number(el.dataset.w);
      const r = rec(c.id, w) || {};
      const t = fd(today());
      el.disabled = true;
      let undo = null, label = '';
      try {
        if (act === 'tg-checkin') { const v = !r.checkinDone; await patchWeek(c.id, w, { checkinDone: v }); undo = () => patchWeek(c.id, w, { checkinDone: !v }); label = v ? 'チェックインを済にしました' : 'チェックインを未にしました'; }
        if (act === 'tg-report') { const v = !r.reportSent; await patchWeek(c.id, w, { reportSent: v }); undo = () => patchWeek(c.id, w, { reportSent: !v }); label = v ? 'レポートを済にしました' : 'レポートを未にしました'; }
        if (act === 'tg-meeting') { const old = r.meetingDate || ''; await patchWeek(c.id, w, { meetingDate: old ? '' : t }); undo = () => patchWeek(c.id, w, { meetingDate: old }); label = old ? '面談を未にしました' : '面談を済にしました'; }
        if (act === 'tg-eval') { const k = el.dataset.key; const old = c[k] || ''; await patchClient(c.id, { [k]: old ? '' : t }); undo = () => patchClient(c.id, { [k]: old }); label = old ? '身体評価を未にしました' : '身体評価を済にしました'; }
        if (act === 'tg-final') { const old = c.finalDone || ''; await patchClient(c.id, { finalDone: old ? '' : t }); undo = () => patchClient(c.id, { finalDone: old }); label = old ? '最終評価を未にしました' : '最終評価を済にしました'; }
        if (act === 'tg-paid') { const old = c.paidDate || ''; await patchClient(c.id, { paidDate: old ? '' : t }); undo = () => patchClient(c.id, { paidDate: old }); label = old ? '入金を未確認に戻しました' : '入金を確認済みにしました'; }
      } catch (_) { /* toast 済 */ }
      keepScroll(render);
      if (undo) toast(label, async () => { try { await undo(); } catch (_) { /* toast 済 */ } keepScroll(render); });
      return;
    }
    if (act === 'step' && c) {
      const w = Number(el.dataset.w);
      const name = el.dataset.name;
      const r = rec(c.id, w) || {};
      const v = Math.max(0, Math.min(Number(el.dataset.max), (Number(r[name]) || 0) + Number(el.dataset.d)));
      if (v === (Number(r[name]) || 0)) return;
      const val = el.closest('.cell').querySelector('.val');
      if (val) val.textContent = v + (name === 'formVideos' ? '本' : '日');
      try { await patchWeek(c.id, w, { [name]: v }); } catch (_) { keepScroll(render); }
      return;
    }
    if (act === 'status' && c) {
      const v = el.dataset.v;
      if (!confirm(`状態を「${v}」にしますか？`)) return;
      try { await patchClient(c.id, { status: v }); toast(`「${v}」にしました`); } catch (_) { /* toast 済 */ }
      return keepScroll(render);
    }
    if (act === 'addweight') {
      const i = document.createElement('input');
      Object.assign(i, { type: 'number', step: '0.1', min: '20', max: '400' });
      i.setAttribute('inputmode', 'decimal'); i.setAttribute('aria-label', '体重');
      document.getElementById('weights').appendChild(i); i.focus();
      return;
    }
    if (act === 'issuekey' && c) {
      el.disabled = true;
      try {
        const d = await api('issueFormKey', { id: c.id });
        const i = state.clients.findIndex((x) => x.id === c.id);
        if (i >= 0) state.clients[i] = d.client;
        saveCache();
        toast('リンクを作りました');
      } catch (ex) { toast(errText(ex)); }
      return keepScroll(render);
    }
    if (act === 'delete') {
      const d = state.clients.find((x) => x.id === el.dataset.id);
      if (!d || !confirm(`${san(d.name)}のデータ（週の記録も含む）を削除します。元に戻せません。よろしいですか？`)) return;
      el.disabled = true;
      try {
        await api('deleteClient', { id: d.id });
        state.clients = state.clients.filter((x) => x.id !== d.id);
        delete state.weeks[d.id];
        saveCache();
        toast('削除しました');
        location.hash = '#/';
      } catch (ex) { toast(errText(ex)); el.disabled = false; }
    }
  });

  $app.addEventListener('change', async (e) => {
    const el = e.target;
    const cid = decodeURIComponent((location.hash.split('/')[2] || ''));
    if (el.dataset.act === 'evaldate') {
      try { await patchClient(cid, { [el.dataset.key]: el.value || '' }); toast(el.value ? '実施日を保存しました' : '実施日を消しました'); } catch (_) { /* toast 済 */ }
      keepScroll(render);
    }
  });

  $app.addEventListener('submit', async (e) => {
    if (e.target.id !== 'finalForm') return;
    e.preventDefault();
    const f = e.target;
    const cid = decodeURIComponent((location.hash.split('/')[2] || ''));
    try { await patchClient(cid, { finalPlan: f.finalPlan.value, finalDone: f.finalDone.value || '' }); toast('最終評価を保存しました'); keepScroll(render); }
    catch (_) { /* toast 済 */ }
  });

  window.addEventListener('hashchange', () => { ui.sheet = null; render(); window.scrollTo(0, 0); document.body.classList.remove('scrolled'); });
  // スクロールしたらナビゲーションバーに小さいタイトルを出す（iOS の大きなタイトルと同じ動き）
  window.addEventListener('scroll', () => { document.body.classList.toggle('scrolled', window.scrollY > 40); }, { passive: true });
  // シートは Esc でも閉じる
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.sheet) { ui.sheet = null; keepScroll(render); } });

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (getToken() && Date.now() - hiddenAt > 3 * 60 * 1000) refresh();
  });

  // ================================================================ 起動

  (function boot() {
    if (!getToken()) { lsSet(CACHE_KEY, null); return render(); }
    try { const cached = JSON.parse(lsGet(CACHE_KEY) || 'null'); if (cached) setData(cached); } catch (_) { /* なくてもよい */ }
    render();
    refresh();
  })();
})();
