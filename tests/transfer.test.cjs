const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const root = path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'src/transferStore.js'), 'utf8');
function store() {
  const context = vm.createContext({ indexedDB: new IDBFactory(), IDBKeyRange, crypto, Blob, TextEncoder, Promise, console });
  vm.runInContext(code, context);
  return context.TransferStore;
}

test('transfer batches keep complete photo bytes after account logout', async () => {
  const db = store();
  const batch = { id: 'batch-a', sourceProfile: { id: '123' }, status: 'capturing', createdAt: Date.now() };
  await db.putBatch(batch);
  const blobs = [new Blob(['photo one'], { type: 'image/jpeg' }), new Blob(['photo two'], { type: 'image/webp' })];
  await db.putItem({ key: 'batch-a:10', batchId: 'batch-a', itemId: '10', source: { id: 10, title: 'Polo' }, blobs, captureState: 'ready' });
  const [saved] = await db.items('batch-a');
  assert.equal(saved.blobs.length, 2);
  assert.equal(await saved.blobs[0].text(), 'photo one');
  assert.equal(saved.hashes.length, 3);
  assert.equal(saved.totalBytes, blobs[0].size + blobs[1].size);
});

test('removing one transfer batch does not touch another batch', async () => {
  const db = store();
  for (const id of ['a', 'b']) {
    await db.putBatch({ id, sourceProfile: { id }, createdAt: Date.now() });
    await db.putItem({ key: `${id}:10`, batchId: id, itemId: '10', source: { title: id }, blobs: [new Blob([id], { type: 'image/jpeg' })] });
  }
  await db.removeBatch('a');
  assert.equal((await db.items('a')).length, 0);
  assert.equal((await db.items('b')).length, 1);
  assert.equal((await db.batches()).length, 1);
});

test('synchronization can remove a listing without deleting its transfer batch', async () => {
  const db = store();
  await db.putBatch({ id: 'sync', sourceProfile: { id: '123' }, createdAt: Date.now() });
  await db.putItem({ key: 'sync:10', batchId: 'sync', itemId: '10', summary: { title: 'Ancienne annonce' }, blobs: [] });
  await db.putItem({ key: 'sync:11', batchId: 'sync', itemId: '11', summary: { title: 'Annonce conservée' }, blobs: [] });
  await db.removeItem('sync:10');
  assert.deepEqual((await db.items('sync')).map(item => item.itemId), ['11']);
  assert.equal((await db.batches()).length, 1);
});

test('transfer UI enforces the verified source deletion gate', () => {
  const ui = fs.readFileSync(path.join(root, 'transfer-ui.js'), 'utf8');
  const content = fs.readFileSync(path.join(root, 'src/content.js'), 'utf8');
  assert.match(ui, /selectedItems\(\)\.every\(item => item\.deleteState === 'deleted'\)/);
  assert.match(ui, /media\/account-placeholder\.png/);
  assert.match(ui, /titleFilter/);
  assert.match(ui, /priceMin/);
  assert.match(ui, /priceMax === priceCeiling/);
  assert.match(ui, /localStateCell/);
  assert.match(ui, /item\.selected && \['capturing', 'capture-error'\]/);
  assert.match(ui, /formatDuration/);
  assert.match(ui, /is-capturing/);
  assert.match(ui, /brandFilters\.has\('__other__'\)/);
  assert.match(ui, /only\.textContent = 'Uniquement'/);
  assert.match(ui, /transferCooldown/);
  assert.doesNotMatch(ui, /MAX_ITEMS/);
  assert.match(ui, /data-sort/);
  assert.match(ui, /dateAfter/);
  assert.match(ui, /async function syncSource/);
  assert.match(ui, /TransferStore\.removeItem/);
  assert.match(ui, /sourceListingCount: result\.items\.length/);
  assert.match(ui, /showTransferError/);
  assert.match(ui, /!== 'no-vinted-tab'/);
  assert.match(ui, /Suppression dans \$\{seconds\} s/);
  assert.match(ui, /label = 'À supprimer'/);
  assert.match(ui, /deleteCancellationRequested/);
  assert.match(ui, /randomDeletionDelayMs/);
  assert.match(ui, /\(6 \+ Math\.floor\(Math\.random\(\) \* 7\)\) \* 10 \* 1000/);
  assert.doesNotMatch(ui, /transferDeleteDelay/);
  assert.match(ui, /sendFromGesture\(activeReportTimestamp\)/);
  assert.match(ui, /sourceCounts: result\.counts/);
  assert.match(content, /img\.web_ui__Image__image\.web_ui__Image__circle/);
  assert.match(content, /for \(let page = 1; page <= 1000; page\+\+\)/);
  assert.match(content, /getCurrentAccountId\(true\).*String\(accountId\)/s);
  assert.match(content, /Vinted retourne encore l’annonce après la suppression/);
  assert.match(content, /Math\.min\(4, urls\.length\)/);
  assert.match(content, /fetchWardrobePage\(profile\.id, page, true, true\)/);
  assert.match(content, /alreadyDeleted: true/);
});

test('clean logout is restricted to the saved Vinted origin and preserves extension IndexedDB', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(background, /allowedOriginFromUrl\(msg\.origin\)/);
  assert.match(background, /chrome\.browsingData\.remove\(\{ origins: \[origin\] \}/);
  assert.doesNotMatch(background, /browsingData\.remove\(\{\s*since/);
});

test('diagnostic logs are retained by age instead of a short count cap', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const logsUi = fs.readFileSync(path.join(root, 'logs-ui.js'), 'utf8');
  assert.match(background, /ACTION_LOG_RETENTION_MS = 42 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(logsUi, /RETENTION_MS = 42 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(background, /vinted:ui-click/);
  assert.match(logsUi, /installClickLogger/);
  assert.doesNotMatch(background, /MAX_ACTION_LOGS/);
});

test('the failed-listings page lists only errored jobs, is deep-linkable and has no account picker', () => {
  const pending = fs.readFileSync(path.join(root, 'pending.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'ui.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.doesNotMatch(pending, /account-picker/);
  assert.doesNotMatch(pending, /src\/accountStore\.js/);
  assert.match(pending, /<a href="pending\.html" data-i18n="uiNavErrors" aria-current="page"><\/a>/);
  assert.match(ui, /new URLSearchParams\(location\.search\)\.get\('detail'\)/);
  assert.match(ui, /state\.jobs\.filter\(job => job\.status === 'error'\)/);
  assert.doesNotMatch(ui, /location\.replace\('welcome\.html'\)/);
  assert.match(background, /if \(typeof msg\.key !== 'string'\) return/);
});

test('the standalone reports page is gone and merged into the failed-listings page', () => {
  assert.equal(fs.existsSync(path.join(root, 'reports.html')), false);
  assert.equal(fs.existsSync(path.join(root, 'reports-ui.js')), false);
  for (const file of ['options.html', 'popup.html', 'welcome.html', 'transfert.html', 'logs.html']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /reports\.html/, `${file} still links reports.html`);
  }
});

test('a resolved failure clears the wardrobe error button and a fresh Republier drops the stale entry', () => {
  const content = fs.readFileSync(path.join(root, 'src/content.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'ui.js'), 'utf8');
  // Resolved jobs are excluded from the wardrobe "see details" state...
  assert.match(content, /job\.status === 'error' && !job\.resolved/);
  assert.match(content, /function clearErrorButton/);
  assert.match(content, /else if \(btn\.classList\.contains\('is-error'\)\) clearErrorButton\(btn\)/);
  // ...and a manual Republier forgets any existing error entry before reseeding.
  assert.match(content, /stale && stale\.status === 'error'/);
  assert.match(content, /NS\.control\('forget', \{ key: staleKey \}\)/);
  assert.match(content, /await NS\.seedJobs\(memberId, \[NS\.snapshotItem\(btn, itemId\)\]\)/);
  // The errors page still shows resolved entries with the resolved badge.
  assert.match(ui, /job\.status === 'error' && job\.resolved/);
  assert.match(ui, /'resolve-error'/);
});

test('transfer is launched from the wardrobe and verifies the source session', () => {
  const content = fs.readFileSync(path.join(root, 'src/content.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'src/i18n.js'), 'utf8');
  const transferUi = fs.readFileSync(path.join(root, 'transfer-ui.js'), 'utf8');
  const transferHtml = fs.readFileSync(path.join(root, 'transfert.html'), 'utf8');
  const transferCss = fs.readFileSync(path.join(root, 'transfer.css'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(i18n, /transferAccountButton: 'Transférer vers un autre compte'/);
  assert.match(content, /type: 'transfer:open'/);
  assert.match(content, /autoCapture: true/);
  assert.match(content, /filters\.insertBefore\(transfer, reference\)/);
  assert.match(background, /chrome\.runtime\.getURL\('transfert\.html'\)/);
  assert.match(background, /autoCapture.*'1'/);
  assert.match(transferUi, /sourceOrigin/);
  assert.match(transferUi, /sourceAccountId/);
  assert.match(transferUi, /const autoCapture = launchParams\.get\('autoCapture'\) === '1'/);
  assert.match(transferUi, /1\. Sauvegarder le compte A/);
  assert.match(transferUi, /if \(autoCapture\)/);
  assert.match(transferUi, /Capture des annonces/);
  assert.match(transferUi, /capture-loading-cell/);
  assert.match(transferUi, /captureListingBusy/);
  assert.match(transferCss, /@keyframes capture-spin/);
  assert.match(transferCss, /\.capture-loading-cell \{ text-align: center!important; \}/);
  assert.match(transferHtml, /<a href="transfert\.html" aria-current="page">Transfert<\/a>/);
  assert.match(transferHtml, /<section class="transfer-actions">/);
  assert.doesNotMatch(transferHtml, /<section class="card transfer-actions">/);
  assert.doesNotMatch(transferHtml, /Nouveau transfert/);
  assert.doesNotMatch(transferHtml, /Synchroniser/);
  assert.doesNotMatch(transferUi, /\$\('#new-batch'\)/);
  assert.doesNotMatch(transferUi, /\$\('#sync-source'\)/);
  assert.match(transferUi, /String\(result\.profile\.id\) !== launchSource\.accountId/);
  assert.doesNotMatch(transferUi, /ensureSession/);
  assert.doesNotMatch(background, /account:page/);
});
