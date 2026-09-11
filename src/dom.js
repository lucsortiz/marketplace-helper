// src/dom.js — Aides DOM pilotées par la config : sélecteurs, injection du bouton, notices.
(function () {
  const NS = (window.__VintedRelister = window.__VintedRelister || {});
  function cfg() { return NS.config || NS.DEFAULT_CONFIG; }

  function allMatches(selectors, root) {
    for (const sel of selectors) {
      try {
        const list = (root || document).querySelectorAll(sel);
        if (list && list.length) return list;
      } catch (e) {}
    }
    return [];
  }

  function ensureStyles() {
    if (document.getElementById('vinted-republish-style')) return;
    const style = document.createElement('style');
    style.id = 'vinted-republish-style';
    style.textContent = `
      .vinted-republish-btn { display: block !important; margin-top: 8px !important; }
      .vinted-republish-btn.is-loading { opacity: 0.6; pointer-events: none; }
      .vinted-republish-btn.is-loading.is-cancellable { opacity: 1; pointer-events: auto; }
      .vinted-republish-cancel-icon {
        display: inline-flex; align-items: center; flex: 0 0 auto;
        order: 2; margin-left: 6px; font-size: 16px; line-height: 1;
      }
      .vinted-republish-btn.is-republished {
        opacity: 1 !important; pointer-events: none; cursor: default !important;
        border-color: #F9BB42 !important; background: transparent !important; color: #007782 !important;
      }
      .vinted-republish-btn.is-republished .vinted-republish-app-icon { display: none; }
      .vinted-republish-btn.is-error {
        border-color: #c5221f !important; background: #fff5f5 !important; color: #a50e0e !important;
      }
      /* Contour jaune assorti au logo (même jaune que les étoiles Vinted, #F9BB42). */
      .vinted-republish-btn, .vinted-relist-all-btn, .vinted-transfer-account-btn, .vinted-queue-summary-btn {
        border-color: #F9BB42 !important; border-width: 2px !important; background: transparent !important;
      }
      .vinted-republish-btn:hover, .vinted-relist-all-btn:hover, .vinted-transfer-account-btn:hover, .vinted-queue-summary-btn:hover {
        background: rgba(249, 187, 66, 0.08) !important;
      }
      .vinted-relist-all-btn:disabled, .vinted-transfer-account-btn:disabled, .vinted-queue-summary-btn:disabled {
        opacity: 0.5 !important; pointer-events: none !important; cursor: not-allowed !important;
      }
      .vinted-republish-btn .web_ui__Button__content,
      .vinted-relist-all-btn .web_ui__Chip__text,
      .vinted-transfer-account-btn .web_ui__Chip__text,
      .vinted-queue-summary-btn .web_ui__Chip__text {
        display: inline-flex !important; align-items: center !important; gap: 6px !important;
      }
      .vinted-republish-app-icon {
        display: block; flex: 0 0 auto; order: 0; width: 18px; height: 18px; object-fit: contain;
      }
      .vinted-republish-btn .web_ui__Button__label { order: 1; }
      .vinted-relist-all-btn, .vinted-transfer-account-btn { margin: 0 !important; }
      .vinted-republish-heading-actions {
        display: inline-flex !important; align-items: center !important; gap: 10px !important;
        flex-wrap: wrap !important; max-width: 100% !important;
      }
      .vinted-queue-summary-btn {
        margin: 0 !important; vertical-align: middle; display: inline-flex !important;
        max-width: min(460px, 100%) !important;
      }
      .vinted-queue-summary-btn .web_ui__Chip__text span {
        max-width: min(360px, calc(100vw - 140px)) !important;
      }
      .vinted-republish-chip-spacer {
        width: 14px !important; min-width: 14px !important; flex: 0 0 14px !important;
      }
      .vinted-relist-notice {
        position: relative; box-sizing: border-box; width: auto; max-width: min(560px, calc(100vw - 32px)); margin: 0;
        padding: 12px 34px 12px 14px; border-radius: 8px; font-size: 14px; line-height: 1.4;
      }
      .vinted-relist-notice.is-success { background: #e6f7ee; color: #0f5132; border: 1px solid #a3e4c4; }
      .vinted-relist-notice.is-error { background: #fdecea; color: #842029; border: 1px solid #f5c2c7; }
      /* Bas à gauche : ne recouvre pas les boutons d'action de Vinted (souvent en bas à droite). */
      .vinted-relist-toast { position: fixed; bottom: 16px; left: 16px; z-index: 2147483647; box-shadow: 0 6px 18px rgba(0,0,0,0.15); }
      /* Texte à gauche (peut passer sur 2 lignes), bouton d'action aligné à droite du texte. */
      .vinted-relist-notice__body { display: flex; align-items: center; gap: 12px; }
      .vinted-relist-notice__msg { flex: 1 1 auto; min-width: 0; }
      .vinted-relist-notice__btn {
        flex: 0 0 auto; white-space: nowrap;
        font: inherit; font-weight: 600; font-size: 13px; cursor: pointer;
        padding: 6px 10px; border-radius: 6px; border: 1px solid currentColor;
        background: transparent; color: inherit;
      }
      .vinted-relist-notice__btn:hover { background: rgba(0,0,0,0.06); }
      /* Croix de fermeture en haut à droite, à la place de l'ancien bouton "Fermer". */
      .vinted-relist-notice__close {
        position: absolute; top: 6px; right: 6px; width: 20px; height: 20px; padding: 0;
        line-height: 18px; text-align: center; font: inherit; font-size: 13px; cursor: pointer;
        border: none; border-radius: 50%; background: transparent; color: inherit; opacity: 0.6;
      }
      .vinted-relist-notice__close:hover { opacity: 1; background: rgba(0,0,0,0.08); }
      .vinted-relist-modal-backdrop {
        position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
        box-sizing: border-box; padding: 20px; background: rgba(17, 24, 39, 0.56);
      }
      .vinted-relist-modal {
        box-sizing: border-box; width: min(480px, 100%); padding: 24px; border-radius: 12px;
        background: #fff; color: #1f2937; box-shadow: 0 20px 50px rgba(0,0,0,0.28);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .vinted-relist-modal__title { margin: 0 0 12px; font-size: 20px; line-height: 1.3; }
      .vinted-relist-modal__message { margin: 0; font-size: 15px; line-height: 1.55; }
      .vinted-relist-modal__actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
      .vinted-relist-modal__button {
        padding: 9px 15px; border: 1px solid #9ca3af; border-radius: 7px; background: #fff;
        color: #1f2937; font: inherit; font-weight: 600; cursor: pointer;
      }
      .vinted-relist-modal__button:hover { background: #f3f4f6; }
      .vinted-relist-modal__button--confirm { border-color: #007782; background: #007782; color: #fff; }
      .vinted-relist-modal__button--confirm:hover { background: #00636c; }
    `;
    document.head.appendChild(style);
  }

  // opts.action : { label, onClick } — ajoute un bouton d'action à droite
  // du texte (ex. « Voir le rapport »). Une croix en haut à droite (au lieu
  // d'un bouton "Fermer" texte) permet de fermer la notice à tout moment ;
  // les notices avec une action ne se referment pas toutes seules — il
  // faut cliquer la croix pour être sûr d'avoir eu le temps de la voir.
  function showNotice(message, type, opts) {
    let el = document.getElementById('vinted-relist-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vinted-relist-notice';
      el.className = 'vinted-relist-notice vinted-relist-toast';
      document.body.appendChild(el);
    }
    el.classList.remove('is-success', 'is-error');
    el.classList.add(type === 'error' ? 'is-error' : 'is-success');
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    el.textContent = '';
    clearTimeout(el._hideTimer);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'vinted-relist-notice__close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', (NS.i18n && NS.i18n().closeButton) || 'Close');
    closeBtn.addEventListener('click', () => { if (el && el.parentElement) el.parentElement.removeChild(el); });
    el.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'vinted-relist-notice__body';

    const msgEl = document.createElement('div');
    msgEl.className = 'vinted-relist-notice__msg';
    msgEl.textContent = message;
    body.appendChild(msgEl);

    const action = opts && opts.action;
    if (action && action.label && typeof action.onClick === 'function') {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'vinted-relist-notice__btn';
      actionBtn.textContent = action.label;
      actionBtn.addEventListener('click', action.onClick);
      body.appendChild(actionBtn);
    }

    el.appendChild(body);

    if (!action && type !== 'error') {
      el._hideTimer = setTimeout(() => { if (el && el.parentElement) el.parentElement.removeChild(el); }, 6000);
    }
  }

  function showConfirmDialog(message, options = {}) {
    ensureStyles();
    return new Promise(resolve => {
      const previous = document.getElementById('vinted-relist-confirm');
      if (previous) previous.remove();

      const backdrop = document.createElement('div');
      backdrop.id = 'vinted-relist-confirm';
      backdrop.className = 'vinted-relist-modal-backdrop';

      const dialog = document.createElement('div');
      dialog.className = 'vinted-relist-modal';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', 'vinted-relist-confirm-title');
      dialog.setAttribute('aria-describedby', 'vinted-relist-confirm-message');

      const title = document.createElement('h2');
      title.id = 'vinted-relist-confirm-title';
      title.className = 'vinted-relist-modal__title';
      title.textContent = NS.i18n().relistAllButton;

      const text = document.createElement('p');
      text.id = 'vinted-relist-confirm-message';
      text.className = 'vinted-relist-modal__message';
      text.textContent = message;
      text.style.whiteSpace = 'pre-line';
      if (options.configuration) {
        const link = document.createElement('a');
        link.textContent = NS.i18n().configurationLink;
        link.href = chrome.runtime.getURL('options.html');
        link.target = '_blank'; link.rel = 'noopener';
        link.addEventListener('click', event => {
          event.preventDefault();
          void chrome.runtime.sendMessage({ type: 'republish:open-settings' });
        });
        text.append(' ', link, '.');
      }

      const actions = document.createElement('div');
      actions.className = 'vinted-relist-modal__actions';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'vinted-relist-modal__button';
      cancel.textContent = NS.i18n().cancelButton;

      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'vinted-relist-modal__button vinted-relist-modal__button--confirm';
      confirm.textContent = NS.i18n().confirmButton;

      let finished = false;
      function finish(value) {
        if (finished) return;
        finished = true;
        document.removeEventListener('keydown', onKeyDown);
        backdrop.remove();
        resolve(value);
      }
      function onKeyDown(event) {
        if (event.key === 'Escape') finish(false);
      }

      cancel.addEventListener('click', () => finish(false));
      confirm.addEventListener('click', () => finish(true));
      backdrop.addEventListener('click', event => { if (event.target === backdrop) finish(false); });
      document.addEventListener('keydown', onKeyDown);

      actions.append(cancel, confirm);
      dialog.append(title, text, actions);
      backdrop.appendChild(dialog);
      document.body.appendChild(backdrop);
      cancel.focus();
    });
  }

  function findClosestItemId(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const testid = cur.getAttribute && cur.getAttribute('data-testid');
      if (testid && testid.startsWith('product-item-id-')) {
        const m = testid.match(/^product-item-id-(\d+)/);
        if (m) return m[1];
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function snapshotItem(el, id) {
    // Vinted tags every sub-part of a card (footer, image, overlay link…)
    // with a data-testid sharing the same "product-item-id-<id>" prefix
    // (e.g. "product-item-id-123--footer"), so a prefix-matching closest()
    // from the injected button lands on whichever narrow sub-part is
    // nearest — never the card itself, and the overlay link that carries
    // the item's title/href sits as a *sibling* of the photo, not a
    // wrapper around it. The card's own testid has no "--" suffix, so
    // target it directly by the id already known instead of guessing from
    // the button's position in the tree.
    const card = document.querySelector(`[data-testid="product-item-id-${id}"]`)
      || el.closest('[data-testid^="product-item-id-"]') || el.parentElement;
    const itemLink = card?.querySelector(`a[href*="/items/${id}"]`) || card?.querySelector('a[href*="/items/"]');
    const image = card?.querySelector('img');
    const clean = (value, max = 300) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    let title = clean(image?.alt || itemLink?.getAttribute('title'));
    if (!title && itemLink) {
      const slug = itemLink.getAttribute('href')?.match(/\/items\/\d+-([^/?#]+)/)?.[1];
      if (slug) title = clean(decodeURIComponent(slug).replace(/[-_]+/g, ' '));
    }
    const text = String(card?.innerText || '').split('\n').map(value => value.trim()).filter(Boolean);
    if (!title) {
      // Last resort: scan the card's visible text for something that isn't
      // a price and isn't the label of an action button sitting in the same
      // card (Vinted's own bump button, or ours) — those are what a click
      // captured here otherwise picks up instead of the actual title.
      const noiseEls = card ? [...card.querySelectorAll('button[data-testid="bump-button"], button[data-testid="vas-bump"], .vinted-republish-btn, .vinted-relist-all-btn')] : [];
      const noise = new Set(noiseEls.map(node => clean(node.textContent)).filter(Boolean));
      title = clean(text.find(value => !/[€$£]|\b(?:EUR|USD|GBP)\b/i.test(value) && !noise.has(value)) || `Annonce ${id}`);
    }
    const priceText = text.find(value => /\d[\d\s.,]*\s*(?:€|EUR|\$|USD|£|GBP)/i.test(value)) || '';
    const numeric = Number((priceText.match(/\d[\d\s.,]*/)?.[0] || '0').replace(/\s/g, '').replace(',', '.')) || 0;
    const currency = /\$|USD/i.test(priceText) ? 'USD' : /£|GBP/i.test(priceText) ? 'GBP' : 'EUR';
    // A card below the fold may still be lazy-loading its photo: currentSrc
    // and src can be empty (or a blank placeholder) until it scrolls into
    // view, so a data-src/srcset the loader hasn't swapped in yet is still
    // worth capturing.
    const lazySrc = image?.getAttribute('data-src') || (image?.getAttribute('srcset') || image?.getAttribute('data-srcset') || '').split(',')[0].trim().split(/\s+/)[0] || '';
    let previewUrl = image?.currentSrc || (image?.src && !image.src.startsWith('data:') ? image.src : '') || lazySrc;
    try { if (new URL(previewUrl).protocol !== 'https:') previewUrl = ''; } catch (_) { previewUrl = ''; }
    return {
      id: String(id),
      title,
      price: { amount: String(numeric), currency_code: currency },
      visible_summary: clean(text.join(' · '), 1000),
      preview_url: previewUrl,
      item_url: itemLink ? new URL(itemLink.getAttribute('href'), location.origin).origin + new URL(itemLink.getAttribute('href'), location.origin).pathname : `${location.origin}/items/${id}`,
    };
  }

  function makeButton(label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'web_ui__Button__button web_ui__Button__outlined web_ui__Button__small web_ui__Button__primary web_ui__Button__truncated';
    const span1 = document.createElement('span');
    span1.className = 'web_ui__Button__content';
    span1.appendChild(makeAppIcon());
    const span2 = document.createElement('span');
    span2.className = 'web_ui__Button__label';
    span2.textContent = label;
    span1.appendChild(span2);
    btn.appendChild(span1);
    return btn;
  }

  // Bouton au style "puce" pour s'intégrer visuellement à côté des filtres
  // Actifs/Vendus du profil (mêmes classes que ces chips natifs).
  function makeChipButton(label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'web_ui__Chip__chip web_ui__Chip__outlined web_ui__Chip__round';
    const div = document.createElement('div');
    div.className = 'web_ui__Chip__text';
    div.appendChild(makeAppIcon());
    const span = document.createElement('span');
    span.className = 'web_ui__Text__text web_ui__Text__subtitle web_ui__Text__left web_ui__Text__amplified web_ui__Text__truncated';
    span.textContent = label;
    div.appendChild(span);
    btn.appendChild(div);
    return btn;
  }

  function makeAppIcon() {
    const icon = document.createElement('img');
    icon.className = 'vinted-republish-app-icon';
    icon.src = chrome.runtime.getURL('icons/icon24.png');
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    icon.draggable = false;
    return icon;
  }

  // Met à jour le libellé sans supprimer le logo du bouton.
  function setButtonText(btn, label) {
    const span = btn && btn.querySelector('.web_ui__Button__label');
    if (span) span.textContent = label;
  }

  function makeChipSpacer() {
    const spacer = document.createElement('div');
    spacer.className = 'web_ui__Spacer__medium web_ui__Spacer__vertical vinted-republish-chip-spacer';
    return spacer;
  }

  // Met à jour le texte visible d'un bouton "puce" créé par makeChipButton,
  // sans recréer sa structure interne (span.textContent seulement).
  function setChipButtonText(btn, label) {
    const span = btn && btn.querySelector('.web_ui__Chip__text span');
    if (span) span.textContent = label;
    else if (btn) btn.textContent = label;
  }

  function getBumpButtons() { return allMatches(cfg().selectors.bumpButton); }

  Object.assign(NS, {
    ensureStyles, showNotice, showConfirmDialog, findClosestItemId, snapshotItem,
    makeButton, makeChipButton, makeChipSpacer, setButtonText, setChipButtonText, getBumpButtons,
  });
})();
