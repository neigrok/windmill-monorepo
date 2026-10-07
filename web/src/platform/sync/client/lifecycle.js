// §7.10 the replica lifecycle (sign-in by the lineage rule, sign-out, discard), §7.11 the fork guard
// and re-identify, §7.3's engine start, §7.5 step 1's epoch change, and §7.12's `activeReplicaChanged`,
// which announces every change of `activeReplica()` in `ctx.events`.

import { moveEntry, REPLICA_MACHINE, transition } from '../core/machines.js';
import { hashText } from '../core/encoding.js';
import { jcs } from '../core/jcs.js';
import { recordKey, stampsOf } from '../core/rows.js';
import { releaseAll } from './hold.js';
import { commandRefs } from './dependents.js';
import { Replica } from './replica.js';

// §7.12: `activeReplica()` answers `replica` where it answered `previous`.
function announce(ctx, previous, replica) {
  if (previous !== replica) ctx.events?.push({ event: 'activeReplicaChanged', previous, replica });
}

export function reidentify(replica, ctx) {
  transition(REPLICA_MACHINE, replica.meta.state, 'reidentify', replica.meta.state);
  const previous = replica.meta.replica;
  replica.meta.replica = ctx.newReplicaId();
  replica.meta.nextN = 1;
  replica.meta.ackThrough = 0;
  for (const entry of replica.entries()) if (entry.state === 'sent') moveEntry(replica, ctx.ended, entry, 'reidentify');
  if (ctx.device?.activeReplica === replica) announce(ctx, previous, replica.meta.replica);
}

// D-2: the engine instance takes a fresh actor at every process launch and at every re-identify.
export function renewActor(ctx) {
  ctx.actor = ctx.newActor();
}

export function epochChange(replica, ctx, epoch) {
  replica.meta.serverEpoch = epoch;
  for (const cursor of Object.values(replica.cursors)) cursor.cursor = null;
  replica.staging = {};
  for (const entry of replica.entries()) {
    if (entry.state !== 'acked' || entry.resultEpoch === epoch) continue;
    if (entry.intent.cmd && entry.writeTargets === undefined) {
      const refs = commandRefs(ctx.registry, entry.intent.cmd);
      entry.writeTargets = (entry.predict ?? []).flatMap((delta) => {
        const sources = refs.filter((ref) => ref.t === delta.t);
        if (sources.length !== 1 || entry.predict.filter((other) => other.t === delta.t).length !== 1) return [];
        return [{ t: delta.t, from: sources[0].id, id: delta.id, ...(delta.born === undefined ? {} : { born: delta.born }) }];
      });
    }
    moveEntry(replica, ctx.ended, entry, 'epoch');
  }
  reidentify(replica, ctx);
  renewActor(ctx);
}

// §7.3 and §7.11 at engine start: every held entry is released, the instance takes a new actor, and a
// native store (options.backupGuard given: the backup-excluded copy, or null when missing) whose
// forkGuard differs from that copy re-identifies every replica under a new forkGuard. A store without
// a forkGuard mints its first. Web runs no fork guard and passes no backupGuard.
// Answers {actor, reidentified, pendingSignIn?}; a pending sign-in is resumed by the caller.
export function engineStart(device, ctx, options = {}) {
  for (const replica of device.replicas) releaseAll(replica, ctx.registry, ctx.ended);
  renewActor(ctx);
  let reidentified = false;
  if (Object.hasOwn(options, 'backupGuard')) {
    if (device.meta.forkGuard !== undefined && options.backupGuard !== device.meta.forkGuard) {
      for (const replica of device.replicas) reidentify(replica, ctx);
      reidentified = true;
    }
    if (device.meta.forkGuard === undefined || reidentified) device.meta.forkGuard = ctx.newForkGuard();
  }
  const answer = { actor: ctx.actor, reidentified };
  if (device.meta.pendingSignIn) answer.pendingSignIn = device.meta.pendingSignIn;
  return answer;
}

function entriesOf(registry, replica, product) {
  return replica.entries().filter((entry) => registry.productOfRef(entry.scope) === product);
}

// The count, by type, of the records (scope, t, id) a product's entries create or change.
export function anonCount(registry, replica, product) {
  const records = new Map();
  for (const entry of entriesOf(registry, replica, product)) {
    for (const delta of [...(entry.intent.d ?? []), ...(entry.predict ?? [])]) records.set(`${entry.scope}|${recordKey(delta.t, delta.id)}`, delta.t);
  }
  const counts = {};
  for (const t of [...records.values()].sort()) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}

function observeEntries(replica) {
  for (const entry of replica.entries()) {
    replica.observe([entry.stamp, ...[...(entry.intent.d ?? []), ...(entry.predict ?? [])].flatMap(stampsOf)]);
  }
}

// Whether an answer's pinned local ids are the ones its question counts now; an answer without them
// is given to the question as it stands.
function sameCounted(pinned, counted) {
  return pinned === undefined || (pinned.length === counted.length && pinned.every((localId, index) => localId === counted[index]));
}

// Sign-in as `account`, after a hello whose holdsRecords is given. `decisions[product]` is 'add' or
// 'discard', answering the question whose local ids `counted[product]` pins. Answers {complete, due},
// each due decision with the local ids it counts; an incomplete sign-in changes nothing past the
// release of holds, and a decision whose entries changed since its question is due again.
export function signIn(device, ctx, { account, holdsRecords, decisions = {}, counted = {} }) {
  const { registry } = ctx;
  const previous = device.activeReplica?.id;
  const anon = device.anonReplica();
  if (anon) releaseAll(anon, registry, ctx.ended);
  const due = Object.keys(registry.products).sort()
    .filter((product) => holdsRecords[product] && anon && entriesOf(registry, anon, product).length > 0)
    .map((product) => ({ kind: 'signed-out', product, count: anonCount(registry, anon, product), counted: entriesOf(registry, anon, product).map((entry) => entry.localId) }));
  const answered = (decision) => (decisions[decision.product] === 'add' || decisions[decision.product] === 'discard')
    && sameCounted(counted[decision.product], decision.counted);
  if (!due.every(answered)) {
    device.meta.pendingSignIn = { account };
    return { complete: false, due };
  }

  for (const decision of due) {
    if (decisions[decision.product] !== 'discard') continue;
    for (const entry of entriesOf(registry, anon, decision.product)) moveEntry(anon, ctx.ended, entry, 'discard');
    delete anon.device[decision.product];
  }

  let target = device.dormantOf(account);
  if (target) {
    target.meta.state = transition(REPLICA_MACHINE, 'dormant', 'sign-in', 'bound');
    target.cursors = {};
    target.staging = {};
  } else if (anon && anon.outbox.length > 0) {
    target = anon;
    anon.meta.state = transition(REPLICA_MACHINE, 'anon', 'sign-in', 'bound');
    anon.meta.account = account;
  } else {
    target = device.add(Replica.fresh({ replica: ctx.newReplicaId(), state: transition(REPLICA_MACHINE, null, 'sign-in', 'bound'), account }));
  }

  if (anon && anon !== target && anon.outbox.length > 0) {
    for (const entry of anon.entries()) {
      entry.commitOrder = target.nextCommitOrder();
      target.outbox.push(entry);
    }
    for (const [product, rows] of Object.entries(anon.device)) {
      const kept = target.deviceRows(product);
      for (const [key, value] of Object.entries(rows)) if (!Object.hasOwn(kept, key)) kept[key] = value;
    }
    target.notices.push(...anon.notices);
    transition(REPLICA_MACHINE, 'anon', 'sign-in', 'deleted');
    device.remove(anon);
  }
  for (const entry of target.outbox) entry.lineage = account;
  observeEntries(target);
  target.meta.authPaused = false;
  delete device.meta.pendingSignIn;
  device.activeReplica = target;
  announce(ctx, previous, target.id);
  return { complete: true, due };
}

// Sign-out after the caller's flush (at most SIGNOUT_FLUSH_MS). Without a finish (`choice` keep, the
// confirm when nothing is left, or discard) it answers the question {unsent, ready, sent, counted},
// the counted local ids of the ready and sent entries and the byte-pinned durable device work
// (Discard cannot recall a sent entry that may have
// landed). Keep covers every entry; a Discard whose pinned `counted` differs from the entries now is
// asked again. The finish resolves acked entries, which the server holds.
export function signOut(device, ctx, { choice, counted } = {}) {
  const bound = device.activeReplica;
  const previous = bound.id;
  releaseAll(bound, ctx.registry, ctx.ended);
  const unsent = bound.entries().filter((entry) => entry.state === 'ready' || entry.state === 'sent');
  // Products identify durable device work that has not yet become an outbox entry. Pin its bytes so
  // Discard asks again if typing changed after the question, even when its device key did not.
  const pending = Object.entries(bound.device).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .flatMap(([product, rows]) => (ctx.pendingDeviceWork?.(product, rows) ?? []).slice().sort().map((key) =>
      `device:${product}:${key}:${hashText(jcs(rows[key]))}`));
  const question = {
    unsent: unsent.length + pending.length,
    ready: unsent.filter((entry) => entry.state === 'ready').length,
    sent: unsent.filter((entry) => entry.state === 'sent').length,
    counted: [...unsent.map((entry) => entry.localId), ...pending],
    ...(pending.length ? { pending: pending.length } : {}),
  };
  const finished = choice === 'keep' || (choice === 'discard' && sameCounted(counted, question.counted));
  if (!finished) return { complete: false, ...question };
  for (const entry of bound.entries()) if (entry.state === 'acked') moveEntry(bound, ctx.ended, entry, 'resolve');
  if (choice === 'keep') {
    bound.meta.state = transition(REPLICA_MACHINE, 'bound', 'sign-out-keep', 'dormant');
    bound.confirmed = {};
    bound.spentIds = {};
    bound.cursors = {};
    bound.staging = {};
    bound.known = {};
    // Device rows hold durable product work, including edits behind frozen command payloads.
    // Keep retains them with this account's dormant replica; Discard deletes the entire replica.
  } else {
    transition(REPLICA_MACHINE, 'bound', 'sign-out-discard', 'deleted');
    for (const entry of bound.entries()) moveEntry(bound, ctx.ended, entry, 'discard');
    device.remove(bound);
  }
  device.activeReplica = device.anonReplica() ?? device.add(Replica.fresh({ replica: ctx.newReplicaId(), state: 'anon' }));
  announce(ctx, previous, device.activeReplica.id);
  return { complete: true, ...question };
}

export function discardUnsent(device, ctx, replica) {
  transition(REPLICA_MACHINE, replica.meta.state, 'discard', 'deleted');
  for (const entry of replica.entries()) moveEntry(replica, ctx.ended, entry, 'discard');
  device.remove(replica);
}
