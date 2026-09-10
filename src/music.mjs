import { EventEmitter } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { MediaError, isPermanentMediaError } from './media.mjs';

const SAFE_RUNTIME_CODES = new Set(['ENOENT', 'EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'ERR_MODULE_NOT_FOUND', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE']);
const SAFE_ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'AudioPlayerError']);
const SOURCE_METRIC_CODES = new Set(['AUDIO_SOURCE_FAILED', 'MEDIA_CANCELLED', 'MEDIA_BUSY', 'MEDIA_TIMEOUT', 'MEDIA_UNAVAILABLE', 'INVALID_MEDIA', 'UNSUPPORTED_MEDIA', 'TRACK_TOO_LONG', 'YOUTUBE_REQUEST_BLOCKED', 'YOUTUBE_RATE_LIMITED', 'YOUTUBE_RESTRICTED', 'YOUTUBE_FORMAT_UNAVAILABLE', 'YOUTUBE_UNAVAILABLE', 'EXTRACTOR_RUNTIME_UNAVAILABLE', 'EXTRACTOR_UNAVAILABLE']);
SOURCE_METRIC_CODES.add('NO_PLAYBACK_MATCH');
SOURCE_METRIC_CODES.add('YOUTUBE_VIDEO_UNAVAILABLE');
for (const code of ['SPOTIFY_NOT_FOUND', 'SPOTIFY_UNAVAILABLE', 'SPOTIFY_QUOTA_EXCEEDED', 'SPOTIFY_RATE_LIMITED', 'SPOTIFY_REAUTHORIZE', 'SPOTIFY_UNAUTHORIZED', 'SPOTIFY_FORBIDDEN', 'SPOTIFY_AUTH_STORAGE', 'SPOTIFY_NOT_CONFIGURED', 'SPOTIFY_PLAYLIST_ACCESS']) SOURCE_METRIC_CODES.add(code);

function failureDetails(error, fallbackCode) {
  const media = error instanceof MediaError ? error : error?.cause instanceof MediaError ? error.cause : null;
  if (media) return {
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(media.code) ? media.code : 'MEDIA_UNAVAILABLE',
    type: 'MediaError',
    // MediaError messages are authored by our adapter, never copied from stderr.
    message: media.message,
  };
  if (typeof error?.message === 'string' && /FFmpeg\/avconv not found/i.test(error.message)) {
    return { code: 'FFMPEG_UNAVAILABLE', type: 'Error', message: 'FFmpeg is missing from the bot host. The owner needs to install the audio runtime.' };
  }
  return {
    code: SAFE_RUNTIME_CODES.has(error?.code) ? error.code : fallbackCode,
    type: SAFE_ERROR_TYPES.has(error?.name) ? error.name : 'Error',
    message: fallbackCode === 'AUDIO_SOURCE_FAILED' ? 'The audio source could not be opened.' : 'The audio stream could not be played.',
  };
}

export function musicError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Shared queue state. Voice and media adapters are injected so transitions can be tested offline. */
export class MusicManager extends EventEmitter {
  constructor({ media, dataDir, maxQueueSize = 2000, idleDisconnectMs = 300_000, logger = console, randomIndex = randomInt, preloadCount = 2, preloadLeadSec = 120, preloadTtlMs = 300_000, validationDelayMs = 1000, validationRetryMs = [30_000, 120_000, 600_000], validationCooldownMs = 30_000 }) {
    super();
    this.media = media;
    this.file = path.join(dataDir, 'queues.json');
    this.maxQueueSize = maxQueueSize;
    this.idleDisconnectMs = idleDisconnectMs;
    this.logger = logger;
    this.randomIndex = randomIndex;
    this.states = new Map();
    this.writes = Promise.resolve();
    this.cleaned = new WeakSet();
    this.shuttingDown = false;
    if (!Number.isInteger(preloadCount) || preloadCount < 0 || preloadCount > 2) throw new Error('preloadCount must be from 0 to 2.');
    if (!Number.isFinite(preloadLeadSec) || preloadLeadSec < 0 || !Number.isSafeInteger(preloadTtlMs) || preloadTtlMs < 1) throw new Error('Preload timing values are invalid.');
    this.preloadCount = preloadCount;
    this.preloadLeadSec = preloadLeadSec;
    this.preloadTtlMs = preloadTtlMs;
    this.preloadEntries = new Set();
    this.validationDelayMs = validationDelayMs;
    if (!Number.isSafeInteger(validationDelayMs) || validationDelayMs < 0 || !Number.isSafeInteger(validationCooldownMs) || validationCooldownMs < 1
      || !Array.isArray(validationRetryMs) || !validationRetryMs.length || validationRetryMs.some(delay => !Number.isSafeInteger(delay) || delay < 1)) throw new Error('Validation timing values are invalid.');
    this.validationRetryMs = validationRetryMs;
    this.validationCooldownMs = validationCooldownMs;
    this.validationEntry = null;
    this.validationTimer = null;
    this.validationPauses = 0;
    this.validationCooldownUntil = 0;
    this.validationAttempts = new Map();
    this.validationLastGuild = null;
    this.preloadCooldownUntil = 0;
  }

  state(guildId) {
    let state = this.states.get(guildId);
    if (!state) {
      state = {
        guildId, tracks: [], nowPlaying: null, channelId: null, channelName: null,
        transport: null, generation: 0, opened: null, abort: null,
        paused: false, opening: false, lastError: null, idleTimer: null,
        preloads: new Map(), preloadTimer: null, retryingTrackId: null, transitionStartedAt: null,
      };
      this.states.set(guildId, state);
    }
    return state;
  }

  async restore() {
    let saved;
    try {
      saved = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error('Could not read saved queues. Preserve queues.json and check its contents.', { cause: error });
    }
    if (saved.version !== 1 || !saved.guilds || typeof saved.guilds !== 'object') {
      throw new Error('Unsupported saved queue format. Preserve queues.json before starting again.');
    }
    for (const [guildId, value] of Object.entries(saved.guilds)) {
      if (!value || !Array.isArray(value.tracks)) throw new Error('Invalid saved queue data.');
      const restored = [value.nowPlaying, ...value.tracks].filter(Boolean);
      if (restored.some(track => !track.id || typeof track.title !== 'string' || !track.requestedBy?.id)) {
        throw new Error('Invalid track in saved queue data.');
      }
      this.state(guildId).tracks = restored.map(track => this.initializeValidation(track));
    }
    this.scheduleValidation();
  }

  snapshot(guildId) {
    const state = this.state(guildId);
    const publicTrack = track => {
      if (!track) return track;
      const { playbackMapping, searchQuery, ...visible } = track;
      return visible;
    };
    return structuredClone({
      guildId, channelId: state.channelId, channelName: state.channelName,
      nowPlaying: publicTrack(state.nowPlaying), tracks: state.tracks.map(publicTrack),
      paused: state.paused,
      playing: Boolean(state.nowPlaying && state.transport && !state.opening && !state.paused),
      lastError: state.lastError,
      elapsedSec: state.nowPlaying ? Math.max(0, state.transport?.elapsedSec?.() || 0) : 0,
    });
  }

  capacity(guildId) {
    const state = this.state(guildId);
    return this.maxQueueSize - state.tracks.length - Number(Boolean(state.nowPlaying));
  }

  assertCapacity(guildId, count) {
    const available = Math.max(0, this.capacity(guildId));
    if (count > available) {
      throw musicError(`This request contains ${count} track${count === 1 ? '' : 's'}, but only ${available} queue slot${available === 1 ? ' is' : 's are'} available (limit ${this.maxQueueSize}, including the current track). Nothing was added. Try a smaller request or wait for space.`, 409);
    }
  }

  async enqueue(guildId, tracks, requestedBy) {
    if (this.shuttingDown) throw musicError('The bot is restarting. Please try again shortly.', 503);
    if (!Array.isArray(tracks) || !tracks.length) throw musicError('No playable tracks were found.');
    const state = this.state(guildId);
    this.assertCapacity(guildId, tracks.length);
    // The capacity check and full-batch append happen before any await. Concurrent
    // requests therefore either reserve every accepted track or add nothing.
    const added = tracks.map(track => this.initializeValidation({ ...structuredClone(track), id: randomUUID(), requestedBy: { ...requestedBy } }));
    state.tracks.push(...added);
    this.clearIdle(state);
    await this.persist();
    this.changed(state);
    this.schedule(state);
    return structuredClone(added);
  }

  attach(guildId, transport, channel) {
    const state = this.state(guildId);
    if (this.shuttingDown) {
      transport.destroy();
      throw musicError('The bot is restarting. Please try again shortly.', 503);
    }
    if (state.transport && state.transport !== transport) this.detach(guildId, true);
    state.transport = transport;
    state.channelId = channel.id;
    state.channelName = channel.name;
    this.changed(state);
    this.schedule(state);
    return this.snapshot(guildId);
  }

  /** Leave/reconnect keeps the interrupted track at the front, ready for an explicit join. */
  detach(guildId, preserve = true, error = null, expectedTransport = null) {
    const state = this.state(guildId);
    if (expectedTransport && state.transport !== expectedTransport) return;
    if (preserve && state.nowPlaying) state.tracks.unshift(state.nowPlaying);
    const transport = state.transport;
    this.cancelCurrent(state);
    state.transport = null;
    state.channelId = null;
    state.channelName = null;
    this.syncPreloads();
    this.clearIdle(state);
    if (error) state.lastError = 'The voice connection ended. Join a voice channel to continue the saved queue.';
    try { transport?.destroy(); } catch (cause) { this.logFailure('voice-cleanup', cause, 'VOICE_CLEANUP_FAILED'); }
    this.persistBackground(state);
    this.changed(state);
  }

  async control(guildId, action, trackId) {
    const state = this.state(guildId);
    if (['shuffle', 'move-top', 'remove', 'stop', 'leave'].includes(action) && this.validationEntry?.state === state) this.cancelValidation();
    switch (action) {
      case 'pause':
        if (!state.nowPlaying) throw musicError('Nothing is playing.', 409);
        state.paused = true;
        state.transport?.pause();
        break;
      case 'resume':
        if (!state.nowPlaying) throw musicError('Nothing is playing.', 409);
        state.paused = false;
        state.transport?.resume();
        // A long explicit pause can outlast a parked connection's TTL. Allow
        // one new warm attempt on resume, without retrying provider failures.
        for (const entry of [...state.preloads.values()]) {
          if (entry.status === 'failed' && entry.failureOutcome === 'expired') this.dropPreload(state, entry);
        }
        break;
      case 'skip':
        if (!state.nowPlaying) throw musicError('Nothing is playing.', 409);
        this.cancelCurrent(state);
        break;
      case 'shuffle':
        if (state.tracks.length < 2) throw musicError('At least two songs must be waiting in the queue to shuffle.', 409);
        for (let index = state.tracks.length - 1; index > 0; --index) {
          const other = this.randomIndex(index + 1);
          [state.tracks[index], state.tracks[other]] = [state.tracks[other], state.tracks[index]];
        }
        break;
      case 'move-top': {
        const index = state.tracks.findIndex(track => track.id === trackId);
        if (index < 0) throw musicError('That song is no longer in the waiting queue.', 404);
        if (index > 0) state.tracks.unshift(...state.tracks.splice(index, 1));
        break;
      }
      case 'stop':
        for (const track of state.tracks) this.validationAttempts.delete(track.id);
        state.tracks = [];
        this.cancelCurrent(state);
        state.lastError = null;
        break;
      case 'leave':
        this.detach(guildId, true);
        break;
      case 'remove': {
        const index = state.tracks.findIndex(track => track.id === trackId);
        if (index < 0) throw musicError('That song is no longer in the waiting queue.', 404);
        state.tracks.splice(index, 1);
        this.validationAttempts.delete(trackId);
        break;
      }
      default:
        throw musicError('Unknown playback action.');
    }
    this.syncPreloads();
    await this.persist();
    this.changed(state);
    this.schedule(state);
    return this.snapshot(guildId);
  }

  clearIdle(state) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }

  schedule(state) {
    this.syncPreloads();
    if (this.shuttingDown || !state.transport || state.nowPlaying) return;
    const firstPlayable = state.tracks.findIndex(track => track.validation?.status !== 'unavailable');
    const skipped = firstPlayable < 0 ? state.tracks.length : firstPlayable;
    if (skipped) {
      const removed = state.tracks.splice(0, skipped);
      for (const track of removed) this.validationAttempts.delete(track.id);
      state.lastError = `Skipped ${skipped} unavailable queued track${skipped === 1 ? '' : 's'}.`;
      this.persistBackground(state);
      this.changed(state);
      this.syncPreloads();
    }
    if (!state.tracks.length) {
      if (!state.idleTimer && this.idleDisconnectMs > 0) {
        state.idleTimer = setTimeout(() => {
          state.idleTimer = null;
          if (!state.nowPlaying && !state.tracks.length) this.detach(state.guildId, true);
        }, this.idleDisconnectMs);
        state.idleTimer.unref?.();
      }
      return;
    }
    this.clearIdle(state);
    // A separate event-loop turn for each attempt prevents failing tracks from spinning recursively.
    setImmediate(() => {
      if (!this.shuttingDown && state.transport && !state.nowPlaying && state.tracks.length) {
        void this.begin(state);
      }
    });
  }

  async begin(state) {
    // A preload failure can mark this row after schedule queued the immediate.
    if (state.tracks[0]?.validation?.status === 'unavailable') { this.schedule(state); return; }
    const cancelledValidation = Boolean(this.validationEntry);
    this.cancelValidation();
    const generation = ++state.generation;
    const transport = state.transport;
    state.nowPlaying = state.tracks.shift();
    state.opening = true;
    state.paused = false;
    const track = state.nowPlaying;
    this.validationAttempts.delete(track.id);
    const cached = state.preloads.get(track.id);
    const usePreload = cached?.status === 'ready' && !cached.opened.stream.destroyed && cached.expiresAt > Date.now() && state.retryingTrackId !== track.id;
    let releasedSpeculation = cancelledValidation;
    state.retryingTrackId = null;
    if (usePreload) {
      state.preloads.delete(track.id);
      this.preloadEntries.delete(cached);
      clearTimeout(cached.timer);
      cached.opened.stream.off('error', cached.onError);
      cached.status = 'playing';
      state.abort = cached.controller;
    } else {
      if (cached) { releasedSpeculation ||= cached.status !== 'failed'; this.dropPreload(state, cached); }
      // Stop competing startup work, but retain already playable songs when
      // current playback plus speculation still leaves an interactive slot.
      for (const entry of [...this.preloadEntries]) {
        if (entry.status !== 'ready' || entry.opened.stream.destroyed || entry.expiresAt <= Date.now()) {
          releasedSpeculation = true;
          this.dropPreload(entry.state, entry);
        }
      }
      const foreground = [...this.states.values()].filter(other => other.transport && other.nowPlaying).length;
      const budget = Math.min(this.preloadCount, Math.max(0, 3 - foreground - Number(Boolean(this.validationEntry))));
      while (this.preloadEntries.size > budget) {
        const entry = [...this.preloadEntries].at(-1);
        releasedSpeculation = true;
        this.dropPreload(entry.state, entry);
      }
      state.abort = new AbortController();
    }
    const signal = state.abort.signal;
    this.changed(state);
    this.persistBackground(state);
    let opened;
    let operation = 'media-open';
    let streamFailure;
    let streamFailureElapsed;
    const sourceStarted = performance.now();
    let metricRecorded = false;
    const metric = (outcome, error) => {
      if (metricRecorded) return;
      metricRecorded = true;
      const code = signal.aborted ? 'MEDIA_CANCELLED' : failureDetails(error, 'AUDIO_SOURCE_FAILED').code;
      try { this.emit('playbackMetric', { outcome, durationMs: Math.max(0, performance.now() - sourceStarted), preloaded: Boolean(usePreload), ...(outcome === 'error' ? { code: SOURCE_METRIC_CODES.has(code) || SAFE_RUNTIME_CODES.has(code) ? code : 'AUDIO_SOURCE_FAILED' } : {}) }); } catch {}
    };
    try {
      if (usePreload) opened = cached.opened;
      else {
        for (let attempt = 0; ; attempt += 1) {
          signal.throwIfAborted();
          try { opened = await this.media.open(track, { signal }); break; }
          catch (error) {
            if (!(error instanceof MediaError) || error.code !== 'MEDIA_BUSY' || error.retryableBeforeStart !== true || attempt >= 4) throw error;
            // Live provider/search work can consume more slots than our queue
            // budget predicts. Only on this preflight failure sacrifice a
            // parked source to make room for the foreground request.
            const parked = [...this.preloadEntries].at(-1);
            if (parked) { releasedSpeculation = true; this.dropPreload(parked.state, parked); }
            if (!releasedSpeculation) throw error;
            // Only a no-provider-work-yet capacity failure is retryable. Killed
            // children release slots asynchronously; allow at most 750ms.
            await new Promise((resolve, reject) => {
              const abort = () => { clearTimeout(timer); reject(signal.reason); };
              const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 50 * 2 ** attempt);
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            });
          }
        }
        opened = await this.prepareSource(opened, transport, signal);
      }
      if (state.generation !== generation || this.shuttingDown || state.transport !== transport) {
        metric('error');
        this.cleanup(opened);
        return;
      }
      if (opened.stream.destroyed) throw new MediaError('The audio source ended before playback could start.', 'MEDIA_UNAVAILABLE');
      metric('ready');
      if (opened.track) {
        // Playlist discovery can omit duration. Media validates before playback;
        // enrich only display fields, retaining request ownership and source identity.
        for (const key of ['title', 'artist', 'durationSec', 'thumbnail', 'needsValidation', 'playbackMapping', 'validation']) {
          if (Object.hasOwn(opened.track, key)) track[key] = opened.track[key];
        }
        this.persistBackground(state);
      }
      state.opened = opened;
      state.opening = false;
      // @discordjs/voice wraps stream failures and drops their original code/cause.
      // Capture the adapter's typed error before that wrapper or an Idle event wins.
      const captureStreamFailure = error => {
        streamFailure = error;
        // Idle removes the transport's resource. Capture timing while the
        // original stream error still belongs to the resource that failed.
        streamFailureElapsed = Math.max(0, transport.elapsedSec?.() || 0);
      };
      opened.stream.once('error', captureStreamFailure);
      opened.stream.once('close', () => opened.stream.off('error', captureStreamFailure));
      const finish = error => {
        if (state.generation !== generation) return;
        const finishedAt = performance.now();
        const failure = streamFailure || error;
        const failedAfter = streamFailureElapsed ?? (error?.resource?.playbackDuration == null ? NaN : error.resource.playbackDuration / 1000);
        if (failure && usePreload && failedAfter < 2) {
          // A parked provider connection can fail only after its prefix drains.
          // Retry that same request once from a fresh source, before advancing.
          state.tracks.unshift(track);
          this.cancelCurrent(state, { preserveTransition: true });
          state.retryingTrackId = track.id;
          this.persistBackground(state);
          this.changed(state);
          this.schedule(state);
          return;
        }
        if (failure) this.playbackFailure(state, track, failure, 'audio-playback');
        this.cancelCurrent(state, { preserveTransition: true });
        if (!failure && state.tracks.length) state.transitionStartedAt = finishedAt;
        this.persistBackground(state);
        this.changed(state);
        this.schedule(state);
      };
      operation = 'audio-start';
      const onStarted = () => {
        if (state.generation !== generation || state.transitionStartedAt === null) return;
        const durationMs = Math.max(0, performance.now() - state.transitionStartedAt);
        state.transitionStartedAt = null;
        try { this.emit('transitionMetric', { outcome: 'ready', durationMs, preloaded: Boolean(usePreload) }); } catch {}
      };
      transport.play(opened, () => finish(), error => finish(error), onStarted);
      if (state.paused) transport.pause();
      this.changed(state);
      this.syncPreloads();
    } catch (error) {
      metric('error', error);
      this.cleanup(opened);
      if (state.generation !== generation || this.shuttingDown) return;
      if (usePreload && (operation === 'media-open' || streamFailure)) {
        state.tracks.unshift(track);
        this.cancelCurrent(state, { preserveTransition: true });
        state.retryingTrackId = track.id;
        this.persistBackground(state);
        this.changed(state);
        this.schedule(state);
        return;
      }
      this.playbackFailure(state, track, streamFailure || error, operation);
      this.cancelCurrent(state, { preserveTransition: true });
      this.persistBackground(state);
      this.changed(state);
      this.schedule(state);
    }
  }

  async prepareSource(raw, transport, signal) {
    if (!transport.prepare) return raw;
    try {
      signal.throwIfAborted();
      // Both the preparing adapter and race cleanup can release this source;
      // route ownership through the manager's idempotent cleanup guard.
      return await transport.prepare({ ...raw, cleanup: () => this.cleanup(raw) }, { signal });
    } catch (error) {
      this.cleanup(raw);
      throw error;
    }
  }

  initializeValidation(track) {
    if (!this.media.preflight) return track;
    const value = track.validation;
    const fresh = Number.isFinite(value?.checkedAt) && value.checkedAt <= Date.now();
    if (value?.status === 'ready' && fresh && Date.now() - value.checkedAt <= 600_000) return track;
    if (value?.status === 'unavailable' && fresh && Date.now() - value.checkedAt <= 86_400_000) return track;
    if (value?.status === 'retry' && Number.isFinite(value.retryAt)) return track;
    track.validation = { status: 'pending' };
    return track;
  }

  applyValidatedTrack(track, result) {
    for (const key of ['title', 'artist', 'durationSec', 'thumbnail', 'needsValidation', 'playbackMapping']) {
      if (Object.hasOwn(result, key)) track[key] = structuredClone(result[key]);
    }
    if (this.media.preflight) track.validation = { status: 'ready', checkedAt: Date.now() };
    this.validationAttempts.delete(track.id);
  }

  validationFailure(track, error) {
    const checkedAt = Date.now();
    const details = failureDetails(error, 'AUDIO_SOURCE_FAILED');
    const code = SOURCE_METRIC_CODES.has(details.code) ? details.code : 'AUDIO_SOURCE_FAILED';
    if (isPermanentMediaError(error)) {
      track.validation = { status: 'unavailable', checkedAt, code };
      this.validationAttempts.delete(track.id);
    } else {
      const attempts = (this.validationAttempts.get(track.id) ?? 0) + 1;
      this.validationAttempts.set(track.id, attempts);
      const delay = this.validationRetryMs[Math.min(attempts - 1, this.validationRetryMs.length - 1)];
      track.validation = { status: 'retry', checkedAt, code, retryAt: checkedAt + delay };
    }
  }

  cancelValidation() {
    const entry = this.validationEntry;
    if (!entry || entry.controller.signal.aborted) return;
    entry.controller.abort();
    if (entry.state.tracks.includes(entry.track) && entry.track.validation === entry.marker) {
      entry.track.validation = { status: 'pending' };
      this.persistBackground(entry.state);
      this.changed(entry.state);
    }
  }

  pausePreflight() {
    this.validationPauses++;
    clearTimeout(this.validationTimer);
    this.validationTimer = null;
    this.cancelValidation();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.validationPauses--;
      this.scheduleValidation();
    };
  }

  scheduleValidation(delay = this.validationDelayMs) {
    if (!this.media.preflight || this.shuttingDown || this.validationPauses || this.validationEntry || this.validationTimer) return;
    if (![...this.states.values()].some(state => state.tracks.some(track => ['pending', 'checking', 'retry'].includes(track.validation?.status)))) return;
    this.validationTimer = setTimeout(() => {
      this.validationTimer = null;
      this.startValidation();
    }, Math.max(delay, this.validationCooldownUntil - Date.now(), 0));
    this.validationTimer.unref?.();
  }

  startValidation() {
    if (!this.media.preflight || this.shuttingDown || this.validationPauses || this.validationEntry) return;
    const states = [...this.states.values()];
    if (states.some(state => state.opening) || states.filter(state => state.transport && state.nowPlaying).length + this.preloadEntries.size >= 3) return;
    const after = states.findIndex(state => state.guildId === this.validationLastGuild) + 1;
    const ordered = [...states.slice(after), ...states.slice(0, after)];
    let selected, nextRetry = Infinity;
    for (const state of ordered) {
      for (let index = 0; index < state.tracks.length; index++) {
        const track = state.tracks[index], status = track.validation?.status;
        if (state.preloads.has(track.id) || !['pending', 'checking', 'retry'].includes(status)) continue;
        if (status === 'retry' && track.validation.retryAt > Date.now()) { nextRetry = Math.min(nextRetry, track.validation.retryAt); continue; }
        if (!selected || index < selected.index) selected = { state, track, index };
        break;
      }
    }
    if (!selected) {
      if (Number.isFinite(nextRetry)) this.scheduleValidation(Math.max(this.validationDelayMs, nextRetry - Date.now()));
      return;
    }
    const { state, track } = selected;
    const marker = { status: 'checking' };
    const entry = { state, track, marker, controller: new AbortController() };
    this.validationEntry = entry;
    this.validationLastGuild = state.guildId;
    track.validation = marker;
    this.persistBackground(state);
    this.changed(state);
    const current = () => !this.shuttingDown && !entry.controller.signal.aborted && state.tracks.includes(track) && track.validation === marker;
    void Promise.resolve().then(async () => {
      entry.controller.signal.throwIfAborted();
      const result = await this.media.preflight(structuredClone(track), { signal: entry.controller.signal, background: true });
      if (!current()) return;
      this.applyValidatedTrack(track, result);
      this.persistBackground(state);
      this.changed(state);
    }).catch(error => {
      if (!current()) return;
      this.validationFailure(track, error);
      if (!isPermanentMediaError(error)) this.validationCooldownUntil = Date.now() + (error?.code === 'MEDIA_BUSY' ? this.validationDelayMs : this.validationCooldownMs);
      this.persistBackground(state);
      this.changed(state);
    }).finally(() => {
      if (this.validationEntry === entry) this.validationEntry = null;
      if (!this.shuttingDown) {
        for (const value of this.states.values()) this.schedule(value);
        this.scheduleValidation();
      }
    });
  }

  preloadMetric(entry, outcome, error) {
    const code = failureDetails(error, 'AUDIO_SOURCE_FAILED').code;
    try { this.emit('preloadMetric', { outcome, durationMs: Math.max(0, performance.now() - entry.startedAt),
      ...(error ? { code: SOURCE_METRIC_CODES.has(code) || SAFE_RUNTIME_CODES.has(code) ? code : 'AUDIO_SOURCE_FAILED' } : {}) }); } catch {}
  }

  dropPreload(state, entry) {
    if (state.preloads.get(entry.id) === entry) state.preloads.delete(entry.id);
    this.preloadEntries.delete(entry);
    clearTimeout(entry.timer);
    if (!['failed', 'cancelled', 'playing'].includes(entry.status)) this.preloadMetric(entry, 'cancelled');
    entry.status = 'cancelled';
    entry.controller.abort();
    this.cleanup(entry.opened);
  }

  preloadTracks(state) {
    return state.tracks.filter(track => track.validation?.status !== 'unavailable'
      && !(state.preloads.get(track.id)?.status === 'failed' && state.preloads.get(track.id).generation === state.generation)).slice(0, this.preloadCount);
  }

  syncPreloads() {
    let foreground = 0;
    for (const state of this.states.values()) {
      if (state.transport && state.nowPlaying) foreground += 1;
      clearTimeout(state.preloadTimer);
      state.preloadTimer = null;
      const wanted = new Set(!this.shuttingDown && state.transport ? this.preloadTracks(state).map(track => track.id) : []);
      const queued = new Set(state.tracks.map(track => track.id));
      for (const entry of [...state.preloads.values()]) {
        if (entry.status === 'failed') {
          if (this.shuttingDown || !state.transport || !queued.has(entry.id) || entry.generation !== state.generation) this.dropPreload(state, entry);
        } else if (!wanted.has(entry.id)) this.dropPreload(state, entry);
      }
    }
    if (this.validationEntry && [...this.states.values()].some(state => {
      if (!state.transport || !state.nowPlaying || state.opening || state.paused) return false;
      const remaining = Number(state.nowPlaying.durationSec) - Math.max(0, state.transport.elapsedSec?.() || 0);
      return (!Number.isFinite(remaining) || remaining <= this.preloadLeadSec) && this.preloadTracks(state).some(track => !state.preloads.has(track.id));
    })) this.cancelValidation();
    // Reserve one of media's four extractor slots for interactive lookups.
    const budget = Math.min(this.preloadCount, Math.max(0, 3 - foreground - Number(Boolean(this.validationEntry))));
    while (this.preloadEntries.size > budget) {
      const entry = [...this.preloadEntries].at(-1);
      this.dropPreload(entry.state, entry);
    }
    for (const state of this.states.values()) {
      if (this.shuttingDown || !state.transport || !state.nowPlaying || state.opening || state.paused || !this.preloadCount) continue;
      const elapsed = Math.max(0, state.transport.elapsedSec?.() || 0);
      const remaining = Number(state.nowPlaying.durationSec) - elapsed;
      if (Number.isFinite(remaining) && remaining > this.preloadLeadSec) {
        state.preloadTimer = setTimeout(() => this.syncPreloads(), Math.max(1, (remaining - this.preloadLeadSec) * 1000));
        state.preloadTimer.unref?.();
        continue;
      }
      if (this.preloadCooldownUntil > Date.now()) {
        state.preloadTimer = setTimeout(() => this.syncPreloads(), this.preloadCooldownUntil - Date.now());
        state.preloadTimer.unref?.();
        continue;
      }
      for (const track of this.preloadTracks(state)) {
        if (this.preloadEntries.size >= budget) break;
        if (state.preloads.has(track.id)) continue;
        if (this.validationEntry) { this.cancelValidation(); break; }
        this.startPreload(state, track);
      }
    }
    this.scheduleValidation();
  }

  startPreload(state, track) {
    const transport = state.transport;
    const entry = { id: track.id, state, generation: state.generation, status: 'opening', controller: new AbortController(), opened: null, timer: null, expiresAt: 0, onError: null, startedAt: performance.now() };
    state.preloads.set(entry.id, entry);
    this.preloadEntries.add(entry);
    const current = () => !this.shuttingDown && state.transport && state.preloads.get(entry.id) === entry && this.preloadTracks(state).some(item => item.id === entry.id);
    const failed = (error, outcome = 'error') => {
      if (!current() || ['cancelled', 'playing', 'failed'].includes(entry.status)) return;
      entry.status = 'failed';
      entry.failureOutcome = outcome;
      this.preloadEntries.delete(entry);
      clearTimeout(entry.timer);
      entry.controller.abort();
      this.cleanup(entry.opened);
      this.preloadMetric(entry, outcome, error);
      this.logFailure('audio-preload', error, 'AUDIO_SOURCE_FAILED');
      if (outcome !== 'expired' && this.media.preflight && isPermanentMediaError(error)) {
        this.validationFailure(track, error);
        this.persistBackground(state);
        this.changed(state);
      }
      if (outcome !== 'expired' && !isPermanentMediaError(error)) this.preloadCooldownUntil = Date.now() + (error?.code === 'MEDIA_BUSY' ? this.validationDelayMs : this.validationCooldownMs);
      // Keep the failed marker for this track/current-song pair. No retry loop.
      setImmediate(() => { if (!this.shuttingDown) this.syncPreloads(); });
    };
    void Promise.resolve().then(async () => {
      entry.controller.signal.throwIfAborted();
      const raw = await this.media.open(track, { signal: entry.controller.signal });
      if (!current() || entry.status !== 'opening') { this.cleanup(raw); return; }
      if (raw.track) {
        this.applyValidatedTrack(track, raw.track);
        this.persistBackground(state);
        this.changed(state);
      }
      let buffer;
      if (transport.prepare) {
        // This is an object-mode Opus packet stream and its exact resource.
        // Never run it through the byte-mode speculative source buffer.
        const prepared = await this.prepareSource(raw, transport, entry.controller.signal);
        if (!current() || entry.status !== 'opening') { this.cleanup(prepared); return; }
        entry.opened = prepared;
        buffer = prepared.stream;
      } else {
        buffer = new PassThrough({ readableHighWaterMark: 256 * 1024, writableHighWaterMark: 16 * 1024 });
        buffer.on('error', () => {}); // The active owner supplies the actionable handler.
        const sourceError = error => buffer.destroy(error);
        const sourceClose = () => {
          if (!raw.stream.readableEnded && !buffer.destroyed) buffer.destroy(new MediaError('The preloaded audio source closed early.', 'MEDIA_UNAVAILABLE'));
        };
        raw.stream.once('error', sourceError);
        raw.stream.once('close', sourceClose);
        entry.opened = { ...raw, stream: buffer, cleanup: () => {
          raw.stream.unpipe(buffer);
          raw.stream.off('error', sourceError);
          raw.stream.off('close', sourceClose);
          this.cleanup(raw);
          buffer.destroy();
        } };
        raw.stream.pipe(buffer);
        if (raw.stream.destroyed && !raw.stream.readableEnded) sourceClose();
      }
      entry.onError = failed;
      buffer.once('error', entry.onError);
      entry.status = 'ready';
      this.preloadMetric(entry, 'ready');
      entry.expiresAt = Date.now() + this.preloadTtlMs;
      entry.timer = setTimeout(() => {
        if (!current() || entry.status !== 'ready') return;
        failed(new MediaError('The preloaded audio expired before playback.', 'MEDIA_UNAVAILABLE'), 'expired');
        this.syncPreloads();
      }, this.preloadTtlMs);
      entry.timer.unref?.();
      if (buffer.destroyed) failed(new MediaError('The preloaded audio source closed early.', 'MEDIA_UNAVAILABLE'));
    }).catch(failed);
  }

  playbackFailure(state, track, error, operation) {
    const fallbackCode = operation === 'media-open' ? 'AUDIO_SOURCE_FAILED' : 'AUDIO_PIPELINE_FAILED';
    const details = failureDetails(error, fallbackCode);
    state.lastError = `Could not play “${track.title}”. ${details.message} [${details.code}] ${state.tracks.length ? 'The next song will be tried.' : 'Request another song to try again.'}`;
    this.logFailure(operation, error, fallbackCode);
  }

  logFailure(operation, error, fallbackCode, level = 'warn') {
    const { code, type } = failureDetails(error, fallbackCode);
    // Do not send exception messages, stacks, track URLs, or provider stderr to logs.
    try { this.logger[level]?.('Music operation failed.', { operation, code, type }); } catch {}
  }

  cancelCurrent(state, { preserveTransition = false } = {}) {
    // Invalidate callbacks before stop/destroy, which can synchronously emit Idle/error events.
    ++state.generation;
    state.abort?.abort();
    state.abort = null;
    const opened = state.opened;
    state.opened = null;
    state.nowPlaying = null;
    state.opening = false;
    state.paused = false;
    state.retryingTrackId = null;
    if (!preserveTransition || !state.tracks.length) state.transitionStartedAt = null;
    try { state.transport?.stop(); } catch (error) { this.logFailure('audio-stop', error, 'AUDIO_STOP_FAILED'); }
    this.cleanup(opened);
  }

  cleanup(opened) {
    if (!opened || this.cleaned.has(opened)) return;
    this.cleaned.add(opened);
    try {
      Promise.resolve(opened.cleanup?.()).catch(error => this.logFailure('media-cleanup', error, 'MEDIA_CLEANUP_FAILED'));
      opened.stream?.destroy?.();
    } catch (error) { this.logFailure('media-cleanup', error, 'MEDIA_CLEANUP_FAILED'); }
  }

  changed(state) {
    this.emit('change', state.guildId, this.snapshot(state.guildId));
  }

  persist() {
    const guilds = {};
    for (const [id, state] of this.states) {
      guilds[id] = { tracks: state.tracks, nowPlaying: state.nowPlaying };
    }
    // Capture now, then serialize writes: a delayed older write cannot overwrite a newer queue.
    const body = JSON.stringify({ version: 1, guilds }, null, 2);
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.writes = write;
    return write;
  }

  persistBackground(state) {
    void this.persist().catch(error => {
      state.lastError = 'The queue could not be saved. Check the server storage before restarting.';
      this.logFailure('queue-save', error, 'QUEUE_SAVE_FAILED', 'error');
      this.changed(state);
    });
  }

  async shutdown() {
    this.shuttingDown = true;
    clearTimeout(this.validationTimer);
    this.validationTimer = null;
    this.cancelValidation();
    this.syncPreloads();
    for (const state of this.states.values()) {
      if (state.nowPlaying) state.tracks.unshift(state.nowPlaying);
      this.cancelCurrent(state);
      const transport = state.transport;
      state.transport = null;
      state.channelId = null;
      state.channelName = null;
      this.clearIdle(state);
      try { transport?.destroy(); } catch (error) { this.logFailure('voice-cleanup', error, 'VOICE_CLEANUP_FAILED'); }
    }
    await this.persist();
  }
}
