import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { MusicManager } from '../src/music.mjs';

const requester = { id: 'radio-user', username: 'Listener' };
const channel = { id: 'voice', name: 'Listening' };
const track = index => ({ source: 'youtube', sourceUrl: `https://www.youtube.com/watch?v=v${String(index).padStart(10, '0')}`,
  title: `Song ${index}`, artist: `Artist ${index % 3}`, durationSec: 180 });
const batch = (start = 1, length = 10) => Array.from({ length }, (_, index) => track(start + index));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('Radio operation did not complete within the test deadline.');
    await sleep(5);
  }
}

function voice() {
  return { plays: [], play(_opened, end) { this.plays.push({ end }); }, stop() {}, destroy() {}, pause() {}, resume() {}, elapsedSec: () => 1 };
}

async function fixture(t, radio, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bap-radio-test-'));
  const calls = [];
  const media = {
    async open() { const stream = new PassThrough(); return { stream, cleanup: () => stream.destroy() }; },
    radio(seed, args) { calls.push({ seed, ...args }); return radio(seed, args, calls.length); },
  };
  const manager = new MusicManager({ media, dataDir, idleDisconnectMs: 0, preloadCount: 0,
    logger: { warn() {}, error() {} }, ...options });
  t.after(async () => {
    await manager.shutdown();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('bap-radio-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { manager, media, calls, dataDir };
}

test('radio waits for a voice connection, adds batches of ten, and refills at two pending picks', async t => {
  const { manager, calls } = await fixture(t, (_seed, _args, number) => batch((number - 1) * 10 + 1));
  const result = await manager.startRadio('guild', track(9000), requester);
  assert.equal(result.radio.active, true);
  assert.equal(result.radio.batchSize, 10);
  assert.equal(result.tracks.length, 0, 'Starting radio does not enqueue the seed.');
  await sleep(20);
  assert.equal(calls.length, 0);
  const transport = voice();
  manager.attach('guild', transport, channel);
  await until(() => transport.plays.length === 1 && !manager.radioEntry);
  assert.equal(calls.length, 1);
  assert.equal(manager.snapshot('guild').tracks.length, 9);
  assert.equal(manager.snapshot('guild').nowPlaying.radio, true);
  assert.ok(manager.snapshot('guild').tracks.every(item => item.radio && item.requestedBy.id === requester.id));
  for (let index = 1; index <= 6; index++) {
    transport.plays.at(-1).end();
    await until(() => transport.plays.length === index + 1);
  }
  assert.equal(manager.snapshot('guild').tracks.length, 3);
  assert.equal(calls.length, 1);
  transport.plays.at(-1).end();
  await until(() => calls.length === 2 && manager.snapshot('guild').tracks.length === 12 && !manager.radioEntry);
  assert.equal(calls[1].limit, 10);
  assert.equal(calls[1].continuation.sourceUrl, track(10).sourceUrl);
  assert.ok(calls[1].exclude.some(item => item.sourceUrl === track(1).sourceUrl));
  await sleep(20);
  assert.equal(calls.length, 2, 'The station does not keep growing after a batch is committed.');
});

test('current-song radio preserves the private playback match while every public snapshot omits it', async t => {
  const { manager, calls, dataDir } = await fixture(t, () => batch());
  const mapping = { videoId: 'matched0001', title: 'Song 9000', artist: 'Artist 0', durationSec: 180, checkedAt: 12345, referenceHash: 'validated-original-song' };
  const current = { ...track(9000), source: 'spotify', sourceUrl: 'https://open.spotify.com/track/1234567890abcdefghijkl', playbackMapping: mapping };
  await manager.enqueue('guild', [current], requester);
  manager.attach('guild', voice(), channel);
  await until(() => manager.snapshot('guild').nowPlaying && !manager.state('guild').opening);
  const publicSeed = manager.snapshot('guild').nowPlaying;
  assert.equal(publicSeed.playbackMapping, undefined);
  await manager.startRadio('guild', publicSeed, requester);
  await until(() => calls.length === 1 && !manager.radioEntry);
  assert.deepEqual(calls[0].seed.playbackMapping, mapping);
  assert.doesNotMatch(JSON.stringify(manager.snapshot('guild')), /playbackMapping|referenceHash/);
  await manager.persist();
  const saved = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8')).guilds.guild;
  assert.deepEqual(saved.radio.seed.playbackMapping, mapping);
  assert.equal(publicSeed.playbackMapping, undefined, 'Starting the station must not enrich the public object in place.');
  const explicit = { ...current, playbackMapping: { ...mapping, videoId: 'explicit001', checkedAt: 12346 } };
  await manager.startRadio('guild', explicit, requester);
  assert.deepEqual(manager.state('guild').radio.seed.playbackMapping, explicit.playbackMapping, 'An explicit preflighted seed keeps its own selected mapping.');
});

test('a partial discovery retains a newly resolved legacy seed across retries and restart', async t => {
  const original = { ...track(9000), source: 'spotify', sourceUrl: 'https://open.spotify.com/track/1234567890abcdefghijkl' };
  const resolved = { ...original, playbackMapping: { videoId: 'matched0001', checkedAt: 12345, referenceHash: 'validated-original-song' } };
  const { manager, media, calls, dataDir } = await fixture(t, (_seed, _options, count) => {
    const tracks = batch(count * 100, count === 1 ? 3 : 10);
    Object.defineProperty(tracks, 'radioSeed', { value: resolved });
    return tracks;
  }, { radioRetryMs: [100, 150] });
  manager.attach('guild', voice(), channel);
  await manager.startRadio('guild', original, requester);
  await until(() => manager.snapshot('guild').radio.error);
  assert.deepEqual(manager.state('guild').radio.seed.playbackMapping, resolved.playbackMapping);
  assert.equal(manager.snapshot('guild').tracks.length, 0, 'Incomplete batches remain atomic.');
  await manager.persist();
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8')).guilds.guild.radio.seed.playbackMapping, resolved.playbackMapping);
  await until(() => calls.length === 2 && !manager.radioEntry);
  assert.deepEqual(calls[1].seed.playbackMapping, resolved.playbackMapping);
  await manager.shutdown();
  const restored = new MusicManager({ media, dataDir, logger: { warn() {}, error() {} }, idleDisconnectMs: 0, preloadCount: 0 });
  await restored.restore();
  assert.deepEqual(restored.state('guild').radio.seed.playbackMapping, resolved.playbackMapping);
  assert.doesNotMatch(JSON.stringify(restored.snapshot('guild')), /playbackMapping|referenceHash/);
  await restored.shutdown();
});

test('an unrelated discovery annotation cannot change the selected radio seed', async t => {
  const original = track(9000);
  const { manager } = await fixture(t, () => {
    const tracks = batch();
    Object.defineProperty(tracks, 'radioSeed', { value: { ...track(9001), playbackMapping: { videoId: 'unrelated01' } } });
    return tracks;
  });
  manager.attach('guild', voice(), channel);
  await manager.startRadio('guild', original, requester);
  await until(() => !manager.radioEntry && manager.snapshot('guild').nowPlaying);
  assert.deepEqual(manager.state('guild').radio.seed, original);
});

test('manual requests lead radio, shuffle preserves that priority, and promoted picks survive radio stop', async t => {
  const { manager } = await fixture(t, () => batch(), { randomIndex: () => 0 });
  const transport = voice();
  manager.attach('guild', transport, channel);
  await manager.startRadio('guild', track(9000), requester);
  await until(() => transport.plays.length === 1 && !manager.radioEntry);
  const currentId = manager.snapshot('guild').nowPlaying.id;
  const manuals = await manager.enqueue('guild', [track(8000), track(8001)], requester);
  assert.deepEqual(manager.snapshot('guild').tracks.slice(0, 2).map(item => item.id), manuals.map(item => item.id));
  await manager.control('guild', 'shuffle');
  const shuffled = manager.snapshot('guild').tracks;
  assert.ok(shuffled.slice(0, 2).every(item => !item.radio));
  assert.ok(shuffled.slice(2).every(item => item.radio));
  const promoted = shuffled.at(-1);
  await manager.control('guild', 'move-top', promoted.id);
  assert.equal(manager.snapshot('guild').tracks[0].id, promoted.id);
  assert.equal(manager.snapshot('guild').tracks[0].radio, undefined);
  const stopped = await manager.stopRadio('guild');
  assert.equal(stopped.radio.active, false);
  assert.equal(stopped.nowPlaying.id, currentId, 'Stopping radio lets the current song finish.');
  assert.deepEqual(new Set(stopped.tracks.map(item => item.id)), new Set([...manuals.map(item => item.id), promoted.id]));
  await manager.control('guild', 'shuffle');
  assert.equal(manager.snapshot('guild').tracks.length, 3, 'A manual-only shuffle retains all songs.');
});

test('an incomplete batch adds nothing and retries with backoff', async t => {
  const { manager, calls } = await fixture(t, (_seed, _args, number) => batch(number * 100, number === 1 ? 9 : 10), { radioRetryMs: [100, 150] });
  manager.attach('guild', voice(), channel);
  await manager.startRadio('guild', track(9000), requester);
  await until(() => manager.snapshot('guild').radio.error);
  const failed = manager.snapshot('guild');
  assert.equal(failed.tracks.length, 0);
  assert.equal(failed.nowPlaying, null);
  assert.equal(failed.radio.loading, false);
  assert.equal(failed.radio.active, true);
  await sleep(30);
  assert.equal(calls.length, 1);
  await until(() => calls.length === 2 && !manager.radioEntry && manager.snapshot('guild').nowPlaying);
  assert.equal(manager.snapshot('guild').tracks.length, 9);
  assert.equal(manager.snapshot('guild').radio.error, null);
});

test('an active station survives an empty queue while discovery backs off', async t => {
  const { manager, calls } = await fixture(t, () => [], { idleDisconnectMs: 15, radioRetryMs: [200] });
  manager.attach('guild', voice(), channel);
  await manager.startRadio('guild', track(9000), requester);
  await until(() => manager.snapshot('guild').radio.error);
  await sleep(40);
  assert.equal(calls.length, 1);
  assert.equal(manager.snapshot('guild').channelId, channel.id);
  await manager.stopRadio('guild');
  await until(() => manager.snapshot('guild').channelId === null);
});

test('changing station cancels old work without overlapping or committing its stale response', async t => {
  const pending = [];
  const { manager, calls } = await fixture(t, () => { const value = defer(); pending.push(value); return value.promise; });
  manager.attach('guild', voice(), channel);
  await manager.startRadio('guild', track(9000), requester);
  await until(() => pending.length === 1);
  await manager.startRadio('guild', track(9001), requester);
  assert.equal(calls[0].signal.aborted, true);
  await sleep(20);
  assert.equal(pending.length, 1, 'Aborted work keeps its slot until it settles.');
  const staleTracks = batch(1);
  Object.defineProperty(staleTracks, 'radioSeed', { value: { ...track(9000), playbackMapping: { videoId: 'stale000001', checkedAt: 12345 } } });
  pending[0].resolve(staleTracks);
  await until(() => pending.length === 2);
  assert.equal(calls[1].seed.sourceUrl, track(9001).sourceUrl);
  assert.deepEqual(manager.state('guild').radio.seed, track(9001), 'A canceled station cannot replace the current private seed.');
  assert.equal(manager.snapshot('guild').tracks.length, 0);
  pending[1].resolve(batch(101));
  await until(() => !manager.radioEntry && manager.snapshot('guild').nowPlaying);
  const state = manager.snapshot('guild');
  assert.deepEqual([state.nowPlaying, ...state.tracks].map(item => item.title), batch(101).map(item => item.title));
});

test('capacity and concurrent manual requests are rechecked before a whole batch is committed', async t => {
  const pending = [];
  const { manager, calls } = await fixture(t, () => { const value = defer(); pending.push(value); return value.promise; }, { maxQueueSize: 12 });
  await manager.enqueue('guild', [track(8000), track(8001)], requester);
  manager.attach('guild', voice(), channel);
  await manager.startRadio('guild', track(9000), requester);
  await until(() => pending.length === 1);
  await manager.enqueue('guild', [track(8002)], requester);
  pending[0].resolve(batch());
  await until(() => !manager.radioEntry);
  assert.equal(manager.snapshot('guild').tracks.length, 2);
  assert.equal(manager.capacity('guild'), 9);
  await sleep(20);
  assert.equal(calls.length, 1);
  await manager.control('guild', 'skip');
  await until(() => pending.length === 2);
  pending[1].resolve(batch());
  await until(() => !manager.radioEntry && manager.capacity('guild') === 0);
  assert.equal(manager.snapshot('guild').tracks.length, 11);
  assert.equal(manager.snapshot('guild').tracks[0].title, track(8002).title);
});

test('radio excludes current, requested, seed, recent, URL aliases and duplicate song identities', async t => {
  const response = defer();
  const { manager, calls } = await fixture(t, () => response.promise);
  const transport = voice();
  await manager.enqueue('guild', [track(8000), track(8001)], requester);
  manager.attach('guild', transport, channel);
  await until(() => transport.plays.length === 1);
  transport.plays[0].end();
  await until(() => transport.plays.length === 2);
  await manager.startRadio('guild', track(9000), requester);
  await until(() => calls.length === 1);
  await manager.enqueue('guild', [track(8002)], requester);
  const duplicateTitle = { ...track(200), title: track(1).title, artist: track(1).artist };
  response.resolve([track(8000), track(8001), track(8002), track(9000), track(1), duplicateTitle,
    { ...track(1), sourceUrl: 'https://youtu.be/v0000000001' }, { ...track(500), durationSec: 3601 }, ...batch(2, 9)]);
  await until(() => !manager.radioEntry);
  const tracks = manager.snapshot('guild').tracks;
  assert.equal(tracks[0].title, track(8002).title);
  assert.deepEqual(tracks.filter(item => item.radio).map(item => item.sourceUrl), batch().map(item => item.sourceUrl));
  for (const index of [8000, 8001, 9000]) assert.ok(calls[0].exclude.some(item => item.sourceUrl === track(index).sourceUrl));
});

test('radio persists its station, initiator, history, queue order and volume, resuming only after join', async t => {
  const { manager, media, dataDir, calls } = await fixture(t, () => batch());
  manager.attach('guild', voice(), channel);
  await manager.setVolume('guild', 47);
  await manager.startRadio('guild', track(9000), requester);
  await until(() => !manager.radioEntry && manager.snapshot('guild').nowPlaying);
  const before = manager.snapshot('guild');
  await manager.shutdown();
  const saved = JSON.parse(await readFile(path.join(dataDir, 'queues.json'), 'utf8')).guilds.guild;
  assert.equal(saved.radio.active, true);
  assert.deepEqual(saved.radio.requestedBy, requester);
  assert.equal(saved.radio.history.length, 11);
  assert.equal(saved.volumePercent, 47);
  const restored = new MusicManager({ media, dataDir, idleDisconnectMs: 0, preloadCount: 0, logger: { warn() {}, error() {} } });
  await restored.restore();
  const after = restored.snapshot('guild');
  assert.equal(after.radio.active, true);
  assert.equal(after.radio.loading, false);
  assert.equal(after.channelId, null);
  assert.equal(after.nowPlaying, null);
  assert.equal(after.volumePercent, 47);
  assert.deepEqual(after.tracks.map(item => item.id), [before.nowPlaying, ...before.tracks].map(item => item.id));
  await sleep(20);
  assert.equal(calls.length, 1);
  restored.attach('guild', voice(), channel);
  await until(() => restored.snapshot('guild').nowPlaying);
  assert.equal(calls.length, 1, 'The retained radio batch plays before any refill is needed.');
  await restored.shutdown();
});

test('pause and disconnect abort discovery, preserve the station, and resume on user control', async t => {
  const pending = [];
  const { manager, calls } = await fixture(t, () => { const value = defer(); pending.push(value); return value.promise; });
  await manager.enqueue('guild', [track(8000)], requester);
  manager.attach('guild', voice(), channel);
  await manager.startRadio('guild', track(9000), requester);
  await until(() => calls.length === 1);
  await manager.control('guild', 'pause');
  assert.equal(calls[0].signal.aborted, true);
  pending[0].resolve(batch());
  await until(() => !manager.radioEntry);
  assert.equal(manager.snapshot('guild').radio.active, true);
  assert.equal(manager.snapshot('guild').tracks.length, 0);
  await manager.control('guild', 'resume');
  await until(() => calls.length === 2);
  manager.detach('guild');
  assert.equal(calls[1].signal.aborted, true);
  pending[1].resolve(batch());
  await until(() => !manager.radioEntry);
  assert.equal(manager.snapshot('guild').radio.active, true);
  assert.equal(manager.snapshot('guild').tracks.length, 1);
  await sleep(20);
  assert.equal(calls.length, 2);
  manager.attach('guild', voice(), channel);
  await until(() => calls.length === 3);
  pending[2].resolve(batch());
  await until(() => !manager.radioEntry && manager.snapshot('guild').tracks.length === 10);
});

test('stop disables radio and shutdown cannot commit a late batch or restart discovery', async t => {
  const pending = [];
  const { manager, calls } = await fixture(t, () => { const value = defer(); pending.push(value); return value.promise; });
  manager.attach('guild', voice(), channel);
  await manager.startRadio('guild', track(9000), requester);
  await until(() => calls.length === 1);
  await manager.control('guild', 'stop');
  assert.equal(calls[0].signal.aborted, true);
  pending[0].resolve(batch());
  await until(() => !manager.radioEntry);
  assert.equal(manager.snapshot('guild').radio.active, false);
  assert.equal(manager.snapshot('guild').tracks.length, 0);
  await manager.startRadio('guild', track(9000), requester);
  await until(() => calls.length === 2);
  await manager.shutdown();
  assert.equal(calls[1].signal.aborted, true);
  const lateTracks = batch();
  Object.defineProperty(lateTracks, 'radioSeed', { value: { ...track(9000), playbackMapping: { videoId: 'late0000001', checkedAt: 12345 } } });
  pending[1].resolve(lateTracks);
  await until(() => !manager.radioEntry);
  assert.deepEqual(manager.state('guild').radio.seed, track(9000), 'Shutdown cannot commit a newly resolved seed mapping.');
  assert.equal(manager.snapshot('guild').radio.active, true, 'Shutdown preserves the station setting.');
  assert.equal(manager.snapshot('guild').tracks.length, 0);
  assert.equal(manager.radioTimer, null);
  await assert.rejects(manager.startRadio('guild', track(9000), requester), { status: 503 });
});

test('one discovery slot is shared fairly across guilds and recent history stays bounded', async t => {
  const pending = [];
  const { manager, calls } = await fixture(t, () => { const value = defer(); pending.push(value); return value.promise; }, { radioRetryMs: [1] });
  manager.attach('first', voice(), channel);
  manager.attach('second', voice(), channel);
  await manager.startRadio('first', track(9000), requester);
  await until(() => calls.length === 1);
  await manager.startRadio('second', track(9001), requester);
  await sleep(10);
  assert.equal(calls.length, 1);
  pending[0].resolve([]);
  await until(() => calls.length === 2);
  assert.equal(calls[1].seed.sourceUrl, track(9001).sourceUrl, 'A failing station yields to the next guild.');
  await manager.stopRadio('first');
  pending[1].resolve(batch());
  await until(() => !manager.radioEntry);
  const state = manager.state('second');
  for (let index = 0; index < 325; index++) manager.rememberRadio(state, track(10000 + index));
  assert.equal(state.radio.history.length, 300);
  assert.equal(state.radio.history[0].sourceUrl, track(10025).sourceUrl);
  assert.equal(state.radio.history.at(-1).sourceUrl, track(10324).sourceUrl);
});
