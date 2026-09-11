import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { StreamType, createAudioResource } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { prepareAudio } from '../src/audio-pipeline.mjs';
import { opusPacketDurationMs } from '../src/audio-health.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
function source(stream) {
  const opened = { stream, cleanupCount: 0, cleanup() { this.cleanupCount++; stream.destroy(); } };
  return opened;
}
const packetProbe = async stream => ({ stream, type: StreamType.Opus });

function tonePackets(count) {
  const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const pcm = Buffer.alloc(960 * 2 * 2);
  for (let sample = 0; sample < 960; sample++) {
    const amplitude = Math.round(12000 * Math.sin(2 * Math.PI * 1000 * sample / 48000));
    pcm.writeInt16LE(amplitude, sample * 4);
    pcm.writeInt16LE(amplitude, sample * 4 + 2);
  }
  try { return Array.from({ length: count }, () => encoder.encode(pcm, 960)); }
  finally { encoder.delete(); }
}

function pcmRms(pcm) {
  let squares = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) squares += pcm.readInt16LE(offset) ** 2;
  return Math.sqrt(squares / (pcm.length / 2));
}

async function readFrames(prepared, decoder, count) {
  const frames = [];
  for (let attempt = 0; frames.length < count && attempt < count + 100; attempt++) {
    const packet = prepared.resource.read();
    if (!packet) { await turn(); continue; }
    assert.equal(opusPacketDurationMs(packet), 20);
    const pcm = decoder.decode(packet);
    assert.equal(pcm.length, 3840);
    frames.push(pcmRms(pcm));
  }
  assert.equal(frames.length, count, 'Resource supplies every requested 20 ms frame');
  return frames;
}

test('real Opus gain produces mute, half and unity amplitude while preserving packet cadence', async () => {
  const input = tonePackets(60);
  const results = [];
  for (const volume of [0, 0.5, 1]) {
    const raw = source(Readable.from(input));
    const prepared = await prepareAudio(raw, { volume }, { demuxProbe: packetProbe });
    const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    try {
      const rms = await readFrames(prepared, decoder, input.length);
      results.push(rms.slice(10).reduce((sum, value) => sum + value, 0) / (rms.length - 10));
      assert.equal(prepared.resource.read(), null, 'Gain adds no padding or packets');
    } finally { prepared.cleanup(); decoder.delete(); }
    assert.equal(raw.cleanupCount, 1);
  }
  assert.ok(results[0] <= 1, `Mute RMS ${results[0]}`);
  assert.ok(results[2] > 7000 && results[2] < 9500, `Unity RMS ${results[2]}`);
  assert.ok(results[1] / results[2] > 0.47 && results[1] / results[2] < 0.53, `Half/unity ratio ${results[1] / results[2]}`);
});

test('parked and active resources apply live gain after the reservoir without changing resource identity', async () => {
  const raw = source(Readable.from(tonePackets(240)));
  const prepared = await prepareAudio(raw, {}, { demuxProbe: packetProbe });
  const resource = prepared.resource;
  const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  try {
    await turn();
    assert.equal(prepared.stream.readableLength, 150);
    prepared.setVolume(0.5);
    const half = await readFrames(prepared, decoder, 20);
    assert.ok(half.at(-1) > 3500 && half.at(-1) < 4800, `Parked source starts at half: ${half.at(-1)}`);
    prepared.setVolume(1);
    const unity = await readFrames(prepared, decoder, 5);
    assert.ok(unity[1] > 7000, `Unity applies within two frames: ${unity}`);
    prepared.setVolume(0.5);
    const lowered = await readFrames(prepared, decoder, 5);
    assert.ok(lowered[1] < 5000, `Lower gain applies within two frames: ${lowered}`);
    prepared.setVolume(0);
    const muted = await readFrames(prepared, decoder, 8);
    assert.ok(muted.slice(1).every(rms => rms < 20), `Mute falls below -60 dBFS after one frame of codec lookahead: ${muted}`);
    prepared.setVolume(0.5);
    const unmuted = await readFrames(prepared, decoder, 8);
    assert.ok(unmuted.slice(2).every(rms => rms > 3500 && rms < 5000), `Unmute stays at half gain: ${unmuted}`);
    assert.equal(prepared.resource, resource);
    assert.ok(prepared.stream.readableLength >= 100, 'Changes did not drain or replace the warm reservoir');
  } finally { prepared.cleanup(); decoder.delete(); }
});

test('gain codecs remain idle while parked, validate setters, and are released exactly once', async () => {
  const raw = source(Readable.from(tonePackets(30)));
  const calls = { decode: 0, encode: 0, delete: 0 };
  const codec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  const prepared = await prepareAudio(raw, { volume: 0.5 }, { demuxProbe: packetProbe,
    createVolumeCodec: () => ({
      encoderCTL: (...args) => codec.encoderCTL(...args),
      decode: packet => { calls.decode++; return codec.decode(packet); },
      encode: (...args) => { calls.encode++; return codec.encode(...args); },
      delete: () => { calls.delete++; codec.delete(); },
    }),
  });
  assert.deepEqual(calls, { decode: 0, encode: 0, delete: 0 });
  for (const invalid of [-0.01, 1.01, NaN, Infinity, '0.5', undefined]) assert.throws(() => prepared.setVolume(invalid), RangeError);
  prepared.setVolume(0);
  assert.ok(Buffer.isBuffer(prepared.resource.read()));
  prepared.cleanup();
  prepared.cleanup();
  assert.doesNotThrow(() => prepared.setVolume(0.5));
  assert.equal(prepared.resource.read(), null, 'A cleaned resource cannot emit unattenuated buffered audio');
  assert.deepEqual(calls, { decode: 1, encode: 1, delete: 1 });
  assert.equal(raw.cleanupCount, 1);
});

test('gain processing failures use stream errors instead of escaping the player timer', async () => {
  for (const failingStage of ['decode', 'encode', 'duration']) {
    const raw = source(Readable.from(failingStage === 'duration' ? Array.from({ length: 30 }, () => Buffer.from([0x80, 0])) : tonePackets(30)));
    let released = 0;
    const prepared = await prepareAudio(raw, {}, { demuxProbe: packetProbe,
      createVolumeCodec: () => ({
        encoderCTL() {},
        decode() { if (failingStage === 'decode') throw new Error('codec detail'); return Buffer.alloc(3840); },
        encode() { throw new Error('codec detail'); },
        delete() { released++; },
      }),
    });
    const failed = new Promise(resolve => prepared.stream.once('error', resolve));
    assert.doesNotThrow(() => assert.equal(prepared.resource.read(), null));
    const error = await failed;
    assert.equal(error.code, 'INVALID_MEDIA');
    assert.doesNotMatch(error.message, /codec detail/);
    prepared.cleanup();
    assert.equal(released, 1);
    assert.equal(raw.cleanupCount, 1);
  }
});

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
  assert.equal(prepared.pipelineMode, 'opus-gain');
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
  assert.equal(prepared.pipelineMode, 'opus-gain');
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
  assert.equal(prepared.pipelineMode, 'transcoded-gain');
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
