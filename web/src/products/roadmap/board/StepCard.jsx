// One step on the Board: the kind rail, the title, the reason line and a two-line excerpt; the whole card selects its step.
// A column's run of them ends, while Done is folded, with the Show all row.

import React, { useContext } from 'react';
import { KIND_CSS, DEFAULT_NODE_COLOR } from '../theme.js';
import { reasonLine, showAllDone } from './copy.js';
import { UpNextRest } from './BoardStates.jsx';

export function StepCard({ card, selected = false, onSelect }) {
  const reason = reasonLine(card);
  const description = card.step.description?.trim() ?? '';
  const kind = KIND_CSS[card.step.color] ?? KIND_CSS[DEFAULT_NODE_COLOR];
  return (
    <button
      type="button"
      className={`st-board-card st-board-card--${card.column}`}
      style={{ '--st-board-rail': kind.base }}
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

export function ColumnCards({ column, recentDone, doneExpanded, selectedId, onSelect, onExpandDone }) {
  const upNextRest = useContext(UpNextRest);
  if (column.name === 'upNext' && upNextRest !== null) return upNextRest;
  const folded = column.name === 'done' && recentDone.folded && !doneExpanded;
  return (
    <>
      {(folded ? recentDone.cards : column.cards).map((card) => (
        <StepCard key={card.id} card={card} selected={card.id === selectedId} onSelect={onSelect} />
      ))}
      {folded && (
        <button type="button" className="st-board-show-all" onClick={onExpandDone}>
          {showAllDone({ total: recentDone.total })}
        </button>
      )}
    </>
  );
}
