// From 744px: Locked · Up next · Done side by side, each scrolling under its sticky heading. At 1024px and up
// all three stand; below it one side column folds to a rail and Show swaps which one, Up next never folds.

import React, { useId, useEffect, useRef, useState } from 'react';
import './columns.css';
import { track } from '../../../telemetry/beacon.js';
import { KIND_CSS, DEFAULT_NODE_COLOR } from '../theme.js';
import { ColumnCards } from './StepCard.jsx';
import { COLUMN_TITLES, LABELS, columnHeadingLabel, formatCount, showColumn } from './copy.js';

export const DEFAULT_RAIL = 'done';
const RAIL_DECK_DEPTH = 3;

export function columnStage({ band, railed = DEFAULT_RAIL }) {
  if (band !== 'tablet') return { locked: 'full', upNext: 'full', done: 'full' };
  return { locked: railed === 'locked' ? 'rail' : 'full', upNext: 'full', done: railed === 'done' ? 'rail' : 'full' };
}

export function swapRail(railed) {
  return railed === 'done' ? 'locked' : 'done';
}

// Revealing a step that sits in the rail stands its column and folds the other side column instead.
export function railToReveal(railed, column) {
  return column === railed ? swapRail(railed) : railed;
}

// Tabbing forward into the cards lands on the first Up next card. Backward entry, a pointer press and focus
// from anywhere that does not precede the columns stay where they fell.
export function enterAtUpNext(event) {
  const columns = event.currentTarget;
  const from = event.relatedTarget;
  if (!from || columns.contains(from)) return;
  if (!(columns.compareDocumentPosition(from) & columns.DOCUMENT_POSITION_PRECEDING)) return;
  if (!event.target.matches('.st-board-card:focus-visible')) return;
  const first = columns.querySelector('.st-board-columns-column--upNext .st-board-card');
  if (first && first !== event.target) first.focus();
}

export function BoardColumns({ board, band, railed, onShowRail, selectedId, onSelect, doneExpanded, onExpandDone }) {
  const columnsRef = useRef(null);
  const showPressed = useRef(false);
  const stage = columnStage({ band, railed });
  const recentDone = board.recentDone();

  // The rail that was pressed has stood up and a new rail took its place, so focus moves to that rail's Show.
  useEffect(() => {
    if (!showPressed.current) return;
    showPressed.current = false;
    columnsRef.current?.querySelector('.st-board-columns-show')?.focus();
  }, [railed]);

  const show = (column) => {
    track('roadmap_board_rail', { column });
    showPressed.current = true;
    onShowRail();
  };

  return (
    <div className="st-board-columns" ref={columnsRef} onFocus={enterAtUpNext}>
      {board.columns.map((column) => (stage[column.name] === 'rail'
        ? <ColumnRail key={`${column.name}-rail`} column={column} onShow={() => show(column.name)} />
        : (
          <FullColumn key={column.name} column={column}>
            <ColumnCards
              column={column}
              recentDone={recentDone}
              doneExpanded={doneExpanded}
              selectedId={selectedId}
              onSelect={onSelect}
              onExpandDone={onExpandDone}
            />
          </FullColumn>
        )))}
    </div>
  );
}

function ColumnHeading({ column, id, scrolled = false, compact = false }) {
  return (
    <h2
      id={id}
      className={`st-board-columns-heading st-board-columns-heading--${column.name} ${scrolled ? 'is-scrolled' : ''}`}
      aria-label={columnHeadingLabel({ column: column.name, count: column.count })}
    >
      {column.name === 'upNext' && <span className="st-board-columns-accent" aria-hidden />}
      <span className="st-board-columns-title">{COLUMN_TITLES[column.name]}</span>
      <span className="st-board-columns-count">{formatCount(column.count, { compact })}</span>
    </h2>
  );
}

function FullColumn({ column, children }) {
  const [scrolled, setScrolled] = useState(false);
  return (
    <section
      className={`st-board-columns-column st-board-columns-column--${column.name}`}
      onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
    >
      <ColumnHeading column={column} scrolled={scrolled} />
      {children}
    </section>
  );
}

// The rail keeps the column's count, compact as the phone's, and its first cards in view: the first card in front, the
// next two peeking behind.
function ColumnRail({ column, onShow }) {
  const headingId = useId();
  const deck = column.cards.slice(0, RAIL_DECK_DEPTH).reverse();
  return (
    <section className={`st-board-columns-rail st-board-columns-rail--${column.name}`} aria-labelledby={headingId}>
      <ColumnHeading column={column} id={headingId} compact />
      {deck.length > 0 && (
        <div className="st-board-columns-deck" aria-hidden>
          {deck.map((card, index) => {
            const behind = deck.length - 1 - index;
            const kind = KIND_CSS[card.step.color] ?? KIND_CSS[DEFAULT_NODE_COLOR];
            return (
              <span key={card.id} className={`st-board-columns-deck-layer st-board-columns-deck-layer--behind-${behind}`}>
                <span className="st-board-columns-deck-card" style={{ '--st-board-rail': kind.base }}>
                  <span className="st-board-columns-deck-rail" />
                  {behind === 0 && <span className="st-board-columns-deck-title">{card.step.label}</span>}
                </span>
              </span>
            );
          })}
        </div>
      )}
      <button type="button" className="st-board-columns-show" onClick={onShow}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 7.5L10 12.5L15 7.5" />
        </svg>
        <span aria-hidden>{LABELS.show}</span>
        <span className="st-board-spoken">{showColumn({ column: column.name })}</span>
      </button>
    </section>
  );
}
