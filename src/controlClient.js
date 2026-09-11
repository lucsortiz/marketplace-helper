(function () {
  const NS = window.__VintedRelister = window.__VintedRelister || {};
  NS.control = async function (action, values = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'republish:control', action, ...values,
      ...(NS.lease ? { lease: NS.lease } : {}) });
    if (!response?.ok) throw Object.assign(new Error(response?.error || 'Extension unavailable'), { code: response?.code, until: response?.until });
    return response.value;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  NS.requestPermit = async (publicRead = false) => {
    for (;;) { const result = await NS.control('request', { publicRead }); if (!result.waitMs) return; await sleep(Math.min(result.waitMs, 1000)); }
  };
  // Diagnostic categories never include a listing ID, slug, query or token.
  function requestType(url) {
    const path = url.pathname;
    if (/^\/items\/\d/.test(path)) return 'public-item';
    if (path === '/items/new') return 'new-item-page';
    if (path === '/api/v2/users/current') return 'current-account';
    if (path === '/api/v2/photos') return 'photo-upload';
    if (/^\/api\/v2\/wardrobe\//.test(path)) return 'wardrobe';
    if (/^\/api\/v2\/item_upload\/size_groups/.test(path)) return 'size-groups';
    if (path === '/api/v2/item_upload/items') return 'item-create';
    if (/^\/api\/v2\/items\/\d+\/delete$/.test(path)) return 'item-delete';
    if (/^\/api\/v2\/(?:item_upload\/)?items\//.test(path)) return 'item-details';
    if (/^images[1-4]?\.vinted\.net$/.test(url.hostname)) return 'photo-download';
    return 'other';
  }
  // Everything below feeds only the local "logs" page (chrome.storage.local,
  // read by logs.html on this device). It never reaches the remote error
  // reports built by errorReporter.js/reportingSanitizer.js — those keep
  // using requestType()/e.diagnostic exactly as before, with no listing ID.
  const NETWORK_LOG_LIMIT = 4000;
  function truncateForLog(text) {
    return text.length > NETWORK_LOG_LIMIT ? `${text.slice(0, NETWORK_LOG_LIMIT)}…[tronqué, ${text.length} caractères au total]` : text;
  }
  function redactForLog(value, depth = 0) {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (depth > 8) return '[…]';
    if (Array.isArray(value)) return value.map(entry => redactForLog(entry, depth + 1));
    if (typeof value !== 'object') return String(value);
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = /token|cookie|csrf|description/i.test(key) ? '[masqué]' : redactForLog(entry, depth + 1);
    }
    return out;
  }
  function summarizeRequestBody(body) {
    if (body == null) return null;
    if (body instanceof FormData) {
      const parts = [];
      for (const [name, value] of body) {
        parts.push(typeof value === 'string' ? `${name}=${value}`
          : `${name}: [fichier ${value.name || 'sans nom'}, ${value.type || 'type inconnu'}, ${value.size || 0} octets]`);
      }
      return truncateForLog(parts.join('\n'));
    }
    if (typeof body !== 'string') return null;
    try { return truncateForLog(JSON.stringify(redactForLog(JSON.parse(body)))); }
    catch (_) { return truncateForLog(body); }
  }
  function summarizeResponseBody(bytes, contentType) {
    if (!bytes || !bytes.byteLength) return null;
    if (bytes.byteLength > 200000) return `[réponse ignorée : ${bytes.byteLength} octets, ${contentType || 'type inconnu'}]`;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { return `[réponse binaire, ${bytes.byteLength} octets, ${contentType || 'type inconnu'}]`; }
    try { return truncateForLog(JSON.stringify(redactForLog(JSON.parse(text)))); }
    catch (_) { return truncateForLog(text); }
  }
  function itemIdFromUrl(url) {
    return url.pathname.match(/\/items\/(\d+)/)?.[1] || null;
  }
  function logNetworkCall(detail) {
    try { chrome.runtime.sendMessage({ type: 'vinted:log-network', ...detail }).catch(() => {}); } catch (_) {}
  }

  NS.network = async function (url, options = {}) {
    const { publicRead = false, itemId = null, ...fetchOptions } = options;
    await NS.requestPermit(publicRead);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    const started = Date.now();
    const method = String(fetchOptions.method || 'GET').toUpperCase();
    let target, usePage = false, type = 'other', resolvedItemId = itemId;
    try {
      // Vinted API/HTML use the page's current fetch. CDN photos retain their
      // CORS transport and existing background fallback. Never replay a write
      // through another transport after a bridge failure.
      target = new URL(url, location.origin);
      type = requestType(target);
      if (!resolvedItemId) resolvedItemId = itemIdFromUrl(target);
      usePage = target.protocol === 'https:' && target.origin === location.origin;
      if (usePage && !NS.pageFetch) throw Object.assign(new Error('Page fetch bridge unavailable. Reload the Vinted tab.'),
        { diagnostic: { check: 'bridge-unavailable' } });
      const response = await (usePage ? NS.pageFetch : fetch)(url, { ...fetchOptions, signal: controller.signal });
      if ([401, 403, 429].includes(response.status)) {
        const body = await response.clone().text().catch(() => '');
        const challenge = /captcha-delivery|__cf_chl|cf_chl|datadome/i.test(body);
        const restriction = response.status === 403 && !challenge && (
          /\/api\/v2\/users\/current(?:[?#]|$)/.test(url) ||
          /restrict|suspend|blocked|banned|account[^\n]{0,40}(?:disabled|locked)/i.test(body)
        );
        await NS.control('refusal', { status: response.status, retryAfter: response.headers.get('retry-after'), challenge, restriction });
      }
      // Keep the timeout active until the response body is received too.
      const bytes = await response.arrayBuffer();
      logNetworkCall({
        eventType: type, itemId: resolvedItemId, method, transport: usePage ? 'bridge' : 'direct',
        status: response.status, ok: response.ok, durationMs: Date.now() - started,
        requestBody: summarizeRequestBody(fetchOptions.body),
        responseBody: summarizeResponseBody(bytes, response.headers.get('content-type')),
      });
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (e) {
      logNetworkCall({
        eventType: type, itemId: resolvedItemId, method, transport: usePage ? 'bridge' : 'direct',
        status: e.status ?? null, ok: false, durationMs: Date.now() - started,
        requestBody: summarizeRequestBody(fetchOptions.body), code: e.code || null,
        error: String(e.message || e).slice(0, 500),
      });
      e.diagnostic = { phase: 'network', check: e.diagnostic?.check || (usePage ? 'page-fetch' : 'isolated-fetch'),
        transport: usePage ? 'page-fetch' : 'isolated-fetch', method: String(fetchOptions.method || 'GET').toUpperCase(),
        requestType: target ? requestType(target) : 'invalid-url', elapsedMs: Date.now() - started };
      e.code = /^(POST|PUT|DELETE|PATCH)$/i.test(fetchOptions.method || '') ? 'uncertain' : 'network';
      throw e;
    } finally { clearTimeout(timer); }
  };
})();
