import { EventEmitter } from 'node:events';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function musicError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Shared queue state. Voice and media adapters are injected so transitions can be tested offline. */
export class MusicManager extends EventEmitter {
  constructor({ media, dataDir, maxQueueSize = 100, idleDisconnectMs = 300_000, logger = console, randomIndex = randomInt }) {
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
  }

  state(guildId) {
    let state = this.states.get(guildId);
    if (!state) {
      state = {
        guildId, tracks: [], nowPlaying: null, channelId: null, channelName: null,
        transport: null, generation: 0, opened: null, abort: null,
        paused: false, opening: false, lastError: null, idleTimer: null,
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
      this.state(guildId).tracks = restored;
    }
  }

  snapshot(guildId) {
    const state = this.state(guildId);
    return structuredClone({
      guildId, channelId: state.channelId, channelName: state.channelName,
      nowPlaying: state.nowPlaying, tracks: state.tracks,
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
    const added = tracks.map(track => ({ ...structuredClone(track), id: randomUUID(), requestedBy: { ...requestedBy } }));
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
    this.clearIdle(state);
    if (error) state.lastError = 'The voice connection ended. Join a voice channel to continue the saved queue.';
    try { transport?.destroy(); } catch (cause) { this.logger.warn('Voice cleanup failed:', cause.message); }
    this.persistBackground(state);
    this.changed(state);
  }

  async control(guildId, action, trackId) {
    const state = this.state(guildId);
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
      case 'stop':
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
        break;
      }
      default:
        throw musicError('Unknown playback action.');
    }
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
    if (this.shuttingDown || !state.transport || state.nowPlaying) return;
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
    const generation = ++state.generation;
    const transport = state.transport;
    state.nowPlaying = state.tracks.shift();
    state.opening = true;
    state.paused = false;
    state.abort = new AbortController();
    const track = state.nowPlaying;
    const signal = state.abort.signal;
    this.changed(state);
    this.persistBackground(state);
    let opened;
    try {
      opened = await this.media.open(track, { signal });
      if (state.generation !== generation || this.shuttingDown || state.transport !== transport) {
        this.cleanup(opened);
        return;
      }
      if (track.source === 'youtube' && track.needsValidation && opened.track) {
        // Playlist discovery can omit duration. Media validates before playback;
        // enrich only display fields, retaining request ownership and source identity.
        for (const key of ['title', 'artist', 'durationSec', 'thumbnail', 'needsValidation']) {
          if (Object.hasOwn(opened.track, key)) track[key] = opened.track[key];
        }
        this.persistBackground(state);
      }
      state.opened = opened;
      state.opening = false;
      const finish = error => {
        if (state.generation !== generation) return;
        if (error) {
          state.lastError = `Could not play “${track.title}”. The next song will be tried.`;
          this.logger.warn('Audio playback failed:', error.message);
        }
        this.cancelCurrent(state);
        this.persistBackground(state);
        this.changed(state);
        this.schedule(state);
      };
      transport.play(opened, () => finish(), error => finish(error));
      if (state.paused) transport.pause();
      this.changed(state);
    } catch (error) {
      this.cleanup(opened);
      if (state.generation !== generation || this.shuttingDown) return;
      state.lastError = `Could not play “${track.title}”. The next song will be tried.`;
      this.logger.warn('Could not open song:', error.message);
      this.cancelCurrent(state);
      this.persistBackground(state);
      this.changed(state);
      this.schedule(state);
    }
  }

  cancelCurrent(state) {
    // Invalidate callbacks before stop/destroy, which can synchronously emit Idle/error events.
    ++state.generation;
    state.abort?.abort();
    state.abort = null;
    const opened = state.opened;
    state.opened = null;
    state.nowPlaying = null;
    state.opening = false;
    state.paused = false;
    try { state.transport?.stop(); } catch (error) { this.logger.warn('Audio stop failed:', error.message); }
    this.cleanup(opened);
  }

  cleanup(opened) {
    if (!opened || this.cleaned.has(opened)) return;
    this.cleaned.add(opened);
    try {
      Promise.resolve(opened.cleanup?.()).catch(error => this.logger.warn('Media cleanup failed:', error.message));
      opened.stream?.destroy?.();
    } catch (error) { this.logger.warn('Media cleanup failed:', error.message); }
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
      this.logger.error('Queue persistence failed:', error.message);
      this.changed(state);
    });
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const state of this.states.values()) {
      if (state.nowPlaying) state.tracks.unshift(state.nowPlaying);
      this.cancelCurrent(state);
      const transport = state.transport;
      state.transport = null;
      state.channelId = null;
      state.channelName = null;
      this.clearIdle(state);
      try { transport?.destroy(); } catch (error) { this.logger.warn('Voice cleanup failed:', error.message); }
    }
    await this.persist();
  }
}
