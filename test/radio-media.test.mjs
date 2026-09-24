import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMedia, radioTrackKeys } from '../src/media.mjs';

const seedInfo = { id: 'dyRsYk0LyA8', title: 'Lovesick Girls', artist: 'BLACKPINK', duration: 202 };
const url = id => `https://www.youtube.com/watch?v=${id}`;
const seed = { title: seedInfo.title, artist: seedInfo.artist, durationSec: 202, source: 'youtube', sourceUrl: url(seedInfo.id) };
const info = (n, artist = `Artist ${Math.floor(n / 3)}`) => ({ id: `radio${String(n).padStart(6, '0')}`, title: `Song ${n}`, uploader: artist, duration: 210, ie_key: 'Youtube' });
const entries = (from = 1, count = 10) => Array.from({ length: count }, (_, n) => info(n + from));
const track = value => ({ title: value.title, artist: value.artist || value.uploader, durationSec: value.duration, source: 'youtube', sourceUrl: url(value.id) });

function fakeExtractor(scenarios = []) {
  const calls = [], stopped = [];
  return {
    calls, stopped,
    logger: { warn() {} },
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      calls.push({ command, args, options, child });
      const scenario = scenarios.shift();
      if (scenario) queueMicrotask(() => {
        if (typeof scenario === 'function') return scenario(child);
        child.stdout.end(JSON.stringify(scenario));
        child.stderr.end();
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    },
    terminate(child) {
      stopped.push(child);
      child.stdout.destroy(); child.stderr.destroy(); child.emit('close', null);
    },
  };
}

test('song radio uses a bounded real Mix, excludes the seed, and favors artist variety', async () => {
  const repetitive = entries(1, 9).map(entry => ({ ...entry, uploader: 'BLACKPINK' }));
  const fake = fakeExtractor([seedInfo, { entries: [seedInfo, ...repetitive, ...entries(10, 10)] }]);
  const media = createMedia({}, fake);
  const result = await media.radio(seed);
  assert.equal(result.length, 10);
  assert.equal(result.filter(item => item.artist === 'BLACKPINK').length, 3);
  assert.ok(result.every(item => item.needsValidation && item.radioStudioOnly && item.sourceUrl !== seed.sourceUrl));
  assert.ok(result.every(item => !item.playbackMapping));
  assert.equal(fake.calls.length, 2);
  const { args, options } = fake.calls[1];
  assert.equal(args.at(-1), `${seed.sourceUrl}&list=RD${seedInfo.id}&start_radio=1`);
  assert.ok(args.includes('--yes-playlist') && args.includes('--flat-playlist') && args.includes('--lazy-playlist') && args.includes('--skip-download'));
  assert.equal(args[args.indexOf('--playlist-items') + 1], '1:80');
  assert.equal(options.shell, false);
  assert.equal(args.some(arg => arg.startsWith('ytsearch')), false);
});

test('radio drops unavailable, overlong, live, and duplicate recordings across providers', async () => {
  const variants = [
    { ...info(1), title: 'Song 1 (Live at Wembley)' },
    { ...info(2), was_live: true },
    { ...info(3), availability: 'private' },
    { ...info(4), duration: 3601 },
    { ...info(5), title: 'Someone - Song (Cover)' },
    { ...info(6), title: 'Known song (Official Audio)', uploader: 'Known artist - Topic' },
    { ...info(7), title: 'Another upload' },
    { ...info(8), id: '../invalid' },
    ...entries(20, 10), info(20),
  ];
  const fake = fakeExtractor([seedInfo, { entries: variants }]);
  const media = createMedia({}, fake);
  const result = await media.radio(seed, { exclude: [
    { sourceUrl: 'https://open.spotify.com/track/1234567890abcdefghijkl', title: 'Known song', artist: 'Known artist' },
    { title: 'Different title', artist: 'Different artist', playbackMapping: { videoId: info(7).id } },
  ] });
  assert.deepEqual(result.map(item => item.sourceUrl), entries(20, 10).map(item => url(item.id)));
});

test('radio only inspects 80 candidates even if the provider returns excess metadata', async () => {
  const fake = fakeExtractor([seedInfo, { entries: [...Array(80).fill(seedInfo), ...entries()] }]);
  await assert.rejects(createMedia({}, fake).radio(seed), { code: 'RADIO_EXHAUSTED' });
  assert.equal(fake.calls.length, 2);
});

test('a depleted seed Mix continues from a prior radio recommendation without replaying history', async () => {
  const old = entries(1, 10);
  const next = entries(20, 10);
  const fake = fakeExtractor([seedInfo, { entries: [seedInfo, ...old] }, { entries: [...old, ...next] }]);
  const result = await createMedia({}, fake).radio(seed, { exclude: old.map(track), continuation: track(old.at(-1)) });
  assert.deepEqual(result.map(item => item.sourceUrl), next.map(item => url(item.id)));
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[2].args.at(-1), `${url(old.at(-1).id)}&list=RD${old.at(-1).id}&start_radio=1`);
});

test('radio never substitutes search results when Mix is unavailable, and returns honest partial batches', async () => {
  const fake = fakeExtractor([seedInfo, { title: 'not a playlist' }]);
  await assert.rejects(createMedia({}, fake).radio(seed), { code: 'RADIO_UNAVAILABLE' });
  assert.equal(fake.calls.length, 2);
  const partial = fakeExtractor([seedInfo, { entries: entries(1, 3) }, { entries: entries(1, 3) }]);
  assert.equal((await createMedia({}, partial).radio(seed)).length, 3);
});

test('continuous radio rotates exhausted anchors instead of retrying the same partial batch forever', async () => {
  const old = entries(1, 10);
  const partial = entries(20, 2);
  const fresh = entries(30, 10);
  const primary = { entries: [seedInfo, ...old, ...partial] };
  const fake = fakeExtractor([
    seedInfo, primary, { entries: old },
    seedInfo, primary, { entries: fresh },
  ]);
  const media = createMedia({}, fake);
  const options = { exclude: old.map(track), continuation: track(old.at(-1)) };
  assert.equal((await media.radio(seed, options)).length, 2);
  const next = await media.radio(seed, options);
  assert.equal(next.length, 10);
  assert.equal(fake.calls[2].args.at(-1), `${url(old.at(-1).id)}&list=RD${old.at(-1).id}&start_radio=1`);
  assert.equal(fake.calls[5].args.at(-1), `${url(old[0].id)}&list=RD${old[0].id}&start_radio=1`);
  assert.ok(next.every(item => !old.some(previous => item.sourceUrl === url(previous.id))));
});

test('initial sparse radio explores its own recommendations without using unrelated excluded songs as anchors', async () => {
  const old = entries(1, 4);
  const manual = track(info(999));
  const fake = fakeExtractor([seedInfo, { entries: [seedInfo, ...old] }, { entries: entries(20, 10) }]);
  const result = await createMedia({}, fake).radio(seed, { exclude: [manual, ...old.map(track)] });
  assert.equal(result.length, 10);
  assert.equal(fake.calls[2].args.at(-1), `${url(old[0].id)}&list=RD${old[0].id}&start_radio=1`);
  assert.ok(fake.calls.every(call => !call.args.at(-1).includes(info(999).id)));
});

test('Spotify radio uses the validated YouTube recording, not Spotify recommendations', async () => {
  const fake = fakeExtractor([{ entries: [seedInfo] }, seedInfo, { entries: [seedInfo, ...entries()] }]);
  const spotify = { ...seed, source: 'spotify', sourceUrl: 'https://open.spotify.com/track/1234567890abcdefghijkl' };
  const media = createMedia({}, { ...fake, fetch() { assert.fail('A known Spotify seed must not query unavailable recommendations.'); } });
  const result = await media.radio(spotify);
  assert.equal(result.length, 10);
  assert.equal(fake.calls[0].args.at(-1), 'ytsearch10:Lovesick Girls BLACKPINK official audio');
  assert.equal(fake.calls[2].args.at(-1), `${seed.sourceUrl}&list=RD${seedInfo.id}&start_radio=1`);
});

test('a validated Spotify radio anchor survives playback cache expiry without weakening playback matching', async () => {
  let clock = 1_000_000;
  const spotify = { ...seed, source: 'spotify', sourceUrl: 'https://open.spotify.com/track/1234567890abcdefghijkl' };
  const wrong = { ...seedInfo, title: 'Unrelated song', artist: 'Another artist' };
  const fake = fakeExtractor([{ entries: [seedInfo] }, seedInfo, { entries: entries() }, wrong, { entries: [] }, { entries: [] }]);
  const media = createMedia({}, { ...fake, now: () => clock });
  const validated = await media.preflight(spotify);
  assert.equal(fake.calls.length, 2);
  clock += 11 * 60_000;
  const result = await media.radio(validated);
  assert.equal(result.length, 10);
  assert.equal(fake.calls.length, 3, 'Radio should read its existing seed Mix without revalidating or searching the original recording.');
  assert.equal(fake.calls[2].args.at(-1), `${seed.sourceUrl}&list=RD${seedInfo.id}&start_radio=1`);
  assert.deepEqual(result.radioSeed.playbackMapping, validated.playbackMapping);
  await assert.rejects(media.preflight(validated), { code: 'NO_PLAYBACK_MATCH' });
  assert.equal(fake.calls.length, 6, 'Playback still rechecks stale metadata and rejects an unrelated recording after both bounded searches.');
});

test('a legacy mappingless radio station returns a private seed mapping for later refills', async () => {
  let clock = 1_000_000;
  const spotify = { ...seed, source: 'spotify', sourceUrl: 'https://open.spotify.com/track/1234567890abcdefghijkl' };
  const fake = fakeExtractor([{ entries: [seedInfo] }, seedInfo, { entries: entries() }, { entries: entries(20) }]);
  const media = createMedia({}, { ...fake, now: () => clock });
  const first = await media.radio(spotify);
  assert.equal(first.radioSeed.sourceUrl, spotify.sourceUrl);
  assert.equal(first.radioSeed.playbackMapping.videoId, seedInfo.id);
  assert.equal(Object.keys(first).includes('radioSeed'), false);
  assert.doesNotMatch(JSON.stringify(first), /playbackMapping|referenceHash|radioSeed/);
  assert.equal(spotify.playbackMapping, undefined, 'The caller owns the original seed object.');
  clock += 11 * 60_000;
  const next = await media.radio(first.radioSeed);
  assert.equal(next.length, 10);
  assert.equal(fake.calls.length, 4, 'A retained mapping avoids repeating the Spotify-to-YouTube search.');
});

test('radio still matches an invalid or unrelated persisted seed mapping before using an anchor', async () => {
  const spotify = { ...seed, source: 'spotify', sourceUrl: 'https://open.spotify.com/track/1234567890abcdefghijkl',
    playbackMapping: { videoId: info(999).id, title: 'Other song', artist: 'Other artist', durationSec: 202, checkedAt: 1, referenceHash: 'invalid' } };
  const fake = fakeExtractor([{ entries: [seedInfo] }, seedInfo, { entries: entries() }]);
  const result = await createMedia({}, fake).radio(spotify);
  assert.equal(result.radioSeed.playbackMapping.videoId, seedInfo.id);
  assert.equal(fake.calls[0].args.at(-1), 'ytsearch10:Lovesick Girls BLACKPINK official audio');
  assert.equal(fake.calls[2].args.at(-1), `${seed.sourceUrl}&list=RD${seedInfo.id}&start_radio=1`);
  assert.ok(fake.calls.every(call => !call.args.at(-1).includes(info(999).id)));
});

test('late full metadata revealing a live recording is rejected during radio preflight', async () => {
  const fake = fakeExtractor([{ ...info(1), title: 'Song 1 (Live at Wembley)' }]);
  const media = createMedia({}, fake);
  await assert.rejects(media.preflight({ ...track(info(1)), needsValidation: true, radioStudioOnly: true }), { code: 'NO_PLAYBACK_MATCH' });
});

test('radio cancellation terminates background extraction and releases its slot', async () => {
  const fake = fakeExtractor([]);
  const media = createMedia({}, fake);
  const controller = new AbortController();
  const pending = media.radio(seed, { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  controller.abort();
  await rejected;
  assert.equal(fake.stopped.length, 1);
});

test('radio respects the background process reserve and keeps its work within a deadline', async () => {
  const fake = fakeExtractor([]);
  const media = createMedia({}, { ...fake, resolveTimeoutMs: 20 });
  const work = [1, 2, 3].map(() => assert.rejects(media.radio(seed), { code: 'MEDIA_TIMEOUT' }));
  await assert.rejects(media.radio(seed), { code: 'MEDIA_BUSY' });
  await Promise.all(work);
  assert.equal(fake.stopped.length, 3);
});

test('radio rejects untrusted seed URLs and malformed limits before extracting', async () => {
  const fake = fakeExtractor();
  const media = createMedia({}, fake);
  await assert.rejects(media.radio({ ...seed, sourceUrl: 'https://attacker.invalid/music' }), { code: 'UNSUPPORTED_MEDIA' });
  for (const limit of [0, 11, 1.1, '10']) await assert.rejects(media.radio(seed, { limit }), { code: 'INVALID_QUERY' });
  assert.equal(fake.calls.length, 0);
});

test('shared radio identity tolerates damaged history and unifies official recording variants', () => {
  for (const item of [null, undefined, 1, 'song', {}, { sourceUrl: 'javascript:bad', playbackMapping: {} }]) assert.deepEqual(radioTrackKeys(item), []);
  const youtube = radioTrackKeys({ title: "BLACKPINK - 'Lovesick Girls' M/V", artist: 'BLACKPINKVEVO', sourceUrl: seed.sourceUrl });
  const spotify = radioTrackKeys({ title: 'Lovesick Girls', artist: 'BLACKPINK', sourceUrl: 'spotify:track:1234567890abcdefghijkl' });
  assert.ok(youtube.includes('song:blackpink:lovesick girls'));
  assert.ok(spotify.includes('song:blackpink:lovesick girls'));
  assert.ok(youtube.includes(`youtube:${seedInfo.id}`));
});
