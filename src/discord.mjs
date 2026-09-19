import {
  ChannelType, Client, Events, GatewayIntentBits, MessageFlags,
  PermissionFlagsBits, REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import {
  AudioPlayerStatus, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
} from '@discordjs/voice';
import { MusicManager, musicError, publicTrack } from './music.mjs';
import { prepareAudio } from './audio-pipeline.mjs';
import { createAudioHealth } from './audio-health.mjs';
import { createVoiceNetworkHealth } from './voice-network-health.mjs';
import { createVoiceDiagnosticLog } from './voice-diagnostic-log.mjs';
import { sanitizeActivityParameters, validateActivityFilters } from './command-activity.mjs';

const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Request a song or playlist from Spotify or YouTube')
    .addStringOption(option => option.setName('query').setDescription('Song name, or a Spotify/YouTube track or playlist URL').setRequired(true).setMaxLength(500)),
  new SlashCommandBuilder().setName('volume').setDescription('Show or change the bot volume for this server')
    .addIntegerOption(option => option.setName('percent').setDescription('Volume from 0 (muted) to 100 (original level)').setMinValue(0).setMaxValue(100)),
  new SlashCommandBuilder().setName('radio').setDescription('Keep adding similar songs in batches of 10')
    .addStringOption(option => option.setName('query').setDescription('Seed song or link; leave blank to use the current song').setMaxLength(500)),
  ...[
    ['queue', 'Show the current song and waiting queue'],
    ['join', 'Join your voice channel and continue the queue'],
    ['skip', 'Skip the current song'],
    ['shuffle', 'Shuffle waiting songs without interrupting the current track'],
    ['pause', 'Pause playback'],
    ['resume', 'Resume playback'],
    ['radio-stop', 'Stop radio and remove its waiting songs, keeping manual requests'],
    ['stop', 'Stop playback and clear the queue'],
    ['leave', 'Leave voice and save the queue for later'],
    ['portal', 'Open the song request website'],
  ].map(([name, description]) => new SlashCommandBuilder().setName(name).setDescription(description)),
].map(command => command.setDMPermission(false).toJSON());

export function isManager(member, djRoleId) {
  return member.permissions.has(PermissionFlagsBits.ManageGuild)
    || Boolean(djRoleId && member.roles.cache.has(djRoleId));
}

/** Shared policy for slash commands and portal actions. */
export function authorizeControl({ manager, userId, voiceChannelId, snapshot, action, trackId }) {
  if (action === 'remove') {
    const track = snapshot.tracks.find(item => item.id === trackId);
    if (!track) throw musicError('That song is no longer in the waiting queue.', 404);
    if (manager || track.requestedBy.id === userId) return;
    throw musicError('You can only remove your own requests. A server manager or DJ can remove any request.', 403);
  }
  if (manager || (snapshot.channelId && voiceChannelId === snapshot.channelId)) return;
  throw musicError('Join the bot’s voice channel to control playback, or ask a server manager or DJ.', 403);
}

export function authorizeJoin({ manager, voiceChannelId, targetChannelId, snapshot }) {
  if (!targetChannelId) throw musicError('Join a voice channel first, or have a server manager or DJ choose one.');
  if (!manager && voiceChannelId !== targetChannelId) {
    throw musicError('You can only join or move the bot to your own voice channel.', 403);
  }
  if (!manager && snapshot.channelId && snapshot.channelId !== targetChannelId
      && (snapshot.nowPlaying || snapshot.tracks.length)) {
    throw musicError('The bot has an active queue in another voice channel. A server manager or DJ must move it.', 409);
  }
}

export function createBot({ config, media, metrics, activity, logger = console }, dependencies = {}) {
  const client = dependencies.client ?? new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const music = dependencies.music ?? new MusicManager({ media, dataDir: config.dataDir, maxQueueSize: config.maxQueueSize, idleDisconnectMs: config.idleDisconnectMs, logger });
  const locks = new Map();
  const radioRequests = new Map();
  const activeAudits = new Set();
  let ready = false;
  let closing = false;
  let queuesRestored = false;
  const isDeveloper = userId => typeof userId === 'string' && Boolean(config.developerDiscordUserId) && userId === config.developerDiscordUserId;

  function cancelRadioRequest(guildId) {
    const pending = radioRequests.get(guildId);
    if (pending) { radioRequests.delete(guildId); pending.abort(musicError('Radio settings changed. Try again.', 409)); }
  }

  function locked(guildId, operation) {
    const result = (locks.get(guildId) || Promise.resolve()).catch(() => {}).then(operation);
    locks.set(guildId, result);
    void result.finally(() => {
      if (locks.get(guildId) === result) locks.delete(guildId);
    }).catch(() => {});
    return result;
  }

  async function membership(guildId, userId) {
    if (!ready || closing) throw musicError('Discord is connecting. Please try again shortly.', 503);
    if (config.discordGuildId && guildId !== config.discordGuildId) throw musicError('This server is not enabled for this bot.', 404);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw musicError('The bot is not in that server.', 404);
    let member;
    try { member = await guild.members.fetch({ user: userId, force: true }); }
    catch (error) {
      if (error.code === 10007 || error.status === 404) throw musicError('You must be a member of that server.', 403);
      throw musicError('Discord could not verify your server membership. Please try again.', 503);
    }
    return { guild, member, manager: isManager(member, config.djRoleId) };
  }

  function visibleChannels(guild, member) {
    const ownMember = guild.members.me;
    return [...guild.channels.cache.values()]
      .filter(channel => channel.type === ChannelType.GuildVoice
        && channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])
        && ownMember && channel.permissionsFor(ownMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]))
      .sort((a, b) => a.position - b.position)
      .map(channel => ({ id: channel.id, name: channel.name }));
  }

  function createTransport(guild, channel) {
    const connection = joinVoiceChannel({
      channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true, selfMute: false, daveEncryption: true,
    });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    const voiceLog = createVoiceDiagnosticLog({ logger, guildId: guild.id, channelId: channel.id });
    const voiceNetwork = createVoiceNetworkHealth({ connection, onEvent: event => voiceLog.event(event) });
    const audioHealth = createAudioHealth({
      onMetric: metric => { music.emit('audioHealthMetric', metric); voiceLog.sample(metric); },
      getVoiceWsPing: () => connection.ping.ws,
      getVoiceNetworkMetrics: () => voiceNetwork.sample(),
    });
    let destroyed = false;
    const transport = {
      connection,
      prepare: prepareAudio,
      play(opened, onEnd, onError, onStarted) {
        const resource = opened.resource ?? createAudioResource(opened.stream, {
          inputType: StreamType.Arbitrary,
        });
        resource.metadata = { onEnd, onError, onStarted };
        audioHealth.observeResource(resource);
        player.play(resource);
      },
      stop() { player.stop(true); },
      pause() { player.pause(); },
      resume() { player.unpause(); },
      elapsedSec() { return (player.state.resource?.playbackDuration || 0) / 1000; },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        player.stop(true);
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        audioHealth.close();
        voiceNetwork.close();
        voiceLog.close();
      },
    };
    player.on('stateChange', (previous, next) => {
      audioHealth.playerState(next.status);
      voiceNetwork.playerState(next.status);
      if (next.status === AudioPlayerStatus.Playing && previous.resource !== next.resource) {
        next.resource?.metadata?.onStarted?.();
      } else if (next.status === AudioPlayerStatus.Playing && previous.status === AudioPlayerStatus.Buffering) {
        next.resource?.metadata?.onStarted?.();
      }
      if (next.status === AudioPlayerStatus.Idle && previous.status !== AudioPlayerStatus.Idle) {
        previous.resource?.metadata?.onEnd?.();
      }
    });
    connection.on('stateChange', (previous, next) => audioHealth.voiceStateChanged(previous.status, next.status));
    player.on('error', error => {
      if (error.resource?.metadata?.onError) error.resource.metadata.onError(error);
      else logger.warn('Audio player error:', error.message);
    });
    connection.on('error', error => {
      logger.warn('Voice connection error:', error.message);
      music.detach(guild.id, true, error, transport);
      transport.destroy();
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Discord can temporarily disconnect while changing voice servers or reconnecting.
      void Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).then(() => entersState(connection, VoiceConnectionStatus.Ready, 20_000)).catch(error => {
        if (!destroyed) music.detach(guild.id, true, error, transport);
      });
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      music.detach(guild.id, true, new Error('Voice connection destroyed'), transport);
    });
    connection.subscribe(player);
    return transport;
  }

  async function joinAs({ guild, member, manager }, channelId, { signal } = {}) {
    signal?.throwIfAborted();
    const snapshot = music.snapshot(guild.id);
    const targetChannelId = channelId || member.voice.channelId;
    authorizeJoin({ manager, voiceChannelId: member.voice.channelId, targetChannelId, snapshot });
    const channel = guild.channels.cache.get(targetChannelId);
    if (!channel || !visibleChannels(guild, member).some(item => item.id === targetChannelId)) {
      throw musicError('Choose a voice channel you can access where the bot can connect and speak.', 403);
    }
    if (snapshot.channelId === targetChannelId) return music.snapshot(guild.id);
    if (snapshot.channelId) music.detach(guild.id, true);
    const transport = createTransport(guild, channel);
    try {
      await entersState(transport.connection, VoiceConnectionStatus.Ready, signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : 20_000);
      signal?.throwIfAborted();
      if (closing) throw musicError('The bot is restarting. Please try again shortly.', 503);
      return music.attach(guild.id, transport, channel);
    } catch (error) {
      transport.destroy();
      if (signal?.aborted) signal.throwIfAborted();
      logger.warn('Could not join voice:', error.message);
      throw musicError('Could not connect to voice. Check the bot’s Connect/Speak permissions and the server’s outbound UDP access.', 503);
    }
  }

  const api = {
    music,
    developerAccess: userId => ({ allowed: isDeveloper(userId) }),
    async developerActivity(userId, input = {}) {
      // Check the configured account before consulting guilds, storage or filters.
      if (!isDeveloper(userId)) throw musicError('Developer access is required.', 403);
      const filters = validateActivityFilters(input);
      if (!activity) throw musicError('Command activity is temporarily unavailable.', 503);
      const result = await activity.query(filters);
      const guilds = new Map((result.guilds || []).map(guild => [guild.id, guild]));
      for (const guild of client.guilds.cache.values()) guilds.set(guild.id, { id: guild.id, name: guild.name });
      return { ...result, guilds: [...guilds.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    },
    async auditCommand(event, operation) {
      if (!activity) return operation();
      let settled;
      const completion = new Promise(resolve => { settled = resolve; });
      activeAudits.add(completion);
      const started = performance.now();
      const timestamp = new Date().toISOString();
      // All enrichment uses existing caches; auditing never starts a Discord
      // request or delays an operation waiting for an account lookup.
      const enrich = () => {
        const guild = client.guilds.cache.get(event.guildId);
        const member = guild?.members?.cache?.get(event.userId);
        const user = client.users?.cache?.get(event.userId);
        return {
          source: event.source, guildId: event.guildId, userId: event.userId,
          guildName: guild?.name, userName: event.userName || member?.displayName || user?.globalName || user?.username,
          command: event.command, parameters: sanitizeActivityParameters(event.parameters),
          timestamp, durationMs: performance.now() - started,
        };
      };
      const record = outcome => {
        try { activity.record({ ...enrich(), ...outcome }); }
        catch { try { logger.warn?.('Could not record command activity.'); } catch { /* Logging cannot change the command outcome. */ } }
      };
      try {
        const result = await operation();
        record({ status: 'success' });
        return result;
      } catch (error) {
        const cancelled = error?.name === 'AbortError' || ['ABORT_ERR', 'WORKER_CANCELLED', 'REQUEST_CANCELLED', 'MEDIA_CANCELLED'].includes(error?.code);
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
          ? error.code : Number.isInteger(error?.status) ? `HTTP_${error.status}` : cancelled ? 'ABORTED' : 'COMMAND_FAILED';
        record({ status: cancelled ? 'cancelled' : 'error', errorCode: code });
        throw error;
      } finally {
        activeAudits.delete(completion);
        settled();
      }
    },
    isReady: () => ready && client.isReady() && !closing,
    snapshot: guildId => music.snapshot(guildId),
    async start() {
      await music.restore();
      queuesRestored = true;
      if (closing) throw musicError('Bot startup was cancelled.', 503);
      const readyPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Discord did not become ready within 45 seconds.')), 45_000);
        timer.unref?.();
        client.once(Events.ClientReady, () => { clearTimeout(timer); resolve(); });
      });
      // Attach a handler immediately, including while login itself is pending.
      void readyPromise.catch(() => {});
      try {
        await client.login(config.discordToken);
        await readyPromise;
        if (closing) throw musicError('Bot startup was cancelled.', 503);
        const rest = dependencies.rest ?? new REST({ version: '10' }).setToken(config.discordToken);
        const route = config.discordGuildId
          ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
          : Routes.applicationCommands(config.discordClientId);
        await rest.put(route, { body: commands });
        if (closing) throw musicError('Bot startup was cancelled.', 503);
        ready = true;
        logger.info(`Discord connected as ${client.user.tag}; slash commands registered.`);
      } catch (error) {
        client.destroy();
        throw error;
      }
    },
    async shutdown() {
      closing = true;
      ready = false;
      for (const guildId of radioRequests.keys()) cancelRadioRequest(guildId);
      try {
        // In-flight connections must finish their closing check before final persistence.
        await Promise.allSettled([...locks.values()]);
        // Failed/unfinished restoration must never replace the original queue file.
        if (queuesRestored) await music.shutdown();
      } finally {
        try { await media.close?.(); }
        finally {
          // Provider work outside guild locks may finish its cancellation after
          // media.close. Keep the journal open until those outcomes are recorded.
          try { await Promise.allSettled([...activeAudits]); }
          finally { client.destroy(); }
        }
      }
    },
    async listGuilds(userId) {
      if (!api.isReady()) throw musicError('Discord is connecting. Please try again shortly.', 503);
      const guilds = [...client.guilds.cache.values()].filter(guild => !config.discordGuildId || guild.id === config.discordGuildId);
      const results = [];
      // Bound REST concurrency for installations with many servers.
      for (let offset = 0; offset < guilds.length; offset += 4) {
        const batch = await Promise.all(guilds.slice(offset, offset + 4).map(async guild => {
          try {
            await membership(guild.id, userId);
            return { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }) };
          } catch (error) {
            if (error.status === 403 || error.status === 404) return null;
            throw error;
          }
        }));
        results.push(...batch.filter(Boolean));
      }
      return results;
    },
    async context(guildId, userId) {
      const { guild, member, manager } = await membership(guildId, userId);
      const snapshot = music.snapshot(guildId);
      return {
        guild: { id: guild.id, name: guild.name },
        member: {
          canControl: manager || Boolean(snapshot.channelId && member.voice.channelId === snapshot.channelId),
          canManage: manager,
          canViewPerformance: manager || isDeveloper(userId),
          voiceChannelId: member.voice.channelId,
        },
        voiceChannels: visibleChannels(guild, member),
      };
    },
    async detail(guildId, userId) {
      // Membership is checked before reading or returning any queue snapshot.
      const context = await api.context(guildId, userId);
      return { ...context, queue: music.snapshot(guildId) };
    },
    async performance(guildId, userId) {
      if (!isDeveloper(userId)) {
        const { manager } = await membership(guildId, userId);
        if (!manager) throw musicError('Only a server manager or DJ can view host performance.', 403);
      }
      if (!metrics) throw musicError('Host performance is temporarily unavailable.', 503);
      return metrics.getSnapshot();
    },
    async join(guildId, userId, channelId) {
      return locked(guildId, async () => joinAs(await membership(guildId, userId), channelId));
    },
    async search(guildId, userId, query, source = 'youtube', { signal } = {}) {
      signal?.throwIfAborted();
      await membership(guildId, userId);
      signal?.throwIfAborted();
      if (typeof query !== 'string' || !query.trim() || query.length > 500) throw musicError('Enter a song or artist to search, up to 500 characters.');
      if (!['youtube', 'spotify'].includes(source)) throw musicError('Choose YouTube or Spotify for search.');
      // Searching never joins voice, reserves queue slots, or starts playback.
      const results = await media.search(query.trim(), source, { signal });
      signal?.throwIfAborted();
      return { results: results.slice(0, 5) };
    },
    async request(guildId, userId, query, channelId, { signal } = {}) {
      signal?.throwIfAborted();
      await membership(guildId, userId);
      signal?.throwIfAborted();
      if (typeof query !== 'string' || !query.trim() || query.length > 500) throw musicError('Enter a song name or a Spotify/YouTube track or playlist URL (up to 500 characters).');
      const available = Math.max(0, music.capacity(guildId));
      if (available < 1) throw musicError('The queue is full. Wait for a song to finish or remove one.', 409);
      let tracks;
      const releasePreflight = music.pausePreflight?.();
      try {
        tracks = await media.resolve(query.trim(), { signal, maxTracks: available });
        signal?.throwIfAborted();
        // A single request is accepted only after its playback match is known.
        // Playlist checks run in the queue so large imports do not hold HTTP
        // requests or the guild's control lock for minutes.
        if (!tracks.import && tracks.length === 1 && media.preflight) {
          tracks[0] = await media.preflight(tracks[0], { signal });
          signal?.throwIfAborted();
        }
      } finally { releasePreflight?.(); }
      return locked(guildId, async () => {
        signal?.throwIfAborted();
        const identity = await membership(guildId, userId);
        signal?.throwIfAborted();
        if (!tracks.length) throw musicError('No playable tracks were found.');
        const details = tracks.import ? structuredClone(tracks.import) : null;
        if (details) {
          const remaining = Math.max(0, music.capacity(guildId));
          if (remaining < 1) throw musicError('The queue filled while the playlist was loading. Nothing was added; try again when there is room.', 409);
          if (tracks.length > remaining) {
            details.notAddedForCapacity = tracks.length - remaining;
            tracks = tracks.slice(0, remaining);
            details.accepted = tracks.length;
            details.limitReached = true;
            details.warnings = [...(details.warnings || []), `The queue had room for ${tracks.length} tracks; ${details.notAddedForCapacity} additional tracks from this import were not added.`];
          } else if (details.limitReached && tracks.length === available) {
            details.warnings = [...(details.warnings || []), `The queue had room for ${tracks.length} tracks; the rest of the playlist was not added.`];
          }
        }
        music.assertCapacity(guildId, tracks.length);
        const snapshot = music.snapshot(guildId);
        if (!snapshot.channelId || (channelId && channelId !== snapshot.channelId)) await joinAs(identity, channelId, { signal });
        // Enqueue commits synchronously before awaiting persistence. A later
        // cancellation must not remove a request that has already committed.
        signal?.throwIfAborted();
        const added = await music.enqueue(guildId, tracks, { id: userId, username: identity.member.displayName });
        if (details && added.some(track => ['pending', 'checking', 'retry'].includes(track.validation?.status))) {
          details.warnings = [...new Set([...(details.warnings || []), 'Playback matches are being checked in the background.'])];
        }
        return {
          added: added.map(publicTrack), queue: music.snapshot(guildId),
          ...(details ? { import: details } : {}),
          warnings: details?.warnings || [],
        };
      });
    },
    async radio(guildId, userId, action, query, channelId, { signal } = {}) {
      signal?.throwIfAborted();
      if (!['start', 'stop'].includes(action)) throw musicError('Choose start or stop for radio.');
      if (query !== undefined && (action !== 'start' || typeof query !== 'string' || !query.trim() || query.length > 500)) {
        throw musicError('Choose one seed song or leave the song blank to use the current track.');
      }
      const authorize = identity => {
        const snapshot = music.snapshot(guildId);
        if (action === 'start' && !snapshot.channelId) {
          authorizeJoin({ manager: identity.manager, voiceChannelId: identity.member.voice.channelId,
            targetChannelId: channelId || identity.member.voice.channelId, snapshot });
        } else authorizeControl({ manager: identity.manager, userId, voiceChannelId: identity.member.voice.channelId, snapshot, action: 'radio' });
      };
      const identity = await membership(guildId, userId);
      signal?.throwIfAborted();
      authorize(identity);
      cancelRadioRequest(guildId);
      const controller = new AbortController();
      radioRequests.set(guildId, controller);
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        let seed;
        if (query !== undefined) {
          const tracks = await media.resolve(query.trim(), { signal: requestSignal, maxTracks: 1 });
          requestSignal.throwIfAborted();
          if (tracks.import || tracks.length !== 1) throw musicError('Radio needs one seed song, not a playlist.');
          seed = media.preflight ? await media.preflight(tracks[0], { signal: requestSignal }) : tracks[0];
        }
        return await locked(guildId, async () => {
          requestSignal.throwIfAborted();
          const currentIdentity = await membership(guildId, userId);
          requestSignal.throwIfAborted();
          authorize(currentIdentity);
          if (action === 'stop') return music.stopRadio(guildId);
          seed ??= music.snapshot(guildId).nowPlaying;
          if (!seed) throw musicError('Play a song first, or provide a seed song for radio.', 409);
          const snapshot = music.snapshot(guildId);
          if (!snapshot.channelId || channelId && channelId !== snapshot.channelId) await joinAs(currentIdentity, channelId, { signal: requestSignal });
          requestSignal.throwIfAborted();
          // Station lifetime is independent of this HTTP request once committed.
          return music.startRadio(guildId, seed, { id: userId, username: currentIdentity.member.displayName });
        });
      } finally {
        if (radioRequests.get(guildId) === controller) radioRequests.delete(guildId);
      }
    },
    async setVolume(guildId, userId, volumePercent, { signal } = {}) {
      signal?.throwIfAborted();
      return locked(guildId, async () => {
        signal?.throwIfAborted();
        const { member, manager } = await membership(guildId, userId);
        signal?.throwIfAborted();
        if (!Number.isInteger(volumePercent) || volumePercent < 0 || volumePercent > 100) {
          throw musicError('Volume must be a whole number from 0 to 100.', 400);
        }
        authorizeControl({ manager, userId, voiceChannelId: member.voice.channelId, snapshot: music.snapshot(guildId), action: 'volume' });
        // Once committed, a disconnected client must not roll back the setting.
        return music.setVolume(guildId, volumePercent);
      });
    },
    async control(guildId, userId, action, trackId) {
      return locked(guildId, async () => {
        const { member, manager } = await membership(guildId, userId);
        const snapshot = music.snapshot(guildId);
        authorizeControl({ manager, userId, voiceChannelId: member.voice.channelId, snapshot, action, trackId });
        if (['stop', 'leave'].includes(action)) cancelRadioRequest(guildId);
        return music.control(guildId, action, trackId);
      });
    },
  };

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    try {
      const content = await api.auditCommand({
        source: 'discord', guildId: interaction.guildId, userId: interaction.user.id,
        userName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
        command: interaction.commandName, parameters: slashParameters(interaction),
      }, async () => {
      if (!interaction.guildId) throw musicError('Use this command inside a Discord server.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guildId = interaction.guildId;
      const userId = interaction.user.id;
      let content;
      switch (interaction.commandName) {
        case 'play': {
          const result = await api.request(guildId, userId, interaction.options.getString('query', true));
          content = formatRequestReply(result);
          break;
        }
        case 'join':
          await api.join(guildId, userId);
          content = 'Joined your voice channel. The queue is ready.';
          break;
        case 'queue': {
          await api.context(guildId, userId);
          const state = music.snapshot(guildId);
          content = state.nowPlaying ? `**${state.paused ? 'Paused' : 'Now playing'}:** ${safeText(state.nowPlaying.title)}\n` : '**Nothing playing yet.**\n';
          content += state.tracks.length
            ? state.tracks.slice(0, 10).map((track, index) => `${index + 1}. ${safeText(track.title)} — ${safeText(track.requestedBy.username)}`).join('\n')
            : 'The waiting queue is empty.';
          if (state.tracks.length > 10) content += `\n…and ${state.tracks.length - 10} more. Open /portal to see every request.`;
          break;
        }
        case 'volume': {
          const percent = interaction.options.getInteger('percent');
          let state;
          if (percent === null) {
            await api.context(guildId, userId);
            state = music.snapshot(guildId);
          } else state = await api.setVolume(guildId, userId, percent);
          content = `Volume${percent === null ? '' : ' set to'}: **${state.volumePercent}%**.`;
          break;
        }
        case 'radio': {
          const state = await api.radio(guildId, userId, 'start', interaction.options.getString('query') ?? undefined);
          content = `Radio started from **${safeText(state.radio.seed.title)}**. Adds 10 similar songs at a time; manual requests play first. Use /radio-stop to stop adding songs and remove waiting radio picks.`;
          break;
        }
        case 'radio-stop':
          await api.radio(guildId, userId, 'stop');
          content = 'Radio stopped. The current song and manual requests are kept.';
          break;
        case 'portal':
          await api.context(guildId, userId);
          content = `Request songs and manage the queue: ${config.publicUrl}/?guild=${guildId}`;
          break;
        default:
          await api.control(guildId, userId, interaction.commandName);
          content = {
            skip: 'Skipped the song.', pause: 'Playback paused.', resume: 'Playback resumed.',
            shuffle: 'Shuffled the waiting queue.',
            stop: 'Playback stopped and the queue cleared.', leave: 'Left voice. The queue is saved; /join continues it.',
          }[interaction.commandName] || 'Queue updated.';
      }
      return content;
      });
      await interaction.editReply({ content: content.slice(0, 2_000), allowedMentions: { parse: [] } });
    } catch (error) {
      if (!error.status) logger.error('Slash command failed:', error.message);
      const content = error.status ? error.message : 'Something went wrong while handling that request. Please try again.';
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, allowedMentions: { parse: [] } });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      } catch (replyError) { logger.warn('Could not reply to Discord command:', replyError.message); }
    }
  });

  client.on(Events.VoiceStateUpdate, (previous, next) => {
    if (next.id !== client.user?.id) return;
    const state = music.state(next.guild.id);
    if (!state.transport) return;
    if (!next.channelId) music.detach(next.guild.id, true, new Error('Bot removed from voice'), state.transport);
    else if (state.channelId !== next.channelId && next.channel) music.attach(next.guild.id, state.transport, next.channel);
  });
  client.on(Events.Error, error => logger.error('Discord client error:', error.message));
  return api;
}

export function formatRequestReply({ added, import: details, warnings = [] }) {
  let content = details
    ? `Added **${added.length} track${added.length === 1 ? '' : 's'}**${details.title ? ` from **${safeText(details.title)}**` : ''} to the queue.`
    : `Added **${safeText(added[0].title)}**${added.length > 1 ? ` and ${added.length - 1} more songs` : ''} to the queue.`;
  if (details?.skipped) content += ` ${details.skipped} playlist entr${details.skipped === 1 ? 'y was' : 'ies were'} skipped.`;
  if (details?.limitReached) content += ` Only the first ${details.inspected} playlist entries were checked.`;
  if (warnings.length) content += `\n${warnings.slice(0, 5).map(warning => safeText(warning)).join('\n')}`;
  return content;
}

function safeText(value) {
  return String(value || '').replace(/[\\`*_~|<>@]/g, '').replace(/[\r\n]/g, ' ').slice(0, 130);
}

function slashParameters(interaction) {
  try {
    if (['play', 'radio'].includes(interaction.commandName)) return { query: interaction.options.getString('query') ?? undefined };
    if (interaction.commandName === 'volume') return { volumePercent: interaction.options.getInteger('percent') ?? undefined };
  } catch { /* Malformed options are handled and recorded by the command itself. */ }
  return {};
}
