// What narrows and orders the Board: Find a step, the kind filter, the sort and the branch scope; from 744px a strip over
// the columns, on the phone the band's rows, its sheets and the chips over the panes; and what an emptied column says.
// Measures from 07.01–07.06 and 11.01 on the desktop page and 03.02, 03.06, 05.01–05.05, 09.03 and 14.01 on the phone page.

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './controls.css';
import { track } from '../../../telemetry/beacon.js';
import { Button } from '../../../design-system';
import { KIND_CSS, DEFAULT_NODE_COLOR } from '../theme.js';
import {
  FILTERED_EMPTY, LABELS, SORT_LABELS, SORT_MENU, branchChip, emptyColumn, removeChip, sortButtonLabel,
} from './copy.js';

const SORT_STEPS = { ArrowDown: 1, ArrowUp: -1 };
const SHEET_FOCUSABLE = 'button, input, [tabindex="0"]';

// Each change a reader makes emits once, with bounded labels only, then reaches the host's query.
function sortBy(query, onQuery, sort) {
  if (sort === query.sort) return;
  track('roadmap_board_sort', { sort });
  onQuery((current) => current.sortedBy(sort));
}

function toggleKind(query, onQuery, hue) {
  track('roadmap_board_filter', { count: query.toggledKind(hue).kinds.length });
  onQuery((current) => current.toggledKind(hue));
}

// All also drops kinds no swatch offers any more (among() set them aside), so they never come back on their own; only a
// change the reader can see emits.
function clearKinds(query, onQuery) {
  if (query.kinds.length > 0) track('roadmap_board_filter', { count: 0 });
  onQuery((current) => (current.kinds.length === 0 ? current : current.without('kinds')));
}

// `what` is 'search', 'kinds' or 'both'; `from` is the door: 'field', 'empty' or 'sheet'.
function clear(onQuery, what, from) {
  track('roadmap_board_clear', { what, from });
  onQuery((current) => current.without(what));
}

// Find a step: from 744px a pill with the / keycap, on the phone the band's field. Escape clears first, then leaves.
// A search emits once it is committed (Enter, or leaving the field) and never says what was asked.
export function FindStep({ query, onQuery, phone = false }) {
  const input = useRef(null);
  const committed = useRef('');
  const typed = query.search !== '';

  const commit = () => {
    const asked = query.search.trim();
    if (asked === '' || asked === committed.current) return;
    committed.current = asked;
    track('roadmap_board_search');
  };

  const clearSearch = () => {
    committed.current = '';
    clear(onQuery, 'search', 'field');
  };

  const onKeyDown = (event) => {
    if (event.key === 'Enter') commit();
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (typed) clearSearch();
    else input.current.blur();
  };

  return (
    <div className={`st-board-find ${phone ? 'st-board-find--phone' : 'st-board-find--wide'} ${typed ? 'is-typed' : ''}`}>
      {phone ? <PhoneSearchGlyph /> : <SearchGlyph />}
      <input
        ref={input}
        className="st-board-find-input"
        type="search"
        value={query.search}
        placeholder={LABELS.findStep}
        aria-label={LABELS.findStep}
        aria-keyshortcuts="/"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onQuery((current) => current.searchingFor(event.target.value))}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
      {typed && (
        <button
          type="button"
          className="st-board-find-clear"
          aria-label={LABELS.clearSearch}
          onClick={() => {
            clearSearch();
            input.current.focus();
          }}
        >
          {phone ? <SmallCrossGlyph /> : <CrossGlyph />}
        </button>
      )}
      {!typed && !phone && <kbd className="st-board-keycap" aria-hidden>/</kbd>}
    </div>
  );
}

// From 744px, between the chrome and the columns: the branch in scope, All and one swatch per kind worn, then the sort.
export function FilterStrip({ board, worn, query, onQuery, onAnchor }) {
  return (
    <div className="st-board-strip">
      {board.branch && <BranchScope step={board.branch} onQuery={onQuery} onAnchor={onAnchor} />}
      {worn.length > 0 && <KindSwatches worn={worn} query={query} onQuery={onQuery} withAll />}
      <SortMenu query={query} onQuery={onQuery} />
    </div>
  );
}

// The branch the Board is scoped to: the title returns to its anchor step, × clears only the scope.
function BranchScope({ step, onQuery, onAnchor }) {
  const anchor = () => {
    track('roadmap_board_branch', { action: 'anchor' });
    onAnchor(step.id);
  };
  const clearBranch = () => {
    track('roadmap_board_branch', { action: 'clear' });
    onQuery((current) => current.without('branch'));
  };
  return (
    <div className="st-board-branch">
      <button type="button" className="st-board-branch-anchor" aria-label={branchChip({ step: step.label })} onClick={anchor}>
        <BranchGlyph />
        <span className="st-board-branch-label">
          <span className="st-board-branch-kicker">{LABELS.branch}</span>
          <span className="st-board-branch-step">{step.label}</span>
        </span>
      </button>
      <button type="button" className="st-board-branch-clear" aria-label={LABELS.clearBranch} onClick={clearBranch}>
        <CloseGlyph />
      </button>
    </div>
  );
}

// A kind is its colour and its legend name together; on is carried by the ring, the ink and the check, never colour alone.
function KindSwatches({ worn, query, onQuery, withAll = false }) {
  return (
    <div className="st-board-swatches" role="group" aria-label={LABELS.filterByKind}>
      {withAll && <KindSwatch label={LABELS.allKinds} on={query.kinds.length === 0} onToggle={() => clearKinds(query, onQuery)} />}
      {worn.map((kind) => (
        <KindSwatch
          key={kind.hue}
          hue={kind.hue}
          label={kind.label}
          on={query.kinds.includes(kind.hue)}
          onToggle={() => toggleKind(query, onQuery, kind.hue)}
        />
      ))}
    </div>
  );
}

function KindSwatch({ hue = null, label, on, onToggle }) {
  const kind = hue === null ? null : KIND_CSS[hue] ?? KIND_CSS[DEFAULT_NODE_COLOR];
  return (
    <button
      type="button"
      className={`st-board-swatch ${on ? 'is-on' : ''}`}
      style={kind ? { '--st-board-swatch-dot': kind.base, '--st-board-swatch-ring': kind.ring } : undefined}
      aria-pressed={on}
      onClick={onToggle}
    >
      <span className="st-board-swatch-chip">
        {kind && <span className="st-board-swatch-dot" aria-hidden />}
        <span className="st-board-swatch-label">{label}</span>
        {on && <CheckGlyph />}
      </span>
    </button>
  );
}

// The sort button names the order in force and opens the menu under it; a pick applies and closes, dismissing commits nothing.
function SortMenu({ query, onQuery }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event) => { if (!box.current.contains(event.target)) setOpen(false); };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);

  const dismiss = () => {
    setOpen(false);
    opener.current.focus();
  };

  const toggle = () => {
    if (!open) track('roadmap_board_menu', { menu: 'sort' });
    setOpen(!open);
  };

  return (
    <div
      className="st-board-sort"
      ref={box}
      onBlur={(event) => { if (open && !box.current.contains(event.relatedTarget)) setOpen(false); }}
    >
      <button
        ref={opener}
        type="button"
        className="st-board-sort-button"
        aria-label={sortButtonLabel({ sort: query.sort })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <span>{SORT_MENU.options[query.sort]}</span>
        <ChevronGlyph />
      </button>
      {open && (
        <div className="st-board-sort-popover">
          <SortOptions sort={query.sort} onPick={(sort) => { sortBy(query, onQuery, sort); dismiss(); }} onDismiss={dismiss} />
        </div>
      )}
    </div>
  );
}

// Roadmap order, then the Created pair; the arrow keys move between them and Escape dismisses.
function SortOptions({ sort, onPick, onDismiss }) {
  const list = useRef(null);
  const createdId = useId();

  useEffect(() => {
    list.current.querySelector('[aria-checked="true"]')?.focus();
  }, []);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (!(event.key in SORT_STEPS)) return;
    event.preventDefault();
    const options = [...list.current.querySelectorAll('[role="menuitemradio"]')];
    const at = options.indexOf(document.activeElement);
    options[(at + SORT_STEPS[event.key] + options.length) % options.length].focus();
  };

  const option = (value) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={sort === value}
      className="st-board-sort-option"
      onClick={() => onPick(value)}
    >
      <span className="st-board-sort-option-text">
        <span className="st-board-sort-option-label">{SORT_MENU.options[value]}</span>
        {value === 'roadmap' && <span className="st-board-sort-option-detail">{SORT_MENU.roadmapDetail}</span>}
      </span>
      {sort === value && <MenuCheckGlyph />}
    </button>
  );

  return (
    <div ref={list} className="st-board-sort-options" role="menu" aria-label={SORT_MENU.title} onKeyDown={onKeyDown}>
      {option('roadmap')}
      <div role="group" aria-labelledby={createdId}>
        <div id={createdId} className="st-board-sort-group">{SORT_MENU.created}</div>
        {option('newest')}
        {option('oldest')}
      </div>
    </div>
  );
}

// From 744px an emptied column names its way out under its heading; when every column is empty only Up next says so.
export function ColumnEmpty({ query, onQuery }) {
  const { title, action } = emptyColumn({ recovery: query.recovery, search: query.search });
  return (
    <div className="st-board-column-empty" role="status">
      <p className="st-board-column-empty-title">{title}</p>
      <button type="button" className="st-board-column-empty-action" onClick={() => clear(onQuery, query.recovery, 'empty')}>{action}</button>
    </div>
  );
}

// On the phone an emptied pane says it in its middle, its title giving way.
export function PaneEmpty({ query, onQuery }) {
  const { title, action } = emptyColumn({ recovery: query.recovery, search: query.search });
  const byKind = query.recovery === 'kinds';
  return (
    <div className="st-board-pane-empty" role="status">
      {byKind ? <FilterStateGlyph /> : <SearchStateGlyph />}
      <p className="st-board-pane-empty-title">{title}</p>
      <Button variant="secondary" full={!byKind} onClick={() => clear(onQuery, query.recovery, 'empty')}>{action}</Button>
    </div>
  );
}

// Over the phone's panes: the branch in scope, then a removable chip per kind on and for an order other than Roadmap order.
export function ActiveFilters({ board, worn, query, onQuery, onAnchor }) {
  const on = worn.filter((kind) => query.kinds.includes(kind.hue));
  const sorted = query.sort !== 'roadmap';
  if (board.branch === null && on.length === 0 && !sorted) return null;
  return (
    <div className="st-board-active">
      {board.branch && <BranchScope step={board.branch} onQuery={onQuery} onAnchor={onAnchor} />}
      {(on.length > 0 || sorted) && (
        <div className="st-board-active-chips">
          {on.map((kind) => <RemovableChip key={kind.hue} label={kind.label} onRemove={() => toggleKind(query, onQuery, kind.hue)} />)}
          {sorted && <RemovableChip label={SORT_LABELS[query.sort]} onRemove={() => sortBy(query, onQuery, 'roadmap')} />}
        </div>
      )}
    </div>
  );
}

// The whole 44px row height removes it.
function RemovableChip({ label, onRemove }) {
  return (
    <button type="button" className="st-board-chip" aria-label={removeChip({ label })} onClick={onRemove}>
      <span className="st-board-chip-surface">
        <span className="st-board-chip-label">{label}</span>
        <span className="st-board-chip-remove"><ChipCrossGlyph /></span>
      </span>
    </button>
  );
}

// The phone band's Sort, beside the tabs: a dot while the order is not Roadmap order; it opens the sort sheet.
export function PhoneSort({ query, onQuery }) {
  const opener = useRef(null);
  const [host, setHost] = useState(null);
  const close = () => {
    setHost(null);
    opener.current.focus();
  };
  const open = () => {
    track('roadmap_board_menu', { menu: 'sort' });
    setHost(opener.current.closest('.st-board'));
  };
  return (
    <>
      <button ref={opener} type="button" className="st-board-tool" aria-label={LABELS.sort} aria-haspopup="dialog" aria-expanded={host !== null} onClick={open}>
        <SortGlyph />
        {query.sort !== 'roadmap' && <span className="st-board-tool-dot" aria-hidden />}
      </button>
      {host && (
        <Sheet host={host} variant="sort" title={SORT_MENU.title} onClose={close}>
          <SortOptions sort={query.sort} onPick={(sort) => { sortBy(query, onQuery, sort); close(); }} onDismiss={close} />
        </Sheet>
      )}
    </>
  );
}

// The phone band's second row: Find a step, then Filter, which a roadmap wearing one kind does without.
export function PhoneTools({ worn, query, onQuery }) {
  const opener = useRef(null);
  const [host, setHost] = useState(null);
  const first = worn.find((kind) => query.kinds.includes(kind.hue));
  const close = () => {
    setHost(null);
    opener.current.focus();
  };
  const open = () => {
    track('roadmap_board_menu', { menu: 'filter' });
    setHost(opener.current.closest('.st-board'));
  };
  return (
    <div className="st-board-phone-tools">
      <FindStep query={query} onQuery={onQuery} phone />
      {worn.length > 0 && (
        <button
          ref={opener}
          type="button"
          className={`st-board-tool st-board-tool--filter ${first ? 'is-on' : ''}`}
          aria-label={LABELS.filterByKind}
          aria-haspopup="dialog"
          aria-expanded={host !== null}
          onClick={open}
        >
          <FilterGlyph />
          {first && <span className="st-board-tool-dot" style={{ '--st-board-tool-dot': KIND_CSS[first.hue].base }} aria-hidden />}
        </button>
      )}
      {host && (
        <Sheet host={host} variant="filter" title={LABELS.filterByKind} onClose={close}>
          <KindSwatches worn={worn} query={query} onQuery={onQuery} />
          <Button
            variant="secondary"
            full
            onClick={() => {
              if (query.kinds.length > 0) clear(onQuery, 'kinds', 'sheet');
              close();
            }}
          >
            {FILTERED_EMPTY.action}
          </Button>
        </Sheet>
      )}
    </div>
  );
}

// A bottom sheet over the whole Board: the scrim and × dismiss it, Escape too, and Tab stays inside while it is open.
function Sheet({ host, variant, title, onClose, children }) {
  const sheet = useRef(null);
  const titleId = useId();

  useEffect(() => {
    sheet.current.querySelector(`[aria-checked="true"], ${SHEET_FOCUSABLE}`)?.focus();
  }, []);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = [...sheet.current.querySelectorAll(SHEET_FOCUSABLE)];
    const edge = event.shiftKey ? stops[0] : stops[stops.length - 1];
    if (document.activeElement !== edge) return;
    event.preventDefault();
    (event.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
  };

  return createPortal(
    <div className="st-board-sheet-layer" onKeyDown={onKeyDown}>
      <div className="st-board-sheet-scrim" aria-hidden onClick={onClose} />
      <div ref={sheet} className={`st-board-sheet st-board-sheet--${variant}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <span className="st-board-sheet-grabber" aria-hidden />
        <div className="st-board-sheet-heading">
          <h2 id={titleId} className="st-board-sheet-title">{title}</h2>
          <button type="button" className="st-board-sheet-close" aria-label={LABELS.close} onClick={onClose}><CloseGlyph /></button>
        </div>
        {children}
      </div>
    </div>,
    host,
  );
}

// Lucide geometry from the Board icons, stroked in currentColor.
function SearchGlyph() {
  return (
    <svg className="st-board-find-glyph" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15.8333 9.16667C15.8333 12.8486 12.8486 15.8333 9.16667 15.8333C5.48477 15.8333 2.5 12.8486 2.5 9.16667C2.5 5.48477 5.48477 2.5 9.16667 2.5C12.8486 2.5 15.8333 5.48477 15.8333 9.16667Z" />
      <path d="M17.5 17.5L13.9167 13.9167" />
    </svg>
  );
}

function PhoneSearchGlyph() {
  return (
    <svg className="st-board-find-glyph" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" aria-hidden>
      <path d="M12.975 8.1C12.975 10.7924 10.7924 12.975 8.1 12.975C5.40761 12.975 3.225 10.7924 3.225 8.1C3.225 5.40761 5.40761 3.225 8.1 3.225C10.7924 3.225 12.975 5.40761 12.975 8.1Z" />
      <path d="M12 12L15.375 15.375" />
    </svg>
  );
}

function CrossGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" aria-hidden>
      <path d="M15 5L5 15M5 5L15 15" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.41667" strokeLinecap="round" aria-hidden>
      <path d="M5 5L15 15M15 5L5 15" />
    </svg>
  );
}

function SmallCrossGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M4 4L12 12M12 4L4 12" />
    </svg>
  );
}

function ChipCrossGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.28333" strokeLinecap="round" aria-hidden>
      <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg className="st-board-swatch-check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.575" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.0625 7.4375L5.6875 10.0625L10.9375 3.9375" />
    </svg>
  );
}

function MenuCheckGlyph() {
  return (
    <svg className="st-board-sort-check" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2.025" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.9375 9.5625L7.3125 12.9375L14.0625 5.0625" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg className="st-board-sort-chevron" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 5.5L7 9L10.5 5.5" />
    </svg>
  );
}

function BranchGlyph() {
  return (
    <svg className="st-board-branch-glyph" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.33333" strokeLinecap="round" aria-hidden>
      <path d="M5 5.83333V10M5 10V14.1667M5 10H10.8333C11.3805 10 11.9223 9.89223 12.4278 9.68283C12.9334 9.47344 13.3927 9.16652 13.7796 8.77961C14.1665 8.3927 14.4734 7.93337 14.6828 7.42785C14.8922 6.92232 15 6.38051 15 5.83333" />
      <path d="M7.08333 3.75C7.08333 4.90059 6.15059 5.83333 5 5.83333C3.84941 5.83333 2.91667 4.90059 2.91667 3.75C2.91667 2.59941 3.84941 1.66667 5 1.66667C6.15059 1.66667 7.08333 2.59941 7.08333 3.75Z" />
      <path d="M7.08333 16.25C7.08333 17.4006 6.15059 18.3333 5 18.3333C3.84941 18.3333 2.91667 17.4006 2.91667 16.25C2.91667 15.0994 3.84941 14.1667 5 14.1667C6.15059 14.1667 7.08333 15.0994 7.08333 16.25Z" />
      <path d="M17.0833 3.75C17.0833 4.90059 16.1506 5.83333 15 5.83333C13.8494 5.83333 12.9167 4.90059 12.9167 3.75C12.9167 2.59941 13.8494 1.66667 15 1.66667C16.1506 1.66667 17.0833 2.59941 17.0833 3.75Z" />
    </svg>
  );
}

function SortGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 15.5V4.5M9.5 7L7 4.5L4.5 7M13 4.5V15.5M15.5 13L13 15.5L10.5 13" />
    </svg>
  );
}

function FilterGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M3.33333 5.83333H16.6667M5.83333 10H14.1667M8.33333 14.1667H11.6667" />
    </svg>
  );
}

function FilterStateGlyph() {
  return (
    <svg className="st-board-pane-empty-glyph st-board-pane-empty-glyph--filter" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.66667" strokeLinecap="round" aria-hidden>
      <path d="M5.33333 9.33333H26.6667M9.33333 16H22.6667M13.3333 22.6667H18.6667" />
    </svg>
  );
}

function SearchStateGlyph() {
  return (
    <svg className="st-board-pane-empty-glyph st-board-pane-empty-glyph--search" width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M28.5 16.5C28.5 23.1274 23.1274 28.5 16.5 28.5C9.87258 28.5 4.5 23.1274 4.5 16.5C4.5 9.87258 9.87258 4.5 16.5 4.5C23.1274 4.5 28.5 9.87258 28.5 16.5Z" />
      <path d="M31.5 31.5L25.05 25.05" />
    </svg>
  );
}
