const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ops-'));
process.env.DATA_DIR=dir;
process.env.BOT_TOKEN='123456:test-token';
process.env.ADMIN_ID='111'; process.env.ADMIN_IDS='';
delete process.env.WIDGETS;
const store=require('../src/store');
const {createBot}=require('../src/bot');
const botInfo={id:123456,is_bot:true,first_name:'Test',username:'plx_test_bot'};
const bot=createBot({botInfo});
let seq=1000; let calls=[];
bot.api.config.use(async (_p, method, payload)=>{ calls.push({method,...payload}); return {ok:true,result: method==='answerCallbackQuery'?true:{message_id:++seq,date:1,chat:{id:Number(payload.chat_id)||0,type:'private'},text:payload.text||''}}; });
const text=(id,value)=>bot.handleUpdate({update_id:++seq,message:{message_id:++seq,date:1,chat:{id,type:'private'},from:{id,first_name:'Admin',is_bot:false},text:value,...(value.match(/^\/\S+/) ? {entities:[{type:'bot_command',offset:0,length:value.match(/^\/\S+/)[0].length}]}:{})}});
const click=(id,data)=>bot.handleUpdate({update_id:++seq,callback_query:{id:String(++seq),chat_instance:'test',from:{id,first_name:'Admin',is_bot:false},data,message:{message_id:42,date:1,chat:{id,type:'private'},from:botInfo,text:'Menu'}}});
const last=(m)=>[...calls].reverse().find(c=>c.method===m);
const kbs=(c)=>(c?.reply_markup?.inline_keyboard||[]).flat().map(b=>b.callback_data).filter(Boolean);
after(()=>fs.rmSync(dir,{recursive:true,force:true}));

test('оператор управляет сетями выплат из бота', async () => {
  calls=[]; await text(111,'/menu');
  await click(111,'m:settings');
  const menu = last('editMessageText');
  assert.ok(kbs(menu).includes('s:net_USDT_TRC20'), 'кнопки сетей в настройках');
  calls=[]; await click(111,'s:net_USDT_TRC20');
  assert.equal(store.get().settings.payoutEnabled.USDT_TRC20, false, 'сеть выключена');
  await click(111,'s:net_USDT_BEP20');
  assert.equal(store.get().settings.payoutEnabled.USDT_BEP20, true, 'BEP-20 выключить нельзя');
  await click(111,'s:net_USDT_TRC20');
  assert.equal(store.get().settings.payoutEnabled.USDT_TRC20, true, 'сеть включена обратно');
});

test('оператор создаёт, ставит на паузу и удаляет промокод из бота', async () => {
  calls=[]; await text(111,'/newpromo BOT10 10 5 100');
  const promo = store.getPromoByCode('BOT10');
  assert.ok(promo, 'промокод создан');
  assert.equal(promo.percent, 10);
  assert.equal(promo.maxUses, 5);
  assert.equal(promo.minUnits, 100);
  const menu = [...calls].reverse().find((c) => kbs(c).some((x) => x.startsWith('pr:t:')));
  assert.ok(menu && kbs(menu).includes(`pr:t:${promo.id}`), 'в меню есть управление');
  await click(111,`pr:t:${promo.id}`);
  assert.equal(store.getPromo(promo.id).active, false, 'пауза');
  await click(111,`pr:t:${promo.id}`);
  assert.equal(store.getPromo(promo.id).active, true, 'снова активен');
  await click(111,`pr:d:${promo.id}`);
  assert.equal(store.getPromo(promo.id), null, 'удалён');
  // обычный клиент не может создавать промокоды
  calls=[]; await text(999,'/newpromo HACK 50');
  assert.equal(store.getPromoByCode('HACK'), null);
});
