import React from 'react';
import { Icon, IconButton } from '../../../design-system';
import { ACTIVITY, LABELS, ROADMAP_VERBS } from '../copy.js';
import { ActorAvatar, EventSentence, relativeTime } from './grammar.jsx';

export function ActivityRows({ groups, nodesById, onOpenStep }) {
  const now = Date.now();
  return (
    <div className="st-roadmap-activity-rows" tabIndex={-1}>
      {groups.length === 0 ? <p className="st-activity-empty">{ACTIVITY.empty}</p> : groups.map((group) => (
        <React.Fragment key={group.label}>
          <div className="st-daysep"><span>{group.label}</span></div>
          {group.events.map((event) => {
            const node = nodesById.get(event.nodeId) ?? null;
            const Row = node ? 'button' : 'div';
            return (
              <Row key={event.id} className={`st-event${node ? '' : ' st-event--static'}`}
                {...(node ? { type: 'button', onClick: () => onOpenStep(event.nodeId) } : {})}>
                <ActorAvatar event={event} />
                <span className="st-event-text"><EventSentence event={event} node={node} /></span>
                <span className="st-event-time">{relativeTime(event.at, now)}</span>
              </Row>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}

// The tablet's Activity panel. The room seats it in whichever layer the view shows, so the Board's menus stand above it.
export function ActivityPanel({ top, groups, nodesById, onClose, onOpenStep }) {
  return (
    <aside className="st-roadmap-activity-panel" aria-label={ROADMAP_VERBS.activity} style={{ top }}>
      <div className="st-roadmap-activity-header">
        <h2>{ROADMAP_VERBS.activity}</h2>
        <IconButton icon={<Icon name="x" size={20} />} label={LABELS.close} onClick={onClose} />
      </div>
      <ActivityRows groups={groups} nodesById={nodesById} onOpenStep={onOpenStep} />
    </aside>
  );
}
