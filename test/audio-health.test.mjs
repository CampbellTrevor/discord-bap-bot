import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioHealth, opusPacketDurationMs } from '../src/audio-health.mjs';

const packet20 = Buffer.from([0xf8, 0xff, 0xfe]);
function fixture() {
  let time = 0, scheduled, cancelled = 0, unrefs = 0;
  const metrics = [];
  const token = { unref() { unrefs++; } };
  const health = createAudioHealth({ onMetric: value => metrics.push(value), getVoiceWsPing: () => 42,
    now: () => time, setInterval(callback, interval) { scheduled = callback; assert.equal(interval, 5000); return token; },
    clearInterval(value) { assert.equal(value, token); cancelled++; } });
  const resource = { ended: false, playStream: { readableLength: 150, readableEnded: false, destroyed: false, writableFinished: false },
    packet: packet20, read() { assert.equal(this, resource); return this.packet; } };
  return { health, resource, metrics, at(value) { time = value; }, tick() { scheduled(); }, counts: () => ({ cancelled, unrefs }) };
}

test('duration diagnostics validate Opus framing without decoding or throwing', () => {
  for (const [packet, duration] of [
    [[0xe0], 2.5], [[0xe8], 5], [[0xf0], 10], [[0xf8, 0xff, 0xfe], 20],
    [[0xf9, 1, 2], 40], [[0xfb, 3, 1, 2, 3], 60], [[0x11, 1, 2], 80],
    [[0xfb, 5, 1, 2, 3, 4, 5], 100], [[0x19, 1, 2], 120],
    [[0xfa, 1, 42, 43], 40], [[0xfb, 0x83, 1, 1, 42, 43, 44], 60],
    [[0xfb, 0x41, 1, 42, 0], 20], [[0xe3, 3], 7.5], [[0xfb, 0x81], 20],
  ]) assert.equal(opusPacketDurationMs(Buffer.from(packet)), duration);
  for (const packet of [Buffer.alloc(0), Buffer.from([0xfa, 252]), Buffer.from([0xfa, 10, 1]),
    Buffer.from([0xfb, 0x41]), Buffer.from([0xfb, 0]), Buffer.from([0xfb, 7, 1, 2, 3, 4, 5, 6, 7]),
    Buffer.from([0xfb, 0x82]), Buffer.from([0xf9, 1]), Buffer.from([0xfb, 0x42, 255]),
    Buffer.alloc(1277), Buffer.alloc(8193), 'not audio', null]) {
    assert.equal(opusPacketDurationMs(packet), null);
  }
});

test('interval metrics distinguish starvation and EOF and contain only numbers or null', () => {
  const f = fixture();
  f.health.observeResource(f.resource);
  f.health.playerState('playing');
  f.resource.read();
  f.at(20); f.resource.packet = Buffer.from([0xf0, 1]); f.resource.playStream.readableLength = 25; f.resource.read();
  f.at(40); f.resource.packet = null; f.resource.playStream.readableLength = 0; f.resource.read();
  f.at(100); f.resource.ended = true; f.resource.read();
  f.health.voiceStateChanged('connecting', 'ready');
  f.health.voiceStateChanged('ready', 'ready');
  f.at(5000); f.tick();
  const metric = f.metrics[0];
  assert.equal(metric.windowMs, 5000);
  assert.equal(metric.readAttempts, 4);
  assert.equal(metric.packetsRead, 2);
  assert.equal(metric.emptyReads, 2);
  assert.equal(metric.starvedReads, 1);
  assert.equal(metric.minBufferedPackets, 0);
  assert.equal(metric.maxReadGapMs, 60);
  assert.equal(metric.maxPacketBytes, 3);
  assert.equal(metric.opus20Ms, 1);
  assert.equal(metric.opus10Ms, 1);
  assert.equal(metric.opusMismatch, 1);
  assert.equal(metric.opusInvalid, 0);
  assert.equal(metric.voiceStateChanges, 1);
  assert.equal(metric.voiceWsPingMs, 42);
  assert.equal(metric.voiceUdpPingMs, null);
  assert.ok(Object.values(metric).every(value => value === null || typeof value === 'number' && Number.isFinite(value)));
  f.at(10000); f.tick();
  assert.equal(f.metrics[1].readAttempts, 0);
  assert.equal(f.metrics[1].minBufferedPackets, null);
  assert.equal(f.metrics[1].maxReadGapMs, 0);
  f.health.close();
});

test('pause, subscriber loss, buffering, and resource changes do not create false cadence gaps', () => {
  const f = fixture();
  f.health.observeResource(f.resource);
  f.health.playerState('playing');
  f.resource.read();
  let time = 20;
  for (const state of ['paused', 'autopaused', 'buffering', 'idle']) {
    f.health.playerState(state);
    f.at(time += 10000); f.resource.read();
    f.health.playerState('playing');
    f.resource.read();
    f.at(time += 20); f.resource.read();
  }
  const next = { ended: false, playStream: { readableLength: 30 }, read: () => packet20 };
  f.health.observeResource(next);
  f.at(time += 10000); next.read();
  f.tick();
  assert.equal(f.metrics[0].readAttempts, 10);
  assert.equal(f.metrics[0].maxReadGapMs, 20);
  f.health.close();
});

test('observer preserves read identity, arguments and exceptions, restores wrappers and cancels once', () => {
  const f = fixture();
  const original = f.resource.read;
  f.health.observeResource(f.resource);
  f.health.playerState('playing');
  assert.equal(f.resource.read(), packet20);
  const failure = new Error('synthetic read failure');
  const other = { playStream: { readableLength: 1 }, read(...args) { assert.equal(this, other); assert.deepEqual(args, [1, 2]); throw failure; } };
  const otherRead = other.read;
  f.health.observeResource(other);
  assert.equal(f.resource.read, original);
  assert.throws(() => other.read(1, 2), error => error === failure);
  f.health.close();
  assert.equal(other.read, otherRead);
  const count = f.metrics.length;
  f.health.close(); f.tick();
  f.health.voiceStateChanged('ready', 'disconnected');
  assert.equal(f.metrics.length, count);
  assert.deepEqual(f.counts(), { cancelled: 1, unrefs: 1 });
});

test('diagnostic callback or ping failures cannot interrupt resource reads', () => {
  let tick;
  const health = createAudioHealth({ onMetric() { throw new Error('diagnostic sink failure'); }, getVoiceWsPing() { throw new Error('Unavailable connection'); },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() {} });
  const resource = { playStream: { readableLength: 10 }, read() { return packet20; } };
  health.observeResource(resource); health.playerState('playing');
  assert.equal(resource.read(), packet20);
  assert.doesNotThrow(() => tick());
  assert.doesNotThrow(() => health.close());
});
