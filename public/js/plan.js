(function () {
  'use strict';

  // お客様アプリ：/app.html#<鍵>（チェックインと同じリンクの鍵）
  // 中身は管理側がこのページの「編集」から書き換え、サーバーに保存する（パスワードはサーバーで照合）。

  const API_URL = '/api';
  const $app = document.getElementById('app');
  const key = location.hash.replace(/^#/, '').split('/')[0];
  const DONE_KEY = (d) => `hk_done_${key}_${d}_${new Date().toISOString().slice(0, 10)}`;
  let data = null;
  let tab = 'train';
  let dayIdx = 0;
  let password = null; // 編集中だけメモリに持つ

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* なくても動く */ } }

  async function api(action, payload) {
    let res;
    try {
      res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action, key }, payload || {})), credentials: 'omit', cache: 'no-store' });
    } catch (_) { throw new Error('network'); }
    let d; try { d = await res.json(); } catch (_) { throw new Error('network'); }
    if (!d.ok) throw new Error(d.error || 'server');
    return d;
  }
  const errText = (e) => ({
    invalid_link: 'このリンクは使えません。お手数ですが、畠山にLINEでお知らせください。',
    network: '通信できませんでした。電波の良いところで、もう一度お試しください。',
    bad_password: 'パスワードが違います。',
    locked: '失敗が続いたため、15分ほど時間をおいてください。',
  }[e && e.message] || 'エラーが発生しました。時間をおいてもう一度お試しください。');

  let toastT = null;
  function toast(msg) { const el = document.getElementById('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 3000); }

  const IC = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14M8 8v8M16 8v8M3 10v4M21 10v4"/></svg>',
    train: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M8 8v8M16 8v8M3 10v4M21 10v4"/></svg>',
    diet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 21V3c-2 1-3 4-3 7h3"/></svg>',
    cardio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>',
    policy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8" fill="currentColor"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8.5 12.3 2.4 2.4 4.6-5"/></svg>',
    play: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  };

  // ================================================================ 表示

  function applyAccent(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
    const r = document.documentElement.style;
    r.setProperty('--accent', hex);
    r.setProperty('--accent-bright', `color-mix(in srgb, ${hex} 70%, white)`);
    r.setProperty('--accent-deep', `color-mix(in srgb, ${hex} 70%, black)`);
  }

  function tabsOf(p) {
    const t = [];
    if (p && p.days && p.days.length) t.push(['train', 'トレーニング', IC.train]);
    if (p && p.diet && p.diet.length) t.push(['diet', '食事', IC.diet]);
    if (p && p.cardio && p.cardio.length) t.push(['cardio', '有酸素', IC.cardio]);
    if (p && p.policy && p.policy.length) t.push(['policy', '方針', IC.policy]);
    return t;
  }

  /** 文章：行頭が「・」の行は箇条書きにする */
  function textBlock(body) {
    const lines = String(body || '').split('\n');
    const out = [];
    let ul = [];
    const flush = () => { if (ul.length) { out.push(`<ul>${ul.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`); ul = []; } };
    for (const l of lines) {
      const m = /^\s*[・•\-]\s*(.+)$/.exec(l);
      if (m) ul.push(m[1]);
      else { flush(); if (l.trim()) out.push(`<p>${esc(l)}</p>`); }
    }
    flush();
    return out.join('');
  }

  function render() {
    const p = data.plan;
    applyAccent(p && p.accent);
    const tabs = tabsOf(p);
    if (tabs.length && !tabs.some((t) => t[0] === tab)) tab = tabs[0][0];
    document.title = (p && p.title) || `${data.name}様のプラン`;
    let body = '';
    if (!tabs.length) {
      body = '<div class="empty">プランは準備中です。<br>できあがったら、このページに表示されます。</div>';
    } else if (tab === 'train') {
      const days = p.days;
      if (dayIdx >= days.length) dayIdx = 0;
      const d = days[dayIdx];
      let done = [];
      try { done = JSON.parse(lsGet(DONE_KEY(dayIdx)) || '[]'); } catch (_) { done = []; }
      const n = d.exercises.length;
      const k = d.exercises.filter((_, i) => done.includes(i)).length;
      body = `
        <div class="days" style="grid-template-columns:repeat(${Math.min(days.length, 5)},1fr)">${days.map((x, i) =>
          `<button type="button" class="day${i === dayIdx ? ' on' : ''}" data-day="${i}"><b>${esc(x.name || 'Day' + (i + 1))}</b><span>${esc(x.focus || '')}</span></button>`).join('')}</div>
        <div class="meta"><div class="f">${esc([d.name, d.focus].filter(Boolean).join('（') + (d.focus && d.name ? '）' : ''))}<small>${n}種目</small></div>
          <div class="prog"><b>${k}/${n}</b><small>完了</small><div class="bar"><i style="width:${n ? (k / n * 100).toFixed(0) : 0}%"></i></div></div></div>
        <div class="list">${d.exercises.map((e, i) => `
          <article class="ex${done.includes(i) ? ' done' : ''}">
            <div class="ex-top"><button type="button" class="num" data-ex="${i}" aria-label="${i + 1}番目を${done.includes(i) ? '未完了' : '完了'}にする">${done.includes(i) ? '✓' : i + 1}</button>
              <div><h3>${esc(e.name)}</h3>${e.note ? `<span class="tag">${esc(e.note)}</span>` : ''}</div></div>
            ${e.sets.length ? `<div class="sets">${e.sets.map((s, j) => `<div class="set"><span>${j + 1}</span><span>${esc(s)}</span></div>`).join('')}</div>` : ''}
            ${e.video ? `<a class="vbtn" href="${esc(e.video)}" target="_blank" rel="noopener noreferrer">${IC.play}動画を見る</a>` : ''}
            ${e.tip ? `<p class="tip"><b>ポイント</b>${esc(e.tip)}</p>` : ''}
          </article>`).join('')}</div>
        <p class="foot">番号をタップすると「完了」になります（その日のうちだけ記録）。</p>`;
    } else {
      body = (p[tab] || []).map((b) => `<section class="blk">${b.title ? `<h2>${esc(b.title)}</h2>` : ''}${textBlock(b.body)}</section>`).join('');
    }
    $app.innerHTML = `
      <div class="wrap">
        <header class="hd"><span class="brand">${IC.logo}HATAKEYAMA <b>COACHING</b></span>
          <h1>${esc((p && p.title) || `${data.name}様のプラン`)}</h1>${p && p.subtitle ? `<p>${esc(p.subtitle)}</p>` : ''}</header>
        ${body}
        <p class="foot"><button type="button" data-act="edit">編集（コーチ用）</button></p>
      </div>
      <nav class="bn">${tabs.map(([k, l, ic]) => `<button type="button" class="${tab === k ? 'on' : ''}" data-tab="${k}">${ic}<span>${l}</span></button>`).join('')}
        <a href="/form.html#${esc(key)}">${IC.check}<span>チェックイン</span></a></nav>`;
  }

  $app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab],[data-day],[data-ex],[data-act]');
    if (!t) return;
    if (t.dataset.tab) { tab = t.dataset.tab; render(); window.scrollTo(0, 0); return; }
    if (t.dataset.day) { dayIdx = Number(t.dataset.day); render(); return; }
    if (t.dataset.ex) {
      let done = [];
      try { done = JSON.parse(lsGet(DONE_KEY(dayIdx)) || '[]'); } catch (_) { done = []; }
      const i = Number(t.dataset.ex);
      done = done.includes(i) ? done.filter((x) => x !== i) : [...done, i];
      lsSet(DONE_KEY(dayIdx), JSON.stringify(done));
      const y = window.scrollY; render(); window.scrollTo(0, y);
      return;
    }
    if (t.dataset.act === 'edit') askPassword();
  });

  // ================================================================ 編集（コーチ用）

  function askPassword() {
    if (password) return openEditor();
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<form><h2>編集</h2><p>コーチ用のパスワードを入れてください。</p>
      <input type="password" name="pw" autocomplete="current-password" aria-label="パスワード">
      <div class="err" hidden></div>
      <div class="row"><button type="button" class="b" data-c>キャンセル</button><button class="b p" type="submit">開く</button></div></form>`;
    document.body.appendChild(m);
    const f = m.querySelector('form');
    f.pw.focus();
    m.querySelector('[data-c]').onclick = () => m.remove();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const er = m.querySelector('.err');
      try {
        await api('planSave', { password: f.pw.value });
        password = f.pw.value;
        m.remove();
        openEditor();
      } catch (ex) { er.hidden = false; er.textContent = errText(ex); }
    };
  }

  let draft = null;
  const blank = () => ({ title: '', subtitle: '', accent: '#e0ad74', days: [], diet: [], cardio: [], policy: [] });

  function openEditor() {
    draft = JSON.parse(JSON.stringify(data.plan || blank()));
    for (const k of ['days', 'diet', 'cardio', 'policy']) draft[k] = draft[k] || [];
    let ed = document.querySelector('.ed');
    if (!ed) { ed = document.createElement('div'); ed.className = 'ed'; document.body.appendChild(ed); }
    drawEditor();
  }

  const fld = (label, path, val, type) => `<label>${label}</label>${type === 'area'
    ? `<textarea data-p="${path}" rows="4">${esc(val)}</textarea>` : `<input type="${type || 'text'}" data-p="${path}" value="${esc(val)}">`}`;

  function drawEditor() {
    const ed = document.querySelector('.ed');
    const blocks = (k, title) => `<h3>${title}</h3>${draft[k].map((b, i) => `<div class="box">
        ${fld('見出し', `${k}.${i}.title`, b.title)}${fld('本文（行頭に「・」で箇条書き）', `${k}.${i}.body`, b.body, 'area')}
        <button type="button" class="b x w" data-del="${k}.${i}">このブロックを削除</button></div>`).join('')}
      <button type="button" class="b w" data-add="${k}">＋ ${title}のブロックを追加</button>`;
    ed.innerHTML = `
      <div class="ed-bar"><button type="button" class="b" data-close>閉じる</button><b>編集</b><button type="button" class="b p" data-save>保存</button></div>
      <div class="ed-in">
        <h3>基本</h3><div class="box">
          ${fld('タイトル（空なら「○○様のプラン」）', 'title', draft.title)}
          ${fld('サブタイトル', 'subtitle', draft.subtitle, 'area')}
          <label>アクセントの色</label><input type="color" data-p="accent" value="${esc(draft.accent || '#e0ad74')}">
        </div>

        <h3>テキストから取り込む</h3><div class="box">
          <textarea id="importText" rows="6" placeholder="Day1 (Push)&#10;・チェストプレス（胸）&#10;40kgx8回&#10;47kgx8回"></textarea>
          <p class="hint">LINEで送るときの書き方をそのまま貼り付けると、トレーニングの日と種目に分けます。「Day1 (Push)」の行が日、「・」の行が種目、その下の「40kgx8回」などがセットです。それ以外の行は「方針」に入ります。</p>
          <button type="button" class="b w" data-import>取り込む（トレーニングを置き換え）</button>
        </div>

        <h3>トレーニング</h3>
        ${draft.days.map((d, i) => `<div class="box">
          <div class="row"><div style="flex:1">${fld('日の名前', `days.${i}.name`, d.name)}</div><div style="flex:1">${fld('内容', `days.${i}.focus`, d.focus)}</div></div>
          ${d.exercises.map((e, j) => `<div class="box">
            ${fld(`種目 ${j + 1}`, `days.${i}.exercises.${j}.name`, e.name)}
            ${fld('メモ（部位など）', `days.${i}.exercises.${j}.note`, e.note)}
            ${fld('セット（1行に1セット）', `days.${i}.exercises.${j}.sets`, (e.sets || []).join('\n'), 'area')}
            ${fld('動画のURL（任意）', `days.${i}.exercises.${j}.video`, e.video, 'url')}
            ${fld('ポイント（任意）', `days.${i}.exercises.${j}.tip`, e.tip, 'area')}
            <button type="button" class="b x w" data-del="days.${i}.exercises.${j}">この種目を削除</button></div>`).join('')}
          <button type="button" class="b w" data-add="days.${i}.exercises">＋ 種目を追加</button>
          <button type="button" class="b x w" data-del="days.${i}">この日を削除</button></div>`).join('')}
        <button type="button" class="b w" data-add="days">＋ 日を追加</button>

        ${blocks('diet', '食事')}
        ${blocks('cardio', '有酸素')}
        ${blocks('policy', '方針')}
        <p class="hint">中身のない項目はお客様の画面に出ません。保存すると、お客様のページにすぐ反映されます。</p>
        <button type="button" class="b p w" data-save style="min-height:50px">保存</button>
      </div>`;
  }

  /** 画面の入力を draft に戻す */
  function collect() {
    document.querySelectorAll('.ed [data-p]').forEach((el) => {
      const path = el.dataset.p.split('.');
      let o = draft;
      for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
      const k = path[path.length - 1];
      o[k] = k === 'sets' ? el.value.split('\n').map((x) => x.trim()).filter(Boolean) : el.value;
    });
  }
  const at = (path) => path.split('.').reduce((o, k) => o[k], draft);

  /** LINE の書き方からトレーニングを作る */
  function parseText(text) {
    const days = [], notes = { policy: [], diet: [], cardio: [] };
    const SEC = { 方針: 'policy', 目標: 'policy', 食事: 'diet', 有酸素: 'cardio' };
    let day = null, ex = null, sec = null;
    const norm = (s) => s.replace(/[•・]/g, ' ').replace(/\s*[xX×✕]\s*/g, ' × ').replace(/(\d+)\s*set(s)?/i, '$1セット').replace(/\s+/g, ' ').replace(/^ × /, '').trim()
      .replace(/kg × (\d+)(?= ×|$)/, 'kg × $1回');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const h = /^[【(（\[]\s*(方針|目標|食事|有酸素)\s*[】)）\]]$/.exec(line);
      if (h) { sec = SEC[h[1]]; day = null; ex = null; continue; }
      let m = /^((?:day|DAY|Day)\s*\d+|\d+日目)\s*(?:[（(]\s*([^）)]*?)\s*[）)])?\s*(.*)$/.exec(line);
      if (m) { day = { name: m[1].replace(/\s+/g, ''), focus: (m[2] || m[3] || '').trim(), exercises: [] }; days.push(day); ex = null; sec = null; continue; }
      m = /^[・･•\-*]\s*(.+)$/.exec(line);
      if (m && day) {
        let name = m[1].trim(), note = '';
        const n = /^(.*?)\s*[（(]([^）)]*)[）)]\s*$/.exec(name);
        if (n) { name = n[1].trim(); note = n[2].trim(); }
        ex = { name, note, sets: [], video: '', tip: '' };
        day.exercises.push(ex);
        continue;
      }
      if (ex && /\d/.test(line) && /(kg|回|rep|set|セット|×|x|✕|秒|分)/i.test(line)) { ex.sets.push(norm(line)); continue; }
      day = null; ex = null;
      const to = sec || (/食|コンビニ|カロリー|タンパク|間食|外食/.test(line) ? 'diet' : /有酸素|ウォーキング|ランニング|歩/.test(line) ? 'cardio' : 'policy');
      notes[to].push(line.replace(/^[・•\-]\s*/, ''));
    }
    return { days, notes };
  }

  document.addEventListener('click', async (e) => {
    const ed = document.querySelector('.ed');
    if (!ed || !ed.contains(e.target)) return;
    const t = e.target.closest('[data-close],[data-save],[data-add],[data-del],[data-import]');
    if (!t) return;
    if (t.hasAttribute('data-close')) { if (confirm('保存していない変更は消えます。閉じますか？')) ed.remove(); return; }
    collect();
    if (t.dataset.add) {
      const list = at(t.dataset.add);
      if (t.dataset.add === 'days') list.push({ name: `Day${list.length + 1}`, focus: '', exercises: [] });
      else if (t.dataset.add.endsWith('exercises')) list.push({ name: '', note: '', sets: [], video: '', tip: '' });
      else list.push({ title: '', body: '' });
      const y = ed.scrollTop; drawEditor(); ed.scrollTop = y;
      return;
    }
    if (t.dataset.del) {
      if (!confirm('削除しますか？')) return;
      const parts = t.dataset.del.split('.');
      const idx = Number(parts.pop());
      at(parts.join('.')).splice(idx, 1);
      const y = ed.scrollTop; drawEditor(); ed.scrollTop = y;
      return;
    }
    if (t.hasAttribute('data-import')) {
      const text = document.getElementById('importText').value;
      const r = parseText(text);
      if (!r.days.length) { toast('「Day1」などの行が見つかりませんでした'); return; }
      if (draft.days.length && !confirm(`トレーニングを${r.days.length}日分で置き換えます。よろしいですか？`)) return;
      draft.days = r.days;
      const T = { policy: '方針', diet: '今の食事', cardio: '有酸素' };
      for (const k of ['policy', 'diet', 'cardio']) if (r.notes[k].length) draft[k].push({ title: T[k], body: r.notes[k].map((x) => '・' + x).join('\n') });
      drawEditor();
      toast(`${r.days.length}日・${r.days.reduce((n, d) => n + d.exercises.length, 0)}種目を取り込みました`);
      return;
    }
    if (t.hasAttribute('data-save')) {
      t.disabled = true;
      try {
        await api('planSave', { password, plan: draft });
        const d = await api('planGet');
        data = d;
        ed.remove();
        render();
        toast('保存しました。お客様のページにも反映されています');
      } catch (ex) {
        toast(errText(ex));
        if (ex.message === 'bad_password') password = null;
      } finally { t.disabled = false; }
    }
  });

  // ================================================================ 起動

  (async function boot() {
    if (!key) { $app.innerHTML = `<div class="wrap"><div class="empty">${errText({ message: 'invalid_link' })}</div></div>`; return; }
    try { data = await api('planGet'); } catch (e) { $app.innerHTML = `<div class="wrap"><div class="empty">${esc(errText(e))}</div></div>`; return; }
    render();
  })();
})();
