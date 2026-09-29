// The client-step language of corpus/README.md ("Client steps"). Each step answers one snapshot in
// `returns`; a throwing step answers {throws: true} and changes nothing, being one local transaction.

import { steadyTiming } from '../core/clock.js';
import { CONSTANTS } from '../core/constants.js';
import { scopeDigest } from '../core/digest.js';
import { TransitionError } from '../core/machines.js';
import { compareRecords, isAlive } from '../core/rows.js';
import { Cursor } from '../core/wire.js';
import { CommitError, commit } from '../client/commit.js';
import { release, releaseAll, releaseDue, undo } from '../client/hold.js';
import { anonCount, discardUnsent, engineStart, epochChange, reidentify, renewActor, signIn, signOut } from '../client/lifecycle.js';
import { onFrame, onPullResponse, pullRequest } from '../client/puller.js';
import { dismiss } from '../client/refusal.js';
import { Device } from '../client/replica.js';
import { nextPush, onHello, onPushResponse } from '../client/sender.js';
import { reconcile, subscribe, subscriptionsOf } from '../client/subscriptions.js';
import { capCount, view } from '../client/views.js';
import { ACTOR, registry } from './fixtures.js';

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

// An input device must be one a client can reach: no dead confirmed row (a dead row deletes), no
// confirmed rows without their scope's cursor record, and every digest the sum of its rows.
export function assertReachable(deviceJson) {
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

export function runSteps({ device: deviceJson, ids, actors, forkGuards, draws, actor = ACTOR, steps, limits }) {
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
  for (const step of structuredClone(steps)) {
    const before = { device: device.toJSON(), ended: ended.length, telemetry: telemetry.length, events: events.length, queues: queues.snapshot(), gestures, current };
    const stepActor = step.actor ?? current;
    const ctx = {
      registry,
      actor: stepActor,
      deviceNow: step.deviceNow ?? 0,
      ended,
      telemetry,
      events,
      appVersion: step.appVersion ?? '1',
      device,
      nextGestureId: () => `g${(gestures += 1)}`,
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
        case 'dismiss':
          dismiss(replica, step.id);
          answer(null);
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
          lastPull = pullRequest(replica, registry, step.scopes);
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
            ...(reconciled === null ? {} : { inSet: (scope) => reconciled.includes(scope) }),
          }));
          break;
        case 'frame':
          answer(onFrame(replica, ctx, step.frame, reconciled === null ? undefined : (scope) => reconciled.includes(scope)));
          break;
        case 'reconcile':
          reconciled = step.scopes === undefined ? subscriptionsOf(replica, registry, ['probe']) : [...step.scopes];
          reconcile(replica, ctx, reconciled);
          answer(null);
          break;
        case 'subscribe':
          if (reconciled !== null && !reconciled.includes(step.scope)) reconciled.push(step.scope);
          answer(subscribe(replica, step.scope));
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
      if (!(error instanceof CommitError) && !(error instanceof TransitionError)) throw error;
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
  const expect = { returns: out.returns, device: out.device, ended: out.ended };
  if (out.telemetry.length) expect.telemetry = out.telemetry;
  if (out.events.length) expect.events = out.events;
  return { name, input, expect };
}
