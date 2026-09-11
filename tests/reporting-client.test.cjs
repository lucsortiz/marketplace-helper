const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/reportingService.js'), 'utf8');

test('a report keeps its listing title local while its GitHub receipt stays linked', async () => {
  const bag = {
    vinted_local_reports_v1: [
      { timestamp: '2026-09-07T10:00:00.000Z', listingTitle: 'Doudou privé', jobKey: 'https://www.vinted.fr|private-account|12345', payload: { errorMessage: 'photos', stack: '', context: { check: 'created-photo-count' } } },
      { timestamp: '2026-09-07T09:00:00.000Z', listingTitle: 'Autre annonce', jobKey: 'other-job', payload: { errorMessage: 'other', stack: '', context: {} } },
    ]
  };
  let posted;
  const context = vm.createContext({
    console, crypto, setTimeout, clearTimeout, AbortController, navigator: { onLine: true },
    fetch: async (url, options) => {
      if (options.method === 'POST') {
        posted = JSON.parse(options.body);
        return new Response(JSON.stringify({ id: '12345678-1234-1234-1234-123456789abc', trackingToken: 'a'.repeat(64), status: 'open' }));
      }
      return new Response(JSON.stringify({ id: '12345678-1234-1234-1234-123456789abc', status: 'open', resolutionMessage: null,
        updatedAt: '2026-09-07T10:01:00.000Z', issueUrl: 'https://github.com/vinted-republish/vinted-republish/issues/2', issueTitle: '[Extension] photos' }));
    },
    Response,
    chrome: {
      permissions: { contains: async () => true },
      storage: { local: {
        get: async keys => {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.map(name => [name, structuredClone(bag[name])]).filter(([, value]) => value !== undefined));
        },
        set: async values => Object.assign(bag, structuredClone(values)),
      } }
    },
    REPORTING_ORIGIN: 'https://reporting.vinted-republish.workers.dev'
  });
  vm.runInContext(source, context);
  await context.ReportingService.handle('submit', '2026-09-07T10:00:00.000Z');
  assert.equal(posted.errorMessage, 'photos');
  assert.equal(JSON.stringify(posted).includes('Doudou privé'), false);
  assert.equal(JSON.stringify(posted).includes('private-account'), false);
  const [receipt] = await context.ReportingService.handle('statuses', null, true);
  assert.equal(receipt.listingTitle, 'Doudou privé');
  assert.equal(receipt.listingUrl, 'https://www.vinted.fr/items/12345');
  assert.equal(JSON.stringify(posted).includes('/items/12345'), false);
  assert.equal(receipt.reportTimestamp, '2026-09-07T10:00:00.000Z');
  assert.equal(receipt.issueTitle, '[Extension] photos');
  assert.equal(receipt.issueUrl, 'https://github.com/vinted-republish/vinted-republish/issues/2');
  assert.equal('trackingToken' in receipt, false);
});
