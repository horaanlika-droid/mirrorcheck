// Telegram Bot API 10.4 widgets (HTML widgets inside bot messages).
// Important: since 13–15.11.2026 Telegram closed sendWidget for regular bots even in private chats
// (INPUT_MEDIA_WIDGET_NOT_ALLOWED — confirmed in the Bot API repository).
// So the widget ships behind the WIDGETS=1 flag with a safe fallback to a plain message:
// until Telegram opens access, the bot works as usual.
//
// Protocol (Bot API 10.4, verified against core.telegram.org/bots/widgets, 25.11.2026):
// • The message carries html (≤ 32 KB raw, ≤ 4096 bytes after zlib level 9) + chat_data (JSON string ≤ 1024 bytes).
// • allow_queries: true is mandatory — without it taps never reach the bot.
// • The page reads TelegramWidget.chatData (a STRING, needs JSON.parse), tap → TelegramWidget.request(data ≤ 64 B).
// • The bot receives an update widget_query: { id, from, chat?, message_id?, data, type: { type: 'data' } } —
//   the chat/message_id fields live at the top level, NOT inside message.
// • Every request must be answered with answerWidgetQuery(widget_query_id, data ≤ 1024 B) within 15 s.
// • State changes only via editMessageWidgetData(chat_id, message_id, chat_data) → chatDataChanged event.
// • fetch/XHR/WebSocket are forbidden inside the widget; only TelegramWidget.request().
const zlib = require('zlib');
const config = require('./config');
const store = require('./store');
const currencies = require('./currencies');

// Test injection point: defaults to the global fetch.
let fetchImpl = (...args) => globalThis.fetch(...args);
const __setFetch = (fn) => { fetchImpl = fn; };

const widgetsEnabled = () => process.env.WIDGETS === '1';
const MAX_RAW = 32 * 1024;
const MAX_ZLIB = 4000; // headroom from the 4096 limit — leave ~96 bytes for growth
const MAX_CHAT_DATA = 1000; // the limit is 1024, keep headroom

const apiCall = async (method, payload) => {
  const res = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(data.description || `${method} failed`);
    err.code = data.error_code;
    throw err;
  }
  return data.result;
};

const zlibSize = (html) => zlib.deflateSync(Buffer.from(html, 'utf8'), { level: 9 }).length;

// Budgets are checked BEFORE sending; if we don't fit — return null and the caller falls back.
const buildWidget = (html, chatData) => {
  const cd = JSON.stringify(chatData);
  if (Buffer.byteLength(cd, 'utf8') > MAX_CHAT_DATA) return null;
  if (Buffer.byteLength(html, 'utf8') > MAX_RAW) return null;
  if (zlibSize(html) > MAX_ZLIB) return null;
  return { html, chatData: cd };
};

/* ---------- shared styles (compact dark Pricelex Worldwide card) ---------- */

const SHELL_CSS =
  'body{margin:0;background:transparent;font-family:system-ui,sans-serif}' +
  '.c{background:linear-gradient(165deg,#0a1c30,#050f1d);color:#eaf6ff;border:1px solid rgba(84,220,255,.22);border-radius:16px;padding:12px 12px 10px;max-width:340px}' +
  '.h{font-size:9px;letter-spacing:.3em;color:#7e94ad;font-weight:800;margin-bottom:8px}' +
  '.r{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;padding:3px 0;color:#bfe9ff}' +
  '.r b{color:#fff}' +
  '.s{font-size:10px;color:#7e94ad;text-align:center;margin:6px 0 8px}' +
  '.bt{display:block;width:100%;margin-top:8px;padding:10px;border:none;border-radius:12px;background:linear-gradient(92deg,#00c8ff,#17e9c0);color:#032730;font:800 13px system-ui;cursor:pointer}' +
  '.bt.w{background:rgba(0,200,255,.1);color:#bfe3ff;border:1px solid rgba(84,220,255,.25)}' +
  '.st{text-align:center;font-size:15px;font-weight:800;margin:6px 0 2px}' +
  '.row{display:flex;gap:8px;margin-top:8px}.row .bt{margin-top:0}' +
  '.gg{display:inline-block;width:12px;height:12px;border-radius:50%;background:#4285F4;color:#fff;font:800 9px/12px system-ui;text-align:center;vertical-align:-1px}';

// Shared number-formatting JS helper in the "1 234 567" style (no toLocaleString — QuickJS may lack ICU).
const GRP =
  'function g(n){n=Math.round(Number(n)||0);var s=String(Math.abs(n)),r="";while(s.length>3){r=" "+s.slice(-3)+r;s=s.slice(0,-3)}return (n<0?"-":"")+s+r}';

// chatData is passed to and parsed by the widget at runtime (TelegramWidget.chatData → JSON.parse),
// so all inner JS is static — no substitutions at build time.
// Виджет курсов: у каждой карты своя строка со своим курсом (BTC за $1 номинала).
const ratesHtml = () => `<!doctype html><meta charset="utf-8"><style>${SHELL_CSS}</style>
<div class="c"><div class="h">✦ Pricelex Worldwide · КУРСЫ КАРТ</div><div id="r"></div>
<button class="bt" id="ex">💱 Сдать карту</button></div>
<script>var W=window.TelegramWidget,d={};try{d=JSON.parse(W.chatData||"{}" )}catch(e){}
var rows=(d.r||[]).map(function(x){return '<div class="r"><span>🎁 '+x[0]+'</span><b>'+(x[2]?('1 $ = '+(Number(x[1])||0).toFixed(8)+' BTC'):'недоступна')+'</b></div>'}).join('');
document.getElementById("r").innerHTML=rows+
'<div class="r"><span>Регион / валюта</span><b>США · USD</b></div>'+
'<div class="s">'+(d.on?"🟢 Приём заявок открыт":"🔴 Приём заявок закрыт")+'</div>';
document.getElementById("ex").addEventListener("click",function(){W.request("ex")});</script>`;

const orderHtml = () => `<!doctype html><meta charset="utf-8"><style>${SHELL_CSS}</style>
<div class="c"><div class="h">✦ Pricelex Worldwide · ЗАЯВКА <span id="i"></span></div>
<div class="st" id="st"></div><div class="s" id="sub"></div>
<button class="bt" id="paid">✅ Я оплатил</button>
<button class="bt w" id="ref">🔄 Обновить</button>
<button class="bt w" id="cancel">❌ Отменить заявку</button></div>
<script>var W=window.TelegramWidget,d={};try{d=JSON.parse(W.chatData||"{}" )}catch(e){}
var L={new:"🕐 Ждём оператора",details:"🤝 Ждём код карты",paid:"⏳ Карта на проверке",completed:"🟢 Завершена",rejected:"🔴 Отклонена",cancelled:"⚪ Отменена"};
document.getElementById("i").textContent="#" + (d.id || "");
document.getElementById("st").textContent = L[d.st] || d.st || "";
document.getElementById("sub").textContent = "$" + (d.un || 0) + " → " + (d.cr || 0) + " BTC";
var p = document.getElementById("paid");
var canPaid = d.st === "new" && d.gc === 1;
if (!canPaid) { p.style.display = "none" }
p.addEventListener("click", function(){ W.request("paid:" + d.id) });
document.getElementById("ref").addEventListener("click", function(){ W.request("ref:" + d.id) });
document.getElementById("cancel").addEventListener("click", function(){ W.request("cancel:" + d.id) });</script>`;

/* ---------- sending with a safe fallback ---------- */

const chatIdOf = (ctx) => ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id ?? ctx.from?.id;

const trySend = async (chatId, built, caption) => {
  if (!built || !chatId) return false;
  try {
    const payload = {
      chat_id: chatId,
      html: built.html,
      chat_data: built.chatData,
      allow_queries: true, // without it taps never reach the bot
    };
    if (caption) payload.caption = caption;
    await apiCall('sendWidget', payload);
    return true;
  } catch (e) {
    // INPUT_MEDIA_WIDGET_NOT_ALLOWED (sendWidget closed for regular bots) and everything else — fall back to a plain message.
    console.warn('[widget] sending unavailable, falling back to a plain message:', e.message);
    return false;
  }
};

// The "Pricelex Worldwide rates" widget. Returns false → the caller shows the plain menu.
const trySendRatesWidget = async (ctx) => {
  if (!widgetsEnabled()) return false;
  const built = buildWidget(ratesHtml(), ratesChatData());
  return trySend(chatIdOf(ctx), built, null);
};

// The "Order" widget. Returns false → the caller shows the plain order card.
const trySendOrderWidget = async (ctx, o) => {
  if (!widgetsEnabled()) return false;
  if (['completed', 'rejected', 'cancelled'].includes(o.status)) return false;
  const built = buildWidget(orderHtml(), orderChatData(o));
  return trySend(chatIdOf(ctx), built, `✦ Pricelex Worldwide · Заявка #${o.id}`);
};

/* ---------- widget_query handling ---------- */

// ALWAYS answer the query (otherwise the client gets a TIMEOUT), then push the fresh state if any.
async function handleWidgetQuery(ctx, wq, clientbot) {
  const qid = wq.id || null;
  const data = String(wq.data || '').slice(0, 64);
  const from = wq.from || {};
  const userId = String(from.id || '');
  const chatId = wq.chat?.id ?? ctx.chat?.id ?? Number(userId) ?? null;
  const messageId = wq.message_id ?? null;
  const answerJson = (obj) => apiCall('answerWidgetQuery', { widget_query_id: qid, data: JSON.stringify(obj) });
  const editState = (fresh) => {
    if (!fresh || !chatId || !messageId) return Promise.resolve();
    return apiCall('editMessageWidgetData', { chat_id: chatId, message_id: messageId, chat_data: JSON.stringify(fresh) })
      .catch((e) => console.error('[widget] edit:', e.message)); // "not modified" is fine too
  };
  const sendMenuShim = () => clientbot.sendClientMenu({
    chat: { id: chatId, type: 'private' },
    from: { id: from.id, first_name: from.first_name, username: from.username },
    reply: (text, opts) => ctx.reply(text, opts),
  });
  const loadOwn = (id) => {
    const o = store.getOrder(id);
    return o && String(o.userId) === userId ? store.expireIfNeeded(o) || o : null;
  };
  let answer = { ok: 1 };
  let fresh = null;
  try {
    const qType = wq.type && typeof wq.type === 'object' ? wq.type.type : (wq.type || 'data');
    if (qType && qType !== 'data') {
      answer = { ok: 0, e: 'unsupported_type' };
    } else if (data === 'ex') {
      await sendMenuShim();
      answer = { ok: 1 };
    } else if (data.startsWith('paid:')) {
      const res = await clientbot.clientPaidWidget({ from }, Number(data.slice(5)));
      fresh = res && res.order ? orderChatData(res.order) : null;
      answer = res && res.ok ? { ok: 1 } : { ok: 0, e: (res && res.error) || 'not_allowed' };
    } else if (data.startsWith('cancel:')) {
      const res = await clientbot.clientCancelWidget({ from }, Number(data.slice(7)));
      fresh = res && res.order ? orderChatData(res.order) : null;
      answer = res && res.ok ? { ok: 1 } : { ok: 0, e: (res && res.error) || 'not_allowed' };
    } else if (data.startsWith('ref:')) {
      const o = loadOwn(Number(data.slice(4)));
      fresh = o ? orderChatData(o) : null;
      answer = o ? { ok: 1 } : { ok: 0, e: 'not_found' };
    } else {
      answer = { ok: 0, e: 'unknown' };
    }
  } catch (e) {
    console.error('[widget] query:', e.message);
    answer = { ok: 0, e: 'internal' };
  }
  if (qid) {
    await answerJson(answer).catch((e) => console.error('[widget] answer:', e.message));
  }
  await editState(fresh);
}

module.exports = {
  __setFetch,
  widgetsEnabled,
  trySendRatesWidget,
  trySendOrderWidget,
  handleWidgetQuery,
  // exports for tests/size debugging:
  _buildWidget: buildWidget,
  _ratesHtml: ratesHtml,
  _orderHtml: orderHtml,
  _zlibSize: zlibSize,
  _ratesChatData: ratesChatData,
  _orderChatData: orderChatData,
};

function ratesChatData() {
  const s = store.get().settings;
  // [название, курс BTC за $1, доступна] для каждой карты отдельно.
  return {
    r: currencies.list().map((p) => [
      p.label.replace(' Gift Card', ''),
      Number(currencies.rateOf(s, p.currency)) || 0,
      currencies.isEnabled(s, p.key) ? 1 : 0,
    ]),
    on: !!s.online,
  };
}

function orderChatData(o) {
  return {
    id: o.id,
    st: o.status,
    un: Number(o.units) || 0,
    cr: Number(o.crypto) || 0,
    gc: o.giftCode ? 1 : 0,
  };
}
