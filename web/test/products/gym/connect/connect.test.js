// THE CONNECTED LOG'S WORDS ARE CLAIMS ABOUT THE BACKEND, which is what makes them worth a test.
// §D screens 12 and 13 draw a card, and this file is where each sentence on it is held against
// products/gym/adapters/mcp/GymToolCatalog.cpp — because a safety promise on a consent surface is
// exactly the kind of line that stays on a page for a year after the tool it described was retired.
//
// Three sentences did not survive that check and are banned here by their own words, so a revert
// fails a test rather than shipping quietly:
//
//   · "it never writes to your program" — `create_routine` is `gym:write` and lands immediately.
//   · "it cannot delete anything" — `discard_session` is `gym:delete` and is permanent.
//   · "you can edit or delete it yourself" — the catalog's justification for landing a new day
//     unasked, and the delete half is true on no surface we ship: nothing in web, iOS or Android
//     calls `deleteRoutine`.
//
// The ban walks the module's namespace rather than a list, because a hand-written list is what let
// the invitation carry the shortened version of the first one — "it proposes; the tap is yours" —
// past a review while the same file's own header refused it.
//
// The reading rules are here for the other reason: `connectionsToTheLog` decides whether a card that
// says "no tool reads your log" is drawn, and getting that backwards is a surface telling somebody
// nothing is connected while something is. It takes BOTH credentials that open this door — an OAuth
// grant and a static personal key — because the key is invisible to the grant list and reaches
// every level there is.

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

// EVERY SENTENCE THIS MODULE CAN PUT ON A SCREEN, TAKEN OFF THE MODULE ITSELF rather than listed by
// hand. The hand-written list is how the ban below missed the invitation — the one card most lifters
// actually meet, mounted on Routines and on every proposal — for a whole review: a constant added
// after the scan was written is a constant the scan does not read, and nothing fails. So the scan
// walks the namespace, which means a new line is covered the moment it is exported.
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

// WHICH CONNECTIONS REACH THE TRAINING LOG, and the three cases that are easy to collapse into one.
// A grant naming only roadmap is not a connection to this log; a grant naming gym at any depth is;
// and the legacy account-wide grant — every token minted before scopes existed carries scope '' —
// reaches every product at every level and is the widest row this list can hold. Dropping it for
// naming no product would be a screen telling a lifter nothing reads their log while a token with
// delete on it does.
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

// THE SECOND DOOR, WHICH THE GRANT LIST CANNOT SEE. A personal key is a static bearer minted in
// Connect → Advanced, it lives in its own table, and platform mints every one of them account-wide —
// so it reads, writes and DISCARDS in gym while `/v1/oauth/grants` answers with an empty array. A
// surface that read grants alone printed "No tool reads your log yet" to the one account whose
// credential can destroy a workout, which is the exact wrong direction of this mistake.
test('connectionsToTheLog — a personal key reaches this log too, at every level there is', () => {
  const rows = connectionsToTheLog([], [personalKey('key_1'), personalKey('key_2', { name: '' })]);

  assert.deepEqual(rows, [
    { id: 'key:key_1', name: 'key_1', since: Date.UTC(2026, 7, 5, 9, 0), levels: ['read', 'write', 'delete'], personal: true },
    { id: 'key:key_2', name: 'Unnamed key', since: Date.UTC(2026, 7, 5, 9, 0), levels: ['read', 'write', 'delete'], personal: true },
  ]);
});

// A CLIENT THAT REGISTERED NO DISPLAY NAME IS NOT A BLANK ROW. The grant list joins the client table
// with a coalesce, so an unregistered client's name comes back as the empty string and a row drawn
// straight off it is a state line under nothing at all.
test('connectionsToTheLog — a nameless client is drawn under the id it authorized with', () => {
  const rows = connectionsToTheLog([grant('cli_9f2', 'gym:read', { name: '' })], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'cli_9f2');
});

// A read that has not answered is not an empty list, and neither is a read that failed. Both hosts
// draw nothing at all in that state; this is the floor under them.
test('connectionsToTheLog — nothing in hand is no rows, never a row with nothing in it', () => {
  assert.deepEqual(connectionsToTheLog([], []), []);
  assert.deepEqual(connectionsToTheLog(null, null), []);
  assert.deepEqual(connectionsToTheLog(undefined, undefined), []);
});

// THE FRESHNESS THE CARD REFUSES TO INVENT. §D draws `connected · read 2h ago`, which needs a
// per-connection last-read of THIS log. Nothing records one: `lastUsedMs` on the grant row is
// touched by any token use, counts writes as well as reads, is throttled, and is account-wide — a
// connection that also reaches roadmap advances it by planting a node in a skill tree. So the label
// says the two things that are observable and stops, and `lastUsedMs` is not among them.
test('connectedLabel says when a tool was connected, and claims no read it cannot observe', () => {
  const row = { id: 'grant:c', name: 'Claude', since: Date.UTC(2026, 7, 3, 9, 0), levels: ['read', 'write'], personal: false };
  assert.equal(connectedLabel(row), 'connected 3 Aug   ·   read · write');
  // Nobody approved a personal key on a consent screen — it was minted in one tap and pasted
  // somewhere this account cannot see — so the verb is the one that is true of it, and it is true of
  // it on both surfaces that draw the row.
  const key = { id: 'key:k', name: 'laptop', since: Date.UTC(2026, 7, 5, 9, 0), levels: ['read', 'write', 'delete'], personal: true };
  assert.equal(connectedLabel(key), 'minted 5 Aug   ·   read · write · delete');
  // The lifted phrase from the design, and every shape of it: an hour count on this row would be a
  // number nothing in the system holds.
  for (const invented of ['read 2h ago', 'ago', 'last read', 'lastUsed']) {
    assert.equal(connectedLabel(row).includes(invented), false, invented);
  }
});

// WHAT EACH LEVEL BUYS, AGAINST THE CATALOG. `write` names the day it adds and the link it mints,
// not only the half that waits for a tap, and `delete` names the workout it can destroy — because a
// level line that named the proposing half alone would be selling a safety property this product
// does not have.
test('the level lines name the writes that land, not only the ones that wait', () => {
  assert.equal(LEVEL_LINES.read.startsWith('Read your log'), true);
  // `create_exercise` is the seventh `gym:write` tool and the one with no clause of its own — a
  // second row for a movement that already exists forks that lift's history across two ids
  // permanently — so the movement is named beside the day.
  for (const lands of ['Record what happened', 'add a new day or a new movement', 'share one workout by link']) {
    assert.equal(LEVEL_LINES.write.includes(lands), true, lands);
  }
  assert.equal(LEVEL_LINES.write.includes('propose changes to the days you have'), true);
  assert.equal(LEVEL_LINES.delete, 'Discard a workout · end a share link · propose a removal');
});

// THE TWO SENTENCES THE DESIGN WROTE THAT THE CATALOG REFUSES. They are banned by their own words
// rather than merely replaced: each was true of an earlier build, each reads perfectly, and each is
// the kind of line a later wave puts back because it sounds like the product.
test('no sentence on this surface says an agent writes nothing, or deletes nothing', () => {
  const spoken = everySentence();
  for (const untrue of [
    'never writes to your program',
    'cannot delete anything',
    'or delete anything',
    'read-only',
    'It only reads',
    // THE HALF-SENTENCE, WHICH IS THE SAME DEFECT SHORTENED. "It proposes; the tap is yours"
    // describes `propose_routine_change` and nothing else `gym:write` reaches — a next block written
    // as a NEW day is `create_routine`, and that lands with no tap at all.
    'It proposes; the tap is yours',
    // AND THE JUSTIFICATION FOR LANDING IT UNASKED, which the catalog states and no surface we ship
    // makes true: nothing in gym deletes a routine. `gymApi.deleteRoutine` has no caller in web, and
    // its iOS and Android twins have none either.
    'delete it yourself',
    'edit or delete it',
  ]) {
    assert.equal(spoken.includes(untrue), false, untrue);
  }
  // And what stands in their place is the split itself, both halves of it — in the pitch, and in the
  // one line the invitation gets, which is the surface most lifters meet before any room.
  assert.equal(PITCH_POINTS.some((point) => point.includes('waits for your tap')), true);
  assert.equal(PITCH_POINTS.some((point) => point.includes('lands right away')), true);
  assert.equal(connect.INVITATION_LINE.includes('a new day lands'), true);
  assert.equal(connect.INVITATION_LINE.includes('waits for your tap'), true);
  // Plus the one the design left out entirely: a granted delete is permanent.
  assert.equal(APPROVE_WITH_CARE.includes('permanently, with no undo'), true);
});

// THE THREE THINGS NO LEVEL BUYS, and the list stops at three because a fourth would have to be
// invented. Each is checked against the catalog: there is no apply tool at any level, no tool at any
// level touches an individual logged set, and a level that was not granted is not in that
// connection's tools/list at all.
//
// EACH IS SCOPED, WHICH IS WHY THEY ARE TRUE. The second says "an individual set" and not "your
// log", because `discard_session` at `gym:delete` destroys a whole workout and every set in it —
// APPROVE_WITH_CARE is where that is said, and a "never" list that swallowed it would be the
// nearly-true safety promise this file exists to refuse.
test('what no level buys is three claims, each of them about a tool that does not exist', () => {
  assert.equal(NEVER.length, 3);
  assert.equal(NEVER[0].includes('no apply tool at any grant level'), true);
  assert.equal(NEVER[0].includes('keeps the copy it was trained against'), true);
  assert.equal(NEVER[1].includes('No tool at any level touches an individual set'), true);
  assert.equal(NEVER[2].includes('Delete is never implied by write'), true);
  // And no line here says an agent cannot reach your log at all — one of them can, with delete.
  assert.equal(NEVER.join('  ').includes('nothing an agent does can change what your log says'), false);
});

// NOTHING HERE NAMES A PRICE, A PLAN OR A LOCK, and nothing leads to a checkout. §D's headline was
// "The log is free. The connected log is Windmill One" — a tier that gates nothing in gym, that
// nobody can buy (`paidPlansOpen()` is a hardcoded false), and whose button would land on a
// BillingApi that 503s. The scan is over the words AND the one href, because copy can be reworded
// and a destination cannot.
test('the connected log offers nothing to buy and walks to no checkout', () => {
  const spoken = everySentence();
  assert.equal(/Windmill One|[Uu]pgrade|[Ss]ubscri|[Pp]remium|\$\d|£\d|€\d|free for now|founder/.test(spoken), false);
  // The free line is a statement and carries no deadline: "free for now" and a countdown are the
  // manufactured urgency this brand's mission forecloses.
  assert.equal(FREE_LINE.includes('There is nothing in gym to buy'), true);
  // The one door out of this surface is the account's own workbench, and it is not a till.
  assert.equal(WORKBENCH_HREF, '#/connect');
});

// THE PRECONDITION IS THE HONEST LINE, and it survives the wave that deleted the price around it: a
// feature that needs a tool we do not sell says so before anyone decides, and it names the clients
// both connect surfaces actually carry instructions for.
test('the precondition names what a lifter must already have, and what stays free if they do not', () => {
  assert.equal(PRECONDITION.includes('speaks MCP'), true);
  for (const client of ['Claude Desktop', 'Claude Code', 'Cursor', 'Codex']) {
    assert.equal(PRECONDITION.includes(client), true, client);
  }
  assert.equal(PRECONDITION.includes('this one is not for you yet'), true);
  assert.equal(PRECONDITION.includes('the log stays free regardless'), true);
});

// DISCONNECT TAKES NOTHING AWAY, which is the half of the sentence that is easy to drop. The account
// revoke drops a client's tokens, codes and grant and never its content, so a proposal it wrote
// stays in the routine's history and a set it logged stays in the log.
test('the disconnect line names where the revoke lives, and what it does not touch', () => {
  assert.equal(DISCONNECT_LINE.includes('Settings → Connected tools'), true);
  assert.equal(DISCONNECT_LINE.includes('stops every read at once'), true);
  assert.equal(DISCONNECT_LINE.includes('every proposal already in your history stays'), true);
  // TWO DOORS IN, SO TWO DOORS OUT. Connected tools cannot revoke a personal key — that is the
  // account's API keys section, a different list of a different credential — so a line naming only
  // the first sends half the people who read it to a section their key is not in.
  assert.equal(DISCONNECT_LINE.includes('Settings → API keys'), true);
  assert.equal(PERSONAL_KEY_NOTE.includes('the whole account'), true);
});
