const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const { IDBFactory } = require('fake-indexeddb');
const { transport } = require('./helpers/page-transport.cjs');
const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');
const origin = 'https://www.vinted.fr';
const sender = { tab: { id: 1 }, documentId: 'doc-a', url: `${origin}/member/123`, frameId: 0 };
const key = `${origin}|123|10`;
const blob = () => new Blob(['image bytes'], { type: 'image/jpeg' });
function env() {
  let now = 1_800_000_000_000;
  const bag = {};
  class Clock extends Date { static now() { return now; } }
  const ctx = vm.createContext({ console, Blob, TextEncoder, crypto, indexedDB: new IDBFactory(), Promise, Date: Clock, URL,
    chrome: { storage: { local: {
      get: async name => ({ [name]: structuredClone(bag[name]) }),
      set: async values => Object.assign(bag, structuredClone(values)),
    } } } });
  vm.runInContext(source('src/jobStore.js') + source('src/coordinator.js'), ctx);
  const call = (action, values = {}, who = sender, trusted = false) => ctx.RepublishCoordinator.handle({ action, ...values }, who, trusted ? null : origin, trusted);
  return { ctx, bag, call, clock: () => now, advance: ms => { now += ms; } };
}
const makeSource = () => ({ id: 10, user_id: 123, title: 'Polo', description: 'Coton', price: { amount: '15', currency_code: 'EUR' },
  brand_id: 7, brand_title: 'Brand', catalog_id: 42, size_id: 4, status_id: 2, package_size_id: 1,
  item_attributes: [{ code: 'size', ids: [4] }, { code: 'condition', ids: [2] }],
  is_reserved: false, is_closed: false, is_hidden: false, is_processing: false, is_draft: false,
  photos: [{ id: 1, url: 'https://images1.vinted.net/a' }, { id: 2, url: 'https://images1.vinted.net/b' }] });
async function engine(options = {}) {
  const e = env();
  let current = makeSource(), created = null, uploads = 0, creations = 0, deletions = 0, copyDeletions = 0, reads = 0;
  const removedIds = [];
  let loseCreate = !!options.loseCreate, loseDelete = !!options.loseDelete;
  const NS = {
    control: (action, values = {}) => e.call(action, { ...values, ...(NS.lease ? { lease: NS.lease } : {}) }),
    network: async url => {
      reads++;
      if (options.accountRestricted && url.includes('/api/v2/users/current')) return { ok: false, status: 403, text: async () => '{"code":"account_restricted"}' };
      return { ok: true, json: async () => url.includes('size_groups') ? { size_groups: [{ size_ids: [4] }] } : { user: { id: options.wrongAccount ? 456 : 123 } } };
    },
    getCsrf: async () => 'token', uuidv4: () => 'session', reportError() {},
    getItemDetails: async id => {
      const item = String(id) === '10' ? current : String(id) === '20' ? created : null;
      if (!item) throw Object.assign(new Error('Missing'), { code: 'missing' }); return structuredClone(item);
    },
    getItemDetailsForBackup: async () => { if (!current) throw Object.assign(new Error('Missing'), { code: 'missing' }); return structuredClone(current); },
    pickPhotos: value => value.photos.map(p => p.url), downloadAsBlob: async () => blob(),
    uploadPhoto: async () => { uploads++; if (options.badPhoto && uploads === 2) throw Object.assign(new Error('Photo failed'), { code: 'photos' }); return { id: 100 + uploads }; },
    createItem: async (_csrf, payload) => {
      creations++;
      created = { ...structuredClone(current || makeSource()), ...payload.item, id: 20, price_numeric: payload.item.price,
        photos: payload.item.assigned_photos.map(p => ({ id: p.id, url: 'https://images1.vinted.net/c' })) };
      if (options.badIdentity) created.photos.forEach(photo => { photo.id += 1000; });
      if (options.editOriginal) current.photos[0].id = 999;
      if (loseCreate) { loseCreate = false; throw Object.assign(new Error('Lost creation response'), { code: 'uncertain' }); }
      return { item: { id: 20 } };
    },
    verifyCreatedItem: async () => ({ ok: true, item: options.incompleteCopy ? { ...created, photos: [] } : structuredClone(created) }),
    deleteItem: async (_csrf, id) => {
      removedIds.push(String(id));
      if (String(id) === '20') {
        copyDeletions++;
        if (options.rejectCleanup) throw Object.assign(new Error('Cleanup refused'), { code: 'rate-limit', status: 429 });
        if (!options.keepCopy) created = null;
        if (options.loseCleanup) throw Object.assign(new Error('Cleanup response lost'), { code: 'uncertain' });
        return {};
      }
      assert.equal(String(id), '10');
      deletions++; current = null;
      if (loseDelete) { loseDelete = false; throw Object.assign(new Error('Lost delete response'), { code: 'uncertain' }); } return {};
    },
    fetchWardrobePage: async () => ({ items: [current, options.hideCreated ? null : created].filter(Boolean), pagination: { total_pages: 1 } }),
  };
  const content = source('src/content.js');
  const build = content.slice(content.indexOf('  function getAttributeIds'), content.indexOf('  NS.buildPayload = buildPayload;'));
  const ctx = vm.createContext({ window: { __VintedRelister: NS }, location: { origin }, console, Blob,
    setInterval: () => 1, clearInterval() {}, setTimeout: fn => fn(), JSON, Date });
  vm.runInContext(`${build}\nwindow.__VintedRelister.buildPayload = buildPayload;\n${source('src/republishEngine.js')}`, ctx);
  await NS.seedJobs('123', [current]);
  return { ...e, NS, run: () => NS.republish('10', '123'), stats: () => ({ current, created, uploads, creations, deletions, copyDeletions, removedIds, reads }), job: () => e.ctx.JobStore.get(key) };
}

test('one persistent lock across tabs and worker restarts; expired owner cannot write', async () => {
  const e = env(); const claim = await e.call('acquire');
  await assert.rejects(e.call('acquire', {}, { ...sender, tab: { id: 2 }, documentId: 'doc-b' }), { code: 'busy' });
  // Re-evaluate worker code with the same persisted chrome.storage state.
  vm.runInContext(source('src/coordinator.js'), e.ctx);
  await assert.rejects(e.call('acquire'), { code: 'busy' });
  e.advance(91000);
  await assert.rejects(e.call('request', { lease: claim.lease }), { code: 'lease-lost' });
});
test('default delay is 4.1–5.9 minutes after an attempt, persistent across calls', async () => {
  const e = env(); const claim = await e.call('acquire'); await e.call('release', { lease: claim.lease });
  const next = await e.call('acquire'); assert.ok(next.waitMs >= 246000 && next.waitMs <= 354000);
});
test('request cadence is shared, and Retry-After is never shortened', async () => {
  const e = env(); await e.call('request'); const second = await e.call('request'); assert.ok(second.waitMs >= 500 && second.waitMs <= 2500);
  await e.call('refusal', { status: 429, retryAfter: '86400' });
  await assert.rejects(e.call('request'), { code: 'rate-limit', until: e.clock() + 86400000 });
  await assert.rejects(e.call('acquire'), { code: 'rate-limit' });
});
test('normal publication removes its local backup only after verified success', async () => {
  const e = await engine(); const result = await e.run(); assert.equal(result.ok, true);
  assert.equal(e.stats().deletions, 1); assert.equal(await e.job(), undefined);
  const state = await e.call('state', {}, sender, true); assert.equal(state.jobs.length, 0); assert.equal(state.history.length, 1);
});
test('a legacy journal left after confirmed deletion is cleaned locally without another Vinted call', async () => {
  const e = env();
  const { lease } = await e.call('acquire');
  await e.call('seed', { accountId: '123', items: [makeSource()] });
  await e.call('backup', { lease, accountId: '123', itemId: '10', source: makeSource(), blobs: [blob()] });
  await e.call('patch', { lease, key, values: { stage: 'deleted', newItemId: '20' } });
  await e.call('release', { lease });
  e.advance(31000);
  const state = await e.call('state', {}, sender, true);
  assert.equal(state.jobs.length, 0); assert.equal(state.history.length, 1); assert.equal(await e.ctx.JobStore.get(key), undefined);
});
test('partial photo upload never creates or deletes; complete source backup stays in error', async () => {
  const e = await engine({ badPhoto: true }); assert.equal((await e.run()).ok, false);
  assert.equal(e.stats().creations, 0); assert.equal(e.stats().deletions, 0);
  const j = await e.job(); assert.equal(j.status, 'error'); assert.equal(j.blobs.length, 2);
  assert.equal(j.errorDetail.check, 'uploaded-photo-response'); assert.equal(j.errorDetail.uploadedPhotoCount, 1);
});
test('resolve-error marks a failed listing resolved without touching its backup', async () => {
  const e = await engine({ badPhoto: true }); await e.run();
  assert.equal((await e.job()).status, 'error');
  await e.call('resolve-error', { key }, sender, true);
  const j = await e.job();
  assert.equal(j.resolved, true); assert.equal(j.resolvedBy, 'manual'); assert.equal(j.status, 'error'); assert.equal(j.blobs.length, 2);
  assert.equal((await e.call('resolve-error', { key }, sender, true)).retained, true);
  assert.equal((await e.call('resolve-error', { key, by: 'issue' }, sender, true)).retained, true);
  // Untrusted callers cannot resolve.
  await assert.rejects(e.call('resolve-error', { key }));
  // Resolved listings still surface in state.jobs so they can be reviewed or forgotten.
  const state = await e.call('state', {}, sender, true);
  assert.equal(state.jobs.find(x => x.key === key)?.resolved, true);
});
test('incomplete created copy never deletes original or clears backup', async () => {
  const e = await engine({ incompleteCopy: true }); assert.equal((await e.run()).ok, false);
  const job = await e.job();
  assert.equal(e.stats().deletions, 0); assert.equal(job.newItemId, null); assert.equal(job.blobs.length, 2);
  assert.equal(e.stats().copyDeletions, 1); assert.equal(e.stats().created, null);
  assert.equal(job.stage, 'rolled-back'); assert.equal(job.errorDetail.cleanupStatus, 'removed');
  assert.equal(job.status, 'error'); assert.equal(job.errorDetail.check, 'created-photo-count');
  assert.equal(job.errorDetail.uploadedPhotoCount, 2); assert.equal(job.errorDetail.createdPhotoCount, 0);
});
test('lost create response is reconciled by uploaded photo IDs, never blindly recreated', async () => {
  const e = await engine({ loseCreate: true }); assert.equal((await e.run()).ok, false); assert.equal((await e.job()).stage, 'create-requested');
  e.advance(400000); assert.equal((await e.run()).ok, true); assert.equal(e.stats().creations, 1); assert.equal(e.stats().deletions, 1);
});
test('matching photo counts with different IDs deletes only the new copy and retains the backup', async () => {
  const e = await engine({ badIdentity: true });
  const result = await e.run(), job = await e.job();
  assert.equal(result.error.code, 'photos'); assert.equal(job.errorDetail.check, 'created-photo-identity');
  assert.equal(job.errorDetail.createdPhotoCount, 2); assert.equal(job.errorDetail.uploadedPhotoCount, 2);
  assert.deepEqual(e.stats().removedIds, ['20']); assert.equal(e.stats().current.id, 10); assert.equal(e.stats().created, null);
  assert.equal(job.stage, 'rolled-back'); assert.equal(job.errorDetail.cleanupStatus, 'removed');
  assert.equal(job.newItemId, null); assert.equal(job.blobs.length, 2); assert.equal(job.complete, true);
  assert.equal((await e.call('state', {}, sender, true)).history.length, 0);
});
test('cleanup refused by Vinted is durable and retry only cleans the existing copy', async () => {
  const options = { badIdentity: true, rejectCleanup: true };
  const e = await engine(options);
  assert.equal((await e.run()).error.code, 'cleanup-pending');
  let job = await e.job();
  assert.equal(job.stage, 'rollback-requested'); assert.equal(job.newItemId, '20');
  assert.equal(job.rollbackCause.code, 'photos'); assert.equal(job.errorDetail.cleanupReason, 'rate-limit');
  assert.equal(e.stats().current.id, 10); assert.equal(e.stats().created.id, 20);
  options.rejectCleanup = false; e.advance(400000);
  assert.equal((await e.run()).error.code, 'photos');
  job = await e.job();
  assert.equal(job.stage, 'rolled-back'); assert.equal(e.stats().created, null);
  assert.equal(e.stats().creations, 1); assert.equal(e.stats().uploads, 2); assert.equal(e.stats().deletions, 0);
});
test('a lost cleanup response is reconciled by reading the copy, without replay', async () => {
  const e = await engine({ badIdentity: true, loseCleanup: true });
  assert.equal((await e.run()).error.code, 'photos');
  assert.equal((await e.job()).stage, 'rolled-back');
  assert.equal(e.stats().copyDeletions, 1); assert.equal(e.stats().deletions, 0);
});
test('successful cleanup POST with copy still visible stays pending and prevents another creation', async () => {
  const e = await engine({ badIdentity: true, keepCopy: true });
  assert.equal((await e.run()).error.code, 'cleanup-pending');
  assert.equal((await e.job()).errorDetail.cleanupReason, 'cleanup-unconfirmed');
  e.advance(400000);
  assert.equal((await e.run()).error.code, 'cleanup-pending');
  assert.equal(e.stats().creations, 1); assert.equal(e.stats().deletions, 0);
});
test('copies left in created/error by an older version are cleaned before verifying or creating again', async () => {
  const e = await engine({ loseCreate: true });
  await e.run();
  await e.ctx.JobStore.put({ ...await e.job(), stage: 'created', newItemId: '20', error: 'photos',
    errorDetail: { phase: 'verify', check: 'created-photo-identity' }, status: 'error' });
  e.NS.verifyCreatedItem = async () => { throw new Error('Must not reverify an abandoned copy'); };
  e.advance(400000);
  await e.run();
  assert.equal((await e.job()).stage, 'rolled-back'); assert.equal(e.stats().creations, 1);
  assert.deepEqual(e.stats().removedIds, ['20']);
});
test('cleanup interrupted after deletion resumes by reading absence, not issuing another delete', async () => {
  const e = await engine({ badIdentity: true });
  const control = e.NS.control;
  let interrupted = false;
  e.NS.control = async (action, values) => {
    if (!interrupted && action === 'patch' && values?.values?.stage === 'rolled-back') {
      interrupted = true; throw Object.assign(new Error('Worker interrupted'), { code: 'storage' });
    }
    return control(action, values);
  };
  assert.equal((await e.run()).error.code, 'cleanup-pending');
  assert.equal((await e.job()).stage, 'rollback-requested'); assert.equal(e.stats().created, null);
  e.advance(400000); await e.run();
  assert.equal((await e.job()).stage, 'rolled-back'); assert.equal(e.stats().copyDeletions, 1); assert.equal(e.stats().creations, 1);
});
test('a failed cleanup-intent save prevents any deletion', async () => {
  const e = await engine({ badIdentity: true });
  const control = e.NS.control;
  e.NS.control = async (action, values) => {
    if (action === 'patch' && values?.values?.stage === 'rollback-requested') throw Object.assign(new Error('Disk unavailable'), { code: 'storage' });
    return control(action, values);
  };
  assert.equal((await e.run()).error.code, 'cleanup-pending');
  assert.deepEqual(e.stats().removedIds, []); assert.equal((await e.job()).stage, 'created');
});
test('missing original or changed account prevents deleting the remaining copy during cleanup', async () => {
  for (const missingOriginal of [true, false]) {
    const e = await engine({ badIdentity: true });
    const verify = e.NS.verifyCreatedItem;
    e.NS.verifyCreatedItem = async (...args) => {
      const result = await verify(...args);
      if (missingOriginal) {
        const details = e.NS.getItemDetails;
        e.NS.getItemDetails = async id => {
          if (String(id) === '10') throw Object.assign(new Error('Missing'), { code: 'missing' });
          return details(id);
        };
      } else e.NS.network = async () => ({ ok: true, json: async () => ({ user: { id: 456 } }) });
      return result;
    };
    assert.equal((await e.run()).error.code, 'cleanup-pending');
    assert.deepEqual(e.stats().removedIds, []); assert.equal((await e.job()).stage, 'rollback-requested');
  }
});
test('a failed verification after original deletion was requested must never clean up the copy', async () => {
  const e = await engine({ loseDelete: true }); await e.run();
  e.NS.verifyCreatedItem = async () => ({ ok: false, reason: 'unconfirmed' });
  e.advance(400000); await e.run();
  assert.equal((await e.job()).stage, 'delete-requested'); assert.equal(e.stats().copyDeletions, 0);
  assert.equal(e.stats().created.id, 20);
});
test('only an explicit later retry creates a replacement after completed cleanup', async () => {
  const options = { badIdentity: true };
  const e = await engine(options); await e.run();
  assert.equal(e.stats().creations, 1);
  options.badIdentity = false; e.advance(400000);
  assert.equal((await e.run()).ok, true); assert.equal(e.stats().creations, 2);
  assert.equal(e.stats().copyDeletions, 1); assert.equal(e.stats().deletions, 1);
});
test('cleanup cannot delete a reserved copy or a copy with a different owner', async () => {
  for (const foreignOwner of [true, false]) {
    const e = await engine({ badIdentity: true });
    const details = e.NS.getItemDetails;
    e.NS.getItemDetails = async id => {
      const item = await details(id);
      return String(id) === '20' ? { ...item, ...(foreignOwner ? { user_id: 456 } : { is_reserved: true }) } : item;
    };
    assert.equal((await e.run()).error.code, 'cleanup-pending'); assert.deepEqual(e.stats().removedIds, []);
  }
});
test('cleanup never targets the original when the stored copy ID equals its ID', async () => {
  const e = await engine({ loseCreate: true }); await e.run();
  await e.ctx.JobStore.put({ ...await e.job(), stage: 'created', status: 'error', newItemId: '10' });
  e.advance(400000); await e.run();
  assert.deepEqual(e.stats().removedIds, []); assert.equal((await e.job()).errorDetail.cleanupReason, 'unsafe-cleanup');
});
test('cancelling a cleanup countdown retains its durable journal and complete backup', async () => {
  const e = await engine({ badIdentity: true, rejectCleanup: true }); await e.run();
  const cancelled = await e.NS.republish('10', '123', () => {}, () => true);
  assert.equal(cancelled.cancelled, true);
  assert.equal((await e.call('forget', { key, onlyIfQueued: true })).retained, true);
  const job = await e.job(); assert.equal(job.stage, 'rollback-requested'); assert.equal(job.blobs.length, 2);
  await e.call('seed', { accountId: '123', items: [{ ...makeSource(), id: 11 }] });
  await e.call('forget', { key: `${origin}|123|11`, onlyIfQueued: true });
  assert.equal(await e.ctx.JobStore.get(`${origin}|123|11`), undefined);
});
test('a local backup cannot overwrite a copy awaiting cleanup', async () => {
  const e = await engine({ badIdentity: true, rejectCleanup: true }); await e.run(); e.advance(400000);
  const { lease } = await e.call('acquire');
  await assert.rejects(e.call('backup', { lease, accountId: '123', itemId: '10', source: makeSource(), blobs: [blob()] }), { code: 'uncertain' });
  assert.equal((await e.job()).stage, 'rollback-requested');
});
test('a creation response lost through the page bridge preserves the original and reconciles on resume', async () => {
  const e = await engine();
  const create = e.NS.createItem;
  const page = transport({ pageFetch: async (_url, options) => {
    await create('token', JSON.parse(options.body));
    throw new TypeError('Connection lost after server created the item');
  } });
  e.NS.createItem = async (_csrf, payload) => (await page.NS.network(page.origin + '/api/v2/item_upload/items', {
    method: 'POST', body: JSON.stringify(payload),
  })).json();
  assert.equal((await e.run()).error.code, 'uncertain');
  assert.equal((await e.job()).stage, 'create-requested');
  assert.equal((await e.job()).blobs.length, 2);
  assert.equal(e.stats().deletions, 0);
  e.advance(400000);
  assert.equal((await e.run()).ok, true);
  assert.equal(page.pageCalls.length, 1);
  assert.equal(e.stats().creations, 1); assert.equal(e.stats().deletions, 1);
});
test('queued backup network failures preserve transport diagnostics in the saved job', async () => {
  const e = await engine();
  const page = transport({ pageFetch: async () => { throw new TypeError('Failed to fetch'); } });
  e.NS.getItemDetailsForBackup = async () => page.NS.network(page.origin + '/items/10', { publicRead: true });
  assert.equal((await e.run()).error.code, 'network');
  const job = await e.job();
  assert.equal(job.stage, 'queued');
  assert.equal(job.errorDetail.check, 'page-fetch');
  assert.equal(job.errorDetail.requestType, 'public-item');
  assert.equal(job.errorDetail.method, 'GET');
  assert.equal(job.errorDetail.transport, 'page-fetch');
  assert.equal(e.stats().creations, 0); assert.equal(e.stats().deletions, 0);
});
test('direct creation through the bridge is verified before any original deletion', async () => {
  const e = await engine();
  const steps = [];
  const create = e.NS.createItem, verify = e.NS.verifyCreatedItem, remove = e.NS.deleteItem;
  const page = transport({ pageFetch: async (_url, options) => {
    steps.push('create');
    return new Response(JSON.stringify(await create('token', JSON.parse(options.body))), { status: 201 });
  } });
  e.NS.createItem = async (_csrf, payload) => (await page.NS.network(page.origin + '/api/v2/item_upload/items', {
    method: 'POST', body: JSON.stringify(payload),
  })).json();
  e.NS.verifyCreatedItem = async (...args) => { steps.push('verify'); return verify(...args); };
  e.NS.deleteItem = async (...args) => { steps.push('delete'); return remove(...args); };
  assert.equal((await e.run()).ok, true);
  assert.deepEqual(steps, ['create', 'verify', 'delete']);
  assert.equal(await e.job(), undefined);
});
test('lost delete response retains backup and resumes without a second creation', async () => {
  const e = await engine({ loseDelete: true }); assert.equal((await e.run()).ok, false);
  assert.equal((await e.job()).stage, 'delete-requested'); assert.equal((await e.job()).blobs.length, 2);
  e.advance(400000); assert.equal((await e.run()).ok, true); assert.equal(e.stats().creations, 1); assert.equal(e.stats().deletions, 1);
});
test('wrong account cannot publish a saved item', async () => {
  const e = await engine({ wrongAccount: true }); const result = await e.run(); assert.equal(result.error.code, 'account'); assert.equal(e.stats().uploads, 0); assert.equal(e.stats().deletions, 0);
});
test('restricted account keeps the complete listing and photos before the 403 error', async () => {
  const e = await engine({ accountRestricted: true });
  const result = await e.run();
  assert.equal(result.ok, false); assert.equal(result.error.code, 'account-restricted'); assert.equal(result.jobKey, key); assert.equal(result.backupComplete, true);
  const job = await e.job();
  assert.equal(job.status, 'error'); assert.equal(job.error, 'account-restricted'); assert.equal(job.complete, true);
  assert.equal(job.source.title, 'Polo'); assert.equal(job.source.description, 'Coton');
  assert.equal(job.source.price.amount, '15'); assert.equal(job.blobs.length, 2);
  assert.equal(e.stats().uploads, 0); assert.equal(e.stats().creations, 0); assert.equal(e.stats().deletions, 0);
});
test('cancelling an attempt before its turn keeps the listing pending without an error report', async () => {
  const e = await engine();
  const result = await e.NS.republish('10', '123', () => {}, () => true);
  assert.equal(result.ok, false); assert.equal(result.cancelled, true);
  const job = await e.job();
  assert.equal(job.status, 'incomplete'); assert.equal(job.error, undefined);
  assert.equal(e.stats().uploads, 0); assert.equal(e.stats().creations, 0); assert.equal(e.stats().deletions, 0);
});
test('an existing restriction gate still allows public backup reads but blocks account operations', async () => {
  const e = env();
  await e.call('refusal', { status: 403, restriction: true });
  const claim = await e.call('acquire'); assert.ok(claim.lease);
  await e.call('request', { lease: claim.lease, publicRead: true });
  await assert.rejects(e.call('request', { lease: claim.lease }), { code: 'account-restricted' });
  await e.call('release', { lease: claim.lease });
});
test('the preflight backup reads the public item endpoint without requiring CSRF', async () => {
  const page = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Polo', description: 'Coton', category: 'Vêtements',
    image: 'https://images1.vinted.net/a', offers: { price: 15, priceCurrency: 'EUR', url: `${origin}/items/10-polo` } })}</script>
    <button data-photoid="1"><img src="https://images1.vinted.net/a"></button>
    <button data-photoid="2"><img src="https://images1.vinted.net/b"></button>`;
  const calls = [];
  const NS = { network: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => page };
  } };
  const context = vm.createContext({
    window: { __VintedRelister: NS }, location: { origin, href: `${origin}/member/123`, hostname: 'www.vinted.fr' },
    document: { cookie: 'anon_id=anonymous', documentElement: {} }, console, URL, URLSearchParams, setTimeout, clearTimeout,
  });
  vm.runInContext(source('src/config.js') + source('src/vintedApi.js'), context);
  const summary = NS.wardrobeItemSummary({ id: 10, title: 'Polo', price: { amount: '15', currency_code: 'EUR' },
    created_at_ts: 1800000000, photos: [{ url: 'https://images1.vinted.net/a' }, { url: 'https://images1.vinted.net/b' }] });
  assert.equal(summary.photo_count, 2);
  assert.equal(summary.created_at, '2027-01-15T08:00:00.000Z');
  const datedFromPhoto = NS.wardrobeItemSummary({ id: 11, title: 'Robe', photo: {
    url: 'https://images1.vinted.net/t/03_example/800x1000/1780000000.webp', high_resolution: { timestamp: 1780000000 },
  } });
  assert.equal(datedFromPhoto.created_at, '2026-05-28T20:26:40.000Z');
  assert.equal(NS.isWardrobeItemEligible({ id: 12, user_id: 123, is_sold: true }, '123'), false);
  assert.equal(NS.isWardrobeItemEligible({ id: 13, user_id: 123, is_draft: true }, '123'), false);
  assert.equal(NS.isWardrobeItemEligible({ id: 14, user_id: 123, is_processing: true }, '123'), false);
  assert.equal(NS.isWardrobeItemEligible({ id: 15, user_id: 123, status: 'En cours de validation' }, '123'), false);
  const item = await NS.getItemDetailsForBackup('10');
  assert.equal(item.description, 'Coton'); assert.equal(item.category_title, 'Vêtements'); assert.equal(item.photos.length, 2); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${origin}/items/10`);
  assert.equal(calls[0].options.publicRead, true);
  assert.equal(calls[0].options.headers['x-csrf-token'], undefined);
});
test('Vinted block leaves all attempted items in error without sending network requests', async () => {
  const e = await engine(); await e.NS.seedJobs('123', [{ ...makeSource(), id: 11 }]);
  await e.call('refusal', { status: 429 }); const before = e.stats().reads;
  await e.run(); await e.NS.republish('11', '123');
  assert.equal(e.stats().reads, before);
  const jobs = (await e.call('state', {}, sender, true)).jobs; assert.equal(jobs.length, 2); assert.ok(jobs.every(j => j.status === 'error' && j.error === 'rate-limit'));
});
test('storage failure aborts before creating or deleting an item', async () => {
  const e = await engine(); const original = e.ctx.JobStore.put;
  e.ctx.JobStore.put = async j => { if (j.complete) throw new Error('QuotaExceeded'); return original(j); };
  assert.equal((await e.run()).ok, false); assert.equal(e.stats().creations, 0); assert.equal(e.stats().deletions, 0);
});

test('archive exports real photo bytes and rejects modified image data', async () => {
  const context = vm.createContext({ crypto, Blob, Uint8Array, btoa, atob });
  vm.runInContext(source('src/backupArchive.js'), context);
  const archive = await context.BackupArchive.encode({ key, source: makeSource(), blobs: [blob()] });
  const restored = await context.BackupArchive.decode(archive);
  assert.equal(await restored.blobs[0].text(), 'image bytes');
  const damaged = JSON.parse(await archive.text()); damaged.photos[0].data = btoa('other bytes');
  await assert.rejects(context.BackupArchive.decode(new Blob([JSON.stringify(damaged)])), /checksum/);
});
test('navigating the owner tab releases the old document lock without losing its backup', async () => {
  const e = env(); const { lease } = await e.call('acquire');
  await e.call('seed', { accountId: '123', items: [makeSource()] });
  await e.call('backup', { lease, accountId: '123', itemId: '10', source: makeSource(), blobs: [blob()] });
  await e.call('page-ready', {}, { ...sender, documentId: 'doc-new' });
  const j = await e.ctx.JobStore.get(key); assert.equal(j.status, 'waiting'); assert.equal(j.blobs.length, 1);
  await assert.rejects(e.call('patch', { lease, key, values: { done: true } }), { code: 'lease-lost' });
});
test('settings cannot remove locks or shorten a server pause', async () => {
  const e = env(); await e.call('refusal', { status: 429, retryAfter: '90000' });
  await assert.rejects(e.call('settings', { settings: { itemDelay: 0 } }, sender, true), { code: 'settings' });
  await e.call('settings', { settings: { itemDelay: 1, transferDeleteDelay: 2, hourlyLimit: 5, dailyLimit: 20 } }, sender, true);
  assert.equal((await e.call('state', {}, sender, true)).settings.transferDeleteDelay, undefined);
  await assert.rejects(e.call('request'), { until: e.clock() + 90000000 });
});

test('only extension pages can reset an active local cooldown', async () => {
  const e = env(); await e.call('refusal', { status: 429, retryAfter: '90000' });
  await assert.rejects(e.call('reset-cooldown'), { code: 'forbidden' });
  await e.call('reset-cooldown', {}, sender, true);
  const state = await e.call('state', {}, sender, true);
  assert.equal(state.gates[origin].blockedUntil, 0); assert.equal(state.gates[origin].nextItem, 0); assert.equal(state.gates[origin].nextRequest, 0);
  assert.equal(state.gates[origin].reason, null); assert.deepEqual(state.gates[origin].strikes, []);
  assert.ok((await e.call('acquire')).lease);
});

test('hourly and daily publication limits are enforced centrally', async () => {
  const e = env();
  await e.call('settings', { settings: { itemDelay: 1, hourlyLimit: 2, dailyLimit: 3 } }, sender, true);
  for (let index = 0; index < 2; index++) {
    const claim = await e.call('acquire');
    await e.call('seed', { accountId: '123', items: [{ ...makeSource(), id: 20 + index }] });
    await e.call('backup', { lease: claim.lease, accountId: '123', itemId: String(20 + index), source: makeSource(), blobs: [blob()] });
    const finishedKey = `${origin}|123|${20 + index}`;
    await e.call('patch', { lease: claim.lease, key: finishedKey, values: { stage: 'deleted', newItemId: String(120 + index) } });
    await e.call('finish', { lease: claim.lease, key: finishedKey });
    await e.call('release', { lease: claim.lease });
    e.advance(120000);
  }
  await assert.rejects(e.call('acquire'), { code: 'hour-limit' });
  e.advance(3600000);
  const claim = await e.call('acquire');
  await e.call('seed', { accountId: '123', items: [{ ...makeSource(), id: 30 }] });
  await e.call('backup', { lease: claim.lease, accountId: '123', itemId: '30', source: makeSource(), blobs: [blob()] });
  const finishedKey = `${origin}|123|30`;
  await e.call('patch', { lease: claim.lease, key: finishedKey, values: { stage: 'deleted', newItemId: '130' } });
  await e.call('finish', { lease: claim.lease, key: finishedKey });
  await e.call('release', { lease: claim.lease });
  e.advance(120000);
  await assert.rejects(e.call('acquire'), { code: 'day-limit' });
});

test('listing summaries accumulate locally without duplicate jobs and retain source/target identities', async () => {
  const e = env();
  const first = await e.call('seed', { accountId: '123', items: [makeSource(), { ...makeSource(), id: 11 }] });
  const second = await e.call('seed', { accountId: '123', items: [makeSource(), { ...makeSource(), id: 12 }] });
  assert.equal(first.added, 2);
  assert.equal(second.added, 1);
  const jobs = (await e.call('state', {}, sender, true)).jobs;
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every(job => job.status === 'incomplete' && job.stage === 'queued' && job.complete === false));
  assert.ok(jobs.every(job => job.schemaVersion === 2 && job.mode === 'relist'));
  assert.ok(jobs.every(job => job.sourceAccountId === '123' && job.targetAccountId === '123'));
  assert.ok(jobs.every(job => job.sourceOrigin === origin && job.targetOrigin === origin));
});

test('wardrobe scan pages are durable, resumable and cached after completion', async () => {
  const e = env();
  let scan = await e.call('scan-start', { sourceAccountId: '123' });
  assert.equal(scan.nextPage, 1);
  await assert.rejects(e.call('scan-start', { sourceAccountId: '123' }, { ...sender, tab: { id: 2 }, documentId: 'doc-b' }), { code: 'busy' });
  const first = await e.call('scan-page', { sourceAccountId: '123', scanId: scan.scanId, page: 1, totalPages: 2, totalItems: 3,
    items: [makeSource(), { ...makeSource(), id: 11 }] });
  assert.equal(first.scan.nextPage, 2); assert.equal(first.scan.added, 2);

  // Simulate a worker restart: the cursor lives in chrome.storage.local.
  vm.runInContext(source('src/coordinator.js'), e.ctx);
  scan = await e.call('scan-state', { sourceAccountId: '123' });
  assert.equal(scan.nextPage, 2); assert.equal(scan.scanned, 2);
  scan = await e.call('scan-start', { sourceAccountId: '123' });
  const second = await e.call('scan-page', { sourceAccountId: '123', scanId: scan.scanId, page: 2, totalPages: 2, totalItems: 3,
    items: [{ ...makeSource(), id: 12 }] });
  assert.equal(second.scan.added, 3); assert.equal(second.scan.scanned, 3);
  const complete = await e.call('scan-complete', { sourceAccountId: '123', scanId: scan.scanId });
  assert.equal(complete.status, 'complete');
  assert.equal((await e.call('scan-state', { sourceAccountId: '123' })).completedAt, e.clock());
  assert.equal((await e.call('state', {}, sender, true)).jobs.length, 3);
});

test('a future cross-account job is represented but cannot run before the transfer flow exists', async () => {
  const e = await engine();
  const job = await e.job();
  await e.ctx.JobStore.put({ ...job, schemaVersion: 2, mode: 'transfer', sourceOrigin: origin, sourceAccountId: '123',
    targetOrigin: origin, targetAccountId: '456', updatedAt: job.updatedAt + 1 });
  const result = await e.run();
  assert.equal(result.error.code, 'transfer-not-enabled');
  assert.equal(e.stats().uploads, 0); assert.equal(e.stats().creations, 0); assert.equal(e.stats().deletions, 0);
});

test('an uncertain creation without a unique match never creates a duplicate', async () => {
  const e = await engine({ loseCreate: true, hideCreated: true });
  assert.equal((await e.run()).ok, false);
  e.advance(400000);
  assert.equal((await e.run()).error.code, 'uncertain');
  assert.equal(e.stats().creations, 1); assert.equal(e.stats().deletions, 0);
  assert.equal((await e.job()).blobs.length, 2);
});
test('a photo edited on the original during creation prevents its deletion', async () => {
  const e = await engine({ editOriginal: true });
  assert.equal((await e.run()).error.code, 'original-changed');
  assert.equal(e.stats().deletions, 0); assert.equal((await e.job()).status, 'error');
});
test('a resumed journal cannot substitute different business fields for the saved source', async () => {
  const e = await engine({ loseCreate: true });
  await e.run();
  const job = await e.job(); job.expected.item.title = 'Different item';
  await e.ctx.JobStore.put(job);
  e.advance(400000);
  assert.equal((await e.run()).error.code, 'integrity');
  assert.equal(e.stats().creations, 1); assert.equal(e.stats().deletions, 0);
});
test('a profile with a shared numeric prefix cannot seed another account', async () => {
  const e = env();
  await assert.rejects(e.call('seed', { accountId: '123', items: [makeSource()] }, { ...sender, url: `${origin}/member/1234` }), { code: 'account' });
  await e.call('seed', { accountId: '123', items: [makeSource()] }, { ...sender, url: `${origin}/member/123-name` });
  assert.ok(await e.ctx.JobStore.get(key));
});
test('settings remain extension-only while the matching Vinted origin can forget its backup', async () => {
  const e = env();
  await e.call('seed', { accountId: '123', items: [makeSource()] });
  await assert.rejects(e.call('settings', { settings: { language: 'it' } }), { code: 'forbidden' });
  await e.call('forget', { key });
  assert.equal(await e.ctx.JobStore.get(key), undefined);
});
test('welcome opens on installation and never on update or Chrome update', async () => {
  let installed;
  const opened = [];
  const event = { addListener() {}, hasListener: () => false };
  const storage = { setAccessLevel() {}, remove() {} };
  const context = vm.createContext({ URL, console, importScripts() {},
    chrome: { storage: { local: storage, session: storage }, webRequest: { onBeforeSendHeaders: event },
      runtime: { onInstalled: { addListener(fn) { installed = fn; } }, onMessage: event, getURL: path => `chrome-extension://test/${path}` },
      tabs: { onRemoved: event, create: async values => opened.push(values.url) } } });
  vm.runInContext(source('background.js'), context);
  installed({ reason: 'update' }); installed({ reason: 'chrome_update' });
  assert.deepEqual(opened, []);
  installed({ reason: 'install' });
  assert.deepEqual(opened, ['chrome-extension://test/welcome.html']);
});

test('a refreshed wardrobe reclaims its scan without losing saved pages', async () => {
  const e = env();
  const old = await e.call('scan-start', { sourceAccountId: '123' });
  await e.call('scan-page', { sourceAccountId: '123', scanId: old.scanId, page: 1, totalPages: 2, totalItems: 2, items: [makeSource()] });
  const refreshed = { ...sender, documentId: 'doc-after-refresh' };
  const resumed = await e.call('scan-start', { sourceAccountId: '123' }, refreshed);
  assert.equal(resumed.nextPage, 2);
  assert.notEqual(resumed.scanId, old.scanId);
  await assert.rejects(e.call('scan-page', { sourceAccountId: '123', scanId: old.scanId, page: 2, totalPages: 2, totalItems: 2, items: [] }), { code: 'scan-lost' });
  await e.call('scan-page', { sourceAccountId: '123', scanId: resumed.scanId, page: 2, totalPages: 2, totalItems: 2, items: [{ ...makeSource(), id: 11 }] }, refreshed);
  const completed = await e.call('scan-complete', { sourceAccountId: '123', scanId: resumed.scanId }, refreshed);
  assert.equal(completed.scanned, 2);
});
