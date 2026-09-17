const CONNECTION_STATES = new Set(['signalling', 'connecting', 'ready', 'disconnected', 'destroyed']);
const ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL', 'EADDRINUSE',
  'ENOBUFS', 'EMSGSIZE', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ERR_SOCKET_DGRAM_NOT_RUNNING',
  'ERR_SOCKET_DGRAM_NOT_CONNECTED', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED']);
const empty = () => ({ udpKeepaliveSent: 0, udpKeepaliveReplies: 0, udpKeepaliveTimeouts: 0,
  udpKeepaliveUntracked: 0, udpRttMaxMs: null, udpRttJitterMs: null, udpAudioPackets: 0,
  udpMaxSendGapMs: 0, udpSendErrors: 0 });
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const code = (value, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : null;
const status = value => CONNECTION_STATES.has(value) ? value : 'unknown';
const attempt = operation => { try { return operation(); } catch { return undefined; } };
function listen(target, name, callback, prepend = false) {
  if (typeof target?.on !== 'function' || typeof target?.off !== 'function') return () => {};
  if (prepend && typeof target.prependListener === 'function') target.prependListener(name, callback);
  else target.on(name, callback);
  return () => attempt(() => target.off(name, callback));
}
function keepaliveId(packet) {
  return Buffer.isBuffer(packet) && packet.length === 8 && packet.readUInt32LE(4) === 0
    ? packet.readUInt32LE(0) : null;
}

/**
 * Passive diagnostics for @discordjs/voice's existing UDP keepalives and audio sends.
 * No probes are sent, packets retained, or payloads changed. Unanswered keepalives
 * are NOT an audio loss measurement: some voice endpoints may not echo them.
 * Counters and maxima reset per sample; ping and pending/queue/heartbeat fields
 * are current gauges. RTT jitter is the largest successive RTT difference.
 * Internals are feature-detected; their absence cannot interrupt playback.
 */
export function createVoiceNetworkHealth({ connection, onEvent, now = () => performance.now(),
  wallNow = () => Date.now(), keepaliveTimeoutMs = 15000, maxPendingKeepalives = 32 } = {}) {
  const timeout = Number.isFinite(keepaliveTimeoutMs) ? Math.max(1000, keepaliveTimeoutMs) : 15000;
  const capacity = Number.isInteger(maxPendingKeepalives) ? Math.min(128, Math.max(1, maxPendingKeepalives)) : 32;
  let counters = empty(), closed = false, networking, udp, ws, playing = false, lastAudioAt = null;
  let lastRtt = null, lastReplyAt = null, confirmed = false;
  let udpSupported = false, intervalObserved = false, unavailableReported = false;
  let restoreSend = () => {}, offConnection = () => {}, offNetwork = () => {};
  let udpOff = [], wsOff = [];
  const pending = new Map();
  const emit = event => { if (!closed) attempt(() => onEvent?.(event)); };
  const unavailable = reason => {
    if (!unavailableReported) { unavailableReported = true; emit({ kind: 'observer-unavailable', reason }); }
  };
  const time = () => nonnegative(now());
  const socketError = (kind, error) => {
    if (kind === 'udp-error') counters.udpSendErrors++;
    emit({ kind, errorCode: ERROR_CODES.has(error?.code) ? error.code : 'UNKNOWN' });
  };
  function expire(at) {
    for (const [id, sentAt] of pending) {
      if (at - sentAt >= timeout) { pending.delete(id); counters.udpKeepaliveTimeouts++; }
    }
  }
  function resetSocketTiming() {
    pending.clear(); lastAudioAt = null; lastRtt = null; lastReplyAt = null; confirmed = false;
  }
  function bindUdp(next) {
    if (next === udp) return;
    restoreSend(); restoreSend = () => {};
    for (const off of udpOff) off();
    udpOff = []; udp = next; udpSupported = false; resetSocketTiming();
    if (!udp) return;
    const watched = udp;
    const original = watched.send;
    if (typeof original !== 'function' || typeof watched.on !== 'function' || typeof watched.off !== 'function') {
      unavailable('unsupported-layout'); return;
    }
    udpOff.push(listen(watched, 'message', packet => attempt(() => {
      if (closed || udp !== watched) return;
      const id = keepaliveId(packet), at = time();
      if (id === null || at === null) return;
      expire(at);
      const sentAt = pending.get(id);
      if (sentAt === undefined) return;
      pending.delete(id);
      const rtt = Math.max(0, at - sentAt);
      counters.udpKeepaliveReplies++;
      counters.udpRttMaxMs = Math.max(counters.udpRttMaxMs ?? 0, rtt);
      if (lastRtt !== null) counters.udpRttJitterMs = Math.max(counters.udpRttJitterMs ?? 0, Math.abs(rtt - lastRtt));
      lastRtt = rtt; lastReplyAt = at; confirmed = true;
    })));
    udpOff.push(listen(watched, 'error', error => attempt(() => {
      if (!closed && udp === watched) socketError('udp-error', error);
    }), true));
    udpOff.push(listen(watched, 'close', () => attempt(() => {
      if (closed || udp !== watched) return;
      resetSocketTiming(); emit({ kind: 'udp-close' });
    }), true));
    const ownDescriptor = Object.getOwnPropertyDescriptor(watched, 'send');
    const wrapped = function(...args) {
      let id = null, at = null;
      const active = !closed && udp === watched;
      if (active) attempt(() => {
        at = time();
        if (at === null) return;
        expire(at);
        id = keepaliveId(args[0]);
        if (id !== null) {
          if (!pending.has(id) && pending.size >= capacity) {
            pending.delete(pending.keys().next().value); counters.udpKeepaliveUntracked++;
          }
          pending.set(id, at);
        }
      });
      let result;
      try { result = original.apply(this, args); }
      catch (error) {
        if (active) attempt(() => {
          if (id !== null && pending.get(id) === at) pending.delete(id);
          socketError('udp-error', error);
        });
        throw error;
      }
      if (active) attempt(() => {
        if (id !== null) counters.udpKeepaliveSent++;
        const packet = args[0];
        if (!Buffer.isBuffer(packet) || packet.length < 12 || packet[0] >>> 6 !== 2 || (packet[1] & 127) !== 120) return;
        counters.udpAudioPackets++;
        if (!playing || at === null) return;
        if (lastAudioAt !== null) counters.udpMaxSendGapMs = Math.max(counters.udpMaxSendGapMs, Math.max(0, at - lastAudioAt));
        lastAudioAt = at;
      });
      return result;
    };
    // Assignment can fail on future versions with a read-only method; metrics then
    // remain unavailable while the original transport continues untouched.
    watched.send = wrapped;
    if (watched.send !== wrapped) { unavailable('attach-failed'); return; }
    udpSupported = true; intervalObserved = true; unavailableReported = false;
    restoreSend = () => attempt(() => {
      if (watched.send !== wrapped) return;
      if (ownDescriptor) Object.defineProperty(watched, 'send', ownDescriptor);
      else delete watched.send;
    });
  }
  function bindWs(next) {
    if (next === ws) return;
    for (const off of wsOff) off();
    wsOff = []; ws = next;
    if (!ws) return;
    const watched = ws;
    wsOff.push(listen(watched, 'close', value => attempt(() => {
      if (!closed && ws === watched) emit({ kind: 'websocket-close', closeCode: code(typeof value === 'number' ? value : value?.code, 1000, 4999) });
    }), true));
    wsOff.push(listen(watched, 'error', error => attempt(() => {
      if (!closed && ws === watched) socketError('websocket-error', error);
    }), true));
  }
  function bindSockets(state) {
    try { bindUdp(state?.udp); } catch { unavailable('attach-failed'); }
    try { bindWs(state?.ws); } catch { unavailable('attach-failed'); }
  }
  function bindNetwork(next) {
    if (next !== networking) {
      offNetwork(); offNetwork = () => {}; networking = next; unavailableReported = false;
      if (networking) offNetwork = listen(networking, 'stateChange', (previous, current) => attempt(() => {
        if (closed || networking !== next) return;
        if (previous?.code !== current?.code) emit({ kind: 'network-state', previous: code(previous?.code, 0, 6), status: code(current?.code, 0, 6) });
        bindSockets(current);
      }), true);
    }
    bindSockets(networking?.state);
    if (connection?.state?.status === 'ready' && (!networking?.state || networking.state.code === 4 && !udp)) unavailable('unsupported-layout');
  }
  function close() {
    if (closed) return;
    closed = true;
    offConnection(); offNetwork(); restoreSend();
    for (const off of [...udpOff, ...wsOff]) off();
    udpOff = []; wsOff = []; networking = undefined; udp = undefined; ws = undefined;
    udpSupported = false; resetSocketTiming();
  }
  attempt(() => {
    offConnection = listen(connection, 'stateChange', (previous, current) => attempt(() => {
      if (closed) return;
      if (previous?.status !== current?.status) emit({ kind: 'connection-state', previous: status(previous?.status),
        status: status(current?.status), reason: code(current?.reason, 0, 4), closeCode: code(current?.closeCode, 1000, 4999) });
      if (current?.status === 'destroyed') close();
      else bindNetwork(current?.networking);
    }), true);
  });
  attempt(() => bindNetwork(connection?.state?.networking));
  return {
    sample() {
      if (!closed) attempt(() => bindNetwork(connection?.state?.networking));
      const at = attempt(time);
      if (at !== null && at !== undefined) attempt(() => expire(at));
      let queueBytes = null, heartbeatAge = null;
      attempt(() => { if (udpSupported) queueBytes = nonnegative(udp?.socket?.getSendQueueSize?.()); });
      attempt(() => {
        const ack = nonnegative(ws?.lastHeartbeatAck), wall = nonnegative(wallNow());
        if (ack !== null && ack > 0 && wall !== null) heartbeatAge = Math.max(0, wall - ack);
      });
      const snapshot = { ...(intervalObserved ? counters : Object.fromEntries(Object.keys(counters).map(key => [key, null]))),
        voiceUdpPingMs: lastReplyAt !== null && at !== null && at !== undefined && at - lastReplyAt <= timeout ? lastRtt : null,
        udpKeepalivePending: udpSupported ? pending.size : null, udpKeepaliveConfirmed: udpSupported ? Number(confirmed) : null,
        udpSendQueueBytes: queueBytes, voiceWsHeartbeatAgeMs: heartbeatAge };
      counters = empty(); intervalObserved = udpSupported;
      return snapshot;
    },
    playerState(next) {
      const nextPlaying = next === 'playing';
      if (nextPlaying !== playing) lastAudioAt = null;
      playing = nextPlaying;
    },
    close,
  };
}
