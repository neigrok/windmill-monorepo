// The pure rules behind a proposal's diff and card. Nothing here writes, decides or derives a target.
// The change rows ARE the document as well as the diff: rows up to the first `removed` are the run
// the routine would take on, in order, and the rest are what it takes away, so all of them are drawn
// — the order is part of what applies and the wire carries it nowhere else. A run of kept rows
// collapses to a count IN ITS PLACE and expands there, so the document never reads out of order.
// The count under Apply is the store's. A change's `before` and `after` are routine entries — `sets`
// per set and `restSeconds` — so every reading here is `entryLabel`'s and `setReading`'s.

import { t } from './i18n/index.js';
import {
  agoLabel, entryLabel, numberWord, sameSet, setReading, shortDayLabel, timeLabel,
} from './log.js';
import { restLabel } from './settings/preferences.js';

// Every other state is settled and stays settled; the wire has no path back.
export function isPending(proposal) {
  return proposal?.state === 'pending';
}

// `superseded` is what a proposal becomes when the routine moves under it, and is not a dismissal.
const STATE_CHIPS = {
  pending: t('gym.proposals.statePending'),
  applied: t('gym.proposals.stateApplied'),
  dismissed: t('gym.proposals.stateDismissed'),
  superseded: t('gym.proposals.stateSuperseded'),
};

export function stateChip(proposal) {
  return STATE_CHIPS[proposal?.state] ?? null;
}

// `agent` is often omitted, the transport carrying no connection identity; the door is the one fact
// the store always holds.
export const UNNAMED_AGENT = t('gym.proposals.unnamedAgent');

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
  if (source?.door === 'ask') return t('gym.proposals.coach');
  return UNNAMED_AGENT;
}

// `source.thread` is the conversation the diff was written in, and is offered only where present.
export const CONVERSATION_VERB = t('gym.proposals.openConversation');

export function conversationOf(source) {
  return source?.thread ?? null;
}

export function changeLabel(count) {
  if (typeof count !== 'number') return t('gym.proposals.changes');
  return t('gym.proposals.changeCount', { count });
}

// The card's one affordance, the same word on every surface.
export const REVIEW_VERB = t('gym.proposals.review');

// The store's count and not the rows this screen drew: the store is what applies.
export function applyLabel(proposal) {
  if (proposal.intent === 'remove') return proposal.baseName ? t('gym.proposals.removeNamed', { name: proposal.baseName }) : t('gym.proposals.removeRoutine');
  if (proposal.changeCount === 1 || typeof proposal.changeCount !== 'number') return t('gym.proposals.apply');
  return t('gym.proposals.applyAll', { count: proposal.changeCount });
}

// Apply is atomic against a frozen base revision: all of it or none.
export function atomicLine(proposal) {
  if (proposal.intent === 'remove') {
    return t('gym.proposals.atomicRemove');
  }
  if (typeof proposal.changeCount !== 'number') return t('gym.proposals.atomicUncounted');
  return t('gym.proposals.atomicAll', { count: numberWord(proposal.changeCount) });
}

// The consequence is drawn from the intent, never from what the proposal says about itself.
export function intentLine(head, routineName) {
  if (head.intent !== 'remove') return null;
  return t('gym.proposals.intentRemove', { name: routineName });
}

// `summary` is always present on the wire and may be empty.
export function summaryLine(head, routineName) {
  const summary = (head.summary ?? '').trim();
  if (summary !== '') return summary;
  if (head.intent === 'remove') return t('gym.proposals.summaryRemove', { name: routineName });
  if (typeof head.changeCount !== 'number') return t('gym.proposals.summaryUncounted', { name: routineName });
  return t('gym.proposals.summaryCounted', { count: head.changeCount, name: routineName });
}

// How much a proposal is, in one phrase, for the Coach card and the routine's history row. A removal
// carries every base entry as a `removed` change, so the count is positive and would read
// `12 changes` for a proposal that DELETES the routine — which is why the intent is asked first,
// here and on both phones (`Proposal.counted`, `line(about:)`).
export function countedLabel(head) {
  if (head.intent === 'remove') return t('gym.proposals.aRemoval');
  return changeLabel(head.changeCount);
}

// A pending proposal is in the same list and borrows none of the settled verbs.
export function historyLabel(head) {
  if (isPending(head)) {
    return t('gym.proposals.historyPending', { day: shortDayLabel(head.createdAt), counted: countedLabel(head), source: sourceLabel(head.source) });
  }
  return t('gym.proposals.historySettled', {
    day: shortDayLabel(head.settledAt ?? head.createdAt), state: head.state, counted: countedLabel(head), source: sourceLabel(head.source),
  });
}

export function settledLine(proposal, now = Date.now()) {
  if (!['applied', 'dismissed', 'superseded'].includes(proposal.state)) return null;
  const ago = agoLabel(proposal.settledAt, now);
  const time = timeLabel(proposal.settledAt);
  if (proposal.state === 'applied') {
    return t('gym.proposals.settledApplied', { name: proposal.baseName ?? t('gym.proposals.theRoutine'), ago, time });
  }
  // A record and never a way back: the wire has no path that reopens one.
  if (proposal.state === 'dismissed') return t('gym.proposals.settledDismissed', { ago, time });
  return t('gym.proposals.settledSuperseded', { name: proposal.baseName ?? t('gym.proposals.theRoutineStart'), ago, time });
}

// Turning down settles for good; the confirmation guards an act the wire cannot undo.
export const TURN_DOWN_CONFIRM = {
  title: t('gym.proposals.turnDownTitle'),
  body: t('gym.proposals.turnDownBody'),
  confirm: t('gym.proposals.turnDownConfirm'),
  keep: t('gym.proposals.turnDownKeep'),
};

export const TURN_DOWN_VERB = t('gym.proposals.turnDown');

// A pending proposal the domain reads as out of date (`ProposalState.outOfDate`: its routine moved on the log, in an
// edit the log has not confirmed, or out of sight) has no Apply and no Turn this down; this line stands where they stood.
export const OUT_OF_DATE_LINE = t('gym.proposals.outOfDate');

// Closing the review decides nothing; the card keeps saying so.
export const STILL_WAITING = t('gym.proposals.stillWaiting');

// Above the diff and never in the band: a session's plan is frozen, so applying now changes nothing
// about the workout in progress, and a line inside the band would move Apply.
export const MID_WORKOUT_CAVEAT = t('gym.proposals.midWorkout');

// The writer's prose sits under this, apart from the counted rows; the two are different kinds of
// truth. Attributed by door: the room, a named agent, or an unnamed one — never Coach's name over
// an agent's words.
export function wroteKicker(source) {
  const named = agentNameOf(source);
  if (named) return t('gym.proposals.agentWrote', { name: named });
  if (source?.door === 'ask') return t('gym.proposals.coachWrote');
  return t('gym.proposals.yourAgentWrote');
}

export function keptRunLabel(count) {
  return t('gym.proposals.keptRun', { count });
}

// Compact cards show up to three changed rows; Review unfolds the full inline diff.
export const CARD_ROW_CAP = 3;

// Rename, order and kept rows belong to the full diff; counts remain the store's own changeCount.
export const CARD_ROW_KINDS = ['added', 'removed', 'retargeted'];

export function moreRowsLabel(count) {
  return t('gym.proposals.moreRows', { count });
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

// Settled receipts use the stored proposal state and server count, never the model's prose.
export function receiptLine({ verb, proposal }) {
  if (verb === 'dismiss') return t('gym.proposals.receiptDismissed');
  if (proposal?.intent === 'remove') return t('gym.proposals.receiptRemoved', { name: proposal.baseName || proposal.name || t('gym.proposals.routineFallback') });
  const name = proposal?.name ?? proposal?.baseName ?? t('gym.proposals.routineFallback');
  if (typeof proposal?.changeCount !== 'number') return t('gym.proposals.receiptApplied', { name });
  return t('gym.proposals.receiptAppliedCounted', { name, count: proposal.changeCount });
}

// An absent rest is the account's own target and not the settings screen's `off`.
function restReading(side) {
  if (side.restSeconds == null) return t('gym.proposals.yourRestTarget');
  return restLabel(side.restSeconds);
}

// The scheme moved: both readings in the scheme's formula, and the ladder behind them for the
// review to unfold. An open side has no rows.
function schemeMove(before, after) {
  return {
    field: 'sets',
    from: entryLabel(before),
    to: entryLabel(after),
    ladder: { from: (before.sets ?? []).map(setReading), to: (after.sets ?? []).map(setReading) },
  };
}

// Only what moved. A shape that held and one set that moved prints that set alone — a week's
// progression on a top set is one line; anything else that differs is the scheme moving.
function movesBetween(before = {}, after = {}) {
  const moves = [];
  const from = before.sets ?? null;
  const to = after.sets ?? null;
  if (from && to && from.length === to.length) {
    const moved = from.map((set, index) => (sameSet(set, to[index]) ? null : index)).filter((index) => index != null);
    if (moved.length === 1) {
      const [index] = moved;
      moves.push({ field: t('gym.proposals.fieldSet', { position: index + 1 }), from: setReading(from[index]), to: setReading(to[index]) });
    } else if (moved.length > 1) {
      moves.push(schemeMove(before, after));
    }
  } else if (from != null || to != null) {
    moves.push(schemeMove(before, after));
  }
  const rest = [restReading(before), restReading(after)];
  if (rest[0] !== rest[1]) moves.push({ field: t('gym.proposals.fieldRest'), from: rest[0], to: rest[1] });
  return moves;
}

// A zero is a real answer and gets its own words; an absent count draws no sentence at all.
export function logKeptLabel(loggedSets) {
  if (typeof loggedSets !== 'number') return null;
  return t('gym.proposals.logKept', { count: loggedSets });
}

// The rows are the whole routine and not a filtered changelog — the one line that asserts it, and
// the only one, since a proposal that retargets every line folds no kept run to say it. The dialog
// title already names the routine and every kept row already prints its numbers, so neither is
// repeated here. A removal has no document left to read and draws no such line.
export function documentLine(proposal) {
  if (proposal.intent === 'remove') return null;
  return t('gym.proposals.documentLine');
}

// Every line of the document, in its order. A `kept` row is drawn unmarked; a rename is a row of its
// own, the store counting it in `changeCount`. A kept line that moved is a counted change no marked row
// carries, and the client never sees the base — so whatever the count holds beyond the marked rows is
// the order moving.
export function diffRows(proposal) {
  const rows = [];
  // A removal carries a blank name, which the store counts as a rename: no row, but it is marked.
  const renamed = typeof proposal.name === 'string' && typeof proposal.baseName === 'string' && proposal.name !== proposal.baseName;
  if (renamed && proposal.intent !== 'remove') {
    rows.push({ kind: 'renamed', from: proposal.baseName, to: proposal.name });
  }
  const changes = proposal.changes ?? [];
  const marked = (renamed ? 1 : 0) + changes.filter((change) => change.kind !== 'kept').length;
  if (typeof proposal.changeCount === 'number' && proposal.changeCount > marked) {
    rows.push({ kind: 'reordered' });
  }
  changes.forEach((change, index) => {
    if (change.kind === 'kept') {
      rows.push({ kind: 'kept', exerciseId: change.exerciseId, targets: entryLabel(change.after) });
      return;
    }
    if (change.kind === 'added') {
      rows.push({
        kind: 'added',
        exerciseId: change.exerciseId,
        targets: entryLabel(change.after),
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
