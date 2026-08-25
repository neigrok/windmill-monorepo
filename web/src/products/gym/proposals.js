// The pure rules behind a proposal's diff and card. Nothing here writes, decides or derives a target.
// The change rows ARE the document as well as the diff: rows up to the first `removed` are the run
// the routine would take on, in order, and the rest are what it takes away, so all of them are drawn
// — the order is part of what applies and the wire carries it nowhere else. The count under Apply is
// the store's. A proposal names its fields `sets` · `reps` · `weightKg` · `restSeconds` where a
// routine entry names them `target…`, and both hand the reading to `entryLabel`.

import {
  agoLabel, entryLabel, fmt, numberWord, OPEN_TARGET, shortDayLabel, targetLoadOf, timeLabel,
} from './log.js';
import { restLabel } from './settings/preferences.js';

// Every other state is settled and stays settled; the wire has no path back.
export function isPending(proposal) {
  return proposal?.state === 'pending';
}

// `superseded` is what a proposal becomes when the routine moves under it, and is not a dismissal.
const STATE_CHIPS = {
  pending: 'Pending',
  applied: 'Applied',
  dismissed: 'Turned down',
  superseded: 'Superseded',
};

export function stateChip(proposal) {
  return STATE_CHIPS[proposal?.state] ?? null;
}

// `agent` is often omitted, the transport carrying no connection identity; the door is the one fact
// the store always holds.
export const UNNAMED_AGENT = 'your connected agent';

// `door: 'ask'` is the wire's token for the Coach room.
export function sourceLabel(source) {
  if (source?.agent) return source.agent;
  if (source?.door === 'ask') return 'Coach';
  return UNNAMED_AGENT;
}

// `source.thread` is the conversation the diff was written in, and is offered only where present.
export const CONVERSATION_VERB = 'Open the conversation';

export function conversationOf(source) {
  return source?.thread ?? null;
}

export function changeLabel(count) {
  return count === 1 ? '1 change' : `${count} changes`;
}

export function reviewLabel(head) {
  if (head.intent === 'remove') return 'Read the proposal';
  return `Review ${changeLabel(head.changeCount)}`;
}

// The store's count and not the rows this screen drew: the store is what applies.
export function applyLabel(proposal) {
  if (proposal.intent === 'remove') return `Remove ${proposal.baseName}`;
  return `Apply all ${proposal.changeCount}`;
}

// Apply is atomic against a frozen base revision: all of it or none.
export function atomicLine(proposal) {
  if (proposal.intent === 'remove') {
    return 'The routine goes and your logged sets stay. Nothing is applied until you tap.';
  }
  return `All ${numberWord(proposal.changeCount)} or none. Nothing is applied until you tap.`;
}

// The consequence is drawn from the intent, never from what the proposal says about itself.
export function intentLine(head, routineName) {
  if (head.intent !== 'remove') return null;
  return `Removes ${routineName} from your routines.`;
}

// `summary` is always present on the wire and may be empty.
export function summaryLine(head, routineName) {
  const summary = (head.summary ?? '').trim();
  if (summary !== '') return summary;
  if (head.intent === 'remove') return `A proposal to remove ${routineName}.`;
  return `${changeLabel(head.changeCount)} to ${routineName}.`;
}

// A pending proposal is in the same list and borrows none of these verbs.
const STATE_VERBS = {
  applied: 'applied',
  dismissed: 'turned down',
  superseded: 'superseded',
};

export function historyLabel(head) {
  const what = head.intent === 'remove' ? 'a removal' : changeLabel(head.changeCount);
  const from = `${what} from ${sourceLabel(head.source)}`;
  if (isPending(head)) return `${shortDayLabel(head.createdAt)} · ${from} · waiting for you`;
  return `${shortDayLabel(head.settledAt ?? head.createdAt)} · ${STATE_VERBS[head.state]} ${from}`;
}

export function settledLine(proposal, now = Date.now()) {
  const when = `${agoLabel(proposal.settledAt, now)} at ${timeLabel(proposal.settledAt)}`;
  if (proposal.state === 'applied') {
    return `Applied to ${proposal.baseName} ${when}. Kept on the routine as a dated record — the program’s history, not a toast that disappears.`;
  }
  // A record and never a way back: the wire has no path that reopens one.
  if (proposal.state === 'dismissed') {
    return `Turned down ${when}. Nothing changed, and it stays in the routine’s history as a record.`;
  }
  if (proposal.state === 'superseded') {
    return `${proposal.baseName} changed ${when}, after this was written. Nothing from it was applied, and it stays in the routine’s history.`;
  }
  return null;
}

// Turning down settles for good; the confirmation guards an act the wire cannot undo.
export const TURN_DOWN_CONFIRM = {
  title: 'Turn this down?',
  body: 'Nothing changes, and it stays in the routine’s history as a record.',
  confirm: 'Turn down',
  keep: 'Keep it',
};

// `sets` is the pair — the sets and the reps moving together — and an absent rep target is `max`.
// An absent `sets` is the OPEN line and never a missing side; the missing side is the row's `kind`.
function setsReading(side) {
  if (side.sets == null) return OPEN_TARGET;
  return `${side.sets} × ${side.reps ?? 'max'}`;
}

// Zero is the absence of a load and an absent load is "last time"; neither prints a number, and
// neither may print the other's word.
function weightReading(side) {
  const target = targetLoadOf(side.weightKg);
  if (target == null) return 'last time';
  return fmt(target);
}

// An absent rest is the account's own target and not the settings screen's `off`.
function restReading(side) {
  if (side.restSeconds == null) return 'your rest target';
  return restLabel(side.restSeconds);
}

// Only what moved.
function movesBetween(before = {}, after = {}) {
  const moves = [];
  for (const [field, reading] of [['sets', setsReading], ['weight', weightReading], ['rest', restReading]]) {
    const from = reading(before);
    const to = reading(after);
    if (from !== to) moves.push({ field, from, to });
  }
  return moves;
}

// A zero is a real answer and gets its own words; an absent count draws no sentence at all.
export function logKeptLabel(loggedSets) {
  if (typeof loggedSets !== 'number') return null;
  if (loggedSets === 0) return 'nothing logged against it yet';
  if (loggedSets === 1) return '1 logged set kept';
  return `${loggedSets} logged sets kept`;
}

function targetsReading(side) {
  return entryLabel({
    targetSets: side.sets,
    targetReps: side.reps,
    targetWeightKg: side.weightKg,
  });
}

// A removal has no document left to read and draws no such line.
export function documentLine(proposal) {
  if (proposal.intent === 'remove') return null;
  return `${proposal.baseName} as it would read, top to bottom. The marked lines change; the rest keep their numbers.`;
}

// Every line of the document, in its order. A `kept` row is drawn unmarked; a rename is a row of its
// own, the store counting it in `changeCount`. A reorder is a counted change no marked row carries,
// and the client never sees the base — so whatever the count holds beyond the marked rows is the
// order moving.
export function diffRows(proposal) {
  const rows = [];
  if (typeof proposal.name === 'string' && proposal.name !== proposal.baseName) {
    rows.push({ kind: 'renamed', from: proposal.baseName, to: proposal.name });
  }
  const changes = proposal.changes ?? [];
  const marked = rows.length + changes.filter((change) => change.kind !== 'kept').length;
  if (typeof proposal.changeCount === 'number' && proposal.changeCount > marked) {
    rows.push({ kind: 'reordered' });
  }
  changes.forEach((change, index) => {
    if (change.kind === 'kept') {
      rows.push({ kind: 'kept', exerciseId: change.exerciseId, targets: targetsReading(change.after) });
      return;
    }
    if (change.kind === 'added') {
      rows.push({
        kind: 'added',
        exerciseId: change.exerciseId,
        targets: targetsReading(change.after),
        // An absent rest sets nothing — the line takes the account's own target — and draws no words.
        rest: change.after.restSeconds == null ? null : restLabel(change.after.restSeconds),
        // Where it lands: the run is in order and removals sort last, so the row before an added one
        // is part of the routine it is joining.
        follows: index === 0 ? null : changes[index - 1].exerciseId,
      });
      return;
    }
    if (change.kind === 'removed') {
      rows.push({ kind: 'removed', exerciseId: change.exerciseId, kept: logKeptLabel(change.loggedSets) });
      return;
    }
    rows.push({ kind: 'retargeted', exerciseId: change.exerciseId, moves: movesBetween(change.before, change.after) });
  });
  return rows;
}
