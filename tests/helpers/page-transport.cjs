const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');
const { webcrypto } = require('node:crypto');
const origin = 'https://www.vinted.fr';
const source = file => fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');

function transport(options = {}) {
  const listeners = { main: {}, isolated: {} };
  const sent = [], controls = [], pageCalls = [], isolatedCalls = [];
  const common = { console, URL, Headers, Response, Blob, FormData, ArrayBuffer, AbortController,
    MessageChannel, crypto: webcrypto, location: { origin },
    setTimeout: (fn, ms) => setTimeout(fn, options.timeoutMs ?? ms), clearTimeout };
  const mainWindow = {
    addEventListener(type, fn) { (listeners.main[type] ||= []).push(fn); },
    async fetch(url, init) {
      pageCalls.push({ url, init });
      return options.pageFetch ? options.pageFetch(url, init) : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    },
  };
  const isolatedWindow = {
    addEventListener(type, fn) { (listeners.isolated[type] ||= []).push(fn); },
    postMessage(data, target, ports) {
      sent.push({ data, target });
      const clone = structuredClone({ data, ports }, { transfer: ports });
      queueMicrotask(() => {
        for (const fn of listeners.main.message || []) fn({ ...clone, origin, source: mainWindow });
      });
    },
  };
  const main = vm.createContext({ ...common, window: mainWindow });
  const isolated = vm.createContext({ ...common, window: isolatedWindow,
    fetch: async (url, init) => { isolatedCalls.push({ url, init }); return new Response('photo'); },
    chrome: { runtime: { sendMessage: async message => {
      controls.push(message);
      if (options.control) return options.control(message);
      return { ok: true, value: {} };
    } } },
  });
  if (!options.noBridge) vm.runInContext(source('src/bridge.js'), main);
  vm.runInContext(source('src/pageFetch.js') + source('src/controlClient.js'), isolated);
  return { NS: isolatedWindow.__VintedRelister, mainWindow, isolatedWindow, listeners,
    sent, controls, pageCalls, isolatedCalls, origin };
}
module.exports = { transport };
