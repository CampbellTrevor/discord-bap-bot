import { PassThrough, Transform } from 'node:stream';
import { createAudioResource, demuxProbe, StreamType } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { MediaError } from './media.mjs';
import { opusPacketDurationMs } from './audio-health.mjs';

// Opus packets retain their boundaries. At Discord's 20 ms packet cadence,
// this reservoir holds about three seconds, independently of song length.
const BUFFER_PACKETS = 150;
const READY_PACKETS = 25;
const MAX_PACKET_BYTES = 8192;
const PCM_FRAME_BYTES = 960 * 2 * 2;

async function probeSource(stream) {
  // Probe a copied prefix. The library probe pushes bytes back into its input;
  // that can reorder buffered chunks or fail after a fast source reaches EOF.
  const chunks = [];
  let bytes = 0;
  while (bytes < 4096) {
    if (stream.errored) throw stream.errored;
    if (stream.readableLength) {
      const chunk = stream.read(Math.min(4096 - bytes, stream.readableLength));
      if (chunk) { chunks.push(chunk); bytes += chunk.length; continue; }
    }
    if (stream.readableEnded) break;
    if (stream.destroyed) throw new MediaError('The audio source closed during preparation.', 'MEDIA_UNAVAILABLE');
    await new Promise((resolve, reject) => {
      const clear = () => { stream.off('readable', readable); stream.off('end', readable); stream.off('close', closed); stream.off('error', error); };
      const readable = () => { clear(); resolve(); };
      const error = cause => { clear(); reject(cause); };
      const closed = () => { clear(); stream.readableEnded ? resolve() : reject(new MediaError('The audio source closed during preparation.', 'MEDIA_UNAVAILABLE')); };
      stream.once('readable', readable);
      stream.once('end', readable);
      stream.once('close', closed);
      stream.once('error', error);
      stream.read(0);
    });
  }
  if (!bytes) throw new MediaError('The audio source contained no data.', 'MEDIA_UNAVAILABLE');
  const prefix = Buffer.concat(chunks, bytes);
  const copy = new PassThrough();
  copy.on('error', () => {});
  let type;
  try {
    const detected = demuxProbe(copy, 4096);
    // Padding is only supplied to the disposable detector, never to playback.
    copy.write(bytes < 4096 ? Buffer.concat([prefix, Buffer.alloc(4096 - bytes)]) : prefix);
    ({ type } = await detected);
  } finally { copy.destroy(); }
  const replay = new PassThrough({ highWaterMark: 64 * 1024 });
  replay.on('error', () => {});
  replay.write(prefix);
  stream.pipe(replay);
  return { stream: replay, type };
}

/** Prepare the exact resource that play() will later consume. Owns raw on entry. */
export async function prepareAudio(opened, { signal, timeoutMs = 15_000, volume = 1 } = {}, dependencies = {}) {
  const probe = dependencies.demuxProbe ?? probeSource;
  const resourceFactory = dependencies.createAudioResource ?? createAudioResource;
  let decoded, packets, prepared, probedStream, codec, stopped = false;
  const setVolume = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Volume must be a number from 0 to 1.');
    if (!stopped) volume = value;
  };
  let timer;
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    decoded?.playStream.unpipe(packets);
    decoded?.playStream.destroy();
    if (probedStream !== opened.stream) probedStream?.destroy();
    packets?.destroy();
    try { codec?.delete(); } catch {}
    codec = null;
    opened.cleanup?.();
    opened.stream.destroy();
  };
  const abort = () => {
    const error = signal?.reason instanceof Error ? signal.reason : new MediaError('Audio preparation was cancelled.', 'MEDIA_CANCELLED');
    opened.stream.destroy(error);
    packets?.destroy(error);
  };
  // Keep cancellation and source failure handled while the probe installs its
  // own listeners, then forward later upstream failures to the packet owner.
  const sourceError = error => { if (probedStream !== opened.stream) probedStream?.destroy(error); packets?.destroy(error); };
  opened.stream.on('error', sourceError);
  opened.stream.once('close', () => {
    opened.stream.off('error', sourceError);
    if (!stopped && !opened.stream.readableEnded) sourceError(new MediaError('The audio source closed early.', 'MEDIA_UNAVAILABLE'));
  });
  try {
    setVolume(volume);
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      const error = new MediaError('The audio pipeline did not become ready in time.', 'MEDIA_TIMEOUT');
      opened.stream.destroy(error);
      packets?.destroy(error);
    }, timeoutMs);
    timer.unref?.();
    const result = await probe(opened.stream);
    probedStream = result.stream;
    signal?.throwIfAborted();
    if (opened.stream.destroyed && !opened.stream.readableEnded) throw new MediaError('The audio source closed during preparation.', 'MEDIA_UNAVAILABLE');
    decoded = resourceFactory(result.stream, { inputType: result.type, silencePaddingFrames: 0 });
    packets = new Transform({
      readableObjectMode: true, writableObjectMode: true,
      readableHighWaterMark: BUFFER_PACKETS, writableHighWaterMark: 1,
      transform(packet, _encoding, done) {
        if (!Buffer.isBuffer(packet) || !packet.length || packet.length > MAX_PACKET_BYTES) {
          done(new MediaError('The audio pipeline produced an invalid packet.', 'INVALID_MEDIA'));
          return;
        }
        done(null, packet);
      },
    });
    packets.on('error', () => {});
    decoded.playStream.on('error', error => packets.destroy(error));
    decoded.playStream.once('close', () => {
      if (!decoded.playStream.readableEnded && !packets.destroyed) packets.destroy(new MediaError('The audio pipeline closed early.', 'MEDIA_UNAVAILABLE'));
    });
    prepared = resourceFactory(packets, { inputType: StreamType.Opus, silencePaddingFrames: 0 });
    const ready = new Promise((resolve, reject) => {
      const finish = error => {
        packets.off('readable', inspect);
        packets.off('finish', inspect);
        packets.off('error', finish);
        packets.off('close', closed);
        error ? reject(error) : resolve();
      };
      const inspect = () => {
        // A complete very short recording can contain fewer than 25 packets.
        if (packets.readableLength >= READY_PACKETS || packets.writableFinished && packets.readableLength > 0) finish();
        else if (packets.writableFinished) finish(new MediaError('The audio source contained no playable packets.', 'MEDIA_UNAVAILABLE'));
      };
      const closed = () => finish(new MediaError('The audio pipeline closed before playback.', 'MEDIA_UNAVAILABLE'));
      packets.on('readable', inspect);
      packets.once('finish', inspect);
      packets.once('error', finish);
      packets.once('close', closed);
    });
    decoded.playStream.pipe(packets);
    await ready;
    signal?.throwIfAborted();
    // Allocate the codec before declaring readiness, but keep speculative
    // packets in their original form. Gain is applied only as the player reads
    // each packet, so a live change cannot trail a three-second warm buffer.
    codec = dependencies.createVolumeCodec ? dependencies.createVolumeCodec() : new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    codec.encoderCTL(4010, 5); // OPUS_SET_COMPLEXITY: modest cost for live music.
    codec.encoderCTL(4002, 128000); // OPUS_SET_BITRATE, stereo music.
    const readPacket = prepared.read.bind(prepared);
    prepared.read = () => {
      if (stopped) return null;
      const packet = readPacket();
      if (!packet) return packet;
      try {
        if (opusPacketDurationMs(packet) !== 20) throw new Error('Unsupported packet duration');
        const pcm = codec.decode(packet);
        if (pcm.length !== PCM_FRAME_BYTES) throw new Error('Unexpected decoded frame size');
        if (volume === 0) pcm.fill(0);
        else if (volume !== 1) {
          for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(Math.round(pcm.readInt16LE(offset) * volume), offset);
        }
        // Keep both codec states advancing even at unity/mute. Switching raw
        // and newly encoded packets mid-song can disrupt decoder prediction.
        return codec.encode(pcm, 960);
      } catch {
        // AudioPlayer calls read() from its timer without a try/catch. Route a
        // processing failure through the existing stream error path instead.
        packets.destroy(new MediaError('The audio volume processor could not handle this stream.', 'INVALID_MEDIA'));
        return null;
      }
    };
    clearTimeout(timer);
    // Cancellation remains connected until the resource is cleaned up.
    return { ...opened, stream: packets, resource: prepared,
      pipelineMode: [StreamType.WebmOpus, StreamType.OggOpus, StreamType.Opus].includes(result.type) ? 'opus-gain' : 'transcoded-gain',
      setVolume, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
