// The pure rules behind a proposal's diff and card. Nothing here writes, decides or derives a target.
// The change rows ARE the document as well as the diff: rows up to the first `removed` are the run
// the routine would take on, in order, and the rest are what it takes away, so all of them are drawn
// — the order is part of what applies and the wire carries it nowhere else. A run of kept rows
// collapses to a count IN ITS PLACE and expands there, so the document never reads out of order.
// The count under Apply is the store's. A proposal names its fields `sets` · `reps` · `weightKg` ·
// `restSeconds` where a routine entry names them `target…`, and both hand the reading to `entryLabel`.

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

// The transport's name for the writer: the agent's own where it gave one, else the connection's (the
// OAuth client or the key), the same on every surface. Null for Coach and for a caller with neither.
export function agentNameOf(source) {
  if (source?.agent) return source.agent;
  if (source?.connection) return source.connection;
  return null;
}

// `door: 'ask'` is the wire's token for the Coach room.
export function sourceLabel(source) {
  const named = agentNameOf(source);
  if (named) return named;
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

// The card's one affordance, the same word on every surface; the count is on the card's own line.
export const REVIEW_VERB = 'Review';

// The store's count and not the rows this screen drew: the store is what applies.
export function applyLabel(proposal) {
  if (proposal.intent === 'remove') return `Remove ${proposal.baseName}`;
  if (proposal.changeCount === 1) return 'Apply';
  return `Apply all ${proposal.changeCount}`;
}

// Apply is atomic against a frozen base revision: all of it or none.
export function atomicLine(proposal) {
  if (proposal.intent === 'remove') {
    return 'The routine goes and your logged sets stay. Nothing is applied until you tap.';
  }
  return `All ${numberWord(proposal.changeCount)} or none. Nothing is applied until you tap.`;
}

// Why Apply is shut, and the way out of it. Said on the screen and not only to a screen reader,
// byte-identical on all three surfaces (`Proposal.applyHint`). Driven off `seen` alone: while the
// apply request is in flight Apply is inert for a different reason, and this sentence would lie.
export const APPLY_HINT = 'Read the changes to the end to apply them.';

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

// How much a proposal is, in one phrase, for the Coach card and the routine's history row. A removal
// carries every base entry as a `removed` change, so the count is positive and would read
// `12 changes` for a proposal that DELETES the routine — which is why the intent is asked first,
// here and on both phones (`Proposal.counted`, `line(about:)`).
export function countedLabel(head) {
  if (head.intent === 'remove') return 'a removal';
  return changeLabel(head.changeCount);
}

export function historyLabel(head) {
  const from = `${countedLabel(head)} from ${sourceLabel(head.source)}`;
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

export const TURN_DOWN_VERB = 'Turn this down';

// Closing the review decides nothing; the card keeps saying so.
export const STILL_WAITING = 'still waiting';

// Above the diff and never in the band: a session's plan is frozen, so applying now changes nothing
// about the workout in progress, and a line inside the band would move Apply.
export const MID_WORKOUT_CAVEAT = 'You are mid-workout. Applying changes next time, not this session.';

// The writer's prose sits under this, apart from the counted rows; the two are different kinds of
// truth. Attributed by door: the room, a named agent, or an unnamed one — never Coach's name over
// an agent's words.
export function wroteKicker(source) {
  const named = agentNameOf(source);
  if (named) return `${named} wrote:`;
  if (source?.door === 'ask') return 'Coach wrote:';
  return 'Your agent wrote:';
}

export function keptRunLabel(count) {
  return count === 1 ? 'and 1 line unchanged' : `and ${count} lines unchanged`;
}

// The card outside the dialog is a SKIM, not the document: what moved, three lines of it, and the
// rest counted. The rows that are the document as well as the diff are behind Review, where the
// scroll gate makes reading them the price of applying them.
export const CARD_ROW_CAP = 3;

// The rows a card may draw. A kept line is the routine standing still; the rename and the order are
// claims about the whole document, and the document is only in the dialog — `the lines run in the
// order below` has no lines below it on a card. `countedLabel` reads the store's own `changeCount`,
// which counts a rename and a reorder, so nothing a card stops drawing stops being counted.
export const CARD_ROW_KINDS = ['added', 'removed', 'retargeted'];

export function moreRowsLabel(count) {
  return `+ ${count} more`;
}

// Runs of kept rows fold to one `kept-run` item holding the rows it stands for, at the run's own
// position; a run whose `at` is in `expanded` unfolds there. Changed rows pass through untouched.
export function collapseKept(rows, expanded = new Set()) {
  const folded = [];
  let run = null;
  rows.forEach((row, index) => {
    if (row.kind !== 'kept') {
      run = null;
      folded.push(row);
      return;
    }
    if (run) {
      run.rows.push(row);
      return;
    }
    run = { kind: 'kept-run', at: index, rows: [row] };
    folded.push(run);
  });
  return folded.flatMap((item) => (item.kind === 'kept-run' && expanded.has(item.at) ? item.rows : [item]));
}

// The receipt is derived from the server's settle reply and never from the model's prose, and it is
// not stored: it lands in the thread for the visit and is gone on reopening. The count is the
// server's to state; a reply without one gets no count, never a made-up one.
export function receiptLine({ verb, proposal }) {
  if (verb === 'dismiss') return 'Turned down · nothing changed.';
  const name = proposal?.name ?? proposal?.baseName;
  if (proposal?.intent === 'remove') return `Applied · ${name} · routine removed`;
  if (typeof proposal?.changeCount !== 'number') return `Applied · ${name}`;
  return `Applied · ${name} · ${changeLabel(proposal.changeCount)}`;
}

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

// The rows are the whole routine and not a filtered changelog — the one line that asserts it, and
// the only one, since a proposal that retargets every line folds no kept run to say it. The dialog
// title already names the routine and every kept row already prints its numbers, so neither is
// repeated here. A removal has no document left to read and draws no such line.
export function documentLine(proposal) {
  if (proposal.intent === 'remove') return null;
  return 'The whole routine, top to bottom — the marked lines change.';
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
