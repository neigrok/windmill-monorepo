// A PROPOSAL, READ — the pure rules behind §D14's diff and the card that carries it, with no React
// and no fetch in them. The one thing this module exists to keep true: **an agent never changes a
// routine.** It hands over a typed diff and the diff waits, so everything here is a reading of
// something that has not happened yet — which is why nothing in this file writes, decides or
// derives a target. The store composed the change rows; this turns them into the four sentences a
// lifter reads before their thumb goes anywhere near Apply.
//
// The change rows ARE the document as well as the diff (backend §2.9): rows up to the first
// `removed` are the run the routine would take on, in order, and the rest are what it takes away.
// So ALL of them are drawn — the changed lines marked, the untouched ones dim and unmarked —
// because THE ORDER IS PART OF WHAT APPLIES and the wire carries it nowhere else. An agent that
// moves a movement up the routine carries that move only in the position of an unmarked row: a
// screen drawing the marked rows alone let a lifter read one weight change, tap Apply, and open
// Monday to a run in an order nobody ever showed them. The count under Apply stays the STORE's and
// counts the marks — a client counting its own rows would be the second copy of that rule.
//
// EVERY TARGET IS SPELLED BY log.js. A proposal names its fields the way the frozen plan snapshot
// does (`sets` · `reps` · `weightKg` · `restSeconds`) while a routine entry names them `target…`, so
// this is the second place those two vocabularies meet — `planReadingOf` is the first — and both
// hand the reading to `entryLabel`. A diff that spelled a weight its own way would be the product
// disagreeing with itself about one number on two screens.

import {
  agoLabel, entryLabel, fmt, numberWord, OPEN_TARGET, shortDayLabel, targetLoadOf, timeLabel,
} from './log.js';
import { restLabel } from './settings/preferences.js';

// A proposal nobody has decided yet. Every other state is settled and stays settled — the wire has
// no path back, and neither does this file.
export function isPending(proposal) {
  return proposal?.state === 'pending';
}

// The chip in the header (§D14). Four states and not the design's three: `superseded` is what a
// proposal becomes when the routine moves under it, and drawing it as "Dismissed" would say a lifter
// turned something down that they never saw.
const STATE_CHIPS = {
  pending: 'Pending',
  applied: 'Applied',
  dismissed: 'Dismissed',
  superseded: 'Superseded',
};

export function stateChip(proposal) {
  return STATE_CHIPS[proposal?.state] ?? null;
}

// WHO WROTE IT, and never a blank where a name should be. The transport carries no connection
// identity today, so `agent` arrives OMITTED far more often than not (backend REQUEST 2) — and the
// whole point of `source` being a column is that "I cannot tell whether that was my Claude or
// Windmill's coach" never happens. So an unnamed agent is named as much as is true: which DOOR it
// came through, which is the one fact the store always holds.
export const UNNAMED_AGENT = 'your connected agent';

export function sourceLabel(source) {
  if (source?.agent) return source.agent;
  if (source?.door === 'ask') return 'Ask';
  return UNNAMED_AGENT;
}

// AND WHERE IT WAS ASKED FOR (§O). A diff Ask wrote was written inside a conversation, and the id of
// that conversation rides on the same `source` the door does — so the trail runs both ways: the
// routine's history says a change came from Ask, and the thread says which changes.
//
// IT IS OFFERED ONLY WHERE THE KEY IS PRESENT, and an absent one is not a fault to explain. Two ways
// it happens and both are ordinary: the diff came through the MCP door, where there is no
// conversation at all; or the lifter deleted the thread, which deletes the conversation and never
// its consequence — the change stays in the program's history and simply stops opening a message
// that is gone. The row still says `door: 'ask'` in both.
export const CONVERSATION_VERB = 'Open the conversation';

export function conversationOf(source) {
  return source?.thread ?? null;
}

export function changeLabel(count) {
  return count === 1 ? '1 change' : `${count} changes`;
}

// The card's one verb (canon screen 4: `Review 4 changes`). A removal is counted on the wire like
// anything else, but "Review 1 change" is a small phrase for a routine disappearing — so that card
// says what the proposal is instead of how big it is.
export function reviewLabel(head) {
  if (head.intent === 'remove') return 'Read the proposal';
  return `Review ${changeLabel(head.changeCount)}`;
}

// WHAT THE BUTTON SAYS, and it says the STORE's count rather than the rows this screen managed to
// draw. The store is what applies, and a button that counted the drawn rows would promise a number
// the apply does not honour the first time the two disagree.
export function applyLabel(proposal) {
  if (proposal.intent === 'remove') return `Remove ${proposal.baseName}`;
  return `Apply all ${proposal.changeCount}`;
}

// ALL OF IT OR NONE, said under the button in the design's own words. It is not decoration: apply is
// atomic against a frozen base revision, so there is no half of this a lifter could end up with, and
// the second sentence is the one this whole wave exists to make true.
export function atomicLine(proposal) {
  if (proposal.intent === 'remove') {
    return 'The routine goes and your logged sets stay. Nothing is applied until you tap.';
  }
  return `All ${numberWord(proposal.changeCount)} or none. Nothing is applied until you tap.`;
}

// WHAT A REMOVAL IS, said on the card whatever the agent wrote in its summary. The summary is the
// agent's prose and a gentle one over a removal is exactly the sentence a lifter would skim — so the
// consequence is drawn by us, from the intent, and never from what the proposal says about itself.
export function intentLine(head, routineName) {
  if (head.intent !== 'remove') return null;
  return `Removes ${routineName} from your routines.`;
}

// The card's line. `summary` is always present on the wire and may be empty, and an empty one is not
// a card with nothing to say: the count and the routine are the fact underneath the prose.
export function summaryLine(head, routineName) {
  const summary = (head.summary ?? '').trim();
  if (summary !== '') return summary;
  if (head.intent === 'remove') return `A proposal to remove ${routineName}.`;
  return `${changeLabel(head.changeCount)} to ${routineName}.`;
}

// A ROW OF THE ROUTINE'S HISTORY (canon screen 6: `2 Aug · applied 3 changes from <agent>`). A
// settled proposal is a dated record on the routine rather than a toast that disappeared, and a
// pending one is in the same list because that is where a lifter goes looking for it — it says it is
// still waiting instead of borrowing a verb it has not earned.
const STATE_VERBS = {
  applied: 'applied',
  dismissed: 'dismissed',
  superseded: 'superseded',
};

export function historyLabel(head) {
  const what = head.intent === 'remove' ? 'a removal' : changeLabel(head.changeCount);
  const from = `${what} from ${sourceLabel(head.source)}`;
  if (isPending(head)) return `${shortDayLabel(head.createdAt)} · ${from} · waiting for you`;
  return `${shortDayLabel(head.settledAt ?? head.createdAt)} · ${STATE_VERBS[head.state]} ${from}`;
}

// WHAT A SETTLED PROPOSAL SAYS ABOUT ITSELF, with the instant it was settled at (§D14). All three
// end the same way on purpose: the record stays. Superseded is the one the design never drew and it
// is the one most worth wording carefully — nothing was applied and nobody turned it down, the
// routine simply moved first, and a lifter who is not told that will read the chip as a refusal
// somebody made on their behalf.
export function settledLine(proposal, now = Date.now()) {
  const when = `${agoLabel(proposal.settledAt, now)} at ${timeLabel(proposal.settledAt)}`;
  if (proposal.state === 'applied') {
    return `Applied to ${proposal.baseName} ${when}. Kept on the routine as a dated record — the program’s history, not a toast that disappears.`;
  }
  if (proposal.state === 'dismissed') {
    return `Dismissed ${when}. No reason asked for, nothing changed, and it stays in the routine’s history in case you want it back.`;
  }
  if (proposal.state === 'superseded') {
    return `${proposal.baseName} changed ${when}, after this was written. Nothing from it was applied, and it stays in the routine’s history.`;
  }
  return null;
}

// The two readings a routine entry has on this screen, in the plan snapshot's vocabulary. `sets` is
// the pair — canon draws `sets 5 × 5 → 5 × 3`, which is the sets and the reps moving together — and
// an absent rep target is `max`, the same movement-to-whatever-it-gives every other surface spells.
//
// AN ABSENT `sets` IS THE OPEN LINE and never a missing side. Which side is missing is the row's
// `kind` and nothing else — `added` carries no before, `removed` carries no after (gymApi.js) — so
// a diff that read an absent sets as an absent side would draw `+ Deadlift` with nothing added.
function setsReading(side) {
  if (side.sets == null) return OPEN_TARGET;
  return `${side.sets} × ${side.reps ?? 'max'}`;
}

// Zero is not a load, it is the absence of one (`targetLoadOf`), and an absent load is the wire's
// "whatever you did last time" — so neither prints a number, and neither may print the other's word.
function weightReading(side) {
  const target = targetLoadOf(side.weightKg);
  if (target == null) return 'last time';
  return fmt(target);
}

// An absent rest is the account's own target (§I), not the settings screen's `off` — the routine is
// saying nothing about rest rather than switching a clock off, and `restLabel` spells only the
// number.
function restReading(side) {
  if (side.restSeconds == null) return 'your rest target';
  return restLabel(side.restSeconds);
}

// Only what MOVED. A field-level diff that listed every field would make the lifter find the change
// themselves, which is the whole job this screen has.
function movesBetween(before = {}, after = {}) {
  const moves = [];
  for (const [field, reading] of [['sets', setsReading], ['weight', weightReading], ['rest', restReading]]) {
    const from = reading(before);
    const to = reading(after);
    if (from !== to) moves.push({ field, from, to });
  }
  return moves;
}

// What a removed line takes with it — and it takes nothing a lifter lifted. The sets stay in the log
// forever; the routine simply stops asking for them. A zero is a real answer and gets its own words
// rather than "0 logged sets kept", and an absent count draws NO sentence at all: a proposal that
// did not carry the number must not be given one.
export function logKeptLabel(loggedSets) {
  if (typeof loggedSets !== 'number') return null;
  if (loggedSets === 0) return 'nothing logged against it yet';
  if (loggedSets === 1) return '1 logged set kept';
  return `${loggedSets} logged sets kept`;
}

// One routine line, read the way every other screen reads it. The line a proposal ADDS and the line
// it leaves alone are the same object read the same way — two readings would disagree the first day
// either grew a field.
function targetsReading(side) {
  return entryLabel({
    targetSets: side.sets,
    targetReps: side.reps,
    targetWeightKg: side.weightKg,
  });
}

// WHAT THE ROWS ARE, said above them, because an unmarked row has to be legible as an unmarked row.
// A removal has no document left to read — every line of it goes — so it draws no such line and the
// atomic sentence under the button says the whole of it.
export function documentLine(proposal) {
  if (proposal.intent === 'remove') return null;
  return `${proposal.baseName} as it would read, top to bottom. The marked lines change; the rest keep their numbers.`;
}

// THE ROWS THE DIFF DRAWS, in the order the document holds them — every line of it, because the
// order is a change this wire can express in no other way (see the head of this file). A `kept` row
// is drawn unmarked and reads only its own numbers; the name is a row of its own when it moved,
// because the store COUNTS a rename in `changeCount`: without that row the button would offer to
// apply four changes over three visible ones, and the missing one would be the routine's name.
export function diffRows(proposal) {
  const rows = [];
  if (typeof proposal.name === 'string' && proposal.name !== proposal.baseName) {
    rows.push({ kind: 'renamed', from: proposal.baseName, to: proposal.name });
  }
  const changes = proposal.changes ?? [];
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
        // A rest this line SETS, because rest is a field this diff already treats as worth moving
        // (`movesBetween` draws it on a line that already stood) and an added line is the one place
        // it could otherwise arrive unread. An absent one sets nothing — the line takes the
        // account's own target — so it draws no words at all.
        rest: change.after.restSeconds == null ? null : restLabel(change.after.restSeconds),
        // Where it lands, named by the movement above it — the run is in order, and removals sort
        // last, so the row before an added one is always part of the routine it is joining.
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
