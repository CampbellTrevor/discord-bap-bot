import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { StreamType, createAudioResource } from '@discordjs/voice';
import { prepareAudio } from '../src/audio-pipeline.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
function source(stream) {
  const opened = { stream, cleanupCount: 0, cleanup() { this.cleanupCount++; stream.destroy(); } };
  return opened;
}
const packetProbe = async stream => ({ stream, type: StreamType.Opus });

function oggPage(parts, sequence, flags = 0) {
  const header = Buffer.alloc(27 + parts.length);
  header.write('OggS');
  header[5] = flags;
  header.writeUInt32LE(1, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = parts.length;
  parts.forEach((part, index) => { header[27 + index] = part.length; });
  const page = Buffer.concat([header, ...parts]);
  let checksum = 0;
  for (const byte of page) {
    checksum ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) checksum = checksum & 0x80000000 ? (checksum << 1) ^ 0x04c11db7 : checksum << 1;
  }
  page.writeUInt32LE(checksum >>> 0, 22);
  return page;
}

test('real demux probe recognizes 48 kHz stereo Ogg Opus and bypasses FFmpeg', async () => {
  const head = Buffer.alloc(19);
  head.write('OpusHead'); head[8] = 1; head[9] = 2; head.writeUInt32LE(48000, 12);
  const tags = Buffer.alloc(16); tags.write('OpusTags');
  const expected = Array.from({ length: 30 }, () => Buffer.from([0xf8, 0xff, 0xfe]));
  const raw = source(new PassThrough());
  raw.stream.end(Buffer.concat([oggPage([head], 0, 2), oggPage([tags], 1), oggPage(expected, 2, 4)]));
  const inputs = [];
  const prepared = await prepareAudio(raw, {}, {
    createAudioResource(stream, options) { inputs.push(options.inputType); assert.notEqual(options.inputType, StreamType.Arbitrary); return createAudioResource(stream, options); },
  });
  assert.deepEqual(inputs, [StreamType.OggOpus, StreamType.Opus]);
  assert.equal(prepared.pipelineMode, 'native-opus');
  const actual = [];
  for await (const packet of prepared.stream) actual.push(packet);
  assert.deepEqual(actual, expected);
  prepared.cleanup();
});

test('preparation buffers bounded, separate Opus packets and preserves first and last packets', async () => {
  const expected = Array.from({ length: 400 }, (_, index) => Buffer.from([0xf8, index >> 8, index & 255]));
  let generated = 0;
  const raw = source(new Readable({ objectMode: true, highWaterMark: 1, read() {
    this.push(generated < expected.length ? expected[generated++] : null);
  } }));
  const inputs = [];
  const prepared = await prepareAudio(raw, {}, { demuxProbe: packetProbe,
    createAudioResource(stream, options) { inputs.push(options.inputType); return createAudioResource(stream, options); } });
  await turn();
  assert.equal(prepared.pipelineMode, 'native-opus');
  assert.equal(prepared.resource.playStream, prepared.stream);
  assert.equal(prepared.resource.started, true);
  assert.equal(prepared.stream.readableObjectMode, true);
  assert.equal(prepared.resource.silencePaddingFrames, 0);
  assert.ok(prepared.stream.readableLength >= 25 && prepared.stream.readableLength <= 150);
  assert.ok(generated <= 155, `Source generated ${generated} packets while parked`);
  assert.deepEqual(inputs, [StreamType.Opus, StreamType.Opus]);
  const actual = [];
  for await (const packet of prepared.stream) actual.push(packet);
  assert.deepEqual(actual, expected);
  prepared.cleanup();
  prepared.cleanup();
  assert.equal(raw.cleanupCount, 1);
});

test('short complete audio can become ready without inventing padding packets', async () => {
  const expected = [Buffer.from([0xf8, 1]), Buffer.from([0xf8, 2])];
  const raw = source(Readable.from(expected));
  const prepared = await prepareAudio(raw, {}, { demuxProbe: packetProbe });
  const actual = [];
  for await (const packet of prepared.stream) actual.push(packet);
  assert.deepEqual(actual, expected);
  prepared.cleanup();
});

test('non-Opus probe result uses conversion before the final prepared Opus resource', async () => {
  const raw = source(new PassThrough());
  const inputs = [];
  const prepared = await prepareAudio(raw, {}, {
    demuxProbe: async stream => ({ stream, type: StreamType.Arbitrary }),
    createAudioResource(stream, options) {
      inputs.push(options.inputType);
      if (options.inputType === StreamType.Arbitrary) return createAudioResource(Readable.from(Array.from({ length: 30 }, () => Buffer.from([0xf8, 1]))), { inputType: StreamType.Opus });
      return createAudioResource(stream, options);
    },
  });
  assert.deepEqual(inputs, [StreamType.Arbitrary, StreamType.Opus]);
  assert.equal(prepared.pipelineMode, 'transcoded');
  prepared.cleanup();
  assert.equal(raw.cleanupCount, 1);
});

test('packet starvation during preparation times out and releases the source', async () => {
  const raw = source(new PassThrough({ objectMode: true }));
  const promise = prepareAudio(raw, { timeoutMs: 20 }, { demuxProbe: packetProbe });
  raw.stream.write(Buffer.from([0xf8, 1]));
  // Keep the test alive while the production timer deliberately stays unrefed.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(promise, { code: 'MEDIA_TIMEOUT' }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(raw.cleanupCount, 1);
  assert.equal(raw.stream.destroyed, true);
});

test('a source stalled before the probe prefix is complete also times out', async () => {
  const raw = source(new PassThrough());
  const promise = prepareAudio(raw, { timeoutMs: 20 });
  raw.stream.write(Buffer.from('incomplete'));
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(promise, { code: 'MEDIA_TIMEOUT' }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(raw.cleanupCount, 1);
});

test('abort during preparation and after readiness cancels every owned stream', async () => {
  for (const ready of [false, true]) {
    const controller = new AbortController();
    const raw = source(new PassThrough({ objectMode: true }));
    const promise = prepareAudio(raw, { signal: controller.signal }, { demuxProbe: packetProbe });
    for (let i = 0; i < (ready ? 30 : 1); i++) raw.stream.write(Buffer.from([0xf8, i]));
    const prepared = ready ? await promise : null;
    const rejected = ready ? null : assert.rejects(promise, /requested cancellation/);
    controller.abort(new Error('requested cancellation'));
    if (rejected) await rejected;
    prepared?.cleanup();
    await turn();
    assert.equal(raw.cleanupCount, 1);
    assert.equal(raw.stream.destroyed, true);
    if (prepared) assert.equal(prepared.stream.destroyed, true);
  }
});

test('a premature raw close after readiness invalidates the parked packet stream', async () => {
  const raw = source(new PassThrough({ objectMode: true }));
  const promise = prepareAudio(raw, {}, { demuxProbe: packetProbe });
  for (let i = 0; i < 30; i++) raw.stream.write(Buffer.from([0xf8, i]));
  const prepared = await promise;
  const failed = new Promise(resolve => prepared.stream.once('error', resolve));
  raw.stream.destroy();
  assert.equal((await failed).code, 'MEDIA_UNAVAILABLE');
  assert.equal(prepared.stream.destroyed, true);
  prepared.cleanup();
  assert.equal(raw.cleanupCount, 1);
});

test('empty and invalid oversized packets fail before readiness', async () => {
  for (const values of [[], [Buffer.alloc(8193)]]) {
    const raw = source(Readable.from(values));
    await assert.rejects(prepareAudio(raw, {}, { demuxProbe: packetProbe }), error => ['INVALID_MEDIA', 'MEDIA_UNAVAILABLE'].includes(error.code));
    assert.equal(raw.cleanupCount, 1);
  }
});
