import { CONSTANTS } from './core/constants.js';
import { jcs } from './core/jcs.js';

const LIVE_QUEUE_FRAMES = 64;
const LIVE_QUEUE_BYTES = 1_048_576;

export class HttpTransport {
  constructor({ schema, base = '', fetch = globalThis.fetch, socket = (url) => new WebSocket(url),
    origin = globalThis.location?.origin, reading, timers = globalThis, limits = CONSTANTS }) {
    Object.assign(this, { schema, base, fetch: fetch.bind(globalThis), socketFactory: socket, origin, reading, timers, limits });
  }

  async request(endpoint, body, { signal, keepalive = false, anonymous = false } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = this.timers.setTimeout(abort, this.limits.REQUEST_TIMEOUT_MS);
    const send = this.reading();
    try {
      const response = await this.fetch(`${this.base}/v1/sync/${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: anonymous ? 'omit' : 'include',
        headers: { 'Sync-Schema': String(this.schema), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: jcs(body) }),
        signal: controller.signal,
        keepalive,
        cache: 'no-store',
      });
      const text = await response.text();
      if (text.length > 2 * this.limits.PULL_PAGE_BYTES * this.limits.PULL_MAX_SCOPES) throw new Error('sync response too large');
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); }
        catch { if (![400, 413, 426, 501].includes(response.status)) throw new Error('invalid sync response'); }
      }
      return { response: { status: response.status, body: parsed }, timing: { send, recv: this.reading() } };
    } finally {
      this.timers.clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  openLive() {
    const url = new URL(`${this.base}/v1/sync/live`, this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('schema', String(this.schema));
    return this.socketFactory(url.href);
  }
}

export class LiveChannel {
  constructor({ transport, onFrame, onReconnect, onFailure, onFollowing = () => {}, timers = globalThis, now = () => performance.now(),
    draw = (bound) => Math.random() * bound, limits = CONSTANTS }) {
    Object.assign(this, { transport, onFrame, onReconnect, onFailure, onFollowing, timers, now, draw, limits });
    this.running = false;
    this.k = 0;
    this.following = new Set();
    this.wanted = new Set();
    this.frames = [];
    this.queuedBytes = 0;
    this.activeBytes = 0;
    this.draining = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  connect() {
    if (!this.running) return;
    let socket;
    try { socket = this.transport.openLive(); }
    catch { this.ended(); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.openedAt = this.now();
      this.lastReceived = this.now();
      this.following.clear();
      this.follow();
      this.pingLater();
    };
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return;
      if (typeof data !== 'string' || data.length > this.limits.LIVE_FRAME_BYTES
        || this.frames.length + Number(this.draining) >= LIVE_QUEUE_FRAMES) {
        this.breakSocket(socket);
        return;
      }
      const bytes = new TextEncoder().encode(data).length;
      if (bytes > this.limits.LIVE_FRAME_BYTES || this.queuedBytes + this.activeBytes + bytes > LIVE_QUEUE_BYTES) {
        this.breakSocket(socket);
        return;
      }
      this.lastReceived = this.now();
      this.timers.clearTimeout(this.pongTimer);
      this.pingLater();
      this.frames.push({ socket, data, bytes });
      this.queuedBytes += bytes;
      this.drain();
    };
    socket.onerror = () => this.breakSocket(socket);
    socket.onclose = () => { if (this.socket === socket) this.ended(); };
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.frames.length) {
        const { socket, data, bytes } = this.frames.shift();
        this.queuedBytes -= bytes;
        this.activeBytes = bytes;
        try {
          if (this.socket !== socket) continue;
          const frame = JSON.parse(data);
          if (frame.op === 'pong') continue;
          if (frame.op === 'gone' || frame.op === 'not-found') {
            const previous = new Set(this.following);
            this.following.delete(frame.scope);
            this.onFollowing(this.following, previous);
          }
          await this.onFrame(frame);
        } catch { this.breakSocket(socket); }
        finally { this.activeBytes = 0; }
      }
    } finally { this.draining = false; }
  }

  breakSocket(socket) {
    if (this.socket !== socket) return;
    this.detach();
    this.ended();
  }

  pingLater() {
    this.timers.clearTimeout(this.pingTimer);
    if (!this.running) return;
    this.pingTimer = this.timers.setTimeout(() => {
      if (this.socket?.readyState !== 1) return;
      try { this.socket.send(jcs({ op: 'ping' })); }
      catch { this.breakSocket(this.socket); return; }
      this.pongTimer = this.timers.setTimeout(() => this.breakSocket(this.socket), this.limits.LIVE_PONG_MS);
    }, this.limits.LIVE_PING_MS);
  }

  setScopes(scopes) {
    this.wanted = new Set(scopes);
    this.follow();
  }

  follow() {
    if (this.socket?.readyState !== 1) return;
    const removed = [...this.following].filter((scope) => !this.wanted.has(scope));
    const added = [...this.wanted].filter((scope) => !this.following.has(scope));
    try {
      for (const [op, scopes] of [['unsub', removed], ['sub', added]]) {
        for (let i = 0; i < scopes.length; i += this.limits.PULL_MAX_SCOPES)
          this.socket.send(jcs({ op, scopes: scopes.slice(i, i + this.limits.PULL_MAX_SCOPES) }));
      }
      const previous = this.following;
      this.following = new Set(this.wanted);
      this.onFollowing(this.following, previous);
    } catch { this.breakSocket(this.socket); }
  }

  ended() {
    this.detach();
    if (!this.running) return;
    if (this.openedAt !== undefined && this.now() - this.openedAt >= 30_000) this.k = 0;
    this.openedAt = undefined;
    this.onFailure('live');
    this.onReconnect();
    const delay = this.draw(Math.min(this.limits.BACKOFF_LIVE_CEILING_MS, this.limits.BACKOFF_BASE_MS * 2 ** Math.min(30, this.k++)));
    this.reconnectTimer = this.timers.setTimeout(() => this.connect(), delay);
  }

  detach() {
    const socket = this.socket;
    this.socket = null;
    this.frames = [];
    this.queuedBytes = 0;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(); } catch { /* already closed */ }
    }
    const previous = this.following;
    this.following = new Set();
    this.onFollowing(this.following, previous);
    this.timers.clearTimeout(this.pingTimer);
    this.timers.clearTimeout(this.pongTimer);
  }

  stop({ reset = false } = {}) {
    this.running = false;
    this.timers.clearTimeout(this.reconnectTimer);
    this.detach();
    if (reset) this.k = 0;
  }
}
