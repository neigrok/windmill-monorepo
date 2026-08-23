import test from 'node:test';
import assert from 'node:assert/strict';

import { SkillTree } from '../../../../src/products/roadmap/model/SkillTree.js';
import { ActivityLog, ActivityEvent } from '../../../../src/products/roadmap/activity/ActivityLog.js';

const HOUR = 3600000;
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

const tree = new SkillTree({
  id: 't',
  title: 'T',
  nodes: [
    { id: 'a', label: 'A', prerequisites: [] },
    { id: 'b', label: 'B', prerequisites: ['a'] },
    { id: 'c', label: 'C', prerequisites: ['b'] },
  ],
});
const allComplete = new Map([['a', 'complete'], ['b', 'complete'], ['c', 'complete']]);

test('a seeded completion carries the stamp the completion was recorded at', () => {
  const log = ActivityLog.fromTree(tree, allComplete, { a: NOW - 50 * HOUR, b: NOW - 26 * HOUR, c: NOW - 2 * HOUR });

  assert.deepEqual(log.events.map((event) => [event.nodeId, event.at]), [
    ['a', NOW - 50 * HOUR],
    ['b', NOW - 26 * HOUR],
    ['c', NOW - 2 * HOUR],
  ]);
});

test('a completion we hold no stamp for is undated, and sorts oldest in dependency order', () => {
  const log = ActivityLog.fromTree(tree, allComplete, { c: NOW - 2 * HOUR });

  assert.deepEqual(log.events.map((event) => [event.nodeId, event.at]), [
    ['a', null],
    ['b', null],
    ['c', NOW - 2 * HOUR],
  ]);
});

test('the day groups read newest first and undated deeds fall under Earlier, last', () => {
  const log = ActivityLog.fromTree(tree, allComplete, { b: NOW - 26 * HOUR, c: NOW - 2 * HOUR });

  assert.deepEqual(
    log.groupedByDay(NOW).map((group) => [group.label, group.events.map((event) => event.nodeId)]),
    [['Today', ['c']], ['Yesterday', ['b']], ['Earlier', ['a']]],
  );
});

test('the log orders a mixed seed and server history by instant, whatever order it is handed', () => {
  const server = new ActivityEvent({ id: 'op-1', actor: 'Guest 2', verb: 'linked', nodeId: 'c', at: NOW - 10 * HOUR, summary: 'linked B → C' });
  const seeded = ActivityLog.fromTree(tree, allComplete, { a: NOW - 50 * HOUR, b: NOW - 26 * HOUR, c: NOW - 2 * HOUR }).events;

  const log = new ActivityLog([server, ...seeded]);

  assert.deepEqual(log.events.map((event) => event.id), ['seed-a', 'seed-b', 'op-1', 'seed-c']);
});
