(async function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const NS = window.__VintedRelister = window.__VintedRelister || {};
  const manifest = chrome.runtime.getManifest();
  const RETENTION_MS = 42 * 24 * 60 * 60 * 1000;

  const safeJson = (value, space = 2) => JSON.stringify(value, (_key, entry) =>
    entry instanceof Blob || entry instanceof ArrayBuffer ? '[binary]' : entry, space);
  const formatDate = value => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('fr-FR');
  };
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
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
        page: 'logs',
        id: target.id || '',
        text: (target.innerText || target.textContent || target.getAttribute('aria-label') || '').trim().slice(0, 160),
        classes: String(target.className || '').slice(0, 240),
        href,
      }).catch(() => {});
    }, true);
  }
  installClickLogger();
  async function withTimeout(promise, milliseconds) {
    let timer;
    try {
      return await Promise.race([promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Délai de lecture dépassé')), milliseconds); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function diagnosticEntry(title, subtitle, value, error = false) {
    const entry = element('div', null, 'log-entry');
    const header = element('div', null, 'log-entry-header');
    header.append(element('div', title, 'log-entry-name'), element('div', subtitle, 'log-entry-time'));
    if (error) entry.append(element('span', 'erreur', 'chip error-chip'));
    entry.append(header, element('pre', safeJson(value), 'log-code'));
    return entry;
  }

  function coordinatorActionLog(entry) {
    return {
      event: 'coordinateur:republication-terminée',
      timestamp: entry?.at ? new Date(entry.at).toISOString() : '',
      detail: entry || {},
    };
  }

  function scanActionLog(scan) {
    return {
      event: `scan:${scan?.status || 'inconnu'}`,
      timestamp: scan?.updatedAt ? new Date(scan.updatedAt).toISOString() : '',
      detail: {
        key: scan?.key,
        origin: scan?.origin,
        sourceAccountId: scan?.sourceAccountId,
        status: scan?.status,
        scanned: scan?.scanned,
        added: scan?.added,
        totalItems: scan?.totalItems,
        totalPages: scan?.totalPages,
        nextPage: scan?.nextPage,
        error: scan?.error,
        startedAt: scan?.startedAt,
        completedAt: scan?.completedAt,
        updatedAt: scan?.updatedAt,
      },
    };
  }

  function withinRetention(log) {
    const time = Date.parse(log?.timestamp || '');
    return !Number.isFinite(time) || time >= Date.now() - RETENTION_MS;
  }

  // The part of `event` before the first ":" is the filterable "type"
  // (clic, republication, requete, transfert, scan, coordinateur…).
  function logType(log) {
    const event = String(log?.event || 'action');
    const i = event.indexOf(':');
    return i === -1 ? event : event.slice(0, i);
  }
  // Lets several log lines about the same listing be filtered together, even
  // though only some events carry `itemId` directly (others only a jobKey
  // shaped "origin|accountId|itemId").
  function resolveLogItemId(log) {
    const detail = log?.detail || {};
    if (detail.itemId != null && detail.itemId !== '') return String(detail.itemId);
    if (detail.newItemId != null && detail.newItemId !== '') return String(detail.newItemId);
    const key = typeof detail.key === 'string' ? detail.key : (typeof detail.jobKey === 'string' ? detail.jobKey : '');
    const parts = key.split('|');
    if (parts.length >= 3 && /^\d+$/.test(parts[2])) return parts[2];
    return null;
  }

  try {
    const localData = await withTimeout(chrome.storage.local.get([
      'vinted_local_reports_v1',
      'vinted_last_report',
      'reporting_private_v1',
      'vinted_action_logs_v1',
    ]), 10000);
    let state = null;
    let stateError = null;
    try {
      state = await withTimeout(NS.control('state'), 10000);
    } catch (error) {
      stateError = error;
    }

    const reports = Array.isArray(localData.vinted_local_reports_v1) ? localData.vinted_local_reports_v1 : [];
    const rawActionLogs = Array.isArray(localData.vinted_action_logs_v1) ? localData.vinted_action_logs_v1 : [];
    const storedActionLogs = rawActionLogs.filter(withinRetention);
    // Reading diagnostics must not rewrite logs concurrently with the worker.
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    const coordinatorHistory = Array.isArray(state?.history) ? state.history : [];
    const scans = state?.scans && typeof state.scans === 'object' ? Object.values(state.scans) : [];
    const actionLogs = [
      ...storedActionLogs,
      ...coordinatorHistory.map(coordinatorActionLog),
      ...scans.map(scanActionLog),
    ].filter(log => (log.timestamp || log.event) && withinRetention(log)).sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));
    const exportData = {
      _meta: {
        extensionVersion: manifest.version,
        exportedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
      },
      coordinatorState: state ? { settings: state.settings, gates: state.gates, history: state.history, scans: state.scans } : null,
      coordinatorError: stateError?.message || null,
      jobs,
      actionLogs,
      errorReports: reports,
      reportingReceipts: localData.reporting_private_v1 || {},
    };

    $('meta-pills').replaceChildren(
      element('span', `Version : ${manifest.version}`),
      element('span', `Export : ${formatDate(exportData._meta.exportedAt)}`),
      element('span', `Jobs : ${jobs.length}`),
      element('span', `Actions : ${actionLogs.length}`),
      element('span', 'Rétention : 42 jours'),
      element('span', `Erreurs enregistrées : ${reports.length}`),
    );

    const coordinator = $('coordinator-card');
    coordinator.replaceChildren();
    coordinator.append(state
      ? element('pre', safeJson(exportData.coordinatorState), 'log-code')
      : element('p', `Impossible de lire l’état du coordinateur : ${stateError?.message || 'erreur inconnue'}`, 'empty-notice'));

    const allTypes = Array.from(new Set(actionLogs.map(logType))).sort();
    // windowMinutes is a string (select value): '' = "Tout", otherwise minutes
    // as text ('5', '15', '30', '60', '180', '1440'). Kept as the raw select
    // value so it round-trips with the <select> without extra parsing here.
    const filterState = { types: new Set(allTypes), itemId: '', windowMinutes: '' };

    // A log with no parseable timestamp is never excluded by the time window —
    // we can't know whether it falls inside or outside it, so we err on the
    // side of showing it rather than silently hiding data.
    function withinSelectedWindow(log) {
      if (!filterState.windowMinutes) return true;
      const minutes = Number(filterState.windowMinutes);
      if (!Number.isFinite(minutes)) return true;
      const time = Date.parse(log.timestamp || '');
      if (!Number.isFinite(time)) return true;
      return time >= Date.now() - minutes * 60000;
    }

    // The item_id dropdown's own options are scoped to the currently selected
    // time window (per the requested flow: pick a period first, then pick
    // among the articles that actually have logs in that period) — it does
    // not additionally depend on the type checkboxes, so switching type
    // filters never makes the item_id selection disappear from under the user.
    function logsInSelectedWindow() {
      return actionLogs.filter(withinSelectedWindow);
    }

    function passesFilter(log) {
      if (!filterState.types.has(logType(log))) return false;
      if (!withinSelectedWindow(log)) return false;
      if (filterState.itemId && resolveLogItemId(log) !== filterState.itemId) return false;
      return true;
    }

    function renderActionsList() {
      const filtered = actionLogs.filter(passesFilter);
      $('actions-count').textContent = filtered.length === actionLogs.length
        ? String(actionLogs.length) : `${filtered.length} / ${actionLogs.length}`;
      $('actions-list').replaceChildren();
      if (!filtered.length) {
        $('actions-list').append(element('p',
          actionLogs.length ? 'Aucune action ne correspond aux filtres.' : 'Aucune action enregistrée.', 'empty-notice'));
        return;
      }
      for (const log of filtered) {
        const id = resolveLogItemId(log);
        $('actions-list').append(diagnosticEntry(
          id ? `${log.event || 'action'} · article ${id}` : (log.event || 'action'),
          formatDate(log.timestamp),
          log.detail || {},
          /erreur|error/i.test(log.event || '') || log.detail?.ok === false,
        ));
      }
    }

    function renderTypeFilters() {
      const container = $('filter-types');
      container.replaceChildren();
      for (const type of allTypes) {
        const label = element('label', null, 'log-type-chip');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = filterState.types.has(type);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) filterState.types.add(type); else filterState.types.delete(type);
          renderActionsList();
        });
        label.append(checkbox, element('span', `${type} (${actionLogs.filter(l => logType(l) === type).length})`));
        container.append(label);
      }
    }

    function renderItemIdFilter() {
      const select = $('filter-item-id');
      const windowed = logsInSelectedWindow();
      const counts = new Map();
      for (const log of windowed) {
        const id = resolveLogItemId(log);
        if (id) counts.set(id, (counts.get(id) || 0) + 1);
      }
      const ids = Array.from(counts.keys()).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
      // Keep the current selection only if it still has logs in this window;
      // otherwise fall back to "Tous les articles" rather than pointing at
      // an id the list no longer offers.
      if (filterState.itemId && !counts.has(filterState.itemId)) filterState.itemId = '';
      select.replaceChildren(element('option', `Tous les articles (${windowed.length})`, null));
      select.firstChild.value = '';
      for (const id of ids) {
        const option = element('option', `${id} (${counts.get(id)})`, null);
        option.value = id;
        select.append(option);
      }
      select.value = filterState.itemId;
    }

    $('filter-window').addEventListener('change', event => {
      filterState.windowMinutes = event.target.value;
      // Changing the period changes which item_ids even exist to pick from,
      // so the item_id dropdown is rebuilt (and reset if its current
      // selection fell outside the new window) before repainting the list.
      renderItemIdFilter();
      renderActionsList();
    });
    $('filter-item-id').addEventListener('change', event => {
      filterState.itemId = event.target.value;
      renderActionsList();
    });
    $('filter-reset').addEventListener('click', () => {
      filterState.types = new Set(allTypes);
      filterState.itemId = ''; filterState.windowMinutes = '';
      $('filter-window').value = '';
      renderTypeFilters(); renderItemIdFilter(); renderActionsList();
    });

    renderTypeFilters();
    renderItemIdFilter();
    renderActionsList();

    $('jobs-count').textContent = String(jobs.length);
    $('jobs-list').replaceChildren();
    if (!jobs.length) {
      $('jobs-list').append(element('p', 'Aucun job en attente.', 'empty-notice'));
    } else {
      for (const job of jobs) {
        $('jobs-list').append(diagnosticEntry(
          job.source?.title || job.key || '(sans titre)',
          `${job.photoCount ?? job.blobs?.length ?? 0} photo(s) · ${formatDate(job.updatedAt || job.savedAt)}`,
          {
            key: job.key,
            status: job.status,
            stage: job.stage,
            origin: job.origin || job.sourceOrigin,
            sourceAccountId: job.sourceAccountId,
            targetAccountId: job.targetAccountId,
            error: job.error || job.errorCode,
            errorDetail: job.errorDetail,
            updatedAt: job.updatedAt,
          },
          job.status === 'error',
        ));
      }
    }

    $('reports-count').textContent = String(reports.length);
    $('reports-list').replaceChildren();
    if (!reports.length) {
      $('reports-list').append(element('p', 'Aucun rapport d’erreur enregistré.', 'empty-notice'));
    } else {
      for (const report of reports) {
        $('reports-list').append(diagnosticEntry(
          report.payload?.errorName || 'Error',
          formatDate(report.timestamp),
          report,
          true,
        ));
      }
    }

    $('copy-btn').addEventListener('click', async () => {
      const button = $('copy-btn');
      const text = safeJson(exportData);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const textarea = element('textarea');
        textarea.value = text;
        textarea.style.cssText = 'position:fixed;opacity:0';
        document.body.append(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      button.textContent = '✓ Copié dans le presse-papiers !';
      setTimeout(() => { button.textContent = '📋 Copier tout (JSON)'; }, 2500);
    });

    $('loading').hidden = true;
    $('main').hidden = false;
  } catch (error) {
    $('loading').textContent = `Erreur lors du chargement : ${error?.message || error}`;
  }
})();
