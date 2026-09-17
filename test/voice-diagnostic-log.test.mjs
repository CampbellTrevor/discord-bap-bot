import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceDiagnosticLog } from '../src/voice-diagnostic-log.mjs';

function fixture(options = {}) {
  let time = Date.parse('2026-09-17T12:00:00.000Z');
  const lines = [];
  const record = level => (label, value) => {
    assert.equal(label, 'Voice diagnostics.');
    lines.push({ level, ...JSON.parse(value) });
  };
  const log = createVoiceDiagnosticLog({ logger: { info: record('info'), warn: record('warn') },
    guildId: '1331658184070529106', channelId: '1234567890123456789', now: () => time, ...options });
  return { log, lines, advance(ms = 5000) { time += ms; } };
}

test('summaries aggregate interval counters and retain spikes without logging every sample', () => {
  const f = fixture();
  for (let index = 0; index < 6; index++) {
    f.advance();
    f.log.sample({ windowMs: 5000, readAttempts: 250, packetsRead: 250,
      starvedReads: index === 1 ? 3 : 0, emptyReads: index === 1 ? 4 : 0,
      opusInvalid: index === 1 ? 1 : 0, opusMismatch: index === 1 ? 2 : 0,
      voiceStateChanges: index === 1 ? 2 : 0, minBufferedPackets: index === 1 ? 1 : 100,
      maxReadGapMs: index === 1 ? 600 : 21, voiceWsPingMs: index === 1 ? 1000 : 100,
      voiceUdpPingMs: index === 1 ? 300 : 60, udpRttMaxMs: index === 1 ? 500 : 65,
      udpRttJitterMs: index === 1 ? 400 : 5, udpKeepaliveSent: 1, udpKeepaliveReplies: 1,
      udpKeepaliveTimeouts: index === 1 ? 1 : 0, udpKeepalivePending: index === 1 ? 3 : 0,
      udpAudioPackets: 250, udpMaxSendGapMs: index === 1 ? 500 : 21, udpSendErrors: 0,
      udpSendQueueBytes: index === 1 ? 1024 : 0, voiceWsHeartbeatAgeMs: index === 1 ? 32000 : 0,
      udpKeepaliveConfirmed: index === 1 ? 0 : 1 });
    assert.equal(f.lines.length, index === 5 ? 1 : 0);
  }
  const summary = f.lines[0];
  assert.equal(summary.type, 'summary');
  assert.equal(summary.level, 'warn');
  assert.equal(summary.timestamp, '2026-09-17T12:00:30.000Z');
  assert.equal(summary.windowMs, 30000);
  assert.equal(summary.samples, 6);
  assert.equal(summary.packetsRead, 1500);
  assert.equal(summary.starvedReads, 3);
  assert.equal(summary.emptyReads, 4);
  assert.equal(summary.opusInvalid, 1);
  assert.equal(summary.opusMismatch, 2);
  assert.equal(summary.voiceStateChanges, 2);
  assert.equal(summary.minBufferedPackets, 1);
  assert.equal(summary.maxReadGapMs, 600);
  assert.equal(summary.voiceWsPingMs, 250);
  assert.equal(summary.voiceWsPingMaxMs, 1000);
  assert.equal(summary.voiceUdpPingMs, 100);
  assert.equal(summary.voiceUdpPingMaxMs, 300);
  assert.equal(summary.udpRttMaxMs, 500);
  assert.equal(summary.udpRttJitterMs, 400);
  assert.equal(summary.udpKeepaliveSent, 6);
  assert.equal(summary.udpKeepaliveReplies, 6);
  assert.equal(summary.udpKeepaliveTimeouts, 1);
  assert.equal(summary.udpKeepalivePending, 3);
  assert.equal(summary.udpSendQueueBytes, 1024);
  assert.equal(summary.udpKeepaliveConfirmed, 0);
  assert.ok(summary.anomalies.includes('audio-starvation'));
  assert.ok(summary.anomalies.includes('udp-echo-timeout'));
  assert.doesNotMatch(JSON.stringify(summary), /packet.loss/i);
});

test('event floods are bounded and the next summary records the suppressed count', () => {
  const f = fixture();
  for (let index = 0; index < 100; index++) f.log.event({ kind: 'udp-error', errorCode: 'ENETUNREACH' });
  assert.equal(f.lines.length, 12);
  assert.equal(f.lines[0].errorCode, 'ENETUNREACH');
  f.advance(30000);
  f.log.sample({ windowMs: 30000 });
  assert.equal(f.lines.length, 13);
  assert.equal(f.lines[12].suppressedEvents, 88);
  f.log.event({ kind: 'udp-close' });
  assert.equal(f.lines.length, 14);
});

test('only allowlisted scalar fields enter logs and malformed numerics stay unknown', () => {
  const secret = 'secret_token_audio_payload';
  const f = fixture({ guildId: secret, channelId: { secret } });
  f.log.sample({ windowMs: '5000', readAttempts: -1, packetsRead: Infinity, starvedReads: NaN,
    voiceWsPingMs: '123', voiceUdpPingMs: null, udpKeepalivePending: {},
    minBufferedPackets: -1, udpRttMaxMs: -100, maxReadGapMs: BigInt(100),
    udpSendErrors: Number.MAX_VALUE, token: secret, audio: Buffer.from(secret) });
  f.log.event({ kind: secret, errorCode: secret });
  f.log.event({ kind: 'connection-state', previous: secret, status: secret, reason: secret, closeCode: secret, token: secret });
  f.log.event({ kind: 'udp-error', errorCode: secret, message: secret, error: new Error(secret) });
  f.log.event({ kind: 'observer-unavailable', reason: secret });
  f.log.close();
  assert.doesNotMatch(JSON.stringify(f.lines), new RegExp(secret));
  for (const line of f.lines) {
    assert.equal(line.guildId, null);
    assert.equal(line.channelId, null);
  }
  const summary = f.lines.at(-1);
  assert.equal(summary.windowMs, 0);
  assert.equal(summary.packetsRead, null);
  assert.equal(summary.starvedReads, null);
  assert.equal(summary.udpSendErrors, null);
  assert.equal(summary.voiceWsPingMs, null);
  assert.equal(summary.voiceWsPingMaxMs, null);
  assert.equal(summary.voiceUdpPingMs, null);
  assert.equal(summary.udpRttMaxMs, null);
  assert.equal(summary.minBufferedPackets, null);
});

test('close flushes once; logger, clock and input errors cannot break playback callers', () => {
  const f = fixture();
  f.log.sample({ windowMs: 5000, packetsRead: 20 });
  f.log.close(); f.log.close(); f.log.sample({ packetsRead: 20 }); f.log.event({ kind: 'udp-close' });
  assert.equal(f.lines.length, 1);
  assert.equal(f.lines[0].packetsRead, 20);
  const broken = createVoiceDiagnosticLog({ now() { throw new Error('clock failed'); },
    logger: { info() { throw new Error('log failed'); }, warn() { throw new Error('log failed'); } } });
  const malformed = new Proxy({}, { get() { throw new Error('getter failed'); } });
  assert.doesNotThrow(() => {
    broken.sample(malformed); broken.sample(null); broken.sample({ voiceUdpPingMs: 30 });
    broken.event(malformed); broken.event({ kind: 'udp-error', errorCode: 'ENETDOWN' });
    broken.close(); broken.close();
  });
});

test('a final short summary retains anomalies without issuing repeated summary warnings', () => {
  const f = fixture();
  f.advance(30000); f.log.sample({ windowMs: 30000, starvedReads: 5 });
  f.advance(5000); f.log.sample({ windowMs: 5000, starvedReads: 1 });
  f.log.close();
  assert.equal(f.lines.length, 2);
  assert.equal(f.lines[0].level, 'warn');
  assert.equal(f.lines[1].level, 'info');
  assert.deepEqual(f.lines[1].anomalies, ['audio-starvation']);
});

test('connection state, numeric network state and close codes are preserved safely', () => {
  const f = fixture();
  f.log.event({ kind: 'connection-state', previous: 'ready', status: 'disconnected', reason: 3, closeCode: 4015 });
  f.log.event({ kind: 'network-state', previous: 4, status: 5 });
  f.log.event({ kind: 'websocket-close', closeCode: 1006 });
  assert.equal(f.lines[0].previous, 'ready');
  assert.equal(f.lines[0].status, 'disconnected');
  assert.equal(f.lines[0].reason, 3);
  assert.equal(f.lines[0].closeCode, 4015);
  assert.equal(f.lines[1].previous, 4);
  assert.equal(f.lines[1].status, 5);
  assert.equal(f.lines[2].closeCode, 1006);
});

test('stateful getters cannot substitute unvalidated objects after allowlist checks', () => {
  const f = fixture();
  let kindReads = 0, statusReads = 0;
  f.log.event({ get kind() { return ++kindReads === 1 ? 'connection-state' : 'secret'; },
    previous: 'ready', get status() { return ++statusReads === 1 ? 'disconnected' : { token: 'secret' }; } });
  assert.equal(kindReads, 1);
  assert.equal(statusReads, 1);
  assert.equal(f.lines[0].type, 'connection-state');
  assert.equal(f.lines[0].status, 'disconnected');
  assert.doesNotMatch(JSON.stringify(f.lines), /secret/);
});

test('unobserved transport counters stay null and heartbeat age alone is not a failure', () => {
  const f = fixture();
  f.log.sample({ packetsRead: 0, udpSendErrors: 0, voiceWsHeartbeatAgeMs: 41250 });
  f.log.close();
  const summary = f.lines[0];
  assert.equal(summary.packetsRead, 0);
  assert.equal(summary.udpSendErrors, 0);
  assert.equal(summary.udpKeepaliveTimeouts, null);
  assert.equal(summary.udpAudioPackets, null);
  assert.equal(summary.voiceWsHeartbeatAgeMs, 41250);
  assert.equal(summary.level, 'info');
  assert.deepEqual(summary.anomalies, []);
});
