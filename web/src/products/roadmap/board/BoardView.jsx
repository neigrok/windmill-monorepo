// The Board view layer: the identity row where no chrome carries one, the device notice, then the frame — the strip and
// the columns for the band, or the skeleton, the load error or the empty roadmap in their place. The host owns the query.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import './board.css';
import { Board, BoardQuery } from './Board.js';
import { kindOptions } from '../model/Legend.js';
import { FilterStrip, FindStep } from './BoardControls.jsx';
import { BoardColumns, DEFAULT_RAIL, railToReveal, swapRail } from './BoardColumns.jsx';
import { PhoneSegments } from './PhoneSegments.jsx';
import { BoardSkeleton, EmptyRoadmap, LoadError, RoadmapComplete, UpNextRest, boardFrame } from './BoardStates.jsx';
import { ViewSwitch } from './ViewSwitch.jsx';
import { progressFigure, progressLabel } from './copy.js';

// Where focus lands once a retried load settles: the columns' tab stop, or the state's own button.
const FOCUS_AFTER_LOAD = '[data-column] [tabindex="0"], [data-column][tabindex="0"], .st-board-state button';
const EVERY_STEP = new BoardQuery();

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

function BoardView({
  tree,
  completed,
  completedAt,
  loading = false,
  failed = false,
  selectedId,
  onSelect,
  onAnchor = () => {},
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
  query: asked = EVERY_STEP,
  onQuery,
  legend = [],
}) {
  const frame = boardFrame({ tree, loading, failed });
  const worn = useMemo(() => (frame === 'columns' ? kindOptions(tree, legend) : []), [frame, tree, legend]);
  const query = useMemo(() => asked.among(worn.map((kind) => kind.hue)), [asked, worn]);
  const board = useMemo(
    () => (frame === 'columns' ? new Board(tree, { completed, completedAt }, query) : null),
    [frame, tree, completed, completedAt, query],
  );
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [railed, setRailed] = useState(DEFAULT_RAIL);
  const [shown, setShown] = useState('upNext');
  const [wasRevealing, setWasRevealing] = useState(false);
  const [branchShown, setBranchShown] = useState(asked.branch);
  const [anchored, setAnchored] = useState(null);
  const boardRef = useRef(null);
  const retried = useRef(false);
  const lastFocus = useRef(null);
  const phone = breakpoint === 'phone';
  const revealing = active && board !== null;

  // A step's column opens — the phone's tab, past the Done fold, out of the tablet's rail. A follow, never a pick, so it
  // emits nothing.
  const standColumnOf = (id) => {
    const column = board.columnOf(id);
    if (column === null) return;
    setShown(column);
    if (column === 'done' && !board.recentDone().cards.some((card) => card.id === id)) setDoneExpanded(true);
    if (breakpoint === 'tablet') setRailed((current) => railToReveal(current, column));
  };

  // Shown with a step selected (Graph → Board, a link, a roadmap that just loaded), its column opens; so does the anchor's
  // when the Board is scoped to a branch.
  if (revealing !== wasRevealing) {
    setWasRevealing(revealing);
    if (revealing) standColumnOf(selectedId);
  }
  if (board !== null && asked.branch !== branchShown) {
    setBranchShown(asked.branch);
    if (asked.branch !== null) standColumnOf(asked.branch);
  }

  // Then its card scrolls into view at once, so reduced motion has nothing to opt out of.
  useEffect(() => {
    if (!revealing) return;
    boardRef.current?.querySelector('.st-board-card[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [revealing]);

  // The branch scope's title returns to its step: selects it and brings its card into view, without opening it.
  const anchor = (id) => {
    onAnchor(id);
    standColumnOf(id);
    setAnchored({ id });
  };
  useEffect(() => {
    if (anchored === null) return;
    boardRef.current?.querySelector(`.st-board-card[data-step-id="${CSS.escape(anchored.id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }, [anchored]);

  // After Try again, focus follows the Board through its frames: the skeleton while it loads, then the columns' tab stop,
  // or Try again or New step if the roadmap failed again or came back empty.
  useEffect(() => {
    if (!retried.current) return;
    if (frame !== 'loading') retried.current = false;
    boardRef.current?.querySelector(frame === 'loading' ? '[aria-busy="true"]' : FOCUS_AFTER_LOAD)?.focus();
  }, [frame]);

  // A control the query took away (a cleared chip, an emptied column's way out) hands focus to the columns' tab stop, or
  // to Find a step while no column has one.
  useEffect(() => {
    const lost = lastFocus.current;
    if (lost === null || lost.isConnected) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const layer = boardRef.current;
    (layer?.querySelector('[data-column] [tabindex="0"]') ?? layer?.querySelector('.st-board-find-input'))?.focus();
  }, [query]);

  const retry = () => {
    retried.current = true;
    onRetry();
  };

  const onExpandDone = () => setDoneExpanded(true);
  const complete = board !== null && board.overall.done === board.overall.total;

  return (
    <div
      ref={boardRef}
      onFocus={(event) => { lastFocus.current = event.target; }}
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
          {board && !phone && <FindStep query={query} onQuery={onQuery} />}
        </header>
      )}
      {notice}
      {frame === 'loading' && <BoardSkeleton phone={phone} />}
      {frame === 'error' && <LoadError phone={phone} onRetry={retry} />}
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
                onAnchor={anchor}
                doneExpanded={doneExpanded}
                onExpandDone={onExpandDone}
                query={query}
                worn={worn}
                onQuery={onQuery}
              />
            )
            : (
              <>
                <FilterStrip board={board} worn={worn} query={query} onQuery={onQuery} onAnchor={anchor} />
                <BoardColumns
                  board={board}
                  band={breakpoint}
                  railed={railed}
                  onShowRail={() => setRailed(swapRail)}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  doneExpanded={doneExpanded}
                  onExpandDone={onExpandDone}
                  query={query}
                  onQuery={onQuery}
                />
              </>
            )}
        </UpNextRest.Provider>
      )}
    </div>
  );
}

// While the Board stays hidden it skips the host's renders; it catches up on everything the moment it is shown.
export default React.memo(BoardView, (previous, next) => !previous.active && !next.active);
