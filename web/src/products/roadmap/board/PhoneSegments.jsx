// Below 744px: one column at a time over the bottom band: the Locked · Up next · Done tabs with Sort, then Find a step and
// Filter. The branch in scope and the chips for what narrows sit over the panes; each pane keeps its scroll and its own
// place for the arrow keys, which move between its cards, and a pane the query emptied names its way out.

import React, { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import './phone.css';
import { track } from '../../../telemetry/beacon.js';
import { ColumnCards } from './ColumnCards.jsx';
import { UpNextRest } from './BoardStates.jsx';
import { ActiveFilters, BulkBar, PaneEmpty, PhoneSort, PhoneTools } from './BoardControls.jsx';
import { BoardQuery } from './Board.js';
import { columnStops, useRovingFocus } from './traversal.js';
import { COLUMN_TITLES, LABELS, columnHeadingLabel, formatCount } from '../copy.js';

const ARROW_STEPS = { ArrowLeft: -1, ArrowRight: 1 };

// The shown column is the host's: a pick here emits roadmap_board_column, the host following a selected step does not.
export function PhoneSegments({
  board, focusBoard = board, beforeBand = null, shown, onShow, selectedId, onSelect, onAnchor, doneExpanded, onExpandDone,
  query = new BoardQuery(), worn = [], onQuery, onNewStep, onComplete, onDelete,
  selection = null, selectionAnnouncement = null, selectable, kinds = [], sharedKind = null, onHold, onKinds, onRecolor, onDeleteSelection, onDoneSelection,
  arrived = new Set(), leaving = new Set(), dimmed = new Set(), pinned = new Set(), settle, counts = board,
}) {
  const [scrolled, setScrolled] = useState({ locked: false, upNext: false, done: false });
  const tabs = useRef({});
  const completedBySwipe = useRef(null);
  const completeStep = useRef(onComplete);
  completeStep.current = onComplete;
  const completeFromSwipe = useCallback((id, door) => {
    if (!completeStep.current?.(id, door)) return false;
    completedBySwipe.current = id;
    return true;
  }, []);
  const idPrefix = useId();
  const tabId = (name) => `${idPrefix}tab-${name}`;
  const panelId = (name) => `${idPrefix}panel-${name}`;

  const choose = (name) => {
    if (name === shown) return;
    track('roadmap_board_column', { column: name });
    onShow(name);
  };

  const order = board.columns.map((column) => column.name);
  const handleKeyDown = (event) => {
    const index = order.indexOf(shown);
    const direction = ARROW_STEPS[event.key];
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    const edge = event.key === 'Home' ? order[0] : order[order.length - 1];
    const next = direction ? order[(index + direction + order.length) % order.length] : edge;
    event.preventDefault();
    choose(next);
    tabs.current[next].focus();
  };

  const handleScroll = (name, event) => {
    const away = event.currentTarget.scrollTop > 0;
    setScrolled((current) => (current[name] === away ? current : { ...current, [name]: away }));
  };

  const upNextRest = useContext(UpNextRest);
  const shownCards = useMemo(
    () => Object.fromEntries(board.columns.map((column) => [column.name, board.shownCards(column.name, { doneExpanded })])),
    [board, doneExpanded],
  );
  const layout = useMemo(() => [{ name: shown, stops: columnStops(shownCards[shown]) }], [shownCards, shown]);
  const recoveryLayout = useMemo(() => {
    if (focusBoard === board) return layout;
    return [{ name: shown, stops: columnStops(focusBoard.shownCards(shown, { doneExpanded })) }];
  }, [focusBoard, board, layout, shown, doneExpanded]);
  const roving = useRovingFocus(layout, { revision: board, existingIds: focusBoard.states, recoveryLayout, onDelete, fallback: () => tabs.current[shown], onComplete: onComplete && ((id, door) => {
    if (!onComplete(id, door)) return false;
    onShow('done');
    return true;
  }) });

  useEffect(() => {
    const id = completedBySwipe.current;
    if (!id || board.columnOf(id) !== 'done') return;
    completedBySwipe.current = null;
    const next = shownCards[shown].cards[0];
    if (next) roving.follow({ column: shown, id: next.id });
    else tabs.current[shown]?.focus();
  }, [board, shown]);

  const expandDone = () => {
    track('roadmap_board_done_expand', { band: 'phone' });
    onExpandDone();
  };

  return (
    <div className="st-board-phone">
      {selectionAnnouncement !== null && <span className="st-board-spoken" role="status" aria-live="polite" aria-atomic="true">{selectionAnnouncement}</span>}
      <ActiveFilters board={board} worn={worn} query={query} onQuery={onQuery} onAnchor={onAnchor} />
      <div className="st-board-phone-panes" ref={roving.ref}
        onFocus={(event) => {
          roving.onFocus(event);
          settle?.(event.target.dataset.stepId);
        }}
        onBlur={roving.onBlur} onKeyDown={roving.onKeyDown}>
        {board.columns.map((column) => {
          const resting = column.name === 'upNext' && upNextRest !== null;
          const empty = column.count === 0 && query.recovery !== null;
          return <div
            key={column.name}
            id={panelId(column.name)}
            role="tabpanel"
            aria-labelledby={selection ? undefined : tabId(column.name)}
            aria-label={selection ? COLUMN_TITLES[column.name] : undefined}
            className={`st-board-phone-pane ${column.name === shown ? 'is-shown' : ''} ${scrolled[column.name] ? 'is-scrolled' : ''}`}
            tabIndex={column.count === 0 ? 0 : -1}
            data-column={column.name}
            onScroll={(event) => handleScroll(column.name, event)}
          >
            <h2 className="st-board-phone-heading">{COLUMN_TITLES[column.name]}</h2>
            {resting && upNextRest}
            {!resting && empty && <PaneEmpty query={query} onQuery={onQuery} />}
            {!resting && !empty && (
              <ColumnCards
                shown={shownCards[column.name]}
                swipe={!selection && Boolean(onComplete) && column.name === shown}
                selection={selection}
                selectable={selectable}
                onHold={column.name === shown ? onHold : undefined}
                onComplete={onComplete ? completeFromSwipe : undefined}
                stopId={roving.stopIn(column.name)}
                pendingId={roving.pendingIn(column.name)}
                arrived={arrived}
                leaving={leaving}
                dimmed={dimmed}
                pinned={pinned}
                selectedId={selectedId}
                onSelect={onSelect}
                onExpandDone={expandDone}
              />
            )}
          </div>;
        })}
      </div>
      {beforeBand}
      {selection ? (
        <BulkBar count={selection.count} kinds={kinds} sharedKind={sharedKind} onKinds={onKinds}
          onRecolor={onRecolor} onDelete={onDeleteSelection} onDone={onDoneSelection} />
      ) : (
        <div className="st-board-phone-band">
          <div className="st-board-phone-row">
            <div className="st-board-phone-segments" role="tablist" aria-label={LABELS.columns} onKeyDown={handleKeyDown}>
              {board.columns.map((column) => (
                <button
                  key={column.name}
                  ref={(node) => { tabs.current[column.name] = node; }}
                  id={tabId(column.name)}
                  type="button"
                  role="tab"
                  className="st-board-phone-segment"
                  aria-label={columnHeadingLabel({ column: column.name, count: counts[column.name].count })}
                  aria-selected={column.name === shown}
                  aria-controls={panelId(column.name)}
                  tabIndex={column.name === shown ? 0 : -1}
                  onClick={() => choose(column.name)}
                >
                  <span className="st-board-phone-segment-surface">
                    <span className="st-board-phone-segment-label">{COLUMN_TITLES[column.name]}</span>
                    <span className="st-board-phone-segment-count">{formatCount(counts[column.name].count, { compact: true })}</span>
                  </span>
                </button>
              ))}
            </div>
            <PhoneSort query={query} onQuery={onQuery} />
          </div>
          <PhoneTools worn={worn} query={query} onQuery={onQuery} onNewStep={onNewStep} />
        </div>
      )}
    </div>
  );
}
