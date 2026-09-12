import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function loadConfig(env = process.env, { demo = false } = {}) {
  const production = env.NODE_ENV === 'production';
  const setupMode = env.SETUP_MODE === 'true';
  const botRole = env.BOT_ROLE || 'combined';
  if (!['combined', 'portal', 'worker'].includes(botRole)) throw new Error('BOT_ROLE must be combined, portal, or worker.');
  if (demo && (production || env.RENDER)) throw new Error('Demo is available only on a local development machine.');
  if (demo && botRole !== 'combined') throw new Error('Demo requires the combined role.');
  if (botRole !== 'combined' && !/^[\x21-\x7e]{32,256}$/.test(env.WORKER_SECRET || '')) throw new Error('WORKER_SECRET must contain 32 to 256 printable characters without spaces.');
  let workerUrl = '';
  if (botRole === 'worker') {
    if (setupMode) throw new Error('Disable SETUP_MODE before starting an audio worker.');
    if (!env.DISCORD_TOKEN || !env.DISCORD_CLIENT_ID) throw new Error('The worker requires DISCORD_TOKEN and DISCORD_CLIENT_ID.');
    let remote;
    try { remote = new URL(env.WORKER_URL); } catch { throw new Error('WORKER_URL must identify the Render portal.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(remote.hostname);
    if (!['https:', 'wss:', ...(local ? ['http:', 'ws:'] : [])].includes(remote.protocol) || remote.username || remote.password || remote.search || remote.hash || !['/', '/internal/worker'].includes(remote.pathname)) {
      throw new Error('WORKER_URL must use a secure portal origin or /internal/worker URL.');
    }
    workerUrl = remote.href;
  }
  const integer = (key, fallback, min, max) => {
    if (!env[key]) return fallback;
    const value = Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    return value;
  };
  const port = integer('PORT', 3000, 1, 65535);
  const workerOrigin = workerUrl ? new URL(workerUrl.replace(/^ws/, 'http')).origin : '';
  const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || workerOrigin || `http://localhost:${port}`).replace(/\/$/, '');
  const parsed = new URL(publicUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('PUBLIC_URL must be a plain http(s) origin without a path.');
  }
  if (production && parsed.protocol !== 'https:') throw new Error('PUBLIC_URL must use HTTPS in production.');
  for (const key of ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'DJ_ROLE_ID']) {
    if (env[key] && !/^\d{17,20}$/.test(env[key])) throw new Error(`${key} must be a Discord ID.`);
  }
  if (production && botRole !== 'worker') {
    if (!setupMode) for (const key of botRole === 'portal' ? ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'] : ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']) {
      if (!env[key]) throw new Error(`${key} is required in production.`);
    }
    if ((env.SESSION_SECRET || '').length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
  }
  if (Boolean(env.SPOTIFY_CLIENT_ID) !== Boolean(env.SPOTIFY_CLIENT_SECRET)) throw new Error('Set both Spotify credentials, or leave both empty.');
  if (env.SPOTIFY_REFRESH_TOKEN && !env.SPOTIFY_CLIENT_ID) throw new Error('Spotify playlist authorization also requires both Spotify app credentials.');
  if (env.SPOTIFY_MARKET && !/^[A-Z]{2}$/.test(env.SPOTIFY_MARKET)) throw new Error('SPOTIFY_MARKET must be a two-letter uppercase country code.');
  const dataDir = path.resolve(env.DATA_DIR || './data');
  return {
    production, demo, setupMode, botRole, workerUrl, workerSecret: env.WORKER_SECRET || '', port, publicUrl: parsed.origin, host: demo ? '127.0.0.1' : '0.0.0.0',
    discordToken: env.DISCORD_TOKEN || '', discordClientId: env.DISCORD_CLIENT_ID || '',
    discordClientSecret: env.DISCORD_CLIENT_SECRET || '', discordGuildId: env.DISCORD_GUILD_ID || '',
    djRoleId: env.DJ_ROLE_ID || '', sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    spotifyClientId: env.SPOTIFY_CLIENT_ID || '', spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET || '',
    spotifyRefreshToken: env.SPOTIFY_REFRESH_TOKEN || '', spotifyMarket: env.SPOTIFY_MARKET || 'US',
    dataDir, ytDlpPath: env.YT_DLP_PATH || 'yt-dlp',
    audioCacheDir: path.resolve(env.AUDIO_CACHE_DIR || path.join(dataDir, '.audio-cache')),
    audioDownloadTimeoutMs: integer('AUDIO_DOWNLOAD_TIMEOUT_MS', 90000, 10000, 120000),
    maxQueueSize: integer('MAX_QUEUE_SIZE', 2000, 1, 2000),
    maxTrackDurationSec: integer('MAX_TRACK_DURATION_SEC', 3600, 30, 14400),
    maxPlaylistTracks: integer('MAX_PLAYLIST_TRACKS', 2000, 1, 2000),
    idleDisconnectMs: integer('IDLE_DISCONNECT_MS', 300000, 10000, 3600000),
  };
}
