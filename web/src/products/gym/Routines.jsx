// ROUTINES — the list of them (canon screen 5) and one of them under the hand (screens 6, 28–30).
// Most lifters get their first routine out of a session they finished, so this room was written for
// the second month rather than the first day; §M adds the door it was missing, which is the one a
// lifter with a program on paper reaches for first — name it, add the movements, type the numbers.
//
// THE DESK IS WHERE THAT HAPPENS. The board draws a phone and puts the targets in a sheet over the
// list; here the same sheet stands over the same list on a wider screen, because the facts, the
// states and the words are the contract and the layout is not. Three of screen 30's controls are not
// here and each is missing for its own reason: `Start` belongs to the phone (§11), `Edit` has nothing
// to open because on this surface the routine's room IS its editor, and `Rename` is the header's own
// name field — the whole-document Save is the write that moves it, and a second door onto that write
// is a second place the rule can drift. Every FACT screen 30 states is drawn.
//
// ONE DRAFT, ONE COMMIT. Every change lands in a copy and nothing reaches the store until Save, so a
// routine is never left half-rewritten by a lifter who walked away mid-edit — half a program is what
// somebody trains against tomorrow. The two ways out say which they are: Save writes, and the back
// arrow leaves the routine as it was. Sessions start on the phone (§11), so nothing here runs one —
// the routine saved here is the plan the phone's Start freezes onto the session.
//
// The order is the store's, not this screen's: `GET /v1/gym/routines` answers most-recently-trained
// first, which is what canon screen 5 sorts by, so the list draws what it is handed.

import React, { useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { failureReason, gymApi } from './gymApi.js';
import {
  alsoReadsLabel, EMPTY_BAR_KG, entryLabel, fmtKg, isUntested, movementOf, NAME_MAX,
  nameCountLabel, nameOfMovement, NEW_ROUTINE_ID, recordHref, routineHref, routineMetaLabel,
  ROUTINES_HREF, threadHref, UNTESTED,
} from './log.js';
import { CONVERSATION_VERB } from './proposals.js';
import { mintId } from './mint.js';
import { ConnectInvitation } from './connect/ConnectLog.jsx';
import { ProposalDot, ProposalFlag } from './Proposals.jsx';
import { Keypad } from './logger/Keypad.jsx';
import { MovementPicker } from './logger/MovementPicker.jsx';
import { LADDER_KEYS, ladderLabels, bump } from './logger/ladder.js';
import {
  blankRoutine, builtLabel, draftFrom, duplicateRoutine, entryPlaceLabel, historyRows,
  NAME_SUGGESTIONS, NEW_ENTRY_REPS, openTargetsLine, reorderEntries, routineWrite, saysNeverLogged,
  targetDraftOf, withEntryAdded, withEntryChanged, withEntryOpened, withEntryRemoved, withTarget,
} from './routines.js';
import { useGymRead } from './useGymRead.js';

export function RoutinesList({ log }) {
  const view = useGymRead(() => gymApi.routines(), []);
  const [copying, setCopying] = useState(false);

  const duplicate = async (routine) => {
    if (copying) return;
    setCopying(true);
    try {
      // The copy goes to the end of the list: it has never been trained, so nothing about it has
      // earned a place above a routine that has.
      await gymApi.createRoutine(duplicateRoutine(routine, { id: mintId('rt_'), position: view.data.length }));
      view.retry();
    } catch (error) {
      log.say(`That copy wasn’t made — ${failureReason(error)}.`);
    }
    setCopying(false);
  };

  return (
    <>
      <header className="gym-head gym-log-head">
        <h1 className="gym-title">Routines</h1>
        <a className="gym-door-past" href={routineHref(NEW_ROUTINE_ID)}>New</a>
      </header>
      {view.phase === 'loading' && <p className="gym-quiet">Opening your routines…</p>}
      {view.phase === 'failed' && (
        <p className="gym-read-failed">
          The routines didn’t load.
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      )}
      {view.phase === 'ready' && view.data.length === 0 && (
        <>
          <p className="gym-quiet">No routines yet.</p>
          <p className="gym-quiet">Finish a session and gym offers to keep it as one — or write one out now.</p>
          {/* NO EMPTY SCREEN WITHOUT A CALL TO ACTION (§A screen 1). The prose above says where
              routines come from; this is the door to writing one out now — the same door the
              header's New opens, drawn where the deciding is done. Screen 1's second path, Just
              start logging, is the phone's: sessions do not start on this surface (§11). */}
          <a className="gym-routines-build" href={routineHref(NEW_ROUTINE_ID)}>Build a routine</a>
        </>
      )}
      {view.phase === 'ready' && view.data.length > 0 && (
        <ul className="gym-routines">
          {view.data.map((routine) => (
            <li className="gym-routine" key={routine.id}>
              <a className="gym-routine-open" href={routineHref(routine.id)}>
                {/* The dot rides the read this list already makes: a routine carries its own
                    pending proposal (gymApi.js), so the card on Today and this row are the same
                    fact drawn twice rather than two questions asked of the store. */}
                <span className="gym-routine-line">
                  <span className="gym-routine-name">{routine.name}</span>
                  {routine.pendingProposal && <ProposalFlag />}
                </span>
                <span className="gym-routine-meta">{routineMetaLabel(routine)}</span>
              </a>
              <button
                type="button"
                className="gym-routine-copy"
                onClick={() => duplicate(routine)}
                aria-label={`Duplicate ${routine.name}`}
              >
                ⧉
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* THE INVITATION (§D12), under the program rather than over it. This is the screen where the
          question it answers is live — the next block is written here — and it is an invitation and
          not a gate: no lock, no chip, no price, and nothing behind it to buy. It draws itself only
          for a lifter with nothing connected and no workout running; both conditions live inside it,
          so its second host cannot forget either. */}
      <ConnectInvitation training={log.session != null} />
    </>
  );
}

export function RoutineEditor({ id, log }) {
  // A routine being written for the first time is minted once, here, and not again on every render:
  // the id is the idempotency key, so a create that times out and is sent again must be the same
  // document arriving twice rather than two routines with one name.
  const minted = useRef(null);
  if (minted.current === null) minted.current = mintId('rt_');
  const fresh = id === NEW_ROUTINE_ID;

  const view = useGymRead(
    () => (fresh ? Promise.resolve(blankRoutine({ id: minted.current })) : gymApi.routine(id)),
    [id],
  );
  // The draft IS the routine until a hand changes something, so there is no moment where the screen
  // holds a copy that has not been filled in yet — no effect to copy it across, and no frame drawn
  // over an empty one. It is scoped to ONE document: the caller keys this component on the routine
  // id, so a hash that moves to another routine drops the instance rather than carrying the draft
  // across (GymApp.jsx). Nothing in here syncs a prop into state, and nothing here has to.
  const [edits, setEdits] = useState(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  // NAME FIRST, AND ONLY ON THE WAY IN (§M screen 28). A routine you built on purpose deserves the
  // word you already call it, so the question is asked once, before there is a list to be distracted
  // by — and never again: the header's field is the same name and the way back to it.
  const [naming, setNaming] = useState(fresh);
  const draft = edits ?? (view.phase === 'ready' ? draftFrom(view.data) : null);

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the routine…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <a className="gym-back" href={ROUTINES_HREF}><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Routines</a>
        <p className="gym-quiet">This routine isn’t in your program.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <a className="gym-back" href={ROUTINES_HREF}><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Routines</a>
        <p className="gym-read-failed">
          The routine didn’t load.
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      </>
    );
  }

  if (naming) {
    return (
      <NameTheRoutine
        name={draft.name}
        onName={(name) => setEdits({ ...draft, name })}
        onNext={() => setNaming(false)}
      />
    );
  }

  const editEntries = (change) => setEdits({ ...draft, entries: change(draft.entries) });
  // The store refuses a routine with no entries and one with no name, and both are things this
  // screen can see. So it says which is missing instead of sending a document it knows comes back.
  const missing = draft.name.trim() === '' ? 'Name it to save it.' : (draft.entries.length === 0 ? 'A routine is at least one movement.' : null);
  // A LINE THAT ASKS FOR NOTHING IS A FACT ABOUT THE DAY, not a fault in the document: the routine
  // saves exactly as it stands and the row asks at the rack. Read off the draft, so opening a row
  // changes the sentence in the same breath.
  const openTargets = openTargetsLine(draft.entries, log.catalog);
  // The two facts screen 30 puts under the name, and both are the STORE's rather than the draft's: a
  // routine is untested until the log holds a session run under it, and it was built on the day it
  // was written with the count it was written with. A routine that has not been saved yet has
  // neither, and is asked for neither.
  const built = builtLabel(view.data);

  const commit = async () => {
    if (missing || saving) return false;
    setSaving(true);
    // The save names the revision it read, so a day that moved under this editor — a proposal
    // applied on the phone, another tab's save — is refused rather than overwritten whole. The
    // repair is a re-read: the draft is dropped and the routine drawn as it now stands, and the
    // toast says the edits were not saved — landing them over the moved day is exactly what the
    // refusal exists to prevent, and a second Save would do it.
    const write = routineWrite({ ...draft, name: draft.name.trim() }, fresh ? null : view.data.revision);
    try {
      if (fresh) await gymApi.createRoutine(write);
      else await gymApi.replaceRoutine(draft.id, write);
      setSaving(false);
      return true;
    } catch (error) {
      setSaving(false);
      if (error?.code === 'routine-stale') {
        log.say('That routine changed since you opened it — here is what it says now. Your edits were not saved.');
        setEdits(null);
        view.retry();
        return false;
      }
      log.say(`That routine wasn’t saved — ${failureReason(error)}.`);
      return false;
    }
  };

  return (
    <>
      <header className="gym-editor-head">
        <a className="gym-back" href={ROUTINES_HREF}><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Routines</a>
        <input
          className="gym-editor-name"
          value={draft.name}
          maxLength={NAME_MAX}
          placeholder="Name this routine"
          aria-label="Routine name"
          onChange={(event) => setEdits({ ...draft, name: event.target.value })}
        />
        <button
          type="button"
          className={missing || saving ? 'gym-editor-save is-inert' : 'gym-editor-save'}
          onClick={async () => { if (await commit()) window.location.hash = ROUTINES_HREF; }}
        >
          Save
        </button>
      </header>
      {missing && <p className="gym-editor-missing">{missing}</p>}

      {/* WHAT THE ROUTINE IS, before what it holds (§M screen 30). `untested` is not a warning: it
          says the first session is allowed to disagree with this, which is the point of writing one
          out before you have trained it. Neither half is drawn for a routine nobody has saved. */}
      {!fresh && (isUntested(view.data) || built) && (
        <p className="gym-editor-meta">
          {isUntested(view.data) && <span className="gym-editor-untested">{UNTESTED}</span>}
          {built && <span>{built}</span>}
        </p>
      )}

      <EntryList
        entries={draft.entries}
        catalog={log.catalog}
        onMove={(from, to) => editEntries((held) => reorderEntries(held, from, to))}
        onTarget={(index) => setTarget(index)}
        onRemove={(index) => editEntries((held) => withEntryRemoved(held, index))}
      />

      {openTargets && <p className="gym-editor-open">{openTargets}</p>}

      <button type="button" className="gym-editor-add" onClick={() => { setQuery(''); setPicking(true); }}>
        + Add movement
      </button>

      {/* THE ROUTINE'S HISTORY (screens 6 and 30) — and every row of it is a DOOR rather than a
          decision. Apply lives on the diff and nowhere else, which matters most exactly here: this
          screen holds a draft, and an Apply drawn beside it would let a routine move under an edit
          in progress, whose Save would then whole-document PUT the applied change straight back out.
          It is drawn off the routine's own read: the day it was created and every proposal ever
          written against it arrive together, so the section costs this screen no second request and
          a routine nobody has saved has nothing to draw. */}
      <RoutineHistory routine={view.data} />

      {/* DUPLICATE COPIES THE ROUTINE AS THE STORE HOLDS IT, never the draft on screen: the hash
          moves to the copy the moment it lands, and a copy of unsaved edits would carry them off
          this editor and leave the original without them — a lifter reading "X copy" beside "X"
          would find the two disagree in exactly the lines they had just typed. So the copy is of
          `view.data`, which also means it can never be a document the store would refuse. A routine
          that has not been saved yet has no stored document to copy, and offers no button. */}
      {!fresh && (
        <div className="gym-editor-foot">
          <button
            type="button"
            className="gym-editor-duplicate"
            onClick={async () => {
              try {
                const copy = duplicateRoutine(view.data, { id: mintId('rt_') });
                await gymApi.createRoutine(copy);
                window.location.hash = routineHref(copy.id);
              } catch (error) {
                log.say(`That copy wasn’t made — ${failureReason(error)}.`);
              }
            }}
          >
            Duplicate
          </button>
        </div>
      )}

      {target != null && (
        <TargetSheet
          // KEYED ON THE LINE IT IS OF, the same rule the editor and the diff are keyed by: this
          // sheet holds a draft of ONE entry, and a sheet reopened on another row with the instance
          // kept would carry the first row's numbers onto the second one's Set.
          key={target}
          movement={nameOfMovement(log.catalog, draft.entries[target].exerciseId)}
          place={entryPlaceLabel(target, draft.entries.length, draft.name)}
          entry={draft.entries[target]}
          // NO HISTORY BEHIND IT, SO THE SHEET SAYS SO (§M). A routine written at the desk has never
          // been trained, and there is nothing to prefill from — this surface reaches for no last
          // time here, and the line is what stops a number nobody lifted from looking like one they
          // did. The routine half of it is the store's answer, never this screen's guess; the row
          // half is the draft's, so a line that already carries a target is not told it has none
          // (routines.js).
          neverLogged={saysNeverLogged(view.data, draft.entries[target])}
          onSet={(entry) => {
            editEntries((held) => withEntryChanged(held, target, entry));
            setTarget(null);
          }}
          onOpen={() => {
            editEntries((held) => withEntryOpened(held, target));
            setTarget(null);
          }}
          onClose={() => setTarget(null)}
        />
      )}

      {picking && (
        <MovementPicker
          catalog={log.catalog}
          query={query}
          onQuery={setQuery}
          onPick={(exerciseId) => { setPicking(false); editEntries((held) => withEntryAdded(held, exerciseId)); }}
          onCreate={log.createMovement}
          onClose={() => setPicking(false)}
          title="Add movement"
        />
      )}
    </>
  );
}

// SCREEN 28 — the name, asked as a real question and asked once. The keyboard is up and the field
// is empty: a routine you sat down to write deserves the word you already call it, and `Workout 3`
// is what a program gets called when nobody asked.
//
// The three openers are SUGGESTIONS AND NEVER RULES — one tap fills the field and typing over it is
// the expected case — so they are drawn as a way past a blank field rather than as a set to choose
// from. Nothing is created here: `Next` carries the name into the editor, and the routine exists
// when Save writes it.
function NameTheRoutine({ name, onName, onNext }) {
  const ready = name.trim() !== '';
  return (
    <>
      <a className="gym-back" href={ROUTINES_HREF}><ArrowLeft size={16} strokeWidth={1.9} aria-hidden="true" /> Routines</a>
      <h1 className="gym-title">What do you call this one?</h1>
      <p className="gym-name-sub">Whatever you already call it.</p>

      <div className="gym-name-field">
        <input
          className="gym-name-input"
          value={name}
          maxLength={NAME_MAX}
          aria-label="Routine name"
          onChange={(event) => onName(event.target.value)}
          autoFocus
        />
        <span className="gym-name-count">{nameCountLabel(name)}</span>
      </div>

      <div className="gym-name-openers">
        {NAME_SUGGESTIONS.map((suggestion) => (
          <button key={suggestion} type="button" className="gym-name-opener" onClick={() => onName(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={ready ? 'gym-name-save' : 'gym-name-save is-inert'}
        onClick={() => { if (ready) onNext(); }}
      >
        Next · add movements
      </button>
    </>
  );
}

// THE ROUTINE'S HISTORY (screens 6 and 30) — the day it was written, and every proposal ever written
// against it: applied, dismissed, superseded or still waiting. An agent's suggestion is part of the
// program's history, and so is whose hand the day came from; the ledger supersedes rather than
// deletes, so a diff that was turned down is still here in case it was turned down too fast.
//
// A routine with no history draws no section at all — an empty "History" heading over nothing is a
// room telling a lifter about a feature rather than about their program — and that is every routine
// this screen has not saved yet.
function RoutineHistory({ routine }) {
  const rows = historyRows(routine);
  if (rows.length === 0) return null;
  return (
    <section className="gym-history">
      <h2 className="gym-history-head">History</h2>
      <ul className="gym-history-rows">
        {rows.map((row) => (
          <li key={row.key}>
            {/* A proposal row is a door onto the diff; the row that says the day was created is not
                a door, because there is nothing behind it to read. */}
            {row.href ? (
              <>
                <a className="gym-history-row" href={row.href}>
                  {row.pending && <ProposalDot />}
                  <span className="gym-history-line">{row.line}</span>
                  <span className="gym-history-go" aria-hidden="true">›</span>
                </a>
                {/* AND THE CONVERSATION IT CAME OUT OF (§O), where there is one — a SIBLING door and
                    not a link inside the row's, because one anchor may not sit inside another. It is
                    absent for a diff written over MCP and for one whose thread was deleted, which is
                    the delete rule from this side: the change is still here and still says it came
                    from Ask, and there is simply nothing left to open. */}
                {row.thread && (
                  <a className="gym-history-thread" href={threadHref(row.thread)}>{CONVERSATION_VERB} ›</a>
                )}
              </>
            ) : (
              <p className="gym-history-row is-flat"><span className="gym-history-line">{row.line}</span></p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// SCREEN 29 — what one line asks for: two counts under a thumb, the weight on the ladder the rack
// uses and the keypad every other number on this surface is typed on. BOTH targets have one value no
// stepper and no keypad can reach — none at all — and neither is a zero somebody has to guess at: an
// absent load is the wire's "whatever you did last time", an absent rep target is canon screen 6's
// `3 × max`, and each gets the same way back, one word under the row it belongs to.
//
// AND THE WHOLE LINE HAS ONE TOO. `Leave it open` clears every target on the row at once, because a
// line asking for five reps of nothing is not a line — the row keeps its place in the day and asks
// at the rack.
//
// IT HOLDS ITS OWN DRAFT AND COMMITS ON `Set`, which is the shape the correction sheet already has
// (FixSheet.jsx): a sheet carrying a button that names what the row will become has to mean it, and
// an open row has to be able to be opened at numbers without the row silently taking them.
function TargetSheet({ movement, place, entry, neverLogged, onSet, onOpen, onClose }) {
  const [draft, setDraft] = useState(() => targetDraftOf(entry));
  const [typing, setTyping] = useState(false);
  const reps = draft.targetReps;
  // THE SAME LADDER AS THE RACK, and it is the one that exists (logger/ladder.js): at 140 kg the row
  // reads −10 · −2.5 · +2.5 · +10 because the golden says so and not because this screen agrees. A
  // second stepper written here would be the third copy Lift had and let drift.
  const rungs = ladderLabels(draft.targetWeightKg ?? EMPTY_BAR_KG);
  const alsoReads = alsoReadsLabel(draft.targetWeightKg);
  return (
    <>
      <div className="gym-sheet-catch" role="presentation" onClick={onClose}>
        <div className="gym-sheet" role="dialog" aria-label={`Target · ${movement}`} onClick={(event) => event.stopPropagation()}>
          <div className="gym-sheet-head">
            <span className="gym-target-movement">{movement}</span>
            <span className="gym-target-place">{place}</span>
            <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">×</button>
          </div>
          {/* The one sentence this sheet owes a lifter, and it is about their training rather than
              about this screen: there is nothing behind an open row on a routine nobody has trained,
              so nothing here is a prefill and the numbers are theirs.
              IT MAY SAY `Never logged` WHERE THE PICKER'S ROW MAY NOT (logger/movements.js), because
              the subject is different: that row is about a MOVEMENT, judged off a read that excludes
              the open workout and warmups, and this is about a ROUTINE nobody has trained with a
              line nobody has filled in — both halves, decided in routines.js. */}
          {neverLogged && <p className="gym-target-never">Never logged — these are your numbers.</p>}
          <div className="gym-target-row">
            <span className="gym-target-label">Sets</span>
            <button type="button" className="gym-target-step" onClick={() => setDraft((held) => withTarget(held, { targetSets: held.targetSets - 1 }))} aria-label="One set fewer">−</button>
            <span className="gym-target-value">{draft.targetSets}</span>
            <button type="button" className="gym-target-step" onClick={() => setDraft((held) => withTarget(held, { targetSets: held.targetSets + 1 }))} aria-label="One set more">+</button>
          </div>
          {/* From `max`, either stepper lands on the opening value rather than one either side of
              it: the first tap is choosing to have a target at all, not moving one. */}
          <div className="gym-target-row">
            <span className="gym-target-label">Reps</span>
            <button type="button" className="gym-target-step" onClick={() => setDraft((held) => withTarget(held, { targetReps: reps == null ? NEW_ENTRY_REPS : reps - 1 }))} aria-label="One rep fewer">−</button>
            <span className="gym-target-value">{reps ?? 'max'}</span>
            <button type="button" className="gym-target-step" onClick={() => setDraft((held) => withTarget(held, { targetReps: reps == null ? NEW_ENTRY_REPS : reps + 1 }))} aria-label="One rep more">+</button>
            {reps != null && (
              <button type="button" className="gym-target-clear" onClick={() => setDraft((held) => withTarget(held, { targetReps: null }))}>
                take it to max
              </button>
            )}
          </div>
          <div className="gym-target-row">
            <span className="gym-target-label">Target weight</span>
            <button type="button" className="gym-target-weight" onClick={() => setTyping(true)}>
              {draft.targetWeightKg == null ? 'last time' : `${fmtKg(draft.targetWeightKg)} kg`}
            </button>
            {draft.targetWeightKg != null && (
              <button type="button" className="gym-target-clear" onClick={() => setDraft((held) => withTarget(held, { targetWeightKg: null }))}>
                use last time
              </button>
            )}
          </div>
          <div className="gym-rungs">
            {LADDER_KEYS.map((rung, index) => (
              <button
                key={`${rung.direction}${rung.big}`}
                type="button"
                className={rung.weight === 'inner' ? 'gym-rung is-loud' : 'gym-rung'}
                // From `last time`, either rung lands on the empty bar rather than one step either
                // side of it — the rep stepper's rule, for the rep stepper's reason.
                onClick={() => setDraft((held) => withTarget(held, {
                  targetWeightKg: held.targetWeightKg == null
                    ? EMPTY_BAR_KG
                    : bump(held.targetWeightKg, rung.direction, rung.big),
                }))}
              >
                {rungs[index]}
              </button>
            ))}
          </div>
          {/* THE SAME TARGET, THE WAY THE ROWS UNDER THIS SHEET READ IT. The button above is a
              kilogram FIELD — the keypad it opens types kilograms and they land in the routine as
              they stand — while the entry row behind it prints the account's own reading. In pounds
              that is `100 kg` over `3 × 5 · 220.5`, one target and two numerals, and this is the
              line that says so. Null in kilograms, where they are the same number. */}
          {alsoReads && <p className="gym-target-reads">{alsoReads}</p>}

          <button type="button" className="gym-target-set" onClick={() => onSet(draft)}>
            {`Set · ${entryLabel(draft)}`}
          </button>
          <button type="button" className="gym-target-open" onClick={onOpen}>
            Leave it open
            <span className="gym-target-open-why">decide at the rack</span>
          </button>
        </div>
      </div>
      {/* Beside the sheet and never inside it: the keypad brings its own tap-to-commit surface, and
          nested inside this one a tap on it would close the sheet under the number it just set. */}
      {typing && (
        <Keypad
          mode="weight"
          current={draft.targetWeightKg ?? EMPTY_BAR_KG}
          onCommit={(value) => { setDraft((held) => withTarget(held, { targetWeightKg: value })); setTyping(false); }}
          onCancel={() => setTyping(false)}
        />
      )}
    </>
  );
}

// A GRAB RAIL ON EVERY ROW (canon screen 6), and it answers a pointer rather than a mouse: the same
// gesture has to work under a thumb, and HTML's drag events do not fire on touch at all. The rows
// are one height, so how far the finger travelled IS how many rows it crossed — the arithmetic is
// the whole implementation, and `reorderEntries` owns what the drop means.
function EntryList({ entries, catalog, onMove, onTarget, onRemove }) {
  const [drag, setDrag] = useState(null);
  const rowHeight = useRef(0);

  const shift = (event) => Math.round((event.clientY - drag.from) / (rowHeight.current || 1));

  return (
    <ul className="gym-entries">
      {entries.map((entry, index) => (
        <li
          className={drag?.index === index ? 'gym-entry is-dragging' : 'gym-entry'}
          key={`${entry.exerciseId}-${index}`}
          style={drag?.index === index ? { transform: `translateY(${drag.by}px)` } : undefined}
        >
          <span
            className="gym-entry-rail"
            aria-hidden="true"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              rowHeight.current = event.currentTarget.closest('.gym-entry').getBoundingClientRect().height;
              setDrag({ index, from: event.clientY, by: 0 });
            }}
            onPointerMove={(event) => { if (drag) setDrag({ ...drag, by: event.clientY - drag.from }); }}
            onPointerUp={(event) => {
              if (!drag) return;
              const moved = shift(event);
              setDrag(null);
              if (moved !== 0) onMove(drag.index, drag.index + moved);
            }}
            onPointerCancel={() => setDrag(null)}
          >
            ⠿
          </span>
          {/* THE NAME IS A DOOR (§H) — and, like the back arrow beside it, a door OUT of the
              editor: this screen holds a draft and nothing reaches the store until Save, so a
              lifter who leaves to check where a movement stands comes back to the routine as the
              store has it. Save is the only thing here that writes, and that is the whole rule. */}
          <a className="gym-entry-name gym-movement-door" href={recordHref(entry.exerciseId)}>
            {nameOfMovement(catalog, entry.exerciseId)}
            {/* A movement this account minted, off the catalog's own `custom` and never a guess
                at the id. ONE word for that flag everywhere since the 2026-08-13 adjudication:
                `yours` — the picker's word (screen 7, logger/MovementPicker.jsx). Screen 30 drew
                `· mine` for the same fact and that word lost; the boards converge on this one. */}
            {movementOf(catalog, entry.exerciseId)?.custom && <span className="gym-entry-yours">yours</span>}
          </a>
          <button type="button" className="gym-entry-target" onClick={() => onTarget(index)}>
            {entryLabel(entry)}
          </button>
          <button
            type="button"
            className="gym-entry-drop"
            onClick={() => onRemove(index)}
            aria-label={`Remove ${nameOfMovement(catalog, entry.exerciseId)}`}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
