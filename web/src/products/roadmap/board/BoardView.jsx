// The Board view layer: the identity row where no chrome carries one, the device notice, then the columns for the band.

import React, { useMemo, useState } from 'react';
import './board.css';
import { Board } from './Board.js';
import { BoardColumns } from './BoardColumns.jsx';
import { PhoneSegments } from './PhoneSegments.jsx';
import { ViewSwitch } from './ViewSwitch.jsx';
import { progressFigure, progressLabel } from './copy.js';

export default function BoardView({
  tree,
  completed,
  completedAt,
  selectedId,
  onSelect,
  title,
  notice = null,
  identity = false,
  breakpoint,
  onSwitchView,
  topInset = 0,
  laneInset = 0,
}) {
  const board = useMemo(() => new Board(tree, { completed, completedAt }), [tree, completed, completedAt]);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const onToggleDone = () => setDoneExpanded((expanded) => !expanded);
  const phone = breakpoint === 'phone';

  return (
    <div
      className={`st-board ${phone ? 'st-board--phone' : 'st-board--columns'}`}
      style={{ paddingTop: topInset > 0 ? `calc(${topInset}px + var(--space-3))` : undefined, paddingBottom: laneInset }}
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
      {phone
        ? <PhoneSegments board={board} selectedId={selectedId} onSelect={onSelect} doneExpanded={doneExpanded} onToggleDone={onToggleDone} />
        : <BoardColumns board={board} band={breakpoint} selectedId={selectedId} onSelect={onSelect} doneExpanded={doneExpanded} onToggleDone={onToggleDone} />}
    </div>
  );
}
