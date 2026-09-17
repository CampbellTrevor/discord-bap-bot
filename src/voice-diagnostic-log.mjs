const COUNTERS = ['readAttempts', 'packetsRead', 'emptyReads', 'starvedReads', 'opusInvalid',
  'opusMismatch', 'voiceStateChanges', 'udpKeepaliveSent', 'udpKeepaliveReplies',
  'udpKeepaliveTimeouts', 'udpKeepaliveUntracked', 'udpAudioPackets', 'udpSendErrors'];
const MAXIMA = ['maxReadGapMs', 'maxPacketBytes', 'udpRttMaxMs', 'udpRttJitterMs',
  'udpKeepalivePending', 'udpMaxSendGapMs', 'udpSendQueueBytes', 'voiceWsHeartbeatAgeMs'];
const AVERAGES = ['voiceWsPingMs', 'voiceUdpPingMs'];
const STATES = new Set(['signalling', 'connecting', 'ready', 'disconnected', 'destroyed', 'unknown']);
const EVENT_KINDS = new Set(['connection-state', 'network-state', 'websocket-close',
  'udp-error', 'websocket-error', 'udp-close', 'observer-unavailable']);
const ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'EADDRNOTAVAIL', 'EADDRINUSE', 'ENOBUFS',
  'EMSGSIZE', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_SOCKET_DGRAM_NOT_RUNNING',
  'ERR_SOCKET_DGRAM_NOT_CONNECTED', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED', 'UNKNOWN']);
const OBSERVER_REASONS = new Set(['unsupported-layout', 'attach-failed', 'sample-failed', 'unavailable']);
const MAX_EVENTS = 12;
const LIMIT = Number.MAX_SAFE_INTEGER;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= LIMIT ? value : null;
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : null;
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value) ? value : null;
const sum = (left, right) => Math.min(LIMIT, left + right);
const empty = () => ({ samples: 0, windowMs: 0, suppressedEvents: 0,
  counters: Object.fromEntries(COUNTERS.map(key => [key, null])),
  maxima: Object.fromEntries(MAXIMA.map(key => [key, null])),
  averages: Object.fromEntries(AVERAGES.map(key => [key, { sum: 0, count: 0, max: null }])),
  minBufferedPackets: null, udpKeepaliveConfirmed: null });

/** Bounded, scalar-only diagnostics. Neither audio nor authentication data enters the log. */
export function createVoiceDiagnosticLog({ logger = console, guildId, channelId, now = Date.now,
  summaryIntervalMs = 30000 } = {}) {
  const interval = integer(summaryIntervalMs, 1000, 3600000) ?? 30000;
  const identity = { guildId: snowflake(guildId), channelId: snowflake(channelId) };
  let lastAt = Date.now(), startedAt, events = 0, closed = false, lastWarningAt = null, bucket = empty();
  function time() {
    try {
      const value = now();
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8640000000000000) {
        lastAt = value;
      }
    } catch {}
    return lastAt;
  }
  startedAt = time();
  function write(record, warning = false) {
    try {
      const method = warning && typeof logger?.warn === 'function' ? 'warn' : 'info';
      logger?.[method]?.('Voice diagnostics.', JSON.stringify(record));
    } catch {}
  }
  function base(type, at) {
    return { timestamp: new Date(at).toISOString(), ...identity, type };
  }
  function flush(at) {
    if (!bucket.samples && !bucket.suppressedEvents) {
      startedAt = at; events = 0;
      return;
    }
    const record = { ...base('summary', at), samples: bucket.samples, windowMs: bucket.windowMs,
      ...bucket.counters, ...bucket.maxima, minBufferedPackets: bucket.minBufferedPackets,
      udpKeepaliveConfirmed: bucket.udpKeepaliveConfirmed, suppressedEvents: bucket.suppressedEvents };
    for (const key of AVERAGES) {
      const stats = bucket.averages[key];
      record[key] = stats.count ? Math.round(stats.sum / stats.count * 100) / 100 : null;
      record[key.replace(/Ms$/, 'MaxMs')] = stats.max;
    }
    const anomalies = [];
    if (record.starvedReads > 0) anomalies.push('audio-starvation');
    if (record.opusInvalid > 0 || record.opusMismatch > 0) anomalies.push('opus-framing');
    if (record.maxReadGapMs > 150) anomalies.push('audio-read-gap');
    if (record.voiceWsPingMaxMs > 500) anomalies.push('voice-websocket-latency');
    if (record.voiceUdpPingMaxMs > 250 || record.udpRttMaxMs > 250) anomalies.push('udp-echo-latency');
    if (record.udpKeepaliveTimeouts > 0) anomalies.push('udp-echo-timeout');
    if (record.udpSendErrors > 0) anomalies.push('udp-send-error');
    if (record.udpMaxSendGapMs > 150) anomalies.push('udp-send-gap');
    record.anomalies = anomalies;
    const warning = anomalies.length > 0 && (lastWarningAt === null || at - lastWarningAt >= interval);
    if (warning) lastWarningAt = at;
    bucket = empty(); startedAt = at; events = 0;
    write(record, warning);
  }
  return {
    sample(metric) {
      if (closed) return;
      try {
        if (!metric || typeof metric !== 'object') return;
        const at = time();
        bucket.samples = sum(bucket.samples, 1);
        bucket.windowMs = sum(bucket.windowMs, number(metric.windowMs) ?? 0);
        for (const key of COUNTERS) {
          const value = number(metric[key]);
          if (value !== null) bucket.counters[key] = sum(bucket.counters[key] ?? 0, value);
        }
        for (const key of MAXIMA) {
          const value = number(metric[key]);
          if (value !== null) bucket.maxima[key] = Math.max(bucket.maxima[key] ?? value, value);
        }
        const buffered = number(metric.minBufferedPackets);
        if (buffered !== null) bucket.minBufferedPackets = Math.min(bucket.minBufferedPackets ?? buffered, buffered);
        for (const key of AVERAGES) {
          const value = number(metric[key]);
          if (value !== null) {
            const stats = bucket.averages[key];
            stats.sum = sum(stats.sum, value); stats.count = sum(stats.count, 1);
            stats.max = Math.max(stats.max ?? value, value);
          }
        }
        const confirmed = integer(metric.udpKeepaliveConfirmed, 0, 1);
        if (confirmed !== null) bucket.udpKeepaliveConfirmed = Math.min(bucket.udpKeepaliveConfirmed ?? confirmed, confirmed);
        if (at - startedAt >= interval) flush(at);
      } catch {}
    },
    event(event) {
      if (closed) return;
      try {
        if (!event || typeof event !== 'object') return;
        const kind = event.kind;
        if (!EVENT_KINDS.has(kind)) return;
        const at = time();
        if (at - startedAt >= interval) flush(at);
        if (events >= MAX_EVENTS) { bucket.suppressedEvents = sum(bucket.suppressedEvents, 1); return; }
        const record = base(kind, at);
        if (kind === 'connection-state') {
          const previous = event.previous, status = event.status;
          record.previous = STATES.has(previous) ? previous : 'unknown';
          record.status = STATES.has(status) ? status : 'unknown';
          record.reason = integer(event.reason, 0, 4);
          record.closeCode = integer(event.closeCode, 1000, 4999);
        } else if (kind === 'network-state') {
          record.previous = integer(event.previous, 0, 6);
          record.status = integer(event.status, 0, 6);
        } else if (kind === 'websocket-close') {
          record.closeCode = integer(event.closeCode, 1000, 4999);
        } else if (kind === 'udp-error' || kind === 'websocket-error') {
          const errorCode = event.errorCode;
          record.errorCode = ERROR_CODES.has(errorCode) ? errorCode : 'UNKNOWN';
        } else if (kind === 'observer-unavailable') {
          const reason = event.reason;
          record.reason = OBSERVER_REASONS.has(reason) ? reason : 'unavailable';
        }
        events++;
        write(record, kind.endsWith('-error') || kind === 'observer-unavailable' || record.status === 'disconnected');
      } catch {}
    },
    close() {
      if (closed) return;
      closed = true;
      try { flush(time()); } catch {}
    },
  };
}
