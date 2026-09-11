#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const root = path.resolve(__dirname, '..');
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function requireFile(relativePath) {
  if (!fs.existsSync(path.join(root, relativePath))) failures.push(`Missing file: ${relativePath}`);
}

function checkMatchPattern(pattern) {
  const match = String(pattern).match(/^https:\/\/([^/]+)\//);
  if (!match) return;
  const host = match[1];
  if (host.includes('*') && !host.startsWith('*.')) {
    failures.push(`Invalid partial host wildcard: ${pattern}`);
  }
}

let manifest;
try {
  manifest = JSON.parse(read('manifest.json'));
} catch (error) {
  failures.push(`manifest.json is invalid: ${error.message}`);
  manifest = {};
}

if (manifest.manifest_version !== 3) failures.push('Manifest V3 is required.');
if (Number(manifest.minimum_chrome_version) < 148) failures.push('Chrome 148 or newer is required.');
if (manifest.message_serialization !== 'structured_clone') failures.push('Structured-clone message serialization is required.');
if (manifest.default_locale !== 'en') failures.push('default_locale must be "en".');
if (!/^__MSG_[A-Za-z0-9_]+__$/.test(manifest.name || '')) failures.push('Manifest name must use _locales.');
if (!/^__MSG_[A-Za-z0-9_]+__$/.test(manifest.description || '')) failures.push('Manifest description must use _locales.');
if (manifest.update_url) failures.push('A custom update_url must not be shipped to the Chrome Web Store.');
const webAccessibleResources = (manifest.web_accessible_resources || []).flatMap(entry => entry.resources || []);
const mainScripts = (manifest.content_scripts || []).filter(entry => entry.world === 'MAIN');
const isolatedScripts = (manifest.content_scripts || []).filter(entry => !entry.world || entry.world === 'ISOLATED');
const bridgeEntry = mainScripts[0];
const clientEntry = isolatedScripts.find(entry => entry.js?.includes('src/pageFetch.js'));
if (mainScripts.length !== 1 || JSON.stringify(bridgeEntry?.js) !== JSON.stringify(['src/bridge.js']) ||
    bridgeEntry.run_at !== 'document_start' || !clientEntry ||
    JSON.stringify(bridgeEntry.matches) !== JSON.stringify(clientEntry.matches) ||
    clientEntry.js.indexOf('src/pageFetch.js') >= clientEntry.js.indexOf('src/controlClient.js')) {
  failures.push('Only the transport bridge may run in MAIN, on the same domains as its isolated client.');
}
if (!webAccessibleResources.includes('icons/icon24.png')) {
  failures.push('The button logo must be declared as a web-accessible resource.');
}

for (const pattern of [...(manifest.host_permissions || []), ...((manifest.content_scripts || []).flatMap(entry => entry.matches || []))]) {
  checkMatchPattern(pattern);
}
for (const pattern of (manifest.host_permissions || [])) {
  if (/^https:\/\/\*\.vinted\.(?:net|com)\//.test(pattern)) {
    failures.push(`Overbroad Vinted subdomain permission: ${pattern}`);
  }
}

for (const locale of ['en', 'fr', 'it']) {
  const localePath = `_locales/${locale}/messages.json`;
  requireFile(localePath);
  if (!fs.existsSync(path.join(root, localePath))) continue;
  try {
    const messages = JSON.parse(read(localePath));
    for (const key of [
      'extensionName', 'extensionShortName', 'extensionDescription',
    ]) {
      if (!messages[key] || !messages[key].message) failures.push(`${localePath} is missing ${key}.`);
    }
    const description = messages.extensionDescription && messages.extensionDescription.message;
    if (messages.extensionName && messages.extensionName.message !== 'Vinted Republish FREE') {
      failures.push(`${localePath} must use the public name Vinted Republish FREE.`);
    }
    if (description && [...description].length > 132) failures.push(`${localePath} description exceeds 132 characters.`);
  } catch (error) {
    failures.push(`${localePath} is invalid: ${error.message}`);
  }
}

for (const relativePath of [
  'logs.html', 'logs-ui.js', 'transfert.html', 'transfer-ui.js', 'transfer.css', 'src/transferStore.js', 'src/reportingSanitizer.js', 'src/reportingService.js', 'src/reportingConfig.js', 'src/reportingClient.js', 'background.js', 'options.html', 'welcome.html', 'pending.html', 'popup.html', 'ui.js', 'ui.css', 'privacy.html',
  'media/illustration-pin.jpg', 'media/illustration-wardrobe.jpg', 'media/account-placeholder.png',
  ...(manifest.content_scripts || []).flatMap(entry => entry.js || []),
  ...Object.values(manifest.icons || {}),
]) requireFile(relativePath);

const jsFiles = ['logs-ui.js', 'transfer-ui.js', 'src/transferStore.js', 'src/reportingService.js', 'src/reportingConfig.js', 'src/reportingClient.js', 'background.js', 'ui.js', 'src/jobStore.js', 'src/coordinator.js', 'src/backupArchive.js', ...(manifest.content_scripts || []).flatMap(entry => entry.js || [])];
for (const relativePath of [...new Set(jsFiles)]) {
  if (!fs.existsSync(path.join(root, relativePath))) continue;
  const result = childProcess.spawnSync(process.execPath, ['--check', path.join(root, relativePath)], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`Syntax error in ${relativePath}: ${(result.stderr || result.stdout).trim()}`);
  const source = read(relativePath);
  if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) failures.push(`Remote-code risk in ${relativePath}: eval/new Function.`);
}

const contentSource = read('src/content.js');
const domSource = read('src/dom.js');
const i18nSource = read('src/i18n.js');
const backgroundSource = read('background.js');
const optionsSource = read('options.html');
const publicText = [
  optionsSource,
  read('privacy.html'),
  read('README.md'),
  ...(fs.existsSync(path.join(root, 'STORE_SUBMISSION.md')) ? [read('STORE_SUBMISSION.md')] : []),
  read('_locales/en/messages.json'),
  read('_locales/fr/messages.json'),
].join('\n');
if (/Relister for Vinted|Republier pour Vinted/.test(publicText)) {
  failures.push('A legacy public extension name remains. Use Vinted Republish FREE everywhere.');
}
if (/window\.confirm\s*\(/.test(contentSource)) failures.push('Native confirmation dialogs must not be used.');
if (/vinted:getSettings|bulkLimit/.test(contentSource)) failures.push('A bulk limit remains in src/content.js.');
if (!manifest.action?.default_popup) failures.push('The extension popup is missing.');
if (!/showConfirmDialog/.test(contentSource) || !/showConfirmDialog/.test(domSource)) {
  failures.push('The custom bulk confirmation dialog is missing.');
}
if (!contentSource.includes('runRepublishOnButton') || !contentSource.includes('NS.snapshotItem(btn, itemId)') ||
    !contentSource.includes('await NS.seedJobs(memberId') || !contentSource.includes('await NS.republish(itemId, memberId')) {
  failures.push('Individual clicks must back up and republish directly from their button.');
}
if (!contentSource.includes("'republishFailureNotice'") || !contentSource.includes('errorDetailsButton') || !contentSource.includes('NS.showNotice(message(noticeKey')) {
  failures.push('Individual republish failures must show the local-backup notice and detail action.');
}
if (!contentSource.includes('syncSavedErrors') || !contentSource.includes("job.status === 'error'") || !contentSource.includes('applySavedErrorButtons')) {
  failures.push('Failed jobs must restore their error-detail button after the wardrobe page reloads.');
}
if (!backgroundSource.includes("url.searchParams.set('detail', msg.key)") || !read('ui.js').includes("new URLSearchParams(location.search).get('detail')")) {
  failures.push('Failed listing buttons must deep-link to their pending detail dialog.');
}
if (!read('src/coordinator.js').includes("g.reason === 'account-restricted'")) {
  failures.push('Restricted-account gates must still allow public backup reads so an old partial backup can be completed.');
}
if (read('pending.html').includes('id="detail-title" data-i18n="uiDetail"') || !read('ui.js').includes('detail-heading-status') ||
    !read('ui.js').includes("['Description', source.description]") || read('ui.js').includes("t('BackupComplete'")) {
  failures.push('The pending detail must use the status/title/price heading and labeled listing fields without the backup notice.');
}
if (read('ui.js').includes("t('ReportingDisclosure')")) {
  failures.push('The failed-listing actions must omit the reporting disclosure.');
}
if (!read('ui.js').includes("t('ResolveError')") || !read('ui.js').includes("'resolve-error'") ||
    read('ui.js').includes('republishButton(') || read('ui.js').includes("type: 'republish:retry'")) {
  failures.push('The failed-listing detail must offer manual resolution instead of a retry control.');
}
if (!contentSource.includes("cancelIcon.textContent = '❌'") || !contentSource.includes("phase === 'cooldown'") ||
    !i18nSource.includes("phaseCooldown: 'Republication dans {seconds}s…'")) {
  failures.push('The republish cooldown must expose the red-cross cancellation control.');
}
if (!contentSource.includes(".append(cancelIcon)") || !read('ui.js').includes('installCooldownReset') ||
    !read('ui.js').includes("NS.control('reset-cooldown')") || !read('src/coordinator.js').includes("case 'reset-cooldown'")) {
  failures.push('Cooldown reset controls must be available in options and popup, and the cancel cross must follow the countdown label.');
}
if (/fetchWardrobeAndAnnotate|republishItemById/.test(contentSource)) {
  failures.push('The legacy page-load scan or immediate bulk republish flow remains.');
}
if (!domSource.includes('snapshotItem') || !contentSource.includes('queueAllItems') ||
    !contentSource.includes("NS.fetchWardrobePage(memberId, page, true)") || !contentSource.includes("NS.control('scan-page'")) {
  failures.push('The resumable paginated wardrobe queue flow is missing.');
}
if (i18nSource.includes('🔄')) failures.push('The legacy rotating-arrow emoji remains in button labels.');
if (!domSource.includes("chrome.runtime.getURL('icons/icon24.png')") || !domSource.includes('vinted-republish-app-icon')) {
  failures.push('The app logo is missing from the republish buttons.');
}
const obsoleteConsentSource = [
  contentSource,
  backgroundSource,
  optionsSource,
  read('ui.js'),
  i18nSource,
  read('_locales/en/messages.json'),
  read('_locales/fr/messages.json'),
].join('\n');
if (/getPrivacyConsent|grantPrivacyConsent|vinted_privacy_consent|consent-required|consentRequiredNotice|withdrawConsent/.test(obsoleteConsentSource)) {
  failures.push('The obsolete in-extension privacy consent gate remains.');
}
if (!backgroundSource.includes('enableHeaderCapture();')) {
  failures.push('Automatic request-header capture is missing.');
}
if (/consentHeading|consentDisclosure/.test(optionsSource + read('ui.js'))) {
  failures.push('The obsolete consent controls remain on the options page.');
}
if (!backgroundSource.includes('vinted:fetchImageBuffer') || !/sendResponse\(\{\s*ok:\s*true,\s*buffer\b/.test(backgroundSource)) {
  failures.push('The structured-clone ArrayBuffer photo fallback is missing.');
}
if (/Base64|arrayBufferToBase64|fetchImageBase64/.test(backgroundSource + read('src/vintedApi.js'))) {
  failures.push('Legacy Base64 photo serialization remains in the package.');
}

const reportingOrigin = 'https://reporting.vinted-republish.workers.dev/*';
if (!manifest.optional_host_permissions?.includes(reportingOrigin) || manifest.host_permissions?.includes(reportingOrigin)) failures.push('Reporting permission must be optional and exact.');
if (/healthchecks\.io|hc-ping\.com|reportToken/.test(read('src/config.js') + read('src/errorReporter.js'))) failures.push('Obsolete reporting integration.');
if (!read('src/reportingClient.js').includes('chrome.permissions.request')) failures.push('Manual reporting permission is missing.');
if (fs.existsSync(path.join(root, 'reports.html')) || fs.existsSync(path.join(root, 'reports-ui.js'))) {
  failures.push('The standalone reports page was merged into the failed-listings (pending) page and must not return.');
}
if (!read('pending.html').includes('src/reportingClient.js') || !read('ui.js').includes("t('SendReport')") || !read('ui.js').includes("t('ViewReport')")) {
  failures.push('Failed-listing report controls are missing from the pending detail view.');
}
if (!read('ui.js').includes('syncDetailReceipt') || !read('ui.js').includes('NS.reporting.getStatuses(') || !read('ui.js').includes('scheduleIssueChase')) {
  failures.push('The failed-listing detail must chase its report receipt so the GitHub issue link and resolution appear without a page reload.');
}
if (failures.length) {
  console.error(`Release checks failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release checks passed for version ${manifest.version}.`);
