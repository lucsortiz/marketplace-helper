// All coordination mutations run through one serial queue in the service worker.
(function (root) {
  'use strict';
  // Conservative defaults. Vinted's terms forbid deleting and re-listing the
  // same item repeatedly or in bulk, so these settings only reduce risk; they
  // never make relisting "safe". See docs/ANTI_BAN.md before changing them.
  const DEFAULTS = { showTransferButton: false, language: 'auto', itemDelay: 6, requestDelay: 1.5, hourlyLimit: 8, dailyLimit: 40,
    itemMin: 180, itemMax: 540, requestMin: 1, requestMax: 2.5,
    itemCooldownHours: 72, quietHours: true, quietStart: 1, quietEnd: 8, breakEvery: 5, breakMinutes: 20 };
  // Hard ceilings the options page cannot exceed (stored values above them
  // are clamped instead of rejected so older settings keep loading).
  const CAPS = { hourlyLimit: 20, dailyLimit: 150 };
  const MIN_ITEM_COOLDOWN_HOURS = 24;
  // Minimum pauses after Vinted signals a problem, before exponential growth.
  const RESTRICTED_PAUSE_MS = 48 * 60 * 60 * 1000;
  const ANTI_BOT_PAUSE_MS = 6 * 60 * 60 * 1000;
  const MAX_PAUSE_MS = 72 * 60 * 60 * 1000;
  const KEY = 'republish_control_v1';
  const LEASE_MS = 90000;
  const SCAN_CACHE_MS = 5 * 60 * 1000;
  const SCAN_RESUME_MS = 60 * 60 * 1000;
  const SCAN_LEASE_MS = 5 * 60 * 1000;
  const HISTORY_RETENTION_MS = 42 * 24 * 60 * 60 * 1000;
  let queue = Promise.resolve();
  const serial = work => { const next = queue.then(work); queue = next.catch(() => {}); return next; };
  const randomAround = (centre, spread) => Math.max(0.1, Math.round((centre + (Math.random() * 2 - 1) * spread) * 10) / 10);
  // Item delays vary by ±50 % (at least ±0.9 min) so batches never run on a
  // fixed, machine-like rhythm: the default 6 min gives 3–9 min.
  const itemSpread = minutes => Math.max(0.9, minutes * 0.5);
  const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  // Milliseconds until the quiet window ends, or 0 outside it. Uses the
  // browser's local time; the window may wrap midnight (e.g. 23 → 7).
  function quietWaitMs(cfg, now = new Date()) {
    if (!cfg.quietHours || cfg.quietStart === cfg.quietEnd) return 0;
    const hour = now.getHours();
    const inside = cfg.quietStart < cfg.quietEnd
      ? hour >= cfg.quietStart && hour < cfg.quietEnd
      : hour >= cfg.quietStart || hour < cfg.quietEnd;
    if (!inside) return 0;
    const end = new Date(now);
    end.setHours(cfg.quietEnd, 0, 0, 0);
    if (end <= now) end.setDate(end.getDate() + 1);
    // A few random minutes so the first run of the day is not on the hour.
    return end - now + randomInt(1, 25) * 60 * 1000;
  }
  const error = (code, detail = {}) => Object.assign(new Error(code), { code, ...detail });
  async function state() {
    const data = await chrome.storage.local.get(KEY);
    const current = Object.assign({ settings: DEFAULTS, gates: {}, history: [], scans: {} }, data[KEY] || {});
    current.settings = settings(current.settings);
    current.scans ||= {};
    return current;
  }
  const save = value => chrome.storage.local.set({ [KEY]: value });
  function settings(value) {
    const raw = value || {};
    const oldItem = ['itemMin', 'itemMax'].some(field => Object.prototype.hasOwnProperty.call(raw, field));
    const oldRequest = ['requestMin', 'requestMax'].some(field => Object.prototype.hasOwnProperty.call(raw, field));
    const itemMin = Number(raw.itemMin ?? DEFAULTS.itemMin); const itemMax = Number(raw.itemMax ?? DEFAULTS.itemMax);
    const requestMin = Number(raw.requestMin ?? DEFAULTS.requestMin); const requestMax = Number(raw.requestMax ?? DEFAULTS.requestMax);
    if (oldItem && (!Number.isFinite(itemMin) || !Number.isFinite(itemMax) || itemMin < 1 || itemMax < 1 || itemMin > itemMax)) throw error('settings');
    if (oldRequest && (!Number.isFinite(requestMin) || !Number.isFinite(requestMax) || requestMin < 0.1 || requestMax < 0.1 || requestMin > requestMax)) throw error('settings');
    const migratedItemDelay = Number.isFinite(Number(raw.itemDelay)) ? Number(raw.itemDelay) : (itemMin + itemMax) / 120;
    const result = { ...DEFAULTS, ...raw,
      itemDelay: Math.round(migratedItemDelay),
      requestDelay: Number.isFinite(Number(raw.requestDelay)) ? Number(raw.requestDelay) : (requestMin + requestMax) / 2 };
    if (!['auto', 'fr', 'en', 'it', 'es'].includes(result.language)) throw error('settings');
    if (!Number.isInteger(result.itemDelay) || result.itemDelay < 1 || result.itemDelay > 60) throw error('settings');
    delete result.transferDeleteDelay;
    if (!Number.isFinite(result.requestDelay) || result.requestDelay < 1.1 || result.requestDelay > 30) throw error('settings');
    result.hourlyLimit = Number(result.hourlyLimit);
    result.dailyLimit = Number(result.dailyLimit);
    if (!Number.isInteger(result.hourlyLimit) || result.hourlyLimit < 1 || result.hourlyLimit > 100) throw error('settings');
    if (!Number.isInteger(result.dailyLimit) || result.dailyLimit < 1 || result.dailyLimit > 1000) throw error('settings');
    result.hourlyLimit = Math.min(result.hourlyLimit, CAPS.hourlyLimit);
    result.dailyLimit = Math.min(result.dailyLimit, CAPS.dailyLimit, result.hourlyLimit * 24);
    result.itemCooldownHours = Number(result.itemCooldownHours);
    if (!Number.isInteger(result.itemCooldownHours) || result.itemCooldownHours > 720) throw error('settings');
    result.itemCooldownHours = Math.max(MIN_ITEM_COOLDOWN_HOURS, result.itemCooldownHours);
    result.quietHours = result.quietHours !== false;
    for (const field of ['quietStart', 'quietEnd']) {
      result[field] = Number(result[field]);
      if (!Number.isInteger(result[field]) || result[field] < 0 || result[field] > 23) throw error('settings');
    }
    result.breakEvery = Number(result.breakEvery);
    result.breakMinutes = Number(result.breakMinutes);
    if (!Number.isInteger(result.breakEvery) || result.breakEvery < 2 || result.breakEvery > 20) throw error('settings');
    if (!Number.isInteger(result.breakMinutes) || result.breakMinutes < 5 || result.breakMinutes > 120) throw error('settings');
    result.requestDelay = Math.round(result.requestDelay * 10) / 10;
    result.itemMin = Math.round((result.itemDelay - itemSpread(result.itemDelay)) * 60 * 10) / 10;
    result.itemMax = Math.round((result.itemDelay + itemSpread(result.itemDelay)) * 60 * 10) / 10;
    result.requestMin = Math.max(0.1, Math.round((result.requestDelay - 1) * 10) / 10);
    result.requestMax = Math.round((result.requestDelay + 1) * 10) / 10;
    return result;
  }
  function gate(s, origin) { return s.gates[origin] ||= { nextItem: 0, nextRequest: 0, blockedUntil: 0 }; }
  function owned(g, msg, sender) {
    if (!g.lease || g.lease.id !== msg.lease || g.lease.tabId !== sender.tab?.id ||
        g.lease.documentId !== sender.documentId || g.lease.until <= Date.now()) throw error('lease-lost');
    return g.lease;
  }
  function blocked(g, allowRestrictedRead = false) {
    if (g.blockedUntil > Date.now() && !(allowRestrictedRead && g.reason === 'account-restricted')) {
      throw error(g.reason || 'rate-limit', { until: g.blockedUntil });
    }
  }
  function limited(s, cfg) {
    const now = Date.now();
    const daily = s.history.filter(entry => entry.at > now - 86400000).sort((a, b) => a.at - b.at);
    if (daily.length >= cfg.dailyLimit) throw error('day-limit', { until: daily[daily.length - cfg.dailyLimit].at + 86400000 });
    const hourly = daily.filter(entry => entry.at > now - 3600000);
    if (hourly.length >= cfg.hourlyLimit) throw error('hour-limit', { until: hourly[hourly.length - cfg.hourlyLimit].at + 3600000 });
  }
  // An item recreated recently (its id is the newItemId of a recent history
  // entry, or it is the same original id) must not be relisted again yet:
  // Vinted explicitly forbids deleting and re-listing the same item repeatedly.
  function itemCooldownUntil(s, cfg, origin, itemId) {
    const id = String(itemId || '');
    if (!id) return 0;
    const windowMs = cfg.itemCooldownHours * 3600000;
    let until = 0;
    for (const entry of s.history) {
      if (origin && entry.origin && entry.origin !== origin) continue;
      const recreated = entry.newItemId && String(entry.newItemId) === id;
      const original = typeof entry.key === 'string' && entry.key.endsWith(`|${id}`);
      if ((recreated || original) && entry.at + windowMs > Date.now()) until = Math.max(until, entry.at + windowMs);
    }
    return until;
  }
  function assertItemCooldown(s, cfg, origin, itemId) {
    const until = itemCooldownUntil(s, cfg, origin, itemId);
    if (until > Date.now()) throw error('item-cooldown', { until });
  }
  function memberIdFromSender(sender) {
    try { return new URL(sender.url).pathname.match(/^\/member\/(\d+)(?:[-/]|$)/)?.[1] || null; }
    catch (_) { return null; }
  }
  function assertSourceAccount(sender, accountId) {
    const id = String(accountId || '');
    if (!/^\d+$/.test(id) || memberIdFromSender(sender) !== id) throw error('account');
    return id;
  }
  function scanKey(origin, sourceAccountId, targetOrigin = origin, targetAccountId = sourceAccountId) {
    return `${origin}|${sourceAccountId}|to|${targetOrigin}|${targetAccountId}`;
  }
  function ownScan(scan, msg, sender) {
    if (!scan || scan.scanId !== msg.scanId || scan.tabId !== sender.tab?.id ||
        scan.documentId !== sender.documentId || scan.leaseUntil <= Date.now()) throw error('scan-lost');
    return scan;
  }
  function accountFields(origin, sourceAccountId, targetOrigin = origin, targetAccountId = sourceAccountId) {
    return {
      mode: sourceAccountId === targetAccountId && origin === targetOrigin ? 'relist' : 'transfer',
      sourceOrigin: origin,
      sourceAccountId,
      targetOrigin,
      targetAccountId,
      // Compatibilité avec les sauvegardes 0.11 créées avant la séparation
      // source/cible. Le flux actuel reste strictement mono-compte.
      origin,
      accountId: sourceAccountId,
    };
  }
  function safeHttps(value, max = 2000) {
    try { const url = new URL(String(value || '')); return url.protocol === 'https:' ? url.href.slice(0, max) : ''; }
    catch (_) { return ''; }
  }
  function cleanSeedItem(item) {
    const price = item.price && typeof item.price === 'object' ? item.price : {};
    return {
      id: String(item.id), title: String(item.title || '').slice(0, 300),
      price: {
        amount: String(price.amount ?? item.price_numeric ?? item.price ?? '0').slice(0, 30),
        currency_code: String(price.currency_code || item.price_currency || item.currency || 'EUR').slice(0, 10),
      },
      brand_title: String(item.brand_title || item.brand?.title || item.brand || '').slice(0, 200),
      size_title: String(item.size_title || item.size?.title || item.size || '').slice(0, 200),
      status_title: String(item.status_title || item.status?.title || '').slice(0, 200),
      visible_summary: String(item.visible_summary || '').slice(0, 1000),
      preview_url: safeHttps(item.preview_url),
      item_url: safeHttps(item.item_url, 1000),
    };
  }
  function cleanDiagnostic(value) {
    if (!value || typeof value !== 'object') return null;
    const strings = ['phase', 'check', 'stage', 'transport', 'method', 'requestType', 'cleanupStatus', 'cleanupReason', 'cleanupCheck', 'responseType', 'nextAction'];
    const numbers = ['sourcePhotoCount', 'backupPhotoCount', 'uploadedPhotoCount', 'createdPhotoCount', 'httpStatus', 'elapsedMs', 'contextAgeMs', 'htmlLength', 'productPresent', 'titlePresent', 'descriptionPresent', 'priceValid', 'jsonLdCount', 'photoMarkerCount', 'challengeHint'];
    const result = {};
    for (const key of strings) if (typeof value[key] === 'string') result[key] = value[key].replace(/[^a-z0-9-]/gi, '').slice(0, 64);
    for (const key of numbers) if (Number.isFinite(Number(value[key]))) result[key] = Math.max(0, Math.floor(Number(value[key])));
    return Object.keys(result).length ? result : null;
  }
  function cleanTrace(value) {
    if (!value || typeof value !== 'object') return null;
    try {
      const text = JSON.stringify(value);
      if (text.length > 3800) return { truncated: true };
      return JSON.parse(text);
    } catch (_) { return null; }
  }
  function cleanRollbackCause(value) {
    if (!value || typeof value !== 'object') return null;
    return { code: String(value.code || 'unconfirmed').replace(/[^a-z0-9-]/gi, '').slice(0, 64), diagnostic: cleanDiagnostic(value.diagnostic) };
  }
  async function seedItems(origin, sourceAccountId, items, targetOrigin = origin, targetAccountId = sourceAccountId, via = 'manual', skip = () => false) {
    const fields = accountFields(origin, sourceAccountId, targetOrigin, targetAccountId);
    let added = 0;
    for (const item of items || []) {
      if (!/^\d+$/.test(String(item?.id))) continue;
      if (skip(String(item.id))) continue;
      const key = fields.mode === 'relist'
        ? `${origin}|${sourceAccountId}|${item.id}`
        : `${origin}|${sourceAccountId}|${item.id}|to|${targetOrigin}|${targetAccountId}`;
      if (!(await JobStore.get(key))) {
        // queuedVia lets a reload tell a "Tout republier" batch apart from
        // individual Republier clicks, so resuming can regroup the former
        // under the chip's progress/cancel instead of one button each.
        await JobStore.put({ schemaVersion: 2, key, ...fields, itemId: String(item.id), source: cleanSeedItem(item),
          blobs: [], complete: false, status: 'incomplete', stage: 'queued', queuedVia: via === 'bulk' ? 'bulk' : 'manual',
          updatedAt: Date.now(), createdAt: Date.now() });
        added++;
      }
    }
    return added;
  }
  async function patchJob(key, values) {
    const record = await JobStore.get(key);
    if (!record) throw error('backup-missing');
    return JobStore.put({ ...record, ...values, updatedAt: Date.now() });
  }
  async function release(s, origin, reason) {
    const g = gate(s, origin);
    if (g.lease?.key) {
      const job = await JobStore.get(g.lease.key);
      if (job && !job.done) await patchJob(job.key, {
        status: job.status === 'error' ? 'error' : job.status === 'incomplete' ? 'incomplete' : 'waiting',
        error: job.error || reason || null
      });
    }
    const cfg = settings(s.settings);
    if (g.lease?.started) {
      let pauseMs = randomAround(cfg.itemDelay, itemSpread(cfg.itemDelay)) * 60 * 1000;
      if (g.lease.completed) {
        // After a few completed relists, take a longer "human" break.
        g.streak = (g.streak || 0) + 1;
        g.streakTarget ||= randomInt(Math.max(2, cfg.breakEvery - 1), cfg.breakEvery + 2);
        if (g.streak >= g.streakTarget) {
          pauseMs += randomAround(cfg.breakMinutes, cfg.breakMinutes * 0.5) * 60 * 1000;
          g.streak = 0; g.streakTarget = 0;
        }
      }
      g.nextItem = Math.max(g.nextItem || 0, Date.now() + pauseMs);
    }
    g.lease = null;
  }
  async function prune(s) {
    for (const [origin, g] of Object.entries(s.gates)) if (g.lease && g.lease.until <= Date.now()) await release(s, origin, 'interrupted');
    s.history = s.history.filter(h => h.at > Date.now() - HISTORY_RETENTION_MS);
  }
  async function handle(msg, sender, origin, trusted) {
    return serial(async () => {
      const s = await state();
      await prune(s);
      const cfg = settings(s.settings);
      const g = origin ? gate(s, origin) : null;
      switch (msg.action) {
        case 'page-ready':
          if (g.lease?.tabId === sender.tab?.id && g.lease.documentId !== sender.documentId) await release(s, origin, 'interrupted');
          await save(s); return {};
        case 'state': {
          const records = await JobStore.all();
          for (const record of records) {
            const activelyOwned = Object.values(s.gates).some(value => value.lease?.key === record.key);
            const completedResidue = record.done || (record.stage === 'deleted' && record.complete && record.newItemId &&
              !activelyOwned && record.updatedAt < Date.now() - 30000);
            if (!completedResidue) continue;
            if (!record.done && !s.history.some(entry => entry.key === record.key)) {
              s.history.push({ key: record.key, origin: record.origin, accountId: record.accountId,
                newItemId: record.newItemId ? String(record.newItemId) : null,
                sourceAccountId: record.sourceAccountId || record.accountId,
                targetAccountId: record.targetAccountId || record.accountId, at: Date.now() });
            }
            await JobStore.remove(record.key);
          }
          await save(s);
          return { settings: cfg, gates: s.gates, history: s.history, scans: s.scans,
            jobs: records.filter(j => !j.done && j.stage !== 'deleted' && (trusted || j.origin === origin))
              .map(({ blobs, ...j }) => ({ ...j, photoCount: blobs?.length || 0 })) };
        }
        case 'settings':
          if (!trusted) throw error('forbidden');
          s.settings = settings({ ...cfg, ...msg.settings }); await save(s); return s.settings;
        case 'reset-cooldown':
          if (!trusted) throw error('forbidden');
          for (const g of Object.values(s.gates)) {
            g.nextItem = 0;
            g.nextRequest = 0;
            g.streak = 0;
            g.streakTarget = 0;
            // Pauses caused by a Vinted restriction or anti-bot challenge are
            // kept unless the caller explicitly forces them (options page).
            const strong = ['account-restricted', 'anti-bot'].includes(g.reason) && g.blockedUntil > Date.now();
            if (strong && !msg.force) continue;
            g.blockedUntil = 0;
            g.reason = null;
            g.strikes = [];
          }
          await save(s); return {};
        case 'acquire': {
          // A restricted account may still enter the local-backup phase. Any
          // account-only network request remains blocked below.
          blocked(g, true);
          limited(s, cfg);
          if (g.lease) throw error('busy');
          if (g.nextItem > Date.now()) { await save(s); return { waitMs: g.nextItem - Date.now() }; }
          const quietMs = quietWaitMs(cfg);
          if (quietMs > 0) { g.nextItem = Date.now() + quietMs; await save(s); return { waitMs: quietMs, quiet: true }; }
          g.lease = { id: crypto.randomUUID(), tabId: sender.tab.id, documentId: sender.documentId,
            until: Date.now() + LEASE_MS, started: true };
          await save(s); return { lease: g.lease.id };
        }
        case 'item-check': {
          if (!/^\d+$/.test(String(msg.itemId))) throw error('account');
          assertItemCooldown(s, cfg, origin, msg.itemId);
          return {};
        }
        case 'heartbeat': owned(g, msg, sender).until = Date.now() + LEASE_MS; await save(s); return {};
        case 'release': owned(g, msg, sender); await release(s, origin); await save(s); return {};
        case 'request': {
          blocked(g, Boolean(msg.publicRead));
          if (msg.lease) owned(g, msg, sender).until = Date.now() + LEASE_MS;
          if (g.nextRequest > Date.now()) { await save(s); return { waitMs: g.nextRequest - Date.now() }; }
          g.nextRequest = Date.now() + randomAround(cfg.requestDelay, 1) * 1000;
          await save(s); return {};
        }
        case 'refusal': {
          const status = Number(msg.status);
          if (![401, 403, 429].includes(status)) return {};
          const now = Date.now();
          const strikes = (g.strikes || []).filter(t => t > now - 86400000);
          const base = status === 429 ? 900000 : status === 401 ? 60000 : 1800000;
          const raw = String(msg.retryAfter || '');
          const retryMs = raw && Number.isFinite(Number(raw)) ? Math.max(0, Number(raw) * 1000) : Math.max(0, Date.parse(raw) - now) || 0;
          // A restriction or an anti-bot challenge is a strong signal: stop for
          // much longer than a plain rate limit (48 h / 6 h minimum).
          const floor = status === 403 && msg.restriction ? RESTRICTED_PAUSE_MS : status === 403 && msg.challenge ? ANTI_BOT_PAUSE_MS : 0;
          const backoff = Math.min(Math.max(floor, base) * 2 ** Math.min(strikes.length, 5), floor ? MAX_PAUSE_MS : 21600000);
          g.blockedUntil = Math.max(g.blockedUntil || 0, now + Math.max(retryMs, backoff));
          g.reason = status === 429 ? 'rate-limit' : msg.challenge ? 'anti-bot' : msg.restriction ? 'account-restricted' : 'auth';
          g.strikes = [...strikes, now]; await save(s); return { until: g.blockedUntil };
        }
        case 'scan-state': {
          const sourceAccountId = assertSourceAccount(sender, msg.sourceAccountId || msg.accountId);
          const key = scanKey(origin, sourceAccountId);
          const scan = s.scans[key] || null;
          if (scan && scan.completedAt && scan.completedAt + SCAN_CACHE_MS <= Date.now()) return null;
          if (scan && !scan.completedAt && scan.updatedAt + SCAN_RESUME_MS <= Date.now()) return null;
          await save(s);
          return scan;
        }
        case 'scan-start': {
          const sourceAccountId = assertSourceAccount(sender, msg.sourceAccountId || msg.accountId);
          const key = scanKey(origin, sourceAccountId);
          const previous = s.scans[key];
          if (previous?.status === 'running' && previous.leaseUntil > Date.now() &&
              previous.tabId !== sender.tab?.id) throw error('busy');
          const resumable = previous && !previous.completedAt && previous.updatedAt + SCAN_RESUME_MS > Date.now();
          const ownership = { scanId: crypto.randomUUID(), tabId: sender.tab.id, documentId: sender.documentId,
            leaseUntil: Date.now() + SCAN_LEASE_MS };
          s.scans[key] = resumable ? { ...previous, ...ownership, status: 'running', updatedAt: Date.now(), error: null } : {
            key, ...accountFields(origin, sourceAccountId), status: 'running', nextPage: 1,
            totalPages: null, totalItems: null, scanned: 0, added: 0,
            startedAt: Date.now(), updatedAt: Date.now(), completedAt: null, error: null, ...ownership,
          };
          await save(s); return s.scans[key];
        }
        case 'scan-page': {
          const sourceAccountId = assertSourceAccount(sender, msg.sourceAccountId || msg.accountId);
          const key = scanKey(origin, sourceAccountId);
          const scan = ownScan(s.scans[key], msg, sender);
          if (scan.completedAt) throw error('scan');
          const page = Number(msg.page);
          const totalPages = Number(msg.totalPages);
          const totalItems = Number(msg.totalItems);
          if (!Number.isInteger(page) || page < 1 || page > 1000 ||
              !Number.isInteger(totalPages) || totalPages < page || totalPages > 1000 || page !== scan.nextPage) throw error('scan');
          const skip = id => itemCooldownUntil(s, cfg, origin, id) > Date.now();
          const skipped = (msg.items || []).filter(item => skip(String(item?.id))).length;
          const added = await seedItems(origin, sourceAccountId, msg.items || [], undefined, undefined, 'bulk', skip);
          scan.skipped = Number(scan.skipped || 0) + skipped;
          scan.status = 'running';
          scan.nextPage = page + 1;
          scan.totalPages = totalPages;
          scan.totalItems = Number.isFinite(totalItems) && totalItems >= 0 ? Math.floor(totalItems) : null;
          scan.scanned = Number(scan.scanned || 0) + (msg.items || []).length;
          scan.added = Number(scan.added || 0) + added;
          scan.updatedAt = Date.now();
          scan.leaseUntil = Date.now() + SCAN_LEASE_MS;
          await save(s); return { added, scan };
        }
        case 'scan-complete': {
          const sourceAccountId = assertSourceAccount(sender, msg.sourceAccountId || msg.accountId);
          const key = scanKey(origin, sourceAccountId);
          const scan = ownScan(s.scans[key], msg, sender);
          scan.status = 'complete'; scan.completedAt = Date.now(); scan.updatedAt = Date.now(); scan.error = null; scan.leaseUntil = 0;
          await save(s); return scan;
        }
        case 'scan-failed': {
          const sourceAccountId = assertSourceAccount(sender, msg.sourceAccountId || msg.accountId);
          const key = scanKey(origin, sourceAccountId);
          const scan = s.scans[key];
          if (!scan) return null;
          ownScan(scan, msg, sender);
          scan.status = 'interrupted'; scan.updatedAt = Date.now(); scan.error = String(msg.error || 'network').slice(0, 100); scan.leaseUntil = 0;
          await save(s); return scan;
        }
        case 'seed': {
          const sourceAccountId = assertSourceAccount(sender, msg.sourceAccountId || msg.accountId);
          return { added: await seedItems(origin, sourceAccountId, msg.items || []) };
        }
        case 'defer': {
          const job = await JobStore.get(msg.key);
          if (!job || job.origin !== origin) throw error('forbidden');
          if (g.lease?.key !== job.key && !job.done) await patchJob(job.key, {
            status: 'error', error: String(msg.error || 'interrupted').slice(0, 500),
            errorDetail: cleanDiagnostic(msg.errorDetail), reportTimestamp: typeof msg.reportTimestamp === 'string' ? msg.reportTimestamp.slice(0, 40) : null
          });
          return {};
        }
        case 'get': {
          const job = await JobStore.get(msg.key);
          if (job && !trusted && job.origin !== origin) throw error('forbidden');
          return job || null;
        }
        case 'cover': {
          if (!trusted) throw error('forbidden');
          const job = await JobStore.get(msg.key);
          return job?.blobs?.[0] || null;
        }
        case 'import': {
          if (!trusted) throw error('forbidden');
          const j = msg.job;
          if (!j || !/^\d+$/.test(String(j.sourceAccountId || j.accountId)) || !/^\d+$/.test(String(j.targetAccountId || j.sourceAccountId || j.accountId)) || !/^\d+$/.test(String(j.itemId)) ||
              !Array.isArray(j.blobs) || !j.blobs.length || j.blobs.length > 50 || j.blobs.some(b => !(b instanceof Blob) || !b.size || b.size > 25 * 1024 * 1024 || !b.type.startsWith('image/')) ||
              !j.source || !['queued', 'backed-up', 'create-requested', 'created', 'rollback-requested', 'rolled-back', 'delete-requested', 'deleted', 'verified'].includes(j.stage)) throw error('invalid-backup');
          // Origin allowlist is supplied by the background before this action.
          const sourceOrigin = j.sourceOrigin || j.origin;
          const sourceAccountId = String(j.sourceAccountId || j.accountId);
          const targetOrigin = j.targetOrigin || sourceOrigin;
          const targetAccountId = String(j.targetAccountId || sourceAccountId);
          const fields = accountFields(sourceOrigin, sourceAccountId, targetOrigin, targetAccountId);
          const key = fields.mode === 'relist' ? `${sourceOrigin}|${sourceAccountId}|${j.itemId}`
            : `${sourceOrigin}|${sourceAccountId}|${j.itemId}|to|${targetOrigin}|${targetAccountId}`;
          if (await JobStore.get(key)) throw error('exists');
          await JobStore.put({ schemaVersion: 2, key, ...fields, itemId: String(j.itemId), source: j.source,
            blobs: j.blobs, complete: true, status: 'waiting', stage: j.stage, newItemId: j.newItemId,
            expected: j.expected, uploaded: j.uploaded, sessionId: j.sessionId, done: !!j.done, rollbackCause: cleanRollbackCause(j.rollbackCause),
            error: 'interrupted', createdAt: Date.now(), updatedAt: Date.now() });
          return {};
        }
        case 'backup': {
          const lease = owned(g, msg, sender);
          if (!/^\d+$/.test(String(msg.accountId)) || !/^\d+$/.test(String(msg.itemId))) throw error('account');
          const key = `${origin}|${msg.accountId}|${msg.itemId}`;
          const old = await JobStore.get(key);
          if (old && ['create-requested', 'created', 'rollback-requested', 'delete-requested', 'deleted'].includes(old.stage)) throw error('uncertain');
          if (!old || ['queued', 'backed-up', 'rolled-back'].includes(old.stage)) assertItemCooldown(s, cfg, origin, msg.itemId);
          if (!Array.isArray(msg.blobs) || !msg.blobs.length || msg.blobs.some(b => !(b instanceof Blob) || !b.size || !b.type.startsWith('image/'))) throw error('photos');
          const fields = accountFields(origin, String(msg.accountId));
          const record = await JobStore.put({ ...old, schemaVersion: 2, ...fields, key, itemId: String(msg.itemId), source: msg.source,
            blobs: msg.blobs, complete: true, status: 'running', stage: 'backed-up', error: null, done: false,
            createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() });
          lease.key = key; lease.started = true; lease.until = Date.now() + LEASE_MS; await save(s); return { key: record.key };
        }
        case 'patch': {
          const lease = owned(g, msg, sender);
          const job = await JobStore.get(msg.key);
          if (!job || job.origin !== origin) throw error('forbidden');
          const allowed = ['stage', 'status', 'error', 'newItemId', 'expected', 'sessionId', 'uploaded', 'errorDetail', 'reportTimestamp', 'rollbackCause', 'diagnosticTrace'];
          const patch = Object.fromEntries(Object.entries(msg.values || {}).filter(([k]) => allowed.includes(k)));
          if ('errorDetail' in patch) patch.errorDetail = cleanDiagnostic(patch.errorDetail);
          if ('rollbackCause' in patch) patch.rollbackCause = cleanRollbackCause(patch.rollbackCause);
          if ('reportTimestamp' in patch) patch.reportTimestamp = typeof patch.reportTimestamp === 'string' ? patch.reportTimestamp.slice(0, 40) : null;
          if ('diagnosticTrace' in patch) patch.diagnosticTrace = cleanTrace(patch.diagnosticTrace);
          lease.key = job.key; lease.started = true; lease.until = Date.now() + LEASE_MS;
          await patchJob(job.key, patch);
          await save(s); return {};
        }
        case 'finish': {
          const lease = owned(g, msg, sender);
          const job = await JobStore.get(msg.key);
          if (!job || job.origin !== origin || job.stage !== 'deleted' || !job.complete || !job.newItemId) throw error('integrity');
          // Marking the record complete before removing it keeps it hidden if
          // Chrome stops between the two durable writes. A later state read
          // also removes any such completed residue.
          await patchJob(job.key, { stage: 'verified', status: 'waiting', error: null, done: true });
          s.history.push({ key: job.key, origin, accountId: job.accountId, newItemId: String(job.newItemId),
            sourceAccountId: job.sourceAccountId || job.accountId, targetAccountId: job.targetAccountId || job.accountId, at: Date.now() });
          lease.key = null; lease.started = true; lease.completed = true; lease.until = Date.now() + LEASE_MS;
          await save(s);
          await JobStore.remove(job.key);
          return {};
        }
        case 'resolve-error': {
          // Marks a failed listing as resolved — manually from its detail view,
          // or automatically once its GitHub issue is resolved. The backup is
          // kept; only the user-facing state changes.
          if (!trusted) throw error('forbidden');
          const rJob = await JobStore.get(msg.key);
          if (!rJob) throw error('backup-missing');
          if (rJob.status !== 'error' || rJob.resolved) return { retained: true };
          await patchJob(rJob.key, { resolved: true, resolvedAt: Date.now(), resolvedBy: msg.by === 'issue' ? 'issue' : 'manual' });
          return {};
        }
        case 'forget': {
          if (!trusted) {
            const fJob = await JobStore.get(msg.key);
            if (!fJob || fJob.origin !== origin) throw error('forbidden');
          }
          if (Object.values(s.gates).some(x => x.lease?.key === msg.key)) throw error('busy');
          if (msg.onlyIfQueued) {
            const job = await JobStore.get(msg.key);
            if (job && (job.stage !== 'queued' || job.complete)) return { retained: true };
          }
          await JobStore.remove(msg.key); return {};
        }
        default: throw error('unknown-action');
      }
    });
  }
  root.RepublishCoordinator = { handle, DEFAULTS, CAPS, serial, quietWaitMs,
    tabClosed: tabId => serial(async () => {
      const s = await state();
      for (const [origin, g] of Object.entries(s.gates)) if (g.lease?.tabId === tabId) await release(s, origin, 'interrupted');
      for (const scan of Object.values(s.scans)) if (scan.tabId === tabId && scan.status === 'running') {
        scan.status = 'interrupted'; scan.error = 'interrupted'; scan.updatedAt = Date.now(); scan.leaseUntil = 0;
      }
      await save(s);
    }) };
})(globalThis);
