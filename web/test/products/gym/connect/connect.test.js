import test from 'node:test';
import assert from 'node:assert/strict';

import * as connect from '../../../../src/products/gym/connect/connect.js';
import {
  APPROVE_WITH_CARE, connectedLabel, connectionsToTheLog, DISCONNECT_LINE, FREE_LINE,
  LEVEL_LINES, NEVER, PERSONAL_KEY_NOTE, PITCH_POINTS, PRECONDITION, WORKBENCH_HREF,
} from '../../../../src/products/gym/connect/connect.js';

const grant = (clientId, scope, over = {}) => ({
  clientId, name: clientId, scope, grantedMs: Date.UTC(2026, 7, 3, 9, 0), lastUsedMs: 0, ...over,
});

const personalKey = (id, over = {}) => ({
  id, name: id, createdMs: Date.UTC(2026, 7, 5, 9, 0), lastUsedMs: null, ...over,
});

const everySentence = () => {
  const out = [];
  const take = (value) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(take);
    else if (value && typeof value === 'object') Object.values(value).forEach(take);
  };
  Object.values(connect).forEach(take);
  return out.join('  ');
};

test('connectionsToTheLog — only gym, and the legacy account-wide grant is the widest row of all', () => {
  const rows = connectionsToTheLog([
    grant('roadmap-only', 'roadmap:read roadmap:write'),
    grant('reader', 'gym:read'),
    grant('planner', 'roadmap:read gym:read gym:write'),
    grant('legacy', ''),
    grant('unreadable', 'nonsense'),
  ], []);

  assert.deepEqual(rows, [
    { id: 'grant:reader', name: 'reader', since: Date.UTC(2026, 7, 3, 9, 0), levels: ['read'], personal: false },
    { id: 'grant:planner', name: 'planner', since: Date.UTC(2026, 7, 3, 9, 0), levels: ['read', 'write'], personal: false },
    { id: 'grant:legacy', name: 'legacy', since: Date.UTC(2026, 7, 3, 9, 0), levels: ['read', 'write', 'delete'], personal: false },
  ]);
});

test('connectionsToTheLog — a personal key reaches this log too, at every level there is', () => {
  const rows = connectionsToTheLog([], [personalKey('key_1'), personalKey('key_2', { name: '' })]);

  assert.deepEqual(rows, [
    { id: 'key:key_1', name: 'key_1', since: Date.UTC(2026, 7, 5, 9, 0), levels: ['read', 'write', 'delete'], personal: true },
    { id: 'key:key_2', name: 'Unnamed key', since: Date.UTC(2026, 7, 5, 9, 0), levels: ['read', 'write', 'delete'], personal: true },
  ]);
});

test('connectionsToTheLog — a nameless client is drawn under the id it authorized with', () => {
  const rows = connectionsToTheLog([grant('cli_9f2', 'gym:read', { name: '' })], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'cli_9f2');
});

test('connectionsToTheLog — nothing in hand is no rows, never a row with nothing in it', () => {
  assert.deepEqual(connectionsToTheLog([], []), []);
  assert.deepEqual(connectionsToTheLog(null, null), []);
  assert.deepEqual(connectionsToTheLog(undefined, undefined), []);
});

test('connectedLabel says when a tool was connected, and claims no read it cannot observe', () => {
  const row = { id: 'grant:c', name: 'Claude', since: Date.UTC(2026, 7, 3, 9, 0), levels: ['read', 'write'], personal: false };
  assert.equal(connectedLabel(row), 'connected 3 Aug   ·   read · write');
  const key = { id: 'key:k', name: 'laptop', since: Date.UTC(2026, 7, 5, 9, 0), levels: ['read', 'write', 'delete'], personal: true };
  assert.equal(connectedLabel(key), 'minted 5 Aug   ·   read · write · delete');
  for (const invented of ['read 2h ago', 'ago', 'last read', 'lastUsed']) {
    assert.equal(connectedLabel(row).includes(invented), false, invented);
  }
});

test('the level lines name the writes that land, not only the ones that wait — and claim no reach the tools do not have', () => {
  assert.equal(LEVEL_LINES.read, 'Read your log — sets, workouts, routines, records and notes');
  // `get_preferences` does not exist at any level: the rest target and the reading unit are the
  // lifter's own dials. A consent screen that says otherwise over-claims.
  for (const overclaimed of ['how your gym is set up', 'preferences', 'rest', 'unit']) {
    assert.equal(LEVEL_LINES.read.includes(overclaimed), false, overclaimed);
  }
  for (const lands of ['Record what happened', 'add a new day or a new movement', 'share one workout by link']) {
    assert.equal(LEVEL_LINES.write.includes(lands), true, lands);
  }
  assert.equal(LEVEL_LINES.write.includes('propose changes to the days you have'), true);
  // A share link is readable by anyone holding it and outlives the session that minted it, so the
  // level that mints one says both — as its own `·` item, because a row of facts does not grow a
  // paragraph.
  assert.equal(
    LEVEL_LINES.write,
    'Record what happened · add a new day or a new movement · propose changes to the days you have · share one workout by link · anybody holding that link reads it without signing in, for 30 days unless you end it sooner',
  );
  assert.equal(LEVEL_LINES.write.includes(' — '), false, 'no clause welded onto the list');
  assert.equal(LEVEL_LINES.delete, 'Discard a workout · end a share link · propose a removal');
});

test('no sentence on this surface says an agent writes nothing, or deletes nothing', () => {
  const spoken = everySentence();
  for (const untrue of [
    'never writes to your program',
    'cannot delete anything',
    'or delete anything',
    'read-only',
    'It only reads',
    'It proposes; the tap is yours',
    'delete it yourself',
    'edit or delete it',
  ]) {
    assert.equal(spoken.includes(untrue), false, untrue);
  }
  assert.equal(PITCH_POINTS.some((point) => point.includes('waits for your tap')), true);
  assert.equal(PITCH_POINTS.some((point) => point.includes('lands right away')), true);
  assert.equal(APPROVE_WITH_CARE.includes('permanently, with no undo'), true);
});

test('what no level buys is three claims, each of them about a tool that does not exist', () => {
  assert.equal(NEVER.length, 3);
  assert.equal(NEVER[0].includes('no apply tool at any grant level'), true);
  assert.equal(NEVER[0].includes('keeps the copy it was trained against'), true);
  assert.equal(NEVER[1].includes('No tool at any level touches an individual set'), true);
  assert.equal(NEVER[2].includes('Delete is never implied by write'), true);
  assert.equal(NEVER.join('  ').includes('nothing an agent does can change what your log says'), false);
});

test('the connected log offers nothing to buy and walks to no checkout', () => {
  const spoken = everySentence();
  assert.equal(/Windmill One|[Uu]pgrade|[Ss]ubscri|[Pp]remium|\$\d|£\d|€\d|free for now|founder/.test(spoken), false);
  assert.equal(FREE_LINE.includes('There is nothing in gym to buy'), true);
  assert.equal(WORKBENCH_HREF, '#/connect');
});

test('the precondition names what a lifter must already have, and what stays free if they do not', () => {
  assert.equal(PRECONDITION.includes('speaks MCP'), true);
  for (const client of ['Claude Desktop', 'Claude Code', 'Cursor', 'Codex']) {
    assert.equal(PRECONDITION.includes(client), true, client);
  }
  assert.equal(PRECONDITION.includes('this one is not for you yet'), true);
  assert.equal(PRECONDITION.includes('the log stays free regardless'), true);
});

test('the disconnect line names where the revoke lives, and what it does not touch', () => {
  assert.equal(DISCONNECT_LINE.includes('Settings → Connected tools'), true);
  assert.equal(DISCONNECT_LINE.includes('stops every read at once'), true);
  assert.equal(DISCONNECT_LINE.includes('every proposal already in your history stays'), true);
  assert.equal(DISCONNECT_LINE.includes('Settings → API keys'), true);
  assert.equal(PERSONAL_KEY_NOTE.includes('the whole account'), true);
});
