import React, { useEffect, useRef, useState } from 'react';
import { Button, Icon, Input, Tag } from '../../design-system/index.js';
import { Back } from './Back.jsx';
import { failureReason, gymApi } from './gymApi.js';
import {
  alsoReadsLabel, cappedName, entryLabel, isNameOverCap, isUntested, MOVEMENTS_HREF, movementOf,
  nameCountLabel, nameOfMovement, NEW_ROUTINE_ID, routineHref, routineMetaLabel, ROUTINES_HREF,
  showsNameCount, threadHref, UNTESTED,
} from './log.js';
import { LiveMirror } from './Mirror.jsx';
import { Overflow } from './Overflow.jsx';
import { CONVERSATION_VERB, receiptLine } from './proposals.js';
import { mintId } from './mint.js';
import { PendingProposals, ProposalDot, ProposalReview } from './Proposals.jsx';
import { useRail } from './rail.js';
import { MovementPicker } from './logger/MovementPicker.jsx';
import {
  blankRoutine, builtLabel, DECIMAL_NOTE, draftFrom, duplicateRoutine, entryDroppedLine,
  entryPlaceLabel, hasOpenEntry, historyRows, isOpenFields, LAST_TIME_PLACEHOLDER, MAX_PLACEHOLDER,
  NAME_IT_TO_SAVE_IT, OPEN_LINE, OPEN_PLACEHOLDER, reorderEntries, routineDeletedLine, routineWrite,
  saysNeverLogged, targetEntryOf, targetFieldsOf, targetRefusal, withEntryAdded, withEntryAt,
  withEntryRemoved, withEntrySet, withField, withSignFlipped,
} from './routines.js';
import { useGymRead } from './useGymRead.js';

// The home. The live mirror heads it, then whatever is waiting for a decision, then the program.
// `reviewing` is a proposal reached by its address: its dialog opens over the home and closes to it,
// and whatever it settles or learns lands in this list's own read.
export function RoutinesList({ log, onSignIn, reviewing = null }) {
  const view = useGymRead(() => gymApi.routines(), []);
  const [copying, setCopying] = useState(false);

  // The read, answered TWICE: `program` is what the ACCOUNT holds — the read less the routines the
  // store has answered a delete for — and `routines` is what the withheld window leaves to draw. The
  // stance reads the account and the rows read the window: a window decides which rows are drawn and
  // never what state a screen is in (`13-gestures.md`). Both questions are asked of the ROOM, so
  // this list is right however many times it is rebuilt mid-window, and the settled delete leaves
  // the read as well as the rows — without that the last routine's delete would leave a home with no
  // rows and no words on it for ever.
  const gone = log.gone('routine');
  const hidden = log.hidden('routine');
  const program = view.phase === 'ready' ? view.data.filter((routine) => !gone.has(routine.id)) : [];
  const routines = program.filter((routine) => !hidden.has(routine.id));

  // The copy is filed past the end of the ACCOUNT's program, never the original's own place and
  // never the raw read's length: nothing re-reads this list behind a settled delete, so the raw read
  // would file every copy one place high for the life of the room. The phones file it the same way.
  const duplicate = async (routine) => {
    if (copying) return;
    setCopying(true);
    try {
      await gymApi.createRoutine(duplicateRoutine(routine, { id: mintId('rt_'), position: program.length }));
      view.retry();
    } catch (error) {
      log.say(`That copy wasn’t made — ${failureReason(error)}.`);
    }
    setCopying(false);
  };

  // Withheld like every other delete in this room: nothing is on the wire for the length of the
  // window, and the transient the room draws is the only way back.
  const remove = (routine) => log.withhold({
    kind: 'routine',
    id: routine.id,
    line: routineDeletedLine(routine.name),
    send: () => gymApi.deleteRoutine(routine.id),
    refused: (error) => log.say(`${routine.name} is still in your program — ${failureReason(error)}.`),
  });

  return (
    <>
      <header className="gym-head gym-log-head">
        <h1 className="gym-title">Routines</h1>
        {/* The one door to a movement's own record, and to Rename, that asks nothing of the movement
            first: every other route needs it to have been trained or to sit in an open proposal's
            diff. A movement that sits in a routine and has never been logged is reached from here. */}
        <span className="gym-head-doors">
          <a className="gym-door-past" href={MOVEMENTS_HREF}>Movements</a>
          <a className="gym-door-past" href={routineHref(NEW_ROUTINE_ID)}>New</a>
        </span>
      </header>
      <LiveMirror log={log} onSignIn={onSignIn} />
      {/* The filtered list, not the read: a delete cascades the routine's proposals, so a routine
          the window is holding takes its waiting card off the home for as long as it holds it. */}
      {view.phase === 'ready' && <PendingProposals routines={routines} log={log} onChanged={view.refresh} />}
      {reviewing && (
        <ProposalReview
          key={reviewing}
          id={reviewing}
          log={log}
          onClose={() => { window.location.hash = ROUTINES_HREF; }}
          onChanged={view.refresh}
          onSettled={(receipt) => { log.say(receiptLine(receipt)); view.refresh(); window.location.hash = ROUTINES_HREF; }}
        />
      )}
      {view.phase === 'loading' && <p className="gym-quiet">Opening your routines…</p>}
      {view.phase === 'failed' && (
        <p className="gym-read-failed">
          The routines didn’t load.
          <Button variant="secondary" size="sm" onClick={view.retry}>Retry</Button>
        </p>
      )}
      {/* Off the ACCOUNT: an account holding one routine the window has taken off the home is not an
          account with no routines — it comes back on Undo, and `Build a routine` would be an act
          offered over a program that still has one. Between the two stances the home draws neither. */}
      {view.phase === 'ready' && program.length === 0 && (
        <>
          <p className="gym-quiet">No routines yet.</p>
          <p className="gym-quiet">Finish a session and gym offers to keep it as one — or write one out now.</p>
          <Button full href={routineHref(NEW_ROUTINE_ID)}>Build a routine</Button>
        </>
      )}
      {view.phase === 'ready' && routines.length > 0 && (
        <ul className="gym-routines">
          {routines.map((routine) => (
            <li className="gym-routine" key={routine.id}>
              <a className="gym-routine-open" href={routineHref(routine.id)}>
                <span className="gym-routine-name">{routine.name}</span>
                <span className="gym-routine-meta">{routineMetaLabel(routine)}</span>
              </a>
              <Overflow
                label={`More for ${routine.name}`}
                items={[
                  { label: 'Duplicate', run: () => duplicate(routine) },
                  { label: 'Delete', run: () => remove(routine) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function RoutineEditor({ id, log }) {
  // The id is the idempotency key: mint once so a retried create is one routine.
  const minted = useRef(null);
  if (minted.current === null) minted.current = mintId('rt_');
  const fresh = id === NEW_ROUTINE_ID;

  const view = useGymRead(
    () => (fresh ? Promise.resolve(blankRoutine({ id: minted.current })) : gymApi.routine(id)),
    [id],
  );
  const [edits, setEdits] = useState(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const draft = edits ?? (view.phase === 'ready' ? draftFrom(view.data) : null);

  // A draft that no longer exists has nowhere to put a line back, so the editor's own withheld
  // removals close with it. Nothing was ever on the wire for them, so nothing is sent either.
  const { dropWithheld } = log;
  useEffect(() => () => dropWithheld('entry'), [dropWithheld]);

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the routine…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        <Back href={ROUTINES_HREF}>Routines</Back>
        <p className="gym-quiet">This routine isn’t in your program.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <Back href={ROUTINES_HREF}>Routines</Back>
        <p className="gym-read-failed">
          The routine didn’t load.
          <Button variant="secondary" size="sm" onClick={view.retry}>Retry</Button>
        </p>
      </>
    );
  }

  // Functional: a row put back nine seconds later must land on the draft as it stands then, not on
  // the draft as it stood when the row left it.
  const editEntries = (change) => setEdits((held) => {
    const base = held ?? draftFrom(view.data);
    return { ...base, entries: change(base.entries) };
  });

  // The `×` is as destructive as a swipe and takes the same undo, on the same clock — the gate is the
  // act, not the gesture. It sends nothing: the line lives in an unsaved draft, and the only other
  // way back is a Cancel that discards every other edit made since the editor opened.
  const dropEntry = (index) => {
    const entry = draft.entries[index];
    editEntries((held) => withEntryRemoved(held, index));
    log.withhold({
      kind: 'entry',
      id: mintId('drop_'),
      line: entryDroppedLine(nameOfMovement(log.catalog, entry.exerciseId)),
      undo: () => editEntries((held) => withEntryAt(held, index, entry)),
    });
  };
  // One at a time, and in this order: there is no screen before this one to have asked for a name.
  const missing = draft.name.trim() === '' ? NAME_IT_TO_SAVE_IT : (draft.entries.length === 0 ? 'A routine is at least one movement.' : null);
  const built = builtLabel(view.data);

  const commit = async () => {
    if (missing || saving) return false;
    setSaving(true);
    // The write carries the revision it read; a stale routine is refused, not overwritten.
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
        <Back href={ROUTINES_HREF}>Routines</Back>
        <span className="gym-editor-name-field">
          <Input
            value={draft.name}
            placeholder="Name this routine"
            ariaLabel="Routine name"
            autoFocus={fresh}
            onChange={(event) => setEdits({ ...draft, name: cappedName(event.target.value) })}
            trailing={showsNameCount(draft.name) && (
              <span className={isNameOverCap(draft.name) ? 'gym-name-count is-over' : 'gym-name-count'}>
                {nameCountLabel(draft.name)}
              </span>
            )}
          />
        </span>
        <Button
          size="md"
          disabled={Boolean(missing) || saving}
          onClick={async () => { if (await commit()) window.location.hash = ROUTINES_HREF; }}
        >
          Save
        </Button>
      </header>
      {missing && <p className="gym-editor-missing">{missing}</p>}

      {!fresh && (isUntested(view.data) || built) && (
        <p className="gym-editor-meta">
          {isUntested(view.data) && <Tag size="sm">{UNTESTED}</Tag>}
          {built && <span>{built}</span>}
        </p>
      )}

      <EntryList
        entries={draft.entries}
        catalog={log.catalog}
        onMove={(from, to) => editEntries((held) => reorderEntries(held, from, to))}
        onTarget={(index) => setTarget(index)}
        onRemove={dropEntry}
      />

      {/* Once, under the whole list, while a row is open and no target sheet stands over it: the
          rows say WHICH by reading `open` in their own target column, and this says what that word
          means. While a sheet is up the sheet owns the sentence — one state, one sentence, never a
          blessing behind a scrim beside a refusal in front of it. */}
      {target == null && hasOpenEntry(draft.entries) && <p className="gym-open-line">{OPEN_LINE}</p>}

      <Button full variant="secondary" onClick={() => { setQuery(''); setPicking(true); }}>
        + Add movement
      </Button>

      <RoutineHistory routine={view.data} />

      {target != null && (
        <TargetSheet
          key={target}
          movement={nameOfMovement(log.catalog, draft.entries[target].exerciseId)}
          place={entryPlaceLabel(target, draft.entries.length, draft.name)}
          entry={draft.entries[target]}
          neverLogged={saysNeverLogged(view.data, draft.entries[target])}
          onSet={(entry) => {
            editEntries((held) => withEntrySet(held, target, entry));
            setTarget(null);
          }}
          onClose={() => setTarget(null)}
        />
      )}

      {picking && (
        <MovementPicker
          catalog={log.catalog}
          sessions={log.summaries}
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

function RoutineHistory({ routine }) {
  const rows = historyRows(routine);
  if (rows.length === 0) return null;
  return (
    <section className="gym-history">
      <h2 className="gym-history-head">History</h2>
      <ul className="gym-history-rows">
        {rows.map((row) => (
          <li key={row.key}>
            {row.href ? (
              <>
                <a className="gym-history-row" href={row.href}>
                  {row.pending && <ProposalDot />}
                  <span className="gym-history-line">{row.line}</span>
                  <span className="gym-history-go" aria-hidden="true">›</span>
                </a>
                {/* A sibling anchor: one anchor may not sit inside another. */}
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

// Three fields and no escape hatch, because clearing a field IS the escape: sets cleared is the open
// line, reps cleared is `max`, weight cleared is `last time`, and each placeholder says so. The plate
// ladder and the keypad are rack controls (16-the-workout.md) and are not here.
function TargetSheet({ movement, place, entry, neverLogged, onSet, onClose }) {
  const [fields, setFields] = useState(() => targetFieldsOf(entry));
  const refusal = targetRefusal(fields);
  // Nothing is derived from a refused field: while one stands, the button says only what it is.
  const held = refusal ? null : targetEntryOf(entry, fields);
  const alsoReads = alsoReadsLabel(held?.targetWeightKg ?? null);
  // A refused clear keeps the field's value, so it keeps it SELECTED too: the gesture that reaches
  // this refusal is backspace-then-retype, and a kept value with the caret behind it would turn the
  // next digit into a second one (5 backspaced and 4 typed reading 54). Written to the node before
  // React's own restore, so the selection survives the re-render that puts the value back.
  const type = (field) => (event) => {
    const input = event.target;
    const next = withField(fields, field, input.value);
    setFields(next);
    if (!next.clearRefused) return;
    input.value = next.sets;
    input.setSelectionRange(0, next.sets.length);
  };
  const refusalFor = (field) => (refusal?.field === field ? refusal.message : undefined);

  return (
    <div className="gym-sheet-catch" role="presentation" onClick={onClose}>
      <div className="gym-sheet" role="dialog" aria-label={`Target · ${movement}`} onClick={(event) => event.stopPropagation()}>
        <div className="gym-sheet-head">
          <span className="gym-target-movement">{movement}</span>
          <span className="gym-target-place">{place}</span>
          <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        {neverLogged && <p className="gym-target-never">Never logged — these are your numbers.</p>}
        {/* The same sentence the list draws beneath its rows, said here for the row being decided.
            It sits with the other statement about the line, above the fields: everything under a
            field belongs to that field. While a refusal stands the sentence is not drawn: blessing a
            state the sheet is refusing in the same breath says two things at once. */}
        {!refusal && isOpenFields(fields) && <p className="gym-open-line">{OPEN_LINE}</p>}

        <div className="gym-target-fields">
          <Input
            label="Sets"
            value={fields.sets}
            placeholder={OPEN_PLACEHOLDER}
            inputMode="numeric"
            error={refusalFor('sets')}
            onChange={type('sets')}
          />
          <Input
            label="Reps"
            value={fields.reps}
            placeholder={MAX_PLACEHOLDER}
            inputMode="numeric"
            error={refusalFor('reps')}
            onChange={type('reps')}
          />
          <div>
            <Input
              label="Weight"
              value={fields.weight}
              placeholder={LAST_TIME_PLACEHOLDER}
              inputMode="decimal"
              error={refusalFor('weight')}
              onChange={type('weight')}
              describedBy="gym-target-decimal"
              trailing={(
                <>
                  <span className="gym-target-unit">kg</span>
                  {/* A decimal keyboard offers no sign, and band-assisted work is a negative load. */}
                  <button
                    type="button"
                    className="gym-target-sign"
                    aria-label="Flip the sign"
                    onClick={() => setFields(withSignFlipped)}
                  >
                    ±
                  </button>
                </>
              )}
            />
            <p className="gym-target-decimal" id="gym-target-decimal">{DECIMAL_NOTE}</p>
          </div>
        </div>

        {/* The field is kilograms; null when the account also reads kilograms. */}
        {alsoReads && <p className="gym-target-reads">{alsoReads}</p>}

        <Button full disabled={held == null} onClick={() => onSet(held)}>
          {held == null ? 'Set' : `Set · ${entryLabel(held)}`}
        </Button>
      </div>
    </div>
  );
}

// Pointer events, not drag events, which do not fire on touch; rows are one height, so travel is rows crossed.
// The rail is a button as well as a drag handle, and `useRail` is the three paths it answers on —
// the drag, the arrows, and the single-pointer pick up and place down. Focus follows the row it
// moved — the list is keyed by index, so the row it left is a new node — and the move is SAID on the
// line under the list, which is the announcement for every path: a drag says nothing on its own, and
// a name changing under a focus that jumped is not an announcement either.
function EntryList({ entries, catalog, onMove, onTarget, onRemove }) {
  const [drag, setDrag] = useState(null);
  const rowHeight = useRef(0);
  const rails = useRef([]);
  const follows = useRef(null);

  useEffect(() => {
    if (follows.current === null) return;
    rails.current[follows.current]?.focus();
    follows.current = null;
  });

  const rail = useRail({
    count: entries.length,
    nameOf: (index) => nameOfMovement(catalog, entries[index].exerciseId),
    placeOf: (index) => entryPlaceLabel(index, entries.length),
    move: (from, to) => { follows.current = to; onMove(from, to); },
  });

  const shift = (event) => Math.round((event.clientY - drag.from) / (rowHeight.current || 1));

  return (
    <>
      <ul className="gym-entries">
        {entries.map((entry, index) => (
          <li
            className={drag?.index === index ? 'gym-entry is-dragging' : 'gym-entry'}
            key={`${entry.exerciseId}-${index}`}
            style={drag?.index === index ? { transform: `translateY(${drag.by}px)` } : undefined}
          >
            <button
              type="button"
              className="gym-entry-rail"
              ref={(node) => { rails.current[index] = node; }}
              aria-label={rail.nameFor(index)}
              aria-pressed={rail.picked === index}
              onClick={(event) => rail.activate(index, event)}
              onKeyDown={(event) => rail.keyDown(index, event)}
              onPointerDown={(event) => {
                rail.grabbed();
                event.currentTarget.setPointerCapture(event.pointerId);
                rowHeight.current = event.currentTarget.closest('.gym-entry').getBoundingClientRect().height;
                setDrag({ index, from: event.clientY, by: 0 });
              }}
              onPointerMove={(event) => { if (drag) setDrag({ ...drag, by: event.clientY - drag.from }); }}
              onPointerUp={(event) => {
                if (!drag) return;
                const moved = shift(event);
                setDrag(null);
                // A drop past the last row travels further than there are rows: it lands on the end.
                rail.dropped(drag.index, Math.min(Math.max(drag.index + moved, 0), entries.length - 1));
              }}
              onPointerCancel={() => setDrag(null)}
            >
              ⠿
            </button>
            {/* One control over the row body, and it opens the target sheet rather than leaving the
                screen: a link out of here discards the draft with no question. The movement's name is
                inside it, so the sheet's own control is named for the line it edits. */}
            <button type="button" className="gym-entry-body" onClick={() => onTarget(index)}>
              <span className="gym-entry-name">
                {nameOfMovement(catalog, entry.exerciseId)}
                {movementOf(catalog, entry.exerciseId)?.custom && <span className="gym-entry-yours">yours</span>}
              </span>
              <span className="gym-entry-target">{entryLabel(entry)}</span>
            </button>
            <button
              type="button"
              className="gym-entry-drop"
              onClick={() => onRemove(index)}
              aria-label={`Remove ${nameOfMovement(catalog, entry.exerciseId)}`}
            >
              <Icon name="x" size={15} />
            </button>
          </li>
        ))}
      </ul>
      {/* The move is said here, once, for every path alike, and the line is read rather than drawn:
          the row itself already carries its place, and what the handle would do next, in its name. */}
      <p className="gym-said" role="status">{rail.said}</p>
    </>
  );
}
