// From 744px: Locked · Up next · Done side by side, each scrolling under its sticky heading. At 1024px and up
// all three stand; below it one side column folds to a rail and Show swaps which one, Up next never folds.

import React, { useContext, useId, useEffect, useMemo, useRef, useState } from 'react';
import './columns.css';
import { track } from '../../../telemetry/beacon.js';
import { KIND_CSS, DEFAULT_NODE_COLOR } from '../theme.js';
import { Chevron, ColumnCards, useArrivals } from './ColumnCards.jsx';
import { UpNextRest } from './BoardStates.jsx';
import { ColumnEmpty } from './BoardControls.jsx';
import { BoardQuery } from './Board.js';
import { RAIL, columnStops, useRovingFocus } from './traversal.js';
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

// The columns are one tab stop: the arrow keys rove across every card, the Show all row and a rail's Show. A column the
// query emptied names its way out; when every column is empty, only Up next does.
export function BoardColumns({
  board, band, railed, onShowRail, selectedId, onSelect, doneExpanded, onExpandDone, query = new BoardQuery(), onQuery,
}) {
  const showPressed = useRef(false);
  const stage = columnStage({ band, railed });
  const [arrived, settle] = useArrivals(board);
  const upNextRest = useContext(UpNextRest);
  const shown = useMemo(
    () => Object.fromEntries(board.columns.map((column) => [column.name, board.shownCards(column.name, { doneExpanded })])),
    [board, doneExpanded],
  );
  const layout = useMemo(() => board.columns.map((column) => ({
    name: column.name,
    stops: stage[column.name] === 'rail' ? [RAIL] : columnStops(shown[column.name]),
  })), [shown, band, railed]);
  const roving = useRovingFocus(layout);
  const everyEmpty = board.columns.every((column) => column.count === 0);
  const emptied = (column) => column.count === 0 && query.recovery !== null && (column.name === 'upNext' || !everyEmpty);

  // The rail that was pressed has stood up and a new rail took its place, so focus moves to that rail's Show.
  useEffect(() => {
    if (!showPressed.current) return;
    showPressed.current = false;
    roving.ref.current?.querySelector('.st-board-columns-show')?.focus();
  }, [railed]);

  const show = (column) => {
    track('roadmap_board_rail', { column });
    showPressed.current = true;
    onShowRail();
  };

  const expandDone = () => {
    track('roadmap_board_done_expand', { band });
    onExpandDone();
  };

  const focus = (event) => {
    roving.onFocus(event);
    settle(event.target.dataset.stepId);
  };

  return (
    <div className="st-board-columns" ref={roving.ref} onFocus={focus} onBlur={roving.onBlur} onKeyDown={roving.onKeyDown}>
      {board.columns.map((column) => (stage[column.name] === 'rail'
        ? (
          <ColumnRail
            key={`${column.name}-rail`}
            column={column}
            tabIndex={roving.stopIn(column.name) === RAIL ? 0 : -1}
            onShow={() => show(column.name)}
          />
        )
        : (
          <FullColumn key={column.name} column={column}>
            {column.name === 'upNext' && upNextRest !== null ? upNextRest : emptied(column) ? <ColumnEmpty query={query} onQuery={onQuery} /> : (
              <ColumnCards
                shown={shown[column.name]}
                stopId={roving.stopIn(column.name)}
                pendingId={roving.pendingIn(column.name)}
                arrived={arrived}
                selectedId={selectedId}
                onSelect={onSelect}
                onExpandDone={expandDone}
              />
            )}
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

// A scrolling column is never a tab stop of its own: the Board's one stop is the roving card (Chromium otherwise makes a
// scroller with nothing tabbable inside it keyboard-focusable).
function FullColumn({ column, children }) {
  const [scrolled, setScrolled] = useState(false);
  return (
    <section
      className={`st-board-columns-column st-board-columns-column--${column.name}`}
      data-column={column.name}
      tabIndex={-1}
      onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
    >
      <ColumnHeading column={column} scrolled={scrolled} />
      {children}
    </section>
  );
}

// The rail keeps the column's count, compact as the phone's, and its first cards in view: the first card in front, the
// next two peeking behind.
function ColumnRail({ column, tabIndex, onShow }) {
  const headingId = useId();
  const deck = column.cards.slice(0, RAIL_DECK_DEPTH).reverse();
  return (
    <section className={`st-board-columns-rail st-board-columns-rail--${column.name}`} aria-labelledby={headingId} data-column={column.name}>
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
      <button type="button" className="st-board-columns-show" tabIndex={tabIndex} onClick={onShow}>
        <Chevron size={20} />
        <span aria-hidden>{LABELS.show}</span>
        <span className="st-board-spoken">{showColumn({ column: column.name })}</span>
      </button>
    </section>
  );
}
