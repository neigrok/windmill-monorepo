// Board ⇄ Graph: the phone's pair of icon targets, and from 744px the segmented control. The canvas view is 'tree'.

import React from 'react';
import { Tooltip } from '../../../design-system';
import { VIEW_SWITCH } from './copy.js';

const PHONE_GLYPHS = {
  board: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.41667" aria-hidden>
      <path d="M3.5 3.33333H5.66667C6.21895 3.33333 6.66667 3.78105 6.66667 4.33333V15.6667C6.66667 16.219 6.21895 16.6667 5.66667 16.6667H3.5C2.94772 16.6667 2.5 16.219 2.5 15.6667V4.33333C2.5 3.78105 2.94772 3.33333 3.5 3.33333Z" />
      <path d="M9.33333 3.33333H11.5C12.0523 3.33333 12.5 3.78105 12.5 4.33333V11.5C12.5 12.0523 12.0523 12.5 11.5 12.5H9.33333C8.78105 12.5 8.33333 12.0523 8.33333 11.5V4.33333C8.33333 3.78105 8.78105 3.33333 9.33333 3.33333Z" />
      <path d="M15.1667 3.33333H16.5C17.0523 3.33333 17.5 3.78105 17.5 4.33333V14C17.5 14.5523 17.0523 15 16.5 15H15.1667C14.6144 15 14.1667 14.5523 14.1667 14V4.33333C14.1667 3.78105 14.6144 3.33333 15.1667 3.33333Z" />
    </svg>
  ),
  tree: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.41667" aria-hidden>
      <path d="M6.66667 5.83333H12.5M5.83333 7.5V13.3333M7.5 14.1667H13.3333" />
      <circle cx="5" cy="5" r="2.5" />
      <circle cx="15" cy="5" r="2.5" />
      <circle cx="5" cy="15" r="2.5" />
      <circle cx="15" cy="15" r="2.5" />
    </svg>
  ),
};

const WIDE_GLYPHS = {
  board: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.66667" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 3.33333V13.3333M10 3.33333V9.16667M15 3.33333V15.8333" />
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
  const glyphs = phone ? PHONE_GLYPHS : WIDE_GLYPHS;
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
            {glyphs[option.view]}
          </button>
        );
        return phone ? button : <Tooltip key={option.view} label={option.label} side="bottom">{button}</Tooltip>;
      })}
    </div>
  );
}
