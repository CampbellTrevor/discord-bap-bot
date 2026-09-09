import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID = /^[A-Za-z0-9_-]{10,100}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_PROCESSES = 4;

export class MediaError extends Error {
  constructor(message, code = 'MEDIA_UNAVAILABLE') {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.status = ['INVALID_QUERY', 'UNSUPPORTED_MEDIA', 'INVALID_MEDIA', 'TRACK_TOO_LONG', 'SPOTIFY_NOT_FOUND', 'MEDIA_CANCELLED', 'EMPTY_PLAYLIST'].includes(code) ? 400 : 503;
  }
}

function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new MediaError('The media request was cancelled.', 'MEDIA_CANCELLED');
}

async function withDeadline(signal, milliseconds, callback) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new MediaError('The music provider took too long. Please try again.', 'MEDIA_TIMEOUT')), milliseconds);
  const abort = () => controller.abort(abortReason(signal));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    controller.signal.throwIfAborted();
    return await callback(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function youtubeUrl(id) {
  if (!VIDEO_ID.test(id ?? '')) throw new MediaError('YouTube did not return a valid video.', 'INVALID_MEDIA');
  return `https://www.youtube.com/watch?v=${id}`;
}

function parseQuery(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 500 || /[\u0000-\u001f\u007f]/u.test(input)) {
    throw new MediaError('Enter a song name or YouTube/Spotify track or playlist link (up to 500 characters).', 'INVALID_QUERY');
  }
  const query = input.trim();
  if (query.startsWith('spotify:')) {
    const match = /^spotify:(track|playlist):([A-Za-z0-9]{22})$/.exec(query);
    if (!match) throw new MediaError('Use a Spotify track or playlist link. Albums, artists and podcasts are not supported.', 'UNSUPPORTED_MEDIA');
    return { source: 'spotify', kind: match[1], id: match[2] };
  }
  const bareProvider = /^(?:(?:www\.|m\.|music\.)?youtube\.com|(?:www\.)?youtu\.be|open\.spotify\.com)(?:\/|$)/i.test(query);
  const looksLikeUrl = /^(?:[a-z][a-z0-9+.-]*:\/|\/\/)/i.test(query);
  if (!bareProvider && !looksLikeUrl) return { source: 'search', query };
  let url;
  try { url = new URL(bareProvider ? `https://${query}` : query); }
  catch { throw new MediaError('That link is not a valid YouTube or Spotify track URL.', 'INVALID_QUERY'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new MediaError('Use a public YouTube or Spotify track link.', 'UNSUPPORTED_MEDIA');
  }
  if (YOUTUBE_HOSTS.has(url.hostname)) {
    if (!url.hostname.endsWith('youtu.be') && /^\/playlist\/?$/.test(url.pathname)) {
      const id = url.searchParams.get('list');
      if (!YOUTUBE_PLAYLIST_ID.test(id ?? '')) throw new MediaError('That YouTube playlist ID is invalid.', 'INVALID_QUERY');
      return { source: 'youtube', kind: 'playlist', id, url: `https://www.youtube.com/playlist?list=${id}` };
    }
    let id;
    if (url.hostname.endsWith('youtu.be')) id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
    else if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
    if (!id || !VIDEO_ID.test(id)) throw new MediaError('Use a YouTube video or playlist link. Channels and feeds are not supported.', 'UNSUPPORTED_MEDIA');
    return { source: 'youtube', kind: 'track', url: youtubeUrl(id) };
  }
  if (url.hostname === 'open.spotify.com') {
    const match = /^\/(?:intl-[a-z]{2}\/)?(track|playlist)\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
    if (!match) throw new MediaError('Use a Spotify track or playlist link. Albums, artists and podcasts are not supported.', 'UNSUPPORTED_MEDIA');
    return { source: 'spotify', kind: match[1], id: match[2] };
  }
  throw new MediaError('Only YouTube and Spotify track or playlist links are supported. Paste the full link, or search by song name.', 'UNSUPPORTED_MEDIA');
}

function safeText(value, fallback = '') {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 250) : fallback;
}

function durationSeconds(value, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new MediaError('Live streams and tracks without a known duration cannot be queued.', 'UNSUPPORTED_MEDIA');
  }
  if (value > maximum) throw new MediaError(`This track exceeds the ${Math.ceil(maximum / 60)} minute limit.`, 'TRACK_TOO_LONG');
  return Math.ceil(value);
}

function youtubeFailure(stderr) {
  if (/sign in|login|private|unavailable|not available|403|429|bot|age.restrict|members.only|drm/i.test(stderr)) {
    return new MediaError('YouTube blocked this request or the video is unavailable. Try another public video; this bot cannot access sign-in-only content.', 'YOUTUBE_UNAVAILABLE');
  }
  return new MediaError('YouTube could not provide this track. Try another link or check that yt-dlp is up to date.', 'YOUTUBE_UNAVAILABLE');
}

// The Linux deployment gives every extractor its own process group, including
// its JS runtime. Windows uses taskkill only for this newly spawned process ID.
function terminateProcess(child) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  if (process.platform === 'win32') {
    const killer = nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
    const timer = setTimeout(() => { try { killer.kill(); child.kill('SIGKILL'); } catch {} }, 2000);
    timer.unref?.();
    killer.on('close', () => clearTimeout(timer));
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch {} }
}

/**
 * Spotify supplies metadata only. Playback is an independently selected public
 * YouTube match, and may be a different recording. No Spotify audio is fetched.
 * The caller owns playback lifetime: call cleanup on completion, skip, leave,
 * shutdown, or a discarded open result. Paused playback has no wall-clock limit.
 * Optional dependencies keep provider and subprocess tests offline.
 */
export function createMedia(config = {}, dependencies = {}) {
  const spawn = dependencies.spawn ?? nodeSpawn;
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const terminate = dependencies.terminate ?? terminateProcess;
  const resolveTimeoutMs = dependencies.resolveTimeoutMs ?? 30_000;
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? 45_000;
  const playlistTimeoutMs = dependencies.playlistTimeoutMs ?? 90_000;
  const maxDuration = config.maxTrackDurationSec ?? 1800;
  const maxPlaylistTracks = config.maxPlaylistTracks ?? 50;
  const spotifyMarket = config.spotifyMarket || 'US';
  if (!Number.isFinite(maxDuration) || maxDuration <= 0) throw new Error('maxTrackDurationSec must be a positive number.');
  if (!Number.isInteger(maxPlaylistTracks) || maxPlaylistTracks < 1 || maxPlaylistTracks > 100) throw new Error('maxPlaylistTracks must be an integer from 1 to 100.');
  if (!/^[A-Z]{2}$/.test(spotifyMarket)) throw new Error('spotifyMarket must be a two-letter uppercase country code.');
  let activeProcesses = 0;
  const runningProcesses = new Set();
  let activeResolutions = 0;
  let spotifyToken;
  let spotifyTokenExpires = 0;
  let spotifyUserToken;
  let spotifyUserTokenExpires = 0;
  let spotifyRefreshToken = config.spotifyRefreshToken;
  let spotifyUserAuthInvalid = false;
  let spotifyUserTokenRequest;
  let spotifyRefreshLoaded;
  const spotifyCache = new Map();

  function startExtractor(extraArgs, target, { playlist = false } = {}) {
    if (activeProcesses >= MAX_PROCESSES) throw new MediaError('The music provider is busy. Try again in a moment.', 'MEDIA_BUSY');
    const args = ['--ignore-config', '--no-cache-dir', playlist ? '--yes-playlist' : '--no-playlist', '--no-warnings', '--no-progress', '--no-colors', '--js-runtimes', 'node', '--socket-timeout', '10', '--retries', '1', '--extractor-retries', '1', ...extraArgs, '--', target];
    let child;
    try {
      child = spawn(config.ytDlpPath || 'yt-dlp', args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      throw new MediaError('The audio extractor could not start. Install yt-dlp and its dependencies on the bot host.', 'EXTRACTOR_UNAVAILABLE');
    }
    activeProcesses += 1;
    runningProcesses.add(child);
    let released = false;
    const release = () => { if (!released) { activeProcesses -= 1; runningProcesses.delete(child); released = true; } };
    child.once('close', release);
    child.once('error', release);
    return child;
  }

  function stopExtractor(child) {
    if (runningProcesses.has(child)) terminate(child);
  }

  function extractMetadata(target, signal, { playlist = false } = {}) {
    signal.throwIfAborted();
    const extraArgs = ['--dump-single-json', '--skip-download'];
    // Flat, lazy extraction fetches only bounded playlist metadata, never one
    // full extraction per video. One extra entry detects a truncated playlist.
    if (playlist) extraArgs.push('--flat-playlist', '--lazy-playlist', '--playlist-items', `1:${maxPlaylistTracks + 1}`);
    const child = startExtractor(extraArgs, target, { playlist });
    return new Promise((resolve, reject) => {
      const stdout = [];
      let stderr = '';
      let outputBytes = 0;
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', abort);
        if (error) { stopExtractor(child); reject(error); }
        else resolve(value);
      };
      const abort = () => finish(abortReason(signal));
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES * (playlist ? 4 : 1)) return finish(new MediaError('The provider returned too much metadata.', 'INVALID_MEDIA'));
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
      child.stdout.on('error', () => finish(youtubeFailure(stderr)));
      child.stderr.on('error', () => {});
      child.once('error', () => finish(new MediaError('The audio extractor could not start. Install yt-dlp and its dependencies on the bot host.', 'EXTRACTOR_UNAVAILABLE')));
      child.once('close', code => {
        if (done) return;
        if (code !== 0) return finish(youtubeFailure(stderr));
        try { finish(null, JSON.parse(Buffer.concat(stdout).toString('utf8'))); }
        catch { finish(new MediaError('YouTube returned invalid track metadata.', 'INVALID_MEDIA')); }
      });
      if (signal.aborted) abort();
    });
  }

  function youtubeTrack(info, { flat = false } = {}) {
    if (!info || info.is_live || ['is_live', 'is_upcoming'].includes(info.live_status)) {
      throw new MediaError('No playable recording was found. Live streams cannot be queued.', 'UNSUPPORTED_MEDIA');
    }
    if (info.availability && !['public', 'unlisted'].includes(info.availability)
      || /^\[?(?:private|deleted) video\]?$/i.test(info.title ?? '')
      || info.ie_key && !/^youtube$/i.test(info.ie_key)) {
      throw new MediaError('This YouTube recording is private, deleted or unavailable.', 'UNSUPPORTED_MEDIA');
    }
    const playbackUrl = youtubeUrl(info.id);
    const title = safeText(info.title);
    if (!title) throw new MediaError('YouTube did not return a track title.', 'INVALID_MEDIA');
    return {
      title,
      artist: safeText(info.artist || info.uploader || info.channel, 'YouTube'),
      durationSec: flat && info.duration == null ? null : durationSeconds(info.duration, maxDuration),
      thumbnail: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
      source: 'youtube',
      sourceUrl: playbackUrl,
      playbackUrl,
      ...(flat ? { needsValidation: true } : {}),
    };
  }

  async function resolveYoutube(target, signal) {
    const result = await extractMetadata(target, signal);
    return youtubeTrack(Array.isArray(result?.entries) ? result.entries.find(Boolean) : result);
  }

  function playlistResult(tracks, { source, title, total, inspected, limitReached, warnings = [] }) {
    const skipped = inspected - tracks.length;
    if (skipped) warnings.push(`Skipped ${skipped} unavailable, unsupported, or over-limit playlist ${skipped === 1 ? 'entry' : 'entries'}.`);
    if (limitReached) warnings.push(`Only the first ${inspected} playlist entries were inspected; remaining entries were not imported.`);
    const deferred = tracks.filter(track => track.durationSec == null).length;
    if (deferred) warnings.push(`${deferred} ${deferred === 1 ? 'track has' : 'tracks have'} an unknown duration and will be checked before playback.`);
    const summary = { source, title, total, inspected, accepted: tracks.length, skipped, limitReached, warnings };
    if (!tracks.length) {
      const error = new MediaError(`No playable tracks were found in this playlist${inspected ? ` after inspecting ${inspected} entries` : ''}. ${warnings.join(' ')}`.trim(), 'EMPTY_PLAYLIST');
      error.import = summary;
      throw error;
    }
    Object.defineProperty(tracks, 'import', { value: summary, enumerable: false });
    return tracks;
  }

  async function resolveYoutubePlaylist(url, signal) {
    const result = await extractMetadata(url, signal, { playlist: true });
    if (!Array.isArray(result?.entries)) throw new MediaError('YouTube did not return a readable playlist.', 'INVALID_MEDIA');
    const entries = result.entries.slice(0, maxPlaylistTracks);
    const tracks = [];
    for (const entry of entries) {
      try { tracks.push(youtubeTrack(entry, { flat: true })); }
      catch (error) { if (!(error instanceof MediaError)) throw error; }
    }
    const count = result.playlist_count;
    const knownTotal = Number.isSafeInteger(count) && count >= entries.length ? count : null;
    const limitReached = result.entries.length > maxPlaylistTracks || knownTotal !== null && knownTotal > entries.length;
    return playlistResult(tracks, { source: 'youtube', title: safeText(result.title, 'YouTube playlist'), total: knownTotal ?? (limitReached ? null : entries.length), inspected: entries.length, limitReached });
  }

  async function spotifyJSON(url, options, signal) {
    let response;
    try { response = await fetch(url, { ...options, signal, redirect: 'error' }); }
    catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new MediaError('Spotify could not be reached. Please try again later.', 'SPOTIFY_UNAVAILABLE');
    }
    let data;
    try {
      const reader = response.body?.getReader();
      const chunks = [];
      let bytes = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_OUTPUT_BYTES) { await reader.cancel(); throw new Error('Metadata limit exceeded'); }
          chunks.push(Buffer.from(value));
        }
      }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      if (signal.aborted) throw abortReason(signal);
      throw new MediaError('Spotify returned an invalid response. Please try again later.', 'SPOTIFY_UNAVAILABLE');
    }
    if (response.ok) return data;
    if (response.status === 429) {
      const quota = data?.error?.reason === 'QUOTA_EXCEEDED';
      throw new MediaError(quota ? 'The Spotify developer account has reached its API quota. Please try again later.' : 'Spotify is rate limiting requests. Please try again later.', quota ? 'SPOTIFY_QUOTA_EXCEEDED' : 'SPOTIFY_RATE_LIMITED');
    }
    if (response.status === 400 && url.includes('/api/token') && data?.error === 'invalid_grant') throw new MediaError('Spotify authorization expired or was revoked. The bot owner must run npm run spotify:authorize again and update SPOTIFY_REFRESH_TOKEN.', 'SPOTIFY_REAUTHORIZE');
    if (response.status === 401 || response.status === 400 && url.includes('/api/token')) throw new MediaError('Spotify rejected the app credentials. Check the Spotify client ID and secret.', 'SPOTIFY_UNAUTHORIZED');
    if (response.status === 403) throw new MediaError('Spotify denied access. Check the app credentials, API access, and the app owner’s Spotify Premium subscription.', 'SPOTIFY_FORBIDDEN');
    if (response.status === 404) throw new MediaError('That Spotify item was not found or is not accessible.', 'SPOTIFY_NOT_FOUND');
    throw new MediaError('Spotify could not provide this track. Please try again later.', 'SPOTIFY_UNAVAILABLE');
  }

  async function loadSpotifyRefreshToken() {
    if (!config.dataDir || !config.spotifyRefreshToken) return;
    const file = path.join(config.dataDir, '.spotify-auth.json');
    try {
      if ((await stat(file)).size > 16_384) throw new Error('Auth cache exceeds size limit');
      const saved = JSON.parse(await readFile(file, 'utf8'));
      const configHash = createHash('sha256').update(`${config.spotifyClientId}\0${config.spotifyRefreshToken}`).digest('hex');
      if (saved.configHash === configHash && typeof saved.refreshToken === 'string' && saved.refreshToken.length > 0 && saved.refreshToken.length < 16_000) spotifyRefreshToken = saved.refreshToken;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new MediaError('The Spotify authorization cache cannot be read. Check DATA_DIR or remove its .spotify-auth.json file and authorize Spotify again.', 'SPOTIFY_AUTH_STORAGE');
    }
  }

  async function saveSpotifyRefreshToken(token) {
    if (!config.dataDir) return;
    const file = path.join(config.dataDir, '.spotify-auth.json');
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    const configHash = createHash('sha256').update(`${config.spotifyClientId}\0${config.spotifyRefreshToken}`).digest('hex');
    try {
      await mkdir(config.dataDir, { recursive: true });
      await writeFile(temporary, JSON.stringify({ configHash, refreshToken: token }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } catch {
      throw new MediaError('The refreshed Spotify authorization could not be saved. Check that DATA_DIR is writable, then try again.', 'SPOTIFY_AUTH_STORAGE');
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async function getSpotifyToken(signal, user = false) {
    if (user) {
      if (spotifyUserAuthInvalid) throw new MediaError('Spotify authorization expired or was revoked. The bot owner must run npm run spotify:authorize again and update SPOTIFY_REFRESH_TOKEN.', 'SPOTIFY_REAUTHORIZE');
      if (spotifyUserToken && spotifyUserTokenExpires > Date.now()) return spotifyUserToken;
      if (spotifyUserTokenRequest) return spotifyUserTokenRequest;
      spotifyUserTokenRequest = (async () => {
        spotifyRefreshLoaded ??= loadSpotifyRefreshToken();
        await spotifyRefreshLoaded;
        if (!config.spotifyClientId || !config.spotifyClientSecret || !spotifyRefreshToken) throw new MediaError('Spotify playlist access needs the bot owner to run npm run spotify:authorize and configure Spotify credentials.', 'SPOTIFY_NOT_CONFIGURED');
        let data;
        try {
          data = await spotifyJSON('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { Authorization: `Basic ${Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.spotifyClientId, refresh_token: spotifyRefreshToken }).toString(),
          }, signal);
        } catch (error) {
          if (error.code === 'SPOTIFY_REAUTHORIZE') { spotifyUserAuthInvalid = true; spotifyRefreshToken = undefined; }
          throw error;
        }
        if (typeof data?.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new MediaError('Spotify returned invalid credentials.', 'SPOTIFY_UNAVAILABLE');
        if (typeof data.refresh_token === 'string' && data.refresh_token && data.refresh_token !== spotifyRefreshToken) {
          spotifyRefreshToken = data.refresh_token;
          // Retain the valid rotated credential in memory even if the disk is
          // temporarily unavailable, while reporting that persistence failed.
          await saveSpotifyRefreshToken(spotifyRefreshToken);
        }
        spotifyUserToken = data.access_token;
        spotifyUserTokenExpires = Date.now() + Math.max(0, data.expires_in - 60) * 1000;
        return spotifyUserToken;
      })();
      try { return await spotifyUserTokenRequest; }
      finally { spotifyUserTokenRequest = undefined; }
    }
    if (spotifyToken && spotifyTokenExpires > Date.now()) return spotifyToken;
    if (!config.spotifyClientId || !config.spotifyClientSecret) throw new MediaError('Spotify links are not configured yet. The bot owner needs to add Spotify API credentials.', 'SPOTIFY_NOT_CONFIGURED');
    const data = await spotifyJSON('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    }, signal);
    if (typeof data?.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new MediaError('Spotify returned invalid credentials.', 'SPOTIFY_UNAVAILABLE');
    spotifyToken = data.access_token;
    spotifyTokenExpires = Date.now() + Math.max(0, data.expires_in - 60) * 1000;
    return spotifyToken;
  }

  async function spotifyRequest(endpoint, signal, user = false) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await getSpotifyToken(signal, user);
      try {
        return await spotifyJSON(`https://api.spotify.com/v1/${endpoint}`, { headers: { Authorization: `Bearer ${token}` } }, signal);
      } catch (error) {
        if (error.code !== 'SPOTIFY_UNAUTHORIZED' || attempt !== 0) throw error;
        if (user) { if (spotifyUserToken === token) spotifyUserToken = undefined; }
        else if (spotifyToken === token) spotifyToken = undefined;
      }
    }
  }

  function spotifyTrack(data, id) {
    if (!data || typeof data !== 'object') throw new MediaError('Spotify returned invalid track metadata.', 'INVALID_MEDIA');
    if (!SPOTIFY_ID.test(id ?? '')) throw new MediaError('This Spotify item has no catalog track ID.', 'UNSUPPORTED_MEDIA');
    const title = safeText(data.name);
    const artist = (Array.isArray(data.artists) ? data.artists : []).map(item => safeText(item?.name)).filter(Boolean).join(', ').slice(0, 250);
    if (!title || !artist || data.is_local || data.type && data.type !== 'track') throw new MediaError('This Spotify item is not a supported catalog track.', 'UNSUPPORTED_MEDIA');
    let thumbnail = null;
    for (const item of Array.isArray(data.album?.images) ? data.album.images : []) {
      try {
        const image = new URL(item.url);
        if (image.protocol === 'https:' && image.hostname === 'i.scdn.co' && !image.username && !image.password && !image.port) { thumbnail = image.href; break; }
      } catch {}
    }
    return { title, artist, durationSec: durationSeconds(data.duration_ms / 1000, maxDuration), thumbnail, source: 'spotify', sourceUrl: `https://open.spotify.com/track/${id}`, searchQuery: `${title} ${artist} official audio`.slice(0, 500) };
  }

  async function resolveSpotify(id, signal) {
    if (!SPOTIFY_ID.test(id)) throw new MediaError('That Spotify track ID is invalid.', 'INVALID_QUERY');
    const cached = spotifyCache.get(id);
    if (cached && cached.expires > Date.now()) return { ...cached.track };
    const track = spotifyTrack(await spotifyRequest(`tracks/${id}`, signal), id);
    if (spotifyCache.size >= 200) spotifyCache.delete(spotifyCache.keys().next().value);
    spotifyCache.set(id, { track, expires: Date.now() + 10 * 60_000 });
    return { ...track };
  }

  async function resolveSpotifyPlaylist(id, signal) {
    const user = Boolean(config.spotifyRefreshToken);
    const tracks = [];
    let inspected = 0;
    let total = null;
    let limitReached = false;
    const warnings = [];
    let title = 'Spotify playlist';
    try {
      const info = await spotifyRequest(`playlists/${id}?fields=name`, signal, user);
      title = safeText(info?.name, title);
      let offset = 0;
      for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
        const limit = Math.min(50, maxPlaylistTracks - inspected + 1);
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset), market: spotifyMarket });
        // Never follow provider-supplied pagination URLs. Construct every request
        // from the validated playlist ID and our own bounded numeric offset.
        const page = await spotifyRequest(`playlists/${id}/items?${params}`, signal, user);
        if (!Array.isArray(page?.items) || page.items.length > limit || page.offset !== undefined && page.offset !== offset) throw new MediaError('Spotify returned inconsistent playlist pagination.', 'INVALID_MEDIA');
        if (Number.isSafeInteger(page.total) && page.total >= 0) total = page.total;
        const entries = page.items.slice(0, maxPlaylistTracks - inspected);
        for (const entry of entries) {
          inspected += 1;
          const item = entry?.item !== undefined ? entry.item : entry?.track;
          if (!item || entry.is_local || item.is_local || item.type !== 'track' || item.is_playable === false || item.restrictions?.reason) continue;
          try { tracks.push(spotifyTrack(item, item.id)); }
          catch (error) { if (!(error instanceof MediaError)) throw error; }
        }
        offset += page.items.length;
        const more = page.items.length > entries.length || total !== null && total > inspected || Boolean(page.next);
        if (inspected >= maxPlaylistTracks) { limitReached = more; break; }
        if (!page.items.length) {
          limitReached = more;
          if (more) warnings.push('Spotify returned an incomplete playlist page. Try importing again later.');
          break;
        }
        if (!more) { total ??= inspected; break; }
        if (pageNumber === 4) {
          limitReached = true;
          warnings.push('The Spotify pagination limit was reached; try a smaller playlist.');
        }
      }
    } catch (error) {
      if (!['SPOTIFY_FORBIDDEN', 'SPOTIFY_NOT_FOUND'].includes(error.code)) throw error;
      throw new MediaError(user
        ? 'Spotify cannot read this playlist. Use a playlist owned by or shared for collaboration with the connected Spotify account. If needed, run npm run spotify:authorize again with playlist read permissions.'
        : 'Spotify requires user authorization for this playlist. The bot owner must run npm run spotify:authorize and set SPOTIFY_REFRESH_TOKEN. Current API access is limited to playlists that account owns or collaborates on.', 'SPOTIFY_PLAYLIST_ACCESS');
    }
    return playlistResult(tracks, { source: 'spotify', title, total, inspected, limitReached, warnings });
  }

  async function resolve(query, { signal } = {}) {
    const parsed = parseQuery(query);
    if (activeResolutions >= MAX_PROCESSES) throw new MediaError('The music provider is busy. Try again in a moment.', 'MEDIA_BUSY');
    activeResolutions += 1;
    try {
      return await withDeadline(signal, parsed.kind === 'playlist' ? playlistTimeoutMs : resolveTimeoutMs, async deadline => {
        if (parsed.kind === 'playlist') return parsed.source === 'spotify' ? resolveSpotifyPlaylist(parsed.id, deadline) : resolveYoutubePlaylist(parsed.url, deadline);
        return [parsed.source === 'spotify' ? await resolveSpotify(parsed.id, deadline) : await resolveYoutube(parsed.source === 'youtube' ? parsed.url : `ytsearch1:${parsed.query}`, deadline)];
      });
    } finally { activeResolutions -= 1; }
  }

  function streamYoutube(track, startupSignal, externalSignal) {
    startupSignal.throwIfAborted();
    const child = startExtractor(['--format', 'bestaudio/best', '--output', '-'], track.playbackUrl);
    return new Promise((resolve, reject) => {
      let stderr = '';
      let ready = false;
      let stopped = false;
      const removeStartup = () => { startupSignal.removeEventListener('abort', startupAbort); child.stdout.removeListener('readable', readable); };
      const cleanup = () => {
        if (stopped) return;
        stopped = true;
        removeStartup();
        externalSignal?.removeEventListener('abort', externalAbort);
        stopExtractor(child);
        child.stdout.destroy();
      };
      const fail = error => {
        if (stopped) return;
        if (ready) child.stdout.destroy(error);
        else reject(error);
        cleanup();
      };
      const startupAbort = () => fail(abortReason(startupSignal));
      const externalAbort = () => fail(abortReason(externalSignal));
      const readable = () => {
        if (ready || stopped || child.stdout.readableLength === 0) return;
        ready = true;
        removeStartup();
        resolve({ stream: child.stdout, cleanup });
      };
      startupSignal.addEventListener('abort', startupAbort, { once: true });
      externalSignal?.addEventListener('abort', externalAbort, { once: true });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
      child.stderr.on('error', () => {});
      child.stdout.on('readable', readable);
      child.stdout.on('error', error => { if (!ready) fail(error); });
      child.stdout.once('end', () => { if (!ready) fail(youtubeFailure(stderr)); });
      child.once('error', () => fail(new MediaError('The audio extractor could not start. Install yt-dlp and its dependencies on the bot host.', 'EXTRACTOR_UNAVAILABLE')));
      child.once('close', code => {
        if (stopped) return;
        if (code !== 0 || !ready) fail(youtubeFailure(stderr));
        else {
          externalSignal?.removeEventListener('abort', externalAbort);
          // stdout may still contain buffered bytes: the consumer owns its end.
        }
      });
      if (startupSignal.aborted) startupAbort();
      else if (externalSignal?.aborted) externalAbort();
    });
  }

  async function open(track, { signal } = {}) {
    if (!track || !['youtube', 'spotify'].includes(track.source)) throw new MediaError('This track has an unsupported source.', 'UNSUPPORTED_MEDIA');
    if (!(track.source === 'youtube' && track.needsValidation === true && track.durationSec == null)) durationSeconds(track.durationSec, maxDuration);
    return withDeadline(signal, startupTimeoutMs, async deadline => {
      let playable;
      if (track.source === 'spotify') {
        const parsed = parseQuery(track.sourceUrl);
        if (parsed.source !== 'spotify' || parsed.kind !== 'track') throw new MediaError('This Spotify track link is invalid.', 'INVALID_MEDIA');
        const query = safeText(track.title) + ' ' + safeText(track.artist) + ' official audio';
        playable = await resolveYoutube(`ytsearch1:${query}`, deadline);
      } else {
        const parsed = parseQuery(track.playbackUrl || track.sourceUrl);
        if (parsed.source !== 'youtube' || parsed.kind !== 'track') throw new MediaError('This playback link is not a YouTube video.', 'INVALID_MEDIA');
        playable = track.needsValidation ? { ...await resolveYoutube(parsed.url, deadline), needsValidation: false } : { ...track, playbackUrl: parsed.url };
      }
      const opened = await streamYoutube(playable, deadline, signal);
      return track.source === 'youtube' && track.needsValidation ? { ...opened, track: playable } : opened;
    });
  }

  return { resolve, open };
}
