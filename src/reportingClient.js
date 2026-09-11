(function () {
  const NS = window.__VintedRelister;
  async function command(action, timestamp, force) {
    const result = await chrome.runtime.sendMessage({ type: 'reporting:command', action, timestamp, force });
    if (!result?.ok) throw Object.assign(new Error('reporting'), { code: result?.code || 'offline' });
    return result.value;
  }
  NS.reporting = {
    // Call directly from the click listener: no await before permissions.request.
    sendFromGesture(timestamp) {
      const permission = chrome.permissions.request({ origins: [`${globalThis.REPORTING_ORIGIN}/*`] });
      return permission.then(granted => {
        if (!granted) throw Object.assign(new Error('permission'), { code: 'permission' });
        return command('submit', timestamp);
      });
    },
    getStatuses: (force = false) => command('statuses', null, force)
  };
})();
