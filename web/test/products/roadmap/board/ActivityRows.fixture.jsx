import React from 'react';
import { ACTIVITY } from '../../../../src/products/roadmap/board/copy.js';
import { EventSentence } from '../../../../src/products/roadmap/activity/grammar.jsx';

export function ActivityRows({ groups, nodesById, onOpenStep }) {
  if (groups.length === 0) return <p>{ACTIVITY.empty}</p>;
  return <div tabIndex={-1}>{groups.map((group) => (
    <section key={group.label}>
      <h3>{group.label}</h3>
      {group.events.map((event) => {
        const node = nodesById.get(event.nodeId);
        if (!node) return <div key={event.id}><EventSentence event={event} node={null} /></div>;
        return <button key={event.id} type="button" onClick={() => onOpenStep(event.nodeId)}>
          <EventSentence event={event} node={node} />
        </button>;
      })}
    </section>
  ))}</div>;
}
