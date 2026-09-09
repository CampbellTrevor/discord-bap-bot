import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, Events } from 'discord.js';
import { createBot } from '../src/discord.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const track = { title: 'Song', artist: 'Artist', durationSec: 120, source: 'youtube', sourceUrl: 'https://www.youtube.com/watch?v=abcdefghijk' };

async function fixture(t, { fetchMember } = {}) {
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
  const bot = createBot({ config: { discordClientId: '123456789012345678', discordToken: 'unused-test-token' }, media, logger: { info() {}, warn() {}, error() {} } }, { client, music, rest: { async put() {} } });
  await bot.start();
  t.after(() => bot.shutdown());
  return { bot, calls, member, guild, music, media, queue };
}

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
