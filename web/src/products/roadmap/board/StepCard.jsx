// One step on the Board: the kind rail, the title, the reason line and a two-line excerpt; the whole card opens its step.

import React from 'react';
import { KIND_CSS, DEFAULT_NODE_COLOR } from '../theme.js';
import { reasonLine } from './copy.js';

export const StepCard = React.memo(function StepCard({ card, selected = false, arrived = false, tabIndex = 0, onSelect }) {
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
});
