import { IndexedDBStore, WriterSlice, frozen } from './store.js';
import { ScopeObservation } from './observation.js';
import { TabLeadership } from './leadership.js';
import { HttpTransport, LiveChannel } from './transport.js';
import { syncTelemetry } from './telemetry.js';
import { registry as composedRegistry } from './schema.js';
import { CONSTANTS } from '../../../../packages/api-contract/sync/reference/core/constants.js';
import { recordKey } from '../../../../packages/api-contract/sync/reference/core/rows.js';
import { bodyBytes, Cursor } from '../../../../packages/api-contract/sync/reference/core/wire.js';
import { Stamp } from '../../../../packages/api-contract/sync/reference/core/stamp.js';
import { Offset } from '../../../../packages/api-contract/sync/reference/core/clock.js';
import { CommitError, commit } from '../../../../packages/api-contract/sync/reference/client/commit.js';
import { ActCommit } from '../../../../packages/api-contract/sync/reference/client/acts.js';
import { release, releaseAll, releaseDue, undo } from '../../../../packages/api-contract/sync/reference/client/hold.js';
import { readInverseResult, requestInverse } from '../../../../packages/api-contract/sync/reference/client/inverse.js';
import { releaseReversibleAct } from '../../../../packages/api-contract/sync/reference/client/journal.js';
import { effectsOf } from '../../../../packages/api-contract/sync/reference/client/projections.js';
import { engineStart, epochChange, signIn, signOut } from '../../../../packages/api-contract/sync/reference/client/lifecycle.js';
import { applyChunk, applyPage, finishPage, onFrame, onPullResponse, pullRequest, settle } from '../../../../packages/api-contract/sync/reference/client/puller.js';
import { dismiss } from '../../../../packages/api-contract/sync/reference/client/refusal.js';
import { applyPushResult, nextPush, onHello, onPushResponse, ResponseError, SenderWait, validatePushEnvelope, validatePushReceipts } from '../../../../packages/api-contract/sync/reference/client/sender.js';
import { Doubts, firstPullComplete, reconcile, subscribe, subscriptionsOf, unsubscribe } from '../../../../packages/api-contract/sync/reference/client/subscriptions.js';
import { viewRecord } from '../../../../packages/api-contract/sync/reference/client/views.js';

function secureDraw(bound) {
  if (!Number.isSafeInteger(bound) || bound <= 0 || bound > 2 ** 32) throw new Error('invalid random bound');
  const maximum = 2 ** 32 - (2 ** 32 % bound);
  const word = new Uint32Array(1);
  do { crypto.getRandomValues(word); } while (word[0] >= maximum);
  return word[0] % bound;
}

const replicaId = () => `rp_${crypto.randomUUID().replace(/-/g, '')}`;
const actorId = () => `r_${Array.from({ length: 12 }, () => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[secureDraw(62)]).join('')}`;

export class BrowserSyncEngine {
  constructor({ store, registry = composedRegistry, transport, telemetry, leadership, navigator = globalThis.navigator,
    document = globalThis.document, window = globalThis.window, timers = globalThis, now = Date.now,
    monotonic = () => Math.floor(performance.now()), newReplicaId = replicaId, newActor = actorId,
    draw = secureDraw, limits = CONSTANTS, appVersion = import.meta.env?.VITE_RELEASE ?? '1', liveHint = () => false,
    pendingDeviceWork = () => [], adoptDeviceRows = () => undefined, onPushResult = () => {}, credentials, base }) {
    Object.assign(this, { store, registry, navigator, document, window, timers, now, monotonic,
      newReplicaId, newActor, draw, appVersion, liveHint, pendingDeviceWork, adoptDeviceRows, onPushResult, credentials });
    this.limits = { ...CONSTANTS, ...limits };
    this.telemetry = syncTelemetry(telemetry);
    this.actor = newActor();
    this.boot = crypto.randomUUID();
    this.reading = () => ({ wall: Math.floor(now()), mono: monotonic(), boot: this.boot });
    this.transport = transport ?? new HttpTransport({ schema: registry.version, base, reading: this.reading, timers, limits: this.limits,
      scopedCommands: [...registry.commands.values()].filter((command) => command.scopedEffects).map((command) => command.name) });
    this.leadershipOptions = leadership;
    this.visible = document?.visibilityState !== 'hidden';
    this.online = navigator?.onLine !== false;
    this.networkGeneration = 0;
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
    this.pullChunk = new WriterSlice(64, this.limits.WRITER_SLICE_MS);
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
      store = options.store ?? await IndexedDBStore.open({ indexedDB: options.indexedDB, keyRange: options.keyRange,
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
      nextGestureId: () => this.newGestureId(), pendingDeviceWork: this.pendingDeviceWork, adoptDeviceRows: this.adoptDeviceRows };
  }

  async write(operation, change, scopes = []) {
    let context;
    let answer;
    let thrown;
    try {
      answer = await this.store.transact((device, ensureScope) => {
        context = this.context(device);
        context.ensureScope = ensureScope;
        // An inverse request that was waiting and settles in this transaction reports its counts, never an id.
        const requests = () => device.replicas.flatMap((replica) => replica.inverses);
        const waiting = new Set(requests().filter(({ state }) => state !== 'settled').map(({ requestId }) => requestId));
        let result;
        try { result = change(device, context); } catch (error) { thrown = error; throw error; }
        for (const request of requests()) {
          if (!waiting.has(request.requestId) || request.state !== 'settled') continue;
          context.telemetry.push({ event: 'sync-inverse', outcome: 'settled', applied: request.result.appliedCount, skipped: request.result.skippedCount });
        }
        return result;
      }, { scopes: (device) => [...this.governingScopes(device), ...scopes] });
    } catch (error) {
      if (error !== thrown) {
        if (!this.closed) this.telemetry.failure('storage');
        throw new CommitError('the device store did not commit', 'store', { cause: error });
      }
      if (!(error instanceof CommitError) && !(error instanceof ResponseError) && error !== context.callerError) this.telemetry.failure('storage');
      throw error;
    }
    this.actor = context.actor;
    this.lastWrite = answer.measurement;
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
    } catch { if (!this.closed) this.telemetry.failure('storage'); }
    if (operation) this.telemetry.event(operation, { outcome: (answer.result?.refused || answer.result?.outcome?.refused) ? 'failed' : answer.result?.complete === false ? 'pending' : 'ok' });
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
    this.snapshot = frozen({ revision, replica: replica.id, state: replica.meta.state,
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
      if (!this.closed) this.telemetry.failure('storage');
      throw error;
    }
  }

  notify(listeners, value) {
    for (const listener of listeners) {
      try { listener(value); } catch { this.telemetry.failure('observer'); }
    }
  }

  emit(event) {
    this.notify(this.eventListeners, frozen(structuredClone(event)));
  }

  activeReplica() { return this.device.activeReplica.id; }
  getSnapshot = () => this.snapshot;
  observeEngine = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  onEvent(listener) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }

  observe(scope) {
    if (this.views.has(scope)) return this.views.get(scope);
    const observation = new ScopeObservation(scope, this.registry, {
      firstPullComplete: (replica) => firstPullComplete(replica, scope, this.scopes(replica)),
      notify: (listeners) => this.notify(listeners) });
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
    // Requests still waiting at engine start stay visible: how many wait, and the oldest one's age.
    const unsettled = this.device.activeReplica.inverses.filter(({ state }) => state !== 'settled');
    if (first && unsettled.length) {
      this.telemetry.event('sync-inverse', { outcome: 'pending', waiting: unsettled.length,
        ageMs: Math.max(0, this.now() - Math.min(...unsettled.map(({ requestedAt }) => requestedAt))) });
    }
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
    const previous = ['scopes', 'bye'].includes(message.type) ? this.scopes() : [];
    if (message.type === 'scopes') this.peerScopes.set(message.tab, new Set(message.scopes));
    if (message.type === 'bye') this.peerScopes.delete(message.tab);
    if (message.type === 'hello' || message.type === 'visible') this.announceScopes();
    if (message.type === 'activeReplicaChanged') {
      this.doubts.clear();
      this.peerScopes.clear();
      this.stopNetwork();
    }
    if (['changed', 'activeReplicaChanged', 'scopes', 'bye'].includes(message.type)) {
      this.refresh().then(async () => {
        if (this.closed) return;
        if (previous.length) await this.write(null, (device, ctx) => {
          const replica = device.activeReplica;
          const current = this.scopes(replica);
          for (const scope of previous) if (!current.includes(scope)) unsubscribe(replica, ctx, scope);
        });
        this.armHolds(); this.kick();
      }).catch(() => { if (!this.closed) this.telemetry.failure('storage'); });
    }
  }

  announceScopes() {
    this.coordination?.post({ type: 'scopes', scopes: [...this.openScopes] });
  }

  scopes(replica = this.device.activeReplica) {
    const products = Object.keys(this.registry.products).filter((product) => this.registry.products[product].surfaces.includes('web'));
    const opened = [...this.openScopes, ...[...this.peerScopes.values()].flatMap((set) => [...set])];
    return subscriptionsOf(replica, this.registry, products, opened);
  }

  async subscribe(scope) {
    if (this.registry.scopeKindOf(scope) !== 'tree') throw new CommitError('only readable trees may be opened');
    const result = await this.write(null, (device) => subscribe(device.activeReplica, scope));
    if (result !== 'gone') this.openScopes.add(scope);
    this.announceScopes();
    for (const observation of this.views.values()) observation.refresh(this.device.activeReplica);
    const overlay = `self/overlay/${scope.slice('tree/'.length)}`;
    this.kickPull(this.scopes().filter((candidate) => candidate === scope || candidate === overlay));
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

  freshness(scope, replica = this.device.activeReplica) {
    const reading = this.reading();
    const sample = replica.meta.clockReading;
    const syncLive = Boolean(replica.id === this.device.activeReplica.id && this.canSync()
      && !this.authenticating && !this.signOutOpening && !this.device.meta.signOut && !this.device.meta.pendingSignIn
      && this.live.socket?.readyState === 1 && this.live.following.has(scope)
      && firstPullComplete(replica, scope, this.scopes(replica))
      && replica.meta.offsetSamples.length > 0 && sample !== undefined
      && !Offset.jumped(sample, reading, this.limits));
    return { syncLive, serverNow: syncLive ? reading.wall + replica.meta.serverOffsetMs : null };
  }

  // Confirmed rows and reconciliation metadata must come from the same replica as a commit's views.
  readMetadata(scope, replica = this.device.activeReplica, actor = this.actor) {
    const record = replica.cursorOf(scope);
    const cursor = Cursor.decode(record.cursor);
    const clean = cursor?.e === replica.meta.serverEpoch && cursor?.m === 'live' && cursor.k === undefined
      && !record.behind && record.digestStop === undefined && !record.mismatchReset && !replica.staging[scope];
    return {
      confirmed: new Map(replica.confirmedRows(scope).map((row) => [recordKey(row.t, row.id),
        structuredClone({ ...viewRecord(row), ...(row.rc === undefined ? {} : { rc: row.rc }), ...(row.ru === undefined ? {} : { ru: row.ru }) })])),
      freshness: this.freshness(scope, replica),
      devices: structuredClone(replica.deviceRows(this.registry.productOfRef(scope))),
      firstPullComplete: firstPullComplete(replica, scope, this.scopes(replica)),
      actor,
      isAnonymous: replica.meta.state === 'anon',
      commands: replica.entries(scope).filter((entry) => entry.intent.cmd !== undefined).map((entry) => ({
        gestureId: entry.gestureId,
        command: structuredClone(entry.intent.cmd),
        canSupersede: replica.meta.state === 'anon' && ['held', 'ready'].includes(entry.state) && entry.n === undefined,
        isAdmitted: entry.state === 'acked',
      })),
      checkpoint: { epoch: replica.meta.serverEpoch, cleanSeq: clean ? cursor.s : null },
    };
  }

  // The read-and-commit body (§7.12) also reads, in its transaction, the product's device rows and the
  // scope's reconciliation metadata. The body's own throw is the caller's (§7.1), unreported.
  async commit(scope, changes, opts) {
    let prepared, didPrepare = false;
    const result = await this.write('sync-commit', (device, ctx) => {
      const replica = device.activeReplica;
      const read = typeof changes === 'function'
        ? (views) => {
          const seen = { ...views, ...this.readMetadata(scope, replica, ctx.actor) };
          try {
            if (!didPrepare) { prepared = changes(seen); didPrepare = true; }
            return prepared;
          } catch (error) { ctx.callerError = error; throw error; }
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

  // K-3 (engine.md §7.3 Undo of an act): the inverse of a journaled act, reserved in one transaction over the
  // scopes its sources and held entries wrote. Its event carries the result's kind as an outcome, nothing more.
  async requestInverse(actId, slots) {
    const replica = this.device.activeReplica;
    const act = replica.journal.find((candidate) => candidate.actId === actId);
    const cancellation = replica.cancellations.find((candidate) => candidate.inverseActId === actId);
    const scopes = [...new Set([
      ...(act?.sourceEntries ?? []).map((source) => source.originScope),
      ...(cancellation?.units ?? []).map((unit) => (unit.target ?? unit.record).scope),
      ...replica.entries().filter((entry) => entry.gestureId === actId).flatMap((entry) => effectsOf(entry).map(({ scope }) => scope)),
    ])];
    let result;
    try {
      result = await this.write(null, (device, ctx) => requestInverse(device.activeReplica, ctx, actId, slots), scopes);
    } catch (error) {
      this.telemetry.event('sync-inverse', { outcome: 'failed' });
      throw error;
    }
    this.telemetry.event('sync-inverse', { outcome: { cancelled: 'ok', settled: 'ok', pending: 'pending', unavailable: 'unavailable' }[result.kind] });
    this.kick();
    return result;
  }

  readInverseResult(requestId) {
    return readInverseResult(this.device.activeReplica, requestId);
  }

  releaseReversibleAct(actId) {
    return this.write(null, (device) => releaseReversibleAct(device.activeReplica, actId));
  }

  async commitAct(prepare, segment) {
    if (typeof prepare !== 'function') {
      const segments = prepare;
      const options = segment ?? {};
      prepare = () => ({ request: segments === null ? null : { scopes: segments.map((item) => item.scope), hold: segments.some((item) => item.opts?.hold), ...options }, value: segments });
      segment = (values, index) => values[index];
    }
    const act = new ActCommit();
    const scopes = [];
    const result = await this.write('sync-commit', (device, ctx) => {
      ctx.opaqueID = () => this.newGestureId();
      ctx.metadata = (replica, scope) => this.readMetadata(scope, replica, act.actor ?? ctx.actor);
      const result = act.advance(device.activeReplica, ctx, (context) => {
        try {
          const prepared = prepare(context);
          if (prepared?.then) throw new CommitError('an act prepare callback is synchronous');
          return prepared;
        } catch (error) { ctx.callerError = error; throw error; }
      }, (value, index, context) => {
        try {
          const gesture = segment(value, index, context);
          if (gesture?.then) throw new CommitError('an act segment callback is synchronous');
          return gesture;
        } catch (error) { ctx.callerError = error; throw error; }
      });
      scopes.push(...act.prepared.request?.scopes ?? []);
      return result;
    }, scopes);
    this.requestPersistence(); this.kick();
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
    const delay = Math.max(0, this.wait.until - this.monotonic(), (this.helloRetryAt ?? 0) - this.monotonic(), (this.device.activeReplica.meta.pushRetryAt ?? 0) - this.now());
    this.senderTimer = this.timers.setTimeout(() => this.send().catch(() => {}), delay);
  }

  async request(endpoint, body, options = {}) {
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const { device } = await this.store.read([]);
      if (this.closed || controller.signal.aborted || (endpoint !== 'hello' && (!this.online || !this.leader)))
        throw new DOMException('sync stopped', 'AbortError');
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
    if (endpoint === 'push' && response.status === 409 && response.body?.as === request.account
      && response.body?.error !== 'account-mismatch') validatePushEnvelope(response);
    if (response.status !== 200) return;
    const body = response.body;
    const expectedAccount = endpoint === 'push' ? request.account : this.device.activeReplica.meta.account;
    if (expectedAccount !== undefined && body?.as !== expectedAccount && endpoint !== 'hello') return;
    const integer = (value) => Number.isSafeInteger(value) && value >= 0;
    const valid = (condition) => { if (!condition) throw new Error('invalid sync response'); };
    valid(body && integer(body.serverTime) && typeof body.epoch === 'string' && body.epoch.length > 0);
    if (endpoint === 'hello') {
      valid(integer(body.schema) && integer(body.minSchema));
      return;
    }
    if (endpoint === 'push') {
      validatePushEnvelope(response);
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
      || (leave && !this.wait.leaveMayPush(this.monotonic())) || (this.helloRetryAt ?? 0) > this.monotonic()) return;
    this.sending = true;
    let request;
    let handle;
    let checkedHello = false;
    try {
      const { device: before } = await this.store.read([]);
      const seat = before.activeReplica;
      const generation = before.meta.authGeneration;
      const network = this.networkGeneration;
      const lifecycle = this.lifecycleGeneration;
      const epoch = seat.meta.serverEpoch;
      if (seat.meta.state !== 'bound' || seat.meta.authPaused || this.signOutPaused(before)
        || !seat.outbox.some((entry) => entry.state === 'ready' || entry.state === 'sent')) return;
      checkedHello = true;
      const hello = await this.request('hello');
      this.validateResponse('hello', hello.response);
      if (hello.response.status === 200 && hello.response.body?.minSchema > this.registry.version) { await this.upgrade(); return; }
      const current = (device) => this.canSync() && network === this.networkGeneration && lifecycle === this.lifecycleGeneration
        && device.meta.authGeneration === generation && device.activeReplica.storageHandle === seat.storageHandle
        && device.activeReplica.id === seat.id && device.activeReplica.meta.account === seat.meta.account
        && device.activeReplica.meta.serverEpoch === epoch
        && device.activeReplica.meta.state === 'bound' && !device.activeReplica.meta.authPaused && !this.signOutPaused(device);
      const ready = await this.write(null, (device, ctx) => {
        if (!current(device)) return false;
        if (hello.response.status === 200) onHello(device.activeReplica, ctx, hello.response, hello.timing);
        else if (device.activeReplica.isUnauthenticated(hello.response)) device.activeReplica.meta.authPaused = true;
        return !device.activeReplica.meta.authPaused && hello.response.status === 200
          && hello.response.body?.as === seat.meta.account && hello.response.body.schema >= this.registry.minVersion;
      });
      if (!ready) {
        if (!current(this.device)) return;
        this.wait.backoff(this.monotonic(), this.draw, { liveHint: this.liveHint(this.device.activeReplica) });
        this.helloRetryAt = Math.max(this.wait.until, this.monotonic() + this.limits.BACKOFF_BASE_MS,
          this.monotonic() + Math.max(0, hello.response.status === 503 ? hello.response.body?.retryAfterMs ?? 0 : 0));
        return;
      }
      this.helloRetryAt = null;
      request = await this.write(null, (device, ctx) => {
        handle = device.activeReplica.storageHandle;
        if (!current(device) || device.activeReplica.meta.authPaused || device.activeReplica.meta.state !== 'bound'
          || this.signOutPaused(device) || (device.activeReplica.meta.pushRetryAt ?? 0) > this.now() || device.meta.upgradeStops?.[`${this.appVersion}:${this.registry.version}`] === true) return null;
        return structuredClone(nextPush(device.activeReplica, ctx, this.pushLimit ? { limit: this.pushLimit } : {}));
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
    } catch (error) {
      if (this.canSync()) {
        if (!(error instanceof CommitError && error.kind === 'store')) this.telemetry.failure('transport');
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
      if (request || checkedHello) this.scheduleSender();
    }
  }

  // A 200's results, in batches after one transaction that checks every receipt, takes the offset sample and
  // notes the unreadable results, which still acknowledge their entries (engine.md §7.4).
  async pushResults(handle, request, response, timing) {
    const unreadable = await this.write(null, (device, ctx) => {
      const replica = device.replicas.find((replica) => replica.storageHandle === handle);
      if (!replica || replica.id !== request.replica) return null;
      if (replica.isUnauthenticated(response)) { replica.meta.authPaused = true; return null; }
      const found = validatePushReceipts(replica, this.registry, response.body);
      replica.takeOffsetSample(response.body.serverTime, timing, this.limits);
      if (found.size) ctx.telemetry.push({ event: 'sync-push-malformed' });
      return found;
    });
    if (!unreadable) return;
    const results = [...response.body.results].sort((a, b) => a.n - b.n);
    for (let index = 0; index < Math.max(1, results.length); index++) {
      await this.write(null, (device, ctx) => {
        const replica = device.replicas.find((replica) => replica.storageHandle === handle);
        if (!replica || replica.id !== request.replica) return;
        if (replica.meta.serverEpoch !== null && replica.meta.serverEpoch !== response.body.epoch) {
          if (!replica.entries().some((entry) => entry.state === 'acked' && entry.resultEpoch !== response.body.epoch)) {
            for (const result of results) {
              if (result.s !== 'ok') continue;
              this.onPushResult(replica, ctx, result, response.body);
              applyPushResult(replica, ctx, result, response.body, unreadable);
            }
          }
          epochChange(replica, ctx, response.body.epoch);
          return;
        }
        if (results[index]) {
          this.onPushResult(replica, ctx, results[index], response.body);
          applyPushResult(replica, ctx, results[index], response.body, unreadable);
        }
        if (index === results.length - 1 || results.length === 0) {
          replica.meta.serverEpoch ??= response.body.epoch;
          replica.meta.ackThrough = response.body.retry ? Math.min(response.body.lastN, response.body.retry.n - 1) : response.body.lastN;
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
      const outcomes = await this.storePages(handle, response.body.pages.map((page) => {
        const cursor = request.scopes.find(({ scope }) => scope === page.scope)?.cursor;
        if (cursor === undefined) throw new Error('unexpected pull scope');
        return { cursor, page };
      }));
      for (const [index, page] of response.body.pages.entries()) {
        const outcome = outcomes[index];
        if (page.more || ['reset', 'stale'].includes(outcome)) this.pullDirty.add(page.scope);
        if (outcome === 'ignored') this.doubts.end(page.scope, this.monotonic(), this.draw);
        if (outcome === 'applied') this.doubts.rows(page.scope);
        this.doubts.repulled(page.scope, this.monotonic(), this.draw);
      }
      this.pullWait.results(['ok'], this.monotonic(), this.draw);
      this.follow();
    } catch (error) {
      if (this.canSync()) {
        if (!(error instanceof CommitError && error.kind === 'store')) this.telemetry.failure('transport');
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

  // A response's pages apply in chunks the writer slice sizes: a chunk takes the rows of one page or of
  // several, and checks each page in the transaction that applies it. Only a product page or an end can
  // move the subscription set, so the set is read again after one of those.
  async storePages(handle, pages) {
    let outcomes = pages.map(() => 'applied');
    const settling = [];
    for (let index = 0, offset = 0; index < pages.length;) {
      const steps = [];
      for (let room = this.pullChunk.size; index < pages.length && room > 0;) {
        const { page } = pages[index];
        const total = page.kind === 'rows' ? page.rows.length : 0;
        const rows = page.kind === 'rows' ? page.rows.slice(offset, offset + room) : [];
        steps.push({ index, rows, first: offset === 0, last: offset + rows.length >= total });
        room -= Math.max(1, rows.length);
        offset += rows.length;
        if (offset >= total) { index++; offset = 0; }
      }
      const answer = await this.write(null, (device, ctx) => {
        const replica = device.activeReplica;
        let subscribed = new Set(this.scopes(replica));
        const decided = [...outcomes], finished = [];
        for (const { index, rows, first, last } of steps) {
          const { cursor, page } = pages[index];
          if (decided[index] !== 'applied') continue;
          if (replica.storageHandle !== handle) decided[index] = 'outside';
          else if (page.kind !== 'rows') decided[index] = applyPage(replica, ctx, cursor, page, undefined, (scope) => subscribed.has(scope));
          else if (!subscribed.has(page.scope)) decided[index] = 'outside';
          else if ((replica.meta.serverEpoch !== null && Cursor.decode(page.cursor)?.e !== replica.meta.serverEpoch)
            || replica.cursorOf(page.scope).cursor !== cursor) decided[index] = 'stale';
          else {
            applyChunk(replica, ctx, cursor, page, rows, first);
            if (last && finishPage(replica, ctx, cursor, page, 64)) finished.push(index);
          }
          if (page.kind !== 'rows' || this.registry.scopeKindOf(page.scope)?.startsWith('product:')) subscribed = new Set(this.scopes(replica));
        }
        return { decided, finished };
      }, steps.map(({ index, rows }) => ({ handle, scope: pages[index].page.scope, keys: rows.map((row) => recordKey(row.t, row.id)) })));
      this.pullChunk.record(steps.reduce((taken, { rows }) => taken + Math.max(1, rows.length), 0), this.lastWrite.writerMs - this.lastWrite.queueMs);
      outcomes = answer.decided;
      settling.push(...answer.finished);
    }
    for (const index of settling) {
      for (let remaining = true; remaining;) remaining = await this.write(null, (device, ctx) =>
        device.activeReplica.storageHandle === handle && settle(device.activeReplica, ctx, pages[index].page.scope, 64));
    }
    return outcomes;
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
    this.authenticating = (this.authenticating ?? 0) + 1;
    try {
      await this.write(null, (device, ctx) => {
        if (device.meta.signOut) throw new CommitError('finish or cancel sign-out before signing in', 'not-writable');
        if (device.activeReplica.meta.state === 'bound' && device.activeReplica.meta.account !== account)
          throw new CommitError('finish sign-out before changing accounts');
        generation = device.meta.authGeneration = (device.meta.authGeneration ?? 0) + 1;
        if (device.activeReplica.meta.state !== 'bound') device.meta.pendingSignIn = { account };
        if (device.activeReplica.meta.state !== 'bound')
          for (const replica of device.replicas) releaseAll(replica, this.registry, ctx.ended);
      });
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
      if (!(error instanceof CommitError && error.kind === 'not-writable')) this.telemetry.failure('auth');
      throw error;
    } finally {
      this.authenticating--;
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

  async finishSignOut({ choice, counted, deviceCleanup = false, beforeSignOutCommit }) {
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
      if (result.complete) {
        const fence = beforeSignOutCommit?.();
        if (fence?.then) throw new Error('sign-out fence must be synchronous');
        device.meta.clearCredential = account;
        if (deviceCleanup) device.meta.deviceCleanup = { previous: account, generation: device.meta.authGeneration };
        delete device.meta.signOut;
      }
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
    if (this.online !== online) this.networkGeneration += 1;
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
