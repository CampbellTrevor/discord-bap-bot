import session from 'express-session';

// Local demo/test store. Production sessions use durable storage.
export class BoundedSessionStore extends session.Store {
  constructor({ maxSessions = 10000, now = Date.now } = {}) {
    super();
    this.sessions = new Map();
    this.maxSessions = maxSessions;
    this.now = now;
    this.timer = setInterval(() => this.prune(), 60000).unref();
  }
  prune() {
    for (const [id, record] of this.sessions) if (record.expires <= this.now()) this.sessions.delete(id);
  }
  get(id, callback) {
    const record = this.sessions.get(id);
    if (!record || record.expires <= this.now()) {
      this.sessions.delete(id);
      callback(null, null);
    } else callback(null, JSON.parse(record.value));
  }
  set(id, value, callback = () => {}) {
    this.prune();
    if (!this.sessions.has(id) && this.sessions.size >= this.maxSessions) {
      callback(new Error('Too many active sessions. Please try again later.'));
      return;
    }
    this.sessions.set(id, { value: JSON.stringify(value), expires: value.cookie?.expires ? new Date(value.cookie.expires).getTime() : this.now() + 8 * 3600000 });
    callback(null);
  }
  // Reads never write an old session snapshot back over a logout or OAuth change.
  touch(_id, _value, callback = () => {}) { callback(null); }
  take(id, callback) {
    this.get(id, (error, value) => {
      if (!error) this.sessions.delete(id);
      callback(error, value);
    });
  }
  destroy(id, callback = () => {}) { this.sessions.delete(id); callback(null); }
  close() { clearInterval(this.timer); this.sessions.clear(); }
}
