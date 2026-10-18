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
    if (on) { b.dataset.label = b.innerHTML; b.disabled = true; b.innerHTML = '<span class="spin"></span>更新中…'; }
    else { b.disabled = false; if (b.dataset.label) b.innerHTML = b.dataset.label; }
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
  // 画面の作りは RafaCoach の管理アプリに合わせている：
  // ホーム（数字のタイル → 対応が必要なお客様 → タップで下からシート）／お客様の詳細（表 → 今週のタスク → 履歴）／下のナビ

  const PRICE = 330000; // 3ヶ月プラン（税込）
  const ui = { filter: 'all', q: '', sheet: null };
  let T = null; // buildTasks() の結果（描画ごとに作り直す）

  function render() {
    if (chart) { chart.destroy(); chart = null; }
    state.dirty = false;
    T = null;
    document.body.classList.remove('sheet-open');
    if (!getToken()) return renderLogin();
    if (!state.ready) { $app.innerHTML = '<div class="loading"><span class="spin"></span>読み込み中…</div>'; return; }
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

  function topbar(title, sub, back, live) {
    return `<header class="topbar">
      ${back ? `<a class="tb-back" href="${back}" aria-label="戻る">‹</a>` : ''}
      <div class="tb-text"><h1>${esc(title)}${live ? '<i class="live"></i>' : ''}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
    </header>`;
  }

  function nav(cur) {
    const it = (href, key, ic, label) => `<a href="${href}" class="${cur === key ? 'on' : ''}"><span class="ic">${ic}</span><span>${label}</span></a>`;
    return `<nav class="bnav">
      ${it('#/', 'home', '⌂', 'ホーム')}
      ${it('#/clients', 'clients', '👥', 'お客様')}
      <a href="#/new" class="add"><span class="ic">＋</span><span>追加</span></a>
      ${it('#/money', 'money', '💰', '売上')}
      ${it('#/menu', 'menu', '≡', 'メニュー')}
    </nav>`;
  }

  // ---------- お客様ごとの「いま必要なこと」 ----------
  const SHORT = { checkin: 'チェックイン', meeting: '面談', report: 'レポート', eval: '身体評価', final: '最終評価' };

  function tasksOf(cid) {
    if (!T) T = buildTasks();
    const pick = (arr) => arr.filter((x) => x.c.id === cid);
    return { overdue: pick(T.overdue), today: pick(T.today), week: pick(T.week) };
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
      if (x.kind === 'go') out.push({ short: x.key === 'ended' ? '12週終了' : '開始日', long: x.key === 'ended' ? '状態の更新（12週終了）' : '開始日の設定', days: since(x.date), level: 'late' });
      else out.push({ short: SHORT[x.kind], long: SHORT[x.kind], days: since(x.date), level: 'late', task: x });
    }
    for (const x of tk.today) if (x.kind !== 'go') out.push({ short: SHORT[x.kind], long: SHORT[x.kind], level: 'today', task: x });
    if (!intake) out.push({ short: 'ヒアリング', long: 'ヒアリングの回答', level: 'info' });
    return out;
  }
  const needsYou = (iss) => iss.some((i) => i.level !== 'info');
  function pill(iss) {
    const late = iss.filter((i) => i.level === 'late').sort((a, b) => (b.days || 0) - (a.days || 0));
    if (late.length) return `<span class="pill late">${esc(late[0].short)}${late[0].days ? `・${late[0].days}日` : ''}</span>`;
    const td = iss.find((i) => i.level === 'today');
    if (td) return `<span class="pill today">${esc(td.short)}・今日</span>`;
    const info = iss.find((i) => i.level === 'info');
    if (info) return `<span class="pill info">${esc(info.short)}未</span>`;
    return '<span class="pill ok">順調</span>';
  }
  function bannerText(iss) {
    const late = iss.filter((i) => i.level === 'late');
    if (!late.length) return '';
    const names = [...new Set(late.map((i) => i.long))];
    const max = Math.max(...late.map((i) => i.days || 0));
    return `${names.join(' + ')}${max ? `・${max}日前から` : ''}`;
  }
  function subLine(c) {
    const s = sched(c);
    if (c.status === ST.WAIT) return c.paidDate ? `入金済 ${mdwS(c.paidDate)}・開始日未定` : '入金待ち';
    if (c.status === ST.DONE) return '終了';
    if (c.status === ST.CONSULT) return '継続相談';
    if (!s) return '開始日未定';
    if (s.cur === 0) return `${mdw(s.start)} 開始`;
    if (s.cur > WEEKS) return '12週終了';
    return `${s.cur}週目/12・チェックイン ${c.checkinDow === '' ? '未設定' : DOW[c.checkinDow] + '曜'}`;
  }

  // ================================================================ ログイン

  function renderLogin(msg) {
    $app.innerHTML = `
      <section class="login">
        <form id="loginForm" autocomplete="on">
          <div class="login-logo">HATAKEYAMA<i class="live"></i></div>
          <p class="muted">顧客管理（関係者専用）</p>
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

  function counts() {
    const n = { active: 0, wait: 0, done: 0, late: 0 };
    for (const c of state.clients) {
      if (c.status === ST.ACTIVE) n.active++;
      else if (c.status === ST.WAIT) n.wait++;
      else n.done++;
      if (issues(c).some((i) => i.level === 'late')) n.late++;
    }
    return n;
  }
  function paidIn(y, m) { return state.clients.filter((c) => { const d = pd(c.paidDate); return d && d.getFullYear() === y && d.getMonth() === m; }); }
  const yen = (n) => '¥' + n.toLocaleString('ja-JP');

  function tiles(n) {
    return `<div class="tiles">
      <a class="tile blue" href="#/clients" data-act="filter" data-v="${ST.ACTIVE}"><span>進行中</span><b>${n.active}</b></a>
      <a class="tile green" href="#/clients" data-act="filter" data-v="${ST.WAIT}"><span>入金待ち</span><b>${n.wait}</b></a>
      <a class="tile slate" href="#/clients" data-act="filter" data-v="${ST.DONE}"><span>終了</span><b>${n.done}</b></a>
      <a class="tile late" href="#/clients" data-act="filter" data-v="late"><span>遅れ</span><b>${n.late}</b></a>
    </div>`;
  }

  function row(c, iss) {
    const late = iss.some((i) => i.level === 'late');
    return `<button type="button" class="row${late ? ' late' : needsYou(iss) ? ' today' : ''}" data-act="sheet" data-id="${esc(c.id)}">
      <span class="row-b"><span class="row-n">${esc(san(c.name))}</span><span class="row-s">${esc(subLine(c))}</span></span>
      ${pill(iss)}
    </button>`;
  }

  function renderHome() {
    const t = today();
    const n = counts();
    const paid = paidIn(t.getFullYear(), t.getMonth());
    const list = state.clients.filter((c) => c.status === ST.ACTIVE || c.status === ST.WAIT).map((c) => ({ c, iss: issues(c) }));
    const need = list.filter((x) => needsYou(x.iss))
      .sort((a, b) => Math.max(0, ...b.iss.map((i) => i.days || 0)) - Math.max(0, ...a.iss.map((i) => i.days || 0)));
    const fine = list.filter((x) => !needsYou(x.iss));
    const subs = recentSubmissions();
    const wd = `${t.getMonth() + 1}月${t.getDate()}日（${DOW[t.getDay()]}）`;

    $app.innerHTML = `
      ${topbar('HATAKEYAMA', wd, null, true)}
      <div class="wrap">
        ${tiles(n)}
        <p class="money-line">💰 ${t.getMonth() + 1}月の入金：<b>${yen(paid.length * PRICE)}</b>（${paid.length}名）</p>
        <a class="search" href="#/clients">🔍 お客様を検索…</a>
        ${need.length ? `<div class="banner">🚨 ${need.length}名があなたを待っています。下から順に対応してください 👇</div>`
          : '<div class="banner ok">✅ 今日やることはすべて済んでいます</div>'}
        ${subs.length ? `<h2 class="sh new">📩 お客様から届いた（${subs.length}）</h2>
          <div class="rows">${subs.map((x) => `<a class="row new" href="#/c/${encodeURIComponent(x.c.id)}">
            <span class="row-b"><span class="row-n">${esc(san(x.c.name))}</span><span class="row-s">${esc(x.text)}・${esc(dt(x.at))}</span></span>
            <span class="pill new">新着</span></a>`).join('')}</div>` : ''}
        ${need.length ? `<h2 class="sh late">🚨 対応が必要（${need.length}）</h2><div class="rows">${need.map((x) => row(x.c, x.iss)).join('')}</div>` : ''}
        ${fine.length ? `<h2 class="sh">✅ 順調（${fine.length}）</h2><div class="rows">${fine.map((x) => row(x.c, x.iss)).join('')}</div>` : ''}
        ${state.clients.length ? '' : '<div class="empty">まだお客様がいません。下の「＋ 追加」から登録できます。</div>'}
      </div>
      ${ui.sheet ? sheet(ui.sheet) : ''}
      ${nav('home')}`;
    if (ui.sheet) document.body.classList.add('sheet-open');
  }

  /** 新着（直近3日） */
  function recentSubmissions() {
    const since = Date.now() - RECENT_MS;
    const out = [];
    for (const c of state.clients) {
      if (c.intake && c.intake.submittedAt && Date.parse(c.intake.submittedAt) > since) out.push({ c, at: c.intake.submittedAt, text: 'ヒアリングに回答' });
      for (const r of Object.values(state.weeks[c.id] || {})) {
        if (r.submittedAt && Date.parse(r.submittedAt) > since) out.push({ c, at: r.submittedAt, text: `${r.week}週目のチェックイン` });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }
  function dt(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // ---------- 今週のタスク（シートと詳細で共通） ----------
  function weekTasks(c) {
    const s = sched(c);
    if (c.status === ST.WAIT) {
      return [{ act: 'tg-paid', done: !!c.paidDate, label: '入金確認', ic: '💰', doneLabel: `入金済 ${c.paidDate ? md(pd(c.paidDate)) : ''}` }];
    }
    if (c.status !== ST.ACTIVE || !s || s.cur < 1) return [];
    const w = Math.min(s.cur, WEEKS);
    const r = rec(c.id, w) || {};
    const out = [
      { act: 'tg-checkin', w, done: !!r.checkinDone, label: 'チェックイン受取', ic: '📅', doneLabel: 'チェックイン' },
      { act: 'tg-meeting', w, done: !!r.meetingDate, label: '面談', ic: '🗣', doneLabel: '面談' },
      { act: 'tg-report', w, done: !!r.reportSent, label: 'レポート送付', ic: '📝', doneLabel: 'レポート' },
    ];
    for (const ev of EVALS) if (ev.week === w) out.push({ act: 'tg-eval', key: ev.key, w, done: !!c[ev.key], label: `${ev.label === '開始時' ? '開始時' : ev.week + '週目'}の身体評価`, ic: '📏', doneLabel: '身体評価' });
    if (s.cur >= 11) out.push({ act: 'tg-final', w, done: !!c.finalDone, label: '最終評価', ic: '🏁', doneLabel: '最終評価' });
    return out;
  }
  function taskButtons(c) {
    const ts = weekTasks(c);
    if (!ts.length) return '';
    return `<div class="tbtns${ts.length % 2 ? ' odd' : ''}">${ts.map((x) => `
      <button type="button" class="tbtn${x.done ? ' done' : ''}" data-act="${x.act}" data-id="${esc(c.id)}"${x.w ? ` data-w="${x.w}"` : ''}${x.key ? ` data-key="${x.key}"` : ''}>
        ${x.ic} ${esc(x.done ? x.doneLabel + ' ✓' : x.label)}</button>`).join('')}</div>`;
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

  // ---------- 下から出るシート ----------
  function sheet(id) {
    const c = state.clients.find((x) => x.id === id);
    if (!c) return '';
    const iss = issues(c);
    const s = sched(c);
    const w = s && s.cur >= 1 ? Math.min(s.cur, WEEKS) : null;
    const r = w ? rec(c.id, w) || {} : {};
    const ci = w ? dowInWeek(s, w, c.checkinDow) : null;
    const t = today();
    const lines = [];
    if (c.status === ST.WAIT) lines.push(['💰', '入金', c.paidDate ? `済 ${mdwS(c.paidDate)}` : '未確認', !c.paidDate]);
    lines.push(['📋', 'ヒアリング', c.intake && c.intake.submittedAt ? '回答済み' : '未回答', !(c.intake && c.intake.submittedAt)]);
    if (w) {
      lines.push(['📅', 'チェックイン', r.checkinDone ? (r.submittedAt ? `届いた ${dt(r.submittedAt)}` : '受取済') : ci ? `${mdw(ci)}${ci < t ? '（遅れ）' : ''}` : '曜日未設定', !r.checkinDone && ci && ci < t]);
      lines.push(['🗣', '面談', r.meetingDate ? `済 ${mdwS(r.meetingDate)}` : '今週まだ', false]);
    }
    const m = c.formKey ? mainMessage(c) : null;
    return `<div class="sheet-bg" data-act="close-sheet"></div>
      <section class="sheet" role="dialog" aria-label="${esc(san(c.name))}">
        <div class="grip"></div>
        <h2>${esc(san(c.name))}</h2>
        <p class="sheet-sub">${esc(subLine(c))}</p>
        ${bannerText(iss) ? `<div class="banner">🚨 ${esc(bannerText(iss))}</div>` : ''}
        <dl class="tbl">${lines.map(([ic, k, v, bad]) => `<div><dt>${ic} ${k}</dt><dd class="${bad ? 'bad' : ''}">${esc(v)}</dd></div>`).join('')}</dl>
        ${taskButtons(c)}
        ${m ? `<a class="btn line block" href="${lineHref(m.text)}" target="_blank" rel="noopener noreferrer">💬 ${m.label}</a>` : ''}
        <a class="btn ghost block" href="#/c/${encodeURIComponent(c.id)}">詳細を見る ›</a>
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
    }).sort((a, b) => (a.c.startDate || '9').localeCompare(b.c.startDate || '9'));
    const chips = [['all', '全員'], [ST.ACTIVE, '進行中'], [ST.WAIT, '入金待ち'], [ST.DONE, '終了'], ['late', '遅れ']];
    $app.innerHTML = `
      ${topbar('お客様', `${state.clients.length}名`)}
      <div class="wrap">
        <input class="search" type="search" id="q" placeholder="🔍 名前・LINE名で検索" value="${esc(ui.q)}" autocomplete="off">
        <div class="chips">${chips.map(([k, l]) => `<button type="button" class="${f === k ? 'on' : ''}" data-act="filter" data-v="${k}">${l}</button>`).join('')}</div>
        <div class="rows">${arr.map((x) => row(x.c, x.iss)).join('') || '<div class="empty">該当するお客様はいません</div>'}</div>
      </div>
      ${ui.sheet ? sheet(ui.sheet) : ''}
      ${nav('clients')}`;
    if (ui.sheet) document.body.classList.add('sheet-open');
    const qi = document.getElementById('q');
    qi.addEventListener('input', () => {
      ui.q = qi.value;
      const pos = qi.selectionStart;
      renderClients();
      const n = document.getElementById('q'); n.focus(); n.setSelectionRange(pos, pos);
    });
  }

  // ================================================================ 売上

  function renderMoney() {
    const t = today();
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
      const list = paidIn(d.getFullYear(), d.getMonth());
      months.push({ d, list });
    }
    const total = state.clients.filter((c) => c.paidDate).length;
    $app.innerHTML = `
      ${topbar('売上', '入金確認日をもとに集計（3ヶ月プラン 税込33万円）')}
      <div class="wrap">
        <div class="big-money"><span>${t.getMonth() + 1}月の入金</span><b>${yen(months[0].list.length * PRICE)}</b><small>${months[0].list.length}名</small></div>
        <div class="card">${months.map(({ d, list }) => `
          <div class="mrow"><span>${d.getFullYear()}年${d.getMonth() + 1}月</span><span class="muted">${list.length}名</span><b>${yen(list.length * PRICE)}</b></div>
          ${list.length ? `<div class="mnames">${list.map((c) => `<a href="#/c/${encodeURIComponent(c.id)}">${esc(san(c.name))}（${md(pd(c.paidDate))}）</a>`).join('')}</div>` : ''}`).join('')}
        </div>
        <p class="note">累計 ${total}名・${yen(total * PRICE)}。入金が確認できたら、お客様の「入金確認」を押すか、編集で入金確認日を入れてください。</p>
      </div>
      ${nav('money')}`;
  }

  // ================================================================ メニュー

  function renderMenu() {
    $app.innerHTML = `
      ${topbar('メニュー', state.syncedAt ? `${state.syncedAt.getHours()}:${String(state.syncedAt.getMinutes()).padStart(2, '0')} に更新` : '')}
      <div class="wrap">
        <div class="menu">
          <button type="button" data-act="refresh">🔄 最新の状態に更新</button>
          <a href="#/new">＋ お客様を追加</a>
          <button type="button" data-act="backup">💾 バックアップを保存（全データ）</button>
          <button type="button" data-act="logout">🚪 ログアウト</button>
        </div>
        <div class="card">
          <h3 class="ch">プラン</h3>
          <dl class="tbl"><div><dt>内容</dt><dd>3ヶ月（12週）完全オンライン</dd></div><div><dt>料金</dt><dd>30万円（税込33万円）</dd></div>
          <div><dt>支払い</dt><dd>銀行振込・入金確認後に開始</dd></div><div><dt>初回</dt><dd>カウンセリング60分</dd></div><div><dt>継続</dt><dd>個別相談</dd></div></dl>
          <h3 class="ch">お客様との約束</h3>
          <dl class="tbl"><div><dt>個別面談</dt><dd>週1回60分 × 12回</dd></div><div><dt>身体評価</dt><dd>開始時・4週・8週・12週</dd></div>
          <div><dt>フォーム添削</dt><dd>動画 週2本まで</dd></div><div><dt>食事記録の確認</dt><dd>週3日分</dd></div>
          <div><dt>週間レポート</dt><dd>週1回</dd></div><div><dt>LINE返信</dt><dd>原則2営業日以内（日曜・祝日なし）</dd></div></dl>
        </div>
      </div>
      ${nav('menu')}`;
  }

  // ================================================================ お客様の詳細（ficha completa）

  function renderDetail(id) {
    const c = state.clients.find((x) => x.id === id);
    if (!c) { $app.innerHTML = topbar('見つかりません', '', '#/') + '<div class="wrap"><div class="empty">画面を更新してください。</div></div>' + nav(''); return; }
    const s = sched(c);
    const iss = issues(c);
    const st = stats(c);
    const t = today();
    const w = s && s.cur >= 1 ? Math.min(s.cur, WEEKS) : null;
    const lastCk = (() => { for (let i = WEEKS; i >= 1; i--) { const r = rec(c.id, i); if (r && r.checkinDone) return r.submittedAt ? dt(r.submittedAt) : `${i}週目`; } return '—'; })();
    const nc = nextCheckin(c, s);
    const dueCk = w && dowInWeek(s, w, c.checkinDow);
    const ckLate = w && !(rec(c.id, w) || {}).checkinDone && dueCk && dueCk < t;
    const banner = bannerText(iss);
    const statusBox = banner ? `<div class="banner big">🚨 ${esc(banner)}</div>`
      : c.status === ST.ACTIVE ? '<div class="status ok"><small>STATUS</small>✅ 順調</div>'
        : `<div class="status"><small>STATUS</small>${esc(c.status)}</div>`;
    const tr = (k, v, cls) => `<div><dt>${k}</dt><dd class="${cls || ''}">${v}</dd></div>`;
    const dowName = (d) => (d === '' || d == null ? '未設定' : DOW[d] + '曜');
    const m = c.formKey ? mainMessage(c) : null;
    const intake = c.intake && c.intake.submittedAt;

    $app.innerHTML = `
      ${topbar(san(c.name), '', '#/')}
      <div class="wrap">
        ${statusBox}
        <dl class="tbl card">
          ${tr('プラン', '<span class="blue">3ヶ月（12週）</span>')}
          ${tr('進み具合', s && s.cur >= 1 ? `${Math.min(s.cur, WEEKS)}週目 / 12週` : '開始前')}
          ${tr('💰 入金確認日', c.paidDate ? `<span class="green">${c.paidDate.replace(/-/g, '/')}</span>` : '<span class="bad">未確認</span>')}
          ${tr('開始日', c.startDate ? c.startDate.replace(/-/g, '/') : '<span class="bad">未設定</span>')}
          ${tr('終了予定日', s ? fd(s.end).replace(/-/g, '/') : '—')}
          ${tr('📋 次のチェックイン', ckLate ? `<span class="bad">${fd(dueCk).replace(/-/g, '/')}（遅れ）</span>` : nc ? fd(nc).replace(/-/g, '/') + `（${DOW[nc.getDay()]}）` : '—')}
          ${tr('最終チェックイン', lastCk)}
          ${tr('チェックイン曜日', dowName(c.checkinDow))}
          ${tr('面談曜日', dowName(c.meetingDow))}
          ${tr('LINE名', esc(c.lineName || '—'))}
          ${c.goal ? tr('目標', esc(c.goal)) : ''}
          ${c.memo ? tr('メモ', esc(c.memo)) : ''}
        </dl>

        ${weekTasks(c).length ? `<h2 class="sh">${w ? `${w}週目のタスク` : 'タスク'}</h2>${taskButtons(c)}` : ''}
        ${w ? `<div class="steps">
          ${stepRow('🎥 フォーム添削', 'formVideos', (rec(c.id, w) || {}).formVideos || 0, FORM_MAX, '本', w, c.id)}
          ${stepRow('🍱 食事記録の確認', 'mealDays', (rec(c.id, w) || {}).mealDays || 0, 7, '日', w, c.id)}
        </div>` : ''}

        ${c.formKey ? `<a class="linkrow" href="${formUrl(c)}" target="_blank" rel="noopener noreferrer"><span>🔗</span><span class="u">${esc(formUrl(c).replace(/^https?:\/\//, ''))}</span><span>›</span></a>`
          : '<button class="btn block" type="button" data-act="issuekey">🔗 お客様用リンクを作る</button>'}
        ${m ? `<a class="btn line block" href="${lineHref(m.text)}" target="_blank" rel="noopener noreferrer">💬 ${m.label}</a>` : ''}
        ${c.formKey && intake && c.status === ST.ACTIVE ? `<a class="btn block" href="${lineHref(msgIntake(c))}" target="_blank" rel="noopener noreferrer">📋 ヒアリングをもう一度送る（LINE）</a>` : ''}
        ${c.status === ST.ACTIVE && s && s.cur >= 11 ? `<button class="btn camel block" type="button" data-act="status" data-v="${ST.CONSULT}">継続の相談に進む</button>` : ''}
        ${c.status === ST.ACTIVE ? `<button class="btn outline block" type="button" data-act="status" data-v="${ST.DONE}">終了にする</button>` : ''}
        ${c.status === ST.DONE || c.status === ST.CONSULT ? `<button class="btn outline block" type="button" data-act="status" data-v="${ST.ACTIVE}">進行中に戻す</button>` : ''}

        <h2 class="sh">事前ヒアリング</h2>
        ${intakeBlock(c)}

        <h2 class="sh">身体評価</h2>
        <div class="card">${EVALS.map((ev) => {
          const due = s ? evalDue(c, s, ev) : null;
          const miss = !c[ev.key] && due && due < t;
          return `<div class="eval${miss ? ' miss' : ''}"><span>${ev.label}<small>予定 ${mdw(due)}</small></span>
            <input type="date" value="${esc(c[ev.key] || '')}" data-act="evaldate" data-key="${ev.key}" aria-label="${ev.label}の実施日"></div>`;
        }).join('')}
        <p class="mini">約束の達成：面談 ${st.meet}/12・評価 ${st.evals}/4・レポート ${st.rep}/12・チェックイン ${st.chk}/12</p></div>
        ${s && (s.cur >= 11 || c.finalDone || c.finalPlan) ? finalCard(c, s) : ''}

        <h2 class="sh">チェックインの履歴</h2>
        ${historyBlock(c, s)}

        <a class="btn block" href="#/edit/${encodeURIComponent(c.id)}">情報を編集</a>
        <button class="btn danger block" type="button" data-act="delete" data-id="${esc(c.id)}">このお客様を削除</button>
      </div>
      ${nav('')}`;
    drawChart(c);
  }

  function stepRow(label, name, v, max, unit, w, cid) {
    return `<div class="step"><span>${label}<small>今週 上限/目安 ${name === 'formVideos' ? FORM_MAX + '本' : MEAL_TARGET + '日'}</small></span>
      <span class="stepper"><button type="button" data-act="step" data-id="${esc(cid)}" data-name="${name}" data-d="-1" data-max="${max}" data-w="${w}" aria-label="減らす">−</button>
      <output>${v}<small>${unit}</small></output>
      <button type="button" data-act="step" data-id="${esc(cid)}" data-name="${name}" data-d="1" data-max="${max}" data-w="${w}" aria-label="増やす">＋</button></span></div>`;
  }

  function intakeBlock(c) {
    if (!(c.intake && c.intake.submittedAt)) return '<p class="muted pad">まだ回答がありません。</p>';
    const a = c.intake.answers || {};
    const qs = INTAKE.sections.flatMap((sec) => sec.questions);
    const val = (q) => (q.type === 'radio' ? a[q.id + '__label'] || a[q.id] : a[q.id] ? a[q.id] + (q.unit ? ' ' + q.unit : '') : '') || '—';
    const known = new Set(qs.map((q) => q.id));
    const extra = Object.keys(a).filter((k) => !known.has(k) && !k.endsWith('__label'));
    return `<details class="card qa"><summary>${dt(c.intake.submittedAt)} に回答 ・ タップで開く</summary>
      <dl class="qa-l">${qs.map((q) => `<dt>${esc(q.label)}</dt><dd>${esc(val(q))}</dd>`).join('')}
      ${extra.map((k) => `<dt>${esc(k)}</dt><dd>${esc(a[k + '__label'] || a[k])}</dd>`).join('')}</dl></details>`;
  }

  function historyBlock(c, s) {
    const cards = [];
    for (let w = WEEKS; w >= 1; w--) {
      const r = rec(c.id, w);
      const has = r && (r.weights.length || r.checks || r.checkinDone || r.memo || r.meetingDate || r.submittedAt);
      if (!has && !(s && w === Math.min(s.cur, WEEKS))) continue;
      const rr = r || {};
      const n = scoreOf(rr);
      const dots = rr.checks && rr.checks.length === 7 ? rr.checks.split('').map((x) => (x === '1' ? '●' : '○')).join('') : '';
      cards.push(`<div class="hcard">
        <div class="h-top"><b>${w}週目</b><span class="muted">${s ? `${md(weekStart(s, w))}〜${md(weekEnd(s, w))}` : ''}</span>
          <span class="h-kg">${avgW(rr) == null ? '—' : avgW(rr).toFixed(1) + ' kg'}</span>
          <a class="mini-btn" href="#/c/${encodeURIComponent(c.id)}/w/${w}">✏️ 記録</a></div>
        <div class="h-rates">
          ${dots ? `<span>チェックシート <i>${dots}</i> ${n}/7</span>` : ''}
          ${rr.condition ? `<span>体調 <i>${esc(rr.condition)}</i></span>` : ''}
          <span>面談 <i>${rr.meetingDate ? '✓' : '—'}</i></span><span>レポート <i>${rr.reportSent ? '✓' : '—'}</i></span>
        </div>
        ${rr.clientWin ? `<p>👍 ${esc(rr.clientWin)}</p>` : ''}
        ${rr.clientNote ? `<p>💭 ${esc(rr.clientNote)}</p>` : ''}
        ${rr.memo ? `<p class="muted">📝 ${esc(rr.memo)}</p>` : ''}
      </div>`);
    }
    const hasW = Object.values(state.weeks[c.id] || {}).some((r) => avgW(r) != null);
    return `${hasW ? `<div class="card chart-card"><div class="ch-row"><h3 class="ch">📊 体重の推移</h3><span id="chg" class="muted"></span></div>
      <div class="chart-box"><canvas id="chart" aria-label="週平均体重の推移"></canvas></div><p id="chartMsg" class="mini"></p></div>` : ''}
      ${cards.join('') || '<p class="muted pad">まだ記録がありません。</p>'}`;
  }

  function finalCard(c, s) {
    const recs = [];
    for (let w = 1; w <= WEEKS; w++) recs.push(rec(c.id, w));
    const withW = recs.map((r, i) => ({ w: i + 1, v: avgW(r) })).filter((x) => x.v != null);
    const first = withW[0];
    const lastW = withW[withW.length - 1];
    const diff = first && lastW && lastW.w !== first.w ? lastW.v - first.v : null;
    return `<form id="finalForm" class="card">
      <h3 class="ch">🏁 最終評価（〜${mdw(s.end)}）</h3>
      <p class="mini">体重 ${first ? kg(first.v) : '—'} → ${lastW ? kg(lastW.v) : '—'}${diff == null ? '' : `（${diff > 0 ? '+' : ''}${diff.toFixed(1)}kg）`}</p>
      <div class="field"><label for="finalPlan">12週の変化と今後の計画（継続の相談も）</label><textarea id="finalPlan" name="finalPlan" rows="4">${esc(c.finalPlan || '')}</textarea></div>
      <div class="field"><label for="finalDone">実施日</label><input type="date" id="finalDone" name="finalDone" value="${esc(c.finalDone || '')}"></div>
      <button class="btn primary block" type="submit">保存</button>
    </form>`;
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
    if (msg) msg.textContent = `${pts.length}週分・${pts[0].w}週目 → ${pts[pts.length - 1].w}週目`;
    let Chart;
    try { Chart = await loadChartJs(); } catch (_) { if (msg) msg.textContent = 'グラフを読み込めませんでした。'; return; }
    if (!cv.isConnected) return;
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    if (chart) chart.destroy();
    chart = new Chart(cv, {
      type: 'line',
      data: { labels: pts.map((p) => p.w + '週'), datasets: [{ data: pts.map((p) => p.v), borderColor: v('--camel'), backgroundColor: 'rgba(217,165,106,.12)',
        fill: true, tension: 0.25, pointRadius: 4, pointBackgroundColor: v('--card'), pointBorderWidth: 2.5, borderWidth: 2.5 }] },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: v('--muted'), font: { size: 11 } }, grid: { display: false } },
          y: { ticks: { color: v('--muted'), font: { size: 11 } }, grid: { color: 'rgba(255,255,255,.06)' } },
        },
      },
    });
  }

  // ================================================================ 週の記録（編集）

  function renderWeekEdit(id, w) {
    const c = state.clients.find((x) => x.id === id);
    if (!c) { location.hash = '#/'; return; }
    const s = sched(c);
    const r = rec(c.id, w) || {};
    const weights = (r.weights || []).slice();
    while (weights.length < 3) weights.push('');
    const checks = (r.checks || '').padEnd(7, '0');
    $app.innerHTML = `
      ${topbar(`${w}週目の記録`, `${san(c.name)}${s ? `・${md(weekStart(s, w))}〜${md(weekEnd(s, w))}` : ''}`, '#/c/' + encodeURIComponent(id))}
      <div class="wrap">
        ${r.submittedAt ? `<div class="card sub"><h3 class="ch">📩 お客様から届いた（${esc(dt(r.submittedAt))}）</h3>
          ${r.condition ? `<p>体調：${esc(r.condition)}</p>` : ''}${r.clientWin ? `<p>👍 ${esc(r.clientWin)}</p>` : ''}${r.clientNote ? `<p>💭 ${esc(r.clientNote)}</p>` : ''}
          <p class="mini">体重とチェックシートは下に反映済みです。</p></div>` : ''}
        <form id="weekForm" class="card" novalidate>
          <div class="field"><span class="lbl">体重（kg）</span>
            <div class="weights" id="weights">${weights.map((v) => `<input type="number" inputmode="decimal" step="0.1" min="20" max="400" value="${esc(v)}" aria-label="体重">`).join('')}</div>
            <div class="row-sb"><span class="avg">週平均 <b id="avg">—</b></span><button class="mini-btn" type="button" data-act="addweight">＋ 入力欄</button></div></div>
          <div class="field"><span class="lbl">チェックシート</span>
            <div class="checklist">${CHECK_ITEMS.map((txt, i) => `<label class="check"><input type="checkbox" name="ck${i}"${checks[i] === '1' ? ' checked' : ''}><span>${esc(txt)}</span></label>`).join('')}</div>
            <div class="score" id="score"></div></div>
          <div class="grid2">
            <label class="toggle"><input type="checkbox" name="checkinDone"${r.checkinDone ? ' checked' : ''}><span>チェックイン受取</span></label>
            <label class="toggle"><input type="checkbox" name="reportSent"${r.reportSent ? ' checked' : ''}><span>レポート送付</span></label>
          </div>
          <div class="grid2">
            <div class="field"><label for="meetingDate">面談実施日</label><input type="date" id="meetingDate" name="meetingDate" value="${esc(r.meetingDate || '')}"></div>
            <div class="field"><label for="formVideos">フォーム添削（本）</label><input type="number" id="formVideos" name="formVideos" min="0" max="${FORM_MAX}" value="${r.formVideos || 0}"></div>
          </div>
          <div class="field"><label for="mealDays">食事記録の確認（日）</label><input type="number" id="mealDays" name="mealDays" min="0" max="7" value="${r.mealDays || 0}"></div>
          <div class="field"><label for="wmemo">メモ</label><textarea id="wmemo" name="memo" rows="3">${esc(r.memo || '')}</textarea></div>
          <button class="btn primary block" type="submit">保存</button>
        </form>
      </div>
      ${nav('')}`;
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
      if (!checksTouched) { sc.className = 'score'; sc.innerHTML = '<span class="muted">未入力</span>'; return; }
      sc.className = 'score lv' + scoreLv(n);
      sc.innerHTML = `<span>スコア <b>${n}/7</b></span><b>${scoreLabel(n)}</b>`;
    };
    f.addEventListener('input', (e) => { state.dirty = true; if (/^ck\d$/.test(e.target.name)) checksTouched = true; update(); });
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
      ${topbar('お客様を追加', '3つ入れるだけ。追加すると送るリンクができます', '#/')}
      <div class="wrap">
        <form id="newForm" class="card" novalidate>
          <div class="field"><label for="n-name">名前</label><input type="text" id="n-name" name="name" autocomplete="off" placeholder="例：田中 太郎"></div>
          <div class="field"><label for="n-line">LINE名</label><input type="text" id="n-line" name="lineName" autocomplete="off"></div>
          <div class="field"><label for="n-paid">入金確認日<small>まだなら空欄でOK</small></label><input type="date" id="n-paid" name="paidDate"></div>
          <div id="editErr"></div>
          <button class="btn primary block" type="submit">追加してリンクを作る</button>
        </form>
      </div>
      ${nav('')}`;
    const f = document.getElementById('newForm');
    f.addEventListener('input', () => { state.dirty = true; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('editErr');
      const name = f.name.value.trim(), lineName = f.lineName.value.trim();
      if (!name || !lineName) { err.innerHTML = '<div class="err">名前とLINE名を入力してください。</div>'; (name ? f.lineName : f.name).focus(); return; }
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        const d = await api('saveClient', { client: { name, lineName, paidDate: f.paidDate.value, status: ST.WAIT } });
        state.clients.push(d.client);
        saveCache();
        toast('追加しました。リンクをLINEで送ってください');
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
      ${topbar('情報を編集', san(c.name), '#/c/' + encodeURIComponent(id))}
      <div class="wrap">
        <form id="editForm" class="card" novalidate>
          <div class="field"><label for="f-name">名前</label><input type="text" id="f-name" name="name" value="${esc(c.name)}" autocomplete="off"></div>
          <div class="field"><label for="f-line">LINE名</label><input type="text" id="f-line" name="lineName" value="${esc(c.lineName)}" autocomplete="off"></div>
          <div class="grid2">
            <div class="field"><label for="f-paid">入金確認日</label><input type="date" id="f-paid" name="paidDate" value="${esc(c.paidDate)}"></div>
            <div class="field"><label for="f-start">開始日</label><input type="date" id="f-start" name="startDate" value="${esc(c.startDate)}"></div>
          </div>
          <p class="mini" id="endHint"></p>
          <div class="grid2">
            <div class="field"><label for="f-ci">チェックイン曜日</label><select id="f-ci" name="checkinDow">${dowOpts(c.checkinDow)}</select></div>
            <div class="field"><label for="f-mt">面談曜日</label><select id="f-mt" name="meetingDow">${dowOpts(c.meetingDow)}</select></div>
          </div>
          <div class="field"><label for="f-st">状態</label><select id="f-st" name="status">${STATUSES.map((s) => `<option${s === c.status ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
          <div class="field"><label for="f-goal">目標</label><textarea id="f-goal" name="goal" rows="2">${esc(c.goal)}</textarea></div>
          <div class="field"><label for="f-memo">メモ</label><textarea id="f-memo" name="memo" rows="3">${esc(c.memo)}</textarea></div>
          <div id="editErr"></div>
          <button class="btn primary block" type="submit">保存</button>
        </form>
      </div>
      ${nav('')}`;
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
      if (!name) { err.innerHTML = '<div class="err">名前を入力してください。</div>'; return; }
      if (f.status.value === ST.ACTIVE && !f.startDate.value) { err.innerHTML = '<div class="err">「進行中」にするには開始日が必要です。</div>'; return; }
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
      } catch (ex) { err.innerHTML = `<div class="err">${esc(errText(ex))}</div>`; btn.disabled = false; btn.textContent = '保存'; }
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
    if (act === 'filter') { e.preventDefault(); ui.filter = el.dataset.v; ui.sheet = null; if (location.hash !== '#/clients') location.hash = '#/clients'; else render(); return; }
    if (act === 'refresh') return refresh({ force: true });
    if (act === 'backup') return downloadBackup();
    if (act === 'logout') { if (confirm('ログアウトしますか？')) logout(); return; }

    // タスクのボタン：タップで 済 ⇄ 未（「元に戻す」つき）
    if (act.startsWith('tg-') && c) {
      const w = Number(el.dataset.w);
      const r = rec(c.id, w) || {};
      const t = fd(today());
      el.disabled = true;
      let undo = null;
      try {
        if (act === 'tg-checkin') { const v = !r.checkinDone; await patchWeek(c.id, w, { checkinDone: v }); undo = () => patchWeek(c.id, w, { checkinDone: !v }); }
        if (act === 'tg-report') { const v = !r.reportSent; await patchWeek(c.id, w, { reportSent: v }); undo = () => patchWeek(c.id, w, { reportSent: !v }); }
        if (act === 'tg-meeting') { const old = r.meetingDate || ''; await patchWeek(c.id, w, { meetingDate: old ? '' : t }); undo = () => patchWeek(c.id, w, { meetingDate: old }); }
        if (act === 'tg-eval') { const k = el.dataset.key; const old = c[k] || ''; await patchClient(c.id, { [k]: old ? '' : t }); undo = () => patchClient(c.id, { [k]: old }); }
        if (act === 'tg-final') { const old = c.finalDone || ''; await patchClient(c.id, { finalDone: old ? '' : t }); undo = () => patchClient(c.id, { finalDone: old }); }
        if (act === 'tg-paid') { const old = c.paidDate || ''; await patchClient(c.id, { paidDate: old ? '' : t }); undo = () => patchClient(c.id, { paidDate: old }); }
      } catch (_) { /* toast 済 */ }
      keepScroll(render);
      if (undo) toast('更新しました', async () => { try { await undo(); } catch (_) { /* toast 済 */ } keepScroll(render); });
      return;
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
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    try { await patchClient(cid, { finalPlan: f.finalPlan.value, finalDone: f.finalDone.value || '' }); toast('最終評価を保存しました'); keepScroll(render); }
    catch (_) { btn.disabled = false; }
  });

  window.addEventListener('hashchange', () => { ui.sheet = null; render(); window.scrollTo(0, 0); });

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
