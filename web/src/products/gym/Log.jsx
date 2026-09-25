import React, { useEffect, useRef, useState } from 'react';
import { Button, Icon } from '../../design-system/index.js';
import { Back } from './Back.jsx';
import { failureReason, gymApi } from './gymApi.js';
import { BodyweightReading, useBodyweight, WeighInSheet } from './bodyweight/Bodyweight.jsx';
import { WEIGH_IN_VERB } from './bodyweight/bodyweight.js';
import { deletedLine, deleteFailure, fixFailure, setsAfter } from './fix.js';
import { FixSheet } from './FixSheet.jsx';
import {
  BACKFILL_HREF, CLOSED_ITSELF_NOTE, closedOnItsOwn, dayLabel, finishHref, fixSetHref, fromSession,
  groupByExercise, isFinished, logWhenLabel, NO_ROUTINE, planFrozenLabel, recordHref,
  routineNameOf, sessionHref, setLoadLabel, shortDayLabel, timeLabel, tonnageLabel,
} from './log.js';
import { SESSION_DELETED } from './review.js';
import { ShareWorkout } from './share/ShareWorkout.jsx';
import { useGymRead } from './useGymRead.js';
import { collapsedScheme, emptyHistoryLine, historyHref, historyQuery, historyTotals, workoutTotals, yearsOf } from './logbook/history.js';
import { useHistory, useHistoryDates } from './logbook/useHistory.js';
import { DateJump } from './logbook/DateJump.jsx';
import { weightUnit } from './units.js';
import { WorkoutEditor } from './correction/WorkoutEditor.jsx';
import { ProgressCards } from './progress/Progress.jsx';
import { consistencyLine } from './progress/progress.js';

export function LogNotOpen({ log, onSignIn }) {
  if (log.failure === 'signed-out') {
    return (
      <p className="gym-read-failed">
        Your sign-in lapsed.
        <Button variant="secondary" size="sm" onClick={onSignIn}>Sign in</Button>
      </p>
    );
  }
  return (
    <p className="gym-read-failed">
      {log.failure === 'signal' ? 'The log didn’t load. Open it again when you have signal.' : 'The log didn’t answer.'}
      <Button variant="secondary" size="sm" onClick={log.retryBoot}>Retry</Button>
    </p>
  );
}

export function LogList({ log, onSignIn, hash = '#/gym/log', sessionId = null, fixSetId = null, edit = false, positions = null, pagePositions = null }) {
  const filters = historyQuery(hash);
  const localPositions = useRef(new Map());
  const index = useRef(null);
  const indexPosition = useRef({ node: null, key: null, pending: false });
  const indexPositions = positions ?? localPositions.current;
  const indexKey = historyHref(filters, { selected: null });
  const history = useHistory(filters, log.revision);
  const dates = useHistoryDates(filters, log.revision);
  const hidden = log.hidden('session');
  const stored = (history.data?.sessions ?? []).filter((session) => !log.gone('session').has(session.id));
  const sessions = (history.data?.sessions ?? []).filter((session) => !hidden.has(session.id));
  const selected = sessionId ?? filters.selected ?? null;
  const noMatches = history.phase === 'ready' && stored.length === 0 && Boolean(filters.year || filters.exercise || filters.routine);
  const exerciseOptions = history.data?.exercises?.length ? history.data.exercises : log.catalog;
  const routineOptions = history.data?.routines ?? [];
  const from = historyHref(filters, { selected });
  const dense = history.data?.summary?.sessions > 50 || filters.density === 'compact';
  const focusedHistory = dense || filters.year || filters.exercise || filters.routine;
  const selectedOutside = selected && history.phase === 'ready' && !history.data?.next && !sessions.some((session) => session.id === selected);
  const weights = useBodyweight(log);
  const [weighing, setWeighing] = useState(false);
  const consistency = consistencyLine(log.progress?.data);
  const selectedIndex = sessions.findIndex((session) => session.id === selected);
  const openSession = (id) => { window.location.hash = `${sessionHref(id)}?from=${encodeURIComponent(historyHref(filters, { selected: id }))}`; };
  const adjacent = async (direction) => {
    const target = sessions[selectedIndex + direction];
    if (target) { openSession(target.id); return; }
    if (direction !== 1 || !history.data?.next) return;
    const page = await history.load();
    const next = page?.sessions.find((session) => !hidden.has(session.id));
    if (next) openSession(next.id);
  };
  useEffect(() => {
    if (selected && selectedIndex < 0 && history.data?.next && history.phase === 'ready' && history.more === 'idle') history.load();
  }, [selected, selectedIndex, history.data, history.phase, history.more]);
  useEffect(() => {
    const node = index.current;
    if (!node || edit || history.phase !== 'ready') return;
    const page = node.closest?.('.gym-scroll, .gym-root');
    if (indexPosition.current.node !== node || indexPosition.current.key !== indexKey || indexPosition.current.selected !== selected || indexPosition.current.reader !== Boolean(sessionId)) {
      indexPosition.current = { node, key: indexKey, selected, reader: Boolean(sessionId), pending: true };
    }
    if (!indexPosition.current.pending) return;
    const offset = indexPositions.get(indexKey);
    const pageOffset = !sessionId ? pagePositions?.get(indexKey) : null;
    if (page && pageOffset != null && page.scrollHeight - page.clientHeight < pageOffset && history.data?.next) {
      if (history.more === 'idle') history.load();
      return;
    }
    if (offset != null) {
      const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
      if (maximum < offset && history.data?.next) {
        if (history.more === 'idle') history.load();
        return;
      }
      node.scrollTop = Math.min(offset, maximum);
      if (selected) node.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
    } else if (selected) {
      const row = node.querySelector('[aria-current="page"]');
      if (!row && history.data?.next) return;
      row?.scrollIntoView({ block: 'nearest' });
    } else node.scrollTop = 0;
    if (page && pageOffset != null) page.scrollTop = pageOffset;
    indexPosition.current.pending = false;
    indexPositions.set(indexKey, node.scrollTop);
  }, [indexKey, selected, sessionId, edit, history.data, history.phase, history.more, indexPositions, pagePositions]);
  useEffect(() => {
    if (sessionId || !pagePositions) return;
    const page = index.current?.closest?.('.gym-scroll, .gym-root');
    if (!page) return;
    const remember = () => { if (!indexPosition.current.pending) pagePositions.set(indexKey, page.scrollTop); };
    page.addEventListener('scroll', remember);
    return () => page.removeEventListener('scroll', remember);
  }, [sessionId, edit, indexKey, history.phase, pagePositions]);
  const moveFilter = (change) => { window.location.hash = historyHref(filters, { ...change, selected: null }); };
  if ((edit || fixSetId) && selected) return <SessionDetail key={`${edit ? 'edit' : fixSetId}-${selected}`} id={selected} log={log} from={from} edit={edit} fixSetId={fixSetId} />;
  return (
    <section className={`gym-log-screen${sessionId ? ' has-session' : ''}${focusedHistory ? ' has-history-focus' : ''}`}>
      <header className="gym-head gym-log-head">
        <h1 className="gym-title">The log</h1>
        <div className="gym-history-actions">
          <a className="gym-history-share" href="#/gym/share-log" aria-label="Share log" title="Share log"><Icon name="share" size={20} /></a>
          <button type="button" className="gym-history-weigh" onClick={() => setWeighing(true)}>{WEIGH_IN_VERB}</button>
          <a className="gym-door-past" href={BACKFILL_HREF}>Add past workout</a>
        </div>
      </header>
      <div className="gym-history-filters">
        <DateJump year={filters.year} month={filters.month} months={dates.months} onChange={moveFilter} failure={dates.failure} onRetry={dates.retry} />
        <HistoryFilter label="Movement" value={filters.exercise} onChange={(exercise) => moveFilter({ exercise })} options={exerciseOptions} />
        <HistoryFilter label="Routine" value={filters.routine} onChange={(routine) => moveFilter({ routine })} options={routineOptions} />
      </div>
      {history.data?.summary && <p className="gym-log-count">{historyTotals(history.data.summary)}</p>}
      {history.phase === 'loading' && !history.data && <p className="gym-quiet">Opening the log…</p>}
      {history.failure && <p className="gym-read-failed">The log didn’t load. <Button size="sm" variant="secondary" onClick={history.retry}>Retry</Button></p>}
      {history.phase === 'ready' && stored.length === 0 && !noMatches && <p className="gym-quiet">No sessions yet.</p>}
      {noMatches && <section className="gym-history-empty"><p>{emptyHistoryLine(filters, log.catalog, routineOptions)}</p><Button onClick={() => moveFilter({ year: null, month: null, exercise: '', routine: '' })}>Clear filters</Button></section>}
      {!noMatches && <div className="gym-history-workspace">
        <aside ref={index} onScroll={(event) => { if (!indexPosition.current.pending) indexPositions.set(indexKey, event.currentTarget.scrollTop); }} className={`gym-history-index is-${filters.density}${dense ? ' is-dense' : ''}`} aria-label="Workout history">
          <HistoryIndex sessions={sessions} selected={selected} filters={filters} dense={dense} />
          {!history.data?.next && history.phase === 'ready' && sessions.length > 0 && <p className="gym-history-end">End of history</p>}
          {history.data?.next && <button type="button" className="gym-older" aria-busy={history.more === 'loading'} onClick={history.load}>{history.more === 'loading' ? 'Loading…' : history.more === 'failed' ? 'That read failed · retry' : 'Load older'}</button>}
        </aside>
        <div className="gym-history-detail">
          {selectedOutside && <p className="gym-quiet">This workout is outside these filters. <a href={historyHref(filters, { selected: null })}>Back to results</a></p>}
          {selected && <>
            <nav className="gym-reader-nav" aria-label="Workout navigation"><a className="gym-reader-top-back" href={historyHref(filters, { selected: null })}>← The log</a><button type="button" disabled={selectedIndex < 0 || (selectedIndex === sessions.length - 1 && !history.data?.next) || history.more === 'loading'} onClick={() => adjacent(1)}>Previous</button><button type="button" disabled={selectedIndex <= 0} onClick={() => adjacent(-1)}>Next</button><a className="gym-reader-edit" href={`${sessionHref(selected)}/edit?from=${encodeURIComponent(from)}`}>Edit workout</a></nav>
            <div className="gym-history-reader"><SessionDetail key={selected} id={selected} log={log} embedded from={from} /></div>
          </>}
          {!selected && <><div className="gym-progress-head"><h2 className="gym-section-title">Progress</h2>{consistency && <p className="gym-consistency">{consistency}</p>}</div>
          <ProgressCards log={log} from={{ screen: 'log', href: from }} /></>}
        </div>
      </div>}
      {!noMatches && <><details className="gym-log-options"><summary>Log options</summary><BodyweightReading latest={weights.latest} /><button type="button" className="gym-clear-filters" aria-pressed={filters.density === 'compact'} onClick={() => { window.location.hash = historyHref(filters, { density: filters.density === 'compact' ? 'comfortable' : 'compact' }); }}>{filters.density === 'compact' ? 'Comfortable rows' : 'Compact rows'}</button></details>
      <footer className="gym-log-footer">
        <button type="button" className="gym-history-weigh" onClick={() => setWeighing(true)}>{WEIGH_IN_VERB}</button>
        <a className="gym-door-past" href={BACKFILL_HREF}>Add past workout</a>
      </footer></>}
      {weighing && <WeighInSheet onSave={async (write) => { const refused = await weights.save(write); if (!refused) setWeighing(false); return refused; }} onClose={() => setWeighing(false)} />}
    </section>
  );
}

export function HistoryFilter({ label, value, options, onChange }) {
  const values = options.some((option) => String(option.id) === String(value)) || !value ? options : [{ id: value, name: value }, ...options];
  return <span className="gym-history-filter">
    <span className="gym-history-select">
      <span aria-hidden="true">{value ? values.find((option) => String(option.id) === String(value))?.name : label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{label}</option>
        {values.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    </span>
    {value && <button type="button" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange('')}>×</button>}
  </span>;
}

export function HistoryIndex({ sessions, selected, filters = {}, hrefOf = null, dense = false, unit = weightUnit() }) {
  return yearsOf(sessions, dense).map((year) => <section className="gym-history-year" key={year.year}>
    <h2>{year.year}</h2>
    <ul className="gym-sessions">
      {year.sessions.map((summary) => <SessionRow key={summary.id} summary={summary} unit={unit} selected={selected === summary.id} href={hrefOf ? hrefOf(summary) : `${sessionHref(summary.id)}?from=${encodeURIComponent(historyHref(filters, { selected: summary.id }))}`} />)}
    </ul>
  </section>);
}

function SessionRow({ summary, selected, href, unit }) {
  const facts = [typeof summary.workingSetCount === 'number' ? `${summary.workingSetCount} sets` : null, tonnageLabel(summary.tonnageKg, unit)].filter(Boolean);
  return <li><a className={`gym-row${selected ? ' is-selected' : ''}`} href={href} aria-current={selected ? 'page' : undefined}>
    <div className="gym-row-head"><span className="gym-row-title">{summary.routineName || routineNameOf(summary) || NO_ROUTINE}</span><span className="gym-row-when">{isFinished(summary) ? shortDayLabel(summary.startedAt) : logWhenLabel(summary)}</span></div>
    {facts.length > 0 && <div className="gym-row-facts">{facts.map((fact) => <span key={fact}>{fact}</span>)}</div>}
    {closedOnItsOwn(summary) && <div className="gym-row-closed">{CLOSED_ITSELF_NOTE}</div>}
  </a></li>;
}

export function SessionDetail({ id, log, embedded = false, from = '#/gym/log', edit = false, fixSetId = null }) {
  const { say, reloadLog, withhold } = log;
  const view = useGymRead(
    () => Promise.all([gymApi.session(id), gymApi.exercises()])
      .then(([detail, catalog]) => (detail ? { detail, catalog } : null)),
    [id],
  );
  const [moves, setMoves] = useState(() => new Map());
  const [fixing, setFixing] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const closeFix = () => { setFixing(null); window.location.hash = `${sessionHref(id)}?from=${encodeURIComponent(from)}`; };

  const dropSet = (set) => {
    closeFix();
    withhold({
      kind: 'set',
      id: set.id,
      line: deletedLine(set),
      send: async () => {
        await gymApi.deleteSet(id, set.id);
        await reloadLog();
      },
      refused: (error) => say(deleteFailure(error)),
    });
  };

  const discard = () => {
    setFixing(null);
    withhold({
      kind: 'session',
      id,
      line: SESSION_DELETED,
      send: async () => {
        await gymApi.discardSession(id);
        await reloadLog();
      },
      refused: (error) => say(`That session wasn’t discarded — ${failureReason(error)}.`),
    });
    window.location.hash = '#/gym/log';
  };

  const reread = () => {
    setMoves(new Map());
    view.retry();
  };

  const saveFix = async (set, fix) => {
    if (Object.keys(fix).length === 0) { closeFix(); return null; }
    try {
      const stored = await gymApi.fixSet(id, set.id, fix);
      setMoves((current) => new Map(current).set(set.id, stored));
      closeFix();
    } catch (error) {
      if (error.setNotFound) { closeFix(); reread(); say(fixFailure(error)); return null; }
      return fixFailure(error);
    }
    reloadLog();
  };

  if (view.phase === 'loading') return <p className="gym-quiet">Opening the session…</p>;
  if (view.phase === 'absent') {
    return (
      <>
        {!embedded && <Back href={from}>The log</Back>}
        <p className="gym-quiet">This session isn’t in your log.</p>
      </>
    );
  }
  if (view.phase === 'failed') {
    return (
      <>
        {!embedded && <Back href={from}>The log</Back>}
        <p className="gym-read-failed">
          The session didn’t load.
          <Button variant="secondary" size="sm" onClick={reread}>Retry</Button>
        </p>
      </>
    );
  }

  const { session } = view.data.detail;
  const settledSets = log.gone('set');
  const hiddenSets = log.hidden('set');
  const logged = setsAfter(view.data.detail.sets, moves).filter((set) => !settledSets.has(set.id));
  const sets = logged.filter((set) => !hiddenSets.has(set.id));
  const names = new Map(view.data.catalog.map((exercise) => [exercise.id, exercise.name]));
  const frozen = planFrozenLabel(session);
  const totals = workoutTotals(sets);
  if (edit && isFinished(session)) return <WorkoutEditor session={session} sets={sets} catalog={view.data.catalog} log={log} from={from} onDelete={discard} />;
  const focusedSet = fixSetId ? sets.find((set) => set.id === fixSetId) : fixing;
  if (focusedSet) return <FixSheet key={focusedSet.id} set={focusedSet} sets={sets} movement={names.get(focusedSet.exerciseId) ?? focusedSet.exerciseId} session={session} onSave={(fix) => saveFix(focusedSet, fix)} onDelete={() => dropSet(focusedSet)} onClose={closeFix} />;
  if (fixSetId) return <><Back href={`${sessionHref(id)}?from=${encodeURIComponent(from)}`}>{routineNameOf(session) ?? NO_ROUTINE}</Back><p className="gym-quiet">That set isn’t in this workout any more.</p></>;
  return (
    <>
      <header className="gym-detail-head">
        {!embedded && <Back href={from}>The log</Back>}
        <h1 className="gym-title">{routineNameOf(session) ?? NO_ROUTINE}</h1>
        <p className="gym-detail-when">{dayLabel(session.startedAt)} {new Date(session.startedAt).getFullYear()} · {timeLabel(session.startedAt)}{session.finishedAt != null ? `–${timeLabel(session.finishedAt)}` : ''}</p>
        {closedOnItsOwn(session, logged) && <p className="gym-detail-closed">{CLOSED_ITSELF_NOTE}</p>}
        <dl className="gym-reader-totals">{[[totals.sets, 'sets'], [totals.reps, 'reps'], [tonnageLabel(totals.tonnageKg) ?? '0', `${weightUnit()} external`]].map(([value, label]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </header>
      {logged.length === 0 && <p className="gym-quiet">No sets in this session.</p>}
      {groupByExercise(sets).map(([exerciseId, group]) => {
        const movementTotals = workoutTotals(group);
        const scheme = collapsedScheme(group);
        const collapsed = scheme && !expanded.has(exerciseId);
        return (
          <section className="gym-exercise" key={exerciseId}>
            <div className="gym-exercise-head">
              <h2 className="gym-exercise-name">
                <a className="gym-movement-door" href={recordHref(exerciseId, fromSession(id, `${sessionHref(id)}?from=${encodeURIComponent(from)}`))}>{names.get(exerciseId) ?? exerciseId}</a>
              </h2>
              {scheme && <button type="button" className="gym-movement-expand" aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${names.get(exerciseId) ?? exerciseId}`} aria-expanded={!collapsed} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(exerciseId)) next.delete(exerciseId); else next.add(exerciseId); return next; })}><img src={collapsed ? new URL('./logbook/assets/expand.svg', import.meta.url).href : new URL('./logbook/assets/collapse.svg', import.meta.url).href} width="12" height="12" alt="" /></button>}
              {!scheme && <span className="gym-movement-state" aria-hidden="true"><img src={new URL('./logbook/assets/collapse.svg', import.meta.url).href} width="12" height="12" alt="" /></span>}
              <span className="gym-movement-totals">{movementTotals.reps} reps · {group.filter((set) => set.kind === 'working').every((set) => set.weightKg === 0) ? 'bodyweight' : `${tonnageLabel(movementTotals.tonnageKg) ?? '0'} ${weightUnit()}`}</span>
            </div>
            {collapsed && <button type="button" className="gym-scheme-row" aria-expanded="false" onClick={() => setExpanded((current) => new Set(current).add(exerciseId))}>
              <span className="gym-set-rail" aria-label={`${group.length} recorded sets`}>{group.map((set) => <i key={set.id} />)}</span>
              <span>{scheme}</span>
            </button>}
            {!collapsed && <ul className="gym-sets">
              {group.map((set) => {
                return (
                  <li key={set.id}>
                    <button
                      type="button"
                      className={['gym-set', set.kind === 'warmup' && 'gym-set-warmup'].filter(Boolean).join(' ')}
                      onClick={() => { setFixing(set); window.location.hash = fixSetHref(id, set.id, from); }}
                    >
                      <span className="gym-set-rail" aria-hidden="true"><i /></span>
                      <span className="gym-set-load">{setLoadLabel(set)}</span>
                      {set.rpe != null && <span className="gym-set-rpe">rpe {set.rpe}</span>}
                      <span className="gym-set-tail">
                        <span className="gym-set-fix">Fix set</span>
                      </span>
                      {set.note && <span className="gym-set-note">{set.note}</span>}
                    </button>

                  </li>
                );
              })}
            </ul>}
          </section>
        );
      })}
      {embedded && isFinished(session) && <a className="gym-reader-edit-narrow" href={`${sessionHref(id)}/edit?from=${encodeURIComponent(from)}`}>Edit workout</a>}
      <details className="gym-workout-more"><summary>Workout options</summary>
        {frozen && <p className="gym-detail-plan">{frozen}</p>}
        {isFinished(session) && <a className="gym-detail-review" href={finishHref(session.id)}>Session review ›</a>}
        <ShareWorkout sessionId={id} />
        {isFinished(session) && <div className="gym-detail-discard"><button type="button" className="gym-short-discard" onClick={discard}>Discard session</button></div>}
      </details>
    </>
  );
}
