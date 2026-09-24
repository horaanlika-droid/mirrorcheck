/* PRICELEX | Official — клиентское Web App (BTC & GRAM обмен + поддержка + tx) */
(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  let initData = '';
  let startParam = '';
  let demo = null;
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.setHeaderColor && tg.setHeaderColor('#04060d');
      tg.setBackgroundColor && tg.setBackgroundColor('#04060d');
    } catch (e) {}
    initData = tg.initData || '';
    startParam = tg.startParam || '';
  }
  if (!initData) {
    try {
      demo = JSON.parse(localStorage.getItem('pricelex_demo') || 'null');
      if (!demo) {
        demo = { id: 900000 + Math.floor(Math.random() * 99999), name: 'Гость' };
        localStorage.setItem('pricelex_demo', JSON.stringify(demo));
      }
    } catch (e) {
      demo = { id: 900001, name: 'Гость' };
    }
  }

  const $ = (s) => document.querySelector(s);
  const TERMINAL = ['completed', 'rejected', 'cancelled'];
  const S = {
    settings: null, me: null, orders: [], order: null, tab: 'exchange',
    currency: 'BTC', isDemo: false, calcFrom: 'rub', support: [],
    history: { points: [], updatedFor: null },
  };

  const STATUS = {
    new: { label: 'Подбор реквизитов', cls: 'new' },
    details: { label: 'Ожидает оплаты', cls: 'details' },
    paid: { label: 'Подтверждение', cls: 'paid' },
    completed: { label: 'Завершён', cls: 'completed' },
    rejected: { label: 'Отклонён', cls: 'rejected' },
    cancelled: { label: 'Отменён', cls: 'cancelled' },
  };

  const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]));
  const fmtRub = (n) => Math.round(Number(n) || 0).toLocaleString('ru-RU') + ' ₽';
  const fmtCrypto = (v, cur) => {
    const n = Number(v) || 0;
    const dec = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
    return n.toFixed(dec) + ' ' + cur;
  };
  const cryptoFromRub = (rub, rate) => Math.floor(((Number(rub) || 0) / rate) * 1e8 + 1e-6) / 1e8;
  const rubFromCrypto = (crypto, rate) => Math.ceil(Number(crypto) * rate - 1e-6);
  const fmtTrim = (v) => {
    const n = Number(v) || 0;
    if (!(n > 0)) return '';
    return n.toFixed(8).replace(/\.?0+$/, '');
  };
  const fmtDate = (ts) => {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtTime = (ts) => {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtAgo = (ts) => {
    if (!Number.isFinite(Number(ts))) return '—';
    const diff = Date.now() - Number(ts);
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ч назад`;
    return `${Math.floor(diff / 86400000)} дн назад`;
  };
  const spanLabel = (ms) => {
    if (ms < 5400000) return `за ${Math.max(1, Math.round(ms / 60000))} мин`;
    if (ms < 129600000) return `за ${Math.max(1, Math.round(ms / 3600000))} ч`;
    return `за ${Math.max(1, Math.round(ms / 86400000))} дн`;
  };
  const fmtSize = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ';
    return (n / 1024 / 1024).toFixed(1) + ' МБ';
  };
  let pendingReceipt = null;
  const haptic = (t) => { try { tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(t || 'light'); } catch (e) {} };

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function copyText(t, msg) {
    try {
      await navigator.clipboard.writeText(t);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    haptic('light');
    toast(msg || 'Скопировано');
  }

  async function api(path, opts = {}) {
    const q = new URLSearchParams(opts.query || {});
    if (initData) q.set('initData', initData);
    else if (demo) { q.set('demo[id]', demo.id); q.set('demo[name]', demo.name); }
    const sep = path.includes('?') ? '&' : '?';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(path + sep + q.toString(), {
        method: opts.method || 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: opts.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: opts.method === 'POST' ? JSON.stringify(Object.assign({ initData, demo }, opts.body || {})) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  const ICONS = {
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5 6.5-5s5.7 1.6 6.5 5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 15.2c2.6.3 4.4 1.8 5 4.8"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.5 7.5L3 21l2-5.5A8.5 8.5 0 0 1 21 11.5Z"/><path d="M8 12h8"/><path d="M8 8h5"/></svg>',
    down: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16"/><path d="m6 14 6 6 6-6"/></svg>',
    copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg>',
    bolt: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
    send: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>',
  };

  /* ---------- график (реальная история курса и сумм) ---------- */
  let chartSeq = 0;

  function smoothPath(pts, top, bottom) {
    if (pts.length < 2) return '';
    if (pts.length === 2) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)} L${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;
    const clamp = (v) => Math.min(bottom, Math.max(top, v));
    let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const t = 0.2;
      const c1x = p1.x + (p2.x - p0.x) * t;
      const c2x = p2.x - (p3.x - p1.x) * t;
      const c1y = clamp(p1.y + (p2.y - p0.y) * t);
      const c2y = clamp(p2.y - (p3.y - p1.y) * t);
      d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    }
    return d;
  }

  // series: [{ at, v }] — реальные наблюдения; рисуем только то, что есть.
  function renderChart(el, series) {
    if (!el) return;
    const W = Math.max(240, Math.round(el.clientWidth || 320));
    const H = Math.max(120, Math.round(el.clientHeight || 158));
    const top = 18;
    const bottom = 14;
    const values = series.map((p) => Number(p.v)).filter((v) => Number.isFinite(v));
    const en = values.length;
    const lo = en ? Math.min(...values) : 0;
    const hi = en ? Math.max(...values) : 1;
    const span = hi - lo;
    const mid = top + (H - top - bottom) / 2;
    const yOf = (v) => (span > 0 ? top + (1 - (v - lo) / span) * (H - top - bottom) : mid);
    const t0 = en ? series[0].at : 0;
    const t1 = en ? series[series.length - 1].at : 0;
    const ts = t1 - t0;
    const xOf = (p, i) => {
      if (ts > 0) return (Math.min(t1, Math.max(t0, p.at)) - t0) / ts * W;
      return en > 1 ? (i / (en - 1)) * W : W;
    };

    const id = ++chartSeq;
    const grid = [];
    for (let i = 1; i <= 5; i += 1) grid.push(`<line class="grid-v" x1="${(W * i / 6).toFixed(1)}" y1="${top - 6}" x2="${(W * i / 6).toFixed(1)}" y2="${H - bottom + 4}"/>`);
    for (let i = 1; i <= 3; i += 1) grid.push(`<line class="grid-h" x1="0" y1="${(top + (H - top - bottom) * i / 4).toFixed(1)}" x2="${W}" y2="${(top + (H - top - bottom) * i / 4).toFixed(1)}"/>`);

    const pts = series.map((p, i) => ({ x: xOf(p, i), y: yOf(Number(p.v)) }));
    const last = pts[pts.length - 1] || { x: W, y: mid };
    const hasLine = pts.length >= 3;
    const line = hasLine ? smoothPath(pts, top - 4, H - bottom + 4) : '';
    const area = hasLine ? `${line} L${last.x.toFixed(1)},${H - bottom} L${pts[0].x.toFixed(1)},${H - bottom} Z` : '';
    const guide = hasLine ? '' : `<line class="guide" x1="0" y1="${last.y.toFixed(1)}" x2="${(last.x - 12).toFixed(1)}" y2="${last.y.toFixed(1)}"/>`;

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="plLine${id}" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#2f6bff"/><stop offset="55%" stop-color="#5ea9ff"/><stop offset="100%" stop-color="#bfe4ff"/>
          </linearGradient>
          <linearGradient id="plArea${id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(78,168,255,.34)"/><stop offset="100%" stop-color="rgba(78,168,255,0)"/>
          </linearGradient>
          <radialGradient id="plDot${id}">
            <stop offset="0%" stop-color="rgba(170,215,255,.5)"/><stop offset="100%" stop-color="rgba(170,215,255,0)"/>
          </radialGradient>
        </defs>
        ${grid.join('')}
        ${guide}
        ${area ? `<path class="area" d="${area}" fill="url(#plArea${id})"/>` : ''}
        ${line ? `<path class="line" d="${line}" stroke="url(#plLine${id})"/>` : ''}
        <circle class="dot-halo" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="15" fill="url(#plDot${id})"/>
        <circle class="dot-core" cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4.6"/>
      </svg>`;
    return { x: last.x, y: last.y, W, H };
  }

  function renderChartNote(el, text) {
    if (!el || !text) return;
    const note = document.createElement('div');
    note.className = 'chart-note';
    note.textContent = text;
    el.appendChild(note);
  }

  function renderChartTip(el, spot, value, sub) {
    if (!el || !spot) return;
    const tip = document.createElement('div');
    tip.className = 'chart-tip' + (spot.y < 78 ? ' below' : '');
    tip.style.top = (spot.y < 78 ? spot.y + 12 : spot.y - 8) + 'px';
    tip.innerHTML = `<div class="t-k">сейчас</div><div class="t-v">${esc(value)}</div>${sub ? `<div class="t-s">${esc(sub)}</div>` : ''}`;
    el.appendChild(tip);
  }

  function renderHero() {
    const s = S.settings;
    if (!s) return;
    const cur = S.currency;
    const rate = cur === 'BTC' ? s.rateBTC : s.rateGRAM;
    const label = document.getElementById('heroRate');
    if (label) label.textContent = Math.round(Number(rate) || 0).toLocaleString('ru-RU');
    const sub = document.getElementById('heroSub');
    if (sub) sub.innerHTML = `за 1 <b>${cur}</b>`;
    const upd = document.getElementById('heroUpdated');
    if (upd) upd.textContent = s.rateUpdatedAt ? fmtAgo(s.rateUpdatedAt) : 'ожидаем обновление';

    const series = (S.history.points || []).map((p) => ({ at: p.at, v: cur === 'BTC' ? p.btc : p.gram }))
      .filter((p) => Number.isFinite(p.v) && p.v > 0);
    const chart = document.getElementById('rateChart');
    const axis = document.getElementById('rateAxis');
    chart.innerHTML = '';
    if (axis) axis.innerHTML = '';

    if (series.length >= 2) {
      const spot = renderChart(chart, series);
      renderChartTip(chart, spot, (Math.round(series[series.length - 1].v) || 0).toLocaleString('ru-RU') + ' ₽', fmtTime(series[series.length - 1].at));
      if (axis) {
        const mid = series[Math.floor((series.length - 1) / 2)];
        axis.innerHTML = [series[0], mid, series[series.length - 1]]
          .map((p) => `<span>${fmtTime(p.at)}</span>`).join('');
      }
      const a = series[0].v;
      const b = series[series.length - 1].v;
      const pct = a > 0 ? ((b - a) / a) * 100 : 0;
      const cls = Math.abs(pct) < 0.005 ? 'flat' : pct > 0 ? 'up' : 'down';
      const ar = cls === 'flat' ? '•' : cls === 'up' ? '▲' : '▼';
      const txt = cls === 'flat' ? 'без изменений' : `${Math.abs(pct).toFixed(2)} %`;
      const when = spanLabel(series[series.length - 1].at - series[0].at);
      const d = document.getElementById('heroDelta');
      if (d) d.innerHTML = `<span class="delta ${cls}"><span class="ar">${ar}</span><span>${txt}</span><span class="when">${when}</span></span>`;
    } else {
      renderChart(chart, series.length ? series : [{ at: Date.now(), v: 0 }]);
      renderChartTip(chart, { x: 0, y: (chart.clientHeight || 158) / 2 }, (Math.round(Number(rate) || 0)).toLocaleString('ru-RU') + ' ₽', 'текущий курс');
      renderChartNote(chart, 'График курса появится, когда накопится история обновлений');
      const d = document.getElementById('heroDelta');
      if (d) d.innerHTML = '<span class="delta flat"><span class="ar">•</span><span>стабильный курс</span></span>';
    }
  }

  function renderHeader() {
    const s = S.settings;
    let html = s.online
      ? '<span class="pill"><span class="dot"></span>ОНЛАЙН</span>'
      : '<span class="pill off"><span class="dot"></span>ОФФЛАЙН</span>';
    if (S.isDemo) html += ' <span class="pill demo">ДЕМО</span>';
    $('#hdrStatus').innerHTML = html;
  }

  function renderAnnounce() {
    const el = $('#announce');
    const t = S.settings && S.settings.announcement;
    el.classList.toggle('hidden', !t);
    el.textContent = t || '';
  }

  function goTab(tab) {
    if (tab === S.tab) return;
    S.tab = tab;
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    const view = $('#view-' + tab);
    if (view) view.classList.remove('hidden');
    renderNav();
    if (tab === 'history') renderHistory();
    if (tab === 'refs') renderRefs();
    if (tab === 'info') renderInfo();
    if (tab === 'support') renderSupport();
  }

  function renderNav() {
    const items = [
      ['exchange', 'Обмен', ICONS.swap],
      ['history', 'История', ICONS.clock],
      ['refs', 'Рефералы', ICONS.users],
      ['support', 'Чат', ICONS.chat],
      ['info', 'Инфо', ICONS.info],
    ];
    $('#nav').innerHTML = items
      .map(([id, l, ic]) => `<button data-tab="${id}" class="${S.tab === id ? 'on' : ''}">${ic}<span>${l}</span>${id === 'support' && S.support.length ? `<span class="badge">${S.support.length > 99 ? '99+' : S.support.length}</span>` : ''}</button>`)
      .join('');
    $('#nav').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        if (S.tab === b.dataset.tab) return;
        haptic('light');
        goTab(b.dataset.tab);
      })
    );
  }

  function renderExchange() {
    $('#view-exchange').innerHTML = `
      <div id="exForm" class="${S.order ? 'hidden' : ''}">
        <section class="card card-hero">
          <div class="hero-top">
            <div class="kicker">Курс обмена</div>
            <div class="seg" id="segCur">
              <button data-c="BTC" class="${S.currency === 'BTC' ? 'on' : ''}">₿ BTC</button>
              <button data-c="GRAM" class="${S.currency === 'GRAM' ? 'on' : ''}">G GRAM</button>
            </div>
          </div>
          <div class="hero-amount">
            <div class="metric"><span id="heroRate">—</span><span class="cur">₽</span></div>
            <div id="heroDelta"></div>
          </div>
          <div class="metric-sub" id="heroSub">за 1 <b>${S.currency}</b></div>
          <div class="chart" id="rateChart"></div>
          <div class="chart-axis" id="rateAxis"></div>
          <div class="hero-foot">
            <div>
              <div class="k">Курс обновлён</div>
              <div class="v" id="heroUpdated">—</div>
            </div>
            <button class="ghost-pill" id="howItWorks"><span class="q">?</span>Как это работает</button>
          </div>
        </section>

        <div class="card">
          <div class="card-title">Сумма обмена</div>
          <div class="f-label"><span>Вы отдаёте</span><span id="mmLabel"></span></div>
          <div class="field">
            <div class="coin-ic rub">₽</div>
            <input id="inRub" type="number" inputmode="decimal" placeholder="5 000" min="0" step="any">
            <span class="suffix">RUB</span>
          </div>
          <div class="swap-row"><div class="swap">${ICONS.down}</div></div>
          <div class="f-label"><span>Вы получаете</span><span id="cryptoLimits"></span></div>
          <div class="field">
            <div class="coin-ic" id="getIc">₿</div>
            <input id="inCrypto" type="number" inputmode="decimal" placeholder="0.0005" min="0" step="any">
            <span class="suffix" id="curSuffix">BTC</span>
          </div>
          <div class="f-hint">Введите сумму в любом поле — второе посчитается автоматически</div>
          <div class="f-meta" id="fMeta"></div>
        </div>

        <div class="card">
          <div class="card-title">Кошелёк получателя</div>
          <div class="field">
            <div class="coin-ic" id="walIc">₿</div>
            <input id="inWallet" placeholder="Адрес BTC-кошелька" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
          </div>
          <div class="f-err" id="fErr"></div>
        </div>

        <button class="btn btn-primary mt" id="btnGo">${ICONS.bolt}<span>Найти реквизиты</span></button>
      </div>
      <div id="exOrder" class="${S.order ? '' : 'hidden'}"></div>
    `;
    $('#segCur').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        S.currency = b.dataset.c;
        haptic('light');
        $('#segCur').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        renderHero();
        renderFormMeta();
      })
    );
    $('#inRub').addEventListener('input', () => { S.calcFrom = 'rub'; renderFormMeta(); });
    $('#inCrypto').addEventListener('input', () => { S.calcFrom = 'crypto'; renderFormMeta(); });
    $('#btnGo').addEventListener('click', submitOrder);
    $('#howItWorks').addEventListener('click', () => { haptic('light'); goTab('info'); });
    renderHero();
    renderFormMeta();
    renderOrderStage();
  }

  function renderFormMeta() {
    const s = S.settings;
    if (!s) return;
    const cur = S.currency;
    const rate = cur === 'BTC' ? s.rateBTC : s.rateGRAM;
    const inRub = $('#inRub');
    const inCrypto = $('#inCrypto');
    if (inRub && inCrypto) {
      if (S.calcFrom === 'crypto') {
        const c = parseFloat(inCrypto.value);
        inRub.value = c > 0 ? String(rubFromCrypto(c, rate)) : '';
      } else {
        const rub = parseFloat(inRub.value);
        inCrypto.value = rub > 0 ? fmtTrim(cryptoFromRub(rub, rate)) : '';
      }
    }
    $('#mmLabel').textContent = `от ${fmtRub(s.minRub)} до ${fmtRub(s.maxRub)}`;
    const cl = $('#cryptoLimits');
    if (cl) cl.textContent = `≈ ${fmtTrim(s.minRub / rate)}–${fmtTrim(s.maxRub / rate)} ${cur}`;
    const ic = $('#getIc');
    ic.className = 'coin-ic ' + cur.toLowerCase();
    ic.textContent = cur === 'BTC' ? '₿' : 'G';
    const wi = $('#walIc');
    wi.className = 'coin-ic ' + cur.toLowerCase();
    wi.textContent = cur === 'BTC' ? '₿' : 'G';
    const sfx = $('#curSuffix');
    if (sfx) sfx.textContent = cur;
    $('#inWallet').placeholder = cur === 'BTC' ? 'Адрес BTC-кошелька (bc1… / 1… / 3…)' : 'Адрес GRAM-кошелька';
    $('#inCrypto').placeholder = cur === 'BTC' ? '0.0005' : '40';
    $('#fMeta').innerHTML = `
      <div class="row"><span>Курс обмена</span><b>1 ${cur} = ${fmtRub(rate)}</b></div>
      ${s.rateUpdatedAt ? `<div class="row"><span>Курс обновлён</span><b>${fmtDate(s.rateUpdatedAt)}</b></div>` : ''}
      <div class="row"><span>Обработкой занимается</span><b>оператор PRICELEX</b></div>`;
    const btn = $('#btnGo');
    btn.disabled = !s.online;
    btn.querySelector('span').textContent = s.online ? 'Найти реквизиты' : '⛔ Обмен временно недоступен';
  }

  async function submitOrder() {
    const s = S.settings;
    const err = $('#fErr');
    err.textContent = '';
    const rate = S.currency === 'BTC' ? s.rateBTC : s.rateGRAM;
    const rawRub = parseFloat($('#inRub').value);
    const rawCrypto = parseFloat($('#inCrypto').value);
    const useCrypto = S.calcFrom === 'crypto' && isFinite(rawCrypto) && rawCrypto > 0;
    const cryptoAmount = useCrypto ? rawCrypto : null;
    const rub = useCrypto ? rubFromCrypto(rawCrypto, rate) : rawRub;
    const wallet = ($('#inWallet').value || '').trim();
    if (!s.online) return (err.textContent = '⛔ Обмен временно недоступен — загляните позже.');
    if (!isFinite(rub) || rub < s.minRub) return (err.textContent = `Минимальная сумма обмена — ${fmtRub(s.minRub)} (≈ ${fmtTrim(cryptoFromRub(s.minRub, rate))} ${S.currency}).`);
    if (rub > s.maxRub) return (err.textContent = `Максимальная сумма обмена — ${fmtRub(s.maxRub)} (≈ ${fmtTrim(cryptoFromRub(s.maxRub, rate))} ${S.currency}).`);
    if (!/^[a-zA-Z0-9]{26,90}$/.test(wallet)) return (err.textContent = 'Проверьте адрес кошелька — он выглядит некорректно.');
    const btn = $('#btnGo');
    btn.disabled = true;
    haptic('medium');
    try {
      const body = useCrypto
        ? { cryptoAmount, currency: S.currency, wallet, startParam }
        : { rub, currency: S.currency, wallet, startParam };
      const r = await api('/api/orders', { method: 'POST', body });
      S.order = r.order;
      S.orders.unshift(r.order);
      haptic('heavy');
      $('#exForm').classList.add('hidden');
      $('#exOrder').classList.remove('hidden');
      renderOrderStage();
    } catch (e) {
      err.textContent = e.message;
      toast(e.message);
    } finally {
      btn.disabled = !S.settings.online;
    }
  }

  function chip(st) {
    const m = STATUS[st] || { label: st, cls: 'cancelled' };
    return `<span class="chip ${m.cls}">${m.label}</span>`;
  }

  function renderOrderStage() {
    const box = $('#exOrder');
    const o = S.order;
    if (!box) return;
    if (!o) { box.innerHTML = ''; return; }
    if (o.status === 'new') {
      box.innerHTML = `
        <div class="card stage">
          <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">🔍</div></div>
          <div class="stage-title">Ищем реквизиты для оплаты</div>
          <div class="stage-sub">Заявка <b>#${o.id}</b> передана оператору.<br>Обычно это занимает меньше минуты — не закрывайте приложение.</div>
          <button class="btn btn-ghost mt" id="btnCancel">Отменить заявку</button>
        </div>`;
      $('#btnCancel').addEventListener('click', async () => {
        haptic('light');
        await changeOrder(o, 'cancel');
      });
    } else if (o.status === 'details') {
      box.innerHTML = `
        <div class="card stage">
          ${chip('details')}
          <div class="pay-amount"><div class="l">Переведите точно</div><div class="v">${fmtRub(o.payRub || o.rub)}</div></div>
          <div class="req-box" id="reqBox">${esc(o.requisites || 'Реквизиты готовятся…')}</div>
          <div class="copy-row">
            <button class="btn btn-ghost btn-sm" id="cpSum">${ICONS.copy}<span>Сумма</span></button>
            <button class="btn btn-ghost btn-sm" id="cpReq">${ICONS.copy}<span>Реквизиты</span></button>
          </div>
          <div class="file-box">
            <input type="file" id="inReceipt" accept=".pdf,application/pdf" hidden>
            <button class="btn btn-ghost btn-sm" id="btnPick">📎 <span>${o.receipt ? 'Заменить чек (PDF)' : 'Прикрепить чек (PDF)'}</span></button>
            <div class="file-name ${o.receipt ? 'ok' : ''}" id="fileName">${o.receipt ? `✅ ${esc(o.receipt.name)} (${fmtSize(o.receipt.size)})` : 'Без чека оплата не подтвердится'}</div>
          </div>
          <div class="note">Переведите <b>точную сумму</b> по реквизитам выше, прикрепите <b>чек в PDF</b>, затем нажмите кнопку ниже. После подтверждения оператор отправит ${fmtCrypto(o.crypto, o.currency)} на ваш кошелёк.</div>
          <button class="btn btn-primary mt" id="btnPaid">${ICONS.check}<span>Я оплатил</span></button>
          <button class="btn btn-ghost" style="margin-top:9px" id="btnCancel">Отменить заявку</button>
        </div>`;
      $('#cpSum').addEventListener('click', () => copyText(String(Math.round(o.payRub || o.rub)), 'Сумма скопирована'));
      $('#cpReq').addEventListener('click', () => copyText(o.requisites || '', 'Реквизиты скопированы'));
      wireReceiptPicker(o);
      $('#btnPaid').addEventListener('click', async () => {
        haptic('medium');
        await confirmPaidWithReceipt(o);
      });
      $('#btnCancel').addEventListener('click', async () => {
        haptic('light');
        await changeOrder(o, 'cancel');
      });
    } else if (o.status === 'paid') {
      box.innerHTML = `
        <div class="card stage">
          <div class="spinner-wrap"><div class="spinner"></div><div class="spinner-ic">⏳</div></div>
          <div class="stage-title">Подтверждаем оплату</div>
          <div class="stage-sub">Оператор проверяет поступление ${fmtRub(o.payRub || o.rub)} по заявке <b>#${o.id}</b>.<br>Как только платёж подтвердится — мы отправим ${fmtCrypto(o.crypto, o.currency)}.</div>
          ${o.receipt
            ? `<div class="note">🧾 Чек <b>${esc(o.receipt.name)}</b> отправлен оператору ✅</div>`
            : `<div class="file-box">
                 <input type="file" id="inReceipt" accept=".pdf,application/pdf" hidden>
                 <button class="btn btn-ghost btn-sm" id="btnPick">📎 <span>Выбрать чек (PDF)</span></button>
                 <div class="file-name" id="fileName">⚠️ Чек не прикреплён — без него оператор не подтвердит оплату</div>
                 <button class="btn btn-primary btn-sm" style="width:100%" id="btnSendReceipt">Отправить чек</button>
               </div>`}
        </div>`;
      if (!o.receipt) {
        wireReceiptPicker(o);
        $('#btnSendReceipt').addEventListener('click', async () => {
          const picked = pendingReceipt && pendingReceipt.orderId === o.id ? pendingReceipt.file : null;
          if (!picked) return toast('📎 Сначала выберите чек в формате PDF');
          const btn = $('#btnSendReceipt');
          btn.disabled = true;
          haptic('medium');
          try {
            const updated = await uploadReceipt(o, picked);
            pendingReceipt = null;
            S.order = updated;
            const i = S.orders.findIndex((x) => x.id === updated.id);
            if (i >= 0) S.orders[i] = updated;
            toast('Чек отправлен оператору ✅');
            renderOrderStage();
          } catch (e) {
            toast(e.message || 'Не удалось отправить чек');
            btn.disabled = false;
          }
        });
      }
    } else if (o.status === 'completed') {
      box.innerHTML = `
        <div class="card stage">
          <svg class="okmark" viewBox="0 0 100 100"><circle cx="50" cy="50" r="41"/><path d="M32 51l13 13 24-27"/></svg>
          <div class="stage-title">Обмен завершён!</div>
          <div class="stage-sub">${fmtRub(o.payRub || o.rub)} → <b>${fmtCrypto(o.crypto, o.currency)}</b><br>отправлены на ваш кошелёк. Спасибо, что выбираете PRICELEX ✦</div>
          ${o.txUrl ? `
            <div class="tx-box">
              <div class="tx-label">🔗 Транзакция в блокчейне</div>
              <a class="tx-link" href="${esc(o.txUrl)}" target="_blank" rel="noopener">${esc(o.txUrl)}</a>
              <button class="btn btn-ghost btn-sm" style="margin-top:11px" id="cpTx">${ICONS.copy}<span>Копировать ссылку</span></button>
            </div>
          ` : `<div class="note">Оператор отправит средства вручную. Ссылка на блокчейн появится здесь, если оператор её добавит.</div>`}
          <button class="btn btn-primary mt" id="btnNew">Новый обмен</button>
        </div>`;
      const cpTx = $('#cpTx');
      if (cpTx) cpTx.addEventListener('click', () => copyText(o.txUrl, 'Ссылка скопирована'));
      $('#btnNew').addEventListener('click', resetToForm);
    } else {
      const rej = o.status === 'rejected';
      box.innerHTML = `
        <div class="card stage">
          <div class="failmark">${rej ? '🔴' : '⚪'}</div>
          <div class="stage-title">${rej ? 'Заявка отклонена' : 'Заявка отменена'}</div>
          <div class="stage-sub">${rej ? 'Оператор отклонил заявку #' + o.id + '. Если это ошибка — напишите в поддержку.' : 'Вы отменили заявку #' + o.id + '.'}</div>
          ${o.txUrl ? `<div class="tx-box"><div class="tx-label">🔗 Блокчейн</div><a class="tx-link" href="${esc(o.txUrl)}" target="_blank" rel="noopener">${esc(o.txUrl)}</a></div>` : ''}
          <button class="btn btn-primary mt" id="btnNew">Создать заявку</button>
        </div>`;
      $('#btnNew').addEventListener('click', resetToForm);
    }
  }

  function wireReceiptPicker(o) {
    $('#btnPick').addEventListener('click', () => { haptic('light'); $('#inReceipt').click(); });
    $('#inReceipt').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { toast('Нужен файл в формате PDF'); e.target.value = ''; return; }
      if (f.size > 8 * 1024 * 1024) { toast('PDF должен весить до 8 МБ'); e.target.value = ''; return; }
      pendingReceipt = { orderId: o.id, file: f };
      haptic('light');
      const fn = $('#fileName');
      if (fn) { fn.textContent = `📎 ${f.name} (${fmtSize(f.size)})`; fn.classList.remove('ok'); }
    });
    const picked = pendingReceipt && pendingReceipt.orderId === o.id ? pendingReceipt.file : null;
    if (picked && !o.receipt) {
      const fn = $('#fileName');
      if (fn) fn.textContent = `📎 ${picked.name} (${fmtSize(picked.size)})`;
    }
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result || '');
        const idx = s.indexOf(',');
        resolve(idx >= 0 ? s.slice(idx + 1) : s);
      };
      r.onerror = () => reject(new Error('Не удалось прочитать файл'));
      r.readAsDataURL(file);
    });
  }

  async function uploadReceipt(order, file) {
    const base64 = await readAsBase64(file);
    const r = await api(`/api/order/${order.id}/receipt`, {
      method: 'POST',
      body: { filename: file.name, data: base64 },
    });
    return r.order;
  }

  async function confirmPaidWithReceipt(order) {
    const btn = $('#btnPaid');
    const label = btn && btn.querySelector('span');
    try {
      let current = S.order && S.order.id === order.id ? S.order : order;
      if (!current.receipt) {
        const picked = pendingReceipt && pendingReceipt.orderId === order.id ? pendingReceipt.file : null;
        if (!picked) {
          toast('📎 Сначала прикрепите чек в формате PDF');
          return;
        }
        if (btn) { btn.disabled = true; if (label) label.textContent = 'Отправляем чек…'; }
        current = await uploadReceipt(order, picked);
        pendingReceipt = null;
        S.order = current;
        const i = S.orders.findIndex((x) => x.id === current.id);
        if (i >= 0) S.orders[i] = current; else S.orders.unshift(current);
        if (label) label.textContent = 'Подтверждаем…';
      }
      await changeOrder(current, 'paid');
    } catch (e) {
      toast(e.message || 'Не удалось отправить. Проверьте связь и повторите.');
      renderOrderStage();
    }
  }

  async function changeOrder(order, action) {
    try {
      const r = await api(`/api/order/${order.id}/${action}`, { method: 'POST' });
      if (S.order?.id !== order.id) return;
      S.order = r.order;
      syncStatus();
      renderOrderStage();
    } catch (e) {
      toast('Не удалось отправить действие. Проверьте связь и повторите.');
    }
  }

  function resetToForm() {
    S.order = null;
    haptic('light');
    $('#exForm').classList.remove('hidden');
    $('#exOrder').classList.add('hidden');
    renderOrderStage();
  }

  function renderHistory() {
    const v = $('#view-history');
    if (!S.orders.length) {
      v.innerHTML = `<div class="card"><div class="empty"><div class="e-ic">🗂</div>История пока пуста.<br>Совершите первый обмен — он появится здесь.</div></div>`;
      return;
    }
    const done = S.orders.filter((o) => o.status === 'completed');
    const rubSum = done.reduce((acc, o) => acc + Math.round(o.payRub || o.rub), 0);
    const byCur = done.reduce((acc, o) => {
      acc[o.currency] = (acc[o.currency] || 0) + (Number(o.crypto) || 0);
      return acc;
    }, {});
    const cryptoLine = Object.keys(byCur).map((c) => fmtCrypto(byCur[c], c)).join(' · ');
    const series = done
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((o) => ({ at: o.createdAt, v: Math.round(o.payRub || o.rub) }));

    v.innerHTML = `
      <section class="card card-hero">
        <div class="hero-top">
          <div class="kicker">Объём обменов</div>
          <div class="seg" id="histSeg">
            <button data-h="all" class="on">Все</button>
            <button data-h="completed">Завершённые</button>
          </div>
        </div>
        <div class="hero-amount">
          <div class="metric">${Number(rubSum).toLocaleString('ru-RU')}<span class="cur">₽</span></div>
          <div><span class="delta ${done.length ? 'up' : 'flat'}"><span class="ar">${done.length ? '✓' : '•'}</span><span>${done.length} ${done.length === 1 ? 'обмен' : done.length < 5 ? 'обмена' : 'обменов'}</span></span></div>
        </div>
        <div class="metric-sub">${cryptoLine ? `${cryptoLine} · всего операций ${S.orders.length}` : `всего операций ${S.orders.length}`}</div>
        ${done.length >= 3 ? `<div class="chart" id="volChart"></div><div class="chart-axis" id="volAxis"></div>` : ''}
      </section>
      <div class="card-title" style="padding:16px 4px 11px">История обменов</div>
      <div id="histList">${historyItems(S.orders)}</div>`;

    const volChart = $('#volChart');
    if (volChart && series.length >= 3) {
      const spot = renderChart(volChart, series);
      renderChartTip(volChart, spot, fmtRub(series[series.length - 1].v), fmtDate(series[series.length - 1].at));
      const axis = $('#volAxis');
      if (axis) {
        axis.innerHTML = [series[0], series[series.length - 1]]
          .map((p) => `<span>${fmtDate(p.at)}</span>`).join('');
      }
    }
    $('#histSeg').querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        haptic('light');
        $('#histSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        $('#histList').innerHTML = historyItems(b.dataset.h === 'all' ? S.orders : S.orders.filter((o) => o.status === 'completed'));
      })
    );
  }

  function historyItems(list) {
    if (!list.length) return '<div class="card"><div class="empty">В этой подборке пока нет обменов.</div></div>';
    return list
      .map(
        (o) => `
      <div class="card h-item">
        <div class="h-ic ${o.currency.toLowerCase()}">${o.currency === 'BTC' ? '₿' : 'G'}</div>
        <div class="h-main">
          <div class="h-top"><span>₽ → ${o.currency}</span><span class="sum">${fmtRub(o.payRub || o.rub)}</span></div>
          <div class="h-sub"><span>#${o.id}${o.receipt ? ' 🧾' : ''} · ${fmtDate(o.createdAt)}</span><span class="crypto">${fmtCrypto(o.crypto, o.currency)}</span></div>
          <div class="h-sub">
            <span>${esc(o.wallet.slice(0, 10) + '…' + o.wallet.slice(-6))}</span>
            ${chip(o.status)}
          </div>
          ${o.txUrl ? `<div class="h-sub"><a href="${esc(o.txUrl)}" target="_blank" rel="noopener">🔗 ${esc(o.txUrl.slice(0, 46))}…</a></div>` : ''}
        </div>
      </div>`
      )
      .join('');
  }

  function renderRefs() {
    const s = S.settings;
    const v = $('#view-refs');
    const link = s.botUsername ? `https://t.me/${s.botUsername}?startapp=ref${S.me.id}` : null;
    v.innerHTML = `
      <div class="card">
        <div class="card-title">Реферальная программа</div>
        ${
          link
            ? `<div class="ref-link" id="refLink">${esc(link)}</div>
               <button class="btn btn-primary" style="margin-top:11px" id="cpRef">${ICONS.copy}<span>Скопировать ссылку</span></button>`
            : `<div class="empty">Реферальная ссылка появится после подключения бота.</div>`
        }
        <div class="ref-stats">
          <div class="ref-stat"><div class="v">${S.me.referredCount || 0}</div><div class="l">приглашено</div></div>
          <div class="ref-stat"><div class="v">${s.refPercent}%</div><div class="l">бонус с обмена</div></div>
        </div>
        <div class="steps">
          <div class="step"><div class="n">1</div>Отправьте ссылку другу — она закрепит его за вами навсегда.</div>
          <div class="step"><div class="n">2</div>Друг совершает обмен в PRICELEX через ваше приложение.</div>
          <div class="step"><div class="n">3</div>Вы получаете ${s.refPercent}% с каждого его обмена — без лимитов.</div>
        </div>
      </div>`;
    const cp = $('#cpRef');
    if (cp) cp.addEventListener('click', () => copyText(link, 'Ссылка скопирована'));
  }

  function renderInfo() {
    const s = S.settings;
    const opLink = 'https://t.me/' + String(s.operator || '').replace(/^@/, '');
    $('#view-info').innerHTML = `
      <div class="card">
        <div class="about"><b>PRICELEX</b> — современный сервис обмена Bitcoin и Gram. Честность, скорость и выгодные условия: мы создали сервис, которым удобно пользоваться каждый день.</div>
        <div class="feat">
          <div class="f"><span class="i">✅</span>Выгодный курс — максимум за каждый обмен</div>
          <div class="f"><span class="i">✅</span>Фиксированная сумма к оплате — известна заранее, без доплат</div>
          <div class="f"><span class="i">✅</span>Быстрые сделки и живая поддержка оператора</div>
          <div class="f"><span class="i">✅</span>Безопасность каждой операции</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Как это работает</div>
        <div class="steps">
          <div class="step"><div class="n">1</div>Выберите валюту и введите сумму — калькулятор сразу покажет, сколько получите.</div>
          <div class="step"><div class="n">2</div>Укажите адрес кошелька и нажмите «Найти реквизиты»: оператор пришлёт точную сумму к оплате.</div>
          <div class="step"><div class="n">3</div>Переведите сумму, прикрепите PDF-чек и нажмите «Я оплатил».</div>
          <div class="step"><div class="n">4</div>После подтверждения средства уходят на ваш кошелёк — ссылку на транзакцию увидите в заявке.</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Связь с нами</div>
        <div class="contacts">
          <a class="contact" href="${esc(opLink)}" target="_blank" rel="noopener"><span class="ci">🧩</span><span>Оператор<small>${esc(s.operator)}</small></span></a>
          <a class="contact" href="${esc(s.channel)}" target="_blank" rel="noopener"><span class="ci">📣</span><span>Официальный канал<small>новости и курсы</small></span></a>
          <a class="contact" href="${esc(s.chat)}" target="_blank" rel="noopener"><span class="ci">💬</span><span>Чат поддержки<small>отвечаем быстро</small></span></a>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Поддержка в приложении</div>
        <div class="about" style="font-size:12.5px">Напишите нам прямо здесь — отвечаем в реальном времени. Перейдите во вкладку <b>Чат</b> в нижнем меню.</div>
        <button class="btn btn-ghost" style="margin-top:12px" id="goSupport">${ICONS.chat}<span>Открыть чат поддержки</span></button>
      </div>
      <div class="card"><div class="about" style="text-align:center;color:var(--mut);font-size:11.5px">PRICELEX — быстро. Надёжно. Выгодно. ✦</div></div>`;
    const go = $('#goSupport');
    if (go) go.addEventListener('click', () => { haptic('light'); goTab('support'); });
  }

  /* ---------- поддержка чат ---------- */
  function renderSupport() {
    const v = $('#view-support');
    v.innerHTML = `
      <div class="card">
        <div class="card-title">Чат поддержки</div>
        <div class="about" style="font-size:12px;color:var(--mut);margin-bottom:12px">Задайте вопрос оператору — отвечаем в реальном времени. Обычно отвечаем за 1–3 минуты.</div>
        <div class="chat-box" id="chatBox">
          <div class="chat-empty" id="chatEmpty"><div class="e-ic">💬</div>Напишите сообщение — мы на связи 24/7</div>
          <div class="chat-list" id="chatList"></div>
        </div>
        <div class="chat-input">
          <textarea id="chatInput" placeholder="Напишите сообщение..." rows="1" maxlength="2000"></textarea>
          <button class="btn btn-primary btn-sm" id="btnSendChat">${ICONS.send}</button>
        </div>
        <div class="f-hint" style="margin-top:9px">Поддержка отвечает в этом чате и в Telegram. Не делитесь приватными ключами.</div>
      </div>
    `;
    const input = $('#chatInput');
    const sendBtn = $('#btnSendChat');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendSupportMessage();
      }
    });
    sendBtn.addEventListener('click', sendSupportMessage);
    renderSupportMessages();
    pollSupport(true);
  }

  function renderSupportMessages() {
    const list = $('#chatList');
    const empty = $('#chatEmpty');
    if (!list) return;
    if (!S.support.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = S.support.map((m) => {
      const isMe = m.from === 'user';
      return `<div class="msg ${isMe ? 'me' : 'them'}"><div class="msg-bubble">${esc(m.text).replace(/\n/g, '<br>')}</div><div class="msg-time">${fmtDate(m.at)} · ${isMe ? 'Вы' : 'Поддержка'}</div></div>`;
    }).join('');
    const box = $('#chatBox');
    if (box) box.scrollTop = box.scrollHeight;
  }

  async function sendSupportMessage() {
    const input = $('#chatInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    if (text.length > 2000) return toast('Сообщение слишком длинное');
    input.value = '';
    input.style.height = 'auto';
    const btn = $('#btnSendChat');
    if (btn) btn.disabled = true;
    haptic('light');
    try {
      const r = await api('/api/support/message', { method: 'POST', body: { text, startParam } });
      S.support.push(r.message);
      renderSupportMessages();
      renderNav();
    } catch (e) {
      toast(e.message || 'Не удалось отправить');
      input.value = text;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function pollSupport(force = false) {
    if (!force && S.tab !== 'support') return;
    try {
      const { messages } = await api('/api/support/messages');
      if (JSON.stringify(messages) !== JSON.stringify(S.support)) {
        S.support = messages;
        if (S.tab === 'support') renderSupportMessages();
        renderNav();
      }
    } catch (e) {
      // silent
    }
  }

  function renderDemoAdmin() {
    if (!S.isDemo) return;
    let el = $('#demoAdmin');
    if (!el) {
      el = document.createElement('button');
      el.id = 'demoAdmin';
      el.className = 'demo-admin';
      el.innerHTML = '🛠 <span>оператор</span>';
      document.body.appendChild(el);
    }
    el.onclick = async () => {
      if (!S.order) return toast('Сначала создайте заявку на обмен');
      const o = S.order;
      haptic('medium');
      if (o.status === 'new') {
        const r = await api(`/api/admin/order/${o.id}/req`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор выдал реквизиты (демо)');
      } else if (o.status === 'paid') {
        const r = await api(`/api/admin/order/${o.id}/confirm`, { method: 'POST' });
        S.order = r.order;
        renderOrderStage();
        toast('Оператор подтвердил оплату (демо)');
      } else if (o.status === 'completed') {
        const url = prompt('Ссылка на блокчейн (опционально):', o.txUrl || 'https://blockchair.com/bitcoin/transaction/');
        if (url) {
          const r = await api(`/api/admin/order/${o.id}/tx`, { method: 'POST', body: { txUrl: url } });
          S.order = r.order;
          renderOrderStage();
          toast('Ссылка сохранена (демо)');
        }
      } else if (o.status === 'details') {
        toast('Теперь клиент жмёт «Я оплатил»');
      } else {
        toast('Заявка уже в финальном статусе');
      }
    };
  }

  function syncStatus(message = '') {
    $('#syncStatus').textContent = message;
    $('#syncStatus').classList.toggle('hidden', !message);
  }

  /* ---------- история курса ---------- */
  async function loadRateHistory() {
    try {
      const r = await api('/api/rates/history', { query: { hours: 24 } });
      S.history.points = Array.isArray(r.points) ? r.points : [];
      if (S.tab === 'exchange') renderHero();
    } catch (e) {
      S.history.points = [];
    }
  }

  async function pollOrder() {
    const current = S.order;
    if (!current || TERMINAL.includes(current.status)) {
      // even if terminal, we still want to catch txUrl updates
      if (current && current.status === 'completed') {
        try {
          const { order } = await api('/api/order/' + current.id);
          if (S.order !== current) return;
          if (JSON.stringify(order) !== JSON.stringify(current)) {
            S.order = order;
            const i = S.orders.findIndex((o) => o.id === order.id);
            if (i >= 0) S.orders[i] = order; else S.orders.unshift(order);
            renderOrderStage();
          }
        } catch {}
      }
      return syncStatus();
    }
    try {
      const { order } = await api('/api/order/' + current.id);
      if (S.order !== current) return;
      syncStatus();
      if (JSON.stringify(order) !== JSON.stringify(current)) {
        S.order = order;
        const i = S.orders.findIndex((o) => o.id === order.id);
        if (i >= 0) S.orders[i] = order; else S.orders.unshift(order);
        renderOrderStage();
        if (order.status === 'completed') haptic('heavy');
      }
    } catch (e) {
      if (S.order === current) syncStatus('⚠️ Не удалось обновить заявку. Восстанавливаем связь автоматически…');
    }
  }

  async function pollSettings() {
    const s = await api('/api/settings');
    if (JSON.stringify(s) !== JSON.stringify(S.settings)) {
      const rateChanged = !S.settings || S.settings.rateUpdatedAt !== s.rateUpdatedAt;
      S.settings = s;
      renderHeader();
      renderAnnounce();
      renderFormMeta();
      if (S.tab === 'exchange') renderHero();
      if (S.tab === 'refs') renderRefs();
      if (S.tab === 'info') renderInfo();
      if (rateChanged) loadRateHistory();
    }
  }

  async function pollProfile() {
    if (S.tab !== 'history' && S.tab !== 'refs') return;
    const m = await api('/api/me');
    S.orders = m.orders;
    S.me = m.me;
    if (!S.order) {
      const act = S.orders.find((o) => !TERMINAL.includes(o.status));
      if (act) {
        S.order = act;
        $('#exForm').classList.add('hidden');
        $('#exOrder').classList.remove('hidden');
        renderOrderStage();
      }
    }
    if (S.tab === 'history') renderHistory();
    else if (S.tab === 'refs') renderRefs();
  }

  function startPolling() {
    const running = new Set();
    const refresh = () => Promise.all([pollOrder, pollSettings, pollProfile, () => pollSupport(false)].map(async (poll) => {
      if (typeof poll !== 'function') return;
      if (running.has(poll)) return;
      running.add(poll);
      try { await poll(); }
      catch (e) { console.warn('[PRICELEX] Обновление не удалось:', e.message); }
      finally { running.delete(poll); }
    }));
    setInterval(refresh, 3000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', refresh);
    if (tg && tg.onEvent) tg.onEvent('activated', refresh);
    window.addEventListener('resize', () => { if (S.tab === 'exchange') renderHero(); if (S.tab === 'history') renderHistory(); });
  }

  (async () => {
    try {
      const r = await api('/api/init', { method: 'POST', body: { startParam } });
      S.settings = r.settings;
      S.me = r.me;
      S.isDemo = !!r.demo;
      const m = await api('/api/me');
      S.orders = m.orders;
      S.me = m.me;
      S.order = S.orders.find((o) => !TERMINAL.includes(o.status)) || null;
      // preload support
      try {
        const sup = await api('/api/support/messages');
        S.support = sup.messages || [];
      } catch {}
      loadRateHistory();
    } catch (e) {
      document.getElementById('announce').textContent = '⚠️ Не удалось подключиться к серверу. Обновите страницу.';
      document.getElementById('announce').classList.remove('hidden');
      return;
    }
    renderHeader();
    renderAnnounce();
    renderNav();
    renderExchange();
    renderHistory();
    renderRefs();
    renderSupport();
    renderInfo();
    // show correct initial tab
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + S.tab).classList.remove('hidden');
    renderDemoAdmin();
    startPolling();
  })();
})();
