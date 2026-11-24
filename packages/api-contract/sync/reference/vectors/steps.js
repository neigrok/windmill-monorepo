// The client-step language of corpus/README.md ("Client steps"). Each step answers one snapshot in
// `returns`; a throwing step answers {throws: true} and changes nothing, being one local transaction.
// `Session` pairs the steps with the reference server, so every response a vector carries is one it answered.

import assert from 'node:assert/strict';
import { steadyTiming } from '../core/clock.js';
import { CONSTANTS } from '../core/constants.js';
import { scopeDigest } from '../core/digest.js';
import { TransitionError } from '../core/machines.js';
import { compareRecords, isAlive } from '../core/rows.js';
import { Cursor } from '../core/wire.js';
import { commitAct } from '../client/acts.js';
import { CommitError, commit } from '../client/commit.js';
import { release, releaseAll, releaseDue, undo } from '../client/hold.js';
import { anonCount, discardUnsent, engineStart, epochChange, reidentify, renewActor, signIn, signOut } from '../client/lifecycle.js';
import { onFrame, onPullResponse, pullRequest } from '../client/puller.js';
import { dismiss } from '../client/refusal.js';
import { Device } from '../client/replica.js';
import { nextPush, onHello, onPushResponse, ResponseError } from '../client/sender.js';
import { reconcile, subscribe, subscriptionsOf } from '../client/subscriptions.js';
import { capCount, view } from '../client/views.js';
import { readInverseResult, requestInverse } from '../client/inverse.js';
import { releaseReversibleAct } from '../client/journal.js';
import { pull } from '../server/pull.js';
import { push } from '../server/push.js';
import { ACTOR, product, registry } from './fixtures.js';

// A device as a client holds it after pulling its confirmed rows: each confirmed scope has a live
// cursor at its highest seq and the digest of its rows, and a replica with cursors knows the epoch.
export function settle(deviceJson, epoch = 'ep-1') {
  const out = structuredClone(deviceJson);
  for (const replica of out.replicas) {
    for (const [scope, rows] of Object.entries(replica.confirmed ?? {})) {
      if (rows.length === 0) continue;
      replica.cursors ??= {};
      replica.cursors[scope] ??= { cursor: Cursor.encode({ e: epoch, m: 'live', s: Math.max(...rows.map((row) => row.seq)) }), digest: '', booted: true };
      replica.cursors[scope].digest = scopeDigest(rows);
    }
    if (Object.keys(replica.cursors ?? {}).length && replica.meta.serverEpoch === null) replica.meta.serverEpoch = epoch;
  }
  return out;
}

// A gesture id, and so a local id, names one gesture of the device (§2.5): no two outbox entries of its replicas share one.
function assertDistinctLocalIds(deviceJson, what) {
  const localIds = deviceJson.replicas.flatMap((replica) => (replica.outbox ?? []).map(({ localId }) => localId));
  if (new Set(localIds).size !== localIds.length) throw new Error(`${what}: two outbox entries share a local id`);
}

// An input device must be one a client can reach: distinct local ids, no dead confirmed row (a dead row deletes),
// no confirmed rows without their scope's cursor record, and every digest the sum of its rows.
export function assertReachable(deviceJson) {
  assertDistinctLocalIds(deviceJson, 'unreachable input');
  for (const replica of deviceJson.replicas) {
    const where = (scope) => `${replica.meta.replica} ${scope}`;
    for (const [scope, rows] of Object.entries(replica.confirmed ?? {})) {
      if (rows.some((row) => !isAlive(row))) throw new Error(`unreachable input: a dead confirmed row in ${where(scope)}`);
      if (rows.length && !replica.cursors?.[scope]) throw new Error(`unreachable input: confirmed rows without a cursor record in ${where(scope)}`);
    }
    for (const [scope, record] of Object.entries(replica.cursors ?? {})) {
      const digest = scopeDigest(replica.confirmed?.[scope] ?? []);
      if (record.digest !== digest) throw new Error(`unreachable input: cursor digest ${record.digest} is not ${digest} in ${where(scope)}`);
    }
    for (const [scope, staged] of Object.entries(replica.staging ?? {})) {
      if (staged.digest !== scopeDigest(staged.rows)) throw new Error(`unreachable input: staging digest in ${where(scope)}`);
    }
  }
}

// Queues the steps draw from in order: replica ids, instance actors, fork guards and CSPRNG draws.
class Queues {
  constructor({ ids = [], actors = [], forkGuards = [], draws = [] }) {
    this.lists = { ids: [...ids], actors: [...actors], forkGuards: [...forkGuards], draws: [...draws] };
  }

  take(name) {
    if (this.lists[name].length === 0) throw new Error(`the vector uses more ${name} than it lists`);
    return this.lists[name].shift();
  }

  snapshot() {
    return structuredClone(this.lists);
  }

  restore(lists) {
    this.lists = lists;
  }
}

export function runSteps({ device: deviceJson, ids, actors, forkGuards, draws, actor = ACTOR, steps, limits }, registryOverride = registry) {
  const registry = registryOverride;
  assertReachable(deviceJson);
  let device = new Device(structuredClone(deviceJson));
  const ended = [];
  const telemetry = [];
  const events = [];
  const queues = new Queues({ ids, actors, forkGuards, draws });
  const returns = [];
  const answer = (value) => returns.push(structuredClone(value));
  let gestures = 0;
  let current = actor;
  let lastPush = null;
  let lastPull = null;
  let pulledFor = null;
  let reconciled = null;
  const opened = new Set();
  for (const step of structuredClone(steps)) {
    const before = { device: device.toJSON(), ended: ended.length, telemetry: telemetry.length, events: events.length, queues: queues.snapshot(), gestures, current };
    const stepActor = step.actor ?? current;
    const ctx = {
      registry: registryOverride,
      actor: stepActor,
      deviceNow: step.deviceNow ?? 0,
      ended,
      telemetry,
      events,
      appVersion: step.appVersion ?? '1',
      device,
      nextGestureId: () => {
        let gestureId;
        do gestureId = `g${(gestures += 1)}`; while (device.carriesGesture(gestureId));
        return gestureId;
      },
      newReplicaId: () => queues.take('ids'),
      newActor: () => queues.take('actors'),
      newForkGuard: () => queues.take('forkGuards'),
      draw: (size) => {
        const index = queues.take('draws');
        if (index >= size) throw new Error(`draw ${index} is not below ${size}`);
        return index;
      },
      limits: { ...CONSTANTS, ...limits },
    };
    try {
      const replica = device.activeReplica;
      const timing = step.send ? { send: step.send, recv: step.recv } : steadyTiming(step.tSend ?? ctx.deviceNow, step.tRecv ?? ctx.deviceNow);
      switch (step.op) {
        case 'commit':
          if (step.changes === null) answer(commit(replica, ctx, step.scope, () => ({ gesture: null })).outcome);
          else answer(commit(replica, ctx, step.scope, step.changes ?? [], step.opts ?? {}));
          break;
        case 'commitAct': {
          const outcome = commitAct(replica, ctx, step.segments, step.opts ?? {});
          if (outcome === null || outcome.refused) { queues.restore(before.queues); gestures = before.gestures; }
          answer(outcome);
          break;
        }
        case 'release':
          answer(release(replica, registry, ended, replica.entry(step.localId)));
          break;
        case 'releaseAll':
          releaseAll(replica, registry, ended);
          answer(null);
          break;
        case 'releaseDue':
          releaseDue(replica, registry, ended, ctx.deviceNow);
          answer(null);
          break;
        case 'undo':
          answer(undo(replica, registry, ended, step.gestureId));
          break;
        case 'requestInverse':
          answer(requestInverse(replica, ctx, step.actId, step.slots));
          break;
        case 'readInverseResult':
          answer(readInverseResult(replica, step.requestId));
          break;
        case 'releaseReversibleAct':
          answer(releaseReversibleAct(replica, step.actId));
          break;
        case 'dismiss':
          answer(dismiss(replica, step.id));
          break;
        case 'push':
          lastPush = nextPush(replica, ctx, step.limit === undefined ? {} : { limit: step.limit });
          answer(lastPush);
          break;
        case 'pushResponse':
          answer(onPushResponse(replica, ctx, lastPush, step.response, timing, dieAfter(step)) ?? null);
          break;
        case 'hello':
          onHello(replica, ctx, step.response, timing);
          answer(null);
          break;
        case 'pull':
          if (step.scopes === undefined) {
            reconciled = subscriptionsOf(replica, registry, ['probe'], opened);
            reconcile(replica, ctx, reconciled);
          }
          lastPull = pullRequest(replica, registry, step.scopes ?? reconciled);
          pulledFor = replica;
          answer(lastPull);
          break;
        case 'pullResponse':
          if (pulledFor !== replica) {
            answer(null);
            break;
          }
          answer(onPullResponse(replica, ctx, lastPull, step.response, timing, {
            ...dieAfter(step),
            ...(step.chunk === undefined ? {} : { chunkRows: step.chunk }),
            ...(step.settle === undefined ? {} : { settle: step.settle }),
            ...(reconciled === null ? {} : { inSet: (scope) => reconciled.includes(scope) }),
          }));
          break;
        case 'frame':
          answer(onFrame(replica, ctx, step.frame, reconciled === null ? undefined : (scope) => reconciled.includes(scope)));
          break;
        case 'reconcile':
          reconciled = step.scopes === undefined ? subscriptionsOf(replica, registry, ['probe'], opened) : [...step.scopes];
          reconcile(replica, ctx, reconciled);
          answer(null);
          break;
        case 'subscribe': {
          const outcome = subscribe(replica, step.scope);
          if (outcome !== 'gone') {
            opened.add(step.scope);
            if (reconciled !== null) reconciled = [...new Set([...reconciled, ...subscriptionsOf(replica, registry, [], [step.scope])])];
          }
          answer(outcome);
          break;
        }
        case 'unsubscribe':
          opened.delete(step.scope);
          reconciled = subscriptionsOf(replica, registry, ['probe'], opened);
          reconcile(replica, ctx, reconciled);
          answer(null);
          break;
        case 'subscriptions':
          answer(subscriptionsOf(replica, registry, ['probe'], opened));
          break;
        case 'signIn':
          answer(signIn(device, ctx, { account: step.account, holdsRecords: step.holdsRecords, decisions: step.decisions, counted: step.counted }));
          break;
        case 'signOut':
          answer(signOut(device, ctx, { choice: step.choice, counted: step.counted }));
          break;
        case 'discardUnsent':
          discardUnsent(device, ctx, device.replica(step.replica));
          answer(null);
          break;
        case 'reidentify':
          reidentify(replica, ctx);
          renewActor(ctx);
          answer(null);
          break;
        case 'engineStart':
          answer(engineStart(device, ctx, Object.hasOwn(step, 'backupGuard') ? { backupGuard: step.backupGuard } : {}));
          break;
        case 'epochChange':
          epochChange(replica, ctx, step.epoch);
          answer(null);
          break;
        case 'anonCount':
          answer(anonCount(registry, device.replica(step.replica), step.product));
          break;
        case 'view': {
          const records = [...view(replica, registry, step.scope, { withHeld: step.withHeld }).values()].sort(compareRecords);
          const caps = {};
          for (const type of registry.types.values()) if (type.cap !== undefined && type.scope === registry.scopeKindOf(step.scope)) caps[type.type] = capCount(replica, registry, step.scope, type.type);
          answer({ records, capCount: caps });
          break;
        }
        default:
          throw new Error(`unknown step ${step.op}`);
      }
      if (ctx.actor !== stepActor) current = ctx.actor;
    } catch (error) {
      if (!(error instanceof CommitError) && !(error instanceof TransitionError) && !(error instanceof ResponseError)) throw error;
      device = new Device(before.device);
      if (pulledFor) pulledFor = device.replica(pulledFor.id);
      ended.length = before.ended;
      telemetry.length = before.telemetry;
      events.length = before.events;
      queues.restore(before.queues);
      gestures = before.gestures;
      current = before.current;
      answer({ throws: true });
    }
  }
  return { returns, device: device.toJSON(), ended, telemetry, events };
}

// A response step's process death: the answer's first `dieAfter` transactions commit, and nothing after.
function dieAfter(step) {
  return step.dieAfter === undefined ? {} : { dieAfter: step.dieAfter };
}

export function stepsVector(name, input) {
  for (const key of ['limits', 'ids', 'actors', 'forkGuards', 'draws', 'actor']) {
    if (input[key] === undefined || (Array.isArray(input[key]) && input[key].length === 0)) delete input[key];
  }
  const out = runSteps(input);
  assertDistinctLocalIds(out.device, `${name} expects a device`);
  const expect = { returns: out.returns, device: out.device, ended: out.ended };
  if (out.telemetry.length) expect.telemetry = out.telemetry;
  if (out.events.length) expect.events = out.events;
  return { name, input, expect };
}

// Client steps paired with the reference server's answers: `push` and `pull` ask the device for its request
// as the steps so far leave it, let the server answer, and append the answer.
export class Session {
  constructor({ device, state }, input = {}) {
    this.device = device;
    this.state = state;
    this.input = input;
    this.steps = [];
    this.serverNow = 6000;
  }

  local(...steps) {
    this.steps.push(...steps);
    return this;
  }

  run() {
    return runSteps({ device: this.device, ...this.input, steps: this.steps });
  }

  last() {
    return this.run().returns.at(-1);
  }

  push({ deviceNow = this.serverNow, dieAfter, answer = (response) => response } = {}) {
    this.steps.push({ op: 'push', deviceNow });
    const request = this.last();
    if (!request) return null;
    this.serverNow += 1000;
    const pushed = push({ state: this.state, registry, product, account: 'A', request, serverNow: this.serverNow });
    this.state = pushed.state;
    const response = answer(structuredClone(pushed.response));
    this.steps.push({ op: 'pushResponse', response, deviceNow, ...(dieAfter === undefined ? {} : { dieAfter }) });
    return response;
  }

  // Pushes until nothing is left to number, each answer applied.
  flush(limit = 8) {
    for (let k = 0; k < limit; k++) if (this.push() === null) return this;
    throw new Error('the session did not flush');
  }

  // Intents another replica of the same account pushes meanwhile, each at the server's present.
  elsewhere(...intents) {
    this.serverNow += 1000;
    this.otherN = (this.otherN ?? 0) + intents.length;
    const request = { replica: 'rp_0000000000000000000000000000000b', account: 'A', ackThrough: 0,
      intents: intents.map((intent, k) => ({ n: this.otherN - intents.length + 1 + k, ...intent })) };
    const pushed = push({ state: this.state, registry, product, account: 'A', request, serverNow: this.serverNow });
    assert.ok(pushed.response.body.results.every(({ s }) => s === 'ok'), 'a foreign write lands');
    this.state = pushed.state;
    return this;
  }

  pull(scopes, { deviceNow = this.serverNow, dieAfter, settle: perSlice } = {}) {
    this.steps.push({ op: 'pull', scopes, deviceNow });
    const request = this.last();
    if (!request) return null;
    this.serverNow += 1000;
    const pulled = pull({ state: this.state, registry, product, account: 'A', request, serverNow: this.serverNow });
    this.state = pulled.state;
    this.steps.push({ op: 'pullResponse', response: pulled.response, deviceNow,
      ...(dieAfter === undefined ? {} : { dieAfter }), ...(perSlice === undefined ? {} : { settle: perSlice }) });
    return pulled.response;
  }

  vector(name) {
    return stepsVector(name, { device: this.device, ...this.input, steps: structuredClone(this.steps) });
  }
}
