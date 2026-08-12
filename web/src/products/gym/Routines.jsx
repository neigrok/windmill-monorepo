// ROUTINES — the list of them (canon screen 5) and one of them under the hand (screen 6). The
// editor is a maintenance surface and not the entry point: most lifters get their first routine out
// of a session they finished, so what this room is for is the second month, not the first day.
//
// ONE DRAFT, ONE COMMIT. Every change lands in a copy and nothing reaches the store until Done, so a
// routine is never left half-rewritten by a lifter who walked away mid-edit — half a program is what
// somebody trains against tomorrow. The two ways out say which they are: Done writes, and the back
// arrow leaves the routine as it was. Sessions start on the phone (§11), so nothing here runs one —
// the routine saved here is the plan the phone's Start freezes onto the session.
//
// The order is the store's, not this screen's: `GET /v1/gym/routines` answers most-recently-trained
// first, which is what canon screen 5 sorts by, so the list draws what it is handed.

import React, { useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { failureReason, gymApi } from './gymApi.js';
import {
  entryLabel, fmt, nameOfMovement, NEW_ROUTINE_ID, recordHref, routineHref, routineMetaLabel,
  ROUTINES_HREF,
} from './log.js';
import { mintId } from './mint.js';
import { Keypad } from './logger/Keypad.jsx';
import { MovementPicker } from './logger/MovementPicker.jsx';
import { EMPTY_BAR_KG } from './log.js';
import {
  blankRoutine, draftFrom, duplicateRoutine, NAME_MAX, NEW_ENTRY_REPS, reorderEntries, routineWrite,
  withEntryAdded, withEntryChanged, withEntryRemoved,
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
        </>
      )}
      {view.phase === 'ready' && view.data.length > 0 && (
        <ul className="gym-routines">
          {view.data.map((routine) => (
            <li className="gym-routine" key={routine.id}>
              <a className="gym-routine-open" href={routineHref(routine.id)}>
                <span className="gym-routine-name">{routine.name}</span>
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

  const editEntries = (change) => setEdits({ ...draft, entries: change(draft.entries) });
  // The store refuses a routine with no entries and one with no name, and both are things this
  // screen can see. So it says which is missing instead of sending a document it knows comes back.
  const missing = draft.name.trim() === '' ? 'Name it to save it.' : (draft.entries.length === 0 ? 'A routine is at least one movement.' : null);

  const commit = async () => {
    if (missing || saving) return false;
    setSaving(true);
    const write = routineWrite({ ...draft, name: draft.name.trim() });
    try {
      if (fresh) await gymApi.createRoutine(write);
      else await gymApi.replaceRoutine(draft.id, write);
      setSaving(false);
      return true;
    } catch (error) {
      setSaving(false);
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
          className={missing || saving ? 'gym-editor-done is-inert' : 'gym-editor-done'}
          onClick={async () => { if (await commit()) window.location.hash = ROUTINES_HREF; }}
        >
          Done
        </button>
      </header>
      {missing && <p className="gym-editor-missing">{missing}</p>}

      <EntryList
        entries={draft.entries}
        catalog={log.catalog}
        onMove={(from, to) => editEntries((held) => reorderEntries(held, from, to))}
        onTarget={(index) => setTarget(index)}
        onRemove={(index) => editEntries((held) => withEntryRemoved(held, index))}
      />

      <button type="button" className="gym-editor-add" onClick={() => { setQuery(''); setPicking(true); }}>
        + Add exercise
      </button>

      <div className="gym-editor-foot">
        <button
          type="button"
          // Inert on exactly what Done is inert on: a copy of a draft the store would refuse is a
          // refusal the screen can already see coming, and the missing line above says which half.
          className={missing ? 'gym-editor-duplicate is-inert' : 'gym-editor-duplicate'}
          onClick={async () => {
            // The copy is of what is ON SCREEN, which leaves the original exactly as the store has
            // it — so this is the one action here that never needs the draft committed first.
            if (missing) return;
            try {
              const copy = duplicateRoutine(draft, { id: mintId('rt_') });
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

      {target != null && (
        <TargetSheet
          movement={nameOfMovement(log.catalog, draft.entries[target].exerciseId)}
          entry={draft.entries[target]}
          onChange={(change) => editEntries((held) => withEntryChanged(held, target, change))}
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
          title="Add exercise"
        />
      )}
    </>
  );
}

// What one line asks for: two counts under a thumb and the weight on the keypad every other number
// on this surface is typed on. BOTH targets have one value no stepper
// and no keypad can reach — none at all — and neither is a zero somebody has to guess at: an absent
// load is the wire's "whatever you did last time", an absent rep target is canon screen 6's
// `3 × max`, and each gets the same way back, one word under the row it belongs to.
function TargetSheet({ movement, entry, onChange, onClose }) {
  const [typing, setTyping] = useState(false);
  const reps = entry.targetReps;
  return (
    <>
      <div className="gym-sheet-catch" role="presentation" onClick={onClose}>
        <div className="gym-sheet" role="dialog" aria-label={`Target · ${movement}`} onClick={(event) => event.stopPropagation()}>
          <div className="gym-sheet-head">
            <span className="gym-sheet-title">{`Target · ${movement}`}</span>
            <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">×</button>
          </div>
          <div className="gym-target-row">
            <span className="gym-target-label">Sets</span>
            <button type="button" className="gym-target-step" onClick={() => onChange({ targetSets: entry.targetSets - 1 })} aria-label="One set fewer">−</button>
            <span className="gym-target-value">{entry.targetSets}</span>
            <button type="button" className="gym-target-step" onClick={() => onChange({ targetSets: entry.targetSets + 1 })} aria-label="One set more">+</button>
          </div>
          {/* From `max`, either stepper lands on the opening value rather than one either side of
              it: the first tap is choosing to have a target at all, not moving one. */}
          <div className="gym-target-row">
            <span className="gym-target-label">Reps</span>
            <button type="button" className="gym-target-step" onClick={() => onChange({ targetReps: reps == null ? NEW_ENTRY_REPS : reps - 1 })} aria-label="One rep fewer">−</button>
            <span className="gym-target-value">{reps ?? 'max'}</span>
            <button type="button" className="gym-target-step" onClick={() => onChange({ targetReps: reps == null ? NEW_ENTRY_REPS : reps + 1 })} aria-label="One rep more">+</button>
            {reps != null && (
              <button type="button" className="gym-target-clear" onClick={() => onChange({ targetReps: null })}>
                take it to max
              </button>
            )}
          </div>
          <div className="gym-target-row">
            <span className="gym-target-label">Weight</span>
            <button type="button" className="gym-target-weight" onClick={() => setTyping(true)}>
              {entry.targetWeightKg == null ? 'last time' : `${fmt(entry.targetWeightKg)} kg`}
            </button>
            {entry.targetWeightKg != null && (
              <button type="button" className="gym-target-clear" onClick={() => onChange({ targetWeightKg: null })}>
                use last time
              </button>
            )}
          </div>
        </div>
      </div>
      {/* Beside the sheet and never inside it: the keypad brings its own tap-to-commit surface, and
          nested inside this one a tap on it would close the sheet under the number it just set. */}
      {typing && (
        <Keypad
          mode="weight"
          current={entry.targetWeightKg ?? EMPTY_BAR_KG}
          onCommit={(value) => { onChange({ targetWeightKg: value }); setTyping(false); }}
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
              editor: this screen holds a draft and nothing reaches the store until Done, so a
              lifter who leaves to check where a movement stands comes back to the routine as the
              store has it. Done is the only thing here that writes, and that is the whole rule. */}
          <a className="gym-entry-name gym-movement-door" href={recordHref(entry.exerciseId)}>
            {nameOfMovement(catalog, entry.exerciseId)}
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
