import React from 'react';
import { ActorAvatar, EventSentence, relativeTime } from './grammar.jsx';

export function EventRow({ event, node, now, related, isNew, onHover, onLeave, onReveal }) {
  const linkable = !!node;
  return (
    <button
      type="button"
      className={`st-event ${linkable ? '' : 'st-event--static'} ${related ? 'st-event--rel' : ''} ${isNew ? 'st-event--new' : ''}`}
      onMouseEnter={linkable ? () => onHover?.(event.nodeId) : undefined}
      onMouseLeave={linkable ? () => onLeave?.() : undefined}
      onClick={linkable ? () => onReveal?.(event.nodeId) : undefined}
    >
      <ActorAvatar event={event} />
      <span className="st-event-text"><EventSentence event={event} node={node} /></span>
      <span className="st-event-time">{relativeTime(event.at, now)}</span>
    </button>
  );
}
