(function () {
  'use strict';
  const NS = window.__VintedRelister;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fail = (code, status, diagnostic) => Object.assign(new Error(code), { code, status, ...(diagnostic ? { diagnostic } : {}) });
  function enrich(error, diagnostic) {
    if (error && typeof error === 'object') {
      if (!error.diagnostic) error.diagnostic = diagnostic;
      return error;
    }
    return fail('unknown', null, diagnostic);
  }
  const eligible = item => item && !['is_reserved', 'is_closed', 'is_draft', 'is_processing', 'is_hidden'].some(k => item[k]);
  const keyFor = (account, itemId) => `${location.origin}|${account}|${itemId}`;
  const sourceAccountFor = job => String(job.sourceAccountId || job.accountId);
  const targetAccountFor = job => String(job.targetAccountId || job.accountId);
  const sourceOriginFor = job => job.sourceOrigin || job.origin;
  const targetOriginFor = job => job.targetOrigin || job.origin;
  const httpFailureCode = (path, status, body) => status === 429 ? 'rate-limit'
    : status === 401 ? 'auth'
      : status === 403 && /captcha-delivery|__cf_chl|cf_chl|datadome/i.test(body || '') ? 'anti-bot'
        : status === 403 && (path === '/api/v2/users/current' || /restrict|suspend|blocked|banned/i.test(body || '')) ? 'account-restricted'
          : status === 403 ? 'auth' : status >= 500 ? 'http-server' : 'http';
  function requireSameAccountRelist(job) {
    if ((job.mode && job.mode !== 'relist') || sourceAccountFor(job) !== targetAccountFor(job) ||
        sourceOriginFor(job) !== targetOriginFor(job)) throw fail('transfer-not-enabled');
  }
  async function jsonGet(path) {
    const csrf = await NS.getCsrf();
    const response = await NS.network(location.origin + path, { credentials: 'include', headers: { 'x-csrf-token': csrf, accept: 'application/json' } });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw fail(httpFailureCode(path, response.status, body), response.status);
    }
    return response.json();
  }
  async function accountId() {
    const json = await jsonGet('/api/v2/users/current');
    const id = json.user?.id || json.id;
    if (!/^\d+$/.test(String(id))) throw fail('account');
    return String(id);
  }
  async function original(id) {
    try { return await NS.getItemDetails(id); } catch (e) { if (e.code === 'missing') return null; throw e; }
  }
  // Canonical business fields only: server-generated timestamps do not describe edits.
  function comparable(item) {
    const result = { ...item };
    for (const key of ['id', 'temp_uuid', 'assigned_photos']) delete result[key];
    result.item_attributes = (result.item_attributes || []).filter(a => !['size', 'condition'].includes(a.code)).map(a => ({ code: a.code, ids: [...(a.ids || [])].sort() })).sort((a, b) => a.code.localeCompare(b.code));
    result.color_ids = [...(result.color_ids || [])].sort();
    return result;
  }
  function sameBusiness(a, b) { return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b)); }
  async function validateSource(source) {
    if (!eligible(source)) throw fail('ineligible');
    const item = NS.buildPayload(source, '', []).item;
    if (!item.title.trim() || !item.catalog_id || !item.status_id || !(item.price > 0)) throw fail('incomplete');
    if (item.size_id) {
      const result = await jsonGet(`/api/v2/item_upload/size_groups?catalog_ids[]=${encodeURIComponent(item.catalog_id)}`);
      const groups = result.size_groups || [];
      const ids = groups.flatMap(g => [...(g.sizes || []).map(s => String(s.id)), ...(g.size_ids || []).map(String)]);
      if (ids.length && !ids.includes(String(item.size_id))) throw fail('stale-size-id');
    }
  }
  function photoShape(photo, ref) {
    const p = photo && typeof photo === 'object' ? photo : {};
    const result = { ref: ref || null, id: Boolean(p.id), orientation: Number.isFinite(Number(p.orientation)) ? Number(p.orientation) : undefined };
    for (const key of ['width', 'height', 'position']) if (Number.isFinite(Number(p[key]))) result[key] = Number(p[key]);
    if (p.photo && typeof p.photo === 'object') result.nestedId = Boolean(p.photo.id);
    return result;
  }
  function photoMetadataMatches(uploaded, created) {
    if (!Array.isArray(uploaded) || !Array.isArray(created) || uploaded.length !== created.length) return false;
    const fields = ['width', 'height', 'orientation'];
    const usable = fields.filter(field => uploaded.some(p => Number.isFinite(Number(p?.[field]))) && created.some(p => Number.isFinite(Number(p?.[field]))));
    if (!usable.includes('width') || !usable.includes('height')) return false;
    const signature = list => list.map(p => usable.map(field => Number.isFinite(Number(p?.[field])) ? Number(p[field]) : null).join(':')).sort().join('|');
    return signature(uploaded) === signature(created);
  }
  async function verify(job, csrf, trace) {
    const counts = {
      sourcePhotoCount: job.source?.photos?.length || 0,
      backupPhotoCount: job.blobs?.length || 0,
      uploadedPhotoCount: job.uploaded?.length || 0,
      stage: job.stage,
    };
    if (!/^\d+$/.test(String(job.newItemId || '')) || String(job.newItemId) === String(job.itemId)) throw fail('unconfirmed', null, { phase: 'verify', check: 'new-item-id', ...counts });
    if (!job.complete || !job.blobs?.length) throw fail('photos', null, { phase: 'verify', check: 'local-photo-backup', ...counts });
    if (job.uploaded?.length !== job.blobs.length) throw fail('photos', null, { phase: 'verify', check: 'uploaded-photo-count', ...counts });
    if (job.source.photos?.length !== job.blobs.length) throw fail('photos', null, { phase: 'verify', check: 'source-backup-photo-count', ...counts });
    if (!job.expected?.item || !sameBusiness(NS.buildPayload(job.source, '', []).item, job.expected.item)) throw fail('integrity');
    const result = await NS.verifyCreatedItem(csrf, job.newItemId);
    trace && trace.event('verify-response', { ok: Boolean(result?.ok), photoCount: Array.isArray(result?.item?.photos) ? result.item.photos.length : 0 });
    if (!result.ok) throw fail(result.reason || 'unconfirmed', null, { phase: 'verify', check: 'created-item-response', ...counts });
    const fresh = result.item;
    if (!eligible(fresh)) throw fail('unconfirmed');
    const owner = fresh.user_id || fresh.user?.id;
    if (owner && String(owner) !== targetAccountFor(job)) throw fail('account');
    if (!sameBusiness(NS.buildPayload(fresh, '', []).item, job.expected.item)) throw fail('integrity');
    const photos = fresh.photos || [];
    if (trace) trace.photos.verify = photos.slice(0, 12).map(p => photoShape(p, trace.ref(p.id)));
    const ids = new Set(photos.map(p => String(p.id)));
    if (photos.length !== job.uploaded.length) throw fail('photos', null, {
      phase: 'verify', check: 'created-photo-count', ...counts, createdPhotoCount: photos.length
    });
    if (job.uploaded.some(p => !ids.has(String(p.id)))) {
      const metadataMatch = photoMetadataMatches(trace?.photos.uploads, trace?.photos.verify);
      if (metadataMatch) trace.event('photo-identity-remapped', { count: photos.length, check: 'metadata' });
      else throw fail('photos', null, {
        phase: 'verify', check: 'created-photo-identity', ...counts, createdPhotoCount: photos.length
      });
    }
    return fresh;
  }
  async function reconcileCreated(job) {
    const expected = new Set((job.uploaded || []).map(p => String(p.id)));
    if (!expected.size) throw fail('uncertain');
    const matches = [];
    for (let page = 1; page <= 100; page++) {
      const result = await NS.fetchWardrobePage(targetAccountFor(job), page, true);
      if (!result || !Array.isArray(result.items)) throw fail('uncertain');
      for (const item of result.items) {
        if (String(item.id) === job.itemId) continue;
        const ids = (item.photos || []).map(p => String(p.id));
        if (item.title === job.source.title && ids.length === expected.size && ids.every(id => expected.has(id))) matches.push(item.id);
      }
      if (page >= (result.pagination?.total_pages || 1)) break;
    }
    if (matches.length !== 1) throw fail('uncertain');
    return String(matches[0]);
  }
  NS.seedJobs = (account, items) => NS.control('seed', { accountId: account, items });
  NS.republish = async function (itemId, account, onPhase = () => {}, cancelled = () => false) {
    const key = keyFor(account, itemId);
    let job;
    let heartbeat;
    let held = false;
    let relistValidated = false;
    let rollbackAttempted = false;
    const refs = new Map();
    const trace = {
      attempt: [], photos: { backup: { count: 0 }, uploads: [], create: [], verify: [] },
      ref(value) { const raw = String(value ?? ''); if (!raw) return null; if (!refs.has(raw)) refs.set(raw, `photo-${refs.size + 1}`); return refs.get(raw); },
      event(stage, values = {}) { if (this.attempt.length < 24) this.attempt.push({ stage, at: new Date().toISOString(), ...values }); },
      snapshot() { return { version: 1, attempt: this.attempt.slice(-24), photos: this.photos }; }
    };
    const previousTrace = () => job?.diagnosticTrace && typeof job.diagnosticTrace === 'object' ? job.diagnosticTrace : null;
    const phase = (name, seconds) => onPhase(name, seconds);
    async function patch(values) {
      if (!Object.prototype.hasOwnProperty.call(values, 'diagnosticTrace')) values = { ...values, diagnosticTrace: trace.snapshot() };
      await NS.control('patch', { key, values });
      job = { ...job, ...values };
    }
    async function rollbackCopy(cause) {
      rollbackAttempted = true;
      const rollbackCause = job.rollbackCause || { code: cause.code || 'unconfirmed', diagnostic: cause.diagnostic || null };
      try {
        // Persist the decision before any DELETE. Resumes must finish cleanup,
        // never verify-and-delete the original or create another copy instead.
        if (job.stage === 'created') await patch({ stage: 'rollback-requested', rollbackCause, status: 'running' });
        else if (job.stage === 'rollback-requested') await patch({ status: 'running' });
        if (job.stage !== 'rollback-requested') throw fail('unsafe-cleanup');
      phase('cleanup');
        trace.event('cleanup-start', { cause: String(cause.code || 'unknown') });
        const copyId = String(job.newItemId || '');
        if (!/^\d+$/.test(copyId) || copyId === String(job.itemId)) throw fail('unsafe-cleanup');
        if (!job.complete || !job.blobs?.length) throw fail('backup-missing');
        if (await accountId() !== sourceAccountFor(job)) throw fail('account');
        const current = await original(job.itemId);
        if (!current || String(current.id) !== String(job.itemId)) throw fail('original-missing');
        const owner = current.user_id || current.user?.id;
        if (owner && String(owner) !== sourceAccountFor(job)) throw fail('account');
        const copy = await original(copyId);
        if (copy) {
          if (String(copy.id) !== copyId) throw fail('unsafe-cleanup');
          const copyOwner = copy.user_id || copy.user?.id;
          if (copyOwner && String(copyOwner) !== targetAccountFor(job)) throw fail('account');
          if (copy.is_sold || copy.is_reserved || copy.is_closed) throw fail('ineligible');
          const csrf = await NS.getCsrf();
          // Revalidate the session just before deleting the recorded new ID.
          if (await accountId() !== sourceAccountFor(job)) throw fail('account');
          let deleteError;
          try { await NS.deleteItem(csrf, copyId); } catch (error) { deleteError = error; }
          // Even a lost response may mean success. Confirm with a read before
          // deciding whether cleanup remains pending; no blind replay here.
          let removed = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt) await sleep(2000);
            if (!await original(copyId)) { removed = true; break; }
            if (deleteError) throw deleteError;
          }
          if (!removed) throw fail('cleanup-unconfirmed');
        }
        trace.event('cleanup-removed');
        await patch({ stage: 'rolled-back', newItemId: null, uploaded: [], expected: null, sessionId: null, rollbackCause: null });
        cause.diagnostic = { ...rollbackCause.diagnostic, cleanupStatus: 'removed' };
        return cause;
      } catch (error) {
        trace.event('cleanup-pending', { reason: String(error.code || 'unknown') });
        return fail('cleanup-pending', error.status, { ...rollbackCause.diagnostic,
          cleanupStatus: 'pending', cleanupReason: error.code || 'unknown', cleanupCheck: error.diagnostic?.check || 'cleanup-copy' });
      }
    }
    async function saveLocalBackup(source) {
      const owner = source.user_id || source.user?.id;
      if (owner && String(owner) !== String(account)) throw fail('account');
      if (!eligible(source)) throw fail('ineligible');
      const urls = NS.pickPhotos(source);
      if (!urls.length || urls.length !== source.photos?.length) throw fail('photos', null, {
        phase: 'backup', check: 'source-photo-urls', sourcePhotoCount: source.photos?.length || 0, backupPhotoCount: 0, stage: job.stage
      });
      const previousUrls = job.complete ? NS.pickPhotos(job.source || {}) : [];
      const canReuse = job.complete && job.blobs?.length === urls.length && JSON.stringify(previousUrls) === JSON.stringify(urls);
      const blobs = canReuse ? job.blobs : [];
      trace.photos.backup = { count: urls.length, reused: Boolean(canReuse) };
      trace.event('backup', { count: urls.length, reused: Boolean(canReuse) });
      phase('backup');
      if (!canReuse) {
        for (const url of urls) {
          if (cancelled()) throw fail('cancelled');
          let blob;
          try { blob = await NS.downloadAsBlob(url, true); }
          catch (error) { throw enrich(error, {
            phase: 'backup', check: 'downloaded-photo-file', sourcePhotoCount: urls.length,
            backupPhotoCount: blobs.length, uploadedPhotoCount: 0, stage: job.stage
          }); }
          if (!blob.size || blob.size > 25 * 1024 * 1024 || !blob.type.startsWith('image/')) throw fail('photos', null, {
            phase: 'backup', check: 'downloaded-photo-file', sourcePhotoCount: urls.length, backupPhotoCount: blobs.length, stage: job.stage
          });
          blobs.push(blob);
        }
      }
      await NS.control('backup', { accountId: account, itemId, source, blobs });
      job = await NS.control('get', { key });
      if (previousTrace()) trace.event('resume', { prior: true });
    }
    try {
      // Refuse early (before taking the lease or touching Vinted) when this
      // item was relisted recently. See coordinator.js itemCooldownUntil.
      await NS.control('item-check', { itemId });
      for (;;) {
        if (cancelled()) throw fail('cancelled');
        const claim = await NS.control('acquire');
        if (claim.lease) { NS.lease = claim.lease; held = true; break; }
        phase('cooldown', Math.ceil(claim.waitMs / 1000));
        await sleep(Math.min(claim.waitMs, 1000));
      }
      heartbeat = setInterval(() => { NS.control('heartbeat').catch(() => {}); }, 20000);
      job = await NS.control('get', { key });
      if (!job) throw fail('backup-missing');
      requireSameAccountRelist(job);
      relistValidated = true;
      if (job?.done) return { ok: true, itemId, newItemId: job.newItemId };
      // Includes failed copies left by versions predating automatic cleanup.
      if (job.stage === 'rollback-requested' || (job.stage === 'created' && job.status === 'error')) {
        const cause = job.rollbackCause || { code: job.error || 'unconfirmed', diagnostic: job.errorDetail };
        throw await rollbackCopy(fail(cause.code, null, cause.diagnostic));
      }
      phase('details');

      // Preserve a complete local recovery copy before an account-level API
      // check can reject a connected but temporarily restricted account.
      if (!job.complete) await saveLocalBackup(await NS.getItemDetailsForBackup(itemId));

      if (await accountId() !== String(account)) throw fail('account');
      if (!job?.complete || ['queued', 'backed-up', 'rolled-back'].includes(job.stage)) {
        const current = await original(itemId);
        if (!current && !job?.complete) throw fail('missing');
        const source = current || job.source;
        await saveLocalBackup(source);
        await validateSource(source);
        const sessionId = NS.uuidv4();
        const uploaded = [];
        const csrf = await NS.getCsrf();
        phase('photos');
        for (const blob of job.blobs) {
          if (cancelled()) throw fail('cancelled');
          let photo;
          try { photo = await NS.uploadPhoto(csrf, blob, sessionId, itemId); }
          catch (error) { throw enrich(error, {
            phase: 'upload', check: 'uploaded-photo-response', sourcePhotoCount: job.source?.photos?.length || 0,
            backupPhotoCount: job.blobs.length, uploadedPhotoCount: uploaded.length, stage: job.stage
          }); }
          trace.event('photo-upload-response', { shape: photo && typeof photo === 'object' ? 'object' : 'missing' });
          if (!photo?.id) throw fail('photos', null, {
            phase: 'upload', check: 'uploaded-photo-id', sourcePhotoCount: job.source?.photos?.length || 0,
            backupPhotoCount: job.blobs.length, uploadedPhotoCount: uploaded.length, stage: job.stage
          });
          trace.photos.uploads.push(photoShape(photo, trace.ref(photo.id)));
          trace.event('photo-upload', { index: trace.photos.uploads.length, hasId: true });
          uploaded.push({ id: photo.id, orientation: photo.orientation || 0 });
        }
        const expected = NS.buildPayload(source, sessionId, uploaded);
        if (await accountId() !== String(account)) throw fail('account');
        await patch({ stage: 'create-requested', status: 'running', sessionId, uploaded, expected, error: null });
        phase('create');
        try {
          const result = await NS.createItem(csrf, expected, itemId);
          if (!result.item?.id || String(result.item.id) === String(itemId)) throw fail('uncertain');
          const createdPhotos = result.item.photos || result.item.assigned_photos || result.photos || [];
          trace.photos.create = Array.isArray(createdPhotos) ? createdPhotos.slice(0, 12).map(p => photoShape(p, trace.ref(p.id || p.photo_id || p.image_id))) : [];
          trace.event('create-response', { hasId: true, photoCount: Array.isArray(createdPhotos) ? createdPhotos.length : 0 });
          await patch({ stage: 'created', newItemId: String(result.item.id) });
        } catch (e) {
          if ([400, 401, 403, 422, 429].includes(e.status) || e.code === 'stale-size-id') await patch({ stage: 'backed-up' });
          throw e;
        }
      } else {
        await patch({ status: 'running', error: null });
        if (job.stage === 'create-requested') await patch({ stage: 'created', newItemId: await reconcileCreated(job) });
      }
      const csrf = await NS.getCsrf();
      phase('verify');
      await verify(job, csrf, trace);
      const current = await original(itemId);
      if (current) {
        if (!eligible(current)) throw fail('ineligible');
        if (!sameBusiness(NS.buildPayload(current, '', []).item, NS.buildPayload(job.source, '', []).item)) throw fail('original-changed');
        const photoSignature = item => JSON.stringify((item.photos || []).map(p => [String(p.id), p.orientation || 0]));
        if (photoSignature(current) !== photoSignature(job.source)) throw fail('original-changed');
        // Recheck the account immediately before the destructive step.
        if (await accountId() !== sourceAccountFor(job)) throw fail('account');
        await patch({ stage: 'delete-requested' });
        phase('delete');
        await NS.deleteItem(csrf, itemId);
        // A successful POST is insufficient if the server still returns the original.
        if (await original(itemId)) throw fail('delete-unconfirmed');
      }
      await patch({ stage: 'deleted' });
      await NS.control('finish', { key });
      job = { ...job, stage: 'verified', done: true, status: 'waiting', error: null };
      // A successful operation no longer occupies the recovery queue: the
      // complete local backup is removed only after the final verification.
      return { ok: true, itemId, newItemId: job.newItemId };
    } catch (e) {
      // Only while the original deletion has NOT been requested. A lost
      // original-delete response must never lead to deleting the remaining copy.
      if (held && relistValidated && job?.stage === 'created' && !rollbackAttempted) e = await rollbackCopy(e);
      if (e?.code === 'cancelled') {
        if (held && job) {
          try { await patch({ status: job.complete ? 'waiting' : 'incomplete', error: null, errorDetail: null, reportTimestamp: null }); } catch (_) {}
        }
        return { ok: false, cancelled: true, itemId, jobKey: key, backupComplete: Boolean(job?.complete) };
      }
      if (e?.code === 'item-cooldown' && !held) {
        // Not a failure of the listing: drop the queued placeholder instead of
        // recording an error, and let the caller show the cooldown message.
        try { await NS.control('forget', { key, onlyIfQueued: true }); } catch (_) {}
        return { ok: false, itemId, jobKey: key, backupComplete: Boolean(job?.complete), error: e };
      }
      const reportTimestamp = NS.reportError('republish', e, {
        itemId, newItemId: job?.newItemId, jobKey: key, listingTitle: job?.source?.title,
        stage: job?.stage, diagnostic: e.diagnostic || null, diagnosticTrace: trace.snapshot()
      });
      const failure = { status: 'error', error: e.code || e.message, errorDetail: e.diagnostic || null, reportTimestamp };
      if (held && job) { try { await patch(failure); } catch (_) {} }
      else { try { await NS.control('defer', { key, ...failure }); } catch (_) {} }
      return { ok: false, itemId, jobKey: key, backupComplete: Boolean(job?.complete), createdItemId: job?.newItemId, error: e };
    } finally {
      clearInterval(heartbeat);
      if (held) { try { await NS.control('release'); } catch (_) {} NS.lease = null; }
    }
  };
})();
