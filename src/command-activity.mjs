import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DAY = 86_400_000;
const SOURCES = ['discord', 'web'];
const STATUSES = ['success', 'error', 'cancelled'];
const FILTERS = new Set(['guildId', 'userId', 'source', 'status', 'cursor', 'limit']);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const text = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit) : '';
const badFilter = () => Object.assign(new Error('Invalid activity filters.'), { status: 400 });

export function validateActivityFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !FILTERS.has(key))) throw badFilter();
  const filters = {};
  for (const key of ['guildId', 'userId']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || !/^\d{17,20}$/.test(input[key])) throw badFilter();
      filters[key] = input[key];
    }
  }
  for (const [key, values] of [['source', SOURCES], ['status', STATUSES]]) {
    if (input[key] !== undefined) {
      if (!values.includes(input[key])) throw badFilter();
      filters[key] = input[key];
    }
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== 'string' || !/^[0-9a-z]{1,16}$/.test(input.cursor)
        || !Number.isSafeInteger(parseInt(input.cursor, 36)) || parseInt(input.cursor, 36) < 1) throw badFilter();
    filters.cursor = input.cursor;
  }
  const limit = typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit) ? Number(input.limit) : input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badFilter();
  return { ...filters, limit };
}

// Store only meaningful media URL parts. Tracking, signed URLs, credentials,
// fragments and arbitrary query parameters never enter the journal.
function safeQuery(value) {
  const query = text(value, 500);
  return query.replace(/https?:\/\/[^\s<>]+/gi, raw => {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      if (host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com')) {
        const clean = new URL(`https://${host}${url.pathname}`);
        for (const key of ['v', 'list']) {
          const item = url.searchParams.get(key);
          if (item && /^[a-zA-Z0-9_-]{1,100}$/.test(item)) clean.searchParams.set(key, item);
        }
        return clean.href;
      }
      if (host === 'open.spotify.com' && /^\/(?:intl-[a-z-]+\/)?(?:track|album|playlist|artist)\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) {
        return `https://${host}${url.pathname}`;
      }
      return '[URL omitted]';
    } catch { return '[URL omitted]'; }
  });
}

export function sanitizeActivityParameters(input) {
  const parameters = {};
  if (!input || typeof input !== 'object') return parameters;
  if (typeof input.query === 'string') parameters.query = safeQuery(input.query);
  if (SOURCES.includes(input.source) || ['youtube', 'spotify'].includes(input.source)) parameters.source = input.source;
  for (const key of ['channelId', 'trackId']) if (identifier(input[key])) parameters[key] = input[key];
  if (typeof input.action === 'string' && /^[a-z-]{1,40}$/.test(input.action)) parameters.action = input.action;
  if (Number.isInteger(input.volumePercent) && input.volumePercent >= 0 && input.volumePercent <= 100) parameters.volumePercent = input.volumePercent;
  return parameters;
}

function cleanEvent(input, id, now) {
  if (!input || !SOURCES.includes(input.source) || !STATUSES.includes(input.status)
      || !identifier(input.userId) || !identifier(input.guildId)
      || typeof input.command !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(input.command)) return null;
  const timestamp = typeof input.timestamp === 'string' && Number.isFinite(Date.parse(input.timestamp))
    ? new Date(input.timestamp).toISOString() : new Date(now).toISOString();
  const event = {
    id, timestamp, source: input.source, guildId: input.guildId,
    guildName: text(input.guildName, 100) || input.guildId,
    userId: input.userId, userName: text(input.userName, 100) || input.userId,
    command: input.command, parameters: sanitizeActivityParameters(input.parameters),
    status: input.status, durationMs: Math.min(86_400_000, Math.max(0, Math.round(Number(input.durationMs) || 0))),
  };
  if (typeof input.errorCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(input.errorCode)) event.errorCode = input.errorCode;
  return event;
}

/** A bounded append journal. Disk writes never delay a music command. */
export function createCommandActivity({ dataDir, logger = console, now = Date.now, maxRecords = 50_000, retentionDays = 30, maxPending = 1_000 } = {}) {
  if (!dataDir || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 50_000
      || !Number.isFinite(retentionDays) || retentionDays <= 0 || retentionDays > 30
      || !Number.isInteger(maxPending) || maxPending < 1 || maxPending > 1_000) throw new Error('Invalid command activity configuration.');
  const file = join(dataDir, '.command-activity.jsonl');
  let events = [], pending = [], sequence = 0, droppedEvents = 0, removed = 0;
  let nextExpiry = Infinity, compactNeeded = false, retryAfter = 0;
  let started = false, closed = false, startPromise, writing, timer, maintenance, warnAt = -Infinity;
  function warn() {
    if (now() - warnAt < 60_000) return;
    warnAt = now();
    logger.warn?.('Command activity persistence is unavailable; some recent activity may not survive a restart.');
  }
  function prune() {
    if (now() < nextExpiry && events.length <= maxRecords) return;
    const cutoff = now() - retentionDays * DAY;
    const retained = events.filter(event => Date.parse(event.timestamp) >= cutoff && Date.parse(event.timestamp) <= now() + 60_000);
    if (retained.length !== events.length) compactNeeded = true;
    if (retained.length > maxRecords) retained.splice(0, retained.length - maxRecords);
    removed += events.length - retained.length;
    events = retained;
    nextExpiry = events.reduce((earliest, event) => Math.min(earliest, Date.parse(event.timestamp) + retentionDays * DAY + 1), Infinity);
  }
  async function compact() {
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    // Snapshot while synchronous; records arriving during awaits are still pending.
    const snapshot = events.slice();
    const through = sequence;
    try {
      handle = await open(temporary, 'wx', 0o600);
      for (let offset = 0; offset < snapshot.length; offset += 200) {
        await handle.writeFile(snapshot.slice(offset, offset + 200).map(event => JSON.stringify(event)).join('\n') + '\n');
      }
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temporary, file);
      removed = 0;
      compactNeeded = false;
      // The snapshot also included records not yet appended. Avoid duplicates.
      pending = pending.filter(event => parseInt(event.id, 36) > through);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  async function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      try {
        const info = await stat(file);
        if (info.size > 256 * 1024 * 1024) throw new Error('Activity journal exceeds its read limit.');
        await chmod(file, 0o600);
        const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line || line.length > 8_192) continue;
          try {
            const raw = JSON.parse(line);
            if (typeof raw.id !== 'string' || !/^[0-9a-z]{1,16}$/.test(raw.id)) continue;
            const next = parseInt(raw.id, 36);
            if (!Number.isSafeInteger(next) || next <= sequence) continue;
            sequence = next;
            const event = cleanEvent(raw, raw.id, now());
            if (event) { events.push(event); nextExpiry = Math.min(nextExpiry, Date.parse(event.timestamp) + retentionDays * DAY + 1); }
            if (events.length > maxRecords + 1_000) prune();
          } catch { /* A crash may leave an incomplete final line. */ }
        }
      } catch (error) { if (error.code !== 'ENOENT') { warn(); throw error; } }
      prune();
      // Drop expired rows and any incomplete tail before accepting new appends.
      await compact();
      started = true;
      maintenance = setInterval(() => { prune(); if (compactNeeded || removed >= 1_000) schedule(); }, 60_000);
      maintenance.unref?.();
    })();
    return startPromise;
  }
  function schedule() {
    if (timer || writing || closed || !started) return;
    timer = setTimeout(() => { timer = null; void flush().catch(warn); }, Math.max(250, retryAfter - now()));
    timer.unref?.();
  }
  function record(input) {
    if (!started || closed || pending.length >= maxPending) { droppedEvents++; return; }
    const event = cleanEvent(input, (++sequence).toString(36), now());
    if (!event) return;
    events.push(event); pending.push(event);
    nextExpiry = Math.min(nextExpiry, Date.parse(event.timestamp) + retentionDays * DAY + 1);
    // Keep admission bounded without scanning the entire journal per command.
    if (events.length > maxRecords) { events.splice(0, events.length - maxRecords); removed++; }
    schedule();
  }
  async function flush() {
    if (!started) return;
    clearTimeout(timer); timer = null;
    if (writing) return writing;
    writing = (async () => {
      prune();
      if (compactNeeded || removed >= 1_000) await compact();
      while (pending.length) {
        const batch = pending.slice(0, 200);
        await appendFile(file, batch.map(event => JSON.stringify(event)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
        pending.splice(0, batch.length);
      }
    })();
    try { await writing; }
    catch (error) { compactNeeded = true; retryAfter = now() + 5_000; warn(); throw error; }
    finally { writing = null; if (pending.length && !closed) schedule(); }
  }
  async function query(input) {
    const filters = validateActivityFilters(input);
    if (!started) throw Object.assign(new Error('Command activity is temporarily unavailable.'), { status: 503 });
    prune();
    const users = new Map(), guilds = new Map(), matches = [];
    let total = 0;
    const before = filters.cursor ? parseInt(filters.cursor, 36) : Infinity;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (!guilds.has(event.guildId)) guilds.set(event.guildId, { id: event.guildId, name: event.guildName });
      if (filters.guildId && event.guildId !== filters.guildId) continue;
      if (!users.has(event.userId)) users.set(event.userId, { id: event.userId, name: event.userName });
      if (filters.userId && event.userId !== filters.userId || filters.source && event.source !== filters.source || filters.status && event.status !== filters.status) continue;
      total++;
      if (parseInt(event.id, 36) >= before || matches.length > filters.limit) continue;
      matches.push(event);
    }
    const more = matches.length > filters.limit;
    if (more) matches.pop();
    return {
      events: structuredClone(matches), users: [...users.values()], guilds: [...guilds.values()],
      nextCursor: more ? matches.at(-1).id : null, retentionDays, total, droppedEvents,
    };
  }
  async function close() {
    closed = true;
    await startPromise?.catch(() => {});
    clearTimeout(timer); clearInterval(maintenance);
    try { await flush(); } catch { /* Persistence warnings must never prevent shutdown. */ }
  }
  return { start, record, query, flush, close };
}
