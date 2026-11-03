// The Board owns its frame and regrouping; the host owns identity, query and the toast slot.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './board.css';
import { Board, BoardQuery } from './Board.js';
import { useStepSelection } from './useStepSelection.js';
import { boardFocusTarget } from './traversal.js';
import { NODE_COLOR_NAMES } from '../theme.js';
import { kindOptions, kindOptionsForHues } from '../model/Legend.js';
import { FilterStrip } from './BoardControls.jsx';
import { BoardColumns, DEFAULT_RAIL, railToReveal, swapRail } from './BoardColumns.jsx';
import { useRegroup } from './ColumnCards.jsx';
import { PhoneSegments } from './PhoneSegments.jsx';
import { BoardSkeleton, EmptyRoadmap, LoadError, RoadmapComplete, UpNextRest, boardFrame } from './BoardStates.jsx';
import { BoardToast } from './BoardToast.jsx';

const EVERY_STEP = new BoardQuery();

function BoardView({
  tree,
  completed,
  completedAt,
  loading = false,
  failed = false,
  selectedId,
  onSelect,
  onAnchor = () => {},
  notice = null,
  refusal = null,
  deviceLine = null,
  onFork = null,
  breakpoint,
  active = false,
  onRetry,
  onShare,
  onNewStep,
  onComplete,
  onRecolor,
  onDelete,
  editable = false,
  toast = null,
  onToastReveal,
  onToastUndo,
  onToastShown,
  onDisplayedOverall,
  reveal = null,
  quiet = 0,
  topInset = 0,
  bottomInset = 0,
  query: asked = EVERY_STEP,
  onQuery,
  legend = [],
}) {
  const frame = boardFrame({ tree, loading, failed });
  const worn = useMemo(() => (frame === 'columns' ? kindOptions(tree, legend) : []), [frame, tree, legend]);
  const query = useMemo(() => asked.among(worn.map((kind) => kind.hue)), [asked, worn]);
  const nextBoard = useMemo(
    () => ((frame === 'columns' || frame === 'empty') ? new Board(tree, { completed, completedAt }, query) : null),
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
  const consumedReveal = useRef(null);
  const revealFocus = useRef(null);
  const phone = breakpoint === 'phone';
  const motion = useRegroup(nextBoard, { quiet, phone, root: boardRef });
  const board = motion.board;
  const canSelect = editable && active && phone && nextBoard !== null;
  const selection = useStepSelection({
    tree, board: nextBoard, shown, doneExpanded, active, enabled: canSelect,
    root: boardRef, leaving: motion.leaving, onSelect, onRecolor, onDelete,
  });
  const selecting = selection.selection;
  const selectionKinds = useMemo(() => kindOptionsForHues(NODE_COLOR_NAMES, legend), [legend]);
  const selectionPins = useMemo(() => {
    if (!selection.starterId) return motion.pinned;
    return new Set([...motion.pinned, selection.starterId]);
  }, [motion.pinned, selection.starterId]);
  const revealing = active && board !== null;

  useLayoutEffect(() => { if (motion.counts) onDisplayedOverall?.(motion.counts.overall); }, [motion.counts, onDisplayedOverall]);

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
  const anchor = (id, key = null) => {
    onAnchor(id);
    standColumnOf(id);
    setAnchored({ id, key });
  };
  useEffect(() => {
    if (anchored === null) return;
    const card = boardRef.current?.querySelector(`.st-board-card[data-step-id="${CSS.escape(anchored.id)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    setAnchored(null);
    if (anchored.key !== null && consumedReveal.current !== anchored.key) {
      consumedReveal.current = anchored.key;
      requestAnimationFrame(() => {
        revealFocus.current = card;
        card.focus({ preventScroll: true });
        revealFocus.current = null;
      });
    }
  }, [anchored, board]);

  useEffect(() => {
    if (!reveal || consumedReveal.current === reveal.key || !board?.columnOf(reveal.id)) return;
    anchor(reveal.id, reveal.key);
  }, [reveal, board]);

  // After Try again, focus follows the Board through its frames: the skeleton while it loads, then the columns' tab stop,
  // or Try again or New step if the roadmap failed again or came back empty.
  useEffect(() => {
    if (!retried.current) return;
    if (frame !== 'loading') retried.current = false;
    boardFocusTarget(boardRef.current)?.focus();
  }, [frame]);

  // A control the query took away hands focus to the Board's displayed fallback.
  useEffect(() => {
    const lost = lastFocus.current;
    if (lost === null || lost.isConnected) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    boardFocusTarget(boardRef.current)?.focus();
  }, [query]);

  const retry = () => {
    retried.current = true;
    onRetry();
  };

  const onExpandDone = () => setDoneExpanded(true);
  const complete = board !== null && board.overall.total > 0 && board.overall.done === board.overall.total;
  const settleFocus = (id) => {
    if (revealFocus.current?.dataset.stepId !== id) motion.settle(id);
  };

  return (
    <div
      ref={boardRef}
      onFocus={(event) => { lastFocus.current = event.target; }}
      onPointerDown={(event) => motion.settle(event.target.closest('.st-board-card')?.dataset.stepId)}
      className={`st-board ${phone ? 'st-board--phone' : 'st-board--columns'}`}
      style={{ paddingTop: topInset > 0 ? `calc(${topInset}px + var(--space-3))` : undefined, paddingBottom: bottomInset }}
    >
      {notice}
      {frame === 'loading' && <BoardSkeleton phone={phone} />}
      {frame === 'error' && <LoadError phone={phone} onRetry={retry} />}
      {frame === 'empty' && <EmptyRoadmap onNewStep={onNewStep && (() => onNewStep('empty'))} />}
      {frame === 'columns' && (
        <UpNextRest.Provider
          value={complete ? <RoadmapComplete phone={phone} total={board.overall.total} onShare={onShare} onNewStep={onNewStep && (() => onNewStep('complete'))} /> : null}
        >
          {phone
            ? (
              <PhoneSegments
                board={board}
                focusBoard={nextBoard}
                counts={motion.counts}
                arrived={motion.arrived}
                leaving={motion.leaving}
                dimmed={motion.phase === 'quiet' ? motion.dimmed : undefined}
                pinned={selectionPins}
                settle={settleFocus}
                onComplete={selecting ? undefined : onComplete}
                onDelete={editable && !selecting ? selection.deleteFromKey : undefined}
                selection={selecting}
                kinds={selectionKinds}
                sharedKind={selecting?.sharedKind(tree) ?? null}
                onHold={canSelect && !selecting ? selection.start : undefined}
                selectable={selection.selectable}
                onKinds={selection.kinds}
                onRecolor={selection.recolor}
                onDeleteSelection={selection.deleteSelected}
                onDoneSelection={selection.done}
                onNewStep={onNewStep && (() => onNewStep('band'))}
                shown={shown}
                onShow={setShown}
                selectedId={selectedId}
                onSelect={selection.pick}
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
                  focusBoard={nextBoard}
                  counts={motion.counts}
                  arrived={motion.arrived}
                  leaving={motion.leaving}
                  dimmed={motion.phase === 'quiet' ? motion.dimmed : undefined}
                  pinned={motion.pinned}
                  settle={settleFocus}
                  onComplete={onComplete}
                  onDelete={editable ? selection.deleteFromKey : undefined}
                  onStandColumn={(column) => { if (breakpoint === 'tablet') setRailed((current) => railToReveal(current, column)); }}
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
      <BoardToast
        toast={toast}
        phone={phone}
        ready={motion.phase === 'settled'}
        onToastShown={onToastShown}
        onToastReveal={onToastReveal}
        onToastUndo={onToastUndo}
      />
    </div>
  );
}

// While the Board stays hidden it skips the host's renders; it catches up on everything the moment it is shown.
export default React.memo(BoardView, (previous, next) => !previous.active && !next.active);
