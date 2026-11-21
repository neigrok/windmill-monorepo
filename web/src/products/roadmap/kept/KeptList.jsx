// §6 The one list of what cannot land (flow 49, boards 49.01–49.08). From 1024px it is a dialog over the page: the list,
// and beside it the change it has selected with Copy. Below, it is a page of its own: the list with its count and Close,
// a page for each change with Copy, Copied or Copy failed with Select text, and Discard, which asks once on a page of its
// own; Back returns to the list. The list closes when it holds nothing, and from 1024px the change offers no Discard and
// says nothing of a copy: the boards draw none of those states yet.

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../../design-system';
import { wrapTab } from '../../../design-system/feedback/dialogFocus.js';
import { useAppearance } from '../../../shell/useAppearance.js';
import { APP_LOCALE } from '../../../platform/i18n/index.js';
import { track } from '../../../telemetry/beacon.js';
import { ActionRunner, EngineReplica } from '../../../platform/domain-kit/runner.js';
import { FixedZone } from '../../../platform/domain-kit/time.js';
import { DiscardKept } from '../domain/carry.js';
import { reportRoadmapFailure } from '../reportFailure.js';
import { t } from '../i18n/index.js';
import { RoadmapNames, keptChanges } from './KeptChanges.js';
import './kept.css';

const WIDE = '(min-width: 1024px)';
const CLIPBOARD_REFUSALS = new Set(['NotAllowedError', 'SecurityError']);

const REASONS = {
  roadmapDeleted: t('roadmap.kept.reason.roadmapDeleted'),
  capFilled: t('roadmap.kept.reason.capFilled'),
  accessEnded: t('roadmap.kept.reason.accessEnded'),
  noteTooLong: t('roadmap.kept.reason.noteTooLong'),
};

// The changes the list shows: those with words of their own, for a reason the boards give words to. A record the
// carry-over kept whole past its bound (pastBound) waits for its words (proposal 49.21).
export function listed(kept) {
  return kept.filter((change) => change.worded && Object.hasOwn(REASONS, change.reason));
}

// A record the carry-over set aside, discarded from its ledger, the engine keeping no Undo of it. Answers false where the
// ledger no longer held it.
async function discardCarried(engine, change) {
  const runner = new ActionRunner(new EngineReplica(engine), engine.registry, new FixedZone(0));
  const outcome = await runner.runAct(new DiscardKept(change.carriedFrom, change.ledgerId));
  if (outcome.kind !== 'committed') return false;
  await runner.release(outcome.receipt.gestureId);
  return true;
}

function useWide() {
  const subscribe = useCallback((changed) => {
    const query = window.matchMedia(WIDE);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  return useSyncExternalStore(subscribe, () => window.matchMedia(WIDE).matches, () => true);
}

// The names the device holds of what each listed roadmap holds, read from its tree scope while the list is open.
function useRoadmapNames(engine, notices) {
  const roadmaps = [...new Set(notices.map((notice) => RoadmapNames.roadmapOf(notice.scope)).filter(Boolean))].sort();
  const [names, setNames] = useState(RoadmapNames.NONE);
  useEffect(() => {
    const holds = roadmaps.map((roadmap) => engine.observe(`tree/${roadmap}`));
    const read = () => setNames(RoadmapNames.read(holds.map((hold, index) => [roadmaps[index], hold.getSnapshot().drawn])));
    const stops = holds.map((hold) => hold.subscribe(read));
    read();
    return () => {
      stops.forEach((stop) => stop());
      holds.forEach((hold) => hold.release());
    };
  }, [engine, roadmaps.join('\n')]);
  return names;
}

export function KeptList({ engine, notices, carried = [], onClose }) {
  const { resolved: theme } = useAppearance();
  const wide = useWide();
  const names = useRoadmapNames(engine, notices);
  const kept = useMemo(() => listed(keptChanges(notices, engine.registry, names, carried).kept), [notices, engine, names, carried]);
  const [chosen, setChosen] = useState(null);
  const [asking, setAsking] = useState(false);
  const [copied, setCopied] = useState(null);
  const layer = useRef(null);
  const words = useRef(null);
  const opener = useRef(typeof document === 'undefined' ? null : document.activeElement);
  const focusNext = useRef({ title: true });
  const copies = useRef(0);
  const titleId = useId();
  const change = kept.find((each) => each.id === chosen) ?? (wide ? kept[0] ?? null : null);
  const page = asking && change ? 'ask' : change && !wide ? 'change' : 'list';
  const copy = copied !== null && copied.id === change?.id ? copied.outcome : null;

  useEffect(() => { if (kept.length === 0) onClose(); }, [kept.length]);
  useEffect(() => () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }, []);
  // Each page takes focus on its title; Back hands it to the row that opened the change, and Keep to Discard.
  useLayoutEffect(() => {
    const next = focusNext.current;
    focusNext.current = { title: true };
    const target = next.row !== undefined ? [...layer.current.querySelectorAll('[data-kept-row]')].find((row) => row.dataset.keptRow === next.row)
      : next.discard ? layer.current.querySelector('.st-kept-discard button') : next.title ? layer.current.querySelector('h2') : null;
    target?.focus({ preventScroll: true });
  }, [page, wide]);

  const choose = (id) => {
    copies.current += 1;
    setCopied(null);
    setChosen(id);
  };
  const back = () => {
    focusNext.current = { row: chosen };
    choose(null);
  };
  const keep = () => {
    focusNext.current = { discard: true };
    setAsking(false);
  };
  const copyText = async () => {
    const attempt = ++copies.current;
    const shown = change;
    try {
      await navigator.clipboard.writeText(shown.text);
      track('roadmap_kept', { step: 'copy', reason: shown.reason, outcome: 'copied' });
      if (copies.current === attempt) setCopied({ id: shown.id, outcome: 'copied' });
    } catch (error) {
      if (navigator.clipboard && !CLIPBOARD_REFUSALS.has(error?.name)) reportRoadmapFailure('roadmap-kept-copy', error);
      track('roadmap_kept', { step: 'copy', reason: shown.reason, outcome: 'failed' });
      if (copies.current === attempt) setCopied({ id: shown.id, outcome: 'failed' });
    }
  };
  const selectText = () => {
    window.getSelection()?.selectAllChildren(words.current);
    words.current.focus({ preventScroll: true });
    track('roadmap_kept', { step: 'select', reason: change.reason });
  };
  // The engine answers `false` for a notice it no longer holds, and the ledger for a record it no longer keeps, each
  // discarded in another tab: the change closes quietly.
  const discard = async () => {
    const shown = change;
    try {
      const dismissed = shown.carriedFrom === null ? await engine.dismissNotice(shown.id) : await discardCarried(engine, shown);
      if (dismissed !== false) track('roadmap_kept', { step: 'discard', reason: shown.reason });
      setAsking(false);
      choose(null);
    } catch (error) {
      reportRoadmapFailure('roadmap-kept-discard', error);
      keep();
    }
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (page === 'ask') keep();
      else if (page === 'change') back();
      else onClose();
      return;
    }
    wrapTab(event, layer.current);
  };

  const rows = (
    <ul className="st-kept-rows">
      {kept.map((each) => (
        <li key={each.id}>
          <button type="button" className="st-kept-row" aria-current={wide && each.id === change?.id ? 'true' : undefined}
            data-kept-row={each.id} onClick={() => { focusNext.current = { title: !wide }; choose(each.id); }}>
            <span className="st-kept-row-title">{each.title}</span>
            <span className="st-kept-reason">{REASONS[each.reason]}</span>
            <ChevronRight className="st-kept-row-mark" size={18} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
  const changeBody = change && (
    <>
      <h3 className="st-kept-change-title">{change.title}</h3>
      <p className="st-kept-reason" role="status">{!wide && copy === 'failed' ? t('roadmap.kept.copyFailed') : REASONS[change.reason]}</p>
      <div ref={words} className="st-kept-words" tabIndex={-1}>{change.text}</div>
      {!wide && <p className="st-kept-copied" role="status">{copy === 'copied' ? t('roadmap.kept.copied') : ''}</p>}
    </>
  );

  const surface = wide ? (
    <section className="st-kept-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="st-kept-head">
        <h2 id={titleId} tabIndex={-1}>{t('roadmap.kept.title')}</h2>
        <Button variant="ghost" size="lg" onClick={onClose}>{t('roadmap.common.close')}</Button>
      </header>
      <p className="st-kept-lede">{t('roadmap.kept.lede')}</p>
      <div className="st-kept-split">
        {rows}
        {change && (
          <article className="st-kept-change">
            {changeBody}
            <div className="st-kept-actions"><Button size="lg" onClick={copyText}>{t('roadmap.kept.copy')}</Button></div>
          </article>
        )}
      </div>
    </section>
  ) : page === 'ask' ? (
    <section className="st-kept-page st-kept-page--ask" role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="st-kept-page-body">
        <h2 id={titleId} tabIndex={-1}>{t('roadmap.kept.discardTitle')}</h2>
        <p className="st-kept-ask">{t('roadmap.kept.discardBody')}</p>
      </div>
      <div className="st-kept-page-actions">
        <Button size="lg" full onClick={keep}>{t('roadmap.kept.keep')}</Button>
        <span className="st-kept-discard"><Button variant="ghost" size="lg" full onClick={discard}>{t('roadmap.kept.discard')}</Button></span>
      </div>
    </section>
  ) : page === 'change' ? (
    <section className="st-kept-page" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="st-kept-page-head">
        <button type="button" className="st-kept-back" aria-label={t('roadmap.kept.back')} onClick={back}><ChevronLeft size={20} aria-hidden="true" /></button>
        <h2 id={titleId} tabIndex={-1}>{t('roadmap.kept.name')}</h2>
      </header>
      <div className="st-kept-page-body st-kept-change">{changeBody}</div>
      <div className="st-kept-page-actions">
        {copy === 'failed'
          ? <Button size="lg" full onClick={selectText}>{t('roadmap.kept.selectText')}</Button>
          : <Button size="lg" full onClick={copyText}>{t('roadmap.kept.copy')}</Button>}
        <span className="st-kept-discard">
          <Button variant="ghost" size="lg" full onClick={() => setAsking(true)}>{t('roadmap.kept.discard')}</Button>
        </span>
      </div>
    </section>
  ) : (
    <section className="st-kept-page" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="st-kept-page-body">
        <h2 id={titleId} tabIndex={-1}>{t('roadmap.kept.name')}</h2>
        <p className="st-kept-count">{t('roadmap.kept.count', { count: kept.length, shown: new Intl.NumberFormat(APP_LOCALE).format(kept.length) })}</p>
        {rows}
      </div>
      <div className="st-kept-page-actions st-kept-page-actions--close">
        <Button variant="ghost" size="lg" onClick={onClose}>{t('roadmap.common.close')}</Button>
      </div>
    </section>
  );

  return createPortal(
    <div ref={layer} className={`st-kept ${wide ? 'st-kept--wide' : 'st-kept--narrow'}`} data-brand="roadmap" data-theme={theme} onKeyDown={onKeyDown}>
      {wide && <div className="st-kept-scrim" onClick={onClose} />}
      {surface}
    </div>,
    document.body,
  );
}
