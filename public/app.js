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
    const login = appendText(container, 'a', 'button button-discord button-small', 'Connect Discord ↗');
    login.href = '/auth/discord';
  } else {
    const login = appendText(container, 'button', 'button button-discord button-small', 'Connect Discord ↗');
    login.type = 'button';
    login.disabled = true;
    login.title = 'Discord sign-in is available after server configuration.';
  }
}

function renderSession() {
  const session = state.session;
  $('demo-badge').hidden = !session?.demo;
  const invite = safeUrl(session?.inviteUrl, ['discord.com']);
  $('invite-link').hidden = !invite;
  if (invite) $('invite-link').href = invite;
  const dot = $('status-dot');
  const connected = session?.botReady && !state.offline;
  dot.classList.toggle('online', Boolean(connected));
  dot.classList.toggle('offline', Boolean(state.offline || (session?.configured && !connected)));
  $('connection-status').textContent = state.offline ? 'CONNECTION INTERRUPTED · RETRYING' : session?.demo ? 'YOUR PRACTICE LISTENING ROOM' : connected ? 'BOT ONLINE · READY TO LISTEN' : session?.configured ? 'BOT OFFLINE' : 'YOUR NEXT LISTENING ROOM';

  const notice = $('setup-notice');
  notice.hidden = true;
  if (session && !session.configured && !session.demo) {
    notice.hidden = false;
    $('notice-title').textContent = 'Your listening room is almost ready.';
    $('notice-description').textContent = 'Add your Discord credentials to the server environment, then restart Turntable to enable sign-in and song requests.';
  } else if (session?.configured && !session.botReady && !session.demo) {
    notice.hidden = false;
    $('notice-title').textContent = 'The bot is currently offline.';
    $('notice-description').textContent = 'Song requests and playback controls will become available when the Discord connection is ready. This page checks automatically.';
  } else if (session?.user && state.guilds.length === 0) {
    notice.hidden = false;
    $('notice-title').textContent = 'Every soundtrack needs a room.';
    $('notice-description').textContent = 'Add Turntable to a Discord server you belong to, then refresh this page to find it here.';
  }
  $('request-hint').textContent = session?.demo ? 'Demo mode: requests do not play audio.' : session && !session.spotifyEnabled ? 'YouTube ready · Spotify needs server setup.' : 'Your next favorite is one request away.';
  renderEnabled();
}

function renderGuildSelect() {
  const select = $('guild-select');
  select.replaceChildren();
  if (!state.guilds.length) {
    select.append(new Option(state.session?.user ? 'No shared servers yet' : 'Your listening room', ''));
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
  const ready = Boolean(state.session?.user && state.session.botReady && state.guildId && state.detail && !state.busy && !state.offline);
  const queue = state.detail?.queue;
  const canControl = ready && Boolean(state.detail?.member?.canControl);
  $('request-query').disabled = !ready;
  $('request-button').disabled = !ready;
  $('guild-select').disabled = state.guilds.length < 1 || state.busy;
  $('channel-select').disabled = !ready || !(state.detail?.voiceChannels?.length);
  $('join-button').disabled = !ready || !$('channel-select').value || queue?.channelId === $('channel-select').value;
  $('leave-button').disabled = !canControl;
  $('pause-button').disabled = !canControl || !queue?.nowPlaying;
  $('skip-button').disabled = !canControl || !queue?.nowPlaying;
  $('stop-button').disabled = !canControl || (!queue?.nowPlaying && !queue?.tracks?.length);
  for (const button of $('queue-list').querySelectorAll('button')) button.disabled = !ready;
}

function renderPlayer() {
  const queue = state.detail?.queue;
  const track = queue?.nowPlaying;
  $('now-title').textContent = track?.title || 'Nothing spinning. Yet.';
  $('now-artist').textContent = track?.artist || (track ? 'Unknown artist' : 'Your soundtrack starts with a request.');
  $('now-requester').hidden = !track?.requestedBy?.username;
  $('now-requester').textContent = track?.requestedBy?.username ? `In the mix thanks to ${track.requestedBy.username}` : '';
  const sourceUrl = safeUrl(track?.sourceUrl);
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
  $('player-status').textContent = track ? queue.paused ? 'PAUSED' : queue.playing ? 'NOW PLAYING' : 'LOADING' : 'STANDING BY';
  $('player-status').classList.toggle('active', Boolean(track && !queue.paused));
  $('artwork-badge-text').textContent = track ? `${track.source === 'spotify' ? 'SPOTIFY REQUEST' : 'YOUTUBE'} · ${queue.paused ? 'ON PAUSE' : 'IN THE MIX'}` : 'WAITING FOR THE FIRST TRACK';
  const pauseLabel = queue?.paused ? 'Resume playback' : 'Pause playback';
  $('pause-button').setAttribute('aria-label', pauseLabel);
  $('pause-button').title = pauseLabel;
  $('pause-icon').classList.toggle('resume', Boolean(queue?.paused));
  $('controls-help').textContent = state.session?.demo ? 'Demo controls · audio plays only in a real Discord room.' : !state.session?.user ? 'Connect Discord to join the listening room.' : !queue?.channelId ? 'Join a voice channel to get the room going.' : !state.detail?.member?.canControl ? 'Join the bot’s voice channel to control playback.' : 'You have the aux. Keep the good songs coming.';
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
  $('total-time').textContent = duration(total);
  $('progress-fill').style.width = `${percent}%`;
  $('progress-track').setAttribute('aria-valuenow', String(Math.round(percent)));
  $('progress-track').setAttribute('aria-valuetext', `${duration(boundedElapsed)} of ${duration(total)}`);
}

function renderQueue() {
  const tracks = state.detail?.queue?.tracks || [];
  $('queue-count').textContent = String(tracks.length);
  const seconds = tracks.reduce((sum, track) => sum + (Number(track.durationSec) || 0), 0);
  $('queue-duration').textContent = tracks.length ? `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}${seconds ? ` · ${Math.ceil(seconds / 60)} min` : ''}` : 'A little room for good music';
  $('queue-empty').hidden = tracks.length > 0;
  $('queue-list').hidden = !tracks.length;
  $('queue-note').hidden = !tracks.length;
  $('queue-empty-copy').textContent = !state.session?.user ? 'Connect your Discord account to find your server and start a queue worth sticking around for.' : !state.guildId ? 'Add Turntable to your Discord server to get everyone listening together.' : state.detail?.queue?.nowPlaying ? 'Enjoy this one, then keep the good music coming. Add the next song above.' : 'Drop a YouTube or Spotify link above, or search for a song. Your friends will thank you.';
  const signature = JSON.stringify([tracks, state.session?.user?.id, state.detail?.member?.canManage]);
  if (signature === state.queueSignature) return;
  state.queueSignature = signature;
  const list = $('queue-list');
  list.replaceChildren();
  for (const [index, track] of tracks.entries()) {
    const item = document.createElement('li');
    item.className = 'queue-item';
    appendText(item, 'span', 'queue-index', String(index + 1).padStart(2, '0'));
    const thumbnail = imageUrl(track.thumbnail);
    if (thumbnail) {
      const cover = document.createElement('img');
      cover.className = 'queue-cover';
      cover.src = thumbnail;
      cover.alt = '';
      cover.loading = 'lazy';
      cover.referrerPolicy = 'no-referrer';
      cover.addEventListener('error', () => {
        const fallback = document.createElement('div');
        fallback.className = 'queue-cover queue-cover-placeholder';
        fallback.setAttribute('aria-hidden', 'true');
        cover.replaceWith(fallback);
      }, { once: true });
      item.append(cover);
    } else {
      const cover = appendText(item, 'div', 'queue-cover queue-cover-placeholder', '');
      cover.setAttribute('aria-hidden', 'true');
    }
    const copy = document.createElement('div');
    copy.className = 'queue-item-copy';
    const title = appendText(copy, 'p', 'queue-item-title', track.title || 'Untitled track');
    title.title = track.title || 'Untitled track';
    const meta = document.createElement('div');
    meta.className = 'queue-item-meta';
    appendText(meta, 'span', 'source-pill', track.source === 'spotify' ? 'Spotify' : 'YouTube');
    appendText(meta, 'span', '', track.artist || 'Unknown artist');
    if (track.requestedBy?.username) {
      appendText(meta, 'span', '', '·');
      const requester = appendText(meta, 'span', '', track.requestedBy.username);
      requester.title = `Requested by ${track.requestedBy.username}`;
    }
    copy.append(meta);
    item.append(copy);
    appendText(item, 'span', 'queue-item-duration', track.durationSec ? duration(track.durationSec) : '—');
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
    showFeedback(error.status === 401 ? 'Your Discord session has expired. Connect Discord again to continue.' : 'We could not reach your listening room. Retrying automatically in a few seconds.', true, true);
  }
}

async function mutate(endpoint, body, successMessage) {
  if (state.busy || !state.guildId || !state.session?.user) return false;
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
    showFeedback(successMessage);
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

$('request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('request-query').value.trim();
  if (!query || state.busy) return;
  const label = $('request-button').querySelector('span');
  label.textContent = 'Finding song…';
  $('request-form').setAttribute('aria-busy', 'true');
  const channelId = state.detail?.queue?.channelId || $('channel-select').value;
  const success = await mutate('requests', { query, ...(channelId ? { channelId } : {}) }, state.session?.demo ? 'Added to your demo queue. No audio will play.' : 'Good choice. Your request is in the mix.');
  if (success) $('request-query').value = '';
  label.textContent = 'Add to queue';
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
$('join-button').addEventListener('click', () => mutate('join', { channelId: $('channel-select').value }, 'The listening room is connected.'));
$('leave-button').addEventListener('click', () => mutate('control', { action: 'leave' }, 'Disconnected from the voice channel.'));
$('pause-button').addEventListener('click', () => {
  const action = state.detail?.queue?.paused ? 'resume' : 'pause';
  return mutate('control', { action }, action === 'resume' ? 'Back in the groove.' : 'Playback paused.');
});
$('skip-button').addEventListener('click', () => mutate('control', { action: 'skip' }, 'On to the next one.'));
$('stop-button').addEventListener('click', () => mutate('control', { action: 'stop' }, 'Playback stopped and the queue cleared.'));
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
