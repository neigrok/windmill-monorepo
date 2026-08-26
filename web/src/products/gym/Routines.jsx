import React, { useRef, useState } from 'react';
import { Back } from './Back.jsx';
import { failureReason, gymApi } from './gymApi.js';
import {
  alsoReadsLabel, EMPTY_BAR_KG, entryLabel, fmtKg, isUntested, movementOf, NAME_MAX,
  nameCountLabel, nameOfMovement, NEW_ROUTINE_ID, recordHref, routineHref, routineMetaLabel,
  ROUTINES_HREF, showsNameCount, threadHref, UNTESTED,
} from './log.js';
import { LiveMirror } from './Mirror.jsx';
import { CONVERSATION_VERB, receiptLine } from './proposals.js';
import { mintId } from './mint.js';
import { PendingProposals, ProposalDot, ProposalFlag, ProposalReview } from './Proposals.jsx';
import { Keypad } from './logger/Keypad.jsx';
import { MovementPicker } from './logger/MovementPicker.jsx';
import { LADDER_KEYS, ladderLabels, bump } from './logger/ladder.js';
import {
  blankRoutine, builtLabel, draftFrom, duplicateRoutine, entryPlaceLabel, historyRows,
  NAME_SUGGESTIONS, NEW_ENTRY_REPS, openTargetsLine, reorderEntries, routineWrite, saysNeverLogged,
  targetDraftOf, withEntryAdded, withEntryChanged, withEntryOpened, withEntryRemoved, withTarget,
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
          <button type="button" className="gym-retry" onClick={view.retry}>Retry</button>
        </p>
      )}
      {view.phase === 'ready' && view.data.length === 0 && (
        <>
          <p className="gym-quiet">No routines yet.</p>
          <p className="gym-quiet">Finish a session and gym offers to keep it as one — or write one out now.</p>
          <a className="gym-routines-build" href={routineHref(NEW_ROUTINE_ID)}>Build a routine</a>
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
  const [naming, setNaming] = useState(fresh);
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
  const missing = draft.name.trim() === '' ? 'Name it to save it.' : (draft.entries.length === 0 ? 'A routine is at least one movement.' : null);
  const openTargets = openTargetsLine(draft.entries, log.catalog);
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
          <input
            className="gym-editor-name"
            value={draft.name}
            maxLength={NAME_MAX}
            placeholder="Name this routine"
            aria-label="Routine name"
            onChange={(event) => setEdits({ ...draft, name: event.target.value })}
          />
          {showsNameCount(draft.name) && <span className="gym-name-count">{nameCountLabel(draft.name)}</span>}
        </span>
        <button
          type="button"
          className={missing || saving ? 'gym-editor-save is-inert' : 'gym-editor-save'}
          onClick={async () => { if (await commit()) window.location.hash = ROUTINES_HREF; }}
        >
          Save
        </button>
      </header>
      {missing && <p className="gym-editor-missing">{missing}</p>}

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

      <RoutineHistory routine={view.data} />

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
          key={target}
          movement={nameOfMovement(log.catalog, draft.entries[target].exerciseId)}
          place={entryPlaceLabel(target, draft.entries.length, draft.name)}
          entry={draft.entries[target]}
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

function NameTheRoutine({ name, onName, onNext }) {
  const ready = name.trim() !== '';
  return (
    <>
      <Back href={ROUTINES_HREF}>Routines</Back>
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
        {showsNameCount(name) && <span className="gym-name-count">{nameCountLabel(name)}</span>}
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

// Null targets are not zeros: no load means "last time", no rep target means max.
function TargetSheet({ movement, place, entry, neverLogged, onSet, onOpen, onClose }) {
  const [draft, setDraft] = useState(() => targetDraftOf(entry));
  const [typing, setTyping] = useState(false);
  const reps = draft.targetReps;
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
          {neverLogged && <p className="gym-target-never">Never logged — these are your numbers.</p>}
          <div className="gym-target-row">
            <span className="gym-target-label">Sets</span>
            <button type="button" className="gym-target-step" onClick={() => setDraft((held) => withTarget(held, { targetSets: held.targetSets - 1 }))} aria-label="One set fewer">−</button>
            <span className="gym-target-value">{draft.targetSets}</span>
            <button type="button" className="gym-target-step" onClick={() => setDraft((held) => withTarget(held, { targetSets: held.targetSets + 1 }))} aria-label="One set more">+</button>
          </div>
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
          {/* The button above is kilograms; null when the account also reads kilograms. */}
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
      {/* Keep the keypad outside the sheet; nested, a tap on it closes the sheet. */}
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
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
