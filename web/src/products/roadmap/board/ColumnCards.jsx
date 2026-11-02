// A column's run of step cards: only the cards in view render, each measured as it paints, with a spacer standing in for
// every stretch skipped. A folded Done ends with the Show all row. Steps that arrive while the Board is mounted wake once.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { regroup, DONE_RECENT_LIMIT } from './Board.js';
import { StepCard } from './StepCard.jsx';
import { SHOW_ALL } from './traversal.js';
import { reasonLine, showAllDone } from './copy.js';

const WAKE_MS = 2400; // the Arrived edge settles over two 1200ms pulses
const OVERSCAN = 10;
const FIRST_PAINT = { first: 0, last: 15 };
const FIRST_RUN = { gap: 8, width: 360 };
const NOTHING_ARRIVED = new Set();

// A card's frame (padding and border above and below its text), the width its sides take (padding, border, the kind rail
// and its gap), and each clamped line's height with a Nunito glyph's average advance.
const CARD = { frame: 26, sides: 46, gap: 4 };
const LINES = {
  title: { height: 24, advance: 7.6 },
  reason: { height: 18, advance: 5.8 },
  excerpt: { height: 20, advance: 5.6 },
};

// Lucide's chevron-down on the 24 grid: 2px strokes, so 1.5px at 18 and 1.67px at 20, as the Board icons draw it.
export function Chevron({ size }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// An unmeasured card's height in a run `width` wide: each of its texts wraps to one or two lines by its length.
export function estimatedHeight(card, width) {
  const room = Math.max(1, width - CARD.sides);
  const texts = [
    [card.step.label ?? '', LINES.title],
    [reasonLine(card) ?? '', LINES.reason],
    [card.step.description?.trim() ?? '', LINES.excerpt],
  ].filter(([text], index) => index === 0 || text !== '');
  const lines = texts.map(([text, line]) => Math.min(2, Math.max(1, Math.ceil((text.length * line.advance) / room))) * line.height);
  return CARD.frame + lines.reduce((sum, height) => sum + height, 0) + (texts.length - 1) * CARD.gap;
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

// One timeline owns the displayed cards, arrival counts, travel and wake across all columns.
export function useRegroup(board, { quiet = 0, phone = false, root } = {}) {
  const [state, setState] = useState({
    target: board, timeline: board, board, counts: board, quiet,
    arrived: NOTHING_ARRIVED, leaving: NOTHING_ARRIVED, dimmed: NOTHING_ARRIVED,
    moved: [], phase: 'settled',
  });
  const positions = useRef(new Map());
  const animations = useRef([]);
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (board !== state.target) {
    const change = board && state.board
      ? regroup(state.board, board)
      : { arrived: NOTHING_ARRIVED, leaving: NOTHING_ARRIVED, moved: [] };
    const reset = change.arrived.size === 0 && change.moved.some((move) => move.from === 'done');
    const continuingQuiet = state.phase === 'quiet' && quiet === state.quiet && board?.treeId === state.target?.treeId
      && change.arrived.size === 0 && change.leaving.size === 0;
    const downward = quiet !== state.quiet || reset || continuingQuiet;
    const moving = !downward && (change.arrived.size > 0 || change.leaving.size > 0);
    const dimmed = downward
      ? new Set([...change.arrived, ...change.moved.map(({ id }) => id)])
      : NOTHING_ARRIVED;
    let phase = 'settled';
    if (downward) phase = 'quiet';
    if (moving) phase = 'leaving';
    setState({
      target: board,
      timeline: continuingQuiet ? state.timeline : board,
      board: moving ? state.board : board,
      counts: moving ? state.counts : board,
      arrived: downward ? NOTHING_ARRIVED : change.arrived,
      leaving: downward ? NOTHING_ARRIVED : change.leaving,
      moved: continuingQuiet ? state.moved : change.moved,
      dimmed: continuingQuiet ? state.dimmed : dimmed,
      phase,
      quiet,
    });
  } else if (quiet !== state.quiet) {
    setState({ ...state, quiet });
  }

  const pinned = useMemo(() => new Set(state.moved.map(({ id }) => id)), [state.moved]);

  useEffect(() => {
    if (state.phase === 'settled') return undefined;
    const timers = [];
    let fastForward = null;
    const finish = () => {
      for (const animation of animations.current) {
        if (animation.playState !== 'idle') animation.finish();
      }
      setState((current) => ({
        ...current, board: current.target, counts: current.target,
        leaving: NOTHING_ARRIVED, phase: 'settled',
      }));
    };

    if (state.phase === 'quiet') {
      timers.push(setTimeout(finish, 280));
    } else if (reduced) {
      timers.push(setTimeout(finish, 150));
    } else if (phone) {
      if (state.arrived.size === 0) {
        timers.push(setTimeout(finish, 280));
      } else {
        timers.push(setTimeout(() => setState((current) => ({
          ...current, board: current.target, counts: current.target,
          leaving: NOTHING_ARRIVED, phase: 'waking',
        })), 280));
        timers.push(setTimeout(finish, 760));
      }
    } else {
      const travels = state.moved.some((move) => state.arrived.has(move.id));
      if (travels) {
        timers.push(setTimeout(() => setState((current) => ({
          ...current, board: current.target, phase: 'travelling',
        })), 430));
        timers.push(setTimeout(finish, 750));
      } else {
        timers.push(setTimeout(finish, 430));
      }
    }

    const forward = () => {
      if (fastForward !== null) return;
      for (const timer of timers) clearTimeout(timer);
      fastForward = setTimeout(finish, 150);
    };
    for (const name of ['pointerdown', 'wheel', 'keydown']) window.addEventListener(name, forward, { passive: true });
    return () => {
      for (const timer of timers) clearTimeout(timer);
      clearTimeout(fastForward);
      for (const name of ['pointerdown', 'wheel', 'keydown']) window.removeEventListener(name, forward);
    };
  }, [state.timeline]);

  useLayoutEffect(() => {
    if (state.phase === 'leaving') {
      const cards = [...root.current?.querySelectorAll('.st-board-card') ?? []];
      positions.current = new Map(cards.map((element) => [element.dataset.stepId, element.getBoundingClientRect()]));
      const leaving = cards.filter((element) => state.leaving.has(element.dataset.stepId) && !state.arrived.has(element.dataset.stepId));
      animations.current = leaving.map((element) => {
        const box = positions.current.get(element.dataset.stepId);
        const frames = reduced ? [{ opacity: 1 }, { opacity: 0 }] : [
          { opacity: 1, height: `${box.height}px` },
          {
            opacity: 0, height: '0px', minHeight: '0px', paddingTop: '0px', paddingBottom: '0px',
            borderTopWidth: '0px', borderBottomWidth: '0px', marginBottom: '-8px',
          },
        ];
        return element.animate(frames, {
          delay: phone || reduced ? 0 : 150,
          duration: reduced ? 150 : 280,
          fill: 'forwards',
          easing: getComputedStyle(element).getPropertyValue('--ease-standard').trim(),
        });
      });
    } else if (state.phase === 'travelling') {
      animations.current = state.moved.filter((move) => state.arrived.has(move.id)).flatMap(({ id }) => {
        const before = positions.current.get(id);
        const element = root.current?.querySelector(`.st-board-card[data-step-id="${CSS.escape(id)}"]`);
        if (!before || !element) return [];
        const after = element.getBoundingClientRect();
        const traveller = element.cloneNode(true);
        traveller.removeAttribute('data-step-id');
        traveller.setAttribute('aria-hidden', 'true');
        traveller.tabIndex = -1;
        Object.assign(traveller.style, {
          position: 'fixed', zIndex: '5', pointerEvents: 'none', margin: '0',
          left: `${after.left}px`, top: `${after.top}px`, width: `${after.width}px`, height: `${after.height}px`,
        });
        root.current.appendChild(traveller);
        element.style.opacity = '0';
        const animation = traveller.animate([
          { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)`, opacity: 1 },
          { transform: 'translate(0, 0)', opacity: 1 },
        ], { duration: 320, easing: getComputedStyle(element).getPropertyValue('--ease-soft').trim() });
        const remove = () => {
          traveller.remove();
          element.style.removeProperty('opacity');
        };
        animation.onfinish = remove;
        animation.oncancel = remove;
        return [animation];
      });
    }
    return () => {
      for (const animation of animations.current) animation.cancel();
      animations.current = [];
    };
  }, [state.target, state.phase]);

  useEffect(() => {
    if (state.phase !== 'settled' || state.arrived.size === 0) return undefined;
    const timer = setTimeout(() => setState((current) => ({ ...current, arrived: NOTHING_ARRIVED })), WAKE_MS);
    return () => clearTimeout(timer);
  }, [state.phase, state.target]);
  const settle = (id) => setState((current) => {
    if (!current.arrived.has(id)) return current;
    return { ...current, arrived: new Set([...current.arrived].filter((candidate) => candidate !== id)) };
  });
  const arrived = state.phase === 'settled' || state.phase === 'waking' ? state.arrived : NOTHING_ARRIVED;
  return { ...state, arrived, pinned, settle };
}

// The run scrolls inside its parent, the column. The roving stop, a card focus is moving to and the selected step always
// render, so focus and a reveal from the Graph reach them wherever the column has scrolled.
export function ColumnCards({ shown, stopId, pendingId, arrived = NOTHING_ARRIVED, selectedId, onSelect, onExpandDone, swipe = false, onComplete, leaving = NOTHING_ARRIVED, pinned = NOTHING_ARRIVED, dimmed = NOTHING_ARRIVED }) {
  const [swiped, setSwiped] = useState(null);
  const listRef = useRef(null);
  const heights = useRef(new Map());
  const latest = useRef(null);
  const anchor = useRef(null);
  const observer = useRef(null);
  const observed = useRef(new Set());
  const refocus = useRef(false);
  const [measured, setMeasured] = useState(0);
  const [run, setRun] = useState(FIRST_RUN);
  const [range, setRange] = useState(FIRST_PAINT);
  const { cards, folded, total } = shown;

  const stack = useMemo(
    () => new CardStack(cards.map((card) => heights.current.get(card.id) ?? estimatedHeight(card, run.width)), run.gap),
    [cards, measured, run],
  );
  const items = useMemo(() => {
    const pins = new Set([stopId, pendingId, selectedId, ...pinned].filter((id) => typeof id === 'string'));
    return stack.window(range, OVERSCAN, cards.flatMap((card, index) => (pins.has(card.id) ? [index] : [])));
  }, [stack, range, stopId, pendingId, selectedId, pinned]);
  latest.current = stack;

  const follow = () => {
    const list = listRef.current;
    const scroller = list?.parentElement;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const next = latest.current.rangeIn(top, top + scroller.clientHeight);
    setRange((current) => (current.first === next.first && current.last === next.last ? current : next));
  };

  // The first card in view and where it stands, as of the column's last scroll.
  const markAnchor = () => {
    const list = listRef.current;
    const scroller = list.parentElement;
    const viewTop = scroller.getBoundingClientRect().top;
    const first = [...list.children].find((element) => element.dataset.stepId && element.getBoundingClientRect().bottom > viewTop);
    anchor.current = first
      ? { id: first.dataset.stepId, offset: first.getBoundingClientRect().top - viewTop, scrollTop: scroller.scrollTop }
      : null;
  };

  // Cards above the anchor that settled to their measured height, or took a spacer's place, move the scroll by as much,
  // so the view holds still: scroll anchoring done here, since the columns turn the browser's off and WebKit has none.
  const keepAnchor = () => {
    const held = anchor.current;
    const list = listRef.current;
    const scroller = list.parentElement;
    const element = held && Math.abs(scroller.scrollTop - held.scrollTop) < 1
      ? list.querySelector(`:scope > [data-step-id="${CSS.escape(held.id)}"]`)
      : null;
    if (element) {
      const drift = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - held.offset;
      if (Math.abs(drift) >= 0.5) scroller.scrollTop += drift;
    }
    markAnchor();
  };

  // The column's size sets the run's gap and width; a card's settled size replaces its estimate.
  useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = list.parentElement;
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = entry.target.dataset.stepId;
        if (id === undefined) {
          const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
          setRun((current) => (current.gap === gap && current.width === list.clientWidth ? current : { gap, width: list.clientWidth }));
          continue;
        }
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.offsetHeight;
        if (height === 0 || heights.current.get(id) === height) continue;
        heights.current.set(id, height);
        changed = true;
      }
      if (changed) {
        keepAnchor();
        setMeasured((count) => count + 1);
      } else {
        follow();
      }
    });
    observer.current.observe(scroller);
    const scrolled = () => {
      setSwiped(null);
      markAnchor();
      follow();
    };
    scroller.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      observer.current.disconnect();
      observed.current = new Set();
      scroller.removeEventListener('scroll', scrolled);
    };
  }, []);

  // Before the window paints: hold the view still, then watch only the cards it newly rendered and let go of the dropped.
  useLayoutEffect(() => {
    keepAnchor();
    const rendered = new Set(listRef.current.querySelectorAll(':scope > .st-board-card, :scope > .st-board-swipe'));
    for (const element of observed.current) if (!rendered.has(element)) observer.current.unobserve(element);
    for (const element of rendered) if (!observed.current.has(element)) observer.current.observe(element);
    observed.current = rendered;
  }, [items]);

  useEffect(follow, [stack]);
  useEffect(() => setSwiped(null), [swipe]);

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
              swipe={swipe}
              open={swiped === cards[item].id}
              onSwipe={setSwiped}
              onComplete={onComplete}
              leaving={leaving.has(cards[item].id)}
              dimmed={dimmed.has(cards[item].id)}
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
