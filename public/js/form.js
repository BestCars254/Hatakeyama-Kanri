(function () {
  'use strict';

  // お客様用ページ：1つのリンクで「事前ヒアリング」→「毎週のチェックイン」
  // URL：/form.html#<鍵>（ヒアリングをやり直すときは #<鍵>/intake）

  const API_URL = '/api';
  const COACH = '畠山';
  const WEEKS = 12;
  const DOW = ['日', '月', '火', '水', '木', '金', '土'];
  const Q = window.INTAKE;
  const CHECK_ITEMS = window.CHECK_ITEMS;
  const $app = document.getElementById('app');
  const [key, mode] = location.hash.replace(/^#/, '').split('/');
  const DRAFT_KEY = 'hk_form_draft_' + key;
  let data = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* なくても動く */ } }

  function pd(s) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  const md = (d) => (d.getMonth() + 1) + '/' + d.getDate();
  const mdw = (d) => md(d) + '（' + DOW[d.getDay()] + '）';
  const scoreLabel = (n) => (n >= 5 ? '継続' : n >= 3 ? '1つだけ改善' : '計画をシンプルに');
  const scoreNote = (n) => (n >= 5 ? '今のやり方を続けましょう。' : n >= 3 ? '来週は1つだけ改善してみましょう。' : '計画をシンプルにして、できることから整えましょう。');

  async function api(action, payload) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action, key }, payload || {})), credentials: 'omit', cache: 'no-store',
      });
    } catch (_) { throw new Error('network'); }
    let d; try { d = await res.json(); } catch (_) { throw new Error('network'); }
    if (!d.ok) throw new Error(d.error || 'server');
    return d;
  }
  const errText = (e) => ({
    invalid_link: `このリンクは使えません。お手数ですが、${COACH}にLINEでお知らせください。`,
    network: '通信できませんでした。電波の良いところで、もう一度お試しください。',
    not_started: 'プログラムの開始前のため、まだチェックインは送れません。',
  }[e && e.message] || 'エラーが発生しました。時間をおいてもう一度お試しください。');

  function header(sub) {
    return `<header class="f-head"><div class="f-brand">${COACH}祐輔｜12週間オンラインコーチング</div>${sub ? `<h1>${esc(sub)}</h1>` : ''}</header>`;
  }
  function fatal(msg) { $app.innerHTML = header('') + `<div class="err" style="margin-top:24px">${esc(msg)}</div>`; }

  // ================================================================ 事前ヒアリング

  function qId(i, j) { return `q${i + 1}_${j + 1}`; }

  function renderIntake() {
    let saved = {};
    try { saved = JSON.parse(lsGet(DRAFT_KEY) || 'null') || data.intake || {}; } catch (_) { saved = data.intake || {}; }
    let no = 0;
    const field = (q, i, j) => {
      no++;
      const v = saved[q.id];
      const id = qId(i, j);
      const head = `<div class="f-q-head"><span class="f-no">${no}</span><span>${esc(q.label)} <span class="req">*</span></span></div>
        ${q.help ? `<p class="f-help">${esc(q.help)}</p>` : ''}${q.example ? `<p class="f-help">${esc(q.example)}</p>` : ''}`;
      let input;
      if (q.type === 'radio') {
        input = '<div class="f-opts">' + q.options.map((o) => {
          const label = typeof o === 'string' ? o : o.label;
          const val = typeof o === 'string' ? o : o.value;
          const on = v != null && String(v) === String(val) && (saved[q.id + '__label'] == null || saved[q.id + '__label'] === label);
          return `<label class="f-opt"><input type="radio" name="${q.id}" value="${esc(val)}" data-label="${esc(label)}"${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;
        }).join('') + '</div>';
      } else if (q.type === 'textarea') {
        input = `<textarea id="${id}" name="${q.id}" rows="3">${esc(v || '')}</textarea>`;
      } else if (q.type === 'number') {
        input = `<div class="f-unit"><input id="${id}" type="text" inputmode="decimal" name="${q.id}" value="${esc(v || '')}"><span>${esc(q.unit || '')}</span></div>`;
      } else {
        input = `<input id="${id}" type="text" name="${q.id}" value="${esc(v || '')}">`;
      }
      return `<div class="f-q" data-q="${q.id}">${head}${input}<div class="f-miss" hidden>この質問は必須です</div></div>`;
    };

    $app.innerHTML = `
      ${header(Q.title)}
      <section class="f-intro">
        <p>${esc(data.client.name)}さん、お申し込みありがとうございます。</p>
        ${Q.intro.map((p) => `<p>${esc(p)}</p>`).join('')}
        <p class="muted">${esc(Q.time)}</p>
        <p class="req-note"><span class="req">*</span> 必須の質問です</p>
      </section>
      <form id="intake" novalidate>
        ${Q.sections.map((sec, i) => `
          <section class="f-sec">
            <h2>${esc(sec.title)}</h2>
            ${sec.lead ? `<p class="f-lead">${esc(sec.lead)}</p>` : ''}
            ${sec.questions.map((q, j) => field(q, i, j)).join('')}
          </section>`).join('')}
        <div id="formErr"></div>
        <div class="actions"><button class="btn primary block" type="submit">送信する</button></div>
        <p class="f-help center">入力内容はこの端末に一時保存されます。途中で閉じても続きから入力できます。</p>
      </form>`;

    const f = document.getElementById('intake');
    const collect = () => {
      const out = {};
      for (const sec of Q.sections) for (const q of sec.questions) {
        if (q.type === 'radio') {
          const c = f.querySelector(`input[name="${q.id}"]:checked`);
          if (c) { out[q.id] = c.value; out[q.id + '__label'] = c.dataset.label; }
        } else {
          out[q.id] = f[q.id].value.trim();
        }
      }
      return out;
    };
    f.addEventListener('input', () => lsSet(DRAFT_KEY, JSON.stringify(collect())));
    f.addEventListener('change', () => lsSet(DRAFT_KEY, JSON.stringify(collect())));

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ans = collect();
      let first = null;
      for (const sec of Q.sections) for (const q of sec.questions) {
        const box = f.querySelector(`[data-q="${q.id}"]`);
        const missing = q.type === 'radio' ? !(q.id + '__label' in ans) : !ans[q.id];
        box.classList.toggle('missing', missing);
        box.querySelector('.f-miss').hidden = !missing;
        if (missing && !first) first = box;
      }
      if (first) {
        document.getElementById('formErr').innerHTML = '<div class="err">未入力の質問があります。決まっていない項目は「未定」、該当がない場合は「なし」とご記入ください。</div>';
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        await api('formIntake', { answers: ans });
        lsSet(DRAFT_KEY, null);
        data.client.intakeDone = true;
        data.intake = ans;
        renderThanks('ヒアリングを送信しました', [
          `ご回答ありがとうございます。${COACH}が確認して、初回カウンセリングで詳しくお話を伺います。`,
          'このページは、プログラム開始後の「毎週のチェックイン」にも使います。ブックマークやホーム画面への追加をしておくと便利です。',
        ]);
      } catch (ex) {
        document.getElementById('formErr').innerHTML = `<div class="err">${esc(errText(ex))}</div>`;
        btn.disabled = false; btn.textContent = '送信する';
      }
    });
  }

  function renderThanks(title, lines) {
    const canCheckin = data.currentWeek >= 1;
    $app.innerHTML = `
      ${header('')}
      <section class="f-done">
        <div class="f-check" aria-hidden="true"></div>
        <h1>${esc(title)}</h1>
        ${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
        ${canCheckin ? '<button class="btn primary block" type="button" id="toCheckin">チェックインの画面へ</button>' : ''}
      </section>`;
    const b = document.getElementById('toCheckin');
    if (b) b.onclick = () => { history.replaceState(null, '', '#' + key); renderCheckin(); window.scrollTo(0, 0); };
  }

  // ================================================================ 毎週のチェックイン

  const RATINGS = [['train', 'トレーニング'], ['diet', '食事'], ['sleep', '睡眠'], ['energy', '元気・やる気']];
  const SLOTS = [['front', '正面'], ['side', '横'], ['back', '後ろ']];
  const EVAL_WEEKS = [1, 4, 8, 12];

  /** 写真を端末で縮小して JPEG にする（長い辺 1280px） */
  async function compress(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      let q = 0.82, out = cv.toDataURL('image/jpeg', q);
      while (out.length > 1.9e6 && q > 0.4) { q -= 0.12; out = cv.toDataURL('image/jpeg', q); }
      return out;
    } finally { URL.revokeObjectURL(url); }
  }

  function renderCheckin(selWeek) {
    const c = data.client;
    const start = pd(c.startDate);
    const cur = data.currentWeek;
    const editLink = `<p class="f-help center"><a href="#${esc(key)}/intake" id="toIntake">ヒアリングの回答を見直す・修正する</a></p>`;

    if (!start || !cur) {
      $app.innerHTML = `${header('毎週のチェックイン')}
        <section class="f-intro"><p>${esc(c.name)}さん、ヒアリングへのご回答ありがとうございました。</p>
        <p>${start ? `プログラムは <b>${esc(mdw(start))}</b> から始まります。` : '開始日が決まりしだい、LINEでお知らせします。'}開始後は、このページから毎週のチェックインを送れます。</p></section>${editLink}`;
      bindIntakeLink();
      return;
    }
    const last = Math.min(cur, WEEKS);
    const w = selWeek || last;
    const ws = addDays(start, 7 * (w - 1));
    const we = addDays(ws, 6);
    const prev = data.weeks[w] || {};
    const weights = (prev.weights || []).slice();
    while (weights.length < 3) weights.push('');
    const checks = (prev.checks || '').padEnd(7, '0');
    const ratings = prev.ratings || {};
    const measures = prev.measures || {};
    const sentPhotos = prev.photos || [];
    const ciDow = c.checkinDow === '' || c.checkinDow == null ? null : Number(c.checkinDow);
    let no = 0;
    const q = (title, body, opt) => `<div class="f-q"${opt && opt.id ? ` data-q="${opt.id}"` : ''}>
      <div class="f-q-head"><span class="f-no">${++no}</span><span>${title}${opt && opt.req ? ' <span class="req">*</span>' : ''}</span></div>
      ${opt && opt.help ? `<p class="f-help">${opt.help}</p>` : ''}${body}${opt && opt.req ? `<div class="f-miss" hidden>${opt.miss || 'この質問は必須です'}</div>` : ''}</div>`;
    const stepper = (name, label, max, v) => `<div class="f-step"><span>${label}</span><span class="stp" data-name="${name}" data-max="${max}">
      <button type="button" data-d="-1" aria-label="減らす">−</button><output>${v || 0}</output><button type="button" data-d="1" aria-label="増やす">＋</button></span></div>`;

    const tabs = [];
    for (let i = Math.max(1, last - 1); i <= last; i++) tabs.push(`<button type="button" class="${i === w ? 'sel' : ''}" data-w="${i}">${i}週目${data.weeks[i] && data.weeks[i].submittedAt ? ' ✓' : ''}</button>`);

    $app.innerHTML = `
      ${header('毎週のチェックイン')}
      <section class="f-intro">
        <p>${esc(c.name)}さん、今週もおつかれさまです。</p>
        <p>${cur > WEEKS ? '12週間のプログラムは終了しました。最終週の記録はこちらから送れます。' : `今日は <b>12週間のうち${cur}週目</b> です。`}${ciDow != null && cur <= WEEKS ? `チェックインは毎週${DOW[ciDow]}曜日が目安です。` : ''}</p>
        <p class="muted">所要時間の目安：3分。体調以外は、分かる範囲で大丈夫です。</p>
      </section>
      <div class="week-tabs f-weeks">${tabs.join('')}</div>
      <form id="checkin" novalidate>
        <section class="f-sec">
          <h2>${w}週目（${md(ws)}〜${md(we)}）</h2>
          ${prev.submittedAt ? `<p class="f-sent">送信済み：${esc(new Date(prev.submittedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}　もう一度送ると上書きされます。</p>` : ''}

          ${q('今週測った体重', `<div class="weights" id="weights">${weights.map((v) => `<input type="text" inputmode="decimal" value="${esc(v)}" aria-label="体重（kg）" placeholder="kg">`).join('')}</div>
            <div class="f-row"><span class="avg">週平均 <b id="avg">—</b></span><button class="btn tiny" type="button" id="addW">＋ 入力欄</button></div>`,
            { help: '測った回数分を入力してください（例：月・木・日の3回）。週平均は自動で計算します。' })}

          ${q('体の写真（正面・横・後ろ）', `<div class="photos">${SLOTS.map(([k, l]) => `
              <label class="photo" data-slot="${k}"><input type="file" accept="image/*" data-slot="${k}" hidden>
                <span class="ph-img">${sentPhotos.includes(k) ? '<span class="ph-done">✓</span>' : '<span class="ph-plus">＋</span>'}</span>
                <span class="ph-l">${l}</span><span class="ph-s">${sentPhotos.includes(k) ? '保存済み・撮り直す' : 'タップして選ぶ'}</span></label>`).join('')}</div>`,
            { help: '同じ場所・同じ服で撮ると変化が分かりやすくなります。写真は畠山だけが見られます。任意です。' })}

          ${q('毎週5分｜身体づくりチェックシート', `<div class="checklist">
              ${CHECK_ITEMS.map((t, i) => `<label class="check"><input type="checkbox" name="ck${i}"${checks[i] === '1' ? ' checked' : ''}><span>${i + 1}. ${esc(t)}</span></label>`).join('')}
            </div><div class="score" id="score"></div>`, { help: '今週できたものにチェックしてください。' })}

          ${q('今週の自己評価', `<div class="rates">${RATINGS.map(([k, l]) => `<div class="rate"><span>${l}</span><span class="rate-b">${[1, 2, 3, 4, 5].map((n) =>
              `<label><input type="radio" name="r_${k}" value="${n}"${ratings[k] === n ? ' checked' : ''}><span>${n}</span></label>`).join('')}</span></div>`).join('')}</div>`,
            { help: '1＝よくなかった、5＝とても良かった' })}

          ${q('今週の回数', `${stepper('trainDays', 'トレーニングした日数', 7, prev.trainDays)}${stepper('mealsSent', 'LINEで送った食事記録（日）', 7, prev.mealsSent)}${stepper('videosSent', 'LINEで送ったフォーム動画（本）', 2, prev.videosSent)}`,
            { help: 'フォーム動画は週2本まで、食事記録は週3日分が目安です。' })}

          ${q('今週の体調', `<div class="f-opts f-inline">${['良い', '普通', 'いまいち'].map((o) => `<label class="f-opt"><input type="radio" name="condition" value="${o}"${prev.condition === o ? ' checked' : ''}><span>${o}</span></label>`).join('')}</div>`,
            { id: 'condition', req: true, miss: '体調を選んでください' })}

          ${EVAL_WEEKS.includes(w) ? q('サイズの測定（任意）', `<div class="meas">
              <label><span>ウエスト</span><input type="text" inputmode="decimal" name="m_waist" value="${esc(measures.waist || '')}"><em>cm</em></label>
              <label><span>ヒップ</span><input type="text" inputmode="decimal" name="m_hip" value="${esc(measures.hip || '')}"><em>cm</em></label>
              <label><span>体脂肪率</span><input type="text" inputmode="decimal" name="m_bodyFat" value="${esc(measures.bodyFat || '')}"><em>%</em></label></div>`,
            { help: `${w === 1 ? '開始時' : w + '週目'}の身体評価に使います。おへその高さで測ってください。` }) : ''}

          ${q('今週うまくいったこと', `<textarea name="clientWin" rows="3">${esc(prev.clientWin || '')}</textarea>`, { help: '例：外食の次の日にいつもの食事に戻せた。小さなことで構いません。' })}
          ${q(`困っていること・${COACH}への質問`, `<textarea name="clientNote" rows="3">${esc(prev.clientNote || '')}</textarea>`, { help: '週間レポートでお返事します。急ぎの内容はLINEでご連絡ください。' })}
          ${w < WEEKS ? q('来週の面談の希望日時', `<input type="text" name="nextMeeting" value="${esc(prev.nextMeeting || '')}" placeholder="例：火曜20時以降、水曜の昼">`, { help: '個別面談（60分）の日程調整に使います。' }) : ''}

          ${w >= 11 ? q('12週間をふり返って', `<textarea name="reflection" rows="4">${esc(prev.reflection || '')}</textarea>`, { help: '変わったこと、続けられたこと、これからも続けたいことなど。' })
            + q('12週間のあと、どうしたいですか？', `<div class="f-opts">${['続けたい', '相談したい', '今回で終了'].map((o) => `<label class="f-opt"><input type="radio" name="renewIntent" value="${o}"${prev.renewIntent === o ? ' checked' : ''}><span>${o}</span></label>`).join('')}</div>`,
              { help: '今の気持ちで大丈夫です。最終評価のときに一緒に決めましょう。' }) : ''}
        </section>
        <div id="formErr"></div>
        <div class="actions"><button class="btn primary block" type="submit">${w}週目のチェックインを送信</button></div>
      </form>
      ${editLink}`;

    const f = document.getElementById('checkin');
    const readWeights = () => [...f.querySelectorAll('#weights input')].map((i) => parseFloat(i.value.replace(/[^\d.]/g, ''))).filter((n) => isFinite(n) && n >= 20 && n <= 400);
    const update = () => {
      const ws2 = readWeights();
      document.getElementById('avg').textContent = ws2.length ? (ws2.reduce((a, b) => a + b, 0) / ws2.length).toFixed(1) + 'kg' : '—';
      const n = CHECK_ITEMS.filter((_, i) => f['ck' + i].checked).length;
      const sc = document.getElementById('score');
      sc.className = 'score lv' + (n >= 5 ? 1 : n >= 3 ? 2 : 3);
      sc.innerHTML = `<span><b>${n}/7</b>　${scoreNote(n)}</span><b>${scoreLabel(n)}</b>`;
    };
    f.addEventListener('input', update);
    update();
    document.getElementById('addW').onclick = () => {
      const i = document.createElement('input');
      Object.assign(i, { type: 'text', placeholder: 'kg' });
      i.setAttribute('inputmode', 'decimal'); i.setAttribute('aria-label', '体重（kg）');
      document.getElementById('weights').appendChild(i); i.focus();
    };
    f.querySelectorAll('.stp button').forEach((b) => {
      b.onclick = () => {
        const st = b.closest('.stp');
        const o = st.querySelector('output');
        o.textContent = Math.max(0, Math.min(Number(st.dataset.max), (Number(o.textContent) || 0) + Number(b.dataset.d)));
      };
    });
    // 写真：選んだらすぐ縮小して送る
    let uploading = 0;
    f.querySelectorAll('.photo input[type=file]').forEach((inp) => {
      inp.addEventListener('change', async () => {
        const file = inp.files && inp.files[0];
        if (!file) return;
        const box = inp.closest('.photo');
        const img = box.querySelector('.ph-img');
        const st = box.querySelector('.ph-s');
        const local = URL.createObjectURL(file);
        img.innerHTML = `<img src="${local}" alt="">`;
        st.textContent = '送信中…';
        box.classList.add('busy');
        uploading++;
        try {
          const dataUrl = await compress(file);
          await api('formPhoto', { week: w, slot: inp.dataset.slot, data: dataUrl });
          st.textContent = '保存しました ✓';
          box.classList.remove('busy'); box.classList.add('ok');
          const pw = data.weeks[w] = data.weeks[w] || {};
          pw.photos = [...new Set([...(pw.photos || []), inp.dataset.slot])];
        } catch (ex) {
          st.textContent = ex.message === 'network' ? '送れませんでした。もう一度タップ' : '送れませんでした';
          box.classList.remove('busy'); box.classList.add('ng');
        } finally { uploading--; }
      });
    });
    $app.querySelectorAll('.f-weeks button').forEach((b) => { b.onclick = () => renderCheckin(Number(b.dataset.w)); });
    bindIntakeLink();

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (uploading) { document.getElementById('formErr').innerHTML = '<div class="err">写真を送信中です。少し待ってからもう一度押してください。</div>'; return; }
      const cond = f.querySelector('input[name="condition"]:checked');
      const box = f.querySelector('[data-q="condition"]');
      box.classList.toggle('missing', !cond);
      box.querySelector('.f-miss').hidden = !!cond;
      if (!cond) { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      const val = (n) => { const el = f.querySelector(`input[name="${n}"]:checked`); return el ? Number(el.value) : undefined; };
      const out = (n) => Number(f.querySelector(`.stp[data-name="${n}"] output`).textContent) || 0;
      const num = (n) => { const el = f[n]; return el ? el.value.replace(/[^\d.]/g, '') : ''; };
      const ratingsOut = {};
      for (const [k] of RATINGS) { const v = val('r_' + k); if (v) ratingsOut[k] = v; }
      const checkin = {
        week: w,
        weights: readWeights(),
        checks: CHECK_ITEMS.map((_, i) => (f['ck' + i].checked ? '1' : '0')).join(''),
        condition: cond.value,
        ratings: ratingsOut,
        trainDays: out('trainDays'), mealsSent: out('mealsSent'), videosSent: out('videosSent'),
        clientWin: f.clientWin.value.trim(),
        clientNote: f.clientNote.value.trim(),
      };
      if (f.nextMeeting) checkin.nextMeeting = f.nextMeeting.value.trim();
      if (f.m_waist) checkin.measures = { waist: num('m_waist'), hip: num('m_hip'), bodyFat: num('m_bodyFat') };
      if (f.reflection) checkin.reflection = f.reflection.value.trim();
      const ri = f.querySelector('input[name="renewIntent"]:checked');
      if (ri) checkin.renewIntent = ri.value;
      const btn = f.querySelector('[type="submit"]');
      btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      try {
        const d = await api('formCheckin', { checkin });
        data.weeks[w] = Object.assign({}, data.weeks[w] || {}, checkin, { submittedAt: d.submittedAt });
        renderThanks(`${w}週目のチェックインを送信しました`, [
          `${COACH}が確認して、週間レポートでお返事します。`,
          '内容を直したいときは、同じページからもう一度送信してください（上書きされます）。',
        ]);
      } catch (ex) {
        document.getElementById('formErr').innerHTML = `<div class="err">${esc(errText(ex))}</div>`;
        btn.disabled = false; btn.textContent = `${w}週目のチェックインを送信`;
      }
    });
  }

  function bindIntakeLink() {
    const a = document.getElementById('toIntake');
    if (a) a.onclick = (e) => { e.preventDefault(); history.replaceState(null, '', '#' + key + '/intake'); renderIntake(); window.scrollTo(0, 0); };
  }

  // 答えたら「必須」の表示を消す
  $app.addEventListener('change', (e) => {
    const q = e.target.closest && e.target.closest('.f-q.missing');
    if (q) { q.classList.remove('missing'); const m = q.querySelector('.f-miss'); if (m) m.hidden = true; }
  });
  $app.addEventListener('input', (e) => {
    const q = e.target.closest && e.target.closest('.f-q.missing');
    if (q && e.target.value.trim()) { q.classList.remove('missing'); const m = q.querySelector('.f-miss'); if (m) m.hidden = true; }
  });

  // ================================================================ 起動

  (async function boot() {
    if (!key) return fatal(errText({ message: 'invalid_link' }));
    try {
      data = await api('formGet');
    } catch (e) {
      return fatal(errText(e));
    }
    document.title = data.client.intakeDone && mode !== 'intake' ? 'チェックイン' : '事前ヒアリング';
    if (!data.client.intakeDone || mode === 'intake') renderIntake(); else renderCheckin();
  })();
})();
