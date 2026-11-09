import React, { useEffect, useRef, useState } from 'react';
import { Button, Icon, Menu, Tag } from '../../design-system/index.js';
import { Id } from '../../platform/domain-kit/entities.js';
import { Back } from './Back.jsx';
import { Routine, RoutineValue } from './domain/routines.js';
import { failureReason } from './errors.js';
import { t } from './i18n/index.js';
import { routineDocument, useGymApi } from './gymRuntime.js';
import {
  agoLabel, backfillHref, cappedName, FROM_ROUTINE_MENU, isNameOverCap, MOVEMENTS_HREF,
  movementOf, nameCountLabel, nameOfMovement, NEW_ROUTINE_ID, routineHref,
  ROUTINES_HREF, schemeParts, showsNameCount,
} from './log.js';
import { LiveMirror } from './Mirror.jsx';
import { mintId } from './mint.js';
import { ProposalPreview, ProposalPanel } from './Proposals.jsx';
import { useRail } from './rail.js';
import { MovementPicker } from './logger/MovementPicker.jsx';
import {
  draftFrom, entryDroppedLine, entryPlaceLabel,
  NAME_IT_TO_SAVE_IT, reorderEntries, routineConflictRows, saysNeverLogged,
  withEntryAdded, withEntryAt, withEntryRemoved, withEntrySet,
} from './routines.js';
import { useGymRead } from './useGymRead.js';
import { useDomainRead } from './useDomainRead.js';
import { TargetEditor } from './planning/TargetEditor.jsx';
import './planning/planning.css';

export function RoutinesList({ log, reviewing = null }) {
  const api = useGymApi();
  const view = useGymRead(() => api.routines(), [], { sync: true, ready: Boolean(api?.ready) });
  const program = useDomainRead((read) => ({ routines: read.repository(Routine).all('stored'), isComplete: read.firstPullComplete() }));
  const removals = useGymRead(() => api.removalReceipts(), [], { sync: true, ready: Boolean(api?.ready) });
  const [reviewId, setReviewId] = useState(reviewing);
  useEffect(() => setReviewId(reviewing), [reviewing]);

  const gone = log.gone('routine');
  const hidden = log.hidden('routine');
  const routines = view.phase === 'ready' ? view.data.filter((routine) => !gone.has(routine.id) && !hidden.has(routine.id)) : [];
  const hasProgram = (program.data?.routines.length ?? 0) > 0;
  const complete = program.phase === 'ready' && program.data.isComplete;

  const remove = (routine) => log.holdDelete({
    kind: 'routine',
    id: routine.id,
    refused: (error) => log.say(t('gym.routines.stillInProgram', { name: routine.name, reason: failureReason(error) })),
  });

  return (
    <section className="gym-plan-home">
      <header className="gym-head gym-log-head">
        <h1 className="gym-title">{t('gym.routines.title')}</h1>

        <span className="gym-head-doors">
          <a className="gym-door-past" href={MOVEMENTS_HREF}>{t('gym.routines.movementsDoor')}</a>
          {hasProgram && <span className="gym-new-routine-wide"><Button href={routineHref(NEW_ROUTINE_ID)}>{t('gym.routines.newRoutine')}</Button></span>}
        </span>
      </header>
      {log.session && <LiveMirror log={log} />}

      {reviewId && <ProposalPanel key={reviewId} id={reviewId} log={log} onChanged={view.refresh} />}
      {removals.phase === 'ready' && removals.data.filter((proposal) => proposal.id !== reviewId).map((proposal) =>
        <section className="gym-routine-review" key={proposal.id}>
          <header><span className="gym-proposal-name">{proposal.baseName || t('gym.routines.removalFallbackName')}</span>
            <button className="gym-proposal-review" type="button" onClick={() => setReviewId(proposal.id)}>{t('gym.routines.viewReceipt')}</button></header>
          <p className="gym-proposal-line">{t('gym.routines.removalOutcome', { outcome: proposal.removalOutcome })}</p>
        </section>)}
      {view.phase === 'loading' && <p className="gym-quiet">{t('gym.routines.opening')}</p>}
      {view.phase === 'failed' && (
        <p className="gym-read-failed">
          {t('gym.routines.loadFailed')}
          <Button variant="secondary" size="sm" onClick={view.retry}>{t('gym.common.retry')}</Button>
        </p>
      )}

      {view.phase === 'ready' && complete && !hasProgram && (
        <section className="gym-plan-empty">
          <p>{t('gym.routines.empty')}</p>
          <Button href={routineHref(NEW_ROUTINE_ID)}>{t('gym.routines.newRoutine')}</Button>
        </section>
      )}
      {view.phase === 'ready' && routines.length > 0 && (
        <ul className="gym-routines">
          {routines.map((routine) => (
            <li className={`gym-routine${routine.pendingProposal ? ' has-proposal' : ''}`} key={routine.id}>
              <a className="gym-routine-open" href={routineHref(routine.id)}>
                <span className="gym-routine-card-head"><span className="gym-routine-name">{routine.name}</span><span className="gym-routine-trained">{routine.lastTrainedAt ? <><span className="gym-routine-trained-prefix">{t('gym.routines.trainedPrefix')} </span>{agoLabel(routine.lastTrainedAt)}</> : complete ? t('gym.routines.neverTrained') : null}</span></span>
                <span className="gym-routine-card-body"><span className="gym-routine-meta">{(routine.entries ?? []).map((entry) => nameOfMovement(log.catalog, entry.exerciseId)).join(' · ')}</span>
                <span className="gym-routine-rails" aria-hidden="true">{(routine.entries ?? []).map((entry, index) => <span key={index}>{Array.from({ length: entry.sets?.length ?? 1 }, (_, tick) => <i key={tick} />)}</span>)}</span></span>
              </a>
              <Menu
                label={t('gym.routines.moreFor', { name: routine.name })}
                items={[
                  { label: t('gym.routines.logPast'), run: () => { window.location.hash = backfillHref(routine.id, FROM_ROUTINE_MENU); } },
                  { label: t('gym.routines.delete'), run: () => remove(routine) },
                ]}
              />
              {routine.pendingProposal && routine.pendingProposal.id !== reviewId && <ProposalPreview routine={routine} onExpand={setReviewId} log={log} />}
            </li>
          ))}
        </ul>
      )}
      {hasProgram && <div className="gym-new-routine-small"><Button full href={routineHref(NEW_ROUTINE_ID)}>{t('gym.routines.newRoutine')}</Button></div>}
    </section>
  );
}

export function RoutineEditor({ id, log }) {
  const api = useGymApi();
  // The id is the idempotency key: mint once so a retried create is one routine.
  const minted = useRef(null);
  if (minted.current === null) minted.current = mintId('rt_');
  const fresh = id === NEW_ROUTINE_ID;

  const projection = useGymRead(
    () => (fresh ? Promise.resolve(routineDocument(new RoutineValue(new Id(minted.current, Routine)))) : api.routine(id)),
    [id],
    { sync: true, ready: Boolean(api?.ready) },
  );
  const base = useRef(null);
  if (base.current === null && projection.phase === 'ready') base.current = projection.data;
  const view = base.current ? { ...projection, phase: 'ready', data: base.current } : projection;
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

  if (view.phase === 'loading') return <p className="gym-quiet">{t('gym.routines.openingRoutine')}</p>;
  // A routine its delete window holds is gone from its own screen, as its row is from the home.
  if (view.phase === 'absent' || (!fresh && log.hidden('routine').has(id))) {
    return (
      <>
        <Back href={ROUTINES_HREF}>{t('gym.routines.back')}</Back>
        <p className="gym-quiet">{t('gym.routines.notInProgram')}</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        <Back href={ROUTINES_HREF}>{t('gym.routines.back')}</Back>
        <p className="gym-read-failed">
          {t('gym.routines.routineLoadFailed')}
          <Button variant="secondary" size="sm" onClick={view.retry}>{t('gym.common.retry')}</Button>
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
  const missing = targetInvalid ? t('gym.routines.checkTargets') : draft.name.trim() === '' ? NAME_IT_TO_SAVE_IT : (draft.entries.length === 0 ? t('gym.routines.atLeastOneMovement') : null);

  const commit = async () => {
    if (missing || saving) return false;
    setSaving(true);
    // The draft retains the fields it read, even while the mirror receives newer data.
    const write = { ...draft, name: draft.name.trim() };
    try {
      if (fresh) await api.createRoutine(write);
      else await api.replaceRoutine(draft.id, write, view.data);
      setSaving(false);
      return true;
    } catch (error) {
      setSaving(false);
      if (error?.code === 'stale') {
        setConflict(true);
        try { const latest = await api.routine(id); if (latest) setConflict(latest); } catch {}
        return false;
      }
      log.say(t('gym.routines.notSaved', { reason: failureReason(error) }));
      return false;
    }
  };

  if (conflict?.entries) return <section className="gym-plan-versions">
    <header className="gym-plan-version-heading"><p className="gym-plan-kicker">{view.data.name}</p><h1 className="gym-title">{t('gym.routines.twoVersions')}</h1>
    <p className="gym-plan-version-intro">{t('gym.routines.versionsIntro')}</p></header>
    <section className="gym-plan-differences"><h2>{t('gym.routines.whatDiffers')}</h2>
      {routineConflictRows(view.data, draft, conflict).map((row, index) => <div key={index}><span>{row.label ?? nameOfMovement(log.catalog, row.exerciseId)}</span><span className="gym-plan-change-values">{row.before} → <strong>{row.after}</strong></span><small>{row.source}</small></div>)}
    </section>
    <div className="gym-plan-version-columns">{[[t('gym.routines.yourDraft'), draft], [t('gym.routines.savedRoutine'), conflict]].map(([label, routine]) => <section key={label}>
      <h2>{label}</h2>{routine.entries.map((entry, index) => <div className="gym-plan-version-entry" key={index}><p>{nameOfMovement(log.catalog, entry.exerciseId)}</p><SchemeReadout entry={entry} compareTo={view.data.entries[index]?.exerciseId === entry.exerciseId ? view.data.entries[index] : null} /></div>)}
    </section>)}</div>
    <div className="gym-plan-version-actions"><a href={ROUTINES_HREF}>{t('gym.routines.useSavedOnly')}</a><Button disabled={saving} onClick={async () => {
      if (saving) return;
      setSaving(true);
      try {
        await api.createRoutine({ ...draft, id: minted.current, name: draft.name.trim() });
        window.location.hash = ROUTINES_HREF;
      } catch (error) { log.say(t('gym.routines.draftStillHere', { reason: failureReason(error) })); }
      setSaving(false);
    }}>{saving ? t('gym.routines.saving') : t('gym.routines.keepBoth')}</Button></div>
  </section>;

  return (
    <section className={`gym-plan-editor${fresh ? ' is-new' : ''}`}>
      <Back href={ROUTINES_HREF}>{t('gym.routines.back')}</Back>
      <header className={`gym-editor-head${fresh ? ' is-new' : ''}`}>
        {fresh ? <h1 className="gym-title">{t('gym.routines.newRoutineTitle')}</h1> : <span className="gym-editor-name-field">
          <input
            className="gym-plan-name"
            value={draft.name}
            placeholder={t('gym.routines.namePlaceholder')}
            aria-label={t('gym.routines.nameLabel')}
            autoFocus={fresh}
            onChange={(event) => setEdits({ ...draft, name: cappedName(event.target.value) })}
          />
          <span className="gym-plan-name-measure" aria-hidden="true">{draft.name || t('gym.routines.namePlaceholder')}</span>
          {showsNameCount(draft.name) && <span className={isNameOverCap(draft.name) ? 'gym-name-count is-over' : 'gym-name-count'}>{nameCountLabel(draft.name)}</span>}
        </span>}
        <span className="gym-plan-draft"><Tag size="sm" selected>{t('gym.routines.draft')}</Tag></span>
      </header>
      {fresh && <div className="gym-plan-new-name"><label htmlFor="gym-routine-name">{t('gym.routines.nameLabel')}</label><input id="gym-routine-name" value={draft.name} placeholder={t('gym.routines.namePlaceholder')} aria-label={t('gym.routines.nameLabel')} autoFocus onChange={(event) => setEdits({ ...draft, name: cappedName(event.target.value) })} /></div>}

      {conflict && <section className="gym-plan-conflict" role="alert">
        <h2>{t('gym.routines.changedElsewhere')}</h2>
        <p>{t('gym.routines.editsStillHere')}</p>
        <Button variant="secondary" onClick={async () => {
          try {
            const latest = await api.routine(id);
            if (!latest) { log.say(t('gym.routines.noLongerInProgram')); return; }
            setConflict(latest);
          } catch (error) { log.say(t('gym.routines.latestNotLoaded', { reason: failureReason(error) })); }
        }}>{t('gym.routines.loadLatest')}</Button>
      </section>}
      <div className="gym-plan-split">
        <div className="gym-plan-movements">
          <h2 className="gym-plan-kicker">{t('gym.routines.movementsHeading')}</h2>
          <EntryList
            entries={draft.entries}
            catalog={log.catalog}
            selected={target}
            onMove={(from, to) => { editEntries((held) => reorderEntries(held, from, to)); setTarget(to); }}
            onTarget={(index) => { if (targetInvalid) { log.say(t('gym.routines.checkCurrentTargets')); return; } setTarget(index); setTargetOpen(true); setPicking(false); setTargetInvalid(false); }}
            onRemove={(index) => { dropEntry(index); setTarget(null); setTargetOpen(false); setTargetInvalid(false); }}
          />
          <button type="button" className="gym-plan-add-movement" onClick={() => { if (targetInvalid) { log.say(t('gym.routines.checkCurrentTargets')); return; } setQuery(''); setPicking(true); setTargetOpen(false); }}>
            <span aria-hidden="true">+</span> {t('gym.routines.addMovement')}
          </button>
        </div>
        <aside className={`gym-plan-detail${targetOpen || picking ? ' is-open' : ''}`}>
          {!picking && target != null && draft.entries[target] && (
            <TargetEditor
              key={`${target}-${draft.entries[target].exerciseId}`}
              pane
              movement={nameOfMovement(log.catalog, draft.entries[target].exerciseId)}
              place={entryPlaceLabel(target, draft.entries.length, draft.name)}
              panePlace={view.data.lastTrainedAt
                ? t('gym.routines.panePlaceTrained', { position: target + 1, total: draft.entries.length, ago: agoLabel(view.data.lastTrainedAt) })
                : t('gym.routines.panePlaceNeverLogged', { position: target + 1, total: draft.entries.length })}
              entry={draft.entries[target]}
              exercise={movementOf(log.catalog, draft.entries[target].exerciseId)}
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
              title={t('gym.routines.addMovement')}
            />
          )}
        </aside>
      </div>
      <div className="gym-plan-commit">
        <div className="gym-plan-actions">
          <a href={ROUTINES_HREF}>{t('gym.common.cancel')}</a>
          <Button disabled={Boolean(missing) || saving || Boolean(conflict)}
            onClick={async () => { if (await commit()) window.location.hash = ROUTINES_HREF; }}>
            {saving ? t('gym.routines.saving') : t('gym.routines.saveRoutine')}
          </Button>
        </div>
        {missing && <p className="gym-editor-missing">{missing}</p>}
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
                {movementOf(catalog, entry.exerciseId)?.custom && <span className="gym-entry-yours">{t('gym.picker.yours')}</span>}
              </span>
              <span className="gym-entry-target"><SchemeReadout entry={entry} /></span>
            </button>
            <button
              type="button"
              className="gym-entry-drop"
              onClick={() => onRemove(index)}
              aria-label={t('gym.routines.removeEntry', { movement: nameOfMovement(catalog, entry.exerciseId) })}
            >
              <Icon name="x" size={12} />
            </button>
          </li>
        ))}
      </ul>

      <p className="gym-said" role="status">{rail.said}</p>
    </>
  );
}

function SchemeReadout({ entry, compareTo = null }) {
  const parts = schemeParts(entry, undefined, { unloadedFromLast: true });
  const original = compareTo ? schemeParts(compareTo, undefined, { unloadedFromLast: true }) : null;
  return <span className="gym-plan-scheme">{parts.map((part, index) => <span key={index} className={index % 2 ? 'is-separator' : original && part.value !== original[index]?.value ? 'is-changed' : undefined}>{part.text}</span>)}</span>;
}
