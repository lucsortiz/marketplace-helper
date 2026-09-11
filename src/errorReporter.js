// Capture only a bounded, sanitized local report. Network submission is manual.
(function () {
  const NS = window.__VintedRelister = window.__VintedRelister || {};
  function compactTrace(trace) {
    if (!trace || typeof trace !== 'object') return null;
    const row = value => {
      const p = value && typeof value === 'object' ? value : {};
      return [p.ref, p.id ? 'id' : 'no-id', p.width, p.height, p.orientation].filter(v => v !== undefined && v !== null).join('|').slice(0, 160);
    };
    const events = Array.isArray(trace.attempt) ? trace.attempt.slice(-24).map(event => {
      const e = event && typeof event === 'object' ? event : {};
      return [e.stage, e.at, e.index, e.count, e.photoCount, e.check, e.reason].filter(v => v !== undefined && v !== null).join('|').slice(0, 180);
    }) : [];
    const photos = trace.photos && typeof trace.photos === 'object' ? trace.photos : {};
    return {
      version: 1,
      attempt: events,
      photos: {
        backup: photos.backup && typeof photos.backup === 'object' ? { count: Number(photos.backup.count) || 0, reused: Boolean(photos.backup.reused) } : null,
        uploads: Array.isArray(photos.uploads) ? photos.uploads.slice(0, 12).map(row) : [],
        create: Array.isArray(photos.create) ? photos.create.slice(0, 12).map(row) : [],
        verify: Array.isArray(photos.verify) ? photos.verify.slice(0, 12).map(row) : [],
      }
    };
  }
  NS.reportError = function reportError(context, error, meta) {
    const timestamp = new Date().toISOString();
    try {
      const S = ReportingSanitizer;
      const { jobKey, listingTitle, diagnosticTrace, ...remoteMeta } = meta || {};
      if (diagnosticTrace) remoteMeta.diagnosticTrace = compactTrace(diagnosticTrace);
      const payload = {
        errorName: S.sanitizeText(error?.name || 'Error', 100),
        errorMessage: S.sanitizeText(error?.message || String(error || 'Unknown error'), 2000),
        stack: S.sanitizeText(error?.stack || '', 8000),
        context: S.sanitizeContext({ operation: context, code: error?.code, status: error?.status ?? null, ...remoteMeta }),
        extensionVersion: chrome.runtime.getManifest().version,
        chromeVersion: navigator.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1] || 'unknown',
        pageOrigin: S.originOnly(location.origin)
      };
      // No raw network logs, full page URL, cookies or listing contents.
      const privateContext = {
        jobKey: typeof jobKey === 'string' ? jobKey : '',
        listingTitle: typeof listingTitle === 'string' ? listingTitle : '',
      };
      void chrome.runtime.sendMessage({ type: 'vinted:storeReport', report: { payload, privateContext, timestamp } }).catch(() => {});
    } catch (_) { /* Reporting must never break republication. */ }
    return timestamp;
  };
})();
