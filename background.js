importScripts('src/jobStore.js', 'src/coordinator.js', 'src/reportingConfig.js', 'src/reportingSanitizer.js', 'src/reportingService.js');

// Service worker : capture en lecture seule les jetons émis par Vinted,
// les conserve en mémoire de session par origine et fournit quelques
// opérations strictement bornées aux scripts de contenu Vinted.

const VINTED_ORIGINS = [
  'https://www.vinted.fr', 'https://www.vinted.de', 'https://www.vinted.it',
  'https://www.vinted.es', 'https://www.vinted.pt', 'https://www.vinted.nl',
  'https://www.vinted.be', 'https://www.vinted.pl', 'https://www.vinted.cz',
  'https://www.vinted.sk', 'https://www.vinted.hu', 'https://www.vinted.ro',
  'https://www.vinted.bg', 'https://www.vinted.lt', 'https://www.vinted.lv',
  'https://www.vinted.ee', 'https://www.vinted.gr', 'https://www.vinted.si',
  'https://www.vinted.hr', 'https://www.vinted.ie', 'https://www.vinted.at',
  'https://www.vinted.ch', 'https://www.vinted.dk', 'https://www.vinted.se',
  'https://www.vinted.no', 'https://www.vinted.fi', 'https://www.vinted.co.uk',
  'https://www.vinted.com',
];

const ALLOWED_ORIGINS = new Set(VINTED_ORIGINS);
const VINTED_IMAGE_HOSTS = new Set([
  'images.vinted.net',
  'images1.vinted.net',
  'images2.vinted.net',
  'images3.vinted.net',
  'images4.vinted.net',
]);
const TOKENS_BY_ORIGIN = new Map();
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ACTION_LOG_KEY = 'vinted_action_logs_v1';
const ACTION_LOG_RETENTION_MS = 42 * 24 * 60 * 60 * 1000;
const NOISY_CONTROL_ACTIONS = new Set(['state', 'cover', 'heartbeat', 'request', 'get', 'scan-state']);
const KNOWN_ACCOUNTS_KEY = 'vinted_known_accounts_v1';

try { chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch (_) {}
try { chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch (_) {}

function allowedOriginFromUrl(value) {
  try {
    const origin = new URL(value).origin;
    return ALLOWED_ORIGINS.has(origin) ? origin : null;
  } catch (_) {
    return null;
  }
}

function senderOrigin(sender) {
  return allowedOriginFromUrl(sender && sender.url);
}

function tokenStorageKey(origin) {
  return `vinted_tokens:${origin}`;
}

async function readTokens(origin) {
  if (!origin) return {};
  if (TOKENS_BY_ORIGIN.has(origin)) return TOKENS_BY_ORIGIN.get(origin);
  try {
    const key = tokenStorageKey(origin);
    const data = await chrome.storage.session.get([key]);
    const tokens = data && data[key] && typeof data[key] === 'object' ? data[key] : {};
    TOKENS_BY_ORIGIN.set(origin, tokens);
    return tokens;
  } catch (_) {
    return {};
  }
}

async function upsertTokensFromHeaders(origin, requestHeaders) {
  if (!origin || !Array.isArray(requestHeaders)) return;
  const current = Object.assign({}, await readTokens(origin));
  let changed = false;
  for (const h of requestHeaders) {
    if (!h || !h.name || !h.value) continue;
    const name = h.name.toLowerCase();
    if (name === 'x-csrf-token' && current.csrf !== h.value) {
      current.csrf = h.value;
      changed = true;
    } else if (name === 'x-anon-id' && current.anonId !== h.value) {
      current.anonId = h.value;
      changed = true;
    }
  }
  if (!changed) return;
  TOKENS_BY_ORIGIN.set(origin, current);
  try { await chrome.storage.session.set({ [tokenStorageKey(origin)]: current }); } catch (_) {}
}

async function clearTokens(origin) {
  if (!origin) return;
  TOKENS_BY_ORIGIN.delete(origin);
  try { await chrome.storage.session.remove(tokenStorageKey(origin)); } catch (_) {}
}

async function cleanVintedOrigin(origin) {
  await clearTokens(origin);
  await chrome.browsingData.remove({ origins: [origin] }, {
    cookies: true, indexedDB: true, localStorage: true, serviceWorkers: true, cacheStorage: true, webSQL: true,
  });
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  for (const tab of tabs) await chrome.tabs.update(tab.id, { url: `${origin}/` }).catch(() => {});
  return { tabs: tabs.length };
}

function isAllowedImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && VINTED_IMAGE_HOSTS.has(url.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function captureVintedRequestHeaders(details) {
  const origin = allowedOriginFromUrl(details.url);
  if (origin) void upsertTokensFromHeaders(origin, details.requestHeaders || []);
}

function enableHeaderCapture() {
  if (chrome.webRequest.onBeforeSendHeaders.hasListener(captureVintedRequestHeaders)) return;
  chrome.webRequest.onBeforeSendHeaders.addListener(
    captureVintedRequestHeaders,
    { urls: VINTED_ORIGINS.map(origin => `${origin}/api/*`) },
    ['requestHeaders']
  );
}

// Les permissions nécessaires sont accordées lors de l'installation : la
// capture en lecture seule peut donc être active immédiatement.
enableHeaderCapture();

function sanitizeLogDetail(value, depth = 0) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (depth > 3) return '[object]';
  if (Array.isArray(value)) return value.slice(0, 20).map(entry => sanitizeLogDetail(entry, depth + 1));
  if (typeof value !== 'object') return String(value);
  const blocked = new Set(['blobs', 'source', 'photos', 'description', 'cookie', 'csrf', 'anonId', 'token']);
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (blocked.has(key) || /token|cookie|csrf|description/i.test(key)) output[key] = '[masqué]';
    else output[key] = sanitizeLogDetail(entry, depth + 1);
  }
  return output;
}

async function storeActionLog(event, detail = {}) {
  const now = Date.now();
  const entry = {
    event: String(event || 'action').slice(0, 120),
    detail: sanitizeLogDetail(detail),
    timestamp: new Date(now).toISOString(),
  };
  try {
    const data = await chrome.storage.local.get(ACTION_LOG_KEY);
    const logs = Array.isArray(data[ACTION_LOG_KEY]) ? data[ACTION_LOG_KEY] : [];
    const retained = logs.filter(log => {
      const time = Date.parse(log?.timestamp || '');
      return Number.isFinite(time) && time >= now - ACTION_LOG_RETENTION_MS;
    });
    await chrome.storage.local.set({ [ACTION_LOG_KEY]: [entry, ...retained] });
  } catch (_) {}
}

async function rememberKnownAccount(origin, profile, listingCount = null, counts = null) {
  const id = String(profile?.id || '');
  if (!origin || !/^\d+$/.test(id)) return null;
  const key = `${origin}|${id}`;
  const count = Number(listingCount);
  const record = {
    key,
    origin,
    id,
    name: String(profile.name || profile.login || profile.username || `Compte ${id}`).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160),
    avatarUrl: /^https:\/\//.test(String(profile.avatarUrl || '')) ? String(profile.avatarUrl).slice(0, 2000) : '',
    listingCount: Number.isFinite(count) && count >= 0 ? Math.floor(count) : null,
    counts: counts && typeof counts === 'object' ? counts : null,
    updatedAt: Date.now(),
  };
  const data = await chrome.storage.local.get(KNOWN_ACCOUNTS_KEY);
  const accounts = data[KNOWN_ACCOUNTS_KEY] && typeof data[KNOWN_ACCOUNTS_KEY] === 'object' ? data[KNOWN_ACCOUNTS_KEY] : {};
  const previous = accounts[key] || {};
  const next = {
    ...previous,
    ...record,
    name: record.name && !/^Compte \d+$/.test(record.name) ? record.name : (previous.name || record.name),
    avatarUrl: record.avatarUrl || previous.avatarUrl || '',
    listingCount: record.listingCount ?? previous.listingCount ?? null,
    counts: record.counts || previous.counts || null,
  };
  await chrome.storage.local.set({ [KNOWN_ACCOUNTS_KEY]: { ...accounts, [key]: next } });
  return next;
}

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  // Nettoie les clés persistantes utilisées par les versions antérieures.
  try {
    chrome.storage.local.remove([
      'vinted_csrf_token',
      'vinted_anon_id',
      'vinted_settings',
    ]);
  } catch (_) {}
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const origin = senderOrigin(sender);

  if (msg && msg.type === 'vinted:getTokens') {
    if (!origin) { sendResponse({ csrf: null, anonId: null }); return false; }
    void readTokens(origin)
      .then(tokens => sendResponse({ csrf: tokens.csrf || null, anonId: tokens.anonId || null }))
      .catch(() => sendResponse({ csrf: null, anonId: null }));
    return true;
  }

  if (msg && msg.type === 'vinted:clearTokens') {
    if (!origin) { sendResponse({ ok: false }); return false; }
    void clearTokens(origin).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg && msg.type === 'vinted:rememberAccount') {
    if (!origin) { sendResponse({ ok: false }); return false; }
    void rememberKnownAccount(origin, msg.profile, msg.listingCount, msg.counts)
      .then(account => sendResponse({ ok: Boolean(account) }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg && msg.type === 'vinted:storeReport') {
    const reportOrigin = origin || (trustedPage(sender) ? allowedOriginFromUrl(msg.report?.pageOrigin) : null);
    if (!reportOrigin || !msg.report?.payload || typeof msg.report.payload.errorMessage !== 'string') {
      sendResponse({ ok: false }); return false;
    }
    const raw = msg.report.payload;
    const payload = {
      errorName: ReportingSanitizer.sanitizeText(String(raw.errorName || 'Error'), 100),
      errorMessage: ReportingSanitizer.sanitizeText(raw.errorMessage, 2000),
      stack: ReportingSanitizer.sanitizeText(String(raw.stack || ''), 8000),
      context: ReportingSanitizer.sanitizeContext(raw.context || {}),
      extensionVersion: chrome.runtime.getManifest().version,
      chromeVersion: /^[\d.]{1,40}$/.test(raw.chromeVersion) ? raw.chromeVersion : 'unknown',
      pageOrigin: reportOrigin
    };
    const suppliedTime = String(msg.report.timestamp || '');
    const timestamp = Number.isFinite(Date.parse(suppliedTime)) && Math.abs(Date.now() - Date.parse(suppliedTime)) < 5 * 60 * 1000
      ? suppliedTime : new Date().toISOString();
    const local = msg.report.privateContext || {};
    const report = {
      payload,
      detailText: JSON.stringify(payload, null, 2),
      timestamp,
      jobKey: typeof local.jobKey === 'string' ? local.jobKey.slice(0, 1000) : '',
      listingTitle: typeof local.listingTitle === 'string'
        ? local.listingTitle.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300) : ''
    };
    void (async () => {
      const data = await chrome.storage.local.get('vinted_local_reports_v1');
      const reports = Array.isArray(data.vinted_local_reports_v1) ? data.vinted_local_reports_v1 : [];
      const next = [report, ...reports.filter(value => value?.timestamp !== timestamp)].slice(0, 100);
      await chrome.storage.local.set({ vinted_last_report: report, vinted_local_reports_v1: next });
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg && msg.type === 'vinted:log-network') {
    if (!origin || !sender.tab || sender.frameId !== 0) return false;
    void storeActionLog(`requete:${String(msg.eventType || 'autre').slice(0, 60)}`, {
      origin,
      itemId: msg.itemId != null ? String(msg.itemId).slice(0, 40) : null,
      method: msg.method,
      transport: msg.transport,
      status: msg.status ?? null,
      ok: Boolean(msg.ok),
      durationMs: Number.isFinite(msg.durationMs) ? Math.round(msg.durationMs) : null,
      code: msg.code || null,
      error: msg.error || null,
      requestBody: msg.requestBody || null,
      responseBody: msg.responseBody || null,
    });
    return false;
  }

  if (msg && msg.type === 'vinted:fetchImageBuffer') {
    if (!origin || !isAllowedImageUrl(msg.url)) {
      sendResponse({ ok: false, error: 'Image URL not allowed.' });
      return false;
    }
    (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const res = await fetch(msg.url, { credentials: 'omit', redirect: 'follow', signal: controller.signal });
        const contentType = res.headers.get('content-type') || '';
        const declaredLength = Number(res.headers.get('content-length') || 0);
        if (!res.ok) {
          if ([401, 403, 429].includes(res.status)) await RepublishCoordinator.handle({ action: 'refusal', status: res.status, retryAfter: res.headers.get('retry-after') }, sender, origin, false);
          sendResponse({ ok: false, status: res.status, statusText: res.statusText });
          return;
        }
        if (!isAllowedImageUrl(res.url)) {
          sendResponse({ ok: false, error: 'Redirected image URL not allowed.' });
          return;
        }
        if (!contentType.toLowerCase().startsWith('image/')) {
          sendResponse({ ok: false, error: 'Unexpected content type.' });
          return;
        }
        if (declaredLength > MAX_IMAGE_BYTES) {
          sendResponse({ ok: false, error: 'Image is too large.' });
          return;
        }
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength > MAX_IMAGE_BYTES) {
          sendResponse({ ok: false, error: 'Image is too large.' });
          return;
        }
        sendResponse({ ok: true, buffer, contentType });
      } catch (error) {
        sendResponse({ ok: false, error: (error && error.message) || String(error) });
      } finally { clearTimeout(timer); }
    })();
    return true;
  }

  return false;
});

// UI commands are accepted only from our packaged extension pages.
function trustedPage(sender) {
  return sender.id === chrome.runtime.id && ['welcome.html', 'options.html', 'pending.html', 'transfert.html', 'popup.html', 'logs.html']
    .some(page => sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(page));
}
chrome.tabs.onRemoved.addListener(tabId => { void RepublishCoordinator.tabClosed(tabId); });
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type !== 'vinted:ui-click') return false;
  const origin = senderOrigin(sender);
  const trusted = trustedPage(sender);
  if ((!origin || !sender.tab || sender.frameId !== 0) && !trusted) {
    respond({ ok: false, code: 'forbidden' });
    return false;
  }
  void storeActionLog('clic:interface-extension', {
    trusted,
    origin,
    page: trusted ? (sender.url || '').split('/').pop().split(/[?#]/)[0] : (msg.page || 'vinted-content'),
    id: msg.id,
    text: msg.text,
    classes: msg.classes,
    href: msg.href,
  }).then(() => respond({ ok: true })).catch(error => respond({ ok: false, code: 'log', error: error.message }));
  return true;
});
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'republish:open-settings') {
    if (sender.id !== chrome.runtime.id || !senderOrigin(sender) || !sender.tab || sender.frameId !== 0) return false;
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }).then(() => respond({ ok: true })).catch(() => respond({ ok: false }));
    return true;
  }
  if (msg?.type === 'republish:openQueue') {
    // Opens the real toolbar popup. Chrome only honors this right after a
    // user gesture, which may or may not survive the message hop from the
    // content script's click handler — if it doesn't, this silently does
    // nothing rather than falling back to a tab (the user explicitly asked
    // for no fallback).
    if (sender.id !== chrome.runtime.id || !senderOrigin(sender) || !sender.tab || sender.frameId !== 0) return false;
    void chrome.action.openPopup().then(() => respond({ ok: true })).catch(() => respond({ ok: false }));
    return true;
  }
  if (msg?.type === 'republish:control') {
    const origin = senderOrigin(sender);
    const trusted = trustedPage(sender);
    const shouldLogControl = !NOISY_CONTROL_ACTIONS.has(msg.action);
    if ((!origin || !sender.tab || sender.frameId !== 0) && !trusted) { respond({ ok: false, code: 'forbidden' }); return false; }
    if (msg.action === 'import' && (!trusted || !ALLOWED_ORIGINS.has(msg.job?.sourceOrigin || msg.job?.origin) ||
        !ALLOWED_ORIGINS.has(msg.job?.targetOrigin || msg.job?.origin))) { respond({ ok: false, code: 'forbidden' }); return false; }
    RepublishCoordinator.handle(msg, sender, origin, trusted).then(value => {
      respond({ ok: true, value });
      if (msg.action === 'settings') void chrome.tabs.query({ url: VINTED_ORIGINS.map(o => `${o}/*`) }).then(tabs => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'republish:language', language: value.language }).catch(() => {});
          chrome.tabs.sendMessage(tab.id, { type: 'republish:settings', showTransferButton: value.showTransferButton === true }).catch(() => {});
        }
      });
      // The popup has no access to a dressing tab's in-memory queue — tell
      // any open one to drop this entry now that it actually forgot it,
      // instead of leaving it to error out once driveQueue reaches it.
      if (msg.action === 'forget' && msg.onlyIfQueued && !value?.retained) {
        void chrome.tabs.query({ url: VINTED_ORIGINS.map(o => `${o}/*`) }).then(tabs => {
          for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'republish:cancelQueued', key: msg.key }).catch(() => {});
        });
      }
      if (shouldLogControl) void storeActionLog(`republication:${msg.action}`, {
        trusted,
        origin,
        status: 'ok',
        key: msg.key || value?.key || value?.scan?.key,
        itemId: msg.itemId,
        accountId: msg.accountId || msg.sourceAccountId,
        stage: msg.values?.stage,
        added: value?.added,
        scanStatus: value?.scan?.status || value?.status,
        scanned: value?.scan?.scanned || value?.scanned,
      });
    })
      .catch(e => {
        if (shouldLogControl) void storeActionLog(`republication:${msg.action}`, { trusted, origin, status: 'error', code: e.code || 'storage', error: e.message, key: msg.key, itemId: msg.itemId });
        respond({ ok: false, code: e.code || 'storage', error: e.message, until: e.until });
      });
    return true;
  }
  if (msg?.type === 'republish:retry' && trustedPage(sender)) {
    (async () => {
      const job = await JobStore.get(msg.key);
      const sourceOrigin = job?.sourceOrigin || job?.origin;
      const sourceAccountId = String(job?.sourceAccountId || job?.accountId || '');
      if (!job || !ALLOWED_ORIGINS.has(sourceOrigin) || !/^\d+$/.test(sourceAccountId)) throw new Error('Invalid backup');
      // The opaque ticket is created before navigation and bound to one tab.
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      await chrome.storage.session.set({ [`republish_retry:${tab.id}`]: job.key });
      await chrome.tabs.update(tab.id, { url: `${sourceOrigin}/member/${sourceAccountId}` });
      await storeActionLog('republication:retry-ouverture', { origin: sourceOrigin, accountId: sourceAccountId, key: job.key, itemId: job.itemId });
      return { ok: true };
    })().then(respond).catch(e => respond({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'republish:ready' && senderOrigin(sender) && sender.tab && sender.frameId === 0) {
    (async () => {
      await RepublishCoordinator.handle({ action: 'page-ready' }, sender, senderOrigin(sender), false);
      const key = `republish_retry:${sender.tab.id}`;
      const value = (await chrome.storage.session.get(key))[key];
      await chrome.storage.session.remove(key);
      return { key: value || null };
    })().then(respond);
    return true;
  }
});

async function transferTab(origin) {
  const patterns = origin ? [`${origin}/*`] : VINTED_ORIGINS.map(value => `${value}/*`);
  const tabs = await chrome.tabs.query({ url: patterns });
  const candidates = tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of candidates) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'transfer:rpc', action: 'profile' });
      if (response?.ok) return { tab, origin: allowedOriginFromUrl(tab.url), profile: response.value.profile };
    } catch (_) {}
  }
  throw Object.assign(new Error('Ouvrez une page Vinted connectée dans un onglet.'), { code: 'no-vinted-tab' });
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type !== 'transfer:page') return false;
  if (!trustedPage(sender) || sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('transfert.html')) {
    respond({ ok: false, code: 'forbidden' }); return false;
  }
  (async () => {
    await storeActionLog(`transfert:${msg.action}:début`, {
      origin: msg.origin,
      accountId: msg.accountId,
      itemId: msg.itemId,
      hasSource: Boolean(msg.source),
      photoCount: Array.isArray(msg.blobs) ? msg.blobs.length : undefined,
    });
    if (msg.action === 'clean-logout') {
      const origin = allowedOriginFromUrl(msg.origin);
      if (!origin) throw Object.assign(new Error('Domaine Vinted invalide.'), { code: 'forbidden' });
      const cleaned = await cleanVintedOrigin(origin);
      await storeActionLog('transfert:clean-logout:terminé', { origin, tabs: cleaned.tabs });
      return { cleaned: true };
    }
    const selected = await transferTab(msg.origin ? allowedOriginFromUrl(msg.origin) : null);
    if (msg.action === 'profile') return { origin: selected.origin, profile: selected.profile };
    const allowed = new Set(['list', 'capture', 'delete', 'create']);
    if (!allowed.has(msg.action)) throw Object.assign(new Error('Action inconnue.'), { code: 'unknown-action' });
    const response = await chrome.tabs.sendMessage(selected.tab.id, {
      type: 'transfer:rpc', action: msg.action, limit: msg.limit, accountId: msg.accountId,
      itemId: msg.itemId, source: msg.source, blobs: msg.blobs,
    });
    if (!response?.ok) throw Object.assign(new Error(response?.error || 'Action Vinted impossible.'), { code: response?.code });
    await storeActionLog(`transfert:${msg.action}:terminé`, {
      origin: selected.origin,
      profileId: selected.profile?.id,
      itemId: msg.itemId,
      count: response.value?.items?.length,
      newItemId: response.value?.newItemId,
    });
    return { ...response.value, origin: selected.origin, profile: selected.profile };
  })().then(value => respond({ ok: true, value })).catch(error => {
    void storeActionLog(`transfert:${msg.action}:erreur`, { origin: msg.origin, itemId: msg.itemId, code: error.code || 'transfer', error: error.message });
    respond({ ok: false, code: error.code || 'transfer', error: error.message });
  });
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'transfer:open' && senderOrigin(sender) && sender.tab && sender.frameId === 0) {
    (async () => {
      const origin = senderOrigin(sender);
      const accountId = String(msg.accountId || '');
      if (!/^\d+$/.test(accountId)) throw new Error('Compte source invalide.');
      const url = new URL(chrome.runtime.getURL('transfert.html'));
      url.searchParams.set('sourceOrigin', origin);
      url.searchParams.set('sourceAccountId', accountId);
      if (msg.autoCapture) url.searchParams.set('autoCapture', '1');
      await storeActionLog('transfert:ouverture-depuis-dressing', { origin, accountId, autoCapture: Boolean(msg.autoCapture), page: sender.url });
      await chrome.tabs.create({ url: url.href });
      return { ok: true };
    })().then(respond).catch(error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (msg?.type === 'republish:openPending' && senderOrigin(sender)) {
    void (async () => {
      if (typeof msg.key !== 'string') return;
      const url = new URL(chrome.runtime.getURL('pending.html'));
      const job = await JobStore.get(msg.key);
      if (job?.origin !== senderOrigin(sender)) return;
      url.searchParams.set('detail', msg.key);
      await chrome.tabs.create({ url: url.href });
    })();
  }
});

// jobKey is stored as "origin|accountId|itemId" (see storeReport above) —
// reused here purely for local log correlation, never sent to the Worker.
function itemIdFromJobKey(jobKey) {
  const parts = String(jobKey || '').split('|');
  return parts.length >= 3 && /^\d+$/.test(parts[2]) ? parts[2] : null;
}

async function itemIdForReportTimestamp(timestamp) {
  if (timestamp == null) return null;
  const data = await chrome.storage.local.get(['vinted_local_reports_v1', 'vinted_last_report']);
  const reports = Array.isArray(data.vinted_local_reports_v1) ? data.vinted_local_reports_v1 : [];
  const report = reports.find(value => value?.timestamp === timestamp) ||
    (data.vinted_last_report?.timestamp === timestamp ? data.vinted_last_report : null);
  return itemIdFromJobKey(report?.jobKey);
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type !== 'reporting:command') return false;
  if (!trustedPage(sender) || !['submit', 'statuses'].includes(msg.action)) {
    respond({ ok: false, code: 'forbidden' }); return false;
  }
  // Local-only diagnostic trail for the manual report-sending flow: the click
  // on "Envoyer le rapport" was already logged (vinted:ui-click), but not the
  // actual attempt to reach the Worker nor its outcome. Both are logged here,
  // the single choke point for 'submit'/'statuses', regardless of which page
  // triggered it (pending.html, the in-page notice, transfer-ui.js).
  const startedAt = Date.now();
  void itemIdForReportTimestamp(msg.timestamp).then(itemId => storeActionLog(`signalement:${msg.action}-tentative`, {
    action: msg.action,
    itemId,
    reportTimestamp: msg.timestamp ?? null,
    force: Boolean(msg.force),
  }));
  ReportingService.handle(msg.action, msg.timestamp, msg.force).then(value => {
    void itemIdForReportTimestamp(msg.timestamp).then(itemId => storeActionLog(`signalement:${msg.action}-reponse`, {
      ok: true,
      itemId,
      durationMs: Date.now() - startedAt,
      // 'submit' resolves to one receipt; 'statuses' resolves to an array —
      // log whichever shape actually came back, without repeating every
      // receipt's full detail for a statuses refresh.
      receiptId: Array.isArray(value) ? null : (value?.id ?? null),
      status: Array.isArray(value) ? null : (value?.status ?? null),
      issueUrl: Array.isArray(value) ? null : (value?.issueUrl ?? null),
      reportTimestamp: Array.isArray(value) ? null : (value?.reportTimestamp ?? null),
      receiptsCount: Array.isArray(value) ? value.length : null,
    }));
    respond({ ok: true, value });
  }).catch(e => {
    void itemIdForReportTimestamp(msg.timestamp).then(itemId => storeActionLog(`signalement:${msg.action}-reponse`, {
      ok: false,
      itemId,
      durationMs: Date.now() - startedAt,
      code: e.code || 'offline',
      status: e.status ?? null,
      bodySnippet: e.bodySnippet ?? null,
      error: String(e.message || e).slice(0, 300),
    }));
    respond({ ok: false, code: e.code || 'offline' });
  });
  return true;
});
