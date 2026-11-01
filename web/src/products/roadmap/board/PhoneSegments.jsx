// Below 744px: one column at a time over the bottom band's Locked · Up next · Done tabs; each column's pane keeps its scroll
// and its own place for the arrow keys, which move between its cards.

import React, { useContext, useId, useMemo, useRef, useState } from 'react';
import './phone.css';
import { track } from '../../../telemetry/beacon.js';
import { ColumnCards, useArrivals } from './ColumnCards.jsx';
import { UpNextRest } from './BoardStates.jsx';
import { columnStops, useRovingFocus } from './traversal.js';
import { COLUMN_TITLES, LABELS, columnHeadingLabel, formatCount } from './copy.js';

const ARROW_STEPS = { ArrowLeft: -1, ArrowRight: 1 };

// The shown column is the host's: a pick here emits roadmap_board_column, the host following a selected step does not.
export function PhoneSegments({ board, shown, onShow, selectedId, onSelect, doneExpanded, onExpandDone }) {
  const [scrolled, setScrolled] = useState({ locked: false, upNext: false, done: false });
  const tabs = useRef({});
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
    const next = event.key === 'Home' ? order[0]
      : event.key === 'End' ? order[order.length - 1]
        : event.key in ARROW_STEPS ? order[(index + ARROW_STEPS[event.key] + order.length) % order.length]
          : null;
    if (next === null) return;
    event.preventDefault();
    choose(next);
    tabs.current[next].focus();
  };

  const handleScroll = (name, event) => {
    const away = event.currentTarget.scrollTop > 0;
    setScrolled((current) => (current[name] === away ? current : { ...current, [name]: away }));
  };

  const [arrived, settle] = useArrivals(board);
  const upNextRest = useContext(UpNextRest);
  const shownCards = useMemo(
    () => Object.fromEntries(board.columns.map((column) => [column.name, board.shownCards(column.name, { doneExpanded })])),
    [board, doneExpanded],
  );
  const layout = useMemo(() => [{ name: shown, stops: columnStops(shownCards[shown]) }], [shownCards, shown]);
  const roving = useRovingFocus(layout);

  const expandDone = () => {
    track('roadmap_board_done_expand', { band: 'phone' });
    onExpandDone();
  };

  const focus = (event) => {
    roving.onFocus(event);
    settle(event.target.dataset.stepId);
  };

  return (
    <div className="st-board-phone">
      <div className="st-board-phone-panes" ref={roving.ref} onFocus={focus} onBlur={roving.onBlur} onKeyDown={roving.onKeyDown}>
        {board.columns.map((column) => (
          <div
            key={column.name}
            id={panelId(column.name)}
            role="tabpanel"
            aria-labelledby={tabId(column.name)}
            className={`st-board-phone-pane ${column.name === shown ? 'is-shown' : ''} ${scrolled[column.name] ? 'is-scrolled' : ''}`}
            tabIndex={column.count === 0 ? 0 : undefined}
            data-column={column.name}
            onScroll={(event) => handleScroll(column.name, event)}
          >
            <h2 className="st-board-phone-heading">{COLUMN_TITLES[column.name]}</h2>
            {column.name === 'upNext' && upNextRest !== null ? upNextRest : (
              <ColumnCards
                shown={shownCards[column.name]}
                stopId={roving.stopIn(column.name)}
                pendingId={roving.pendingIn(column.name)}
                arrived={arrived}
                selectedId={selectedId}
                onSelect={onSelect}
                onExpandDone={expandDone}
              />
            )}
          </div>
        ))}
      </div>
      <div className="st-board-phone-band">
        <div className="st-board-phone-segments" role="tablist" aria-label={LABELS.columns} onKeyDown={handleKeyDown}>
          {board.columns.map((column) => (
            <button
              key={column.name}
              ref={(node) => { tabs.current[column.name] = node; }}
              id={tabId(column.name)}
              type="button"
              role="tab"
              className="st-board-phone-segment"
              aria-label={columnHeadingLabel({ column: column.name, count: column.count })}
              aria-selected={column.name === shown}
              aria-controls={panelId(column.name)}
              tabIndex={column.name === shown ? 0 : -1}
              onClick={() => choose(column.name)}
            >
              <span className="st-board-phone-segment-surface">
                <span className="st-board-phone-segment-label">{COLUMN_TITLES[column.name]}</span>
                <span className="st-board-phone-segment-count">{formatCount(column.count, { compact: true })}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
