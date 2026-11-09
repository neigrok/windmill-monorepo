import { ACTIVITY } from '../copy.js';
import React from 'react';
import { Icon, IconButton } from '../../../design-system';
import { EventRow } from './EventRow.jsx';
import { t } from '../i18n/index.js';

export function ActivityFeed({ groups, count, nodesById, now, hoveredId, newIds, onClose, onHoverNode, onLeaveNode, onRevealNode }) {
  return (
    <div className="st-activity">
      <div className="st-activity-head">
        <span>{ACTIVITY.heading}</span>
        <span className="st-activity-count">{count}</span>
        <IconButton icon={<Icon name="x" size={14} />} label={t('roadmap.activity.close')} size="sm" onClick={onClose} />
      </div>
      <div className="st-activity-list">
        {groups.length === 0 ? (
          <div className="st-activity-empty">{ACTIVITY.empty}</div>
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
