const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/content.js'), 'utf8');
// "Tout republier" now pushes its jobs into the same queue single items use
// (startBulk/driveQueue/performItem) instead of a dedicated loop, so this
// slice covers that whole unified machinery.
const code = source.slice(source.indexOf('  const queue = ['), source.indexOf('  async function queueAllItems('));
const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
for (const mode of ['success', 'failure', 'cancel']) {
  test(`bulk publishing runs sequentially with progress and cooldown (${mode})`, async () => {
    const labels = [], calls = [];
    const btn = {};
    // Filtering by origin/account/stage now happens in queueAllItems before
    // hand-off; startBulk itself just runs whatever jobs it's given.
    const jobs = [{ itemId: '1' }, { itemId: '2' }];
    let running = false;
    const context = vm.createContext({
      location: { origin: 'https://www.vinted.fr' },
      document: { querySelectorAll: () => [] },
      chrome: { runtime: { id: 'extension', onMessage: { addListener() {} }, sendMessage: async () => null } },
      setInterval: () => 1, clearInterval() {},
      formatClock: () => '14h00', updateQueueSummaryButton() {},
      message: (key, vars) => JSON.stringify({ key, ...vars }), phaseLabel: () => 'Creating',
      setCancelVisual() {}, showRepublishFailure() {}, republishErrorMessage: () => 'Error',
      savedErrorsByItem: new Map(), async syncSavedErrors() {},
      NS: {
        i18n: () => ({ relistButton: 'Republier', relistAllButton: 'Tout republier', clickToCancel: 'Annuler' }),
        setChipButtonText(_btn, text) { labels.push(text); },
        setButtonText() {}, showNotice() {},
        async control(action) { return action === 'state' ? { settings: { itemDelay: 5 }, gates: {} } : {}; },
        async republish(itemId, accountId, phase, cancelled) {
          assert.equal(running, false); running = true;
          assert.equal(accountId, '123'); calls.push(itemId);
          phase('cooldown', 65);
          if (mode === 'cancel') btn._cancelBulk();
          await Promise.resolve(); running = false;
          return cancelled() ? { cancelled: true } : mode === 'failure' ? { ok: false, error: {} } : { ok: true };
        },
      },
    });
    vm.runInContext(code, context);
    context.startBulk(btn, '123', jobs);
    assert.equal(btn.disabled, true);
    await flush();
    assert.deepEqual(calls, mode === 'success' ? ['1', '2'] : ['1']);
    // "Tout republier" itself never shows progress text — only the final
    // safety reset back to its own idle label.
    assert.deepEqual(labels, ['Tout republier']);
    assert.equal(btn.disabled, false);
    assert.equal(btn._cancelBulk, null);
  });
}
