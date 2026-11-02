// The Board view layer: the identity row where no chrome carries one, the device notice, then the frame — the strip and
// the columns for the band, or the skeleton, the load error or the empty roadmap in their place. The host owns the query.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './board.css';
import { Board, BoardQuery } from './Board.js';
import { track } from '../../../telemetry/beacon.js';
import { StepSelection, deletable } from './acts.js';
import { stepOf } from './stepAddress.js';
import { NODE_COLOR_NAMES } from '../theme.js';
import { kindOptions } from '../model/Legend.js';
import { FilterStrip, FindStep, NewStep } from './BoardControls.jsx';
import { BoardColumns, DEFAULT_RAIL, railToReveal, swapRail } from './BoardColumns.jsx';
import { useRegroup } from './ColumnCards.jsx';
import { PhoneSegments } from './PhoneSegments.jsx';
import { BoardSkeleton, EmptyRoadmap, LoadError, RoadmapComplete, UpNextRest, boardFrame } from './BoardStates.jsx';
import { ViewSwitch } from './ViewSwitch.jsx';
import { progressFigure, progressLabel } from './copy.js';

// Where focus lands once a retried load settles: the columns' tab stop, or the state's own button.
const FOCUS_AFTER_LOAD = '[data-column] [tabindex="0"], [data-column][tabindex="0"], .st-board-state button';
const EVERY_STEP = new BoardQuery();
const PALETTE = { nodes: NODE_COLOR_NAMES.map((color) => ({ color })) };

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
  const [visibleToast, setVisibleToast] = useState(null);
  const [selection, setSelection] = useState(null);
  const selectionVisit = useRef(null);
  const selectionTokens = useRef(new Set());
  const selectionCallbacks = useRef(null);
  const restoreSelectionFocus = useRef(null);
  const focusSelectionStart = useRef(false);
  const canSelect = editable && active && phone && nextBoard !== null;
  const visit = selectionVisit.current;
  const inPane = canSelect && visit?.treeId === tree?.treeId && visit.column === shown;
  const pruned = inPane && selection ? selection.prune(nextBoard, shown) : null;
  const allowed = pruned?.ids.filter((id) => deletable(tree, [id])) ?? [];
  const selecting = allowed.length > 0 ? new StepSelection(allowed) : null;
  const selectionKinds = useMemo(() => kindOptions(PALETTE, legend), [legend]);
  const selectionPins = useMemo(() => {
    const held = visit ?? restoreSelectionFocus.current;
    if ((!selection && !restoreSelectionFocus.current) || !held) return motion.pinned;
    return new Set([...motion.pinned, held.id]);
  }, [motion.pinned, selection, visit]);

  const finishSelection = (via, pop = true) => {
    const held = selectionVisit.current;
    if (!held || held.ending) return;
    held.ending = true;
    setSelection(null);
    track('roadmap_board_select', { step: 'end', via });
    if (via !== 'left') restoreSelectionFocus.current = held;
    const entry = window.history.state?.boardSelection;
    if (pop && entry?.token === held.token && window.location.href === held.href) {
      held.pending = true;
      window.history.go(entry.kinds ? -2 : -1);
      return;
    }
    selectionVisit.current = null;
  };

  const startSelection = (id) => {
    if (!canSelect || selectionVisit.current || stepOf(window.location.hash) !== null || !deletable(tree, [id])) return;
    const token = crypto.randomUUID();
    selectionTokens.current.add(token);
    selectionVisit.current = { token, id, column: shown, treeId: tree.treeId, href: window.location.href, pending: false, ending: false };
    window.history.pushState({ ...window.history.state, boardSelection: { token, kinds: false } }, '', window.location.href);
    focusSelectionStart.current = true;
    setSelection(new StepSelection([id]).prune(nextBoard, shown));
    track('roadmap_board_select', { step: 'start' });
  };

  const kindsLayer = (open) => {
    const held = selectionVisit.current;
    if (!held || held.pending || held.ending) return false;
    if (open) {
      window.history.pushState({ ...window.history.state, boardSelection: { token: held.token, kinds: true } }, '', window.location.href);
      return true;
    }
    held.pending = true;
    window.history.back();
    return true;
  };

  const pickCard = (id) => {
    if (selectionVisit.current?.pending) return;
    if (!selecting) {
      onSelect(id);
      return;
    }
    if (!deletable(tree, [id])) return;
    const next = selecting.toggle(id, nextBoard, shown);
    if (next.count === 0) finishSelection('emptied');
    else setSelection(next);
  };

  const recolorSelection = (hue) => {
    if (!selecting || selectionVisit.current?.pending) return;
    if (selecting.sharedKind(tree) !== hue && onRecolor?.(selecting.ids, hue)?.ok) navigator.vibrate?.(8);
    finishSelection('acted');
  };

  const deleteSelection = () => {
    if (!selecting || selectionVisit.current?.pending) return;
    onDelete?.(selecting.ids, 'bulk');
    finishSelection('acted');
  };

  selectionCallbacks.current = { finishSelection };

  useEffect(() => {
    const back = () => {
      const held = selectionVisit.current;
      if (!held) {
        if (!selectionTokens.current.has(window.history.state?.boardSelection?.token)) return;
        const { boardSelection, ...state } = window.history.state;
        window.history.replaceState(state, '', window.location.href);
        return;
      }
      held.pending = false;
      if (held.ending) {
        selectionVisit.current = null;
        return;
      }
      if (window.history.state?.boardSelection?.token !== held.token) selectionCallbacks.current.finishSelection('back', false);
    };
    const escape = (event) => {
      const held = selectionVisit.current;
      if (!held || held.ending || event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (held.pending) return;
      if (window.history.state?.boardSelection?.kinds) {
        held.pending = true;
        window.history.back();
        return;
      }
      selectionCallbacks.current.finishSelection('back');
    };
    window.addEventListener('popstate', back);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('popstate', back);
      window.removeEventListener('keydown', escape);
      selectionCallbacks.current.finishSelection('left');
    };
  }, []);

  if (selection && selecting && (selection.ids.length !== selecting.ids.length || selection.ids.some((id, index) => id !== selecting.ids[index]))) setSelection(selecting);

  useEffect(() => {
    if (!selection) return;
    if (!selecting) {
      finishSelection(inPane ? 'emptied' : 'left');
      return;
    }
  }, [selection, nextBoard, canSelect, shown]);

  useLayoutEffect(() => {
    if (selecting && focusSelectionStart.current) {
      focusSelectionStart.current = false;
      boardRef.current?.querySelector(`.st-board-card[data-step-id="${CSS.escape(visit.id)}"]`)?.focus({ preventScroll: true });
    }
    const held = restoreSelectionFocus.current;
    if (!held || selecting || !active) return;
    const layer = boardRef.current;
    const starter = nextBoard?.columnOf(held.id) === held.column
      ? layer?.querySelector(`.st-board-phone-pane.is-shown .st-board-card[data-step-id="${CSS.escape(held.id)}"]`)
      : null;
    const target = starter ?? layer?.querySelector('.st-board-phone-segment[aria-selected="true"]');
    if (!target) return;
    restoreSelectionFocus.current = null;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
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

  useEffect(() => {
    if (!toast || visibleToast === toast.key || motion.phase !== 'settled') return undefined;
    const timer = setTimeout(() => {
      setVisibleToast(toast.key);
      onToastShown?.(toast.key);
    }, 120);
    return () => clearTimeout(timer);
  }, [toast?.key, visibleToast, motion.phase]);

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
      {identity && (
        <header className="st-board-identity">
          <h1 className="st-board-identity-title" title={title}>{title}</h1>
          {frame === 'columns' && board && (
            <span className="st-board-identity-progress">
              <span aria-hidden>{progressFigure({ ...motion.counts.overall, compact: phone })}</span>
              <span className="st-board-spoken">{progressLabel(motion.counts.overall)}</span>
            </span>
          )}
          <ViewSwitch view="board" onSwitch={onSwitchView} phone={phone} />
          {frame === 'columns' && board && !phone && <FindStep query={query} onQuery={onQuery} />}
          {frame === 'columns' && breakpoint === 'tablet' && onNewStep && (
            <NewStep compact onClick={() => onNewStep('verbs')} />
          )}
        </header>
      )}
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
                onDelete={editable && !selecting ? ((ids, door) => deletable(tree, ids) && onDelete?.(ids, door)) : undefined}
                selection={selecting}
                kinds={selectionKinds}
                sharedKind={selecting?.sharedKind(tree) ?? null}
                onHold={canSelect && !selecting ? startSelection : undefined}
                selectable={(id) => deletable(tree, [id])}
                onKinds={kindsLayer}
                onRecolor={recolorSelection}
                onDeleteSelection={deleteSelection}
                onDoneSelection={() => finishSelection('done')}
                onNewStep={onNewStep && (() => onNewStep('band'))}
                shown={shown}
                onShow={setShown}
                selectedId={selectedId}
                onSelect={pickCard}
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
                  onDelete={editable ? ((ids, door) => deletable(tree, ids) && onDelete?.(ids, door)) : undefined}
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
      {toast && <div className="st-board-spoken" role="status" aria-live="polite" aria-atomic="true">{visibleToast === toast.key ? toast.message : ''}</div>}
      {toast && visibleToast === toast.key && (
        <div className={`st-board-toast${toast.leaving ? ' is-leaving' : ''}${toast.act ? ` st-board-toast--${toast.act}` : ''}`}>
          {phone && toast.act === 'complete' && <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="m5 12 4 4 10-10" /></svg>}
          {toast.reveal
            ? <button type="button" className="st-board-toast-message" onClick={onToastReveal}>{toast.message}</button>
            : <span className="st-board-toast-message">{toast.message}</span>}
          {toast.action && <button type="button" className="st-board-toast-undo" onClick={onToastUndo}>{toast.action.label}</button>}
        </div>
      )}
    </div>
  );
}

// While the Board stays hidden it skips the host's renders; it catches up on everything the moment it is shown.
export default React.memo(BoardView, (previous, next) => !previous.active && !next.active);
