import { randomUUID, randomInt } from 'node:crypto';

// Local UI sandbox. It never connects to Discord or a music provider.
export function createDemoBot() {
  const guild = { id: 'demo-guild', name: 'The listening room', icon: null };
  const channel = { id: 'demo-channel', name: 'Late night lounge' };
  const user = { id: 'demo-user', username: 'You' };
  const makeTrack = (title, artist, source) => ({ id: randomUUID(), title, artist, source, durationSec: 240, thumbnail: null, sourceUrl: '', requestedBy: user });
  const searchFixtures = new Map();
  const queue = { guildId: guild.id, channelId: channel.id, channelName: channel.name, nowPlaying: makeTrack('After hours', 'Demo track · no audio', 'youtube'),
    tracks: [makeTrack('Somewhere slow', 'Demo track · no audio', 'spotify'), makeTrack('Meet me on the rooftop', 'Demo track · no audio', 'youtube')], paused: false, playing: true, lastError: null, elapsedSec: 32, volumePercent: 50 };
  let sampledAt = Date.now();
  const failure = (message, status = 400) => Object.assign(new Error(message), { status });
  const validate = id => { if (id !== guild.id) throw failure('Server not found.', 404); };
  function tick() {
    const now = Date.now();
    if (queue.playing) queue.elapsedSec += (now - sampledAt) / 1000;
    sampledAt = now;
    if (queue.nowPlaying && queue.elapsedSec >= queue.nowPlaying.durationSec) advance();
  }
  function advance() {
    queue.nowPlaying = queue.channelId ? queue.tracks.shift() || null : null;
    queue.elapsedSec = 0;
    queue.paused = false;
    queue.playing = Boolean(queue.nowPlaying);
  }
  const bot = {
    isReady: () => true,
    start: async () => {}, shutdown: async () => {},
    listGuilds: async () => [guild],
    context: async id => { validate(id); return { guild, member: { canControl: true, canManage: true, voiceChannelId: channel.id }, voiceChannels: [channel] }; },
    snapshot: id => { validate(id); tick(); return structuredClone(queue); },
    join: async id => { validate(id); queue.channelId = channel.id; queue.channelName = channel.name; if (!queue.nowPlaying) advance(); return bot.snapshot(id); },
    setVolume: async (id, _userId, volumePercent) => {
      validate(id);
      if (!Number.isInteger(volumePercent) || volumePercent < 0 || volumePercent > 100) throw failure('Volume must be an integer from 0 to 100.');
      queue.volumePercent = volumePercent;
      return bot.snapshot(id);
    },
    search: async (id, _userId, query, source = 'youtube') => {
      validate(id);
      if (typeof query !== 'string' || !query.trim() || query.length > 500) throw failure('Enter a song or artist to search, up to 500 characters.');
      if (!['youtube', 'spotify'].includes(source)) throw failure('Choose YouTube or Spotify for search.');
      const results = Array.from({ length: 5 }, (_, index) => {
        // These URLs are selection keys only: the demo never resolves or opens them.
        const sourceUrl = source === 'youtube' ? `https://www.youtube.com/watch?v=dEmO000000${index + 1}` : `https://open.spotify.com/track/${'0'.repeat(21)}${index + 1}`;
        const track = {
          title: `${query.trim().slice(0, 100)} — demo result ${index + 1}`,
          artist: 'Demo fixture · no audio', source, sourceUrl,
          durationSec: [243, 257, 326, 251, 193][index], thumbnail: null,
        };
        // Five fixed keys per provider keep the local fixture cache bounded.
        searchFixtures.set(sourceUrl, track);
        return track;
      });
      return { results: structuredClone(results) };
    },
    request: async (id, _userId, query) => {
      validate(id); tick();
      if (queue.tracks.length + Number(Boolean(queue.nowPlaying)) >= 2000) throw failure('The demo queue is full.', 409);
      const selected = searchFixtures.get(query);
      const track = selected
        ? { ...structuredClone(selected), id: randomUUID(), requestedBy: user }
        : makeTrack(query, 'Your demo request · no audio', /spotify/i.test(query) ? 'spotify' : 'youtube');
      queue.tracks.push(track);
      if (!queue.nowPlaying && queue.channelId) advance();
      return { added: [track], queue: bot.snapshot(id) };
    },
    control: async (id, _userId, action, trackId) => {
      validate(id); tick();
      if (['skip', 'pause', 'resume'].includes(action) && !queue.nowPlaying) throw failure('Nothing is playing.', 409);
      if (action === 'skip') advance();
      if (action === 'pause') { queue.paused = true; queue.playing = false; }
      if (action === 'resume') { queue.paused = false; queue.playing = true; }
      if (action === 'stop') { queue.tracks = []; advance(); }
      if (action === 'shuffle') {
        if (queue.tracks.length < 2) throw failure('Add at least two songs to the waiting queue before shuffling.', 409);
        for (let i = queue.tracks.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
        }
      }
      if (action === 'leave') {
        if (queue.nowPlaying) queue.tracks.unshift(queue.nowPlaying);
        queue.channelId = null; queue.channelName = null; advance();
      }
      if (action === 'move-top') {
        const index = queue.tracks.findIndex(track => track.id === trackId);
        if (index === -1) throw failure('Song not found.', 404);
        if (index > 0) queue.tracks.unshift(queue.tracks.splice(index, 1)[0]);
      }
      if (action === 'remove') {
        const index = queue.tracks.findIndex(track => track.id === trackId);
        if (index === -1) throw failure('Song not found.', 404);
        queue.tracks.splice(index, 1);
      }
      return bot.snapshot(id);
    },
  };
  return bot;
}
