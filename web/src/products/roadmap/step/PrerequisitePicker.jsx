import React, { useLayoutEffect, useRef } from 'react';
import { Check, ChevronDown, ChevronLeft, Search, X } from 'lucide-react';
import { Button } from '../../../design-system';
import { track } from '../../../telemetry/beacon.js';
import { countBucket } from '../board/acts.js';
import { boardKey } from '../shortcuts/shortcutMap.js';
import {
  COMPOSER, EDIT_STEP, LABELS, PICKER, backTo, draftLine, formatCount, matchCount,
  leftSelection, noStepsMatch, pickerFor, removeChip, showMore,
} from '../copy.js';
import './composer.css';

// A picker's search field: the query with its clear button, or the / that reaches it from 744px.
export function PickerSearch({ inputRef, label, value, phone, onChange, onClear, onKeyDown }) {
  return (
    <div className="st-board-picker-search">
      <Search size={18} strokeWidth={1.8} aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder={label}
        aria-label={label}
        aria-keyshortcuts="/"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {value ? (
        <button type="button" aria-label={PICKER.clearSearch} onClick={onClear}>
          <X size={18} aria-hidden />
        </button>
      ) : !phone && <kbd aria-hidden>/</kbd>}
    </div>
  );
}

export function PrerequisitePicker({ choices, onChoices, draft, layout, headingId, onApply, onCancel, mode = 'create' }) {
  const phone = layout === 'phone';
  const page = layout === 'page';
  const region = useRef(null);
  const search = useRef(null);
  const context = phone
    ? pickerFor({ step: draft.name, total: choices.fits ? null : choices.total })
    : draft.name.trim() ? draftLine({ step: draft.name.trim() }) : null;
  const selected = choices.selected.length > 0;
  const searched = choices.query.trim() !== '';
  const count = searched
    ? matchCount({
      shown: choices.rows.length,
      count: choices.count,
      total: choices.fits ? null : choices.total,
      band: phone ? 'phone' : 'desktop',
    })
    : PICKER.allSteps;

  useLayoutEffect(() => {
    if (region.current.contains(document.activeElement)) return;
    const target = phone && choices.fits ? region.current : search.current;
    target.focus({ preventScroll: true });
  }, [choices, layout]);

  const cancel = () => {
    track('roadmap_board_picker', { step: 'cancel', mode });
    onCancel();
  };
  const apply = () => {
    track('roadmap_board_picker', { step: 'apply', mode, count: countBucket(choices.selectedIds.length) });
    onApply(choices.selectedIds);
  };
  const toggle = (id) => onChoices(choices.toggle(id));
  const remove = (id) => {
    toggle(id);
    (phone && choices.fits ? region.current : search.current).focus();
  };
  const clear = () => {
    onChoices(choices.search(''));
    search.current.focus();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    const typing = event.target.matches('input, textarea') || event.target.isContentEditable;
    if (boardKey(event, { typing }) !== 'find') return;
    event.preventDefault();
    event.stopPropagation();
    search.current.focus();
  };
  const searchField = (
    <PickerSearch inputRef={search} label={LABELS.findStep} value={choices.query} phone={phone}
      onChange={(query) => onChoices(choices.search(query))} onClear={clear}
      onKeyDown={(event) => {
        if (event.key !== 'Backspace' || choices.query || choices.selectedIds.length === 0) return;
        event.preventDefault();
        toggle(choices.selectedIds.at(-1));
      }} />
  );
  const chips = selected && (
    <div className="st-board-picker-chips" tabIndex={-1}>
      {phone && <span className="st-board-picker-selected-count">{formatCount(choices.selected.length)}</span>}
      {choices.selected.map((row) => (
        <button
          key={row.id}
          type="button"
          className="st-board-picker-chip"
          aria-label={removeChip({ label: [row.label, row.context].filter(Boolean).join(' · ') })}
          onClick={() => remove(row.id)}
        >
          <span>{row.label}{row.context && <> · {row.context}</>}</span>
          <X size={14} aria-hidden />
        </button>
      ))}
    </div>
  );
  return (
    <div
      ref={region}
      tabIndex={-1}
      className={`st-board-picker st-board-picker--${layout}`}
      onKeyDown={onKeyDown}
    >
      <header className="st-board-draft-heading">
        {phone && (
          <button className="st-board-draft-cancel" type="button" onClick={cancel}>{PICKER.cancel}</button>
        )}
        {page && (
          <button className="st-board-picker-back" type="button" aria-label={backTo({ screen: mode === 'edit' ? EDIT_STEP.title : COMPOSER.title })} onClick={cancel}>
            <ChevronLeft size={20} aria-hidden />
          </button>
        )}
        <div className="st-board-picker-heading-copy">
          <h2 id={headingId}>{PICKER.title}</h2>
          {page && context && <p className="st-board-picker-context">{context}</p>}
        </div>
        {phone && <span className="st-board-draft-balance" />}
      </header>
      {phone && context && <p className="st-board-picker-context">{context}</p>}
      {choices.revalidated.length > 0 && (
        <div className="st-board-picker-revalidated" role="status">
          {choices.revalidated.map((row) => <p key={row.id}>{leftSelection({ step: row.label })}</p>)}
        </div>
      )}
      {!phone && <>{searchField}{chips}</>}
      <div className="st-board-picker-results" tabIndex={-1}>
        {choices.count > 0 ? (
          <>
            {(phone || searched || choices.hasMore) && <p className="st-board-picker-count">{count}</p>}
            {choices.rows.map((row) => (
              <button
                key={row.id}
                type="button"
                role="checkbox"
                aria-checked={row.selected}
                className="st-board-picker-row"
                onClick={() => toggle(row.id)}
              >
                <span className="st-board-picker-row-text">
                  <strong>{row.label}</strong>
                  <span>{row.state}{row.context && <span>{row.context}</span>}</span>
                </span>
                <span className="st-board-picker-checkbox" aria-hidden>
                  {row.selected && <Check size={16} strokeWidth={2} />}
                </span>
              </button>
            ))}
            {choices.hasMore && (
              <button
                type="button"
                className="st-board-picker-more"
                onClick={() => {
                  track('roadmap_board_picker', { step: 'more', mode });
                  onChoices(choices.more());
                }}
              >
                {showMore({ count: choices.nextCount })}
                {phone && <ChevronDown size={18} aria-hidden />}
              </button>
            )}
          </>
        ) : searched && choices.blocked.length === 0 ? (
          <div className="st-board-picker-empty" role="status">
            <h3>{noStepsMatch({ query: choices.query })}</h3>
            {selected && <p>{PICKER.selectionKept}</p>}
            <Button variant="secondary" onClick={clear}>{PICKER.clearSearch}</Button>
          </div>
        ) : null}
        {choices.blocked.length > 0 && (
          <section className="st-board-picker-blocked" aria-label={PICKER.cantBe}>
            <h3 className="st-board-picker-count">{PICKER.cantBe}</h3>
            {choices.blocked.map((row) => (
              <div key={row.id} role="checkbox" aria-checked="false" aria-disabled="true" className="st-board-picker-row is-blocked">
                <span className="st-board-picker-row-text">
                  <strong>{row.label}</strong>
                  <span>{row.reason}{row.context && <span>{row.context}</span>}</span>
                </span>
              </div>
            ))}
          </section>
        )}
      </div>
      <footer className="st-board-picker-footer">
        {phone && chips}
        <div className="st-board-picker-actions">
          {phone ? searchField : <Button variant="secondary" onClick={cancel}>{PICKER.cancel}</Button>}
          <Button disabled={!choices.differsFrom(draft.prerequisites)} onClick={apply}>{PICKER.apply}</Button>
        </div>
      </footer>
    </div>
  );
}
