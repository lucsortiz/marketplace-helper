// Extension-owned IndexedDB. A complete backup and its photo bytes commit together.
(function (root) {
  'use strict';
  const DB = 'vinted-republish-backups';
  let opened;
  function database() {
    if (!opened) opened = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('jobs', { keyPath: 'key' });
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opened = null; }; resolve(request.result); };
      request.onerror = () => { opened = null; reject(request.error); };
    });
    return opened;
  }
  async function transaction(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('jobs', mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      let request;
      try { request = action(tx.objectStore('jobs')); } catch (e) { tx.abort(); reject(e); return; }
      tx.oncomplete = () => resolve(request && request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Backup transaction aborted'));
    });
  }
  const get = key => transaction('readonly', store => store.get(key));
  const all = () => transaction('readonly', store => store.getAll());
  async function fingerprint(record) {
    const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    const result = [await hash(new TextEncoder().encode(JSON.stringify(record.source)))];
    for (const blob of record.blobs || []) result.push(await hash(await blob.arrayBuffer()));
    return result.join(':');
  }
  async function put(record) {
    const expected = record.complete ? await fingerprint(record) : null;
    await transaction('readwrite', store => store.put(record));
    const saved = await get(record.key);
    if (!saved || saved.updatedAt !== record.updatedAt || (record.complete &&
        (!saved.blobs?.length || saved.blobs.length !== record.blobs.length || saved.blobs.some((b, i) => b.size !== record.blobs[i].size)))) {
      throw new Error('Backup verification failed');
    }
    if (expected && await fingerprint(saved) !== expected) throw new Error('Backup bytes do not match');
    return saved;
  }
  root.JobStore = { get, all, put, remove: key => transaction('readwrite', store => store.delete(key)) };
})(globalThis);
