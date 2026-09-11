// Runs only in the trusted extension service worker. No automatic submission.
(function (root) {
  const KEY = 'reporting_private_v1';
  let queue = Promise.resolve();
  const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const fault = code => Object.assign(new Error(code), { code });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function state() { return (await chrome.storage.local.get(KEY))[KEY] || { installationId: random(), receipts: [] }; }
  const save = s => chrome.storage.local.set({ [KEY]: s });
  async function request(path, options, retries = 1) {
    const origin = root.REPORTING_ORIGIN;
    if (!/^https:\/\/[^/?#]+$/.test(origin) || !(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) throw fault('permission');
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(origin + path, { ...options, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
        if (!response.ok) {
          const e = fault(response.status === 429 ? 'limited' : response.status === 404 ? 'missing' : 'http');
          e.status = response.status;
          // Best-effort: a body snippet is invaluable for local diagnosis
          // (see logs.html) and never reaches the extension's own error UI.
          try { e.bodySnippet = (await response.clone().text()).slice(0, 300); } catch (_) { /* ignore */ }
          throw e;
        }
        const text = await response.text(); if (text.length > 8192) throw fault('response');
        return JSON.parse(text);
      } catch (e) {
        // The same persisted idempotency key is used for the only POST retry.
        if (attempt >= retries || e.status || e.code || globalThis.navigator?.onLine === false) {
          // fault() builds a fresh Error carrying only `code` — without this,
          // the HTTP status and body captured just above were silently
          // dropped on every rethrow here, even though the caller (and the
          // local diagnostic log in background.js) expects `e.status` to be
          // the real status code, not always null.
          const rethrown = fault(e.code || 'offline');
          if (e.status != null) rethrown.status = e.status;
          if (e.bodySnippet != null) rethrown.bodySnippet = e.bodySnippet;
          throw rethrown;
        }
        await sleep(1000 * 2 ** attempt);
      } finally { clearTimeout(timer); }
    }
  }
  async function localReport(timestamp) {
    const stored = await chrome.storage.local.get(['vinted_local_reports_v1', 'vinted_last_report']);
    const reports = Array.isArray(stored.vinted_local_reports_v1) ? stored.vinted_local_reports_v1 : [];
    return reports.find(report => report?.timestamp === timestamp) ||
      (stored.vinted_last_report?.timestamp === timestamp ? stored.vinted_last_report : null);
  }
  function originalListingUrl(report) {
    const [origin, , itemId] = String(report?.jobKey || '').split('|');
    if (!/^https:\/\/www\.vinted\.[a-z.]+$/.test(origin) || !/^\d+$/.test(itemId)) return null;
    return `${origin}/items/${itemId}`;
  }
  function publicReceipt(receipt) {
    const { trackingToken, localTimestamp, nextCheck, failures, ...fields } = receipt;
    return { ...fields, reportTimestamp: localTimestamp };
  }
  async function submit(timestamp) {
    const local = await localReport(timestamp);
    if (!local?.payload) throw fault('no-report');
    const payload = local.payload;
    const s = await state();
    if (s.receipts.length >= 100) throw fault('capacity');
    // An unchanged report reuses its receipt rather than counting another occurrence.
    const previous = s.receipts.find(r => r.localTimestamp === local.timestamp);
    if (previous) return publicReceipt(previous);
    if (!s.pending || JSON.stringify(s.pending.payload) !== JSON.stringify(payload)) {
      s.pending = {
        key: random(), payload, localTimestamp: local.timestamp,
        listingTitle: String(local.listingTitle || '').slice(0, 300),
        listingUrl: originalListingUrl(local)
      }; await save(s);
    }
    const result = await request('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': s.pending.key, 'X-Installation-Id': s.installationId }, body: JSON.stringify(s.pending.payload) });
    if (!/^[a-f0-9-]{36}$/.test(result.id) || !/^[a-f0-9]{64}$/.test(result.trackingToken) || !['open', 'investigating', 'resolved'].includes(result.status)) throw fault('response');
    s.receipts.unshift({
      ...result, createdAt: new Date().toISOString(), localTimestamp: s.pending.localTimestamp,
      listingTitle: s.pending.listingTitle, listingUrl: s.pending.listingUrl || originalListingUrl(local),
      issueTitle: typeof result.issueTitle === 'string' ? result.issueTitle.slice(0, 240) : `[Extension] ${String(payload.errorMessage || 'Error').slice(0, 160)}`,
      issueUrl: typeof result.issueUrl === 'string' ? result.issueUrl : null,
      nextCheck: 0, failures: 0
    });
    s.pending = null; await save(s);
    return publicReceipt(s.receipts[0]);
  }
  async function statuses(force = false) {
    const s = await state();
    for (const r of s.receipts) {
      if (!r.listingUrl) r.listingUrl = originalListingUrl(await localReport(r.localTimestamp));
      if (!force && r.nextCheck > Date.now()) continue;
      try {
        const value = await request(`/api/reports/${encodeURIComponent(r.id)}`, { method: 'GET', headers: { Authorization: `Bearer ${r.trackingToken}` } }, 0);
        const issueUrlOk = value.issueUrl == null || /^https:\/\/github\.com\/vinted-republish\/vinted-republish\/issues\/\d+$/.test(value.issueUrl);
        if (value.id !== r.id || !['open', 'investigating', 'resolved'].includes(value.status) ||
            (value.resolutionMessage !== null && typeof value.resolutionMessage !== 'string') || !issueUrlOk ||
            (value.issueTitle != null && typeof value.issueTitle !== 'string')) throw fault('response');
        r.status = value.status; r.resolutionMessage = value.resolutionMessage?.slice(0, 1000) || null; r.updatedAt = value.updatedAt;
        r.issueUrl = value.issueUrl || null;
        if (value.issueTitle) r.issueTitle = value.issueTitle.slice(0, 240);
        r.failures = 0; r.lastError = null; r.nextCheck = Date.now() + (r.status === 'resolved' ? 86400000 : 15 * 60000);
      } catch (e) {
        r.failures = (r.failures || 0) + 1; r.lastError = e.code || 'offline';
        r.nextCheck = Date.now() + Math.min(86400000, 15 * 60000 * 2 ** Math.min(r.failures - 1, 7));
        // Avoid a long chain of requests while offline or lacking permission.
        if (['offline', 'permission', 'limited'].includes(r.lastError)) break;
      }
    }
    await save(s);
    return s.receipts.map(publicReceipt);
  }
  root.ReportingService = {
    handle(action, timestamp, force) {
      const next = queue.then(() => action === 'submit' ? submit(timestamp) : statuses(!!force));
      queue = next.catch(() => {}); return next;
    }
  };
})(globalThis);
