const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const content = fs.readFileSync(path.join(__dirname, '../src/content.js'), 'utf8');
const init = content.slice(content.indexOf('  (async function init()'), content.lastIndexOf('\n})();'));
for (const preference of [undefined, true, false, 'unavailable']) {
  test(`content initializes without storage access (transfer preference: ${preference})`, async () => {
    let injected = 0;
    let updated = 0;
    const listeners = [];
    const context = vm.createContext({
      showTransferButton: false,
      // Off the dressing path so the auto-resume block (out of scope for
      // this test) short-circuits before touching document/NS.control again.
      location: { pathname: '/other' },
      NS: {
        DEFAULT_CONFIG: {}, localeReady: Promise.resolve(), ensureStyles() {},
        async control() {
          if (preference === 'unavailable') throw new Error('Storage unavailable');
          return { settings: { showTransferButton: preference } };
        },
      },
      chrome: {
        // No storage API: content must go through the worker.
        runtime: { id: 'extension', onMessage: { addListener(fn) { listeners.push(fn); } }, async sendMessage() { return null; } },
      },
      document: { documentElement: {}, addEventListener() {} },
      MutationObserver: class { observe() {} },
      clearTimeout, setTimeout,
      async injectButtons() { injected++; },
      injectRelistAllButton() { updated++; },
      async syncSavedErrors() {},
    });
    await vm.runInContext(init, context);
    assert.equal(injected, 1);
    assert.equal(context.showTransferButton, preference === true);
    listeners[0]({ type: 'republish:settings', showTransferButton: true }, { id: 'foreign' });
    assert.equal(updated, 0);
    listeners[0]({ type: 'republish:settings', showTransferButton: true }, { id: 'extension' });
    assert.equal(context.showTransferButton, true);
    listeners[0]({ type: 'republish:settings', showTransferButton: false }, { id: 'extension' });
    assert.equal(context.showTransferButton, false);
    assert.equal(updated, 2);
  });
}
