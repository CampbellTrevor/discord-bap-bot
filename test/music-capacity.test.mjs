import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { MusicManager } from '../src/music.mjs';

const requester = { id: 'capacity-user', username: 'Queue owner' };
const track = index => ({ title: `Track ${index}`, artist: 'Artist', source: 'youtube',
  sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk', durationSec: 3600 });
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'turntable-capacity-'));
  const instances = [];
  const create = (overrides = {}) => {
    const manager = new MusicManager({ dataDir, idleDisconnectMs: 0, preloadCount: 0,
      logger: { warn() {}, error() {} },
      media: { open: () => assert.fail('An offline queue must not open a media source.') },
      ...options, ...overrides });
    instances.push(manager);
    return manager;
  };
  t.after(async () => {
    for (const manager of instances) await manager.shutdown();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('turntable-capacity-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { manager: create(), create, file: path.join(dataDir, 'queues.json') };
}

test('the default queue accepts and restores 2000 tracks, rejecting overflow atomically', async t => {
  const { manager, create, file } = await fixture(t);
  assert.equal(manager.capacity('guild'), 2000);
  const tracks = Array.from({ length: 2000 }, (_, index) => track(index + 1));

  await assert.rejects(manager.enqueue('guild', [...tracks, track(2001)], requester), { status: 409 });
  assert.deepEqual(manager.snapshot('guild').tracks, []);
  assert.equal(manager.capacity('guild'), 2000);

  const added = await manager.enqueue('guild', tracks, requester);
  assert.equal(added.length, 2000);
  assert.equal(new Set(added.map(item => item.id)).size, 2000);
  assert.deepEqual(added.map(item => item.title), tracks.map(item => item.title));
  assert.ok(added.every(item => item.requestedBy.id === requester.id));
  assert.equal(manager.capacity('guild'), 0);
  const before = manager.snapshot('guild');
  const saved = await readFile(file, 'utf8');

  await assert.rejects(manager.enqueue('guild', [track(2001)], requester), error => {
    assert.equal(error.status, 409);
    assert.match(error.message, /limit 2000, including the current track/);
    assert.match(error.message, /Nothing was added/);
    return true;
  });
  assert.deepEqual(manager.snapshot('guild'), before);
  assert.equal(await readFile(file, 'utf8'), saved);

  const restored = create();
  await restored.restore();
  const snapshot = restored.snapshot('guild');
  assert.deepEqual(snapshot.tracks, added);
  assert.equal(snapshot.nowPlaying, null);
  assert.equal(snapshot.channelId, null);
  assert.equal(snapshot.playing, false);
  assert.equal(restored.capacity('guild'), 0);
  await assert.rejects(restored.enqueue('guild', [track(2001)], requester), { status: 409 });
  assert.deepEqual(restored.snapshot('guild'), snapshot);
});

test('the current track consumes a queue slot and a rejected batch leaves playback and persistence intact', async t => {
  let opens = 0;
  const media = { open: async () => {
    opens++;
    const stream = new PassThrough();
    return { stream, cleanup: () => stream.destroy() };
  } };
  const { manager, file } = await fixture(t, { maxQueueSize: 3, media });
  const voice = { play() {}, stop() {}, destroy() {}, elapsedSec: () => 15 };
  const first = await manager.enqueue('guild', [track(1), track(2)], requester);
  manager.attach('guild', voice, { id: 'voice', name: 'Test channel' });
  await turn();
  await manager.writes;
  assert.equal(manager.snapshot('guild').nowPlaying.id, first[0].id);
  assert.equal(manager.snapshot('guild').tracks.length, 1);
  assert.equal(manager.capacity('guild'), 1);
  const before = manager.snapshot('guild');
  const resource = manager.state('guild').opened;
  const saved = await readFile(file, 'utf8');

  await assert.rejects(manager.enqueue('guild', [track(3), track(4)], requester), { status: 409 });
  assert.deepEqual(manager.snapshot('guild'), before);
  assert.equal(manager.state('guild').opened, resource);
  assert.equal(resource.stream.destroyed, false);
  assert.equal(await readFile(file, 'utf8'), saved);

  await manager.enqueue('guild', [track(3)], requester);
  const full = manager.snapshot('guild');
  assert.equal(full.nowPlaying.id, first[0].id);
  assert.deepEqual(full.tracks.map(item => item.title), ['Track 2', 'Track 3']);
  assert.equal(manager.capacity('guild'), 0);
  await assert.rejects(manager.enqueue('guild', [track(4)], requester), { status: 409 });
  assert.deepEqual(manager.snapshot('guild'), full);
  assert.equal(opens, 1, 'Only the current fake source opens; no queued tracks are extracted.');
});
