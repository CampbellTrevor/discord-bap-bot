import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BoundedSessionStore } from './session-store.mjs';

const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const save = req => new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve())).catch(error => {
  // An unacknowledged write must not be retried implicitly while sending an error.
  req.session = null;
  throw error;
});
const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
const takeSession = req => new Promise((resolve, reject) => req.sessionStore.take(req.sessionID, (err, value) => err ? reject(err) : resolve(value)));
const httpError = (message, status) => Object.assign(new Error(message), { status });
const SIGN_IN_LIFETIME = 30 * 24 * 3600000;

async function withClientCancellation(req, res, operation) {
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', abort);
  res.once('close', abort);
  if (req.aborted || res.destroyed) abort();
  try { return await operation(controller.signal); }
  finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
}

export function createApp({ config, bot, fetchImpl = fetch, store = new BoundedSessionStore() }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.production) app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:', 'https://i.ytimg.com', 'https://i.scdn.co', 'https://mosaic.scdn.co', 'https://cdn.discordapp.com'],
    connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
    upgradeInsecureRequests: config.production ? [] : null,
  } } }));
  app.get('/healthz', (_req, res) => res.json({ ok: true, botReady: bot.isReady() }));
  app.use(express.json({ limit: '4kb' }));
  app.use(['/api', '/auth'], (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const limiter = (limit, windowMs) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please wait a moment and try again.' } });
  app.use(['/api', '/auth'], limiter(300, 60000));
  app.use(['/api', '/auth'], session({ name: 'turntable.sid', secret: config.sessionSecret, store, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: 8 * 3600000 } }));
  const configured = !config.setupMode && Boolean(config.discordClientId && config.discordClientSecret && (config.botRole === 'portal' || config.discordToken));
  const csrf = (req, _res, next) => {
    if (req.get('origin') && req.get('origin') !== config.publicUrl) return next(httpError('Request origin did not match this portal.', 403));
    if (!equal(req.session.csrfToken, req.get('x-csrf-token'))) return next(httpError('Your session changed. Refresh the page and try again.', 403));
    next();
  };
  app.get('/api/session', async (req, res) => {
    const needsSave = !req.session.csrfToken || (config.demo && !req.session.user);
    req.session.csrfToken ||= randomBytes(32).toString('hex');
    if (config.demo) req.session.user ||= { id: 'demo-user', username: 'You', avatar: null };
    if (needsSave) await save(req);
    res.json({ user: req.session.user || null, csrfToken: req.session.csrfToken, configured, botReady: !config.setupMode && bot.isReady(), demo: config.demo,
      spotifyEnabled: config.botRole === 'portal' ? Boolean(bot.isReady() && bot.capabilities?.().spotifyEnabled) : Boolean(config.spotifyClientId && config.spotifyClientSecret),
      inviteUrl: config.discordClientId ? `https://discord.com/oauth2/authorize?client_id=${config.discordClientId}&scope=bot%20applications.commands&permissions=36703232` : null });
  });
  app.use('/auth', limiter(20, 60000));
  app.get('/auth/discord', async (req, res) => {
    if (!configured || config.demo) throw httpError('Discord sign-in is not configured yet.', 503);
    if (req.session.user) return res.redirect('/');
    req.session.oauthState = randomBytes(32).toString('hex');
    req.session.oauthStartedAt = Date.now();
    await save(req);
    const params = new URLSearchParams({ client_id: config.discordClientId, response_type: 'code', scope: 'identify',
      redirect_uri: `${config.publicUrl}/auth/discord/callback`, state: req.session.oauthState });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });
  app.get('/auth/discord/callback', async (req, res) => {
    if (!configured || !req.session.oauthState) return res.redirect('/?error=sign_in_failed');
    // Consume the stored anonymous session atomically, so concurrent callbacks
    // cannot both exchange a code. Never save the old snapshot back afterward.
    const previous = await takeSession(req);
    await regenerate(req);
    const stateAge = Date.now() - previous?.oauthStartedAt;
    const stateValid = equal(previous?.oauthState, req.query.state) && Number.isFinite(stateAge) && stateAge >= 0 && stateAge < 10 * 60000;
    if (!stateValid || typeof req.query.code !== 'string' || req.query.code.length > 2048) return res.redirect('/?error=sign_in_failed');
    try {
      const tokenResponse = await fetchImpl('https://discord.com/api/v10/oauth2/token', { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.discordClientId, client_secret: config.discordClientSecret, grant_type: 'authorization_code',
          code: req.query.code, redirect_uri: `${config.publicUrl}/auth/discord/callback` }) });
      if (!tokenResponse.ok) throw new Error('Token exchange rejected');
      const token = await tokenResponse.json();
      if (typeof token.access_token !== 'string') throw new Error('Missing token');
      const profileResponse = await fetchImpl('https://discord.com/api/v10/users/@me', { signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token.access_token}` } });
      if (!profileResponse.ok) throw new Error('Profile request rejected');
      const profile = await profileResponse.json();
      if (!/^\d{17,20}$/.test(profile.id) || typeof profile.username !== 'string') throw new Error('Invalid profile');
      req.session.user = { id: profile.id, username: profile.global_name || profile.username,
        avatar: /^[a-zA-Z0-9_]+$/.test(profile.avatar || '') ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=64` : null };
      req.session.csrfToken = randomBytes(32).toString('hex');
      req.session.cookie.maxAge = SIGN_IN_LIFETIME;
      await save(req);
      res.redirect('/');
    } catch (error) {
      req.session = null;
      if (error?.status === 503) throw error;
      res.redirect('/?error=sign_in_failed');
    }
  });
  app.post('/auth/logout', csrf, (req, res, next) => req.session.destroy(err => {
    if (err) return next(err);
    res.clearCookie('turntable.sid', { httpOnly: true, sameSite: 'lax', secure: config.production }).json({ ok: true });
  }));
  app.use('/api', (req, _res, next) => {
    if (!req.session.user) return next(httpError('Sign in with Discord to open your server queue.', 401));
    if (config.setupMode) return next(httpError('The bot owner is finishing setup. Song requests will be available shortly.', 503));
    if (!bot.isReady()) return next(httpError('The bot is connecting to Discord. Please try again shortly.', 503));
    next();
  });
  app.get('/api/guilds', async (req, res) => res.json({ guilds: await bot.listGuilds(req.session.user.id) }));
  app.param('guildId', (req, _res, next, id) => {
    if (!(config.demo && id === 'demo-guild') && !/^\d{17,20}$/.test(id)) return next(httpError('Invalid server.', 400));
    next();
  });
  app.get('/api/guilds/:guildId', async (req, res) => {
    const { guildId } = req.params;
    const userId = req.session.user.id;
    const detail = bot.detail ? await bot.detail(guildId, userId) : { ...await bot.context(guildId, userId), queue: await bot.snapshot(guildId) };
    res.json(detail);
  });
  app.get('/api/guilds/:guildId/performance', limiter(20, 60000), async (req, res) => {
    if (!bot.performance) throw httpError('Host performance is temporarily unavailable.', 503);
    res.json(await bot.performance(req.params.guildId, req.session.user.id));
  });
  app.post('/api/guilds/:guildId/search', csrf, limiter(20, 60000), async (req, res) => {
    const { query, source = 'youtube' } = req.body || {};
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw httpError('Enter a song or artist to search, up to 500 characters.', 400);
    if (!['youtube', 'spotify'].includes(source)) throw httpError('Choose YouTube or Spotify for search.', 400);
    res.json(await withClientCancellation(req, res, signal => bot.search(req.params.guildId, req.session.user.id, query.trim(), source, { signal })));
  });
  const requestLimit = limiter(10, 60000);
  app.post('/api/guilds/:guildId/requests', csrf, requestLimit, async (req, res) => {
    const { query, channelId } = req.body || {};
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw httpError('Enter a song title or link, up to 500 characters.', 400);
    if (channelId !== undefined && typeof channelId !== 'string') throw httpError('Choose a voice channel.', 400);
    const result = await withClientCancellation(req, res, signal => bot.request(req.params.guildId, req.session.user.id, query.trim(), channelId, { signal }));
    res.json(result.queue ? result : { queue: result });
  });
  app.post('/api/guilds/:guildId/join', csrf, requestLimit, async (req, res) => {
    const { channelId } = req.body || {};
    if (typeof channelId !== 'string' || !channelId) throw httpError('Choose a voice channel.', 400);
    res.json({ queue: await bot.join(req.params.guildId, req.session.user.id, channelId) });
  });
  app.post('/api/guilds/:guildId/control', csrf, limiter(30, 60000), async (req, res) => {
    const { action, trackId } = req.body || {};
    if (!['skip', 'pause', 'resume', 'stop', 'leave', 'remove', 'shuffle', 'move-top'].includes(action)) throw httpError('Unknown playback control.', 400);
    if (['remove', 'move-top'].includes(action) && (typeof trackId !== 'string' || !trackId || trackId.length > 100)) throw httpError('Choose a queued song.', 400);
    res.json({ queue: await bot.control(req.params.guildId, req.session.user.id, action, trackId) });
  });
  app.use('/api', (_req, _res, next) => next(httpError('API route not found.', 404)));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), {
    maxAge: config.production ? '5m' : 0,
    setHeaders: (res, file) => { if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache'); },
  }));
  app.use((error, _req, res, _next) => {
    if (res.destroyed) return;
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    if (status === 500) console.error('Request failed:', error.name);
    const message = error.type === 'entity.parse.failed' ? 'Invalid JSON request.' : status < 500 || error.status === 503 ? error.message : 'Something went wrong. Please try again.';
    res.status(status).json({ error: message });
  });
  return { app, close: () => store.close?.() };
}
