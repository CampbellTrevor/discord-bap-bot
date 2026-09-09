import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { MediaError } from './media.mjs';

const VERSION = 1;
const WORKER_PATH = '/internal/worker';
const MAX_PAYLOAD = 1024 * 1024;
const ID = /^\d{17,20}$/;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACTIONS = new Set(['skip', 'pause', 'resume', 'stop', 'leave', 'remove', 'shuffle']);
const METHODS = new Set(['listGuilds', 'detail', 'search', 'request', 'join', 'control']);
const MUTATIONS = new Set(['request', 'join', 'control']);
const STATUSES = new Set([400, 403, 404, 409, 429, 503]);
const MEDIA_CODES = new Set([
  'INVALID_QUERY', 'UNSUPPORTED_MEDIA', 'INVALID_MEDIA', 'TRACK_TOO_LONG', 'SPOTIFY_NOT_FOUND',
  'MEDIA_CANCELLED', 'EMPTY_PLAYLIST', 'MEDIA_UNAVAILABLE', 'MEDIA_TIMEOUT', 'MEDIA_BUSY',
  'YOUTUBE_REQUEST_BLOCKED', 'YOUTUBE_RATE_LIMITED', 'YOUTUBE_RESTRICTED', 'YOUTUBE_FORMAT_UNAVAILABLE',
  'YOUTUBE_UNAVAILABLE', 'EXTRACTOR_RUNTIME_UNAVAILABLE', 'EXTRACTOR_UNAVAILABLE',
  'SPOTIFY_UNAVAILABLE', 'SPOTIFY_QUOTA_EXCEEDED', 'SPOTIFY_RATE_LIMITED', 'SPOTIFY_REAUTHORIZE',
  'SPOTIFY_UNAUTHORIZED', 'SPOTIFY_FORBIDDEN', 'SPOTIFY_AUTH_STORAGE', 'SPOTIFY_NOT_CONFIGURED', 'SPOTIFY_PLAYLIST_ACCESS',
]);
const BRIDGE_CODES = new Set([
  'WORKER_UNAVAILABLE', 'WORKER_BUSY', 'WORKER_TIMEOUT', 'WORKER_CANCELLED', 'WORKER_OUTCOME_UNKNOWN',
  'WORKER_INVALID_REQUEST', 'WORKER_DUPLICATE_REQUEST', 'WORKER_OPERATION_FAILED', 'WORKER_RESULT_TOO_LARGE',
]);
// These messages originate in the bot, not in Discord responses or extractor stderr.
const PUBLIC_MESSAGES = new Set([
  'That song is no longer in the waiting queue.',
  'You can only remove your own requests. A server manager or DJ can remove any request.',
  'Join the bot’s voice channel to control playback, or ask a server manager or DJ.',
  'Join a voice channel first, or have a server manager or DJ choose one.',
  'You can only join or move the bot to your own voice channel.',
  'The bot has an active queue in another voice channel. A server manager or DJ must move it.',
  'Discord is connecting. Please try again shortly.',
  'This server is not enabled for this bot.',
  'The bot is not in that server.',
  'You must be a member of that server.',
  'Discord could not verify your server membership. Please try again.',
  'Choose a voice channel you can access where the bot can connect and speak.',
  'The bot is restarting. Please try again shortly.',
  'Could not connect to voice. Check the bot’s Connect/Speak permissions and the server’s outbound UDP access.',
  'Enter a song or artist to search, up to 500 characters.',
  'Choose YouTube or Spotify for search.',
  'Enter a song name or a Spotify/YouTube track or playlist URL (up to 500 characters).',
  'The queue is full. Wait for a song to finish or remove one.',
  'No playable tracks were found.',
  'Nothing is playing.',
  'At least two songs must be waiting in the queue to shuffle.',
  'Unknown playback action.',
]);
const CAPACITY_MESSAGE = /^This request contains \d{1,4} tracks?, but only \d{1,4} queue slots? (?:is|are) available \(limit \d{1,4}, including the current track\)\. Nothing was added\. Try a smaller request or wait for space\.$/;

class BridgeError extends Error {
  constructor(message, code, status = 503) {
    super(message);
    this.name = 'WorkerBridgeError';
    this.code = code;
    this.status = status;
  }
}

function unavailable() {
  return new BridgeError('The audio worker is disconnected or still connecting to Discord. Please try again shortly.', 'WORKER_UNAVAILABLE');
}

function interrupted(method, reason) {
  if (MUTATIONS.has(method)) return new BridgeError('The worker connection was interrupted before confirmation. The action may have completed. Refresh the queue before trying again.', 'WORKER_OUTCOME_UNKNOWN');
  if (reason === 'cancel') return new BridgeError('The worker request was cancelled.', 'WORKER_CANCELLED', 400);
  if (reason === 'timeout') return new BridgeError('The audio worker took too long. Please try again.', 'WORKER_TIMEOUT');
  return unavailable();
}

function validateSecret(secret) {
  if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(secret)) {
    throw new Error('WORKER_SECRET must contain 32 to 256 printable characters without spaces.');
  }
}

function duration(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Worker bridge timing values must be positive integers.');
  return value;
}

function limit(value, fallback) {
  const result = duration(value, fallback);
  if (result > 1024) throw new Error('Worker bridge concurrency must not exceed 1024.');
  return result;
}

function log(logger, operation, code) {
  try { logger?.warn?.('Worker bridge event.', { operation, code }); } catch { /* Logging cannot interrupt cleanup. */ }
}

function genericMessage(status) {
  if (status === 400) return 'The music request is invalid. Check the request and try again.';
  if (status === 403) return 'You do not have permission to perform this action in that server.';
  if (status === 404) return 'The requested server or queue item could not be found.';
  if (status === 409) return 'The queue changed or cannot accept this action. Refresh it and try again.';
  if (status === 429) return 'Too many music requests. Please wait before trying again.';
  return 'The audio worker could not complete this action. Please try again.';
}

function cleanMessage(message, fallback, secret) {
  if (typeof message !== 'string' || !message || message.length > 1000
      || /[\u0000-\u001f\u007f]|https?:\/\/|wss?:\/\/|bearer\s|authorization\s*[:=]|(?:access|refresh)[_-]?token\s*[:=]|secret\s*[:=]|[A-Z]:\\|\/(?:home|var|etc)\//iu.test(message)
      || message.includes(secret)) return fallback;
  return message;
}

function publicError(error, secret) {
  const status = STATUSES.has(error?.status) ? error.status : 503;
  const fallback = genericMessage(status);
  if (error instanceof BridgeError || error instanceof MediaError && MEDIA_CODES.has(error.code)) {
    return { status, code: error.code, message: cleanMessage(error.message, fallback, secret) };
  }
  const message = error instanceof Error && (PUBLIC_MESSAGES.has(error.message) || CAPACITY_MESSAGE.test(error.message))
    ? cleanMessage(error.message, fallback, secret) : fallback;
  return { status, code: 'WORKER_OPERATION_FAILED', message };
}

function receiveError(value, secret) {
  if (!shape(value, ['status', 'code', 'message']) || !STATUSES.has(value.status)
      || !(MEDIA_CODES.has(value.code) || BRIDGE_CODES.has(value.code))) return new BridgeError(genericMessage(503), 'WORKER_OPERATION_FAILED');
  return new BridgeError(cleanMessage(value.message, genericMessage(value.status), secret), value.code, value.status);
}

function shape(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function parseFrame(data, isBinary) {
  if (isBinary) return null;
  try {
    const frame = JSON.parse(data.toString());
    return frame?.v === VERSION && typeof frame.type === 'string' ? frame : null;
  } catch { return null; }
}

function sendFrame(socket, frame) {
  if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_PAYLOAD * 2) return false;
  let data;
  try { data = JSON.stringify(frame); } catch { return false; }
  if (Buffer.byteLength(data) > MAX_PAYLOAD) return false;
  try {
    socket.send(data, error => { if (error) socket.terminate(); });
    return true;
  } catch { return false; }
}

function validArguments(method, args) {
  if (!METHODS.has(method) || !Array.isArray(args)) return false;
  if (method === 'listGuilds') return args.length === 1 && typeof args[0] === 'string' && ID.test(args[0]);
  if (args.length < 2 || !args.slice(0, 2).every(value => typeof value === 'string' && ID.test(value))) return false;
  const optionalId = value => value === null || value === undefined || typeof value === 'string' && ID.test(value);
  const query = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value);
  if (method === 'detail') return args.length === 2;
  if (method === 'search') return args.length === 4 && query(args[2]) && ['youtube', 'spotify'].includes(args[3]);
  if (method === 'request') return args.length === 4 && query(args[2]) && optionalId(args[3]);
  if (method === 'join') return args.length === 3 && optionalId(args[2]);
  if (method === 'control') return args.length === 4 && ACTIONS.has(args[2])
    && (args[2] === 'remove' ? typeof args[3] === 'string' && REQUEST_ID.test(args[3]) : args[3] === null || args[3] === undefined);
  return false;
}

function isLoopback(address) {
  return address === '::1' || address === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address ?? '') || /^::ffff:127\./i.test(address ?? '');
}

function workerUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('WORKER_URL must be a valid HTTPS portal URL.'); }
  if (url.username || url.password || url.search || url.hash || !['/', WORKER_PATH].includes(url.pathname)
      || !['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol)) throw new Error('WORKER_URL must name the portal origin or /internal/worker, without credentials or query parameters.');
  if (['http:', 'ws:'].includes(url.protocol) && !isLoopback(url.hostname.replace(/^\[|\]$/g, ''))) {
    throw new Error('The audio worker requires HTTPS or WSS outside loopback.');
  }
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  url.pathname = WORKER_PATH;
  return url.href;
}

/** Portal-side proxy. Only the worker owns Discord membership checks and queue state. */
export function createWorkerBridge({ secret, logger = console, trustProxy = false, readTimeoutMs, requestTimeoutMs,
  heartbeatTimeoutMs, maxPending, now = Date.now } = {}) {
  validateSecret(secret);
  const readTimeout = duration(readTimeoutMs, 30_000);
  const requestTimeout = duration(requestTimeoutMs, 120_000);
  const heartbeatTimeout = duration(heartbeatTimeoutMs, 45_000);
  const pendingLimit = limit(maxPending, 32);
  const expectedAuth = createHash('sha256').update(`Bearer ${secret}`).digest();
  const wss = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: MAX_PAYLOAD });
  const pending = new Map();
  let server;
  let worker;
  let closed = false;
  let upgrading = false;

  function fresh() {
    return !closed && worker?.socket.readyState === WebSocket.OPEN && worker.heartbeatReceived && now() - worker.lastHeartbeat <= heartbeatTimeout;
  }

  function disconnect(current, code = 'WORKER_DISCONNECTED') {
    if (worker !== current) return;
    worker = undefined;
    for (const entry of pending.values()) entry.finish(interrupted(entry.method, 'disconnect'));
    current.socket.terminate();
    log(logger, 'connection', code);
  }

  const watchdog = setInterval(() => {
    if (worker && now() - worker.lastHeartbeat > heartbeatTimeout) disconnect(worker, 'WORKER_HEARTBEAT_EXPIRED');
  }, Math.max(1, Math.min(1000, Math.floor(heartbeatTimeout / 3))));
  watchdog.unref?.();

  function upgrade(req, socket, head) {
    const deny = status => {
      socket.on('error', () => {});
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (closed || req.url !== WORKER_PATH) return deny('404 Not Found');
    const secure = req.socket.encrypted || isLoopback(req.socket.remoteAddress)
      || trustProxy && req.headers['x-forwarded-proto'] === 'https';
    const authorization = typeof req.headers.authorization === 'string' && req.headers.authorization.length <= 512 ? req.headers.authorization : '';
    const actualAuth = createHash('sha256').update(authorization).digest();
    if (!secure || req.headers.origin !== undefined || !timingSafeEqual(expectedAuth, actualAuth)) return deny('401 Unauthorized');
    if (worker && now() - worker.lastHeartbeat > heartbeatTimeout) disconnect(worker, 'WORKER_HEARTBEAT_EXPIRED');
    if (worker || upgrading) return deny('409 Conflict');
    upgrading = true;
    try {
      wss.handleUpgrade(req, socket, head, connection => {
        const current = { socket: connection, lastHeartbeat: now(), heartbeatReceived: false, ready: false, spotifyEnabled: false };
        worker = current;
        connection.on('error', () => disconnect(current, 'WORKER_SOCKET_ERROR'));
        connection.on('close', () => disconnect(current));
        connection.on('message', (data, isBinary) => {
          if (worker !== current) return;
          const frame = parseFrame(data, isBinary);
          if (frame?.type === 'heartbeat' && shape(frame, ['v', 'type', 'botReady', 'spotifyEnabled'])
              && typeof frame.botReady === 'boolean' && typeof frame.spotifyEnabled === 'boolean') {
            current.lastHeartbeat = now();
            current.heartbeatReceived = true;
            current.ready = frame.botReady;
            current.spotifyEnabled = frame.spotifyEnabled;
            if (!sendFrame(connection, { v: VERSION, type: 'ack' })) disconnect(current);
            return;
          }
          if (frame?.type === 'result' && typeof frame.id === 'string' && REQUEST_ID.test(frame.id) && typeof frame.ok === 'boolean'
              && shape(frame, ['v', 'type', 'id', 'ok', frame.ok ? 'result' : 'error'])) {
            const entry = pending.get(frame.id);
            if (entry) entry.finish(frame.ok ? null : receiveError(frame.error, secret), frame.result);
            return; // Timed-out and cancelled response IDs are never reused.
          }
          disconnect(current, 'WORKER_PROTOCOL_ERROR');
        });
        if (!sendFrame(connection, { v: VERSION, type: 'welcome' })) disconnect(current);
      });
    } catch {
      socket.destroy();
      log(logger, 'upgrade', 'WORKER_UPGRADE_FAILED');
    } finally { upgrading = false; }
  }

  function rpc(method, args, options) {
    return new Promise((resolve, reject) => {
      if (!validArguments(method, args)) return reject(new BridgeError('The worker request arguments are invalid.', 'WORKER_INVALID_REQUEST', 400));
      const signal = options?.signal;
      if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) {
        return reject(new BridgeError('The request cancellation options are invalid.', 'WORKER_INVALID_REQUEST', 400));
      }
      if (signal?.aborted) return reject(new BridgeError('The worker request was cancelled.', 'WORKER_CANCELLED', 400));
      if (!fresh() || !worker.ready) return reject(unavailable());
      if (pending.size >= pendingLimit) return reject(new BridgeError('The audio worker is busy. Please try again shortly.', 'WORKER_BUSY'));
      const connection = worker.socket;
      const id = randomUUID();
      let timer;
      const abort = () => cancel('cancel');
      const entry = {
        method,
        finish(error, result) {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(result);
        },
      };
      function cancel(reason) {
        if (!pending.has(id)) return;
        sendFrame(connection, { v: VERSION, type: 'cancel', id });
        entry.finish(interrupted(method, reason));
      }
      pending.set(id, entry);
      timer = setTimeout(() => cancel('timeout'), method === 'request' ? requestTimeout : readTimeout);
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      if (!sendFrame(connection, { v: VERSION, type: 'call', id, method, args })) {
        entry.finish(interrupted(method, 'disconnect'));
        if (worker?.socket === connection) disconnect(worker);
      }
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(watchdog);
    server?.removeListener('upgrade', upgrade);
    if (worker) disconnect(worker, 'WORKER_BRIDGE_CLOSED');
    wss.close();
  }

  const bot = {
    isReady: () => Boolean(fresh() && worker.ready),
    capabilities: () => ({ spotifyEnabled: Boolean(fresh() && worker.spotifyEnabled) }),
    listGuilds: (userId, options) => rpc('listGuilds', [userId], options),
    detail: (guildId, userId, options) => rpc('detail', [guildId, userId], options),
    search: (guildId, userId, query, source = 'youtube', options) => rpc('search', [guildId, userId, query, source], options),
    request: (guildId, userId, query, channelId, options) => rpc('request', [guildId, userId, query, channelId ?? null], options),
    join: (guildId, userId, channelId, options) => rpc('join', [guildId, userId, channelId ?? null], options),
    control: (guildId, userId, action, trackId, options) => rpc('control', [guildId, userId, action, trackId ?? null], options),
    shutdown: close,
  };
  return {
    bot,
    attach(httpServer) {
      if (closed) throw new Error('The worker bridge is closed.');
      if (server) throw new Error('The worker bridge is already attached.');
      server = httpServer;
      server.on('upgrade', upgrade);
    },
    close,
  };
}

/** Worker-side connection. Its lifecycle is intentionally independent from the Discord bot. */
export function connectWorker({ url, secret, bot, spotifyEnabled = false, logger = console, heartbeatMs,
  heartbeatTimeoutMs, reconnectMinMs, reconnectMaxMs, handshakeTimeoutMs, readTimeoutMs,
  requestTimeoutMs, maxPending, now = Date.now, random = Math.random } = {}) {
  validateSecret(secret);
  const endpoint = workerUrl(url);
  if (!bot || typeof bot.isReady !== 'function') throw new Error('The worker needs a Discord bot with isReady().');
  const heartbeatInterval = duration(heartbeatMs, 15_000);
  const heartbeatTimeout = duration(heartbeatTimeoutMs, 45_000);
  const minimumRetry = duration(reconnectMinMs, 1000);
  const maximumRetry = Math.max(minimumRetry, duration(reconnectMaxMs, 30_000));
  const handshakeTimeout = duration(handshakeTimeoutMs, 10_000);
  const readTimeout = duration(readTimeoutMs, 30_000);
  const requestTimeout = duration(requestTimeoutMs, 120_000);
  const pendingLimit = limit(maxPending, 32);
  const executing = new Map();
  const seen = new Map();
  let socket;
  let retryTimer;
  let retryDelay = minimumRetry;
  let closed = false;
  let cleanupCurrent = () => {};

  function remember(id) {
    for (const [oldId, time] of seen) {
      if (now() - time < 10 * 60_000 && seen.size < 4096) break;
      seen.delete(oldId);
    }
    if (seen.has(id) || executing.has(id)) return false;
    seen.set(id, now());
    return true;
  }

  function reconnect() {
    if (closed || retryTimer) return;
    const sample = random();
    const jitter = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
    const delay = Math.min(maximumRetry, Math.max(1, Math.round(retryDelay * (0.8 + jitter * 0.4))));
    retryDelay = Math.min(maximumRetry, retryDelay * 2);
    retryTimer = setTimeout(() => { retryTimer = undefined; open(); }, delay);
    retryTimer.unref?.();
  }

  function open() {
    if (closed) return;
    const connection = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${secret}` }, followRedirects: false, rejectUnauthorized: true,
      perMessageDeflate: false, maxPayload: MAX_PAYLOAD, handshakeTimeout,
    });
    socket = connection;
    let welcomed = false;
    let lastAcknowledged = now();
    let heartbeatTimer;
    let welcomeTimer;
    let cleaned = false;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeatTimer);
      clearTimeout(welcomeTimer);
      for (const task of executing.values()) {
        if (task.connection === connection) task.cancel();
      }
    }
    cleanupCurrent = cleanup;

    function heartbeat() {
      if (now() - lastAcknowledged > heartbeatTimeout) return connection.terminate();
      let ready = false;
      try { ready = bot.isReady() === true; } catch { /* Failed readiness never enables portal controls. */ }
      if (!sendFrame(connection, { v: VERSION, type: 'heartbeat', botReady: ready, spotifyEnabled: Boolean(spotifyEnabled) })) connection.terminate();
    }

    function reply(id, result, error) {
      if (cleaned || connection.readyState !== WebSocket.OPEN) return;
      const frame = error
        ? { v: VERSION, type: 'result', id, ok: false, error: publicError(error, secret) }
        : { v: VERSION, type: 'result', id, ok: true, result: result ?? null };
      if (!sendFrame(connection, frame)) {
        const tooLarge = new BridgeError('The worker response was too large to send. Please reduce the queue size.', 'WORKER_RESULT_TOO_LARGE');
        if (!sendFrame(connection, { v: VERSION, type: 'result', id, ok: false, error: publicError(tooLarge, secret) })) connection.terminate();
      }
    }

    async function dispatch(frame) {
      const { id, method, args } = frame;
      if (!validArguments(method, args)) return reply(id, null, new BridgeError('The worker request arguments are invalid.', 'WORKER_INVALID_REQUEST', 400));
      if (!remember(id)) return reply(id, null, new BridgeError('This worker request has already been received. Refresh the queue before trying again.', 'WORKER_DUPLICATE_REQUEST', 409));
      if (executing.size >= pendingLimit) return reply(id, null, new BridgeError('The audio worker is busy. Please try again shortly.', 'WORKER_BUSY'));
      let ready = false;
      try { ready = bot.isReady() === true; } catch { /* Readiness is checked again for every call. */ }
      if (!ready) return reply(id, null, unavailable());
      const controller = new AbortController();
      const task = { connection, cancelled: false, cancel() {
        if (task.cancelled) return;
        task.cancelled = true;
        controller.abort(new BridgeError('The worker request was cancelled.', 'WORKER_CANCELLED', 400));
      } };
      executing.set(id, task);
      const timeout = setTimeout(() => {
        reply(id, null, interrupted(method, 'timeout'));
        task.cancel();
      }, method === 'request' ? requestTimeout : readTimeout);
      timeout.unref?.();
      try {
        let result;
        // No caller-controlled property dispatch or deserialized cancellation object.
        switch (method) {
          case 'listGuilds': result = await bot.listGuilds(args[0]); break;
          case 'detail': result = await bot.detail(args[0], args[1]); break;
          case 'search': result = await bot.search(args[0], args[1], args[2], args[3], { signal: controller.signal }); break;
          case 'request': result = await bot.request(args[0], args[1], args[2], args[3] ?? undefined, { signal: controller.signal }); break;
          case 'join': result = await bot.join(args[0], args[1], args[2] ?? undefined); break;
          case 'control': result = await bot.control(args[0], args[1], args[2], args[3] ?? undefined); break;
        }
        if (!task.cancelled) reply(id, result);
      } catch (error) {
        if (!task.cancelled) {
          const exposed = publicError(error, secret);
          log(logger, method, exposed.code);
          reply(id, null, error);
        }
      } finally {
        clearTimeout(timeout);
        executing.delete(id);
      }
    }

    connection.on('open', () => {
      welcomeTimer = setTimeout(() => connection.terminate(), handshakeTimeout);
      welcomeTimer.unref?.();
    });
    connection.on('message', (data, isBinary) => {
      if (closed || cleaned) return;
      const frame = parseFrame(data, isBinary);
      if (!welcomed && frame?.type === 'welcome' && shape(frame, ['v', 'type'])) {
        welcomed = true;
        retryDelay = minimumRetry;
        clearTimeout(welcomeTimer);
        lastAcknowledged = now();
        heartbeat();
        heartbeatTimer = setInterval(heartbeat, heartbeatInterval);
        heartbeatTimer.unref?.();
        return;
      }
      if (!welcomed) return connection.terminate();
      if (frame?.type === 'ack' && shape(frame, ['v', 'type'])) { lastAcknowledged = now(); return; }
      if (frame?.type === 'cancel' && shape(frame, ['v', 'type', 'id']) && typeof frame.id === 'string' && REQUEST_ID.test(frame.id)) {
        const task = executing.get(frame.id);
        if (task?.connection === connection) task.cancel();
        return;
      }
      if (frame?.type === 'call' && shape(frame, ['v', 'type', 'id', 'method', 'args']) && typeof frame.id === 'string' && REQUEST_ID.test(frame.id)) {
        void dispatch(frame);
        return;
      }
      connection.terminate();
    });
    connection.on('error', () => log(logger, 'connection', 'WORKER_CONNECTION_FAILED'));
    connection.on('close', () => {
      cleanup();
      if (socket === connection) { socket = undefined; reconnect(); }
    });
  }

  open();
  return {
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      cleanupCurrent();
      socket?.terminate();
    },
  };
}
