import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { createDemoBot } from '../src/demo.mjs';
import { BoundedSessionStore } from '../src/session-store.mjs';

async function fixture(t, { demo = false, setup = false, bot = createDemoBot(), fetchImpl } = {}) {
  const config = loadConfig({ DISCORD_TOKEN: 'test-token', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'test-secret', SETUP_MODE: String(setup) }, { demo });
  const result = createApp({ config, bot, fetchImpl });
  const server = result.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  config.publicUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { result.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let cookie = '';
  async function request(path, options = {}) {
    const response = await fetch(config.publicUrl + path, { ...options, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
    const nextCookie = response.headers.get('set-cookie');
    if (nextCookie) cookie = nextCookie.split(';')[0];
    return response;
  }
  return { request, config, cookie: () => cookie };
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
