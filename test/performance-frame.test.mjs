import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePerformanceFrame } from '../src/performance-frame.mjs';

const frame = result => ({ v: 1, type: 'result', id: '12345678-1234-1234-1234-123456789abc', ok: true, result });
const snapshot = () => ({ version: 1, sampledAt: 1234, latest: { cpu: 2.5, optional: undefined, missing: null },
  history: Array.from({ length: 288 }, (_, at) => ({ at, summary: 'µ音🎵'.repeat(600), avg: { value: at / 3 }, min: { value: null }, max: { value: Infinity } })),
  network: { measurement: 'voice-udp-keepalive-and-local-send', errors: [] }, persistence: { available: true }, omitted: undefined });

test('performance encoding preserves the exact JSON wire contract and yields through a full history', async () => {
  const input = frame(snapshot());
  let yields = 0;
  const result = await encodePerformanceFrame(input, { yieldTask: async () => { yields++; } });
  assert.equal(result, JSON.stringify(input));
  assert.ok(yields > 20);
  for (const value of [null, false, 1, 'ok', { version: 1, history: [] }, { history: [null, undefined, , NaN], latest: null }]) {
    assert.equal(await encodePerformanceFrame(frame(value)), JSON.stringify(frame(value)));
  }
});

test('default telemetry encoding gives event-loop tasks a turn before finishing', async () => {
  let timerRan = false;
  const pendingTimer = new Promise(resolve => setImmediate(() => { timerRan = true; resolve(); }));
  const result = await encodePerformanceFrame(frame(snapshot()));
  assert.ok(result);
  assert.equal(timerRan, true);
  await pendingTimer;
});

test('the byte limit includes UTF-8 metadata, frame overhead and closing delimiters', async () => {
  const input = frame({ latest: '音🎵', history: [{ at: 1, avg: 'µ' }] });
  const size = Buffer.byteLength(JSON.stringify(input));
  assert.equal(await encodePerformanceFrame(input, { maxBytes: size }), JSON.stringify(input));
  assert.equal(await encodePerformanceFrame(input, { maxBytes: size - 1 }), null);
  assert.ok(size > JSON.stringify(input).length);
  let visited = 0;
  const history = Array.from({ length: 100 }, () => ({ toJSON() { visited++; return { padding: 'x'.repeat(8_000) }; } }));
  assert.equal(await encodePerformanceFrame(frame({ history }), { maxBytes: 64_000 }), null);
  assert.ok(visited < 10, 'stop building as soon as the size limit is reached');
});

test('cancelled encoding stops at the next yield and preserves the cancellation reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Request disconnected');
  let yields = 0;
  await assert.rejects(encodePerformanceFrame(frame(snapshot()), { signal: controller.signal, yieldTask: async () => {
    yields++; controller.abort(reason);
  } }), error => error === reason);
  assert.equal(yields, 1);
  await assert.rejects(encodePerformanceFrame(frame(snapshot()), { signal: controller.signal }), error => error === reason);
});

test('unserializable telemetry fails without changing the result error contract', async () => {
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(await encodePerformanceFrame(frame({ history: [cyclic] })), null);
  assert.equal(await encodePerformanceFrame(frame({ history: [{ impossible: 1n }] })), null);
});
