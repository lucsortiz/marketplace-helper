const test = require('node:test');
const assert = require('node:assert/strict');
const { transport } = require('./helpers/page-transport.cjs');

test('same-origin API calls use current page instrumentation after the extension permit', async () => {
  const e = transport();
  e.NS.lease = 'extension-private-lease';
  let instrumented = false;
  e.mainWindow.fetch = async (url, init) => {
    assert.equal(e.controls[0].action, 'request');
    instrumented = true;
    assert.equal(init.credentials, 'include');
    assert.equal(init.headers.get('x-csrf-token'), 'csrf');
    assert.equal(init.body, '{"item":{}}');
    assert.equal(init.redirect, 'error');
    return new Response('{"item":{"id":20}}', { status: 201, headers: { 'x-test': 'page' } });
  };
  const response = await e.NS.network(e.origin + '/api/v2/item_upload/items', {
    method: 'POST', headers: { 'x-csrf-token': 'csrf' }, body: '{"item":{}}', publicRead: false,
  });
  assert.equal(instrumented, true);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-test'), 'page');
  assert.deepEqual(await response.clone().json(), { item: { id: 20 } });
  assert.match(await response.text(), /20/);
  assert.equal(e.isolatedCalls.length, 0);
  assert.equal(e.sent[0].target, e.origin);
  assert.equal(JSON.stringify(e.sent).includes('extension-private-lease'), false);
  assert.equal('publicRead' in e.sent[0].data, false);
  assert.equal(e.mainWindow.__VintedRelister, undefined);
});

test('multipart photo bytes, filename and repeated fields survive; boundary is browser-owned', async () => {
  const bytes = new Uint8Array([0, 255, 128, 12]);
  const e = transport({ pageFetch: async (_url, init) => {
    assert.equal(init.headers.has('content-type'), false);
    assert.deepEqual(init.body.getAll('tag'), ['one', 'two']);
    const file = init.body.get('photo[file]');
    assert.equal(file.name, 'photo.jpg');
    assert.equal(file.type, 'image/jpeg');
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    return new Response('{"id":101}', { status: 201 });
  } });
  const body = new FormData();
  body.append('tag', 'one'); body.append('tag', 'two');
  body.append('photo[file]', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
  assert.equal((await (await e.NS.network(e.origin + '/api/v2/photos', {
    method: 'POST', body, headers: { 'Content-TYPE': 'multipart/form-data' },
  })).json()).id, 101);
});

test('HTTP refusals and Retry-After still reach the extension coordinator intact', async () => {
  for (const [status, body, challenge, restriction] of [
    [429, 'slow down', false, false], [403, '<html>datadome</html>', true, false],
    [403, 'account restricted', false, true], [401, 'login', false, false],
  ]) {
    const e = transport({ pageFetch: async () => new Response(body, { status, headers: { 'retry-after': '86400' } }) });
    const response = await e.NS.network(e.origin + '/api/v2/items/10', { method: 'POST' });
    assert.equal(response.status, status); assert.equal(await response.text(), body);
    const refusal = e.controls.find(message => message.action === 'refusal');
    assert.equal(refusal.retryAfter, '86400'); assert.equal(refusal.challenge, challenge);
    assert.equal(refusal.restriction, restriction); assert.equal(e.pageCalls.length, 1);
  }
});

test('CDN photo reads retain isolated fetch while public item HTML uses page fetch', async () => {
  const e = transport();
  await e.NS.network('https://images1.vinted.net/photo.jpg', { credentials: 'omit', publicRead: true });
  await e.NS.network(e.origin + '/items/10', { publicRead: true });
  assert.equal(e.isolatedCalls.length, 1); assert.equal(e.pageCalls.length, 1);
  assert.equal(e.pageCalls[0].init.redirect, 'follow');
  assert.equal(e.pageCalls[0].init.mode, 'same-origin');
  // Only the `republish:control` channel carries `publicRead`; the local
  // `vinted:log-network` diagnostic message added alongside each request is
  // a different, unrelated message type and is excluded from this check.
  assert.ok(e.controls.filter(message => message.type === 'republish:control').every(message => message.publicRead === true));
});

test('a coordinator refusal prevents the request reaching the page', async () => {
  const e = transport({ control: async () => ({ ok: false, code: 'lease-lost', error: 'Lease expired' }) });
  await assert.rejects(e.NS.network(e.origin + '/api/v2/photos', { method: 'POST' }), { code: 'lease-lost' });
  assert.equal(e.sent.length, 0);
});

test('lost page response marks writes uncertain without isolated fallback or replay', async () => {
  const e = transport({ pageFetch: async () => { throw new TypeError('Connection lost'); } });
  await assert.rejects(e.NS.network(e.origin + '/api/v2/item_upload/items', { method: 'POST' }), { code: 'uncertain' });
  assert.equal(e.pageCalls.length, 1); assert.equal(e.isolatedCalls.length, 0);
  await assert.rejects(e.NS.network(e.origin + '/api/v2/items/10'), { code: 'network' });
});

test('abort cancels page fetch including a response body still downloading', async () => {
  let started, aborted;
  const ready = new Promise(resolve => { started = resolve; });
  const stopped = new Promise(resolve => { aborted = resolve; });
  const e = transport({ pageFetch: async (_url, init) => ({
    arrayBuffer: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted(); reject(new Error('Aborted body')); }, { once: true });
      started();
    }),
  }) });
  const controller = new AbortController();
  const request = e.NS.pageFetch(e.origin + '/api/v2/items/10', { signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await stopped;
});

test('missing bridge and page navigation reject pending requests', async () => {
  const e = transport({ noBridge: true });
  const request = e.NS.network(e.origin + '/api/v2/item_upload/items', { method: 'POST' });
  // Let the coordinator and transport enqueue the request before navigation.
  await new Promise(resolve => setImmediate(resolve));
  for (const fn of e.listeners.isolated.pagehide) fn();
  await assert.rejects(request, { code: 'uncertain' });
  assert.equal(e.isolatedCalls.length, 0);
});

test('missing bridge reaches the deadline without replaying an uncertain write', async () => {
  const e = transport({ noBridge: true, timeoutMs: 10 });
  await assert.rejects(e.NS.network(e.origin + '/api/v2/item_upload/items', { method: 'POST' }), error => {
    assert.equal(error.code, 'uncertain');
    assert.equal(error.diagnostic.check, 'bridge-unavailable');
    return true;
  });
  assert.equal(e.sent.length, 1); assert.equal(e.isolatedCalls.length, 0);
});

test('malformed page replies cannot become successful write responses', async () => {
  const e = transport({ pageFetch: async () => ({ status: 0, statusText: '', headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0) }) });
  await assert.rejects(e.NS.network(e.origin + '/api/v2/item_upload/items', { method: 'POST' }), { code: 'uncertain' });
  assert.equal(e.pageCalls.length, 1); assert.equal(e.isolatedCalls.length, 0);
});

test('parallel requests cannot swap replies and null-body statuses work', async () => {
  const e = transport({ pageFetch: async url => {
    if (url.endsWith('/slow')) await new Promise(resolve => setTimeout(resolve, 20));
    return url.endsWith('/empty') ? new Response(null, { status: 204 }) : new Response(url);
  } });
  const urls = ['/slow', '/fast', '/empty'].map(path => e.origin + path);
  const responses = await Promise.all(urls.map(url => e.NS.network(url)));
  assert.equal(await responses[0].text(), urls[0]); assert.equal(await responses[1].text(), urls[1]);
  assert.equal(responses[2].status, 204); assert.equal(await responses[2].text(), '');
});

test('foreign origins and frames cannot execute bridge requests', async () => {
  const e = transport();
  await assert.rejects(e.NS.pageFetch('https://example.com/api'), /same-origin/);
  let replies = [];
  const port = { postMessage: reply => replies.push(reply), close() {} };
  const request = { type: 'vinted-republish:page-fetch:v1', id: 'test', url: 'https://example.com/api' };
  const listener = e.listeners.main.message[0];
  listener({ data: request, ports: [port], source: e.mainWindow, origin: 'https://example.com' });
  listener({ data: request, ports: [port], source: {}, origin: e.origin });
  assert.equal(replies.length, 0);
  listener({ data: request, ports: [port], source: e.mainWindow, origin: e.origin });
  assert.match(replies.find(reply => reply.error).error.message, /same-origin/);
  assert.equal(e.pageCalls.length, 0);
});

test('failed public backup reads retain a precise diagnostic without listing identifiers', async () => {
  const e = transport({ pageFetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(e.NS.network(e.origin + '/items/123456789-private-title?token=secret', { publicRead: true }), error => {
    assert.equal(error.code, 'network');
    assert.equal(error.message, 'Failed to fetch');
    assert.equal(error.diagnostic.check, 'page-fetch');
    assert.equal(error.diagnostic.requestType, 'public-item');
    assert.equal(error.diagnostic.transport, 'page-fetch');
    assert.equal(error.diagnostic.method, 'GET');
    assert.ok(error.diagnostic.elapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /123456789|private-title|secret|token/);
    return true;
  });
});

test('a timeout after bridge acceptance is distinct from a missing bridge', async () => {
  const e = transport({ timeoutMs: 20, pageFetch: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }) });
  await assert.rejects(e.NS.network(e.origin + '/items/10'), error => {
    assert.equal(error.diagnostic.check, 'page-fetch-timeout'); return true;
  });
});
