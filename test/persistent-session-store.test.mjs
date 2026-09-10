import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, unlink, rm, stat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileSessionStorage, EncryptedSessionStore } from '../src/persistent-session-store.mjs';

const SECRET = 'test-portal-secret-with-at-least-32-characters';
const FIRST = 'a'.repeat(32);
const SECOND = 'b'.repeat(32);
const THIRD = 'c'.repeat(32);
const DAY = 24 * 3600000;
const call = (store, method, ...args) => new Promise((resolve, reject) => store[method](...args, (error, value) => error ? reject(error) : resolve(value)));
const login = expires => ({ cookie: { expires: new Date(expires), originalMaxAge: 30 * DAY },
  user: { id: '123456789012345678', username: 'private-listener' }, csrfToken: 'private-csrf-value' });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'turntable-sessions-'));
  const instances = [];
  const create = () => {
    const storage = new FileSessionStorage({ dataDir: directory, ...options });
    instances.push(storage);
    return { storage, store: new EncryptedSessionStore({ storage, secret: SECRET, now: options.now }) };
  };
  t.after(async () => {
    await Promise.allSettled(instances.map(instance => instance.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, file: path.join(directory, '.portal-sessions.json'), create, ...create() };
}

test('encrypted sessions survive a process-store restart without exposing identity or CSRF data', async t => {
  const { store, storage, file, create } = await fixture(t);
  const value = login(Date.now() + 30 * DAY);
  await call(store, 'set', FIRST, value);
  const disk = await readFile(file, 'utf8');
  for (const privateText of [value.user.id, value.user.username, value.csrfToken]) assert.equal(disk.includes(privateText), false);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await storage.close();
  assert.deepEqual(await call(create().store, 'get', FIRST), JSON.parse(JSON.stringify(value)));
});

test('tampering, wrong keys, changed expiry and moving ciphertext to another SID cannot authenticate', async t => {
  const { store, storage } = await fixture(t);
  const expires = Date.now() + DAY;
  await call(store, 'set', FIRST, login(expires));
  const original = await storage.get(FIRST);
  const wrongKey = new EncryptedSessionStore({ storage, secret: 'a-different-secret-with-at-least-32-characters' });
  assert.equal(await call(wrongKey, 'get', FIRST), null);
  await storage.set(SECOND, original);
  assert.equal(await call(store, 'get', SECOND), null);
  await storage.set(FIRST, { ...original, expires: expires + 1 });
  assert.equal(await call(store, 'get', FIRST), null);
  const parts = original.value.split('.');
  parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  await storage.set(FIRST, { ...original, value: parts.join('.') });
  assert.equal(await call(store, 'get', FIRST), null);
  await storage.set(FIRST, { ...original, value: 'not a sealed session' });
  assert.equal(await call(store, 'get', FIRST), null);
});

test('expiry stays fixed during touch and expired sessions disappear after reload', async t => {
  let now = Date.now();
  const { store, storage, create } = await fixture(t, { now: () => now });
  const value = login(now + 1000);
  await call(store, 'set', FIRST, value);
  now += 500;
  await call(store, 'touch', FIRST, login(now + DAY));
  assert.equal((await storage.get(FIRST)).expires, value.cookie.expires.getTime());
  now += 501;
  assert.equal(await call(store, 'get', FIRST), null);
  await storage.close();
  assert.equal(await call(create().store, 'get', FIRST), null);
});

test('logout durably revokes saved cookies and late set/touch cannot restore them', async t => {
  const { store, storage, create } = await fixture(t);
  const value = login(Date.now() + DAY);
  await call(store, 'set', FIRST, value);
  await call(store, 'destroy', FIRST);
  await call(store, 'touch', FIRST, value);
  await assert.rejects(call(store, 'set', FIRST, value), { status: 503 });
  assert.equal(await call(store, 'get', FIRST), null);
  await storage.close();
  const restarted = create();
  assert.equal(await call(restarted.store, 'get', FIRST), null);
  await assert.rejects(call(restarted.store, 'set', FIRST, value), { status: 503 });
});

test('concurrent take consumes once and revocation survives restart', async t => {
  const { store, storage, create } = await fixture(t);
  const value = { ...login(Date.now() + DAY), oauthState: 'single-use-private-state' };
  await call(store, 'set', FIRST, value);
  const consumed = await Promise.all([call(store, 'take', FIRST), call(store, 'take', FIRST)]);
  assert.equal(consumed.filter(Boolean).length, 1);
  assert.equal(consumed.find(Boolean).oauthState, value.oauthState);
  await storage.close();
  const restarted = create();
  assert.equal(await call(restarted.store, 'take', FIRST), null);
  await assert.rejects(call(restarted.store, 'set', FIRST, value), { status: 503 });
});

test('records, revocation tombstones, payloads and expiration are bounded', async t => {
  let now = Date.now();
  const { storage } = await fixture(t, { maxSessions: 1, now: () => now });
  const record = { value: 'opaque', expires: now + 1000 };
  for (const id of ['short', '../'.repeat(20), 'a'.repeat(129)]) await assert.rejects(storage.get(id), { status: 503 });
  for (const invalid of [{ ...record, value: 'x'.repeat(12289) }, { ...record, expires: Infinity },
    { ...record, value: '' }, { ...record, value: '\u00e9'.repeat(7000) },
    { ...record, expires: now + 0.5 }, { ...record, extra: true },
    { ...record, expires: now }, { ...record, expires: now + 31 * DAY }]) await assert.rejects(storage.set(FIRST, invalid), { status: 503 });
  await storage.set(FIRST, record);
  await assert.rejects(storage.set(SECOND, record), { status: 503 });
  await storage.destroy(FIRST);
  await storage.destroy(SECOND);
  await assert.rejects(storage.destroy(THIRD), { status: 503 });
  now += 1001;
  await storage.set(FIRST, { ...record, expires: now + 1000 });
  assert.equal((await storage.get(FIRST)).value, 'opaque');
});

test('invalid persisted data fails closed instead of resetting the store', async t => {
  const { storage, file, create } = await fixture(t);
  await storage.set(FIRST, { value: 'opaque', expires: Date.now() + DAY });
  await storage.close();
  await writeFile(file, '{ damaged session storage');
  const restarted = create();
  await assert.rejects(call(restarted.store, 'get', FIRST), { status: 503, code: 'SESSION_STORAGE_UNAVAILABLE' });
  await assert.rejects(call(restarted.store, 'set', SECOND, login(Date.now() + DAY)), { status: 503 });
  assert.equal(await readFile(file, 'utf8'), '{ damaged session storage');
});

test('loading rejects oversized files and excess records before serving sessions', async t => {
  const { storage, file, create } = await fixture(t, { maxSessions: 1 });
  const record = { value: 'opaque', expires: Date.now() + DAY };
  await storage.set(FIRST, record);
  await storage.close();
  await writeFile(file, JSON.stringify({ version: 1, records: [[FIRST, record], [SECOND, record]], revoked: [] }));
  await assert.rejects(create().storage.get(FIRST), { status: 503 });
  const handle = await open(file, 'w');
  try { await handle.truncate(16 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(create().storage.get(FIRST), { status: 503 });
});

test('failed disk writes are rejected without publishing uncommitted state', async t => {
  const { store, storage, directory } = await fixture(t);
  await call(store, 'set', FIRST, login(Date.now() + DAY));
  const saved = await storage.get(FIRST);
  const moved = directory + '-moved';
  await rename(directory, moved);
  await writeFile(directory, 'block directory creation');
  try {
    await assert.rejects(call(store, 'set', SECOND, login(Date.now() + DAY)), error => error.status === 503 && !error.message.includes(directory));
    await assert.rejects(call(store, 'destroy', FIRST), { status: 503 });
    assert.equal(await storage.get(SECOND), null);
    assert.deepEqual(await storage.get(FIRST), saved);
  } finally {
    await unlink(directory);
    await rename(moved, directory);
  }
});

test('adapter propagates storage outages without treating them as missing sessions', async () => {
  const fail = async () => { throw new Error('secret filesystem detail'); };
  const store = new EncryptedSessionStore({ storage: { get: fail, set: fail, take: fail, destroy: fail }, secret: SECRET });
  for (const [method, args] of [['get', []], ['take', []], ['destroy', []], ['set', [login(Date.now() + DAY)]]]) {
    await assert.rejects(call(store, method, FIRST, ...args), error => error.status === 503 && !error.message.includes('filesystem'));
  }
});
