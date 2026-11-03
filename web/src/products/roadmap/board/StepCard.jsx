// One step on the Board: the kind rail, the title, the reason line and a two-line excerpt; the whole card opens its step.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SwipeGesture, SWIPE_REVEAL } from './gestures.js';
import { HoldGesture, HOLD_MS } from '../input/HoldGesture.js';
import { hueOf } from '../theme.js';
import { completeStepAction, STEP_DETAIL, reasonLine } from '../copy.js';

const SWIPE_ACTION_GAP = 8;
const SWIPE_HAPTIC_MS = 8;

export const StepCard = React.memo(function StepCard({ card, selected = false, arrived = false, tabIndex = 0, onSelect, swipe = false, open = false, onSwipe, onComplete, leaving = false, dimmed = false, selecting = false, checked = false, onHold }) {
  const reason = reasonLine(card);
  const description = card.step.description?.trim() ?? '';
  const kind = hueOf(card.step.color);
  const cardButton = (
    <button
      type="button"
      className={`st-board-card st-board-card--${card.column}${arrived ? ' is-arrived' : ''}${leaving ? ' is-leaving' : ''}${dimmed ? ' is-restored' : ''}${checked ? ' is-selected' : ''}`}
      style={{ '--st-board-rail': kind.base }}
      data-step-id={card.id}
      tabIndex={tabIndex}
      aria-current={selected ? 'true' : undefined}
      aria-pressed={selecting ? checked : undefined}
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
  return <InteractiveCard card={card} onHold={onHold} selecting={selecting}
    swipe={swipe && card.column === 'upNext'} open={open} onSwipe={onSwipe} onComplete={onComplete} tabIndex={tabIndex}>{cardButton}</InteractiveCard>;
});

function InteractiveCard({ card, onHold, selecting, swipe, open, onSwipe, onComplete, tabIndex, children }) {
  const hold = useRef(null);
  const timer = useRef(null);
  const scroller = useRef(null);
  const swallowed = useRef(false);
  const callbacks = useRef({ onHold, onSwipe });
  callbacks.current = { onHold, onSwipe };
  const cancelHold = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    hold.current?.cancel();
    scroller.current?.removeEventListener('scroll', cancelHold);
    scroller.current = null;
  }, []);
  const holdEnabled = Boolean(onHold);
  useEffect(() => cancelHold, [holdEnabled, cancelHold]);
  const startHold = (event) => {
    cancelHold();
    hold.current = null;
    swallowed.current = false;
    if (event.pointerType !== 'touch' || event.isPrimary === false) return;
    const gesture = new HoldGesture({ x: event.clientX, y: event.clientY, at: performance.now() });
    hold.current = gesture;
    const deadline = gesture.at + HOLD_MS;
    scroller.current = event.currentTarget.closest('[data-column]');
    scroller.current?.addEventListener('scroll', cancelHold, { passive: true });
    timer.current = setTimeout(() => {
      if (!gesture.advance(deadline)) return;
      swallowed.current = true;
      callbacks.current.onSwipe?.(null);
      callbacks.current.onHold?.(card.id);
    }, HOLD_MS);
  };
  const button = React.cloneElement(children, {
    onPointerDown: startHold,
    onPointerMove: (event) => hold.current?.move(event.clientX, event.clientY),
    onPointerUp: () => {
      swallowed.current ||= hold.current?.release() ?? false;
      cancelHold();
    },
    onPointerCancel: cancelHold,
    onContextMenu: (event) => { if (onHold || selecting) event.preventDefault(); },
    onClick: (event) => {
      if (swallowed.current) {
        swallowed.current = false;
        event.preventDefault();
        return;
      }
      children.props.onClick(event);
    },
  });
  if (!swipe) return button;
  return <SwipeCard hold={hold} card={card} open={open} onSwipe={onSwipe} onComplete={onComplete} tabIndex={tabIndex}>{button}</SwipeCard>;
}

function SwipeCard({ hold, card, open, onSwipe, onComplete, tabIndex, children }) {
  const gesture = useRef(null);
  const dragged = useRef(false);
  const [offset, setOffset] = useState(null);
  const down = (event) => {
    if (event.pointerType === 'mouse' || event.target.closest('.st-board-swipe-complete')) return;
    gesture.current = new SwipeGesture({ x: event.clientX, y: event.clientY, width: window.innerWidth, open });
    dragged.current = false;
  };
  const move = (event) => {
    if (!gesture.current || hold.current?.fired) return;
    const next = gesture.current.move(event.clientX, event.clientY);
    if (!next.claimed) return;
    hold.current?.cancel();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragged.current = true;
    onSwipe(card.id);
    setOffset(next.offset);
    if (next.tick) navigator.vibrate?.(SWIPE_HAPTIC_MS);
  };
  const end = (cancelled) => {
    if (!gesture.current) return;
    onSwipe(!cancelled && !hold.current?.fired && gesture.current.release() ? card.id : null);
    gesture.current = null;
    setOffset(null);
  };
  return (
    <div className={`st-board-swipe${open ? ' is-open' : ''}${offset !== null ? ' is-dragging' : ''}`} data-step-id={card.id}
      style={{ '--swipe-offset': `${offset ?? (open ? SWIPE_REVEAL + SWIPE_ACTION_GAP : 0)}px` }}
      onPointerDown={down} onPointerMove={move} onPointerUp={() => end(false)} onPointerCancel={() => end(true)}
      onClickCapture={(event) => {
        if (!dragged.current || event.target.closest('.st-board-swipe-complete')) return;
        event.preventDefault();
        event.stopPropagation();
        dragged.current = false;
      }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onSwipe(null); }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onSwipe(null);
        event.currentTarget.querySelector('.st-board-card').focus();
      }}>
      {children}
      <button type="button" className="st-board-swipe-complete" tabIndex={tabIndex} aria-label={completeStepAction({ step: card.step.label })}
        onFocus={() => onSwipe(card.id)} onClick={() => {
          onSwipe(null);
          onComplete(card.id, 'swipe');
        }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m5 12 4 4 10-10" /></svg>
        <span>{STEP_DETAIL.complete}</span>
      </button>
    </div>
  );
}
