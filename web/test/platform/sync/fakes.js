import { setImmediate } from 'node:timers/promises';
import { IDBFactory } from 'fake-indexeddb';
import { registry, product } from './oracle-adapters/fixtures.js';
import { ServerState } from '../../../../packages/api-contract/sync/reference/server/state.js';
import { hello, pull } from '../../../../packages/api-contract/sync/reference/server/pull.js';
import { push } from '../../../../packages/api-contract/sync/reference/server/push.js';

export const tick = () => setImmediate();
export async function until(condition, limit = 100) {
  for (let i = 0; i < limit; i++) { if (condition()) return; await tick(); }
  throw new Error('condition not reached');
}

export class FakeLocks {
  constructor() { this.held = []; this.queue = []; }
  async query() { return { held: this.held.map(({ name, mode }) => ({ name, mode })), pending: this.queue.map(({ name, mode }) => ({ name, mode })) }; }
  request(name, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const { signal, mode = 'exclusive' } = options;
    return new Promise((resolve, reject) => {
      const item = { name, mode, callback, resolve, reject, signal };
      const abort = () => {
        if (!this.queue.includes(item)) return;
        this.queue.splice(this.queue.indexOf(item), 1);
        reject(new DOMException('aborted', 'AbortError'));
      };
      item.abort = abort;
      if (signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(item);
      this.drain();
    });
  }
  drain() {
    for (const item of [...this.queue]) {
      if (this.held.some((held) => held.name === item.name && (held.mode === 'exclusive' || item.mode === 'exclusive'))) continue;
      this.queue.splice(this.queue.indexOf(item), 1);
      item.signal?.removeEventListener('abort', item.abort);
      this.held.push(item);
      Promise.resolve().then(() => item.callback({ name: item.name, mode: item.mode })).then(item.resolve, item.reject).finally(() => {
        this.held.splice(this.held.indexOf(item), 1);
        this.drain();
      });
    }
  }
}

export class FakeChannels {
  constructor() { this.channels = new Set(); this.messages = []; }
  open = (name) => {
    const channel = { name, onmessage: null, closed: false,
      postMessage: (data) => {
        this.messages.push({ name, data: structuredClone(data) });
        for (const peer of this.channels) if (peer !== channel && peer.name === name) {
          queueMicrotask(() => { if (!peer.closed) peer.onmessage?.({ data: structuredClone(data) }); });
        }
      },
      close: () => { channel.closed = true; this.channels.delete(channel); },
    };
    this.channels.add(channel);
    return channel;
  };
}

export class FakeTimers {
  constructor() { this.time = 1000; this.next = 0; this.tasks = new Map(); }
  setTimeout = (callback, delay) => {
    const id = ++this.next;
    this.tasks.set(id, { at: this.time + Math.max(0, delay), callback });
    return id;
  };
  clearTimeout = (id) => this.tasks.delete(id);
  advance(ms) {
    this.time += ms;
    const tasks = [...this.tasks].filter(([, task]) => task.at <= this.time).sort((a, b) => a[1].at - b[1].at);
    for (const [id, task] of tasks) if (this.tasks.delete(id)) task.callback();
  }
}

export function environment() {
  const indexedDB = new IDBFactory();
  const locks = new FakeLocks();
  const channels = new FakeChannels();
  const timers = new FakeTimers();
  let ids = 0;
  const newReplicaId = () => `rp_${String(++ids).padStart(32, '0')}`;
  const events = [], failures = [], requests = [], sockets = [];
  let persisted = 0;
  let state = ServerState.empty({ epoch: 'ep-1', accounts: { A: { name: 'A' }, B: { name: 'B' } } });
  const transport = {
    account: null,
    response: null,
    async request(endpoint, request) {
      requests.push({ endpoint, request });
      if (transport.response) return transport.response(endpoint, request);
      const account = transport.account;
      const now = timers.time;
      let response;
      if (endpoint === 'hello') response = hello({ state, registry, account, serverTime: now });
      else {
        const out = (endpoint === 'push' ? push : pull)({ state, registry, product, account, request, serverNow: now });
        state = out.state;
        response = out.response;
      }
      return { response, timing: { send: { wall: now, mono: now, boot: 'test' }, recv: { wall: now, mono: now, boot: 'test' } } };
    },
    openLive() {
      const socket = { readyState: 0, sent: [], send(data) { this.sent.push(JSON.parse(data)); }, close() { this.readyState = 3; } };
      sockets.push(socket);
      return socket;
    },
  };
  const options = { indexedDB, registry, timers, now: () => timers.time, monotonic: () => timers.time,
    navigator: { onLine: true, locks, storage: { persist: () => { persisted++; return Promise.resolve(true); } } },
    document: null, window: null, leadership: { locks, channel: channels.open }, transport, newReplicaId,
    newActor: () => 'r_aaaaaaaaaaaa', draw: (bound) => Math.max(1, Math.floor(bound / 2)),
    telemetry: { event: (name, props) => events.push({ name, props }), failure: (name) => failures.push(name) } };
  return { options, indexedDB, locks, channels, timers, transport, events, failures, requests, sockets,
    get persisted() { return persisted; }, get state() { return state; }, set state(value) { state = value; } };
}
