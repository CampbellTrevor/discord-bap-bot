const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 32 * 1024;
const yieldImmediate = () => new Promise(resolve => setImmediate(resolve));

/** Encode the bounded, plain host telemetry snapshot without stringifying its
 * entire 24-hour history in one audio-blocking turn. Other RPCs do not use this.
 * A null return matches the bridge's existing oversized/unserializable result.
 */
export async function encodePerformanceFrame(frame, { maxBytes = MAX_BYTES, signal, yieldTask = yieldImmediate } = {}) {
  signal?.throwIfAborted();
  const parts = [];
  let bytes = 0, chunkBytes = 0;
  const append = value => {
    const size = Buffer.byteLength(value);
    bytes += size; chunkBytes += size;
    if (bytes > maxBytes) return false;
    parts.push(value);
    return true;
  };
  const checkpoint = async () => {
    if (chunkBytes >= CHUNK_BYTES) {
      chunkBytes = 0;
      await yieldTask();
      signal?.throwIfAborted();
    }
  };
  try {
    const snapshot = frame.result;
    // Real host snapshots are plain objects with small scalar/summary fields
    // and one large history array. Preserve legacy null/primitive test results.
    if (!snapshot || typeof snapshot !== 'object') {
      const value = JSON.stringify(frame);
      return typeof value === 'string' && Buffer.byteLength(value) <= maxBytes ? value : null;
    }
    if (Array.isArray(snapshot) || ![Object.prototype, null].includes(Object.getPrototypeOf(snapshot))
        || typeof snapshot.toJSON === 'function') return null;
    const prefix = JSON.stringify({ ...frame, result: undefined });
    if (!append(prefix.slice(0, -1) + ',"result":{')) return null;
    let first = true;
    for (const key of Object.keys(snapshot)) {
      signal?.throwIfAborted();
      const value = snapshot[key];
      if (key === 'history' && Array.isArray(value)) {
        if (!append(`${first ? '' : ','}${JSON.stringify(key)}:[`)) return null;
        first = false;
        for (let index = 0; index < value.length; index++) {
          // Each five-minute bucket is bounded independently of retention.
          const row = JSON.stringify(value[index]) ?? 'null';
          if (!append((index ? ',' : '') + row)) return null;
          await checkpoint();
        }
        if (!append(']')) return null;
      } else {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) continue;
        if (!append(`${first ? '' : ','}${JSON.stringify(key)}:${encoded}`)) return null;
        first = false;
      }
      await checkpoint();
    }
    if (!append('}}')) return null;
    signal?.throwIfAborted();
    return parts.join('');
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}
