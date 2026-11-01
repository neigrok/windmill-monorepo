// The Board view layer: the identity row where no chrome carries one, the device notice, then the columns for the band.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import './board.css';
import { Board } from './Board.js';
import { BoardColumns, DEFAULT_RAIL, railToReveal, swapRail } from './BoardColumns.jsx';
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
  active = false,
  onSwitchView,
  topInset = 0,
  bottomInset = 0,
}) {
  const board = useMemo(() => new Board(tree, { completed, completedAt }), [tree, completed, completedAt]);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [railed, setRailed] = useState(DEFAULT_RAIL);
  const [shown, setShown] = useState('upNext');
  const [wasActive, setWasActive] = useState(false);
  const boardRef = useRef(null);
  const phone = breakpoint === 'phone';

  // Shown with a step selected (Graph → Board, a link): its column opens — the phone's tab, past the Done fold,
  // out of the tablet's rail. A follow, never a pick, so it emits nothing.
  if (active !== wasActive) {
    setWasActive(active);
    const column = active ? board.columnOf(selectedId) : null;
    if (column !== null) setShown(column);
    if (column === 'done' && !board.recentDone().cards.some((card) => card.id === selectedId)) setDoneExpanded(true);
    if (column !== null && breakpoint === 'tablet') setRailed((current) => railToReveal(current, column));
  }

  // Then its card scrolls into view at once, so reduced motion has nothing to opt out of.
  useEffect(() => {
    if (!active) return;
    boardRef.current?.querySelector('.st-board-card[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [active]);

  const onExpandDone = () => setDoneExpanded(true);

  return (
    <div
      ref={boardRef}
      className={`st-board ${phone ? 'st-board--phone' : 'st-board--columns'}`}
      style={{ paddingTop: topInset > 0 ? `calc(${topInset}px + var(--space-3))` : undefined, paddingBottom: bottomInset }}
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
        ? (
          <PhoneSegments
            board={board}
            shown={shown}
            onShow={setShown}
            selectedId={selectedId}
            onSelect={onSelect}
            doneExpanded={doneExpanded}
            onExpandDone={onExpandDone}
          />
        )
        : (
          <BoardColumns
            board={board}
            band={breakpoint}
            railed={railed}
            onShowRail={() => setRailed(swapRail)}
            selectedId={selectedId}
            onSelect={onSelect}
            doneExpanded={doneExpanded}
            onExpandDone={onExpandDone}
          />
        )}
    </div>
  );
}
