import {
  ChannelType, Client, Events, GatewayIntentBits, MessageFlags,
  PermissionFlagsBits, REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import {
  AudioPlayerStatus, NoSubscriberBehavior, StreamType, VoiceConnectionStatus,
  createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
} from '@discordjs/voice';
import { MusicManager, musicError } from './music.mjs';

const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Request a song or playlist from Spotify or YouTube')
    .addStringOption(option => option.setName('query').setDescription('Song name, or a Spotify/YouTube track or playlist URL').setRequired(true).setMaxLength(500)),
  ...[
    ['queue', 'Show the current song and waiting queue'],
    ['join', 'Join your voice channel and continue the queue'],
    ['skip', 'Skip the current song'],
    ['shuffle', 'Shuffle waiting songs without interrupting the current track'],
    ['pause', 'Pause playback'],
    ['resume', 'Resume playback'],
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

export function createBot({ config, media, logger = console }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const music = new MusicManager({ media, dataDir: config.dataDir, maxQueueSize: config.maxQueueSize, idleDisconnectMs: config.idleDisconnectMs, logger });
  const locks = new Map();
  let ready = false;
  let closing = false;
  let queuesRestored = false;

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
    let destroyed = false;
    const transport = {
      connection,
      play(opened, onEnd, onError) {
        const resource = createAudioResource(opened.stream, {
          inputType: StreamType.Arbitrary,
          metadata: { onEnd, onError },
        });
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
      },
    };
    player.on('stateChange', (previous, next) => {
      if (next.status === AudioPlayerStatus.Idle && previous.status !== AudioPlayerStatus.Idle) {
        previous.resource?.metadata?.onEnd?.();
      }
    });
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

  async function joinAs({ guild, member, manager }, channelId) {
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
      await entersState(transport.connection, VoiceConnectionStatus.Ready, 20_000);
      if (closing) throw musicError('The bot is restarting. Please try again shortly.', 503);
      return music.attach(guild.id, transport, channel);
    } catch (error) {
      transport.destroy();
      logger.warn('Could not join voice:', error.message);
      throw musicError('Could not connect to voice. Check the bot’s Connect/Speak permissions and the server’s outbound UDP access.', 503);
    }
  }

  const api = {
    music,
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
        const rest = new REST({ version: '10' }).setToken(config.discordToken);
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
      try {
        // In-flight connections must finish their closing check before final persistence.
        await Promise.allSettled([...locks.values()]);
        // Failed/unfinished restoration must never replace the original queue file.
        if (queuesRestored) await music.shutdown();
      } finally {
        client.destroy();
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
          voiceChannelId: member.voice.channelId,
        },
        voiceChannels: visibleChannels(guild, member),
      };
    },
    async join(guildId, userId, channelId) {
      return locked(guildId, async () => joinAs(await membership(guildId, userId), channelId));
    },
    async search(guildId, userId, query, source = 'youtube') {
      await membership(guildId, userId);
      if (typeof query !== 'string' || !query.trim() || query.length > 500) throw musicError('Enter a song or artist to search, up to 500 characters.');
      if (!['youtube', 'spotify'].includes(source)) throw musicError('Choose YouTube or Spotify for search.');
      // Searching never joins voice, reserves queue slots, or starts playback.
      const results = await media.search(query.trim(), source);
      return { results: results.slice(0, 5) };
    },
    async request(guildId, userId, query, channelId) {
      await membership(guildId, userId);
      if (typeof query !== 'string' || !query.trim() || query.length > 500) throw musicError('Enter a song name or a Spotify/YouTube track or playlist URL (up to 500 characters).');
      if (music.capacity(guildId) < 1) throw musicError('The queue is full. Wait for a song to finish or remove one.', 409);
      const tracks = await media.resolve(query.trim());
      return locked(guildId, async () => {
        const identity = await membership(guildId, userId);
        if (!tracks.length) throw musicError('No playable tracks were found.');
        music.assertCapacity(guildId, tracks.length);
        const snapshot = music.snapshot(guildId);
        if (!snapshot.channelId || (channelId && channelId !== snapshot.channelId)) await joinAs(identity, channelId);
        const added = await music.enqueue(guildId, tracks, { id: userId, username: identity.member.displayName });
        const details = tracks.import ? structuredClone(tracks.import) : null;
        return {
          added, queue: music.snapshot(guildId),
          ...(details ? { import: details } : {}),
          warnings: details?.warnings || [],
        };
      });
    },
    async control(guildId, userId, action, trackId) {
      return locked(guildId, async () => {
        const { member, manager } = await membership(guildId, userId);
        const snapshot = music.snapshot(guildId);
        authorizeControl({ manager, userId, voiceChannelId: member.voice.channelId, snapshot, action, trackId });
        return music.control(guildId, action, trackId);
      });
    },
  };

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    try {
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
