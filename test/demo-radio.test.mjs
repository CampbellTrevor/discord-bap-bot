import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoBot } from '../src/demo.mjs';

const guild = 'demo-guild', user = 'demo-user';

test('demo radio adds ten songs, preserves the current song, and prioritizes requests', async () => {
  const bot = createDemoBot();
  const before = bot.snapshot(guild);
  const started = await bot.radio(guild, user, 'start');
  assert.equal(started.radio.active, true);
  assert.equal(started.radio.batchSize, 10);
  assert.equal(started.radio.seed.title, before.nowPlaying.title);
  assert.equal(started.nowPlaying.id, before.nowPlaying.id);
  assert.deepEqual(started.tracks.filter(track => !track.radio), before.tracks);
  assert.equal(started.tracks.filter(track => track.radio).length, 10);
  const requested = await bot.request(guild, user, 'Manual request');
  assert.equal(requested.queue.tracks[2].id, requested.added[0].id);
  assert.equal(requested.queue.tracks[3].radio, true);
  const shuffled = await bot.control(guild, user, 'shuffle');
  assert.equal(shuffled.tracks.slice(0, 3).every(track => !track.radio), true);
  assert.equal(shuffled.tracks.slice(3).every(track => track.radio), true);
});

test('demo radio replenishes in batches of ten without repeating track IDs', async () => {
  const bot = createDemoBot();
  let queue = await bot.radio(guild, user, 'start');
  const seen = new Set(queue.tracks.map(track => track.id));
  let refills = 0;
  for (let i = 0; i < 33; i++) {
    const beforeCount = queue.tracks.filter(track => track.radio).length;
    queue = await bot.control(guild, user, 'skip');
    const afterCount = queue.tracks.filter(track => track.radio).length;
    const consumed = queue.nowPlaying.radio ? 1 : 0;
    const delta = afterCount - beforeCount + consumed;
    assert.ok(delta === 0 || delta === 10);
    if (delta) {
      const fresh = queue.tracks.filter(track => !seen.has(track.id));
      assert.equal(fresh.length, 10);
      for (const track of fresh) seen.add(track.id);
      refills++;
    }
    assert.equal(queue.radio.active, true);
  }
  assert.ok(refills >= 3);
});

test('stopping demo radio keeps the current radio song and manual requests', async () => {
  const bot = createDemoBot();
  await bot.radio(guild, user, 'start');
  for (let i = 0; i < 3; i++) await bot.control(guild, user, 'skip');
  const requested = await bot.request(guild, user, 'Keep this request');
  assert.equal(requested.queue.nowPlaying.radio, true);
  const stopped = await bot.radio(guild, user, 'stop');
  assert.equal(stopped.radio.active, false);
  assert.equal(stopped.nowPlaying.id, requested.queue.nowPlaying.id);
  assert.deepEqual(stopped.tracks.map(track => track.id), [requested.added[0].id]);
  const next = await bot.control(guild, user, 'skip');
  assert.equal(next.nowPlaying.id, requested.added[0].id);
  assert.equal(next.tracks.length, 0);
});

test('demo radio validates its seed, clears on stop, and survives disconnect', async () => {
  const bot = createDemoBot();
  await assert.rejects(bot.radio(guild, user, 'invalid'), /start or stop/);
  await assert.rejects(bot.radio(guild, user, 'start', ' '), /Enter a song/);
  await bot.control(guild, user, 'stop');
  await assert.rejects(bot.radio(guild, user, 'start'), /Play a song/);
  const seeded = await bot.radio(guild, user, 'start', 'Selected seed');
  assert.equal(seeded.radio.seed.title, 'Selected seed');
  assert.equal(seeded.tracks.length + Number(Boolean(seeded.nowPlaying)), 10);
  const stopped = await bot.control(guild, user, 'stop');
  assert.equal(stopped.radio.active, false);
  assert.equal(stopped.nowPlaying, null);
  assert.equal(stopped.tracks.length, 0);
  const restarted = await bot.radio(guild, user, 'start', 'Another seed');
  const left = await bot.control(guild, user, 'leave');
  assert.equal(left.radio.active, true);
  assert.equal(left.channelId, null);
  assert.equal(left.nowPlaying, null);
  assert.deepEqual(left.tracks.map(track => track.id), [restarted.nowPlaying, ...restarted.tracks].map(track => track.id));
  const joined = await bot.join(guild, user);
  assert.equal(joined.nowPlaying.id, restarted.nowPlaying.id);
  assert.equal(joined.radio.active, true);
});
