import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('../../../jsxLoader.mjs', import.meta.url);
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { ActivityRows } = await import('../../../../src/products/roadmap/activity/ActivityRows.jsx');
const { ActorAvatar, EventSentence } = await import('../../../../src/products/roadmap/activity/grammar.jsx');
const { ACTIVITY } = await import('../../../../src/products/roadmap/board/copy.js');
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test('touch Activity renders the exact shipped empty state outside the Tab order', () => {
  assert.equal(render(ActivityRows, { groups: [], nodesById: new Map(), onOpenStep() {} }),
    `<div class="st-roadmap-activity-rows" tabindex="-1"><p class="st-activity-empty">${ACTIVITY.empty}</p></div>`);
});

test('touch Activity keeps grouped live and removed rows, full sentences, avatars and relative times', (t) => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const node = { id: 'wind', label: 'Read the wind', color: 'sky' };
  const live = { id: 'e1', nodeId: node.id, actor: 'Maya', verb: 'renamed', at: now - 7200000 };
  const removed = { id: 'e2', nodeId: 'old', actor: 'You', verb: 'removed', label: 'an old step', at: now - 86400000 };
  const groups = [{ label: 'Today', events: [live] }, { label: 'Yesterday', events: [removed] }];
  const expected = '<div class="st-roadmap-activity-rows" tabindex="-1">'
    + '<div class="st-daysep"><span>Today</span></div><button class="st-event" type="button">'
    + render(ActorAvatar, { event: live })
    + '<span class="st-event-text">' + render(EventSentence, { event: live, node })
    + '</span><span class="st-event-time">2h</span></button>'
    + '<div class="st-daysep"><span>Yesterday</span></div><div class="st-event st-event--static">'
    + render(ActorAvatar, { event: removed })
    + '<span class="st-event-text">' + render(EventSentence, { event: removed, node: null })
    + '</span><span class="st-event-time">1d</span></div></div>';
  assert.equal(render(ActivityRows, { groups, nodesById: new Map([[node.id, node]]), onOpenStep() {} }), expected);
});
