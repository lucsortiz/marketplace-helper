(function () {
  const NS = window.__VintedRelister = window.__VintedRelister || {};
  const catalogs = {};
  let preferred = 'auto';
  function language(value) {
    const browser = (chrome.i18n.getUILanguage() || navigator.language || 'en').split('-')[0];
    return ['fr', 'en', 'it', 'es'].includes(value === 'auto' ? browser : value) ? (value === 'auto' ? browser : value) : 'en';
  }
  NS.t = (key, vars = {}) => {
    const message = catalogs[NS.language]?.[key]?.message || catalogs.en?.[key]?.message || key;
    return message.replace(/\{(\w+)\}/g, (_, name) => vars[name] == null ? `{${name}}` : String(vars[name]));
  };
  NS.applyLocale = () => {
    if (location.protocol === 'chrome-extension:') document.documentElement.lang = NS.language;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = NS.t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-label]').forEach(el => el.setAttribute('aria-label', NS.t(el.dataset.i18nLabel)));
    document.querySelectorAll('[data-language]').forEach(el => { el.value = preferred === 'auto' ? NS.language : preferred; });
    NS.resetLanguage?.();
  };
  NS.setLocale = async value => {
    await NS.control('settings', { settings: { language: value } });
    preferred = value; NS.language = language(value); NS.applyLocale();
    document.dispatchEvent(new Event('republish:language'));
  };
  NS.localeReady = (async () => {
    await Promise.all(['en', 'fr', 'it', 'es'].map(async code => {
      catalogs[code] = await fetch(`${chrome.runtime.getURL(`_locales/${code}/messages.json`)}?v=0.11.9`).then(r => r.json());
    }));
    const state = await NS.control('state');
    preferred = state.settings.language; NS.language = language(preferred); NS.applyLocale();
  })();
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id === chrome.runtime.id && msg?.type === 'republish:language') {
      preferred = msg.language; NS.language = language(preferred); NS.applyLocale();
      document.dispatchEvent(new Event('republish:language'));
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    const value = changes.republish_control_v1?.newValue?.settings?.language;
    if (area === 'local' && value && value !== preferred) {
      preferred = value; NS.language = language(value); NS.applyLocale();
      document.dispatchEvent(new Event('republish:language'));
    }
  });
})();
