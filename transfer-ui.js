(async function () {
  'use strict';
  const FALLBACK_AVATAR = 'media/account-placeholder.png';
  const $ = selector => document.querySelector(selector);
  const launchParams = new URLSearchParams(location.search);
  const launchSource = {
    origin: launchParams.get('sourceOrigin') || '',
    accountId: launchParams.get('sourceAccountId') || '',
  };
  const autoCapture = launchParams.get('autoCapture') === '1';
  if (!/^https:\/\/www\.vinted\./.test(launchSource.origin) || !/^\d+$/.test(launchSource.accountId)) {
    location.replace('welcome.html');
    return;
  }
  let batch = null;
  let items = [];
  let busy = false;
  let titleFilter = '';
  let brandFilters = new Set();
  let brandFilterInitialized = false;
  let knownBrands = new Set();
  let priceMin = 0;
  let priceMax = Infinity;
  let priceCeiling = Infinity;
  let dateAfter = '';
  let dateBefore = '';
  let sortKey = 'date';
  let sortDirection = 'desc';
  let activeReportTimestamp = null;
  let scheduledDeletion = null;
  let scheduledCreation = null;
  let deletionRunning = false;
  let deleteCancellationRequested = false;
  let captureListingBusy = false;
  const objectUrls = new Set();
  const deletionBadges = new Map();
  const creationBadges = new Map();

  function status(message, error = false) {
    $('#transfer-status').textContent = message;
    $('#transfer-status').classList.toggle('error-text', error);
  }
  function installClickLogger() {
    document.addEventListener('click', event => {
      const target = event.target.closest('button, a[href]');
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
        page: 'transfert',
        id: target.id || target.dataset.sort || target.dataset.filterToggle || '',
        text: (target.innerText || target.textContent || target.getAttribute('aria-label') || '').trim().slice(0, 160),
        classes: String(target.className || '').slice(0, 240),
        href,
      }).catch(() => {});
    }, true);
  }
  installClickLogger();
  async function command(action, values = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'transfer:page', action, ...values });
    if (!response?.ok) throw Object.assign(new Error(response?.error || 'Action impossible'), { code: response?.code });
    return response.value;
  }
  async function showTransferError(error, action, item = null) {
    const message = String(error?.message || error || 'Erreur inconnue');
    const reportable = String(error?.code || '') !== 'no-vinted-tab';
    const detail = {
      action,
      code: String(error?.code || 'transfer'),
      phase: phase(),
      lot: String(batch?.status || 'aucun'),
      annonce: item ? String(itemSource(item).title || 'Annonce sélectionnée') : null,
    };
    const reportContext = { action: detail.action, code: detail.code, phase: detail.phase, lot: detail.lot, annonceSélectionnée: Boolean(item) };
    const timestamp = new Date().toISOString();
    const response = reportable ? await chrome.runtime.sendMessage({
      type: 'vinted:storeReport',
      report: {
        pageOrigin: batch?.sourceOrigin || 'https://www.vinted.fr',
        timestamp,
        payload: {
          errorName: String(error?.name || 'Error'), errorMessage: message, stack: String(error?.stack || ''), context: reportContext,
          extensionVersion: chrome.runtime.getManifest().version,
          chromeVersion: navigator.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1] || 'unknown',
        },
        privateContext: { jobKey: batch?.id ? `transfer:${batch.id}` : 'transfer', listingTitle: detail.annonce || 'Transfert de compte' },
      },
    }).catch(() => null) : null;
    activeReportTimestamp = response?.ok ? timestamp : null;
    $('#transfer-error-message').textContent = message;
    $('#transfer-error-details').textContent = JSON.stringify({ ...detail, technique: String(error?.stack || message).slice(0, 2000) }, null, 2);
    $('#transfer-report-actions').hidden = !reportable;
    $('#transfer-error-details-section').hidden = !reportable;
    $('#transfer-report-status').textContent = reportable && !activeReportTimestamp ? 'Le rapport local n’a pas pu être préparé.' : '';
    $('#send-transfer-report').disabled = !activeReportTimestamp;
    $('#send-transfer-report').textContent = 'Envoyer un rapport';
    $('#transfer-error-toast').hidden = false;
  }
  const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const randomDeletionDelayMs = () => (6 + Math.floor(Math.random() * 7)) * 10 * 1000;
  async function transferCooldown(label, completed, total, nextItem = null, mode = null) {
    if (completed >= total) return;
    const response = await chrome.runtime.sendMessage({ type: 'republish:control', action: 'state' }).catch(() => null);
    const settings = response?.value?.settings || {};
    const isDeletion = mode === 'delete';
    const isCreation = mode === 'create';
    const minutes = Number(settings.itemDelay || 5);
    const delay = isDeletion ? randomDeletionDelayMs() : Math.max(1, minutes + (Math.random() * 1.8 - 0.9)) * 60 * 1000;
    const until = Date.now() + delay;
    if (isDeletion && nextItem) { scheduledDeletion = { key: nextItem.key, until }; render(); }
    if (isCreation && nextItem) { scheduledCreation = { key: nextItem.key, until }; render(); }
    while (Date.now() < until) {
      if (isDeletion && deleteCancellationRequested) { scheduledDeletion = null; render(); return false; }
      const seconds = Math.ceil((until - Date.now()) / 1000);
      status(`${label} ${completed + 1}/${total} dans ${seconds} s…`);
      const badge = isDeletion
        ? deletionBadges.get(nextItem?.key)
        : isCreation ? creationBadges.get(nextItem?.key) : null;
      if (badge) badge.textContent = `Suppression dans ${seconds} s…`;
      if (badge && isCreation) badge.textContent = `Création dans ${seconds} s…`;
      await sleep(Math.min(1000, until - Date.now()));
    }
    if (isDeletion) { scheduledDeletion = null; render(); }
    if (isCreation) { scheduledCreation = null; render(); }
    return true;
  }
  function money(source) {
    const amount = Number(source?.price_numeric ?? source?.price?.amount ?? source?.price ?? 0);
    const currency = source?.price_currency || source?.price?.currency_code || source?.currency || 'EUR';
    try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(amount); } catch (_) { return String(amount); }
  }
  function stateLabel(value) {
    return ({ queued: 'À capturer', capturing: 'Capture', ready: 'Vérifié', capture_error: 'Erreur', deleting: 'Suppression…', deleted: 'Supprimée et vérifiée', delete_error: 'Erreur', transferring: 'Création…', transferred: 'Créée et vérifiée', transfer_error: 'Erreur' })[value] || '—';
  }
  function localStateCell(item) {
    const cell = document.createElement('td'); const badge = document.createElement('span');
    const value = item.captureState;
    const waiting = value === 'queued' && item.selected && ['capturing', 'capture-error'].includes(batch?.status);
    if (!waiting && !['capturing', 'ready', 'capture_error'].includes(value)) { cell.textContent = '—'; return cell; }
    badge.className = `local-state ${value === 'capturing' ? 'is-capturing' : value === 'ready' ? 'is-verified' : value === 'capture_error' ? 'is-error' : 'is-queued'}`;
    badge.textContent = waiting ? 'À capturer' : stateLabel(value); cell.append(badge); return cell;
  }
  function deleteStateCell(item) {
    const cell = document.createElement('td');
    const badge = document.createElement('span');
    let label = '—'; let className = '';
    if (scheduledDeletion?.key === item.key) {
      label = `Suppression dans ${Math.max(0, Math.ceil((scheduledDeletion.until - Date.now()) / 1000))} s…`; className = 'is-active';
    } else if (item.deleteState === 'deleting') { label = 'Suppression'; className = 'is-active'; }
    else if (item.deleteState === 'deleted') { label = 'Supprimée et vérifiée'; className = 'is-done'; }
    else if (item.deleteState === 'delete_error') { label = 'Erreur'; className = 'is-error'; }
    else if (item.selected && ['deleting-source', 'delete-error', 'delete-paused'].includes(batch?.status)) { label = 'À supprimer'; className = 'is-queued'; }
    if (!className) { cell.textContent = label; return cell; }
    badge.className = `delete-state ${className}`; badge.textContent = label; cell.append(badge); deletionBadges.set(item.key, badge); return cell;
  }
  function transferStateCell(item) {
    const cell = document.createElement('td');
    const badge = document.createElement('span');
    let label = '—'; let className = '';
    if (scheduledCreation?.key === item.key) {
      label = `Création dans ${Math.max(0, Math.ceil((scheduledCreation.until - Date.now()) / 1000))} s…`; className = 'is-active';
    } else if (item.transferState === 'transferring') { label = 'Création'; className = 'is-active'; }
    else if (item.transferState === 'transferred') { label = 'Créée et vérifiée'; className = 'is-done'; }
    else if (item.transferState === 'transfer_error') { label = 'Erreur'; className = 'is-error'; }
    else if (item.selected && batch?.targetProfile && ['target-ready', 'transfer-error'].includes(batch?.status)) { label = 'À créer'; className = 'is-queued'; }
    if (!className) { cell.textContent = label; return cell; }
    badge.className = `transfer-state ${className}`; badge.textContent = label; cell.append(badge); creationBadges.set(item.key, badge); return cell;
  }
  const selectedItems = () => items.filter(item => item.selected);
  const itemSource = item => item.source || item.summary || {};
  const itemPrice = item => Number(itemSource(item).price_numeric ?? itemSource(item).price?.amount ?? itemSource(item).price ?? 0);
  const itemBrand = item => String(itemSource(item).brand_title || itemSource(item).brand?.title || itemSource(item).brand || '').trim();
  const itemDate = item => {
    const raw = item.source?.created_at || item.source?.created_at_ts || item.summary?.created_at || item.summary?.created_at_ts || '';
    if (!raw) return 0;
    const numeric = Number(raw);
    const value = Number.isFinite(numeric) ? (numeric < 100000000000 ? numeric * 1000 : numeric) : Date.parse(raw);
    return Number.isFinite(value) ? value : 0;
  };
  const itemPhotoCount = item => item.blobs?.length || Number(itemSource(item).photo_count || itemSource(item).photos_count || itemSource(item).photos?.length || 0);
  const itemPhotoLabel = item => !item.blobs?.length && itemSource(item).photo_count_estimated ? `${itemPhotoCount(item)}+` : String(itemPhotoCount(item));
  function visibleItem(item) {
    const source = itemSource(item);
    if (titleFilter && !String(source.title || '').toLocaleLowerCase('fr').includes(titleFilter)) return false;
    if (itemPrice(item) < priceMin || itemPrice(item) > priceMax) return false;
    const brand = itemBrand(item);
    if (brandFilterInitialized && !(brandFilters.has(brand) || (!brand && brandFilters.has('__other__')))) return false;
    const added = itemDate(item);
    if (dateAfter && (!added || added < new Date(`${dateAfter}T00:00:00`).getTime())) return false;
    if (dateBefore && (!added || added > new Date(`${dateBefore}T23:59:59.999`).getTime())) return false;
    return true;
  }
  function compareItems(a, b) {
    const values = {
      title: item => String(itemSource(item).title || ''),
      price: itemPrice,
      brand: item => itemBrand(item) || 'Autres',
      date: itemDate,
    };
    const getter = values[sortKey] || values.date;
    const left = getter(a); const right = getter(b);
    const compared = typeof left === 'number' ? left - right : String(left).localeCompare(String(right), 'fr', { sensitivity: 'base' });
    return (sortDirection === 'asc' ? 1 : -1) * compared || a.position - b.position;
  }
  function formatDate(item) {
    const value = itemDate(item); return value ? new Intl.DateTimeFormat('fr-FR').format(value) : 'Inconnue';
  }
  function paintAccount(prefix, profile, empty) {
    $(`#${prefix}-avatar`).src = profile?.avatarUrl || FALLBACK_AVATAR;
    $(`#${prefix}-name`).textContent = profile?.name || empty;
    $(`#${prefix}-id`).textContent = profile?.id ? `Compte ${profile.id}` : (prefix === 'source' ? 'Compte source' : 'Compte cible');
  }
  const batchMatchesLaunchSource = value =>
    value?.sourceOrigin === launchSource.origin && String(value?.sourceProfile?.id || '') === launchSource.accountId;
  function phase() {
    if (!batch) return 'empty';
    const selected = selectedItems();
    if (batch.status === 'selecting') return 'selecting';
    if (selected.length && selected.every(item => item.transferState === 'transferred')) return 'complete';
    if (batch.targetProfile) return 'target';
    if (selected.length && selected.every(item => item.deleteState === 'deleted')) return batch.logoutCleanedAt ? 'awaiting-target' : 'deleted';
    if (selected.some(item => item.deleteState === 'deleted' || item.deleteState === 'delete_error')) return 'partial-delete';
    if (selected.length && selected.every(item => item.captureState === 'ready')) return 'ready';
    return 'capturing';
  }
  function render() {
    paintAccount('source', batch?.sourceProfile, 'À détecter');
    paintAccount('target', batch?.targetProfile, 'À connecter');
    const sourceStats = $('#source-stats'); const sourceCount = $('#source-count');
    const listingCount = Number(batch?.sourceListingCount ?? (batch?.sourceProfile ? items.length : NaN));
    sourceCount.hidden = !batch?.sourceProfile || !Number.isFinite(listingCount);
    sourceCount.textContent = Number.isFinite(listingCount) ? `${listingCount} annonce${listingCount === 1 ? '' : 's'}` : '';
    const counts = batch?.sourceCounts || {};
    for (const [id, value, singular, plural] of [
      ['source-sold', counts.sold, 'vendue', 'vendues'],
      ['source-draft', counts.draft, 'brouillon', 'brouillons'],
      ['source-pending', counts.pending, 'en attente', 'en attente'],
    ]) {
      const line = $(`#${id}`); const number = Number(value || 0); line.hidden = number <= 0;
      line.textContent = number > 0 ? `${number} ${number === 1 ? singular : plural}` : '';
    }
    sourceStats.hidden = ![counts.sold, counts.draft, counts.pending].some(value => Number(value || 0) > 0);
    for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls.clear(); deletionBadges.clear(); creationBadges.clear();
    const body = $('#transfer-body'); body.replaceChildren();
    const visible = items.filter(visibleItem).sort(compareItems);
    body.closest('.table-scroll').classList.toggle('is-empty', !visible.length);
    const selectAll = $('#select-all'); const visibleKeys = visible.map(item => item.key);
    selectAll.disabled = busy || phase() !== 'selecting' || !visible.length;
    selectAll.checked = !!visible.length && visible.every(item => item.selected) && selectedItems().length === visibleKeys.length;
    selectAll.indeterminate = !selectAll.checked && selectedItems().length > 0;
    if (!visible.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 8;
      if (captureListingBusy) {
        cell.className = 'capture-loading-cell';
        const loading = document.createElement('div'); loading.className = 'capture-loading';
        const icon = document.createElement('span'); icon.className = 'capture-loading-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '↻';
        const text = document.createElement('span'); text.textContent = 'Capture des annonces';
        loading.append(icon, text); cell.append(loading);
      } else {
        cell.className = 'muted'; cell.textContent = 'Aucune annonce sauvegardée.';
      }
      row.append(cell); body.append(row);
    } else for (const item of visible) {
      const row = document.createElement('tr');
      row.classList.toggle('is-selected', !!item.selected);
      const listing = document.createElement('td'); listing.className = 'transfer-listing';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = !!item.selected;
      checkbox.disabled = busy || phase() !== 'selecting';
      checkbox.setAttribute('aria-label', `Sélectionner ${itemSource(item).title || item.itemId}`);
      checkbox.onchange = async () => {
        await saveItem(item, { selected: checkbox.checked }); status(`${selectedItems().length} annonce(s) sélectionnée(s).`);
      };
      const image = document.createElement('img'); image.alt = '';
      if (item.blobs?.[0]) { image.src = URL.createObjectURL(item.blobs[0]); objectUrls.add(image.src); } else image.src = item.summary?.preview_url || '';
      const title = document.createElement('span'); title.textContent = item.source?.title || item.summary?.title || `Annonce ${item.itemId}`; listing.append(image, title);
      listing.prepend(checkbox);
      const values = [listing, money(itemSource(item)), itemBrand(item) || 'Autres', formatDate(item), itemPhotoLabel(item), localStateCell(item), deleteStateCell(item), transferStateCell(item)];
      for (const value of values) { if (value instanceof Node) row.append(value); else { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } }
      body.append(row);
    }
    const current = phase();
    $('#capture').textContent = current === 'empty' ? '1. Sauvegarder le compte A' : current === 'selecting' ? `1. Sauvegarder la sélection (${selectedItems().length})` : '1. Sauvegarder le compte A';
    $('#capture').disabled = busy || !['empty', 'selecting', 'capturing'].includes(current) || (current === 'selecting' && !selectedItems().length);
    $('#delete-source').textContent = deletionRunning
      ? (deleteCancellationRequested ? '❌ Annulation…' : '❌ Annuler la suppression')
      : (current === 'partial-delete' ? '2. Reprendre la suppression de A' : '2. Supprimer du compte A');
    $('#delete-source').disabled = deletionRunning ? deleteCancellationRequested : busy || !['ready', 'partial-delete'].includes(current);
    $('#detect-target').disabled = busy || !['deleted', 'awaiting-target'].includes(current);
    $('#transfer').disabled = busy || current !== 'target';
    document.querySelectorAll('[data-sort]').forEach(button => {
      button.textContent = button.dataset.sort === sortKey ? (sortDirection === 'asc' ? '↑' : '↓') : '↕';
      button.setAttribute('aria-pressed', String(button.dataset.sort === sortKey));
    });
  }
  async function saveBatch(values) {
    batch = { ...batch, ...values, id: batch?.id || crypto.randomUUID(), createdAt: batch?.createdAt || Date.now() };
    await TransferStore.putBatch(batch); batch = await TransferStore.getBatch(batch.id);
  }
  async function saveItem(item, values) {
    const saved = await TransferStore.putItem({ ...item, ...values });
    items = items.map(value => value.key === saved.key ? saved : value); render(); return saved;
  }
  async function loadLatest() {
    const batches = await TransferStore.batches();
    batch = batches.filter(batchMatchesLaunchSource).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    items = batch ? await TransferStore.items(batch.id) : [];
    items.sort((a, b) => a.position - b.position); configureFilters(); render();
  }
  function resetBatchDraft() {
    batch = null; items = []; titleFilter = ''; brandFilters = new Set(); brandFilterInitialized = false; knownBrands = new Set(); priceMin = 0; priceMax = Infinity; priceCeiling = Infinity; dateAfter = ''; dateBefore = ''; sortKey = 'date'; sortDirection = 'desc';
    $('#title-filter').value = ''; $('#date-after').value = ''; $('#date-before').value = '';
  }
  function clearAutoCaptureFlag() {
    const params = new URLSearchParams(location.search);
    params.delete('autoCapture');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  }
  function configureFilters() {
    const maximum = items.reduce((value, item) => Math.max(value, itemPrice(item)), 0);
    const min = $('#price-min'); const max = $('#price-max');
    min.max = String(maximum); max.max = String(maximum);
    if (!Number.isFinite(priceMax) || priceMax > maximum || priceMax === priceCeiling) priceMax = maximum;
    priceCeiling = maximum;
    priceMin = Math.min(priceMin, maximum);
    min.value = String(priceMin); max.value = String(priceMax);
    const brands = ['__other__', ...[...new Set(items.map(itemBrand).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'))];
    if (!brandFilterInitialized) brandFilters = new Set(brands);
    else for (const value of brands) if (!knownBrands.has(value)) brandFilters.add(value);
    brandFilters = new Set([...brandFilters].filter(value => brands.includes(value)));
    knownBrands = new Set(brands); brandFilterInitialized = true;
    const brandList = $('#brand-filter'); brandList.replaceChildren();
    for (const value of brands) {
      const row = document.createElement('div'); row.className = 'brand-filter-row';
      const label = document.createElement('label');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = value; checkbox.checked = brandFilters.has(value);
      const name = document.createElement('span'); name.textContent = value === '__other__' ? 'Autres' : value;
      checkbox.onchange = () => { if (checkbox.checked) brandFilters.add(value); else brandFilters.delete(value); render(); };
      const only = document.createElement('button'); only.type = 'button'; only.className = 'filter-text-action'; only.textContent = 'Uniquement';
      only.onclick = () => { brandFilters = new Set([value]); brandList.querySelectorAll('input').forEach(input => { input.checked = input.value === value; }); render(); };
      label.append(checkbox, name); row.append(label, only); brandList.append(row);
    }
    updatePriceLabel();
  }
  function updatePriceLabel() {
    $('#price-filter-label').textContent = `${priceMin.toLocaleString('fr-FR')} € – ${priceMax.toLocaleString('fr-FR')} €`;
  }
  async function syncSource() {
    if (!batch || phase() !== 'selecting') throw new Error('La synchronisation est disponible avant la capture des annonces.');
    busy = true; render();
    try {
      status('Synchronisation du dressing du compte A…');
      const result = await command('list');
      if (result.origin !== batch.sourceOrigin || result.profile.id !== batch.sourceProfile.id) throw new Error('Le compte connecté ne correspond pas au compte A de ce lot.');
      const previous = new Map(items.map(item => [String(item.itemId), item]));
      const next = [];
      for (const [position, summary] of result.items.entries()) {
        const itemId = String(summary.id);
        const existing = previous.get(itemId);
        const saved = await TransferStore.putItem(existing
          ? { ...existing, position, summary }
          : { key: `${batch.id}:${itemId}`, batchId: batch.id, itemId, position, summary, selected: false, blobs: [], captureState: 'queued', deleteState: null, transferState: null });
        next.push(saved); previous.delete(itemId);
      }
      for (const stale of previous.values()) await TransferStore.removeItem(stale.key);
      items = next;
      await saveBatch({ sourceProfile: result.profile, sourceListingCount: result.items.length, sourceCounts: result.counts, syncedAt: Date.now() });
      configureFilters(); render();
      status(`${items.length} annonce(s) synchronisée(s). Les modifications du compte A sont à jour.`);
    } finally { busy = false; render(); }
  }
  async function capture() {
    const firstCapture = !batch;
    busy = true; captureListingBusy = firstCapture; render();
    try {
      if (!batch) {
        status('Chargement du dressing du compte A…');
        const result = await command('list', { origin: launchSource.origin });
        if (String(result.profile.id) !== launchSource.accountId) throw new Error('La session Vinted ne correspond plus au dressing du compte A.');
        if (!result.items.length) throw new Error('Aucune annonce active trouvée sur le compte connecté.');
        await saveBatch({ sourceOrigin: result.origin, sourceProfile: result.profile, sourceListingCount: result.items.length, sourceCounts: result.counts, status: 'selecting' });
        for (const [position, summary] of result.items.entries()) {
          const item = await TransferStore.putItem({ key: `${batch.id}:${summary.id}`, batchId: batch.id, itemId: String(summary.id), position, summary, selected: false, blobs: [], captureState: 'queued', deleteState: null, transferState: null });
          items.push(item);
        }
        titleFilter = ''; brandFilters = new Set(); brandFilterInitialized = false; knownBrands = new Set(); priceMin = 0; priceMax = Infinity; priceCeiling = Infinity; dateAfter = ''; dateBefore = '';
        configureFilters(); render();
        status(`${items.length} annonce(s) chargée(s). Utilisez les filtres puis sélectionnez les annonces à transférer.`);
        return;
      }
      const selected = selectedItems();
      if (!selected.length) throw new Error('Sélectionnez au moins une annonce.');
      const result = await command('profile');
      if (batch.sourceProfile?.id !== result.profile.id) throw new Error('Ce lot appartient à un autre compte source.');
      await saveBatch({ status: 'capturing' });
      for (let index = 0; index < selected.length; index++) {
        let item = selected[index]; if (item.captureState === 'ready') continue;
        status(`Capture ${index + 1}/${selected.length} : ${item.summary.title}`);
        item = await saveItem(item, { captureState: 'capturing', error: null });
        try {
          const captured = await command('capture', { origin: batch.sourceOrigin, accountId: batch.sourceProfile.id, itemId: item.itemId });
          await saveItem(item, { source: captured.source, blobs: captured.blobs, captureState: 'ready', error: null });
        } catch (error) { await saveItem(item, { captureState: 'capture_error', error: error.message }); await showTransferError(error, 'capture', item); }
      }
      const complete = selectedItems().every(item => item.captureState === 'ready');
      await saveBatch({ status: complete ? 'ready' : 'capture-error' });
      status(complete ? `${selected.length} annonce(s) sauvegardée(s) et vérifiée(s) localement.` : 'Certaines annonces n’ont pas pu être capturées.', !complete);
    } finally { captureListingBusy = false; busy = false; render(); }
  }
  function formatDuration(totalMinutes) {
    if (totalMinutes < 1) return 'moins d’une minute';
    const rounded = Math.ceil(totalMinutes); const hours = Math.floor(rounded / 60); const minutes = rounded % 60;
    return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : ''].filter(Boolean).join(' ');
  }
  async function confirmDeletion() {
    return new Promise(resolve => {
      const dialog = $('#delete-transfer-dialog');
      const name = batch?.sourceProfile?.name || 'le compte source';
      const count = selectedItems().filter(item => item.deleteState !== 'deleted').length;
      $('#delete-transfer-title').textContent = 'Suppression irréversible sur compte A';
      $('#delete-transfer-copy').textContent = `${selectedItems().length} annonce(s) seront supprimée(s) du compte ${name}. Les copies locales ont été vérifiées, mais cette action est irréversible sur Vinted.`;
      const duration = $('#delete-transfer-duration');
      duration.textContent = `Durée estimée : ${formatDuration(Math.max(0, count - 1) * 1.5)} avec un délai aléatoire de 1 à 2 minutes entre chaque suppression.`;
      $('#delete-transfer-confirm').textContent = 'Supprimer sur compte A';
      $('#delete-transfer-cancel').onclick = () => { dialog.close(); resolve(false); };
      $('#delete-transfer-confirm').onclick = () => { dialog.close(); resolve(true); };
      dialog.oncancel = () => resolve(false); dialog.showModal();
    });
  }
  async function deleteSource() {
    if (!(await confirmDeletion())) return;
    deleteCancellationRequested = false; deletionRunning = true; busy = true; render();
    try {
      const selected = selectedItems();
      await saveBatch({ status: 'deleting-source' }); render();
      for (let index = 0; index < selected.length; index++) {
        if (deleteCancellationRequested) break;
        let item = selected[index]; if (item.deleteState === 'deleted') continue;
        status(`Suppression vérifiée ${index + 1}/${selected.length} : ${item.source.title}`);
        item = await saveItem(item, { deleteState: 'deleting', error: null });
        try {
          await command('delete', { origin: batch.sourceOrigin, accountId: batch.sourceProfile.id, itemId: item.itemId });
          await saveItem(item, { deleteState: 'deleted' });
          const nextDeletion = selected.slice(index + 1).find(value => value.deleteState !== 'deleted');
          const continued = await transferCooldown('Prochaine suppression', index + 1, selected.length, nextDeletion, 'delete');
          if (continued === false) break;
        }
        catch (error) { await saveItem(item, { deleteState: 'delete_error', error: error.message }); await showTransferError(error, 'suppression', item); break; }
      }
      const complete = selectedItems().every(item => item.deleteState === 'deleted');
      await saveBatch({ status: complete ? 'deleted-source' : deleteCancellationRequested ? 'delete-paused' : 'delete-error' });
      status(complete ? 'Toutes les annonces ont disparu du compte A. Vous pouvez nettoyer la session A puis détecter le compte B.' : deleteCancellationRequested ? 'Suppression mise en pause. Vous pourrez la reprendre avec le même bouton.' : 'La suppression a été interrompue. Aucune création sur B n’est autorisée.', !complete && !deleteCancellationRequested);
    } finally { scheduledDeletion = null; deletionRunning = false; busy = false; render(); }
  }
  async function detectTarget() {
    busy = true; render();
    try {
      let cleanedNow = false;
      if (!batch.logoutCleanedAt) {
        await command('clean-logout', { origin: batch.sourceOrigin });
        await saveBatch({ logoutCleanedAt: Date.now(), status: 'awaiting-target' });
        status('Session A et données du site Vinted effacées. Connectez-vous au compte B puis ouvrez une page Vinted connectée.');
        cleanedNow = true;
      }
      if (cleanedNow) return;
      const result = await command('list', { origin: batch.sourceOrigin });
      if (result.origin !== batch.sourceOrigin) throw new Error('Le transfert doit rester sur le même domaine Vinted.');
      if (result.profile.id === batch.sourceProfile.id) throw new Error('Le compte B doit être différent du compte A.');
      await saveBatch({ targetProfile: result.profile, targetOrigin: result.origin, targetListingCount: result.items.length, targetCounts: result.counts, status: 'target-ready' });
      status(`Compte B confirmé : ${result.profile.name}.`);
    } finally { busy = false; render(); }
  }
  async function confirmTransfer() {
    const response = await chrome.runtime.sendMessage({ type: 'republish:control', action: 'state' }).catch(() => null);
    const delayMinutes = Number(response?.value?.settings?.itemDelay || 5);
    const count = selectedItems().filter(item => item.transferState !== 'transferred').length;
    return new Promise(resolve => {
      const dialog = $('#create-transfer-dialog');
      const duration = $('#create-transfer-duration'); const settingsLink = document.createElement('a');
      settingsLink.href = 'options.html'; settingsLink.textContent = `${delayMinutes} minute${delayMinutes === 1 ? '' : 's'}`;
      $('#create-transfer-title').textContent = 'Création sur compte B';
      $('#create-transfer-copy').textContent = `${count} annonce(s) seront créée(s) sur le compte B. Chaque création sera vérifiée avant de passer à l’annonce suivante.`;
      duration.replaceChildren(`Durée estimée : ${formatDuration(Math.max(0, count - 1) * delayMinutes)} avec un délai moyen de `, settingsLink, ' entre chaque création.');
      $('#create-transfer-cancel').onclick = () => { dialog.close(); resolve(false); };
      $('#create-transfer-confirm').onclick = () => { dialog.close(); resolve(true); };
      dialog.oncancel = () => resolve(false); dialog.showModal();
    });
  }
  async function transfer() {
    if (!(await confirmTransfer())) return;
    busy = true; render();
    try {
      const selected = selectedItems();
      for (let index = 0; index < selected.length; index++) {
        let item = selected[index]; if (item.transferState === 'transferred') continue;
        if (item.deleteState !== 'deleted') throw new Error('Une annonce n’a pas été supprimée et vérifiée sur A.');
        status(`Création ${index + 1}/${selected.length} : ${item.source.title}`);
        item = await saveItem(item, { transferState: 'transferring', error: null });
        try {
          const result = await command('create', { origin: batch.targetOrigin, accountId: batch.targetProfile.id, source: item.source, blobs: item.blobs });
          await saveItem(item, { transferState: 'transferred', newItemId: result.newItemId });
          const nextCreation = selected.slice(index + 1).find(value => value.transferState !== 'transferred');
          await transferCooldown('Prochaine création', index + 1, selected.length, nextCreation, 'create');
        } catch (error) { await saveItem(item, { transferState: 'transfer_error', error: error.message }); await showTransferError(error, 'création', item); break; }
      }
      const complete = selectedItems().every(item => item.transferState === 'transferred'); await saveBatch({ status: complete ? 'complete' : 'transfer-error' });
      status(complete ? 'Transfert terminé et vérifié sur le compte B. Les sauvegardes locales sont conservées.' : 'Le transfert est interrompu. Les sauvegardes locales restent disponibles.', !complete);
    } finally { scheduledCreation = null; busy = false; render(); }
  }

  $('#capture').onclick = () => capture().catch(error => showTransferError(error, 'capture'));
  $('#delete-source').onclick = () => {
    if (deletionRunning) { deleteCancellationRequested = true; status('Annulation demandée…'); render(); return; }
    deleteSource().catch(error => showTransferError(error, 'suppression'));
  };
  $('#detect-target').onclick = () => detectTarget().catch(error => showTransferError(error, 'détection du compte B'));
  $('#transfer').onclick = () => transfer().catch(error => showTransferError(error, 'création'));
  $('#transfer-error-close').onclick = () => { $('#transfer-error-toast').hidden = true; };
  $('#send-transfer-report').onclick = () => {
    if (!activeReportTimestamp) return;
    const button = $('#send-transfer-report'); const reportStatus = $('#transfer-report-status');
    const sending = window.__VintedRelister.reporting.sendFromGesture(activeReportTimestamp);
    button.disabled = true; reportStatus.textContent = 'Envoi…';
    sending.then(() => { button.textContent = 'Rapport envoyé'; reportStatus.textContent = 'Merci, le rapport a été transmis.'; })
      .catch(error => { const labels = { permission: 'Autorisation refusée.', limited: 'Trop de rapports envoyés.', capacity: 'Historique des rapports plein.' }; reportStatus.textContent = labels[error.code] || 'Échec de l’envoi. Réessayez.'; button.disabled = false; });
  };
  document.querySelectorAll('[data-filter-toggle]').forEach(button => {
    button.onclick = event => {
      event.stopPropagation();
      const panel = document.querySelector(`[data-filter-panel="${button.dataset.filterToggle}"]`);
      document.querySelectorAll('[data-filter-panel]').forEach(value => { if (value !== panel) value.hidden = true; });
      panel.hidden = !panel.hidden;
    };
  });
  document.addEventListener('click', event => { if (!event.target.closest('.column-filter') && !event.target.closest('.table-filter-toggle')) document.querySelectorAll('[data-filter-panel]').forEach(panel => { panel.hidden = true; }); });
  document.querySelectorAll('.column-filter').forEach(panel => panel.onclick = event => event.stopPropagation());
  $('#title-filter').oninput = event => { titleFilter = event.target.value.trim().toLocaleLowerCase('fr'); render(); };
  $('#brand-all').onclick = () => { brandFilters = new Set(knownBrands); $('#brand-filter').querySelectorAll('input').forEach(input => { input.checked = true; }); render(); };
  $('#price-min').oninput = event => { const value = event.target.valueAsNumber; priceMin = Number.isFinite(value) ? Math.max(0, Math.min(value, priceMax)) : 0; updatePriceLabel(); render(); };
  $('#price-max').oninput = event => { const value = event.target.valueAsNumber; priceMax = Number.isFinite(value) ? Math.min(priceCeiling, Math.max(value, priceMin)) : priceCeiling; updatePriceLabel(); render(); };
  $('#date-after').onchange = event => { dateAfter = event.target.value; render(); };
  $('#date-before').onchange = event => { dateBefore = event.target.value; render(); };
  $('#select-all').onchange = async event => {
    if (phase() !== 'selecting') return;
    const checked = event.target.checked;
    const chosen = new Set(checked ? items.filter(visibleItem).sort(compareItems).map(item => item.key) : []);
    busy = true;
    try {
      for (let index = 0; index < items.length; index++) {
        const desired = chosen.has(items[index].key);
        if (!!items[index].selected === desired) continue;
        items[index] = await TransferStore.putItem({ ...items[index], selected: desired });
      }
      status(checked ? `${chosen.size} annonce(s) sélectionnée(s), selon les filtres et le tri actuels.` : 'Toutes les annonces sont désélectionnées.');
    } finally { busy = false; render(); }
  };
  document.querySelectorAll('[data-sort]').forEach(button => {
    button.onclick = () => {
      if (sortKey === button.dataset.sort) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      else { sortKey = button.dataset.sort; sortDirection = sortKey === 'date' ? 'desc' : 'asc'; }
      render();
    };
  });
  await loadLatest();
  if (autoCapture) {
    clearAutoCaptureFlag();
    resetBatchDraft(); configureFilters(); render();
    await capture();
  }
})().catch(error => { document.querySelector('#transfer-status').textContent = error.message; document.querySelector('#transfer-status').classList.add('error-text'); });
