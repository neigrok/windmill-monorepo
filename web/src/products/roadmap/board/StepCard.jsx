// One step on the Board: the kind rail, the title, the reason line and a two-line excerpt; the whole card opens its step.

import React, { useRef, useState } from 'react';
import { SwipeGesture, SWIPE_REVEAL } from './gestures.js';
import { KIND_CSS, DEFAULT_NODE_COLOR } from '../theme.js';
import { completeStepAction, STEP_DETAIL, reasonLine } from './copy.js';

export const StepCard = React.memo(function StepCard({ card, selected = false, arrived = false, tabIndex = 0, onSelect, swipe = false, open = false, onSwipe, onComplete, leaving = false, dimmed = false }) {
  const reason = reasonLine(card);
  const description = card.step.description?.trim() ?? '';
  const kind = KIND_CSS[card.step.color] ?? KIND_CSS[DEFAULT_NODE_COLOR];
  const cardButton = (
    <button
      type="button"
      className={`st-board-card st-board-card--${card.column}${arrived ? ' is-arrived' : ''}${leaving ? ' is-leaving' : ''}${dimmed ? ' is-restored' : ''}`}
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
  if (!swipe || card.column !== 'upNext') return cardButton;
  return <SwipeCard card={card} open={open} onSwipe={onSwipe} onComplete={onComplete} tabIndex={tabIndex}>{cardButton}</SwipeCard>;
});

function SwipeCard({ card, open, onSwipe, onComplete, tabIndex, children }) {
  const gesture = useRef(null);
  const dragged = useRef(false);
  const [offset, setOffset] = useState(null);
  const down = (event) => {
    if (event.pointerType === 'mouse' || event.target.closest('.st-board-swipe-complete')) return;
    gesture.current = new SwipeGesture({ x: event.clientX, y: event.clientY, width: window.innerWidth, open });
    dragged.current = false;
  };
  const move = (event) => {
    if (!gesture.current) return;
    const next = gesture.current.move(event.clientX, event.clientY);
    if (!next.claimed) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragged.current = true;
    onSwipe(card.id);
    setOffset(next.offset);
    if (next.tick) navigator.vibrate?.(8);
  };
  const end = (cancelled) => {
    if (!gesture.current) return;
    onSwipe(!cancelled && gesture.current.release() ? card.id : null);
    gesture.current = null;
    setOffset(null);
  };
  return (
    <div className={`st-board-swipe${open ? ' is-open' : ''}${offset !== null ? ' is-dragging' : ''}`} data-step-id={card.id}
      style={{ '--swipe-offset': `${offset ?? (open ? SWIPE_REVEAL + 8 : 0)}px` }}
      onPointerDown={down} onPointerMove={move} onPointerUp={() => end(false)} onPointerCancel={() => end(true)}
      onClickCapture={(event) => { if (dragged.current && !event.target.closest('.st-board-swipe-complete')) { event.preventDefault(); event.stopPropagation(); dragged.current = false; } }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onSwipe(null); }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onSwipe(null); event.currentTarget.querySelector('.st-board-card').focus(); } }}>
      {children}
      <button type="button" className="st-board-swipe-complete" tabIndex={tabIndex} aria-label={completeStepAction({ step: card.step.label })}
        onFocus={() => onSwipe(card.id)} onClick={() => { onSwipe(null); onComplete(card.id, 'swipe'); }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m5 12 4 4 10-10" /></svg>
        <span>{STEP_DETAIL.complete}</span>
      </button>
    </div>
  );
}
