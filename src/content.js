// src/content.js — Orchestre le bouton Relist et son flux de bout en bout.
(function () {
  const NS = window.__VintedRelister;
  let savedErrorsByItem = new Map();
  let showTransferButton = false;
  let bulkRunning = false; // true only while queueAllItems is scanning/seeding, before hand-off to the queue
  let bulk = null; // active "Tout republier" batch descriptor once items are queued, or null

  function getMemberId() {
    try {
      const m = (location.pathname || '').match(/\/member\/(\d+)/);
      if (m) return m[1];
    } catch (_) {}
    const vuid = NS.getCookie('v_uid');
    return vuid && /^(\d+)$/.test(vuid) ? vuid : null;
  }

  function message(key, vars) {
    const template = NS.i18n()[key] || '';
    return template.replace(/\{(\w+)\}/g, (_, name) => (
      vars && vars[name] != null ? String(vars[name]) : ''
    ));
  }

  function installInjectedClickLogger() {
    if (window.__VintedRelisterClickLoggerInstalled) return;
    window.__VintedRelisterClickLoggerInstalled = true;
    document.addEventListener('click', event => {
      const target = event.target.closest('.vinted-republish-btn, .vinted-relist-all-btn, .vinted-transfer-account-btn, .vinted-relist-notice__btn, .vinted-relist-notice__close, .vinted-relist-modal__button');
      if (!target) return;
      const label = target.innerText || target.textContent || target.getAttribute('aria-label') || target.title || '';
      chrome.runtime.sendMessage({
        type: 'vinted:ui-click',
        id: target.id || target.dataset.republishErrorKey || '',
        text: label.trim().slice(0, 160),
        classes: String(target.className || '').slice(0, 240),
        page: 'vinted-content',
      }).catch(() => {});
    }, true);
  }

  installInjectedClickLogger();

  // Vinted a migré taille/état/matière hors des champs top-level (size_id, status_id)
  // vers un tableau dynamique `item_attributes: [{code, ids}]`. On les relit depuis
  // là en priorité, avec repli sur d'anciens champs plats si jamais ils reviennent.
  function getAttributeIds(base, code) {
    const attrs = (base && base.item_attributes) || [];
    const found = attrs.find(a => a && a.code === code);
    return (found && Array.isArray(found.ids)) ? found.ids : [];
  }

  function buildPayload(base, tempUuid, assigned) {
    const priceObj = base.price || {};
    const priceNum = base.price_numeric || parseFloat(priceObj.amount || '0') || 0;
    const currency = base.price_currency || priceObj.currency_code || base.currency || 'EUR';
    const colorIds = base.color_ids || [base.color1_id, base.color2_id].filter(Boolean);
    const brandTitleRaw = base.brand_title || base.brand || (base.brand_dto && base.brand_dto.title) || null;
    const brandTitle = (brandTitleRaw && String(brandTitleRaw).trim()) ? brandTitleRaw : null;
    const sizeIds = getAttributeIds(base, 'size');
    const conditionIds = getAttributeIds(base, 'condition');
    const resolvedSizeId = sizeIds[0] != null ? sizeIds[0] : (base.size_id || null);
    const resolvedStatusId = conditionIds[0] != null ? conditionIds[0] : (base.status_id || null);
    return {
      item: {
        id: null,
        currency,
        temp_uuid: tempUuid,
        title: base.title || '',
        description: base.description || '',
        brand_id: base.brand_id || null,
        brand: brandTitle,
        size_id: resolvedSizeId,
        catalog_id: base.catalog_id || null,
        isbn: base.isbn || null,
        author: base.author || null,
        book_title: base.book_title || null,
        model: base.model || null,
        video_game_rating_id: base.video_game_rating_id || null,
        is_unisex: Boolean(base.is_unisex),
        status_id: resolvedStatusId,
        price: priceNum,
        package_size_id: base.package_size_id || 1,
        shipment_prices: base.shipment_prices || { domestic: null, international: null },
        color_ids: colorIds || [],
        assigned_photos: assigned,
        item_attributes: base.item_attributes || [],
        manufacturer: base.manufacturer || null,
        manufacturer_labelling: base.manufacturer_labelling || null,
        measurement_length: base.measurement_length != null ? base.measurement_length : null,
        measurement_width: base.measurement_width != null ? base.measurement_width : null,
        measurement_unit: base.measurement_unit != null ? base.measurement_unit : null,
      },
      feedback_id: null,
      push_up: false,
      parcel: null,
      upload_session_id: tempUuid,
    };
  }

  NS.buildPayload = buildPayload;

  // "14h35" — used everywhere a queue ETA is shown (buttons, chip, popup)
  // so they all read the same clock instead of drifting countdowns.
  function formatClock(timestamp) {
    const date = new Date(timestamp);
    return `${date.getHours()}h${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function phaseLabel(phase, seconds) {
    const keys = {
      csrf: 'phaseCollect', details: 'phaseCollect', photos: 'phasePhotos',
      create: 'phaseCreate', verify: 'phaseVerify', delete: 'phaseDelete', cleanup: 'phaseCleanup', backup: 'phaseBackup', cooldown: 'phaseCooldown',
    };
    if (phase === 'photos' && NS.t) return NS.t('phasePhotos');
    // Long waits (pauses, quiet hours) read better in hours/minutes.
    if (phase === 'cooldown' && seconds >= 120) {
      const minutes = Math.ceil(seconds / 60);
      const time = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`;
      return message('phaseCooldownLong', { time });
    }
    return keys[phase] ? message(keys[phase], { seconds }) : '';
  }

  function setCancelVisual(btn, active) {
    const icon = btn.querySelector('.vinted-republish-app-icon');
    if (icon) icon.hidden = active;
    let cancelIcon = btn.querySelector('.vinted-republish-cancel-icon');
    if (active && !cancelIcon) {
      cancelIcon = document.createElement('span');
      cancelIcon.className = 'vinted-republish-cancel-icon';
      cancelIcon.textContent = '❌';
      cancelIcon.setAttribute('aria-hidden', 'true');
      const label = btn.querySelector('.web_ui__Button__label');
      if (label) label.after(cancelIcon);
      else btn.querySelector('.web_ui__Button__content')?.append(cancelIcon);
    }
    if (cancelIcon) cancelIcon.hidden = !active;
    btn.classList.toggle('is-cancellable', active);
  }

  function republishErrorMessage(error) {
    if (error?.diagnostic?.check === 'public-page-incomplete') return message('publicPageIncomplete');
    const keys = {
      'account-restricted': 'republishErrorRestricted', auth: 'republishErrorAuth', account: 'republishErrorAccount',
      'rate-limit': 'republishErrorRateLimit', 'anti-bot': 'republishErrorAntiBot', photos: 'republishErrorPhotos',
      storage: 'republishErrorStorage', 'backup-missing': 'republishErrorStorage', missing: 'republishErrorMissing',
      'hour-limit': 'republishErrorLimit', 'day-limit': 'republishErrorLimit', busy: 'republishErrorBusy',
      'item-cooldown': 'republishErrorItemCooldown',
    };
    return message(keys[error?.code] || 'republishErrorGeneric');
  }

  function openPendingDetail(key) {
    return chrome.runtime.sendMessage({ type: 'republish:openPending', key }).catch(() => {});
  }

  async function openTransferFromWardrobe(btn) {
    const memberId = getMemberId();
    if (!memberId) { NS.showNotice(message('missingAccountNotice'), 'error'); return; }
    btn.disabled = true;
    NS.setChipButtonText(btn, message('preparing'));
    try {
      const profile = await transferProfile();
      if (String(profile.id) !== String(memberId)) throw Object.assign(new Error('account'), { code: 'account' });
      const response = await chrome.runtime.sendMessage({
        type: 'transfer:open',
        origin: location.origin,
        accountId: memberId,
        autoCapture: true,
      });
      if (!response?.ok) throw new Error(response?.error || 'Ouverture du transfert impossible.');
    } catch (error) {
      NS.showNotice(republishErrorMessage(error), 'error');
    } finally {
      btn.disabled = false;
      NS.setChipButtonText(btn, message('transferAccountButton'));
    }
  }

  function markErrorButton(btn, key, errorText) {
    btn.disabled = false;
    btn.classList.add('is-error');
    btn.dataset.republishErrorKey = key;
    NS.setButtonText(btn, message('errorDetailsButton'));
    btn.title = errorText;
  }

  function clearErrorButton(btn) {
    btn.classList.remove('is-error');
    delete btn.dataset.republishErrorKey;
    btn.title = '';
    if (!btn.classList.contains('is-loading') && !btn.classList.contains('is-republished')) {
      NS.setButtonText(btn, NS.i18n().relistButton);
    }
  }

  function applySavedErrorButtons() {
    document.querySelectorAll('.vinted-republish-btn').forEach(btn => {
      if (btn.classList.contains('is-loading')) return;
      const itemId = NS.findClosestItemId(btn);
      const job = itemId && savedErrorsByItem.get(String(itemId));
      if (job) markErrorButton(btn, job.key, republishErrorMessage({ code: job.error }));
      else if (btn.classList.contains('is-error')) clearErrorButton(btn);
    });
  }

  async function syncSavedErrors() {
    const local = await NS.control('state');
    // A resolved failure (validated manually, or its GitHub issue closed) no
    // longer surfaces the "see details" button on the wardrobe.
    savedErrorsByItem = new Map(local.jobs.filter(job => job.status === 'error' && !job.resolved).map(job => [String(job.itemId), job]));
    applySavedErrorButtons();
  }

  function showRepublishFailure(btn, result) {
    const errorText = republishErrorMessage(result.error);
    savedErrorsByItem.set(String(result.itemId), { key: result.jobKey, error: result.error?.code });
    markErrorButton(btn, result.jobKey, errorText);
    const cleanupStatus = result.error?.diagnostic?.cleanupStatus;
    const noticeKey = cleanupStatus === 'removed' ? 'republishCopyRemovedNotice' : cleanupStatus === 'pending' ? 'republishCleanupPendingNotice'
      : result.backupComplete ? 'republishFailureNotice' : 'republishFailurePartialNotice';
    NS.showNotice(message(noticeKey, { error: errorText }), 'error', {
      action: { label: message('errorDetailsAction'), onClick: () => openPendingDetail(result.jobKey) }
    });
  }

  // Single ordered queue shared by individual "Republier" clicks and by
  // "Tout republier" batches, so both interleave and survive a reload via
  // the durable JobStore state instead of dying with this tab's JS heap.
  const queue = [];
  let queueTimer = null;
  let queueState = null;
  let queueStateAt = 0;
  let queueRefreshing = false;
  function paintQueue() {
    const now = Date.now();
    const cfg = queueState?.settings || { itemDelay: 5 };
    const gate = queueState?.gates?.[location.origin] || {};
    const head = queue[0];
    // head.due is refreshed live by performItem's phase callback while the
    // lead item is actually cooling down, which is more current than
    // gate.nextItem (only updated once that item's lease is released) —
    // a refinement of this same cumulative formula, not a second one.
    let due = Math.max(now, gate.nextItem || 0, gate.blockedUntil || 0, head?.due || 0);
    queue.forEach((entry, index) => {
      if (index) due += cfg.itemDelay * 60000;
      entry.dueAt = due;
      if (entry.running || !entry.btn) return;
      NS.setButtonText(entry.btn, message('manualQueueWait', { position: index + 1, time: formatClock(due) }));
    });
    updateQueueSummaryButton();
    if (queue.length && !queueRefreshing && now - queueStateAt >= 5000) {
      queueRefreshing = true;
      void NS.control('state').then(value => { queueState = value; queueStateAt = Date.now(); })
        .catch(() => { queueStateAt = Date.now(); })
        .finally(() => { queueRefreshing = false; });
    }
  }
  function finishBulk(b) {
    NS.setChipButtonText(b.btn, NS.i18n().relistAllButton);
    b.btn.disabled = false;
    b.btn._cancelBulk = null;
    b.btn.title = '';
    NS.showNotice(message('bulkFinished', { count: b.completed, total: b.total }), 'success');
    void syncSavedErrors().catch(() => {});
    if (bulk === b) bulk = null;
  }
  async function driveQueue() {
    const entry = queue[0];
    if (!entry) {
      if (queueTimer) { clearInterval(queueTimer); queueTimer = null; updateQueueSummaryButton(); }
      return;
    }
    if (entry.running) return;
    if (entry.bulk?.cancelled) {
      // A cancelled (or failed) batch leaves its remaining items untouched
      // in JobStore — they simply never run, ready for an explicit retry.
      queue.shift();
      entry.bulk.pending--;
      if (entry.bulk.pending <= 0) finishBulk(entry.bulk);
      entry.resolve();
      void driveQueue();
      return;
    }
    entry.running = true;
    try { await performItem(entry); }
    finally {
      queue.shift();
      const b = entry.bulk;
      entry.resolve();
      if (b) { b.pending--; if (b.pending <= 0) finishBulk(b); }
      // The engine has just persisted its actual delay before releasing the
      // lease. Refresh it before handing off to the next queued publication.
      try { queueState = await NS.control('state'); queueStateAt = Date.now(); } catch (_) {}
      if (queue.length) { paintQueue(); void driveQueue(); }
      else { clearInterval(queueTimer); queueTimer = null; updateQueueSummaryButton(); }
    }
  }
  // Clicking Republier on a listing that still has a failed entry in the
  // errors page drops that entry first, so the copy is recreated from a
  // clean journal instead of resuming the old one.
  async function seedQueueEntry(entry) {
    const { itemId, memberId, btn } = entry;
    const staleKey = `${location.origin}|${memberId}|${itemId}`;
    const stale = await NS.control('get', { key: staleKey }).catch(() => null);
    if (stale && stale.status === 'error') {
      await NS.control('forget', { key: staleKey }).catch(() => {});
      savedErrorsByItem.delete(String(itemId));
    }
    await NS.seedJobs(memberId, [NS.snapshotItem(btn, itemId)]);
  }
  function keyFor(entry) { return `${location.origin}|${entry.memberId}|${entry.itemId}`; }
  // Drops a still-waiting entry from the queue — from its own button's ❌,
  // or (skipForget: true) from a republish:cancelQueued broadcast when the
  // popup cancelled it first and already forgot the JobStore record.
  function cancelQueueEntry(entry, { skipForget = false } = {}) {
    if (entry.running) return false;
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (entry.bulk) { entry.bulk.pending--; if (entry.bulk.pending <= 0) finishBulk(entry.bulk); }
    const btn = entry.btn;
    if (btn) {
      btn._cancelRepublish = null; btn.classList.remove('is-loading'); btn.title = '';
      setCancelVisual(btn, false); NS.setButtonText(btn, NS.i18n().relistButton);
    }
    entry.resolve();
    if (!skipForget) NS.control('forget', { key: keyFor(entry), onlyIfQueued: true }).catch(() => {});
    paintQueue();
    return true;
  }
  // Shared by a fresh click and by attachPendingQueueButtons(): lets a
  // button still waiting its turn drop itself from the queue.
  function wireWaitingCancel(entry, btn) {
    btn._cancelRepublish = () => { cancelQueueEntry(entry); };
  }
  // The popup has no access to this tab's in-memory queue; when it cancels
  // a waiting item it forgets the JobStore record itself and broadcasts
  // here so an already-open dressing tab drops it and repaints immediately.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'republish:cancelQueued') return;
    const entry = queue.find(e => keyFor(e) === message.key);
    if (entry) cancelQueueEntry(entry, { skipForget: true });
  });
  function runRepublishOnButton(btn, itemId, memberId, seedFromDom) {
    if (!itemId || !memberId) return Promise.resolve();
    if (queue.some(entry => entry.itemId === itemId && entry.memberId === memberId)) return Promise.resolve();
    const entry = { itemId, memberId, btn: btn || null, seedFromDom, resolve: () => {}, running: false, due: 0, bulk: null };
    if (btn) { btn.classList.add('is-loading'); btn.disabled = true; btn.title = ''; }
    return new Promise(resolve => {
      entry.resolve = resolve;
      const enqueue = () => {
        // A durable JobStore record must exist before this entry is visible
        // in the queue/popup or countable toward a reload's auto-resume —
        // otherwise a waiting item would vanish if the tab closes first.
        queue.push(entry);
        if (btn) {
          btn.disabled = false;
          btn.title = NS.i18n().clickToCancel;
          setCancelVisual(btn, true);
          wireWaitingCancel(entry, btn);
        }
        if (!queueTimer) queueTimer = setInterval(paintQueue, 1000);
        paintQueue(); void driveQueue();
      };
      if (seedFromDom && btn) {
        seedQueueEntry(entry).then(enqueue).catch(error => {
          btn.disabled = false; btn.classList.remove('is-loading');
          NS.setButtonText(btn, message('retryButton')); btn.title = error?.message || '';
          resolve();
        });
      } else enqueue();
    });
  }
  // A listing further down the (virtualized/lazily rendered) dressing only
  // gets its "Republier" button once scrolled into view. Reconnect it to
  // its already-waiting or already-running queue entry as soon as it
  // appears, instead of leaving a plain button unaware it's in the queue.
  function attachPendingQueueButtons() {
    let changed = false;
    for (const entry of queue) {
      if (entry.btn) continue;
      const btn = buttonForItem(entry.itemId);
      if (!btn) continue;
      entry.btn = btn;
      changed = true;
      btn.classList.add('is-loading');
      if (entry.running) {
        btn.disabled = true;
        btn.title = '';
      } else {
        btn.disabled = false;
        btn.title = NS.i18n().clickToCancel;
        setCancelVisual(btn, true);
        wireWaitingCancel(entry, btn);
      }
    }
    if (changed) paintQueue();
  }
  // Runs one queue entry end-to-end, whether it came from a single click
  // (entry.bulk is null) or from a "Tout republier" batch (entry.bulk set,
  // in which case the chip button also gets live progress). entry.btn is
  // re-read throughout rather than captured once, so a button that only
  // gets attached mid-run (attachPendingQueueButtons) still picks up state.
  async function performItem(entry) {
    const { itemId, memberId, bulk: b } = entry;
    entry.btn = entry.btn || buttonForItem(itemId);
    let cancelRequested = false;
    if (entry.btn) {
      const btn = entry.btn;
      btn.classList.remove('is-error');
      delete btn.dataset.republishErrorKey;
      btn._cancelRepublish = null;
      setCancelVisual(btn, false);
      btn.disabled = true;
      btn.classList.add('is-loading');
    }
    try {
      const result = await NS.republish(itemId, memberId, (phase, seconds) => {
        entry.due = phase === 'cooldown' ? Date.now() + seconds * 1000 : 0;
        paintQueue();
        const label = phaseLabel(phase, seconds);
        const cancellable = phase === 'cooldown';
        const btn = entry.btn;
        if (btn) {
          btn.classList.add('is-loading');
          if (label) NS.setButtonText(btn, label);
          btn.disabled = !cancellable;
          btn._cancelRepublish = cancellable ? () => { cancelRequested = true; btn.disabled = true; } : null;
          setCancelVisual(btn, cancellable);
          if (cancellable) btn.title = NS.i18n().clickToCancel;
        }
        // "Tout republier" itself stays untouched during a run — progress
        // lives on the "Liste d'attente" button and in the popup instead.
      }, () => cancelRequested || Boolean(b?.cancelled));
      if (!result.ok) {
        const btn = entry.btn;
        if (result.cancelled) {
          // Cancelling a countdown must not discard a copy awaiting cleanup.
          if (result.jobKey) await NS.control('forget', { key: result.jobKey, onlyIfQueued: true }).catch(() => {});
          if (btn) { btn.disabled = false; NS.setButtonText(btn, NS.i18n().relistButton); btn.title = ''; }
          await syncSavedErrors().catch(() => {});
          return;
        }
        if (btn) showRepublishFailure(btn, result);
        else NS.showNotice(republishErrorMessage(result.error), 'error');
        // Stop the rest of this batch on a failure: keep the remaining jobs
        // queued in JobStore for an explicit retry, same as a cancel.
        if (b) b.cancelled = true;
        return;
      }
      if (entry.btn) {
        entry.btn.classList.add('is-republished');
        NS.setButtonText(entry.btn, `✅ ${message('successButton')}`);
        entry.btn.title = '';
      }
      savedErrorsByItem.delete(String(itemId));
      if (b) b.completed++;
    } catch (error) {
      const btn = entry.btn;
      if (btn) { btn.disabled = false; NS.setButtonText(btn, message('retryButton')); btn.title = error?.message || ''; }
      NS.reportError('republish-button', error, { itemId });
    } finally {
      const btn = entry.btn;
      if (btn) { btn._cancelRepublish = null; setCancelVisual(btn, false); btn.classList.remove('is-loading'); }
    }
  }

  async function republishFromButton(btn) {
    if (typeof btn._cancelRepublish === 'function') {
      btn._cancelRepublish();
      return;
    }
    if (btn.dataset.republishErrorKey) {
      await openPendingDetail(btn.dataset.republishErrorKey);
      return;
    }
    const itemId = NS.findClosestItemId(btn);
    const memberId = getMemberId();
    if (!itemId || !memberId) {
      NS.setButtonText(btn, message('retryButton'));
      btn.title = message(itemId ? 'missingAccountNotice' : 'missingItemIdNotice');
      return;
    }
    await runRepublishOnButton(btn, itemId, memberId, true);
  }

  function buttonForItem(itemId) {
    return [...document.querySelectorAll('.vinted-republish-btn')]
      .find(button => NS.findClosestItemId(button) === String(itemId)) || null;
  }

  function paginationValue(pagination, names) {
    for (const name of names) {
      const value = Number(pagination?.[name]);
      if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    }
    return null;
  }

  function pageItems(result, memberId) {
    return (Array.isArray(result?.items) ? result.items : [])
      .filter(item => NS.isWardrobeItemEligible(item, memberId))
      .map(NS.wardrobeItemSummary);
  }

  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  async function fetchWardrobePageWithRetry(memberId, page) {
    const retryDelays = [5000, 15000, 30000];
    for (let attempt = 0; ; attempt++) {
      try { return await NS.fetchWardrobePage(memberId, page, true); }
      catch (error) {
        // Authentication, anti-bot and rate limits already install a shared
        // pause in the coordinator. Retrying them here would add avoidable load.
        if (['auth', 'anti-bot', 'rate-limit'].includes(error.code) || attempt >= retryDelays.length) throw error;
        await sleep(retryDelays[attempt]);
      }
    }
  }

  // Pushes every job left "queued" by the wardrobe scan into the shared
  // queue as one batch, in scan order, and hands progress display of the
  // "Tout republier" chip over to performItem/driveQueue.
  function startBulk(btn, memberId, jobs) {
    // A listing already sitting in the queue (a manual Republier click got
    // to it first) must not get a second, duplicate entry here.
    const fresh = jobs.filter(job => !queue.some(entry => entry.itemId === job.itemId && entry.memberId === memberId));
    if (!fresh.length) {
      NS.setChipButtonText(btn, NS.i18n().relistAllButton);
      btn.disabled = false;
      NS.showNotice(message('bulkFinished', { count: 0, total: 0 }), 'success');
      return;
    }
    const b = { btn, total: fresh.length, completed: 0, pending: 0, cancelled: false };
    btn._cancelBulk = () => { b.cancelled = true; };
    bulk = b;
    // "Tout republier" stays as-is and disabled for the whole run — no
    // progress text, no accidental cancel-by-click; that lives in the
    // "Liste d'attente" button and the popup instead.
    btn.disabled = true;
    for (const job of fresh) {
      const entry = { itemId: job.itemId, memberId, btn: null, seedFromDom: false, resolve: () => {}, running: false, due: 0, bulk: b };
      queue.push(entry);
      b.pending++;
    }
    if (!queueTimer) queueTimer = setInterval(paintQueue, 1000);
    paintQueue();
    void driveQueue();
  }
  async function queueAllItems(btn) {
    if (btn._cancelBulk) { btn._cancelBulk(); return; }
    if (bulkRunning || bulk || NS.lease) return;
    const L = NS.i18n();
    const memberId = getMemberId();
    if (!memberId) { NS.showNotice(message('missingAccountNotice'), 'error'); return; }
    bulkRunning = true;
    // Only during the scan, until the confirm dialog: "Tout republier" gets
    // a one-shot "collecting" label, then goes back to its own name and
    // never changes again once a run actually starts (see startBulk).
    btn.disabled = true;
    NS.setChipButtonText(btn, message('collectingListings'));
    let scan = null;
    let profile = null;
    let handedOff = false;
    const rememberAccount = listingCount => {
      if (profile) {
        try { chrome.runtime.sendMessage({ type: 'vinted:rememberAccount', profile, listingCount }); } catch (_) {}
      }
    };
    try {
      // This identity check is a plain, uncached fetch (getCurrentAccountProfile
      // force-refreshes) — a single transient 401 here shouldn't abort the
      // whole run when the queue itself is clearly still authenticated.
      profile = await transferProfile().catch(async error => {
        if (error.code !== 'auth') throw error;
        await sleep(2000);
        return transferProfile();
      });
      if (profile.id !== memberId) throw Object.assign(new Error('account'), { code: 'account' });

      // Snapshot of what's already queued before this scan touches
      // anything, so declining the dialog only un-seeds what this run
      // itself just added — not a manual click seeded moments earlier.
      const preScanJobs = (await NS.control('state')).jobs
        .filter(job => job.origin === location.origin && String(job.sourceAccountId || job.accountId) === String(memberId));
      const preScanKeys = new Set(preScanJobs.map(job => job.key));

      scan = await NS.control('scan-state', { sourceAccountId: memberId });
      rememberAccount(scan?.totalItems ?? scan?.scanned ?? null);

      if (scan?.completedAt) {
        // A "completed" scan is cached for a few minutes so a quick reclick
        // doesn't re-fetch the whole wardrobe. But if everything it queued
        // has already been republished (and pruned from the job store), the
        // cache is stale: fall through to a fresh scan instead of proposing
        // a count of jobs that no longer exist.
        const stillQueued = preScanJobs.some(job => job.stage === 'queued');
        if (!stillQueued) scan = null;
      }

      if (!scan || !scan.completedAt) {
        scan = await NS.control('scan-start', { sourceAccountId: memberId });
        let totalPages = scan.totalPages || null;
        let totalItems = scan.totalItems ?? null;
        if (!totalPages) {
          const startPage = Math.max(1, Number(scan.nextPage || 1));
          const firstResult = await fetchWardrobePageWithRetry(memberId, startPage);
          const firstItems = pageItems(firstResult, memberId);
          const pagination = firstResult?.pagination || {};
          totalPages = paginationValue(pagination, ['total_pages', 'page_count']) || (firstItems.length ? 1 : 0);
          totalItems = paginationValue(pagination, ['total_entries', 'total_items', 'total', 'count']);
          rememberAccount(totalItems ?? firstItems.length);
          if (!firstItems.length || !totalPages) {
            await NS.control('scan-failed', { sourceAccountId: memberId, scanId: scan.scanId, error: 'empty' }).catch(() => {});
            NS.showNotice(L.nothingToRelist, 'error');
            return;
          }
          const saved = await NS.control('scan-page', {
            sourceAccountId: memberId, scanId: scan.scanId, page: startPage, totalPages, totalItems, items: firstItems,
          });
          scan = saved.scan;
          if (startPage < totalPages) await sleep(1000 + Math.random() * 2000);
        }

        totalPages = scan.totalPages || totalPages;
        for (let page = Math.max(1, Number(scan.nextPage || 1)); page <= totalPages; page++) {
          const result = await fetchWardrobePageWithRetry(memberId, page);
          const items = pageItems(result, memberId);
          const responsePages = paginationValue(result?.pagination, ['total_pages', 'page_count']);
          if (responsePages && responsePages >= page) totalPages = responsePages;
          const responseTotal = paginationValue(result?.pagination, ['total_entries', 'total_items', 'total', 'count']);
          const saved = await NS.control('scan-page', {
            sourceAccountId: memberId, scanId: scan.scanId, page, totalPages, totalItems: responseTotal ?? totalItems, items,
          });
          scan = saved.scan;
          if (page < totalPages) await sleep(1000 + Math.random() * 2000);
        }

        scan = await NS.control('scan-complete', { sourceAccountId: memberId, scanId: scan.scanId });
        rememberAccount(scan.totalItems ?? scan.scanned);
      }

      // The full dressing is seeded now — the dialog can propose an exact
      // count instead of a pre-scan estimate: new, not already queued
      // (manual click or a prior run) and not stuck in error.
      const current = await NS.control('state');
      const accountJobs = current.jobs.filter(job => job.origin === location.origin &&
        String(job.sourceAccountId || job.accountId) === String(memberId));
      const jobs = accountJobs.filter(job => job.stage === 'queued' && job.status !== 'error' &&
        !queue.some(entry => entry.itemId === job.itemId && entry.memberId === memberId))
        .sort((a, c) => (a.createdAt || 0) - (c.createdAt || 0));

      if (!jobs.length) {
        // Nothing left to add: say why instead of a bare "0/0", which reads
        // like a failure even when every listing is already being handled.
        const inProgress = queue.length > 0 || accountJobs.some(job => !job.done && job.stage !== 'deleted' && job.status !== 'error');
        const errored = accountJobs.some(job => job.status === 'error' && !job.resolved);
        if (inProgress) NS.showNotice(message('bulkAlreadyQueued'), 'success');
        else if (errored) NS.showNotice(message('bulkAllErrored'), 'error');
        else if (scan?.skipped) NS.showNotice(message('bulkSkippedCooldownNotice', { count: scan.skipped }), 'success');
        else NS.showNotice(message('bulkFinished', { count: 0, total: 0 }), 'success');
        return;
      }

      // The estimate covers everything that will actually be waiting once
      // this run joins the queue, not just the new items in isolation —
      // hourly/daily caps don't add up linearly across two separate counts.
      const totalCount = queue.length + jobs.length;
      const cfg = current.settings;
      const minutes = Math.ceil(Math.max(totalCount * cfg.itemDelay, Math.floor(Math.max(0, totalCount - 1) / cfg.hourlyLimit) * 60, Math.floor(Math.max(0, totalCount - 1) / cfg.dailyLimit) * 1440));
      const duration = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
      NS.setChipButtonText(btn, L.relistAllButton);
      const confirmed = await NS.showConfirmDialog(message(queue.length ? 'confirmBulkAdd' : 'confirmBulk', { count: jobs.length })
        + (scan?.skipped ? '\n\n' + message('bulkSkippedCooldownNotice', { count: scan.skipped }) : '')
        + '\n\n' + message('bulkDuration', { duration }), { configuration: true });
      if (!confirmed) {
        // Only forget what this run itself just seeded — anything that was
        // already queued before it started stays exactly as it was.
        await Promise.all(jobs.filter(job => !preScanKeys.has(job.key))
          .map(job => NS.control('forget', { key: job.key, onlyIfQueued: true }).catch(() => {})));
        return;
      }

      handedOff = true;
      startBulk(btn, memberId, jobs);
    } catch (error) {
      if (scan) await NS.control('scan-failed', { sourceAccountId: memberId, scanId: scan.scanId, error: error.code || error.message }).catch(() => {});
      NS.reportError('queue-wardrobe', error, { nextPage: scan?.nextPage, totalPages: scan?.totalPages });
      const reason = String(error?.code || error?.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      NS.showNotice(message('bulkInterruptedNotice', { count: scan?.scanned || 0 }) + ` (${reason})`, 'error');
    } finally {
      bulkRunning = false;
      if (!handedOff) { btn.disabled = false; NS.setChipButtonText(btn, L.relistAllButton); }
    }
  }

  function openQueueOverview() {
    chrome.runtime.sendMessage({ type: 'republish:openQueue' }).catch(() => {});
  }
  // The item-count heading ("22 articles") isn't inside the filters bar and
  // carries no testid, only Vinted's generic title text style — matched by
  // a leading number so it still works across languages ("22 items", …).
  function findItemCountHeading() {
    return [...document.querySelectorAll('h2.web_ui__Text__title')].find(h => /^\d+\s/.test((h.textContent || '').trim())) || null;
  }
  function injectQueueSummaryButton() {
    const heading = findItemCountHeading();
    if (!heading || !heading.parentElement) return;
    let summary = document.querySelector('.vinted-queue-summary-btn');
    if (!summary) {
      summary = NS.makeChipButton('');
      summary.classList.add('vinted-queue-summary-btn');
      summary.hidden = true;
      summary.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openQueueOverview(); });
    }
    let row = heading.closest('.vinted-republish-heading-actions');
    if (!row) {
      row = document.createElement('div');
      row.className = 'vinted-republish-heading-actions';
      heading.parentElement.insertBefore(row, heading);
      row.appendChild(heading);
    }
    row.appendChild(summary);
    summary.hidden = true;
    updateQueueSummaryButton();
  }
  // "Liste d'attente : X - Fin : HHhMM", stuck to the "22 articles" heading —
  // the one place that summarizes both manual and bulk items together.
  function updateQueueSummaryButton() {
    const btn = document.querySelector('.vinted-queue-summary-btn');
    if (!btn) {
      // Vinted's own re-render (e.g. right after a republished listing's
      // original gets deleted, which reflows the wardrobe grid) can wipe our
      // injected chip along with it. Re-inject immediately instead of
      // waiting on the debounced observer, so it doesn't sit missing until
      // the next unrelated mutation.
      if (queue.length) injectQueueSummaryButton();
      return;
    }
    if (!queue.length) { btn.hidden = true; return; }
    const last = queue[queue.length - 1];
    btn.hidden = false;
    NS.setChipButtonText(btn, message('queueSummaryButton', { count: queue.length, time: formatClock(last?.dueAt || Date.now()) }));
  }
  function injectRelistAllButton() {
    const filters = document.querySelector('[data-testid="closet-seller-filters"]')
      || (document.querySelector('[data-testid="closet-seller-filters-active"]') || {}).parentElement;
    if (!filters) return;

    const hasRelist = document.querySelector('.vinted-relist-all-btn');
    const hasTransfer = document.querySelector('.vinted-transfer-account-btn');
    if (hasTransfer) hasTransfer.hidden = !showTransferButton;
    const transferSpacer = filters.querySelector('.vinted-transfer-spacer');
    if (transferSpacer) transferSpacer.hidden = !showTransferButton;
    if (hasRelist && (hasTransfer || !showTransferButton)) return;
    // Placé avant les chips "Actifs"/"Vendus", avec le transfert avant
    // "Tout republier" pour démarrer depuis le dressing source garanti.
    const firstChild = filters.firstChild;
    let relistButton = hasRelist;
    if (!hasRelist) {
      const btn = NS.makeChipButton(NS.i18n().relistAllButton);
      btn.classList.add('vinted-relist-all-btn');
      btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); void queueAllItems(btn); });
      filters.insertBefore(btn, firstChild);
      filters.insertBefore(NS.makeChipSpacer(), firstChild);
      relistButton = btn;
    }
    if (!hasTransfer && showTransferButton) {
      const transfer = NS.makeChipButton(message('transferAccountButton'));
      transfer.classList.add('vinted-transfer-account-btn');
      transfer.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); void openTransferFromWardrobe(transfer); });
      const reference = relistButton || firstChild;
      filters.insertBefore(transfer, reference);
      const spacer = NS.makeChipSpacer();
      spacer.classList.add('vinted-transfer-spacer');
      filters.insertBefore(spacer, reference);
    }
  }

  function refreshRepublishButtons() {
    const bumped = NS.getBumpButtons();
    let injected = 0;
    for (const b of bumped) {
      const existing = b.parentElement && b.parentElement.querySelector('.vinted-republish-btn');
      if (existing) continue;
      const btn = NS.makeButton(NS.i18n().relistButton);
      btn.classList.add('vinted-republish-btn');
      btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); republishFromButton(btn); });
      if (b.parentElement) {
        const spacer = document.createElement('div');
        spacer.classList.add('vinted-republish-spacer');
        spacer.style.height = '8px'; spacer.style.width = '100%';
        b.parentElement.appendChild(spacer);
        b.parentElement.appendChild(btn);
        injected++;
      }
    }
    if (injected > 0) NS.log('Injecté', injected, 'bouton(s)', NS.i18n().relistButton);
    applySavedErrorButtons();
    attachPendingQueueButtons();
  }

  async function injectButtons() {
    NS.ensureStyles();
    injectRelistAllButton();
    refreshRepublishButtons();
  }

  function uniqueHeaderAvatar() {
    const images = [...document.querySelectorAll('img.web_ui__Image__image.web_ui__Image__circle')]
      .filter(image => image.currentSrc || image.src);
    return images.length === 1 ? String(images[0].currentSrc || images[0].src) : '';
  }

  async function transferProfile() {
    const profile = await NS.getCurrentAccountProfile(true);
    const avatarUrl = uniqueHeaderAvatar();
    return avatarUrl ? { ...profile, avatarUrl } : profile;
  }

  async function transferList() {
    const profile = await transferProfile();
    const found = [];
    const counts = { active: 0, sold: 0, draft: 0, pending: 0 };
    for (let page = 1; page <= 1000; page++) {
      const result = await NS.fetchWardrobePage(profile.id, page, true, true);
      for (const item of Array.isArray(result?.items) ? result.items : []) {
        const state = NS.wardrobeItemState(item);
        if (Object.hasOwn(counts, state)) counts[state]++;
      }
      found.push(...pageItems(result, profile.id));
      if (page >= Number(result?.pagination?.total_pages || 1)) break;
      await sleep(1200 + Math.random() * 800);
    }
    counts.active = found.length;
    return { profile, items: found, counts };
  }

  async function transferCapture(accountId, itemId) {
    if (await NS.getCurrentAccountId(true) !== String(accountId)) throw Object.assign(new Error('Le compte A connecté ne correspond pas au lot.'), { code: 'account' });
    const source = await NS.getItemDetails(itemId);
    const owner = source.user_id || source.user?.id;
    if (owner && String(owner) !== String(accountId)) throw Object.assign(new Error('Cette annonce ne dépend pas du compte A.'), { code: 'account' });
    const urls = NS.pickPhotos(source);
    if (!urls.length || urls.length !== source.photos?.length) throw Object.assign(new Error('Toutes les photos ne sont pas accessibles.'), { code: 'photos' });
    const blobs = new Array(urls.length);
    let nextPhoto = 0;
    async function downloadWorker() {
      while (nextPhoto < urls.length) {
        const index = nextPhoto++;
        blobs[index] = await NS.downloadAsBlob(urls[index], true);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, urls.length) }, downloadWorker));
    return { source, blobs };
  }

  async function transferDelete(accountId, itemId) {
    if (await NS.getCurrentAccountId(true) !== String(accountId)) throw Object.assign(new Error('Le compte A n’est plus connecté.'), { code: 'account' });
    try { await NS.getItemDetails(itemId); }
    catch (error) { if (error.code === 'missing' || error.status === 404) return { deleted: true, alreadyDeleted: true }; throw error; }
    const csrf = await NS.getCsrf();
    try { await NS.deleteItem(csrf, itemId); }
    catch (error) { if (error.code === 'missing' || error.status === 404) return { deleted: true, alreadyDeleted: true }; throw error; }
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(attempt ? 2000 : 500);
      try { await NS.getItemDetails(itemId); }
      catch (error) { if (error.code === 'missing') return { deleted: true }; throw error; }
    }
    throw Object.assign(new Error('Vinted retourne encore l’annonce après la suppression.'), { code: 'delete-unconfirmed' });
  }

  async function transferCreate(accountId, source, blobs) {
    if (await NS.getCurrentAccountId(true) !== String(accountId)) throw Object.assign(new Error('Le compte B connecté ne correspond pas au lot.'), { code: 'account' });
    if (!Array.isArray(blobs) || !blobs.length) throw Object.assign(new Error('Sauvegarde photo absente.'), { code: 'photos' });
    const csrf = await NS.getCsrf();
    const sessionId = NS.uuidv4();
    const uploaded = [];
    for (const blob of blobs) {
      const photo = await NS.uploadPhoto(csrf, blob, sessionId);
      if (!photo?.id) throw Object.assign(new Error('Une photo n’a pas été transférée.'), { code: 'photos' });
      uploaded.push({ id: photo.id, orientation: photo.orientation || 0 });
    }
    const payload = NS.buildPayload(source, sessionId, uploaded);
    if (await NS.getCurrentAccountId(true) !== String(accountId)) throw Object.assign(new Error('Le compte a changé avant la création.'), { code: 'account' });
    const created = await NS.createItem(csrf, payload);
    const newItemId = String(created.item?.id || '');
    if (!/^\d+$/.test(newItemId) || newItemId === String(source.id)) throw Object.assign(new Error('La création n’a pas renvoyé un identifiant fiable.'), { code: 'uncertain' });
    const checked = await NS.verifyCreatedItem(csrf, newItemId);
    const owner = checked.item?.user_id || checked.item?.user?.id;
    if (!checked.ok || (owner && String(owner) !== String(accountId)) || checked.item?.photos?.length !== blobs.length) {
      throw Object.assign(new Error('La nouvelle annonce n’a pas pu être vérifiée sur le compte B.'), { code: 'unconfirmed' });
    }
    return { newItemId };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'transfer:rpc') return false;
    (async () => {
      if (message.action === 'profile') return { profile: await transferProfile() };
      if (message.action === 'list') return transferList();
      if (message.action === 'capture') return transferCapture(message.accountId, message.itemId);
      if (message.action === 'delete') return transferDelete(message.accountId, message.itemId);
      if (message.action === 'create') return transferCreate(message.accountId, message.source, message.blobs);
      throw new Error('Action de transfert inconnue.');
    })().then(value => respond({ ok: true, value })).catch(error => respond({ ok: false, code: error.code || 'transfer', error: error.message }));
    return true;
  });

  (async function init() {
    NS.config = NS.DEFAULT_CONFIG;
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (sender.id !== chrome.runtime.id || message?.type !== 'republish:settings') return;
      showTransferButton = message.showTransferButton === true;
      injectRelistAllButton();
    });
    // Page scripts cannot read storage restricted to TRUSTED_CONTEXTS.
    // A preference failure must not prevent the regular buttons from appearing.
    try {
      const preferences = await NS.control('state');
      showTransferButton = preferences.settings?.showTransferButton === true;
    } catch (_) { showTransferButton = false; }
    await NS.localeReady;
    NS.resetLanguage?.();
    document.addEventListener('republish:language', () => {
      document.querySelectorAll('.vinted-republish-btn.is-error').forEach(btn => NS.setButtonText(btn, NS.i18n().errorDetailsButton));
      document.querySelectorAll('.vinted-republish-btn:not(.is-loading):not(.is-republished):not(.is-error)').forEach(btn => NS.setButtonText(btn, NS.i18n().relistButton));
      if (!bulkRunning && !bulk) document.querySelectorAll('.vinted-relist-all-btn').forEach(btn => NS.setChipButtonText(btn, NS.i18n().relistAllButton));
      document.querySelectorAll('.vinted-transfer-account-btn').forEach(btn => NS.setChipButtonText(btn, NS.i18n().transferAccountButton));
    });
    NS.ensureStyles();
    let injectTimer = null;
    const scheduleInjection = () => {
      clearTimeout(injectTimer);
      injectTimer = setTimeout(() => { void injectButtons(); }, 150);
    };
    const obs = new MutationObserver(scheduleInjection);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    await injectButtons();
    await syncSavedErrors().catch(() => {});
    // Re-check when the tab regains focus so a listing resolved on the errors
    // page stops showing the failure button here without a reload.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncSavedErrors().catch(() => {}); });

    // Releases a lease left over from a stale document (e.g. this same tab
    // reloaded mid-job) so a fresh acquire below isn't refused as "busy".
    await chrome.runtime.sendMessage({ type: 'republish:ready' }).catch(() => null);

    // Auto-resume: on the dressing page of the account that owns them, pick
    // back up any job left mid-flight by a reload/navigation (bulk or
    // manual) instead of requiring the button to be clicked again. Failed
    // jobs are excluded — those need an explicit retry, not a silent replay.
    const ownMemberMatch = (location.pathname || '').match(/^\/member\/(\d+)/);
    if (ownMemberMatch && document.querySelector('[data-testid="closet-seller-filters"]')) {
      const memberId = ownMemberMatch[1];
      try {
        const resumeState = await NS.control('state');
        const lease = resumeState.gates?.[location.origin]?.lease;
        const leaseHeld = Boolean(lease && lease.until > Date.now());
        if (!leaseHeld) {
          const pending = resumeState.jobs
            .filter(job => job.origin === location.origin &&
              String(job.sourceAccountId || job.accountId) === memberId &&
              !job.done && job.stage !== 'deleted' && job.status !== 'error')
            .sort((a, c) => (a.createdAt || 0) - (c.createdAt || 0));
          // A "Tout republier" batch interrupted by the reload resumes as
          // one group under the chip (progress + cancel-all) instead of as
          // separate silent items; individual Republier clicks stay separate.
          const bulkJobs = pending.filter(job => job.queuedVia === 'bulk');
          const manualJobs = pending.filter(job => job.queuedVia !== 'bulk');
          // Only an already-visible "Republier" button gets its text driven
          // live; an item with none still resumes in the background and
          // shows up in the popup's queue list instead of spawning one.
          for (const job of manualJobs) {
            void runRepublishOnButton(buttonForItem(job.itemId), job.itemId, memberId, false);
          }
          const chipBtn = document.querySelector('.vinted-relist-all-btn');
          if (bulkJobs.length && chipBtn && !bulk) startBulk(chipBtn, memberId, bulkJobs);
        }
      } catch (_) {}
    }
  })();
})();
