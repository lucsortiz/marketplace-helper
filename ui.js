(async function () {
  'use strict';
  const NS = window.__VintedRelister;
  const $ = selector => document.querySelector(selector);
  const t = (key, vars) => NS.t(`ui${key}`, vars);
  const page = document.body.dataset.page;
  const urls = new Set();
  const modalUrls = new Set();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let state;
  let refreshing = false;
  let detailKey;
  let detailUpdatedAt;
  let gridSignature;
  const queueUrls = new Set();
  let queueSignature;
  let issueChase = null;
  let lastReceiptPoll = 0;
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function status(key) { $('#page-status').textContent = t(key); }
  function installClickLogger() {
    document.addEventListener('click', event => {
      const target = event.target.closest('button, a.button, a[href$=".html"], a[href^="http"]');
      if (!target) return;
      let href = '';
      if (target.href) {
        try {
          const url = new URL(target.href);
          href = `${url.origin}${url.pathname}`;
        } catch (_) { href = ''; }
      }
      chrome.runtime.sendMessage({
        type: 'vinted:ui-click',
        page,
        id: target.id || '',
        text: (target.innerText || target.textContent || target.getAttribute('aria-label') || '').trim().slice(0, 160),
        classes: String(target.className || '').slice(0, 240),
        href,
      }).catch(() => {});
    }, true);
  }
  installClickLogger();
  function welcomeConfetti() {
    if (page !== 'welcome') return;
    const colors = ['#007782', '#f2a43a', '#ef6f61', '#78b6a9', '#e3c24d'];
    const origin = document.querySelector('.hero h1')?.getBoundingClientRect();
    for (let i = 0; i < 64; i++) {
      const piece = document.createElement('i'); piece.className = 'confetti-piece';
      if (origin) {
        piece.style.left = `${origin.left + Math.min(origin.width * .14, 72)}px`;
        piece.style.top = `${origin.top + origin.height / 2}px`;
      }
      const angle = Math.random() * Math.PI * 2;
      const radius = 100 + Math.random() * 240;
      piece.style.setProperty('--x', `${Math.cos(angle) * radius}px`);
      piece.style.setProperty('--y', `${Math.sin(angle) * radius}px`);
      piece.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = `${Math.random() * 520}ms`;
      document.body.append(piece); setTimeout(() => piece.remove(), 4600);
    }
  }
  function objectUrl(blob, pool = urls) { const url = URL.createObjectURL(blob); pool.add(url); return url; }
  function revoke(pool) { for (const url of pool) URL.revokeObjectURL(url); pool.clear(); }
  function money(source) {
    const amount = Number(source.price_numeric ?? source.price?.amount ?? source.price ?? 0);
    const currency = source.price_currency || source.price?.currency_code || source.currency || 'EUR';
    try { return new Intl.NumberFormat(NS.language, { style: 'currency', currency }).format(amount); } catch (_) { return String(amount); }
  }
  function title(job) { return job.source?.title || t('UnknownItem', { id: job.itemId }); }
  function label(value) { return typeof value === 'string' ? value : value?.title || ''; }
  function detailValue(value) {
    if (Array.isArray(value)) return value.map(detailValue).filter(Boolean).join(', ');
    if (typeof value === 'number') return String(value);
    return label(value);
  }
  function meta(job) { return label(job.source?.size_title || job.source?.size); }
  function reason(code) {
    const map = { 'rate-limit': 'Blocked', 'anti-bot': 'Blocked', auth: 'Account', account: 'Account', 'account-restricted': 'Restricted', 'transfer-not-enabled': 'Account', 'stale-size-id': 'Size',
      uncertain: 'Uncertain', 'delete-unconfirmed': 'Uncertain', photos: 'Photos', integrity: 'Integrity', unconfirmed: 'Integrity', 'not-active': 'Integrity',
      'original-changed': 'Changed', interrupted: 'Interrupted', cancelled: 'Interrupted', 'lease-lost': 'Interrupted',
      storage: 'Storage', 'backup-missing': 'Storage', busy: 'Busy', missing: 'Missing', ineligible: 'Ineligible',
      network: 'Network', incomplete: 'Incomplete', 'unsafe-cleanup': 'Cleanup', 'cleanup-unconfirmed': 'Cleanup', 'original-missing': 'Cleanup',
      'http-server': 'ServerDown', http: 'Rejected', 'bad-response': 'BadResponse',
      'hour-limit': 'Limit', 'day-limit': 'Limit' };
    return t(`Error${map[code] || 'Generic'}`);
  }
  function detailedReason(job) {
    const detail = job.errorDetail || {};
    if (detail.check === 'public-page-incomplete') return t('ErrorPublicPageIncomplete');
    if (detail.cleanupStatus === 'pending' || job.stage === 'rollback-requested') return t('CleanupPending');
    const counts = {
      source: detail.sourcePhotoCount ?? 0,
      backup: detail.backupPhotoCount ?? 0,
      uploaded: detail.uploadedPhotoCount ?? 0,
      created: detail.createdPhotoCount ?? 0,
    };
    const checks = {
      'local-photo-backup': 'ErrorPhotoLocalBackup',
      'uploaded-photo-count': 'ErrorPhotoUploadCount',
      'source-backup-photo-count': 'ErrorPhotoSourceBackupCount',
      'created-photo-count': 'ErrorPhotoCreatedCount',
      'created-photo-identity': 'ErrorPhotoCreatedIdentity',
      'source-photo-urls': 'ErrorPhotoSourceUrls',
      'downloaded-photo-file': 'ErrorPhotoDownload',
      'uploaded-photo-id': 'ErrorPhotoUploadResponse',
      'uploaded-photo-response': 'ErrorPhotoUploadResponse',
      'created-item-response': 'ErrorCreatedResponse',
      'new-item-id': 'ErrorCreatedIdentity',
    };
    const explanation = checks[detail.check] ? t(checks[detail.check], counts) : reason(job.error);
    return detail.cleanupStatus === 'removed' ? `${explanation} ${t('CopyRemoved')}` : explanation;
  }
  const needsCleanup = job => job.stage === 'rollback-requested' || (job.stage === 'created' && job.status === 'error');
  function badge(job) {
    if (job.status === 'error' && job.resolved) return node('span', t('RepublishResolved'), 'badge resolved');
    const key = job.status === 'running' ? 'Running' : job.status === 'incomplete' ? 'Incomplete' : job.status === 'error' ? 'RepublishError' : 'Waiting';
    return node('span', t(key), `badge ${job.status}`);
  }
  function button(text, handler, className = '') {
    const el = node('button', text, className); el.type = 'button'; el.addEventListener('click', () => Promise.resolve(handler(el)).catch(() => status('LoadFailed'))); return el;
  }
  function paintPause() {
    const box = $('#pause-notice');
    const latest = Object.values(state.gates).filter(g => g.blockedUntil > Date.now()).sort((a, b) => b.blockedUntil - a.blockedUntil)[0];
    if (box) {
      box.hidden = !latest;
      if (latest) box.textContent = `${t('PauseTitle')} · ${t('PauseUntil', { date: new Date(latest.blockedUntil).toLocaleString(NS.language) })}`;
    }
    const reset = $('#reset-cooldown');
    if (reset) {
      const active = Object.values(state.gates).some(g => Math.max(g.blockedUntil || 0, g.nextItem || 0) > Date.now());
      reset.hidden = page !== 'options' && !active;
      reset.disabled = !active;
    }
  }
  function installCooldownReset() {
    if (!['options', 'popup'].includes(page) || $('#reset-cooldown')) return;
    const reset = button(t('ResetCooldown'), async control => {
      control.disabled = true;
      try {
        await NS.control('reset-cooldown');
        state = await NS.control('state');
        paintPause();
        status('CooldownReset');
      } catch (_) { status('LoadFailed'); }
      finally { paintPause(); }
    }, 'danger cooldown-reset');
    reset.id = 'reset-cooldown';
    reset.hidden = true;
    $('#cooldown-slot').append(reset);
  }
  function installQueueCancelAll() {
    const btn = $('#queue-cancel-all');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      const items = state.jobs.filter(job => job.status !== 'error' && !job.done && job.stage !== 'deleted');
      Promise.all(items.map(job => NS.control('forget', { key: job.key, onlyIfQueued: true }).catch(() => {})))
        .then(() => { queueSignature = null; return refresh(); })
        .catch(() => status('LoadFailed'))
        .finally(() => { btn.disabled = false; });
    });
  }
  function installNavLabels() {
    document.querySelectorAll('a[href="transfert.html"]').forEach(link => { if (page !== 'transfert') link.remove(); });
    if (!['pending', 'options', 'popup'].includes(page)) {
      document.querySelectorAll('a[href="pending.html"]').forEach(link => link.remove());
    }
    const names = { 'options.html': t('NavSettings'), 'pending.html': t('NavErrors'), 'transfert.html': t('NavTransfer') };
    document.querySelectorAll('.nav a').forEach(link => {
      const href = link.getAttribute('href'); if (names[href] && !link.dataset.i18n) link.textContent = names[href];
    });
  }
  // The errors tab is only exposed from Settings and the popup, and only when
  // at least one listing is currently in the error state.
  async function syncOptionalTabs() {
    if (!['options', 'popup'].includes(page)) return;
    const link = document.querySelector('a[href="pending.html"]');
    if (!link) return;
    link.hidden = !(state?.jobs || []).some(job => job.status === 'error');
  }
  // One storage read maps every sent report to its listing job key, so the
  // errors page can reconcile "issue resolved" → "listing resolved" in one pass.
  async function reportReceiptsByKey() {
    const stored = await chrome.storage.local.get(['vinted_local_reports_v1', 'vinted_last_report', 'reporting_private_v1']);
    const reports = Array.isArray(stored.vinted_local_reports_v1) ? [...stored.vinted_local_reports_v1] : [];
    if (stored.vinted_last_report) reports.push(stored.vinted_last_report);
    const receipts = stored.reporting_private_v1?.receipts || [];
    const byKey = new Map();
    for (const report of reports) {
      if (!report?.jobKey || byKey.has(report.jobKey)) continue;
      const receipt = receipts.find(value => value?.localTimestamp === report.timestamp);
      if (receipt) byKey.set(report.jobKey, receipt);
    }
    return byKey;
  }
  async function renderWardrobe() {
    const grid = $('#wardrobe');
    const errored = state.jobs.filter(job => job.status === 'error');
    const signature = JSON.stringify([NS.language, errored.map(j => [j.key, j.updatedAt, !!j.resolved])]);
    if (signature === gridSignature) return;
    gridSignature = signature;
    revoke(urls); grid.replaceChildren();
    $('#empty').hidden = !!errored.length;
    for (const job of errored.sort((a, b) => b.createdAt - a.createdAt)) {
      const card = node('article', null, 'listing');
      const cover = button('', () => openDetail(job.key), 'cover-button');
      cover.setAttribute('aria-label', title(job));
      const statusBadge = badge(job); statusBadge.classList.add('cover-status');
      cover.append(statusBadge);
      const blob = await NS.control('cover', { key: job.key });
      if (blob) { const img = node('img'); img.src = objectUrl(blob); img.alt = title(job); cover.append(img); }
      else if (/^https:\/\//.test(job.source?.preview_url || '')) { const img = node('img'); img.src = job.source.preview_url; img.alt = title(job); cover.append(img); }
      else { const empty = node('span', '◇', 'placeholder'); empty.setAttribute('aria-label', t('NoPhoto')); cover.append(empty); }
      const heading = node('div', null, 'listing-heading');
      heading.append(node('span', title(job), 'title'), node('span', money(job.source || {}), 'price'));
      card.append(cover, heading, node('p', meta(job), 'meta'));
      grid.append(card);
    }
  }
  // Popup-only, compact list of everything still queued (manual clicks and
  // "Tout republier" batches share the same underlying jobs) — reuses the
  // same badge()/title()/money() helpers as the errors page for consistency.
  // "14h35" — same clock format and cumulative-schedule formula content.js
  // uses for its own buttons, so the two never show different numbers.
  function formatClock(timestamp) {
    const date = new Date(timestamp);
    return `${date.getHours()}h${String(date.getMinutes()).padStart(2, '0')}`;
  }
  function dueTimesFor(items) {
    const now = Date.now();
    const itemDelay = Number(state.settings?.itemDelay || 5);
    const dueByOrigin = new Map();
    return items.map(job => {
      const gate = state.gates?.[job.origin] || {};
      const previous = dueByOrigin.get(job.origin);
      const due = previous == null ? Math.max(now, gate.nextItem || 0, gate.blockedUntil || 0) : previous + itemDelay * 60000;
      dueByOrigin.set(job.origin, due);
      return due;
    });
  }
  async function renderQueue() {
    const card = $('#queue-card');
    if (!card) return;
    const items = state.jobs.filter(job => job.status !== 'error' && !job.done && job.stage !== 'deleted')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    card.hidden = !items.length;
    if ($('#queue-cancel-all')) $('#queue-cancel-all').hidden = !items.length;
    if (!items.length) return;
    const signature = JSON.stringify([NS.language, items.map(j => [j.key, j.updatedAt, j.status])]);
    if (signature === queueSignature) return;
    queueSignature = signature;
    revoke(queueUrls);
    const list = $('#queue-list');
    list.replaceChildren();
    const dueTimes = dueTimesFor(items);
    for (const [index, job] of items.entries()) {
      const row = node('div', null, 'queue-row');
      const cover = node('span', null, 'queue-cover');
      const blob = await NS.control('cover', { key: job.key });
      if (blob) { const img = node('img'); img.src = objectUrl(blob, queueUrls); img.alt = title(job); cover.append(img); }
      else if (/^https:\/\//.test(job.source?.preview_url || '')) { const img = node('img'); img.src = job.source.preview_url; img.alt = title(job); cover.append(img); }
      else cover.append(node('span', '◇', 'placeholder'));
      const info = node('div', null, 'queue-info');
      info.append(node('span', title(job), 'title'), badge(job));
      if (job.status !== 'running') info.append(node('span', t('QueueEta', { time: formatClock(dueTimes[index]) }), 'eta'));
      const cancel = button('❌', async () => {
        await NS.control('forget', { key: job.key, onlyIfQueued: true });
        queueSignature = null;
        await refresh();
      }, 'queue-cancel');
      cancel.setAttribute('aria-label', t('QueueCancel'));
      row.append(cover, info, cancel);
      list.append(row);
    }
  }
  // When a report's GitHub issue is resolved, the failed listing follows.
  async function reconcileResolvedFromIssues() {
    const receipts = await reportReceiptsByKey();
    const pending = state.jobs.filter(j => j.status === 'error' && !j.resolved && receipts.get(j.key)?.status === 'resolved');
    if (!pending.length) return false;
    await Promise.all(pending.map(j => NS.control('resolve-error', { key: j.key, by: 'issue' }).catch(() => {})));
    return true;
  }
  async function exportJob(job) {
    const output = await BackupArchive.encode(job);
    const link = node('a'); const url = URL.createObjectURL(output); link.href = url; link.download = `vinted-backup-${job.itemId}.json`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function reportState(job) {
    const stored = await chrome.storage.local.get(['vinted_local_reports_v1', 'vinted_last_report', 'reporting_private_v1']);
    const reports = Array.isArray(stored.vinted_local_reports_v1) ? stored.vinted_local_reports_v1 : [];
    const report = reports.find(value => value?.timestamp === job.reportTimestamp) ||
      reports.find(value => value?.jobKey === job.key) ||
      (stored.vinted_last_report?.timestamp === job.reportTimestamp ? stored.vinted_last_report : null);
    const receipts = stored.reporting_private_v1?.receipts || [];
    const receipt = report && receipts.find(value => value?.localTimestamp === report.timestamp);
    return { report, receipt };
  }
  async function sendJobReport(job, report, control, message) {
    const sending = NS.reporting.sendFromGesture(report.timestamp);
    control.disabled = true; message.hidden = true;
    try {
      await sending;
      await refreshReportAction(job);
      void syncDetailReceipt(job, true);
    } catch (error) {
      const names = { permission: 'ReportDenied', limited: 'ReportLimited', capacity: 'ReportCapacity' };
      message.hidden = false; message.textContent = t(names[error.code] || 'ReportFailure'); control.disabled = false;
    }
  }
  async function appendReportAction(job, info) {
    if (job.status !== 'error') return;
    const { report, receipt } = await reportState(job);
    if (!report) return;
    const box = node('section', null, 'report-action');
    const message = node('p', '', 'hint');
    message.hidden = true;
    const actions = node('div', null, 'actions');
    if (receipt?.issueUrl) {
      const link = node('a', t('ViewReport'), 'button primary');
      link.href = receipt.issueUrl; link.target = '_blank'; link.rel = 'noopener'; actions.append(link);
      box.append(actions);
      if (receipt.resolutionMessage) {
        const response = node('div', null, 'report-response');
        response.append(node('strong', t('ReportsResponse')), node('p', receipt.resolutionMessage));
        box.append(response);
      }
    } else if (receipt) {
      const waiting = button(t('ReportIssuePending'), () => {}, 'primary'); waiting.disabled = true;
      actions.append(waiting); box.append(actions);
    } else {
      const send = button(t('SendReport'), () => sendJobReport(job, report, send, message), 'primary');
      actions.append(send); box.append(actions);
    }
    box.append(message); info.append(box);
  }
  async function refreshReportAction(job) {
    if (job.key !== detailKey) return;
    const current = $('#detail-body .report-action');
    if (!current) return;
    // Build off-screen, then replace only the report controls. Keep the gallery,
    // photo URLs, dialog dimensions and scroll position intact.
    const staging = node('div');
    await appendReportAction(job, staging);
    if (job.key !== detailKey || $('#detail-body .report-action') !== current) return;
    if (staging.firstElementChild) current.replaceWith(staging.firstElementChild);
  }
  function stopIssueChase() { if (issueChase) { clearTimeout(issueChase.timer); issueChase = null; } }
  // The GitHub issue is created a few seconds after the report POST (worker
  // waitUntil), so a single check on open can still miss it. While the receipt
  // has no issue URL, keep forcing a status check on a short cadence — bounded,
  // well under the worker's per-report read limit — until the link lands.
  function scheduleIssueChase(key) {
    if (issueChase?.key === key) return;
    stopIssueChase();
    issueChase = { key, attempts: 0, timer: null };
    const tick = async () => {
      if (!issueChase || issueChase.key !== key || key !== detailKey) return stopIssueChase();
      issueChase.attempts++;
      const job = await NS.control('get', { key }).catch(() => null);
      if (job) await forceReceiptCheck(job);
      const { receipt } = await reportState({ key });
      if (!issueChase || key !== detailKey || !receipt || receipt.issueUrl || issueChase.attempts >= 6) return stopIssueChase();
      issueChase.timer = setTimeout(tick, 6000);
    };
    issueChase.timer = setTimeout(tick, 3000);
  }
  const receiptSnapshot = r => JSON.stringify([r?.issueUrl || null, r?.status || null, r?.resolutionMessage || null]);
  // One forced worker check for the open listing's GitHub issue; repaints the
  // detail if anything moved (issue link appeared, status changed, resolution
  // message posted). Returns the receipt as it stands after the check.
  async function forceReceiptCheck(job) {
    if (!job || job.key !== detailKey || job.status !== 'error') return null;
    const { receipt } = await reportState(job);
    if (!receipt) return null;
    lastReceiptPoll = Date.now();
    const before = receiptSnapshot(receipt);
    try { await NS.reporting.getStatuses(true); }
    catch (_) { return receipt; }
    if (job.key !== detailKey) return null;
    const after = (await reportState(job)).receipt;
    if (after?.status === 'resolved' && !job.resolved) {
      await NS.control('resolve-error', { key: job.key, by: 'issue' }).catch(() => {});
      await refresh();
    }
    if (after && receiptSnapshot(after) !== before) await refreshReportAction(job);
    return (await reportState(job)).receipt;
  }
  // Opening a failed listing always re-checks its GitHub issue with the worker
  // (fresh resolution state); background 5s refreshes stay throttled. If the
  // issue link is not in yet, hand off to the bounded chase.
  async function syncDetailReceipt(job, force) {
    if (!job || job.key !== detailKey || job.status !== 'error') return;
    const { receipt } = await reportState(job);
    if (!receipt) return;
    if (!force) {
      if (receipt.issueUrl && receipt.status === 'resolved') return;
      // Fast only while chasing the missing issue link; slow once it is in so a
      // long-open dialog never hammers the worker's per-report read limit.
      if (Date.now() - lastReceiptPoll < (receipt.issueUrl ? 120000 : 4000)) return;
    }
    const after = await forceReceiptCheck(job);
    if (after && !after.issueUrl) scheduleIssueChase(job.key);
  }
  function installBulkDelete() {
    const dialog = $('#bulk-delete-dialog');
    const cancel = $('#bulk-delete-cancel');
    const scopes = ['all', 'resolved', 'error'];
    const controls = scopes.map(scope => $('#bulk-delete-' + scope));
    let candidates = [];
    let deleting = false;
    const selected = scope => candidates.filter(job => scope === 'all' ||
      (job.status === 'error' && (scope === 'resolved' ? Boolean(job.resolved) : !job.resolved)));
    const paint = () => controls.forEach((control, index) => { control.disabled = deleting || selected(scopes[index]).length === 0; });
    $('#delete-backups').onclick = async () => {
      try {
        const current = await NS.control('state');
        candidates = current.jobs;
        paint(); dialog.showModal(); cancel.focus();
      } catch (_) { status('LoadFailed'); }
    };
    cancel.onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
    controls.forEach((control, index) => { control.onclick = async () => {
      if (deleting) return;
      const jobs = selected(scopes[index]);
      if (!jobs.length) return;
      deleting = true; cancel.disabled = true; paint();
      let deleted = 0;
      try {
        for (const job of jobs) {
          try { await NS.control('forget', { key: job.key }); deleted++; }
          catch (_) { /* Busy or unavailable backups remain saved. */ }
        }
        dialog.close();
        await refresh();
        $('#page-status').textContent = t('BulkDeleteResult', { count: deleted, retained: jobs.length - deleted });
      } finally {
        deleting = false; cancel.disabled = false; paint();
      }
    }; });
  }
  function confirmDelete() {
    return new Promise(resolve => {
      const dialog = $('#confirm-dialog');
      const finish = value => { dialog.close(); resolve(value); };
      $('#confirm-cancel').onclick = () => finish(false);
      $('#confirm-delete').onclick = () => finish(true);
      dialog.oncancel = () => resolve(false);
      dialog.showModal(); $('#confirm-cancel').focus();
    });
  }
  async function openDetail(key, repaint = false) {
    const job = await NS.control('get', { key });
    if (!job) return;
    if (key !== detailKey) stopIssueChase();
    detailKey = key; detailUpdatedAt = job.updatedAt; revoke(modalUrls);
    const body = $('#detail-body'); body.replaceChildren();
    const heading = $('#detail-title'); heading.replaceChildren();
    const headingBadge = badge(job); headingBadge.classList.add('detail-heading-status');
    heading.append(node('span', t('SavedLocally'), 'detail-heading-saved'), headingBadge);
    const gallery = node('div', null, 'gallery');
    for (const blob of job.blobs || []) { const img = node('img'); img.src = objectUrl(blob, modalUrls); img.alt = title(job); gallery.append(img); }
    if (!job.blobs?.length) gallery.append(node('div', t('NoPhoto'), 'empty-state'));
    const info = node('section', null, 'detail-info');
    const summary = node('div', null, 'detail-summary');
    summary.append(node('h2', title(job), 'detail-summary-title'), node('span', money(job.source || {}), 'detail-summary-price'));
    info.append(summary);
    const attrs = node('dl', null, 'detail-attrs');
    const source = job.source || {};
    const details = [
      ['Brand', source.brand_title || source.brand],
      ['Condition', source.status_title || source.status],
      ['Colour', source.color_title || source.color],
      ['Size', source.size_title || source.size],
      ['Category', source.category_title || source.category || source.catalog?.title],
      ['Material', source.material_title || source.material],
      ['Manufacturer', source.manufacturer],
      ['Model', source.model],
      ['Author', source.author],
      ['BookTitle', source.book_title],
      ['Isbn', source.isbn],
      ['Description', source.description],
    ];
    for (const [name, value] of details) {
      const text = detailValue(value);
      if (!text) continue;
      const row = node('div', null, name === 'Description' ? 'detail-attr-wide' : '');
      row.append(node('dt', t(name)), node('dd', text, name === 'Description' ? 'description' : '')); attrs.append(row);
    }
    info.append(attrs);
    if (job.error) info.append(node('p', detailedReason(job), job.status === 'error' ? 'notice error-detail' : 'notice warning'));
    await appendReportAction(job, info);
    const oldListing = node('div', null, 'actions');
    const viewOrigin = job.sourceOrigin || job.origin;
    if (job.status === 'error' && !job.resolved) {
      oldListing.append(button(t('ResolveError'), async btn => {
        btn.disabled = true;
        try { await NS.control('resolve-error', { key }); await openDetail(key, true); await refresh(); }
        catch (_) { btn.disabled = false; status('LoadFailed'); }
      }, 'primary'));
    }
    if (needsCleanup(job) && /^\d+$/.test(String(job.newItemId || '')) && String(job.newItemId) !== String(job.itemId)) {
      const copy = node('a', t('ViewNewCopy'), 'button'); copy.href = `${viewOrigin}/items/${job.newItemId}`;
      copy.target = '_blank'; copy.rel = 'noopener'; oldListing.append(copy);
    }
    if (oldListing.childElementCount) info.append(oldListing);
    const tools = node('div', null, 'actions tools');
    const exportButton = button(t('Export'), () => exportJob(job));
    exportButton.disabled = !job.complete;
    tools.append(exportButton, button(t('Forget'), async () => {
      if (!(await confirmDelete())) return;
      await NS.control('forget', { key }); $('#detail-dialog').close(); detailKey = null; revoke(modalUrls); await refresh();
    }, 'danger'));
    info.append(tools); body.append(gallery, info);
    if (!repaint && !$('#detail-dialog').open) $('#detail-dialog').showModal();
    void syncDetailReceipt(job, true);
  }
  function fillSettings(cfg) {
    $('[name=showTransferButton]').checked = cfg.showTransferButton === true;
    $('[name=itemDelay]').value = String(Math.round(Number(cfg.itemDelay ?? 5)));
    $('[name=hourlyLimit]').value = String(Number(cfg.hourlyLimit ?? 12));
    $('[name=dailyLimit]').value = String(Number(cfg.dailyLimit ?? 100));
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      state = await NS.control('state'); paintPause();
      await syncOptionalTabs();
      if (page === 'popup') {
        $('#count-hour').textContent = state.history.filter(h => h.at > Date.now() - 3600000).length;
        $('#count-day').textContent = state.history.filter(h => h.at > Date.now() - 86400000).length;
        if ($('#pending-count')) $('#pending-count').textContent = state.jobs.length;
        const running = Object.values(state.gates).some(g => g.lease?.until > Date.now());
        $('#popup-running').hidden = !running; $('#popup-running').textContent = t('Running');
        await renderQueue();
      }
      if (page === 'pending') {
        if (await reconcileResolvedFromIssues()) state = await NS.control('state');
        await renderWardrobe();
        if (detailKey) {
          const current = state.jobs.find(job => job.key === detailKey);
          if (!current) $('#detail-dialog').close();
          else if (current.updatedAt !== detailUpdatedAt) await openDetail(detailKey, true);
          else await syncDetailReceipt(current, false);
        }
      }
    } catch (_) { status('LoadFailed'); }
    finally { refreshing = false; }
  }
  try {
    await NS.localeReady;
    const requestedDetail = page === 'pending' ? new URLSearchParams(location.search).get('detail') : '';
    installNavLabels();
    document.title = `${t(page === 'welcome' ? 'NavHome' : page === 'options' ? 'NavSettings' : page === 'pending' ? 'NavErrors' : 'Volume')} · Vinted Republish FREE`;
    document.querySelectorAll('[data-language]').forEach(el => el.addEventListener('change', () => NS.setLocale(el.value).catch(() => status('SaveFailed'))));
    document.querySelectorAll('.nav a').forEach(a => { if (a.getAttribute('href') === `${page === 'options' ? 'options' : page}.html`) a.setAttribute('aria-current', 'page'); });
    if (page === 'popup') document.querySelectorAll('a[href$=".html"]').forEach(link => link.addEventListener('click', e => { e.preventDefault(); void chrome.tabs.create({ url: chrome.runtime.getURL(link.getAttribute('href')) }); }));
    installCooldownReset();
    installQueueCancelAll();
    await refresh();
    welcomeConfetti();
    if (page === 'options') {
      fillSettings(state.settings);
      const itemDelay = $('[name=itemDelay]');
      const hourlyLimit = $('[name=hourlyLimit]');
      const dailyLimit = $('[name=dailyLimit]');
      const settingInputs = [itemDelay, hourlyLimit, dailyLimit];
      const showTransferButton = $('[name=showTransferButton]');
      let saveTimer;
      const saveSettings = async () => {
        clearTimeout(saveTimer);
        if (settingInputs.some(input => !input.reportValidity())) return;
        try {
          await NS.control('settings', { settings: {
            showTransferButton: showTransferButton.checked, itemDelay: Number(itemDelay.value), hourlyLimit: Number(hourlyLimit.value), dailyLimit: Number(dailyLimit.value)
          } });
          $('#page-status').textContent = '';
        }
        catch (_) { status('SaveFailed'); }
      };
      showTransferButton.addEventListener('change', () => { void saveSettings(); });
      const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void saveSettings(); }, 500); };
      $('#settings-form').addEventListener('submit', event => { event.preventDefault(); void saveSettings(); });
      settingInputs.forEach(input => {
        input.addEventListener('input', scheduleSave);
        input.addEventListener('change', () => { void saveSettings(); });
      });
      const defaults = { itemDelay: 5, hourlyLimit: 12, dailyLimit: 100 };
      settingInputs.forEach(input => {
        const wrapper = node('span', null, 'setting-input');
        input.before(wrapper); wrapper.append(input);
        const reset = button('×', () => {
          input.value = defaults[input.name];
          updateReset(); input.focus();
          return saveSettings();
        }, 'input-reset');
        reset.dataset.i18nLabel = 'uiResetField';
        reset.setAttribute('aria-label', t('ResetField'));
        const updateReset = () => { reset.hidden = input.value === String(defaults[input.name]); };
        input.addEventListener('input', updateReset);
        wrapper.append(reset); updateReset();
      });
    }
    if (page === 'pending') {
      $('#close-detail').onclick = () => $('#detail-dialog').close();
      $('#detail-dialog').addEventListener('click', event => { if (event.target === $('#detail-dialog')) $('#detail-dialog').close(); });
      $('#detail-dialog').addEventListener('close', () => { detailKey = null; stopIssueChase(); revoke(modalUrls); });
      // One throttled sweep on load so every card's GitHub issue badge reflects
      // the latest state the worker knows; per-receipt cadence is respected.
      NS.reporting.getStatuses(false).then(() => { gridSignature = null; return refresh(); }).catch(() => {});
      if (requestedDetail) await openDetail(requestedDetail);
      installBulkDelete();
      $('#import-backup').onclick = () => $('#import-file').click();
      $('#import-file').onchange = async event => {
        try {
          const file = event.target.files[0]; if (!file) return;
          await NS.control('import', { job: await BackupArchive.decode(file) });
          await refresh(); status('Imported');
        } catch (_) { status('ImportFailed'); }
        event.target.value = '';
      };
    }
    document.addEventListener('republish:language', async () => {
      installNavLabels();
      document.title = `${t(page === 'welcome' ? 'NavHome' : page === 'options' ? 'NavSettings' : page === 'pending' ? 'NavErrors' : 'Volume')} · Vinted Republish FREE`;
        if ($('#reset-cooldown')) $('#reset-cooldown').textContent = t('ResetCooldown');
        await refresh(); if (detailKey) await openDetail(detailKey, true);
    });
    if (['popup', 'pending', 'options'].includes(page)) setInterval(() => { if (!document.hidden && !$('#confirm-dialog')?.open) void refresh(); }, 5000);
    window.addEventListener('pagehide', () => { revoke(urls); revoke(modalUrls); });
  } catch (_) { status('LoadFailed'); }
})();
