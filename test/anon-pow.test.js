const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
process.env.DATA_DIR = fs.mkdtempSync('/tmp/plx-pow-');
delete process.env.BOT_TOKEN;
process.env.POW_BITS = '10';
const session = require('../src/session');

test('браузерный PoW решается и проверяется сервером', async () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  const dom = new JSDOM(fs.readFileSync('public/index.html', 'utf8'), {
    runScripts: 'outside-only', url: 'https://example.test/?selftest=1',
  });
  dom.window.fetch = async () => ({ ok: false, json: async () => ({}), headers: { getSetCookie: () => [] } });
  dom.window.eval(fs.readFileSync('public/order-chat.js', 'utf8'));
  dom.window.eval(app);
  // app.js — IIFE: достаём функцию из области видимости через отладочный хвост.
  const solve = dom.window.__plxTest && dom.window.__plxTest.solveChallenge;
  assert.ok(solve, 'solveChallenge доступна для теста');
  const { challenge, bits } = session.issueChallenge();
  const t0 = Date.now();
  const nonce = await solve(challenge, bits);
  console.log('solved in', Date.now() - t0, 'ms, nonce', nonce);
  assert.ok(Number.isInteger(nonce));
  assert.equal(session.checkPow(challenge, nonce), true);
  assert.equal(session.checkPow(challenge, nonce + 1), false);
  dom.window.close();
});
