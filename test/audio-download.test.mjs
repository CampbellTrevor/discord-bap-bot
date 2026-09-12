import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, readdir, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createAudioDownloadCache } from '../src/audio-download.mjs';

const OWNED = 'bap-audio-12345678-1234-4123-8123-123456789012.download';
const OWNER = '.bap-audio-cache-owner.json';
const downloadFiles = async directory => (await readdir(directory)).filter(name => name.endsWith('.download'));
const consume = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

async function fixture(t, options = {}, dependencies = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bap-audio-cache-test-'));
  const cache = createAudioDownloadCache({ directory, ...options }, dependencies);
  t.after(async () => {
    await cache.close();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await rmdir(path.join(directory, entry.name));
      else await unlink(path.join(directory, entry.name));
    }
    await rmdir(directory);
  });
  return { cache, directory };
}

test('completed disk source preserves all bytes and owns its file until idempotent cleanup', async t => {
  const { cache, directory } = await fixture(t);
  const lease = await cache.reserve();
  const content = Buffer.concat([Buffer.from('first'), Buffer.alloc(96 * 1024, 7), Buffer.from('last')]);
  assert.equal(await lease.writeFrom(Readable.from([content.subarray(0, 5), content.subarray(5)])), content.length);
  assert.deepEqual(await consume(await lease.openStream()), content);
  assert.equal((await downloadFiles(directory)).length, 1, 'Playback EOF does not discard a file until its owner releases it.');
  const cleaning = lease.cleanup();
  assert.equal(lease.cleanup(), cleaning);
  assert.equal(await cleaning, true);
  assert.deepEqual(await downloadFiles(directory), []);
});

test('unknown-length output is stopped at the byte cap and a partial source cannot open', async t => {
  const { cache, directory } = await fixture(t, { maxFileBytes: 16, maxTotalBytes: 32 });
  const lease = await cache.reserve();
  await assert.rejects(lease.writeFrom(Readable.from([Buffer.alloc(8), Buffer.alloc(9)])), {
    code: 'MEDIA_UNAVAILABLE', message: 'This audio download exceeds the bot host limit.',
  });
  await assert.rejects(lease.openStream(), { code: 'MEDIA_UNAVAILABLE' });
  await lease.cleanup();
  assert.deepEqual(await downloadFiles(directory), []);
  await (await cache.reserve()).cleanup();
});

test('download reservations and completed bytes share a strict disk budget and file-count cap', async t => {
  const { cache } = await fixture(t, { maxFileBytes: 100, maxTotalBytes: 200, maxFiles: 3 });
  const first = await cache.reserve();
  const second = await cache.reserve();
  await assert.rejects(cache.reserve(), { code: 'MEDIA_BUSY' });
  await first.writeFrom(Readable.from([Buffer.alloc(30)]));
  await assert.rejects(cache.reserve(), { code: 'MEDIA_BUSY' }, 'An unfinished download still reserves its full ceiling.');
  await second.writeFrom(Readable.from([Buffer.alloc(20)]));
  const third = await cache.reserve();
  await third.writeFrom(Readable.from([Buffer.alloc(1)]));
  await assert.rejects(cache.reserve(), { code: 'MEDIA_BUSY' }, 'Tiny files still count toward the independent file ceiling.');
  await second.cleanup();
  await (await cache.reserve()).cleanup();
});

test('a current recording and two thirty-megabyte preloads stream to disk within the production budget', async t => {
  const { cache, directory } = await fixture(t);
  const chunk = Buffer.alloc(256 * 1024, 73);
  const chunksPerRecording = 120;
  const expectedHash = createHash('sha256');
  for (let i = 0; i < chunksPerRecording; i++) expectedHash.update(chunk);
  const expectedDigest = expectedHash.digest('hex');
  const sources = await Promise.all([cache.reserve(), cache.reserve(), cache.reserve()]);
  const recording = () => Readable.from((function* () {
    for (let i = 0; i < chunksPerRecording; i++) yield chunk;
  })());
  await Promise.all(sources.map(source => source.writeFrom(recording())));
  assert.equal((await downloadFiles(directory)).length, 3);
  for (const source of sources) {
    let bytes = 0;
    const digest = createHash('sha256');
    for await (const data of await source.openStream()) { bytes += data.length; digest.update(data); }
    assert.equal(bytes, 30 * 1024 * 1024);
    assert.equal(digest.digest('hex'), expectedDigest);
  }
  await Promise.all(sources.map(source => source.cleanup()));
  assert.deepEqual(await downloadFiles(directory), []);
  // All four full 128 MiB reservations must fit again after the large sources
  // close; none of their completed bytes may remain counted or on disk.
  const reservations = await Promise.all([cache.reserve(), cache.reserve(), cache.reserve(), cache.reserve()]);
  await assert.rejects(cache.reserve(), { code: 'MEDIA_BUSY' });
  await Promise.all(reservations.map(source => source.cleanup()));
});

test('cancellation during writing closes partial output and returns its reservation', async t => {
  const { cache, directory } = await fixture(t, { maxFileBytes: 100, maxTotalBytes: 100 });
  const lease = await cache.reserve();
  const controller = new AbortController();
  const source = new PassThrough();
  const reason = new Error('Cancelled test download');
  const writing = lease.writeFrom(source, { signal: controller.signal });
  const rejected = assert.rejects(writing, error => error === reason);
  source.write('partial');
  controller.abort(reason);
  await rejected;
  await lease.cleanup();
  assert.equal(source.destroyed, true);
  assert.deepEqual(await downloadFiles(directory), []);
  await (await cache.reserve()).cleanup();
});

test('cleanup owns a blocked writer even without a separate abort signal', async t => {
  const { cache, directory } = await fixture(t);
  const lease = await cache.reserve();
  const source = new PassThrough();
  const writing = assert.rejects(lease.writeFrom(source), { code: 'MEDIA_UNAVAILABLE' });
  source.write('partial');
  await lease.cleanup();
  await writing;
  assert.equal(source.destroyed, true);
  assert.deepEqual(await downloadFiles(directory), []);
});

test('empty output and a disappeared completed file fail before they become a playback source', async t => {
  const { cache, directory } = await fixture(t);
  const empty = await cache.reserve();
  await assert.rejects(empty.writeFrom(Readable.from([])), { code: 'MEDIA_UNAVAILABLE' });
  await empty.cleanup();
  const missing = await cache.reserve();
  await missing.writeFrom(Readable.from(['audio']));
  await unlink(path.join(directory, (await downloadFiles(directory))[0]));
  await assert.rejects(missing.openStream(), error => error.code === 'MEDIA_UNAVAILABLE' && !error.message.includes(directory));
  assert.equal(await missing.cleanup(), true);
});

test('disk writer errors are sanitized and do not leak a file or reservation', async t => {
  const { cache, directory } = await fixture(t, {}, { fs: {
    async open(file, flags, mode) {
      const handle = await open(file, flags, mode);
      if (file.endsWith('.download')) handle.createWriteStream = () => new Writable({
        write(chunk, encoding, callback) { callback(Object.assign(new Error(`ENOSPC: ${file}`), { code: 'ENOSPC' })); },
      });
      return handle;
    },
  } });
  const lease = await cache.reserve();
  await assert.rejects(lease.writeFrom(Readable.from(['audio'])), {
    code: 'MEDIA_UNAVAILABLE', message: 'The bot could not store this audio download. Please try again.',
  });
  await lease.cleanup();
  assert.deepEqual(await downloadFiles(directory), []);
});

test('read errors expose a safe message instead of a private file path', async t => {
  const { cache } = await fixture(t, {}, { fs: {
    async open(file, flags, mode) {
      const handle = await open(file, flags, mode);
      if (file.endsWith('.download') && !(flags & constants.O_WRONLY)) {
        handle.createReadStream = () => new Readable({
          read() { this.destroy(new Error(`EIO: ${file}`)); },
          destroy(error, callback) { handle.close().then(() => callback(error), callback); },
        });
      }
      return handle;
    },
  } });
  const lease = await cache.reserve();
  await lease.writeFrom(Readable.from(['audio']));
  await assert.rejects(consume(await lease.openStream()), {
    code: 'MEDIA_UNAVAILABLE', message: 'The bot could not store this audio download. Please try again.',
  });
  await lease.cleanup();
});

test('startup scavenges only owned regular files and preserves unrelated application data', async t => {
  const { cache, directory } = await fixture(t);
  await writeFile(path.join(directory, OWNED), 'abandoned partial file');
  await writeFile(path.join(directory, 'queues.json'), 'queue sentinel');
  await writeFile(path.join(directory, 'sessions.json'), 'session sentinel');
  await writeFile(path.join(directory, 'bap-audio-not-a-uuid.download'), 'unowned sentinel');
  const nested = OWNED.replace('12345678', '22345678');
  await mkdir(path.join(directory, nested));
  if (process.platform === 'linux') await writeFile(path.join(directory, OWNER), JSON.stringify({ pid: 2147483647, identity: 'a previous process identity' }));
  const lease = await cache.reserve();
  await assert.rejects(readFile(path.join(directory, OWNED)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(directory, 'queues.json'), 'utf8'), 'queue sentinel');
  assert.equal(await readFile(path.join(directory, 'sessions.json'), 'utf8'), 'session sentinel');
  assert.equal(await readFile(path.join(directory, 'bap-audio-not-a-uuid.download'), 'utf8'), 'unowned sentinel');
  assert.deepEqual(await readdir(path.join(directory, nested)), []);
  await lease.cleanup();
});

test('a cache root that is a directory link is rejected without touching its target', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bap-audio-linked-cache-test-'));
  const target = path.join(directory, 'target');
  const linked = path.join(directory, 'linked');
  await mkdir(target);
  await writeFile(path.join(target, OWNED), 'outside sentinel');
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const cache = createAudioDownloadCache({ directory: linked });
  t.after(async () => { await cache.close(); await unlink(path.join(target, OWNED)); await rmdir(target); await (process.platform === 'win32' ? rmdir(linked) : unlink(linked)); await rmdir(directory); });
  await assert.rejects(cache.reserve(), { code: 'MEDIA_UNAVAILABLE' });
  assert.equal(await readFile(path.join(target, OWNED), 'utf8'), 'outside sentinel');
});

test('a second live worker cannot scavenge another worker\'s playback files', async t => {
  const { cache, directory } = await fixture(t);
  const lease = await cache.reserve();
  await lease.writeFrom(Readable.from(['active recording']));
  const competitor = createAudioDownloadCache({ directory });
  await assert.rejects(competitor.reserve(), { code: 'MEDIA_BUSY', message: 'The audio download cache is already in use by another worker.' });
  await competitor.close();
  assert.deepEqual(await consume(await lease.openStream()), Buffer.from('active recording'));
  assert.equal((await downloadFiles(directory)).length, 1);
  await lease.cleanup();
});

test('desktop crash records fail closed instead of racing a replacement owner', { skip: process.platform === 'linux' }, async t => {
  const { cache, directory } = await fixture(t);
  await writeFile(path.join(directory, OWNER), JSON.stringify({ pid: 2147483647, nonce: 'a previous desktop process' }));
  await writeFile(path.join(directory, OWNED), 'unconfirmed ownership sentinel');
  await assert.rejects(cache.reserve(), { code: 'MEDIA_BUSY' });
  await cache.close();
  assert.equal(await readFile(path.join(directory, OWNED), 'utf8'), 'unconfirmed ownership sentinel');
  assert.equal(JSON.parse(await readFile(path.join(directory, OWNER), 'utf8')).nonce, 'a previous desktop process');
});

test('close cancels outstanding files, removes its owner lock, and rejects new reservations', async t => {
  const { cache, directory } = await fixture(t);
  const reading = await cache.reserve();
  await reading.writeFrom(Readable.from([Buffer.alloc(128 * 1024)]));
  const stream = await reading.openStream();
  const writing = await cache.reserve();
  const writeResult = assert.rejects(writing.writeFrom(new PassThrough()), { code: 'MEDIA_UNAVAILABLE' });
  const closing = cache.close();
  assert.equal(cache.close(), closing);
  await closing;
  await writeResult;
  assert.equal(stream.destroyed, true);
  assert.deepEqual((await readdir(directory)).filter(name => process.platform !== 'linux' || name !== OWNER), []);
  await assert.rejects(cache.reserve(), { code: 'MEDIA_UNAVAILABLE' });
});

test('abort while the private file is being allocated closes and removes it', async t => {
  let allocating;
  let proceed;
  const allocated = new Promise(resolve => { allocating = resolve; });
  const gate = new Promise(resolve => { proceed = resolve; });
  const { cache, directory } = await fixture(t, {}, { fs: {
    async open(file, flags, mode) {
      const handle = await open(file, flags, mode);
      if (file.endsWith('.download')) { allocating(); await gate; }
      return handle;
    },
  } });
  const controller = new AbortController();
  const reservation = cache.reserve({ signal: controller.signal });
  const reason = new Error('Cancelled allocation');
  const rejected = assert.rejects(reservation, error => error === reason);
  await allocated;
  controller.abort(reason);
  proceed();
  await rejected;
  assert.deepEqual(await downloadFiles(directory), []);
});

test('cleanup waits for an in-progress file read open before unlinking the recording', async t => {
  let readStarted;
  let proceed;
  const starting = new Promise(resolve => { readStarted = resolve; });
  const gate = new Promise(resolve => { proceed = resolve; });
  const { cache, directory } = await fixture(t, {}, { fs: {
    async open(file, flags, mode) {
      const handle = await open(file, flags, mode);
      if (file.endsWith('.download') && !(flags & constants.O_WRONLY)) { readStarted(); await gate; }
      return handle;
    },
  } });
  const lease = await cache.reserve();
  await lease.writeFrom(Readable.from(['complete recording']));
  const opening = assert.rejects(lease.openStream(), { code: 'MEDIA_UNAVAILABLE' });
  await starting;
  let cleaned = false;
  const cleaning = lease.cleanup();
  cleaning.then(() => { cleaned = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleaned, false, 'The reader owns an open descriptor until its open operation settles.');
  proceed();
  await opening;
  assert.equal(await cleaning, true);
  assert.deepEqual(await downloadFiles(directory), []);
});

test('Linux kernel ownership survives the short helper and is released after an ungraceful owner exit', { skip: process.platform !== 'linux', timeout: 10_000 }, async t => {
  const { directory } = await fixture(t);
  const moduleUrl = new URL('../src/audio-download.mjs', import.meta.url).href;
  const script = `import { createAudioDownloadCache } from ${JSON.stringify(moduleUrl)};
    import { Readable } from 'node:stream';
    const cache = createAudioDownloadCache({ directory: process.argv[1] });
    const lease = await cache.reserve();
    await lease.writeFrom(Readable.from(['a recording owned by the first process']));
    process.stdout.write('ready\\n');
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('end', resolve));
    await cache.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, directory], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  const ready = await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => chunk.toString()),
    closed.then(() => assert.fail('Cache owner exited before acquiring its lock.')),
  ]);
  assert.equal(ready, 'ready\n');
  const ownerPath = path.join(directory, OWNER);
  const originalInode = (await stat(ownerPath)).ino;
  const abandoned = (await downloadFiles(directory))[0];
  const contender = createAudioDownloadCache({ directory });
  await assert.rejects(contender.reserve(), { code: 'MEDIA_BUSY' });
  await contender.close();
  assert.equal(await readFile(path.join(directory, abandoned), 'utf8'), 'a recording owned by the first process');
  child.kill('SIGKILL');
  await closed;
  const successor = createAudioDownloadCache({ directory });
  t.after(() => successor.close());
  const lease = await successor.reserve();
  await assert.rejects(readFile(path.join(directory, abandoned)), { code: 'ENOENT' });
  assert.equal((await stat(ownerPath)).ino, originalInode, 'The lock inode is retained across process crashes and handoff.');
  await lease.cleanup();
  await successor.close();
  const last = createAudioDownloadCache({ directory });
  t.after(() => last.close());
  await (await last.reserve()).cleanup();
  await last.close();
  assert.equal((await stat(ownerPath)).ino, originalInode, 'Graceful close releases the descriptor without unlinking the lock.');
});
