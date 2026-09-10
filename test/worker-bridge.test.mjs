import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createWorkerBridge, connectWorker } from '../src/worker-bridge.mjs';
import { MediaError } from '../src/media.mjs';

const SECRET = 'worker-test-secret-with-at-least-thirty-two-characters';
const USER = '123456789012345678';
const GUILD = '223456789012345678';
const CHANNEL = '323456789012345678';
const SID = 'test-session-identifier-with-32-characters';
const silent = { warn() {} };

test('2,000 Unicode queue entries round trip without exceeding the bounded frame', async t => {
  const tracks = Array.from({ length: 2000 }, (_, index) => ({ id: randomUUID(), title: `${index} ${'音'.repeat(300)}`, artist: '楽'.repeat(300),
    requestedBy: { id: USER, username: 'Listener' }, durationSec: 3600, source: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' }));
  const detail = { guild: { id: GUILD }, queue: { nowPlaying: null, tracks } };
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) > 1024 * 1024);
  const { bridge, connect } = await fixture(t);
  connect(fakeBot({ detail: async () => detail }));
  await until(() => bridge.bot.isReady());
  assert.deepEqual(await bridge.bot.detail(GUILD, USER), detail);
  assert.equal(bridge.bot.isReady(), true);
});

test('performance and move-top RPCs validate identities and retain track IDs', async t => {
  const trackId = randomUUID();
  const { bridge, connect } = await fixture(t);
  const calls = [];
  connect(fakeBot({
    performance: async (...args) => { calls.push(args); return { version: 1, history: [] }; },
    control: async (...args) => { calls.push(args); return { tracks: [{ id: trackId }] }; },
  }));
  await until(() => bridge.bot.isReady());
  assert.equal((await bridge.bot.performance(GUILD, USER)).version, 1);
  assert.equal((await bridge.bot.control(GUILD, USER, 'move-top', trackId)).tracks[0].id, trackId);
  assert.deepEqual(calls, [[GUILD, USER], [GUILD, USER, 'move-top', trackId]]);
  await assert.rejects(bridge.bot.performance('invalid', USER), { code: 'WORKER_INVALID_REQUEST' });
  await assert.rejects(bridge.bot.control(GUILD, USER, 'move-top'), { code: 'WORKER_INVALID_REQUEST' });
  assert.equal(calls.length, 2);
});

function fakeSessionStorage(overrides = {}) {
  const records = new Map();
  return {
    async get(sid) { return records.get(sid) ?? null; },
    async set(sid, record) { records.set(sid, record); return null; },
    async take(sid) { const record = records.get(sid) ?? null; records.delete(sid); return record; },
    async destroy(sid) { records.delete(sid); return null; },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate, timeout = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('The expected worker state did not arrive.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function inbox(socket) {
  const frames = [];
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  return async predicate => {
    await until(() => frames.some(predicate));
    const index = frames.findIndex(predicate);
    return frames.splice(index, 1)[0];
  };
}

function fakeBot(overrides = {}) {
  return {
    isReady: () => true,
    listGuilds: async userId => [{ id: GUILD, name: 'Listening room', member: userId }],
    detail: async (guildId, userId) => ({ guild: { id: guildId }, member: { id: userId }, queue: { tracks: [] } }),
    search: async (guildId, userId, query, source) => ({ results: [{ title: query, source }] }),
    request: async (guildId, userId, query) => ({ added: [{ title: query }], queue: { tracks: [{ title: query }] }, warnings: [] }),
    join: async (guildId, userId, channelId) => ({ channelId }),
    control: async (guildId, userId, action) => ({ action }),
    shutdown: async () => { throw new Error('The bridge must never shut down the bot.'); },
    ...overrides,
  };
}

async function fixture(t, options = {}) {
  const server = createServer((req, res) => { res.writeHead(404); res.end(); });
  const bridge = createWorkerBridge({ secret: SECRET, logger: silent, ...options });
  bridge.attach(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    bridge.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  function connect(bot = fakeBot(), settings = {}) {
    const connection = connectWorker({ url, secret: SECRET, bot, logger: silent,
      heartbeatMs: 20, heartbeatTimeoutMs: 1000, reconnectMinMs: 10, reconnectMaxMs: 20, random: () => 0.5, ...settings });
    clients.push(connection);
    return connection;
  }
  return { bridge, server, url, connect };
}

async function rawWorker(t, url) {
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/internal/worker', { headers: { Authorization: `Bearer ${SECRET}` } });
  socket.on('error', () => {});
  const receive = inbox(socket);
  t.after(() => socket.terminate());
  await once(socket, 'open');
  await receive(frame => frame.type === 'welcome');
  return { socket, receive, heartbeat(ready = true) {
    socket.send(JSON.stringify({ v: 1, type: 'heartbeat', botReady: ready, spotifyEnabled: true }));
  } };
}

async function rejectedUpgrade(url, { secret = SECRET, path = '/internal/worker', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace(/^http/, 'ws') + path, { headers: { Authorization: `Bearer ${secret}`, ...headers } });
    socket.on('error', () => {});
    socket.once('open', () => { socket.terminate(); reject(new Error('An invalid upgrade was accepted.')); });
    socket.once('unexpected-response', (request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode);
    });
  });
}

test('bridge enforces secret, fixed endpoint, browser-origin rejection and one worker', async t => {
  const { bridge, url } = await fixture(t);
  assert.equal(bridge.bot.isReady(), false);
  assert.deepEqual(bridge.bot.capabilities(), { spotifyEnabled: false });
  await assert.rejects(bridge.bot.listGuilds(USER), { code: 'WORKER_UNAVAILABLE', status: 503 });
  assert.equal(await rejectedUpgrade(url, { secret: 'incorrect' }), 401);
  assert.equal(await rejectedUpgrade(url, { headers: { Origin: 'https://portal.example' } }), 401);
  assert.equal(await rejectedUpgrade(url, { headers: { Origin: 'null' } }), 401);
  assert.equal(await rejectedUpgrade(url, { path: '/internal/worker?secret=' + SECRET }), 404);
  assert.equal(await rejectedUpgrade(url, { path: '/internal/worker/' }), 404);
  const worker = await rawWorker(t, url);
  assert.equal(bridge.bot.isReady(), false, 'An authenticated socket alone does not mean Discord is ready.');
  worker.heartbeat(false);
  await worker.receive(frame => frame.type === 'ack');
  assert.equal(bridge.bot.isReady(), false);
  worker.heartbeat();
  await until(() => bridge.bot.isReady());
  assert.equal(await rejectedUpgrade(url), 409);
  assert.equal(bridge.bot.isReady(), true, 'A duplicate worker cannot replace the active worker.');
});

test('fixed RPC methods round trip identities, metadata, optional channel, and local AbortSignals', async t => {
  const { bridge, connect } = await fixture(t);
  let searchOptions;
  let requestOptions;
  let requestChannel = 'not-called';
  let shutdowns = 0;
  const connector = connect(fakeBot({
    async search(guildId, userId, query, source, options) {
      assert.deepEqual([guildId, userId, query, source], [GUILD, USER, 'Dreams', 'spotify']);
      searchOptions = options;
      return { results: [{ title: 'Dreams', source: 'spotify', durationSec: null }] };
    },
    async request(guildId, userId, query, channelId, options) {
      assert.deepEqual([guildId, userId, query], [GUILD, USER, 'Dreams']);
      requestChannel = channelId;
      requestOptions = options;
      return { added: [{ title: query }], queue: { tracks: [] }, import: { accepted: 1, skipped: 2 }, warnings: ['Two unavailable entries skipped.'] };
    },
    shutdown() { shutdowns++; },
  }), { spotifyEnabled: true });
  await until(() => bridge.bot.isReady());
  assert.deepEqual(bridge.bot.capabilities(), { spotifyEnabled: true });
  assert.equal((await bridge.bot.listGuilds(USER))[0].member, USER);
  assert.equal((await bridge.bot.detail(GUILD, USER)).member.id, USER);
  assert.equal((await bridge.bot.search(GUILD, USER, 'Dreams', 'spotify')).results[0].durationSec, null);
  assert.ok(searchOptions.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(searchOptions), ['signal']);
  const result = await bridge.bot.request(GUILD, USER, 'Dreams');
  assert.equal(requestChannel, undefined);
  assert.ok(requestOptions.signal instanceof AbortSignal);
  assert.equal(result.import.skipped, 2);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(await bridge.bot.join(GUILD, USER, CHANNEL), { channelId: CHANNEL });
  assert.deepEqual(await bridge.bot.control(GUILD, USER, 'shuffle'), { action: 'shuffle' });
  connector.close();
  await until(() => !bridge.bot.isReady());
  assert.equal(shutdowns, 0);
});

test('worker membership failures and trusted provider codes survive without leaking arbitrary diagnostics', async t => {
  const logs = [];
  const logger = { warn: (...args) => logs.push(args) };
  const { bridge, connect } = await fixture(t, { logger });
  connect(fakeBot({
    detail: async () => { throw Object.assign(new Error('You must be a member of that server.'), { status: 403 }); },
    search: async (guildId, userId, query) => {
      if (query === 'restricted') throw new MediaError('YouTube is refusing requests from the bot host. Playback is unavailable while that restriction remains.', 'YOUTUBE_REQUEST_BLOCKED');
      if (query === 'playlist') throw new MediaError('Spotify playlist access requires owner authorization.', 'SPOTIFY_PLAYLIST_ACCESS');
      if (query === 'unsafe-typed') throw new MediaError('Raw https://provider.example/audio?token=private-token', 'YOUTUBE_UNAVAILABLE');
      throw Object.assign(new Error(`Raw token ${SECRET}, https://provider.example/private`), { status: 503, code: 'YOUTUBE_REQUEST_BLOCKED', name: 'MediaError' });
    },
  }), { logger });
  await until(() => bridge.bot.isReady());
  await assert.rejects(bridge.bot.detail(GUILD, USER), { status: 403, message: 'You must be a member of that server.' });
  await assert.rejects(bridge.bot.search(GUILD, USER, 'restricted', 'youtube'), { code: 'YOUTUBE_REQUEST_BLOCKED', status: 503 });
  await assert.rejects(bridge.bot.search(GUILD, USER, 'playlist', 'spotify'), { code: 'SPOTIFY_PLAYLIST_ACCESS', message: 'Spotify playlist access requires owner authorization.' });
  for (const query of ['unsafe-typed', 'untyped']) {
    await assert.rejects(bridge.bot.search(GUILD, USER, query, 'youtube'), error => {
      assert.doesNotMatch(error.message, /provider|private-token|Raw token/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
  }
  assert.ok(logs.length >= 4);
  assert.doesNotMatch(JSON.stringify(logs), /provider|private-token|Raw token/);
  assert.ok(!JSON.stringify(logs).includes(SECRET));
});

test('fresh heartbeats control readiness and capabilities and stale workers release their slot', async t => {
  let clock = 100;
  const { bridge, url } = await fixture(t, { heartbeatTimeoutMs: 60, now: () => clock });
  const first = await rawWorker(t, url);
  first.heartbeat();
  await until(() => bridge.bot.isReady());
  clock += 61;
  assert.equal(bridge.bot.isReady(), false, 'Readiness expires even before the watchdog tick.');
  assert.deepEqual(bridge.bot.capabilities(), { spotifyEnabled: false });
  await until(() => first.socket.readyState === WebSocket.CLOSED);
  const second = await rawWorker(t, url);
  second.heartbeat();
  await until(() => bridge.bot.isReady());
});

test('explicit cancellation reaches only a locally created signal and never enqueues cancelled work', async t => {
  const { bridge, connect } = await fixture(t);
  const started = deferred();
  const aborted = deferred();
  let commits = 0;
  connect(fakeBot({
    async request(guildId, userId, query, channelId, { signal }) {
      started.resolve();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted.resolve(); reject(signal.reason); }, { once: true }));
      commits++;
    },
  }));
  await until(() => bridge.bot.isReady());
  const controller = new AbortController();
  const response = bridge.bot.request(GUILD, USER, 'Dreams', undefined, { signal: controller.signal });
  const rejected = assert.rejects(response, { code: 'WORKER_OUTCOME_UNKNOWN' });
  await started.promise;
  controller.abort(new Error('A browser-only private diagnostic.'));
  await rejected;
  await aborted.promise;
  assert.equal(commits, 0);
  assert.equal(bridge.bot.isReady(), true);
  const preAborted = AbortSignal.abort();
  await assert.rejects(bridge.bot.request(GUILD, USER, 'Dreams', undefined, { signal: preAborted }), { code: 'WORKER_CANCELLED' });
});

test('read and import deadlines cancel work and discard late responses', async t => {
  const { bridge, connect } = await fixture(t, { readTimeoutMs: 35, requestTimeoutMs: 70 });
  let searchAborted = false;
  let requestAborted = false;
  const late = deferred();
  connect(fakeBot({
    async search(guildId, userId, query, source, { signal }) {
      signal.addEventListener('abort', () => { searchAborted = true; }, { once: true });
      return late.promise; // Simulates a dependency that completes after cancellation.
    },
    async request(guildId, userId, query, channelId, { signal }) {
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => { requestAborted = true; reject(signal.reason); }, { once: true }));
    },
  }), { readTimeoutMs: 1000, requestTimeoutMs: 1000 });
  await until(() => bridge.bot.isReady());
  await assert.rejects(bridge.bot.search(GUILD, USER, 'Dreams'), { code: 'WORKER_TIMEOUT' });
  await until(() => searchAborted);
  late.resolve({ results: [{ title: 'Too late' }] });
  await assert.rejects(bridge.bot.request(GUILD, USER, 'Playlist'), { code: 'WORKER_OUTCOME_UNKNOWN' });
  await until(() => requestAborted);
  assert.equal((await bridge.bot.listGuilds(USER))[0].id, GUILD);
});

test('disconnect cancels pending work, reconnects without mutation replay, and preserves the bot lifecycle', async t => {
  const { bridge, server, connect } = await fixture(t);
  const started = deferred();
  const cancelled = deferred();
  let requests = 0;
  let shutdowns = 0;
  const tracks = [];
  connect(fakeBot({
    async request(guildId, userId, query, channelId, { signal }) {
      requests++;
      tracks.push(query); // Models a committed mutation whose confirmation gets lost.
      started.resolve();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled.resolve(); reject(signal.reason); }, { once: true }));
    },
    detail: async () => ({ queue: { tracks } }),
    shutdown() { shutdowns++; },
  }));
  await until(() => bridge.bot.isReady());
  const pending = assert.rejects(bridge.bot.request(GUILD, USER, 'Dreams'), error => {
    assert.equal(error.code, 'WORKER_OUTCOME_UNKNOWN');
    assert.match(error.message, /may have completed/);
    return true;
  });
  await started.promise;
  bridge.close();
  await pending;
  await cancelled.promise;
  const replacement = createWorkerBridge({ secret: SECRET, logger: silent });
  replacement.attach(server);
  t.after(() => replacement.close());
  await until(() => replacement.bot.isReady());
  assert.deepEqual((await replacement.bot.detail(GUILD, USER)).queue.tracks, ['Dreams']);
  assert.equal(requests, 1);
  assert.equal(shutdowns, 0);
});

test('portal concurrency cap rejects excess work without dispatching it', async t => {
  const { bridge, connect } = await fixture(t, { maxPending: 1 });
  const started = deferred();
  const gate = deferred();
  let calls = 0;
  connect(fakeBot({ async listGuilds() { calls++; started.resolve(); return gate.promise; } }));
  await until(() => bridge.bot.isReady());
  const pending = bridge.bot.listGuilds(USER);
  await started.promise;
  await assert.rejects(bridge.bot.detail(GUILD, USER), { code: 'WORKER_BUSY' });
  assert.equal(calls, 1);
  gate.resolve([]);
  await pending;
  assert.deepEqual((await bridge.bot.detail(GUILD, USER)).queue.tracks, []);
});

test('proxy rejects invalid IDs, options, sources and controls before dispatch', async t => {
  const { bridge, connect } = await fixture(t);
  let calls = 0;
  connect(fakeBot({ search: async () => { calls++; } }));
  await until(() => bridge.bot.isReady());
  for (const request of [
    () => bridge.bot.detail('__proto__', USER),
    () => bridge.bot.search(GUILD, USER, 'Dreams', 'file'),
    () => bridge.bot.search(GUILD, USER, 'Dreams\n', 'youtube'),
    () => bridge.bot.search(GUILD, USER, 'Dreams', 'youtube', { signal: { aborted: false } }),
    () => bridge.bot.request(GUILD, USER, 'x'.repeat(501)),
    () => bridge.bot.control(GUILD, USER, 'shutdown'),
    () => bridge.bot.control(GUILD, USER, 'remove', '../../track'),
    () => bridge.bot.control(GUILD, USER, 'skip', randomUUID()),
  ]) await assert.rejects(request(), { code: 'WORKER_INVALID_REQUEST', status: 400 });
  assert.equal(calls, 0);
});

test('worker rejects arbitrary method aliases, extra serialized options and duplicate request IDs', async t => {
  const server = createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const connected = deferred();
  wss.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(req.url, '/internal/worker');
    const receive = inbox(socket);
    socket.on('message', data => { if (JSON.parse(data.toString()).type === 'heartbeat') socket.send(JSON.stringify({ v: 1, type: 'ack' })); });
    socket.send(JSON.stringify({ v: 1, type: 'welcome' }));
    connected.resolve({ socket, receive });
  });
  let calls = 0;
  let takes = 0;
  const connection = connectWorker({ url: `http://127.0.0.1:${server.address().port}`, secret: SECRET, logger: silent,
    bot: fakeBot({ request: async () => { calls++; return { added: [] }; } }), heartbeatMs: 20,
    sessionStorage: fakeSessionStorage({ async take() { takes++; return null; } }) });
  t.after(async () => {
    connection.close();
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise(resolve => server.close(resolve));
  });
  const { socket, receive } = await connected.promise;
  await receive(frame => frame.type === 'heartbeat');
  async function call(method, args, id = randomUUID()) {
    socket.send(JSON.stringify({ v: 1, type: 'call', id, method, args }));
    return receive(frame => frame.type === 'result' && frame.id === id);
  }
  for (const method of ['constructor', '__proto__', 'shutdown', 'snapshot', 'music']) {
    const result = await call(method, [GUILD, USER]);
    assert.equal(result.error.code, 'WORKER_INVALID_REQUEST');
  }
  assert.equal((await call('request', [GUILD, USER, 'Dreams', null, { signal: {} }])).error.code, 'WORKER_INVALID_REQUEST');
  const id = randomUUID();
  assert.equal((await call('request', [GUILD, USER, 'Dreams', null], id)).ok, true);
  assert.equal((await call('request', [GUILD, USER, 'Dreams', null], id)).error.code, 'WORKER_DUPLICATE_REQUEST');
  assert.equal(calls, 1);
  for (const [method, args] of [
    ['sessionTake', ['../' + SID]], ['sessionGet', [SID, { admin: true }]],
    ['sessionSet', [SID, { value: 'encrypted', expires: 100, user: USER }]],
    ['sessionSet', [SID, { value: 'x'.repeat(12289), expires: 100 }]],
  ]) assert.equal((await call(method, args)).error.code, 'WORKER_INVALID_REQUEST');
  const takeId = randomUUID();
  assert.equal((await call('sessionTake', [SID], takeId)).ok, true);
  assert.equal((await call('sessionTake', [SID], takeId)).error.code, 'WORKER_DUPLICATE_REQUEST');
  assert.equal(takes, 1);
});

test('outbound worker configuration rejects insecure remote URLs and credential-bearing endpoints', () => {
  for (const url of ['http://portal.example', 'ws://portal.example/internal/worker', 'https://user:password@portal.example',
    'https://portal.example/internal/worker?secret=anything', 'https://portal.example/other', 'file:///internal/worker']) {
    assert.throws(() => connectWorker({ url, secret: SECRET, bot: fakeBot() }));
  }
  for (const secret of ['short', 'a'.repeat(31), 'a'.repeat(257), 'a '.repeat(20), 'é'.repeat(40)]) {
    assert.throws(() => createWorkerBridge({ secret }), /WORKER_SECRET/);
  }
});

test('durable session calls work while Discord is reconnecting and atomically consume records', async t => {
  const { bridge, connect } = await fixture(t);
  connect(fakeBot({ isReady: () => false }), { sessionStorage: fakeSessionStorage(), spotifyEnabled: true });
  await until(() => bridge.bot.capabilities().spotifyEnabled);
  assert.equal(bridge.bot.isReady(), false);
  await assert.rejects(bridge.bot.listGuilds(USER), { code: 'WORKER_UNAVAILABLE' });
  const record = { value: 'opaque-encrypted-session', expires: Date.now() + 60000 };
  assert.equal(await bridge.sessionStorage.get(SID), null);
  assert.equal(await bridge.sessionStorage.set(SID, record), null);
  assert.deepEqual(await bridge.sessionStorage.get(SID), record);
  const consumed = await Promise.all([bridge.sessionStorage.take(SID), bridge.sessionStorage.take(SID)]);
  assert.equal(consumed.filter(Boolean).length, 1);
  assert.deepEqual(consumed.find(Boolean), record);
  assert.equal(await bridge.sessionStorage.get(SID), null);
  await bridge.sessionStorage.set(SID, record);
  assert.equal(await bridge.sessionStorage.destroy(SID), null);
  assert.equal(await bridge.sessionStorage.get(SID), null);
});

test('session storage failures never masquerade as a missing session or disclose stored values', async t => {
  const logs = [];
  const { bridge, connect } = await fixture(t);
  const oldWorker = connect();
  await until(() => bridge.bot.isReady());
  await assert.rejects(bridge.sessionStorage.get(SID), { code: 'SESSION_STORAGE_UNAVAILABLE', status: 503 });
  oldWorker.close();
  await until(() => !bridge.bot.isReady());
  connect(fakeBot(), { logger: { warn: (...args) => logs.push(args) }, sessionStorage: fakeSessionStorage({
    async get() { throw new Error('private-session-data /var/data/sessions.json'); },
    async take() { return { user: { id: USER } }; },
    async destroy() { return 'unexpected result'; },
  }) });
  await until(() => bridge.bot.isReady());
  for (const method of ['get', 'take', 'destroy']) {
    await assert.rejects(bridge.sessionStorage[method](SID), error => {
      assert.equal(error.code, 'SESSION_STORAGE_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /private-session|var\/data|unexpected|123456789/);
      return true;
    });
  }
  assert.doesNotMatch(JSON.stringify(logs), /private-session|var\/data|unexpected|123456789/);
});

test('session proxy bounds identifiers and opaque records before dispatch', async t => {
  const { bridge, connect } = await fixture(t);
  let calls = 0;
  connect(fakeBot(), { sessionStorage: fakeSessionStorage({ async set() { calls++; return null; } }) });
  await until(() => bridge.bot.isReady());
  const record = { value: 'encrypted', expires: Date.now() + 60000 };
  for (const sid of ['short', '../' + SID, 'x'.repeat(129), USER, 'x'.repeat(32) + '\n']) {
    await assert.rejects(bridge.sessionStorage.get(sid), { code: 'WORKER_INVALID_REQUEST' });
  }
  for (const invalid of [
    { ...record, value: '' }, { ...record, value: 'x'.repeat(12289) },
    { ...record, value: '\u00e9'.repeat(7000) }, { ...record, extra: true },
    { ...record, expires: Infinity }, { ...record, expires: -1 }, { ...record, expires: 1.5 },
  ]) await assert.rejects(bridge.sessionStorage.set(SID, invalid), { code: 'WORKER_INVALID_REQUEST' });
  assert.equal(calls, 0);
});

test('portal validates session results even when supplied by an authenticated worker', async t => {
  const { bridge, url } = await fixture(t);
  const worker = await rawWorker(t, url);
  worker.heartbeat();
  await until(() => bridge.bot.isReady());
  for (const result of [false, { value: 'encrypted', expires: 100, user: USER }, { value: 'x'.repeat(12289), expires: 100 }]) {
    const pending = assert.rejects(bridge.sessionStorage.get(SID), { code: 'SESSION_STORAGE_UNAVAILABLE' });
    const call = await worker.receive(frame => frame.type === 'call');
    worker.socket.send(JSON.stringify({ v: 1, type: 'result', id: call.id, ok: true, result }));
    await pending;
  }
});

test('unconfirmed session writes are never replayed on a replacement connection', async t => {
  const { bridge, connect } = await fixture(t);
  const started = deferred();
  const finish = deferred();
  let writes = 0;
  const storage = fakeSessionStorage({ async set() { writes++; started.resolve(); return finish.promise; } });
  const first = connect(fakeBot(), { sessionStorage: storage });
  await until(() => bridge.bot.isReady());
  const pending = assert.rejects(bridge.sessionStorage.set(SID, { value: 'encrypted', expires: Date.now() + 60000 }), { code: 'SESSION_STORAGE_UNAVAILABLE' });
  await started.promise;
  first.close();
  await pending;
  finish.resolve(null);
  connect(fakeBot(), { sessionStorage: storage });
  await until(() => bridge.bot.isReady());
  assert.equal(await bridge.sessionStorage.get(SID), null);
  assert.equal(writes, 1);
});
