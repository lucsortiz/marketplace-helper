// Account-protection guards added in this fork (see docs/ANTI_BAN.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const { IDBFactory } = require('fake-indexeddb');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const origin = 'https://www.vinted.fr';
const sender = { tab: { id: 1 }, documentId: 'doc-a', url: `${origin}/member/123`, frameId: 0 };
const HOUR = 3600000;
const blob = () => new Blob(['image bytes'], { type: 'image/jpeg' });
const item = id => ({ id, user_id: 123, title: 'Polo', price: { amount: '15', currency_code: 'EUR' },
  photos: [{ id: 1, url: 'https://images1.vinted.net/a' }] });

function env(settings = { quietHours: false }) {
  let now = 1_800_000_000_000;
  const bag = { republish_control_v1: { settings } };
  class Clock extends Date {
    constructor(...args) { if (args.length) super(...args); else super(now); }
    static now() { return now; }
  }
  const ctx = vm.createContext({ console, Blob, TextEncoder, crypto, indexedDB: new IDBFactory(), Promise, Date: Clock, URL,
    chrome: { storage: { local: {
      get: async name => ({ [name]: structuredClone(bag[name]) }),
      set: async values => Object.assign(bag, structuredClone(values)),
    } } } });
  vm.runInContext(source('src/jobStore.js') + source('src/coordinator.js'), ctx);
  const call = (action, values = {}, trusted = false) =>
    ctx.RepublishCoordinator.handle({ action, ...values }, sender, trusted ? null : origin, trusted);
  return { ctx, call, now: () => now, advance: ms => { now += ms; } };
}

// Runs one full relist of `itemId` that Vinted recreated as `newItemId`.
async function relist(e, itemId, newItemId) {
  const claim = await e.call('acquire');
  assert.ok(claim.lease, 'expected a lease');
  await e.call('seed', { accountId: '123', items: [item(itemId)] });
  await e.call('backup', { lease: claim.lease, accountId: '123', itemId: String(itemId), source: item(itemId), blobs: [blob()] });
  const key = `${origin}|123|${itemId}`;
  await e.call('patch', { lease: claim.lease, key, values: { stage: 'deleted', newItemId: String(newItemId) } });
  await e.call('finish', { lease: claim.lease, key });
  await e.call('release', { lease: claim.lease });
}

test('conservative defaults: 6 min ±50 %, 8/hour, 40/day, 72 h per item', async () => {
  const { settings } = await env().call('state', {}, true);
  assert.equal(settings.itemDelay, 6);
  assert.equal(settings.itemMin, 180); assert.equal(settings.itemMax, 540);
  assert.equal(settings.hourlyLimit, 8); assert.equal(settings.dailyLimit, 40);
  assert.equal(settings.itemCooldownHours, 72);
});

test('limits above the hard caps are clamped, per-item cooldown never below 24 h', async () => {
  const e = env();
  const saved = await e.call('settings', { settings: { hourlyLimit: 100, dailyLimit: 1000, itemCooldownHours: 1 } }, true);
  assert.equal(saved.hourlyLimit, 20); assert.equal(saved.dailyLimit, 150); assert.equal(saved.itemCooldownHours, 24);
  await assert.rejects(e.call('settings', { settings: { itemCooldownHours: 5000 } }, true), { code: 'settings' });
  await assert.rejects(e.call('settings', { settings: { quietStart: 24 } }, true), { code: 'settings' });
});

test('a freshly recreated listing cannot be relisted again before the cooldown', async () => {
  const e = env();
  await relist(e, 10, 20);
  await assert.rejects(e.call('item-check', { itemId: '20' }), { code: 'item-cooldown', until: e.now() + 72 * HOUR });
  await e.call('item-check', { itemId: '30' });
  e.advance(72 * HOUR + 1000);
  await e.call('item-check', { itemId: '20' });
});

test('the backup step also refuses an item in cooldown (defence in depth)', async () => {
  const e = env();
  await relist(e, 10, 20);
  e.advance(HOUR);
  const claim = await e.call('acquire');
  await e.call('seed', { accountId: '123', items: [item(20)] });
  await assert.rejects(e.call('backup', { lease: claim.lease, accountId: '123', itemId: '20', source: item(20), blobs: [blob()] }),
    { code: 'item-cooldown' });
});

test('"republish all" scans skip listings that are still in cooldown', async () => {
  const e = env();
  await relist(e, 10, 20);
  const scan = await e.call('scan-start', { sourceAccountId: '123' });
  const page = await e.call('scan-page', { sourceAccountId: '123', scanId: scan.scanId, page: 1, totalPages: 1, totalItems: 2,
    items: [item(20), item(31)] });
  assert.equal(page.added, 1);
  assert.equal(page.scan.skipped, 1);
});

test('quiet hours postpone new relists until the window ends', async () => {
  const probe = env();
  const hour = new probe.ctx.Date().getHours();
  const e = env({ quietHours: true, quietStart: hour, quietEnd: (hour + 2) % 24 });
  const claim = await e.call('acquire');
  assert.equal(claim.lease, undefined);
  assert.equal(claim.quiet, true);
  assert.ok(claim.waitMs > HOUR && claim.waitMs <= 2 * HOUR + 25 * 60000, `waitMs=${claim.waitMs}`);
});

test('quiet hours can be switched off', async () => {
  const probe = env();
  const hour = new probe.ctx.Date().getHours();
  const e = env({ quietHours: false, quietStart: hour, quietEnd: (hour + 2) % 24 });
  assert.ok((await e.call('acquire')).lease);
});

test('a restricted account pauses for at least 48 h and a plain reset keeps that pause', async () => {
  const e = env();
  const { until } = await e.call('refusal', { status: 403, restriction: true });
  assert.ok(until >= e.now() + 48 * HOUR);
  await e.call('reset-cooldown', {}, true);
  // Account requests stay blocked (local backups may still be completed).
  await assert.rejects(e.call('request'), { code: 'account-restricted' });
  await e.call('reset-cooldown', { force: true }, true);
  assert.equal(JSON.stringify(await e.call('request')), '{}');
});

test('an anti-bot challenge pauses for at least 6 h', async () => {
  const e = env();
  const { until } = await e.call('refusal', { status: 403, challenge: true });
  assert.ok(until >= e.now() + 6 * HOUR);
  await assert.rejects(e.call('acquire'), { code: 'anti-bot' });
});

test('a long break is added after a few completed relists', async () => {
  const e = env({ quietHours: false, itemDelay: 1, breakEvery: 2, breakMinutes: 30 });
  let longest = 0;
  for (let index = 0; index < 4; index++) {
    await relist(e, 100 + index, 200 + index);
    const claim = await e.call('acquire');
    longest = Math.max(longest, claim.waitMs || 0);
    e.advance(claim.waitMs || 0);
  }
  // Base delay is at most 1.9 min; a break adds 15–45 min on top.
  assert.ok(longest > 10 * 60000, `longest wait ${longest}`);
});
