import React, { useEffect, useId, useRef, useState } from 'react';
import { Button, Icon, Input, Menu, Tag } from '../../design-system/index.js';
import { Back } from './Back.jsx';
import { failureReason, gymApi } from './gymApi.js';
import {
  alsoReadsLabel, cappedName, entryLabel, isNameOverCap, isUntested, MOVEMENTS_HREF, movementOf,
  nameCountLabel, nameOfMovement, NEW_ROUTINE_ID, routineHref, routineMetaLabel, ROUTINES_HREF,
  schemeAgrees, showsNameCount, threadHref, UNTESTED,
} from './log.js';
import { LiveMirror } from './Mirror.jsx';
import { CONVERSATION_VERB, receiptLine } from './proposals.js';
import { mintId } from './mint.js';
import { PendingProposals, ProposalDot, ProposalReview } from './Proposals.jsx';
import { useRail } from './rail.js';
import { MovementPicker } from './logger/MovementPicker.jsx';
import {
  ADD_SET, blankRoutine, builtLabel, commitLabel, draftFrom, entryDroppedLine,
  entryPlaceLabel, EVERY_SET, FILL, headOf, historyRows, isOpenFields, ladderOf, LAST_TIME_PLACEHOLDER,
  MATCH_SET_ONE, MAX_PLACEHOLDER, NAME_IT_TO_SAVE_IT, OPEN_LINE, OPEN_PLACEHOLDER, RAMP_UP,
  rampDisabled, reorderEntries, routineDeletedLine, routineWrite, saysNeverLogged, SET_BY_SET,
  targetEntryOf, targetFieldsOf, targetRefusal, withEntryAdded, withEntryAt, withEntryRemoved,
  withEntrySet, withHead, withMatchedToFirst, withRampUp, withRow, withRowAdded, withRowRemoved,
  withSets, withSignFlipped,
} from './routines.js';
import { useGymRead } from './useGymRead.js';

// The home. The live mirror heads it, then whatever is waiting for a decision, then the program.
// `reviewing` is a proposal reached by its address: its dialog opens over the home and closes to it,
// and whatever it settles or learns lands in this list's own read.
export function RoutinesList({ log, onSignIn, reviewing = null }) {
  const view = useGymRead(() => gymApi.routines(), []);

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
          <p className="gym-quiet">One training day, written down.</p>
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
              <Menu
                label={`More for ${routine.name}`}
                items={[{ label: 'Delete', run: () => remove(routine) }]}
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
          equipment={movementOf(log.catalog, draft.entries[target].exerciseId)?.equipment ?? null}
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

// The sheet holds one scheme at two zooms and nothing is a mode: the head speaks about every set at
// once, the ladder one row per set, and both are always drawn while the line names a count. Clearing
// Sets IS the open line — the ladder is hidden, not thrown away, and the other two fields go inert.
// The plate ladder and the keypad are rack controls (16-the-workout.md) and are not here.
function TargetSheet({ movement, place, entry, equipment, neverLogged, onSet, onClose }) {
  const [fields, setFields] = useState(() => targetFieldsOf(entry));
  const ids = useId();
  const refusal = targetRefusal(fields);
  const open = isOpenFields(fields);
  const head = headOf(fields);
  const ladder = ladderOf(fields);
  // Nothing is derived from a refused field: while one stands, the button says only what it is.
  const held = refusal ? null : targetEntryOf(entry, fields);
  // The pounds reading is honest only for a scheme with one load to read.
  const alsoReads = held?.sets && schemeAgrees(held.sets) ? alsoReadsLabel(held.sets[0].weightKg ?? null) : null;
  // `±` is drawn only where a negative load means something: band assistance on a bodyweight movement.
  const signed = equipment === 'bodyweight';
  const rowRefusal = (index, field) => (refusal?.row === index && refusal.field === field ? refusal.message : undefined);
  const rowId = (index, field) => `${ids}-row-${index}-${field}`;
  // Enter walks the same column down the ladder, so a ramp is typed top to bottom without a mouse.
  const nextDown = (index, field) => (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    globalThis.document?.getElementById?.(rowId(index + 1, field))?.focus();
  };
  const sign = (flip) => (
    <button type="button" className="gym-target-sign" aria-label="Flip the sign — band-assisted" onClick={flip}>
      ±
    </button>
  );

  return (
    <div className="gym-sheet-catch" role="presentation" onClick={onClose}>
      <div className="gym-sheet gym-target" role="dialog" aria-label={`Target · ${movement}`} onClick={(event) => event.stopPropagation()}>
        <div className="gym-sheet-head">
          <span className="gym-target-movement">{movement}</span>
          <span className="gym-target-place">{place}</span>
          <button type="button" className="gym-sheet-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        {neverLogged && <p className="gym-target-never">Never logged — these are your numbers.</p>}
        {/* The one place the open line is said: the rows only name themselves `open`. It sits with
            the other statement about the line, above the fields: everything under a field belongs to
            that field. While a refusal stands the sentence is not drawn: blessing a state the sheet
            is refusing in the same breath says two things at once. */}
        {!refusal && isOpenFields(fields) && <p className="gym-open-line">{OPEN_LINE}</p>}

        <section className="gym-sheet-section">
          <div className="gym-sheet-section-head">
            <h3 className="gym-sheet-section-title">{EVERY_SET}</h3>
          </div>
          <div className="gym-target-fields">
            <Input
              label="Sets"
              value={fields.sets}
              placeholder={OPEN_PLACEHOLDER}
              inputMode="numeric"
              error={refusal?.field === 'sets' ? refusal.message : undefined}
              onChange={(event) => setFields(withSets(fields, event.target.value))}
            />
            {/* An open line names neither: the two are inert, not refused. */}
            <fieldset className="gym-target-head" disabled={open}>
              <Input
                label="Reps"
                value={head.reps.value}
                placeholder={head.reps.placeholder}
                inputMode="numeric"
                onChange={(event) => setFields(withHead(fields, 'reps', event.target.value))}
              />
              <Input
                label="Weight"
                value={head.weight.value}
                placeholder={head.weight.placeholder}
                inputMode="decimal"
                onChange={(event) => setFields(withHead(fields, 'weight', event.target.value))}
                trailing={(
                  <>
                    <span className="gym-target-unit">kg</span>
                    {signed && sign(() => setFields(withSignFlipped(fields)))}
                  </>
                )}
              />
            </fieldset>
          </div>
        </section>

        {!open && (
          <section className="gym-sheet-section">
            <div className="gym-sheet-section-head">
              <h3 className="gym-sheet-section-title">{SET_BY_SET}</h3>
              <FillMenu
                items={[
                  { label: RAMP_UP, disabled: rampDisabled(fields), run: () => setFields(withRampUp(fields)) },
                  { label: MATCH_SET_ONE, disabled: false, run: () => setFields(withMatchedToFirst(fields)) },
                ]}
              />
            </div>
            <ul className="gym-ladder">
              {ladder.map((row, index) => (
                <li className="gym-ladder-row" key={index}>
                  <span className="gym-ladder-ordinal" aria-hidden="true">{index + 1}</span>
                  {/* The field catches no key of its own; Enter bubbles to the wrapper. */}
                  <span className="gym-ladder-field" onKeyDown={nextDown(index, 'reps')}>
                    <Input
                      id={rowId(index, 'reps')}
                      ariaLabel={`Set ${index + 1} reps`}
                      value={row.reps}
                      placeholder={MAX_PLACEHOLDER}
                      inputMode="numeric"
                      error={rowRefusal(index, 'reps')}
                      onChange={(event) => setFields(withRow(fields, index, 'reps', event.target.value))}
                    />
                  </span>
                  <span className="gym-ladder-field is-load" onKeyDown={nextDown(index, 'weight')}>
                    <Input
                      id={rowId(index, 'weight')}
                      ariaLabel={`Set ${index + 1} load`}
                      value={row.weight}
                      placeholder={LAST_TIME_PLACEHOLDER}
                      inputMode="decimal"
                      error={rowRefusal(index, 'weight')}
                      onChange={(event) => setFields(withRow(fields, index, 'weight', event.target.value))}
                      trailing={(
                        <>
                          <span className="gym-target-unit">kg</span>
                          {signed && sign(() => setFields(withSignFlipped(fields, index)))}
                        </>
                      )}
                    />
                  </span>
                  <button
                    type="button"
                    className="gym-ladder-drop"
                    aria-label={`Delete set ${index + 1}`}
                    onClick={() => setFields(withRowRemoved(fields, index))}
                  >
                    <Icon name="x" size={15} />
                  </button>
                </li>
              ))}
              <li className="gym-ladder-row is-add">
                <button type="button" className="gym-ladder-add" onClick={() => setFields(withRowAdded(fields))}>
                  {ADD_SET}
                </button>
                {refusal?.field === 'add' && <span className="gym-ladder-refusal">{refusal.message}</span>}
              </li>
            </ul>
          </section>
        )}

        {/* The field is kilograms; null when the account also reads kilograms. */}
        {alsoReads && <p className="gym-target-reads">{alsoReads}</p>}

        <Button full disabled={held == null} onClick={() => onSet(held)}>
          {held == null ? 'Set' : commitLabel(held)}
        </Button>
      </div>
    </div>
  );
}

// The ladder's one menu, opened by a word rather than the design system's ⋯: `Fill` names what the
// two items do. It closes on the act, on Escape, and on a pointer landing outside it, as `Menu` does.
function FillMenu({ items }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (!box.current?.contains(event.target)) setOpen(false); };
    const key = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <span className="wm-menu gym-fill" ref={box}>
      <button
        type="button"
        className="gym-fill-open"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((held) => !held)}
      >
        {FILL}
      </button>
      {open && (
        <span className="wm-menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="wm-menu-item"
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.run(); }}
            >
              {item.label}
            </button>
          ))}
        </span>
      )}
    </span>
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
