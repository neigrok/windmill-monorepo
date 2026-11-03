// The Board is one tab stop with roving focus; Enter is the focused stop's own button, so on a card it opens the step.
// A stop is { column, id }: a step id, SHOW_ALL for the row ending a folded Done, or RAIL for a tablet rail's Show.

import { useEffect, useRef, useState } from 'react';
import { boardKey } from '../shortcuts/shortcutMap.js';

export const SHOW_ALL = Symbol('Show all');
export const RAIL = Symbol('rail Show');

const COLUMN_STEPS = { ArrowLeft: -1, ArrowRight: 1 };

export function boardFocusTarget(root, { preferredId = null, excludeId = null, cards = true } = {}) {
  if (!root) return null;
  const selectors = [
    ...(preferredId === null ? [] : [`.st-board-card[data-step-id="${CSS.escape(preferredId)}"]`]),
    ...(cards ? ['[data-column] [tabindex="0"], [data-column][tabindex="0"]'] : []),
    '.st-board-phone-segment[aria-selected="true"]',
    '.st-board-find-input',
    '.st-board-state button',
    '[aria-busy="true"][tabindex]',
  ];
  for (const selector of selectors) {
    const target = [...root.querySelectorAll(selector)].find((element) => (
      !element.disabled && !element.closest('[inert], .is-leaving, .st-board-phone-pane:not(.is-shown)')
      && element.getClientRects().length > 0
      && getComputedStyle(element).visibility === 'visible'
      && (excludeId === null || element.closest('[data-step-id]')?.dataset.stepId !== excludeId)
    ));
    if (target) return target;
  }
  if (root.closest('[inert]') || root.getClientRects().length === 0 || getComputedStyle(root).visibility !== 'visible') return null;
  root.tabIndex = -1;
  return root;
}

export function columnStops({ cards, folded }) {
  return [...cards.map((card) => card.id), ...(folded ? [SHOW_ALL] : [])];
}

// Tab enters on the last focused stop while it stands, else a column's own remembered stop, else the first Up next card.
// `layout` lists the columns in reading order as { name, stops }; `memory` is { last, byColumn } from the focus.
export function entryStop(layout, memory, recoveryLayout = layout) {
  // Regroup retains old cards; a removed stop yields to the current entry wherever its card is still displayed.
  if (recoveryLayout !== layout) {
    const stop = entryStop(layout, memory);
    const currentIds = new Set(recoveryLayout.flatMap((column) => column.stops));
    if (stop === null || currentIds.has(stop.id)) return stop;
    const recovery = entryStop(recoveryLayout, memory);
    const displayed = layout.find((column) => column.stops.includes(recovery?.id));
    if (displayed) return { column: displayed.name, id: recovery.id };
    return entryStop(layout.map((column) => ({
      ...column, stops: column.stops.filter((id) => currentIds.has(id)),
    })), memory);
  }
  const upNextFirst = [...layout].sort((a, b) => (b.name === 'upNext') - (a.name === 'upNext'));
  const remembering = [layout.find((column) => column.name === memory.last), ...upNextFirst]
    .find((column) => column?.stops.includes(memory.byColumn[column.name]));
  if (remembering) return { column: remembering.name, id: memory.byColumn[remembering.name] };
  const first = upNextFirst.find((column) => column.stops.length > 0);
  return first ? { column: first.name, id: first.stops[0] } : null;
}

// Up and Down step within a column, Home and End jump to its ends, Left and Right cross to the neighbouring column,
// skipping an empty one, and land on the stop `nearest` picks there. Null when the key moves nowhere.
export function moveStop(layout, from, key, nearest = (column) => column.stops[0]) {
  const columnIndex = layout.findIndex((column) => column.name === from.column);
  if (columnIndex === -1) return null;
  const { stops } = layout[columnIndex];
  const index = stops.indexOf(from.id);
  const within = (to) => (to === index || to < 0 || to >= stops.length ? null : { column: from.column, id: stops[to] });
  if (key === 'ArrowUp') return within(index - 1);
  if (key === 'ArrowDown') return within(index + 1);
  if (key === 'Home') return within(0);
  if (key === 'End') return within(stops.length - 1);
  if (!(key in COLUMN_STEPS)) return null;
  const ahead = COLUMN_STEPS[key] > 0 ? layout.slice(columnIndex + 1) : layout.slice(0, columnIndex).reverse();
  const neighbour = ahead.find((column) => column.stops.length > 0);
  return neighbour ? { column: neighbour.name, id: neighbour.stops.length === 1 ? neighbour.stops[0] : nearest(neighbour) } : null;
}

// The candidate whose middle sits closest to `y`; the earlier one on a tie.
export function nearestStop(y, candidates) {
  let best = null;
  for (const candidate of candidates) {
    const distance = Math.abs((candidate.top + candidate.bottom) / 2 - y);
    if (best === null || distance < best.distance) best = { id: candidate.id, distance };
  }
  return best?.id ?? null;
}

// A completion waits on its displayed Board; a newer Board must contain its destination or release focus recovery.
export function pendingStop(layout, pending, existingIds, revision) {
  if (pending === null) return null;
  const exists = existingIds ? existingIds.has(pending.id) : layout.some((column) => column.stops.includes(pending.id));
  if (!exists) return null;
  const advanced = pending.revision !== undefined && pending.revision !== revision;
  const destination = layout.find((column) => column.name === pending.column);
  if (advanced && !destination?.stops.includes(pending.id)) return null;
  return pending;
}

function stopOfElement(element) {
  const column = element.closest('[data-column]')?.dataset.column;
  if (!column) return null;
  if (element.matches('.st-board-show-all')) return { column, id: SHOW_ALL };
  if (element.matches('.st-board-columns-show')) return { column, id: RAIL };
  if (element.matches('.st-board-card')) return { column, id: element.dataset.stepId };
  return null;
}

function elementOfStop(container, { column, id }) {
  const home = container.querySelector(`[data-column="${column}"]`);
  if (id === SHOW_ALL) return home?.querySelector('.st-board-show-all') ?? null;
  if (id === RAIL) return home?.querySelector('.st-board-columns-show') ?? null;
  return home?.querySelector(`.st-board-card[data-step-id="${CSS.escape(id)}"]`) ?? null;
}

function focusInView(element) {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Holds the roving stop for a container of columns. A card not yet rendered is pinned as pending until it can take focus;
// a focused stop that unmounts (a sync moved its step) hands focus to the stop instead of dropping it to the page.
export function useRovingFocus(layout, { onComplete, onDelete, existingIds, revision, recoveryLayout = layout } = {}) {
  const ref = useRef(null);
  const focused = useRef(null);
  const [memory, setMemory] = useState({ last: null, byColumn: {} });
  const [pending, setPending] = useState(null);
  const stop = entryStop(layout, memory, recoveryLayout);
  const following = pendingStop(layout, pending, existingIds, revision);
  if (following !== pending) setPending(following);

  useEffect(() => {
    if (pending === null) return;
    const element = elementOfStop(ref.current, pending);
    if (!element) return;
    setPending(null);
    focusInView(element);
  }, [pending, layout]);

  useEffect(() => {
    const lost = focused.current;
    if (pending !== null || lost === null || lost.isConnected) return;
    focused.current = null;
    const fallen = document.activeElement === null || document.activeElement === document.body;
    const element = fallen && stop !== null ? elementOfStop(ref.current, stop) : null;
    if (element) focusInView(element);
  });

  const onFocus = (event) => {
    const at = stopOfElement(event.target);
    if (at === null) return;
    focused.current = event.target;
    if (memory.last === at.column && memory.byColumn[at.column] === at.id) return;
    setMemory({ last: at.column, byColumn: { ...memory.byColumn, [at.column]: at.id } });
  };

  // Focus leaving on purpose lets go of the element; one that left because its element unmounted is caught above.
  const onBlur = (event) => {
    const element = event.target;
    queueMicrotask(() => {
      if (element.isConnected && focused.current === element) focused.current = null;
    });
  };

  const onKeyDown = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const from = stopOfElement(event.target);
    if (from === null || event.defaultPrevented) return;
    const action = boardKey(event, {
      typing: Boolean(event.target.closest('input, textarea, select, [contenteditable="true"]')),
      covered: Boolean(event.target.closest('[inert]') || document.querySelector('[aria-modal="true"]')),
    });
    if (action === 'delete') {
      if (!onDelete || !event.target.matches('.st-board-card')) return;
      event.preventDefault();
      onDelete([from.id], 'key');
      return;
    }
    if (action === 'complete') {
      if (from.column !== 'upNext' || !onComplete || !event.target.matches('.st-board-card')) return;
      event.preventDefault();
      if (onComplete(from.id, 'key')) setPending({ column: 'done', id: from.id, revision });
      return;
    }
    const box = event.target.getBoundingClientRect();
    const y = (box.top + box.bottom) / 2;
    const nearest = (column) => nearestStop(y, [...ref.current.querySelectorAll(`[data-column="${column.name}"] :is(.st-board-card, .st-board-show-all)`)]
      .map((element) => ({ id: stopOfElement(element).id, ...element.getBoundingClientRect().toJSON() }))) ?? column.stops[0];
    const to = moveStop(layout, from, event.key, nearest);
    if (to === null) return;
    event.preventDefault();
    const element = elementOfStop(ref.current, to);
    if (element) focusInView(element);
    else setPending(to);
  };

  const stopIn = (column) => (stop?.column === column ? stop.id : undefined);
  const pendingIn = (column) => (pending?.column === column ? pending.id : undefined);

  return { ref, stopIn, pendingIn, onFocus, onBlur, onKeyDown, follow: setPending };
}
