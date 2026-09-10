import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rmdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMedia, isPermanentMediaError, MediaError } from '../src/media.mjs';

const VIDEO = 'abcdefghijk';
const TRACK = '1234567890abcdefghijkl';
const youtube = { id: VIDEO, title: 'A song', uploader: 'An artist', duration: 120 };
const spotify = { id: TRACK, type: 'track', name: 'A song', artists: [{ name: 'An artist' }], duration_ms: 120_000, album: { images: [{ url: 'https://i.scdn.co/image/example' }] } };
const spotifyConfig = { spotifyClientId: 'test-client', spotifyClientSecret: 'test-secret' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function extractor(scenarios = []) {
  const calls = [];
  const stopped = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 1000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    calls.push({ command, args, options, child });
    const scenario = scenarios.shift();
    if (scenario) queueMicrotask(() => scenario(child));
    return child;
  };
  const terminate = child => {
    stopped.push(child);
    child.stdout.destroy();
    child.stderr.destroy();
    child.emit('close', null);
  };
  return { spawn, terminate, calls, stopped, logger: { warn() {} } };
}

const metadata = value => child => {
  child.stdout.end(JSON.stringify(value));
  child.stderr.end();
  setImmediate(() => child.emit('close', 0));
};

test('provider errors carry safe HTTP statuses for portal and Discord responses', () => {
  for (const code of ['INVALID_QUERY', 'UNSUPPORTED_MEDIA', 'INVALID_MEDIA', 'TRACK_TOO_LONG', 'SPOTIFY_NOT_FOUND', 'NO_PLAYBACK_MATCH', 'YOUTUBE_VIDEO_UNAVAILABLE']) {
    assert.equal(new MediaError('Please choose another track.', code).status, 400);
  }
  for (const code of ['MEDIA_TIMEOUT', 'MEDIA_BUSY', 'EXTRACTOR_UNAVAILABLE', 'YOUTUBE_UNAVAILABLE', 'SPOTIFY_NOT_CONFIGURED', 'SPOTIFY_QUOTA_EXCEEDED']) {
    assert.equal(new MediaError('Please try again later.', code).status, 503);
  }
});

test('canonicalizes YouTube links and ignores playlist tracking parameters', async () => {
  const fake = extractor([metadata(youtube)]);
  const media = createMedia({}, fake);
  const [track] = await media.resolve(`https://youtu.be/${VIDEO}?list=ignored&si=tracking`);
  assert.equal(track.source, 'youtube');
  assert.equal(track.sourceUrl, `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.equal(track.durationSec, 120);
  assert.equal(fake.calls[0].args.at(-1), track.sourceUrl);
  assert.equal(fake.calls[0].args.at(-2), '--');
  assert.equal(fake.calls[0].options.shell, false);
  assert.ok(fake.calls[0].args.includes('--ignore-config'));
  assert.ok(fake.calls[0].args.includes('--no-playlist'));
});

test('song searches are one literal ytsearch argument, never shell commands', async () => {
  const fake = extractor([metadata({ entries: [youtube] }), metadata(youtube)]);
  const query = 'Artist; song name --help';
  const [track] = await createMedia({}, fake).resolve(query);
  assert.equal(track.title, 'A song');
  assert.equal(fake.calls[0].args.at(-1), `ytsearch10:${query}`);
  assert.equal(fake.calls[0].options.shell, false);
});

test('rejects unsupported URLs, malformed playlist links, invalid IDs and control characters before network access', async () => {
  const fake = extractor();
  const media = createMedia({}, { ...fake, fetch: () => assert.fail('No network calls expected') });
  for (const input of [
    'http://127.0.0.1/private', 'file:///tmp/audio', 'https://youtube.com.example.org/watch?v=abcdefghijk',
    'https://user:password@youtube.com/watch?v=abcdefghijk', 'https://youtube.com:1234/watch?v=abcdefghijk',
    'https://youtube.com/playlist?list=example', 'https://youtu.be/short',
    `https://open.spotify.com/album/${TRACK}`, `spotify:album:${TRACK}`, 'song\nname', '',
  ]) await assert.rejects(media.resolve(input), error => ['INVALID_QUERY', 'UNSUPPORTED_MEDIA'].includes(error.code));
  assert.equal(fake.calls.length, 0);
});

test('rejects long tracks, live streams, and unknown durations', async () => {
  for (const entry of [{ ...youtube, duration: 601 }, { ...youtube, is_live: true }, { ...youtube, duration: null }]) {
    const media = createMedia({ maxTrackDurationSec: 600 }, extractor([metadata(entry)]));
    await assert.rejects(media.resolve(`https://youtu.be/${VIDEO}`), error => ['TRACK_TOO_LONG', 'UNSUPPORTED_MEDIA'].includes(error.code));
  }
});

test('the default duration limit accepts exactly one hour and rejects longer direct links', async () => {
  const fake = extractor([metadata({ ...youtube, duration: 3600 }), metadata({ ...youtube, duration: 3601 })]);
  const media = createMedia({}, fake);
  const [track] = await media.resolve(`https://youtu.be/${VIDEO}`);
  assert.equal(track.durationSec, 3600);
  await assert.rejects(media.resolve(`https://youtu.be/${VIDEO}`), { code: 'TRACK_TOO_LONG' });
  assert.equal(fake.calls.length, 2);
  assert.ok(fake.calls.every(call => call.args.includes('--skip-download')));
});

test('opening accepts a one-hour track and rejects 3601 seconds before starting audio', async () => {
  const fake = extractor([child => child.stdout.write('audio prefix')]);
  const media = createMedia({}, fake);
  const track = { source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`, durationSec: 3600 };
  const opened = await media.open(track);
  try {
    assert.equal(opened.stream.read().toString(), 'audio prefix');
    await assert.rejects(media.open({ ...track, durationSec: 3601 }), { code: 'TRACK_TOO_LONG' });
    assert.equal(fake.calls.length, 1);
  } finally { opened.cleanup(); }
});

test('unknown playlist durations enforce the same one-hour boundary before audio begins', async () => {
  for (const duration of [3600, 3601]) {
    const fake = extractor([metadata({ ...youtube, duration }), child => child.stdout.write('audio prefix')]);
    const media = createMedia({}, fake);
    const track = { source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`, durationSec: null, needsValidation: true };
    if (duration === 3601) {
      await assert.rejects(media.open(track), { code: 'TRACK_TOO_LONG' });
      assert.equal(fake.calls.length, 1, 'Overlong playlist entries never start an audio extractor.');
    } else {
      const opened = await media.open(track);
      try {
        assert.equal(opened.track.durationSec, 3600);
        assert.equal(opened.track.needsValidation, false);
        assert.equal(fake.calls.length, 2);
      } finally { opened.cleanup(); }
    }
  }
});

test('rejects malformed provider metadata', async () => {
  for (const entry of [null, { entries: [] }, { ...youtube, id: '../../other' }]) {
    await assert.rejects(createMedia({}, extractor([metadata(entry)])).resolve('song'), error => ['INVALID_MEDIA', 'NO_PLAYBACK_MATCH'].includes(error.code));
  }
});

test('bounds metadata output and terminates timed-out extractors', async () => {
  const oversized = extractor([child => child.stdout.write(Buffer.alloc(1024 * 1024 + 1))]);
  await assert.rejects(createMedia({}, oversized).resolve('song'), { code: 'INVALID_MEDIA' });
  assert.equal(oversized.stopped.length, 1);
  const stalled = extractor();
  await assert.rejects(createMedia({}, { ...stalled, resolveTimeoutMs: 15 }).resolve('song'), { code: 'MEDIA_TIMEOUT' });
  assert.equal(stalled.stopped.length, 1);
});

test('caps concurrent extractors and cancellation releases capacity', async () => {
  const fake = extractor();
  const media = createMedia({}, fake);
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map(controller => assert.rejects(media.resolve('song', { signal: controller.signal }), /cancelled/));
  await assert.rejects(media.resolve('fifth song'), { code: 'MEDIA_BUSY' });
  for (const controller of controllers) controller.abort(new Error('cancelled'));
  await Promise.all(pending);
  assert.equal(fake.stopped.length, 4);
  assert.equal(fake.calls.length, 4);
});

test('full initial capacity marks open as retryable without starting provider work', async () => {
  const fake = extractor();
  const media = createMedia({}, fake);
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map(controller => assert.rejects(
    media.resolve(`https://youtu.be/${VIDEO}`, { signal: controller.signal }), /test cleanup/));
  try {
    await assert.rejects(media.open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
      title: 'A song', artist: 'An artist', durationSec: 120 }), error => {
      assert.equal(error.code, 'MEDIA_BUSY');
      assert.equal(error.retryableBeforeStart, true);
      assert.equal(Object.keys(error).includes('retryableBeforeStart'), false);
      return true;
    });
    assert.equal(fake.calls.length, 4, 'No search, validation, or audio extractor was started.');
  } finally {
    for (const controller of controllers) controller.abort(new Error('test cleanup'));
    await Promise.all(pending);
  }
});

test('capacity lost after metadata validation is not marked safe to retry provider work', async () => {
  const controllers = [];
  const pending = [];
  let media;
  const occupy = () => {
    const controller = new AbortController();
    controllers.push(controller);
    pending.push(assert.rejects(media.resolve(`https://youtu.be/${VIDEO}`, { signal: controller.signal }), /test cleanup/));
  };
  const fake = extractor([undefined, undefined, undefined, child => {
    metadata(youtube)(child);
    // Refill the released metadata slot before open resumes to start audio.
    child.once('close', occupy);
  }]);
  media = createMedia({}, fake);
  for (let index = 0; index < 3; index++) occupy();
  try {
    await assert.rejects(media.open({ source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`,
      durationSec: null, needsValidation: true }), error => {
      assert.equal(error.code, 'MEDIA_BUSY');
      assert.equal(error.retryableBeforeStart, undefined);
      return true;
    });
    assert.equal(fake.calls.length, 5);
    assert.ok(fake.calls.every(call => call.args.includes('--skip-download')));
  } finally {
    for (const controller of controllers) controller.abort(new Error('test cleanup'));
    await Promise.all(pending);
  }
});

test('reports missing yt-dlp and provider restrictions without exposing stderr', async () => {
  const missing = extractor([child => child.emit('error', new Error('ENOENT'))]);
  await assert.rejects(createMedia({}, missing).resolve('song'), { code: 'EXTRACTOR_UNAVAILABLE' });
  const denied = extractor([child => { child.stderr.write('Sign in to confirm you are not a bot; diagnostic text'); child.emit('close', 1); }]);
  await assert.rejects(createMedia({}, denied).resolve('song'), error => error.code === 'YOUTUBE_REQUEST_BLOCKED' && !error.message.includes('diagnostic text'));
});

test('Spotify uses client credentials, preserves source metadata and caches tracks', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? json({ access_token: 'test-token', expires_in: 3600 }) : json(spotify);
  };
  const media = createMedia(spotifyConfig, { fetch });
  const [track] = await media.resolve(`https://open.spotify.com/intl-en/track/${TRACK}?si=tracking`);
  assert.equal(track.source, 'spotify');
  assert.equal(track.playbackUrl, undefined);
  assert.equal(track.searchQuery, 'A song An artist official audio');
  assert.equal(calls[0].url, 'https://accounts.spotify.com/api/token');
  assert.equal(calls[0].options.body, 'grant_type=client_credentials');
  assert.equal(calls[1].url, `https://api.spotify.com/v1/tracks/${TRACK}`);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[1].options.redirect, 'error');
  track.title = 'changed by caller';
  const [cached] = await media.resolve(`spotify:track:${TRACK}`);
  assert.equal(cached.title, 'A song');
  assert.equal(calls.length, 2);
});

test('Spotify is optional and missing credentials fail explicitly', async () => {
  const media = createMedia({}, { fetch: () => assert.fail('No network calls expected') });
  await assert.rejects(media.resolve(`spotify:track:${TRACK}`), { code: 'SPOTIFY_NOT_CONFIGURED' });
});

test('recognizes July 2026 shared Spotify quota responses and ordinary rate limits', async () => {
  for (const reason of ['QUOTA_EXCEEDED', undefined]) {
    let calls = 0;
    const media = createMedia(spotifyConfig, { fetch: async () => ++calls === 1 ? json({ access_token: 'test-token', expires_in: 3600 }) : json({ error: { status: 429, reason } }, 429) });
    await assert.rejects(media.resolve(`spotify:track:${TRACK}`), { code: reason ? 'SPOTIFY_QUOTA_EXCEEDED' : 'SPOTIFY_RATE_LIMITED' });
    assert.equal(calls, 2);
  }
});

test('refreshes rejected Spotify tokens once and reports access errors', async () => {
  const responses = [json({ access_token: 'old-token', expires_in: 3600 }), json({ error: { status: 401 } }, 401), json({ access_token: 'new-token', expires_in: 3600 }), json(spotify)];
  const media = createMedia(spotifyConfig, { fetch: async () => responses.shift() });
  const [track] = await media.resolve(`spotify:track:${TRACK}`);
  assert.equal(track.title, 'A song');
  assert.equal(responses.length, 0);
  const forbidden = createMedia(spotifyConfig, { fetch: async () => json({ error: { status: 403 } }, 403) });
  await assert.rejects(forbidden.resolve(`spotify:track:${TRACK}`), { code: 'SPOTIFY_FORBIDDEN' });
});

test('Spotify metadata response size is bounded', async () => {
  const media = createMedia(spotifyConfig, { fetch: async () => json({ oversized: 'x'.repeat(1024 * 1024) }) });
  await assert.rejects(media.resolve(`spotify:track:${TRACK}`), { code: 'SPOTIFY_UNAVAILABLE' });
});

test('open returns all first audio bytes and idempotent cleanup terminates its extractor', async () => {
  const audio = Buffer.from('original audio bytes');
  const fake = extractor([child => child.stdout.write(audio)]);
  const media = createMedia({}, fake);
  const opened = await media.open({ source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`, durationSec: 120 });
  assert.deepEqual(opened.stream.read(), audio);
  assert.equal(fake.calls[0].args.at(-1), `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.ok(fake.calls[0].args.includes('bestaudio[acodec=opus][asr=48000]/bestaudio/best'));
  opened.cleanup();
  opened.cleanup();
  assert.equal(fake.stopped.length, 1);
  assert.ok(opened.stream.destroyed);
});

test('open resolves Spotify to a YouTube match at playback time', async () => {
  const fake = extractor([metadata({ entries: [youtube] }), metadata(youtube), child => child.stdout.write('audio')]);
  const media = createMedia({}, fake);
  const opened = await media.open({ source: 'spotify', sourceUrl: `https://open.spotify.com/track/${TRACK}`, title: 'A song', artist: 'An artist', durationSec: 120 });
  assert.equal(fake.calls[0].args.at(-1), 'ytsearch10:A song An artist official audio');
  assert.equal(fake.calls[1].args.at(-1), `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.equal(fake.calls[2].args.at(-1), `https://www.youtube.com/watch?v=${VIDEO}`);
  opened.cleanup();
});

test('audio startup timeouts and cancellation terminate active processes', async () => {
  const stalled = extractor();
  const track = { source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`, durationSec: 120 };
  await assert.rejects(createMedia({}, { ...stalled, startupTimeoutMs: 15 }).open(track), { code: 'MEDIA_TIMEOUT' });
  assert.equal(stalled.stopped.length, 1);
  const fake = extractor([child => child.stdout.write('audio')]);
  const controller = new AbortController();
  const opened = await createMedia({}, fake).open(track, { signal: controller.signal });
  controller.abort(new Error('cancelled by skip'));
  assert.ok(opened.stream.destroyed);
  assert.equal(fake.stopped.length, 1);
});

test('a failed stream startup rejects and stale cleanup never kills an exited process', async () => {
  const track = { source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`, durationSec: 120 };
  const denied = extractor([child => { child.stderr.write('Video unavailable'); child.emit('close', 1); }]);
  await assert.rejects(createMedia({}, denied).open(track), { code: 'YOUTUBE_VIDEO_UNAVAILABLE' });
  const finished = extractor([child => child.stdout.write('audio')]);
  const opened = await createMedia({}, finished).open(track);
  finished.calls[0].child.emit('close', 0);
  opened.cleanup();
  assert.equal(finished.stopped.length, 0);
});

const PLAYLIST = 'PLabcdefghijk123456789';
const video = (index, overrides = {}) => ({ ...youtube, id: String(index).padStart(11, '0'), title: `Song ${index}`, ...overrides });
const spotifyItem = (index, overrides = {}) => ({ ...spotify, id: String(index).padStart(22, '0'), name: `Track ${index}`, ...overrides });

test('imports YouTube playlist entries in order with skipped, deferred and truncation counts', async () => {
  const fake = extractor([metadata({ title: 'Our playlist', playlist_count: 8, entries: [video(1), video(2, { title: '[Private video]' }), video(3, { duration: null }), video(4)] })]);
  const media = createMedia({ maxPlaylistTracks: 3 }, fake);
  const tracks = await media.resolve(`https://music.youtube.com/playlist?list=${PLAYLIST}&si=tracking`);
  assert.deepEqual(tracks.map(track => track.title), ['Song 1', 'Song 3']);
  assert.equal(tracks[0].needsValidation, true);
  assert.equal(tracks[1].durationSec, null);
  assert.deepEqual({ ...tracks.import, warnings: [] }, { source: 'youtube', title: 'Our playlist', total: 8, inspected: 3, accepted: 2, skipped: 1, limitReached: true, warnings: [] });
  assert.equal(tracks.import.warnings.length, 3);
  assert.match(tracks.import.warnings.join(' '), /Skipped 1/);
  assert.match(tracks.import.warnings.join(' '), /first 3/);
  assert.match(tracks.import.warnings.join(' '), /unknown duration/);
  const args = fake.calls[0].args;
  assert.equal(args.at(-1), `https://www.youtube.com/playlist?list=${PLAYLIST}`);
  assert.ok(args.includes('--yes-playlist'));
  assert.ok(args.includes('--flat-playlist'));
  assert.ok(args.includes('--lazy-playlist'));
  assert.ok(!args.includes('--no-playlist'));
  assert.equal(args[args.indexOf('--playlist-items') + 1], '1:4');
});

test('YouTube watch URLs with a playlist parameter still resolve just one video', async () => {
  const fake = extractor([metadata(youtube)]);
  const tracks = await createMedia({}, fake).resolve(`https://www.youtube.com/watch?v=${VIDEO}&list=${PLAYLIST}`);
  assert.equal(tracks.length, 1);
  assert.equal(tracks.import, undefined);
  assert.equal(fake.calls[0].args.at(-1), `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.ok(!fake.calls[0].args.includes('--flat-playlist'));
});

test('rejects malformed playlist IDs before any provider access', async () => {
  const fake = extractor();
  const media = createMedia({}, { ...fake, fetch: () => assert.fail('No provider request expected') });
  for (const query of ['https://youtube.com/playlist?list=short', 'https://youtube.com/playlist?list=PLvalidvalue%2Fmore', 'https://youtube.com/playlist?list=PLvalidvalue%26more', 'https://open.spotify.com/playlist/not-a-valid-id', 'spotify:playlist:short']) {
    await assert.rejects(media.resolve(query), error => ['INVALID_QUERY', 'UNSUPPORTED_MEDIA'].includes(error.code));
  }
  assert.equal(fake.calls.length, 0);
  for (const value of [0, 101, 1.5]) assert.throws(() => createMedia({ maxPlaylistTracks: value }), /maxPlaylistTracks/);
});

test('skips unavailable, deleted, live, overlong and non-video YouTube entries', async () => {
  const entries = [video(1), null, video(2, { title: '[Deleted video]' }), video(3, { is_live: true }), video(4, { duration: 601 }), video(5, { availability: 'needs_auth' }), video(6, { ie_key: 'OtherSite' }), video(7, { id: 'bad' })];
  const fake = extractor([metadata({ entries })]);
  const tracks = await createMedia({ maxTrackDurationSec: 600 }, fake).resolve(`https://youtube.com/playlist?list=${PLAYLIST}`);
  assert.equal(tracks.length, 1);
  assert.equal(tracks.import.skipped, 7);
  assert.equal(tracks.import.inspected, 8);
  assert.equal(tracks.import.total, 8);
  assert.equal(tracks.import.limitReached, false);
});

test('YouTube truncation with no provider total does not invent a total count', async () => {
  const fake = extractor([metadata({ entries: [video(1), video(2), video(3)] })]);
  const tracks = await createMedia({ maxPlaylistTracks: 2 }, fake).resolve(`https://youtube.com/playlist?list=${PLAYLIST}`);
  assert.equal(tracks.import.total, null);
  assert.equal(tracks.import.limitReached, true);
});

test('empty or entirely skipped playlists return explicit counts without a partial queue result', async () => {
  for (const entries of [[], [null, video(1, { title: '[Private video]' })]]) {
    const fake = extractor([metadata({ entries })]);
    await assert.rejects(createMedia({}, fake).resolve(`https://youtube.com/playlist?list=${PLAYLIST}`), error => error.code === 'EMPTY_PLAYLIST' && error.status === 400 && error.import.inspected === entries.length && error.import.skipped === entries.length);
  }
});

test('playlist resolution has a bounded deadline and metadata output', async () => {
  const fake = extractor();
  await assert.rejects(createMedia({}, { ...fake, playlistTimeoutMs: 15 }).resolve(`https://youtube.com/playlist?list=${PLAYLIST}`), { code: 'MEDIA_TIMEOUT' });
  assert.equal(fake.stopped.length, 1);
  const oversized = extractor([child => child.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1))]);
  await assert.rejects(createMedia({}, oversized).resolve(`https://youtube.com/playlist?list=${PLAYLIST}`), { code: 'INVALID_MEDIA' });
  assert.equal(oversized.stopped.length, 1);
});

test('unknown-duration playlist tracks are validated before audio and return corrected metadata', async () => {
  const fake = extractor([metadata({ entries: [video(1, { duration: null })] }), metadata(video(1, { title: 'Validated title', duration: 183 })), child => child.stdout.write('audio')]);
  const media = createMedia({}, fake);
  const [track] = await media.resolve(`https://youtube.com/playlist?list=${PLAYLIST}`);
  const opened = await media.open(track);
  assert.equal(opened.track.durationSec, 183);
  assert.equal(opened.track.title, 'Validated title');
  assert.equal(opened.track.needsValidation, false);
  assert.ok(fake.calls[1].args.includes('--dump-single-json'));
  assert.ok(fake.calls[2].args.includes('bestaudio[acodec=opus][asr=48000]/bestaudio/best'));
  opened.cleanup();
});

test('playlist playback validation rejects live or overlong tracks before starting an audio process', async () => {
  for (const info of [video(1, { duration: 601 }), video(1, { is_live: true })]) {
    const fake = extractor([metadata(info)]);
    const media = createMedia({ maxTrackDurationSec: 600 }, fake);
    await assert.rejects(media.open({ source: 'youtube', sourceUrl: `https://youtu.be/${info.id}`, durationSec: null, needsValidation: true }), error => ['TRACK_TOO_LONG', 'UNSUPPORTED_MEDIA'].includes(error.code));
    assert.equal(fake.calls.length, 1);
  }
});

test('open never accepts a playlist as a single playback URL', async () => {
  const fake = extractor();
  const media = createMedia({}, fake);
  await assert.rejects(media.open({ source: 'youtube', sourceUrl: `https://youtube.com/playlist?list=${PLAYLIST}`, durationSec: 120 }), { code: 'INVALID_MEDIA' });
  await assert.rejects(media.open({ source: 'spotify', sourceUrl: `https://open.spotify.com/playlist/${TRACK}`, durationSec: 120 }), { code: 'INVALID_MEDIA' });
  assert.equal(fake.calls.length, 0);
});

test('Spotify playlist pagination preserves order and constructs canonical offset URLs', async () => {
  const calls = [];
  const responses = [json({ access_token: 'test-user-token', expires_in: 3600 }), json({ name: 'Spotify list' }), json({ offset: 0, total: 5, next: 'https://untrusted.example/ignored', items: [{ item: spotifyItem(1) }, { track: spotifyItem(2) }] }), json({ offset: 2, total: 5, next: 'https://untrusted.example/also-ignored', items: [{ item: spotifyItem(3) }, { track: spotifyItem(4) }] })];
  const media = createMedia({ ...spotifyConfig, spotifyRefreshToken: 'test-refresh', maxPlaylistTracks: 3 }, { fetch: async (url, options) => { calls.push({ url, options }); return responses.shift(); } });
  const tracks = await media.resolve(`spotify:playlist:${TRACK}`);
  assert.deepEqual(tracks.map(track => track.title), ['Track 1', 'Track 2', 'Track 3']);
  assert.equal(tracks.import.title, 'Spotify list');
  assert.equal(tracks.import.total, 5);
  assert.equal(tracks.import.limitReached, true);
  assert.equal(tracks.import.accepted, 3);
  assert.equal(tracks.import.skipped, 0);
  const grant = new URLSearchParams(calls[0].options.body);
  assert.equal(grant.get('grant_type'), 'refresh_token');
  assert.equal(grant.get('client_id'), spotifyConfig.spotifyClientId);
  assert.equal(grant.get('refresh_token'), 'test-refresh');
  assert.equal(calls[2].url, `https://api.spotify.com/v1/playlists/${TRACK}/items?limit=4&offset=0&market=US`);
  assert.equal(calls[3].url, `https://api.spotify.com/v1/playlists/${TRACK}/items?limit=2&offset=2&market=US`);
  assert.equal(calls[3].options.headers.Authorization, 'Bearer test-user-token');
  assert.equal(responses.length, 0);
});

test('Spotify pagination imports up to100 entries with at most50 per API page', async () => {
  const calls = [];
  const media = createMedia({ ...spotifyConfig, maxPlaylistTracks: 100, spotifyMarket: 'CA' }, { fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/api/token')) return json({ access_token: 'test-token', expires_in: 3600 });
    if (url.includes('fields=name')) return json({ name: 'Long playlist' });
    const params = new URL(url).searchParams;
    assert.equal(params.get('limit'), '50');
    assert.equal(params.get('market'), 'CA');
    const offset = Number(params.get('offset'));
    return json({ offset, total: 100, next: offset === 0 ? 'more' : null, items: Array.from({ length: 50 }, (_, index) => ({ item: spotifyItem(offset + index) })) });
  } });
  const tracks = await media.resolve(`https://open.spotify.com/playlist/${TRACK}`);
  assert.equal(tracks.length, 100);
  assert.equal(tracks[99].title, 'Track 99');
  assert.equal(tracks.import.limitReached, false);
  assert.equal(calls.length, 4);
});

test('Spotify skips episodes, local files, missing, unavailable and overlong entries', async () => {
  const items = [{ item: spotifyItem(1) }, { item: null }, { track: spotifyItem(2, { type: 'episode' }) }, { is_local: true, item: spotifyItem(3) }, { item: spotifyItem(4, { is_local: true }) }, { item: spotifyItem(5, { is_playable: false }) }, { item: spotifyItem(6, { restrictions: { reason: 'market' } }) }, { item: spotifyItem(7, { duration_ms: 601_000 }) }, { item: spotifyItem(8, { id: 'bad' }) }];
  const media = createMedia({ ...spotifyConfig, maxTrackDurationSec: 600 }, { fetch: async url => url.includes('/api/token') ? json({ access_token: 'test-token', expires_in: 3600 }) : url.includes('fields=name') ? json({ name: 'Mixed list' }) : json({ offset: 0, total: items.length, next: null, items }) });
  const tracks = await media.resolve(`https://open.spotify.com/playlist/${TRACK}`);
  assert.deepEqual(tracks.map(track => track.title), ['Track 1']);
  assert.equal(tracks.import.inspected, 9);
  assert.equal(tracks.import.skipped, 8);
  assert.match(tracks.import.warnings[0], /Skipped 8/);
});

test('Spotify inaccessible playlists explain authorization and ownership restrictions', async () => {
  for (const refreshToken of [undefined, 'user-refresh']) {
    const media = createMedia({ ...spotifyConfig, spotifyRefreshToken: refreshToken }, { fetch: async url => url.includes('/api/token') ? json({ access_token: 'test-token', expires_in: 3600 }) : url.includes('fields=name') ? json({ name: 'Restricted list' }) : json({ error: { status: 403 } }, 403) });
    await assert.rejects(media.resolve(`https://open.spotify.com/playlist/${TRACK}`), error => error.code === 'SPOTIFY_PLAYLIST_ACCESS' && /owns|owned/.test(error.message) && (Boolean(refreshToken) || error.message.includes('SPOTIFY_REFRESH_TOKEN')));
  }
});

test('Spotify expired refresh grants fail explicitly and are not retried repeatedly', async () => {
  let calls = 0;
  const media = createMedia({ ...spotifyConfig, spotifyRefreshToken: 'expired-test-refresh' }, { fetch: async () => { calls += 1; return json({ error: 'invalid_grant' }, 400); } });
  await assert.rejects(media.resolve(`spotify:playlist:${TRACK}`), { code: 'SPOTIFY_REAUTHORIZE' });
  await assert.rejects(media.resolve(`spotify:playlist:${TRACK}`), { code: 'SPOTIFY_REAUTHORIZE' });
  assert.equal(calls, 1);
});

test('a Spotify page error rejects the whole import instead of silently returning partial tracks', async () => {
  const responses = [json({ access_token: 'test-token', expires_in: 3600 }), json({ name: 'List' }), json({ offset: 0, total: 2, next: 'more', items: [{ item: spotifyItem(1) }] }), json({ error: { reason: 'QUOTA_EXCEEDED' } }, 429)];
  const media = createMedia(spotifyConfig, { fetch: async () => responses.shift() });
  await assert.rejects(media.resolve(`spotify:playlist:${TRACK}`), { code: 'SPOTIFY_QUOTA_EXCEEDED' });
  assert.equal(responses.length, 0);
});

test('Spotify pagination is bounded even when responses provide tiny pages indefinitely', async () => {
  let pageCalls = 0;
  const media = createMedia(spotifyConfig, { fetch: async url => {
    if (url.includes('/api/token')) return json({ access_token: 'test-token', expires_in: 3600 });
    if (url.includes('fields=name')) return json({ name: 'Tiny pages' });
    const offset = Number(new URL(url).searchParams.get('offset'));
    pageCalls += 1;
    return json({ offset, total: 100, next: 'more', items: [{ item: spotifyItem(offset) }] });
  } });
  const tracks = await media.resolve(`spotify:playlist:${TRACK}`);
  assert.equal(pageCalls, 5);
  assert.equal(tracks.length, 5);
  assert.equal(tracks.import.limitReached, true);
  assert.match(tracks.import.warnings.join(' '), /pagination limit/);
});

test('Spotify rejects inconsistent pagination offsets', async () => {
  const media = createMedia(spotifyConfig, { fetch: async url => url.includes('/api/token') ? json({ access_token: 'test-token', expires_in: 3600 }) : url.includes('fields=name') ? json({ name: 'List' }) : json({ offset: 42, total: 1, next: null, items: [{ item: spotifyItem(1) }] }) });
  await assert.rejects(media.resolve(`spotify:playlist:${TRACK}`), { code: 'INVALID_MEDIA' });
});

test('rotated Spotify refresh tokens persist privately and a changed configured token overrides the cache', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'turntable-media-'));
  const authFile = path.join(dataDir, '.spotify-auth.json');
  t.after(async () => { await unlink(authFile).catch(() => {}); await rmdir(dataDir); });
  const config = { ...spotifyConfig, spotifyRefreshToken: 'original-test-refresh', dataDir };
  const fetchFor = (expected, rotated) => async (url, options) => {
    if (url.includes('/api/token')) {
      assert.equal(new URLSearchParams(options.body).get('refresh_token'), expected);
      return json({ access_token: 'test-token', expires_in: 3600, ...(rotated ? { refresh_token: rotated } : {}) });
    }
    return url.includes('fields=name') ? json({ name: 'List' }) : json({ offset: 0, total: 1, next: null, items: [{ item: spotifyItem(1) }] });
  };
  await createMedia(config, { fetch: fetchFor('original-test-refresh', 'rotated-test-refresh') }).resolve(`spotify:playlist:${TRACK}`);
  const saved = JSON.parse(await readFile(authFile, 'utf8'));
  assert.equal(saved.refreshToken, 'rotated-test-refresh');
  assert.match(saved.configHash, /^[a-f0-9]{64}$/);
  assert.equal(saved.access_token, undefined);
  if (process.platform !== 'win32') assert.equal((await stat(authFile)).mode & 0o777, 0o600);
  await createMedia(config, { fetch: fetchFor('rotated-test-refresh') }).resolve(`spotify:playlist:${TRACK}`);
  await createMedia({ ...config, spotifyRefreshToken: 'operator-replacement-token' }, { fetch: fetchFor('operator-replacement-token') }).resolve(`spotify:playlist:${TRACK}`);
});

test('YouTube search returns at most five ordered canonical choices without resolving their audio', async () => {
  const entries = Array.from({ length: 7 }, (_, index) => video(index + 1));
  const fake = extractor([metadata({ entries }), metadata(entries[1])]);
  const media = createMedia({}, fake);
  const results = await media.search('  song & artist  ');
  assert.deepEqual(results.map(track => track.title), ['Song 1', 'Song 2', 'Song 3', 'Song 4', 'Song 5']);
  assert.equal(results[0].providerId, entries[0].id);
  assert.equal(results[0].source, 'youtube');
  assert.equal(results[0].artist, 'An artist');
  assert.equal(results[0].durationSec, 120);
  assert.equal(results[0].needsValidation, true);
  assert.equal(results[0].sourceUrl, `https://www.youtube.com/watch?v=${entries[0].id}`);
  assert.equal(results[0].thumbnail, `https://i.ytimg.com/vi/${entries[0].id}/hqdefault.jpg`);
  assert.equal(fake.calls.length, 1);
  const args = fake.calls[0].args;
  assert.equal(args.at(-1), 'ytsearch10:song & artist');
  assert.equal(args.at(-2), '--');
  assert.equal(fake.calls[0].options.shell, false);
  assert.ok(args.includes('--flat-playlist'));
  assert.ok(args.includes('--skip-download'));
  assert.equal(args[args.indexOf('--playlist-items') + 1], '1:10');
  const [selected] = await media.resolve(results[1].sourceUrl);
  assert.equal(selected.title, 'Song 2');
  assert.equal(fake.calls[1].args.at(-1), results[1].sourceUrl);
});

test('YouTube search omits restricted, live and over-limit results while allowing deferred duration checks', async () => {
  const entries = [video(1, { availability: 'private' }), video(2, { is_live: true }), video(3, { duration: 601 }), video(4, { duration: null }), video(5)];
  const fake = extractor([metadata({ entries })]);
  const tracks = await createMedia({ maxTrackDurationSec: 600 }, fake).search('song');
  assert.deepEqual(tracks.map(track => track.title), ['Song 4', 'Song 5']);
  assert.equal(tracks[0].durationSec, null);
  assert.equal(tracks[0].needsValidation, true);
  assert.equal(fake.calls.length, 1);
});

test('search removes duplicates and invalid provider IDs and does not trust returned URLs', async () => {
  const entries = [video(1, { url: 'https://example.invalid/ignored' }), video(1), video(3, { id: 'bad' }), video(4, { id: 12345678901 }), video(5, { ie_key: 'Other' })];
  const tracks = await createMedia({}, extractor([metadata({ entries })])).search('song');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].sourceUrl, 'https://www.youtube.com/watch?v=00000000001');
});

test('search rejects invalid queries, direct links and unsupported sources before provider calls', async () => {
  const fake = extractor();
  const media = createMedia({}, { ...fake, fetch: () => assert.fail('No provider call expected') });
  for (const query of ['', '  ', null, 'x'.repeat(501), 'song\nname', `https://youtu.be/${VIDEO}`, `spotify:track:${TRACK}`]) {
    await assert.rejects(media.search(query), { code: 'INVALID_QUERY' });
  }
  await assert.rejects(media.search('song', 'other'), { code: 'UNSUPPORTED_MEDIA' });
  assert.equal(fake.calls.length, 0);
});

test('search returns empty catalog results but rejects malformed response shapes', async () => {
  const fake = extractor([metadata({ entries: [] }), metadata({ title: 'not a result list' })]);
  const media = createMedia({}, fake);
  assert.deepEqual(await media.search('song'), []);
  await assert.rejects(media.search('song'), { code: 'INVALID_MEDIA' });
  for (const data of [{ tracks: { items: [] } }, { tracks: null }]) {
    const spotifyMedia = createMedia(spotifyConfig, { fetch: async url => url.includes('/api/token') ? json({ access_token: 'test-token', expires_in: 3600 }) : json(data) });
    if (data.tracks) assert.deepEqual(await spotifyMedia.search('song', 'spotify'), []);
    else await assert.rejects(spotifyMedia.search('song', 'spotify'), { code: 'INVALID_MEDIA' });
  }
});

test('Spotify search uses one official bounded catalog request and normalizes selectable tracks', async () => {
  const calls = [];
  const media = createMedia({ ...spotifyConfig, spotifyMarket: 'GB' }, { fetch: async (url, options) => {
    calls.push({ url, options });
    return url.includes('/api/token') ? json({ access_token: 'test-token', expires_in: 3600 }) : json({ tracks: { items: Array.from({ length: 8 }, (_, index) => spotifyItem(index + 1)), next: 'https://example.invalid/do-not-follow' } });
  } });
  const results = await media.search('Artist & track:Song', 'spotify');
  assert.equal(calls.length, 2);
  const url = new URL(calls[1].url);
  assert.equal(url.origin, 'https://api.spotify.com');
  assert.equal(url.pathname, '/v1/search');
  assert.equal(url.searchParams.get('q'), 'Artist & track:Song');
  assert.equal(url.searchParams.get('type'), 'track');
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.get('offset'), '0');
  assert.equal(url.searchParams.get('market'), 'GB');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(results.length, 5);
  assert.deepEqual(results.map(track => track.title), ['Track 1', 'Track 2', 'Track 3', 'Track 4', 'Track 5']);
  assert.equal(results[0].providerId, '0000000000000000000001');
  assert.equal(results[0].sourceUrl, 'https://open.spotify.com/track/0000000000000000000001');
  assert.equal(results[0].durationSec, 120);
  assert.equal(results[0].artist, 'An artist');
  assert.equal(results[0].thumbnail, 'https://i.scdn.co/image/example');
});

test('Spotify search uses configured user authorization and skips unplayable catalog results', async () => {
  const entries = [spotifyItem(1, { is_local: true }), spotifyItem(2, { is_playable: false }), spotifyItem(3, { restrictions: { reason: 'market' } }), spotifyItem(4, { type: 'episode' }), spotifyItem(5)];
  const media = createMedia({ ...spotifyConfig, spotifyRefreshToken: 'test-refresh' }, { fetch: async (url, options) => {
    if (url.includes('/api/token')) {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('client_id'), 'test-client');
      assert.equal(body.get('refresh_token'), 'test-refresh');
      return json({ access_token: 'user-token', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer user-token');
    return json({ tracks: { items: entries } });
  } });
  const results = await media.search('song', 'spotify');
  assert.deepEqual(results.map(track => track.title), ['Track 5']);
});

test('Spotify search reports credential, quota and access failures without falling back to another provider', async () => {
  const missing = createMedia({}, { fetch: () => assert.fail('No provider call expected') });
  await assert.rejects(missing.search('song', 'spotify'), { code: 'SPOTIFY_NOT_CONFIGURED' });
  for (const [status, code] of [[403, 'SPOTIFY_FORBIDDEN'], [429, 'SPOTIFY_RATE_LIMITED']]) {
    let calls = 0;
    const media = createMedia(spotifyConfig, { spawn: () => assert.fail('No fallback expected'), fetch: async url => {
      calls += 1;
      return url.includes('/api/token') ? json({ access_token: 'test-token', expires_in: 3600 }) : json({ error: { status } }, status);
    } });
    await assert.rejects(media.search('song', 'spotify'), { code });
    assert.equal(calls, 2);
  }
});

test('search shares request concurrency limits and cancellation frees provider capacity', async () => {
  const fake = extractor();
  const media = createMedia({}, fake);
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map(controller => assert.rejects(media.search('song', 'youtube', { signal: controller.signal }), /cancelled/));
  await assert.rejects(media.search('fifth'), { code: 'MEDIA_BUSY' });
  await assert.rejects(media.resolve('sixth'), { code: 'MEDIA_BUSY' });
  for (const controller of controllers) controller.abort(new Error('cancelled'));
  await Promise.all(pending);
  assert.equal(fake.calls.length, 4);
  assert.equal(fake.stopped.length, 4);
  const controller = new AbortController();
  controller.abort(new Error('cancelled before search'));
  await assert.rejects(media.search('song', 'youtube', { signal: controller.signal }), /cancelled before search/);
  assert.equal(fake.calls.length, 4);
});

test('search bounds metadata bytes and extraction time and terminates unfinished processes', async () => {
  const oversized = extractor([child => child.stdout.write(Buffer.alloc(1024 * 1024 + 1))]);
  await assert.rejects(createMedia({}, oversized).search('song'), { code: 'INVALID_MEDIA' });
  assert.equal(oversized.stopped.length, 1);
  const stalled = extractor();
  await assert.rejects(createMedia({}, { ...stalled, resolveTimeoutMs: 15 }).search('song'), { code: 'MEDIA_TIMEOUT' });
  assert.equal(stalled.stopped.length, 1);
});

test('YouTube failures distinguish host rejection, request limits, restricted content and runtime problems', async () => {
  const cases = [
    ["Sign in to confirm you're not a bot", 'YOUTUBE_REQUEST_BLOCKED', /bot host/],
    ['HTTP Error 403: Forbidden', 'YOUTUBE_REQUEST_BLOCKED', /403/],
    ['HTTP Error 429: Too Many Requests', 'YOUTUBE_RATE_LIMITED', /wait/i],
    ["This content isn't available, try again later", 'YOUTUBE_RATE_LIMITED', /wait/i],
    ['This is a private video. Sign in', 'YOUTUBE_RESTRICTED', /restricted/],
    ['No supported JavaScript runtime could be found. Requested format is not available', 'EXTRACTOR_RUNTIME_UNAVAILABLE', /JavaScript dependencies/],
    ['Requested format is not available', 'YOUTUBE_FORMAT_UNAVAILABLE', /audio format/],
    ['Video unavailable', 'YOUTUBE_VIDEO_UNAVAILABLE', /unavailable/],
    ['Unable to download video info: HTTP Error 503: Service Unavailable', 'YOUTUBE_UNAVAILABLE', /connection recovers/],
    ['Video unavailable: HTTP Error 502: Bad Gateway', 'YOUTUBE_UNAVAILABLE', /connection recovers/],
    ['Unable to download video info: connection reset by peer', 'YOUTUBE_UNAVAILABLE', /connection recovers/],
    ['Provider request failed unexpectedly', 'YOUTUBE_UNAVAILABLE', /could not provide/],
  ];
  for (const [diagnostic, code, message] of cases) {
    const logs = [];
    const fake = extractor([child => { child.stderr.end(`${diagnostic}\nhttps://example.invalid/private?token=never-log-this`); child.emit('close', 1); }]);
    const media = createMedia({}, { ...fake, logger: { warn: (...args) => logs.push(args) } });
    await assert.rejects(media.search('private query'), error => error.code === code && error.status === (code === 'YOUTUBE_VIDEO_UNAVAILABLE' ? 400 : 503) && message.test(error.message) && !error.message.includes('never-log-this'));
    assert.deepEqual(logs, [['YouTube extractor failed.', { operation: 'search', code }]]);
  }
});

test('playback failure logs only its operation and safe classification', async () => {
  const logs = [];
  const fake = extractor([child => { child.stderr.end('HTTP Error 403: Forbidden; https://example.invalid/private'); child.emit('close', 1); }]);
  const media = createMedia({}, { ...fake, logger: { warn: (...args) => logs.push(args) } });
  await assert.rejects(media.open({ source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`, durationSec: 120 }), { code: 'YOUTUBE_REQUEST_BLOCKED' });
  assert.deepEqual(logs, [['YouTube extractor failed.', { operation: 'playback', code: 'YOUTUBE_REQUEST_BLOCKED' }]]);
});

test('default YouTube search omits recorded performances and prefers studio audio within ten candidates', async () => {
  const entries = [
    video(1, { title: 'An artist - A song (Live at Wembley)' }),
    video(2, { title: 'An artist - A song', was_live: true }),
    video(3, { title: 'An artist - A song [Full Concert]' }),
    video(4, { title: 'An artist - A song (Official Music Video)' }),
    video(5, { title: 'A song', uploader: 'An artist - Topic' }),
    video(6, { title: 'An artist - A song (Official Audio)' }),
    video(7, { title: 'An artist - A song' }),
    video(8, { title: 'An artist - A song', live_status: 'post_live' }),
    video(9, { title: 'An artist - A song (Live)' }),
    video(10, { title: 'An artist - A song - Live 2025' }),
    video(11, { title: 'An artist - A song (Official Audio)' }),
  ];
  const fake = extractor([metadata({ entries })]);
  const tracks = await createMedia({}, fake).search('A song An artist');
  assert.deepEqual(tracks.map(track => track.providerId), [5, 6, 4, 7].map(id => String(id).padStart(11, '0')));
  assert.equal(fake.calls.length, 1, 'Ranking must not fully extract every search result.');
});

test('recording filters preserve Live Forever, the artist Live, and Live Through This', async () => {
  const entries = [video(1, { title: 'Oasis - Live Forever (Official Audio)', uploader: 'Oasis' }),
    video(2, { title: 'Live - Lightning Crashes', uploader: 'Live' })];
  const tracks = await createMedia({}, extractor([metadata({ entries })])).search('Live');
  assert.equal(tracks.length, 2);
  const spotifyEntries = [spotifyItem(1, { name: 'Live Forever', album: { name: 'Definitely Maybe' } }),
    spotifyItem(2, { name: 'Doll Parts', album: { name: 'Live Through This' } }),
    spotifyItem(3, { name: 'Lightning Crashes', artists: [{ name: 'Live' }] }),
    spotifyItem(4, { name: 'Doll Parts - Live at Reading' }),
    spotifyItem(5, { name: 'Doll Parts', album: { name: 'Live at Reading' } })];
  const media = createMedia(spotifyConfig, { fetch: async url => url.includes('/api/token')
    ? json({ access_token: 'token', expires_in: 3600 }) : json({ tracks: { items: spotifyEntries } }) });
  assert.deepEqual((await media.search('Live', 'spotify')).map(track => track.title), ['Live Forever', 'Doll Parts', 'Lightning Crashes']);
});

test('Spotify matching selects relevant studio audio instead of the first live, cover or mismatched result', async () => {
  const chosen = video(6, { title: 'A song', uploader: 'An artist - Topic', duration: 120 });
  const entries = [video(1, { title: 'An artist - A song (Live)' }),
    video(2, { title: 'An artist - A song (Cover)' }),
    video(3, { title: 'Another artist - A song', uploader: 'Another artist' }),
    video(4, { title: 'An artist - A song (Official Audio)', duration: 400 }),
    video(5, { title: 'An artist - A song (Official Music Video)', duration: 125 }), chosen];
  const fake = extractor([metadata({ entries }), metadata(chosen), child => child.stdout.write('audio')]);
  const opened = await createMedia({}, fake).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
    title: 'A song', artist: 'An artist', durationSec: 120 });
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[1].args.at(-1), `https://www.youtube.com/watch?v=${chosen.id}`);
  assert.equal(fake.calls[2].args.at(-1), `https://www.youtube.com/watch?v=${chosen.id}`);
  opened.cleanup();
});

test('Spotify matching rejects live-only and unrelated candidates without opening audio', async () => {
  for (const entries of [[video(1, { title: 'An artist - A song (Live)' })],
    [video(2, { title: 'An artist - Another song', duration: 120 })],
    [video(3, { title: 'Different band - A song', uploader: 'Different band' })]]) {
    const fake = extractor([metadata({ entries })]);
    await assert.rejects(createMedia({}, fake).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
      title: 'A song', artist: 'An artist', durationSec: 120 }), error => error.code === 'NO_PLAYBACK_MATCH' && /studio/.test(error.message));
    assert.equal(fake.calls.length, 1);
  }
});

test('Spotify matching accepts official M/V labels on the requested recording', async () => {
  const recording = video(1, { title: "BLACKPINK - 'Lovesick Girls' M/V", uploader: 'BLACKPINK', duration: 194 });
  const fake = extractor([metadata({ entries: [recording] }), metadata(recording), child => child.stdout.write('audio')]);
  const opened = await createMedia({}, fake).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
    title: 'Lovesick Girls', artist: 'BLACKPINK', durationSec: 192 });
  assert.equal(fake.calls.at(-1).args.at(-1), `https://www.youtube.com/watch?v=${recording.id}`);
  opened.cleanup();
});

test('full metadata rechecks studio matches and tries only the next ranked candidate', async () => {
  const first = video(1, { title: 'An artist - A song (Official Audio)' });
  const next = video(2, { title: 'An artist - A song' });
  const fake = extractor([metadata({ entries: [first, next] }), metadata({ ...first, was_live: true }),
    metadata(next), child => child.stdout.write('audio')]);
  const opened = await createMedia({}, fake).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
    title: 'A song', artist: 'An artist', durationSec: 120 });
  assert.equal(fake.calls.at(-1).args.at(-1), `https://www.youtube.com/watch?v=${next.id}`);
  opened.cleanup();
});

test('explicit recorded-live links and Spotify album versions remain selectable', async () => {
  const live = video(1, { title: 'An artist - A song (Live at Wembley)', was_live: true });
  const directFake = extractor([metadata(live), child => child.stdout.write('audio')]);
  const direct = createMedia({}, directFake);
  const [exact] = await direct.resolve(`https://youtu.be/${live.id}`);
  const openedDirect = await direct.open(exact);
  assert.equal(directFake.calls.at(-1).args.at(-1), exact.sourceUrl);
  openedDirect.cleanup();
  const fake = extractor([metadata({ entries: [youtube, live] }), metadata(live), child => child.stdout.write('audio')]);
  const media = createMedia(spotifyConfig, { ...fake, fetch: async url => url.includes('/api/token')
    ? json({ access_token: 'token', expires_in: 3600 }) : json({ ...spotify, album: { name: 'Live at Wembley' } }) });
  const [selected] = await media.resolve(`spotify:track:${TRACK}`);
  assert.equal(selected.recordingKind, 'live');
  const opened = await media.open(selected);
  assert.equal(fake.calls.at(-1).args.at(-1), `https://www.youtube.com/watch?v=${live.id}`);
  opened.cleanup();
});

test('Spotify candidate validation keeps cancellation and duration limits', async () => {
  const first = video(1, { title: 'An artist - A song (Official Audio)', duration: null });
  const fake = extractor([metadata({ entries: [first] }), metadata({ ...first, duration: 999 })]);
  const track = { source: 'spotify', sourceUrl: `spotify:track:${TRACK}`, title: 'A song', artist: 'An artist', durationSec: 120 };
  await assert.rejects(createMedia({ maxTrackDurationSec: 600 }, fake).open(track), { code: 'NO_PLAYBACK_MATCH' });
  assert.equal(fake.calls.length, 2);
  const controller = new AbortController();
  const stalled = extractor([metadata({ entries: [first] }), () => controller.abort(new Error('skip cancelled matching'))]);
  await assert.rejects(createMedia({}, stalled).open(track, { signal: controller.signal }), /skip cancelled/);
  assert.equal(stalled.stopped.length, 1);
});

test('Spotify matching accepts Japanese song titles, redundant translations and release credits', async () => {
  const examples = [
    { title: 'Ref:rain', artist: 'Aimer', durationSec: 290,
      recording: 'Aimer 『Ref:rain』MUSIC VIDEO（5th album「Sun Dance」収録）' },
    { title: 'イマジネーション', artist: 'SPYAIR', durationSec: 177,
      recording: 'SPYAIR「イマジネーション」(Imagination) [TVアニメ「ハイキュー!!」オープニングテーマ]' },
    { title: 'カワキヲアメク', artist: '美波', durationSec: 252,
      recording: '美波 (Minami) - カワキヲアメク (Kawaki wo Ameku) [Official MV]' },
  ];
  for (const example of examples) {
    const full = video(1, { title: example.recording, uploader: example.artist, duration: example.durationSec });
    const fake = extractor([metadata({ entries: [full] }), metadata(full), child => child.stdout.write('audio')]);
    const opened = await createMedia({}, fake).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`, ...example });
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls[2].args.at(-1), `https://www.youtube.com/watch?v=${full.id}`);
    opened.cleanup();
  }
});

test('missing flat artist credits are checked in full metadata, never guessed from a transliteration', async () => {
  const flat = video(1, { title: 'Minami「カワキヲアメク」MV', uploader: 'Minami - Topic', duration: 252 });
  const track = { source: 'spotify', sourceUrl: `spotify:track:${TRACK}`, title: 'カワキヲアメク', artist: '美波', durationSec: 252 };
  for (const artist of ['美波', '別の歌手', undefined]) {
    const full = { ...flat, artist };
    const fake = extractor([metadata({ entries: [flat] }), metadata(full), child => child.stdout.write('audio')]);
    const pending = createMedia({}, fake).open(track);
    if (artist === '美波') {
      const opened = await pending;
      assert.equal(fake.calls.length, 3);
      opened.cleanup();
    } else {
      await assert.rejects(pending, { code: 'NO_PLAYBACK_MATCH' });
      assert.equal(fake.calls.length, 2, 'Missing or contradictory full artist credits never start audio.');
    }
  }
});

test('matching folds Latin accents without conflating Japanese voiced characters', async () => {
  const recording = video(1, { title: 'Beyonce - Halo (Official Audio)', uploader: 'BeyonceVEVO', duration: 261 });
  const fake = extractor([metadata({ entries: [recording] }), metadata(recording), child => child.stdout.write('audio')]);
  const opened = await createMedia({}, fake).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
    title: 'Halo', artist: 'Beyoncé', durationSec: 261 });
  assert.equal(fake.calls.length, 3);
  opened.cleanup();

  const wrong = video(2, { title: '歌手 - カラス (Official Audio)', uploader: '歌手', duration: 240 });
  const japanese = extractor([metadata({ entries: [wrong] })]);
  await assert.rejects(createMedia({}, japanese).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
    title: 'ガラス', artist: '歌手', durationSec: 240 }), { code: 'NO_PLAYBACK_MATCH' });
  assert.equal(japanese.calls.length, 1);
});

test('verified provider heart spellings match Spotify artist names without dropping artist numbers', async () => {
  const flat = { id: 'shtzavAquGs', title: 'dopamine crash!', uploader: 'han.irl♡', channel: 'han.irl♡', duration: 156 };
  const full = { ...flat, artist: 'han.irl ᐸ3', artists: ['han.irl ᐸ3'], creator: 'han.irl ᐸ3', creators: ['han.irl ᐸ3'], duration: 155, availability: 'public' };
  const fake = extractor([metadata({ entries: [flat] }), metadata(full), child => child.stdout.write('audio')]);
  const opened = await createMedia({}, fake).open({ source: 'spotify', sourceUrl: 'spotify:track:4d8CJ0PFqz8jWr2nZWT7ik',
    title: 'dopamine crash!', artist: 'han.irl <3', durationSec: 156 });
  assert.equal(fake.calls.at(-1).args.at(-1), 'https://www.youtube.com/watch?v=shtzavAquGs');
  opened.cleanup();

  const otherArtist = video(1, { title: 'Artist 3 - A song', uploader: 'Artist 3' });
  const mismatch = extractor([metadata({ entries: [otherArtist] })]);
  await assert.rejects(createMedia({}, mismatch).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
    title: 'A song', artist: 'Artist 4', durationSec: 120 }), { code: 'NO_PLAYBACK_MATCH' });
  assert.equal(mismatch.calls.length, 1);
});

test('verified Falling Slowly official metadata matches the requested Vwillz recording', async () => {
  const flat = { id: 'I0a8pO-4JxQ', title: 'Vwillz - Falling Slowly (Official Audio)', uploader: 'Vwillz', channel: 'Vwillz', duration: 120 };
  const fake = extractor([metadata({ entries: [flat] }), metadata({ ...flat, creators: null, duration: 119, availability: 'public' }), child => child.stdout.write('audio')]);
  const opened = await createMedia({}, fake).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
    title: 'Falling Slowly', artist: 'Vwillz', durationSec: 119 });
  assert.equal(fake.calls.at(-1).args.at(-1), 'https://www.youtube.com/watch?v=I0a8pO-4JxQ');
  opened.cleanup();
});

test('Japanese title translations cannot hide a First Take recording annotation', async () => {
  const recording = video(1, { title: '美波 - カワキヲアメク (THE FIRST TAKE)', uploader: '美波', duration: 252 });
  const fake = extractor([metadata({ entries: [recording] })]);
  await assert.rejects(createMedia({}, fake).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
    title: 'カワキヲアメク', artist: '美波', durationSec: 252 }), { code: 'NO_PLAYBACK_MATCH' });
  assert.equal(fake.calls.length, 1);
});

test('matching rejects different tracks, different artists and alternate recordings despite shared title words', async () => {
  for (const title of ['An artist - A song 2', 'An artist - Another song', 'Another artist - A song',
    'An artist - A song (Acoustic)', 'An artist - A song (Piano Version)', 'An artist - A song / THE FIRST TAKE',
    'An artist - A song (THE FIRST TAKE Official Video)', 'An artist - A song [The First Take - Official Music Video]',
    'An artist - A song (カバー)', 'An artist - A song (歌ってみた)', 'An artist - A song (Official Remix)']) {
    const info = video(1, { title, uploader: title.startsWith('Another artist') ? 'Another artist' : 'An artist' });
    const fake = extractor([metadata({ entries: [info] })]);
    await assert.rejects(createMedia({}, fake).open({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`,
      title: 'A song', artist: 'An artist', durationSec: 120 }), { code: 'NO_PLAYBACK_MATCH' });
    assert.equal(fake.calls.length, 1, title);
  }
});

test('validated Spotify mappings survive preload cancellation but still open fresh audio each time', async () => {
  const controller = new AbortController();
  const fake = extractor([metadata({ entries: [youtube] }), metadata(youtube), () => controller.abort(new Error('preload moved')),
    child => child.stdout.write('fresh audio')]);
  const media = createMedia({}, fake);
  const track = { source: 'spotify', sourceUrl: `spotify:track:${TRACK}`, title: 'A song', artist: 'An artist', durationSec: 120 };
  await assert.rejects(media.open(track, { signal: controller.signal }), /preload moved/);
  const opened = await media.open(track);
  assert.equal(fake.calls.length, 4);
  assert.equal(fake.calls[3].args.at(-1), `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.equal(opened.stream.read().toString(), 'fresh audio');
  opened.cleanup();
});

test('Spotify mapping cache expires and is invalidated when audio becomes unavailable', async () => {
  let now = 0;
  const fresh = () => [metadata({ entries: [youtube] }), metadata(youtube), child => child.stdout.write('audio')];
  const failedAudio = child => { child.stderr.end('ERROR: Video unavailable'); child.emit('close', 1); };
  const fake = extractor([...fresh(), ...fresh(), failedAudio, ...fresh()]);
  const media = createMedia({}, { ...fake, now: () => now });
  const track = { source: 'spotify', sourceUrl: `spotify:track:${TRACK}`, title: 'A song', artist: 'An artist', durationSec: 120 };
  (await media.open(track)).cleanup();
  now = 10 * 60_000;
  (await media.open(track)).cleanup();
  assert.equal(fake.calls.length, 6, 'Expired mappings require catalog and full metadata again.');
  await assert.rejects(media.open(track), { code: 'YOUTUBE_VIDEO_UNAVAILABLE' });
  assert.equal(fake.calls.length, 7, 'Cached mappings still perform a normal public audio extraction.');
  (await media.open(track)).cleanup();
  assert.equal(fake.calls.length, 10, 'Unavailable mappings are not reused on the next attempt.');
});

test('Spotify validated mapping cache remains bounded and metadata-sensitive', async () => {
  const tracks = Array.from({ length: 201 }, (_, index) => ({ source: 'spotify', sourceUrl: `spotify:track:${String(index).padStart(22, '0')}`,
    title: 'A song', artist: 'An artist', durationSec: 120 }));
  const fresh = () => [metadata({ entries: [youtube] }), metadata(youtube), child => child.stdout.write('audio')];
  const fake = extractor([...tracks.flatMap(fresh), ...fresh(), ...fresh()]);
  const media = createMedia({}, fake);
  for (const track of tracks) (await media.open(track)).cleanup();
  (await media.open(tracks[0])).cleanup();
  assert.equal(fake.calls.length, 202 * 3, 'The oldest mapping is evicted after 200 entries.');
  (await media.open({ ...tracks[0], durationSec: 121 })).cleanup();
  assert.equal(fake.calls.length, 203 * 3, 'Changed track metadata cannot reuse an earlier validation.');
});

const queuedSpotify = () => ({ source: 'spotify', sourceUrl: `spotify:track:${TRACK}`, title: 'A song', artist: 'An artist', durationSec: 120 });
async function savedSpotifyMapping(checkedAt = 1000) {
  return createMedia({}, { ...extractor([metadata({ entries: [youtube] }), metadata(youtube)]), now: () => checkedAt }).preflight(queuedSpotify());
}

test('metadata preflight validates Spotify without audio and shares its selected recording with open', async () => {
  const fake = extractor([metadata({ entries: [youtube] }), metadata({ ...youtube, formats: [{ acodec: 'opus', url: 'https://private-cdn.invalid/audio?token=never-persist' }] }), child => child.stdout.write('audio')]);
  const media = createMedia({}, { ...fake, now: () => 1000 });
  const track = queuedSpotify();
  const ready = await media.preflight(track);
  assert.equal(fake.calls.length, 2);
  assert.ok(fake.calls.every(call => call.args.includes('--skip-download')));
  assert.equal(track.playbackMapping, undefined, 'Preflight returns an update without mutating the queue request.');
  assert.deepEqual(ready.validation, { status: 'ready', checkedAt: 1000 });
  assert.equal(ready.source, 'spotify');
  assert.equal(ready.sourceUrl, track.sourceUrl);
  assert.equal(ready.playbackMapping.videoId, VIDEO);
  assert.match(ready.playbackMapping.referenceHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(ready.playbackMapping).sort(), ['artist', 'checkedAt', 'durationSec', 'referenceHash', 'title', 'videoId']);
  assert.doesNotMatch(JSON.stringify(ready), /private-cdn|never-persist|formats/);
  const opened = await media.open(ready);
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[2].args.at(-1), `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.deepEqual(opened.track.playbackMapping, ready.playbackMapping);
  opened.cleanup();
});

test('fresh persisted mappings survive a process restart and stale mappings revalidate the same public ID', async () => {
  const ready = await savedSpotifyMapping();
  const fresh = extractor([child => child.stdout.write('audio')]);
  const restarted = createMedia({}, { ...fresh, now: () => 1001 });
  const restored = await restarted.preflight(JSON.parse(JSON.stringify(ready)));
  assert.equal(fresh.calls.length, 0, 'A fresh metadata check is reusable after restart.');
  (await restarted.open(restored)).cleanup();
  assert.equal(fresh.calls.length, 1);

  const stale = extractor([metadata(youtube), child => child.stdout.write('audio')]);
  const later = createMedia({}, { ...stale, now: () => 601_001 });
  const updated = await later.preflight(ready);
  assert.equal(stale.calls.length, 1);
  assert.equal(stale.calls[0].args.at(-1), `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.equal(updated.validation.checkedAt, 601_001);
  (await later.open(updated)).cleanup();
  assert.equal(stale.calls.length, 2);
});

test('stale Spotify mapping replacement performs at most two full validations including the old ID', async () => {
  const ready = await savedSpotifyMapping();
  const next = video(2, { title: 'An artist - A song (Official Audio)' });
  const third = video(3, { title: 'An artist - A song' });
  const staleFirst = { ...youtube, title: 'An artist - A song (Official Audio)', uploader: 'An artist - Topic' };
  for (const valid of [true, false]) {
    const fake = extractor([child => { child.stderr.end('Video unavailable'); child.emit('close', 1); },
      metadata({ entries: [staleFirst, next, third] }), metadata(valid ? next : { ...next, title: 'Another song' })]);
    const pending = createMedia({}, { ...fake, now: () => 601_001 }).preflight(ready);
    if (valid) assert.equal((await pending).playbackMapping.videoId, next.id);
    else await assert.rejects(pending, { code: 'NO_PLAYBACK_MATCH' });
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.calls.filter(call => !call.args.at(-1).startsWith('ytsearch')).length, 2);
    assert.equal(new Set(fake.calls.filter(call => !call.args.at(-1).startsWith('ytsearch')).map(call => call.args.at(-1))).size, 2,
      'A rejected stale ID is excluded from fallback even when it still ranks first in the catalog.');
    assert.ok(fake.calls.every(call => call.args.includes('--skip-download')));
  }
});

test('resolved YouTube singles reuse metadata while flat playlist entries validate before audio', async () => {
  const full = extractor([metadata(youtube), child => child.stdout.write('audio')]);
  const media = createMedia({}, { ...full, now: () => 1000 });
  const [resolved] = await media.resolve(`https://youtu.be/${VIDEO}`);
  const ready = await media.preflight(resolved);
  assert.equal(full.calls.length, 1, 'Request-time preflight does not repeat a completed YouTube resolution.');
  (await media.open(ready)).cleanup();
  assert.equal(full.calls.length, 2);

  const flat = extractor([metadata(youtube), child => child.stdout.write('audio')]);
  const playlists = createMedia({}, { ...flat, now: () => 1000 });
  const checked = await playlists.preflight({ source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`, title: 'Old title', durationSec: null, needsValidation: true });
  assert.equal(checked.durationSec, 120);
  assert.equal(checked.title, 'A song');
  assert.equal(checked.needsValidation, false);
  assert.equal(flat.calls.length, 1);
  (await playlists.open(checked)).cleanup();
  assert.equal(flat.calls.length, 2);
});

test('preflight checks legacy YouTube entries without a mapping instead of trusting old queue metadata', async () => {
  for (const needsValidation of [undefined, false]) {
    const fake = extractor([metadata(youtube)]);
    const ready = await createMedia({}, fake).preflight({ source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`,
      title: 'Legacy title', artist: 'Legacy artist', durationSec: 90, ...(needsValidation === undefined ? {} : { needsValidation }) });
    assert.equal(fake.calls.length, 1);
    assert.ok(fake.calls[0].args.includes('--skip-download'));
    assert.equal(ready.title, youtube.title);
    assert.equal(ready.durationSec, youtube.duration);
    assert.equal(ready.validation.status, 'ready');
  }
  const removed = extractor([child => { child.stderr.end('Video unavailable'); child.emit('close', 1); }]);
  await assert.rejects(createMedia({}, removed).preflight({ source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`,
    title: 'Legacy title', artist: 'Legacy artist', durationSec: 120 }), error => error.code === 'YOUTUBE_VIDEO_UNAVAILABLE' && isPermanentMediaError(error));
  assert.equal(removed.calls.length, 1);
});

test('background preflight reserves the fourth extractor slot for interactive requests', async () => {
  const fake = extractor([child => child.stdout.write('audio'), child => child.stdout.write('audio'), child => child.stdout.write('audio'),
    metadata({ entries: [youtube] }), metadata(youtube)]);
  const media = createMedia({}, fake);
  const playing = [];
  try {
    for (let index = 0; index < 3; index++) playing.push(await media.open({ source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`, durationSec: 120 }));
    await assert.rejects(media.preflight(queuedSpotify(), { background: true }), { code: 'MEDIA_BUSY' });
    assert.equal(fake.calls.length, 3);
    assert.equal((await media.preflight(queuedSpotify())).validation.status, 'ready');
    assert.equal(fake.calls.length, 5);
  } finally { for (const opened of playing) opened.cleanup(); }
});

test('background admission is checked again after its catalog query yields to foreground work', async () => {
  const controllers = [], pending = [];
  let media;
  const occupy = () => {
    const controller = new AbortController(); controllers.push(controller);
    pending.push(assert.rejects(media.resolve(`https://youtu.be/${VIDEO}`, { signal: controller.signal }), /test cleanup/));
  };
  const fake = extractor([undefined, undefined, child => { metadata({ entries: [youtube] })(child); child.once('close', occupy); }]);
  media = createMedia({}, fake);
  occupy(); occupy();
  try {
    await assert.rejects(media.preflight(queuedSpotify(), { background: true }), { code: 'MEDIA_BUSY' });
    assert.equal(fake.calls.length, 4, 'Background full extraction cannot take the reserved fourth slot.');
  } finally { for (const controller of controllers) controller.abort(new Error('test cleanup')); await Promise.all(pending); }
});

test('per-track definitive errors stay separate from temporary provider, metadata and auth failures', async () => {
  for (const code of ['INVALID_QUERY', 'UNSUPPORTED_MEDIA', 'TRACK_TOO_LONG', 'NO_PLAYBACK_MATCH', 'YOUTUBE_VIDEO_UNAVAILABLE', 'YOUTUBE_RESTRICTED', 'SPOTIFY_NOT_FOUND', 'EMPTY_PLAYLIST']) {
    const error = new MediaError('Authored message', code);
    assert.equal(isPermanentMediaError(error), true, code);
    assert.equal(isPermanentMediaError(new Error('Wrapper', { cause: error })), true, code);
  }
  for (const code of ['INVALID_MEDIA', 'MEDIA_BUSY', 'MEDIA_TIMEOUT', 'MEDIA_CANCELLED', 'YOUTUBE_UNAVAILABLE', 'YOUTUBE_FORMAT_UNAVAILABLE', 'YOUTUBE_RATE_LIMITED', 'YOUTUBE_REQUEST_BLOCKED', 'EXTRACTOR_RUNTIME_UNAVAILABLE', 'SPOTIFY_UNAVAILABLE', 'SPOTIFY_QUOTA_EXCEEDED', 'SPOTIFY_REAUTHORIZE', 'SPOTIFY_UNAUTHORIZED', 'SPOTIFY_FORBIDDEN']) {
    assert.equal(isPermanentMediaError(new MediaError('Authored message', code)), false, code);
  }
  assert.equal(isPermanentMediaError({ code: 'NO_PLAYBACK_MATCH' }), false, 'Unclassified arbitrary exceptions are not permanent provider decisions.');
  const empty = extractor([metadata({ entries: [] })]);
  await assert.rejects(createMedia({}, empty).preflight(queuedSpotify()), error => error.code === 'NO_PLAYBACK_MATCH' && isPermanentMediaError(error));
  const malformed = extractor([metadata({ entries: [youtube] }), metadata({})]);
  await assert.rejects(createMedia({}, malformed).preflight(queuedSpotify()), error => error.code === 'INVALID_MEDIA' && !isPermanentMediaError(error));
});

test('preflight cancellation and timeout release metadata extractors without audio or success state', async () => {
  const controller = new AbortController();
  const cancelled = extractor([metadata({ entries: [youtube] }), () => controller.abort(new Error('Removed request'))]);
  await assert.rejects(createMedia({}, cancelled).preflight(queuedSpotify(), { signal: controller.signal }), /Removed request/);
  assert.equal(cancelled.stopped.length, 1);
  assert.ok(cancelled.calls.every(call => call.args.includes('--skip-download')));
  const stalled = extractor();
  await assert.rejects(createMedia({}, { ...stalled, resolveTimeoutMs: 15 }).preflight(queuedSpotify()), error => error.code === 'MEDIA_TIMEOUT' && !isPermanentMediaError(error));
  assert.equal(stalled.stopped.length, 1);
});

test('persistent mappings cannot supply CDN URLs or another Spotify track reference', async () => {
  const ready = await savedSpotifyMapping();
  const copy = structuredClone(ready);
  copy.playbackMapping.url = 'http://127.0.0.1/private';
  const cached = extractor([child => child.stdout.write('audio')]);
  const opened = await createMedia({}, { ...cached, now: () => 1001 }).open(copy);
  assert.equal(cached.calls[0].args.at(-1), `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.equal(opened.track.playbackMapping.url, undefined);
  opened.cleanup();
  for (const override of [{ videoId: '../invalid' }, { referenceHash: '0'.repeat(64) }, { checkedAt: 5000 }]) {
    const fake = extractor([metadata({ entries: [youtube] }), metadata(youtube)]);
    await createMedia({}, { ...fake, now: () => 1001 }).preflight({ ...ready, playbackMapping: { ...ready.playbackMapping, ...override } });
    assert.equal(fake.calls.length, 2);
    assert.ok(fake.calls[0].args.at(-1).startsWith('ytsearch10:'));
  }
});

test('audio source failure invalidates even a fresh persisted mapping before a later retry', async () => {
  const ready = await savedSpotifyMapping();
  const replacement = video(2, { title: 'An artist - A song' });
  const fake = extractor([child => { child.stderr.end('Video unavailable'); child.emit('close', 1); },
    metadata({ entries: [replacement] }), metadata(replacement), child => child.stdout.write('audio')]);
  const media = createMedia({}, { ...fake, now: () => 1001 });
  await assert.rejects(media.open(ready), { code: 'YOUTUBE_VIDEO_UNAVAILABLE' });
  const opened = await media.open(ready);
  assert.equal(fake.calls.length, 4);
  assert.equal(opened.track.playbackMapping.videoId, replacement.id);
  opened.cleanup();
});

test('full metadata with no offered audio format remains retryable and never starts an audio process', async () => {
  for (const formats of [[], [{ acodec: 'none', vcodec: 'avc1' }], [{ acodec: 'none', vcodec: 'none', ext: 'mhtml' }]]) {
    const fake = extractor([metadata({ ...youtube, formats })]);
    await assert.rejects(createMedia({}, fake).resolve(`https://youtu.be/${VIDEO}`), error => error.code === 'YOUTUBE_FORMAT_UNAVAILABLE' && !isPermanentMediaError(error));
    assert.equal(fake.calls.length, 1);
    assert.ok(fake.calls[0].args.includes('--skip-download'));
  }
  for (const formats of [undefined, [{ acodec: 'opus', vcodec: 'none' }], [{ acodec: 'mp4a.40.2', vcodec: 'avc1' }]]) {
    const fake = extractor([metadata({ ...youtube, formats })]);
    const ready = await createMedia({}, fake).preflight({ source: 'youtube', sourceUrl: `https://youtu.be/${VIDEO}`, durationSec: null, needsValidation: true });
    assert.equal(ready.validation.status, 'ready');
    assert.equal(fake.calls.length, 1);
  }
});
