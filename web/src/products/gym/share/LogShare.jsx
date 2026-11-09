import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { failureReason } from '../errors.js';
import { t } from '../i18n/index.js';
import { HistoryFilter, HistoryIndex } from '../Log.jsx';
import { groupByExercise } from '../log.js';
import { historyQuery, historyTotals } from '../logbook/history.js';
import { useHistory, useHistoryDates } from '../logbook/useHistory.js';
import { DateJump } from '../logbook/DateJump.jsx';
import { mintId } from '../mint.js';
import { ProgressCards } from '../progress/Progress.jsx';
import { consistencyLine } from '../progress/progress.js';
import { useGymRead } from '../useGymRead.js';
import { useGymApi } from '../gymRuntime.js';
import { logShareDescription, logShareRequest, publicLogHref, shareHistoryScope, sharedSetScheme, shareDateLabel } from './logShare.js';
import { gymApi } from '../gymApi.js';
import './logShare.css';

export function LogShareScreen() {
  const api = useGymApi();
  const [draft, setDraft] = useState({ mode: 'snapshot', scope: 'all', from: '', until: '' });
  const [preview, setPreview] = useState(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const active = useGymRead(() => gymApi.logShares(), []);
  const historyCount = useGymRead(() => {
    const scope = logShareRequest(draft, 'preview-count');
    if (scope.error) return Promise.resolve(null);
    return api.history({ ...shareHistoryScope(scope.value, { limit: 1 }), projection: 'progress' });
  }, [draft.scope, draft.from, draft.until], { sync: true, ready: Boolean(api?.ready) });
  const identity = useRef(null);
  const previewBox = useRef(null);
  const detailHistory = useGymRead(() => detail?.token && !detail.revoked ? gymApi.sharedLog(detail.token, { limit: 1 }) : Promise.resolve(null), [detail?.id, detail?.revoked]);
  useEffect(() => {
    if (!preview) return;
    const opener = document.activeElement;
    previewBox.current?.showModal?.();
    previewBox.current?.focus();
    const key = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); setPreview(null); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(previewBox.current?.querySelectorAll('a[href],button:not(:disabled),input,select,[tabindex="0"]') ?? []).filter((element) => element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === previewBox.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      if (opener?.isConnected && opener !== document.body) opener.focus();
      else globalThis.requestAnimationFrame?.(() => document.querySelector?.('.gym-share-scope > button')?.focus());
    };
  }, [Boolean(preview)]);
  const change = (fields) => { setDraft({ ...draft, ...fields }); setPreview(null); identity.current = null; setNote(''); };
  const openPreview = () => {
    if (!identity.current) identity.current = mintId('lsh_');
    const result = logShareRequest(draft, identity.current);
    if (result.error) { setNote(result.error); return; }
    setNote(''); setPreviewReady(false); setPreview(result.value);
  };
  const create = async () => {
    if (!preview || !previewReady || busy) return;
    setBusy(true); setNote('');
    try {
      const share = await gymApi.createLogShare(preview);
      setDetail(share); setPreview(null); active.refresh();
    } catch (error) { setNote(t('gym.share.logNotCreated', { reason: failureReason(error) })); }
    setBusy(false);
  };
  const revoke = async () => {
    if (busy) return;
    setBusy(true); setNote('');
    try { await gymApi.revokeLogShare(detail.id); setDetail({ ...detail, revoked: true }); active.refresh(); }
    catch (error) { setNote(t('gym.share.logNotRevoked', { reason: failureReason(error) })); }
    setBusy(false);
  };
  if (detail) return <section className="gym-log-share is-link">
    <Back href="#/gym/log">{t('gym.share.backToLog')}</Back>
    <header className="gym-share-heading"><h1 className="gym-title">{t('gym.share.logTitle')}</h1><p className="gym-share-subtitle">{detail.revoked ? t('gym.share.linkRevoked') : t('gym.share.linkReady')}</p></header>
    <div className="gym-share-link-card">
      {detail.revoked ? <><p>{t('gym.share.revokedBody')}</p><p className="gym-share-meta">{t('gym.share.revokedMeta')}</p></> : <>
        <p>{detail.scope === 'all' ? t('gym.share.entireHistoryMode', { mode: detail.mode }) : logShareDescription(detail)}</p>
        {detailHistory.data?.summary && <p className="gym-share-meta">{detailHistory.data.sessions[0]
          ? t('gym.share.completedThrough', { count: detailHistory.data.summary.sessions, day: shareDateLabel(detailHistory.data.sessions[0].startedAt) })
          : t('gym.share.completed', { count: detailHistory.data.summary.sessions })}</p>}
        <p className="gym-share-meta">{t('gym.share.expires', { day: shareDateLabel(detail.expiresAt) })}</p>
        <input className="gym-share-url" readOnly aria-label={t('gym.share.shareLinkLabel')} value={detail.url} onFocus={(event) => event.target.select()} />
        <a className="gym-share-view" href={detail.url} target="_blank" rel="noreferrer">{t('gym.share.viewLog')}</a>
        <p className="gym-share-meta">{t('gym.share.anyoneCanRead')}</p>
        <button type="button" className="gym-share-revoke" disabled={busy} onClick={revoke}>{busy ? t('gym.share.revoking') : t('gym.share.revokeLink')}</button>
      </>}
    </div>
    {detail.revoked ? <Button onClick={() => { setDetail(null); setCopied(false); identity.current = null; }}>{t('gym.share.newLink')}</Button> : <Button onClick={async () => {
      try { await navigator.clipboard.writeText(detail.url); setCopied(true); }
      catch { setNote(t('gym.share.copyByHand')); }
    }}>{copied ? t('gym.share.copied') : t('gym.share.copy')}</Button>}
    {note && <p role="status">{note}</p>}
  </section>;
  if (preview) return <dialog className="gym-share-preview" aria-label={t('gym.share.previewLabel')} tabIndex={-1} ref={previewBox} onCancel={(event) => { event.preventDefault(); setPreview(null); }}>
    <div className="gym-share-preview-content">
      <header className="gym-public-head"><span>Windmill</span><span>{t('gym.share.previewTag')}</span><Back href="#/gym/share-log" onClick={(event) => { event.preventDefault(); setPreview(null); }}>{t('gym.share.logTitle')}</Back></header>
      <ReadOnlyLog key={preview.id} preview={preview} onReady={setPreviewReady} />
      {note && <p role="status">{note}</p>}
      <div className="gym-share-preview-actions"><Button disabled={busy || !previewReady} onClick={create}>{busy ? t('gym.share.creating') : t('gym.share.createLink')}</Button></div>
    </div>
  </dialog>;
  return <section className="gym-log-share">
    <Back href="#/gym/log">{t('gym.share.backToLog')}</Back>
    <header className="gym-share-heading"><h1 className="gym-title">{t('gym.share.logTitle')}</h1><p className="gym-share-subtitle">{t('gym.share.logSubtitle')}</p></header>
    <div className="gym-share-scope">
      <div className="gym-share-group">
        <fieldset className="gym-share-choice"><legend>{t('gym.share.historyLegend')}</legend>
          {[['all', t('gym.share.entireHistory')], ['range', t('gym.share.dateRange')]].map(([value, label]) => <button type="button" key={value} aria-pressed={draft.scope === value} onClick={() => change({ scope: value })}>{label}</button>)}
        </fieldset>
        {draft.scope === 'range' && <div className="gym-share-dates"><label>{t('gym.share.from')}<input type="date" value={draft.from} onChange={(event) => change({ from: event.target.value })} /></label><label>{t('gym.share.through')}<input type="date" value={draft.until} onChange={(event) => change({ until: event.target.value })} /></label></div>}
        {historyCount.data?.summary && <p className="gym-share-meta">{historyCount.data.sessions[0]
          ? t('gym.share.completedThrough', { count: historyCount.data.summary.sessions, day: shareDateLabel(historyCount.data.sessions[0].startedAt) })
          : t('gym.share.completed', { count: historyCount.data.summary.sessions })}</p>}
      </div>
      <div className="gym-share-group">
        <fieldset className="gym-share-choice"><legend>{t('gym.share.updatesLegend')}</legend>
          {[['snapshot', t('gym.share.snapshot')], ['live', t('gym.share.liveUpdates')]].map(([value, label]) => <button type="button" key={value} aria-pressed={draft.mode === value} onClick={() => change({ mode: value })}>{label}</button>)}
        </fieldset>
        <p className="gym-share-meta">{draft.mode === 'snapshot' ? t('gym.share.snapshotMeta') : draft.scope === 'range' ? t('gym.share.liveRangeMeta') : t('gym.share.liveMeta')}</p>
      </div>
      <div className="gym-share-disclosure"><strong>{t('gym.share.disclosureTitle')}</strong><p>{t('gym.share.disclosureShared')}</p><p>{t('gym.share.disclosurePrivate')}</p></div>
      <div className="gym-share-group"><p className="gym-share-meta">{t('gym.share.anyoneCanRead')}</p><p className="gym-share-meta">{t('gym.share.expiryTerms')}</p></div>
      {note && <p role="alert">{note}</p>}
      <Button onClick={openPreview}>{t('gym.share.preview')}</Button>
    </div>
    {(active.phase !== 'ready' || active.data?.length > 0) && <section className="gym-share-active"><h2>{t('gym.share.activeLinks')}</h2>
      {active.phase === 'loading' && <p>{t('gym.share.openingLinks')}</p>}
      {active.phase === 'failed' && <Button variant="secondary" onClick={active.retry}>{t('gym.share.retryLinks')}</Button>}
      {active.data?.map((share) => <button type="button" className="gym-share-active-row" key={share.id} onClick={() => setDetail(share)}><span>{logShareDescription(share)}</span><span>{t('gym.share.expiresRow', { day: shareDateLabel(share.expiresAt) })}</span></button>)}
    </section>}
  </section>;
}

export function SharedLogScreen({ token, hash = globalThis.location?.hash ?? '' }) {
  return <section className="gym-public-log">
    <header className="gym-public-head"><span>Windmill</span><span>{t('gym.share.readOnly')}</span></header>
    <ReadOnlyLog key={token} token={token} hash={hash} />
  </section>;
}

export function ReadOnlyLog({ token = null, preview = null, hash = '', onReady = null }) {
  const localApi = useGymApi();
  const [olderFor, setOlderFor] = useState(null);
  const initialSelection = useRef(false);
  const [localFilters, setLocalFilters] = useState({ year: null, month: null, exercise: '', routine: '', density: 'comfortable', selected: null });
  const filters = preview ? localFilters : historyQuery(hash);
  const wide = globalThis.window?.matchMedia?.('(min-width: 800px)')?.matches === true;
  const api = useMemo(() => ({ history: (query) => {
    if (!preview) return gymApi.sharedLog(token, query);
    const scope = shareHistoryScope(preview, query);
    if (scope.from >= scope.until) return Promise.resolve({ sessions: [], summary: { sessions: 0, sets: 0, reps: 0, tonnageKg: 0 }, months: [], exercises: [], routines: [], next: null });
    return localApi.history({ ...scope, projection: 'progress' });
  }, live: Boolean(preview), ready: !preview || Boolean(localApi?.ready) }), [token, preview, localApi]);
  const history = useHistory(filters, api);
  const dates = useHistoryDates(filters, api);
  useEffect(() => { onReady?.(history.phase === 'ready'); }, [history.phase, onReady]);
  useEffect(() => {
    if (preview && history.phase === 'ready' && !initialSelection.current && wide) {
      initialSelection.current = true;
      setLocalFilters((current) => ({ ...current, selected: history.data?.sessions[0]?.id ?? null }));
    }
  }, [preview, history.phase, wide]);
  const sessions = history.data?.sessions ?? [];
  const selectedId = filters.selected ?? (wide && (filters.year || filters.exercise || filters.routine) ? sessions[0]?.id : null);
  const selected = sessions.find((session) => session.id === selectedId);
  const share = preview ?? history.data?.share;
  const move = (change) => {
    const next = { ...filters, ...change };
    if (preview) setLocalFilters(next);
    else window.location.hash = publicLogHref(token, next);
  };
  useEffect(() => {
    if (history.phase !== 'ready' || history.more !== 'idle') return;
    if (filters.selected && !selected && history.data?.next) history.load();
    if (olderFor) {
      const index = sessions.findIndex((session) => session.id === olderFor);
      if (index >= 0 && sessions[index + 1]) { move({ selected: sessions[index + 1].id }); setOlderFor(null); }
      else if (history.data?.next) history.load();
      else setOlderFor(null);
    }
  }, [filters.selected, selected, history.phase, history.more, history.data, olderFor]);
  if (history.failure) return <div className="gym-share-unavailable"><h1 className="gym-title">{t('gym.share.logUnavailable')}</h1><p>{t('gym.share.logUnavailableBody')}</p><Button variant="secondary" onClick={history.retry}>{t('gym.common.retry')}</Button></div>;
  const consistency = consistencyLine(history.data?.progress);
  const progressLog = { progress: { phase: 'ready', data: history.data?.progress }, catalog: history.data?.exercises ?? [] };
  return <div className={`gym-read-only-log${selected ? ' has-session' : ''}`}>
    {share && <p className="gym-public-scope">{share.mode === 'snapshot' && share.createdAt
      ? t('gym.share.scopeThrough', { scope: logShareDescription(share), day: shareDateLabel(share.createdAt) })
      : logShareDescription(share)}</p>}
    <h1 className="gym-title">{t('gym.share.trainingLog')}</h1>
    <div className="gym-history-filters">
      <DateJump year={filters.year} month={filters.month} months={dates.months} failure={dates.failure} onRetry={dates.retry} onChange={(change) => move({ ...change, selected: null })} />
      <HistoryFilter kind="exercise" value={filters.exercise} options={history.data?.exercises ?? []} onChange={(exercise) => move({ exercise, selected: null })} />
      <HistoryFilter kind="routine" value={filters.routine} options={history.data?.routines ?? []} onChange={(routine) => move({ routine, selected: null })} />
    </div>
    <p className="gym-log-count">{historyTotals(history.data?.summary, 'kg')}</p>
    {history.phase === 'loading' && !history.data && <p className="gym-quiet">{t('gym.share.openingLog')}</p>}
    {history.phase === 'ready' && sessions.length === 0 && <section className="gym-history-empty"><p>{t('gym.logbook.noMatches')}</p><Button onClick={() => move({ year: null, month: null, exercise: '', routine: '', selected: null })}>{t('gym.share.clearFilters')}</Button></section>}
    {!selected && consistency && <p className="gym-public-consistency">{consistency}</p>}
    {sessions.length > 0 && <div className="gym-history-workspace">
      <aside className={`gym-history-index is-${filters.density}`} aria-label={t('gym.share.historyLabel')} onClick={preview ? (event) => {
        const anchor = event.target.closest('a[data-session], a[href]');
        if (!anchor) return;
        event.preventDefault(); setLocalFilters(historyQuery(anchor.getAttribute('href')));
      } : undefined}>
        <HistoryIndex unit="kg" dense={history.data?.summary?.sessions > 50 || filters.density === 'compact'} sessions={sessions} selected={selected?.id} hrefOf={(session) => publicLogHref(token ?? 'preview', { ...filters, selected: session.id })} />
        {history.data?.next ? <button type="button" className="gym-older" disabled={history.more === 'loading'} onClick={history.load}>{history.more === 'loading' ? t('gym.share.loading') : history.more === 'failed' ? t('gym.share.retryOlder') : t('gym.share.loadOlder')}</button> : sessions.length > 0 && <p className="gym-share-meta">{t('gym.share.endOfHistory')}</p>}
      </aside>
      <div className="gym-history-detail">
        {filters.selected && !selected ? <p className="gym-quiet">{history.data?.next ? t('gym.share.openingSelected') : t('gym.share.notInHistory')}</p> : selected ? <SharedWorkoutReader catalog={history.data?.exercises ?? []} session={selected} previous={sessions[sessions.indexOf(selected) + 1]} next={sessions[sessions.indexOf(selected) - 1]} onSelect={(id) => move({ selected: id })} onBack={() => move({ selected: null })} hasOlder={Boolean(history.data?.next)} onOlder={() => setOlderFor(selected.id)} olderBusy={Boolean(olderFor)} /> : <><div className="gym-progress-head"><h2 className="gym-section-title">{t('gym.share.progress')}</h2>{consistency && <p className="gym-consistency">{consistency}</p>}</div><ProgressCards log={progressLog} readOnly unit="kg" /></>}
      </div>
    </div>}
    {!preview && <p className="gym-public-private">{t('gym.share.coachNotShared')}</p>}
  </div>;
}

export function SharedWorkoutReader({ catalog = [], session, previous, next, onSelect, onBack, hasOlder, onOlder, olderBusy }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const date = new Date(session.startedAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const clock = (at) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return <article className="gym-shared-reader">
    <nav className="gym-reader-neighbors">
      <button className="gym-shared-back" type="button" onClick={onBack}>{t('gym.share.readerBack')}</button>
      <button type="button" disabled={olderBusy || (!previous && !hasOlder)} onClick={() => previous ? onSelect(previous.id) : onOlder()}>{olderBusy ? t('gym.share.loading') : t('gym.share.previous', { workout: <span className="gym-reader-nav-long">{t('gym.share.navWorkout')}</span> })}</button>
      <button type="button" disabled={!next} onClick={() => onSelect(next.id)}>{t('gym.share.next', { workout: <span className="gym-reader-nav-long">{t('gym.share.navWorkout')}</span> })}</button>
    </nav>
    <h2 className="gym-title">{session.routineName || t('gym.share.freeSession')}</h2>
    <p className="gym-detail-when">{date} · {clock(session.startedAt)}–{clock(session.finishedAt)}</p>
    <dl className="gym-reader-totals"><div><dt>{t('gym.share.totalSets')}</dt><dd>{session.workingSetCount ?? session.setCount}</dd></div><div><dt>{t('gym.share.totalReps')}</dt><dd>{session.reps}</dd></div><div><dt>{t('gym.share.totalExternal')}</dt><dd>{session.tonnageKg === null ? '—' : number.format(session.tonnageKg)}</dd></div></dl>
    {groupByExercise(session.sets ?? []).map(([exerciseId, sets]) => {
      const scheme = sharedSetScheme(sets);
      const collapsed = scheme && !expanded.has(exerciseId);
      const totals = session.movements?.find((movement) => movement.exerciseId === exerciseId);
      const bodyweight = catalog.find((movement) => movement.id === exerciseId)?.equipment === 'bodyweight';
      return <section className="gym-share-movement" key={exerciseId}>
        <header>
          <h3>{sets[0].exercise}</h3>
          {scheme ? <button type="button" className="gym-movement-expand" aria-label={collapsed ? t('gym.share.expandMovement', { movement: sets[0].exercise }) : t('gym.share.collapseMovement', { movement: sets[0].exercise })} aria-expanded={!collapsed} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(exerciseId)) next.delete(exerciseId); else next.add(exerciseId); return next; })}><img src={collapsed ? new URL('../logbook/assets/expand.svg', import.meta.url).href : new URL('../logbook/assets/collapse.svg', import.meta.url).href} width="12" height="12" alt="" /></button> : <span className="gym-movement-state" aria-hidden="true"><img src={new URL('../logbook/assets/collapse.svg', import.meta.url).href} width="12" height="12" alt="" /></span>}
          {totals && <p>{bodyweight && totals.tonnageKg === 0
            ? t('gym.share.movementBodyweight', { reps: totals.reps })
            : t('gym.share.movementLoad', { reps: totals.reps, load: totals.tonnageKg === null ? '—' : number.format(totals.tonnageKg) })}</p>}
        </header>
        {collapsed ? <button type="button" className="gym-share-scheme" aria-expanded="false" aria-label={t('gym.share.showEverySet', { movement: sets[0].exercise })} onClick={() => setExpanded((current) => new Set([...current, exerciseId]))}><span className="gym-share-ticks" aria-hidden="true">{sets.map((set) => <i key={set.id} />)}</span>{scheme}</button> : <ul className="gym-share-sets">{sets.map((set) => <li key={set.id}><i aria-hidden="true" /><span className="gym-share-set-line"><span>{set.weightKg === 0 ? t('gym.share.bodyweight') : number.format(set.weightKg)}</span><span className="gym-share-set-times">×</span><span>{set.reps}</span></span>{set.rpe != null && <span>{t('gym.share.rpeUpper', { rpe: set.rpe })}</span>}</li>)}</ul>}
      </section>;
    })}
    {(session.sets ?? []).length === 0 && <p>{t('gym.share.noSetsInWorkout')}</p>}
  </article>;
}
