// Minimal MAIN-world transport. No extension APIs, storage or relisting policy.
// The page can observe/alter its own fetch and this channel; it is not a trust boundary.
(() => {
  'use strict';
  const protocol = 'vinted-republish:page-fetch:v1';
  const active = new Set();

  window.addEventListener('message', event => {
    const request = event.data;
    if (event.source !== window || event.origin !== location.origin ||
        request?.type !== protocol || typeof request.id !== 'string' ||
        event.ports.length !== 1) return;
    const port = event.ports[0];
    const controller = new AbortController();
    const abort = () => controller.abort();
    active.add(abort);
    // Bound execution even if the isolated world disappears without cancelling.
    const timer = setTimeout(abort, 60000);
    port.onmessage = event => { if (event.data?.type === 'abort') abort(); };
    port.onmessageerror = abort;

    (async () => {
      let check = 'page-fetch-setup';
      try {
        port.postMessage({ id: request.id, type: 'accepted' });
        const url = new URL(request.url, location.origin);
        if (url.protocol !== 'https:' || url.origin !== location.origin || url.username || url.password) {
          throw new Error('Page fetch requires a same-origin HTTPS URL.');
        }
        const method = String(request.method || 'GET').toUpperCase();
        if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Unsupported method.');
        const headers = new Headers(request.headers);
        let body = request.body;
        if (request.fields) {
          body = new FormData();
          for (const field of request.fields) {
            if (field.buffer instanceof ArrayBuffer) {
              body.append(field.name, new Blob([field.buffer], { type: field.mime }), field.filename);
            } else {
              body.append(field.name, field.value);
            }
          }
          // The browser must generate the multipart boundary, regardless of casing.
          headers.delete('content-type');
        }
        // Resolve at call time: retain instrumentation installed by Vinted after injection.
        check = 'page-fetch';
        const response = await window.fetch(url.href, {
          method, headers, body, credentials: request.credentials || 'include',
          // Public item URLs may redirect to their canonical slug before backup.
          // same-origin also rejects redirects to another origin. Writes never redirect.
          mode: 'same-origin', redirect: ['GET', 'HEAD'].includes(method) ? 'follow' : 'error', signal: controller.signal,
        });
        check = 'page-response-body';
        const buffer = await response.arrayBuffer();
        port.postMessage({ id: request.id, status: response.status, statusText: response.statusText,
          headers: [...response.headers], buffer }, [buffer]);
      } catch (error) {
        port.postMessage({ id: request.id, error: { check, name: String(error?.name || 'Error'),
          message: String(error?.message || 'Page fetch failed') } });
      } finally {
        clearTimeout(timer);
        active.delete(abort);
        port.close();
      }
    })();
  });
  window.addEventListener('pagehide', () => { for (const abort of active) abort(); });
})();
