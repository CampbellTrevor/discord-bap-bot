import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function loadConfig(env = process.env, { demo = false } = {}) {
  const production = env.NODE_ENV === 'production';
  const setupMode = env.SETUP_MODE === 'true';
  if (demo && (production || env.RENDER)) throw new Error('Demo is available only on a local development machine.');
  const integer = (key, fallback, min, max) => {
    if (!env[key]) return fallback;
    const value = Number(env[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    return value;
  };
  const port = integer('PORT', 3000, 1, 65535);
  const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const parsed = new URL(publicUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('PUBLIC_URL must be a plain http(s) origin without a path.');
  }
  if (production && parsed.protocol !== 'https:') throw new Error('PUBLIC_URL must use HTTPS in production.');
  for (const key of ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'DJ_ROLE_ID']) {
    if (env[key] && !/^\d{17,20}$/.test(env[key])) throw new Error(`${key} must be a Discord ID.`);
  }
  if (production) {
    if (!setupMode) for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']) {
      if (!env[key]) throw new Error(`${key} is required in production.`);
    }
    if ((env.SESSION_SECRET || '').length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
  }
  if (Boolean(env.SPOTIFY_CLIENT_ID) !== Boolean(env.SPOTIFY_CLIENT_SECRET)) throw new Error('Set both Spotify credentials, or leave both empty.');
  if (env.SPOTIFY_REFRESH_TOKEN && !env.SPOTIFY_CLIENT_ID) throw new Error('Spotify playlist authorization also requires both Spotify app credentials.');
  if (env.SPOTIFY_MARKET && !/^[A-Z]{2}$/.test(env.SPOTIFY_MARKET)) throw new Error('SPOTIFY_MARKET must be a two-letter uppercase country code.');
  return {
    production, demo, setupMode, port, publicUrl: parsed.origin, host: demo ? '127.0.0.1' : '0.0.0.0',
    discordToken: env.DISCORD_TOKEN || '', discordClientId: env.DISCORD_CLIENT_ID || '',
    discordClientSecret: env.DISCORD_CLIENT_SECRET || '', discordGuildId: env.DISCORD_GUILD_ID || '',
    djRoleId: env.DJ_ROLE_ID || '', sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    spotifyClientId: env.SPOTIFY_CLIENT_ID || '', spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET || '',
    spotifyRefreshToken: env.SPOTIFY_REFRESH_TOKEN || '', spotifyMarket: env.SPOTIFY_MARKET || 'US',
    dataDir: path.resolve(env.DATA_DIR || './data'), ytDlpPath: env.YT_DLP_PATH || 'yt-dlp',
    maxQueueSize: integer('MAX_QUEUE_SIZE', 100, 1, 1000),
    maxTrackDurationSec: integer('MAX_TRACK_DURATION_SEC', 1800, 30, 14400),
    maxPlaylistTracks: integer('MAX_PLAYLIST_TRACKS', 50, 1, 100),
    idleDisconnectMs: integer('IDLE_DISCONNECT_MS', 300000, 10000, 3600000),
  };
}
