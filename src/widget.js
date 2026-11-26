// Виджеты Telegram Bot API 10.4 (HTML-виджеты внутри сообщений бота).
// Важно: с 13–15.11.2026 Telegram закрыл sendWidget для обычных ботов даже в личке
// (INPUT_MEDIA_WIDGET_NOT_ALLOWED — подтверждено в репозитории Bot API).
// Поэтому виджет за флагом WIDGETS=1 и с безопасным откатом на обычное сообщение:
// пока Telegram не откроет доступ, бот работает как обычно.
//
// Протокол (Bot API 10.4, проверено по core.telegram.org/bots/widgets, 25.11.2026):
// • Сообщение несёт html (≤ 32 КБ сырьём, ≤ 4096 байт после zlib level 9) + chat_data (JSON-строка ≤ 1024 байт).
// • allow_queries: true обязателен — без него тапы не доходят до бота.
// • Страница читает TelegramWidget.chatData (СТРОКА, нужен JSON.parse), тап → TelegramWidget.request(data ≤ 64 Б).
// • Бот получает update widget_query: { id, from, chat?, message_id?, data, type: { type: 'data' } } —
//   поля chat/message_id лежат на верхнем уровне, а НЕ внутри message.
// • На каждый запрос надо ответить answerWidgetQuery(widget_query_id, data ≤ 1024 Б) в течение 15 с.
// • Состояние меняется только через editMessageWidgetData(chat_id, message_id, chat_data) → событие chatDataChanged.
// • fetch/XHR/WebSocket в виджете запрещены; только TelegramWidget.request().
const zlib = require('zlib');
const config = require('./config');
const store = require('./store');
const currencies = require('./currencies');

// Инъекция для тестов: по умолчанию — глобальный fetch.
let fetchImpl = (...args) => globalThis.fetch(...args);
const __setFetch = (fn) => { fetchImpl = fn; };

const widgetsEnabled = () => process.env.WIDGETS === '1';
const MAX_RAW = 32 * 1024;
const MAX_ZLIB = 4000; // запас от лимита 4096 — оставим ~96 байт на рост
const MAX_CHAT_DATA = 1000; // лимит 1024, держим запас

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

// Проверяем бюджеты ДО отправки; не влезаем — отдаём null, вызывающий уйдёт на fallback.
const buildWidget = (html, chatData) => {
  const cd = JSON.stringify(chatData);
  if (Buffer.byteLength(cd, 'utf8') > MAX_CHAT_DATA) return null;
  if (Buffer.byteLength(html, 'utf8') > MAX_RAW) return null;
  if (zlibSize(html) > MAX_ZLIB) return null;
  return { html, chatData: cd };
};

/* ---------- общие стили (компактная тёмная карточка VEGA) ---------- */

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

// Общий JS-помощник форматирования чисел в стиле «1 234 567» (без toLocaleString — в QuickJS может не быть ICU).
const GRP =
  'function g(n){n=Math.round(Number(n)||0);var s=String(Math.abs(n)),r="";while(s.length>3){r=" "+s.slice(-3)+r;s=s.slice(0,-3)}return (n<0?"-":"")+s+r}';

// chatData передаётся и парсится виджетом в рантайме (TelegramWidget.chatData → JSON.parse),
// поэтому весь внутренний JS статичен — нет подстановок на момент сборки.
const ratesHtml = () => `<!doctype html><meta charset="utf-8"><style>${SHELL_CSS}</style>
<div class="c"><div class="h">✦ VEGA · КУРСЫ</div><div id="r"></div>
<button class="bt" id="ex">💱 Выкупить карту</button></div>
<script>var W=window.TelegramWidget,d={};try{d=JSON.parse(W.chatData||"{}" )}catch(e){}
function g(n){n=Math.round(Number(n)||0);var s=String(Math.abs(n)),r="";while(s.length>3){r=" "+s.slice(-3)+r;s=s.slice(0,-3)}return (n<0?"-":"")+s+r}
document.getElementById("r").innerHTML='<div class="r"><span>🎁 USD gift-карты</span><b>1 $ = '+(Number(d.g)||0).toFixed(8)+' BTC</b></div>'+
'<div class="r"><span>Бренды</span><b>Google · iTunes · Xbox · Apple Store</b></div>'+
'<div class="s">'+(d.on?"🟢 Онлайн":"🔴 Оффлайн")+'</div>';
document.getElementById("ex").addEventListener("click",function(){W.request("ex")});</script>`;

const orderHtml = () => `<!doctype html><meta charset="utf-8"><style>${SHELL_CSS}</style>
<div class="c"><div class="h">✦ VEGA · ЗАЯВКА <span id="i"></span></div>
<div class="st" id="st"></div><div class="s" id="sub"></div>
<button class="bt" id="paid">✅ Я оплатил</button>
<button class="bt w" id="ref">🔄 Обновить</button>
<button class="bt w" id="cancel">❌ Отменить заявку</button></div>
<script>var W=window.TelegramWidget,d={};try{d=JSON.parse(W.chatData||"{}" )}catch(e){}
var L={new:"🕐 Ожидаем оператора",details:"🤝 Ожидает код карты",paid:"⏳ Карта на проверке",completed:"🟢 Завершена",rejected:"🔴 Отклонена",cancelled:"⚪ Отменена"};
document.getElementById("i").textContent="#" + (d.id || "");
document.getElementById("st").textContent = L[d.st] || d.st || "";
document.getElementById("sub").textContent = "$" + (d.un || 0) + " → " + (d.cr || 0) + " BTC";
var p = document.getElementById("paid");
var canPaid = d.st === "new" && d.gc === 1;
if (!canPaid) { p.style.display = "none" }
p.addEventListener("click", function(){ W.request("paid:" + d.id) });
document.getElementById("ref").addEventListener("click", function(){ W.request("ref:" + d.id) });
document.getElementById("cancel").addEventListener("click", function(){ W.request("cancel:" + d.id) });</script>`;

/* ---------- отправка с безопасным откатом ---------- */

const chatIdOf = (ctx) => ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id ?? ctx.from?.id;

const trySend = async (chatId, built, caption) => {
  if (!built || !chatId) return false;
  try {
    const payload = {
      chat_id: chatId,
      html: built.html,
      chat_data: built.chatData,
      allow_queries: true, // без него тапы не доходят до бота
    };
    if (caption) payload.caption = caption;
    await apiCall('sendWidget', payload);
    return true;
  } catch (e) {
    // INPUT_MEDIA_WIDGET_NOT_ALLOWED (обычным ботам закрыли доступ) и всё остальное — на обычное сообщение.
    console.warn('[widget] отправка недоступна, используем обычное сообщение:', e.message);
    return false;
  }
};

// Виджет «Курсы VEGA». Возвращает false → вызывающий показывает обычное меню.
const trySendRatesWidget = async (ctx) => {
  if (!widgetsEnabled()) return false;
  const built = buildWidget(ratesHtml(), ratesChatData());
  return trySend(chatIdOf(ctx), built, null);
};

// Виджет «Заявка». Возвращает false → вызывающий показывает обычную карточку заявки.
const trySendOrderWidget = async (ctx, o) => {
  if (!widgetsEnabled()) return false;
  if (['completed', 'rejected', 'cancelled'].includes(o.status)) return false;
  const built = buildWidget(orderHtml(), orderChatData(o));
  return trySend(chatIdOf(ctx), built, `✦ VEGA · Заявка #${o.id}`);
};

/* ---------- обработка widget_query ---------- */

// Отвечаем на запрос ВСЕГДА (иначе TIMEOUT у клиента), потом, если есть, пушим свежее состояние.
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
      .catch((e) => console.error('[widget] edit:', e.message)); // «not modified» тоже не страшно
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
  // экспорт для тестов/отладки размеров:
  _buildWidget: buildWidget,
  _ratesHtml: ratesHtml,
  _orderHtml: orderHtml,
  _zlibSize: zlibSize,
  _ratesChatData: ratesChatData,
  _orderChatData: orderChatData,
};

function ratesChatData() {
  const s = store.get().settings;
  return {
    g: Number(s.rateGOOGLEUSD) || 0,
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
