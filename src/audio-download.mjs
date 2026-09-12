import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const OWNED_FILE = /^bap-audio-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.download$/;
const OWNER_FILE = '.bap-audio-cache-owner.json';
const MESSAGES = {
  busy: ['The audio download cache is full. Try again in a moment.', 'MEDIA_BUSY'],
  owner: ['The audio download cache is already in use by another worker.', 'MEDIA_BUSY'],
  storage: ['The bot could not store this audio download. Please try again.', 'MEDIA_UNAVAILABLE'],
  size: ['This audio download exceeds the bot host limit.', 'MEDIA_UNAVAILABLE'],
  incomplete: ['The audio download was incomplete. Please try again.', 'MEDIA_UNAVAILABLE'],
};

export class AudioDownloadError extends Error {
  constructor(kind) {
    super(MESSAGES[kind][0]);
    this.name = 'AudioDownloadError';
    this.code = MESSAGES[kind][1];
  }
}

function acquireKernelLock(handle, error) {
  return new Promise((resolve, reject) => {
    // Python is already required by yt-dlp on the Linux worker. flock belongs
    // to the inherited open file description, so Node retains the kernel lock
    // after this short helper exits. A crash releases it automatically, even
    // across Docker PID namespaces. Never unlink this lock inode.
    const script = 'import errno, fcntl, sys\ntry:\n fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept OSError as e:\n sys.exit(75 if e.errno in (errno.EACCES, errno.EAGAIN) else 74)\n';
    let child;
    try { child = spawn('python3', ['-I', '-c', script], { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', handle.fd] }); }
    catch { reject(error('storage')); return; }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
    child.once('error', () => { clearTimeout(timer); reject(error('storage')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else reject(error(code === 75 ? 'owner' : 'storage'));
    });
  });
}

function waitForClose(stream) {
  if (!stream || stream.closed) return Promise.resolve();
  return new Promise(resolve => stream.once('close', resolve));
}

/**
 * One worker process owns a cache directory. Only UUID-named files created by
 * this module are scavenged, after an exclusive owner check; links and other
 * application data are never followed or removed. Cache files are temporary
 * and contain no provider URLs. The directory must live on disk, not tmpfs.
 */
export function createAudioDownloadCache({ directory, maxFileBytes = 128 * 1024 * 1024,
  maxTotalBytes = 512 * 1024 * 1024, maxFiles = 16 } = {}, dependencies = {}) {
  if (typeof directory !== 'string' || !directory || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1
    || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxFileBytes || !Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new TypeError('Audio download cache limits and directory must be valid.');
  }
  const fs = { lstat, mkdir, open, readFile, readdir, realpath, unlink, ...dependencies.fs };
  const error = dependencies.error ?? (kind => new AudioDownloadError(kind));
  let initialized;
  let root;
  let owner;
  let reservedBytes = 0;
  let reservedFiles = 0;
  let closed = false;
  let ownerAcquired = false;
  let ownerHandle;
  let closing;
  const leases = new Set();
  const pending = new Set();

  async function initialize() {
    try {
      const requested = path.resolve(directory);
      await fs.mkdir(requested, { recursive: true, mode: 0o700 });
      if (!(await fs.lstat(requested)).isDirectory()) throw error('storage');
      root = await fs.realpath(requested);
      const ownerPath = path.join(root, OWNER_FILE);
      if (process.platform === 'linux') {
        try {
          ownerHandle = await fs.open(ownerPath, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
          if (!(await ownerHandle.stat()).isFile()) throw error('owner');
          await acquireKernelLock(ownerHandle, error);
        } catch (failure) { await ownerHandle?.close(); ownerHandle = null; throw failure; }
        ownerAcquired = true;
      } else {
        // Desktop adapters fail closed on any existing owner record. Stale
        // recovery requires an operator to confirm the old process is stopped
        // and remove this specific record; no PID-based takeover can race a
        // live owner. Linux production does not need this manual recovery.
        owner = { pid: process.pid, nonce: randomUUID() };
        let handle;
        try { handle = await fs.open(ownerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
        catch (failure) { if (failure.code === 'EEXIST') throw error('owner'); throw failure; }
        ownerAcquired = true;
        try { await handle.writeFile(JSON.stringify(owner)); }
        finally { await handle.close(); }
      }
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (!OWNED_FILE.test(entry.name) || !entry.isFile()) continue;
        const candidate = path.join(root, entry.name);
        if ((await fs.lstat(candidate)).isFile()) await fs.unlink(candidate);
      }
    } catch (failure) {
      if (failure?.code === 'MEDIA_BUSY' || failure?.code === 'MEDIA_UNAVAILABLE') throw failure;
      throw error('storage');
    }
  }

  async function createReservation({ signal } = {}) {
    signal?.throwIfAborted();
    if (closed) throw error('storage');
    initialized ??= initialize();
    await initialized;
    signal?.throwIfAborted();
    if (closed) throw error('storage');
    // Reserve the worst case before starting the subprocess. Completed files
    // retain only their actual byte count, so active sources still fit the cap.
    if (reservedFiles >= maxFiles || reservedBytes + maxFileBytes > maxTotalBytes) throw error('busy');
    reservedFiles++;
    reservedBytes += maxFileBytes;
    let reservation = maxFileBytes;
    const file = path.join(root, `bap-audio-${randomUUID()}.download`);
    let handle;
    let writer;
    let reader;
    let output;
    let bytes = 0;
    let written = false;
    let cleaned = false;
    let cleaning;
    let writing;
    let opening;
    const release = () => { reservedBytes -= reservation; reservedFiles--; reservation = 0; };
    try {
      handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      signal?.throwIfAborted();
      if (closed) throw error('storage');
    } catch (failure) {
      let removed = true;
      if (handle) {
        await handle.close().catch(() => {});
        try { await fs.unlink(file); } catch (failure) { removed = failure.code === 'ENOENT'; }
      }
      if (removed) release();
      if (signal?.aborted) throw signal.reason;
      throw error('storage');
    }

    function cleanup() {
      if (cleaning) return cleaning;
      cleaned = true;
      output?.destroy();
      reader?.destroy();
      writer?.destroy();
      cleaning = (async () => {
        await Promise.all([writing?.catch(() => {}), opening?.catch(() => {}), waitForClose(reader), waitForClose(writer)]);
        if (handle) await handle.close().catch(() => {});
        try { await fs.unlink(file); }
        catch (failure) {
          // Keep the reservation if removal fails: never pretend disk space
          // was freed, and never produce an unhandled cleanup rejection.
          if (failure.code !== 'ENOENT') return false;
        }
        release();
        leases.delete(lease);
        return true;
      })();
      return cleaning;
    }

    async function writeFrom(source, { signal: writeSignal, sourceError, onError } = {}) {
      if (cleaned || writer || written) throw error('storage');
      writeSignal?.throwIfAborted();
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxFileBytes) callback(error('size'));
          else callback(null, chunk);
        },
      });
      let originFailure;
      const report = (failure, fromSource = false) => {
        if (originFailure) return;
        originFailure = failure?.code === 'MEDIA_UNAVAILABLE' ? failure
          : fromSource && sourceError ? sourceError(failure) : error('storage');
        try { onError?.(originFailure); } catch {}
      };
      try { writer = handle.createWriteStream({ autoClose: true }); }
      catch { throw error('storage'); }
      // pipeline redistributes its first error to every stream. Capture the
      // originating side before that happens: a disk write failure must never
      // be mistaken for a failed YouTube connection when stdout is destroyed.
      limiter.once('error', failure => report(failure));
      writer.once('error', failure => report(failure));
      source.once('error', failure => report(failure, true));
      writing = pipeline(source, limiter, writer, { signal: writeSignal }).catch(failure => {
        if (writeSignal?.aborted) throw writeSignal.reason;
        if (originFailure) throw originFailure;
        if (failure?.code === 'MEDIA_UNAVAILABLE') throw failure;
        throw error('storage');
      });
      await writing;
      handle = null;
      if (cleaned) throw error('storage');
      if (!bytes) throw error('incomplete');
      written = true;
      reservedBytes -= reservation - bytes;
      reservation = bytes;
      return bytes;
    }

    async function createReadStream({ signal: readSignal } = {}) {
      if (cleaned || !written || reader) throw error('incomplete');
      readSignal?.throwIfAborted();
      let readHandle;
      try {
        readHandle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const info = await readHandle.stat();
        if (!info.isFile() || info.size !== bytes) throw error('incomplete');
        readSignal?.throwIfAborted();
        if (cleaned) throw error('storage');
        reader = readHandle.createReadStream({ autoClose: true });
        // The private file handle never escapes. Map local I/O failures before
        // publishing them, keeping paths out of snapshots and playback errors.
        output = new PassThrough();
        output.on('error', () => reader.destroy());
        reader.on('error', () => output.destroy(error('storage')));
        reader.pipe(output);
        return output;
      } catch (failure) {
        await readHandle?.close().catch(() => {});
        if (readSignal?.aborted) throw readSignal.reason;
        if (failure?.code === 'MEDIA_UNAVAILABLE') throw failure;
        throw error('storage');
      }
    }

    function openStream(options) {
      if (opening) return Promise.reject(error('incomplete'));
      opening = createReadStream(options);
      return opening;
    }

    const lease = { writeFrom, openStream, cleanup };
    leases.add(lease);
    return lease;
  }

  function reserve(options) {
    const reservation = createReservation(options);
    pending.add(reservation);
    reservation.then(() => pending.delete(reservation), () => pending.delete(reservation));
    return reservation;
  }

  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await Promise.allSettled([...pending]);
      await Promise.all([...leases].map(lease => lease.cleanup()));
      if (!initialized) return;
      await initialized.catch(() => {});
      if (!ownerAcquired) return;
      if (ownerHandle) { await ownerHandle.close(); ownerHandle = null; return; }
      const ownerPath = path.join(root, OWNER_FILE);
      const current = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
      if (current.nonce === owner.nonce) await fs.unlink(ownerPath);
    })();
    return closing;
  }

  return { reserve, close };
}
