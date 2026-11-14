// The Board owns its frame and regrouping; the host owns identity, query and the toast slot.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './board.css';
import { Board, BoardQuery } from './Board.js';
import { useStepSelection } from './useStepSelection.js';
import { boardFocusTarget } from './traversal.js';
import { kindOptions } from '../model/Legend.js';
import { bulkKindChoice } from '../model/bulkSelection.js';
import { FilterStrip } from './BoardControls.jsx';
import { BoardColumns, DEFAULT_RAIL, railToReveal, swapRail } from './BoardColumns.jsx';
import { WAKE_MS, useRegroup } from './ColumnCards.jsx';
import { PhoneSegments } from './PhoneSegments.jsx';
import { BoardSkeleton, EmptyRoadmap, LoadError, RoadmapComplete, UpNextRest, boardFrame } from './BoardStates.jsx';
import { BoardToast } from './BoardToast.jsx';
import { DeviceLine, RefusedSync } from '../sync/SyncNotices.jsx';
import { FORK_OFFER } from '../copy.js';
import { Button } from '../../../design-system/core/Button.jsx';
import { track } from '../../../telemetry/beacon.js';

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
  refusal = null,
  deviceLine = null,
  guide = null,
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
  selectionOpen = false,
  selectRequest = null,
  onSelectRequestTaken,
  toast = null,
  onToastReveal,
  onToastUndo,
  onToastShown,
  onDisplayedOverall,
  reveal = null,
  wake = null,
  quiet = 0,
  topInset = 0,
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
  const consumedSelect = useRef(null);
  const revealFocus = useRef(null);
  const phone = breakpoint === 'phone';
  const topGap = phone && (deviceLine || guide) ? '0px'
    : !phone && frame === 'loading' && !guide && !refusal ? 'var(--space-1)'
      : 'var(--space-3)';
  const motion = useRegroup(nextBoard, { quiet, phone, root: boardRef });
  const board = motion.board;
  const canSelect = selectionOpen && nextBoard !== null;
  const selection = useStepSelection({
    tree, board: nextBoard, shown, doneExpanded, active, enabled: canSelect,
    root: boardRef, leaving: motion.leaving, onSelect, onRecolor, onDelete,
  });
  const selecting = selection.selection;
  const selectionKinds = useMemo(() => bulkKindChoice(tree, selecting?.ids ?? [], legend), [tree, selecting, legend]);
  const selectionPins = useMemo(() => {
    if (!selection.starterId && !selection.restoreId) return motion.pinned;
    return new Set([...motion.pinned, selection.starterId, selection.restoreId].filter(Boolean));
  }, [motion.pinned, selection.starterId, selection.restoreId]);
  const revealing = active && board !== null;
  // The step a return from its tree came back through wakes once where it stands, as an arrival does.
  const [woken, setWoken] = useState(wake);
  const waking = woken !== null && board !== null;
  useEffect(() => {
    if (!waking) return undefined;
    const timer = setTimeout(() => setWoken(null), WAKE_MS);
    return () => clearTimeout(timer);
  }, [waking]);
  const arrived = useMemo(() => (waking ? new Set([...motion.arrived, woken]) : motion.arrived), [waking, woken, motion.arrived]);
  const settleWake = (id) => {
    if (id === woken) setWoken(null);
    motion.settle(id);
  };

  useLayoutEffect(() => { if (motion.counts) onDisplayedOverall?.(motion.counts.overall); }, [motion.counts, onDisplayedOverall]);

  // A step's column opens — the phone's tab, past the Done fold, out of the tablet's rail. A follow, never a pick, so it
  // emits nothing.
  const standColumnOf = useCallback((id, displayed = board) => {
    const column = displayed.columnOf(id);
    if (column === null) return;
    setShown(column);
    if (column === 'done' && !displayed.recentDone().cards.some((card) => card.id === id)) setDoneExpanded(true);
    if (breakpoint === 'tablet') setRailed((current) => railToReveal(current, column));
  }, [board, breakpoint]);

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

  useEffect(() => {
    if (!canSelect || !selectRequest || consumedSelect.current === selectRequest.key) return;
    const column = nextBoard.columnOf(selectRequest.id);
    if (column === null) return;
    const folded = column === 'done' && !doneExpanded && !nextBoard.recentDone().cards.some((card) => card.id === selectRequest.id);
    if (shown !== column || folded) {
      standColumnOf(selectRequest.id, nextBoard);
      return;
    }
    const displayed = board?.shownCards(column, { doneExpanded }).cards.some((card) => card.id === selectRequest.id);
    if (!displayed || motion.leaving.has(selectRequest.id)) return;
    if (!selection.start(selectRequest.id)) return;
    consumedSelect.current = selectRequest.key;
    onSelectRequestTaken?.(selectRequest.key);
  }, [canSelect, selectRequest, nextBoard, shown, doneExpanded, selection.start, standColumnOf, board, motion.leaving, onSelectRequestTaken]);

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

  // A removed control hands focus to the Board's displayed fallback.
  useLayoutEffect(() => {
    const lost = lastFocus.current;
    if (lost === null || lost.isConnected) return;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    boardFocusTarget(boardRef.current)?.focus();
  }, [query, refusal]);

  const retry = () => {
    retried.current = true;
    onRetry();
  };

  const onExpandDone = () => setDoneExpanded(true);
  const complete = board !== null && board.overall.total > 0 && board.overall.done === board.overall.total;
  const settleFocus = (id) => {
    if (revealFocus.current?.dataset.stepId !== id) settleWake(id);
  };

  // What the phone's panes and the columns both show.
  const cards = {
    board, focusBoard: nextBoard, counts: motion.counts, arrived, leaving: motion.leaving,
    dimmed: motion.phase === 'quiet' ? motion.dimmed : undefined, settle: settleFocus,
    selectedId, doneExpanded, onExpandDone, query, onQuery,
  };

  const toastSlot = (
    <BoardToast
      toast={toast}
      phone={phone}
      ready={motion.phase === 'settled'}
      blocked={phone && Boolean(refusal)}
      onToastShown={onToastShown}
      onToastReveal={onToastReveal}
      onToastUndo={onToastUndo}
    />
  );
  const refusedNotice = refusal && (
    <div className="st-board-refusal" data-board-refusal="">
      <RefusedSync band={breakpoint} code={refusal.code} count={refusal.count}
        onRetry={refusal.onRetry} onDiscard={refusal.onDiscard} />
    </div>
  );
  const phoneNotices = phone && (refusal || onFork) && (
    <div className="st-board-phone-notices">
      {refusal && toastSlot}
      {refusedNotice}
      {onFork && (
        <Button variant="secondary" full onClick={() => {
          track('roadmap_verb', { verb: 'fork', door: 'offer', view: 'board', band: 'phone' });
          onFork();
        }}>{FORK_OFFER}</Button>
      )}
    </div>
  );

  return (
    <div
      ref={boardRef}
      onFocus={(event) => { lastFocus.current = event.target; }}
      onPointerDown={(event) => settleWake(event.target.closest('.st-board-card')?.dataset.stepId)}
      className={`st-board ${phone ? 'st-board--phone' : 'st-board--columns'}`}
      style={{ paddingTop: topInset > 0 ? `calc(${topInset}px + ${topGap})` : undefined }}
    >
      {phone && deviceLine && <DeviceLine text={deviceLine.text} onSignIn={deviceLine.onSignIn} />}
      {guide}
      {frame !== 'columns' && !phone && refusedNotice}
      {frame === 'loading' && <BoardSkeleton band={breakpoint} />}
      {frame === 'error' && <LoadError phone={phone} onRetry={retry} />}
      {frame === 'empty' && onNewStep && <EmptyRoadmap onNewStep={() => onNewStep('empty')} />}
      {frame === 'columns' && (
        <UpNextRest.Provider
          value={complete ? <RoadmapComplete phone={phone} total={board.overall.total} onShare={onShare} onNewStep={onNewStep && (() => onNewStep('complete'))} /> : null}
        >
          {phone
            ? (
              <PhoneSegments
                {...cards}
                beforeBand={phoneNotices}
                pinned={selectionPins}
                onComplete={selecting ? undefined : onComplete}
                onDelete={editable && !selecting ? selection.deleteFromKey : undefined}
                selection={selecting}
                selectionAnnouncement={selectionOpen ? selection.announcement : null}
                kinds={selectionKinds.kinds}
                sharedKind={selectionKinds.shared}
                onHold={canSelect && !selecting ? selection.start : undefined}
                selectable={selection.selectable}
                onKinds={selection.kinds}
                onRecolor={selection.recolor}
                onDeleteSelection={selection.deleteSelected}
                onDoneSelection={selection.done}
                onNewStep={onNewStep && (() => onNewStep('band'))}
                shown={shown}
                onShow={setShown}
                onSelect={selection.pick}
                onAnchor={anchor}
                worn={worn}
              />
            )
            : (
              <>
                <FilterStrip board={board} worn={worn} query={query} onQuery={onQuery} onAnchor={anchor} />
                {refusedNotice}
                <BoardColumns
                  {...cards}
                  pinned={motion.pinned}
                  onComplete={onComplete}
                  onDelete={editable ? selection.deleteFromKey : undefined}
                  onStandColumn={(column) => { if (breakpoint === 'tablet') setRailed((current) => railToReveal(current, column)); }}
                  band={breakpoint}
                  railed={railed}
                  onShowRail={() => setRailed(swapRail)}
                  onSelect={onSelect}
                />
              </>
            )}
        </UpNextRest.Provider>
      )}
      {frame !== 'columns' && phoneNotices}
      {!(phone && refusal) && toastSlot}
    </div>
  );
}

// While the Board stays hidden it skips the host's renders; it catches up on everything the moment it is shown.
export default React.memo(BoardView, (previous, next) => !previous.active && !next.active);
