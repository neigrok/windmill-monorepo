import test from 'node:test';
import assert from 'node:assert/strict';

import { capabilityGroups, consentSummary, readScope, summarizeScope } from '../../../src/shell/auth/scopes.js';

test('a scope is read into products and levels, in ladder order', () => {
  const read = readScope('gym:delete roadmap:read gym:read');
  assert.equal(read.accountWide, false);
  assert.deepEqual(read.products, [
    { product: 'gym', label: 'training log', levels: ['read', 'delete'] },
    { product: 'roadmap', label: 'roadmaps', levels: ['read'] },
  ]);
});

// The legacy grant: every token minted before scopes existed carries scope ''. Rendering it as
// "nothing" would tell someone they gave away far less than they did.
test('an empty scope is the account-wide grant and says so', () => {
  for (const stored of ['', '   ', undefined, null]) {
    assert.equal(readScope(stored).accountWide, true);
    assert.deepEqual(capabilityGroups(stored), []);
    assert.equal(summarizeScope(stored), 'Everything in your account');
  }
});

// The opposite case, and the one that must not collapse into the case above: unreadable tokens grant
// nothing on the backend, so the screen must not call them everything.
test('an unreadable scope reads as nothing, never as everything', () => {
  const read = readScope('nonsense roadmap:admin :read gym:');
  assert.equal(read.accountWide, false);
  assert.deepEqual(read.products, []);
  assert.equal(summarizeScope('nonsense'), 'Nothing — this grant reaches no product');
});

test('capability lines name the product the level actually reaches', () => {
  const groups = capabilityGroups('gym:read gym:write gym:delete');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'training log');
  assert.deepEqual(groups[0].lines, [
    { level: 'read', glyph: 'dim', label: 'See your training log' },
    { level: 'write', glyph: 'bud', label: 'Add to and change your training log' },
    { level: 'delete', glyph: 'gone', label: 'Delete from your training log' },
  ]);
});

// The gate, as the person sees it: a grant that did not ask for delete must not render a delete line,
// or the screen is asking for more than the token will carry.
test('a grant without delete renders no delete line', () => {
  const lines = capabilityGroups('roadmap:read roadmap:write').flatMap((group) => group.lines);
  assert.deepEqual(lines.map((line) => line.level), ['read', 'write']);
});

test('a multi-product grant is grouped per product, in the order it was asked for', () => {
  const groups = capabilityGroups('roadmap:write gym:read journal:read');
  assert.deepEqual(groups.map((group) => group.label), ['roadmaps', 'training log', 'journal']);
});

test('the settings summary keeps every level, delete included', () => {
  assert.equal(summarizeScope('gym:read gym:delete roadmap:read'),
               'training log: read, delete · roadmaps: read');
});

// A product this build has no name for is still shown, spelled as the wire spells it — an unlabeled
// product is a gap in this table, and hiding the line would hide real access.
test('an unknown product is named rather than dropped', () => {
  assert.equal(summarizeScope('atlas:write'), 'atlas: write');
});

// THE CONSENT CARD'S THREE FACES. Until 2026-08-07 the card chose between two of them by asking "did
// capabilityGroups come back empty?" — which is true of the account-wide grant AND of a scope this
// build cannot read, so every unparseable scope was drawn as "Everything in your account". That is
// the lie the file's own header names as the one that matters, told by the screen the header is about.
test('an unreadable scope reaches nothing on the consent card, never everything', () => {
  assert.deepEqual(consentSummary('nonsense roadmap:admin :read gym:'),
                   { reach: 'nothing', groups: [], canDelete: false });
});

test('an empty scope is the legacy account-wide grant, and it can delete', () => {
  for (const stored of ['', '   ', undefined, null])
    assert.deepEqual(consentSummary(stored), { reach: 'everything', groups: [], canDelete: true });
});

// The other half of the same bug: the account-wide grant draws no delete LINE, so a card reading
// "can it delete?" off its own rendered lines gave the widest grant in the system the reassuring
// sentence written for the narrowest.
test('canDelete follows the grant, not the lines that happen to be drawn', () => {
  assert.equal(consentSummary('roadmap:read roadmap:write').canDelete, false);
  assert.equal(consentSummary('roadmap:read gym:delete').canDelete, true);
  assert.equal(consentSummary('').canDelete, true);
});

test('a listed grant carries the same groups the card used to build itself', () => {
  const summary = consentSummary('gym:read journal:write');
  assert.equal(summary.reach, 'listed');
  assert.deepEqual(summary.groups, capabilityGroups('gym:read journal:write'));
});
