import React from 'react';
import { ACTIVITY } from '../board/copy.js';
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
