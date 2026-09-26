// The client-step language of corpus/README.md ("Client steps"). Each step answers one snapshot in
// `returns`; a throwing step answers {throws: true} and changes nothing, being one local transaction.

import { CONSTANTS } from '../core/constants.js';
import { scopeDigest } from '../core/digest.js';
import { TransitionError } from '../core/machines.js';
import { compareRecords, isAlive } from '../core/rows.js';
import { Cursor } from '../core/wire.js';
import { CommitError, commit } from '../client/commit.js';
import { release, releaseAll, releaseDue, undo } from '../client/hold.js';
import { anonCount, discardUnsent, epochChange, reidentify, signIn, signOut } from '../client/lifecycle.js';
import { onFrame, onPullResponse, pullRequest } from '../client/puller.js';
import { Device } from '../client/replica.js';
import { nextPush, onHello, onPushResponse } from '../client/sender.js';
import { reconcile } from '../client/subscriptions.js';
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

export function runSteps({ device: deviceJson, ids = [], steps, limits }) {
  assertReachable(deviceJson);
  let device = new Device(structuredClone(deviceJson));
  const ended = [];
  const telemetry = [];
  const queue = [...ids];
  const returns = [];
  const answer = (value) => returns.push(structuredClone(value));
  let gestures = 0;
  let lastPush = null;
  let lastPull = null;
  for (const step of structuredClone(steps)) {
    const before = { device: device.toJSON(), ended: ended.length, telemetry: telemetry.length, queue: [...queue], gestures };
    const ctx = {
      registry,
      actor: step.actor ?? ACTOR,
      deviceNow: step.deviceNow ?? 0,
      ended,
      telemetry,
      appVersion: step.appVersion ?? '1',
      nextGestureId: () => `g${(gestures += 1)}`,
      newReplicaId: () => {
        if (queue.length === 0) throw new Error('the vector minted more replica ids than it lists');
        return queue.shift();
      },
      limits: { ...CONSTANTS, ...limits },
    };
    try {
      const replica = device.activeReplica;
      const timing = { tSend: step.tSend ?? ctx.deviceNow, tRecv: step.tRecv ?? ctx.deviceNow };
      switch (step.op) {
        case 'commit':
          answer(commit(replica, ctx, step.scope, step.changes ?? [], step.opts ?? {}));
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
          answer(undo(replica, ended, step.gestureId));
          break;
        case 'push':
          lastPush = nextPush(replica, ctx, step.limit === undefined ? {} : { limit: step.limit });
          answer(lastPush);
          break;
        case 'pushResponse':
          answer(onPushResponse(replica, ctx, lastPush, step.response, timing) ?? null);
          break;
        case 'hello':
          onHello(replica, step.response, timing);
          answer(null);
          break;
        case 'pull':
          lastPull = pullRequest(replica, step.scopes);
          answer(lastPull);
          break;
        case 'pullResponse':
          answer(onPullResponse(replica, ctx, lastPull, step.response, timing));
          break;
        case 'frame':
          answer(onFrame(replica, ctx, step.frame));
          break;
        case 'reconcile':
          reconcile(replica, ctx, step.scopes);
          answer(null);
          break;
        case 'signIn':
          answer(signIn(device, ctx, { account: step.account, holdsRecords: step.holdsRecords, decisions: step.decisions }));
          break;
        case 'signOut':
          answer(signOut(device, ctx, { choice: step.choice }));
          break;
        case 'discardUnsent':
          discardUnsent(device, ctx, device.replica(step.replica));
          answer(null);
          break;
        case 'reidentify':
          reidentify(replica, ctx);
          answer(null);
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
    } catch (error) {
      if (!(error instanceof CommitError) && !(error instanceof TransitionError)) throw error;
      device = new Device(before.device);
      ended.length = before.ended;
      telemetry.length = before.telemetry;
      queue.splice(0, queue.length, ...before.queue);
      gestures = before.gestures;
      answer({ throws: true });
    }
  }
  return { returns, device: device.toJSON(), ended, telemetry };
}

export function stepsVector(name, input) {
  if (input.limits === undefined) delete input.limits;
  const out = runSteps(input);
  const expect = { returns: out.returns, device: out.device, ended: out.ended };
  if (out.telemetry.length) expect.telemetry = out.telemetry;
  return { name, input, expect };
}
