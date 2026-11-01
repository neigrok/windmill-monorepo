// Below 744px: one column at a time over the bottom band's Locked · Up next · Done tabs; each column's pane keeps its scroll.

import React, { useEffect, useId, useRef, useState } from 'react';
import './phone.css';
import { track } from '../../../telemetry/beacon.js';
import { StepCard } from './StepCard.jsx';
import { COLUMN_TITLES, LABELS, columnHeadingLabel, formatCount, showAllDone } from './copy.js';

const ARROW_STEPS = { ArrowLeft: -1, ArrowRight: 1 };

export function PhoneSegments({ board, selectedId, onSelect, doneExpanded, onToggleDone }) {
  const [shown, setShown] = useState(() => board.columnOf(selectedId) ?? 'upNext');
  const [scrolled, setScrolled] = useState({ locked: false, upNext: false, done: false });
  const tabs = useRef({});
  const idPrefix = useId();
  const tabId = (name) => `${idPrefix}tab-${name}`;
  const panelId = (name) => `${idPrefix}panel-${name}`;

  // A step selected elsewhere (the Graph, a link) opens its column; the same step changing column in place does not.
  useEffect(() => {
    const column = board.columnOf(selectedId);
    if (column !== null) setShown(column);
  }, [selectedId]);

  const choose = (name) => {
    if (name === shown) return;
    track('roadmap_board_column', { column: name });
    setShown(name);
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

  const recentDone = board.recentDone();
  const folded = recentDone.folded && !doneExpanded;

  return (
    <div className="st-board-phone">
      <div className="st-board-phone-panes">
        {board.columns.map((column) => (
          <div
            key={column.name}
            id={panelId(column.name)}
            role="tabpanel"
            aria-labelledby={tabId(column.name)}
            className={`st-board-phone-pane ${column.name === shown ? 'is-shown' : ''} ${scrolled[column.name] ? 'is-scrolled' : ''}`}
            onScroll={(event) => handleScroll(column.name, event)}
          >
            <h2 className="st-board-phone-heading">{COLUMN_TITLES[column.name]}</h2>
            {(column.name === 'done' && folded ? recentDone.cards : column.cards).map((card) => (
              <StepCard key={card.id} card={card} selected={card.id === selectedId} onSelect={onSelect} />
            ))}
            {column.name === 'done' && folded && (
              <button type="button" className="st-board-show-all" onClick={() => onToggleDone()}>
                {showAllDone({ total: recentDone.total })}
              </button>
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
