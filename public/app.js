'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  session: null,
  guilds: [],
  guildId: '',
  detail: null,
  busy: false,
  polling: false,
  offline: false,
  sampleTime: Date.now(),
  queueSignature: '',
  detailRevision: 0,
  pollCount: 0,
  feedbackTimer: null,
};

function savedGuild() {
  try { return localStorage.getItem('turntable.guild') || ''; } catch { return ''; }
}

function saveGuild(id) {
  try { localStorage.setItem('turntable.guild', id); } catch { /* Storage is optional. */ }
}

function updateThemeColor() {
  const root = document.documentElement;
  const color = document.querySelector('meta[name="theme-color"]');
  if (color) color.content = root.dataset.theme === 'winamp' ? '#354149' : root.dataset.cassetteMode === 'dark' ? '#1f201d' : '#eee7d8';
}

function setCassetteMode(value, save = true) {
  const mode = value === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.cassetteMode = mode;
  $('cassette-mode-toggle')?.setAttribute('aria-pressed', String(mode === 'dark'));
  updateThemeColor();
  if (save) try { localStorage.setItem('turntable-cassette-mode', mode); } catch { /* Storage is optional. */ }
}

function setTheme(value, save = true) {
  const theme = value === 'winamp' ? 'winamp' : 'cassette';
  document.documentElement.dataset.theme = theme;
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
  }
  updateThemeColor();
  if (save) try { localStorage.setItem('turntable-theme', theme); } catch { /* Storage is optional. */ }
}

function safeUrl(value, allowedHosts) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (allowedHosts && !allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    return url.href;
  } catch { return null; }
}

function imageUrl(value) {
  return safeUrl(value, ['ytimg.com', 'img.youtube.com', 'scdn.co', 'spotifycdn.com']);
}

function duration(value) {
  if (value == null || !Number.isFinite(Number(value))) return '--:--';
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

function showFeedback(message, isError = false, persist = false) {
  clearTimeout(state.feedbackTimer);
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', isError);
  $('feedback').hidden = false;
  if (!persist) state.feedbackTimer = setTimeout(() => { $('feedback').hidden = true; }, isError ? 12000 : 6500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(120000),
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': state.session?.csrfToken || '' } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `The request could not be completed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function appendText(parent, tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

function renderAuth() {
  const session = state.session;
  const container = $('auth-container');
  container.replaceChildren();
  if (session?.user) {
    const profile = document.createElement('div');
    profile.className = 'auth-profile';
    const avatar = safeUrl(session.user.avatar, ['cdn.discordapp.com', 'media.discordapp.net']);
    if (avatar) {
      const image = document.createElement('img');
      image.className = 'avatar';
      image.alt = '';
      image.src = avatar;
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => {
        const initials = document.createElement('span');
        initials.className = 'avatar';
        initials.textContent = (session.user.username || 'You').slice(0, 2).toUpperCase();
        image.replaceWith(initials);
      }, { once: true });
      profile.append(image);
    } else appendText(profile, 'span', 'avatar', (session.user.username || 'You').slice(0, 2).toUpperCase());
    const profileText = document.createElement('div');
    profileText.className = 'auth-profile-text';
    appendText(profileText, 'span', 'auth-profile-name', session.user.username || 'Connected');
    if (session.demo) {
      appendText(profileText, 'span', 'auth-profile-mode', 'Demo guest');
    } else {
      const logout = appendText(profileText, 'button', 'text-button', 'Sign out');
      logout.type = 'button';
      logout.addEventListener('click', async () => {
        logout.disabled = true;
        try {
          await api('/auth/logout', { method: 'POST' });
          window.location.assign('/');
        } catch (error) {
          logout.disabled = false;
          showFeedback(error.message, true);
        }
      });
    }
    profile.append(profileText);
    container.append(profile);
  } else if (session?.configured) {
    const login = appendText(container, 'a', 'small-button button-discord', 'Connect Discord ↗');
    login.href = '/auth/discord';
  } else {
    const login = appendText(container, 'button', 'small-button button-discord', 'Connect Discord ↗');
    login.type = 'button';
    login.disabled = true;
    login.title = 'Discord sign-in is available after server configuration.';
  }
}

function renderSession() {
  const session = state.session;
  $('demo-badge').hidden = !session?.demo;
  const invite = safeUrl(session?.inviteUrl, ['discord.com']);
  $('invite-link').hidden = !invite || !session?.configured;
  if (invite) $('invite-link').href = invite;
  const dot = $('status-dot');
  const connected = session?.botReady && !state.offline;
  dot.classList.toggle('online', Boolean(connected));
  dot.classList.toggle('offline', Boolean(state.offline || (session?.configured && !connected)));
  $('connection-status').textContent = state.offline ? 'CONNECTION INTERRUPTED · RETRYING' : session?.demo ? 'LOCAL DEMO · NO AUDIO' : connected ? 'DISCORD CONNECTED' : session?.configured ? 'BOT OFFLINE' : 'SETUP IN PROGRESS';

  const notice = $('setup-notice');
  notice.hidden = true;
  if (session && !session.configured && !session.demo) {
    notice.hidden = false;
    $('notice-title').textContent = 'The bot owner is finishing setup.';
    $('notice-description').textContent = 'Discord sign-in and song requests are disabled. You can switch player styles while setup is completed.';
  } else if (session?.configured && !session.botReady && !session.demo) {
    notice.hidden = false;
    $('notice-title').textContent = 'The bot is currently offline.';
    $('notice-description').textContent = 'Song requests and playback controls will become available when the Discord connection is ready. This page checks automatically.';
  } else if (session?.user && state.guilds.length === 0) {
    notice.hidden = false;
    $('notice-title').textContent = 'No shared servers found.';
    $('notice-description').textContent = 'Add Turntable to a Discord server you belong to, then refresh this page to find it here.';
  }
  $('request-hint').textContent = session?.demo ? 'Local demo: requests do not play audio.' : session && !session.configured ? 'Song and playlist requests will be available after setup.' : session && !session.spotifyEnabled ? 'YouTube songs and playlists supported. Spotify requires server credentials.' : 'Spotify and YouTube songs or playlists. Imports join the end of the queue.';
  renderPlayer();
  renderEnabled();
}

function renderGuildSelect() {
  const select = $('guild-select');
  select.replaceChildren();
  if (!state.guilds.length) {
    select.append(new Option(state.session?.user ? 'No shared servers yet' : 'Select a server', ''));
  } else {
    for (const guild of state.guilds) select.append(new Option(guild.name, guild.id));
    select.value = state.guildId;
  }
  select.disabled = state.guilds.length < 1 || state.busy;
}

function renderChannels() {
  const select = $('channel-select');
  const oldValue = select.value;
  const channels = state.detail?.voiceChannels || [];
  const signature = JSON.stringify(channels);
  if (select.dataset.signature !== signature) {
    select.replaceChildren(new Option('Select a voice channel', ''));
    for (const channel of channels) select.append(new Option(channel.name, channel.id));
    select.dataset.signature = signature;
  }
  const preferences = [oldValue, state.detail?.queue?.channelId, state.detail?.member?.voiceChannelId];
  const selected = preferences.find((id) => id && channels.some((channel) => channel.id === id));
  select.value = selected || '';
  const channelId = state.detail?.queue?.channelId;
  const channelName = state.detail?.queue?.channelName || channels.find((channel) => channel.id === channelId)?.name;
  $('voice-status').textContent = channelId ? `Connected to ${channelName || 'voice'}` : channels.length ? 'Choose where to listen.' : state.session?.user ? 'No available voice channels.' : 'Connect Discord to find your channels.';
  $('voice-connected-dot').hidden = !channelId;
  $('join-button').textContent = channelId ? (select.value && select.value !== channelId ? 'Move' : 'Joined') : 'Join';
  $('leave-button').hidden = !channelId;
  renderEnabled();
}

function renderEnabled() {
  const connected = Boolean(state.session?.user && (state.session.configured || state.session.demo) && state.session.botReady && !state.busy && !state.offline);
  const ready = Boolean(connected && state.guildId && state.detail);
  const queue = state.detail?.queue;
  const canControl = ready && Boolean(state.detail?.member?.canControl);
  $('request-query').disabled = !ready;
  $('request-button').disabled = !ready;
  $('guild-select').disabled = !connected || state.guilds.length < 1;
  $('channel-select').disabled = !ready || !(state.detail?.voiceChannels?.length);
  $('join-button').disabled = !ready || !$('channel-select').value || queue?.channelId === $('channel-select').value;
  $('leave-button').disabled = !canControl;
  $('pause-button').disabled = !canControl || !queue?.nowPlaying;
  $('skip-button').disabled = !canControl || !queue?.nowPlaying;
  $('stop-button').disabled = !canControl || (!queue?.nowPlaying && !queue?.tracks?.length);
  $('shuffle-button').disabled = !canControl || (queue?.tracks?.length || 0) < 2;
  for (const button of $('queue-list').querySelectorAll('button')) button.disabled = !ready;
}

function renderPlayer() {
  const queue = state.detail?.queue;
  const track = queue?.nowPlaying;
  $('now-title').textContent = track?.title || 'No track loaded';
  $('now-artist').textContent = track?.artist || (track ? 'Unknown artist' : 'Request a song to get started.');
  $('now-requester').textContent = track?.requestedBy?.username ? `REQUESTED BY ${track.requestedBy.username}` : 'AUTO QUEUE / ON';
  const sourceUrl = safeUrl(track?.sourceUrl, ['youtube.com', 'youtu.be', 'open.spotify.com']);
  $('now-link').hidden = !sourceUrl;
  if (sourceUrl) $('now-link').href = sourceUrl;
  const thumbnail = imageUrl(track?.thumbnail);
  const art = $('now-art');
  if (thumbnail && art.dataset.source !== thumbnail) {
    art.dataset.source = thumbnail;
    art.hidden = false;
    art.src = thumbnail;
  } else if (!thumbnail) {
    art.hidden = true;
    art.removeAttribute('src');
    art.dataset.source = '';
  }
  $('record-scene').hidden = Boolean(thumbnail && !art.hidden);
  const status = state.offline || (state.session?.configured && !state.session.botReady) ? 'OFFLINE' : track ? queue.paused ? 'PAUSED' : queue.playing ? 'PLAYING' : 'LOADING' : 'STANDBY';
  $('player-status').textContent = status;
  $('screen-status').textContent = status;
  $('screen-source').textContent = track ? track.source === 'spotify' ? 'SPOTIFY' : 'YOUTUBE' : 'DISCORD VOICE';
  $('output-status').textContent = queue?.channelId && !state.offline && state.session?.botReady ? 'CONNECTED' : 'DISCONNECTED';
  document.body.classList.toggle('is-paused', Boolean(queue?.paused));
  document.body.classList.toggle('is-idle', !queue?.playing || state.offline || !state.session?.botReady);
  $('player-status').classList.toggle('active', Boolean(track && !queue.paused && !state.offline && state.session?.botReady));
  const pauseLabel = queue?.paused ? 'Resume playback' : 'Pause playback';
  $('pause-button').setAttribute('aria-label', pauseLabel);
  $('pause-button').title = pauseLabel;
  $('pause-icon').textContent = queue?.paused ? '▶' : 'Ⅱ';
  $('pause-label').textContent = queue?.paused ? 'PLAY' : 'PAUSE';
  $('controls-help').textContent = state.session?.demo ? 'Demo controls only. No audio is playing.' : !state.session?.user ? 'Connect Discord to use playback controls.' : !queue?.channelId ? 'Join a voice channel to start playback.' : !state.detail?.member?.canControl ? 'Join the bot’s voice channel to control playback, or ask a DJ.' : 'Controls affect everyone listening in this voice channel.';
  renderProgress();
}

function renderProgress() {
  const queue = state.detail?.queue;
  const track = queue?.nowPlaying;
  const total = Number(track?.durationSec) || 0;
  const elapsedSinceSample = queue?.playing && !queue.paused && !state.offline && state.session?.botReady ? (Date.now() - state.sampleTime) / 1000 : 0;
  const elapsed = track ? Math.max(0, (Number(queue?.elapsedSec) || 0) + elapsedSinceSample) : 0;
  const boundedElapsed = total > 0 ? Math.min(elapsed, total) : elapsed;
  const percent = total > 0 ? Math.min(100, boundedElapsed / total * 100) : 0;
  $('elapsed-time').textContent = duration(boundedElapsed);
  $('screen-elapsed').textContent = duration(boundedElapsed);
  const totalText = duration(track ? track.durationSec : 0);
  $('total-time').textContent = totalText;
  $('cassette-total').textContent = totalText;
  $('progress-fill').style.width = `${percent}%`;
  $('progress-track').setAttribute('aria-valuenow', String(Math.round(percent)));
  $('progress-track').setAttribute('aria-valuetext', `${duration(boundedElapsed)} elapsed${totalText === '--:--' ? '; duration unknown' : ` of ${totalText}`}`);
}

function renderQueue() {
  const tracks = state.detail?.queue?.tracks || [];
  $('queue-count').textContent = String(tracks.length).padStart(2, '0');
  const seconds = tracks.reduce((sum, track) => sum + (Number(track.durationSec) || 0), 0);
  $('queue-duration').textContent = tracks.some(track => track.durationSec == null) ? '--:--' : duration(seconds);
  $('queue-duration').title = tracks.some(track => track.durationSec == null) ? 'Some track durations will be checked before playback.' : 'Total duration of upcoming tracks';
  $('queue-empty').hidden = tracks.length > 0;
  $('queue-list').hidden = !tracks.length;
  $('queue-note').hidden = !tracks.length;
  $('queue-empty-copy').textContent = !state.session?.user ? 'Connect Discord, select your server, and add a song.' : !state.guildId ? 'Add Turntable to a Discord server you belong to.' : state.detail?.queue?.nowPlaying ? 'No tracks waiting. Request the next song above.' : 'Paste a song or playlist link above, or search by name.';
  const signature = JSON.stringify([tracks, state.session?.user?.id, state.detail?.member?.canManage]);
  if (signature === state.queueSignature) return;
  state.queueSignature = signature;
  const list = $('queue-list');
  list.replaceChildren();
  for (const [index, track] of tracks.entries()) {
    const item = document.createElement('li');
    item.className = 'queue-item';
    appendText(item, 'span', 'queue-index', String(index + 1).padStart(2, '0'));
    const copy = document.createElement('div');
    copy.className = 'queue-item-copy';
    const title = appendText(copy, 'p', 'queue-item-title', track.title || 'Untitled track');
    title.title = track.title || 'Untitled track';
    appendText(copy, 'span', 'queue-item-artist', track.artist || 'Unknown artist');
    item.append(copy);
    const requester = appendText(item, 'div', 'queue-item-requester', '');
    const person = appendText(requester, 'span', 'queue-item-person', track.requestedBy?.username || 'Listener');
    person.title = `Requested by ${track.requestedBy?.username || 'a listener'}`;
    appendText(requester, 'span', 'queue-item-source', track.source === 'spotify' ? 'Spotify' : 'YouTube');
    appendText(item, 'span', 'queue-item-duration', duration(track.durationSec));
    if (state.detail?.member?.canManage || track.requestedBy?.id === state.session?.user?.id) {
      const remove = appendText(item, 'button', 'queue-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${track.title || 'track'} from queue`);
      remove.title = 'Remove from queue';
      remove.addEventListener('click', () => mutate('control', { action: 'remove', trackId: track.id }, 'Song removed from the queue.'));
    } else appendText(item, 'span', '', '');
    list.append(item);
  }
}

function renderDetail() {
  renderChannels();
  renderPlayer();
  renderQueue();
  renderEnabled();
}

async function loadDetail({ silent = false } = {}) {
  if (!state.guildId || !state.session?.user) return;
  const guildId = state.guildId;
  const revision = ++state.detailRevision;
  const detail = await api(`/api/guilds/${encodeURIComponent(guildId)}`);
  if (guildId !== state.guildId || revision !== state.detailRevision) return;
  const oldError = state.detail?.queue?.lastError;
  state.detail = detail;
  state.sampleTime = Date.now();
  state.offline = false;
  renderSession();
  renderDetail();
  if (detail.queue?.lastError && detail.queue.lastError !== oldError && !silent) showFeedback(detail.queue.lastError, true);
}

async function initialize() {
  try {
    const session = await api('/api/session');
    const changedUser = state.session?.user?.id !== session.user?.id;
    state.session = session;
    state.offline = false;
    renderAuth();
    if (session.user && session.botReady) {
      const payload = await api('/api/guilds');
      state.guilds = Array.isArray(payload.guilds) ? payload.guilds : [];
      const previousGuildId = state.guildId;
      const preferredGuild = state.guildId || savedGuild();
      state.guildId = state.guilds.some((guild) => guild.id === preferredGuild) ? preferredGuild : state.guilds[0]?.id || '';
      if (changedUser || state.guildId !== previousGuildId) state.detail = null;
    } else if (!session.user) {
      state.guilds = [];
      state.guildId = '';
      state.detail = null;
    }
    renderGuildSelect();
    renderSession();
    renderDetail();
    if (state.guildId && session.botReady) await loadDetail();
  } catch (error) {
    state.offline = true;
    renderSession();
    showFeedback(error.status === 401 ? 'Session expired. Sign in again.' : 'Connection lost. Retrying…', true, true);
  }
}

async function mutate(endpoint, body, successMessage) {
  if (state.busy || state.offline || !state.guildId || !state.session?.user || !state.session.botReady || (!state.session.configured && !state.session.demo)) return false;
  state.busy = true;
  state.detailRevision += 1;
  renderEnabled();
  try {
    const result = await api(`/api/guilds/${encodeURIComponent(state.guildId)}/${endpoint}`, { method: 'POST', body: JSON.stringify(body) });
    if (result.queue && state.detail) {
      state.detail.queue = result.queue;
      state.sampleTime = Date.now();
      renderDetail();
    }
    showFeedback(typeof successMessage === 'function' ? successMessage(result) : successMessage);
    await loadDetail({ silent: true }).catch(() => { /* The normal polling loop retries an updated snapshot. */ });
    return true;
  } catch (error) {
    showFeedback(error.message || 'That request did not go through. Please try again.', true);
    if (error.status === 401) await initialize();
    return false;
  } finally {
    state.busy = false;
    renderEnabled();
  }
}

function requestMessage(result) {
  const count = Array.isArray(result.added) ? result.added.length : result.import?.accepted;
  const messages = [count == null ? 'Request added to the queue.' : `Added ${count} ${count === 1 ? 'track' : 'tracks'} to ${state.session?.demo ? 'the demo' : 'the'} queue.`];
  const details = result.import;
  const warnings = [...new Set((result.warnings || details?.warnings || []).filter(value => typeof value === 'string'))];
  if (details?.skipped && !warnings.some(value => /skipp/i.test(value))) messages.push(`${details.skipped} playlist entries were skipped.`);
  if (details?.limitReached && !warnings.some(value => /first|limit|remaining/i.test(value))) messages.push(`Only the first ${details.inspected} playlist entries were inspected.`);
  messages.push(...warnings);
  if (state.session?.demo) messages.push('No audio will play.');
  return messages.join(' ');
}

$('request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('request-query').value.trim();
  if (!query || state.busy) return;
  if (!state.session?.demo && !state.session?.spotifyEnabled && /^(?:spotify:|(?:https?:\/\/)?(?:open\.)?spotify\.com\/)/i.test(query)) {
    showFeedback('Spotify requests need Spotify credentials on the bot server. You can request a YouTube song or playlist now.', true);
    return;
  }
  const label = $('request-button').querySelector('span');
  label.textContent = 'IMPORTING…';
  $('request-form').setAttribute('aria-busy', 'true');
  const channelId = state.detail?.queue?.channelId || $('channel-select').value;
  const success = await mutate('requests', { query, ...(channelId ? { channelId } : {}) }, requestMessage);
  if (success) $('request-query').value = '';
  label.textContent = '+ REQUEST';
  $('request-form').setAttribute('aria-busy', 'false');
  if (success) $('request-query').focus();
});

$('guild-select').addEventListener('change', async () => {
  state.guildId = $('guild-select').value;
  saveGuild(state.guildId);
  state.detailRevision += 1;
  state.detail = null;
  $('channel-select').value = '';
  renderDetail();
  try { await loadDetail(); } catch (error) { showFeedback(error.message, true); }
});
$('channel-select').addEventListener('change', renderChannels);
$('join-button').addEventListener('click', () => mutate('join', { channelId: $('channel-select').value }, 'Connected to voice.'));
$('leave-button').addEventListener('click', () => mutate('control', { action: 'leave' }, 'Disconnected from the voice channel.'));
$('pause-button').addEventListener('click', () => {
  const action = state.detail?.queue?.paused ? 'resume' : 'pause';
  return mutate('control', { action }, action === 'resume' ? 'Playback resumed.' : 'Playback paused.');
});
$('skip-button').addEventListener('click', () => mutate('control', { action: 'skip' }, 'Skipped the current track.'));
$('stop-button').addEventListener('click', () => mutate('control', { action: 'stop' }, 'Playback stopped and the queue cleared.'));
$('shuffle-button').addEventListener('click', () => mutate('control', { action: 'shuffle' }, 'Shuffled the upcoming tracks.'));
$('now-art').referrerPolicy = 'no-referrer';
$('now-art').addEventListener('error', () => {
  $('now-art').hidden = true;
  $('record-scene').hidden = false;
});

async function poll() {
  if (state.polling || state.busy || document.hidden) return;
  state.polling = true;
  try {
    if (!state.session || state.offline || ++state.pollCount % 6 === 0) {
      const wasOffline = state.offline;
      await initialize();
      if (wasOffline && !state.offline) showFeedback('Connected again. Your queue is up to date.');
    } else await loadDetail();
  } catch (error) {
    if (error.status === 401) {
      await initialize();
    } else {
      state.offline = true;
      renderSession();
    }
  } finally { state.polling = false; }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('online', poll);
window.addEventListener('offline', () => { state.offline = true; renderSession(); });

for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => setTheme(button.dataset.themeChoice));
}
$('cassette-mode-toggle')?.addEventListener('click', () => {
  setCassetteMode(document.documentElement.dataset.cassetteMode === 'dark' ? 'light' : 'dark');
});
let initialTheme = 'cassette';
let initialCassetteMode = 'light';
try { initialTheme = localStorage.getItem('turntable-theme') || 'cassette'; } catch { /* Storage is optional. */ }
try { initialCassetteMode = localStorage.getItem('turntable-cassette-mode') || 'light'; } catch { /* Storage is optional. */ }
setCassetteMode(initialCassetteMode, false);
setTheme(initialTheme, false);

const authError = new URL(window.location.href).searchParams.has('error');
if (authError) {
  showFeedback('Discord sign-in did not complete. Please try connecting again.', true);
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete('error');
  window.history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
}
initialize();
setInterval(poll, 5000);
setInterval(renderProgress, 1000);
