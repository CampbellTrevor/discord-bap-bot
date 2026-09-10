import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';

const CLIENT_ID = '123456789012345678';
const USER_ID = '123456789012345679';
const GUILD_ID = '123456789012345680';
const portalEnv = {
  NODE_ENV: 'production', BOT_ROLE: 'portal', PUBLIC_URL: 'https://portal.example',
  DISCORD_CLIENT_ID: CLIENT_ID, DISCORD_CLIENT_SECRET: 'test-portal-oauth-secret',
  SESSION_SECRET: 'test-portal-session-secret-32-characters',
  WORKER_SECRET: 'test-worker-shared-secret-32-characters',
};
const workerEnv = {
  NODE_ENV: 'production', BOT_ROLE: 'worker', PUBLIC_URL: 'https://portal.example',
  WORKER_URL: 'wss://portal.example/internal/worker', WORKER_SECRET: portalEnv.WORKER_SECRET,
  DISCORD_TOKEN: 'test-worker-discord-token', DISCORD_CLIENT_ID: CLIENT_ID,
};

test('queue defaults support 2,000 total songs and one-hour tracks across roles', () => {
  for (const env of [{}, workerEnv, portalEnv]) {
    const config = loadConfig(env);
    assert.equal(config.maxQueueSize, 2000);
    assert.equal(config.maxTrackDurationSec, 3600);
    assert.equal(config.maxPlaylistTracks, 50);
    assert.equal(loadConfig({ ...env, MAX_QUEUE_SIZE: '2000', MAX_TRACK_DURATION_SEC: '3600' }).maxQueueSize, 2000);
    assert.throws(() => loadConfig({ ...env, MAX_QUEUE_SIZE: '2001' }), /MAX_QUEUE_SIZE/);
  }
});

test('performance API authenticates and forwards the user and guild to worker authorization', async t => {
  let allowed = true;
  const calls = [];
  const bot = { isReady: () => true, performance: async (guild, user) => {
    calls.push([guild, user]);
    if (!allowed) throw Object.assign(new Error('Only a server manager or DJ can view host performance.'), { status: 403 });
    return { version: 1, latest: { hostCpuBusyPct: 9 } };
  } };
  const { request, signIn } = await portalFixture(t, { bot });
  const endpoint = `/api/guilds/${GUILD_ID}/performance`;
  assert.equal((await request(endpoint)).status, 401);
  assert.equal(calls.length, 0);
  await signIn();
  const response = await request(endpoint);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).latest.hostCpuBusyPct, 9);
  assert.deepEqual(calls, [[GUILD_ID, USER_ID]]);
  allowed = false;
  assert.equal((await request(endpoint)).status, 403);
});

async function portalFixture(t, { bot, env = {} } = {}) {
  const config = loadConfig({ ...portalEnv, ...env });
  const fetchImpl = async (url, options) => {
    if (url === 'https://discord.com/api/v10/oauth2/token') {
      assert.equal(options.body.get('client_id'), CLIENT_ID);
      assert.equal(options.body.get('client_secret'), portalEnv.DISCORD_CLIENT_SECRET);
      assert.equal(options.body.get('redirect_uri'), `${config.publicUrl}/auth/discord/callback`);
      return Response.json({ access_token: 'test-provider-access-token' });
    }
    assert.equal(url, 'https://discord.com/api/v10/users/@me');
    assert.equal(options.headers.Authorization, 'Bearer test-provider-access-token');
    return Response.json({ id: USER_ID, username: 'Listener', avatar: null });
  };
  const result = createApp({ config, bot: bot || { isReady: () => true, capabilities: () => ({ spotifyEnabled: false }) }, fetchImpl });
  const server = result.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    result.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  let cookie = '';
  async function request(route, options = {}) {
    // Simulate Render's TLS terminator while keeping this test server local.
    const response = await fetch(origin + route, { ...options, redirect: 'manual', headers: { 'X-Forwarded-Proto': 'https', ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
    const nextCookie = response.headers.get('set-cookie');
    if (nextCookie) cookie = nextCookie.split(';')[0];
    return response;
  }
  async function signIn() {
    const start = await request('/auth/discord');
    assert.equal(start.status, 302);
    assert.match(start.headers.get('set-cookie'), /; Secure/);
    const location = new URL(start.headers.get('location'));
    assert.equal(location.searchParams.get('client_id'), CLIENT_ID);
    const callback = await request('/auth/discord/callback?' + new URLSearchParams({ code: 'test-code', state: location.searchParams.get('state') }));
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/');
    const session = await (await request('/api/session')).json();
    assert.equal(session.user.id, USER_ID);
    return session;
  }
  return { config, request, signIn };
}

test('production portal configuration requires OAuth credentials but no Discord bot token', () => {
  const config = loadConfig(portalEnv);
  assert.equal(config.botRole, 'portal');
  assert.equal(config.production, true);
  assert.equal(config.discordToken, '');
  assert.equal(config.discordClientId, CLIENT_ID);
  assert.equal(config.publicUrl, 'https://portal.example');
  assert.equal(config.workerSecret, portalEnv.WORKER_SECRET);
  for (const key of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET']) {
    assert.throws(() => loadConfig({ ...portalEnv, [key]: '' }), new RegExp(key));
  }
});

test('production worker needs bot identity and bridge credentials without portal OAuth or session secrets', () => {
  const config = loadConfig(workerEnv);
  assert.equal(config.botRole, 'worker');
  assert.equal(config.discordToken, workerEnv.DISCORD_TOKEN);
  assert.equal(config.discordClientSecret, '');
  assert.equal(config.workerUrl, 'wss://portal.example/internal/worker');
  assert.equal(config.publicUrl, 'https://portal.example');
  for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']) {
    assert.throws(() => loadConfig({ ...workerEnv, [key]: '' }), /worker requires DISCORD_TOKEN and DISCORD_CLIENT_ID/);
  }
  assert.throws(() => loadConfig({ ...workerEnv, DISCORD_CLIENT_ID: 'invalid-id' }), /DISCORD_CLIENT_ID/);
});

test('both split roles reject worker secrets that cannot authenticate the bridge', () => {
  for (const env of [portalEnv, workerEnv]) {
    for (const value of ['', 'x'.repeat(31), 'x'.repeat(257), ' '.repeat(32), '\u00e9'.repeat(32), 'x'.repeat(32) + '\n']) assert.throws(() => loadConfig({ ...env, WORKER_SECRET: value }), /WORKER_SECRET/);
    assert.equal(loadConfig({ ...env, WORKER_SECRET: 'x'.repeat(32) }).workerSecret.length, 32);
  }
  assert.equal(loadConfig({}).botRole, 'combined');
  assert.equal(loadConfig({}).workerSecret, '');
});

test('role validation prevents unsupported roles, split demo mode and setup-only workers', () => {
  assert.throws(() => loadConfig({ BOT_ROLE: 'invalid' }), /BOT_ROLE/);
  for (const role of ['portal', 'worker']) assert.throws(() => loadConfig({ BOT_ROLE: role }, { demo: true }), /combined role/);
  assert.throws(() => loadConfig({ ...workerEnv, SETUP_MODE: 'true' }), /SETUP_MODE/);
});

test('worker accepts secure portal URLs and explicit local development connections', () => {
  assert.equal(loadConfig({ ...workerEnv, PUBLIC_URL: '' }).publicUrl, 'https://portal.example');
  for (const url of [
    'https://portal.example', 'https://portal.example/internal/worker',
    'wss://portal.example', 'wss://portal.example/internal/worker',
    'http://localhost:3000', 'ws://127.0.0.1:3000/internal/worker', 'http://[::1]:3000',
  ]) assert.equal(loadConfig({ ...workerEnv, WORKER_URL: url }).workerUrl, new URL(url).href);
});

test('worker URL validation rejects nonsecure remote URLs and credentials, query, fragment or unrelated paths', () => {
  for (const url of [
    '', 'not a URL', 'http://portal.example', 'ws://portal.example', 'ftp://portal.example',
    'https://user:password@portal.example', 'https://portal.example?key=test',
    'https://portal.example/#fragment', 'https://portal.example/unrelated',
    'https://portal.example/internal/worker?secret=test',
  ]) assert.throws(() => loadConfig({ ...workerEnv, WORKER_URL: url }), /WORKER_URL/);
});

test('portal public origin stays HTTPS and cannot contain credentials or routing suffixes', () => {
  for (const url of ['http://portal.example', 'https://user:password@portal.example', 'https://portal.example/path', 'https://portal.example?query=1', 'https://portal.example/#fragment']) {
    assert.throws(() => loadConfig({ ...portalEnv, PUBLIC_URL: url }), /PUBLIC_URL/);
  }
});

test('portal session metadata reflects remote Spotify readiness without local Spotify credentials', async t => {
  let ready = true;
  let spotifyEnabled = true;
  let capabilityCalls = 0;
  const bot = { isReady: () => ready, capabilities: () => { capabilityCalls += 1; return { spotifyEnabled }; } };
  const { request, config } = await portalFixture(t, { bot });
  assert.equal(config.spotifyClientId, '');
  assert.equal(config.spotifyClientSecret, '');
  let session = await (await request('/api/session')).json();
  assert.equal(session.configured, true);
  assert.equal(session.botReady, true);
  assert.equal(session.spotifyEnabled, true);
  spotifyEnabled = false;
  session = await (await request('/api/session')).json();
  assert.equal(session.spotifyEnabled, false);
  const beforeOffline = capabilityCalls;
  ready = false;
  spotifyEnabled = true;
  session = await (await request('/api/session')).json();
  assert.equal(session.configured, true);
  assert.equal(session.botReady, false);
  assert.equal(session.spotifyEnabled, false);
  assert.equal(capabilityCalls, beforeOffline);
  const serialized = JSON.stringify(session);
  for (const secret of [portalEnv.WORKER_SECRET, portalEnv.SESSION_SECRET, portalEnv.DISCORD_CLIENT_SECRET, 'test-provider-access-token']) assert.equal(serialized.includes(secret), false);
});

test('portal local Spotify credentials never override missing remote capabilities', async t => {
  const { request } = await portalFixture(t, { env: { SPOTIFY_CLIENT_ID: 'local-client', SPOTIFY_CLIENT_SECRET: 'local-secret' }, bot: { isReady: () => true, capabilities: () => ({ spotifyEnabled: false }) } });
  assert.equal((await (await request('/api/session')).json()).spotifyEnabled, false);
});

test('portal completes OAuth without a bot token and obtains authenticated details from the remote method', async t => {
  const calls = [];
  const detail = { guild: { id: GUILD_ID, name: 'Remote room' }, member: { canControl: true, canManage: false, voiceChannelId: 'voice' }, voiceChannels: [{ id: 'voice', name: 'Lounge' }], queue: { channelId: 'voice', tracks: [{ title: 'Remote song' }] } };
  const bot = {
    isReady: () => true,
    capabilities: () => ({ spotifyEnabled: true }),
    async listGuilds(userId) { calls.push(['listGuilds', userId]); return [detail.guild]; },
    async detail(guildId, userId) { calls.push(['detail', guildId, userId]); return detail; },
    context: () => assert.fail('Portal must call the authorized remote detail method'),
    snapshot: () => assert.fail('Portal must never request a standalone remote snapshot'),
  };
  const { request, signIn, config } = await portalFixture(t, { bot });
  assert.equal(config.discordToken, '');
  assert.equal((await request(`/api/guilds/${GUILD_ID}`)).status, 401);
  assert.deepEqual(calls, []);
  await signIn();
  const guilds = await request('/api/guilds');
  assert.equal(guilds.status, 200);
  assert.deepEqual((await guilds.json()).guilds, [detail.guild]);
  const response = await request(`/api/guilds/${GUILD_ID}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), detail);
  assert.deepEqual(calls, [['listGuilds', USER_ID], ['detail', GUILD_ID, USER_ID]]);
});

test('portal propagates remote detail membership denial without requesting an unchecked snapshot', async t => {
  let calls = 0;
  const bot = {
    isReady: () => true,
    async detail(guildId, userId) {
      calls += 1;
      assert.equal(guildId, GUILD_ID);
      assert.equal(userId, USER_ID);
      throw Object.assign(new Error('You must be a member of that server.'), { status: 403 });
    },
    snapshot: () => assert.fail('Membership denial must not fall back to a snapshot'),
  };
  const { request, signIn } = await portalFixture(t, { bot });
  await signIn();
  const response = await request(`/api/guilds/${GUILD_ID}`);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'You must be a member of that server.' });
  assert.equal(calls, 1);
});

test('portal refuses server requests while its remote worker is disconnected', async t => {
  let ready = true;
  const bot = { isReady: () => ready, detail: () => assert.fail('Disconnected workers cannot receive requests') };
  const { request, signIn } = await portalFixture(t, { bot });
  await signIn();
  ready = false;
  assert.equal((await request(`/api/guilds/${GUILD_ID}`)).status, 503);
  const session = await (await request('/api/session')).json();
  assert.equal(session.user.id, USER_ID);
  assert.equal(session.configured, true);
  assert.equal(session.botReady, false);
  assert.equal(session.spotifyEnabled, false);
});
