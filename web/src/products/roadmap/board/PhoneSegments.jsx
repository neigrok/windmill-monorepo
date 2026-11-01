// Placeholder until the phone Board lands: below 744px, Locked, Up next and Done as plain stacks.

import React from 'react';
import { StepCard } from './StepCard.jsx';
import { COLUMN_TITLES, columnHeadingLabel, formatCount, showAllDone } from './copy.js';

export function PhoneSegments({ board, selectedId, onSelect, doneExpanded, onToggleDone }) {
  const recentDone = board.recentDone();
  const cardsOf = (column) => (column.name === 'done' && !doneExpanded ? recentDone.cards : column.cards);
  return board.columns.map((column) => (
    <section key={column.name} className="st-board-column">
      <h2 className="st-board-column-heading" aria-label={columnHeadingLabel({ column: column.name, count: column.count })}>
        {COLUMN_TITLES[column.name]} {formatCount(column.count)}
      </h2>
      <div className="st-board-column-cards">
        {cardsOf(column).map((card) => (
          <StepCard key={card.id} card={card} selected={card.id === selectedId} onSelect={onSelect} />
        ))}
      </div>
      {column.name === 'done' && recentDone.folded && !doneExpanded && (
        <button type="button" className="st-board-show-all" onClick={onToggleDone}>
          {showAllDone({ total: recentDone.total })}
        </button>
      )}
    </section>
  ));
}
