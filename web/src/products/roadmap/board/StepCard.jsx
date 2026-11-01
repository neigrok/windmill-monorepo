// One step on the Board: the kind rail, the title, the reason line and a two-line excerpt; the whole card selects its step.
// A column renders only the cards in view, measured as they render, and a folded Done ends with the Show all row.

import React, { useEffect, useRef, useState } from 'react';
import { KIND_CSS, DEFAULT_NODE_COLOR } from '../theme.js';
import { arrivals, DONE_RECENT_LIMIT } from './Board.js';
import { SHOW_ALL } from './traversal.js';
import { reasonLine, showAllDone } from './copy.js';

const WAKE_MS = 2400; // the Arrived ring settles over two 1200ms pulses
const OVERSCAN = 10;
const FIRST_PAINT = { first: 0, last: 15 };
const ESTIMATE = { frame: 26, title: 24, reason: 22, excerpt: 24 };
const NOTHING_ARRIVED = new Set();

export function StepCard({ card, selected = false, arrived = false, tabIndex = 0, onSelect }) {
  const reason = reasonLine(card);
  const description = card.step.description?.trim() ?? '';
  const kind = KIND_CSS[card.step.color] ?? KIND_CSS[DEFAULT_NODE_COLOR];
  return (
    <button
      type="button"
      className={`st-board-card st-board-card--${card.column}${arrived ? ' is-arrived' : ''}`}
      style={{ '--st-board-rail': kind.base }}
      data-step-id={card.id}
      tabIndex={tabIndex}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(card.id)}
    >
      <span className="st-board-card-rail" aria-hidden />
      <span className="st-board-card-content">
        <span className="st-board-card-title">{card.step.label}</span>
        {reason && <span className="st-board-card-reason">{reason}</span>}
        {description && <span className="st-board-card-excerpt">{description}</span>}
      </span>
    </button>
  );
}

// Lucide's chevron-down on the 24 grid: 2px strokes, so 1.5px at 18 and 1.67px at 20, as the Board icons draw it.
export function Chevron({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// An unmeasured card's height from its anatomy, every line taken as one; the measured height replaces it once it renders.
export function estimatedHeight(card) {
  const reason = reasonLine(card) === null ? 0 : ESTIMATE.reason;
  const excerpt = (card.step.description?.trim() ?? '') === '' ? 0 : ESTIMATE.excerpt;
  return ESTIMATE.frame + ESTIMATE.title + reason + excerpt;
}

// A column's cards stacked top to bottom with a gap between, in px from the run's top edge.
export class CardStack {
  constructor(heights, gap) {
    this.heights = heights;
    this.offsets = [];
    let top = 0;
    for (const height of heights) {
      this.offsets.push(top);
      top += height + gap;
    }
  }

  get count() { return this.heights.length; }

  // The cards any part of which lies between top and bottom.
  rangeIn(top, bottom) {
    if (this.count === 0) return { first: 0, last: -1 };
    const below = this.offsets.findIndex((offset, index) => offset + this.heights[index] > top);
    const first = below === -1 ? this.count - 1 : below;
    let last = first;
    while (last < this.count - 1 && this.offsets[last + 1] < bottom) last += 1;
    return { first, last };
  }

  // What the column renders, in order: the range widened by the overscan, each pinned index, and one spacer per skipped stretch.
  window({ first, last }, overscan, pinned = []) {
    const shown = new Set(pinned.filter((index) => index >= 0 && index < this.count));
    for (let index = Math.max(0, first - overscan); index <= Math.min(this.count - 1, last + overscan); index += 1) shown.add(index);
    const items = [];
    let next = 0;
    for (const index of [...shown].sort((a, b) => a - b)) {
      if (index > next) items.push({ spacer: this.span(next, index - 1), from: next });
      items.push(index);
      next = index + 1;
    }
    if (next < this.count) items.push({ spacer: this.span(next, this.count - 1), from: next });
    return items;
  }

  span(from, to) {
    return this.offsets[to] + this.heights[to] - this.offsets[from];
  }
}

// The steps that arrived while the Board stayed mounted wake once; the first Board a column sees wakes nothing.
export function useArrivals(board) {
  const [seen, setSeen] = useState({ board, arrived: NOTHING_ARRIVED });
  if (seen.board !== board) {
    const arrived = new Set([...seen.arrived, ...arrivals(seen.board, board)]);
    setSeen({ board, arrived: arrived.size === 0 ? NOTHING_ARRIVED : arrived });
  }

  useEffect(() => {
    if (seen.arrived.size === 0) return undefined;
    const settle = setTimeout(() => setSeen((current) => ({ ...current, arrived: NOTHING_ARRIVED })), WAKE_MS);
    return () => clearTimeout(settle);
  }, [seen.arrived]);

  return seen.arrived;
}

// The run scrolls inside its parent, the column. Pinned cards (the roving stop, the selected step) always render, so focus
// and a reveal from the Graph can reach them wherever the column has scrolled.
export function ColumnCards({ shown, stopId, pinned = [], arrived = NOTHING_ARRIVED, selectedId, onSelect, onExpandDone }) {
  const listRef = useRef(null);
  const heights = useRef(new Map());
  const gap = useRef(0);
  const latest = useRef(null);
  const observer = useRef(null);
  const observed = useRef(new Set());
  const refocus = useRef(false);
  const [, setMeasured] = useState(0);
  const [range, setRange] = useState(FIRST_PAINT);
  const { cards, folded, total } = shown;

  const stack = new CardStack(cards.map((card) => heights.current.get(card.id) ?? estimatedHeight(card)), gap.current);
  const held = new Set([...pinned, selectedId]);
  const items = stack.window(range, OVERSCAN, cards.flatMap((card, index) => (held.has(card.id) ? [index] : [])));

  const follow = () => {
    const list = listRef.current;
    const scroller = list?.parentElement;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const next = latest.current.rangeIn(top, top + scroller.clientHeight);
    setRange((current) => (current.first === next.first && current.last === next.last ? current : next));
  };

  // The column's scroll and size move the range; each card's settled size replaces its estimate.
  useEffect(() => {
    const scroller = listRef.current.parentElement;
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = entry.target.dataset.stepId;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.offsetHeight;
        if (id === undefined || height === 0 || heights.current.get(id) === height) continue;
        heights.current.set(id, height);
        changed = true;
      }
      if (changed) setMeasured((count) => count + 1);
      else follow();
    });
    observer.current.observe(scroller);
    scroller.addEventListener('scroll', follow, { passive: true });
    return () => {
      observer.current.disconnect();
      scroller.removeEventListener('scroll', follow);
    };
  }, []);

  // After each render: watch the cards it painted, take the column's gap, and fit the range to the scroll.
  useEffect(() => {
    latest.current = stack;
    const list = listRef.current;
    const rendered = new Set(list.querySelectorAll(':scope > .st-board-card'));
    for (const element of observed.current) if (!rendered.has(element)) observer.current.unobserve(element);
    for (const element of rendered) observer.current.observe(element);
    observed.current = rendered;
    const rowGap = parseFloat(getComputedStyle(list).rowGap) || 0;
    if (rowGap !== gap.current) {
      gap.current = rowGap;
      setMeasured((count) => count + 1);
    }
    follow();
  });

  // A focused Show all unfolds into the card that took its place.
  useEffect(() => {
    if (folded || !refocus.current) return;
    refocus.current = false;
    listRef.current.querySelector(`[data-step-id="${CSS.escape(cards[DONE_RECENT_LIMIT].id)}"]`)?.focus();
  }, [folded]);

  const expand = (event) => {
    refocus.current = event.currentTarget === document.activeElement;
    onExpandDone();
  };

  return (
    <>
      <div className="st-board-cards" ref={listRef}>
        {items.map((item) => (typeof item === 'number'
          ? (
            <StepCard
              key={cards[item].id}
              card={cards[item]}
              selected={cards[item].id === selectedId}
              arrived={arrived.has(cards[item].id)}
              tabIndex={cards[item].id === stopId ? 0 : -1}
              onSelect={onSelect}
            />
          )
          : <div key={`spacer-${item.from}`} className="st-board-cards-spacer" style={{ height: item.spacer }} aria-hidden />))}
      </div>
      {folded && (
        <button type="button" tabIndex={stopId === SHOW_ALL ? 0 : -1} className="st-board-show-all" onClick={expand}>
          {showAllDone({ total })}
          <Chevron size={18} />
        </button>
      )}
    </>
  );
}
