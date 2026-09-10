import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostMetrics } from '../src/host-metrics.mjs';

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const MIB = 1024 * 1024;

async function fixture(t, { missing = false, failWrites = false, monitorEventLoopDelay = () => null } = {}) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'turntable-metrics-'));
  let clock = Math.floor(Date.now() / MINUTE) * MINUTE;
  let writes = 0, timerCallback, stopped = false;
  const fallbackTimes = { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 };
  const files = new Map([
    ['/proc/stat', 'cpu 100 0 50 800 10 0 0 40 0 0\ncpu0 100 0 50 800 10 0 0 40 0 0\n'],
    ['/proc/meminfo', 'MemTotal: 2097152 kB\nMemAvailable: 1048576 kB\nSwapTotal: 2097152 kB\nSwapFree: 1572864 kB\n'],
    ['/sys/fs/cgroup/cpu.stat', 'usage_usec 1000000\nnr_periods 100\nnr_throttled 10\nthrottled_usec 1000\n'],
    ['/sys/fs/cgroup/cpu.max', '100000 100000\n'],
    ['/sys/fs/cgroup/memory.current', String(500 * MIB)],
    ['/sys/fs/cgroup/memory.max', String(768 * MIB)],
    ['/sys/fs/cgroup/memory.events', 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n'],
  ]);
  const io = { ...fs,
    async readFile(file, ...args) {
      if (file.startsWith('/proc/') || file.startsWith('/sys/')) {
        if (missing || !files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return files.get(file);
      }
      return fs.readFile(file, ...args);
    },
    async writeFile(...args) { writes++; if (failWrites) throw new Error('private path and secret'); return fs.writeFile(...args); },
    async statfs() { if (missing) throw new Error('unsupported'); return { bsize: 4096, blocks: 100000, bavail: 20000 }; },
  };
  const instances = [];
  const create = () => {
    const metrics = createHostMetrics({ dataDir, now: () => clock, fs: io, monitorEventLoopDelay,
      os: { cpus: () => [{ times: { ...fallbackTimes } }], totalmem: () => 4 * 1024 * MIB, freemem: () => 2 * 1024 * MIB },
      setInterval(fn, interval) { assert.equal(interval, 5000); timerCallback = fn; return { unref() {} }; },
      clearInterval() { stopped = true; },
    });
    instances.push(metrics);
    return metrics;
  };
  t.after(async () => {
    await Promise.allSettled(instances.map(metrics => metrics.close()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { metrics: create(), create, files, dataDir, fallbackTimes, writes: () => writes, stopped: () => stopped,
    now: () => clock,
    advance: async milliseconds => { clock += milliseconds; await timerCallback?.(); },
    setTime: value => { clock = value; },
  };
}

function pressure(files) {
  files.set('/proc/stat', 'cpu 130 0 60 845 15 0 0 50 0 0\ncpu0 130 0 60 845 15 0 0 50 0 0\n');
  files.set('/sys/fs/cgroup/cpu.stat', 'usage_usec 2000000\nnr_periods 150\nnr_throttled 20\nthrottled_usec 1001000\n');
  files.set('/sys/fs/cgroup/memory.events', 'oom 2\noom_kill 1\n');
}

test('collects host pressure, container limits/counter changes, and disk availability', async t => {
  const { metrics, files, advance } = await fixture(t);
  await metrics.start();
  assert.equal(metrics.getSnapshot().latest.hostCpuBusyPct, null, 'CPU utilization needs two samples.');
  pressure(files);
  await advance(5000);
  const { latest } = metrics.getSnapshot();
  assert.equal(latest.hostCpuBusyPct, 40);
  assert.equal(latest.hostCpuStealPct, 10);
  assert.equal(latest.hostCpuIowaitPct, 5);
  assert.equal(latest.hostCpuCores, 1);
  assert.equal(latest.hostMemoryTotalBytes, 2048 * MIB);
  assert.equal(latest.hostMemoryAvailableBytes, 1024 * MIB);
  assert.equal(latest.hostSwapTotalBytes, 2048 * MIB);
  assert.equal(latest.hostSwapUsedBytes, 512 * MIB);
  assert.equal(latest.containerMemoryBytes, 500 * MIB);
  assert.equal(latest.containerMemoryLimitBytes, 768 * MIB);
  assert.equal(latest.containerCpuUsagePct, 20);
  assert.equal(latest.containerCpuLimitCores, 1);
  assert.equal(latest.containerCpuThrottledPct, 20);
  assert.equal(latest.containerCpuThrottledMs, 1000);
  assert.equal(latest.containerOomEventsDelta, 2);
  assert.equal(latest.containerOomKillsDelta, 1);
  assert.equal(latest.diskFreeBytes, 4096 * 20000);
  assert.deepEqual(latest.sources, { cpu: 'proc', memory: 'proc', cgroup: 'v2', disk: 'statfs' });
});

test('counter resets and unlimited cgroups do not report fabricated negative utilization', async t => {
  const { metrics, files, advance } = await fixture(t);
  await metrics.start();
  pressure(files);
  await advance(5000);
  files.set('/proc/stat', 'cpu 1 0 1 1 0 0 0 0 0 0\ncpu0 1 0 1 1 0 0 0 0 0 0\n');
  files.set('/sys/fs/cgroup/cpu.stat', 'usage_usec 1\nnr_periods 1\nnr_throttled 0\nthrottled_usec 0\n');
  files.set('/sys/fs/cgroup/memory.events', 'oom 0\noom_kill 0\n');
  files.set('/sys/fs/cgroup/memory.max', 'max\n');
  files.set('/sys/fs/cgroup/cpu.max', 'max 100000\n');
  files.set('/proc/meminfo', 'MemTotal: 2097152 kB\nMemAvailable: 999999999999999999999999999 kB\nSwapTotal: 2097152 kB\n');
  await advance(5000);
  const { latest } = metrics.getSnapshot();
  for (const field of ['hostCpuBusyPct', 'hostCpuStealPct', 'containerCpuUsagePct', 'containerCpuThrottledPct',
    'containerCpuThrottledMs', 'containerOomKillsDelta', 'containerMemoryLimitBytes', 'containerCpuLimitCores',
    'hostMemoryAvailableBytes', 'hostSwapUsedBytes']) assert.equal(latest[field], null, field);
});

test('Windows or unavailable Linux counters fall back without inventing steal, swap or cgroup readings', async t => {
  const { metrics, fallbackTimes, advance } = await fixture(t, { missing: true });
  await metrics.start();
  fallbackTimes.user += 50;
  fallbackTimes.idle += 50;
  await advance(5000);
  const { latest } = metrics.getSnapshot();
  assert.equal(latest.hostCpuBusyPct, 50);
  assert.equal(latest.hostMemoryTotalBytes, 4096 * MIB);
  assert.equal(latest.hostMemoryAvailableBytes, 2048 * MIB);
  assert.equal(latest.sources.memory, 'os');
  for (const field of ['hostCpuStealPct', 'hostCpuIowaitPct', 'hostSwapTotalBytes', 'containerMemoryBytes', 'diskFreeBytes']) assert.equal(latest[field], null);
});

test('minute aggregates preserve short peaks and persist at most once per minute across restart', async t => {
  const { metrics, files, advance, writes, create, stopped } = await fixture(t);
  await metrics.start();
  assert.equal(writes(), 1);
  pressure(files);
  await advance(5000);
  files.set('/proc/stat', 'cpu 130 0 60 945 15 0 0 50 0 0\ncpu0 130 0 60 945 15 0 0 50 0 0\n');
  await advance(5000);
  assert.equal(writes(), 1);
  const history = metrics.getSnapshot().history;
  assert.equal(history[0].avg.hostCpuBusyPct, 20);
  assert.equal(history[0].max.hostCpuBusyPct, 40);
  assert.equal(history[0].min.hostCpuBusyPct, 0);
  await advance(50000);
  assert.equal(writes(), 2);
  await metrics.close();
  assert.equal(writes(), 2, 'Shutdown obeys the same write budget.');
  assert.equal(stopped(), true);
  const restarted = create();
  await restarted.start();
  assert.equal(writes(), 2, 'Immediate restart does not add a write within the saved minute.');
  assert.equal(Math.max(...restarted.getSnapshot().history.map(point => point.max.hostCpuBusyPct ?? 0)), 40);
});

test('source startup aggregates and safe error codes survive restart without media metadata', async t => {
  const { metrics, advance, create, dataDir } = await fixture(t);
  await metrics.start();
  metrics.recordPlayback({ outcome: 'ready', durationMs: 100, preloaded: true });
  metrics.recordPlayback({ outcome: 'ready', durationMs: 3000, preloaded: false });
  metrics.recordPlayback({ outcome: 'error', durationMs: 4000, preloaded: false, code: 'MEDIA_TIMEOUT' });
  metrics.recordPlayback({ outcome: 'error', durationMs: 500, preloaded: true, code: 'https://private-media.example?token=secret' });
  metrics.recordPlayback({ outcome: 'ready', durationMs: NaN, preloaded: true });
  metrics.recordPlayback({ outcome: 'unknown', durationMs: 1, preloaded: false });
  await advance(MINUTE);
  const before = metrics.getSnapshot().playback;
  assert.equal(before.measurement, 'source-and-packet-preparation');
  assert.equal(before.legacySourceOnly, false);
  assert.equal(before.ready, 2);
  assert.equal(before.error, 2);
  assert.equal(before.preloadedReady, 1);
  assert.equal(before.preloadedError, 1);
  assert.equal(before.meanReadyMs, 1550);
  assert.equal(before.maxReadyMs, 3000);
  assert.equal(before.p95ReadyMsUpperBound, 4000);
  assert.deepEqual(before.errors, [{ code: 'MEDIA_TIMEOUT', count: 1 }, { code: 'UNKNOWN', count: 1 }]);
  const disk = await fs.readFile(path.join(dataDir, '.host-metrics.json'), 'utf8');
  assert.equal(disk.includes('private-media'), false);
  assert.equal(disk.includes('secret'), false);
  await metrics.close();
  const restarted = create();
  await restarted.start();
  assert.deepEqual(restarted.getSnapshot().playback, before);
});

test('history expires after 24 hours and response history never exceeds 288 buckets', async t => {
  const { metrics, advance } = await fixture(t);
  await metrics.start();
  metrics.recordPlayback({ outcome: 'ready', durationMs: 100, preloaded: false });
  for (let i = 0; i < 290; i++) await advance(5 * MINUTE);
  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.history.length, 288);
  assert.equal(snapshot.playback.ready, 0);
  assert.ok(snapshot.history.every(point => point.at >= snapshot.sampledAt - DAY));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 4 * 1024 * 1024, 'History stays below half the 8 MiB worker message ceiling.');
});

test('damaged persistence and failed writes do not interrupt metrics or expose filesystem details', async t => {
  const { metrics, files, advance } = await fixture(t, { failWrites: true });
  await metrics.start();
  pressure(files);
  await advance(5000);
  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.latest.hostCpuBusyPct, 40);
  assert.equal(snapshot.persistence.available, false);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  const second = await fixture(t);
  await fs.writeFile(path.join(second.dataDir, '.host-metrics.json'), '{broken');
  await second.metrics.start();
  assert.ok(second.metrics.getSnapshot().latest);
  assert.equal(second.metrics.getSnapshot().history.length, 1);
});

test('snapshot data is detached and repeated start/close are safe', async t => {
  const { metrics, writes } = await fixture(t);
  await Promise.all([metrics.start(), metrics.start()]);
  assert.equal(writes(), 1);
  const snapshot = metrics.getSnapshot();
  snapshot.latest.hostMemoryTotalBytes = 1;
  snapshot.history[0].max.hostMemoryTotalBytes = 1;
  assert.equal(metrics.getSnapshot().latest.hostMemoryTotalBytes, 2048 * MIB);
  assert.equal(metrics.getSnapshot().history[0].max.hostMemoryTotalBytes, 2048 * MIB);
  await Promise.all([metrics.close(), metrics.close()]);
  metrics.recordPlayback({ outcome: 'ready', durationMs: 10, preloaded: false });
  assert.equal(metrics.getSnapshot().playback.ready, 0);
});

test('preload lifecycle counts and natural transition timing persist independently from foreground preparation', async t => {
  const { metrics, advance, create, dataDir } = await fixture(t);
  await metrics.start();
  metrics.recordPreload({ outcome: 'ready', durationMs: 100 });
  metrics.recordPreload({ outcome: 'ready', durationMs: 3000 });
  metrics.recordPreload({ outcome: 'error', durationMs: 4000, code: 'MEDIA_TIMEOUT' });
  metrics.recordPreload({ outcome: 'error', durationMs: 50, code: 'https://private.example/?secret=hidden' });
  metrics.recordPreload({ outcome: 'cancelled', durationMs: 200 });
  metrics.recordPreload({ outcome: 'expired', durationMs: 300000, code: 'MEDIA_UNAVAILABLE' });
  metrics.recordTransition({ outcome: 'ready', durationMs: 40, preloaded: true });
  metrics.recordTransition({ outcome: 'ready', durationMs: 600, preloaded: false });
  metrics.recordTransition({ outcome: 'error', durationMs: 10, preloaded: true });
  metrics.recordTransition({ outcome: 'ready', durationMs: 10 });
  metrics.recordPreload({ outcome: 'ready', durationMs: NaN });
  metrics.recordPreload({ outcome: 'expired', durationMs: 3600001 });
  await advance(MINUTE);
  const before = metrics.getSnapshot();
  assert.equal(before.playback.ready, 0);
  assert.deepEqual(before.preload, { measurement: 'background-source-and-packet-preparation',
    ready: 2, error: 2, cancelled: 1, expired: 1, meanReadyMs: 1550, maxReadyMs: 3000,
    p95ReadyMsUpperBound: 4000, errors: [{ code: 'MEDIA_TIMEOUT', count: 1 }, { code: 'UNKNOWN', count: 1 }] });
  assert.deepEqual(before.transition, { measurement: 'natural-end-to-transport-playing',
    ready: 2, preloadedReady: 1, meanReadyMs: 320, maxReadyMs: 600, p95ReadyMsUpperBound: 1000 });
  assert.equal(before.history.reduce((sum, point) => sum + point.preload.ready, 0), 2);
  assert.equal(before.history.reduce((sum, point) => sum + point.transition.ready, 0), 2);
  const disk = await fs.readFile(path.join(dataDir, '.host-metrics.json'), 'utf8');
  assert.doesNotMatch(disk, /private\.example|secret|hidden/);
  await metrics.close();
  const restarted = create();
  await restarted.start();
  assert.deepEqual(restarted.getSnapshot().preload, before.preload);
  assert.deepEqual(restarted.getSnapshot().transition, before.transition);
  metrics.recordPreload({ outcome: 'ready', durationMs: 10 });
  metrics.recordTransition({ outcome: 'ready', durationMs: 10, preloaded: true });
  assert.deepEqual(metrics.getSnapshot().preload, before.preload);
  assert.deepEqual(metrics.getSnapshot().transition, before.transition);
});

test('existing version 1 history survives missing new fields and identifies legacy source-only timing', async t => {
  const { metrics, advance, create, dataDir, files } = await fixture(t);
  await metrics.start();
  metrics.recordPlayback({ outcome: 'ready', durationMs: 100, preloaded: false });
  pressure(files);
  await advance(MINUTE);
  await metrics.close();
  const file = path.join(dataDir, '.host-metrics.json');
  const old = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const entry of old.buckets) {
    delete entry.preload;
    delete entry.transition;
    delete entry.legacySourceOnly;
  }
  await fs.writeFile(file, JSON.stringify(old));
  const restarted = create();
  await restarted.start();
  const restored = restarted.getSnapshot();
  assert.equal(restored.persistence.available, true);
  assert.equal(restored.playback.ready, 1);
  assert.equal(restored.playback.meanReadyMs, 100);
  assert.equal(restored.playback.legacySourceOnly, true);
  assert.equal(restored.preload.ready, 0);
  assert.equal(restored.transition.ready, 0);
  assert.equal(Math.max(...restored.history.map(point => point.max.hostCpuBusyPct ?? 0)), 40);
  restarted.recordPlayback({ outcome: 'ready', durationMs: 200, preloaded: true });
  restarted.recordPreload({ outcome: 'ready', durationMs: 300 });
  await advance(MINUTE);
  assert.equal(restarted.getSnapshot().playback.meanReadyMs, 150);
  assert.equal(restarted.getSnapshot().playback.legacySourceOnly, true);
  const migrated = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(migrated.version, 1);
  assert.equal(migrated.buckets.reduce((sum, entry) => sum + entry.playback.ready, 0), 2);
  assert.equal(migrated.buckets.reduce((sum, entry) => sum + entry.preload.ready, 0), 1);
});

test('malformed additive metrics are ignored without discarding valid host history', async t => {
  const { metrics, advance, create, dataDir } = await fixture(t);
  await metrics.start();
  metrics.recordPlayback({ outcome: 'ready', durationMs: 100, preloaded: false });
  await advance(MINUTE);
  await metrics.close();
  const file = path.join(dataDir, '.host-metrics.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const entry of saved.buckets) {
    entry.preload = { ...entry.preload, cancelled: -1, errors: { 'private raw text': 1 } };
    entry.transition = { ...entry.transition, ready: 9000000 };
  }
  await fs.writeFile(file, JSON.stringify(saved));
  const restarted = create();
  await restarted.start();
  const snapshot = restarted.getSnapshot();
  assert.equal(snapshot.persistence.available, true);
  assert.equal(snapshot.playback.ready, 1);
  assert.equal(snapshot.preload.cancelled, 0);
  assert.equal(snapshot.transition.ready, 0);
  assert.ok(snapshot.history.some(point => point.max.hostMemoryTotalBytes === 2048 * MIB));
  assert.doesNotMatch(JSON.stringify(snapshot), /private raw text/);
});

test('new metric event rates and error vocabularies are bounded and expire with history', async t => {
  const { metrics, advance } = await fixture(t);
  await metrics.start();
  for (let index = 0; index < 1100; index++) {
    metrics.recordPreload({ outcome: 'error', durationMs: 10, code: `PROVIDER_${index % 30}` });
    metrics.recordTransition({ outcome: 'ready', durationMs: index, preloaded: true });
  }
  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.preload.error, 1000);
  assert.ok(snapshot.preload.errors.length <= 17);
  assert.equal(snapshot.preload.errors.reduce((sum, entry) => sum + entry.count, 0), 1000);
  assert.equal(snapshot.transition.ready, 1000);
  assert.equal(snapshot.transition.preloadedReady, 1000);
  snapshot.preload.errors[0].count = 999999;
  snapshot.history[0].transition.ready = 999999;
  assert.equal(metrics.getSnapshot().preload.errors.reduce((sum, entry) => sum + entry.count, 0), 1000);
  assert.equal(metrics.getSnapshot().transition.ready, 1000);
  await advance(DAY + MINUTE);
  assert.equal(metrics.getSnapshot().preload.error, 0);
  assert.equal(metrics.getSnapshot().transition.ready, 0);
});

test('audio intervals retain packet shortages, cadence peaks and duration counters without payload data', async t => {
  const { metrics, advance, create, dataDir } = await fixture(t);
  await metrics.start();
  const first = { windowMs: 5000, readAttempts: 250, packetsRead: 248, emptyReads: 2, starvedReads: 1,
    minBufferedPackets: 0, maxReadGapMs: 145, maxPacketBytes: 1300, opus20Ms: 247, opus40Ms: 1,
    opusMismatch: 1, opusInvalid: 0, voiceStateChanges: 0, voiceWsPingMs: 31, voiceUdpPingMs: null,
    sourceUrl: 'https://private.example/audio', packet: 'private audio payload', userId: 'private-user' };
  metrics.recordAudioHealth(first);
  metrics.recordAudioHealth({ ...first, readAttempts: 250, packetsRead: 250, emptyReads: 0, starvedReads: 0,
    minBufferedPackets: 148, maxReadGapMs: 21, maxPacketBytes: 700, opus20Ms: 250, opus40Ms: 0,
    opusMismatch: 0, voiceWsPingMs: null });
  const before = metrics.getSnapshot().audio;
  assert.equal(before.samples, 2);
  assert.equal(before.totals.readAttempts, 500);
  assert.equal(before.totals.starvedReads, 1);
  assert.equal(before.totals.opusMismatch, 1);
  assert.equal(before.max.maxReadGapMs, 145);
  assert.equal(before.min.minBufferedPackets, 0);
  assert.equal(before.avg.maxReadGapMs, 83);
  assert.equal(before.latest.minBufferedPackets, 148);
  assert.equal(before.latest.voiceWsPingMs, null);
  assert.equal(before.max.voiceUdpPingMs, null);
  assert.equal(before.totals.opus2_5Ms, null, 'Unavailable duration counters are not fabricated as zero.');
  before.latest.maxReadGapMs = 999999;
  assert.equal(metrics.getSnapshot().audio.latest.maxReadGapMs, 21);
  await advance(MINUTE);
  assert.equal(metrics.getSnapshot().audio.latest, null, 'Old voice intervals are not presented as current playback.');
  const stored = await fs.readFile(path.join(dataDir, '.host-metrics.json'), 'utf8');
  assert.doesNotMatch(stored, /private\.example|private audio|private-user/);
  await metrics.close();
  const restarted = create();
  await restarted.start();
  const audio = restarted.getSnapshot().audio;
  assert.equal(audio.latest, null);
  assert.equal(audio.totals.starvedReads, 1);
  assert.equal(audio.max.maxReadGapMs, 145);
  assert.equal(restarted.getSnapshot().history.reduce((sum, point) => sum + (point.audio.totals.packetsRead || 0), 0), 498);
});

test('event loop delay converts nanoseconds, resets each interval and disables exactly once', async t => {
  let enabled = 0, disabled = 0, resets = 0, factories = 0;
  const histogram = { count: 0, max: 0, p99: 0,
    enable() { enabled++; }, disable() { disabled++; },
    percentile(value) { assert.equal(value, 99); return this.p99; },
    reset() { resets++; this.count = 0; this.max = 0; this.p99 = 0; },
  };
  const { metrics, advance } = await fixture(t, { monitorEventLoopDelay(options) {
    factories++; assert.deepEqual(options, { resolution: 20 }); return histogram;
  } });
  await Promise.all([metrics.start(), metrics.start()]);
  assert.equal(factories, 1);
  assert.equal(enabled, 1);
  assert.equal(metrics.getSnapshot().latest.eventLoopMaxMs, null);
  histogram.count = 200; histogram.max = 180_000_000; histogram.p99 = 21_500_000;
  await advance(5000);
  assert.equal(metrics.getSnapshot().latest.eventLoopMaxMs, 180);
  assert.equal(metrics.getSnapshot().latest.eventLoopP99Ms, 21.5);
  histogram.count = 200; histogram.max = 22_000_000; histogram.p99 = 20_100_000;
  await advance(5000);
  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.latest.eventLoopMaxMs, 22);
  assert.equal(snapshot.eventLoop.max.eventLoopMaxMs, 180);
  assert.equal(snapshot.history[0].max.eventLoopMaxMs, 180);
  assert.equal(snapshot.history[0].max.eventLoopP99Ms, 21.5);
  assert.equal(snapshot.eventLoop.avg.eventLoopMaxMs, 101);
  assert.equal(resets, 3);
  await Promise.all([metrics.close(), metrics.close()]);
  assert.equal(disabled, 1);
});

test('older history without audio or loop fields stays intact and malformed additions remain isolated', async t => {
  const { metrics, advance, create, dataDir } = await fixture(t);
  await metrics.start();
  metrics.recordPlayback({ outcome: 'ready', durationMs: 123, preloaded: false });
  await advance(MINUTE);
  await metrics.close();
  const file = path.join(dataDir, '.host-metrics.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const entry of saved.buckets) {
    assert.equal(entry.metrics.length, 20, 'Original version-1 field order is unchanged.');
    delete entry.audio; delete entry.eventLoop;
  }
  await fs.writeFile(file, JSON.stringify(saved));
  const restored = create();
  await restored.start();
  let snapshot = restored.getSnapshot();
  assert.equal(snapshot.playback.ready, 1);
  assert.equal(snapshot.audio.samples, 0);
  assert.equal(snapshot.eventLoop.max.eventLoopMaxMs, null);
  assert.equal(snapshot.persistence.available, true);
  await restored.close();
  for (const entry of saved.buckets) { entry.audio = { samples: Infinity, metrics: [] }; entry.eventLoop = [['private text']]; }
  await fs.writeFile(file, JSON.stringify(saved));
  const repaired = create();
  await repaired.start();
  snapshot = repaired.getSnapshot();
  assert.equal(snapshot.playback.ready, 1);
  assert.equal(snapshot.audio.samples, 0);
  assert.equal(snapshot.eventLoop.max.eventLoopMaxMs, null);
  assert.ok(snapshot.history.some(point => point.max.hostMemoryTotalBytes === 2048 * MIB));
});

test('audio telemetry rejects unbounded values and unavailable loop monitoring does not affect collection', async t => {
  const { metrics, advance } = await fixture(t, { monitorEventLoopDelay() { throw new Error('unsupported'); } });
  await metrics.start();
  metrics.recordAudioHealth({ windowMs: Infinity, packetsRead: 1 });
  assert.equal(metrics.getSnapshot().audio.samples, 0);
  for (let index = 0; index < 800; index++) metrics.recordAudioHealth({ windowMs: 5000,
    packetsRead: 250, emptyReads: -1, starvedReads: 0.5, maxReadGapMs: Infinity, maxPacketBytes: 1e12 });
  const snapshot = metrics.getSnapshot();
  assert.equal(snapshot.audio.samples, 720);
  assert.equal(snapshot.audio.totals.packetsRead, 720 * 250);
  assert.equal(snapshot.audio.totals.emptyReads, null);
  assert.equal(snapshot.audio.totals.starvedReads, null);
  assert.equal(snapshot.audio.max.maxPacketBytes, null);
  assert.equal(snapshot.latest.eventLoopMaxMs, null);
  assert.equal(snapshot.latest.hostMemoryTotalBytes, 2048 * MIB);
  await advance(DAY + MINUTE);
  assert.equal(metrics.getSnapshot().audio.samples, 0);
  await metrics.close();
  metrics.recordAudioHealth({ windowMs: 5000, packetsRead: 1 });
  assert.equal(metrics.getSnapshot().audio.samples, 0);
});
