// protocol/*.jsonl: transcripts of the reference client against the reference server. Line 1 is the
// header; every later line is one client action, one HTTP exchange, one live frame or one server load,
// in the order they happened (corpus/README.md, "Protocol transcripts").

import { steadyTiming } from '../core/clock.js';
import { CONSTANTS } from '../core/constants.js';
import { commit } from '../client/commit.js';
import { release, releaseAll } from '../client/hold.js';
import { signIn, signOut } from '../client/lifecycle.js';
import { onFrame, onPullResponse, pullRequest } from '../client/puller.js';
import { Device, Replica } from '../client/replica.js';
import { nextPush, onHello, onPushResponse } from '../client/sender.js';
import { reconcile } from '../client/subscriptions.js';
import { deathFrameFor, hello, pull } from '../server/pull.js';
import { push } from '../server/push.js';
import { ServerState } from '../server/state.js';
import { ACTOR, OTHER, product, registry } from './fixtures.js';

function replicaId(n) {
  return `rp_${String(n).padStart(32, '0')}`;
}

function boundDevice(id, account, meta = {}) {
  const replica = Replica.fresh({ replica: id, state: 'bound', account });
  Object.assign(replica.meta, meta);
  return new Device({ active: id, replicas: [replica.toJSON()] }).toJSON();
}

function anonDevice(id) {
  return new Device({ active: id, replicas: [Replica.fresh({ replica: id, state: 'anon' }).toJSON()] }).toJSON();
}

// A device's instance actors: its first actor, then one fresh actor for each re-identify (D-2).
function actorsOf(base) {
  return [base, ...[1, 2, 3].map((k) => `${base.slice(0, -1)}${k}`)];
}

class Stage {
  constructor(transcript, about, { server, devices, ids = {}, actors = {} }) {
    this.server = new ServerState(server);
    this.devices = Object.fromEntries(Object.entries(devices).map(([name, json]) => [name, new Device(json)]));
    this.ids = Object.fromEntries(Object.entries(ids).map(([name, list]) => [name, [...list]]));
    const queues = Object.fromEntries(Object.keys(devices).map((name) => [name, actorsOf(actors[name] ?? ACTOR)]));
    this.current = Object.fromEntries(Object.entries(queues).map(([name, list]) => [name, list[0]]));
    this.actorQueues = Object.fromEntries(Object.entries(queues).map(([name, list]) => [name, list.slice(1)]));
    this.ended = Object.fromEntries(Object.keys(devices).map((name) => [name, []]));
    this.lines = [{ transcript, about, registry: registry.name, server: this.server.toJSON(), devices: structuredClone(devices), ids: structuredClone(ids), actors: queues }];
    this.gestures = 0;
  }

  // The context of one client call; the device keeps the actor the call leaves (a re-identify renews it).
  call(name, deviceNow, act) {
    const take = (list, what) => {
      const next = list?.shift();
      if (next === undefined) throw new Error(`${name} has no ${what} left`);
      return next;
    };
    const ctx = {
      registry,
      actor: this.current[name],
      deviceNow,
      ended: this.ended[name],
      telemetry: [],
      appVersion: '1',
      nextGestureId: () => `g${(this.gestures += 1)}`,
      newReplicaId: () => take(this.ids[name], 'replica id'),
      newActor: () => take(this.actorQueues[name], 'actor'),
      newForkGuard: () => take(undefined, 'fork guard'),
      draw: () => take(undefined, 'draw'),
      limits: CONSTANTS,
    };
    const out = act(ctx);
    this.current[name] = ctx.actor;
    return out;
  }

  line(fields) {
    this.lines.push({ step: this.lines.length, ...structuredClone(fields) });
  }

  // A client action in the client-steps vocabulary.
  do(name, op, args, deviceNow) {
    const device = this.devices[name];
    const replica = device.activeReplica;
    const out = this.call(name, deviceNow, (ctx) => {
      if (op === 'commit') return commit(replica, ctx, args.scope, args.changes ?? [], args.opts ?? {});
      if (op === 'release') return release(replica, registry, ctx.ended, replica.entry(args.localId));
      if (op === 'releaseAll') return releaseAll(replica, registry, ctx.ended) ?? null;
      if (op === 'signIn') return signIn(device, ctx, args);
      if (op === 'signOut') return signOut(device, ctx, args);
      if (op === 'reconcile') return reconcile(replica, ctx, args.scopes) ?? null;
      if (op === 'load') {
        this.devices[name] = new Device(structuredClone(args.device));
        return null;
      }
      throw new Error(`unknown action ${op}`);
    });
    this.line({ device: name, do: op, args, deviceNow, returns: out });
    return out;
  }

  account(name) {
    const meta = this.devices[name].activeReplica.meta;
    return meta.state === 'bound' ? meta.account : null;
  }

  // One push: the device numbers its batch, the server answers, and unless the reply is lost the device
  // applies it. Change frames and death frames (§6.8) go to the listed subscribers of each scope.
  push(name, { serverNow, deviceNow = serverNow, authenticated = true, budget, fault = [], lost = false, frames = [] }) {
    const replica = this.devices[name].activeReplica;
    const request = this.call(name, deviceNow, (ctx) => nextPush(replica, ctx));
    if (request === null) throw new Error(`${name} has nothing to push`);
    const account = authenticated ? this.account(name) : null;
    const out = push({
      state: this.server,
      registry,
      product,
      account,
      request,
      serverNow,
      budget: budget ?? Infinity,
      faultOf: (_, n) => (fault.includes(n) ? 'fault' : null),
    });
    this.server = out.state;
    const fields = { device: name, http: 'push', account, serverNow, deviceNow, request: structuredClone(request), response: out.response };
    const inject = {};
    if (budget !== undefined) inject.budget = budget;
    if (fault.length) inject.fault = fault;
    if (Object.keys(inject).length) fields.inject = inject;
    if (lost) fields.lost = true;
    this.line(fields);
    if (!lost) this.call(name, deviceNow, (ctx) => onPushResponse(replica, ctx, request, out.response, steadyTiming(deviceNow, deviceNow)));
    this.deliver(out.live, frames, deviceNow);
    return out.response;
  }

  // Change frames and death frames (§6.8) to the listed subscribers of each scope.
  deliver(live, subscribers, deviceNow) {
    for (const event of live) {
      for (const subscriber of subscribers) {
        const owner = event.key.startsWith('acct:') ? event.key.slice('acct:'.length).split('/')[0] : null;
        if (owner !== null && owner !== this.account(subscriber)) continue;
        this.frame(subscriber, event.frame ?? deathFrameFor(this.server, event.key, this.account(subscriber)), deviceNow);
      }
    }
  }

  // One pull: the server runs the scopes' beforePull commands, then answers the pages.
  pull(name, scopes, { serverNow, deviceNow = serverNow, frames = [] }) {
    const replica = this.devices[name].activeReplica;
    const request = pullRequest(replica, scopes);
    const account = this.account(name);
    const out = pull({ state: this.server, registry, product, account, request, serverNow });
    this.server = out.state;
    const sent = structuredClone({ request, response: out.response });
    const outcomes = this.call(name, deviceNow, (ctx) => onPullResponse(replica, ctx, request, out.response, steadyTiming(deviceNow, deviceNow)));
    this.line({ device: name, http: 'pull', account, serverNow, deviceNow, ...sent, returns: outcomes });
    this.deliver(out.live, frames, deviceNow);
    return out.response;
  }

  // A hello: the device takes its offset sample from the answer (§10.4).
  hello(name, { serverNow, account }) {
    const response = hello({ state: this.server, registry, account, serverTime: serverNow });
    this.call(name, serverNow, (ctx) => onHello(this.devices[name].activeReplica, ctx, response, steadyTiming(serverNow, serverNow)));
    this.line({ device: name, http: 'hello', account, serverNow, deviceNow: serverNow, request: {}, response });
    return response.body;
  }

  frame(name, frame, deviceNow) {
    const sent = structuredClone(frame);
    const outcome = this.call(name, deviceNow, (ctx) => onFrame(this.devices[name].activeReplica, ctx, frame));
    this.line({ device: name, frame: sent, deviceNow, returns: outcome });
    return outcome;
  }

  load(state) {
    this.server = new ServerState(state);
    this.line({ server: 'load', state });
  }

  finish() {
    this.line({ end: true, server: this.server.toJSON(), devices: Object.fromEntries(Object.entries(this.devices).map(([name, device]) => [name, device.toJSON()])), ended: this.ended });
    return this.lines;
  }
}

const EMPTY = new ServerState({ epoch: 'ep-1', clock: { ms: 0, counter: 0 }, accounts: { A: { name: 'Ann' }, B: { name: 'Bob' } } }).toJSON();
const T = 1_000_000;
const createCard = (id, title) => ({ scope: 'self/probe', changes: [{ op: 'create', t: 'card', id, f: { title } }] });
const editCard = (id, title) => ({ scope: 'self/probe', changes: [{ op: 'update', t: 'card', id, f: { title } }] });

function pushTranscript() {
  const one = replicaId(1);
  const stage = new Stage('push', 'numbering, results, resends answered from sync_results, ackThrough pruning, retry by budget, poison, 401, and the three 409s with re-identify', {
    server: EMPTY,
    devices: { d1: boundDevice(one, 'A'), d2: boundDevice(replicaId(2), 'A', { nextN: 3 }), d3: boundDevice(one, 'B') },
    ids: { d1: [replicaId(11)], d2: [replicaId(21)], d3: [replicaId(31)] },
    actors: { d1: ACTOR, d2: 'r_cccccccccccc', d3: OTHER },
  });
  stage.do('d1', 'commit', createCard('card0001', 'One'), T);
  stage.do('d1', 'commit', createCard('card0002', 'Two'), T + 10);
  stage.push('d1', { serverNow: T + 20 });
  stage.do('d1', 'commit', editCard('card0001', 'Uno'), T + 30);
  stage.push('d1', { serverNow: T + 40, lost: true });
  stage.push('d1', { serverNow: T + 50 });
  stage.do('d1', 'commit', createCard('card0003', 'Three'), T + 60);
  stage.do('d1', 'commit', editCard('card0002', 'Dos'), T + 70);
  stage.do('d1', 'commit', editCard('card0003', 'Tres'), T + 80);
  stage.push('d1', { serverNow: T + 90, budget: 1 });
  stage.push('d1', { serverNow: T + 100 });
  stage.do('d1', 'commit', editCard('card0001', 'Ein'), T + 110);
  const poisoned = [stage.devices.d1.activeReplica.meta.nextN];
  stage.push('d1', { serverNow: T + 120, fault: poisoned });
  stage.push('d1', { serverNow: T + 130, fault: poisoned });
  stage.push('d1', { serverNow: T + 140, fault: poisoned });
  stage.do('d1', 'commit', editCard('card0002', 'Zwei'), T + 150);
  stage.push('d1', { serverNow: T + 160, authenticated: false });
  stage.do('d2', 'commit', { scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: 'b_00000002' }] }, T + 170);
  stage.push('d2', { serverNow: T + 180 });
  stage.push('d2', { serverNow: T + 190 });
  stage.do('d3', 'commit', createCard('cardbbbb', 'Bee'), T + 200);
  stage.push('d3', { serverNow: T + 210 });
  stage.push('d3', { serverNow: T + 220 });
  const snapshot = boundDevice(one, 'A', { nextN: 1 });
  stage.do('d1', 'load', { device: snapshot }, T + 230);
  stage.do('d1', 'commit', { scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: 'b_00000003' }] }, T + 240);
  stage.push('d1', { serverNow: T + 250 });
  stage.push('d1', { serverNow: T + 260 });
  return stage.finish();
}

function pullTranscript() {
  const board = 'b_00000001';
  const stage = new Stage('pull', 'a boot straight into confirmed rows, a live page, gone, and after a server restore an epoch change that drops the stale page and boots into staging', {
    server: EMPTY,
    devices: { d1: boundDevice(replicaId(1), 'A'), d2: boundDevice(replicaId(2), 'A') },
    ids: { d1: [replicaId(11)], d2: [replicaId(21)] },
    actors: { d1: ACTOR, d2: 'r_cccccccccccc' },
  });
  const scopes = ['self/probe', `tree/${board}`, `self/overlay/${board}`];
  stage.do('d2', 'commit', createCard('card0001', 'One'), T);
  stage.do('d2', 'commit', { scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: board }] }, T + 5);
  stage.do('d2', 'commit', { scope: `tree/${board}`, changes: [{ op: 'write', t: 'meta', id: 'meta', f: { title: 'Plan' } }, { op: 'create', t: 'tag', label: 'Oak Tree' }] }, T + 6);
  stage.push('d2', { serverNow: T + 10 });
  stage.pull('d1', scopes, { serverNow: T + 20 });
  const restorePoint = stage.server.toJSON();
  stage.do('d2', 'commit', editCard('card0001', 'Uno'), T + 30);
  stage.push('d2', { serverNow: T + 40 });
  stage.pull('d1', ['self/probe'], { serverNow: T + 50 });
  stage.do('d2', 'commit', { scope: 'self/probe', changes: [{ op: 'delete', t: 'board', id: board }] }, T + 60);
  stage.push('d2', { serverNow: T + 70 });
  stage.pull('d1', scopes, { serverNow: T + 80 });
  stage.do('d1', 'reconcile', { scopes: ['self/probe'] }, T + 90);
  stage.load({ ...restorePoint, epoch: 'ep-2' });
  stage.pull('d1', ['self/probe'], { serverNow: T + 100 });
  stage.pull('d1', ['self/probe'], { serverNow: T + 110 });
  return stage.finish();
}

function liveTranscript() {
  const stage = new Stage('live', 'change frames applied inline at the next seq, a frame past a gap answered by a pull, and a deleted board\'s tree gone to its subscriber', {
    server: EMPTY,
    devices: { d1: boundDevice(replicaId(1), 'A'), d2: boundDevice(replicaId(2), 'A') },
    actors: { d1: ACTOR, d2: 'r_cccccccccccc' },
  });
  stage.pull('d1', ['self/probe'], { serverNow: T });
  stage.do('d2', 'commit', createCard('card0001', 'One'), T + 10);
  stage.push('d2', { serverNow: T + 20, frames: ['d1'] });
  stage.do('d2', 'commit', editCard('card0001', 'Uno'), T + 30);
  stage.push('d2', { serverNow: T + 40 });
  stage.do('d2', 'commit', createCard('card0002', 'Two'), T + 50);
  stage.push('d2', { serverNow: T + 60, frames: ['d1'] });
  stage.pull('d1', ['self/probe'], { serverNow: T + 70 });
  stage.do('d2', 'commit', { scope: 'self/probe', changes: [{ op: 'create', t: 'board', id: 'b_00000001' }] }, T + 80);
  stage.push('d2', { serverNow: T + 90, frames: ['d1'] });
  stage.pull('d1', ['tree/b_00000001', 'self/overlay/b_00000001'], { serverNow: T + 100 });
  stage.do('d2', 'commit', { scope: 'self/probe', changes: [{ op: 'delete', t: 'board', id: 'b_00000001' }] }, T + 110);
  stage.push('d2', { serverNow: T + 120, frames: ['d1'] });
  return stage.finish();
}

function joinTranscript() {
  const stage = new Stage('join', 'probe.start on two devices: the second joins the first run, and its write map rewrites the entries behind it', {
    server: EMPTY,
    devices: { d1: boundDevice(replicaId(1), 'A'), d2: boundDevice(replicaId(2), 'A') },
    actors: { d1: ACTOR, d2: 'r_cccccccccccc' },
  });
  const start = (id, label, at) => ({
    scope: 'self/probe',
    opts: {
      cmd: { name: 'probe.start', args: { id, label, startedAt: at, join: true } },
      predict: [{ op: 'create', t: 'run', id, f: { startedAt: at, label } }],
    },
  });
  stage.do('d2', 'commit', start('runbbbb1', 'Bee', T), T);
  stage.push('d2', { serverNow: T + 10 });
  stage.do('d1', 'commit', start('runaaaa1', 'Ann', T + 20), T + 20);
  stage.do('d1', 'commit', { scope: 'self/probe', changes: [{ op: 'create', t: 'lap', id: 'lapaaaa1', f: { runId: 'runaaaa1', weight: 20 } }] }, T + 30);
  stage.do('d1', 'commit', { scope: 'self/probe', changes: [{ op: 'update', t: 'run', id: 'runaaaa1', f: { label: 'Mine' } }] }, T + 40);
  stage.do('d1', 'commit', { scope: 'self/probe', changes: [{ op: 'delete', t: 'run', id: 'runaaaa1' }], opts: { hold: true } }, T + 50);
  stage.push('d1', { serverNow: T + 60 });
  stage.push('d1', { serverNow: T + 70 });
  stage.pull('d1', ['self/probe'], { serverNow: T + 80 });
  return stage.finish();
}

function skewTranscript() {
  const fast = T + 600_000;
  const stage = new Stage('skew', 'a device clock ten minutes fast: clock-skew, the offset from the response, the restamp in commit order, and the resend', {
    server: EMPTY,
    devices: { d1: boundDevice(replicaId(1), 'A') },
  });
  stage.do('d1', 'commit', createCard('card0001', 'One'), fast);
  stage.do('d1', 'commit', editCard('card0001', 'Uno'), fast + 5);
  stage.do('d1', 'commit', { scope: 'self/probe', changes: [{ op: 'update', t: 'card', id: 'card0001', f: { body: 'More' } }], opts: { guard: [{ t: 'card', id: 'card0001', field: 'body' }] } }, fast + 6);
  stage.push('d1', { serverNow: T, deviceNow: fast + 10, budget: 1 });
  stage.push('d1', { serverNow: T + 20, deviceNow: fast + 30 });
  stage.pull('d1', ['self/probe'], { serverNow: T + 40, deviceNow: fast + 50 });
  return stage.finish();
}

function helloTranscript() {
  const stage = new Stage('hello', 'hello before and after sign-in: signed-out work meets a signed-out decision because the account holds records', {
    server: EMPTY,
    devices: { d1: anonDevice(replicaId(1)), d2: boundDevice(replicaId(2), 'A') },
    ids: { d1: [replicaId(11)] },
    actors: { d1: ACTOR, d2: 'r_cccccccccccc' },
  });
  stage.do('d2', 'commit', createCard('card0001', 'One'), T);
  stage.push('d2', { serverNow: T + 10 });
  stage.hello('d1', { serverNow: T + 20, account: null });
  stage.do('d1', 'commit', createCard('card0002', 'Two'), T + 30);
  const body = stage.hello('d1', { serverNow: T + 40, account: 'A' });
  stage.do('d1', 'signIn', { account: 'A', holdsRecords: body.holdsRecords, decisions: {} }, T + 50);
  stage.do('d1', 'signIn', { account: 'A', holdsRecords: body.holdsRecords, decisions: { probe: 'add' } }, T + 60);
  stage.push('d1', { serverNow: T + 70 });
  stage.pull('d1', ['self/probe'], { serverNow: T + 80 });
  return stage.finish();
}

export function files() {
  return {
    'protocol/push.jsonl': pushTranscript(),
    'protocol/pull.jsonl': pullTranscript(),
    'protocol/live.jsonl': liveTranscript(),
    'protocol/join.jsonl': joinTranscript(),
    'protocol/skew.jsonl': skewTranscript(),
    'protocol/hello.jsonl': helloTranscript(),
  };
}
