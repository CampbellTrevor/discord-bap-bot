import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { monitorEventLoopDelay as nodeMonitorEventLoopDelay, performance } from 'node:perf_hooks';

const MINUTE = 60000;
const RETENTION = 24 * 60 * MINUTE;
const MAX_FILE = 8 * 1024 * 1024;
const LATENCY_BOUNDS = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, 120000, 300000, 3600000];
const FIELDS = [
  'hostCpuBusyPct', 'hostCpuStealPct', 'hostCpuIowaitPct', 'hostCpuCores',
  'hostMemoryTotalBytes', 'hostMemoryAvailableBytes', 'hostSwapTotalBytes', 'hostSwapUsedBytes',
  'containerMemoryBytes', 'containerMemoryLimitBytes', 'containerCpuUsagePct', 'containerCpuLimitCores',
  'containerCpuThrottledPct', 'containerCpuThrottledMs', 'containerOomEvents', 'containerOomKills',
  'containerOomEventsDelta', 'containerOomKillsDelta', 'diskTotalBytes', 'diskFreeBytes',
];
// Kept separate from the original version-1 field order for existing history.
const LOOP_FIELDS = ['eventLoopMaxMs', 'eventLoopP99Ms'];
const AUDIO_COUNTERS = ['readAttempts', 'packetsRead', 'emptyReads', 'starvedReads',
  'opus2_5Ms', 'opus5Ms', 'opus10Ms', 'opus20Ms', 'opus40Ms', 'opus60Ms', 'opus80Ms', 'opus100Ms', 'opus120Ms', 'opusOtherMs',
  'opusInvalid', 'opusMismatch', 'voiceStateChanges'];
const AUDIO_FIELDS = ['windowMs', ...AUDIO_COUNTERS, 'minBufferedPackets', 'maxReadGapMs', 'maxPacketBytes', 'voiceWsPingMs', 'voiceUdpPingMs'];
// Additive section: never extend AUDIO_FIELDS, whose positions are stored on disk.
const NETWORK_COUNTERS = ['udpKeepaliveSent', 'udpKeepaliveReplies', 'udpKeepaliveTimeouts', 'udpAudioPackets', 'udpSendErrors', 'udpKeepaliveUntracked'];
const NETWORK_FIELDS = ['voiceUdpPingMs', 'udpKeepaliveSent', 'udpKeepaliveReplies', 'udpKeepaliveTimeouts',
  'udpKeepalivePending', 'udpRttMaxMs', 'udpRttJitterMs', 'udpAudioPackets', 'udpMaxSendGapMs',
  'udpSendErrors', 'udpSendQueueBytes', 'voiceWsHeartbeatAgeMs', 'udpKeepaliveConfirmed', 'udpKeepaliveUntracked'];
const MAX_AUDIO_SAMPLES = 720;
const MAX_HEALTH_VALUE = 1e9;
const WORK_SLICE_MS = 1;
const WORK_SLICE_ITEMS = 8;
const PLAYBACK_SUM_FIELDS = ['ready', 'error', 'preloadedReady', 'preloadedError', 'readyDurationSumMs'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const round = value => numeric(value) ? Math.round(value * 100) / 100 : null;
const number = text => /^\d+$/.test(text?.trim() ?? '') && count(Number(text.trim())) ? Number(text.trim()) : null;
const delta = (current, previous) => numeric(current) && numeric(previous) && current >= previous ? current - previous : null;
const pairs = text => Object.fromEntries((text ?? '').trim().split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2).map(([key, value]) => [key, number(value)]));
const emptyPlayback = () => ({ ready: 0, error: 0, preloadedReady: 0, preloadedError: 0,
  readyDurationSumMs: 0, readyDurationMaxMs: 0, latencyBins: LATENCY_BOUNDS.map(() => 0), errors: {} });
const emptyPreload = () => ({ ...emptyPlayback(), cancelled: 0, expired: 0 });
const emptyStats = fields => fields.map(() => [0, 0, null, null]);
const emptyAudio = () => ({ samples: 0, metrics: emptyStats(AUDIO_FIELDS) });
const emptyNetwork = () => ({ samples: 0, metrics: emptyStats(NETWORK_FIELDS) });
const emptyBucket = at => ({ at, samples: 0, metrics: FIELDS.map(() => [0, 0, null, null]),
  playback: emptyPlayback(), legacySourceOnly: false, preload: emptyPreload(), transition: emptyPlayback(),
  audio: emptyAudio(), network: emptyNetwork(), eventLoop: emptyStats(LOOP_FIELDS) });

function addStats(target, fields, values) {
  fields.forEach((field, index) => {
    const value = values[field];
    if (!numeric(value)) return;
    const stat = target[index];
    stat[0]++; stat[1] += value;
    stat[2] = stat[2] === null ? value : Math.min(stat[2], value);
    stat[3] = stat[3] === null ? value : Math.max(stat[3], value);
  });
}
function mergeStats(target, source) {
  for (let index = 0; index < source.length; index++) {
    const [n, sum, low, high] = source[index];
    if (!n) continue;
    const stat = target[index];
    stat[0] += n; stat[1] += sum;
    stat[2] = stat[2] === null ? low : Math.min(stat[2], low);
    stat[3] = stat[3] === null ? high : Math.max(stat[3], high);
  }
}
function statsSummary(fields, values) {
  const avg = {}, min = {}, max = {};
  fields.forEach((field, index) => {
    const [n, sum, low, high] = values[index];
    avg[field] = n ? round(sum / n) : null;
    min[field] = low; max[field] = high;
  });
  return { avg, min, max };
}
function audioSummary(value) {
  const totals = {};
  for (const field of AUDIO_COUNTERS) {
    const [n, sum] = value.metrics[AUDIO_FIELDS.indexOf(field)];
    totals[field] = n ? sum : null;
  }
  return { samples: value.samples, ...statsSummary(AUDIO_FIELDS, value.metrics), totals };
}
function networkSummary(value) {
  const totals = {};
  for (const field of NETWORK_COUNTERS) {
    const [n, sum] = value.metrics[NETWORK_FIELDS.indexOf(field)];
    totals[field] = n ? sum : null;
  }
  return { samples: value.samples, ...statsSummary(NETWORK_FIELDS, value.metrics), totals };
}
function validStats(value, fields, samples) {
  return Array.isArray(value) && value.length === fields.length && value.every(stat =>
    Array.isArray(stat) && stat.length === 4 && count(stat[0]) && stat[0] <= samples && numeric(stat[1])
    && stat[1] <= stat[0] * MAX_HEALTH_VALUE && (stat[0] === 0
      ? stat[1] === 0 && stat[2] === null && stat[3] === null
      : numeric(stat[2]) && numeric(stat[3]) && stat[2] <= stat[3] && stat[3] <= MAX_HEALTH_VALUE
        && stat[1] / stat[0] >= stat[2] - 0.01 && stat[1] / stat[0] <= stat[3] + 0.01));
}
function validAudio(value) {
  return value && count(value.samples) && value.samples <= MAX_AUDIO_SAMPLES && validStats(value.metrics, AUDIO_FIELDS, value.samples);
}
function validNetwork(value) {
  return value && count(value.samples) && value.samples <= MAX_AUDIO_SAMPLES
    && validStats(value.metrics, NETWORK_FIELDS, value.samples)
    && NETWORK_COUNTERS.every(field => {
      const [n, sum, low, high] = value.metrics[NETWORK_FIELDS.indexOf(field)];
      return !n || count(sum) && count(low) && count(high);
    })
    && (() => {
      const [n, sum, low, high] = value.metrics[NETWORK_FIELDS.indexOf('udpKeepaliveConfirmed')];
      return !n || count(sum) && count(low) && count(high) && high <= 1;
    })();
}

function recordReady(target, durationMs) {
  const duration = Math.round(durationMs);
  target.readyDurationSumMs += duration;
  target.readyDurationMaxMs = Math.max(target.readyDurationMaxMs, duration);
  target.latencyBins[LATENCY_BOUNDS.findIndex(bound => duration <= bound)]++;
}
const safeCode = code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNKNOWN';

function addError(errors, code, amount) {
  const key = Object.hasOwn(errors, code) || Object.keys(errors).length < 16 ? code : 'OTHER';
  errors[key] = (errors[key] || 0) + amount;
}
function combinePlayback(target, source) {
  for (const field of PLAYBACK_SUM_FIELDS) target[field] += source[field];
  target.readyDurationMaxMs = Math.max(target.readyDurationMaxMs, source.readyDurationMaxMs);
  for (let index = 0; index < target.latencyBins.length; index++) target.latencyBins[index] += source.latencyBins[index];
  for (const [code, amount] of Object.entries(source.errors)) addError(target.errors, code, amount);
}
function playbackSummary(value) {
  const threshold = Math.ceil(value.ready * 0.95);
  let cumulative = 0;
  let p95ReadyMsUpperBound = null;
  for (let i = 0; i < LATENCY_BOUNDS.length && threshold; i++) {
    cumulative += value.latencyBins[i];
    if (cumulative >= threshold) { p95ReadyMsUpperBound = LATENCY_BOUNDS[i]; break; }
  }
  return { ready: value.ready, error: value.error, preloadedReady: value.preloadedReady, preloadedError: value.preloadedError,
    meanReadyMs: value.ready ? round(value.readyDurationSumMs / value.ready) : null,
    maxReadyMs: value.ready ? value.readyDurationMaxMs : null, p95ReadyMsUpperBound,
    errors: Object.entries(value.errors).map(([code, total]) => ({ code, count: total })).sort((a, b) => b.count - a.count) };
}
function preloadSummary(value) {
  const { ready, error, meanReadyMs, maxReadyMs, p95ReadyMsUpperBound, errors } = playbackSummary(value);
  return { ready, error, cancelled: value.cancelled, expired: value.expired, meanReadyMs, maxReadyMs, p95ReadyMsUpperBound, errors };
}
function transitionSummary(value) {
  const { ready, preloadedReady, meanReadyMs, maxReadyMs, p95ReadyMsUpperBound } = playbackSummary(value);
  return { ready, preloadedReady, meanReadyMs, maxReadyMs, p95ReadyMsUpperBound };
}
function bucketView(bucket) {
  const avg = {}, min = {}, max = {};
  FIELDS.forEach((field, i) => {
    const [n, sum, low, high] = bucket.metrics[i];
    avg[field] = n ? round(sum / n) : null;
    min[field] = low;
    max[field] = high;
  });
  const loop = statsSummary(LOOP_FIELDS, bucket.eventLoop);
  Object.assign(avg, loop.avg); Object.assign(min, loop.min); Object.assign(max, loop.max);
  return { at: bucket.at, samples: bucket.samples, avg, min, max,
    playback: { ...playbackSummary(bucket.playback), legacySourceOnly: bucket.legacySourceOnly },
    preload: preloadSummary(bucket.preload), transition: transitionSummary(bucket.transition), audio: audioSummary(bucket.audio),
    network: networkSummary(bucket.network) };
}
function validPlayback(p) {
  if (!p || ['ready', 'error', 'preloadedReady', 'preloadedError', 'readyDurationSumMs', 'readyDurationMaxMs'].some(key => !count(p[key]))
      || p.ready + p.error > 1000 || p.preloadedReady > p.ready || p.preloadedError > p.error
      || p.readyDurationMaxMs > 3600000 || p.readyDurationSumMs > p.ready * 3600000
      || !Array.isArray(p.latencyBins) || p.latencyBins.length !== LATENCY_BOUNDS.length
      || p.latencyBins.some(value => !count(value)) || p.latencyBins.reduce((sum, value) => sum + value, 0) !== p.ready
      || !p.errors || typeof p.errors !== 'object' || Array.isArray(p.errors) || Object.keys(p.errors).length > 17
      || Object.entries(p.errors).some(([code, amount]) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(code) || !count(amount) || amount > p.error)) return false;
  return true;
}
function validPreload(value) {
  return validPlayback(value) && count(value.cancelled) && count(value.expired)
    && value.ready + value.error + value.cancelled + value.expired <= 1000
    && value.preloadedReady === 0 && value.preloadedError === 0;
}
function validTransition(value) {
  return validPlayback(value) && value.error === 0 && value.preloadedError === 0 && Object.keys(value.errors).length === 0;
}
function validBucket(bucket, now) {
  if (!bucket || !count(bucket.at) || bucket.at % MINUTE || bucket.at < now - RETENTION || bucket.at > now
      || !count(bucket.samples) || bucket.samples > 120 || !Array.isArray(bucket.metrics) || bucket.metrics.length !== FIELDS.length) return false;
  if (bucket.metrics.some(stat => !Array.isArray(stat) || stat.length !== 4 || !count(stat[0]) || stat[0] > bucket.samples
      || !numeric(stat[1]) || stat[1] > 1e20 || (stat[0] === 0 ? stat[1] !== 0 || stat[2] !== null || stat[3] !== null
        : !numeric(stat[2]) || !numeric(stat[3]) || stat[2] > stat[3]))) return false;
  return validPlayback(bucket.playback);
}

/** Records source/packet preparation and transport transitions, not audible voice gaps. */
export function createHostMetrics({ dataDir, sampleIntervalMs = 5000, now = Date.now, fs = nodeFs, os = nodeOs,
  monitorEventLoopDelay = nodeMonitorEventLoopDelay,
  yieldWork = () => new Promise(resolve => setImmediate(resolve)),
  setInterval: schedule = globalThis.setInterval, clearInterval: unschedule = globalThis.clearInterval } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || !Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 1000 || sampleIntervalMs > MINUTE) {
    throw new Error('Host metrics require a data directory and a sample interval between 1 and 60 seconds.');
  }
  const file = path.join(dataDir, '.host-metrics.json');
  const buckets = new Map();
  const capturedBuckets = new WeakSet(), encodedBuckets = new WeakMap();
  let latest = null, previous = null, timer, starting, sampling, closed = false;
  let lastAudio = null, lastNetwork = null, loopMonitor;
  let persistent = null, lastSavedAt = null, lastWriteAttempt = -Infinity;
  const read = async location => { try { const text = await fs.readFile(location, 'utf8'); return text.length <= 128 * 1024 ? text : null; } catch { return null; } };
  const prune = at => { for (const timestamp of buckets.keys()) if (timestamp < at - RETENTION || timestamp > at) buckets.delete(timestamp); };
  function captureBuckets(at) {
    prune(at);
    const captured = [...buckets.values()];
    // Capture references in one turn. A later record copies only its small minute
    // bucket, so yielding readers see one consistent point in time without a
    // synchronous clone of the entire day's history.
    for (const entry of captured) capturedBuckets.add(entry);
    return captured;
  }
  function checkpoint() {
    let items = 0, started = performance.now();
    return () => {
      if (++items < WORK_SLICE_ITEMS && performance.now() - started < WORK_SLICE_MS) return null;
      return Promise.resolve(yieldWork()).then(() => { items = 0; started = performance.now(); });
    };
  }
  function bucket(at) {
    prune(at);
    const timestamp = Math.floor(at / MINUTE) * MINUTE;
    if (!buckets.has(timestamp)) buckets.set(timestamp, emptyBucket(timestamp));
    else if (capturedBuckets.has(buckets.get(timestamp))) buckets.set(timestamp, structuredClone(buckets.get(timestamp)));
    return buckets.get(timestamp);
  }
  async function load() {
    try {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = await fs.open(file, 'r');
        const { size } = await handle.stat();
        if (size > MAX_FILE) throw new Error();
        const buffer = Buffer.alloc(size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > size) throw new Error();
        const data = JSON.parse(buffer.subarray(0, length).toString('utf8'));
        if (data?.version !== 1 || !Array.isArray(data.buckets) || data.buckets.length > 1441) throw new Error();
        const current = now();
        for (const entry of data.buckets) {
          if (entry?.at < current - RETENTION) continue;
          if (!validBucket(entry, current) || buckets.has(entry.at)) throw new Error();
          // Copy only the schema we own; arbitrary strings from disk never enter snapshots.
          const clean = emptyBucket(entry.at);
          clean.samples = entry.samples;
          clean.metrics = entry.metrics.map(stat => [...stat]);
          for (const key of Object.keys(clean.playback)) clean.playback[key] = entry.playback[key];
          // Version 1 history predates these additive fields. Keep its readings
          // and source-only timing rather than dropping the existing history.
          clean.legacySourceOnly = entry.legacySourceOnly === true ||
            (!Object.hasOwn(entry, 'legacySourceOnly') && entry.playback.ready + entry.playback.error > 0);
          for (const [key, validate] of [['preload', validPreload], ['transition', validTransition]]) {
            if (validate(entry[key])) for (const field of Object.keys(clean[key])) clean[key][field] = entry[key][field];
          }
          if (validAudio(entry.audio)) clean.audio = { samples: entry.audio.samples, metrics: entry.audio.metrics.map(stat => [...stat]) };
          if (validNetwork(entry.network)) clean.network = { samples: entry.network.samples, metrics: entry.network.metrics.map(stat => [...stat]) };
          if (validStats(entry.eventLoop, LOOP_FIELDS, entry.samples)) clean.eventLoop = entry.eventLoop.map(stat => [...stat]);
          buckets.set(entry.at, clean);
        }
        if (count(data.savedAt) && data.savedAt <= current) { lastSavedAt = data.savedAt; lastWriteAttempt = data.savedAt; }
      } finally { await handle?.close(); }
      persistent = true;
    } catch (error) {
      if (error.code === 'ENOENT') persistent = true;
      else { buckets.clear(); persistent = false; }
    }
  }
  async function persist(at) {
    if (at - lastWriteAttempt < MINUTE) return;
    lastWriteAttempt = at;
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const captured = captureBuckets(at);
      // writeFile consumes this async iterable incrementally. Neither JSON
      // encoding nor UTF-8 conversion ever receives the whole history at once.
      async function* body() {
        const pause = checkpoint();
        let bytes = 0, parts = [], items = 0;
        const append = text => {
          bytes += Buffer.byteLength(text);
          if (bytes > MAX_FILE) throw new Error('Metrics history exceeds its storage budget.');
          parts.push(text);
        };
        append(`{"version":1,"savedAt":${JSON.stringify(at)},"buckets":[`);
        for (const entry of captured) {
          let text = encodedBuckets.get(entry);
          if (text === undefined) { text = JSON.stringify(entry); encodedBuckets.set(entry, text); }
          append(`${items++ ? ',' : ''}${text}`);
          const waiting = pause();
          if (waiting) {
            yield parts.join('');
            parts = [];
            await waiting;
          }
        }
        append(']}');
        if (parts.length) yield parts.join('');
      }
      await fs.writeFile(temporary, body(), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
      persistent = true;
      lastSavedAt = at;
    } catch { persistent = false; }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function collect(at) {
    const [stat, meminfo, cpuStat, memoryCurrent, memoryMax, memoryEvents, cpuMax, disk] = await Promise.all([
      read('/proc/stat'), read('/proc/meminfo'), read('/sys/fs/cgroup/cpu.stat'), read('/sys/fs/cgroup/memory.current'),
      read('/sys/fs/cgroup/memory.max'), read('/sys/fs/cgroup/memory.events'), read('/sys/fs/cgroup/cpu.max'),
      Promise.resolve().then(() => fs.statfs(dataDir)).catch(() => null),
    ]);
    const result = Object.fromEntries(FIELDS.map(field => [field, null]));
    const sources = { cpu: 'unavailable', memory: 'unavailable', cgroup: 'unavailable', disk: 'unavailable' };
    let cpu = stat?.match(/^cpu\s+([\d\s]+)$/m)?.[1].trim().split(/\s+/).slice(0, 8).map(number);
    if (cpu?.length === 8 && cpu.every(count)) {
      sources.cpu = 'proc';
      result.hostCpuCores = (stat.match(/^cpu\d+\s/gm) || []).length || null;
    } else {
      cpu = null;
      try {
        const cores = os.cpus();
        if (cores.length) {
          cpu = [0, 0, 0, 0, 0, 0, 0, 0];
          for (const core of cores) [core.times.user, core.times.nice, core.times.sys, core.times.idle, 0, core.times.irq, 0, 0].forEach((time, i) => { cpu[i] += time; });
          if (!cpu.every(count)) cpu = null;
          else { sources.cpu = 'os'; result.hostCpuCores = cores.length; }
        }
      } catch { /* Leave unavailable counters null. */ }
    }
    if (cpu && previous?.cpu && previous.cpuSource === sources.cpu) {
      const changes = cpu.map((value, i) => delta(value, previous.cpu[i]));
      const total = changes.every(numeric) ? changes.reduce((sum, value) => sum + value, 0) : 0;
      if (total > 0) {
        result.hostCpuBusyPct = round((total - changes[3] - changes[4] - changes[7]) / total * 100);
        if (sources.cpu === 'proc') {
          result.hostCpuIowaitPct = round(changes[4] / total * 100);
          result.hostCpuStealPct = round(changes[7] / total * 100);
        }
      }
    }
    const memory = Object.fromEntries([...meminfo?.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$/gm) || []].map(match => {
      const value = number(match[2]);
      return [match[1], value !== null && count(value * 1024) ? value * 1024 : null];
    }));
    if (numeric(memory.MemTotal) && memory.MemTotal > 0) {
      sources.memory = 'proc';
      result.hostMemoryTotalBytes = memory.MemTotal;
      result.hostMemoryAvailableBytes = numeric(memory.MemAvailable) ? Math.min(memory.MemTotal, memory.MemAvailable) : null;
      result.hostSwapTotalBytes = numeric(memory.SwapTotal) ? memory.SwapTotal : null;
      result.hostSwapUsedBytes = numeric(memory.SwapTotal) && numeric(memory.SwapFree) ? Math.max(0, memory.SwapTotal - memory.SwapFree) : null;
    } else {
      try {
        result.hostMemoryTotalBytes = numeric(os.totalmem()) ? os.totalmem() : null;
        // On non-Linux hosts this is free RAM, which is not Linux MemAvailable.
        result.hostMemoryAvailableBytes = numeric(os.freemem()) ? os.freemem() : null;
        sources.memory = 'os';
      } catch { /* Keep partial or unavailable fallback readings. */ }
    }
    const cg = pairs(cpuStat), events = pairs(memoryEvents);
    result.containerMemoryBytes = number(memoryCurrent);
    result.containerMemoryLimitBytes = number(memoryMax);
    result.containerOomEvents = events.oom ?? null;
    result.containerOomKills = events.oom_kill ?? null;
    const quota = cpuMax?.trim().split(/\s+/);
    if (quota?.length === 2 && number(quota[0]) !== null && number(quota[1]) > 0) result.containerCpuLimitCores = round(number(quota[0]) / number(quota[1]));
    if (Object.values(cg).some(numeric) || result.containerMemoryBytes !== null) sources.cgroup = 'v2';
    const elapsed = previous ? at - previous.at : 0;
    if (elapsed > 0) {
      const usage = delta(cg.usage_usec, previous.cg.usage_usec);
      const periods = delta(cg.nr_periods, previous.cg.nr_periods);
      const throttled = delta(cg.nr_throttled, previous.cg.nr_throttled);
      const throttledTime = delta(cg.throttled_usec, previous.cg.throttled_usec);
      result.containerCpuUsagePct = usage === null ? null : round(usage / (elapsed * 1000) * 100);
      result.containerCpuThrottledPct = periods > 0 && throttled !== null ? round(Math.min(1, throttled / periods) * 100) : periods === 0 && throttled === 0 ? 0 : null;
      result.containerCpuThrottledMs = throttledTime === null ? null : round(throttledTime / 1000);
      result.containerOomEventsDelta = delta(events.oom, previous.events.oom);
      result.containerOomKillsDelta = delta(events.oom_kill, previous.events.oom_kill);
    }
    if (disk && numeric(Number(disk.bsize)) && numeric(Number(disk.blocks)) && numeric(Number(disk.bavail))) {
      result.diskTotalBytes = Number(disk.bsize) * Number(disk.blocks);
      result.diskFreeBytes = Number(disk.bsize) * Number(disk.bavail);
      sources.disk = 'statfs';
    }
    previous = { at, cpu, cpuSource: sources.cpu, cg, events };
    result.eventLoopMaxMs = null;
    result.eventLoopP99Ms = null;
    try {
      if (loopMonitor?.count > 0) {
        const maximum = loopMonitor.max / 1e6;
        const percentile = loopMonitor.percentile(99) / 1e6;
        result.eventLoopMaxMs = numeric(maximum) && maximum <= MAX_HEALTH_VALUE ? round(maximum) : null;
        result.eventLoopP99Ms = numeric(percentile) && percentile <= MAX_HEALTH_VALUE ? round(percentile) : null;
      }
      loopMonitor?.reset();
    } catch { /* A missing histogram must not interrupt host/audio metrics. */ }
    return { at, intervalMs: elapsed > 0 ? elapsed : null, sources, ...result };
  }
  function sample() {
    if (closed || sampling) return sampling;
    sampling = (async () => {
      const at = now();
      latest = await collect(at);
      const target = bucket(at);
      if (target.samples < 120) {
        target.samples++;
        addStats(target.eventLoop, LOOP_FIELDS, latest);
        FIELDS.forEach((field, i) => {
          const value = latest[field];
          if (!numeric(value)) return;
          const stat = target.metrics[i];
          stat[0]++; stat[1] += value;
          stat[2] = stat[2] === null ? value : Math.min(stat[2], value);
          stat[3] = stat[3] === null ? value : Math.max(stat[3], value);
        });
      }
      await persist(at);
    })().catch(() => { /* Telemetry failures must not interrupt playback. */ }).finally(() => { sampling = undefined; });
    return sampling;
  }
  return {
    start() {
      if (closed) return Promise.resolve();
      if (!starting) starting = (async () => {
        await load();
        if (closed) return;
        try { loopMonitor = monitorEventLoopDelay?.({ resolution: 20 }); loopMonitor?.enable(); }
        catch { try { loopMonitor?.disable(); } catch {} loopMonitor = undefined; }
        await sample();
        if (!closed) { timer = schedule(sample, sampleIntervalMs); timer?.unref?.(); }
      })();
      return starting;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== undefined) unschedule(timer);
      await starting;
      await sampling;
      try { loopMonitor?.disable(); } catch {}
      loopMonitor = undefined;
      // Respect the same once-per-minute write limit even during shutdown.
      await persist(now());
    },
    recordPlayback({ outcome, durationMs, preloaded, code } = {}) {
      if (closed || !['ready', 'error'].includes(outcome) || !numeric(durationMs) || durationMs > 3600000 || typeof preloaded !== 'boolean') return;
      const target = bucket(now()).playback;
      if (target.ready + target.error >= 1000) return;
      target[outcome]++;
      if (preloaded) target[outcome === 'ready' ? 'preloadedReady' : 'preloadedError']++;
      if (outcome === 'ready') recordReady(target, durationMs);
      else addError(target.errors, safeCode(code), 1);
    },
    recordPreload({ outcome, durationMs, code } = {}) {
      if (closed || !['ready', 'error', 'cancelled', 'expired'].includes(outcome) || !numeric(durationMs) || durationMs > 3600000) return;
      const target = bucket(now()).preload;
      if (target.ready + target.error + target.cancelled + target.expired >= 1000) return;
      // These count lifecycle events: a ready preload may later expire/cancel.
      target[outcome]++;
      if (outcome === 'ready') recordReady(target, durationMs);
      else if (outcome === 'error') addError(target.errors, safeCode(code), 1);
    },
    recordTransition({ outcome, durationMs, preloaded } = {}) {
      if (closed || outcome !== 'ready' || !numeric(durationMs) || durationMs > 3600000 || typeof preloaded !== 'boolean') return;
      const target = bucket(now()).transition;
      if (target.ready >= 1000) return;
      target.ready++;
      if (preloaded) target.preloadedReady++;
      recordReady(target, durationMs);
    },
    recordAudioHealth(value = {}) {
      if (closed || !numeric(value?.windowMs) || value.windowMs > MAX_HEALTH_VALUE) return;
      const at = now();
      const current = bucket(at);
      const target = current.audio;
      if (target.samples >= MAX_AUDIO_SAMPLES) return;
      const clean = {};
      for (const field of AUDIO_FIELDS) {
        const item = value[field];
        clean[field] = numeric(item) && item <= MAX_HEALTH_VALUE && (!AUDIO_COUNTERS.includes(field) || count(item)) ? item : null;
      }
      target.samples++;
      addStats(target.metrics, AUDIO_FIELDS, clean);
      lastAudio = { at, ...clean };
      if (current.network.samples < MAX_AUDIO_SAMPLES) {
        const network = {};
        for (const field of NETWORK_FIELDS) {
          const item = value[field];
          network[field] = numeric(item) && item <= MAX_HEALTH_VALUE
            && (!NETWORK_COUNTERS.includes(field) || count(item))
            && (field !== 'udpKeepaliveConfirmed' || item === 0 || item === 1) ? item : null;
        }
        current.network.samples++;
        addStats(current.network.metrics, NETWORK_FIELDS, network);
        lastNetwork = { at, ...network };
      }
    },
    async getSnapshot() {
      const at = now();
      const captured = captureBuckets(at);
      const capturedLatest = latest, capturedAudio = lastAudio, capturedNetwork = lastNetwork;
      const capturedPersistence = { available: persistent, lastSavedAt };
      const pause = checkpoint();
      const grouped = new Map(), playback = emptyPlayback(), preload = emptyPreload(), transition = emptyPlayback();
      const audio = emptyAudio(), network = emptyNetwork(), eventLoop = emptyStats(LOOP_FIELDS);
      let legacySourceOnly = false;
      for (const source of captured) {
        const timestamp = Math.floor(source.at / (5 * MINUTE)) * 5 * MINUTE;
        if (!grouped.has(timestamp)) grouped.set(timestamp, emptyBucket(timestamp));
        const target = grouped.get(timestamp);
        target.samples += source.samples;
        source.metrics.forEach(([n, sum, low, high], i) => {
          if (!n) return;
          const stat = target.metrics[i];
          stat[0] += n; stat[1] += sum;
          stat[2] = stat[2] === null ? low : Math.min(stat[2], low);
          stat[3] = stat[3] === null ? high : Math.max(stat[3], high);
        });
        combinePlayback(target.playback, source.playback);
        combinePlayback(playback, source.playback);
        target.legacySourceOnly ||= source.legacySourceOnly;
        legacySourceOnly ||= source.legacySourceOnly;
        for (const destination of [target.preload, preload]) {
          combinePlayback(destination, source.preload);
          destination.cancelled += source.preload.cancelled;
          destination.expired += source.preload.expired;
        }
        combinePlayback(target.transition, source.transition);
        combinePlayback(transition, source.transition);
        for (const destination of [target.audio, audio]) {
          destination.samples += source.audio.samples;
          mergeStats(destination.metrics, source.audio.metrics);
        }
        for (const destination of [target.network, network]) {
          destination.samples += source.network.samples;
          mergeStats(destination.metrics, source.network.metrics);
        }
        mergeStats(target.eventLoop, source.eventLoop);
        mergeStats(eventLoop, source.eventLoop);
        const waiting = pause();
        if (waiting) await waiting;
      }
      const history = [];
      for (const entry of [...grouped.values()].sort((a, b) => a.at - b.at).slice(-288)) {
        history.push(bucketView(entry));
        const waiting = pause();
        if (waiting) await waiting;
      }
      return { version: 1, sampledAt: at, sampleIntervalMs, historyIntervalMs: 5 * MINUTE, retentionMs: RETENTION,
        latest: capturedLatest && structuredClone(capturedLatest), history,
        playback: { measurement: 'source-and-packet-preparation', legacySourceOnly, ...playbackSummary(playback) },
        preload: { measurement: 'background-source-and-packet-preparation', ...preloadSummary(preload) },
        transition: { measurement: 'natural-end-to-transport-playing', ...transitionSummary(transition) },
        audio: { measurement: 'transport-packet-reads', latest: capturedAudio && at >= capturedAudio.at && at - capturedAudio.at <= 15000 ? structuredClone(capturedAudio) : null,
          ...audioSummary(audio) },
        // These describe keepalive exchanges and local socket sends, not delivered audio or listener loss.
        network: { measurement: 'voice-udp-keepalive-and-local-send',
          latest: capturedNetwork && at >= capturedNetwork.at && at - capturedNetwork.at <= 15000 ? structuredClone(capturedNetwork) : null,
          ...networkSummary(network) },
        eventLoop: { resolutionMs: 20, ...statsSummary(LOOP_FIELDS, eventLoop) },
        persistence: capturedPersistence };
    },
  };
}
