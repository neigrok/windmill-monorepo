// §8 the state machines as data. Every outbox state change in the client goes through `moveEntry`, so
// a transition the table lacks throws; the replica and scope tables back the lifecycle and admission.

export const TERMINAL_OUTCOMES = ['undone', 'coalesced', 'resolved', 'refused', 'discarded'];

// §8.1. `from: null` is an intent not yet in the outbox.
export const INTENT_MACHINE = [
  { from: [null], event: 'commit', to: ['held', 'ready'] },
  { from: [null, 'ready'], event: 'coalesce', to: ['coalesced'] },
  { from: ['held'], event: 'release', to: ['ready'] },
  { from: ['held'], event: 'undo', to: ['undone'] },
  { from: ['held'], event: 'retire', to: ['undone'] },
  { from: ['ready'], event: 'number', to: ['sent'] },
  { from: ['held', 'ready'], event: 'cancel', to: ['coalesced'] },
  { from: ['held', 'ready'], event: 'fold', to: ['refused'] },
  { from: ['held', 'ready'], event: 'target-merged', to: ['refused'] },
  { from: ['sent'], event: 'ok', to: ['acked'] },
  { from: ['sent'], event: 'recover', to: ['ready'] },
  { from: ['sent'], event: 'refuse', to: ['refused'] },
  { from: ['sent'], event: 'transport', to: ['sent'] },
  { from: ['sent'], event: 'reidentify', to: ['ready'] },
  { from: ['sent'], event: 'skew-return', to: ['ready'] },
  { from: ['sent'], event: 'rewind', to: ['ready'] },
  { from: ['acked'], event: 'resolve', to: ['resolved'] },
  { from: ['acked'], event: 'epoch', to: ['ready'] },
  { from: ['held', 'ready', 'sent', 'acked'], event: 'discard', to: ['discarded'] },
];

// §8.2, without the owner-unknown state R99 removed.
export const REPLICA_MACHINE = [
  { from: [null], event: 'first-launch', to: ['anon'] },
  { from: [null], event: 'sign-in', to: ['bound'] },
  { from: ['dormant'], event: 'sign-in', to: ['bound', 'dormant'] },
  { from: ['anon'], event: 'sign-in', to: ['bound', 'deleted', 'anon'] },
  { from: ['bound'], event: 'sign-out-keep', to: ['dormant'] },
  { from: ['bound'], event: 'sign-out-discard', to: ['deleted'] },
  { from: ['dormant'], event: 'discard', to: ['deleted'] },
  { from: ['anon'], event: 'reidentify', to: ['anon'] },
  { from: ['bound'], event: 'reidentify', to: ['bound'] },
  { from: ['dormant'], event: 'reidentify', to: ['dormant'] },
];

// §8.3.
export const SCOPE_MACHINE = [
  { from: ['absent'], event: 'first-write', to: ['alive'] },
  { from: ['absent'], event: 'governing-create', to: ['alive'] },
  { from: ['alive'], event: 'governing-delete', to: ['dead'] },
  { from: ['dead'], event: 'horizon', to: ['dead'] },
];

export class TransitionError extends Error {}

export function transition(machine, from, event, to) {
  const rule = machine.find((row) => row.event === event && row.from.includes(from));
  if (!rule) throw new TransitionError(`no ${event} from ${from}`);
  const next = to ?? rule.to[0];
  if (!rule.to.includes(next)) throw new TransitionError(`${event} from ${from} cannot reach ${next}`);
  return next;
}

// Moves an outbox entry; a terminal outcome removes it and is logged in `ended`, with the refusal whose
// notice holds its content when it was folded or orphaned.
export function moveEntry(replica, ended, entry, event, to) {
  const next = transition(INTENT_MACHINE, entry.state, event, to);
  if (TERMINAL_OUTCOMES.includes(next)) {
    replica.removeEntry(entry.localId);
    const end = { localId: entry.localId, outcome: next, event };
    if (entry.orphanOf !== undefined) end.orphanOf = entry.orphanOf;
    ended.push(end);
    return next;
  }
  entry.state = next;
  if (next === 'ready') {
    for (const key of ['n', 'digest', 'resultSeq', 'resultEpoch']) delete entry[key];
    delete entry.intent.n;
  }
  return next;
}
