import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createVoiceNetworkHealth } from '../src/voice-network-health.mjs';

const keepalive = id => { const value = Buffer.alloc(8); value.writeUInt32LE(id, 0); return value; };
const audio = () => { const value = Buffer.alloc(20, 47); value[0] = 0x80; value[1] = 120; return value; };
function transport() {
  const udp = new EventEmitter();
  udp.calls = [];
  udp.send = function(...args) { this.calls.push(args); return 42; };
  udp.socket = { getSendQueueSize() { return 64; } };
  const ws = new EventEmitter(); ws.lastHeartbeatAck = 99000;
  const networking = new EventEmitter(); networking.state = { code: 4, udp, ws };
  return { udp, ws, networking };
}
function fixture(options = {}) {
  let clock = 0, wall = 100000;
  const current = transport(), events = [];
  const connection = new EventEmitter(); connection.state = { status: 'ready', networking: current.networking };
  const original = current.udp.send;
  const health = createVoiceNetworkHealth({ connection, onEvent: event => events.push(event),
    now: () => clock, wallNow: () => wall, ...options });
  function replace(next) {
    const previous = connection.state;
    connection.state = { status: 'ready', networking: next.networking };
    connection.emit('stateChange', previous, connection.state);
  }
  return { ...current, connection, original, health, events, replace, at(value) { clock = value; }, wall(value) { wall = value; } };
}

test('matches existing UDP keepalive echoes once, records fresh RTT and interval extrema, and expires freshness', () => {
  const f = fixture();
  assert.equal(f.health.sample().voiceUdpPingMs, null);
  const reused = keepalive(0);
  f.udp.send(reused);
  f.at(45); f.udp.emit('message', Buffer.from(reused));
  f.udp.emit('message', Buffer.from(reused)); // duplicate, not a second reply
  reused.writeUInt32LE(1, 0); // library reuses one send buffer
  f.at(5000); f.udp.send(reused);
  f.at(5060); f.udp.emit('message', keepalive(1));
  const sample = f.health.sample();
  assert.equal(sample.udpKeepaliveSent, 2);
  assert.equal(sample.udpKeepaliveReplies, 2);
  assert.equal(sample.voiceUdpPingMs, 60);
  assert.equal(sample.udpRttMaxMs, 60);
  assert.equal(sample.udpRttJitterMs, 15);
  assert.equal(sample.udpKeepaliveConfirmed, 1);
  assert.equal(sample.udpKeepalivePending, 0);
  assert.equal(sample.udpSendQueueBytes, 64);
  assert.equal(sample.voiceWsHeartbeatAgeMs, 1000);
  assert.equal(f.health.sample().udpKeepaliveReplies, 0);
  assert.equal(f.health.sample().udpRttMaxMs, null);
  f.at(20060); assert.equal(f.health.sample().voiceUdpPingMs, 60);
  f.at(20061); assert.equal(f.health.sample().voiceUdpPingMs, null);
  f.health.close();
});

test('unanswered, late, unsolicited and malformed UDP messages cannot invent latency or audio loss', () => {
  const f = fixture();
  f.udp.send(keepalive(4));
  f.at(14999);
  assert.equal(f.health.sample().udpKeepalivePending, 1);
  f.at(15000);
  f.udp.emit('message', keepalive(4)); // late response, expired before matching
  f.udp.emit('message', keepalive(5));
  f.udp.emit('message', Buffer.alloc(7));
  f.udp.emit('message', Buffer.alloc(8, 255));
  f.udp.emit('message', audio());
  f.udp.emit('message', null);
  const sample = f.health.sample();
  assert.equal(sample.udpKeepaliveTimeouts, 1);
  assert.equal(sample.udpKeepaliveReplies, 0);
  assert.equal(sample.voiceUdpPingMs, null);
  assert.equal(sample.udpKeepaliveConfirmed, 0);
  assert.equal(sample.udpKeepalivePending, 0);
  assert.equal(sample.udpAudioPackets, 0);
  assert.equal(f.health.sample().udpKeepaliveTimeouts, 0);
  f.health.close();
});

test('pending probes stay bounded and evictions are separate from timeout measurements', () => {
  const f = fixture({ maxPendingKeepalives: 3 });
  for (let index = 0; index < 1000; index++) f.udp.send(keepalive(index));
  let sample = f.health.sample();
  assert.equal(sample.udpKeepaliveSent, 1000);
  assert.equal(sample.udpKeepalivePending, 3);
  assert.equal(sample.udpKeepaliveUntracked, 997);
  assert.equal(sample.udpKeepaliveTimeouts, 0);
  f.at(20); f.udp.emit('message', keepalive(0));
  f.udp.emit('message', keepalive(999));
  sample = f.health.sample();
  assert.equal(sample.udpKeepaliveReplies, 1);
  assert.equal(sample.voiceUdpPingMs, 20);
  assert.equal(sample.udpKeepalivePending, 2);
  f.at(15000); assert.equal(f.health.sample().udpKeepaliveTimeouts, 2);
  f.health.close();
});

test('audio observation preserves payload, receiver, arguments and return value; only RTP audio contributes', () => {
  const f = fixture();
  const packet = audio(), before = Buffer.from(packet), otherArg = { callback: true };
  f.health.playerState('playing');
  assert.equal(f.udp.send(packet, otherArg), 42);
  assert.equal(f.udp.calls[0][0], packet);
  assert.equal(f.udp.calls[0][1], otherArg);
  assert.deepEqual(packet, before);
  f.at(20); f.udp.send(packet);
  f.at(620); f.udp.send(packet);
  const marker = audio(); marker[1] |= 0x80;
  f.at(640); f.udp.send(marker);
  const wrongVersion = audio(); wrongVersion[0] = 0;
  const wrongPayload = audio(); wrongPayload[1] = 119;
  f.udp.send(wrongVersion); f.udp.send(wrongPayload); f.udp.send(packet.subarray(0, 11));
  f.udp.send(keepalive(2));
  const sample = f.health.sample();
  assert.equal(sample.udpAudioPackets, 4);
  assert.equal(sample.udpMaxSendGapMs, 600);
  assert.equal(f.udp.calls.length, 8); // observer sends no extra traffic
  assert.equal(sample.udpKeepaliveSent, 1);
  f.health.close();
});

test('pauses and socket replacement reset send cadence and previous RTT', () => {
  const f = fixture();
  f.health.playerState('playing');
  f.udp.send(audio());
  f.at(20); f.udp.send(audio());
  f.udp.send(keepalive(1)); f.at(60); f.udp.emit('message', keepalive(1));
  f.health.sample();
  let time = 60;
  for (const state of ['paused', 'autopaused', 'buffering', 'idle']) {
    f.health.playerState(state);
    f.at(time += 10000); f.udp.send(audio());
    f.at(time += 10000); f.health.playerState('playing'); f.udp.send(audio());
    f.at(time += 20); f.udp.send(audio());
    assert.equal(f.health.sample().udpMaxSendGapMs, 20);
  }
  const next = transport(); f.replace(next);
  f.at(100000); next.udp.send(audio());
  const sample = f.health.sample();
  assert.equal(sample.udpMaxSendGapMs, 0);
  assert.equal(sample.voiceUdpPingMs, null);
  assert.equal(sample.udpKeepaliveConfirmed, 0);
  assert.equal(f.udp.send, f.original);
  assert.equal(f.udp.listenerCount('message'), 0);
  assert.equal(f.networking.listenerCount('stateChange'), 0);
  f.health.close();
});

test('network state socket replacements rebind once and close restores all listeners and method descriptors', () => {
  const f = fixture();
  const originalDescriptor = Object.getOwnPropertyDescriptor(f.udp, 'send');
  const next = transport(), nextOriginal = next.udp.send;
  const previous = f.networking.state;
  f.networking.state = { code: 5, ws: next.ws, udp: next.udp };
  f.networking.emit('stateChange', previous, f.networking.state);
  for (let index = 0; index < 10; index++) f.health.sample();
  assert.equal(f.udp.send, f.original);
  assert.equal(f.ws.listenerCount('error'), 0);
  assert.equal(next.udp.listenerCount('message'), 1);
  assert.equal(next.ws.listenerCount('close'), 1);
  assert.deepEqual(f.events, [{ kind: 'network-state', previous: 4, status: 5 }]);
  f.health.close(); f.health.close();
  assert.equal(next.udp.send, nextOriginal);
  for (const target of [f.connection, f.networking, f.udp, f.ws, next.udp, next.ws]) assert.equal(target.eventNames().length, 0);
  assert.equal(originalDescriptor.enumerable, Object.getOwnPropertyDescriptor(f.udp, 'send').enumerable);
});

test('inherited UDP send is restored without leaving an own method behind', () => {
  class Udp extends EventEmitter { send(packet) { return packet; } }
  const udp = new Udp(), connection = new EventEmitter();
  connection.state = { networking: { state: { udp } } };
  const health = createVoiceNetworkHealth({ connection });
  assert.equal(Object.hasOwn(udp, 'send'), true);
  health.close();
  assert.equal(Object.hasOwn(udp, 'send'), false);
  assert.equal(udp.send, Udp.prototype.send);
});

test('real send exceptions retain identity and failed sends do not create pending probes', () => {
  const failure = Object.assign(new Error('SECRET payload'), { code: 'ENOBUFS' });
  const f = fixture();
  const next = transport();
  next.udp.send = function(packet, sentinel) { assert.equal(this, next.udp); assert.equal(sentinel, 123); throw failure; };
  f.replace(next);
  assert.throws(() => next.udp.send(keepalive(10), 123), error => error === failure);
  const sample = f.health.sample();
  assert.equal(sample.udpSendErrors, 1);
  assert.equal(sample.udpKeepalivePending, 0);
  assert.equal(sample.udpKeepaliveSent, 0);
  assert.deepEqual(f.events, [{ kind: 'udp-error', errorCode: 'ENOBUFS' }]);
  f.health.close();
});

test('diagnostic callback, clock, queue and property failures never break transport', () => {
  const f = fixture({ now() { throw new Error('clock unavailable'); }, wallNow() { throw new Error('wall clock unavailable'); },
    onEvent() { throw new Error('sink unavailable'); } });
  f.udp.socket.getSendQueueSize = () => { throw new Error('queue unavailable'); };
  f.health.playerState('playing');
  assert.equal(f.udp.send(audio()), 42);
  assert.doesNotThrow(() => f.udp.emit('error', Object.defineProperty({}, 'code', { get() { throw new Error('unreadable error'); } })));
  assert.doesNotThrow(() => f.ws.emit('close', 4006));
  const sample = f.health.sample();
  assert.equal(sample.voiceUdpPingMs, null);
  assert.equal(sample.udpSendQueueBytes, null);
  assert.equal(sample.voiceWsHeartbeatAgeMs, null);
  assert.ok(Object.values(sample).every(value => value === null || typeof value === 'number' && Number.isFinite(value)));
  assert.doesNotThrow(() => f.health.close());
});

test('missing or read-only transport internals fail open', () => {
  for (const connection of [undefined, {}, { get state() { throw new Error('unknown implementation'); } }, { state: {} }]) {
    const health = createVoiceNetworkHealth({ connection });
    assert.equal(health.sample().voiceUdpPingMs, null);
    assert.doesNotThrow(() => health.close());
  }
  const udp = new EventEmitter(), send = () => 77;
  Object.defineProperty(udp, 'send', { value: send, writable: false });
  const health = createVoiceNetworkHealth({ connection: { state: { networking: { state: { udp } } } } });
  assert.equal(udp.send(audio()), 77);
  assert.equal(health.sample().voiceUdpPingMs, null);
  health.close();
  assert.equal(udp.send, send);
  assert.equal(udp.eventNames().length, 0);
});

test('sanitized state/error/close events cannot reveal error messages, addresses, tokens or packets', () => {
  const f = fixture();
  const secret = 'SECRET access-token endpoint session-id audio-payload';
  f.udp.emit('error', { code: secret, message: secret, stack: secret });
  f.ws.emit('error', { code: 'ECONNRESET', message: secret });
  f.ws.emit('close', { code: 4014, reason: secret, target: { url: secret } });
  const previousNetwork = f.networking.state;
  f.networking.state = { ...previousNetwork, code: secret, connectionOptions: { token: secret } };
  f.networking.emit('stateChange', previousNetwork, f.networking.state);
  const previousConnection = f.connection.state;
  f.connection.state = { ...previousConnection, status: secret, reason: secret, closeCode: secret };
  f.connection.emit('stateChange', previousConnection, f.connection.state);
  assert.deepEqual(f.events, [
    { kind: 'udp-error', errorCode: 'UNKNOWN' }, { kind: 'websocket-error', errorCode: 'ECONNRESET' },
    { kind: 'websocket-close', closeCode: 4014 }, { kind: 'network-state', previous: 4, status: null },
    { kind: 'connection-state', previous: 'ready', status: 'unknown', reason: null, closeCode: null },
  ]);
  assert.equal(JSON.stringify(f.events).includes(secret), false);
  f.health.close();
});

test('destroyed connection releases observers immediately and does not interfere with later transport decorators', () => {
  const f = fixture();
  const wrapper = f.udp.send;
  const laterWrapper = function(...args) { return wrapper.apply(this, args); };
  f.udp.send = laterWrapper;
  f.connection.emit('stateChange', f.connection.state, { status: 'destroyed' });
  assert.equal(f.udp.send, laterWrapper);
  assert.equal(f.connection.listenerCount('stateChange'), 0);
  assert.equal(f.udp.listenerCount('message'), 0);
  assert.equal(f.udp.send(audio()), 42);
  assert.equal(f.health.sample().udpAudioPackets, 0);
  assert.deepEqual(f.events, [{ kind: 'connection-state', previous: 'ready', status: 'destroyed', reason: null, closeCode: null }]);
});

test('prepended lifecycle observers capture triggering errors and closes before library handlers tear down transport', () => {
  for (const [socketName, eventName, value, expected] of [
    ['ws', 'close', { code: 4015, reason: 'private' }, { kind: 'websocket-close', closeCode: 4015 }],
    ['ws', 'error', { code: 'ECONNRESET', message: 'private' }, { kind: 'websocket-error', errorCode: 'ECONNRESET' }],
    ['udp', 'close', undefined, { kind: 'udp-close' }],
    ['udp', 'error', { code: 'ENETDOWN', message: 'private' }, { kind: 'udp-error', errorCode: 'ENETDOWN' }],
  ]) {
    const current = transport(), connection = new EventEmitter(), events = [];
    connection.state = { status: 'ready', networking: current.networking };
    let libraryCalls = 0;
    // @discordjs/voice installs these handlers before the health observer exists.
    current[socketName].on(eventName, () => {
      libraryCalls++;
      const previous = connection.state;
      connection.state = { status: 'destroyed' };
      connection.emit('stateChange', previous, connection.state);
    });
    const health = createVoiceNetworkHealth({ connection, onEvent: event => events.push(event) });
    current[socketName].emit(eventName, value);
    assert.equal(libraryCalls, 1);
    assert.deepEqual(events[0], expected);
    assert.equal(events[1].kind, 'connection-state');
    assert.equal(events[1].status, 'destroyed');
    assert.equal(connection.listenerCount('stateChange'), 0);
    assert.equal(current.ws.listenerCount('close'), socketName === 'ws' && eventName === 'close' ? 1 : 0);
    assert.equal(health.sample().udpSendErrors, socketName === 'udp' && eventName === 'error' ? 1 : 0);
    health.close();
  }
});

test('prepended network observer captures transition before the earlier library listener discards networking', () => {
  const current = transport(), connection = new EventEmitter(), events = [];
  connection.state = { status: 'ready', networking: current.networking };
  current.networking.on('stateChange', () => {
    const previous = connection.state;
    connection.state = { status: 'destroyed' };
    connection.emit('stateChange', previous, connection.state);
  });
  const health = createVoiceNetworkHealth({ connection, onEvent: event => events.push(event) });
  const previous = current.networking.state;
  current.networking.state = { code: 6 };
  current.networking.emit('stateChange', previous, current.networking.state);
  assert.deepEqual(events[0], { kind: 'network-state', previous: 4, status: 6 });
  assert.equal(events[1].kind, 'connection-state');
  health.close();
});

test('ready unsupported transport emits one bounded availability event and null UDP fields', () => {
  const cases = [{ status: 'ready' }, { status: 'ready', networking: { state: { code: 4 } } },
    { status: 'ready', networking: { state: { code: 4, udp: {} } } }];
  const readOnly = new EventEmitter(); Object.defineProperty(readOnly, 'send', { value: () => 1, writable: false });
  cases.push({ status: 'ready', networking: { state: { code: 4, udp: readOnly } } });
  for (const state of cases) {
    const events = [], connection = new EventEmitter(); connection.state = state;
    const health = createVoiceNetworkHealth({ connection, onEvent: event => events.push(event) });
    for (let index = 0; index < 10; index++) {
      const sample = health.sample();
      for (const key of ['udpAudioPackets', 'udpKeepaliveSent', 'udpKeepalivePending', 'udpKeepaliveConfirmed', 'udpSendErrors', 'voiceUdpPingMs']) assert.equal(sample[key], null, key);
    }
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { kind: 'observer-unavailable', reason: state.networking?.state?.udp === readOnly ? 'attach-failed' : 'unsupported-layout' });
    health.close();
  }
});

test('collected UDP interval survives replacement with unsupported transport, then returns null', () => {
  const f = fixture();
  f.udp.send(audio());
  f.udp.send(keepalive(9));
  f.replace({ networking: { state: { code: 4 } } });
  const sample = f.health.sample();
  assert.equal(sample.udpAudioPackets, 1);
  assert.equal(sample.udpKeepaliveSent, 1);
  assert.equal(sample.udpKeepalivePending, null);
  assert.equal(f.health.sample().udpAudioPackets, null);
  f.health.close();
});
