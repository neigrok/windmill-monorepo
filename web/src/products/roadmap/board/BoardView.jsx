// The Board view layer: the identity row where no chrome carries one, the device notice, then Locked, Up next and Done as plain stacks.

import React, { useMemo, useState } from 'react';
import './board.css';
import { Board } from './Board.js';
import { StepCard } from './StepCard.jsx';
import { ViewSwitch } from './ViewSwitch.jsx';
import { COLUMN_TITLES, columnHeadingLabel, formatCount, progressFigure, progressLabel, showAllDone } from './copy.js';

export default function BoardView({
  tree,
  completed,
  completedAt,
  selectedId,
  onSelect,
  title,
  notice = null,
  identity = false,
  phone = false,
  onSwitchView,
  underTopbar = false,
  laneInset = 0,
}) {
  const board = useMemo(() => new Board(tree, { completed, completedAt }), [tree, completed, completedAt]);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const recentDone = board.recentDone();
  const cardsOf = (column) => (column.name === 'done' && !doneExpanded ? recentDone.cards : column.cards);

  return (
    <div
      className={`st-board ${phone ? 'st-board--phone' : ''} ${underTopbar ? 'st-board--under-topbar' : ''}`}
      style={{ paddingBottom: laneInset }}
    >
      {identity && (
        <header className="st-board-identity">
          <h1 className="st-board-identity-title" title={title}>{title}</h1>
          <span className="st-board-identity-progress">
            <span aria-hidden>{progressFigure({ ...board.overall, compact: phone })}</span>
            <span className="st-board-spoken">{progressLabel(board.overall)}</span>
          </span>
          <ViewSwitch view="board" onSwitch={onSwitchView} phone={phone} />
        </header>
      )}
      {notice}
      {board.columns.map((column) => (
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
            <button type="button" className="st-board-show-all" onClick={() => setDoneExpanded(true)}>
              {showAllDone({ total: recentDone.total })}
            </button>
          )}
        </section>
      ))}
    </div>
  );
}
