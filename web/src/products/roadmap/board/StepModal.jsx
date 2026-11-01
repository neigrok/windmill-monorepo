// From 744px a step opens in a modal centred over the scrimmed roadmap: the identity with ⋯ and close on top, the
// sections under them, the content scrolling between, the actions pinned to the foot. 760 wide, and 24px in from the
// window's edges below that (05.06). A press on the scrim closes it.

import React from 'react';
import './modal.css';
import { StepIcons } from './StepIcons.jsx';
import { STEP_DETAIL } from './copy.js';

export function StepModal({ layerRef, labelledBy, onKeyDown, onClose, identity, menu, sections, content, offer, actions }) {
  return (
    <div
      ref={layerRef}
      className="st-board-step-layer st-board-step-scrim"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="st-board-step-modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
        <div className="st-board-step-modal-tools">
          {identity}
          {menu}
          <button type="button" className="st-board-step-icon-button" aria-label={STEP_DETAIL.close} onClick={onClose}>
            <StepIcons.close />
          </button>
        </div>
        {sections}
        <div className="st-board-step-modal-content">{content}</div>
        {(offer || actions) && (
          <div className="st-board-step-modal-actions">
            {offer}
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
