const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../ui.js'), 'utf8');
const code = source.slice(source.indexOf('  function installBulkDelete()'), source.indexOf('  function confirmDelete()'));
for (const [scope, expected] of [['all', ['queued', 'resolved', 'error']], ['resolved', ['resolved']], ['error', ['error']]]) {
  test(`bulk delete selects ${scope} backups and retains busy jobs`, async () => {
    const elements = new Map();
    const $ = id => {
      if (!elements.has(id)) elements.set(id, { addEventListener() {}, showModal() {}, close() {}, focus() {} });
      return elements.get(id);
    };
    const forgotten = [];
    const context = vm.createContext({ $, t: (key, vars) => ({ key, ...vars }), status() {}, async refresh() {},
      NS: { async control(action, args) {
        if (action === 'state') return { jobs: [
          { key: 'queued', status: 'pending' }, { key: 'resolved', status: 'error', resolved: true }, { key: 'error', status: 'error' },
        ] };
        assert.equal(action, 'forget'); forgotten.push(args.key);
        if (args.key === 'error') throw new Error('busy');
      } },
    });
    vm.runInContext(code + '\ninstallBulkDelete();', context);
    await $('#delete-backups').onclick();
    assert.deepEqual(forgotten, []);
    await $('#bulk-delete-' + scope).onclick();
    assert.deepEqual(forgotten, expected);
    assert.equal($('#page-status').textContent.retained, expected.includes('error') ? 1 : 0);
    assert.equal($('#bulk-delete-cancel').disabled, false);
  });
}
