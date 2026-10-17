(function () {
  'use strict';

  // ================================================================ 定数

  const CFG = window.APP_CONFIG || {};
  const TOKEN_KEY = 'hk_token';
  const CACHE_KEY = 'hk_cache';
  const WEEKS = 12;
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  const ST = { WAIT: '入金待ち', ACTIVE: '進行中', DONE: '終了', CONSULT: '継続相談' };
  const STATUSES = [ST.WAIT, ST.ACTIVE, ST.DONE, ST.CONSULT];
  const CHECK_ITEMS = [
    '予定していたトレーニングを実施できた',
    '主要種目で回数・重量・フォームのどれかが改善した',
    'タンパク質をおおむね目標量とれた',
    '体重を複数回測り、週平均を確認した',
    '睡眠時間を大きく崩さなかった',
    '外食後も翌日から戻せた',
    '写真・鏡・服のフィット感で変化を確認した',
  ];
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
    not_configured: 'GAS側でパスワードが未設定です（スクリプトプロパティ APP_PASSWORD）。',
    network: '通信できませんでした。電波状況を確認して、もう一度お試しください。',
    config: 'GASのURLが未設定です（js/config.js）。',
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
    if (!CFG.GAS_URL) throw new Error('config');
    const body = Object.assign({ action }, payload || {});
    if (action !== 'login') body.token = getToken();
    let res;
    try {
      res = await fetch(CFG.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライトを避ける
        body: JSON.stringify(body),
        redirect: 'follow',
        credentials: 'omit',
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

  function render() {
    if (chart) { chart.destroy(); chart = null; }
    state.dirty = false;
    if (!getToken()) return renderLogin();
    if (!state.ready) { $app.innerHTML = '<div class="loading"><span class="spin"></span>　読み込み中…</div>'; return; }
    const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
    if (a === 'c' && b) return renderDetail(decodeURIComponent(b));
    if (a === 'new') return renderEdit(null);
    if (a === 'edit' && b) return renderEdit(decodeURIComponent(b));
    return renderHome();
  }

  function topBar(title, back, right) {
    return `<header class="top">${back ? `<a class="back" href="${back}">‹ 戻る</a>` : ''}<h1>${esc(title)}</h1>${right || ''}</header>`;
  }

  // ================================================================ ログイン

  function renderLogin(msg) {
    $app.innerHTML = `
      <section class="login">
        <form id="loginForm" autocomplete="on">
          <h1>顧客管理</h1>
          <p>畠山祐輔さん・株式会社マルカト 関係者専用</p>
          <input type="text" name="username" value="hatakeyama-kanri" autocomplete="username" hidden>
          <div class="field">
            <label for="pw">パスワード</label>
            <input id="pw" type="password" name="password" autocomplete="current-password" required>
          </div>
          <div class="field"><button class="btn primary block" type="submit">ログイン</button></div>
          ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
          ${CFG.GAS_URL ? '' : `<div class="err">${esc(ERRORS.config)}</div>`}
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

  // ================================================================ 画面1：ホーム

  function taskRow(task, cls) {
    state.tasks[task.id] = task;
    const go = task.kind === 'go';
    return `<li class="task ${cls}${go ? ' go' : ''}" data-tid="${esc(task.id)}">
      <button type="button" class="task-do" data-act="${go ? 'go' : 'done'}" data-tid="${esc(task.id)}">
        <span class="tick" aria-hidden="true"></span>
        <span class="task-text"><span class="who">${esc(san(task.c.name))}</span><span class="sep">｜</span>${esc(task.text)}</span>
      </button>
      <a class="task-go" href="#/c/${encodeURIComponent(task.c.id)}" aria-label="${esc(san(task.c.name))}の詳細">›</a>
    </li>`;
  }

  function mark(label, done, total, behind) {
    const cls = behind ? 'behind' : done >= total ? 'full' : '';
    return `<span class="mk ${cls}">${label} <b class="num">${done}/${total}</b></span>`;
  }

  function clientCard(c) {
    const st = stats(c);
    const s = st.s;
    const behind = st.missMeet || st.missRep || st.missChk || st.missEval;
    let wk, pct;
    if (!s) { wk = '開始日未設定'; pct = 0; }
    else if (s.cur === 0) { wk = `開始前<small>（${md(s.start)}〜）</small>`; pct = 0; }
    else if (s.cur > WEEKS) { wk = '12週終了'; pct = 100; }
    else { wk = `${s.cur}週目<small>／12週</small>`; pct = s.cur / WEEKS * 100; }
    const nm = nextMeeting(c, s);
    const nc = nextCheckin(c, s);
    return `<a class="card${behind ? ' alert' : ''}" href="#/c/${encodeURIComponent(c.id)}">
      <div class="card-top"><span class="name">${esc(san(c.name))}</span><span class="wk num">${wk}</span></div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="12" aria-valuenow="${s ? Math.min(s.cur, 12) : 0}"><i style="width:${pct.toFixed(1)}%"></i></div>
      <dl class="meta">
        <div><dt>次のチェックイン</dt><dd class="num">${c.checkinDow === '' ? '曜日未設定' : nc ? mdw(nc) : '—'}</dd></div>
        <div><dt>次の面談</dt><dd class="num">${esc(nm || '—')}</dd></div>
        <div><dt>週平均体重</dt><dd class="num">${st.latestW ? kg(st.latestW.v) + ` <small>${st.latestW.w}週</small>` : '—'}</dd></div>
        <div><dt>チェックシート</dt><dd class="num">${st.latestS ? `${st.latestS.v}/7 <small>${scoreLabel(st.latestS.v)}</small>` : '—'}</dd></div>
      </dl>
      <div class="marks">
        ${mark('面談', st.meet, WEEKS, st.missMeet)}
        ${mark('評価', st.evals, 4, st.missEval)}
        ${mark('レポート', st.rep, WEEKS, st.missRep)}
        ${mark('チェックイン', st.chk, WEEKS, st.missChk)}
      </div>
    </a>`;
  }

  function renderHome() {
    const t = today();
    const tasks = buildTasks();
    state.tasks = {};
    const active = state.clients.filter((c) => c.status === ST.ACTIVE)
      .sort((a, b) => (a.startDate || '9').localeCompare(b.startDate || '9'));
    const groups = [ST.WAIT, ST.CONSULT, ST.DONE].map((st) => ({ st, list: state.clients.filter((c) => c.status === st) }));
    const wd = `${t.getMonth() + 1}月${t.getDate()}日（${DOW[t.getDay()]}）`;
    const synced = state.syncedAt ? `${state.syncedAt.getHours()}:${String(state.syncedAt.getMinutes()).padStart(2, '0')} 時点` : '保存データを表示中';

    const list = (arr, cls, emptyText) => arr.length
      ? `<ul class="tasks">${arr.map((x) => taskRow(x, cls)).join('')}</ul>`
      : `<div class="empty">${emptyText}</div>`;

    $app.innerHTML = `
      ${topBar('顧客管理', null, `<button class="btn ghost" type="button" data-act="refresh">更新</button><a class="btn primary" href="#/new">＋ 追加</a>`)}
      <div class="dateline"><span class="d">${wd}</span><span class="muted small">${synced}</span></div>
      <div class="chips">
        <div class="chip${tasks.overdue.length ? ' alert' : ''}"><b class="num">${tasks.overdue.length}</b><span>遅れ・抜け</span></div>
        <div class="chip"><b class="num">${tasks.today.length}</b><span>今日</span></div>
        <div class="chip"><b class="num">${tasks.week.length}</b><span>今週</span></div>
      </div>

      ${tasks.overdue.length ? `
        <div class="section"><h2>遅れ・抜け</h2><span class="count">タップで「済」</span></div>
        ${list(tasks.overdue.slice(0, OVERDUE_SHOWN), 'overdue', '')}
        ${tasks.overdue.length > OVERDUE_SHOWN ? `
          <details class="more"><summary>残り${tasks.overdue.length - OVERDUE_SHOWN}件を表示</summary>
          ${list(tasks.overdue.slice(OVERDUE_SHOWN), 'overdue', '')}</details>` : ''}` : ''}

      <div class="section"><h2>今日</h2><span class="count">${tasks.today.length}件</span></div>
      ${list(tasks.today, '', '今日の予定はありません')}

      <div class="section"><h2>今週</h2><span class="count">${tasks.week.length}件</span></div>
      ${list(tasks.week, '', '今週の残りはありません')}

      <div class="section"><h2>進行中のお客様</h2><span class="count">${active.length}名</span></div>
      ${active.length ? `<div class="cards">${active.map(clientCard).join('')}</div>`
        : `<div class="empty">進行中のお客様はいません。<br>右上の「＋ 追加」から登録できます。</div>`}

      ${groups.map((g) => g.list.length ? `
        <details class="group">
          <summary>${g.st}<span class="muted small num">${g.list.length}名</span></summary>
          <ul class="plain-list">${g.list.map((c) => `<li><a href="#/c/${encodeURIComponent(c.id)}"><span>${esc(san(c.name))}</span><span>${groupNote(c)}</span></a></li>`).join('')}</ul>
        </details>` : '').join('')}

      <div class="foot"><span>LINE返信：原則2営業日以内（日曜・祝日は返信なし）</span><button class="btn tiny ghost" type="button" data-act="logout">ログアウト</button></div>
    `;
  }

  function groupNote(c) {
    if (c.status === ST.WAIT) return c.startDate ? '開始予定 ' + mdwS(c.startDate) : '開始日未定';
    const s = sched(c);
    return s ? md(s.start) + '〜' + md(s.end) : '';
  }

  async function onTaskDone(task, row) {
    const t = today();
    const ts = fd(t);
    const c = task.c;
    row.classList.add('done');
    row.querySelector('.task-do').disabled = true;
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
      row.querySelector('.task-do').disabled = false;
      return;
    }
    setTimeout(() => { if (!state.dirty) render(); }, 450);
    toast(`${san(c.name)}｜${task.text.replace(/（.*$/, '')} を済にしました`, async () => {
      try { await undo(); } catch (_) { /* toast は patch 側で出す */ }
      render();
    });
  }

  // ================================================================ 画面2：お客様の詳細

  function renderDetail(id) {
    const c = state.clients.find((x) => x.id === id);
    if (!c) {
      $app.innerHTML = topBar('お客様', '#/') + '<div class="empty" style="margin-top:20px">見つかりませんでした。</div>';
      return;
    }
    const s = sched(c);
    const st = stats(c);
    const t = today();
    if (!state.selWeek[id]) state.selWeek[id] = s ? Math.min(Math.max(s.cur, 1), WEEKS) : 1;
    const sel = state.selWeek[id];
    const dowName = (d) => (d === '' || d == null ? '未設定' : DOW[d] + '曜');

    const wkLabel = !s ? '開始日未設定' : s.cur === 0 ? '開始前' : s.cur > WEEKS ? '12週終了' : `${s.cur}週目／12週`;

    // 約束の達成表
    const curRec = s && s.cur >= 1 && s.cur <= WEEKS ? rec(id, s.cur) || {} : null;
    const evalRows = EVALS.map((ev) => {
      const due = s ? evalDue(c, s, ev) : null;
      const miss = !c[ev.key] && due && due < t;
      return `<div class="eval${miss ? ' miss' : ''}">
        <span class="lbl">${ev.label}<span class="muted small">　予定 ${mdw(due)}</span></span>
        <span>${c[ev.key]
          ? `<input type="date" value="${esc(c[ev.key])}" data-act="evaldate" data-key="${ev.key}" aria-label="${ev.label}の実施日">`
          : `<button class="btn tiny" type="button" data-act="evaldone" data-key="${ev.key}">今日 実施</button>`}</span>
      </div>`;
    }).join('');

    const finalDue = s ? s.end : null;
    const finalMiss = !c.finalDone && finalDue && finalDue < t;

    const promises = `
      <table class="promises">
        <tr class="${st.missMeet ? 'behind' : ''}"><th>個別面談<small>週1回60分 × 全12回</small></th>
          <td><span class="st num">${st.meet}/12回</span>${st.missMeet ? `<br><span class="small">未実施 ${st.missMeet}週</span>` : ''}</td></tr>
        <tr class="${st.missEval ? 'behind' : ''}"><th>目標・身体評価<small>開始時／4週／8週／12週</small></th>
          <td><div class="evals">${evalRows}</div></td></tr>
        <tr><th>フォーム添削<small>動画提出 週2本まで</small></th>
          <td><span class="st num">${curRec ? `今週 ${curRec.formVideos || 0}/${FORM_MAX}本` : '—'}</span></td></tr>
        <tr><th>食事記録の確認<small>週3日分</small></th>
          <td><span class="st num">${curRec ? `今週 ${curRec.mealDays || 0}/${MEAL_TARGET}日` : '—'}</span></td></tr>
        <tr class="${st.missRep ? 'behind' : ''}"><th>週間レポート<small>週1回（振り返りと改善提案）</small></th>
          <td><span class="st num">${st.rep}/12回</span>${st.missRep ? `<br><span class="small">未送付 ${st.missRep}週</span>` : ''}</td></tr>
        <tr><th>LINEサポート<small>原則2営業日以内に返信</small></th>
          <td><span class="muted small">日曜・祝日は返信なし（表示のみ）</span></td></tr>
        <tr class="${finalMiss ? 'behind' : ''}"><th>最終評価<small>12週目</small></th>
          <td><span class="st">${c.finalDone ? '済 ' + mdwS(c.finalDone) : '予定 ' + mdw(finalDue)}</span></td></tr>
      </table>`;

    // 12週のタイムライン
    const rows = [['meeting', '面談'], ['checkin', 'チェックイン'], ['report', 'レポート'], ['eval', '評価']];
    let tl = '<div class="tl"><span></span>';
    for (let w = 1; w <= WEEKS; w++) {
      tl += `<button type="button" class="wkh num${s && s.cur === w ? ' cur' : ''}${sel === w ? ' sel' : ''}" data-act="selweek" data-w="${w}" aria-label="${w}週目を開く">${w}</button>`;
    }
    for (const [k, lab] of rows) {
      tl += `<span class="lab">${lab}</span>`;
      for (let w = 1; w <= WEEKS; w++) {
        const cs = s ? cellState(c, s, w, k) : (k === 'eval' && !EVALS.some((e) => e.week === w) ? 'none' : 'todo');
        tl += `<span class="c">${cs === 'none' ? '' : `<i class="dot ${cs}" title="${w}週目 ${lab}"></i>`}</span>`;
      }
    }
    tl += '</div>';

    $app.innerHTML = `
      ${topBar(san(c.name), '#/', `<a class="btn" href="#/edit/${encodeURIComponent(id)}">編集</a>`)}
      <section class="hero">
        <div class="row"><span class="name">${esc(san(c.name))}</span><span class="badge${c.status === ST.ACTIVE ? ' active' : ''}">${esc(c.status)}</span></div>
        <div class="muted num">${wkLabel}${s ? `　${md(s.start)}〜${md(s.end)}` : ''}</div>
        ${s && s.cur >= 1 ? `<div class="bar"><i style="width:${(Math.min(s.cur, WEEKS) / WEEKS * 100).toFixed(1)}%"></i></div>` : ''}
      </section>

      <section class="panel">
        <h2>12週のタイムライン <span class="muted small">週をタップで記録</span></h2>
        ${tl}
        <div class="legend"><span><i class="dot done"></i>済</span><span><i class="dot miss"></i>遅れ</span><span><i class="dot todo"></i>これから</span></div>
      </section>

      <section class="panel">
        <h2>約束の達成状況</h2>
        ${promises}
      </section>

      <section class="panel" id="weekPanel">${weekForm(c, s, sel)}</section>

      <section class="panel">
        <h2>推移 <span class="muted small">週平均体重・スコア</span></h2>
        <div class="chart-box"><canvas id="chart" aria-label="週平均体重とスコアの推移"></canvas></div>
        <div id="chartMsg" class="muted small"></div>
      </section>

      ${s && (s.cur >= 11 || c.finalDone || c.finalPlan) ? finalPanel(c, s) : ''}

      <section class="panel">
        <h2>基本情報 <a class="btn tiny" href="#/edit/${encodeURIComponent(id)}">編集</a></h2>
        <dl class="kv">
          <dt>LINE名</dt><dd>${esc(c.lineName || '—')}</dd>
          <dt>目標</dt><dd>${esc(c.goal || '—')}</dd>
          <dt>開始日</dt><dd class="num">${c.startDate ? mdwS(c.startDate) + ' ' + c.startDate.slice(0, 4) : '—'}</dd>
          <dt>入金確認日</dt><dd class="num">${c.paidDate ? mdwS(c.paidDate) + ' ' + c.paidDate.slice(0, 4) : '未確認'}</dd>
          <dt>終了予定日</dt><dd class="num">${s ? mdw(s.end) + ' ' + s.end.getFullYear() : '—'}</dd>
          <dt>チェックイン</dt><dd>${dowName(c.checkinDow)}</dd>
          <dt>面談曜日</dt><dd>${dowName(c.meetingDow)}</dd>
          <dt>メモ</dt><dd>${esc(c.memo || '—')}</dd>
        </dl>
      </section>
    `;
    bindWeekForm(c, s, sel);
    drawChart(c);
  }

  function weekForm(c, s, w) {
    const r = rec(c.id, w) || {};
    const range = s ? `${md(weekStart(s, w))}〜${md(weekEnd(s, w))}` : '';
    const ci = s ? dowInWeek(s, w, c.checkinDow) : null;
    const weights = (r.weights || []).slice();
    while (weights.length < 3) weights.push('');
    const checks = (r.checks || '').padEnd(7, '0');
    let tabs = '';
    for (let i = 1; i <= WEEKS; i++) {
      tabs += `<button type="button" class="num${i === w ? ' sel' : ''}${s && s.cur === i ? ' cur' : ''}" data-act="selweek" data-w="${i}">${i}週</button>`;
    }
    return `
      <h2>週の記録 <span class="muted small num">${range}</span></h2>
      <div class="week-tabs" id="weekTabs">${tabs}</div>
      <form id="weekForm" novalidate>
        <label class="toggle"><input type="checkbox" name="checkinDone"${r.checkinDone ? ' checked' : ''}>
          <span>チェックインを受け取った${ci ? `<span class="muted small">（予定 ${mdw(ci)}）</span>` : ''}</span></label>

        <div class="field">
          <span class="lbl">体重（kg）</span>
          <div class="weights" id="weights">${weights.map((v) => `<input type="number" inputmode="decimal" step="0.1" min="20" max="400" value="${esc(v)}" aria-label="体重">`).join('')}</div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
            <span class="avg">週平均 <b class="num" id="avg">—</b></span>
            <button class="btn tiny" type="button" data-act="addweight">＋ 入力欄</button>
          </div>
        </div>

        <div class="field">
          <span class="lbl">チェックシート（毎週5分｜身体づくりチェックシート）</span>
          <div class="checklist">
            ${CHECK_ITEMS.map((txt, i) => `<label class="check"><input type="checkbox" name="ck${i}"${checks[i] === '1' ? ' checked' : ''}><span>${i + 1}. ${txt}</span></label>`).join('')}
          </div>
          <div class="score" id="score"></div>
        </div>

        <div class="field">
          <label for="meetingDate">面談実施日</label>
          <input type="date" id="meetingDate" name="meetingDate" value="${esc(r.meetingDate || '')}">
        </div>

        <div class="grid2">
          <div class="field">
            <span class="lbl">フォーム添削（上限${FORM_MAX}本）</span>
            <div class="stepper" data-name="formVideos" data-max="${FORM_MAX}">
              <button type="button" data-act="step" data-d="-1" aria-label="減らす">−</button>
              <output class="num">${r.formVideos || 0}</output>
              <button type="button" data-act="step" data-d="1" aria-label="増やす">＋</button>
            </div>
          </div>
          <div class="field">
            <span class="lbl">食事記録の確認（目安${MEAL_TARGET}日）</span>
            <div class="stepper" data-name="mealDays" data-max="7">
              <button type="button" data-act="step" data-d="-1" aria-label="減らす">−</button>
              <output class="num">${r.mealDays || 0}</output>
              <button type="button" data-act="step" data-d="1" aria-label="増やす">＋</button>
            </div>
          </div>
        </div>

        <div class="field">
          <label class="toggle"><input type="checkbox" name="reportSent"${r.reportSent ? ' checked' : ''}><span>週間レポートを送付した</span></label>
        </div>

        <div class="field">
          <label for="wmemo">メモ</label>
          <textarea id="wmemo" name="memo" rows="3">${esc(r.memo || '')}</textarea>
        </div>

        <div class="actions"><button class="btn primary block" type="submit">${w}週目を保存</button></div>
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
      sc.innerHTML = `<span>スコア <b class="num">${n}/7</b></span><b>${scoreLabel(n)}</b>`;
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
      const out = (name) => Number(f.querySelector(`.stepper[data-name="${name}"] output`).textContent) || 0;
      const patch = {
        weights: readWeights(),
        checkinDone: f.checkinDone.checked,
        meetingDate: f.meetingDate.value || '',
        formVideos: out('formVideos'),
        mealDays: out('mealDays'),
        reportSent: f.reportSent.checked,
        memo: f.memo.value,
      };
      if (checksTouched) patch.checks = CHECK_ITEMS.map((_, i) => (f['ck' + i].checked ? '1' : '0')).join('');
      try {
        await patchWeek(c.id, w, patch);
        toast(`${w}週目を保存しました`);
        state.dirty = false;
        const y = window.scrollY;
        render();
        window.scrollTo(0, y);
      } catch (_) {
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  function finalPanel(c, s) {
    const recs = [];
    for (let w = 1; w <= WEEKS; w++) recs.push(rec(c.id, w));
    const withW = recs.map((r, i) => ({ w: i + 1, v: avgW(r) })).filter((x) => x.v != null);
    const withS = recs.map((r) => scoreOf(r)).filter((x) => x != null);
    const first = withW[0];
    const lastW = withW[withW.length - 1];
    const diff = first && lastW && lastW.w !== first.w ? lastW.v - first.v : null;
    const avgS = withS.length ? withS.reduce((a, b) => a + b, 0) / withS.length : null;
    return `
      <section class="panel">
        <h2>最終評価 <span class="muted small">12週の変化と今後の計画</span></h2>
        <div class="final-sum">
          <div><span>週平均体重</span><b class="num">${first ? kg(first.v) : '—'}</b><span class="num">${first ? first.w + '週 → ' + (lastW ? lastW.w + '週 ' + kg(lastW.v) : '') : ''}</span></div>
          <div><span>変化</span><b class="num">${diff == null ? '—' : (diff > 0 ? '+' : '') + diff.toFixed(1) + 'kg'}</b></div>
          <div><span>平均スコア</span><b class="num">${avgS == null ? '—' : avgS.toFixed(1) + '/7'}</b><span>${withS.length}週分</span></div>
        </div>
        <form id="finalForm">
          <div class="field" style="margin-top:0">
            <label for="finalPlan">今後の計画（継続の相談内容も）</label>
            <textarea id="finalPlan" name="finalPlan" rows="4">${esc(c.finalPlan || '')}</textarea>
          </div>
          <div class="field">
            <label for="finalDone">最終評価の実施日</label>
            <input type="date" id="finalDone" name="finalDone" value="${esc(c.finalDone || '')}">
            <div class="hint">終了予定日：${mdw(s.end)}</div>
          </div>
          <div class="field"><button class="btn primary block" type="submit">最終評価を保存</button></div>
        </form>
      </section>`;
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
      if (msg) msg.textContent = '記録が入るとグラフが表示されます。';
      const box = document.querySelector('.chart-box'); if (box) box.style.height = '0';
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
          { type: 'line', label: '週平均体重（kg）', data: wt, yAxisID: 'y', borderColor: v('--primary'), backgroundColor: v('--primary'),
            spanGaps: true, tension: 0.25, pointRadius: 3, borderWidth: 2, order: 1 },
          { type: 'bar', label: 'スコア（/7）', data: sc, yAxisID: 'y1', backgroundColor: v('--dot-empty'), borderRadius: 4, maxBarThickness: 18, order: 2 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: v('--muted'), boxWidth: 12, font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: v('--muted'), font: { size: 10 } }, grid: { display: false } },
          y: { position: 'left', ticks: { color: v('--muted'), font: { size: 10 } }, grid: { color: v('--line') } },
          y1: { position: 'right', min: 0, max: 7, ticks: { stepSize: 1, color: v('--muted'), font: { size: 10 } }, grid: { display: false } },
        },
      },
    });
  }

  // ================================================================ 画面3：追加・編集

  function renderEdit(id) {
    const c = id ? state.clients.find((x) => x.id === id) : null;
    if (id && !c) { location.hash = '#/'; return; }
    const v = c || { name: '', lineName: '', startDate: '', checkinDow: '', meetingDow: '', goal: '', paidDate: '', status: ST.WAIT, memo: '' };
    const dowOpts = (sel) => `<option value="">未設定</option>` +
      DOW.map((d, i) => `<option value="${i}"${String(sel) === String(i) ? ' selected' : ''}>${d}曜</option>`).join('');

    $app.innerHTML = `
      ${topBar(c ? san(c.name) + 'を編集' : 'お客様を追加', c ? '#/c/' + encodeURIComponent(c.id) : '#/')}
      <form id="editForm" novalidate>
        <div class="field"><label for="f-name">名前（必須）</label><input type="text" id="f-name" name="name" required value="${esc(v.name)}" autocomplete="off"></div>
        <div class="field"><label for="f-line">LINE名</label><input type="text" id="f-line" name="lineName" value="${esc(v.lineName)}" autocomplete="off"></div>
        <div class="grid2">
          <div class="field"><label for="f-paid">入金確認日</label><input type="date" id="f-paid" name="paidDate" value="${esc(v.paidDate)}"></div>
          <div class="field"><label for="f-start">開始日</label><input type="date" id="f-start" name="startDate" value="${esc(v.startDate)}"></div>
        </div>
        <div class="hint muted small" id="endHint"></div>
        <div class="grid2">
          <div class="field"><label for="f-ci">チェックイン曜日</label><select id="f-ci" name="checkinDow">${dowOpts(v.checkinDow)}</select></div>
          <div class="field"><label for="f-mt">面談曜日（任意）</label><select id="f-mt" name="meetingDow">${dowOpts(v.meetingDow)}</select></div>
        </div>
        <div class="field"><label for="f-goal">目標</label><textarea id="f-goal" name="goal" rows="2">${esc(v.goal)}</textarea></div>
        <div class="field"><label for="f-st">状態</label>
          <select id="f-st" name="status">${STATUSES.map((s) => `<option${s === v.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="field"><label for="f-memo">メモ</label><textarea id="f-memo" name="memo" rows="3">${esc(v.memo)}</textarea></div>
        <div id="editErr"></div>
        <div class="actions"><button class="btn primary block" type="submit">${c ? '保存' : '追加する'}</button></div>
      </form>

      <div class="plan">
        <b>プラン</b>　3ヶ月（12週）／完全オンライン／30万円（税込33万円）<br>
        支払い：銀行振込。入金確認後に開始／初回カウンセリング60分<br>
        3ヶ月以降の継続：個別相談
      </div>

      ${c ? `<div class="field" style="margin-top:28px"><button class="btn danger-quiet block" type="button" data-act="delete" data-id="${esc(c.id)}">このお客様を削除</button></div>` : ''}
    `;

    const f = document.getElementById('editForm');
    const endHint = () => {
      const st = pd(f.startDate.value);
      document.getElementById('endHint').textContent = st
        ? `終了予定日：${mdw(addDays(st, WEEKS * 7 - 1))} ${addDays(st, WEEKS * 7 - 1).getFullYear()}（12週）`
        : '開始日を入れると終了予定日を自動で出します。';
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
        name, lineName: f.lineName.value.trim(), paidDate: f.paidDate.value, startDate: f.startDate.value,
        checkinDow: f.checkinDow.value, meetingDow: f.meetingDow.value, goal: f.goal.value, status: f.status.value, memo: f.memo.value,
      };
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        const d = await api('saveClient', { client: c ? Object.assign({ id: c.id }, data) : data });
        const i = state.clients.findIndex((x) => x.id === d.client.id);
        if (i >= 0) state.clients[i] = d.client; else state.clients.push(d.client);
        saveCache();
        state.dirty = false;
        toast(c ? '保存しました' : '追加しました');
        location.hash = '#/c/' + encodeURIComponent(d.client.id);
      } catch (ex) {
        err.innerHTML = `<div class="err">${esc(errText(ex))}</div>`;
        btn.disabled = false; btn.textContent = c ? '保存' : '追加する';
      }
    });
  }

  // ================================================================ イベント

  $app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const cid = decodeURIComponent((location.hash.split('/')[2] || ''));

    if (act === 'refresh') return refresh({ force: true });
    if (act === 'logout') { if (confirm('ログアウトしますか？')) logout(); return; }
    if (act === 'done' || act === 'go') {
      const task = state.tasks[el.dataset.tid];
      if (!task) return;
      if (act === 'go') { location.hash = task.href; return; }
      return onTaskDone(task, el.closest('.task'));
    }
    if (act === 'selweek') {
      state.selWeek[cid] = Number(el.dataset.w);
      const c = state.clients.find((x) => x.id === cid);
      const s = c && sched(c);
      document.querySelectorAll('.tl .wkh').forEach((b) => b.classList.toggle('sel', Number(b.dataset.w) === state.selWeek[cid]));
      const panel = document.getElementById('weekPanel');
      panel.innerHTML = weekForm(c, s, state.selWeek[cid]);
      bindWeekForm(c, s, state.selWeek[cid]);
      if (el.classList.contains('wkh')) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const tab = panel.querySelector('.week-tabs .sel');
      if (tab) tab.scrollIntoView({ block: 'nearest', inline: 'center' });
      return;
    }
    if (act === 'addweight') {
      const box = document.getElementById('weights');
      const i = document.createElement('input');
      Object.assign(i, { type: 'number', step: '0.1', min: '20', max: '400' });
      i.setAttribute('inputmode', 'decimal'); i.setAttribute('aria-label', '体重');
      box.appendChild(i); i.focus();
      return;
    }
    if (act === 'step') {
      const st = el.closest('.stepper');
      const o = st.querySelector('output');
      o.textContent = Math.max(0, Math.min(Number(st.dataset.max), (Number(o.textContent) || 0) + Number(el.dataset.d)));
      state.dirty = true;
      return;
    }
    if (act === 'evaldone') {
      el.disabled = true;
      try { await patchClient(cid, { [el.dataset.key]: fd(today()) }); toast('身体評価を「済」にしました'); } catch (_) { /* toast 済 */ }
      return render();
    }
    if (act === 'delete') {
      const c = state.clients.find((x) => x.id === el.dataset.id);
      if (!c || !confirm(`${san(c.name)}のデータ（週の記録も含む）を削除します。元に戻せません。よろしいですか？`)) return;
      el.disabled = true;
      try {
        await api('deleteClient', { id: c.id });
        state.clients = state.clients.filter((x) => x.id !== c.id);
        delete state.weeks[c.id];
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
      try { await patchClient(cid, { [el.dataset.key]: el.value || '' }); toast(el.value ? '実施日を更新しました' : '実施日を消しました'); } catch (_) { /* toast 済 */ }
      render();
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
      state.dirty = false;
      const y = window.scrollY; render(); window.scrollTo(0, y);
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
