const DURATIONS = new Map([[2.5, 'opus2_5Ms'], [5, 'opus5Ms'], [10, 'opus10Ms'], [20, 'opus20Ms'],
  [40, 'opus40Ms'], [60, 'opus60Ms'], [80, 'opus80Ms'], [100, 'opus100Ms'], [120, 'opus120Ms']]);

/** Inspect packet framing, without decoding or retaining the audio payload. */
export function opusPacketDurationMs(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 1 || packet.length > 8192) return null;
  const config = packet[0] >>> 3;
  const frameMs = config >= 16 ? 2.5 * 2 ** (config & 3) : config >= 12 ? 10 * 2 ** (config & 1) : [10, 20, 40, 60][config & 3];
  const code = packet[0] & 3;
  // RFC 6716 sections 3.1-3.2. The normal single-frame path allocates nothing.
  if (code === 0) return packet.length - 1 <= 1275 ? frameMs : null;
  if (code === 1) return (packet.length - 1) % 2 === 0 && (packet.length - 1) / 2 <= 1275 ? frameMs * 2 : null;
  let offset = 1, end = packet.length;
  const length = () => {
    if (offset >= end) return -1;
    const first = packet[offset++];
    return first < 252 ? first : offset < end ? first + 4 * packet[offset++] : -1;
  };
  if (code === 2) {
    const first = length();
    const second = end - offset - first;
    return first >= 0 && second >= 0 && second <= 1275 ? frameMs * 2 : null;
  }
  if (offset >= end) return null;
  const flags = packet[offset++], count = flags & 63;
  const duration = frameMs * count;
  if (!count || count > 48 || duration > 120) return null;
  if (flags & 64) {
    let padding = 0, value;
    do {
      if (offset >= end) return null;
      value = packet[offset++];
      padding += value === 255 ? 254 : value;
    } while (value === 255);
    end -= padding;
    if (end < offset) return null;
  }
  if (flags & 128) {
    let total = 0;
    for (let index = 0; index < count - 1; index++) {
      const size = length();
      if (size < 0) return null;
      total += size;
    }
    const finalSize = end - offset - total;
    return finalSize >= 0 && finalSize <= 1275 ? duration : null;
  }
  return (end - offset) % count === 0 && (end - offset) / count <= 1275 ? duration : null;
}

const empty = () => ({ readAttempts: 0, packetsRead: 0, emptyReads: 0, starvedReads: 0,
  minBufferedPackets: null, maxReadGapMs: 0, maxPacketBytes: 0,
  ...Object.fromEntries([...DURATIONS.values(), 'opusOtherMs', 'opusInvalid', 'opusMismatch'].map(key => [key, 0])),
  voiceStateChanges: 0 });

/** Numeric interval diagnostics only; observing playback never changes its output. */
export function createAudioHealth({ onMetric, getVoiceWsPing = () => null, sampleIntervalMs = 5000,
  now = () => performance.now(), setInterval: interval = globalThis.setInterval,
  clearInterval: cancelInterval = globalThis.clearInterval } = {}) {
  let counters = empty(), intervalStarted = now(), previousReadAt = null, status = 'idle';
  let activeResource, restoreRead = () => {}, closed = false;
  function observe(packet, buffered, at, resource) {
    counters.readAttempts++;
    if (Number.isFinite(buffered) && buffered >= 0) counters.minBufferedPackets = Math.min(counters.minBufferedPackets ?? buffered, buffered);
    if (previousReadAt !== null) counters.maxReadGapMs = Math.max(counters.maxReadGapMs, Math.max(0, at - previousReadAt));
    previousReadAt = at;
    if (!packet) {
      counters.emptyReads++;
      const stream = resource.playStream;
      if (!resource.ended && !stream.readableEnded && !stream.destroyed && !(stream.writableFinished && stream.readableLength === 0)) counters.starvedReads++;
      return;
    }
    counters.packetsRead++;
    if (Buffer.isBuffer(packet)) counters.maxPacketBytes = Math.max(counters.maxPacketBytes, packet.length);
    const duration = opusPacketDurationMs(packet);
    if (duration === null) counters.opusInvalid++;
    else {
      counters[DURATIONS.get(duration) ?? 'opusOtherMs']++;
      if (duration !== 20) counters.opusMismatch++;
    }
  }
  function flush() {
    if (closed) return;
    const at = now();
    let ping = null;
    try { const value = getVoiceWsPing(); if (typeof value === 'number' && Number.isFinite(value) && value >= 0) ping = value; } catch {}
    const metric = { windowMs: Math.max(0, at - intervalStarted), ...counters,
      voiceWsPingMs: ping, voiceUdpPingMs: null };
    counters = empty();
    intervalStarted = at;
    try { onMetric?.(metric); } catch {}
  }
  const timer = interval(flush, sampleIntervalMs);
  timer?.unref?.();
  return {
    observeResource(resource) {
      if (closed || resource === activeResource) return;
      restoreRead();
      activeResource = resource;
      previousReadAt = null;
      const original = resource.read;
      const wrapped = function(...args) {
        let at, buffered;
        const watching = !closed && activeResource === resource && status === 'playing';
        if (watching) { try { at = now(); buffered = resource.playStream.readableLength; } catch {} }
        const packet = original.apply(this, args);
        if (watching && at !== undefined) { try { observe(packet, buffered, at, resource); } catch {} }
        return packet;
      };
      resource.read = wrapped;
      restoreRead = () => { if (resource.read === wrapped) resource.read = original; };
    },
    playerState(next) {
      if (next !== status) previousReadAt = null;
      status = next;
    },
    voiceStateChanged(previous, next) { if (!closed && previous !== next) counters.voiceStateChanges++; },
    flush,
    close() {
      if (closed) return;
      flush();
      closed = true;
      cancelInterval(timer);
      restoreRead();
      activeResource = null;
    },
  };
}
