// Board ⇄ Graph: the phone's pair of icon targets, and from 744px the segmented control. The canvas view is 'tree'.

import React from 'react';
import { Tooltip } from '../../../design-system';
import { VIEW_SWITCH } from '../copy.js';

const GLYPHS = {
  board: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="3.33333" width="3.5" height="13.33333" rx="1" />
      <rect x="8.25" y="3.33333" width="3.5" height="9.16667" rx="1" />
      <rect x="14" y="3.33333" width="3.5" height="11.66667" rx="1" />
    </svg>
  ),
  tree: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="10" cy="4.16667" r="2.08333" />
      <circle cx="5" cy="15.8333" r="2.08333" />
      <circle cx="15" cy="15.8333" r="2.08333" />
      <path d="M10 6.25V9.58333M10 9.58333L5.83333 14.1667M10 9.58333L14.1667 14.1667" />
    </svg>
  ),
};

const OPTIONS = [
  { view: 'board', label: VIEW_SWITCH.board },
  { view: 'tree', label: VIEW_SWITCH.graph },
];

export function ViewSwitch({ view, onSwitch, phone = false }) {
  return (
    <div className={`st-board-switch ${phone ? 'st-board-switch--phone' : 'st-board-switch--wide'}`} role="group" aria-label={VIEW_SWITCH.group}>
      {OPTIONS.map((option) => {
        const button = (
          <button
            key={option.view}
            type="button"
            className="st-board-switch-option"
            aria-label={option.label}
            aria-pressed={view === option.view}
            onClick={() => { if (view !== option.view) onSwitch(option.view); }}
          >
            {GLYPHS[option.view]}
          </button>
        );
        return phone ? button : <Tooltip key={option.view} label={option.label} side="bottom">{button}</Tooltip>;
      })}
    </div>
  );
}
