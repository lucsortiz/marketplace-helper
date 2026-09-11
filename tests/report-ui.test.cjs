const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../ui.js'), 'utf8');
test('report send updates only report controls and starts receipt polling', async () => {
  const calls = [];
  const code = source.slice(source.indexOf('  async function sendJobReport('), source.indexOf('  async function appendReportAction('));
  const context = vm.createContext({
    NS: { reporting: { async sendFromGesture(timestamp) { calls.push(timestamp); } } },
    async refreshReportAction(job) { calls.push(job.key); },
    async syncDetailReceipt(job, force) { calls.push(force); },
    openDetail() { assert.fail('Must not rebuild the listing'); },
  });
  vm.runInContext(code, context);
  await context.sendJobReport({ key: 'listing' }, { timestamp: 123 }, {}, {});
  assert.deepEqual(calls, [123, 'listing', true]);
});
test('report refresh leaves existing content visible during load and ignores a closed listing', async () => {
  let finish;
  let replaced = 0;
  const replacement = {};
  const existing = { replaceWith(value) { assert.equal(value, replacement); replaced++; } };
  const code = source.slice(source.indexOf('  async function refreshReportAction('), source.indexOf('  function stopIssueChase('));
  const context = vm.createContext({ detailKey: 'listing', $: () => existing,
    node: () => ({ firstElementChild: replacement }),
    appendReportAction: () => new Promise(resolve => { finish = resolve; }),
  });
  vm.runInContext(code, context);
  const pending = context.refreshReportAction({ key: 'listing' });
  assert.equal(replaced, 0);
  finish(); await pending;
  assert.equal(replaced, 1);
  const stale = context.refreshReportAction({ key: 'listing' });
  context.detailKey = 'another-listing';
  finish(); await stale;
  assert.equal(replaced, 1);
});
