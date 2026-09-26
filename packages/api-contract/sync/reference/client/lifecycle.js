// §7.10 the replica lifecycle (sign-in by the lineage rule, sign-out, discard), §7.11 re-identify and
// §7.5 step 1's epoch change. R99 leaves one decision kind: the signed-out decision.

import { moveEntry, REPLICA_MACHINE, transition } from '../core/machines.js';
import { recordKey, stampsOf } from '../core/rows.js';
import { releaseAll } from './hold.js';
import { Replica } from './replica.js';

export function reidentify(replica, ctx) {
  transition(REPLICA_MACHINE, replica.meta.state, 'reidentify', replica.meta.state);
  replica.meta.replica = ctx.newReplicaId();
  replica.meta.nextN = 1;
  replica.meta.ackThrough = 0;
  for (const entry of replica.entries()) if (entry.state === 'sent') moveEntry(replica, ctx.ended, entry, 'reidentify');
}

export function epochChange(replica, ctx, epoch) {
  replica.meta.serverEpoch = epoch;
  for (const cursor of Object.values(replica.cursors)) cursor.cursor = null;
  replica.staging = {};
  for (const entry of replica.entries()) {
    if (entry.state === 'acked' && entry.resultEpoch !== epoch) moveEntry(replica, ctx.ended, entry, 'epoch');
  }
  reidentify(replica, ctx);
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

// Sign-in as `account`, after a hello whose holdsRecords is given. `decisions[product]` is 'add' or
// 'discard'. Answers {complete, due}; an incomplete sign-in changes nothing past the release of holds.
export function signIn(device, ctx, { account, holdsRecords, decisions = {} }) {
  const { registry } = ctx;
  const anon = device.anonReplica();
  if (anon) releaseAll(anon, registry, ctx.ended);
  const due = Object.keys(registry.products).sort()
    .filter((product) => holdsRecords[product] && anon && entriesOf(registry, anon, product).length > 0)
    .map((product) => ({ kind: 'signed-out', product, count: anonCount(registry, anon, product) }));
  if (due.some((decision) => decisions[decision.product] !== 'add' && decisions[decision.product] !== 'discard')) {
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
  device.activeReplica = target;
  return { complete: true, due };
}

// Sign-out of the active bound replica. Acked entries are admitted and resolve as every scope is
// unsubscribed; with entries left and no choice, answers {unsent} so the product can ask Keep or Discard.
export function signOut(device, ctx, { choice } = {}) {
  const bound = device.activeReplica;
  releaseAll(bound, ctx.registry, ctx.ended);
  for (const entry of bound.entries()) if (entry.state === 'acked') moveEntry(bound, ctx.ended, entry, 'resolve');
  const unsent = bound.outbox.length;
  if (unsent > 0 && choice !== 'keep' && choice !== 'discard') return { complete: false, unsent };
  if (unsent === 0 || choice === 'keep') {
    bound.meta.state = transition(REPLICA_MACHINE, 'bound', 'sign-out-keep', 'dormant');
    bound.confirmed = {};
    bound.spentIds = {};
    bound.cursors = {};
    bound.staging = {};
    bound.known = {};
    bound.device = {};
  } else {
    transition(REPLICA_MACHINE, 'bound', 'sign-out-discard', 'deleted');
    for (const entry of bound.entries()) moveEntry(bound, ctx.ended, entry, 'discard');
    device.remove(bound);
  }
  device.activeReplica = device.anonReplica() ?? device.add(Replica.fresh({ replica: ctx.newReplicaId(), state: 'anon' }));
  return { complete: true, unsent };
}

export function discardUnsent(device, ctx, replica) {
  transition(REPLICA_MACHINE, replica.meta.state, 'discard', 'deleted');
  for (const entry of replica.entries()) moveEntry(replica, ctx.ended, entry, 'discard');
  device.remove(replica);
}
