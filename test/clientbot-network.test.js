const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'net2-'));
process.env.DATA_DIR=dir;
process.env.BOT_TOKEN='123456:test-token';
process.env.ADMIN_ID='111'; process.env.ADMIN_IDS='';
delete process.env.WIDGETS;
const store=require('../src/store');
const {createBot}=require('../src/bot');
const botInfo={id:123456,is_bot:true,first_name:'Test',username:'plx_test_bot'};
let bot=createBot({botInfo});
let seq=1000; let calls=[];
const attach=(b)=>{ b.api.config.use(async (_p, method, payload)=>{ calls.push({method,...payload}); return {ok:true,result: method==='answerCallbackQuery'?true:{message_id:++seq,date:1,chat:{id:Number(payload.chat_id)||0,type:'private'},text:payload.text||''}}; }); };
attach(bot);
const text=(id,value)=>bot.handleUpdate({update_id:++seq,message:{message_id:++seq,date:1,chat:{id,type:'private'},from:{id,first_name:'Client',is_bot:false},text:value,...(value.match(/^\/\S+/) ? {entities:[{type:'bot_command',offset:0,length:value.match(/^\/\S+/)[0].length}]}:{})}});
const click=(id,data)=>bot.handleUpdate({update_id:++seq,callback_query:{id:String(++seq),chat_instance:'test',from:{id,first_name:'Client',is_bot:false},data,message:{message_id:42,date:1,chat:{id,type:'private'},from:botInfo,text:'Order'}}});
const last=(m)=>[...calls].reverse().find(c=>c.method===m);
const kbs=(c)=>(c?.reply_markup?.inline_keyboard||[]).flat().map(b=>b.callback_data).filter(Boolean);
after(()=>fs.rmSync(dir,{recursive:true,force:true}));

test('выбор сети создаёт заявку и переживает рестарт бота', async () => {
  await text(999,'/start');
  await click(999,'c:exchange');
  await click(999,'c:buy:GOOGLE_USD');
  await click(999,'c:giftnom:GOOGLE_USD');
  await click(999,'c:units:GOOGLE_USD:100');
  const walletScreen = last('editMessageText');
  const netButtons = kbs(walletScreen).filter((d) => d.startsWith('c:pnet:'));
  assert.ok(netButtons.length >= 4, 'кнопки сетей присутствуют: ' + netButtons.join(','));
  assert.ok(netButtons.every((d) => d.split(':').length === 5), 'в кнопке есть карта, номинал и сеть');

  // РЕСТАРТ: состояние в памяти теряется, сообщение остаётся.
  calls = [];
  bot = createBot({ botInfo }); attach(bot);
  await click(999, netButtons.find((d) => d.includes('USDT_TRC20')));
  const afterRestart = last('editMessageText');
  assert.ok(afterRestart, 'после рестарта бот отвечает на выбор сети');
  assert.match(afterRestart.text, /Кошелёк для USDT \(TRC-20\)/);
  assert.match(afterRestart.text, /\$100/);

  // И сама заявка создаётся с выбранной сетью.
  await text(999, 'T' + '9aBcDeFgHiJkLmNoPqRsTuVwXyZ123456');
  const created = [...calls].reverse().find((c) => /создана/.test(c.text || ''));
  assert.ok(created, 'клиенту пришло подтверждение создания заявки');
  const order = store.userOrders('999')[0];
  assert.equal(order.payoutId, 'USDT_TRC20');
  assert.equal(order.networkFee, 1.5);
  assert.equal(order.crypto, 98.5); // $100 по курсу 1:1 минус 1.5 USDT сети
});

test('устаревшая кнопка сети без данных не роняет поток', async () => {
  calls = [];
  await click(999, 'c:pnet:USDT_ERC20');
  const res = last('editMessageText') || last('sendMessage');
  assert.ok(res, 'есть ответ');
  assert.match(res.text, /номинал|Кошелёк/i);
});

test('все сети выключены — выбор всё равно доступен', async () => {
  store.mutate((db) => { for (const k of Object.keys(db.settings.payoutEnabled)) db.settings.payoutEnabled[k] = false; });
  calls = [];
  await click(999,'c:giftnom:GOOGLE_USD');
  await click(999,'c:units:GOOGLE_USD:50');
  const w = last('editMessageText');
  const nets = kbs(w).filter((d) => d.startsWith('c:pnet:'));
  assert.ok(nets.length >= 4, 'сети показаны даже при выключенных настройках');
  store.mutate((db) => { for (const k of Object.keys(db.settings.payoutEnabled)) db.settings.payoutEnabled[k] = true; });
});
