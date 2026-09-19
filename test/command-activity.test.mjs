import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandActivity, validateActivityFilters } from '../src/command-activity.mjs';

const event = overrides => ({ source: 'web', guildId: '111111111111111111', guildName: 'Server One', userId: '333333333333333333', userName: 'User One', command: 'play', parameters: { query: 'Song title' }, status: 'success', durationMs: 15, ...overrides });
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bap-activity-'));
  const instances = [];
  const create = async changes => {
    const activity = createCommandActivity({ dataDir, logger: { warn() {} }, ...options, ...changes });
    await activity.start(); instances.push(activity); return activity;
  };
  t.after(async () => { for (const instance of instances) await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, create, activity: await create() };
}

test('activity survives restart, strips secret fields and URL credentials, and recovers a torn final append', async t => {
  const { activity, create, dataDir } = await fixture(t);
  activity.record(event({ parameters: {
    query: 'https://name:password@www.youtube.com/watch?v=abcdefghijk&token=secret&list=RDabcdefghijk#private',
    token: 'DO_NOT_STORE', headers: { cookie: 'DO_NOT_STORE' }, volumePercent: 47,
  }, errorCode: 'HTTP_403', stack: 'DO_NOT_STORE', token: 'DO_NOT_STORE' }));
  activity.record(event({ parameters: { query: 'https://private.example/path?key=secret https://open.spotify.com/track/abc123?si=secret' } }));
  await Promise.all([activity.flush(), activity.flush()]);
  await activity.close();
  const file = join(dataDir, '.command-activity.jsonl');
  const saved = await readFile(file, 'utf8');
  assert.doesNotMatch(saved, /password|secret|DO_NOT_STORE|headers|private\.example|#private/);
  assert.match(saved, /https:\/\/www.youtube.com\/watch\?v=abcdefghijk&list=RDabcdefghijk/);
  assert.match(saved, /https:\/\/open.spotify.com\/track\/abc123/);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await appendFile(file, '{"id":"3",');
  const reopened = await create();
  assert.equal((await reopened.query()).events.length, 2);
  reopened.record(event({ command: 'skip' }));
  await reopened.flush();
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 3);
  assert.equal(rows[2].command, 'skip');
});

test('retention and record caps survive restart and expire even with no new commands', async t => {
  let clock = Date.parse('2026-09-19T00:00:00Z');
  const { activity, create, dataDir } = await fixture(t, { maxRecords: 3, now: () => clock });
  for (let i = 0; i < 5; i++) activity.record(event({ command: `command${i}` }));
  assert.deepEqual((await activity.query()).events.map(row => row.command), ['command4', 'command3', 'command2']);
  await activity.close();
  const reopened = await create();
  assert.equal((await reopened.query()).events.length, 3);
  clock += 31 * 86_400_000;
  assert.equal((await reopened.query()).events.length, 0);
  await reopened.flush();
  assert.equal((await readFile(join(dataDir, '.command-activity.jsonl'), 'utf8')).trim(), '');
});

test('server/user/source/outcome filters and cursors stay stable when new commands arrive', async t => {
  const { activity } = await fixture(t);
  activity.record(event({ command: 'play' }));
  activity.record(event({ source: 'discord', command: 'skip', userId: '444444444444444444', userName: 'User Two' }));
  activity.record(event({ command: 'pause', status: 'error', errorCode: 'HTTP_403' }));
  activity.record(event({ guildId: '222222222222222222', guildName: 'Server Two', command: 'radio', status: 'cancelled' }));
  const first = await activity.query({ limit: 2 });
  assert.deepEqual(first.events.map(row => row.command), ['radio', 'pause']);
  activity.record(event({ command: 'resume' }));
  const second = await activity.query({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.events.map(row => row.command), ['skip', 'play']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.total, 5);
  assert.equal((await activity.query({ guildId: '111111111111111111', userId: '333333333333333333', source: 'web', status: 'error' })).events[0].command, 'pause');
  assert.deepEqual((await activity.query({ guildId: '222222222222222222' })).users, [{ id: '333333333333333333', name: 'User One' }]);
  assert.equal((await activity.query()).guilds.length, 2);
  first.events[0].command = 'changed';
  assert.equal((await activity.query({ guildId: '222222222222222222' })).events[0].command, 'radio');
});

test('pending writes remain bounded without blocking commands', async t => {
  const { activity } = await fixture(t, { maxPending: 2 });
  for (let i = 0; i < 5; i++) assert.equal(activity.record(event()), undefined);
  assert.equal((await activity.query()).events.length, 2);
  assert.equal((await activity.query()).droppedEvents, 3);
  await activity.flush();
  activity.record(event({ command: 'resume' }));
  assert.equal((await activity.query()).events.length, 3);
});

test('a disk write failure keeps a bounded recoverable buffer and cannot reject command admission', async t => {
  const { activity, dataDir } = await fixture(t);
  const file = join(dataDir, '.command-activity.jsonl');
  await unlink(file);
  await mkdir(file);
  assert.equal(activity.record(event({ command: 'pause' })), undefined);
  await assert.rejects(activity.flush());
  assert.equal((await activity.query()).events[0].command, 'pause');
  assert.equal(activity.record(event({ command: 'resume' })), undefined);
  await rmdir(file);
  await activity.flush();
  const saved = (await readFile(file, 'utf8')).trim().split('\n').map(value => JSON.parse(value));
  assert.deepEqual(saved.map(value => value.command), ['pause', 'resume']);
});

test('filter validation rejects unbounded, unknown and nested inputs', () => {
  assert.deepEqual(validateActivityFilters({ limit: '100', source: 'web' }), { limit: 100, source: 'web' });
  for (const filters of [null, [], { limit: 101 }, { limit: 0 }, { limit: '10.5' }, { cursor: 'secret/path' }, { cursor: '0' }, { cursor: 'zzzzzzzzzzzzzzzz' }, { userId: {} }, { guildId: ['one'] }, { source: 'all' }, { status: 'unknown' }, { token: 'ignored?' }]) {
    assert.throws(() => validateActivityFilters(filters), { status: 400 });
  }
});
