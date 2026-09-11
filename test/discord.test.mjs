import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, Events } from 'discord.js';
import { createBot } from '../src/discord.mjs';
import { MediaError } from '../src/media.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const track = { title: 'Song', artist: 'Artist', durationSec: 120, source: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' };

test('performance requires current membership and manager permission before reading metrics', async t => {
  let reads = 0;
  const metrics = { getSnapshot() { reads++; return { version: 1, latest: { hostCpuBusyPct: 12 } }; } };
  const { bot, member, guild } = await fixture(t, { metrics });
  await assert.rejects(bot.performance('guild', 'listener'), { status: 403 });
  assert.equal(reads, 0);
  member.permissions.has = () => true;
  assert.equal((await bot.performance('guild', 'manager')).latest.hostCpuBusyPct, 12);
  assert.equal(reads, 1);
  guild.members.fetch = async () => { throw Object.assign(new Error('Unknown member'), { code: 10007 }); };
  await assert.rejects(bot.performance('guild', 'removed-manager'), { status: 403 });
  assert.equal(reads, 1);
});

test('move-top uses playback permissions even for a listener’s own request', async t => {
  const { bot, member, music, queue } = await fixture(t);
  const calls = [];
  queue.tracks.push({ id: 'queued', requestedBy: { id: 'listener' } });
  music.control = async (...args) => { calls.push(args); return queue; };
  member.voice.channelId = 'other-voice';
  await assert.rejects(bot.control('guild', 'listener', 'move-top', 'queued'), { status: 403 });
  assert.equal(calls.length, 0);
  member.voice.channelId = 'voice';
  await bot.control('guild', 'listener', 'move-top', 'queued');
  member.voice.channelId = null;
  member.permissions.has = () => true;
  await bot.control('guild', 'manager', 'move-top', 'queued');
  assert.deepEqual(calls, [['guild', 'move-top', 'queued'], ['guild', 'move-top', 'queued']]);
});

async function fixture(t, { fetchMember, metrics } = {}) {
  const calls = { memberships: 0, snapshots: 0, enqueues: 0, searches: 0, resolves: 0 };
  const member = { displayName: 'Listener', voice: { channelId: 'voice' }, permissions: { has: () => false }, roles: { cache: new Map() } };
  const channel = { id: 'voice', name: 'Lounge', type: ChannelType.GuildVoice, position: 0, permissionsFor: () => ({ has: () => true }) };
  const guild = {
    id: 'guild', name: 'Listening room', channels: { cache: new Map([['voice', channel]]) },
    members: { me: {}, async fetch(options) { calls.memberships += 1; return fetchMember ? fetchMember(options, calls.memberships, member) : member; } },
  };
  const client = new EventEmitter();
  client.guilds = { cache: new Map([['guild', guild]]) };
  client.user = { tag: 'Test bot' };
  client.isReady = () => true;
  client.login = async () => { queueMicrotask(() => client.emit(Events.ClientReady)); };
  client.destroy = () => {};
  const queue = { channelId: 'voice', nowPlaying: null, tracks: [] };
  const music = {
    async restore() {}, async shutdown() {},
    snapshot() { calls.snapshots += 1; return structuredClone(queue); },
    capacity() { return 50 - queue.tracks.length; },
    assertCapacity() {},
    async enqueue(guildId, tracks, requestedBy) {
      calls.enqueues += 1;
      const added = tracks.map(item => ({ ...item, requestedBy }));
      queue.tracks.push(...added);
      return added;
    },
  };
  const media = {
    async search() { calls.searches += 1; return [track]; },
    async resolve() { calls.resolves += 1; return [track]; },
  };
  const registered = [];
  const bot = createBot({ config: { discordClientId: '123456789012345678', discordToken: 'unused-test-token' }, media, metrics, logger: { info() {}, warn() {}, error() {} } }, { client, music, rest: { async put(_route, { body }) { registered.push(...body); } } });
  await bot.start();
  t.after(() => bot.shutdown());
  return { bot, calls, member, guild, music, media, queue, client, registered };
}

test('volume uses current membership and playback permission, validating before mutation', async t => {
  const { bot, member, guild, music, queue } = await fixture(t);
  const changes = [];
  music.setVolume = async (guildId, percent) => { changes.push([guildId, percent]); queue.volumePercent = percent; return queue; };
  member.voice.channelId = 'other-voice';
  await assert.rejects(bot.setVolume('guild', 'listener', 50), { status: 403 });
  member.voice.channelId = 'voice';
  for (const value of [-1, 101, 0.5, '50', null, undefined, NaN]) {
    await assert.rejects(bot.setVolume('guild', 'listener', value), { status: 400 });
  }
  assert.equal(changes.length, 0);
  assert.equal((await bot.setVolume('guild', 'listener', 0)).volumePercent, 0);
  member.voice.channelId = null;
  member.permissions.has = () => true;
  assert.equal((await bot.setVolume('guild', 'manager', 100)).volumePercent, 100);
  guild.members.fetch = async () => { throw Object.assign(new Error('Unknown member'), { code: 10007 }); };
  await assert.rejects(bot.setVolume('guild', 'removed-manager', 50), { status: 403 });
  assert.deepEqual(changes, [['guild', 0], ['guild', 100]]);
});

test('cancelled volume request never commits after a delayed membership check', async t => {
  const started = deferred(), release = deferred();
  const { bot, music } = await fixture(t, { fetchMember: async (_options, _count, member) => {
    started.resolve(); await release.promise; return member;
  } });
  let changed = false;
  music.setVolume = async () => { changed = true; };
  const controller = new AbortController();
  const result = bot.setVolume('guild', 'listener', 50, { signal: controller.signal });
  await started.promise;
  controller.abort(new Error('volume cancelled'));
  release.resolve();
  await assert.rejects(result, /volume cancelled/);
  assert.equal(changed, false);
});

test('volume slash command registers bounded optional percent and supports reading or muting', async t => {
  const { client, registered, member, music, queue } = await fixture(t);
  const command = registered.find(value => value.name === 'volume');
  assert.equal(command.options[0].name, 'percent');
  assert.equal(command.options[0].min_value, 0);
  assert.equal(command.options[0].max_value, 100);
  assert.equal(Boolean(command.options[0].required), false);
  queue.volumePercent = 50;
  const changes = [];
  music.setVolume = async (_guild, percent) => { changes.push(percent); queue.volumePercent = percent; return queue; };
  async function invoke(percent) {
    const reply = deferred();
    client.emit(Events.InteractionCreate, {
      isChatInputCommand: () => true, guildId: 'guild', user: { id: 'listener' }, commandName: 'volume',
      options: { getInteger: () => percent }, deferred: true,
      async deferReply() {}, async editReply(value) { reply.resolve(value); },
    });
    return reply.promise;
  }
  member.voice.channelId = null;
  assert.match((await invoke(null)).content, /50%/);
  assert.equal(changes.length, 0);
  member.voice.channelId = 'voice';
  assert.match((await invoke(0)).content, /0%/);
  assert.deepEqual(changes, [0]);
});

test('detail authorizes membership before returning server context and its queue', async t => {
  const { bot, calls } = await fixture(t);
  const detail = await bot.detail('guild', 'listener');
  assert.equal(calls.memberships, 1);
  assert.equal(detail.guild.name, 'Listening room');
  assert.equal(detail.member.canControl, true);
  assert.deepEqual(detail.voiceChannels, [{ id: 'voice', name: 'Lounge' }]);
  assert.deepEqual(detail.queue, { channelId: 'voice', nowPlaying: null, tracks: [] });
});

test('detail and provider methods never expose queue or provider data to a nonmember', async t => {
  const { bot, calls } = await fixture(t, { fetchMember: async () => { throw Object.assign(new Error('Unknown Member'), { code: 10007 }); } });
  await assert.rejects(bot.detail('guild', 'outsider'), { status: 403 });
  await assert.rejects(bot.search('guild', 'outsider', 'song'), { status: 403 });
  await assert.rejects(bot.request('guild', 'outsider', 'song'), { status: 403 });
  assert.equal(calls.snapshots, 0);
  assert.equal(calls.searches, 0);
  assert.equal(calls.resolves, 0);
  assert.equal(calls.enqueues, 0);
});

test('pre-cancelled search and request stop before membership or provider work', async t => {
  const { bot, calls } = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('cancelled before dispatch'));
  await assert.rejects(bot.search('guild', 'listener', 'song', 'youtube', { signal: controller.signal }), /cancelled before dispatch/);
  await assert.rejects(bot.request('guild', 'listener', 'song', undefined, { signal: controller.signal }), /cancelled before dispatch/);
  assert.equal(calls.memberships, 0);
  assert.equal(calls.searches, 0);
  assert.equal(calls.resolves, 0);
});

test('search forwards cancellation and does not return a late provider result', async t => {
  const { bot, media, calls } = await fixture(t);
  const started = deferred();
  const result = deferred();
  const controller = new AbortController();
  media.search = async (query, source, options) => {
    assert.equal(query, 'song');
    assert.equal(source, 'spotify');
    assert.equal(options.signal, controller.signal);
    started.resolve();
    return result.promise;
  };
  const pending = bot.search('guild', 'listener', ' song ', 'spotify', { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled search/);
  await started.promise;
  controller.abort(new Error('cancelled search'));
  result.resolve([track]);
  await rejected;
  assert.equal(calls.enqueues, 0);
  assert.equal(calls.snapshots, 0);
});

test('cancellation during initial membership verification prevents provider work', async t => {
  const identity = deferred();
  const { bot, calls, member } = await fixture(t, { fetchMember: () => identity.promise });
  const controller = new AbortController();
  const pending = bot.request('guild', 'listener', 'song', undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled membership/);
  controller.abort(new Error('cancelled membership'));
  identity.resolve(member);
  await rejected;
  assert.equal(calls.resolves, 0);
  assert.equal(calls.enqueues, 0);
});

test('request forwards its signal and rejects late metadata before entering the queue lock', async t => {
  const { bot, media, calls } = await fixture(t);
  const started = deferred();
  const result = deferred();
  const controller = new AbortController();
  media.resolve = async (query, options) => {
    assert.equal(query, 'song');
    assert.equal(options.signal, controller.signal);
    started.resolve();
    return result.promise;
  };
  const pending = bot.request('guild', 'listener', ' song ', undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled metadata/);
  await started.promise;
  controller.abort(new Error('cancelled metadata'));
  result.resolve([track]);
  await rejected;
  assert.equal(calls.memberships, 1);
  assert.equal(calls.snapshots, 0);
  assert.equal(calls.enqueues, 0);
});

test('a cancelled request waiting for its guild lock never enqueues', async t => {
  const { bot, music, calls, queue } = await fixture(t);
  const firstCommit = deferred();
  const persistence = deferred();
  const enqueue = music.enqueue.bind(music);
  music.enqueue = async (...args) => {
    const added = await enqueue(...args);
    firstCommit.resolve();
    await persistence.promise;
    return added;
  };
  const first = bot.request('guild', 'listener', 'first');
  await firstCommit.promise;
  const controller = new AbortController();
  const second = bot.request('guild', 'listener', 'second', undefined, { signal: controller.signal });
  const rejected = assert.rejects(second, /cancelled while waiting/);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancelled while waiting'));
  persistence.resolve();
  await first;
  await rejected;
  assert.equal(calls.enqueues, 1);
  assert.equal(calls.memberships, 3);
  assert.equal(queue.tracks.length, 1);
});

test('cancellation during the locked membership recheck prevents voice and queue changes', async t => {
  const checked = deferred();
  const identity = deferred();
  const { bot, calls, member, music } = await fixture(t, { fetchMember: (_options, count, value) => {
    if (count === 2) { checked.resolve(); return identity.promise; }
    return value;
  } });
  music.snapshot = () => assert.fail('No voice or queue reads expected after cancellation');
  const controller = new AbortController();
  const pending = bot.request('guild', 'listener', 'song', 'other-voice', { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled before commit/);
  await checked.promise;
  controller.abort(new Error('cancelled before commit'));
  identity.resolve(member);
  await rejected;
  assert.equal(calls.enqueues, 0);
});

test('late cancellation never rolls back a request that already committed', async t => {
  const { bot, music, queue } = await fixture(t);
  const committed = deferred();
  const persistence = deferred();
  const enqueue = music.enqueue.bind(music);
  music.enqueue = async (...args) => {
    const added = await enqueue(...args);
    committed.resolve();
    await persistence.promise;
    return added;
  };
  const controller = new AbortController();
  const pending = bot.request('guild', 'listener', 'song', undefined, { signal: controller.signal });
  await committed.promise;
  controller.abort(new Error('cancelled after commit'));
  persistence.resolve();
  const result = await pending;
  assert.equal(result.added.length, 1);
  assert.equal(result.queue.tracks.length, 1);
  assert.equal(queue.tracks.length, 1);
});

test('single requests validate playback before admission and preserve the validated mapping', async t => {
  const { bot, media, music, calls, queue } = await fixture(t);
  let held = false;
  music.pausePreflight = () => { held = true; return () => { held = false; }; };
  const controller = new AbortController();
  media.preflight = async (value, { signal }) => {
    assert.equal(held, true);
    assert.equal(calls.enqueues, 0);
    assert.equal(calls.snapshots, 0);
    assert.equal(signal, controller.signal);
    return { ...value, validation: { status: 'ready', checkedAt: 123 }, playbackMapping: { videoId: 'abcdefghijk' } };
  };
  const result = await bot.request('guild', 'listener', 'song', undefined, { signal: controller.signal });
  assert.equal(held, false);
  assert.equal(result.added[0].validation.status, 'ready');
  assert.equal(result.added[0].playbackMapping, undefined);
  assert.equal(queue.tracks[0].playbackMapping.videoId, 'abcdefghijk');
  assert.equal(calls.enqueues, 1);
});

test('failed or cancelled single-song validation never joins voice or changes the queue', async t => {
  const { bot, media, music, calls } = await fixture(t);
  let releases = 0;
  music.pausePreflight = () => () => { releases++; };
  media.preflight = async () => { throw new MediaError('No suitable studio recording was found.', 'NO_PLAYBACK_MATCH'); };
  await assert.rejects(bot.request('guild', 'listener', 'song'), { code: 'NO_PLAYBACK_MATCH' });
  assert.equal(calls.enqueues, 0);
  assert.equal(calls.snapshots, 0);
  const started = deferred(), checked = deferred(), controller = new AbortController();
  media.preflight = async () => { started.resolve(); return checked.promise; };
  const pending = bot.request('guild', 'listener', 'song', undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled match/);
  await started.promise;
  controller.abort(new Error('cancelled match'));
  checked.resolve({ ...track, validation: { status: 'ready' } });
  await rejected;
  assert.equal(calls.enqueues, 0);
  assert.equal(calls.snapshots, 0);
  assert.equal(releases, 2);
});

test('playlist requests enqueue pending checks without blocking on every playback lookup', async t => {
  const { bot, media, music } = await fixture(t);
  const tracks = [track, { ...track, title: 'Second' }];
  Object.defineProperty(tracks, 'import', { value: { source: 'youtube', accepted: 2, warnings: [] } });
  media.resolve = async () => tracks;
  media.preflight = async () => assert.fail('The request must leave playlist playback checks to the queue');
  const enqueue = music.enqueue.bind(music);
  music.enqueue = (guildId, values, requester) => enqueue(guildId, values.map(value => ({ ...value, validation: { status: 'pending' } })), requester);
  const result = await bot.request('guild', 'listener', 'playlist');
  assert.equal(result.added.length, 2);
  assert.equal(result.import.accepted, 2);
  assert.deepEqual(result.warnings, ['Playback matches are being checked in the background.']);
  assert.deepEqual(tracks.import.warnings, []);
});

test('playlist resolution uses available capacity and trims safely if another request fills slots', async t => {
  const { bot, media, music, queue } = await fixture(t);
  let remaining = 5;
  music.capacity = () => remaining;
  music.assertCapacity = (_guild, count) => assert.ok(count <= remaining);
  const tracks = Array.from({ length: 5 }, (_, index) => ({ ...track, title: `Track ${index}` }));
  const summary = { source: 'spotify', accepted: 5, inspected: 6, skipped: 1, limitReached: false, warnings: ['Skipped 1 unavailable playlist entry.'] };
  Object.defineProperty(tracks, 'import', { value: summary });
  media.resolve = async (_query, options) => {
    assert.equal(options.maxTracks, 5);
    remaining = 2;
    return tracks;
  };
  const result = await bot.request('guild', 'listener', 'playlist');
  assert.deepEqual(result.added.map(item => item.title), ['Track 0', 'Track 1']);
  assert.equal(queue.tracks.length, 2);
  assert.equal(result.import.accepted, 2);
  assert.equal(result.import.skipped, 1);
  assert.equal(result.import.notAddedForCapacity, 3);
  assert.equal(result.import.limitReached, true);
  assert.match(result.warnings.join(' '), /room for 2 tracks; 3 additional/);
  assert.equal(tracks.length, 5);
  assert.equal(summary.accepted, 5);
  assert.equal(summary.warnings.length, 1);
});

test('a queue filled during playlist lookup rejects before voice changes or admission', async t => {
  const { bot, media, music, calls } = await fixture(t);
  let remaining = 2;
  music.capacity = () => remaining;
  media.resolve = async () => {
    remaining = 0;
    const tracks = [track];
    Object.defineProperty(tracks, 'import', { value: { source: 'spotify', accepted: 1, warnings: [] } });
    return tracks;
  };
  await assert.rejects(bot.request('guild', 'listener', 'playlist', 'other-voice'), error => error.status === 409 && /Nothing was added/.test(error.message));
  assert.equal(calls.enqueues, 0);
  assert.equal(calls.snapshots, 0);
});

test('a large playlist retains its order and reports the queue-capacity stop', async t => {
  const { bot, media, music, queue } = await fixture(t);
  music.capacity = () => 2000 - queue.tracks.length;
  const tracks = Array.from({ length: 2000 }, (_, index) => ({ ...track, title: `Track ${index}`, searchQuery: 'internal lookup' }));
  Object.defineProperty(tracks, 'import', { value: { source: 'spotify', accepted: 2000, inspected: 2000, skipped: 0, limitReached: true, warnings: [] } });
  media.resolve = async (_query, options) => { assert.equal(options.maxTracks, 2000); return tracks; };
  const result = await bot.request('guild', 'listener', 'playlist');
  assert.equal(result.added.length, 2000);
  assert.deepEqual(result.added.map(item => item.title), tracks.map(item => item.title));
  assert.equal(result.added[0].searchQuery, undefined);
  assert.equal(queue.tracks[0].searchQuery, 'internal lookup');
  assert.match(result.warnings.join(' '), /room for 2000 tracks/);
});
