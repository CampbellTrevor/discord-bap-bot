import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHostMetrics } from '../src/host-metrics.mjs';

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const MIB = 1024 * 1024;

async function fixture(t, { missing = false, failWrites = false } = {}) {
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
    const metrics = createHostMetrics({ dataDir, now: () => clock, fs: io,
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
  assert.equal(before.measurement, 'source-startup');
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
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 1024 * 1024);
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
