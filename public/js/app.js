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
    if (b) { b.disabled = on; b.innerHTML = on ? '<span class="spin"></span>' : '更新'; }
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

  const ui = { home: 'todo', list: ST.ACTIVE, tab: {} }; // 画面の切り替え状態（clientId → 今週/記録/情報）

  const ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    todo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2c2.4.1 4.2 1.7 5 4.8"/></svg>',
    week: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M5 15l4-4 3 3 6-7"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/></svg>',
    line: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3.5c-5 0-9 3.2-9 7.2 0 3.6 3.2 6.6 7.5 7.1.3.1.7.2.8.5.1.2.1.6 0 .9l-.1.8c0 .2-.2.9.8.5s5.4-3.2 7.4-5.5c1.3-1.4 2-2.9 2-4.3 0-4-4-7.2-9-7.2z"/></svg>',
  };

  function render() {
    if (chart) { chart.destroy(); chart = null; }
    state.dirty = false;
    document.body.classList.remove('has-fab');
    if (!getToken()) return renderLogin();
    if (!state.ready) { $app.innerHTML = '<div class="loading"><span class="spin"></span>読み込み中…</div>'; return; }
    const [a, b, c, d] = location.hash.replace(/^#\/?/, '').split('/');
    if (a === 'c' && b) {
      const id = decodeURIComponent(b);
      if (c === 'w' && Number(d) >= 1 && Number(d) <= WEEKS) { state.selWeek[id] = Number(d); ui.tab[id] = 'record'; }
      return renderDetail(id);
    }
    if (a === 'new') return renderNew();
    if (a === 'edit' && b) return renderEdit(decodeURIComponent(b));
    return renderHome();
  }

  /** ページ上部（ロゴ・タイトル） */
  function head(title, sub, opts) {
    const o = opts || {};
    return `<header class="hd">
      <div class="hd-bar">
        ${o.back ? `<a class="hd-btn" href="${o.back}" aria-label="戻る">‹</a>` : '<span class="hd-btn ghost"></span>'}
        <span class="brand">HATAKEYAMA <b>COACHING</b></span>
        ${o.right || '<span class="hd-btn ghost"></span>'}
      </div>
      <h1 class="h-title">${esc(title)}</h1>
      ${sub ? `<p class="h-sub">${sub}</p>` : ''}
      ${o.bar != null ? `<div class="bar big"><i style="width:${o.bar.toFixed(1)}%"></i></div>` : ''}
    </header>`;
  }

  /** 大きな切り替えボタン（RafaCoach の 治療／食事 と同じ形） */
  function modeSwitch(items, cur, act) {
    return `<div class="mode m${items.length}">${items.map((it) =>
      `<button type="button" class="${it.key === cur ? 'on' : ''}" data-act="${act}" data-v="${it.key}">${it.icon || ''}<span>${esc(it.label)}</span>${it.count != null ? `<em>${it.count}</em>` : ''}</button>`).join('')}</div>`;
  }

  // ================================================================ ログイン

  function renderLogin(msg) {
    $app.innerHTML = `
      <section class="login">
        <form id="loginForm" autocomplete="on">
          <span class="brand">HATAKEYAMA <b>COACHING</b></span>
          <h1 class="h-title">顧客管理</h1>
          <p class="h-sub">関係者専用</p>
          <input type="text" name="username" value="hatakeyama-kanri" autocomplete="username" hidden>
          <input id="pw" type="password" name="password" autocomplete="current-password" placeholder="パスワード" aria-label="パスワード" required>
          <button class="btn primary block" type="submit">ログイン</button>
          ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
        </form>
      </section>`;
    const f = document.getElementById('loginForm');
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        const d = await api('login', { password: f.password.value });
        lsSet(TOKEN_KEY, JSON.stringify({ token: d.token, exp: d.exp }));
        state.ready = false;
        render();
        await refresh({ force: true });
      } catch (e) {
        renderLogin(errText(e));
      }
    });
    setTimeout(() => { const p = document.getElementById('pw'); if (p) p.focus(); }, 50);
  }

  // ================================================================ ホーム

  function renderHome() {
    const t = today();
    const tasks = buildTasks();
    const subs = recentSubmissions();
    state.tasks = {};
    const nTodo = tasks.overdue.length + tasks.today.length + tasks.week.length;
    const lists = {
      [ST.ACTIVE]: state.clients.filter((c) => c.status === ST.ACTIVE),
      [ST.WAIT]: state.clients.filter((c) => c.status === ST.WAIT),
      [ST.DONE]: state.clients.filter((c) => c.status === ST.DONE || c.status === ST.CONSULT),
    };
    const sub = [
      tasks.overdue.length ? `<span class="warn">遅れ ${tasks.overdue.length}</span>` : '',
      `今日 ${tasks.today.length}`, `今週 ${tasks.week.length}`,
    ].filter(Boolean).join('<span class="dot-sep">・</span>');

    let body;
    if (ui.home === 'todo') {
      const block = (label, arr, cls, limit) => {
        if (!arr.length) return '';
        const shown = limit ? arr.slice(0, limit) : arr;
        const rest = limit ? arr.slice(limit) : [];
        return `<div class="sec ${cls}"><h2>${label}</h2><span>${arr.length}</span></div>
          <div class="list">${shown.map((x) => taskCard(x, cls)).join('')}</div>
          ${rest.length ? `<details class="more"><summary>残り${rest.length}件を表示</summary><div class="list">${rest.map((x) => taskCard(x, cls)).join('')}</div></details>` : ''}`;
      };
      body = `
        ${subs.length ? `<div class="sec new"><h2>お客様から届いた</h2><span>${subs.length}</span></div>
          <div class="list">${subs.map(subCard).join('')}</div>` : ''}
        ${block('遅れ・抜け', tasks.overdue, 'overdue', OVERDUE_SHOWN)}
        ${block('今日', tasks.today, 'today')}
        ${block('今週', tasks.week, 'week')}
        ${nTodo || subs.length ? '' : `<div class="empty"><div class="empty-ic">${ICON.check}</div>やることはありません</div>`}`;
    } else {
      const tabs = [[ST.ACTIVE, '進行中'], [ST.WAIT, '入金待ち'], [ST.DONE, '終了']];
      const arr = lists[ui.list].slice().sort((a, b) => (a.startDate || '9').localeCompare(b.startDate || '9'));
      body = `
        <div class="tabs"><div class="tabs-inner t3">${tabs.map(([k, l]) =>
          `<button type="button" class="tab${ui.list === k ? ' on' : ''}" data-act="list" data-v="${k}"><span class="t-l">${lists[k].length}</span><span class="t-s">${l}</span></button>`).join('')}</div></div>
        ${arr.length ? `<div class="list">${arr.map(clientCard).join('')}</div>`
          : `<div class="empty">${ui.list === ST.ACTIVE ? '進行中のお客様はいません' : 'いません'}</div>`}`;
    }

    $app.innerHTML = `
      ${head(`${t.getMonth() + 1}月${t.getDate()}日（${DOW[t.getDay()]}）`, sub)}
      ${modeSwitch([
        { key: 'todo', label: 'やること', icon: ICON.todo, count: nTodo },
        { key: 'clients', label: 'お客様', icon: ICON.people, count: state.clients.length },
      ], ui.home, 'home')}
      ${body}
      <footer class="foot">
        <span>${state.syncedAt ? `${state.syncedAt.getHours()}:${String(state.syncedAt.getMinutes()).padStart(2, '0')} 更新` : '保存データを表示中'}</span>
        <button type="button" data-act="refresh">更新</button>
        <button type="button" data-act="backup">バックアップ</button>
        <button type="button" data-act="logout">ログアウト</button>
      </footer>
      <a class="fab" href="#/new">＋ お客様を追加</a>`;
    document.body.classList.add('has-fab');
  }

  function taskCard(task, cls) {
    state.tasks[task.id] = task;
    const go = task.kind === 'go';
    return `<div class="tk ${cls}${go ? ' go' : ''}" data-tid="${esc(task.id)}">
      <button type="button" class="tk-do" data-act="${go ? 'go' : 'done'}" data-tid="${esc(task.id)}">
        <span class="num">${go ? '›' : ''}<i>${ICON.check}</i></span>
        <span class="tk-b"><span class="tk-who">${esc(san(task.c.name))}</span><span class="tk-what">${esc(task.text)}</span></span>
      </button>
      <a class="tk-go" href="#/c/${encodeURIComponent(task.c.id)}" aria-label="${esc(san(task.c.name))}を開く">›</a>
    </div>`;
  }

  function subCard(x) {
    return `<a class="tk new" href="${x.href}">
      <span class="tk-do"><span class="num">${ICON.line}</span>
      <span class="tk-b"><span class="tk-who">${esc(san(x.c.name))}</span><span class="tk-what">${esc(x.text)}<small>　${esc(dt(x.at))}</small></span></span></span>
      <span class="tk-go">›</span></a>`;
  }

  function clientCard(c) {
    const st = stats(c);
    const s = st.s;
    const miss = st.missMeet + st.missRep + st.missChk + st.missEval;
    const intake = c.intake && c.intake.submittedAt;
    let wk, pct = 0;
    if (c.status === ST.WAIT) wk = c.paidDate ? '入金済' : '入金待ち';
    else if (!s) wk = '開始日未定';
    else if (s.cur === 0) wk = `${md(s.start)}開始`;
    else if (s.cur > WEEKS) { wk = '終了'; pct = 100; }
    else { wk = `<b>${s.cur}</b>/12週`; pct = s.cur / WEEKS * 100; }
    let pill;
    if (miss) pill = `<span class="pill warn">遅れ ${miss}件</span>`;
    else if (!intake && c.status !== ST.DONE) pill = '<span class="pill warn">ヒアリング未回答</span>';
    else if (c.status === ST.ACTIVE && s && s.cur >= 1) pill = '<span class="pill ok">順調</span>';
    else pill = '';
    const nc = c.status === ST.ACTIVE ? nextCheckin(c, s) : null;
    return `<a class="cl${miss ? ' alert' : ''}" href="#/c/${encodeURIComponent(c.id)}">
      <div class="cl-top"><span class="cl-name">${esc(san(c.name))}</span><span class="cl-wk">${wk}</span></div>
      ${c.status === ST.ACTIVE ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
      <div class="cl-meta">${pill}${nc ? `<span>次のチェックイン ${mdw(nc)}</span>` : ''}${st.latestW ? `<span>${kg(st.latestW.v)}</span>` : ''}</div>
    </a>`;
  }

  /** お客様がリンクから送った内容（直近3日・新しい順） */
  function recentSubmissions() {
    const since = Date.now() - RECENT_MS;
    const out = [];
    for (const c of state.clients) {
      if (c.intake && c.intake.submittedAt && Date.parse(c.intake.submittedAt) > since) {
        out.push({ c, at: c.intake.submittedAt, href: `#/c/${encodeURIComponent(c.id)}`, text: '事前ヒアリングに回答しました' });
      }
      for (const r of Object.values(state.weeks[c.id] || {})) {
        if (r.submittedAt && Date.parse(r.submittedAt) > since) {
          out.push({ c, at: r.submittedAt, href: `#/c/${encodeURIComponent(c.id)}/w/${r.week}`,
            text: `${r.week}週目のチェックイン${r.condition ? `（体調：${r.condition}）` : ''}` });
        }
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }
  function dt(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  async function onTaskDone(task, row) {
    const t = today();
    const ts = fd(t);
    const c = task.c;
    row.classList.add('done');
    row.querySelector('.tk-do').disabled = true;
    let undo;
    try {
      if (task.kind === 'checkin') {
        await patchWeek(c.id, task.w, { checkinDone: true });
        undo = () => patchWeek(c.id, task.w, { checkinDone: false });
      } else if (task.kind === 'report') {
        await patchWeek(c.id, task.w, { reportSent: true });
        undo = () => patchWeek(c.id, task.w, { reportSent: false });
      } else if (task.kind === 'meeting') {
        const s = sched(c);
        const end = weekEnd(s, task.w);
        const d = end < t ? (dowInWeek(s, task.w, c.meetingDow) || end) : t;
        await patchWeek(c.id, task.w, { meetingDate: fd(d) });
        undo = () => patchWeek(c.id, task.w, { meetingDate: '' });
      } else if (task.kind === 'eval') {
        await patchClient(c.id, { [task.key]: ts });
        undo = () => patchClient(c.id, { [task.key]: '' });
      } else if (task.kind === 'final') {
        await patchClient(c.id, { finalDone: ts });
        undo = () => patchClient(c.id, { finalDone: '' });
      }
    } catch (_) {
      row.classList.remove('done');
      row.querySelector('.tk-do').disabled = false;
      return;
    }
    setTimeout(() => { if (!state.dirty) keepScroll(render); }, 450);
    toast(`${san(c.name)}｜${task.text.replace(/（.*$/, '')} を済にしました`, async () => {
      try { await undo(); } catch (_) { /* toast は patch 側で出す */ }
      keepScroll(render);
    });
  }

  function keepScroll(fn) { const y = window.scrollY; fn(); window.scrollTo(0, y); }

  // ================================================================ お客様の画面

  function renderDetail(id) {
    const c = state.clients.find((x) => x.id === id);
    if (!c) {
      $app.innerHTML = head('見つかりません', '', { back: '#/' }) + '<div class="empty">画面を更新してください。</div>';
      return;
    }
    const s = sched(c);
    if (!state.selWeek[id]) state.selWeek[id] = s ? Math.min(Math.max(s.cur, 1), WEEKS) : 1;
    const tab = ui.tab[id] || 'week';
    let sub;
    if (c.status === ST.WAIT) sub = c.paidDate ? `入金済（${mdwS(c.paidDate)}）・開始日未定` : '入金待ち';
    else if (!s) sub = '開始日未定';
    else if (s.cur === 0) sub = `${mdw(s.start)} 開始`;
    else if (s.cur > WEEKS) sub = `12週終了（${md(s.start)}〜${md(s.end)}）`;
    else sub = `<b>${s.cur}週目</b> / 12週　${md(s.start)}〜${md(s.end)}`;

    let body;
    if (tab === 'week') body = weekTab(c, s);
    else if (tab === 'record') body = recordTab(c, s);
    else body = infoTab(c, s);

    $app.innerHTML = `
      ${head(san(c.name), sub, { back: '#/', bar: s && s.cur >= 1 ? Math.min(s.cur, WEEKS) / WEEKS * 100 : null,
        right: `<a class="hd-btn text" href="#/edit/${encodeURIComponent(id)}">編集</a>` })}
      ${modeSwitch([
        { key: 'week', label: '今週', icon: ICON.week },
        { key: 'record', label: '記録', icon: ICON.chart },
        { key: 'info', label: '情報', icon: ICON.info },
      ], tab, 'dtab')}
      ${body}`;
    if (tab === 'record') { bindWeekForm(c, s, state.selWeek[id]); drawChart(c); }
  }

  // ---------- 今週 ----------
  function weekTab(c, s) {
    const send = sendCard(c);
    if (!s || s.cur === 0 || c.status !== ST.ACTIVE) {
      const note = c.status === ST.WAIT
        ? (c.paidDate ? '入金確認済みです。「編集」で開始日とチェックイン曜日を入れると、毎週の予定が自動で出ます。'
          : '入金を確認したら「編集」で入金確認日と開始日を入れてください。')
        : !s ? '「編集」で開始日を入れると、毎週の予定が自動で出ます。'
          : s.cur === 0 ? `プログラムは ${mdw(s.start)} から始まります。` : 'このお客様は進行中ではありません。';
      return `${send}<div class="note">${note}</div>`;
    }
    const w = Math.min(s.cur, WEEKS);
    const r = rec(c.id, w) || {};
    const t = today();
    const ci = dowInWeek(s, w, c.checkinDow);
    const mt = dowInWeek(s, w, c.meetingDow);
    const items = [
      { act: 'tg-checkin', done: !!r.checkinDone, title: 'チェックインを受け取る',
        sub: r.submittedAt ? `お客様から届きました（${dt(r.submittedAt)}）` : ci ? `予定 ${mdw(ci)}` : 'チェックイン曜日が未設定です',
        late: !r.checkinDone && ci && ci < t },
      { act: 'tg-meeting', done: !!r.meetingDate, title: '個別面談（60分）',
        sub: r.meetingDate ? `実施 ${mdwS(r.meetingDate)}` : mt ? `予定 ${mdw(mt)}` : '今週中に実施',
        late: !r.meetingDate && mt && mt < t },
      { act: 'tg-report', done: !!r.reportSent, title: '週間レポートを送る', sub: '振り返りと改善提案', late: false },
    ];
    for (const ev of EVALS) {
      if (ev.week !== w) continue;
      const due = evalDue(c, s, ev);
      items.push({ act: 'tg-eval', key: ev.key, done: !!c[ev.key], title: `${ev.label === '開始時' ? '開始時' : ev.week + '週目'}の身体評価`,
        sub: c[ev.key] ? `実施 ${mdwS(c[ev.key])}` : `予定 ${mdw(due)}`, late: !c[ev.key] && due < t });
    }
    if (s.cur >= 11) {
      items.push({ act: 'tg-final', done: !!c.finalDone, title: '最終評価（12週の変化と今後の計画）',
        sub: c.finalDone ? `実施 ${mdwS(c.finalDone)}` : `〜${mdw(s.end)}　内容は「情報」に記入`, late: !c.finalDone && s.end < t });
    }
    const doneN = items.filter((x) => x.done).length;
    const past = buildTasks().overdue.filter((x) => x.c.id === c.id && x.w !== w && x.kind !== 'go');
    state.tasks = {};

    return `
      <div class="meta"><div class="focus">${w}週目のやること<span>${md(weekStart(s, w))}〜${md(weekEnd(s, w))}</span></div>
        <div class="prog"><div class="pc">${doneN}/${items.length}</div><div class="pl">完了</div>
        <div class="bar"><i style="width:${(doneN / items.length * 100).toFixed(1)}%"></i></div></div></div>
      ${submissionCard(r)}
      <div class="list">${items.map((it, i) => `
        <div class="ex${it.done ? ' done' : ''}${it.late ? ' late' : ''}">
          <button type="button" class="ex-do" data-act="${it.act}" data-w="${w}"${it.key ? ` data-key="${it.key}"` : ''}>
            <span class="num"><span>${i + 1}</span><i>${ICON.check}</i></span>
            <span class="ex-b"><span class="ex-t">${esc(it.title)}</span><span class="ex-s">${esc(it.sub)}${it.late ? '　遅れ' : ''}</span></span>
          </button>
        </div>`).join('')}
      </div>
      <div class="steps">
        ${stepCard('フォーム添削', 'formVideos', r.formVideos || 0, FORM_MAX, '本', `上限${FORM_MAX}本`, w)}
        ${stepCard('食事記録の確認', 'mealDays', r.mealDays || 0, 7, '日', `目安${MEAL_TARGET}日`, w)}
      </div>
      ${past.length ? `<div class="sec overdue"><h2>前の週の抜け</h2><span>${past.length}</span></div>
        <div class="list">${past.map((x) => taskCard(x, 'overdue')).join('')}</div>` : ''}
      ${send}`;
  }

  function stepCard(label, name, v, max, unit, hint, w) {
    return `<div class="step"><div class="step-l">${label}<small>${hint}</small></div>
      <div class="stepper"><button type="button" data-act="step" data-name="${name}" data-d="-1" data-max="${max}" data-w="${w}" aria-label="減らす">−</button>
      <output>${v}<small>${unit}</small></output>
      <button type="button" data-act="step" data-name="${name}" data-d="1" data-max="${max}" data-w="${w}" aria-label="増やす">＋</button></div></div>`;
  }

  function submissionCard(r) {
    if (!r || !r.submittedAt) return '';
    const n = scoreOf(r);
    return `<div class="card sub">
      <div class="card-h">${ICON.line}<span>お客様から届いたチェックイン</span><small>${esc(dt(r.submittedAt))}</small></div>
      <div class="sub-grid">
        <div><small>週平均体重</small><b>${kg(avgW(r))}</b></div>
        <div><small>チェックシート</small><b>${n == null ? '—' : n + '/7'}</b></div>
        <div><small>体調</small><b>${esc(r.condition || '—')}</b></div>
      </div>
      ${r.clientWin ? `<p><small>うまくいったこと</small>${esc(r.clientWin)}</p>` : ''}
      ${r.clientNote ? `<p><small>困っていること・質問</small>${esc(r.clientNote)}</p>` : ''}
    </div>`;
  }

  // ---------- お客様に送るリンク ----------
  function formUrl(c) { return `${location.origin}/form.html#${c.formKey}`; }
  function lineMessage(c) {
    const url = formUrl(c);
    if (!(c.intake && c.intake.submittedAt)) {
      const head0 = c.paidDate ? 'ご入金を確認しました。ありがとうございます。' : 'このたびはお申し込みありがとうございます。';
      return `${san(c.name)}\n${head0}畠山です。\n\n開始前に、こちらの事前ヒアリングにご回答をお願いします（5分ほど）。\n${url}\n\nこのリンクは、開始後の毎週のチェックインにも使います。ブックマークしておいてください。`;
    }
    return `${san(c.name)}\n今週のチェックインをお願いします。\n${url}`;
  }
  function sendCard(c) {
    if (!c.formKey) {
      return `<div class="card"><div class="card-h"><span>お客様に送るリンク</span></div>
        <button class="btn primary block" type="button" data-act="issuekey">リンクを作る</button></div>`;
    }
    const intake = c.intake && c.intake.submittedAt;
    return `<div class="card send">
      <div class="card-h"><span>${intake ? 'チェックインのお願いを送る' : '事前ヒアリングを送る'}</span>
        <small class="${intake ? 'ok' : 'warn'}">${intake ? 'ヒアリング回答済み' : 'ヒアリング未回答'}</small></div>
      <div class="send-row">
        <a class="btn line" href="https://line.me/R/share?text=${encodeURIComponent(lineMessage(c))}" target="_blank" rel="noopener noreferrer">${ICON.line}LINEで送る</a>
        <button class="btn" type="button" data-act="copymsg">コピー</button>
      </div>
      <details class="msg"><summary>送る文章を見る</summary><textarea class="msgbox" readonly rows="8">${esc(lineMessage(c))}</textarea>
        <button class="btn tiny ghost" type="button" data-act="issuekey" data-reissue="1">リンクを作り直す</button></details>
    </div>`;
  }

  // ---------- 記録 ----------
  function recordTab(c, s) {
    const w = state.selWeek[c.id];
    const r = rec(c.id, w) || {};
    let tabs = '';
    for (let i = 1; i <= WEEKS; i++) {
      const has = rec(c.id, i);
      tabs += `<button type="button" class="tab${i === w ? ' on' : ''}${s && s.cur === i ? ' cur' : ''}" data-act="selweek" data-w="${i}"><span class="t-l">${i}</span><span class="t-s">${has && (has.checkinDone || has.weights.length) ? '●' : '週'}</span></button>`;
    }
    const weights = (r.weights || []).slice();
    while (weights.length < 3) weights.push('');
    const checks = (r.checks || '').padEnd(7, '0');
    return `
      <div class="card chart-card"><div class="card-h"><span>推移</span><small>週平均体重・スコア</small></div>
        <div class="chart-box"><canvas id="chart" aria-label="週平均体重とスコアの推移"></canvas></div><div id="chartMsg" class="muted small"></div></div>
      <div class="tabs"><div class="tabs-inner t6">${tabs}</div></div>
      ${submissionCard(r)}
      <form id="weekForm" class="card form" novalidate>
        <div class="card-h"><span>${w}週目の記録</span><small>${s ? `${md(weekStart(s, w))}〜${md(weekEnd(s, w))}` : ''}</small></div>
        <div class="field"><span class="lbl">体重（kg）</span>
          <div class="weights" id="weights">${weights.map((v) => `<input type="number" inputmode="decimal" step="0.1" min="20" max="400" value="${esc(v)}" aria-label="体重">`).join('')}</div>
          <div class="row-sb"><span class="avg">週平均 <b id="avg">—</b></span><button class="btn tiny" type="button" data-act="addweight">＋ 入力欄</button></div></div>
        <div class="field"><span class="lbl">チェックシート</span>
          <div class="checklist">${CHECK_ITEMS.map((txt, i) => `<label class="check"><input type="checkbox" name="ck${i}"${checks[i] === '1' ? ' checked' : ''}><span>${esc(txt)}</span></label>`).join('')}</div>
          <div class="score" id="score"></div></div>
        <div class="grid2">
          <label class="toggle"><input type="checkbox" name="checkinDone"${r.checkinDone ? ' checked' : ''}><span>チェックイン受取</span></label>
          <label class="toggle"><input type="checkbox" name="reportSent"${r.reportSent ? ' checked' : ''}><span>レポート送付</span></label>
        </div>
        <div class="grid2">
          <div class="field"><label for="meetingDate">面談実施日</label><input type="date" id="meetingDate" name="meetingDate" value="${esc(r.meetingDate || '')}"></div>
          <div class="field"><label for="formVideos">添削（本）</label><input type="number" id="formVideos" name="formVideos" min="0" max="${FORM_MAX}" value="${r.formVideos || 0}"></div>
        </div>
        <div class="field"><label for="mealDays">食事記録の確認（日）</label><input type="number" id="mealDays" name="mealDays" min="0" max="7" value="${r.mealDays || 0}"></div>
        <div class="field"><label for="wmemo">メモ</label><textarea id="wmemo" name="memo" rows="3">${esc(r.memo || '')}</textarea></div>
        <button class="btn primary block" type="submit">${w}週目を保存</button>
      </form>`;
  }

  function bindWeekForm(c, s, w) {
    const f = document.getElementById('weekForm');
    if (!f) return;
    const r = rec(c.id, w) || {};
    let checksTouched = hasScore(r);
    const readWeights = () => [...f.querySelectorAll('#weights input')]
      .map((i) => parseFloat(i.value)).filter((n) => isFinite(n) && n >= 20 && n <= 400);
    const update = () => {
      const ws = readWeights();
      document.getElementById('avg').textContent = ws.length ? kg(ws.reduce((a, b) => a + b, 0) / ws.length) + `（${ws.length}回）` : '—';
      const n = CHECK_ITEMS.filter((_, i) => f['ck' + i].checked).length;
      const sc = document.getElementById('score');
      if (!checksTouched) { sc.className = 'score'; sc.innerHTML = '<span class="muted">未入力</span>'; return; }
      sc.className = 'score lv' + scoreLv(n);
      sc.innerHTML = `<span>スコア <b>${n}/7</b></span><b>${scoreLabel(n)}</b>`;
    };
    f.addEventListener('input', (e) => {
      state.dirty = true;
      if (/^ck\d$/.test(e.target.name)) checksTouched = true;
      update();
    });
    update();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = f.querySelector('[type="submit"]');
      const label = btn.textContent;
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      const patch = {
        weights: readWeights(),
        checkinDone: f.checkinDone.checked,
        meetingDate: f.meetingDate.value || '',
        formVideos: Number(f.formVideos.value) || 0,
        mealDays: Number(f.mealDays.value) || 0,
        reportSent: f.reportSent.checked,
        memo: f.memo.value,
      };
      if (checksTouched) patch.checks = CHECK_ITEMS.map((_, i) => (f['ck' + i].checked ? '1' : '0')).join('');
      try {
        await patchWeek(c.id, w, patch);
        toast(`${w}週目を保存しました`);
        keepScroll(render);
      } catch (_) {
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  // ---------- 情報 ----------
  function infoTab(c, s) {
    const st = stats(c);
    const t = today();
    const tile = (label, v, total, miss) => `<div class="tile${miss ? ' warn' : v >= total ? ' full' : ''}"><b>${v}<small>/${total}</small></b><span>${label}</span></div>`;
    const dowName = (d) => (d === '' || d == null ? '未設定' : DOW[d] + '曜');
    const evalRows = EVALS.map((ev) => {
      const due = s ? evalDue(c, s, ev) : null;
      const miss = !c[ev.key] && due && due < t;
      return `<div class="eval${miss ? ' miss' : ''}"><span>${ev.label}<small>予定 ${mdw(due)}</small></span>
        <input type="date" value="${esc(c[ev.key] || '')}" data-act="evaldate" data-key="${ev.key}" aria-label="${ev.label}の実施日"></div>`;
    }).join('');
    return `
      <div class="tiles">
        ${tile('面談', st.meet, WEEKS, st.missMeet)}${tile('評価', st.evals, 4, st.missEval)}
        ${tile('レポート', st.rep, WEEKS, st.missRep)}${tile('チェックイン', st.chk, WEEKS, st.missChk)}
      </div>
      <div class="card"><div class="card-h"><span>目標・身体評価</span><small>実施日を入れる</small></div>${evalRows}</div>
      ${s && (s.cur >= 11 || c.finalDone || c.finalPlan) ? finalCard(c, s) : ''}
      <div class="card"><div class="card-h"><span>基本情報</span><a class="btn tiny" href="#/edit/${encodeURIComponent(c.id)}">編集</a></div>
        <dl class="kv">
          <dt>LINE名</dt><dd>${esc(c.lineName || '—')}</dd>
          <dt>目標</dt><dd>${esc(c.goal || '—')}</dd>
          <dt>入金確認日</dt><dd>${c.paidDate ? mdwS(c.paidDate) : '未確認'}</dd>
          <dt>期間</dt><dd>${s ? `${mdw(s.start)}〜${mdw(s.end)}` : '開始日未定'}</dd>
          <dt>チェックイン</dt><dd>${dowName(c.checkinDow)}</dd>
          <dt>面談</dt><dd>${dowName(c.meetingDow)}</dd>
          <dt>メモ</dt><dd>${esc(c.memo || '—')}</dd>
        </dl></div>
      ${intakeCard(c)}
      <p class="small muted center">LINEの返信：原則2営業日以内（日曜・祝日は返信なし）</p>`;
  }

  function finalCard(c, s) {
    const recs = [];
    for (let w = 1; w <= WEEKS; w++) recs.push(rec(c.id, w));
    const withW = recs.map((r, i) => ({ w: i + 1, v: avgW(r) })).filter((x) => x.v != null);
    const withS = recs.map((r) => scoreOf(r)).filter((x) => x != null);
    const first = withW[0];
    const lastW = withW[withW.length - 1];
    const diff = first && lastW && lastW.w !== first.w ? lastW.v - first.v : null;
    const avgS = withS.length ? withS.reduce((a, b) => a + b, 0) / withS.length : null;
    return `<form id="finalForm" class="card form">
      <div class="card-h"><span>最終評価</span><small>〜${mdw(s.end)}</small></div>
      <div class="tiles t3">
        <div class="tile"><b>${first ? kg(first.v) : '—'}</b><span>${first ? first.w + '週目' : '最初'}</span></div>
        <div class="tile"><b>${diff == null ? '—' : (diff > 0 ? '+' : '') + diff.toFixed(1) + 'kg'}</b><span>変化</span></div>
        <div class="tile"><b>${avgS == null ? '—' : avgS.toFixed(1)}</b><span>平均スコア</span></div>
      </div>
      <div class="field"><label for="finalPlan">今後の計画（継続の相談も）</label><textarea id="finalPlan" name="finalPlan" rows="4">${esc(c.finalPlan || '')}</textarea></div>
      <div class="field"><label for="finalDone">実施日</label><input type="date" id="finalDone" name="finalDone" value="${esc(c.finalDone || '')}"></div>
      <button class="btn primary block" type="submit">保存</button>
    </form>`;
  }

  function intakeCard(c) {
    if (!(c.intake && c.intake.submittedAt)) return '';
    const a = c.intake.answers || {};
    const qs = INTAKE.sections.flatMap((sec) => sec.questions);
    const val = (q) => (q.type === 'radio' ? a[q.id + '__label'] || a[q.id] : a[q.id] ? a[q.id] + (q.unit ? ' ' + q.unit : '') : '') || '—';
    // いまの質問にない回答（質問を差し替える前の回答）も消さずに出す
    const known = new Set(qs.map((q) => q.id));
    const extra = Object.keys(a).filter((k) => !known.has(k) && !k.endsWith('__label'));
    return `<details class="card qa"><summary class="card-h"><span>事前ヒアリングの回答</span><small>${esc(dt(c.intake.submittedAt))}</small></summary>
      <dl class="kv stack">${qs.map((q) => `<dt>${esc(q.label)}</dt><dd>${esc(val(q))}</dd>`).join('')}
      ${extra.map((k) => `<dt>${esc(k)}</dt><dd>${esc(a[k + '__label'] || a[k])}</dd>`).join('')}</dl></details>`;
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
    const labels = [], wt = [], sc = [];
    for (let w = 1; w <= WEEKS; w++) {
      const r = rec(c.id, w);
      labels.push(w + '週');
      wt.push(avgW(r) == null ? null : Math.round(avgW(r) * 10) / 10);
      sc.push(scoreOf(r));
    }
    const msg = document.getElementById('chartMsg');
    if (!wt.some((v) => v != null) && !sc.some((v) => v != null)) {
      if (msg) msg.textContent = '記録が入るとグラフが出ます。';
      const box = document.querySelector('.chart-box'); if (box) box.style.display = 'none';
      return;
    }
    let Chart;
    try { Chart = await loadChartJs(); } catch (_) { if (msg) msg.textContent = 'グラフを読み込めませんでした。'; return; }
    const cv = document.getElementById('chart');
    if (!cv || !cv.isConnected) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    if (chart) chart.destroy();
    chart = new Chart(cv, {
      data: {
        labels,
        datasets: [
          { type: 'line', label: '週平均体重（kg）', data: wt, yAxisID: 'y', borderColor: v('--accent-bright'), backgroundColor: v('--accent-bright'),
            spanGaps: true, tension: 0.3, pointRadius: 3, borderWidth: 2.5, order: 1 },
          { type: 'bar', label: 'スコア（/7）', data: sc, yAxisID: 'y1', backgroundColor: 'rgba(255,255,255,.12)', borderRadius: 5, maxBarThickness: 16, order: 2 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: v('--muted'), boxWidth: 10, font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: v('--muted'), font: { size: 10 } }, grid: { display: false } },
          y: { position: 'left', ticks: { color: v('--muted'), font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.06)' } },
          y1: { position: 'right', min: 0, max: 7, ticks: { stepSize: 1, color: v('--muted'), font: { size: 10 } }, grid: { display: false } },
        },
      },
    });
  }

  // ================================================================ 追加・編集

  /** 新規登録：名前・LINE名・入金確認日だけ。保存するとすぐ送るリンクが出る */
  function renderNew() {
    $app.innerHTML = `
      ${head('お客様を追加', '3つ入れるだけ。追加すると送るリンクができます', { back: '#/' })}
      <form id="newForm" class="card form" novalidate>
        <div class="field"><label for="n-name">名前</label><input type="text" id="n-name" name="name" autocomplete="off" placeholder="例：田中 太郎"></div>
        <div class="field"><label for="n-line">LINE名</label><input type="text" id="n-line" name="lineName" autocomplete="off"></div>
        <div class="field"><label for="n-paid">入金確認日<small>まだなら空欄でOK</small></label><input type="date" id="n-paid" name="paidDate"></div>
        <div id="editErr"></div>
        <button class="btn primary block" type="submit">追加してリンクを作る</button>
      </form>`;
    const f = document.getElementById('newForm');
    f.addEventListener('input', () => { state.dirty = true; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('editErr');
      const name = f.name.value.trim(), lineName = f.lineName.value.trim();
      if (!name || !lineName) {
        err.innerHTML = '<div class="err">名前とLINE名を入力してください。</div>';
        (name ? f.lineName : f.name).focus();
        return;
      }
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        const d = await api('saveClient', { client: { name, lineName, paidDate: f.paidDate.value, status: ST.WAIT } });
        state.clients.push(d.client);
        saveCache();
        state.dirty = false;
        ui.tab[d.client.id] = 'week';
        toast('追加しました。リンクを送ってください');
        location.hash = '#/c/' + encodeURIComponent(d.client.id);
      } catch (ex) {
        err.innerHTML = `<div class="err">${esc(errText(ex))}</div>`;
        btn.disabled = false; btn.textContent = '追加してリンクを作る';
      }
    });
    setTimeout(() => f.name.focus(), 50);
  }

  function renderEdit(id) {
    const c = state.clients.find((x) => x.id === id);
    if (!c) { location.hash = '#/'; return; }
    const dowOpts = (sel) => '<option value="">未設定</option>' +
      DOW.map((d, i) => `<option value="${i}"${String(sel) === String(i) ? ' selected' : ''}>${d}曜</option>`).join('');
    $app.innerHTML = `
      ${head(san(c.name), '編集', { back: '#/c/' + encodeURIComponent(id) })}
      <form id="editForm" class="card form" novalidate>
        <div class="field"><label for="f-name">名前</label><input type="text" id="f-name" name="name" value="${esc(c.name)}" autocomplete="off"></div>
        <div class="field"><label for="f-line">LINE名</label><input type="text" id="f-line" name="lineName" value="${esc(c.lineName)}" autocomplete="off"></div>
        <div class="grid2">
          <div class="field"><label for="f-paid">入金確認日</label><input type="date" id="f-paid" name="paidDate" value="${esc(c.paidDate)}"></div>
          <div class="field"><label for="f-start">開始日</label><input type="date" id="f-start" name="startDate" value="${esc(c.startDate)}"></div>
        </div>
        <div class="hint" id="endHint"></div>
        <div class="grid2">
          <div class="field"><label for="f-ci">チェックイン曜日</label><select id="f-ci" name="checkinDow">${dowOpts(c.checkinDow)}</select></div>
          <div class="field"><label for="f-mt">面談曜日</label><select id="f-mt" name="meetingDow">${dowOpts(c.meetingDow)}</select></div>
        </div>
        <div class="field"><label for="f-st">状態</label>
          <select id="f-st" name="status">${STATUSES.map((s) => `<option${s === c.status ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
        <div class="field"><label for="f-goal">目標</label><textarea id="f-goal" name="goal" rows="2">${esc(c.goal)}</textarea></div>
        <div class="field"><label for="f-memo">メモ</label><textarea id="f-memo" name="memo" rows="3">${esc(c.memo)}</textarea></div>
        <div id="editErr"></div>
        <button class="btn primary block" type="submit">保存</button>
      </form>
      <div class="note">プラン：3ヶ月（12週）／完全オンライン／30万円（税込33万円）。銀行振込、入金確認後に開始。初回カウンセリング60分。3ヶ月以降の継続は個別相談。</div>
      <button class="btn danger-quiet block" type="button" data-act="delete" data-id="${esc(c.id)}">このお客様を削除</button>`;

    const f = document.getElementById('editForm');
    const endHint = () => {
      const st = pd(f.startDate.value);
      document.getElementById('endHint').textContent = st
        ? `終了予定日：${mdw(addDays(st, WEEKS * 7 - 1))}（12週）` : '開始日を入れると終了予定日と毎週の予定が自動で出ます。';
    };
    endHint();
    f.addEventListener('input', (e) => {
      state.dirty = true;
      if (e.target.name === 'startDate') endHint();
      // 入金確認日と開始日が入ったら「進行中」に寄せる
      if ((e.target.name === 'paidDate' || e.target.name === 'startDate') && f.status.value === ST.WAIT && f.paidDate.value && f.startDate.value) {
        f.status.value = ST.ACTIVE;
      }
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('editErr');
      const name = f.name.value.trim();
      if (!name) { err.innerHTML = '<div class="err">名前を入力してください。</div>'; f.name.focus(); return; }
      if (f.status.value === ST.ACTIVE && !f.startDate.value) { err.innerHTML = '<div class="err">「進行中」にするには開始日が必要です。</div>'; return; }
      const data = {
        id: c.id, name, lineName: f.lineName.value.trim(), paidDate: f.paidDate.value, startDate: f.startDate.value,
        checkinDow: f.checkinDow.value, meetingDow: f.meetingDow.value, goal: f.goal.value, status: f.status.value, memo: f.memo.value,
      };
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        const d = await api('saveClient', { client: data });
        const i = state.clients.findIndex((x) => x.id === d.client.id);
        if (i >= 0) state.clients[i] = d.client;
        saveCache();
        state.dirty = false;
        toast('保存しました');
        location.hash = '#/c/' + encodeURIComponent(d.client.id);
      } catch (ex) {
        err.innerHTML = `<div class="err">${esc(errText(ex))}</div>`;
        btn.disabled = false; btn.textContent = '保存';
      }
    });
  }

  // ================================================================ 操作

  $app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT') return;
    const act = el.dataset.act;
    const cid = decodeURIComponent((location.hash.split('/')[2] || ''));
    const c = state.clients.find((x) => x.id === cid);

    if (act === 'home') { ui.home = el.dataset.v; return render(); }
    if (act === 'list') { ui.list = el.dataset.v; return render(); }
    if (act === 'dtab') { ui.tab[cid] = el.dataset.v; return render(); }
    if (act === 'refresh') return refresh({ force: true });
    if (act === 'backup') return downloadBackup();
    if (act === 'logout') { if (confirm('ログアウトしますか？')) logout(); return; }
    if (act === 'done' || act === 'go') {
      const task = state.tasks[el.dataset.tid];
      if (!task) return;
      if (act === 'go') { location.hash = task.href; return; }
      return onTaskDone(task, el.closest('.tk'));
    }

    // 今週の4項目：タップで 済 ⇄ 未
    if (act.startsWith('tg-') && c) {
      const w = Number(el.dataset.w);
      const r = rec(c.id, w) || {};
      el.disabled = true;
      el.parentElement.classList.toggle('done');
      try {
        if (act === 'tg-checkin') await patchWeek(c.id, w, { checkinDone: !r.checkinDone });
        if (act === 'tg-report') await patchWeek(c.id, w, { reportSent: !r.reportSent });
        if (act === 'tg-meeting') await patchWeek(c.id, w, { meetingDate: r.meetingDate ? '' : fd(today()) });
        if (act === 'tg-eval') await patchClient(c.id, { [el.dataset.key]: c[el.dataset.key] ? '' : fd(today()) });
        if (act === 'tg-final') await patchClient(c.id, { finalDone: c.finalDone ? '' : fd(today()) });
      } catch (_) { /* toast 済 */ }
      return keepScroll(render);
    }
    if (act === 'step' && c) {
      const w = Number(el.dataset.w);
      const name = el.dataset.name;
      const r = rec(c.id, w) || {};
      const v = Math.max(0, Math.min(Number(el.dataset.max), (Number(r[name]) || 0) + Number(el.dataset.d)));
      if (v === (Number(r[name]) || 0)) return;
      el.closest('.stepper').querySelector('output').firstChild.textContent = v;
      try { await patchWeek(c.id, w, { [name]: v }); } catch (_) { keepScroll(render); }
      return;
    }
    if (act === 'selweek') { state.selWeek[cid] = Number(el.dataset.w); return keepScroll(render); }
    if (act === 'addweight') {
      const box = document.getElementById('weights');
      const i = document.createElement('input');
      Object.assign(i, { type: 'number', step: '0.1', min: '20', max: '400' });
      i.setAttribute('inputmode', 'decimal'); i.setAttribute('aria-label', '体重');
      box.appendChild(i); i.focus();
      return;
    }
    if (act === 'copymsg' && c) {
      try { await navigator.clipboard.writeText(lineMessage(c)); toast('送る文章をコピーしました'); }
      catch (_) { const d = document.querySelector('details.msg'); d.open = true; d.querySelector('textarea').select(); toast('文章を選択しました。コピーしてください'); }
      return;
    }
    if (act === 'issuekey' && c) {
      if (el.dataset.reissue && !confirm('リンクを作り直すと、今までのリンクは使えなくなります。よろしいですか？')) return;
      el.disabled = true;
      try {
        const d = await api('issueFormKey', { id: cid });
        const i = state.clients.findIndex((x) => x.id === cid);
        if (i >= 0) state.clients[i] = d.client;
        saveCache();
        toast(el.dataset.reissue ? '新しいリンクを作りました' : 'リンクを作りました');
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
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    try {
      await patchClient(cid, { finalPlan: f.finalPlan.value, finalDone: f.finalDone.value || '' });
      toast('最終評価を保存しました');
      keepScroll(render);
    } catch (_) { btn.disabled = false; }
  });

  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

  // しばらく裏にいたら戻ったときに最新化する
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (getToken() && Date.now() - hiddenAt > 3 * 60 * 1000) refresh();
  });

  // ================================================================ 起動

  (function boot() {
    if (!getToken()) { lsSet(CACHE_KEY, null); return render(); }
    try {
      const cached = JSON.parse(lsGet(CACHE_KEY) || 'null');
      if (cached) setData(cached);
    } catch (_) { /* キャッシュは無くてもよい */ }
    render();
    refresh();
  })();
})();
