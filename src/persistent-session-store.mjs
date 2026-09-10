import session from 'express-session';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const SID = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_AGE = 30 * 24 * 3600000;
const CLOCK_SLACK = 5 * 60000;
const MAX_VALUE = 12288;
const MAX_FILE = 16 * 1024 * 1024;
const unavailable = () => Object.assign(new Error('Sign-in storage is temporarily unavailable. Please try again shortly.'), {
  status: 503, code: 'SESSION_STORAGE_UNAVAILABLE',
});
const validExpiry = (expires, now) => Number.isSafeInteger(expires) && expires > now && expires <= now + MAX_AGE + CLOCK_SLACK;
const validRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && Object.hasOwn(value, 'value') && Object.hasOwn(value, 'expires')
  && typeof value.value === 'string' && value.value.length > 0 && value.value.length <= MAX_VALUE
  && Buffer.byteLength(value.value) <= MAX_VALUE && Number.isSafeInteger(value.expires) && value.expires > 0 && value.expires <= 8.64e15;
const checkId = id => { if (typeof id !== 'string' || !SID.test(id)) throw unavailable(); };

/** One worker process owns this file. Every mutation is committed before acknowledgement. */
export class FileSessionStorage {
  constructor({ dataDir, maxSessions = 10000, now = Date.now }) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 10000) throw unavailable();
    this.file = path.join(dataDir, '.portal-sessions.json');
    this.maxSessions = maxSessions;
    this.now = now;
    this.records = new Map();
    this.revoked = new Map();
    this.closed = false;
    this.tail = Promise.resolve();
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  async load() {
    let handle;
    try {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      try { handle = await open(this.file, 'r'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const { size } = await handle.stat();
      if (size > MAX_FILE) throw unavailable();
      const buffer = Buffer.alloc(size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > size) throw unavailable();
      const data = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      if (data?.version !== 1 || !Array.isArray(data.records) || !Array.isArray(data.revoked)
          || data.records.length > this.maxSessions || data.revoked.length > this.maxSessions * 2) throw unavailable();
      const seen = new Set();
      const now = this.now();
      for (const [kind, entries] of [['records', data.records], ['revoked', data.revoked]]) {
        for (const entry of entries) {
          if (!Array.isArray(entry) || entry.length !== 2) throw unavailable();
          const [id, value] = entry;
          checkId(id);
          const expires = kind === 'records' ? value?.expires : value;
          if (seen.has(id) || !Number.isSafeInteger(expires) || expires <= 0 || expires > now + MAX_AGE + CLOCK_SLACK
              || kind === 'records' && !validRecord(value)) throw unavailable();
          seen.add(id);
          if (expires > now) this[kind].set(id, value);
        }
      }
    } catch { throw unavailable(); }
    finally { await handle?.close(); }
  }
  run(operation) {
    if (this.closed) return Promise.reject(unavailable());
    const result = this.tail.then(() => this.ready).then(operation).catch(() => { throw unavailable(); });
    this.tail = result.catch(() => {});
    return result;
  }
  async commit(records, revoked) {
    const body = JSON.stringify({ version: 1, records: [...records], revoked: [...revoked] });
    if (Buffer.byteLength(body) > MAX_FILE) throw unavailable();
    const temporary = `${this.file}.${randomBytes(12).toString('hex')}.tmp`;
    let handle;
    let renamed = false;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(body);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.file);
      renamed = true;
      if (process.platform !== 'win32') {
        const directory = await open(path.dirname(this.file), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
      this.records = records;
      this.revoked = revoked;
    } catch {
      // After rename, an uncertain durability result must block stale in-memory reads.
      if (renamed) { this.ready = Promise.reject(unavailable()); this.ready.catch(() => {}); }
      throw unavailable();
    } finally {
      await handle?.close();
      if (!renamed) await unlink(temporary).catch(() => {});
    }
  }
  snapshot() {
    const now = this.now();
    return [new Map([...this.records].filter(([, value]) => value.expires > now)),
      new Map([...this.revoked].filter(([, expires]) => expires > now))];
  }
  get(id) {
    return this.run(() => {
      checkId(id);
      const value = this.records.get(id);
      return value && value.expires > this.now() ? { ...value } : null;
    });
  }
  set(id, value) {
    const record = validRecord(value) ? { value: value.value, expires: value.expires } : null;
    return this.run(async () => {
      checkId(id);
      if (!validRecord(record) || !validExpiry(record.expires, this.now())) throw unavailable();
      const [records, revoked] = this.snapshot();
      if (revoked.has(id)) throw unavailable();
      if (!records.has(id) && records.size >= this.maxSessions) throw unavailable();
      records.set(id, record);
      await this.commit(records, revoked);
      return null;
    });
  }
  take(id) {
    return this.run(async () => {
      checkId(id);
      const [records, revoked] = this.snapshot();
      const value = records.get(id);
      if (revoked.has(id)) return null;
      if (revoked.size >= this.maxSessions * 2) throw unavailable();
      records.delete(id);
      revoked.set(id, value?.expires ?? this.now() + MAX_AGE + CLOCK_SLACK);
      await this.commit(records, revoked);
      return value ? { ...value } : null;
    });
  }
  async destroy(id) { await this.take(id); return null; }
  async close() { this.closed = true; await this.tail; await this.ready; }
}

/** The worker stores opaque records; only the portal holds this encryption key. */
export class EncryptedSessionStore extends session.Store {
  constructor({ storage, secret, now = Date.now }) {
    super();
    if (typeof secret !== 'string' || secret.length < 32) throw unavailable();
    this.storage = storage;
    this.now = now;
    this.key = Buffer.from(hkdfSync('sha256', secret, '', 'turntable:portal-session:v1', 32));
  }
  decode(id, record) {
    try {
      checkId(id);
      if (!validRecord(record) || !validExpiry(record.expires, this.now())) return null;
      const [version, nonce, tag, ciphertext, extra] = record.value.split('.');
      if (version !== 'v1' || extra !== undefined || !/^[A-Za-z0-9_-]{16}$/.test(nonce)
          || !/^[A-Za-z0-9_-]{22}$/.test(tag) || !/^[A-Za-z0-9_-]+$/.test(ciphertext)) return null;
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64url'));
      cipher.setAAD(Buffer.from(`turntable:portal-session:v1:${id}`));
      cipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const decoded = JSON.parse(Buffer.concat([cipher.update(Buffer.from(ciphertext, 'base64url')), cipher.final()]).toString());
      if (decoded.expires !== record.expires || !decoded.session || typeof decoded.session !== 'object'
          || Array.isArray(decoded.session) || new Date(decoded.session.cookie?.expires).getTime() !== decoded.expires) return null;
      return decoded.session;
    } catch { return null; }
  }
  complete(promise, callback = () => {}) { promise.then(value => callback(null, value), () => callback(unavailable())); }
  get(id, callback) { this.complete(Promise.resolve().then(() => this.storage.get(id)).then(record => this.decode(id, record)), callback); }
  take(id, callback) { this.complete(Promise.resolve().then(() => this.storage.take(id)).then(record => this.decode(id, record)), callback); }
  set(id, value, callback) {
    this.complete(Promise.resolve().then(() => {
      checkId(id);
      const expires = new Date(value?.cookie?.expires).getTime();
      if (!validExpiry(expires, this.now())) throw unavailable();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(Buffer.from(`turntable:portal-session:v1:${id}`));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ expires, session: value })), cipher.final()]);
      const sealed = `v1.${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
      if (sealed.length > MAX_VALUE) throw unavailable();
      return this.storage.set(id, { value: sealed, expires });
    }), callback);
  }
  destroy(id, callback) { this.complete(Promise.resolve().then(() => this.storage.destroy(id)), callback); }
  // Expiry is fixed; reads must never save stale authentication state or revive a deleted SID.
  touch(_id, _value, callback = () => {}) { callback(null); }
  close() { return this.storage.close?.(); }
}
