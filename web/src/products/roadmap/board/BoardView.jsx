// The Board view layer: the identity row where no chrome carries one, the device notice, then the frame — the columns
// for the band, or the skeleton, the load error or the empty roadmap in their place.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import './board.css';
import { Board } from './Board.js';
import { BoardColumns, DEFAULT_RAIL, railToReveal, swapRail } from './BoardColumns.jsx';
import { PhoneSegments } from './PhoneSegments.jsx';
import { BoardSkeleton, EmptyRoadmap, LoadError, RoadmapComplete, UpNextRest, boardFrame } from './BoardStates.jsx';
import { ViewSwitch } from './ViewSwitch.jsx';
import { progressFigure, progressLabel } from './copy.js';

// Everything painted beneath the opaque Board leaves the tab order and the accessibility tree while it is shown: the
// layer's siblings stacked under it, the Graph's own overlays among them, and any that mount while it stays.
export function coverBeneath(layer) {
  const root = layer.parentElement;
  const floor = Number(getComputedStyle(layer).zIndex);
  const covered = new Set();
  const cover = () => {
    for (const sibling of root.children) {
      if (sibling === layer || sibling.inert || Number(getComputedStyle(sibling).zIndex) > floor) continue;
      sibling.inert = true;
      covered.add(sibling);
    }
  };
  cover();
  const watcher = new MutationObserver(cover);
  watcher.observe(root, { childList: true });
  return () => {
    watcher.disconnect();
    for (const sibling of covered) sibling.inert = false;
  };
}

export default function BoardView({
  tree,
  completed,
  completedAt,
  loading = false,
  failed = false,
  selectedId,
  onSelect,
  title,
  notice = null,
  identity = false,
  breakpoint,
  active = false,
  onSwitchView,
  onRetry,
  onShare,
  onNewStep,
  topInset = 0,
  bottomInset = 0,
}) {
  const frame = boardFrame({ tree, loading, failed });
  const board = useMemo(
    () => (frame === 'columns' ? new Board(tree, { completed, completedAt }) : null),
    [frame, tree, completed, completedAt],
  );
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [railed, setRailed] = useState(DEFAULT_RAIL);
  const [shown, setShown] = useState('upNext');
  const [wasRevealing, setWasRevealing] = useState(false);
  const boardRef = useRef(null);
  const phone = breakpoint === 'phone';
  const revealing = active && board !== null;

  // Shown with a step selected (Graph → Board, a link, a roadmap that just loaded): its column opens — the phone's tab,
  // past the Done fold, out of the tablet's rail. A follow, never a pick, so it emits nothing.
  if (revealing !== wasRevealing) {
    setWasRevealing(revealing);
    const column = revealing ? board.columnOf(selectedId) : null;
    if (column !== null) setShown(column);
    if (column === 'done' && !board.recentDone().cards.some((card) => card.id === selectedId)) setDoneExpanded(true);
    if (column !== null && breakpoint === 'tablet') setRailed((current) => railToReveal(current, column));
  }

  // Then its card scrolls into view at once, so reduced motion has nothing to opt out of.
  useEffect(() => {
    if (!revealing) return;
    boardRef.current?.querySelector('.st-board-card[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [revealing]);

  const onExpandDone = () => setDoneExpanded(true);
  const complete = board !== null && board.overall.done === board.overall.total;

  return (
    <div
      ref={boardRef}
      className={`st-board ${phone ? 'st-board--phone' : 'st-board--columns'}`}
      style={{ paddingTop: topInset > 0 ? `calc(${topInset}px + var(--space-3))` : undefined, paddingBottom: bottomInset }}
    >
      {identity && (
        <header className="st-board-identity">
          <h1 className="st-board-identity-title" title={title}>{title}</h1>
          {board && (
            <span className="st-board-identity-progress">
              <span aria-hidden>{progressFigure({ ...board.overall, compact: phone })}</span>
              <span className="st-board-spoken">{progressLabel(board.overall)}</span>
            </span>
          )}
          <ViewSwitch view="board" onSwitch={onSwitchView} phone={phone} />
        </header>
      )}
      {notice}
      {frame === 'loading' && <BoardSkeleton phone={phone} />}
      {frame === 'error' && <LoadError phone={phone} onRetry={onRetry} />}
      {frame === 'empty' && <EmptyRoadmap onNewStep={onNewStep} />}
      {frame === 'columns' && (
        <UpNextRest.Provider
          value={complete ? <RoadmapComplete phone={phone} total={board.overall.total} onShare={onShare} onNewStep={onNewStep} /> : null}
        >
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
        </UpNextRest.Provider>
      )}
    </div>
  );
}
