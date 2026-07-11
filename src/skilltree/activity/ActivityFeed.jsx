// The docked activity panel (design option A — the recommended placement): the
// dock's resting state, a flat reverse-chron feed with day separators. Purely
// presentational — SkillTreeView supplies the day groups, the count, and the
// row↔canvas handlers, plus the hovered node so a hovered fruit lights its rows.

import React from 'react';
import { Icon, IconButton } from '../../components';
import { EventRow } from './EventRow.jsx';

export function ActivityFeed({ groups, count, nodesById, now, hoveredId, newIds, pinned, onTogglePin, onClose, onHoverNode, onLeaveNode, onRevealNode }) {
  return (
    <div className="st-activity">
      <div className="st-activity-head">
        <span>Activity</span>
        <span className="st-activity-count">{count}</span>
        <span className="st-activity-live" title="Live" />
        <button
          type="button"
          className={`st-activity-pin ${pinned ? 'st-activity-pin--on' : ''}`}
          title={pinned ? 'Unpin — summon on demand' : 'Pin — keep docked'}
          aria-pressed={pinned}
          onClick={onTogglePin}
        >
          <Icon name="pin" size={13} />
        </button>
        <IconButton icon={<Icon name="x" size={14} />} label="Close activity" size="sm" onClick={onClose} />
      </div>
      <div className="st-activity-list">
        {groups.length === 0 ? (
          <div className="st-activity-empty">No activity yet — changes you make will appear here.</div>
        ) : (
          groups.map((group) => (
            <React.Fragment key={group.label}>
              <div className="st-daysep"><span>{group.label}</span></div>
              {group.events.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  node={nodesById.get(event.nodeId) ?? null}
                  now={now}
                  related={hoveredId != null && event.nodeId === hoveredId}
                  isNew={newIds?.has(event.id)}
                  onHover={onHoverNode}
                  onLeave={onLeaveNode}
                  onReveal={onRevealNode}
                />
              ))}
            </React.Fragment>
          ))
        )}
      </div>
    </div>
  );
}
