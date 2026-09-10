import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createDemoBot } from '../src/demo.mjs';
import { BoundedSessionStore } from '../src/session-store.mjs';
import { EncryptedSessionStore, FileSessionStorage } from '../src/persistent-session-store.mjs';

async function fixture(t, { demo = false, setup = false, bot = createDemoBot(), fetchImpl, store, env = {}, cookieValue = '' } = {}) {
  const config = loadConfig({ DISCORD_TOKEN: 'test-token', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'test-secret', SETUP_MODE: String(setup), ...env }, { demo });
  const result = createApp({ config, bot, fetchImpl, store });
  const server = result.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  if (!config.production) config.publicUrl = url;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await result.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  t.after(close);
  let cookie = cookieValue;
  async function request(path, options = {}) {
    const response = await fetch(url + path, { ...options, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(config.production ? { 'X-Forwarded-Proto': 'https' } : {}), ...options.headers } });
    const nextCookie = response.headers.get('set-cookie');
    if (nextCookie) cookie = nextCookie.split(';')[0];
    return response;
  }
  return { request, config, cookie: () => cookie, close };
}

test('private queue API requires Discord sign-in and does not expose identities', async t => {
  const { request } = await fixture(t);
  const response = await request('/api/guilds');
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Sign in/);
  const session = await (await request('/api/session')).json();
  assert.equal(session.user, null);
  assert.equal(session.csrfToken.length, 64);
  assert.equal('discordToken' in session, false);
});

test('mutations require CSRF and matching origin, then expose the real shared queue', async t => {
  const { request, config } = await fixture(t, { demo: true });
  const { csrfToken } = await (await request('/api/session')).json();
  const endpoint = '/api/guilds/demo-guild/requests';
  const body = JSON.stringify({ query: 'A new requested song' });
  assert.equal((await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Origin: 'https://different.example' }, body })).status, 403);
  const response = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Origin: config.publicUrl }, body });
  assert.equal(response.status, 200);
  const added = await response.json();
  assert.ok(Array.isArray(added.queue.tracks));
  assert.equal(added.added[0].title, 'A new requested song');
  assert.equal(added.queue.tracks.at(-1).id, added.added[0].id);
  const detail = await (await request('/api/guilds/demo-guild')).json();
  assert.equal(detail.queue.tracks.at(-1).id, added.added[0].id);
});

test('OAuth validates state without exchanging a code; rejects non-ASCII state cleanly', async t => {
  let calls = 0;
  const { request } = await fixture(t, { fetchImpl: () => { calls++; throw new Error('Must not call provider'); } });
  const start = await request('/auth/discord');
  assert.equal(start.status, 302);
  const location = new URL(start.headers.get('location'));
  assert.equal(location.searchParams.get('scope'), 'identify');
  const response = await request('/auth/discord/callback?' + new URLSearchParams({ code: 'not-exchanged', state: 'é'.repeat(64) }));
  assert.equal(response.headers.get('location'), '/?error=sign_in_failed');
  assert.equal(calls, 0);
});

test('successful OAuth rotates session, consumes state, verifies server membership, and logout revokes it', async t => {
  let providerCalls = 0;
  const userId = '123456789012345679';
  const guildId = '123456789012345680';
  const fakeBot = {
    isReady: () => true,
    listGuilds: async id => { assert.equal(id, userId); return [{ id: guildId, name: 'My server' }]; },
    context: async () => { throw Object.assign(new Error('You must be a member of that server.'), { status: 403 }); },
    snapshot: () => { throw new Error('Must not expose a queue without membership'); },
  };
  const fetchImpl = async (url, options) => {
    providerCalls++;
    if (url.endsWith('/oauth2/token')) {
      assert.equal(options.body.get('grant_type'), 'authorization_code');
      return Response.json({ access_token: 'provider-only-token' });
    }
    assert.equal(options.headers.Authorization, 'Bearer provider-only-token');
    return Response.json({ id: userId, username: 'Listener', avatar: null });
  };
  const { request, cookie } = await fixture(t, { bot: fakeBot, fetchImpl });
  const start = await request('/auth/discord');
  const oldCookie = cookie();
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = '/auth/discord/callback?' + new URLSearchParams({ code: 'test-code', state });
  assert.equal((await request(callback)).headers.get('location'), '/');
  assert.notEqual(cookie(), oldCookie);
  assert.equal(providerCalls, 2);
  const session = await (await request('/api/session')).json();
  assert.equal(session.user.id, userId);
  assert.equal(JSON.stringify(session).includes('provider-only-token'), false);
  assert.equal((await request('/api/guilds')).status, 200);
  assert.equal((await request(`/api/guilds/${guildId}`)).status, 403);
  assert.equal((await request(callback)).headers.get('location'), '/?error=sign_in_failed');
  assert.equal(providerCalls, 2);
  assert.equal((await request('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } })).status, 200);
  assert.equal((await request('/api/guilds')).status, 401);
});

test('invalid actions, overlong queries and malformed JSON are rejected', async t => {
  const { request } = await fixture(t, { demo: true });
  const { csrfToken } = await (await request('/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
  for (const [path, body] of [['control', { action: 'invalid' }], ['requests', { query: 'x'.repeat(501) }], ['join', {}]]) {
    assert.equal((await request(`/api/guilds/demo-guild/${path}`, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  }
  const malformed = await request('/api/guilds/demo-guild/requests', { method: 'POST', headers, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'Invalid JSON request.');
});

test('configuration prevents public demo mode and incomplete production credentials', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }, { demo: true }), /local/);
  assert.throws(() => loadConfig({ RENDER: 'true' }, { demo: true }), /local/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://music.example' }), /DISCORD_TOKEN/);
  assert.throws(() => loadConfig({ SPOTIFY_CLIENT_ID: 'only-one-half' }), /both/);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'https://music.example/nested' }), /origin/);
  assert.throws(() => loadConfig({ MAX_QUEUE_SIZE: '-10' }), /integer/);
  assert.equal(loadConfig({}).host, '0.0.0.0');
  assert.equal(loadConfig({}, { demo: true }).host, '127.0.0.1');
});

test('session store bounds memory and expires sessions', () => {
  let now = 100;
  const store = new BoundedSessionStore({ maxSessions: 1, now: () => now });
  try {
    store.set('first', { cookie: { expires: new Date(200).toISOString() }, user: { id: 'user' } });
    store.set('second', {}, error => assert.match(error.message, /Too many/));
    now = 300;
    store.get('first', (error, value) => { assert.equal(error, null); assert.equal(value, null); });
    store.set('second', {}, error => assert.equal(error, null));
  } finally { store.close(); }
});

test('shuffle API preserves the current track and all waiting requests', async t => {
  const { request } = await fixture(t, { demo: true });
  const { csrfToken } = await (await request('/api/session')).json();
  const before = (await (await request('/api/guilds/demo-guild')).json()).queue;
  const response = await request('/api/guilds/demo-guild/control', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ action: 'shuffle' }) });
  assert.equal(response.status, 200);
  const after = (await response.json()).queue;
  assert.equal(after.nowPlaying.id, before.nowPlaying.id);
  assert.deepEqual(after.tracks.map(track => track.id).sort(), before.tracks.map(track => track.id).sort());
});

test('playlist counts and warnings reach the portal without wrapping the queue twice', async t => {
  const bot = createDemoBot();
  const playlist = { source: 'youtube', title: 'Test playlist', total: 12, inspected: 10, accepted: 8, skipped: 2, limitReached: true, warnings: ['Only the first 10 entries were inspected.'] };
  bot.request = async () => ({ added: Array.from({ length: 8 }, (_, id) => ({ id: String(id), title: 'Track ' + id })), queue: bot.snapshot('demo-guild'), import: playlist, warnings: playlist.warnings });
  const { request } = await fixture(t, { demo: true, bot });
  const { csrfToken } = await (await request('/api/session')).json();
  const response = await request('/api/guilds/demo-guild/requests', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ query: 'https://www.youtube.com/playlist?list=PLtest1234567890' }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.added.length, 8);
  assert.equal(result.queue.guildId, 'demo-guild');
  assert.deepEqual(result.import, playlist);
  assert.deepEqual(result.warnings, playlist.warnings);
});

test('explicit setup mode locks Discord login even if partial credentials are present', async t => {
  const { request } = await fixture(t, { setup: true });
  assert.equal((await (await request('/api/session')).json()).configured, false);
  assert.equal((await request('/auth/discord')).status, 503);
  assert.equal((await request('/api/guilds')).status, 401);
  const production = { NODE_ENV: 'production', PUBLIC_URL: 'https://music.example', SETUP_MODE: 'true', SESSION_SECRET: 's'.repeat(32) };
  assert.equal(loadConfig(production).setupMode, true);
  assert.throws(() => loadConfig({ ...production, SETUP_MODE: 'false' }), /DISCORD_TOKEN/);
  assert.throws(() => loadConfig({ ...production, SESSION_SECRET: '' }), /SESSION_SECRET/);
  assert.equal(loadConfig({}).maxPlaylistTracks, 50);
  assert.throws(() => loadConfig({ MAX_PLAYLIST_TRACKS: '101' }), /MAX_PLAYLIST_TRACKS/);
  assert.throws(() => loadConfig({ SPOTIFY_REFRESH_TOKEN: 'missing-app' }), /both Spotify/);
});

test('search requires authentication, CSRF, and the portal origin before calling the provider', async t => {
  let searches = 0;
  const bot = createDemoBot();
  const search = bot.search;
  bot.search = async (...args) => { ++searches; return search(...args); };
  const anonymous = await fixture(t, { bot });
  const endpoint = '/api/guilds/demo-guild/search';
  const body = JSON.stringify({ query: 'Midnight City', source: 'youtube' });
  assert.equal((await anonymous.request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  const { request } = await fixture(t, { demo: true, bot });
  const { csrfToken } = await (await request('/api/session')).json();
  assert.equal((await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Origin: 'https://another.example' }, body })).status, 403);
  assert.equal(searches, 0);
});

test('search returns five selectable results without changing playback, then queues the selected result', async t => {
  const bot = createDemoBot();
  const originalSearch = bot.search;
  const calls = [];
  bot.search = async (...args) => { calls.push(args); return originalSearch(...args); };
  const { request, config } = await fixture(t, { demo: true, bot });
  const { csrfToken } = await (await request('/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Origin: config.publicUrl };
  const before = (await (await request('/api/guilds/demo-guild')).json()).queue;
  const response = await request('/api/guilds/demo-guild/search', { method: 'POST', headers, body: JSON.stringify({ query: '  Midnight City  ', source: 'spotify' }) });
  assert.equal(response.status, 200);
  const { results } = await response.json();
  assert.deepEqual(calls.map(args => args.slice(0, 4)), [['demo-guild', 'demo-user', 'Midnight City', 'spotify']]);
  assert.ok(calls[0][4].signal instanceof AbortSignal);
  assert.equal(calls[0][4].signal.aborted, false);
  assert.equal(results.length, 5);
  assert.equal(new Set(results.map(track => track.sourceUrl)).size, 5);
  assert.ok(results.every(track => track.source === 'spotify' && track.title.includes('demo result') && track.artist.includes('no audio')));
  const after = (await (await request('/api/guilds/demo-guild')).json()).queue;
  assert.equal(after.nowPlaying.id, before.nowPlaying.id);
  assert.equal(after.playing, before.playing);
  assert.deepEqual(after.tracks, before.tracks);
  const selected = results[3];
  const queued = await request('/api/guilds/demo-guild/requests', { method: 'POST', headers, body: JSON.stringify({ query: selected.sourceUrl }) });
  assert.equal(queued.status, 200);
  const result = await queued.json();
  assert.equal(result.added[0].title, selected.title);
  assert.equal(result.added[0].durationSec, selected.durationSec);
  assert.equal(result.added[0].sourceUrl, selected.sourceUrl);
  assert.notEqual(result.added[0].title, results[0].title);
});

test('search validates query bounds and provider before bot dispatch', async t => {
  let searches = 0;
  const bot = createDemoBot();
  bot.search = async () => { ++searches; return { results: [] }; };
  const { request } = await fixture(t, { demo: true, bot });
  const { csrfToken } = await (await request('/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken };
  for (const body of [{ query: '' }, { query: '   ' }, { query: 'x'.repeat(501) }, { query: ['song'] }, { query: 'song', source: 'other' }, { query: 'song', source: ['youtube'] }]) {
    assert.equal((await request('/api/guilds/demo-guild/search', { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal(searches, 0);
});

test('search propagates guild membership denial without exposing search data', async t => {
  const guildId = '123456789012345680';
  const bot = {
    isReady: () => true,
    search: async (id, userId) => {
      assert.equal(id, guildId);
      assert.equal(userId, 'demo-user');
      throw Object.assign(new Error('You must be a member of that server.'), { status: 403 });
    },
  };
  const { request } = await fixture(t, { demo: true, bot });
  const { csrfToken } = await (await request('/api/session')).json();
  const response = await request(`/api/guilds/${guildId}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ query: 'song', source: 'youtube' }) });
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.match(payload.error, /member/);
  assert.equal('results' in payload, false);
});

test('setup mode blocks search even when a supplied bot reports ready', async t => {
  const bot = createDemoBot();
  bot.search = async () => { throw new Error('Search must stay disabled during setup'); };
  const { request } = await fixture(t, { demo: true, setup: true, bot });
  const { csrfToken } = await (await request('/api/session')).json();
  const response = await request('/api/guilds/demo-guild/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ query: 'song', source: 'youtube' }) });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /finishing setup/);
});

test('search rate limit caps provider calls independently of queue requests', async t => {
  let searches = 0;
  const bot = createDemoBot();
  bot.search = async () => { ++searches; return { results: [] }; };
  const { request } = await fixture(t, { demo: true, bot });
  const { csrfToken } = await (await request('/api/session')).json();
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ query: 'song', source: 'youtube' }) };
  for (let index = 0; index < 20; ++index) assert.equal((await request('/api/guilds/demo-guild/search', options)).status, 200);
  assert.equal((await request('/api/guilds/demo-guild/search', options)).status, 429);
  assert.equal(searches, 20);
});

for (const [route, method] of [['search', 'search'], ['requests', 'request']]) {
  test(`closing an HTTP ${route} request cancels provider work`, { timeout: 5000 }, async t => {
    const started = Promise.withResolvers();
    const stopped = Promise.withResolvers();
    const bot = createDemoBot();
    bot[method] = async (...args) => {
      const { signal } = args.at(-1);
      started.resolve();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        stopped.resolve();
        reject(Object.assign(new Error('Cancelled'), { status: 400 }));
      }, { once: true }));
    };
    const { request } = await fixture(t, { demo: true, bot });
    const { csrfToken } = await (await request('/api/session')).json();
    const controller = new AbortController();
    const response = request(`/api/guilds/demo-guild/${route}`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ query: 'A requested song', source: 'youtube' }),
    });
    const rejected = assert.rejects(response, { name: 'AbortError' });
    await started.promise;
    controller.abort();
    await rejected;
    await stopped.promise;
  });
}

async function sessionStorageFixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'turntable-sessions-http-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return () => {
    const store = new FileSessionStorage({ dataDir });
    stores.push(store);
    return store;
  };
}

const persistentSecret = 'test-only-stable-portal-session-secret-32';
const persistentUser = '123456789012345679';
const productionEnv = { NODE_ENV: 'production', PUBLIC_URL: 'https://music.example', SESSION_SECRET: persistentSecret };
const profileProvider = async url => Response.json(url.endsWith('/oauth2/token')
  ? { access_token: 'provider-only-token' } : { id: persistentUser, username: 'Listener', avatar: null });

async function signIn(request) {
  const start = await request('/auth/discord');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  return request('/auth/discord/callback?' + new URLSearchParams({ code: 'test-code', state }));
}

test('persistent login survives portal and storage restarts; logout revokes the saved cookie', async t => {
  const storage = await sessionStorageFixture(t);
  let providerCalls = 0;
  const fetchImpl = url => { providerCalls++; return profileProvider(url); };
  const bot = { isReady: () => true, listGuilds: async id => { assert.equal(id, persistentUser); return []; } };
  const make = cookieValue => fixture(t, { bot, fetchImpl, env: productionEnv, cookieValue,
    store: new EncryptedSessionStore({ storage: storage(), secret: persistentSecret }) });
  const original = await make();
  const login = await signIn(original.request);
  assert.equal(login.headers.get('location'), '/');
  const header = login.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  const expiry = new Date(/Expires=([^;]+)/.exec(header)[1]).getTime();
  assert.ok(expiry - Date.now() > 29 * 24 * 3600000);
  assert.ok(expiry - Date.now() <= 30 * 24 * 3600000);
  const oldCookie = original.cookie();
  const before = await (await original.request('/api/session')).json();
  assert.equal(before.user.id, persistentUser);
  await original.close();

  const restarted = await make(oldCookie);
  const after = await (await restarted.request('/api/session')).json();
  assert.deepEqual(after.user, before.user);
  assert.equal(after.csrfToken, before.csrfToken);
  assert.equal((await restarted.request('/api/guilds')).status, 200);
  assert.equal((await restarted.request('/auth/discord')).headers.get('location'), '/');
  assert.equal(providerCalls, 2, 'A refresh/reconnect must not exchange another OAuth code.');
  const logout = await restarted.request('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': after.csrfToken } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  await restarted.close();

  const replay = await make(oldCookie);
  assert.equal((await replay.request('/api/guilds')).status, 401);
  assert.equal((await (await replay.request('/api/session')).json()).user, null);
});

test('storage outages preserve the browser cookie and static assets skip session storage', async t => {
  const makeStorage = await sessionStorageFixture(t);
  const storage = makeStorage();
  let failed = false;
  let reads = 0;
  let writes = 0;
  const transport = {
    async get(id) { reads++; if (failed) throw new Error('private storage diagnostic'); return storage.get(id); },
    set(id, value) { writes++; return storage.set(id, value); },
    take: id => storage.take(id), destroy: id => storage.destroy(id),
  };
  const { request, cookie } = await fixture(t, { env: productionEnv,
    store: new EncryptedSessionStore({ storage: transport, secret: persistentSecret }) });
  const before = await (await request('/api/session')).json();
  const savedCookie = cookie();
  const counts = { reads, writes };
  for (const url of ['/', '/app.js', '/healthz']) assert.equal((await request(url)).status, 200);
  assert.deepEqual({ reads, writes }, counts);
  assert.equal((await (await request('/api/session')).json()).csrfToken, before.csrfToken);
  assert.equal(writes, counts.writes, 'Polling must not rewrite the durable file.');
  failed = true;
  const unavailable = await request('/api/session');
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('set-cookie'), null);
  assert.equal(cookie(), savedCookie);
  assert.doesNotMatch(JSON.stringify(await unavailable.json()), /private storage diagnostic/);
  failed = false;
  assert.equal((await (await request('/api/session')).json()).csrfToken, before.csrfToken);
});

test('concurrent OAuth callbacks consume one state and only the winner sets a login cookie', async t => {
  const makeStorage = await sessionStorageFixture(t);
  let exchanges = 0;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const fetchImpl = async url => {
    if (url.endsWith('/oauth2/token')) { exchanges++; started.resolve(); await release.promise; }
    return profileProvider(url);
  };
  const { request, cookie } = await fixture(t, { fetchImpl, env: productionEnv,
    store: new EncryptedSessionStore({ storage: makeStorage(), secret: persistentSecret }) });
  const start = await request('/auth/discord');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = '/auth/discord/callback?' + new URLSearchParams({ code: 'one-code', state });
  const headers = { Cookie: cookie() };
  const callbacks = Promise.all([request(callback, { headers }), request(callback, { headers })]);
  await started.promise;
  release.resolve();
  const responses = await callbacks;
  assert.equal(exchanges, 1);
  const success = responses.find(response => response.headers.get('location') === '/');
  const failure = responses.find(response => response.headers.get('location') === '/?error=sign_in_failed');
  assert.ok(success);
  assert.ok(failure);
  assert.ok(success.headers.get('set-cookie'));
  assert.equal(failure.headers.get('set-cookie'), null);
});

test('an unacknowledged login save returns 503 without retrying or issuing an authenticated cookie', async t => {
  const makeStorage = await sessionStorageFixture(t);
  const storage = makeStorage();
  let failed = false;
  let refusedWrites = 0;
  const transport = {
    get: id => storage.get(id), take: id => storage.take(id), destroy: id => storage.destroy(id),
    set(id, value) {
      if (failed) { refusedWrites++; throw new Error('private write failure'); }
      return storage.set(id, value);
    },
  };
  const fetchImpl = async url => {
    const response = await profileProvider(url);
    if (url.endsWith('/users/@me')) failed = true;
    return response;
  };
  const { request, cookie } = await fixture(t, { fetchImpl, env: productionEnv,
    store: new EncryptedSessionStore({ storage: transport, secret: persistentSecret }) });
  const start = await request('/auth/discord');
  const oldCookie = cookie();
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const response = await request('/auth/discord/callback?' + new URLSearchParams({ code: 'test-code', state }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(cookie(), oldCookie);
  assert.equal(refusedWrites, 1);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private write failure/);
  failed = false;
  assert.equal((await request('/api/guilds')).status, 401);
});
