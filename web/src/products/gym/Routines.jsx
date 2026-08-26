import React, { useRef, useState } from 'react';
import { Button, Icon, Input, Tag } from '../../design-system/index.js';
import { Back } from './Back.jsx';
import { failureReason, gymApi } from './gymApi.js';
import {
  alsoReadsLabel, cappedName, entryLabel, isUntested, movementOf, nameCountLabel, nameOfMovement,
  NEW_ROUTINE_ID, recordHref, routineHref, routineMetaLabel, ROUTINES_HREF, showsNameCount,
  threadHref, UNTESTED,
} from './log.js';
import { LiveMirror } from './Mirror.jsx';
import { Overflow } from './Overflow.jsx';
import { CONVERSATION_VERB, receiptLine } from './proposals.js';
import { mintId } from './mint.js';
import { PendingProposals, ProposalDot, ProposalFlag, ProposalReview } from './Proposals.jsx';
import { MovementPicker } from './logger/MovementPicker.jsx';
import {
  blankRoutine, builtLabel, DECIMAL_NOTE, draftFrom, duplicateRoutine, entryPlaceLabel, hasOpenEntry,
  historyRows, isOpenFields, LAST_TIME_PLACEHOLDER, MAX_PLACEHOLDER, OPEN_LINE, OPEN_PLACEHOLDER,
  reorderEntries, routineWrite, saysNeverLogged, targetEntryOf, targetFieldsOf, targetRefusal,
  withEntryAdded, withEntryRemoved, withEntrySet, withField, withSignFlipped,
} from './routines.js';
import { useGymRead } from './useGymRead.js';

// The home. The live mirror heads it, then whatever is waiting for a decision, then the program.
// `reviewing` is a proposal reached by its address: its dialog opens over the home and closes to it,
// and whatever it settles or learns lands in this list's own read.
export function RoutinesList({ log, onSignIn, reviewing = null }) {
  const view = useGymRead(() => gymApi.routines(), []);
  const [copying, setCopying] = useState(false);

  const duplicate = async (routine) => {
    if (copying) return;
    setCopying(true);
    try {
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
      <LiveMirror log={log} onSignIn={onSignIn} />
      {view.phase === 'ready' && <PendingProposals routines={view.data} log={log} onChanged={view.refresh} />}
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
      {view.phase === 'ready' && view.data.length === 0 && (
        <>
          <p className="gym-quiet">No routines yet.</p>
          <p className="gym-quiet">Finish a session and gym offers to keep it as one — or write one out now.</p>
          <Button full href={routineHref(NEW_ROUTINE_ID)}>Build a routine</Button>
        </>
      )}
      {view.phase === 'ready' && view.data.length > 0 && (
        <ul className="gym-routines">
          {view.data.map((routine) => (
            <li className="gym-routine" key={routine.id}>
              <a className="gym-routine-open" href={routineHref(routine.id)}>
                <span className="gym-routine-line">
                  <span className="gym-routine-name">{routine.name}</span>
                  {routine.pendingProposal && <ProposalFlag />}
                </span>
                <span className="gym-routine-meta">{routineMetaLabel(routine)}</span>
              </a>
              <Overflow
                label={`More for ${routine.name}`}
                items={[{ label: 'Duplicate', run: () => duplicate(routine) }]}
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

  const editEntries = (change) => setEdits({ ...draft, entries: change(draft.entries) });
  // One at a time, and in this order: there is no screen before this one to have asked for a name.
  const missing = draft.name.trim() === '' ? 'Name it to save it.' : (draft.entries.length === 0 ? 'A routine is at least one movement.' : null);
  const built = builtLabel(view.data);
  const copy = async () => {
    try {
      const made = duplicateRoutine(view.data, { id: mintId('rt_') });
      await gymApi.createRoutine(made);
      window.location.hash = routineHref(made.id);
    } catch (error) {
      log.say(`That copy wasn’t made — ${failureReason(error)}.`);
    }
  };

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
            trailing={showsNameCount(draft.name) && <span className="gym-name-count">{nameCountLabel(draft.name)}</span>}
          />
        </span>
        <Button
          size="md"
          disabled={Boolean(missing) || saving}
          onClick={async () => { if (await commit()) window.location.hash = ROUTINES_HREF; }}
        >
          Save
        </Button>
        {!fresh && <Overflow label="More for this routine" items={[{ label: 'Duplicate', run: copy }]} />}
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
        onRemove={(index) => editEntries((held) => withEntryRemoved(held, index))}
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
          <a className="gym-entry-name gym-movement-door" href={recordHref(entry.exerciseId)}>
            {nameOfMovement(catalog, entry.exerciseId)}
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
            <Icon name="x" size={15} />
          </button>
        </li>
      ))}
    </ul>
  );
}
