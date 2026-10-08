// §11.3 the deterministic replay simulator: devices running the reference client against the reference
// server over a network that drops, duplicates, delays and reorders, with process death and reboots,
// clock error and device clock jumps, holds, undo and retire, two tabs, sign-in and sign-out, credentials
// that expire (401), are dropped on the way (served as anonymous) or are another account's (served as
// it), 400 and 413 envelopes, poison, epoch change, restored or cloned stores behind fork guards, pull
// pages short of the head, and a process death between two chunks of a pull page, two settling slices
// of its cursor, or two batches of a push answer's results. Each step checks that every change of a
// device's active replica id was announced (§7.12); `check()` states the invariants after quiescence.

import { readFileSync } from 'node:fs';
import { CONSTANTS } from '../../core/constants.js';
import { jcs } from '../../core/jcs.js';
import { Registry } from '../../core/registry.js';
import { compareRecords, isAlive, isVisible, recordKey } from '../../core/rows.js';
import { ProbeProduct } from '../../probe/product.js';
import { commit } from '../../client/commit.js';
import { releaseAll, releaseDue, undo, undoOffered } from '../../client/hold.js';
import { engineStart, signIn, signOut } from '../../client/lifecycle.js';
import { onFrame, onPullResponse, pullRequest } from '../../client/puller.js';
import { Device, Replica } from '../../client/replica.js';
import { reconcile, subscriptionsOf } from '../../client/subscriptions.js';
import { nextPush, onPushResponse } from '../../client/sender.js';
import { capCount, drawn, stored } from '../../client/views.js';
import { frameFor, hello, pull, refOfKey } from '../../server/pull.js';
import { push } from '../../server/push.js';
import { serverCall } from '../../server/requests.js';
import { ServerState } from '../../server/state.js';
import { Rng } from '../../vectors/fixtures.js';

export const PROBE_REGISTRY = new Registry(JSON.parse(readFileSync(new URL('../../../probe.registry.json', import.meta.url), 'utf8')));

const WORDS = ['oak', 'ash', 'elm', 'fir', 'yew', 'bay', 'box', 'ivy'];

// What a replica holds from pulls and frames: its confirmed rows, cursors and known scopes.
function pulledState(replica) {
  return jcs({ confirmed: replica.confirmed, cursors: replica.cursors, known: replica.known });
}

// A device: a web browser with two tabs (no fork guard), or a phone with one app process whose fork
// guard's backup-excluded copy is `backupGuard`. `pushLimit` is the last push answer's halving limit.
class SimDevice {
  constructor(world, { name, account, signedIn, skew, tabs }) {
    this.world = world;
    this.name = name;
    this.account = account;
    this.skew = skew;
    this.boot = 1;
    this.bootAt = world.now;
    this.native = tabs === 1;
    this.actorsMinted = 0;
    this.tabs = Array.from({ length: tabs }, (_, index) => this.freshActor(index));
    const first = signedIn ? Replica.fresh({ replica: world.replicaId(), state: 'bound', account }) : Replica.fresh({ replica: world.replicaId(), state: 'anon' });
    this.store = new Device({ active: first.id, replicas: [first.toJSON()] });
    this.backupGuard = null;
    // 'valid'; 'expired', sent but resolving to no account; 'dropped', lost on the way (a cleared
    // cookie, a stripping proxy), so a request carries none; or 'foreign', another account's (a tab
    // signed in as someone else), so a request is served as that account (§9.1).
    this.credential = 'valid';
    this.ended = [];
    this.telemetry = [];
    this.events = [];
    this.announced = this.store.activeReplica.id;
    this.committed = [];
    this.discardedNotices = [];
    this.gestures = 0;
    this.pushing = null;
    this.pulling = null;
    this.wantsPull = true;
  }

  get replica() {
    return this.store.activeReplica;
  }

  freshActor(tab) {
    this.actorsMinted += 1;
    return `r_${`${this.name}${tab}n${this.actorsMinted.toString(36)}`.padEnd(12, 'x')}`;
  }

  ctx(tab = 0) {
    return {
      registry: this.world.registry,
      actor: this.tabs[tab],
      deviceNow: this.world.now + this.skew,
      ended: this.ended,
      telemetry: this.telemetry,
      events: this.events,
      appVersion: '1',
      device: this.store,
      nextGestureId: () => `${this.name}-g${++this.gestures}`,
      newReplicaId: () => this.world.replicaId(),
      newActor: () => {
        this.tabs[tab] = this.freshActor(tab);
        return this.tabs[tab];
      },
      newForkGuard: () => this.world.forkGuard(),
      draw: (size) => this.world.rng.int(size),
      limits: CONSTANTS,
    };
  }

  // §7.3 and §7.11: a process launch releases holds, renews every tab's actor and, on a phone, checks
  // the fork guard against its backup-excluded copy, which it then rewrites.
  start() {
    const outcome = engineStart(this.store, this.ctx(), this.native ? { backupGuard: this.backupGuard } : {});
    for (let tab = 1; tab < this.tabs.length; tab += 1) this.tabs[tab] = this.freshActor(tab);
    if (this.native) this.backupGuard = this.store.meta.forkGuard;
    return outcome;
  }

  // The device's clocks: the wall clock follows the skew, the monotonic clock counts real time since boot.
  reading() {
    return { wall: this.ctx().deviceNow, mono: this.world.now - this.bootAt, boot: `${this.name}-boot${this.boot}` };
  }

  reboot() {
    this.boot += 1;
    this.bootAt = this.world.now;
  }

  // The account a request of `replica` is served as, and the credential it carries (§9.1).
  servedAs(replica) {
    if (this.credential === 'valid') return { account: replica.meta.account ?? null };
    if (this.credential === 'foreign') return { account: replica.meta.account === 'A' ? 'B' : 'A' };
    return { account: null, credential: this.credential === 'expired' ? 'unresolved' : undefined };
  }

  subscriptions() {
    return subscriptionsOf(this.replica, this.world.registry, ['probe']);
  }

  snapshot() {
    return { store: this.store.toJSON(), ended: structuredClone(this.ended), committed: [...this.committed], discardedNotices: [...this.discardedNotices], gestures: this.gestures };
  }

  // A store restored from a backup, or cloned, starts as a new process does: what it announces next
  // follows the active replica it holds.
  restore(snapshot) {
    this.store = new Device(snapshot.store);
    this.announced = this.store.activeReplica.id;
    this.events.length = 0;
    this.ended = structuredClone(snapshot.ended);
    this.committed = [...snapshot.committed];
    this.discardedNotices = [...snapshot.discardedNotices];
    this.gestures = Math.max(this.gestures, snapshot.gestures) + 1000;
    this.pushing = null;
    this.pulling = null;
  }
}

export class World {
  constructor({ seed, steps = 120, faults = true, registry = PROBE_REGISTRY }) {
    this.rng = new Rng(seed);
    this.seed = seed;
    this.steps = steps;
    this.faults = faults;
    // Process deaths between two chunks of a pull page, two settling slices or two batches of a push
    // answer's results: during the faults, and in quiescence's first round, where the long pages and
    // answers are. They draw from their own generator, so the other faults each seed draws stay as they
    // were. Meanwhile a settling slice resolves one covered entry.
    this.midDeaths = faults;
    this.deathRng = new Rng(seed ^ 0x5eed5);
    // A server whose pull pages hold a few hundred bytes answers most pulls short of the head, so frames
    // meet scopes left behind (§7.5 step 3). Drawn apart too.
    this.pullLimits = faults && new Rng(seed ^ 0xbead5).chance(0.3) ? { ...CONSTANTS, PULL_PAGE_BYTES: 600 } : CONSTANTS;
    this.registry = registry;
    this.product = new ProbeProduct();
    this.now = 10_000_000;
    this.server = ServerState.empty({ epoch: 'ep-0', accounts: { A: { name: 'Ann' }, B: { name: 'Bob' } } });
    this.epochs = 0;
    this.ids = 0;
    this.replicas = 0;
    this.network = [];
    this.serverSnapshots = [];
    this.deviceSnapshots = new Map();
    this.poison = new Set();
    this.malformed = new Map();
    // A server whose push byte limit sits below the clients' answers larger requests 413: a batch halves,
    // and a lone intent is refused too-large.
    this.serverLimits = faults && this.rng.chance(0.3) ? { ...CONSTANTS, PUSH_MAX_BYTES: 400 } : CONSTANTS;
    this.deadForever = new Set();
    this.violations = [];
    this.log = [];
    this.tally = {};
    this.devices = [
      new SimDevice(this, { name: 'wa', account: 'A', signedIn: true, skew: 0, tabs: 2 }),
      new SimDevice(this, { name: 'pa', account: 'A', signedIn: false, skew: this.rng.int(1_200_000) - 600_000, tabs: 1 }),
      new SimDevice(this, { name: 'pb', account: 'B', signedIn: true, skew: this.rng.int(600_000) - 300_000, tabs: 1 }),
    ];
    for (const device of this.devices) device.start();
  }

  replicaId() {
    this.replicas += 1;
    return `rp_${String(this.replicas).padStart(32, '0')}`;
  }

  forkGuard() {
    this.ids += 1;
    return `fg_${String(this.ids).padStart(8, '0')}`;
  }

  id(prefix) {
    this.ids += 1;
    return `${prefix}${String(this.ids).padStart(6, '0')}`;
  }

  note(text) {
    this.log.push(`${this.now} ${text}`);
  }

  run() {
    for (let step = 0; step < this.steps; step += 1) {
      this.step();
      this.checkAnnounced();
    }
    this.quiesce();
    this.checkAnnounced();
    this.check();
    return this;
  }

  // §7.12: each change of a device's active replica id is announced once, by an activeReplicaChanged event
  // naming the id it replaces, so a holder of the last announced id always holds the active one.
  checkAnnounced() {
    for (const device of this.devices) {
      for (const event of device.events) {
        if (event.previous !== device.announced) this.violations.push(`§7.12 ${device.name}: activeReplicaChanged from ${event.previous}, but ${device.announced} was announced`);
        device.announced = event.replica;
        this.count('activeReplicaChanged announced');
      }
      device.events.length = 0;
      if (device.announced !== device.store.activeReplica.id) this.violations.push(`§7.12 ${device.name}: the active replica became ${device.store.activeReplica.id} unannounced`);
      device.announced = device.store.activeReplica.id;
    }
  }

  step() {
    this.now += this.rng.int(4000);
    const device = this.rng.pick(this.devices);
    const roll = this.rng.next();
    if (roll < 0.34) return this.gesture(device, this.rng.int(device.tabs.length));
    if (roll < 0.46) return this.startPush(device);
    if (roll < 0.56) return this.startPull(device);
    if (roll < 0.74) return this.deliver();
    if (roll < 0.77) return releaseDue(device.replica, this.registry, device.ended, device.ctx().deviceNow);
    if (roll < 0.79) return this.undoSome(device);
    if (roll < 0.8) {
      this.count('left the app');
      return releaseAll(device.replica, this.registry, device.ended);
    }
    if (!this.faults) return undefined;
    if (roll < 0.83) return this.processDeath(device);
    if (roll < 0.85) return this.signOutOrIn(device);
    if (roll < 0.86) return this.lapseCredential(device);
    if (roll < 0.87) return this.poisonNext(device);
    if (roll < 0.885) return this.serverRestore();
    if (roll < 0.9) return this.deviceRestore(device);
    if (roll < 0.905) return this.clone(device);
    if (roll < 0.92) return this.setVisibility();
    if (roll < 0.94) {
      device.skew = this.rng.int(1_200_000) - 600_000;
      this.count('device clock jumped');
    }
    return undefined;
  }

  // Gestures a person makes, on the views the person sees.
  gesture(device, tab) {
    const replica = device.replica;
    if (replica.meta.state !== 'anon' && replica.meta.state !== 'bound') return;
    const ctx = device.ctx(tab);
    const registry = this.registry;
    const view = drawn(replica, registry, 'self/probe');
    const alive = (t) => [...view.values()].filter((record) => record.t === t && isAlive(record));
    const record = (outcome) => {
      if (outcome.localIds) device.committed.push(...outcome.localIds);
      if (outcome.localIds && tab > 0) this.count('second tab commit');
      if (outcome.retired?.length) this.count('retired');
      return outcome;
    };
    const choice = this.rng.int(16);
    const cards = alive('card');
    const runs = alive('run');
    const boards = alive('board');
    const storedProbe = stored(replica, registry, 'self/probe');
    // Anchors (D-25): ordered cards in drawn, and those inside a delete window, which only stored holds.
    const ordered = [...new Set([...view.values(), ...storedProbe.values()].filter((c) => c.t === 'card' && isVisible(registry.type('card'), c) && c.f?.ord).map((c) => c.id))];
    // A held gesture that only deletes one record, which a later commit may retire (§7.1 step 4).
    const retirable = (t) => replica.entries().filter((entry) => entry.state === 'held' && entry.scope === 'self/probe' && entry.intent.cmd === undefined
      && entry.intent.d?.length === 1 && entry.intent.d[0].t === t && entry.intent.d[0].life?.[0] === 'dead').map((entry) => entry.intent.d[0].id);
    if (choice === 0) {
      const id = this.rng.chance(0.5) ? this.id('card') : undefined;
      const below = ordered.length && this.rng.chance(0.8) ? this.rng.pick(ordered) : null;
      return record(commit(replica, ctx, 'self/probe', [{ op: 'create', t: 'card', id, f: { title: this.rng.pick(WORDS), tier: 'draft' }, anchor: { field: 'ord', below } }]));
    }
    if (choice === 14) {
      const deleted = retirable('day');
      const day = deleted.length && this.rng.chance(0.6) ? this.rng.pick(deleted) : `2026-09-0${1 + this.rng.int(5)}`;
      const present = this.rng.chance(0.75);
      const opts = present ? { retire: deleted.includes(day) && this.rng.chance(0.8) ? [{ t: 'day', id: day }] : [] } : { hold: this.rng.chance(0.6) };
      return record(commit(replica, ctx, 'self/probe', [{ op: 'put', t: 'day', id: day, present, f: this.rng.chance(0.7) ? { score: this.rng.int(11) } : {} }], opts));
    }
    if (choice === 15 && boards.length) {
      const dst = `b_${this.ids.toString(16).padStart(8, '0')}`;
      this.ids += 1;
      return record(commit(replica, ctx, 'self/probe', [], {
        cmd: { name: 'probe.copy', args: { src: this.rng.pick(boards).id, dst } },
        predict: [{ op: 'create', t: 'board', id: dst }],
      }));
    }
    if (choice === 1 && cards.length) {
      const deleted = retirable('card').filter((id) => storedProbe.has(recordKey('card', id)));
      const id = deleted.length && this.rng.chance(0.7) ? this.rng.pick(deleted) : this.rng.pick(cards).id;
      const f = {};
      if (this.rng.chance(0.5)) f.title = this.rng.pick(WORDS);
      if (this.rng.chance(0.4)) f.size = (this.rng.int(20000) - 10000) / 997;
      if (this.rng.chance(0.4)) f.tier = this.rng.pick(['draft', 'review', 'done', 'dropped']);
      if (this.rng.chance(0.3)) f.claim = this.rng.pick(WORDS);
      const guard = this.rng.chance(0.3) ? [...Object.keys(f), ...(this.rng.chance(0.3) ? ['tier'] : [])].map((field) => ({ t: 'card', id, field })) : [];
      return record(commit(replica, ctx, 'self/probe', [{ op: 'update', t: 'card', id, f }], { guard, retire: deleted.includes(id) ? [{ t: 'card', id }] : [] }));
    }
    if (choice === 2 && ordered.length > 1) {
      const movable = cards.filter((c) => c.f?.ord).map((c) => c.id);
      if (movable.length === 0) return undefined;
      const moved = this.rng.pick(movable);
      const anchors = ordered.filter((id) => id !== moved);
      const below = this.rng.chance(0.3) ? null : this.rng.pick(anchors);
      return record(commit(replica, ctx, 'self/probe', [{ op: 'move', t: 'card', id: moved, anchor: { field: 'ord', below } }]));
    }
    if (choice === 3 && cards.length) {
      const id = this.rng.pick(cards).id;
      const outcome = record(commit(replica, ctx, 'self/probe', [{ op: 'delete', t: 'card', id }], { hold: true }));
      if (!storedProbe.has(recordKey('card', id)) || !this.rng.chance(0.25)) return outcome;
      // The person edits the card again inside its delete window: the edit retires the delete.
      return record(commit(replica, ctx, 'self/probe', [{ op: 'update', t: 'card', id, f: { title: this.rng.pick(WORDS) } }], { retire: [{ t: 'card', id }] }));
    }
    if (choice === 4) {
      const id = this.id('run');
      const label = this.rng.pick(WORDS);
      return record(commit(replica, ctx, 'self/probe', [], {
        cmd: { name: 'probe.start', args: { id, label, startedAt: ctx.deviceNow, join: true } },
        predict: [{ op: 'create', t: 'run', id, f: { startedAt: ctx.deviceNow, label } }],
      }));
    }
    if (choice === 5 && runs.length) {
      const run = this.rng.pick(runs);
      const endedAt = Math.max(run.f?.startedAt?.[0] ?? 0, this.now);
      return record(commit(replica, ctx, 'self/probe', [], {
        cmd: { name: 'probe.end', args: { runId: run.id, endedAt } },
        predict: [{ op: 'update', t: 'run', id: run.id, f: { endedAt } }],
      }));
    }
    if (choice === 6 && runs.length) {
      const run = this.rng.pick(runs);
      return record(commit(replica, ctx, 'self/probe', [{ op: 'create', t: 'lap', id: this.id('lap'), f: { runId: run.id, weight: (this.rng.int(4000) - 2000) / 7 } }]));
    }
    if (choice === 7 && runs.length) {
      const run = this.rng.pick(runs);
      if (this.rng.chance(0.5)) return record(commit(replica, ctx, 'self/probe', [{ op: 'update', t: 'run', id: run.id, f: { label: this.rng.pick(WORDS) } }]));
      return record(commit(replica, ctx, 'self/probe', [{ op: 'delete', t: 'run', id: run.id }], { hold: true }));
    }
    if (choice === 8) {
      if (boards.length && this.rng.chance(0.3)) return record(commit(replica, ctx, 'self/probe', [{ op: 'delete', t: 'board', id: this.rng.pick(boards).id }], { hold: true }));
      const id = `b_${this.ids.toString(16).padStart(8, '0')}`;
      this.ids += 1;
      return record(commit(replica, ctx, 'self/probe', [{ op: 'create', t: 'board', id }], { atomic: true }));
    }
    if (choice === 12 && runs.length) {
      const run = this.rng.pick(runs);
      return record(commit(replica, ctx, 'self/probe', [
        { op: 'create', t: 'card', id: this.id('card'), f: { title: this.rng.pick(WORDS), tier: 'draft' } },
        { op: 'create', t: 'lap', id: this.id('lap'), f: { runId: run.id, weight: this.rng.int(100) } },
      ], { atomic: true }));
    }
    if (boards.length === 0) return undefined;
    const board = this.rng.pick(boards).id;
    const treeScope = `tree/${board}`;
    const tree = drawn(replica, registry, treeScope);
    const tags = [...tree.values()].filter((r) => r.t === 'tag' && isAlive(r));
    if (choice === 9) {
      if (tags.length && this.rng.chance(0.3)) return record(commit(replica, ctx, treeScope, [{ op: 'delete', t: 'tag', id: this.rng.pick(tags).id }], { hold: true }));
      const dead = [...tree.values()].filter((r) => r.t === 'tag' && !isAlive(r)).map((r) => r.id)
        .concat(Object.values(replica.spentIds[treeScope] ?? {}).map((spent) => spent.id));
      if (dead.length && this.rng.chance(0.3)) return record(commit(replica, ctx, treeScope, [{ op: 'revive', t: 'tag', id: this.rng.pick(dead) }]));
      if (tags.length && this.rng.chance(0.4)) return record(commit(replica, ctx, treeScope, [{ op: 'update', t: 'tag', id: this.rng.pick(tags).id, f: { label: this.rng.pick(WORDS) } }]));
      return record(commit(replica, ctx, treeScope, [{ op: 'create', t: 'tag', label: `${this.rng.pick(WORDS)} ${this.rng.pick(WORDS)}`, f: { label: this.rng.pick(WORDS) } }]));
    }
    if (choice === 10 && tags.length >= 2) {
      const from = this.rng.pick(tags).id;
      const to = this.rng.pick(tags).id;
      const f = this.rng.chance(0.5) ? { strength: this.rng.int(10) } : {};
      return record(commit(replica, ctx, treeScope, [{ op: 'put', t: 'link', id: [from, to], present: this.rng.chance(0.7), f }]));
    }
    if (choice === 13 && tags.length) {
      const tag = this.id('tag');
      return record(commit(replica, ctx, treeScope, [
        { op: 'create', t: 'tag', id: tag, f: { label: this.rng.pick(WORDS) } },
        { op: 'put', t: 'link', id: [tag, this.rng.pick(tags).id], f: { strength: this.rng.int(10) } },
      ], { atomic: true }));
    }
    if (choice === 11 && tags.length) {
      const overlay = `self/overlay/${board}`;
      if (replica.meta.state !== 'bound') return record(commit(replica, ctx, treeScope, [{ op: 'write', t: 'meta', id: 'meta', f: { title: this.rng.pick(WORDS) } }]));
      const tag = this.rng.pick(tags).id;
      const marks = drawn(replica, registry, overlay);
      const shown = marks.get(recordKey('mark', tag))?.x?.memo ?? '';
      const words = shown.split(' ').filter(Boolean);
      if (words.length && this.rng.chance(0.4)) words.splice(this.rng.int(words.length), 1, this.rng.pick(WORDS));
      else words.push(this.rng.pick(WORDS));
      const memo = words.join(' ').slice(-38);
      const f = this.rng.chance(0.5) ? { done: this.rng.chance(0.5) } : {};
      return record(commit(replica, ctx, overlay, [{ op: 'write', t: 'mark', id: tag, f, x: { memo } }]));
    }
    return undefined;
  }

  undoSome(device) {
    const held = device.replica.entries().filter((entry) => entry.state === 'held');
    if (held.length === 0) return;
    const gestureId = this.rng.pick(held).gestureId;
    if (undoOffered(device.replica, gestureId, device.ctx().deviceNow)) undo(device.replica, this.registry, device.ended, gestureId);
  }

  startPush(device) {
    if (device.pushing) return;
    const replica = device.replica;
    const request = nextPush(replica, device.ctx(), device.pushLimit === undefined ? {} : { limit: device.pushLimit });
    if (!request) return;
    device.pushing = { kind: 'push', device, replica, replicaId: replica.id, request: structuredClone(request), send: device.reading(), id: this.id('m') };
    this.network.push({ ...device.pushing, phase: 'request' });
  }

  startPull(device) {
    if (device.pulling || device.replica.meta.state !== 'bound' || device.replica.meta.authPaused) return;
    const scopes = device.subscriptions();
    if (scopes.length === 0) return;
    reconcile(device.replica, device.ctx(), scopes);
    const request = pullRequest(device.replica, this.registry, scopes);
    device.wantsPull = false;
    if (request === null) return;
    device.pulling = { kind: 'pull', device, replica: device.replica, request: structuredClone(request), send: device.reading(), id: this.id('m') };
    this.network.push({ ...device.pulling, phase: 'request' });
  }

  deliver(index) {
    if (this.network.length === 0) return;
    const at = index ?? (this.faults ? this.rng.int(this.network.length) : 0);
    if (at > 0) this.count('delivered out of order');
    const [message] = this.network.splice(at, 1);
    if (this.faults && this.rng.chance(0.06)) return this.lose(message);
    if (message.phase === 'request') return this.serve(message);
    if (message.phase === 'frame') return this.frame(message);
    return this.reply(message);
  }

  lose(message) {
    const { device } = message;
    this.count(`${message.phase} lost`);
    if (message.phase === 'frame') {
      device.wantsPull = true;
      return;
    }
    if (message.kind === 'push' && device.pushing?.id === message.id) device.pushing = null;
    if (message.kind === 'pull' && device.pulling?.id === message.id) device.pulling = null;
  }

  serve(message) {
    const { device } = message;
    const { account, credential } = device.servedAs(message.replica);
    if (message.kind === 'push') {
      const faultOf = (replica, n) => {
        if (this.poison.has(`${replica}#${n}`)) return 'fault';
        return this.faults && this.rng.chance(0.03) ? 'transient' : null;
      };
      const budget = this.faults && this.rng.chance(0.2) ? 1 + this.rng.int(2) : Infinity;
      const malformed = account !== null && message.request.intents.some((intent) => this.rejects(intent));
      const out = malformed
        ? { state: this.server, response: { status: 400, body: { serverTime: this.now, epoch: this.server.epoch, as: account, error: 'malformed' } }, live: [] }
        : push({ state: this.server, registry: this.registry, product: this.product, account, credential, request: message.request, serverNow: this.now, budget, faultOf, limits: this.serverLimits });
      this.server = out.state;
      this.count(`http ${out.response.status}${out.response.body.error ? ` ${out.response.body.error}` : ''}`);
      for (const result of out.response.body.results ?? []) this.count(result.s === 'ok' ? (result.write?.some((w) => w.from) ? 'ok with a joining write map' : 'ok') : `refused ${result.code}`);
      if (out.response.body.retry) this.count('retry');
      this.watchDeaths();
      for (const event of out.live) this.broadcast(event);
      if (this.faults && this.rng.chance(0.05)) {
        this.network.push({ ...message, phase: 'request' });
        this.count('push request duplicated');
      }
      this.network.push({ ...message, phase: 'reply', response: out.response, tRecvServer: this.now });
      return;
    }
    const pulled = pull({ state: this.server, registry: this.registry, product: this.product, account, credential, request: message.request, serverNow: this.now, limits: this.pullLimits });
    this.server = pulled.state;
    if (pulled.response.status === 200 && account === null) this.count('pull served as anonymous');
    if (pulled.response.status === 200 && account !== null && account !== message.replica.meta.account) this.count('pull served as another account');
    this.watchDeaths();
    for (const event of pulled.live) this.broadcast(event);
    this.network.push({ ...message, phase: 'reply', response: pulled.response });
  }

  reply(message) {
    const { device } = message;
    const replica = device.replica;
    const timing = { send: message.send, recv: device.reading() };
    if (message.kind === 'push') {
      if (device.pushing?.id !== message.id) return;
      device.pushing = null;
      if (replica !== message.replica || replica.id !== message.replicaId) return;
      const before = this.contentsOf(device, message.response);
      const from = device.ended.length;
      const epoch = replica.meta.serverEpoch;
      const results = message.response.status === 200 ? message.response.body.results.length : 0;
      const dieAfter = this.midDeaths && results > 1 && this.deathRng.chance(0.2) ? this.deathRng.int(results) : Infinity;
      device.pushLimit = onPushResponse(replica, device.ctx(), message.request, message.response, timing, { dieAfter })?.limit;
      this.checkRefusals(device, before, from);
      if (epoch !== null && replica.meta.serverEpoch !== epoch) this.count('epoch change');
      if (dieAfter !== Infinity) {
        this.count('death between result batches');
        this.processDeath(device);
      }
      return;
    }
    if (device.pulling?.id !== message.id) return;
    device.pulling = null;
    if (replica !== message.replica) return;
    const before = pulledState(replica);
    const epoch = replica.meta.serverEpoch;
    const chunkRows = this.midDeaths ? 1 + this.deathRng.int(2) : Infinity;
    const dieAfter = this.midDeaths && this.deathRng.chance(0.3) ? 1 + this.deathRng.int(4) : Infinity;
    const settle = this.midDeaths ? 1 : Infinity;
    const subscribed = device.subscriptions();
    const inSet = (scope) => subscribed.includes(scope);
    const outcomes = onPullResponse(replica, device.ctx(), message.request, message.response, timing, { chunkRows, settle, dieAfter, inSet });
    this.checkServedAs(device, message.response.body?.as, before);
    if (epoch !== null && replica.meta.serverEpoch !== epoch) this.count('epoch change');
    const answered = message.response.status === 200 && !replica.isUnauthenticated(message.response);
    const cut = outcomes.some((page) => page.outcome === 'partial');
    const unsettled = outcomes.some((page) => page.outcome === 'unsettled');
    if (dieAfter !== Infinity && answered && (cut || unsettled || outcomes.length < message.response.body.pages.length)) {
      if (cut) this.count('death between page chunks');
      if (unsettled) this.count('death between settling slices');
      this.processDeath(device);
      return;
    }
    if (outcomes.length === 0) return;
    if (outcomes.some((page) => page.outcome === 'outside')) this.count('page outside the subscription set');
    if (message.response.body.pages.some((page, k) => page.more && outcomes[k]?.outcome === 'applied')) this.count('page short of its head');
    const again = (page) => page.outcome !== 'applied' && page.outcome !== 'outside';
    if (outcomes.some(again) || message.response.body.pages.some((page, k) => page.more && outcomes[k]?.outcome === 'applied')) device.wantsPull = true;
  }

  // A change frame, or a scope's death (gone to its owner, not-found to other subscribers, §6.8), as each
  // subscribed socket is served: a socket whose credential expired is closed, and one whose credential
  // was dropped is served as anonymous (§9.5).
  broadcast(event) {
    const owner = event.key.startsWith('acct:') ? event.key.slice('acct:'.length).split('/')[0] : null;
    const ref = refOfKey(event.key);
    for (const device of this.devices) {
      if (device.replica.meta.state !== 'bound' || device.credential === 'expired') continue;
      if (owner !== null && owner !== device.replica.meta.account) continue;
      if (!device.subscriptions().includes(ref)) continue;
      const sent = frameFor(this.server, event, device.servedAs(device.replica).account);
      this.network.push({ kind: 'frame', phase: 'frame', device, replica: device.replica, frame: sent, id: this.id('m') });
    }
  }

  frame(message) {
    const { device, frame } = message;
    if (device.replica !== message.replica || device.replica.meta.state !== 'bound') return;
    const before = pulledState(device.replica);
    const subscribed = device.subscriptions();
    const outcome = onFrame(device.replica, device.ctx(), frame, (scope) => subscribed.includes(scope));
    this.checkServedAs(device, frame.as, before);
    if (outcome === 'pull') device.wantsPull = true;
    if (outcome === 'applied' || outcome === 'pull') this.count(`frame ${outcome === 'applied' ? 'applied inline' : 'answered pull'}`);
    if (outcome === 'paused') this.count(frame.as === null ? 'frame served as anonymous' : 'frame served as another account');
  }

  processDeath(device) {
    this.note(`${device.name} dies`);
    this.count('process death');
    this.network = this.network.filter((message) => message.device !== device || message.phase === 'request');
    device.pushing = null;
    device.pulling = null;
    if (this.rng.chance(0.3)) {
      device.reboot();
      this.count('reboot');
    }
    device.start();
  }

  // An intent the server's schema rejects, decided once per intent: every request carrying it is
  // answered 400, and the sender isolates it by halving (§7.4).
  rejects(intent) {
    const key = jcs(intent);
    if (!this.malformed.has(key)) this.malformed.set(key, this.faults && this.rng.chance(0.01));
    return this.malformed.get(key);
  }

  signOutOrIn(device) {
    const replica = device.replica;
    if (replica.meta.state === 'bound') {
      this.note(`${device.name} signs out`);
      const choice = this.rng.chance(0.8) ? 'keep' : 'discard';
      if (choice === 'discard') device.discardedNotices.push(...replica.notices.map((notice) => notice.id));
      signOut(device.store, device.ctx(), { choice });
      this.count(`sign-out ${choice}`);
      device.pushing = null;
      device.pulling = null;
      return;
    }
    const holds = hello({ state: this.server, registry: this.registry, account: device.account, serverTime: this.now }).body.holdsRecords;
    const decisions = this.rng.chance(0.2) ? {} : { probe: this.rng.chance(0.8) ? 'add' : 'discard' };
    const outcome = signIn(device.store, device.ctx(), { account: device.account, holdsRecords: holds, decisions });
    this.note(`${device.name} signs in: ${outcome.complete ? 'complete' : 'incomplete'}`);
    this.count(`sign-in ${outcome.complete ? 'complete' : 'incomplete'}`);
    device.wantsPull = true;
  }

  // A credential expires, is dropped or is another account's; the next lapse re-authenticates,
  // clearing authPaused.
  lapseCredential(device) {
    if (device.credential === 'valid') {
      device.credential = this.rng.pick(['expired', 'dropped', 'foreign']);
      return;
    }
    device.credential = 'valid';
    device.replica.meta.authPaused = false;
  }

  poisonNext(device) {
    const replica = device.replica;
    if (replica.meta.state !== 'bound') return;
    this.poison.add(`${replica.id}#${replica.meta.nextN}`);
  }

  serverRestore() {
    if (this.serverSnapshots.length === 0 || this.rng.chance(0.5)) {
      this.serverSnapshots.push({ state: this.server.toJSON(), dead: new Set(this.deadForever) });
      return;
    }
    const snapshot = this.rng.pick(this.serverSnapshots);
    this.epochs += 1;
    this.server = new ServerState({ ...structuredClone(snapshot.state), epoch: `ep-${this.epochs}` });
    this.deadForever = new Set(snapshot.dead);
    this.note(`server restored to a snapshot, epoch ep-${this.epochs}`);
    this.count('server restored');
  }

  deviceRestore(device) {
    const saved = this.deviceSnapshots.get(device);
    if (!saved || this.rng.chance(0.5)) {
      this.deviceSnapshots.set(device, device.snapshot());
      return;
    }
    this.note(`${device.name} store restored from a snapshot`);
    this.count('store restored');
    device.restore(saved);
    this.network = this.network.filter((message) => message.device !== device || message.phase === 'request');
    device.start();
  }

  clone(device) {
    if (this.devices.length >= 5) return;
    const copy = new SimDevice(this, { name: `c${this.devices.length}`, account: device.account, signedIn: false, skew: device.skew, tabs: 1 });
    copy.restore(device.snapshot());
    copy.gestures = device.gestures + 5000;
    copy.backupGuard = null;
    copy.start();
    this.devices.push(copy);
    this.note(`${device.name} cloned as ${copy.name}`);
    this.count('store cloned');
  }

  setVisibility() {
    const trees = Object.entries(this.server.scopes).filter(([key, scope]) => key.startsWith('tree:') && scope.state === 'alive');
    if (trees.length === 0) return;
    const [key, scope] = this.rng.pick(trees);
    const visibility = this.rng.pick(['private', 'unlisted', 'public']);
    const intent = { scope: `tree/${key.slice('tree:'.length)}`, d: [{ t: 'meta', id: 'meta', f: { visibility: [visibility, null] } }] };
    const out = serverCall({ state: this.server, registry: this.registry, product: this.product, account: scope.owner, tool: 'visibility', args: { visibility }, intents: [intent], serverNow: this.now });
    this.server = out.state;
    for (const event of out.live) this.broadcast(event);
  }

  // Each entry's records and command, with ids mapped through the response's joining write maps.
  contentsOf(device, response) {
    const joined = new Map();
    for (const result of response.body?.results ?? []) for (const w of result.write ?? []) if (w.from) joined.set(recordKey(w.t, w.from), recordKey(w.t, w.id));
    const contents = new Map();
    for (const replica of device.store.replicas) {
      for (const entry of replica.outbox) {
        const keys = (entry.intent.d ?? []).map((delta) => recordKey(delta.t, delta.id));
        contents.set(entry.localId, { keys: keys.map((key) => [key, joined.get(key) ?? key]), cmd: entry.intent.cmd?.name });
      }
    }
    return contents;
  }

  // INV-3 by content: a refused entry's records and command are in the notice that holds it.
  checkRefusals(device, before, from) {
    const notices = new Map(device.store.replicas.flatMap((replica) => replica.notices.map((notice) => [notice.id, notice])));
    for (const end of device.ended.slice(from)) {
      const content = before.get(end.localId);
      if (end.outcome !== 'refused' || !content) continue;
      const notice = notices.get(`notice:${end.orphanOf ?? end.localId}`);
      if (!notice) {
        this.violations.push(`INV-3 ${device.name}: ${end.localId} refused (${end.event}) with no notice`);
        continue;
      }
      const held = [notice.content, ...(notice.content.dependents ?? [])];
      const keys = new Set(held.flatMap((part) => (part.d ?? []).map((delta) => recordKey(delta.t, delta.id))));
      const commands = new Set(held.map((part) => part.cmd?.name).filter(Boolean));
      for (const [key, mapped] of content.keys) {
        if (!keys.has(key) && !keys.has(mapped)) this.violations.push(`INV-3 ${device.name}: ${end.localId} refused, ${key} is in no notice`);
      }
      if (content.cmd && !commands.has(content.cmd)) this.violations.push(`INV-3 ${device.name}: ${end.localId} refused, its ${content.cmd} is in no notice`);
    }
  }

  // §9.1: an answer or frame served as anyone but the replica's account changes nothing it pulled.
  checkServedAs(device, as, before) {
    const replica = device.replica;
    if (as === replica.meta.account || pulledState(replica) === before) return;
    this.violations.push(`${device.name}: an answer served as ${as} changed what ${replica.meta.account}'s replica pulled`);
  }

  count(key) {
    this.tally[key] = (this.tally[key] ?? 0) + 1;
  }

  coverage() {
    const tally = { ...this.tally };
    for (const device of this.devices) {
      for (const end of device.ended) tally[`ended ${end.outcome} by ${end.event}`] = (tally[`ended ${end.outcome} by ${end.event}`] ?? 0) + 1;
    }
    return tally;
  }

  // INV-2: a non-revivable minted record the server made dead is never alive again.
  watchDeaths() {
    for (const [scope, map] of Object.entries(this.server.rows)) {
      for (const row of Object.values(map)) {
        const key = `${scope}|${recordKey(row.t, row.id)}`;
        const type = this.registry.type(row.t);
        if (!type.hasBorn || type.revivable) continue;
        if (!isAlive(row)) this.deadForever.add(key);
        else if (this.deadForever.has(key)) this.violations.push(`INV-2 ${key} is alive again`);
      }
    }
    for (const [scope, map] of Object.entries(this.server.spent)) {
      for (const entry of Object.values(map)) this.deadForever.add(`${scope}|${recordKey(entry.t, entry.id)}`);
    }
  }

  quiesce() {
    this.faults = false;
    this.poison.clear();
    for (const device of this.devices) {
      device.credential = 'valid';
      device.replica.meta.authPaused = false;
      device.start();
      if (device.replica.meta.state === 'anon') {
        const holds = hello({ state: this.server, registry: this.registry, account: device.account, serverTime: this.now }).body.holdsRecords;
        signIn(device.store, device.ctx(), { account: device.account, holdsRecords: holds, decisions: { probe: 'add' } });
      }
      for (const replica of device.store.replicas) {
        if (replica.meta.state === 'dormant' && replica.meta.account === device.account) this.violations.push(`${device.name} keeps a dormant replica after sign-in`);
      }
      device.pushing = null;
      device.pulling = null;
    }
    this.network = [];
    for (let round = 0; round < 40; round += 1) {
      this.midDeaths = round === 0;
      this.now += CONSTANTS.HOLD_MS + 1;
      let moved = false;
      for (const device of this.devices) {
        releaseAll(device.replica, this.registry, device.ended);
        for (let guard = 0; guard < 20; guard += 1) {
          this.startPush(device);
          if (this.network.length === 0) break;
          moved = true;
          while (this.network.length) this.deliver(0);
        }
        for (let guard = 0; guard < 20; guard += 1) {
          this.startPull(device);
          if (this.network.length === 0) break;
          while (this.network.length) this.deliver(0);
          if (!device.wantsPull) break;
        }
      }
      if (!moved && this.devices.every((device) => device.replica.outbox.length === 0)) {
        this.devices.forEach((device) => { device.wantsPull = true; });
        for (const device of this.devices) {
          for (let guard = 0; guard < 20 && device.wantsPull; guard += 1) {
            this.startPull(device);
            while (this.network.length) this.deliver(0);
          }
        }
        return;
      }
    }
    this.violations.push('no quiescence within 40 rounds');
  }

  serverRows(scopeRef, account) {
    const key = scopeRef.startsWith('tree/') ? `tree:${scopeRef.slice(5)}` : `acct:${account}/${scopeRef.slice(5)}`;
    return this.server.rowsOf(key).filter((row) => isAlive(row)).sort(compareRecords);
  }

  check() {
    for (const device of this.devices) {
      const replica = device.replica;
      const tag = `${device.name}(${replica.meta.state})`;
      for (const other of device.store.replicas) {
        if (other.outbox.length) this.violations.push(`${tag}: outbox of ${other.meta.state} replica not empty: ${other.outbox.map((e) => `${e.localId}:${e.state}`).join(' ')}`);
      }
      if (device.telemetry.some((event) => event.event === 'sync-digest-mismatch')) this.violations.push(`INV-15 ${tag}: digest mismatch ${jcs(device.telemetry)}`);
      const endedIds = device.ended.map((end) => end.localId);
      const unique = new Set(endedIds);
      if (unique.size !== endedIds.length) this.violations.push(`INV-3 ${tag}: an entry ended twice`);
      for (const localId of device.committed) if (!unique.has(localId)) this.violations.push(`INV-3 ${tag}: ${localId} never ended`);
      const notices = new Set([...device.discardedNotices, ...device.store.replicas.flatMap((r) => r.notices.map((notice) => notice.id))]);
      for (const end of device.ended) {
        if (end.outcome !== 'refused') continue;
        const holder = end.orphanOf ?? end.localId;
        if (!notices.has(`notice:${holder}`)) this.violations.push(`INV-3 ${tag}: ${end.localId} refused (${end.event}) with no notice holding it`);
      }
      if (replica.meta.state !== 'bound') continue;
      for (const [scope, kind] of Object.entries(replica.known)) {
        const tree = this.server.scope(`tree:${scope.split('/').at(-1)}`);
        if (kind === 'not-found' && tree?.state === 'alive' && tree.owner === replica.meta.account) this.violations.push(`§7.9 ${tag} ${scope}: known not-found, yet its tree is the account's own and alive`);
      }
      for (const scope of device.subscriptions()) {
        const mine = replica.confirmedRows(scope).sort(compareRecords);
        const truth = this.serverRows(scope, replica.meta.account);
        if (jcs(mine) !== jcs(truth)) this.violations.push(`INV-6 ${tag} ${scope}: confirmed differs from the server\n  mine  ${jcs(mine)}\n  truth ${jcs(truth)}`);
        const view = [...drawn(replica, this.registry, scope).values()].filter((r) => isVisible(this.registry.type(r.t), r));
        const truthView = truth.filter((r) => isVisible(this.registry.type(r.t), r));
        if (view.length !== truthView.length) this.violations.push(`INV-6 ${tag} ${scope}: drawn has ${view.length} visible, server ${truthView.length}`);
      }
    }
    for (const [key, scope] of Object.entries(this.server.scopes)) {
      const alive = this.server.rowsOf(key).filter((row) => row.t === 'card' && isAlive(row)).length;
      if ((scope.counters.card ?? 0) !== alive) this.violations.push(`INV-8 ${key}: counter ${scope.counters.card} but ${alive} alive cards`);
      if (alive > 3) this.violations.push(`INV-8 ${key}: ${alive} cards above the cap`);
    }
    this.checkExistence();
    return this.violations;
  }

  // INV-7(e): to an account without read access, an absent, private or dead tree answers alike.
  checkExistence() {
    const answers = new Set();
    for (const [key, scope] of Object.entries(this.server.scopes)) {
      if (!key.startsWith('tree:') || scope.owner === 'B') continue;
      const open = ['unlisted', 'public'].includes(this.server.row(key, 'meta', 'meta')?.f?.visibility?.[0]);
      if (open && scope.state === 'alive') continue;
      const page = pull({ state: this.server, registry: this.registry, product: this.product, account: 'B', request: { scopes: [{ scope: `tree/${key.slice(5)}`, cursor: null }] }, serverNow: this.now }).response.body.pages[0];
      answers.add(jcs(page).replace(key.slice(5), 'T'));
    }
    const absent = pull({ state: this.server, registry: this.registry, product: this.product, account: 'B', request: { scopes: [{ scope: 'tree/b_ffffffff', cursor: null }] }, serverNow: this.now }).response.body.pages[0];
    answers.add(jcs(absent).replace('b_ffffffff', 'T'));
    if (answers.size > 1) this.violations.push(`INV-7 existence answers differ: ${[...answers].join(' | ')}`);
  }
}
