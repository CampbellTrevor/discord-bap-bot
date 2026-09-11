import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { AudioPlayerError, StreamType } from '@discordjs/voice';
import { prepareAudio } from '../src/audio-pipeline.mjs';
import { MusicManager } from '../src/music.mjs';
import { MediaError } from '../src/media.mjs';
import { authorizeControl, authorizeJoin, createBot, formatRequestReply } from '../src/discord.mjs';

const requester = { id: 'user-a', username: 'Listener' };
const quiet = { info() {}, warn() {}, error() {} };
const track = title => ({ title, artist: 'Artist', source: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', durationSec: 120 });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Timed out waiting for the bounded test operation.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function openedAudio() {
  const value = { stream: new PassThrough(), cleanupCount: 0 };
  value.cleanup = () => { ++value.cleanupCount; value.stream.destroy(); };
  return value;
}

function fakeTransport() {
  return {
    plays: [], stopped: 0, destroyed: 0, paused: false,
    play(opened, end, error) { this.plays.push({ opened, end, error }); },
    stop() { ++this.stopped; this.plays.at(-1)?.end(); },
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    destroy() { ++this.destroyed; },
    elapsedSec() { return 2.5; },
  };
}

async function fixture(t, media = { open: async () => openedAudio() }, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'discord-music-test-'));
  const manager = new MusicManager({ media, dataDir, logger: quiet, idleDisconnectMs: 0, preloadCount: 0, ...options });
  t.after(async () => {
    await manager.shutdown();
    // Delete only the exact temporary directory allocated by this fixture.
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('discord-music-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { manager, dataDir };
}

test('guild volume defaults to 50 and persists independently even with empty queues', async t => {
  const { manager, dataDir } = await fixture(t);
  assert.equal(manager.snapshot('guild').volumePercent, 50);
  assert.equal(manager.snapshot('other').volumePercent, 50);
  const changes = [];
  manager.on('change', (guildId, snapshot) => changes.push([guildId, snapshot.volumePercent]));
  assert.equal((await manager.setVolume('guild', 0)).volumePercent, 0);
  assert.equal((await manager.setVolume('other', 100)).volumePercent, 100);
  assert.deepEqual(changes, [['guild', 0], ['other', 100]]);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8'));
  assert.deepEqual(saved.guilds.guild, { tracks: [], nowPlaying: null, volumePercent: 0 });
  assert.deepEqual(saved.guilds.other, { tracks: [], nowPlaying: null, volumePercent: 100 });
  const restored = new MusicManager({ media: {}, dataDir, logger: quiet });
  await restored.restore();
  assert.equal(restored.snapshot('guild').volumePercent, 0);
  assert.equal(restored.snapshot('other').volumePercent, 100);
  assert.equal(restored.snapshot('new').volumePercent, 50);
  await restored.shutdown();
});

test('volume rejects invalid input without changing playback or persisted settings', async t => {
  const { manager, dataDir } = await fixture(t);
  await manager.setVolume('guild', 35);
  const saved = await readFile(path.join(dataDir, 'queues.json'), 'utf8');
  const before = manager.snapshot('guild');
  for (const value of [-1, 101, 50.5, NaN, Infinity, '50', null, undefined, true, {}]) {
    await assert.rejects(manager.setVolume('guild', value), { status: 400 });
  }
  assert.deepEqual(manager.snapshot('guild'), before);
  assert.equal(await readFile(path.join(dataDir, 'queues.json'), 'utf8'), saved);
  await manager.shutdown();
  await assert.rejects(manager.setVolume('guild', 80), { status: 503 });
  assert.equal(manager.snapshot('guild').volumePercent, 35);
});

test('restoration saves safe volume defaults while retaining requests and removing unavailable songs', async t => {
  const { manager, dataDir } = await fixture(t);
  const savedTrack = title => ({ ...track(title), id: title, requestedBy: requester });
  const guilds = {
    legacy: { nowPlaying: savedTrack('Interrupted'), tracks: [savedTrack('Waiting'), { ...savedTrack('Unavailable'), validation: { status: 'unavailable' } }] },
    empty: { nowPlaying: null, tracks: [] },
    muted: { nowPlaying: null, tracks: [], volumePercent: 0 },
    full: { nowPlaying: null, tracks: [], volumePercent: 100 },
  };
  for (const [index, volumePercent] of [-1, 101, 25.5, '90', null, true, {}].entries()) {
    guilds[`invalid-${index}`] = { tracks: [], nowPlaying: null, volumePercent };
  }
  await writeFile(path.join(dataDir, 'queues.json'), JSON.stringify({ version: 1, guilds }));
  await manager.restore();
  assert.deepEqual(manager.snapshot('legacy').tracks.map(item => item.title), ['Interrupted', 'Waiting']);
  assert.deepEqual(manager.snapshot('legacy').tracks.map(item => item.requestedBy), [requester, requester]);
  assert.equal(manager.snapshot('legacy').nowPlaying, null);
  assert.equal(manager.snapshot('legacy').channelId, null);
  const migrated = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8')).guilds;
  for (const id of Object.keys(guilds)) {
    const expected = id === 'muted' ? 0 : id === 'full' ? 100 : 50;
    assert.equal(manager.snapshot(id).volumePercent, expected);
    assert.equal(migrated[id].volumePercent, expected);
  }
  assert.deepEqual(migrated.legacy.tracks.map(item => item.title), ['Interrupted', 'Waiting']);
});

test('volume updates current and parked resources without canceling, unpausing, or reordering', async t => {
  const media = warmMedia();
  const { manager, dataDir } = await fixture(t, media, { preloadCount: 2 });
  const voice = fakeTransport(), prepared = [], initialVolumes = [], playedVolumes = [];
  voice.prepare = async (raw, { volume }) => {
    initialVolumes.push(volume);
    const gains = [];
    const opened = { ...raw, gains, setVolume: value => gains.push(value) };
    prepared.push(opened);
    return opened;
  };
  const play = voice.play;
  voice.play = function (opened, ...callbacks) {
    playedVolumes.push(opened.gains.at(-1));
    play.call(this, opened, ...callbacks);
  };
  await manager.enqueue('guild', ['A', 'B', 'C'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await until(() => manager.preloadEntries.size === 2 && [...manager.preloadEntries].every(entry => entry.status === 'ready'));
  assert.deepEqual(initialVolumes, [0.5, 0.5, 0.5]);
  assert.deepEqual(playedVolumes, [0.5]);
  await manager.control('guild', 'pause');
  const before = manager.snapshot('guild'), generation = manager.state('guild').generation;
  const parked = [...manager.preloadEntries], stopped = voice.stopped;
  const result = await manager.setVolume('guild', 0);
  assert.deepEqual(result, { ...before, volumePercent: 0 });
  assert.deepEqual(prepared.map(source => source.gains.at(-1)), [0, 0, 0]);
  await manager.setVolume('guild', 23);
  assert.deepEqual(prepared.map(source => source.gains.at(-1)), [0.23, 0.23, 0.23]);
  assert.deepEqual([...manager.preloadEntries], parked);
  assert.equal(manager.state('guild').generation, generation);
  assert.equal(voice.plays.length, 1);
  assert.equal(voice.plays[0].opened, prepared[0]);
  assert.equal(voice.stopped, stopped);
  assert.equal(voice.paused, true);
  assert.equal(media.calls.length, 3);
  assert.ok(media.calls.every(call => !call.signal.aborted && call.opened.cleanupCount === 0));
  await manager.shutdown();
  const restored = new MusicManager({ media: {}, dataDir, logger: quiet });
  await restored.restore();
  assert.equal(restored.snapshot('guild').volumePercent, 23);
  assert.deepEqual(restored.snapshot('guild').tracks.map(item => item.title), ['A', 'B', 'C']);
  await restored.shutdown();
});

test('volume changes during preparation and handoff apply before the first consumed packet', async t => {
  const media = warmMedia();
  const { manager } = await fixture(t, media, { preloadCount: 1 });
  const voice = fakeTransport(), preparation = [], playedVolumes = [];
  voice.prepare = (raw, options) => {
    const pending = deferred(), gains = [];
    const opened = { ...raw, gains, setVolume: value => gains.push(value) };
    preparation.push({ ...pending, options, opened });
    return pending.promise;
  };
  const play = voice.play;
  voice.play = function (opened, ...callbacks) {
    playedVolumes.push(opened.gains.at(-1));
    play.call(this, opened, ...callbacks);
  };
  await manager.enqueue('guild', ['A', 'B'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await until(() => preparation.length === 1);
  assert.equal(preparation[0].options.volume, 0.5);
  await manager.setVolume('guild', 0);
  assert.equal(preparation[0].options.signal.aborted, false);
  preparation[0].resolve(preparation[0].opened);
  await until(() => preparation.length === 2);
  assert.deepEqual(playedVolumes, [0]);
  assert.equal(preparation[1].options.volume, 0);
  await manager.setVolume('guild', 100);
  assert.equal(preparation[1].options.signal.aborted, false);
  preparation[1].resolve(preparation[1].opened);
  await until(() => [...manager.preloadEntries][0]?.status === 'ready');
  assert.equal(preparation[1].opened.gains.at(-1), 1);
  voice.plays[0].end();
  await manager.setVolume('guild', 25);
  await until(() => voice.plays.length === 2);
  assert.deepEqual(playedVolumes, [0, 0.25]);
  assert.equal(voice.plays[1].opened, preparation[1].opened);
  assert.equal(media.calls.length, 2);
});

test('volume leaves pending metadata validation running and canceled preparation stays canceled', async t => {
  const checking = deferred(), checkSignals = [], preparing = deferred();
  const media = {
    async open() { return openedAudio(); },
    preflight(_item, { signal }) { checkSignals.push(signal); return checking.promise; },
  };
  const { manager } = await fixture(t, media, { validationDelayMs: 1 });
  await manager.enqueue('guild', [track('A')], requester);
  await until(() => checkSignals.length === 1);
  await manager.setVolume('guild', 70);
  assert.equal(checkSignals[0].aborted, false);
  checking.resolve({ ...track('A') });
  await until(() => !manager.validationEntry);
  const voice = fakeTransport();
  let prepared, prepareSignal;
  voice.prepare = (raw, { signal, volume }) => {
    assert.equal(volume, 0.7);
    prepareSignal = signal;
    const gains = [];
    prepared = { ...raw, gains, setVolume: value => gains.push(value) };
    return preparing.promise;
  };
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await until(() => prepared);
  await manager.setVolume('guild', 65);
  await manager.control('guild', 'stop');
  assert.equal(prepareSignal.aborted, true);
  preparing.resolve(prepared);
  await until(() => prepared.stream.destroyed);
  assert.deepEqual(prepared.gains, []);
  assert.equal(voice.plays.length, 0);
  assert.equal(manager.snapshot('guild').volumePercent, 65);
  assert.deepEqual(manager.snapshot('guild').tracks, []);
});

test('skip during asynchronous opening discards and cleans the stale song', async t => {
  const first = deferred();
  const second = deferred();
  const signals = [];
  let count = 0;
  const { manager } = await fixture(t, { open: (_track, { signal }) => { signals.push(signal); return ++count === 1 ? first.promise : second.promise; } });
  const voice = fakeTransport();
  await manager.enqueue('guild', [track('First'), track('Second')], requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await turn();
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'First');
  await manager.control('guild', 'skip');
  await turn();
  assert.equal(signals[0].aborted, true);
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Second');
  const stale = openedAudio();
  first.resolve(stale);
  await turn();
  assert.equal(stale.cleanupCount, 1);
  assert.equal(voice.plays.length, 0);
  const current = openedAudio();
  second.resolve(current);
  await turn();
  assert.equal(voice.plays.length, 1);
  assert.equal(voice.plays[0].opened, current);
  assert.equal(manager.snapshot('guild').playing, true);
});

test('stop clears the queue and late open results never start playback', async t => {
  const pending = deferred();
  const { manager } = await fixture(t, { open: () => pending.promise });
  const voice = fakeTransport();
  await manager.enqueue('guild', [track('First'), track('Second')], requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await turn();
  await manager.control('guild', 'stop');
  const stale = openedAudio();
  pending.resolve(stale);
  await turn();
  assert.equal(stale.cleanupCount, 1);
  assert.equal(voice.plays.length, 0);
  assert.deepEqual(manager.snapshot('guild').tracks, []);
  assert.equal(manager.snapshot('guild').nowPlaying, null);
});

test('stale Idle/error callbacks cannot end the next song; resources clean exactly once', async t => {
  const { manager } = await fixture(t);
  const voice = fakeTransport();
  await manager.enqueue('guild', [track('First'), track('Second')], requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await turn();
  const first = voice.plays[0];
  first.end();
  await turn();
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Second');
  first.error(new Error('Late error from destroyed stream'));
  first.end();
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Second');
  assert.equal(first.opened.cleanupCount, 1);
  await manager.control('guild', 'stop');
  assert.equal(voice.plays[1].opened.cleanupCount, 1);
});

test('all unavailable tracks are attempted once and the queue finishes without recursion', async t => {
  const attempts = [];
  const { manager } = await fixture(t, { open: async item => { attempts.push(item.title); throw new Error('Source unavailable'); } });
  await manager.enqueue('guild', [track('One'), track('Two'), track('Three')], requester);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  for (let index = 0; index < 8; ++index) await turn();
  assert.deepEqual(attempts, ['One', 'Two', 'Three']);
  assert.equal(manager.snapshot('guild').nowPlaying, null);
  assert.equal(manager.snapshot('guild').tracks.length, 0);
  assert.match(manager.snapshot('guild').lastError, /Could not play/);
});

test('pause while media opens is honored when playback starts', async t => {
  const pending = deferred();
  const { manager } = await fixture(t, { open: () => pending.promise });
  const voice = fakeTransport();
  await manager.enqueue('guild', [track('One')], requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await turn();
  await manager.control('guild', 'pause');
  pending.resolve(openedAudio());
  await turn();
  assert.equal(manager.snapshot('guild').paused, true);
  assert.equal(voice.paused, true);
  assert.equal(manager.snapshot('guild').playing, false);
  await manager.control('guild', 'resume');
  assert.equal(voice.paused, false);
  assert.equal(manager.snapshot('guild').playing, true);
});

test('leave preserves interrupted song and ignores disconnect events from an old transport', async t => {
  const { manager } = await fixture(t);
  const firstVoice = fakeTransport();
  await manager.enqueue('guild', [track('One'), track('Two')], requester);
  manager.attach('guild', firstVoice, { id: 'voice-1', name: 'Lounge' });
  await turn();
  await manager.control('guild', 'leave');
  assert.equal(manager.snapshot('guild').channelId, null);
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['One', 'Two']);
  assert.equal(firstVoice.plays[0].opened.cleanupCount, 1);
  const secondVoice = fakeTransport();
  manager.attach('guild', secondVoice, { id: 'voice-2', name: 'New Lounge' });
  manager.detach('guild', true, new Error('Old disconnect'), firstVoice);
  await turn();
  assert.equal(manager.snapshot('guild').channelId, 'voice-2');
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'One');
});

test('serialized writes restore the interrupted track first and never auto-connect', async t => {
  const { manager, dataDir } = await fixture(t);
  await Promise.all([
    manager.enqueue('guild', [track('First')], requester),
    manager.enqueue('guild', [track('Second')], requester),
    manager.enqueue('other-guild', [track('Other server')], requester),
  ]);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  await turn();
  await manager.writes;
  const persisted = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8'));
  assert.equal(persisted.guilds.guild.nowPlaying.title, 'First');
  const restored = new MusicManager({ media: {}, dataDir, logger: quiet });
  await restored.restore();
  assert.deepEqual(restored.snapshot('guild').tracks.map(item => item.title), ['First', 'Second']);
  assert.equal(restored.snapshot('guild').channelId, null);
  assert.equal(restored.snapshot('guild').nowPlaying, null);
  await manager.shutdown();
  const afterShutdown = new MusicManager({ media: {}, dataDir, logger: quiet });
  await afterShutdown.restore();
  assert.deepEqual(afterShutdown.snapshot('guild').tracks.map(item => item.title), ['First', 'Second']);
  assert.equal(afterShutdown.snapshot('other-guild').tracks[0].title, 'Other server');
});

test('concurrent enqueue calls cannot exceed the queue limit', async t => {
  const { manager } = await fixture(t, undefined, { maxQueueSize: 2 });
  const results = await Promise.allSettled([
    manager.enqueue('guild', [track('First')], requester),
    manager.enqueue('guild', [track('Second')], requester),
    manager.enqueue('guild', [track('Third')], requester),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(manager.snapshot('guild').tracks.length, 2);
  const snapshot = manager.snapshot('guild');
  snapshot.tracks[0].title = 'Mutation attempt';
  assert.equal(manager.snapshot('guild').tracks[0].title, 'First');
});

test('an empty queue disconnects after the configured idle timeout', async t => {
  const { manager } = await fixture(t, undefined, { idleDisconnectMs: 15 });
  const voice = fakeTransport();
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(manager.snapshot('guild').channelId, null);
  assert.equal(voice.destroyed, 1);
});

test('controls require the current voice channel or manager; removal belongs to the requester', () => {
  const snapshot = { channelId: 'lounge', nowPlaying: track('Current'), tracks: [{ ...track('Next'), id: 'request-1', requestedBy: requester }] };
  assert.throws(() => authorizeControl({ manager: false, userId: 'user-b', voiceChannelId: 'elsewhere', snapshot, action: 'skip' }), { status: 403 });
  assert.doesNotThrow(() => authorizeControl({ manager: false, userId: 'user-b', voiceChannelId: 'lounge', snapshot, action: 'skip' }));
  assert.doesNotThrow(() => authorizeControl({ manager: true, userId: 'user-b', voiceChannelId: null, snapshot, action: 'stop' }));
  assert.doesNotThrow(() => authorizeControl({ manager: false, userId: 'user-a', voiceChannelId: null, snapshot, action: 'remove', trackId: 'request-1' }));
  assert.throws(() => authorizeControl({ manager: false, userId: 'user-b', voiceChannelId: 'lounge', snapshot, action: 'remove', trackId: 'request-1' }), { status: 403 });
  assert.throws(() => authorizeControl({ manager: false, userId: 'user-a', voiceChannelId: 'elsewhere', snapshot, action: 'shuffle' }), { status: 403 });
  assert.doesNotThrow(() => authorizeControl({ manager: false, userId: 'user-b', voiceChannelId: 'lounge', snapshot, action: 'shuffle' }));
  assert.doesNotThrow(() => authorizeControl({ manager: true, userId: 'user-b', voiceChannelId: null, snapshot, action: 'shuffle' }));
});

test('joining from another voice channel cannot hijack an active queue', () => {
  const snapshot = { channelId: 'lounge', nowPlaying: track('Current'), tracks: [] };
  assert.throws(() => authorizeJoin({ manager: false, voiceChannelId: 'other', targetChannelId: 'other', snapshot }), { status: 409 });
  assert.throws(() => authorizeJoin({ manager: false, voiceChannelId: null, targetChannelId: 'lounge', snapshot }), { status: 403 });
  assert.doesNotThrow(() => authorizeJoin({ manager: true, voiceChannelId: null, targetChannelId: 'other', snapshot }));
  assert.doesNotThrow(() => authorizeJoin({ manager: false, voiceChannelId: 'other', targetChannelId: 'other', snapshot: { ...snapshot, nowPlaying: null } }));
});

test('failed startup and shutdown before startup preserve the original queue file', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'discord-music-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('discord-music-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  const filename = path.join(dataDir, 'queues.json');
  const original = '{ "version": 1, "guilds": { "unfinished":';
  await writeFile(filename, original);
  const config = { dataDir, maxQueueSize: 100, idleDisconnectMs: 0 };
  const failedBot = createBot({ config, media: {}, logger: quiet });
  await assert.rejects(failedBot.start(), /Could not read saved queues/);
  await failedBot.shutdown();
  assert.equal(await readFile(filename, 'utf8'), original);
  const unstartedBot = createBot({ config, media: {}, logger: quiet });
  await unstartedBot.shutdown();
  assert.equal(await readFile(filename, 'utf8'), original);
});

test('shutdown during restoration prevents Discord login from starting afterward', async t => {
  const { dataDir } = await fixture(t);
  const bot = createBot({ config: { dataDir }, media: {}, logger: quiet });
  const restoring = deferred();
  bot.music.restore = () => restoring.promise;
  const starting = bot.start();
  await bot.shutdown();
  restoring.resolve();
  await assert.rejects(starting, /Bot startup was cancelled/);
  assert.equal(bot.isReady(), false);
});

test('shuffle persists pending order while preserving the current resource, pause state, and every request', async t => {
  const randomBounds = [];
  const { manager, dataDir } = await fixture(t, undefined, { randomIndex: bound => { randomBounds.push(bound); return 0; } });
  const voice = fakeTransport();
  const added = await manager.enqueue('guild', [track('Current'), track('One'), track('Two'), track('Three')], requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await turn();
  await manager.control('guild', 'pause');
  const state = manager.state('guild');
  const opened = state.opened;
  const abort = state.abort;
  const generation = state.generation;
  const snapshot = await manager.control('guild', 'shuffle');
  assert.deepEqual(snapshot.tracks.map(item => item.title), ['Two', 'Three', 'One']);
  assert.deepEqual(randomBounds, [3, 2]);
  assert.deepEqual(snapshot.tracks.map(item => item.id).sort(), added.slice(1).map(item => item.id).sort());
  assert.deepEqual(snapshot.tracks.map(item => item.requestedBy), [requester, requester, requester]);
  assert.equal(snapshot.nowPlaying.id, added[0].id);
  assert.equal(snapshot.paused, true);
  assert.equal(snapshot.elapsedSec, 2.5);
  assert.equal(state.opened, opened);
  assert.equal(state.abort, abort);
  assert.equal(state.generation, generation);
  assert.equal(abort.signal.aborted, false);
  assert.equal(opened.cleanupCount, 0);
  assert.equal(voice.plays.length, 1);
  assert.equal(voice.stopped, 0);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8'));
  assert.deepEqual(saved.guilds.guild.tracks.map(item => item.id), snapshot.tracks.map(item => item.id));
  const restored = new MusicManager({ media: {}, dataDir, logger: quiet });
  await restored.restore();
  assert.deepEqual(restored.snapshot('guild').tracks.map(item => item.title), ['Current', 'Two', 'Three', 'One']);
});

test('shuffle during media opening leaves the in-flight track and abort signal intact', async t => {
  const opening = deferred();
  let signal;
  const { manager } = await fixture(t, { open: (_track, options) => { signal = options.signal; return opening.promise; } }, { randomIndex: () => 0 });
  const voice = fakeTransport();
  await manager.enqueue('guild', [track('Opening'), track('One'), track('Two')], requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await turn();
  await manager.control('guild', 'shuffle');
  assert.equal(signal.aborted, false);
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Opening');
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['Two', 'One']);
  const opened = openedAudio();
  opening.resolve(opened);
  await turn();
  assert.equal(voice.plays.length, 1);
  assert.equal(voice.plays[0].opened, opened);
});

test('shuffle requires at least two waiting tracks and leaves undersized queues unchanged', async t => {
  const { manager } = await fixture(t);
  await assert.rejects(manager.control('guild', 'shuffle'), { status: 409 });
  await manager.enqueue('guild', [track('Only song')], requester);
  const before = manager.snapshot('guild');
  await assert.rejects(manager.control('guild', 'shuffle'), /At least two songs must be waiting/);
  assert.deepEqual(manager.snapshot('guild'), before);
});

test('a playlist batch is accepted in full and in order, or rejected without adding any tracks', async t => {
  const { manager } = await fixture(t, undefined, { maxQueueSize: 4 });
  const voice = fakeTransport();
  await manager.enqueue('guild', [track('Current'), track('Existing')], requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await turn();
  const before = manager.snapshot('guild');
  await assert.rejects(manager.enqueue('guild', [track('A'), track('B'), track('C')], requester), error => {
    assert.equal(error.status, 409);
    assert.match(error.message, /3 tracks, but only 2 queue slots/);
    assert.match(error.message, /Nothing was added/);
    return true;
  });
  assert.deepEqual(manager.snapshot('guild'), before);
  const added = await manager.enqueue('guild', [track('A'), track('B')], { id: 'playlist-user', username: 'Playlist listener' });
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['Existing', 'A', 'B']);
  assert.deepEqual(added.map(item => item.requestedBy.id), ['playlist-user', 'playlist-user']);
  assert.equal(new Set(added.map(item => item.id)).size, 2);
  assert.equal(manager.capacity('guild'), 0);
});

test('concurrent playlist imports reserve full batches without overflow or interleaving', async t => {
  const { manager, dataDir } = await fixture(t, undefined, { maxQueueSize: 4 });
  const results = await Promise.allSettled([
    manager.enqueue('guild', [track('A1'), track('A2'), track('A3')], requester),
    manager.enqueue('guild', [track('B1'), track('B2'), track('B3')], requester),
    manager.enqueue('guild', [track('C1')], requester),
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(results[1].reason.status, 409);
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['A1', 'A2', 'A3', 'C1']);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8'));
  assert.deepEqual(saved.guilds.guild.tracks.map(item => item.title), ['A1', 'A2', 'A3', 'C1']);
});

test('validated YouTube playlist metadata updates display fields without replacing request identity', async t => {
  const media = { open: async () => ({ ...openedAudio(), track: { title: 'Verified title', artist: 'Verified artist', durationSec: 243, thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg', needsValidation: false, id: 'untrusted-id', requestedBy: { id: 'different-user' }, source: 'spotify', sourceUrl: 'https://example.com/' } }) };
  const { manager, dataDir } = await fixture(t, media);
  const [added] = await manager.enqueue('guild', [{ ...track('Flat title'), durationSec: null, needsValidation: true }], requester);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  await turn();
  const current = manager.snapshot('guild').nowPlaying;
  assert.equal(current.title, 'Verified title');
  assert.equal(current.artist, 'Verified artist');
  assert.equal(current.durationSec, 243);
  assert.equal(current.needsValidation, false);
  assert.equal(current.id, added.id);
  assert.equal(current.source, 'youtube');
  assert.equal(current.sourceUrl, added.sourceUrl);
  assert.deepEqual(current.requestedBy, requester);
  await manager.writes;
  const saved = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8'));
  assert.equal(saved.guilds.guild.nowPlaying.durationSec, 243);
});

test('playlist slash replies include actual accepted counts, skipped entries, limits, and safe warnings', () => {
  const result = { added: [track('First'), track('Second')], import: { title: '@everyone **Playlist**', accepted: 2, inspected: 50, skipped: 3, total: 80, limitReached: true }, warnings: ['Some @everyone tracks require validation.'] };
  const message = formatRequestReply(result);
  assert.match(message, /Added \*\*2 tracks\*\*/);
  assert.match(message, /3 playlist entries were skipped/);
  assert.match(message, /first 50 playlist entries/);
  assert.match(message, /Some everyone tracks require validation/);
  assert.doesNotMatch(message, /@everyone/);
  assert.equal(formatRequestReply({ added: [track('Single')], warnings: [] }), 'Added **Single** to the queue.');
});

test('trusted media-open failures retain actionable message and code while advancing the queue', async t => {
  const logs = [];
  const message = 'The bot host could not run the YouTube extractor correctly. The owner needs to check yt-dlp and its JavaScript dependencies.';
  const media = { open: async item => {
    if (item.title === 'Lovesick Girls') throw new MediaError(message, 'EXTRACTOR_RUNTIME_UNAVAILABLE');
    return openedAudio();
  } };
  const { manager } = await fixture(t, media, { logger: { warn: (...args) => logs.push(args), error() {} } });
  await manager.enqueue('guild', [track('Lovesick Girls'), track('Next')], requester);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  for (let index = 0; index < 5; ++index) await turn();
  const snapshot = manager.snapshot('guild');
  assert.equal(snapshot.nowPlaying.title, 'Next');
  assert.ok(snapshot.lastError.includes(message));
  assert.match(snapshot.lastError, /\[EXTRACTOR_RUNTIME_UNAVAILABLE\]/);
  assert.deepEqual(logs, [['Music operation failed.', { operation: 'media-open', code: 'EXTRACTOR_RUNTIME_UNAVAILABLE', type: 'MediaError' }]]);
});

test('original media stream errors survive Discord wrappers and an Idle event arriving first', async t => {
  for (const completion of ['wrapped-error', 'idle']) {
    const logs = [];
    const { manager } = await fixture(t, undefined, { logger: { warn: (...args) => logs.push(args), error() {} } });
    const voice = fakeTransport();
    await manager.enqueue('guild', [track('Current')], requester);
    manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
    await turn();
    const playing = voice.plays[0];
    const failure = new MediaError('YouTube is rate limiting this bot. Please wait before trying again.', 'YOUTUBE_RATE_LIMITED');
    const wrapped = new AudioPlayerError(failure, {});
    assert.equal(wrapped.code, undefined);
    assert.equal(wrapped instanceof MediaError, false);
    playing.opened.stream.emit('error', failure);
    if (completion === 'wrapped-error') playing.error(wrapped);
    else playing.end();
    assert.match(manager.snapshot('guild').lastError, /YouTube is rate limiting this bot/);
    assert.match(manager.snapshot('guild').lastError, /\[YOUTUBE_RATE_LIMITED\]/);
    assert.equal(playing.opened.cleanupCount, 1);
    assert.deepEqual(logs, [['Music operation failed.', { operation: 'audio-playback', code: 'YOUTUBE_RATE_LIMITED', type: 'MediaError' }]]);
  }
});

test('untrusted errors cannot impersonate MediaError or leak process messages, URLs, and secrets', async t => {
  const logs = [];
  const sensitive = 'https://provider.invalid/audio?token=private-value stderr /private/process/path';
  const failure = Object.assign(new Error(sensitive), { name: 'MediaError', code: 'YOUTUBE_REQUEST_BLOCKED' });
  const { manager } = await fixture(t, { open: async () => { throw failure; } }, { logger: { warn: (...args) => logs.push(args), error() {} } });
  await manager.enqueue('guild', [track('Song')], requester);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  await turn();
  const displayed = manager.snapshot('guild').lastError;
  assert.match(displayed, /\[AUDIO_SOURCE_FAILED\]/);
  assert.doesNotMatch(displayed, /provider\.invalid|private-value|process\/path|YOUTUBE_REQUEST_BLOCKED/);
  assert.deepEqual(logs, [['Music operation failed.', { operation: 'media-open', code: 'AUDIO_SOURCE_FAILED', type: 'Error' }]]);
});

test('missing FFmpeg is reported as an audio-start failure rather than a provider failure', async t => {
  const logs = [];
  const opened = openedAudio();
  const { manager } = await fixture(t, { open: async () => opened }, { logger: { warn: (...args) => logs.push(args), error() {} } });
  const voice = fakeTransport();
  voice.play = () => { throw new Error('FFmpeg/avconv not found!'); };
  await manager.enqueue('guild', [track('Song')], requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await turn();
  assert.match(manager.snapshot('guild').lastError, /FFmpeg is missing from the bot host/);
  assert.match(manager.snapshot('guild').lastError, /\[FFMPEG_UNAVAILABLE\]/);
  assert.equal(opened.cleanupCount, 1);
  assert.deepEqual(logs, [['Music operation failed.', { operation: 'audio-start', code: 'FFMPEG_UNAVAILABLE', type: 'Error' }]]);
});

test('cleanup diagnostics exclude raw exception messages', async t => {
  const logs = [];
  const opened = openedAudio();
  opened.cleanup = () => { throw new Error('https://provider.invalid/?secret=private-token'); };
  const { manager } = await fixture(t, { open: async () => opened }, { logger: { warn: (...args) => logs.push(args), error() {} } });
  await manager.enqueue('guild', [track('Song')], requester);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  await turn();
  await manager.control('guild', 'stop');
  assert.deepEqual(logs, [['Music operation failed.', { operation: 'media-cleanup', code: 'MEDIA_CLEANUP_FAILED', type: 'Error' }]]);
  assert.doesNotMatch(JSON.stringify(logs), /private-token|provider\.invalid/);
});

const settle = async () => { for (let index = 0; index < 4; index += 1) await turn(); };
function warmMedia() {
  const calls = [];
  return { calls, async open(item, { signal }) {
    const opened = openedAudio();
    opened.stream.write(Buffer.from(`audio:${item.title}`));
    calls.push({ title: item.title, signal, opened });
    return opened;
  } };
}

test('preloads only the next two audio sources and promotes the same buffered bytes in queue order', async t => {
  const media = warmMedia();
  const { manager } = await fixture(t, media, { preloadCount: 2 });
  const metrics = [];
  manager.on('playbackMetric', value => metrics.push(value));
  const voice = fakeTransport();
  await manager.enqueue('guild', ['A', 'B', 'C', 'D'].map(track), requester);
  assert.equal(media.calls.length, 0);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  assert.deepEqual(media.calls.map(call => call.title), ['A', 'B', 'C']);
  assert.equal(voice.plays.length, 1);
  const state = manager.state('guild');
  const warm = state.preloads.get(state.tracks[0].id);
  assert.equal(warm.opened.stream.readableLength, Buffer.byteLength('audio:B'));
  assert.equal(manager.preloadEntries.size, 2);
  voice.plays[0].end();
  await settle();
  assert.equal(voice.plays[1].opened, warm.opened);
  assert.equal(voice.plays[1].opened.stream.read().toString(), 'audio:B');
  assert.deepEqual(media.calls.map(call => call.title), ['A', 'B', 'C', 'D']);
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['C', 'D']);
  assert.equal(media.calls[1].signal.aborted, false);
  assert.deepEqual(metrics.map(value => [value.outcome, value.preloaded]), [['ready', false], ['ready', true]]);
  for (const metric of metrics) {
    assert.ok(metric.durationMs >= 0);
    assert.deepEqual(Object.keys(metric).sort(), ['durationMs', 'outcome', 'preloaded']);
  }
});

test('preload buffers apply backpressure and do not download whole long sources', async t => {
  const sources = [];
  const media = { async open(item) {
    if (item.title === 'Current') return openedAudio();
    let bytes = 0;
    const stream = new Readable({ highWaterMark: 16 * 1024, read() { bytes += 16 * 1024; this.push(Buffer.alloc(16 * 1024, 7)); } });
    sources.push({ stream, bytes: () => bytes });
    return { stream, cleanup: () => stream.destroy() };
  } };
  const { manager } = await fixture(t, media, { preloadCount: 2 });
  await manager.enqueue('guild', [track('Current'), { ...track('Long one'), durationSec: 3600 }, { ...track('Long two'), durationSec: 3600 }, track('Not loaded')], requester);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  await settle();
  assert.equal(sources.length, 2);
  const before = sources.map(source => source.bytes());
  for (const bytes of before) assert.ok(bytes >= 256 * 1024 && bytes <= 512 * 1024);
  await settle();
  assert.deepEqual(sources.map(source => source.bytes()), before);
  await manager.control('guild', 'stop');
  assert.ok(sources.every(source => source.stream.destroyed));
  assert.equal(manager.preloadEntries.size, 0);
});

test('removing or moving pending songs reconciles preloads without changing current playback', async t => {
  const media = warmMedia();
  const { manager } = await fixture(t, media, { preloadCount: 2 });
  const voice = fakeTransport();
  const added = await manager.enqueue('guild', ['A', 'B', 'C', 'D'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  const current = manager.state('guild').opened;
  await manager.control('guild', 'move-top', added[3].id);
  await settle();
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['D', 'B', 'C']);
  assert.equal(media.calls.find(call => call.title === 'C').opened.cleanupCount, 1);
  assert.equal(media.calls.find(call => call.title === 'B').opened.cleanupCount, 0);
  assert.equal(manager.state('guild').opened, current);
  const plays = voice.plays.length;
  await manager.control('guild', 'move-top', added[3].id);
  assert.equal(voice.plays.length, plays);
  await assert.rejects(manager.control('guild', 'move-top', 'missing'), { status: 404 });
  await manager.control('guild', 'remove', added[1].id);
  await settle();
  assert.equal(media.calls.find(call => call.title === 'B').opened.cleanupCount, 1);
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['D', 'C']);
  assert.equal(manager.snapshot('guild').nowPlaying.id, added[0].id);
});

test('shuffle cancels only preloads that leave the next-two window and preserves pause', async t => {
  const media = warmMedia();
  const { manager } = await fixture(t, media, { preloadCount: 2, randomIndex: () => 0 });
  const voice = fakeTransport();
  await manager.enqueue('guild', ['A', 'B', 'C', 'D'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  await manager.control('guild', 'pause');
  await manager.control('guild', 'shuffle');
  assert.equal(manager.snapshot('guild').paused, true);
  assert.equal(voice.paused, true);
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['C', 'D', 'B']);
  assert.equal(media.calls.find(call => call.title === 'B').signal.aborted, true);
  assert.equal(media.calls.find(call => call.title === 'C').signal.aborted, false);
  assert.equal(media.calls.some(call => call.title === 'D'), false);
  await manager.control('guild', 'resume');
  await settle();
  assert.equal(media.calls.some(call => call.title === 'D'), true);
});

test('pending preload cancellation discards late results and never stalls foreground playback', async t => {
  const pending = deferred();
  const media = warmMedia();
  const normal = media.open.bind(media);
  let pendingSignal;
  let attempts = 0;
  media.open = async (item, options) => {
    if (item.title === 'B' && ++attempts === 1) { pendingSignal = options.signal; return pending.promise; }
    return normal(item, options);
  };
  const { manager } = await fixture(t, media, { preloadCount: 2 });
  const voice = fakeTransport();
  await manager.enqueue('guild', ['A', 'B', 'C'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  voice.plays[0].end();
  await settle();
  assert.equal(pendingSignal.aborted, true);
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'B');
  assert.equal(voice.plays.length, 2);
  const stale = openedAudio();
  pending.resolve(stale);
  await settle();
  assert.equal(stale.cleanupCount, 1);
  assert.notEqual(voice.plays[1].opened, stale);
});

test('failed preloads fall back once on demand without changing the queue or reporting a playback error early', async t => {
  const media = warmMedia();
  const normal = media.open.bind(media);
  let attempts = 0;
  media.open = async (item, options) => {
    if (item.title === 'B' && ++attempts === 1) throw new MediaError('Provider unavailable.', 'YOUTUBE_UNAVAILABLE');
    return normal(item, options);
  };
  const { manager } = await fixture(t, media, { preloadCount: 2 });
  const metrics = [];
  manager.on('playbackMetric', metric => metrics.push(metric));
  const voice = fakeTransport();
  await manager.enqueue('guild', ['A', 'B'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  manager.syncPreloads();
  await settle();
  assert.equal(attempts, 1);
  assert.equal(manager.snapshot('guild').lastError, null);
  assert.equal(metrics.length, 1);
  voice.plays[0].end();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'B');
  assert.equal(metrics.at(-1).preloaded, false);
});

test('long songs defer warming and expired parked streams refresh only in the next playback window', async t => {
  const media = warmMedia();
  const { manager } = await fixture(t, media, { preloadCount: 2, preloadTtlMs: 25 });
  const voice = fakeTransport();
  let elapsed = 0;
  voice.elapsedSec = () => elapsed;
  await manager.enqueue('guild', [{ ...track('A'), durationSec: 3600 }, { ...track('B'), durationSec: 3600 }, track('C')], requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  assert.deepEqual(media.calls.map(call => call.title), ['A']);
  elapsed = 3500;
  manager.syncPreloads();
  await settle();
  assert.deepEqual(media.calls.map(call => call.title), ['A', 'B', 'C']);
  elapsed = 0;
  voice.plays[0].end();
  await settle();
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(media.calls.find(call => call.title === 'C').opened.cleanupCount, 1);
  assert.equal(manager.preloadEntries.size, 0);
  manager.syncPreloads();
  assert.equal(media.calls.length, 3);
  elapsed = 3500;
  manager.syncPreloads();
  await settle();
  assert.equal(media.calls.filter(call => call.title === 'C').length, 2);
});

test('leave and shutdown clean all warm sources and restore preserves queue order without prefetching', async t => {
  const media = warmMedia();
  const { manager, dataDir } = await fixture(t, media, { preloadCount: 2 });
  await manager.enqueue('guild', ['A', 'B', 'C'].map(track), requester);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  await settle();
  await manager.control('guild', 'leave');
  assert.equal(manager.preloadEntries.size, 0);
  assert.ok(media.calls.every(call => call.signal.aborted && call.opened.cleanupCount === 1));
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['A', 'B', 'C']);
  const restored = new MusicManager({ media: { open: () => assert.fail('Restoration must not preload') }, dataDir });
  await restored.restore();
  assert.deepEqual(restored.snapshot('guild').tracks.map(item => item.title), ['A', 'B', 'C']);
  await restored.shutdown();
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  await settle();
  await manager.shutdown();
  assert.equal(manager.preloadEntries.size, 0);
  assert.ok(media.calls.every(call => call.opened.cleanupCount === 1));
});

test('an early parked-source failure retries the same request cold, while a late Idle error never replays it', async t => {
  for (const failedAfter of [0.5, 30]) {
    const media = warmMedia();
    const { manager } = await fixture(t, media, { preloadCount: 2 });
    const voice = fakeTransport();
    let elapsed = 0;
    voice.elapsedSec = () => elapsed;
    const added = await manager.enqueue('guild', ['A', 'B', 'C'].map(track), requester);
    manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
    await settle();
    voice.plays[0].end();
    await settle();
    elapsed = failedAfter;
    voice.plays[1].opened.stream.emit('error', new MediaError('Provider stream ended.', 'YOUTUBE_UNAVAILABLE'));
    elapsed = 0; // Discord Idle has discarded the failed resource by this point.
    voice.plays[1].end();
    await settle();
    assert.equal(manager.snapshot('guild').nowPlaying.id, failedAfter < 2 ? added[1].id : added[2].id);
    assert.equal(media.calls.filter(call => call.title === 'B').length, failedAfter < 2 ? 2 : 1);
    if (failedAfter < 2) {
      const cold = voice.plays.at(-1);
      cold.opened.stream.emit('error', new MediaError('Still unavailable.', 'YOUTUBE_UNAVAILABLE'));
      cold.end();
      await settle();
      assert.equal(manager.snapshot('guild').nowPlaying.id, added[2].id);
      assert.equal(media.calls.filter(call => call.title === 'B').length, 2);
    }
  }
});

test('foreground retries only marked no-work capacity failures after cancelling speculation', async t => {
  for (const marked of [true, false]) {
    const media = warmMedia();
    const normal = media.open.bind(media);
    let calls = 0;
    media.open = async (item, options) => {
      if (item.title === 'New guild' && ++calls === 1) {
        const error = new MediaError('Provider busy.', 'MEDIA_BUSY');
        if (marked) error.retryableBeforeStart = true;
        throw error;
      }
      return normal(item, options);
    };
    const { manager } = await fixture(t, media, { preloadCount: 2 });
    await manager.enqueue('first', ['A', 'B', 'C'].map(track), requester);
    manager.attach('first', fakeTransport(), { id: 'voice', name: 'Lounge' });
    await settle();
    await manager.enqueue('second', [track('New guild')], requester);
    manager.attach('second', fakeTransport(), { id: 'other', name: 'Other' });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(calls, marked ? 2 : 1);
    assert.equal(manager.snapshot('second').nowPlaying?.title || null, marked ? 'New guild' : null);
    assert.ok(manager.preloadEntries.size <= 2);
  }
});

test('foreground metrics classify safe provider errors and exclude speculative attempts', async t => {
  const { manager } = await fixture(t, { open: async () => { throw new MediaError('Spotify quota reached.', 'SPOTIFY_QUOTA_EXCEEDED'); } });
  const metrics = [];
  manager.on('playbackMetric', metric => metrics.push(metric));
  await manager.enqueue('guild', [track('Private title')], requester);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  await settle();
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].outcome, 'error');
  assert.equal(metrics[0].code, 'SPOTIFY_QUOTA_EXCEEDED');
  assert.equal(metrics[0].preloaded, false);
  assert.doesNotMatch(JSON.stringify(metrics), /Private title|guild|user-a|https/);
});

test('prepared preloads retain packet boundaries and reuse the exact ready resource at transition', async t => {
  const sources = [];
  const media = { async open(item) {
    const stream = new PassThrough({ objectMode: true });
    const opened = { stream, cleanupCount: 0, cleanup() { this.cleanupCount++; stream.destroy(); } };
    sources.push(opened);
    for (let i = 0; i < 40; i++) stream.write(Buffer.from([0xf8, item.title.charCodeAt(0), i]));
    return opened;
  } };
  const { manager } = await fixture(t, media, { preloadCount: 2 });
  const voice = fakeTransport();
  let preparations = 0;
  voice.prepare = async (raw, options) => {
    preparations++;
    return prepareAudio(raw, options, { demuxProbe: async stream => ({ stream, type: StreamType.Opus }) });
  };
  voice.play = function(opened, end, error, started) { this.plays.push({ opened, end, error, started }); started(); };
  const preload = [], transitions = [];
  manager.on('preloadMetric', value => preload.push(value));
  manager.on('transitionMetric', value => transitions.push(value));
  await manager.enqueue('guild', ['A', 'B', 'C'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  assert.equal(preparations, 3);
  assert.equal(preload.filter(value => value.outcome === 'ready').length, 2);
  const next = manager.state('guild').preloads.get(manager.state('guild').tracks[0].id).opened;
  const resource = next.resource;
  assert.equal(next.stream.readableObjectMode, true);
  assert.equal(resource.playStream, next.stream);
  assert.equal(resource.started, true);
  assert.equal(transitions.length, 0);
  voice.plays[0].end();
  await settle();
  assert.equal(voice.plays[1].opened, next);
  assert.equal(voice.plays[1].opened.resource, resource);
  assert.equal(preparations, 3, 'A warmed resource must not be re-created at handoff');
  assert.deepEqual(next.stream.read(), Buffer.from([0xf8, 'B'.charCodeAt(0), 0]));
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].preloaded, true);
  assert.ok(transitions[0].durationMs >= 0);
  voice.plays[1].started();
  assert.equal(transitions.length, 1, 'Repeated Playing events cannot duplicate the transition');
  await manager.control('guild', 'stop');
  assert.ok(sources.every(value => value.cleanupCount === 1));
  assert.ok(sources.every(value => value.stream.destroyed));
});

test('a cancelled packet preparation is cleaned before a late result can reach playback', async t => {
  const media = warmMedia();
  const pending = deferred();
  const { manager } = await fixture(t, media, { preloadCount: 2 });
  const voice = fakeTransport();
  const preparing = [];
  voice.prepare = async (raw, { signal }) => {
    preparing.push({ raw, signal });
    if (preparing.length === 2) return pending.promise;
    return raw;
  };
  const added = await manager.enqueue('guild', ['A', 'B'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  assert.equal(preparing.length, 2);
  const events = [];
  manager.on('preloadMetric', value => events.push(value));
  await manager.control('guild', 'remove', added[1].id);
  assert.equal(preparing[1].signal.aborted, true);
  pending.resolve(preparing[1].raw);
  await settle();
  assert.equal(media.calls[1].opened.cleanupCount, 1);
  assert.equal(voice.plays.length, 1);
  assert.equal(events.filter(value => value.outcome === 'cancelled').length, 1);
});

test('natural transition timing survives unavailable queued tracks and explicit skip clears it', async t => {
  for (const skip of [false, true]) {
    const last = deferred();
    const { manager } = await fixture(t, { async open(item) {
      if (item.title === 'B') throw new MediaError('Unavailable recording.', 'UNSUPPORTED_MEDIA');
      if (item.title === 'C') return last.promise;
      return openedAudio();
    } });
    const voice = fakeTransport();
    voice.play = function(opened, end, error, started) { this.plays.push({ opened, end, error }); started(); };
    const transitions = [];
    manager.on('transitionMetric', value => transitions.push(value));
    await manager.enqueue('guild', ['A', 'B', 'C', 'D'].map(track), requester);
    manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
    await settle();
    voice.plays[0].end();
    await settle();
    assert.equal(manager.snapshot('guild').nowPlaying.title, 'C');
    assert.equal(typeof manager.state('guild').transitionStartedAt, 'number');
    if (skip) await manager.control('guild', 'skip');
    last.resolve(openedAudio());
    await settle();
    assert.equal(transitions.length, skip ? 0 : 1);
    assert.equal(manager.state('guild').transitionStartedAt, null);
  }
});

test('resume after parked sources expire allows one new preload attempt', async t => {
  const media = warmMedia();
  const { manager } = await fixture(t, media, { preloadCount: 2, preloadTtlMs: 25 });
  const voice = fakeTransport();
  await manager.enqueue('guild', ['A', 'B'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  await manager.control('guild', 'pause');
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(media.calls.filter(call => call.title === 'B').length, 1);
  assert.equal(manager.preloadEntries.size, 0);
  await manager.control('guild', 'resume');
  await settle();
  assert.equal(media.calls.filter(call => call.title === 'B').length, 2);
  manager.syncPreloads();
  await settle();
  assert.equal(media.calls.filter(call => call.title === 'B').length, 2);
});

test('an exhausted failed queue does not count later idle time as a transition', async t => {
  const { manager } = await fixture(t, { async open(item) {
    if (item.title === 'B') throw new MediaError('Unavailable recording.', 'UNSUPPORTED_MEDIA');
    return openedAudio();
  } });
  const voice = fakeTransport();
  voice.play = function(opened, end, error, started) { this.plays.push({ opened, end, error }); started(); };
  const transitions = [];
  manager.on('transitionMetric', value => transitions.push(value));
  await manager.enqueue('guild', ['A', 'B'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  voice.plays[0].end();
  await settle();
  assert.equal(manager.state('guild').transitionStartedAt, null);
  await manager.enqueue('guild', [track('C')], requester);
  await settle();
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'C');
  assert.equal(transitions.length, 0);
});

test('a failed cold next track preserves the following prepared resource when capacity permits', async t => {
  const calls = [];
  const media = { async open(item) {
    calls.push(item.title);
    if (item.title === 'B') throw new MediaError('No suitable studio recording.', 'UNSUPPORTED_MEDIA');
    const stream = new PassThrough({ objectMode: true });
    for (let i = 0; i < 35; i++) stream.write(Buffer.from([0xf8, i]));
    return { stream, cleanup() { stream.destroy(); } };
  } };
  const { manager } = await fixture(t, media, { preloadCount: 2 });
  const voice = fakeTransport();
  voice.prepare = (raw, options) => prepareAudio(raw, options, { demuxProbe: async stream => ({ stream, type: StreamType.Opus }) });
  const metrics = [];
  manager.on('playbackMetric', metric => metrics.push(metric));
  const added = await manager.enqueue('guild', ['A', 'B', 'C'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  const prepared = manager.state('guild').preloads.get(added[2].id).opened;
  assert.equal(prepared.resource.started, true);
  voice.plays[0].end();
  await settle();
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'C');
  assert.equal(voice.plays[1].opened.resource, prepared.resource);
  assert.equal(voice.plays[1].opened, prepared);
  assert.equal(calls.filter(title => title === 'B').length, 2);
  assert.equal(calls.filter(title => title === 'C').length, 1);
  assert.deepEqual(metrics.map(metric => [metric.outcome, metric.preloaded]), [['ready', false], ['error', false], ['ready', true]]);
});

test('playlist admission returns before serial background checks and removed rows cannot return through late results', async t => {
  const checks = [];
  const { manager } = await fixture(t, { async preflight(item, options) {
    const pending = deferred(); checks.push({ item, options, pending }); return pending.promise;
  } }, { validationDelayMs: 10 });
  const added = await manager.enqueue('guild', Array.from({ length: 50 }, (_, index) => track(`Track ${index}`)), requester);
  assert.equal(added.length, 50);
  assert.equal(checks.length, 0);
  assert.ok(added.every(item => item.validation.status === 'pending'));
  await until(() => checks.length === 1);
  assert.equal(checks[0].options.background, true);
  assert.equal(manager.snapshot('guild').tracks[0].validation.status, 'checking');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(checks.length, 1);
  checks[0].pending.resolve({ ...checks[0].item, id: 'must-not-replace-request-id', requestedBy: { id: 'other' }, validation: { status: 'ready' }, playbackMapping: { videoId: 'abcdefghijk' } });
  await until(() => checks.length === 2);
  assert.equal(manager.snapshot('guild').tracks[0].id, added[0].id);
  assert.equal(manager.snapshot('guild').tracks[0].requestedBy.id, requester.id);
  assert.equal(manager.snapshot('guild').tracks[0].validation.status, 'ready');
  await manager.control('guild', 'stop');
  assert.equal(checks[1].options.signal.aborted, true);
  checks[1].pending.resolve(checks[1].item);
  await settle();
  assert.equal(manager.snapshot('guild').tracks.length, 0);
  assert.equal(manager.validationEntry, null);
});

test('permanent checks remove waiting songs immediately without interrupting current playback', async t => {
  const opened = [];
  const media = { async preflight(item) {
    if (item.title.startsWith('Bad')) throw new MediaError('No suitable recording.', 'NO_PLAYBACK_MATCH');
    return item;
  }, async open(item) { opened.push(item.title); return openedAudio(); } };
  const { manager, dataDir } = await fixture(t, media, { validationDelayMs: 5 });
  const voice = fakeTransport();
  await manager.enqueue('guild', ['Current', 'Good A', 'Bad A', 'Good B', 'Bad B'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await until(() => manager.snapshot('guild').tracks.length === 2);
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['Good A', 'Good B']);
  assert.deepEqual(opened, ['Current']);
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Current');
  assert.equal(voice.stopped, 0);
  assert.equal(manager.capacity('guild'), 1997);
  await manager.writes;
  const saved = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8')).guilds.guild;
  assert.deepEqual(saved.tracks.map(item => item.title), ['Good A', 'Good B']);
  assert.equal(saved.nowPlaying.title, 'Current');
});

test('an entirely unavailable queue becomes empty and idle without retrying its tracks', async t => {
  const { manager } = await fixture(t, { async preflight() { throw new MediaError('No suitable recording.', 'NO_PLAYBACK_MATCH'); },
    open() { assert.fail('Known unavailable tracks must not open'); } }, { validationDelayMs: 5 });
  await manager.enqueue('guild', ['Bad A', 'Bad B'].map(track), requester);
  await until(() => manager.snapshot('guild').tracks.length === 0);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  await settle();
  assert.equal(manager.snapshot('guild').nowPlaying, null);
  assert.deepEqual(manager.snapshot('guild').tracks, []);
});

test('a transient background outage backs off globally instead of checking the whole playlist', async t => {
  let checks = 0;
  const { manager } = await fixture(t, { async preflight() { checks++; throw new MediaError('Provider timed out.', 'MEDIA_TIMEOUT'); } },
    { validationDelayMs: 5, validationCooldownMs: 100, validationRetryMs: [150, 300, 500] });
  const added = await manager.enqueue('guild', Array.from({ length: 50 }, (_, index) => track(`Track ${index}`)), requester);
  await until(() => manager.snapshot('guild').tracks[0].validation.status === 'retry');
  const status = manager.snapshot('guild').tracks[0].validation;
  assert.equal(status.code, 'MEDIA_TIMEOUT');
  assert.ok(status.retryAt > status.checkedAt);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(checks, 1);
  assert.equal(manager.snapshot('guild').tracks.length, 50);
  await manager.control('guild', 'remove', added[0].id);
  assert.equal(manager.validationAttempts.size, 0);
  await manager.control('guild', 'stop');
});

test('restore removes saved unavailable songs of any age and backfills other validation', async t => {
  const { manager, dataDir } = await fixture(t);
  await manager.enqueue('guild', ['Checking', 'Ready', 'Unavailable', 'Legacy', 'Old unavailable'].map(track), requester);
  const rows = manager.state('guild').tracks;
  rows[0].validation = { status: 'checking' };
  rows[1].validation = { status: 'ready', checkedAt: Date.now() };
  rows[2].validation = { status: 'unavailable', checkedAt: Date.now(), code: 'NO_PLAYBACK_MATCH' };
  rows[4].validation = { status: 'unavailable', checkedAt: Date.now() - 172_800_000, code: 'NO_PLAYBACK_MATCH' };
  await manager.persist();
  const checks = [];
  const restored = new MusicManager({ media: { async preflight(item) { checks.push(item.title); return item; } }, dataDir,
    logger: quiet, validationDelayMs: 5 });
  await restored.restore();
  assert.deepEqual(restored.snapshot('guild').tracks.map(item => item.validation.status), ['pending', 'ready', 'pending']);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8')).guilds.guild;
  assert.deepEqual(saved.tracks.map(item => item.title), ['Checking', 'Ready', 'Legacy']);
  await until(() => checks.length === 2);
  assert.deepEqual(checks, ['Checking', 'Legacy']);
  await restored.shutdown();
});

test('permanent preload failures extend lookahead to the next two playable requests', async t => {
  const media = warmMedia();
  const normal = media.open.bind(media);
  media.preflight = async item => item;
  media.open = async (item, options) => {
    if (item.title === 'Bad') throw new MediaError('No suitable recording.', 'NO_PLAYBACK_MATCH');
    return normal(item, options);
  };
  const { manager } = await fixture(t, media, { preloadCount: 2, validationDelayMs: 1000 });
  const voice = fakeTransport();
  await manager.enqueue('guild', ['Current', 'Bad', 'Next', 'Following'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  assert.deepEqual(manager.snapshot('guild').tracks.map(item => item.title), ['Next', 'Following']);
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Current');
  assert.equal(voice.stopped, 0);
  assert.deepEqual([...manager.preloadEntries].map(entry => manager.state('guild').tracks.find(item => item.id === entry.id).title), ['Next', 'Following']);
  assert.equal(manager.preloadEntries.size, 2);
  voice.plays[0].end();
  await settle();
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Next');
  assert.equal(media.calls.filter(call => call.title === 'Next').length, 1);
});

test('transient preload failures cool down lookahead and keep the original foreground request', async t => {
  const media = warmMedia();
  const normal = media.open.bind(media);
  let badAttempts = 0;
  media.open = async (item, options) => {
    if (item.title === 'Transient' && ++badAttempts === 1) throw new MediaError('Provider timed out.', 'MEDIA_TIMEOUT');
    return normal(item, options);
  };
  const { manager } = await fixture(t, media, { preloadCount: 2, validationCooldownMs: 100 });
  const voice = fakeTransport();
  await manager.enqueue('guild', ['Current', 'Transient', 'Next', 'Following'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(media.calls.some(call => call.title === 'Following'), false);
  assert.equal(manager.snapshot('guild').tracks[0].validation?.status, undefined);
  await until(() => media.calls.some(call => call.title === 'Following'));
  assert.equal(badAttempts, 1);
  voice.plays[0].end();
  await settle();
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Transient');
  assert.equal(badAttempts, 2);
});

test('a permanent preload failure between scheduling and beginning cannot open the bad head again', async t => {
  const media = warmMedia(); media.preflight = async item => item;
  const { manager } = await fixture(t, media, { preloadCount: 2, validationDelayMs: 1000 });
  const voice = fakeTransport();
  const added = await manager.enqueue('guild', ['Current', 'Bad', 'Good'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  const parked = manager.state('guild').preloads.get(added[1].id).opened;
  voice.plays[0].end();
  parked.stream.emit('error', new MediaError('Video unavailable.', 'YOUTUBE_VIDEO_UNAVAILABLE'));
  await settle();
  assert.equal(media.calls.filter(call => call.title === 'Bad').length, 1);
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Good');
});

test('removing the final failed preload after current ends releases its source and arms idle disconnect', async t => {
  const media = warmMedia(); media.preflight = async item => item;
  const { manager } = await fixture(t, media, { preloadCount: 2, validationDelayMs: 1000, idleDisconnectMs: 20 });
  const voice = fakeTransport();
  const added = await manager.enqueue('guild', ['Current', 'Bad'].map(track), requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Lounge' });
  await settle();
  const parked = manager.state('guild').preloads.get(added[1].id).opened;
  voice.plays[0].end();
  parked.stream.emit('error', new MediaError('Video unavailable.', 'YOUTUBE_VIDEO_UNAVAILABLE'));
  await until(() => voice.destroyed === 1);
  assert.equal(manager.snapshot('guild').nowPlaying, null);
  assert.deepEqual(manager.snapshot('guild').tracks, []);
  assert.equal(manager.preloadEntries.size, 0);
  assert.equal(manager.state('guild').preloads.size, 0);
  assert.equal(parked.stream.destroyed, true);
  assert.equal(media.calls.filter(call => call.title === 'Bad').length, 1);
});

test('public snapshots omit internal search/mapping fields while queue persistence retains them', async t => {
  const { manager, dataDir } = await fixture(t);
  const added = await manager.enqueue('guild', [{ ...track('Mapped'), searchQuery: 'private resolver query', playbackMapping: { videoId: 'abcdefghijk', referenceHash: 'internal' } }], requester);
  const snapshot = manager.snapshot('guild');
  assert.equal(Object.hasOwn(snapshot.tracks[0], 'searchQuery'), false);
  assert.equal(Object.hasOwn(snapshot.tracks[0], 'playbackMapping'), false);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8')).guilds.guild.tracks[0];
  assert.equal(saved.searchQuery, 'private resolver query');
  assert.equal(saved.playbackMapping.videoId, 'abcdefghijk');
  assert.equal(saved.id, added[0].id);
});

test('a settling cancelled background checker gets the bounded foreground capacity wait', async t => {
  const check = deferred();
  let checkerSignal, attempts = 0;
  const { manager } = await fixture(t, { preflight(_item, { signal }) { checkerSignal = signal; return check.promise; },
    async open() {
      if (++attempts === 1) { const error = new MediaError('Provider busy.', 'MEDIA_BUSY'); error.retryableBeforeStart = true; throw error; }
      return openedAudio();
    } }, { validationDelayMs: 5 });
  await manager.enqueue('guild', [track('Current')], requester);
  await until(() => checkerSignal);
  manager.attach('guild', fakeTransport(), { id: 'voice', name: 'Lounge' });
  await until(() => attempts === 2);
  assert.equal(checkerSignal.aborted, true);
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Current');
  check.resolve(track('Old metadata'));
  await settle();
  assert.equal(manager.snapshot('guild').nowPlaying.title, 'Current');
});

test('interactive preflight holds background checks until its idempotent release', async t => {
  let checks = 0;
  const { manager } = await fixture(t, { async preflight(item) { checks++; return item; } }, { validationDelayMs: 5 });
  const release = manager.pausePreflight();
  await manager.enqueue('guild', [track('Queued')], requester);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(checks, 0);
  release(); release();
  await until(() => checks === 1);
  assert.equal(manager.validationPauses, 0);
});
