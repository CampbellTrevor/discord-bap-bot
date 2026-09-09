import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { MusicManager } from '../src/music.mjs';
import { authorizeControl, authorizeJoin, createBot, formatRequestReply } from '../src/discord.mjs';

const requester = { id: 'user-a', username: 'Listener' };
const quiet = { info() {}, warn() {}, error() {} };
const track = title => ({ title, artist: 'Artist', source: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', durationSec: 120 });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

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
  const manager = new MusicManager({ media, dataDir, logger: quiet, idleDisconnectMs: 0, ...options });
  t.after(async () => {
    await manager.shutdown();
    // Delete only the exact temporary directory allocated by this fixture.
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('discord-music-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { manager, dataDir };
}

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
