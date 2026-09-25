import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../design-system/index.js';
import { Back } from '../Back.jsx';
import { failureReason } from '../gymApi.js';
import { HistoryFilter, HistoryIndex } from '../Log.jsx';
import { groupByExercise } from '../log.js';
import { historyQuery, historyTotals } from '../logbook/history.js';
import { useHistory, useHistoryDates } from '../logbook/useHistory.js';
import { DateJump } from '../logbook/DateJump.jsx';
import { mintId } from '../mint.js';
import { ProgressCards } from '../progress/Progress.jsx';
import { consistencyLine } from '../progress/progress.js';
import { useGymRead } from '../useGymRead.js';
import { logShareDescription, logShareRequest, publicLogHref, shareHistoryScope, sharedSetScheme, shareDateLabel } from './logShare.js';
import { logShareApi } from './logShareApi.js';
import './logShare.css';

export function LogShareScreen() {
  const [draft, setDraft] = useState({ mode: 'snapshot', scope: 'all', from: '', until: '' });
  const [preview, setPreview] = useState(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const active = useGymRead(() => logShareApi.list(), []);
  const historyCount = useGymRead(() => {
    const scope = logShareRequest(draft, 'preview-count');
    if (scope.error) return Promise.resolve(null);
    return logShareApi.preview(shareHistoryScope(scope.value, { limit: 1 }));
  }, [draft.scope, draft.from, draft.until]);
  const identity = useRef(null);
  const previewBox = useRef(null);
  const detailHistory = useGymRead(() => detail?.token && !detail.revoked ? logShareApi.read(detail.token, { limit: 1 }) : Promise.resolve(null), [detail?.id, detail?.revoked]);
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
      const share = await logShareApi.create(preview);
      setDetail(share); setPreview(null); active.refresh();
    } catch (error) { setNote(`The link wasn’t created — ${failureReason(error)}.`); }
    setBusy(false);
  };
  const revoke = async () => {
    if (busy) return;
    setBusy(true); setNote('');
    try { await logShareApi.revoke(detail.id); setDetail({ ...detail, revoked: true }); active.refresh(); }
    catch (error) { setNote(`The link wasn’t revoked — ${failureReason(error)}.`); }
    setBusy(false);
  };
  if (detail) return <section className="gym-log-share is-link">
    <Back href="#/gym/log">The log</Back>
    <header className="gym-share-heading"><h1 className="gym-title">Share log</h1><p className="gym-share-subtitle">{detail.revoked ? 'Link revoked' : 'Link ready'}</p></header>
    <div className="gym-share-link-card">
      {detail.revoked ? <><p>This link no longer opens your log.</p><p className="gym-share-meta">Anyone who saved the link loses access.</p></> : <>
        <p>{detail.scope === 'all' ? `Entire history · ${detail.mode === 'live' ? 'Live updates' : 'Snapshot'}` : logShareDescription(detail)}</p>
        {detailHistory.data?.summary && <p className="gym-share-meta">{detailHistory.data.summary.sessions} completed workouts{detailHistory.data.sessions[0] ? ` through ${shareDateLabel(detailHistory.data.sessions[0].startedAt)}` : ''}.</p>}
        <p className="gym-share-meta">Expires {shareDateLabel(detail.expiresAt)}.</p>
        <input className="gym-share-url" readOnly aria-label="Share link" value={detail.url} onFocus={(event) => event.target.select()} />
        <a className="gym-share-view" href={detail.url} target="_blank" rel="noreferrer">View shared log</a>
        <p className="gym-share-meta">Anyone with the link can read it.</p>
        <button type="button" className="gym-share-revoke" disabled={busy} onClick={revoke}>{busy ? 'Revoking…' : 'Revoke link'}</button>
      </>}
    </div>
    {detail.revoked ? <Button onClick={() => { setDetail(null); setCopied(false); identity.current = null; }}>New link</Button> : <Button onClick={async () => {
      try { await navigator.clipboard.writeText(detail.url); setCopied(true); }
      catch { setNote('Copy the link from the field above.'); }
    }}>{copied ? 'Copied' : 'Copy link'}</Button>}
    {note && <p role="status">{note}</p>}
  </section>;
  if (preview) return <dialog className="gym-share-preview" aria-label="Shared log preview" tabIndex={-1} ref={previewBox} onCancel={(event) => { event.preventDefault(); setPreview(null); }}>
    <div className="gym-share-preview-content">
      <header className="gym-public-head"><span>Windmill</span><span>Preview</span><Back href="#/gym/share-log" onClick={(event) => { event.preventDefault(); setPreview(null); }}>Share log</Back></header>
      <ReadOnlyLog key={preview.id} preview={preview} onReady={setPreviewReady} />
      {note && <p role="status">{note}</p>}
      <div className="gym-share-preview-actions"><Button disabled={busy || !previewReady} onClick={create}>{busy ? 'Creating…' : 'Create link'}</Button></div>
    </div>
  </dialog>;
  return <section className="gym-log-share">
    <Back href="#/gym/log">The log</Back>
    <header className="gym-share-heading"><h1 className="gym-title">Share log</h1><p className="gym-share-subtitle">Let someone read your training.</p></header>
    <div className="gym-share-scope">
      <div className="gym-share-group">
        <fieldset className="gym-share-choice"><legend>History</legend>
          {[['all', 'Entire history'], ['range', 'Date range']].map(([value, label]) => <button type="button" key={value} aria-pressed={draft.scope === value} onClick={() => change({ scope: value })}>{label}</button>)}
        </fieldset>
        {draft.scope === 'range' && <div className="gym-share-dates"><label>From<input type="date" value={draft.from} onChange={(event) => change({ from: event.target.value })} /></label><label>Through<input type="date" value={draft.until} onChange={(event) => change({ until: event.target.value })} /></label></div>}
        {historyCount.data?.summary && <p className="gym-share-meta">{historyCount.data.summary.sessions} completed workouts{historyCount.data.sessions[0] ? ` through ${shareDateLabel(historyCount.data.sessions[0].startedAt)}` : ''}.</p>}
      </div>
      <div className="gym-share-group">
        <fieldset className="gym-share-choice"><legend>Updates</legend>
          {[['snapshot', 'Snapshot'], ['live', 'Live updates']].map(([value, label]) => <button type="button" key={value} aria-pressed={draft.mode === value} onClick={() => change({ mode: value })}>{label}</button>)}
        </fieldset>
        <p className="gym-share-meta">{draft.mode === 'snapshot' ? 'New workouts stay private.' : draft.scope === 'range' ? 'Workouts and corrections in this range update the link.' : 'New workouts and corrections update the link.'}</p>
      </div>
      <div className="gym-share-disclosure"><strong>Workouts and sets</strong><p>Movements, load, reps, dates and duration.</p><p>Notes and Coach chats stay private.</p></div>
      <div className="gym-share-group"><p className="gym-share-meta">Anyone with the link can read it.</p><p className="gym-share-meta">Expires after 30 days. Revoke anytime.</p></div>
      {note && <p role="alert">{note}</p>}
      <Button onClick={openPreview}>Preview</Button>
    </div>
    {(active.phase !== 'ready' || active.data?.length > 0) && <section className="gym-share-active"><h2>Active links</h2>
      {active.phase === 'loading' && <p>Opening your links…</p>}
      {active.phase === 'failed' && <Button variant="secondary" onClick={active.retry}>Retry links</Button>}
      {active.data?.map((share) => <button type="button" className="gym-share-active-row" key={share.id} onClick={() => setDetail(share)}><span>{logShareDescription(share)}</span><span>Expires {shareDateLabel(share.expiresAt)} ›</span></button>)}
    </section>}
  </section>;
}

export function SharedLogScreen({ token, hash = globalThis.location?.hash ?? '' }) {
  return <section className="gym-public-log">
    <header className="gym-public-head"><span>Windmill</span><span>Read-only</span></header>
    <ReadOnlyLog key={token} token={token} hash={hash} />
  </section>;
}

export function ReadOnlyLog({ token = null, preview = null, hash = '', onReady = null }) {
  const [olderFor, setOlderFor] = useState(null);
  const initialSelection = useRef(false);
  const [localFilters, setLocalFilters] = useState({ year: null, month: null, exercise: '', routine: '', density: 'comfortable', selected: null });
  const filters = preview ? localFilters : historyQuery(hash);
  const wide = globalThis.window?.matchMedia?.('(min-width: 800px)')?.matches === true;
  const api = useMemo(() => ({ history: (query) => {
    if (!preview) return logShareApi.read(token, query);
    const scope = shareHistoryScope(preview, query);
    if (scope.from >= scope.until) return Promise.resolve({ sessions: [], summary: { sessions: 0, sets: 0, reps: 0, tonnageKg: 0 }, months: [], exercises: [], routines: [], next: null });
    return logShareApi.preview(scope);
  } }), [token, preview]);
  const history = useHistory(filters, 0, api);
  const dates = useHistoryDates(filters, 0, api);
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
  if (history.failure) return <div className="gym-share-unavailable"><h1 className="gym-title">This log isn’t available</h1><p>The link may have expired or been revoked.</p><Button variant="secondary" onClick={history.retry}>Retry</Button></div>;
  const consistency = consistencyLine(history.data?.progress);
  const progressLog = { progress: { phase: 'ready', data: history.data?.progress }, catalog: history.data?.exercises ?? [] };
  return <div className={`gym-read-only-log${selected ? ' has-session' : ''}`}>
    {share && <p className="gym-public-scope">{logShareDescription(share)}{share.mode === 'snapshot' && share.createdAt ? ` · through ${shareDateLabel(share.createdAt)}` : ''}</p>}
    <h1 className="gym-title">Training log</h1>
    <div className="gym-history-filters">
      <DateJump year={filters.year} month={filters.month} months={dates.months} failure={dates.failure} onRetry={dates.retry} onChange={(change) => move({ ...change, selected: null })} />
      <HistoryFilter label="Movement" value={filters.exercise} options={history.data?.exercises ?? []} onChange={(exercise) => move({ exercise, selected: null })} />
      <HistoryFilter label="Routine" value={filters.routine} options={history.data?.routines ?? []} onChange={(routine) => move({ routine, selected: null })} />
    </div>
    <p className="gym-log-count">{historyTotals(history.data?.summary, 'kg')}</p>
    {history.phase === 'loading' && !history.data && <p className="gym-quiet">Opening the shared log…</p>}
    {history.phase === 'ready' && sessions.length === 0 && <section className="gym-history-empty"><p>No workouts match these filters.</p><Button onClick={() => move({ year: null, month: null, exercise: '', routine: '', selected: null })}>Clear filters</Button></section>}
    {!selected && consistency && <p className="gym-public-consistency">{consistency}</p>}
    {sessions.length > 0 && <div className="gym-history-workspace">
      <aside className={`gym-history-index is-${filters.density}`} aria-label="Workout history" onClick={preview ? (event) => {
        const anchor = event.target.closest('a[data-session], a[href]');
        if (!anchor) return;
        event.preventDefault(); setLocalFilters(historyQuery(anchor.getAttribute('href')));
      } : undefined}>
        <HistoryIndex unit="kg" dense={history.data?.summary?.sessions > 50 || filters.density === 'compact'} sessions={sessions} selected={selected?.id} hrefOf={(session) => publicLogHref(token ?? 'preview', { ...filters, selected: session.id })} />
        {history.data?.next ? <button type="button" className="gym-older" disabled={history.more === 'loading'} onClick={history.load}>{history.more === 'loading' ? 'Loading…' : history.more === 'failed' ? 'Retry older workouts' : 'Load older'}</button> : sessions.length > 0 && <p className="gym-share-meta">End of history</p>}
      </aside>
      <div className="gym-history-detail">
        {filters.selected && !selected ? <p className="gym-quiet">{history.data?.next ? 'Opening the selected workout…' : 'That workout is not in this shared history.'}</p> : selected ? <SharedWorkoutReader catalog={history.data?.exercises ?? []} session={selected} previous={sessions[sessions.indexOf(selected) + 1]} next={sessions[sessions.indexOf(selected) - 1]} onSelect={(id) => move({ selected: id })} onBack={() => move({ selected: null })} hasOlder={Boolean(history.data?.next)} onOlder={() => setOlderFor(selected.id)} olderBusy={Boolean(olderFor)} /> : <><div className="gym-progress-head"><h2 className="gym-section-title">Progress</h2>{consistency && <p className="gym-consistency">{consistency}</p>}</div><ProgressCards log={progressLog} readOnly unit="kg" /></>}
      </div>
    </div>}
    {!preview && <p className="gym-public-private">Coach and Notes are not shared.</p>}
  </div>;
}

export function SharedWorkoutReader({ catalog = [], session, previous, next, onSelect, onBack, hasOlder, onOlder, olderBusy }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const date = new Date(session.startedAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const clock = (at) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return <article className="gym-shared-reader">
    <nav className="gym-reader-neighbors">
      <button className="gym-shared-back" type="button" onClick={onBack}>← The log</button>
      <button type="button" disabled={olderBusy || (!previous && !hasOlder)} onClick={() => previous ? onSelect(previous.id) : onOlder()}>{olderBusy ? 'Loading…' : <>← Previous<span className="gym-reader-nav-long"> workout</span></>}</button>
      <button type="button" disabled={!next} onClick={() => onSelect(next.id)}>Next<span className="gym-reader-nav-long"> workout</span> →</button>
    </nav>
    <h2 className="gym-title">{session.routineName || 'Free session'}</h2>
    <p className="gym-detail-when">{date} · {clock(session.startedAt)}–{clock(session.finishedAt)}</p>
    <dl className="gym-reader-totals"><div><dt>sets</dt><dd>{session.workingSetCount ?? session.setCount}</dd></div><div><dt>reps</dt><dd>{session.reps}</dd></div><div><dt>kg external</dt><dd>{number.format(session.tonnageKg)}</dd></div></dl>
    {groupByExercise(session.sets ?? []).map(([exerciseId, sets]) => {
      const scheme = sharedSetScheme(sets);
      const collapsed = scheme && !expanded.has(exerciseId);
      const totals = session.movements?.find((movement) => movement.exerciseId === exerciseId);
      const bodyweight = catalog.find((movement) => movement.id === exerciseId)?.equipment === 'bodyweight';
      return <section className="gym-share-movement" key={exerciseId}>
        <header>
          <h3>{sets[0].exercise}</h3>
          {scheme ? <button type="button" className="gym-movement-expand" aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${sets[0].exercise}`} aria-expanded={!collapsed} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(exerciseId)) next.delete(exerciseId); else next.add(exerciseId); return next; })}><img src={collapsed ? new URL('../logbook/assets/expand.svg', import.meta.url).href : new URL('../logbook/assets/collapse.svg', import.meta.url).href} width="12" height="12" alt="" /></button> : <span className="gym-movement-state" aria-hidden="true"><img src={new URL('../logbook/assets/collapse.svg', import.meta.url).href} width="12" height="12" alt="" /></span>}
          {totals && <p>{totals.reps} reps · {bodyweight && totals.tonnageKg === 0 ? 'bodyweight' : `${number.format(totals.tonnageKg)} kg`}</p>}
        </header>
        {collapsed ? <button type="button" className="gym-share-scheme" aria-expanded="false" aria-label={`Show every set of ${sets[0].exercise}`} onClick={() => setExpanded((current) => new Set([...current, exerciseId]))}><span className="gym-share-ticks" aria-hidden="true">{sets.map((set) => <i key={set.id} />)}</span>{scheme}</button> : <ul className="gym-share-sets">{sets.map((set) => <li key={set.id}><i aria-hidden="true" /><span className="gym-share-set-line"><span>{set.weightKg === 0 ? 'bodyweight' : number.format(set.weightKg)}</span><span className="gym-share-set-times">×</span><span>{set.reps}</span></span>{set.rpe != null && <span>RPE {set.rpe}</span>}</li>)}</ul>}
      </section>;
    })}
    {(session.sets ?? []).length === 0 && <p>No sets in this workout.</p>}
  </article>;
}
