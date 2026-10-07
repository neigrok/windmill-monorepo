import { IndexedDBStore } from './store.js';
import { TabLeadership } from './leadership.js';
import { HttpTransport, LiveChannel } from './transport.js';
import { syncTelemetry } from './telemetry.js';
import { registry as composedRegistry } from './schema.js';
import { CONSTANTS } from './core/constants.js';
import { compareRecords, recordKey } from './core/rows.js';
import { bodyBytes, Cursor } from './core/wire.js';
import { Stamp } from './core/stamp.js';
import { CommitError, commit } from './client/commit.js';
import { release, releaseAll, releaseDue, undo, undoOffers } from './client/hold.js';
import { engineStart, epochChange, signIn, signOut } from './client/lifecycle.js';
import { applyChunk, applyPage, finishPage, onFrame, onPullResponse, pullRequest, settle } from './client/puller.js';
import { dismiss } from './client/refusal.js';
import { applyPushResult, nextPush, onHello, onPushResponse, SenderWait } from './client/sender.js';
import { Doubts, firstPullComplete, reconcile, subscribe, subscriptionsOf } from './client/subscriptions.js';
import { drawn, stored } from './client/views.js';

function secureDraw(bound) {
  if (!Number.isSafeInteger(bound) || bound <= 0 || bound > 2 ** 32) throw new Error('invalid random bound');
  const maximum = 2 ** 32 - (2 ** 32 % bound);
  const word = new Uint32Array(1);
  do { crypto.getRandomValues(word); } while (word[0] >= maximum);
  return word[0] % bound;
}

const replicaId = () => `rp_${crypto.randomUUID().replace(/-/g, '')}`;
const actorId = () => `r_${Array.from({ length: 12 }, () => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[secureDraw(62)]).join('')}`;
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

export class BrowserSyncEngine {
  constructor({ store, registry = composedRegistry, transport, telemetry, leadership, navigator = globalThis.navigator,
    document = globalThis.document, window = globalThis.window, timers = globalThis, now = Date.now,
    monotonic = () => Math.floor(performance.now()), newReplicaId = replicaId, newActor = actorId,
    draw = secureDraw, limits = CONSTANTS, appVersion = import.meta.env?.VITE_RELEASE ?? '1', liveHint = () => false,
    pendingDeviceWork = () => [], onPushResult = () => {}, credentials, base }) {
    Object.assign(this, { store, registry, navigator, document, window, timers, now, monotonic,
      newReplicaId, newActor, draw, appVersion, liveHint, pendingDeviceWork, onPushResult, credentials });
    this.limits = { ...CONSTANTS, ...limits };
    this.telemetry = syncTelemetry(telemetry);
    this.actor = newActor();
    this.boot = crypto.randomUUID();
    this.reading = () => ({ wall: Math.floor(now()), mono: monotonic(), boot: this.boot });
    this.transport = transport ?? new HttpTransport({ schema: registry.version, base, reading: this.reading, timers, limits: this.limits });
    this.leadershipOptions = leadership;
    this.visible = document?.visibilityState !== 'hidden';
    this.online = navigator?.onLine !== false;
    this.listeners = new Set();
    this.eventListeners = new Set();
    this.views = new Map();
    this.openScopes = new Set();
    this.peerScopes = new Map();
    this.doubts = new Doubts();
    this.wait = new SenderWait(this.limits);
    this.pullWait = new SenderWait(this.limits);
    this.pullDirty = new Set();
    this.repullSolo = new Set();
    this.pullInFlight = new Set();
    this.deferredFrames = new Map();
    this.inFlight = new Set();
    this.live = new LiveChannel({ transport: this.transport, timers, now: monotonic, draw,
      limits: this.limits, onFrame: (frame) => this.receiveFrame(frame),
      onFollowing: (current, previous) => {
        for (const scope of previous) if (!current.has(scope)) this.doubts.unfollowed(scope, this.monotonic());
        for (const scope of current) this.doubts.followed(scope, this.monotonic());
      },
      onReconnect: () => this.kickPull(), onFailure: (operation) => this.telemetry.failure(operation) });
    this.closed = false;
    this.lifecycleGeneration = 0;
    this.started = false;
    this.upgradeRequired = false;
    this.revision = -1;
  }

  static async open(options = {}) {
    let store;
    try {
      store = options.store ?? await IndexedDBStore.open({ indexedDB: options.indexedDB,
        name: options.name, newReplicaId: options.newReplicaId ?? replicaId });
      const engine = new BrowserSyncEngine({ ...options, store });
      await engine.refresh(true);
      return engine;
    } catch (error) {
      syncTelemetry(options.telemetry).failure('storage');
      store?.close();
      throw error;
    }
  }

  context(device) {
    return { registry: this.registry, actor: this.actor, deviceNow: this.now(), appVersion: this.appVersion,
      device, ended: [], telemetry: [], events: [], limits: this.limits, draw: this.draw,
      newReplicaId: this.newReplicaId, newActor: this.newActor,
      nextGestureId: () => this.newGestureId(), pendingDeviceWork: this.pendingDeviceWork };
  }

  async write(operation, change, scopes = []) {
    let context;
    let answer;
    let thrown;
    try {
      answer = await this.store.transact((device) => {
        context = this.context(device);
        try { return change(device, context); } catch (error) { thrown = error; throw error; }
      }, { scopes: (device) => [...this.governingScopes(device), ...scopes] });
    } catch (error) {
      if (error !== thrown) {
        this.telemetry.failure('storage');
        throw new CommitError('the device store did not commit', 'store', { cause: error });
      }
      if (!(error instanceof CommitError) && error !== context.callerError) this.telemetry.failure('storage');
      throw error;
    }
    this.actor = context.actor;
    try {
      for (const event of context.events) {
        this.coordination?.post({ type: 'activeReplicaChanged', previous: event.previous,
          replica: event.replica, revision: answer.revision });
      }
      if (answer.changed) this.coordination?.post({ type: 'changed', revision: answer.revision });
    } catch { this.telemetry.failure('leadership'); }
    try {
      if (answer.changed) {
        this.telemetry.event('sync-writer', { durationMs: Math.ceil(answer.measurement.writerMs), queueMs: Math.ceil(answer.measurement.queueMs) });
        await this.refresh(false, scopes);
        this.scheduleCleanup();
      }
      for (const event of context.telemetry) this.telemetry.event(event.event, { ...event, scopeKind: event.kind });
      for (const ended of context.ended) if (ended.outcome === 'refused') this.telemetry.event('sync-refused');
      if (answer.previous !== answer.active) {
        this.doubts.clear();
        this.peerScopes.clear();
        this.stopNetwork();
        this.coordination?.rekey(answer.active);
      }
      this.armHolds();
    } catch { this.telemetry.failure('storage'); }
    if (operation) this.telemetry.event(operation, { outcome: answer.result?.refused ? 'failed' : answer.result?.complete === false ? 'pending' : 'ok' });
    return answer.result;
  }

  publish({ device, revision, hydrated = false }) {
    if (revision < this.revision) return;
    const previous = this.device?.activeReplica;
    const current = device.activeReplica;
    if (previous?.storageHandle === current.storageHandle) {
      for (const kind of ['confirmed', 'spentIds']) for (const scope of Object.keys(current[kind])) {
        if (!current.loadedCaches.has(`${kind}:${scope}`) && current.cacheGenerations[`${kind}:${scope}`] === previous.cacheGenerations[`${kind}:${scope}`])
        {
          current[kind][scope] = previous[kind][scope] ?? {};
          if (previous.loadedCaches.has(`${kind}:${scope}`)) current.loadedCaches.add(`${kind}:${scope}`);
        }
      }
    }
    this.device = device;
    if (!device.meta.signOut && !this.signOutOpening) { this.releaseSignOut?.(); this.releaseSignOut = null; }
    this.upgradeRequired = device.meta.upgradeStops?.[`${this.appVersion}:${this.registry.version}`] === true;
    this.signingOut = device.meta.signOut?.phase === 'decision';
    if (revision === this.revision && this.snapshot) {
      if (hydrated) for (const observation of this.views.values()) observation.refresh(device.activeReplica);
      return;
    }
    this.revision = revision;
    const replica = device.activeReplica;
    this.snapshot = freeze({ revision, replica: replica.id, state: replica.meta.state,
      authPaused: replica.meta.authPaused, upgradeRequired: this.upgradeRequired,
      pendingSignIn: structuredClone(device.meta.pendingSignIn ?? null) });
    for (const observation of this.views.values()) observation.refresh(replica);
    if (previous && previous.id !== replica.id) this.emit({ event: 'activeReplicaChanged', previous: previous.id, replica: replica.id });
    this.notify(this.listeners);
    if (this.upgradeRequired || this.signingOut) this.stopNetwork();
    if (replica.meta.authPaused) {
      this.live.stop();
      this.telemetry.event('sync-auth-paused', { outcome: 'paused' });
    }
  }

  governingScopes(device) {
    const governing = this.registry.governingType;
    return governing ? [{ handle: device.activeReplica.storageHandle, scope: `self/${this.registry.productOfScopeKind(governing.scope)}`, type: governing.type }] : [];
  }

  scheduleCleanup() {
    if (this.cleanupTimer || this.closed) return;
    this.cleanupTimer = this.timers.setTimeout(async () => {
      this.cleanupTimer = null;
      try { if (await this.store.cleanup() === 128) this.scheduleCleanup(); }
      catch { if (!this.closed) this.telemetry.failure('storage'); }
    }, 0);
  }

  async refresh(boot = false, changedScopes = []) {
    try {
      const answer = await this.store.read((device) => [...this.governingScopes(device),
        ...changedScopes.map((item) => typeof item === 'string' ? { handle: device.activeReplica.storageHandle, scope: item } : item),
        ...(boot ? Object.keys(device.activeReplica.confirmed) : []).map((scope) => ({ handle: device.activeReplica.storageHandle, scope })),
        ...[...this.views.keys()].map((scope) => ({ handle: device.activeReplica.storageHandle, scope }))]);
      this.publish(answer);
      if (this.coordination && this.coordination.replica !== this.activeReplica()) this.coordination.rekey(this.activeReplica());
      this.scheduleSender();
      return this.device.activeReplica.id;
    } catch (error) {
      this.telemetry.failure('storage');
      throw error;
    }
  }

  notify(listeners, value) {
    for (const listener of listeners) {
      try { listener(value); } catch { this.telemetry.failure('observer'); }
    }
  }

  emit(event) {
    this.notify(this.eventListeners, freeze(structuredClone(event)));
  }

  activeReplica() { return this.device.activeReplica.id; }
  getSnapshot = () => this.snapshot;
  observeEngine = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  onEvent(listener) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }

  observe(scope) {
    if (this.views.has(scope)) return this.views.get(scope);
    const listeners = new Set();
    const observation = {
      getSnapshot: () => observation.snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      refresh: (replica) => {
        const records = (view) => [...view.values()].sort(compareRecords).map((row) => {
          const envelope = replica.confirmedRow(scope, row.t, row.id);
          const metadata = Object.fromEntries(['seq', 'rc', 'ru'].filter((key) => envelope?.[key] !== undefined).map((key) => [key, envelope[key]]));
          return { ...row, ...metadata };
        });
        observation.snapshot = freeze({ replica: replica.id,
          drawn: records(drawn(replica, this.registry, scope)),
          stored: records(stored(replica, this.registry, scope)),
          notices: structuredClone(replica.notices.filter((notice) => notice.scope === scope)),
          undoOffers: undoOffers(replica, scope),
          firstPullComplete: firstPullComplete(replica, scope, this.scopes(replica)) });
        this.notify(listeners);
      },
    };
    observation.refresh(this.device.activeReplica);
    this.views.set(scope, observation);
    if (this.device.activeReplica.confirmed[scope] && !this.device.activeReplica.loadedCaches.has(`confirmed:${scope}`)) {
      this.store.read([scope]).then((answer) => { if (!this.closed) this.publish({ ...answer, hydrated: true }); })
        .catch(() => { if (!this.closed) this.telemetry.failure('storage'); });
    }
    return observation;
  }

  async start() {
    if (this.started || this.closed) return;
    this.started = true;
    try { this.coordination = new TabLeadership({ locks: this.navigator?.locks,
      visible: this.visible, ...this.leadershipOptions,
      readReplica: () => this.refresh(), onLeader: (leader) => {
        this.leader = leader;
        this.telemetry.event('sync-leader', { outcome: leader ? 'acquired' : 'released' });
        if (leader) { this.kick(); this.armReconcile(); }
        else { this.timers.clearTimeout(this.reconcileTimer); this.stopNetwork(); }
      }, onMessage: (message) => this.peerMessage(message),
      onFailure: (operation) => this.telemetry.failure(operation) }); }
    catch (error) { this.telemetry.failure('leadership'); this.started = false; throw error; }
    let first;
    try { first = await this.coordination.start(this.activeReplica()); }
    catch (error) { this.telemetry.failure('leadership'); this.started = false; throw error; }
    if (this.closed) return;
    if (first) await this.write(null, (device, ctx) => engineStart(device, ctx));
    this.installLifecycle();
    this.requestPersistence();
    this.telemetry.event('sync-start', { outcome: 'ok' });
    this.armHolds();
    await this.cleanupCredentials();
    this.kick();
    if (this.device.meta.pendingSignIn && this.online)
      this.signIn(this.device.meta.pendingSignIn.account).catch(() => {});
  }

  requestPersistence() {
    if (this.persistenceRequested) return;
    this.persistenceRequested = true;
    if (!this.navigator?.storage?.persist) { this.telemetry.event('sync-persist', { outcome: 'unavailable' }); return; }
    try {
      Promise.resolve(this.navigator.storage.persist()).then((granted) =>
        this.telemetry.event('sync-persist', { outcome: granted ? 'ok' : 'denied' }))
        .catch(() => this.telemetry.failure('storage'));
    } catch { this.telemetry.failure('storage'); }
  }

  peerMessage(message) {
    if (message.type === 'upgrade') { this.refresh().catch(() => {}); return; }
    if (message.type === 'scopes') this.peerScopes.set(message.tab, new Set(message.scopes));
    if (message.type === 'bye') this.peerScopes.delete(message.tab);
    if (message.type === 'hello' || message.type === 'visible') this.announceScopes();
    if (message.type === 'activeReplicaChanged') {
      this.doubts.clear();
      this.peerScopes.clear();
      this.stopNetwork();
    }
    if (['changed', 'activeReplicaChanged', 'scopes', 'bye'].includes(message.type)) {
      this.refresh().then(() => { this.armHolds(); this.kick(); }).catch(() => this.telemetry.failure('storage'));
    }
  }

  announceScopes() {
    this.coordination?.post({ type: 'scopes', scopes: [...this.openScopes] });
  }

  scopes(replica = this.device.activeReplica) {
    const products = Object.keys(this.registry.products).filter((product) => this.registry.products[product].surfaces.includes('web'));
    const scopes = new Set(subscriptionsOf(replica, this.registry, products));
    for (const scope of [...this.openScopes, ...[...this.peerScopes.values()].flatMap((set) => [...set])])
      if (!replica.known[scope]) scopes.add(scope);
    return [...scopes];
  }

  async subscribe(scope) {
    if (this.registry.scopeKindOf(scope) !== 'tree') throw new CommitError('only readable trees may be opened');
    const result = await this.write(null, (device) => subscribe(device.activeReplica, scope));
    if (result !== 'gone') this.openScopes.add(scope);
    this.announceScopes();
    for (const observation of this.views.values()) observation.refresh(this.device.activeReplica);
    this.kickPull([scope]);
    return result;
  }

  unsubscribe(scope) {
    this.openScopes.delete(scope);
    this.announceScopes();
    this.kickPull();
    return this.write(null, (device, ctx) => reconcile(device.activeReplica, ctx, this.scopes(device.activeReplica)));
  }

  // A caller that must know its gesture id before the commit (the domain kit's runner) mints it here and
  // passes it as `opts.gestureId`.
  newGestureId() { return crypto.randomUUID(); }

  // The read-and-commit body (§7.12) also reads, in its transaction, the product's device rows and the
  // scope's first-pull state: `{drawn, stored, now, replica, devices, firstPullComplete}`. The body's own
  // throw is the caller's (§7.1), so it passes through unreported.
  async commit(scope, changes, opts) {
    const result = await this.write('sync-commit', (device, ctx) => {
      const replica = device.activeReplica;
      const read = typeof changes === 'function'
        ? (views) => {
          const seen = { ...views,
            devices: structuredClone(replica.deviceRows(this.registry.productOfRef(scope))),
            firstPullComplete: firstPullComplete(replica, scope, this.scopes(replica)) };
          try { return changes(seen); } catch (error) { ctx.callerError = error; throw error; }
        }
        : changes;
      return commit(replica, ctx, scope, read, opts);
    }, [scope]);
    this.requestPersistence();
    this.kick();
    return result;
  }

  async undo(gestureId) {
    const result = await this.write('sync-undo', (device, ctx) => undo(device.activeReplica, this.registry, ctx.ended, gestureId));
    this.kick();
    return result;
  }

  async release(localId) {
    await this.write('sync-release', (device, ctx) => {
      const entry = device.activeReplica.entry(localId);
      return entry ? release(device.activeReplica, this.registry, ctx.ended, entry) : false;
    });
    this.kick();
  }

  dismissNotice(id) { return this.write(null, (device) => dismiss(device.activeReplica, id)); }

  armHolds() {
    this.timers.clearTimeout(this.holdTimer);
    if (this.closed || !this.device) return;
    const held = this.device.replicas.flatMap((replica) => replica.outbox.filter((entry) => entry.state === 'held'));
    if (!held.length) return;
    const delay = Math.max(0, Math.min(...held.map((entry) => entry.releaseAt)) - this.now());
    this.holdTimer = this.timers.setTimeout(() => {
      this.write('sync-release', (device, ctx) => {
        for (const replica of device.replicas) releaseDue(replica, this.registry, ctx.ended, ctx.deviceNow);
      }).then(() => this.kick()).catch(() => {});
    }, delay);
  }

  canSync() {
    return this.started && this.leader && !this.closed && this.online && !this.upgradeRequired
      && !this.device.activeReplica.meta.authPaused && !this.signOutPaused(this.device);
  }

  signOutPaused(device) {
    const session = device.meta.signOut;
    return !!session && (session.phase !== 'flush' || this.now() >= session.deadline);
  }

  armReconcile() {
    this.timers.clearTimeout(this.reconcileTimer);
    if (!this.started || !this.leader || this.closed) return;
    this.reconcileTimer = this.timers.setTimeout(async () => {
      try {
        await this.refresh();
        const session = this.device.meta.signOut;
        if (session) {
          const { held } = await this.navigator.locks.query();
          const alive = held.some((lock) => lock.name === session.lock);
          const resumed = await this.write(null, (device) => {
            if (device.meta.signOut?.lock !== session.lock) return false;
            if (!alive) { delete device.meta.signOut; return true; }
            else if (session.phase === 'flush' && (this.now() >= session.deadline
              || !device.activeReplica.outbox.some((entry) => ['ready', 'sent'].includes(entry.state))))
              device.meta.signOut.phase = 'decision';
            return false;
          });
          if (resumed) this.kick();
        }
        this.scheduleSender();
      } catch { if (!this.closed) this.telemetry.failure('storage'); }
      finally { this.armReconcile(); }
    }, 1000);
  }

  kick() {
    this.wait.kick(this.monotonic());
    this.kickPull();
    this.scheduleSender();
  }

  scheduleSender() {
    this.timers.clearTimeout(this.senderTimer);
    if (!this.canSync() || this.sending || this.device.activeReplica.meta.state !== 'bound') return;
    const delay = Math.max(0, this.wait.until - this.monotonic(), (this.device.activeReplica.meta.pushRetryAt ?? 0) - this.now());
    this.senderTimer = this.timers.setTimeout(() => this.send().catch(() => {}), delay);
  }

  async request(endpoint, body, options = {}) {
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const { device } = await this.store.read([]);
      if (this.closed || controller.signal.aborted) throw new DOMException('sync stopped', 'AbortError');
      if (device.meta.upgradeStops?.[`${this.appVersion}:${this.registry.version}`] === true)
        return { response: { status: 426 }, timing: {} };
      if (endpoint !== 'hello' && this.signOutPaused(device)) throw new Error('sync paused');
      const answer = await this.transport.request(endpoint, body, { ...options, signal: controller.signal,
        anonymous: endpoint === 'pull' && device.activeReplica.meta.state === 'anon' });
      if (answer.response.status === 426) await this.upgrade();
      return answer;
    } finally { this.inFlight.delete(controller); }
  }

  validateResponse(endpoint, response, request) {
    if (response.status !== 200) return;
    const body = response.body;
    const expectedAccount = endpoint === 'push' ? request.account : this.device.activeReplica.meta.account;
    if (expectedAccount !== undefined && body?.as !== expectedAccount && endpoint !== 'hello') return;
    const integer = (value) => Number.isSafeInteger(value) && value >= 0;
    const valid = (condition) => { if (!condition) throw new Error('invalid sync response'); };
    valid(body && integer(body.serverTime) && typeof body.epoch === 'string');
    if (endpoint === 'hello') {
      valid(integer(body.schema) && integer(body.minSchema));
      return;
    }
    if (endpoint === 'push') {
      valid(integer(body.lastN) && Array.isArray(body.results));
      const numbers = new Set();
      for (const result of body.results) {
        valid(integer(result.n) && result.n > 0 && !numbers.has(result.n)
          && request.intents.some((intent) => intent.n === result.n));
        numbers.add(result.n);
        valid(result.s === 'ok' ? integer(result.seq) : result.s === 'refused' && typeof result.code === 'string');
        if (result.write !== undefined) {
          valid(Array.isArray(result.write));
          for (const write of result.write) {
            valid(this.registry.type(write.t) && write.id !== undefined && (write.born === undefined || Stamp.isValid(write.born)));
            valid(Object.values(write.f ?? {}).every((stamp) => Stamp.isValid(stamp)));
          }
        }
      }
      if (body.retry) valid(integer(body.retry.n) && integer(body.retry.retryAfterMs));
      return;
    }
    valid(Array.isArray(body.pages) && body.pages.length === request.scopes.length);
    const scopes = new Set();
    for (const page of body.pages) {
      valid(request.scopes.some(({ scope }) => scope === page.scope) && !scopes.has(page.scope));
      scopes.add(page.scope);
      valid(['rows', 'reset', 'gone', 'not-found'].includes(page.kind));
      if (page.kind !== 'rows') continue;
      valid(Array.isArray(page.rows) && typeof page.more === 'boolean' && integer(page.seq)
        && /^[0-9a-f]{64}$/.test(page.digest) && Cursor.decode(page.cursor)?.e === body.epoch);
      for (const row of page.rows) {
        valid(this.registry.type(row.t) && row.id !== undefined && integer(row.seq));
        if (row.life) valid(['alive', 'dead'].includes(row.life[0]) && Stamp.isValid(row.life[1]));
        if (row.born !== undefined) valid(Stamp.isValid(row.born));
        valid(Object.values(row.f ?? {}).every((register) => Array.isArray(register) && register.length === 2 && Stamp.isValid(register[1])));
        valid(Object.values(row.x ?? {}).every((text) => text && typeof text.text === 'string' && integer(text.rev)));
      }
    }
  }

  async send({ leave = false } = {}) {
    if (!this.canSync() || this.sending || (!leave && !this.wait.due(this.monotonic()))
      || (leave && !this.wait.leaveMayPush(this.monotonic()))) return;
    this.sending = true;
    let request;
    let handle;
    try {
      request = await this.write(null, (device, ctx) => {
        handle = device.activeReplica.storageHandle;
        if (device.activeReplica.meta.authPaused || device.activeReplica.meta.state !== 'bound'
          || this.signOutPaused(device) || (device.activeReplica.meta.pushRetryAt ?? 0) > this.now() || device.meta.upgradeStops?.[`${this.appVersion}:${this.registry.version}`] === true) return null;
        return nextPush(device.activeReplica, ctx, { ...(this.pushLimit ? { limit: this.pushLimit } : {}),
        });
      });
      if (!request) return;
      if (leave) {
        while (request.intents.length && bodyBytes(request) > this.limits.KEEPALIVE_BYTES) request.intents.pop();
        if (!request.intents.length) return;
      }
      const { response, timing } = await this.request('push', request, { keepalive: leave });
      if (response.status === 426) return;
      this.validateResponse('push', response, request);
      if (response.status === 200) await this.pushResults(handle, request, response, timing);
      else {
        const outcome = await this.write(null, (device, ctx) => {
          const replica = device.replicas.find((replica) => replica.storageHandle === handle);
          if (replica?.id === request.replica) return onPushResponse(replica, ctx, request, response, timing);
        });
        this.pushLimit = outcome?.limit;
      }
      if (response.status === 503 || response.body?.retry) await this.write(null, (device) => {
        const replica = device.replicas.find((replica) => replica.storageHandle === handle);
        if (replica?.id === request.replica) replica.meta.pushRetryAt = Math.max(replica.meta.pushRetryAt ?? 0,
          this.now() + Math.max(0, response.body?.retry?.retryAfterMs ?? response.body?.retryAfterMs ?? 0));
      });
      const time = this.monotonic();
      const hint = { liveHint: this.liveHint(this.device.activeReplica) };
      if (response.status === 503) this.wait.unavailable(time, Math.max(0, response.body?.retryAfterMs ?? 0), this.draw, hint);
      else if (response.status === 200) {
        this.wait.results(response.body.results.map((result) => result.code ?? 'ok'), time, this.draw, hint);
        if (response.body.retry) this.wait.retry(time, response.body.retry.retryAfterMs);
        this.pushLimit = null;
        this.kickPull();
      } else if (![400, 401, 409, 413].includes(response.status)) this.wait.backoff(time, this.draw, hint);
    } catch {
      if (!this.closed && this.leader) {
        this.telemetry.failure('transport');
        this.wait.backoff(this.monotonic(), this.draw, { liveHint: this.liveHint(this.device.activeReplica) });
      }
    } finally {
      this.sending = false;
      if (this.device.meta.signOut?.phase === 'flush' && this.leader) {
        await this.write(null, (device) => {
          const session = device.meta.signOut;
          if (session?.phase === 'flush' && (this.now() >= session.deadline
            || !request || !device.activeReplica.outbox.some((entry) => ['ready', 'sent'].includes(entry.state))))
            session.phase = 'decision';
        }).catch(() => {});
      }
      if (request) this.scheduleSender();
    }
  }

  async pushResults(handle, request, response, timing) {
    const accepted = await this.write(null, (device) => {
      const replica = device.replicas.find((replica) => replica.storageHandle === handle);
      if (!replica || replica.id !== request.replica) return false;
      if (replica.isUnauthenticated(response)) { replica.meta.authPaused = true; return false; }
      replica.takeOffsetSample(response.body.serverTime, timing, this.limits);
      return true;
    });
    if (!accepted) return;
    const results = [...response.body.results].sort((a, b) => a.n - b.n);
    for (let index = 0; index < Math.max(1, results.length); index++) {
      await this.write(null, (device, ctx) => {
        const replica = device.replicas.find((replica) => replica.storageHandle === handle);
        if (!replica || replica.id !== request.replica) return;
        if (results[index]) {
          this.onPushResult(replica, ctx, results[index], response.body);
          applyPushResult(replica, ctx, results[index], response.body);
        }
        if (index === results.length - 1 || results.length === 0) {
          replica.meta.serverEpoch ??= response.body.epoch;
          replica.meta.ackThrough = response.body.lastN;
          if (replica.meta.serverEpoch !== response.body.epoch) epochChange(replica, ctx, response.body.epoch);
        }
      });
    }
  }

  kickPull(scopes = this.scopes()) {
    for (const scope of scopes) this.pullDirty.add(scope);
    this.pullWait.kick(this.monotonic());
    this.schedulePull();
  }

  schedulePull() {
    this.timers.clearTimeout(this.pullTimer);
    if (!this.canSync() || this.pulling) return;
    this.pullTimer = this.timers.setTimeout(() => this.pull().catch(() => {}), Math.max(0, this.pullWait.until - this.monotonic()));
  }

  async pull() {
    if (!this.canSync() || this.pulling) return;
    this.pulling = true;
    let request;
    let handle;
    let replicaId;
    try {
      request = await this.write(null, (device, ctx) => {
        const replica = device.activeReplica;
        handle = replica.storageHandle;
        replicaId = replica.id;
        const scopes = this.scopes(replica);
        reconcile(replica, ctx, scopes);
        for (const scope of [...this.doubts.scopes.keys()]) if (!scopes.includes(scope)) this.doubts.left(scope);
        const solo = [...this.repullSolo].find((scope) => scopes.includes(scope));
        const pending = solo ? [solo] : [...this.pullDirty].filter((scope) => scopes.includes(scope)).slice(0, this.limits.PULL_MAX_SCOPES);
        const request = pullRequest(replica, this.registry, pending);
        if (!request) return null;
        while (bodyBytes(request) > this.limits.PULL_MAX_BYTES) request.scopes.pop();
        if (!request.scopes.length) throw new Error('pull scope too large');
        for (const { scope } of request.scopes) {
          this.repullSolo.delete(scope); this.pullDirty.delete(scope); this.pullInFlight.add(scope);
        }
        return request;
      });
      if (!request) return;
      const { response, timing } = await this.request('pull', request);
      if (response.status === 426) return;
      this.validateResponse('pull', response, request);
      const accepted = await this.write(null, (device, ctx) => {
        if (device.activeReplica.storageHandle !== handle || device.activeReplica.id !== replicaId) return false;
        const replica = device.activeReplica;
        if (replica.meta.state === 'anon' && response.status === 200 && response.body?.as !== null) {
          replica.meta.authPaused = true;
          return false;
        }
        onPullResponse(replica, ctx, request, { ...response, body: { ...response.body, pages: [] } }, timing);
        return response.status === 200 && !replica.meta.authPaused;
      });
      if (!accepted) {
        for (const { scope } of request.scopes) this.pullDirty.add(scope);
        if (response.status === 503) this.pullWait.unavailable(this.monotonic(), Math.max(0, response.body?.retryAfterMs ?? 0), this.draw);
        else if (response.status !== 401) this.pullWait.backoff(this.monotonic(), this.draw);
        return;
      }
      for (const page of response.body.pages) {
        const cursor = request.scopes.find(({ scope }) => scope === page.scope)?.cursor;
        if (cursor === undefined) throw new Error('unexpected pull scope');
        const outcome = await this.storePage(handle, cursor, page);
        if (page.more || ['reset', 'stale'].includes(outcome)) this.pullDirty.add(page.scope);
        if (outcome === 'ignored') this.doubts.end(page.scope, this.monotonic(), this.draw);
        if (outcome === 'applied') this.doubts.rows(page.scope);
        this.doubts.repulled(page.scope, this.monotonic(), this.draw);
      }
      this.pullWait.results(['ok'], this.monotonic(), this.draw);
      this.follow();
    } catch {
      if (!this.closed && this.leader) {
        this.telemetry.failure('transport');
        this.pullWait.backoff(this.monotonic(), this.draw);
        for (const { scope } of request?.scopes ?? []) {
          this.pullDirty.add(scope);
          this.doubts.repulled(scope, this.monotonic(), this.draw);
        }
      }
    } finally {
      this.pulling = false;
      for (const { scope } of request?.scopes ?? []) this.pullInFlight.delete(scope);
      for (const { scope } of request?.scopes ?? []) {
        const frame = this.deferredFrames.get(scope);
        this.deferredFrames.delete(scope);
        if (frame) await this.receiveFrame(frame);
      }
      if (request && this.pullDirty.size) this.schedulePull();
      this.armFallback();
    }
  }

  async storePage(handle, cursor, page) {
    if (page.kind !== 'rows') return this.write(null, (device, ctx) => {
      const replica = device.activeReplica;
      if (replica.storageHandle !== handle) return 'outside';
      return applyPage(replica, ctx, cursor, page, undefined, (scope) => this.scopes(replica).includes(scope));
    });
    let remaining = true;
    let outcome = 'applied';
    for (let offset = 0; offset < Math.max(1, page.rows.length); offset += 64) {
      const last = offset + 64 >= page.rows.length;
      const answer = await this.write(null, (device, ctx) => {
        const replica = device.activeReplica;
        if (replica.storageHandle !== handle || !this.scopes(replica).includes(page.scope)) return { outcome: 'outside' };
        if (replica.meta.serverEpoch !== null && Cursor.decode(page.cursor)?.e !== replica.meta.serverEpoch) return { outcome: 'stale' };
        if (replica.cursorOf(page.scope).cursor !== cursor) return { outcome: 'stale' };
        applyChunk(replica, ctx, cursor, page, page.rows.slice(offset, offset + 64), offset === 0);
        return { outcome: 'applied', remaining: last && finishPage(replica, ctx, cursor, page, 64) };
      }, [{ handle, scope: page.scope, keys: page.rows.slice(offset, offset + 64).map((row) => recordKey(row.t, row.id)) }]);
      outcome = answer.outcome;
      remaining = answer.remaining;
      if (outcome !== 'applied') return outcome;
    }
    while (remaining) remaining = await this.write(null, (device, ctx) =>
      device.activeReplica.storageHandle === handle && settle(device.activeReplica, ctx, page.scope, 64));
    return outcome;
  }

  follow() {
    if (!this.canSync() || !this.visible) { this.live.stop(); return; }
    const request = pullRequest(this.device.activeReplica, this.registry, this.scopes());
    const wanted = (request?.scopes ?? []).map(({ scope }) => scope).filter((scope) => this.doubts.mayFollow(scope));
    for (const scope of this.live.following) if (!wanted.includes(scope)) this.doubts.unfollowed(scope, this.monotonic());
    this.live.setScopes(wanted);
    if (wanted.length) this.live.start();
    else this.live.stop();
    for (const scope of this.live.following) this.doubts.followed(scope, this.monotonic());
  }

  async receiveFrame(frame) {
    const handle = this.device.activeReplica.storageHandle;
    const replica = this.device.activeReplica;
    if (['change', 'gone', 'not-found'].includes(frame.op) && !replica.servedAsOther(frame.as) && this.pullInFlight.has(frame.scope)) {
      this.deferredFrames.set(frame.scope, frame);
      this.pullDirty.add(frame.scope);
      return;
    }
    if (['gone', 'not-found'].includes(frame.op)) this.doubts.unfollowed(frame.scope, this.monotonic());
    const outcome = await this.write(null, (device, ctx) => {
      if (device.activeReplica.storageHandle !== handle) return 'outside';
      if (device.activeReplica.meta.state === 'anon' && ['change', 'gone', 'not-found'].includes(frame.op) && frame.as !== null) {
        device.activeReplica.meta.authPaused = true;
        return 'paused';
      }
      return onFrame(device.activeReplica, ctx, frame, (scope) => this.scopes(device.activeReplica).includes(scope));
    }, [{ handle, scope: frame.scope, keys: (frame.rows ?? []).map((row) => recordKey(row.t, row.id)) }]);
    if (outcome === 'pull') this.kickPull([frame.scope]);
    if (outcome === 'ignored' && ['gone', 'not-found'].includes(frame.op)) this.doubts.end(frame.scope, this.monotonic(), this.draw);
    if (outcome === 'applied') this.doubts.rows(frame.scope);
    if (outcome === 'paused') this.live.stop();
    this.follow();
    this.armFallback();
  }

  armFallback() {
    this.timers.clearTimeout(this.fallbackTimer);
    if (!this.canSync() || !this.visible) return;
    this.fallbackAt ??= this.monotonic() + this.limits.PULL_FALLBACK_MS;
    const due = [...this.doubts.scopes.values()].map((scope) => scope.due).filter((due) => due !== null);
    const delay = Math.min(Math.max(0, this.fallbackAt - this.monotonic()), ...due.map((due) => Math.max(0, due - this.monotonic())));
    this.fallbackTimer = this.timers.setTimeout(() => {
      const scopes = this.doubts.due(this.monotonic());
      for (const scope of scopes) this.repullSolo.add(scope);
      if (this.monotonic() >= this.fallbackAt) {
        this.fallbackAt = this.monotonic() + this.limits.PULL_FALLBACK_MS;
        this.kickPull();
      } else this.kickPull(scopes);
    }, delay);
  }

  async signIn(account, { decisions, counted } = {}) {
    let generation;
    const current = this.device.activeReplica.meta;
    if (current.state === 'bound' && current.account !== account) throw new CommitError('finish sign-out before changing accounts');
    await this.write(null, (device, ctx) => {
      if (device.meta.signOut) throw new CommitError('finish or cancel sign-out before signing in');
      if (device.activeReplica.meta.state === 'bound' && device.activeReplica.meta.account !== account)
        throw new CommitError('finish sign-out before changing accounts');
      generation = device.meta.authGeneration = (device.meta.authGeneration ?? 0) + 1;
      if (device.activeReplica.meta.state !== 'bound') device.meta.pendingSignIn = { account };
      if (device.activeReplica.meta.state !== 'bound')
        for (const replica of device.replicas) releaseAll(replica, this.registry, ctx.ended);
    });
    try {
      const { response, timing } = await this.request('hello');
      if (response.status === 426) return { complete: false, upgradeRequired: true };
      this.validateResponse('hello', response);
      if (response.status !== 200 || response.body?.as !== account || !response.body.holdsRecords
        || Object.keys(this.registry.products).some((product) => typeof response.body.holdsRecords[product] !== 'boolean')) {
        this.telemetry.failure('auth');
        return { complete: false, authPaused: true };
      }
      const result = await this.write('sync-signin', (device, ctx) => {
        if (device.meta.authGeneration !== generation) return { complete: false, superseded: true };
        if (device.activeReplica.meta.state === 'bound') {
          if (device.activeReplica.meta.account !== account) throw new CommitError('account changed during authentication');
          onHello(device.activeReplica, ctx, response, timing);
          device.activeReplica.meta.authPaused = false;
          return { complete: true, due: [] };
        }
        const result = signIn(device, ctx, { account, decisions, counted, holdsRecords: response.body.holdsRecords });
        if (result.complete) onHello(device.activeReplica, ctx, response, timing);
        return result;
      });
      this.doubts.clear();
      this.peerScopes.clear();
      this.live.stop({ reset: true });
      this.kick();
      return result;
    } catch (error) {
      this.telemetry.failure('auth');
      throw error;
    }
  }

  async beginSignOut() {
    if (this.releaseSignOut || this.signOutOpening) throw new CommitError('sign-out already in progress');
    this.signOutOpening = true;
    const lock = `wm-signout:${crypto.randomUUID()}`;
    let acquired, failed;
    const ready = new Promise((resolve, reject) => { acquired = resolve; failed = reject; });
    const task = this.navigator.locks.request(lock, () => {
      acquired();
      return new Promise((resolve) => { this.releaseSignOut = resolve; });
    });
    task.catch(failed);
    try {
      await ready;
      await this.write(null, (device, ctx) => {
        if (device.activeReplica.meta.state !== 'bound') throw new CommitError('sign-out requires a bound account');
        if (device.meta.signOut) throw new CommitError('sign-out already in progress');
        device.meta.authGeneration = (device.meta.authGeneration ?? 0) + 1;
        device.meta.signOut = { lock, phase: this.online ? 'flush' : 'decision', deadline: this.now() + this.limits.SIGNOUT_FLUSH_MS };
        releaseAll(device.activeReplica, this.registry, ctx.ended);
      });
      this.kick();
      if (this.leader) this.flush().catch(() => {});
      if (this.online) await new Promise((resolve, reject) => {
        const check = async () => {
          try {
            await this.refresh();
            if (this.device.meta.signOut?.lock !== lock || this.device.meta.signOut.phase === 'decision') { resolve(); return; }
            this.signoutPoll = this.timers.setTimeout(check, 20);
          } catch (error) { reject(error); }
        };
        this.signoutTimer = this.timers.setTimeout(resolve, this.limits.SIGNOUT_FLUSH_MS);
        check();
      });
      this.timers.clearTimeout(this.signoutTimer);
      this.timers.clearTimeout(this.signoutPoll);
      return await this.write(null, (device, ctx) => {
        if (device.meta.signOut?.lock !== lock) throw new CommitError('sign-out cancelled');
        device.meta.signOut.phase = 'decision';
        return signOut(device, ctx);
      });
    } catch (error) { this.releaseSignOut?.(); this.releaseSignOut = null; throw error; }
    finally { this.signOutOpening = false; }
  }

  async flush() {
    while (this.canSync() && this.device.activeReplica.meta.state === 'bound'
      && this.device.activeReplica.outbox.some((entry) => ['ready', 'sent'].includes(entry.state))) {
      if (this.sending || !this.wait.due(this.monotonic())) return;
      await this.send();
    }
  }

  async finishSignOut({ choice, counted }) {
    if (this.device.activeReplica.meta.state !== 'bound') throw new CommitError('sign-out requires a bound account');
    const account = this.device.activeReplica.meta.account;
    const handle = this.device.activeReplica.storageHandle;
    const session = this.device.meta.signOut?.lock;
    const result = await this.write('sync-signout', (device, ctx) => {
      if (device.activeReplica.meta.state !== 'bound' || device.activeReplica.meta.account !== account
        || device.activeReplica.storageHandle !== handle || device.meta.signOut?.lock !== session)
        throw new CommitError('account changed during sign-out');
      device.meta.authGeneration = (device.meta.authGeneration ?? 0) + 1;
      const result = signOut(device, ctx, { choice, counted });
      if (result.complete) { device.meta.clearCredential = account; delete device.meta.signOut; }
      return result;
    });
    if (result.complete) {
      this.releaseSignOut?.(); this.releaseSignOut = null;
      this.signingOut = false;
      this.doubts.clear();
      this.peerScopes.clear();
      await this.cleanupCredentials();
      this.kick();
    }
    return result;
  }

  async cleanupCredentials() {
    const account = this.device.meta.clearCredential;
    if (!account || !this.online || !this.credentials?.clear) return;
    try {
      await this.credentials.clear(account);
      await this.write(null, (device) => {
        if (device.meta.clearCredential === account) delete device.meta.clearCredential;
      });
    } catch { this.telemetry.failure('auth'); }
  }

  async cancelSignOut() {
    await this.write(null, (device) => { delete device.meta.signOut; });
    this.releaseSignOut?.(); this.releaseSignOut = null;
    this.signingOut = false;
    this.kick();
  }

  async upgrade() {
    const key = `${this.appVersion}:${this.registry.version}`;
    this.upgradeRequired = true;
    this.stopNetwork();
    await this.write(null, (device) => { (device.meta.upgradeStops ??= {})[key] = true; });
    this.coordination?.post({ type: 'upgrade', key });
    this.telemetry.event('sync-upgrade', { outcome: 'paused' });
  }

  installLifecycle() {
    this.visibilityChanged = () => this.setVisible(this.document.visibilityState !== 'hidden');
    this.connectivityChanged = () => this.setOnline(this.navigator.onLine !== false);
    this.pageHidden = (event) => {
      if (event.persisted) { this.close({ persisted: true }); return; }
      if (this.coordination.lastTab()) this.leave().finally(() => this.close()).catch(() => {});
      else this.close();
    };
    this.pageShown ??= (event) => {
      if (event.persisted && this.suspended) this.resume().catch(() => {});
    };
    this.document?.addEventListener('visibilitychange', this.visibilityChanged);
    this.window?.addEventListener('online', this.connectivityChanged);
    this.window?.addEventListener('offline', this.connectivityChanged);
    this.window?.addEventListener('pagehide', this.pageHidden);
    this.window?.addEventListener('pageshow', this.pageShown);
  }

  async resume() {
    if (this.restoring) return this.restoring;
    this.restoring = (async () => {
      const generation = this.lifecycleGeneration;
      try {
        const store = await this.store.reopen();
        if (!this.suspended || generation !== this.lifecycleGeneration) { store.close(); return; }
        this.store = store;
        this.closed = false;
        this.suspended = false;
        this.started = false;
        this.visible = this.document?.visibilityState !== 'hidden';
        this.online = this.navigator?.onLine !== false;
        this.peerScopes.clear();
        this.doubts.clear();
        await this.refresh(true);
        if (this.closed) return;
        await this.start();
        if (this.closed) return;
        this.announceScopes();
        this.emit({ event: 'restored' });
      } catch (error) {
        if (generation !== this.lifecycleGeneration) throw error;
        this.telemetry.failure('storage');
        this.close({ persisted: true });
        this.emit({ event: 'restoreFailed' });
        throw error;
      } finally { this.restoring = null; }
    })();
    return this.restoring;
  }

  setOnline(online) {
    this.online = online;
    if (online) this.kick();
    else this.stopNetwork();
  }

  setVisible(visible) {
    this.visible = visible;
    this.coordination?.setVisible(visible);
    this.timers.clearTimeout(this.leaveTimer);
    if (visible) { this.kick(); return; }
    this.live.stop();
    this.timers.clearTimeout(this.fallbackTimer);
    this.fallbackAt = undefined;
    this.leaveTimer = this.timers.setTimeout(() => {
      if (!this.coordination.anyVisible()) this.leave().catch(() => {});
    }, this.limits.LEAVE_DEBOUNCE_MS);
  }

  async leave() {
    await this.write('sync-release', (device, ctx) => {
      for (const replica of device.replicas) releaseAll(replica, this.registry, ctx.ended);
    });
    if (this.leader) await this.send({ leave: true });
  }

  stopNetwork() {
    this.live.stop();
    this.deferredFrames.clear();
    this.fallbackAt = undefined;
    for (const controller of this.inFlight) controller.abort();
    for (const timer of ['senderTimer', 'pullTimer', 'fallbackTimer']) this.timers.clearTimeout(this[timer]);
  }

  close({ persisted = false } = {}) {
    if (this.closed && !this.suspended) return;
    this.lifecycleGeneration++;
    this.suspended = persisted;
    this.closed = true;
    this.releaseSignOut?.(); this.releaseSignOut = null;
    this.timers.clearTimeout(this.reconcileTimer);
    this.timers.clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;
    this.stopNetwork();
    this.coordination?.close();
    for (const timer of ['holdTimer', 'leaveTimer', 'signoutTimer', 'signoutPoll']) this.timers.clearTimeout(this[timer]);
    this.document?.removeEventListener('visibilitychange', this.visibilityChanged);
    this.window?.removeEventListener('online', this.connectivityChanged);
    this.window?.removeEventListener('offline', this.connectivityChanged);
    this.window?.removeEventListener('pagehide', this.pageHidden);
    if (!persisted) this.window?.removeEventListener('pageshow', this.pageShown);
    this.store.close();
    if (persisted) this.emit({ event: 'suspended' });
    else { this.listeners.clear(); this.eventListeners.clear(); }
  }
}
