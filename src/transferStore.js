// Dedicated local storage for account-to-account transfers. It is deliberately
// separate from the short-lived republication recovery queue.
(function (root) {
  'use strict';
  const DB_NAME = 'vinted-transfer-v1';
  const DB_VERSION = 1;
  let opened;

  function database() {
    if (!opened) opened = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('batches')) db.createObjectStore('batches', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('items')) {
          const items = db.createObjectStore('items', { keyPath: 'key' });
          items.createIndex('batchId', 'batchId', { unique: false });
        }
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); opened = null; };
        resolve(request.result);
      };
      request.onerror = () => { opened = null; reject(request.error); };
    });
    return opened;
  }

  async function transaction(storeNames, mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);
      let result;
      try { result = action(tx); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(result?.result ?? result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Transfer transaction aborted'));
    });
  }

  const digest = async buffer => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
  async function fingerprints(source, blobs) {
    return Promise.all([
      digest(new TextEncoder().encode(JSON.stringify(source))),
      ...(blobs || []).map(async blob => digest(await blob.arrayBuffer())),
    ]);
  }

  async function putItem(item) {
    const complete = Array.isArray(item.blobs) && item.blobs.length > 0;
    const hashes = complete ? await fingerprints(item.source, item.blobs) : [];
    const totalBytes = (item.blobs || []).reduce((sum, blob) => sum + blob.size, 0);
    const record = { ...item, hashes, totalBytes, updatedAt: Date.now() };
    await transaction(['items'], 'readwrite', tx => tx.objectStore('items').put(record));
    const saved = await getItem(record.key);
    if (!saved || saved.updatedAt !== record.updatedAt || saved.blobs?.length !== record.blobs?.length) throw new Error('Transfer backup verification failed');
    if (complete && JSON.stringify(await fingerprints(saved.source, saved.blobs)) !== JSON.stringify(hashes)) throw new Error('Transfer backup bytes do not match');
    return saved;
  }

  const putBatch = batch => transaction(['batches'], 'readwrite', tx => tx.objectStore('batches').put({ ...batch, updatedAt: Date.now() }));
  const getBatch = id => transaction(['batches'], 'readonly', tx => tx.objectStore('batches').get(id));
  const getItem = key => transaction(['items'], 'readonly', tx => tx.objectStore('items').get(key));
  const removeItem = key => transaction(['items'], 'readwrite', tx => tx.objectStore('items').delete(key));
  const batches = () => transaction(['batches'], 'readonly', tx => tx.objectStore('batches').getAll());
  async function items(batchId) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readonly');
      const request = tx.objectStore('items').index('batchId').getAll(batchId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
  async function removeBatch(id) {
    await transaction(['batches', 'items'], 'readwrite', tx => {
      tx.objectStore('batches').delete(id);
      const index = tx.objectStore('items').index('batchId');
      const request = index.openKeyCursor(IDBKeyRange.only(id));
      request.onsuccess = () => { const cursor = request.result; if (cursor) { tx.objectStore('items').delete(cursor.primaryKey); cursor.continue(); } };
    });
  }

  root.TransferStore = { putBatch, getBatch, putItem, getItem, removeItem, batches, items, removeBatch };
})(globalThis);
