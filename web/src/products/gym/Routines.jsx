import React, { useEffect, useRef, useState } from 'react';
import { Button, Icon, Menu, Tag } from '../../design-system/index.js';
import { Back } from './Back.jsx';
import { failureReason, gymApi } from './gymApi.js';
import {
  agoLabel, backfillHref, cappedName, entryLabel, FROM_ROUTINE_MENU, isNameOverCap, MOVEMENTS_HREF,
  movementOf, nameCountLabel, nameOfMovement, NEW_ROUTINE_ID, routineHref,
  ROUTINES_HREF, showsNameCount,
} from './log.js';
import { LiveMirror } from './Mirror.jsx';
import { mintId } from './mint.js';
import { PendingProposals, ProposalPanel } from './Proposals.jsx';
import { useRail } from './rail.js';
import { MovementPicker } from './logger/MovementPicker.jsx';
import {
  blankRoutine, draftFrom, entryDroppedLine, entryPlaceLabel,
  NAME_IT_TO_SAVE_IT, reorderEntries, routineConflictRows, routineDeletedLine, routineWrite, saysNeverLogged,
  withEntryAdded, withEntryAt, withEntryRemoved, withEntrySet,
} from './routines.js';
import { useGymRead } from './useGymRead.js';
import { TargetEditor } from './planning/TargetEditor.jsx';
import './planning/planning.css';

export function RoutinesList({ log, onSignIn, reviewing = null }) {
  const view = useGymRead(() => gymApi.routines(), []);

  const gone = log.gone('routine');
  const hidden = log.hidden('routine');
  const program = view.phase === 'ready' ? view.data.filter((routine) => !gone.has(routine.id)) : [];
  const routines = program.filter((routine) => !hidden.has(routine.id));

  const remove = (routine) => log.withhold({
    kind: 'routine',
    id: routine.id,
    line: routineDeletedLine(routine.name),
    send: () => gymApi.deleteRoutine(routine.id),
    refused: (error) => log.say(`${routine.name} is still in your program — ${failureReason(error)}.`),
  });

  return (
    <section className="gym-plan-home">
      <header className="gym-head gym-log-head">
        <h1 className="gym-title">Your routines</h1>

        <span className="gym-head-doors">
          <a className="gym-door-past" href={MOVEMENTS_HREF}>Movements</a>
          {program.length > 0 && <span className="gym-new-routine-wide"><Button href={routineHref(NEW_ROUTINE_ID)}>New routine</Button></span>}
        </span>
      </header>
      {log.session && <LiveMirror log={log} onSignIn={onSignIn} />}

      {view.phase === 'ready' && <PendingProposals routines={routines} log={log} onChanged={view.refresh} />}
      {reviewing && <ProposalPanel key={reviewing} id={reviewing} log={log} onChanged={view.refresh} />}
      {view.phase === 'loading' && <p className="gym-quiet">Opening your routines…</p>}
      {view.phase === 'failed' && (
        <p className="gym-read-failed">
          The routines didn’t load.
          <Button variant="secondary" size="sm" onClick={view.retry}>Retry</Button>
        </p>
      )}

      {view.phase === 'ready' && program.length === 0 && (
        <section className="gym-plan-empty">
          <p>No routines yet. Build the first one.</p>
          <Button href={routineHref(NEW_ROUTINE_ID)}>New routine</Button>
        </section>
      )}
      {view.phase === 'ready' && routines.length > 0 && (
        <ul className="gym-routines">
          {routines.map((routine) => (
            <li className="gym-routine" key={routine.id}>
              <a className="gym-routine-open" href={routineHref(routine.id)}>
                <span className="gym-routine-card-head"><span className="gym-routine-name">{routine.name}</span><span className="gym-routine-trained">{routine.lastTrainedAt ? `Trained ${agoLabel(routine.lastTrainedAt)}` : 'Never trained'}</span></span>
                <span className="gym-routine-card-body"><span className="gym-routine-meta">{(routine.entries ?? []).map((entry) => nameOfMovement(log.catalog, entry.exerciseId)).join(' · ')}</span>
                <span className="gym-routine-rails" aria-hidden="true">{(routine.entries ?? []).map((entry, index) => <span key={index}>{Array.from({ length: entry.sets?.length ?? 1 }, (_, tick) => <i key={tick} />)}</span>)}</span></span>
              </a>
              <Menu
                label={`More for ${routine.name}`}
                items={[
                  { label: 'Log past', run: () => { window.location.hash = backfillHref(routine.id, FROM_ROUTINE_MENU); } },
                  { label: 'Delete', run: () => remove(routine) },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      {program.length > 0 && <div className="gym-new-routine-small"><Button full href={routineHref(NEW_ROUTINE_ID)}>New routine</Button></div>}
    </section>
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
  const [target, setTarget] = useState(0);
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetInvalid, setTargetInvalid] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const draft = edits ?? (view.phase === 'ready' ? draftFrom(view.data) : null);

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

  const editEntries = (change) => setEdits((held) => {
    const base = held ?? draftFrom(view.data);
    return { ...base, entries: change(base.entries) };
  });

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
  const missing = targetInvalid ? 'Check the movement targets.' : draft.name.trim() === '' ? NAME_IT_TO_SAVE_IT : (draft.entries.length === 0 ? 'A routine is at least one movement.' : null);

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
        setConflict(true);
        try { const latest = await gymApi.routine(id); if (latest) setConflict(latest); } catch {}
        return false;
      }
      log.say(`That routine wasn’t saved — ${failureReason(error)}.`);
      return false;
    }
  };

  if (conflict?.entries) return <section className="gym-plan-versions">
    <p className="gym-plan-kicker">{view.data.name}</p><h1 className="gym-title">Two versions</h1>
    <p className="gym-plan-version-intro">Your draft and the saved routine differ. Nothing is thrown away.</p>
    <section className="gym-plan-differences"><h2>What differs</h2>
      {routineConflictRows(view.data, draft, conflict).map((row, index) => <div key={index}><span>{row.label ?? nameOfMovement(log.catalog, row.exerciseId)}</span><span className="gym-plan-change-values">{row.before} → <strong>{row.after}</strong></span><small>{row.source}</small></div>)}
    </section>
    <div className="gym-plan-version-columns">{[['Your draft', draft], ['Saved routine', conflict]].map(([label, routine]) => <section key={label}>
      <h2>{label}</h2>{routine.entries.map((entry, index) => <div className="gym-plan-version-entry" key={index}><p>{nameOfMovement(log.catalog, entry.exerciseId)}</p><span>{entryLabel(entry)}</span></div>)}
    </section>)}</div>
    <div className="gym-plan-version-actions"><a href={ROUTINES_HREF}>Use saved only</a><Button disabled={saving} onClick={async () => {
      if (saving) return;
      setSaving(true);
      try {
        await gymApi.createRoutine(routineWrite({ ...draft, id: minted.current, name: draft.name.trim() }));
        window.location.hash = ROUTINES_HREF;
      } catch (error) { log.say(`Your draft is still here — ${failureReason(error)}.`); }
      setSaving(false);
    }}>{saving ? 'Saving…' : 'Keep both'}</Button></div>
  </section>;

  return (
    <section className="gym-plan-editor">
      <Back href={ROUTINES_HREF}>Routines</Back>
      <header className={`gym-editor-head${fresh ? ' is-new' : ''}`}>
        {fresh ? <h1 className="gym-title">New routine</h1> : <span className="gym-editor-name-field">
          <input
            className="gym-plan-name"
            value={draft.name}
            placeholder="Name this routine"
            aria-label="Routine name"
            autoFocus={fresh}
            onChange={(event) => setEdits({ ...draft, name: cappedName(event.target.value) })}
          />
          <span className="gym-plan-name-measure" aria-hidden="true">{draft.name || 'Name this routine'}</span>
          {showsNameCount(draft.name) && <span className={isNameOverCap(draft.name) ? 'gym-name-count is-over' : 'gym-name-count'}>{nameCountLabel(draft.name)}</span>}
        </span>}
        <span className="gym-plan-draft"><Tag size="sm" selected>Draft</Tag></span>
      </header>
      {fresh && <div className="gym-plan-new-name"><label htmlFor="gym-routine-name">Routine name</label><input id="gym-routine-name" value={draft.name} placeholder="Name this routine" aria-label="Routine name" autoFocus onChange={(event) => setEdits({ ...draft, name: cappedName(event.target.value) })} /></div>}

      {conflict && <section className="gym-plan-conflict" role="alert">
        <h2>The routine changed elsewhere</h2>
        <p>Your edits are still here. Load the latest routine to compare before saving this draft.</p>
        <Button variant="secondary" onClick={async () => {
          try {
            const latest = await gymApi.routine(id);
            if (!latest) { log.say('This routine is no longer in your program.'); return; }
            setConflict(latest);
          } catch (error) { log.say(`The latest routine didn’t load — ${failureReason(error)}.`); }
        }}>Load latest</Button>
      </section>}
      <div className="gym-plan-split">
        <div className="gym-plan-movements">
          <h2 className="gym-plan-kicker">Movements</h2>
          <EntryList
            entries={draft.entries}
            catalog={log.catalog}
            selected={target}
            onMove={(from, to) => { editEntries((held) => reorderEntries(held, from, to)); setTarget(to); }}
            onTarget={(index) => { if (targetInvalid) { log.say('Check the current movement targets first.'); return; } setTarget(index); setTargetOpen(true); setPicking(false); setTargetInvalid(false); }}
            onRemove={(index) => { dropEntry(index); setTarget(null); setTargetOpen(false); setTargetInvalid(false); }}
          />
          <button type="button" className="gym-plan-add-movement" onClick={() => { if (targetInvalid) { log.say('Check the current movement targets first.'); return; } setQuery(''); setPicking(true); setTargetOpen(false); }}>
            + Add movement
          </button>
        </div>
        <aside className={`gym-plan-detail${targetOpen || picking ? ' is-open' : ''}`}>
          {!picking && target != null && draft.entries[target] && (
            <TargetEditor
              key={`${target}-${draft.entries[target].exerciseId}`}
              pane
              movement={nameOfMovement(log.catalog, draft.entries[target].exerciseId)}
              place={entryPlaceLabel(target, draft.entries.length, draft.name)}
              entry={draft.entries[target]}
              equipment={movementOf(log.catalog, draft.entries[target].exerciseId)?.equipment ?? null}
              neverLogged={saysNeverLogged(view.data, draft.entries[target])}
              onDraft={(entry) => { setTargetInvalid(entry == null); if (entry) editEntries((held) => withEntrySet(held, target, entry)); }}
              onSet={(entry) => { editEntries((held) => withEntrySet(held, target, entry)); setTargetOpen(false); }}
              onClose={() => setTargetOpen(false)}
            />
          )}
          {picking && (
            <MovementPicker
              pane
              catalog={log.catalog}
              sessions={log.summaries}
              query={query}
              onQuery={setQuery}
              onPick={(exerciseId) => { setPicking(false); setTarget(draft.entries.length); setTargetOpen(true); editEntries((held) => withEntryAdded(held, exerciseId)); }}
              onCreate={log.createMovement}
              onClose={() => setPicking(false)}
              title="Add movement"
            />
          )}
        </aside>
      </div>
      <div className="gym-plan-actions">
        <a href={ROUTINES_HREF}>Cancel</a>
        <div className="gym-plan-save-area">{missing && <p className="gym-editor-missing">{missing}</p>}
        <Button disabled={Boolean(missing) || saving || Boolean(conflict)}
          onClick={async () => { if (await commit()) window.location.hash = ROUTINES_HREF; }}>
          {saving ? 'Saving…' : 'Save routine'}
        </Button></div>
      </div>
    </section>
  );
}

function EntryList({ entries, catalog, selected, onMove, onTarget, onRemove }) {
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
            className={`gym-entry${drag?.index === index ? ' is-dragging' : ''}${selected === index ? ' is-selected' : ''}`}
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

      <p className="gym-said" role="status">{rail.said}</p>
    </>
  );
}
