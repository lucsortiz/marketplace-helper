// src/vintedApi.js — Client API Vinted : jetons, endpoints, construction des payloads.
(function () {
  const NS = (window.__VintedRelister = window.__VintedRelister || {});
  const ORIGIN = location.origin;
  const apiLoadedAt = Date.now();
  let currentAccountCache = null;

  function log(...args) {
    console.debug('[Vinted Cloner]', ...args);
  }
  function cfg() { return NS.config || NS.DEFAULT_CONFIG; }
  function fillTemplate(str, vars) {
    return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function codedError(message, code, status) {
    const error = new Error(message);
    if (code) error.code = code;
    if (status != null) error.status = status;
    return error;
  }

  function clearCapturedTokens() {
    try { chrome.runtime.sendMessage({ type: 'vinted:clearTokens' }); } catch (_) {}
  }

  function codeForHttpFailure(status, body) {
    if (status === 429) return 'rate-limit';
    if (status === 401) return 'auth';
    if (status === 403 && /captcha-delivery|__cf_chl|cf_chl|datadome/i.test(body || '')) return 'anti-bot';
    if (status === 403 && /restrict|suspend|blocked|banned|account[^\n]{0,40}(?:disabled|locked)/i.test(body || '')) return 'account-restricted';
    if (status === 403) return 'auth';
    // 5xx : panne côté Vinted, une nouvelle tentative a des chances d'aboutir.
    // 4xx (hors cas ci-dessus) : requête refusée, réessayer ne suffira pas.
    if (status >= 500) return 'http-server';
    return 'http';
  }

  function getCookie(name) {
    try {
      const parts = document.cookie.split(';').map(s => s.trim());
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (!p) continue;
        const eq = p.indexOf('=');
        if (eq > 0) {
          const k = decodeURIComponent(p.slice(0, eq).trim());
          if (k === name) return decodeURIComponent(p.slice(eq + 1));
        }
      }
    } catch (e) {}
    return null;
  }

  function getCsrfFromHtml(html) {
    for (const pattern of cfg().csrf.htmlPatterns) {
      try {
        const m = html.match(new RegExp(pattern));
        if (m && m[1]) return m[1];
      } catch (e) {}
    }
    return null;
  }

  function getCsrfFromDOM() {
    try {
      const html = document.documentElement && document.documentElement.innerHTML;
      return html ? getCsrfFromHtml(html) : null;
    } catch (e) { return null; }
  }

  function getTokensFromBg() {
    return new Promise(resolve => {
      try { chrome.runtime.sendMessage({ type: 'vinted:getTokens' }, res => resolve(res || {})); }
      catch (e) { resolve({}); }
    });
  }

  // Resolve the current session token. Missing authentication stops the operation.
  async function getCsrf() {
    const fromDom = getCsrfFromDOM();
    if (fromDom) return fromDom;

    const fromBg = await getTokensFromBg();
    if (fromBg && fromBg.csrf) return fromBg.csrf;

    // L'app Vinted elle-même déclenche en général plusieurs appels API
    // authentifiés dans la première seconde de vie de n'importe quelle page ;
    // background.js capture passivement l'en-tête x-csrf-token de ces appels.
    // On lui laisse une courte fenêtre avant d'abandonner, plutôt que
    // d'échouer immédiatement.
    const { waitForBackgroundMs, pollIntervalMs } = cfg().csrf;
    const attempts = Math.ceil(waitForBackgroundMs / pollIntervalMs);
    for (let i = 0; i < attempts; i++) {
      await sleep(pollIntervalMs);
      const bg = await getTokensFromBg();
      if (bg && bg.csrf) return bg.csrf;
    }

    // Dernier recours "historique" : d'anciens templates Vinted embarquaient
    // le token dans le HTML de la page de création d'article. Conservé pour
    // une compatibilité future gratuite ; sait actuellement renvoyer null
    // (frontend SPA, aucun token inline) sans faire échouer tout le flux.
    try {
      const res = await NS.network(`${ORIGIN}${cfg().endpoints.newItemPage}`, { credentials: 'include' });
      const html = await res.text();
      const token = getCsrfFromHtml(html);
      if (token) return token;
    } catch (e) {}

    throw codedError('Session Vinted à actualiser.', 'auth');
  }

  async function getAnonId() {
    let anonId = getCookie('anon_id');
    if (!anonId) {
      const bg = await getTokensFromBg();
      anonId = (bg && bg.anonId) || null;
    }
    return anonId;
  }

  function authHeaders(csrf, anonId, extra) {
    return Object.assign(
      {},
      csrf ? { [cfg().headers.csrf]: csrf } : {},
      anonId ? { [cfg().headers.anonId]: anonId } : {},
      extra || {}
    );
  }

  async function fetchWardrobePage(memberId, pageNum, strict, includeSold = false) {
    if (!memberId) return null;
    let csrf = null;
    try { csrf = await getCsrf(); } catch (_) { csrf = null; }
    const anonId = await getAnonId();
    const params = new URLSearchParams({ page: String(pageNum), per_page: '20', order: 'relevance', ...(includeSold ? { include_sold: 'true' } : {}) }).toString();
    const url = `${ORIGIN}${fillTemplate(cfg().endpoints.wardrobeItems, { memberId })}?${params}`;
    try {
      const res = await NS.network(url, {
        credentials: 'include',
        headers: authHeaders(csrf, anonId, { accept: 'application/json, text/plain, */*', referer: location.href }),
      });
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (_) {}
        if (res.status === 401 || res.status === 403) clearCapturedTokens();
        if (strict) throw codedError(`HTTP ${res.status}: ${body}`, codeForHttpFailure(res.status, body), res.status);
        return null;
      }
      try { return await res.json(); } catch (e) { if (strict) throw codedError('Réponse du dressing illisible (JSON invalide).', 'bad-response'); return null; }
    } catch (error) {
      if (strict) throw error;
      return null;
    }
  }

  async function getCurrentAccountProfile(force = false) {
    if (!force && currentAccountCache?.expiresAt > Date.now()) return currentAccountCache;
    const anonId = await getAnonId();
    const res = await NS.network(`${ORIGIN}/api/v2/users/current`, {
      credentials: 'include',
      headers: authHeaders(null, anonId, { accept: 'application/json, text/plain, */*', referer: location.href }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) clearCapturedTokens();
      throw codedError(`HTTP ${res.status}: ${body}`, codeForHttpFailure(res.status, body), res.status);
    }
    const json = await res.json().catch(() => null);
    const id = json && (json.user?.id || json.id);
    if (!/^\d+$/.test(String(id || ''))) throw codedError('Current Vinted account could not be identified.', 'account');
    const user = json.user || json;
    const photo = user.photo || user.avatar || {};
    currentAccountCache = {
      id: String(id),
      name: String(user.login || user.username || user.name || `Compte ${id}`).slice(0, 100),
      avatarUrl: String(photo.url || photo.full_size_url || photo.thumbnails?.[0]?.url || ''),
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    return currentAccountCache;
  }

  async function getCurrentAccountId(force = false) {
    return (await getCurrentAccountProfile(force)).id;
  }

  function clearCurrentAccountCache() { currentAccountCache = null; }

  function wardrobeItemOwnerId(item) {
    return item && (item.user_id || item.owner_id || item.user?.id || item.owner?.id);
  }

  function wardrobeItemState(item) {
    if (!item) return 'excluded';
    const status = String(item.status?.title || item.status || item.item_status || '').toLowerCase();
    if (item.is_sold || /(?:sold|vendu|venduto)/i.test(status)) return 'sold';
    if (item.is_draft || /(?:draft|brouillon|bozza)/i.test(status)) return 'draft';
    if (['is_processing', 'is_under_review', 'is_pending_review', 'is_moderation_pending'].some(key => item[key]) ||
      /(?:processing|en traitement|in elaborazione|under review|pending review|in review|en cours de validation|validation en cours|moderation|modération|revisione)/i.test(status)) return 'pending';
    if (['is_reserved', 'is_closed', 'is_hidden', 'is_deleted', 'is_rejected'].some(key => item[key]) ||
      /(?:reserved|réservé|riservato|closed|fermé|chiuso|hidden|masqué|nascosto|deleted|supprimé|eliminato|rejected|refusé)/i.test(status)) return 'excluded';
    return 'active';
  }

  function isWardrobeItemEligible(item, memberId) {
    if (!item || !/^\d+$/.test(String(item.id || ''))) return false;
    const owner = wardrobeItemOwnerId(item);
    if (owner && String(owner) !== String(memberId)) return false;
    return wardrobeItemState(item) === 'active';
  }

  function wardrobeItemSummary(item) {
    const firstPhoto = item.photo || item.photos?.[0] || {};
    const preview = firstPhoto.full_size_url || firstPhoto.url || firstPhoto.high_resolution?.url ||
      firstPhoto.thumbnails?.find?.(thumb => thumb?.url)?.url || '';
    let previewUrl = '';
    try {
      const parsed = new URL(preview);
      if (parsed.protocol === 'https:' && /^images[1-4]?\.vinted\.net$/i.test(parsed.hostname)) previewUrl = parsed.href;
    } catch (_) {}
    const rawItemUrl = item.url || item.item_url || `${ORIGIN}/items/${item.id}`;
    let itemUrl = `${ORIGIN}/items/${item.id}`;
    try {
      const parsed = new URL(rawItemUrl, ORIGIN);
      if (parsed.origin === ORIGIN && /^\/items\/\d+/.test(parsed.pathname)) itemUrl = parsed.origin + parsed.pathname;
    } catch (_) {}
    const price = item.price && typeof item.price === 'object' ? item.price : {};
    const brand = item.brand_title || item.brand?.title || item.brand || '';
    const size = item.size_title || item.size?.title || item.size || '';
    const status = item.status_title || item.status?.title || '';
    let createdAt = '';
    const timestampFromPhotoUrl = previewUrl.match(/(?:\/|=)(1[5-9]\d{8}|2\d{9})(?:[./?&]|$)/)?.[1];
    const createdAtCandidates = [
      item.created_at_ts, item.created_at, item.uploaded_at, item.upload_date, item.created_at_timestamp,
      item.created_at_date, item.uploaded_at_ts, firstPhoto.high_resolution?.timestamp, firstPhoto.timestamp,
      timestampFromPhotoUrl,
    ];
    for (const rawCreatedAt of createdAtCandidates) {
      if (rawCreatedAt == null || rawCreatedAt === '') continue;
      const numeric = Number(rawCreatedAt);
      const parsed = Number.isFinite(numeric)
        ? new Date(numeric < 100000000000 ? numeric * 1000 : numeric)
        : new Date(String(rawCreatedAt));
      if (!Number.isNaN(parsed.getTime())) { createdAt = parsed.toISOString(); break; }
    }
    const explicitPhotoCount = item.photo_count ?? item.photos_count ?? item.photos?.length;
    const photoCount = Math.max(0, Number(explicitPhotoCount ?? (previewUrl ? 1 : 0)) || 0);
    return {
      id: String(item.id),
      title: String(item.title || `Annonce ${item.id}`),
      price: {
        amount: String(price.amount ?? item.price_numeric ?? item.price ?? '0'),
        currency_code: String(price.currency_code || item.price_currency || item.currency || 'EUR'),
      },
      brand_title: typeof brand === 'string' ? brand : '',
      size_title: typeof size === 'string' ? size : '',
      status_title: typeof status === 'string' ? status : '',
      created_at: createdAt,
      photo_count: photoCount,
      photo_count_estimated: explicitPhotoCount == null && Boolean(previewUrl),
      visible_summary: [item.title, brand, size, status].filter(value => typeof value === 'string' && value.trim()).join(' · '),
      preview_url: previewUrl,
      item_url: itemUrl,
    };
  }

  async function getItemDetails(itemId) {
    const csrf = await getCsrf();
    const anonId = await getAnonId();
    let primaryStatus = null;
    try {
      const url = `${ORIGIN}${fillTemplate(cfg().endpoints.itemUploadDetails, { itemId })}`;
      const res = await NS.network(url, {
        credentials: 'include',
        headers: authHeaders(csrf, anonId, { 'x-enable-multiple-size-groups': 'true', accept: 'application/json, text/plain, */*' }),
      });
      primaryStatus = res.status;
      if (!res.ok) { const body = await res.text(); throw codedError(`HTTP ${res.status}: ${body}`, codeForHttpFailure(res.status, body), res.status); }
      const j = await res.json();
      return j.item || j || {};
    } catch (e) {
      if (['auth', 'anti-bot', 'rate-limit'].includes(e.code)) throw e;
      log(
        `getItemDetails(${itemId}) : endpoint principal (item_upload/items) en échec` +
        (primaryStatus ? ` (HTTP ${primaryStatus})` : ' (requête non aboutie)') +
        `, tentative sur l'endpoint de repli…`, e
      );
      const url = `${ORIGIN}${fillTemplate(cfg().endpoints.itemDetailsFallback, { itemId })}`;
      const res = await NS.network(url, {
        credentials: 'include',
        headers: authHeaders(csrf, anonId, { accept: 'application/json, text/plain, */*' }),
      });
      if (!res.ok) {
        const txt = await res.text();
        if (res.status === 403 && /__cf_chl|cf_chl/.test(txt || '')) {
          clearCapturedTokens();
          throw codedError('Bloqué par Cloudflare/DataDome (403). Déconnecte-toi puis reconnecte-toi et réessaie.', 'anti-bot', 403);
        }
        if (primaryStatus === 404 && res.status === 404) {
          log(`getItemDetails(${itemId}) : 404 sur les deux endpoints — l'article est probablement vendu/clôturé/retiré côté Vinted.`);
          throw codedError(`Article ${itemId} introuvable.`, 'missing', 404);
        }
        if (res.status === 401 || res.status === 403) clearCapturedTokens();
        throw codedError(`HTTP ${res.status}: ${txt}`, codeForHttpFailure(res.status, txt), res.status);
      }
      const j = await res.json();
      return j.item || {};
    }
  }

  function decodeHtmlAttribute(value) {
    return String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  }

  function productJsonLd(html) {
    const scripts = String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    for (const match of scripts) {
      try {
        const parsed = JSON.parse(match[1]);
        const candidates = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [])];
        const product = candidates.find(value => value?.['@type'] === 'Product' || value?.['@type']?.includes?.('Product'));
        if (product) return product;
      } catch (_) {}
    }
    return null;
  }

  function publicItemFromHtml(html, itemId) {
    const product = productJsonLd(html);
    if (!product) return null;
    const photos = [];
    const seen = new Set();
    for (const match of String(html).matchAll(/data-photoid=["']([^"']+)["'][\s\S]{0,2500}?<img[^>]+src=["']([^"']+)["']/gi)) {
      const url = decodeHtmlAttribute(match[2]);
      if (!seen.has(url)) { seen.add(url); photos.push({ id: match[1], url, full_size_url: url }); }
    }
    const schemaImages = Array.isArray(product.image) ? product.image : [product.image];
    for (const value of schemaImages) {
      const url = decodeHtmlAttribute(typeof value === 'string' ? value : value?.url);
      if (url && !seen.has(url)) { seen.add(url); photos.push({ url, full_size_url: url }); }
    }
    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers || {};
    const brand = typeof product.brand === 'string' ? product.brand : product.brand?.name;
    return {
      id: String(itemId), title: String(product.name || ''), description: String(product.description || ''),
      price: { amount: String(offer.price ?? '0'), currency_code: String(offer.priceCurrency || 'EUR') },
      brand_title: String(brand || ''), status_title: String(offer.itemCondition || ''), color_title: String(product.color || ''),
      category_title: String(product.category || ''),
      photos, url: String(offer.url || `${ORIGIN}/items/${itemId}`),
    };
  }

  // Account-only API routes can fail while an account is temporarily
  // restricted. The public listing page still contains enough structured data
  // to preserve its content and all rendered photos in the local recovery copy.
  async function getItemDetailsForBackup(itemId) {
    const startedAt = Date.now();
    const anonId = await getAnonId();
    const url = `${ORIGIN}/items/${encodeURIComponent(itemId)}`;
    const res = await NS.network(url, {
      publicRead: true,
      credentials: 'include',
      headers: authHeaders(null, anonId, { accept: 'text/html,application/xhtml+xml', referer: location.href }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401 || (res.status === 403 && codeForHttpFailure(res.status, body) === 'auth')) clearCapturedTokens();
      throw codedError(`HTTP ${res.status}: ${body}`, codeForHttpFailure(res.status, body), res.status);
    }
    const html = await res.text();
    const item = publicItemFromHtml(html, itemId);
    if (!item?.title || !item.description || !item.photos.length || !(Number(item.price.amount) > 0)) {
      const challenge = /captcha-delivery|__cf_chl|cf-chl-|verify you are human/i.test(html);
      const product = productJsonLd(html);
      const error = codedError(`Article ${itemId} incomplet dans la page publique.`, 'incomplete');
      // Only structural facts: never retain HTML, cookies, titles or URLs.
      error.diagnostic = {
        phase: 'backup', check: 'public-page-incomplete', stage: 'queued',
        httpStatus: res.status, elapsedMs: Date.now() - startedAt,
        contextAgeMs: Date.now() - apiLoadedAt, htmlLength: html.length,
        responseType: (res.headers.get('content-type') || '').split(';')[0] === 'text/html' ? 'html' : 'other',
        productPresent: product ? 1 : 0,
        titlePresent: item?.title ? 1 : 0, descriptionPresent: item?.description ? 1 : 0,
        priceValid: Number(item?.price?.amount) > 0 ? 1 : 0,
        sourcePhotoCount: item?.photos?.length || 0,
        jsonLdCount: (html.match(/application\/ld\+json/gi) || []).length,
        photoMarkerCount: (html.match(/data-photoid=/gi) || []).length,
        challengeHint: challenge ? 1 : 0,
        nextAction: challenge ? 'open-vinted-check' : 'refresh-page-retry',
      };
      throw error;
    }
    return item;
  }

  function pickPhotos(src) {
    const out = [];
    for (const p of (src.photos || [])) {
      const u = p.full_size_url || p.url || (p.thumbnails && p.thumbnails[0] && p.thumbnails[0].url);
      if (u) out.push(u);
    }
    return out;
  }

  async function downloadAsBlob(url, publicRead = false) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !/^images[1-4]?\.vinted\.net$/.test(target.hostname)) throw codedError('Image host not allowed.', 'photos');
    try {
      const res = await NS.network(url, { credentials: 'omit', mode: 'cors', publicRead });
      if (res.ok) return res.blob();
    } catch (e) { if (['auth', 'anti-bot', 'rate-limit', 'lease-lost'].includes(e.code)) throw e; }
    await NS.requestPermit(publicRead);
    const bgRes = await new Promise(resolve => {
      try { chrome.runtime.sendMessage({ type: 'vinted:fetchImageBuffer', url }, resolve); }
      catch (e) { resolve({ ok: false, error: e && e.message }); }
    });
    if (!bgRes || !bgRes.ok || !(bgRes.buffer instanceof ArrayBuffer)) {
      throw codedError(`Échec du téléchargement (background) : ${url} ${bgRes && (bgRes.status || bgRes.error) || ''}`, bgRes?.status ? codeForHttpFailure(bgRes.status) : 'photos', bgRes?.status);
    }
    const contentType = bgRes.contentType || 'image/jpeg';
    try { return new Blob([bgRes.buffer], { type: contentType }); }
    catch (e) { return new Blob([bgRes.buffer], { type: 'image/jpeg' }); }
  }

  async function uploadPhoto(csrf, file, tempUuid, itemId = null) {
    const fd = new FormData();
    fd.append('photo[type]', 'item');
    fd.append('photo[temp_uuid]', tempUuid);
    fd.append('photo[file]', file, 'photo.jpg');
    const anonId = await getAnonId();
    const res = await NS.network(`${ORIGIN}${cfg().endpoints.photos}`, {
      method: 'POST',
      body: fd,
      credentials: 'include',
      itemId,
      headers: authHeaders(csrf, anonId, { 'x-enable-multiple-size-groups': 'true' }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      if (res.status === 401 || res.status === 403) clearCapturedTokens();
      throw codedError(`Échec de l'upload photo : ${res.status}`, codeForHttpFailure(res.status, body), res.status);
    }
    try { return await res.json(); }
    catch (_) { throw codedError("Réponse d'upload photo illisible (JSON invalide).", 'bad-response', res.status); }
  }

  async function createItem(csrf, payload, itemId = null) {
    const anonId = await getAnonId();
    const res = await NS.network(`${ORIGIN}${cfg().endpoints.createItem}`, {
      method: 'POST',
      credentials: 'include',
      itemId,
      headers: authHeaders(csrf, anonId, {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'x-enable-multiple-size-groups': 'true',
        'x-upload-form': 'true',
        origin: location.origin,
        referer: location.href,
      }),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      if (res.status === 403 && /captcha-delivery|__cf_chl|cf_chl|datadome/i.test(body || '')) {
        clearCapturedTokens();
        throw codedError('Bloqué par un système anti-bot (DataDome/Cloudflare). Déconnecte-toi puis reconnecte-toi et réessaie.', 'anti-bot', 403);
      }
      if (res.status === 401 || (res.status === 403 && !body)) {
        clearCapturedTokens();
        throw codedError('Session/CSRF invalide ou expirée. Recharge la page Vinted (F5) puis réessaie — cela relance la capture du jeton.', 'auth', res.status);
      }
      if (res.status === 429) {
        throw codedError('Trop de requêtes envoyées à Vinted (429). Attends avant de réessayer.', 'rate-limit', 429);
      }
      // Vinted a migré son système de tailles vers un nouveau schéma
      // "groupes de tailles" avec de nouveaux identifiants (ex. 1735,
      // 1940…). Les articles créés avant cette migration renvoient encore
      // leur ancien identifiant de taille (un petit nombre, ex. 3/4/5) via
      // l'API de lecture (item_upload/items), mais celui-ci n'est plus
      // reconnu par l'API de création, qui le traite comme si aucune
      // taille n'avait été fournie — d'où ce message Vinted trompeur alors
      // qu'une taille est bel et bien enregistrée sur l'article. Un
      // identifiant de taille qui n'apparaît dans aucune des options
      // actuelles renvoyées par Vinted pour le catalogue de l'article est
      // le signe distinctif de ce cas.
      let parsedBody = null;
      try { parsedBody = JSON.parse(body); } catch (_) {}
      const isStaleSizeId = res.status === 400 && parsedBody && Array.isArray(parsedBody.errors) &&
        parsedBody.errors.some(er => er && er.field === 'size');
      if (isStaleSizeId) {
        // La valeur de taille effectivement envoyée (celle récupérée sur
        // l'article, cf. buildPayload dans content.js). Conservée sur
        // l'erreur pour le rapport/les logs (voir errorReporter.js) — le
        // message affiché à l'utilisateur (content.js → staleSizeNotice)
        // ne montre volontairement plus cet identifiant brut, qui n'a pas
        // de sens pour quelqu'un qui n'est pas Vinted lui-même.
        const sizeValue = payload && payload.item && payload.item.size_id != null ? payload.item.size_id : null;

        const err = new Error(
          `Taille non reconnue par la création (valeur envoyée : ${sizeValue != null ? sizeValue : '(aucune)'}` +
          ` — probablement un ancien identifiant de taille, antérieur à la migration Vinted vers les « groupes de tailles »). ` +
          "Resélectionne et enregistre la taille manuellement sur vinted.fr pour cet article, puis réessaie."
        );
        err.code = 'stale-size-id';
        err.status = res.status;
        err.sizeValue = sizeValue;
        throw err;
      }
      throw codedError(`Échec de la création : ${res.status} ${body}`, codeForHttpFailure(res.status, body), res.status);
    }
    try { return await res.json(); }
    catch (_) { throw codedError('Réponse de création illisible (JSON invalide).', 'bad-response', res.status); }
  }

  // Une création qui renvoie un identifiant peut encore être en cours de
  // traitement. On confirme explicitement que la nouvelle annonce est
  // éditable et non masquée avant d'autoriser la suppression de l'originale.
  async function verifyCreatedItem(csrf, itemId) {
    const anonId = await getAnonId();
    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(2000);
      try {
        const url = `${ORIGIN}${fillTemplate(cfg().endpoints.itemUploadDetails, { itemId })}`;
        const res = await NS.network(url, {
          credentials: 'include',
          headers: authHeaders(csrf, anonId, {
            'x-enable-multiple-size-groups': 'true',
            accept: 'application/json, text/plain, */*',
          }),
        });
        if (res.status === 401 || res.status === 403 || res.status === 429) {
          const body = await res.text().catch(() => '');
          if (res.status === 401 || res.status === 403) clearCapturedTokens();
          return { ok: false, reason: codeForHttpFailure(res.status, body) };
        }
        if (!res.ok) continue;
        const json = await res.json().catch(() => null);
        const item = json && (json.item || json);
        if (!item || String(item.id || '') !== String(itemId)) continue;
        if (item.is_processing || item.is_draft || item.is_hidden || item.is_closed) {
          return { ok: false, reason: 'not-active', item };
        }
        return { ok: true, item };
      } catch (_) {}
    }
    return { ok: false, reason: 'unconfirmed' };
  }

  async function deleteItem(csrf, itemId) {
    const anonId = await getAnonId();
    const res = await NS.network(`${ORIGIN}${fillTemplate(cfg().endpoints.deleteItem, { itemId })}`, {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders(csrf, anonId, { accept: 'application/json, text/plain, */*' }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      if (res.status === 401 || res.status === 403) clearCapturedTokens();
      throw codedError(`Échec de la suppression : ${res.status} ${body}`, codeForHttpFailure(res.status, body), res.status);
    }
    try { return await res.json(); } catch (_) { return { ok: true }; }
  }

  function uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
    );
  }

  Object.assign(NS, {
    log, getCsrf, getCurrentAccountId, getCurrentAccountProfile, clearCurrentAccountCache, fetchWardrobePage, wardrobeItemState, isWardrobeItemEligible, wardrobeItemSummary, getItemDetails,
    getItemDetailsForBackup, pickPhotos, downloadAsBlob, uploadPhoto, createItem, verifyCreatedItem, deleteItem, uuidv4,
  });
})();
