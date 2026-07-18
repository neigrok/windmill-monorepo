// Top overlay bar: the Windmill wordmark (links home to the landing root) on the
// left, camera controls on the right.

import React from 'react';
import { IconButton, Tooltip, Icon } from '../../components';

export function ControlBar({ title, titleSlot, onZoomIn, onZoomOut, onFitToView, canReset, onResetEdits, onShare, activityOpen, activityUnread, activityPing, readyCount = 0, onToggleActivity }) {
  return (
    <div className="st-topbar">
      <div className="st-brand">
        <a className="st-brand-home" href="#/" aria-label="Windmill — home">
          <span className="st-brand-name">Windmill</span>
        </a>
        {/* The tree identity plaque (F1·F2): the TreeSwitcher docks here when given,
            else the static title. It's the one home for "which tree am I in". */}
        {titleSlot ?? (title && <span className="st-brand-title" style={{ marginLeft: 'var(--space-2)' }}>{title}</span>)}
      </div>

      <div className="st-controls">
        {/* The standing offer (whats-next-panel): "Next · N" while steps are ready,
            the plain Activity chip at zero; the unseen-activity badge rides along. */}
        <Tooltip label={readyCount > 0 ? 'What’s next (A)' : 'Activity (A)'} side="bottom">
          <button
            type="button"
            className={`st-activity-chip ${activityOpen ? 'st-activity-chip--on' : ''} ${activityPing ? 'st-activity-chip--ping' : ''}`}
            onClick={onToggleActivity}
            aria-pressed={activityOpen}
          >
            <Icon name="bell" size={14} />
            <span>{readyCount > 0 ? `Next · ${readyCount}` : 'Activity'}</span>
            {activityUnread > 0 && <span className="st-activity-chip-badge">{activityUnread}</span>}
          </button>
        </Tooltip>
        <Tooltip label="Share roadmap" side="bottom">
          <IconButton icon={<Icon name="image" />} label="Share roadmap" size="sm" onClick={onShare} />
        </Tooltip>
        {canReset && (
          <Tooltip label="Reset to authored roadmap" side="bottom">
            <IconButton icon={<Icon name="rotate-ccw" />} label="Reset edits" size="sm" onClick={onResetEdits} />
          </Tooltip>
        )}
        <div className="st-zoom-group">
          <Tooltip label="Zoom out" side="bottom">
            <IconButton icon={<Icon name="zoom-out" />} label="Zoom out" size="sm" onClick={onZoomOut} />
          </Tooltip>
          <Tooltip label="Zoom in" side="bottom">
            <IconButton icon={<Icon name="zoom-in" />} label="Zoom in" size="sm" onClick={onZoomIn} />
          </Tooltip>
          <Tooltip label="Fit to view" side="bottom">
            <IconButton icon={<Icon name="maximize" />} label="Fit to view" size="sm" onClick={onFitToView} />
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
