// ISOLATED-world adapter. Only a single HTTP request crosses each MessagePort.
(function () {
  'use strict';
  const NS = window.__VintedRelister = window.__VintedRelister || {};
  const pending = new Set();
  const failure = (message, check, name = 'Error') => Object.assign(new Error(message), {
    name, diagnostic: { phase: 'network', check },
  });
  const abortError = () => failure('Page fetch aborted.', 'page-fetch-aborted', 'AbortError');

  NS.pageFetch = async function (url, options = {}) {
    const target = new URL(url, location.origin);
    if (target.protocol !== 'https:' || target.origin !== location.origin || target.username || target.password) {
      throw new Error('Page fetch requires a same-origin HTTPS URL.');
    }
    const { signal } = options;
    if (signal?.aborted) throw abortError();
    const request = { type: 'vinted-republish:page-fetch:v1', id: crypto.randomUUID(), url: target.href,
      method: options.method || 'GET', headers: [...new Headers(options.headers)],
      credentials: options.credentials || 'include' };
    if (options.body instanceof FormData) {
      request.fields = [];
      for (const [name, value] of options.body) {
        request.fields.push(typeof value === 'string' ? { name, value } : {
          name, buffer: await value.arrayBuffer(), mime: value.type, filename: value.name || 'file',
        });
      }
    } else if (options.body != null) {
      if (typeof options.body === 'string' || options.body instanceof ArrayBuffer) request.body = options.body;
      else throw new Error('Unsupported page fetch body.');
    }
    if (signal?.aborted) throw abortError();

    return new Promise((resolve, reject) => {
      const { port1, port2 } = new MessageChannel();
      let settled = false;
      let accepted = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        pending.delete(navigate);
        port1.close();
        port2.close();
        if (error) reject(error); else resolve(response);
      };
      const abort = () => {
        port1.postMessage({ type: 'abort' });
        finish(failure(accepted ? 'Page fetch timed out or was aborted.' : 'Page fetch bridge did not respond. Reload the Vinted tab.',
          accepted ? 'page-fetch-timeout' : 'bridge-unavailable', 'AbortError'));
      };
      const navigate = () => {
        port1.postMessage({ type: 'abort' });
        finish(failure('Page navigation interrupted the request.', 'bridge-navigation', 'AbortError'));
      };
      const timer = setTimeout(abort, 60000);
      pending.add(navigate);
      signal?.addEventListener('abort', abort, { once: true });
      port1.onmessageerror = () => finish(failure('Unreadable page fetch response.', 'bridge-response'));
      port1.onmessage = event => {
        const reply = event.data;
        if (reply?.id !== request.id) return;
        if (reply.type === 'accepted') { accepted = true; return; }
        try {
          if (reply.error) throw failure(String(reply.error.message),
            ['page-fetch-setup', 'page-fetch', 'page-response-body'].includes(reply.error.check) ? reply.error.check : 'page-fetch',
            String(reply.error.name));
          if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599 ||
              !Array.isArray(reply.headers) || !(reply.buffer instanceof ArrayBuffer)) {
            throw failure('Invalid page fetch response.', 'bridge-response');
          }
          finish(null, new Response(['HEAD'].includes(request.method.toUpperCase()) || [204, 205, 304].includes(reply.status) ? null : reply.buffer,
            { status: reply.status, statusText: reply.statusText, headers: reply.headers }));
        } catch (error) { finish(error); }
      };
      try {
        // The port correlates the reply; the ID also rejects unrelated messages.
        // Never send leases, job state or extension control commands to the page.
        window.postMessage(request, location.origin, [port2]);
      } catch (error) { finish(failure(error.message, 'bridge-send', error.name)); }
    });
  };
  window.addEventListener('pagehide', () => { for (const abort of pending) abort(); });
})();
