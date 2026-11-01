// Below 744px a step is a page pushed over the Board, which stays mounted beneath it with its pane and scroll. Back
// names the screen it returns to: the roadmap, or the step this one was opened from. The sections and the actions sit
// under the thumb; the subtask offer leads the workspace (07.06).

import React from 'react';
import './page.css';
import { StepIcons } from './StepIcons.jsx';
import { backTo } from './copy.js';

export function StepPage({ layerRef, labelledBy, onKeyDown, backLabel, onBack, identity, menu, sections, content, offer, actions }) {
  return (
    <div
      ref={layerRef}
      className="st-board-step-layer st-board-step-page"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="st-board-step-page-nav">
        <button type="button" className="st-board-step-page-back" aria-label={backTo({ screen: backLabel })} onClick={onBack}>
          <span className="st-board-step-page-back-glyph"><StepIcons.back /></span>
          <span className="st-board-step-page-back-label">{backLabel}</span>
        </button>
        {menu}
      </div>
      <div className="st-board-step-page-scroll">
        {identity}
        {offer}
        {content}
      </div>
      {(sections || actions) && (
        <div className="st-board-step-page-pinned">
          {sections}
          {actions}
        </div>
      )}
    </div>
  );
}
