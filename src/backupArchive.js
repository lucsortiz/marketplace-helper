(function (root) {
  const digest = async buffer => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), b => b.toString(16).padStart(2, '0')).join('');
  async function encode(job) {
    const { blobs, ...record } = job;
    const photos = [];
    for (const blob of blobs || []) {
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
      photos.push({ type: blob.type, data: btoa(binary), sha256: await digest(buffer) });
    }
    return new Blob([JSON.stringify({ format: 'vinted-republish-backup', version: 1, record, photos })], { type: 'application/json' });
  }
  async function decode(file) {
    if (file.size > 500 * 1024 * 1024) throw new Error('Archive too large');
    const input = JSON.parse(await file.text());
    if (input.format !== 'vinted-republish-backup' || input.version !== 1 || !Array.isArray(input.photos) || !input.photos.length || input.photos.length > 50) throw new Error('Unsupported backup');
    const blobs = [];
    for (const photo of input.photos) {
      if (typeof photo.data !== 'string' || photo.data.length > 36 * 1024 * 1024 || !/^image\//.test(photo.type)) throw new Error('Invalid photo');
      const binary = atob(photo.data);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      if (await digest(bytes) !== photo.sha256) throw new Error('Photo checksum mismatch');
      blobs.push(new Blob([bytes], { type: photo.type }));
    }
    return { ...input.record, blobs };
  }
  root.BackupArchive = { encode, decode };
})(globalThis);
