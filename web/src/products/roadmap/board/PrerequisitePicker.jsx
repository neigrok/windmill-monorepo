import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { Button } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { countBucket } from './acts.js';
import { PrerequisiteChoices } from './StepDraft.js';
import { LABELS, PICKER, formatCount, matchCount, noStepsMatch, pickerFor, removeChip, showMore } from './copy.js';
import './composer.css';

const FOCUSABLE = 'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

export function useDraftViewport(phone) {
  const [viewport, setViewport] = useState(null);
  useEffect(() => {
    const visible = window.visualViewport;
    if (!phone || !visible) return undefined;
    const resize = () => setViewport({ position: 'fixed', top: visible.offsetTop, left: visible.offsetLeft, width: visible.width, height: visible.height });
    resize();
    visible.addEventListener('resize', resize);
    visible.addEventListener('scroll', resize);
    return () => { visible.removeEventListener('resize', resize); visible.removeEventListener('scroll', resize); };
  }, [phone]);
  return phone ? viewport : undefined;
}

export function useDraftFocus(ref, active, initial) {
  const openerRef = useRef(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => {
    const opener = openerRef.current;
    return () => {
      if (opener?.isConnected) { opener.focus({ preventScroll: true }); return; }
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body && document.activeElement?.isConnected) return;
        document.querySelector('.st-board [data-column] [tabindex="0"], .st-board .st-board-find-input, .st-board-state button')?.focus({ preventScroll: true });
      });
    };
  }, []);
  useEffect(() => {
    if (active && !ref.current?.contains(document.activeElement)) (initial?.current ?? ref.current)?.focus({ preventScroll: true });
  }, [active]);
  return (event) => {
    if (!active || event.key !== 'Tab') return;
    const stops = [...ref.current.querySelectorAll(FOCUSABLE)];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) {
      event.preventDefault(); first.focus();
    }
  };
}

export function PrerequisitePicker({ tree, completed, draft, band, onApply, onCancel }) {
  const phone = band === 'phone';
  const viewport = useDraftViewport(phone);
  const [selection, setSelection] = useState(() => new PrerequisiteChoices(tree, completed, { selected: draft.prerequisites }));
  const choices = selection.reconcile(tree, completed);
  useEffect(() => { if (choices !== selection) setSelection(choices); }, [choices, selection]);
  const dialog = useRef(null);
  const search = useRef(null);
  const titleId = useId();
  const focus = useDraftFocus(dialog, true, !phone || !choices.fits ? search : dialog);
  const context = pickerFor({ step: draft.name, total: choices.fits ? null : choices.total });
  const cancel = () => { track('roadmap_board_picker', { step: 'cancel' }); onCancel(); };
  const apply = () => {
    track('roadmap_board_picker', { step: 'apply', count: countBucket(choices.selectedIds.length) });
    onApply(choices.selectedIds);
  };
  const toggle = (id) => setSelection(choices.toggle(id));
  const remove = (id) => { toggle(id); (phone && choices.fits ? dialog.current : search.current).focus(); };
  const clear = () => { setSelection(choices.search('')); search.current.focus(); };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    focus(event);
  };
  const searchField = (
    <div className="st-board-picker-search">
      <Search size={18} strokeWidth={1.8} aria-hidden />
      <input ref={search} type="search" value={choices.query} placeholder={LABELS.findStep} aria-label={LABELS.findStep}
        autoComplete="off" spellCheck={false} onChange={(event) => setSelection(choices.search(event.target.value))}
        onKeyDown={(event) => {
          if (event.key !== 'Backspace' || choices.query || choices.selectedIds.length === 0) return;
          event.preventDefault(); toggle(choices.selectedIds.at(-1));
        }} />
      {choices.query ? <button type="button" aria-label={PICKER.clearSearch} onClick={clear}><X size={18} aria-hidden /></button>
        : !phone && <kbd aria-hidden>/</kbd>}
    </div>
  );
  const chips = choices.selected.length > 0 && (
    <div className="st-board-picker-chips" tabIndex={-1}>
      {phone && <span className="st-board-picker-selected-count">{formatCount(choices.selected.length)}</span>}
      {choices.selected.map((row) => <button key={row.id} type="button" className="st-board-picker-chip" aria-label={removeChip({ label: [row.label, row.context].filter(Boolean).join(' · ') })} onClick={() => remove(row.id)}>
        <span>{row.label}{row.context && <> · {row.context}</>}</span><X size={14} aria-hidden />
      </button>)}
    </div>
  );
  return (
    <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}
      style={viewport} className={`st-board-picker st-board-picker--${phone ? 'phone' : 'wide'}`} onKeyDown={onKeyDown}>
      <header className="st-board-draft-heading">
        {phone && <button className="st-board-draft-cancel" type="button" onClick={cancel}>{PICKER.cancel}</button>}
        <h2 id={titleId}>{PICKER.title}</h2>{phone && <span className="st-board-draft-balance" />}
      </header>
      {phone && context && <p className="st-board-picker-context">{context}</p>}
      {!phone && <>{searchField}{chips}</>}
      <div className="st-board-picker-results" tabIndex={-1}>
        {choices.count > 0 ? <>
          {(phone || choices.query || choices.hasMore) && <p className="st-board-picker-count">{!choices.query && !choices.hasMore ? PICKER.allSteps : matchCount({ shown: choices.rows.length, count: choices.count, total: choices.total, band: phone ? 'phone' : 'desktop' })}</p>}
          {choices.rows.map((row) => <button key={row.id} type="button" role="checkbox" aria-checked={row.selected}
            className="st-board-picker-row" onClick={() => toggle(row.id)}>
            <span className="st-board-picker-row-text"><strong>{row.label}</strong><span>{row.state}{row.context && <span>{row.context}</span>}</span></span>
            <span className="st-board-picker-checkbox" aria-hidden>{row.selected && <Check size={16} strokeWidth={2} />}</span>
          </button>)}
          {choices.hasMore && <button type="button" className="st-board-picker-more" onClick={() => { track('roadmap_board_picker', { step: 'more' }); setSelection(choices.more()); }}>{showMore({ count: choices.nextCount })}{phone && <ChevronDown size={18} aria-hidden />}</button>}
        </> : choices.query ? <div className="st-board-picker-empty" role="status">
          <h3>{noStepsMatch({ query: choices.query })}</h3>
          <p>{PICKER.selectionKept}</p><Button variant="secondary" onClick={clear}>{PICKER.clearSearch}</Button>
        </div> : null}
      </div>
      <footer className="st-board-picker-footer">
        {phone && chips}
        <div className="st-board-picker-actions">
          {phone ? searchField : <Button variant="secondary" onClick={cancel}>{PICKER.cancel}</Button>}
          <Button disabled={!choices.differsFrom(draft.prerequisites)} onClick={apply}>{PICKER.apply}</Button>
        </div>
      </footer>
    </section>
  );
}
