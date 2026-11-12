import test from 'node:test';
import assert from 'node:assert/strict';
import { GUIDE_BOUND, GuideDraft, InadmissibleGuide, admitsGuide, guideExcerpt, guideLengthBucket, hasGuide, saveFailureReason } from '../../../../src/products/roadmap/guide/GuideDraft.js';

const reading = (draft) => ({ length: draft.length, fits: draft.fits, counted: draft.counted, left: draft.left, over: draft.over });

test('a draft counts code points as the server does: an astral emoji or a CJK character is one, and so is each part of a joined emoji', () => {
  assert.deepEqual(reading(new GuideDraft('', '🌊⛵')), { length: 2, fits: true, counted: false, left: 4998, over: 0 });
  assert.deepEqual(reading(new GuideDraft('', '帆船を学ぶ')), { length: 5, fits: true, counted: false, left: 4995, over: 0 });
  assert.equal('🧑‍🚀'.length, 5);
  assert.equal(new GuideDraft('', '🧑‍🚀').length, 3);
});

test('the counter speaks from 4,500 code points, exactly 5,000 still fits, and 5,001 is over', () => {
  assert.deepEqual(reading(new GuideDraft('', 'a'.repeat(4499))), { length: 4499, fits: true, counted: false, left: 501, over: 0 });
  assert.deepEqual(reading(new GuideDraft('', 'a'.repeat(4500))), { length: 4500, fits: true, counted: true, left: 500, over: 0 });
  assert.deepEqual(reading(new GuideDraft('', '🌊'.repeat(4620))), { length: 4620, fits: true, counted: true, left: 380, over: 0 });
  assert.deepEqual(reading(new GuideDraft('', '海'.repeat(GUIDE_BOUND))), { length: 5000, fits: true, counted: true, left: 0, over: 0 });
  assert.deepEqual(reading(new GuideDraft('', '🌊'.repeat(GUIDE_BOUND + 1))), { length: 5001, fits: false, counted: true, left: 0, over: 1 });
});

test('a paste over the bound is kept whole: the draft holds every character and says how far over it is', () => {
  const pasted = `${'a'.repeat(5000)}${'帆'.repeat(312)}`;
  const draft = new GuideDraft('One step a week.').writing(pasted);
  assert.equal(draft.text, pasted);
  assert.deepEqual({ ...reading(draft), changed: draft.changed, saved: draft.saved === pasted }, { length: 5312, fits: false, counted: true, left: 0, over: 312, changed: true, saved: true });
});

test('a draft knows its own change, what Save writes and whether the guide moved away from where it started', () => {
  const draft = new GuideDraft('One step a week.');
  assert.deepEqual({ changed: draft.changed, saved: draft.saved }, { changed: false, saved: 'One step a week.' });
  assert.deepEqual({ changed: draft.writing('  \n ').changed, saved: draft.writing('  \n ').saved }, { changed: true, saved: '' });
  assert.equal(draft.writing('  Two steps.\n').saved, '  Two steps.\n');
  assert.equal(draft.outdatedBy('One step a week.'), false);
  assert.equal(draft.writing('Mine').outdatedBy('Two steps a week until the June trip.'), true);
  assert.ok(Object.isFrozen(draft));
});

test('an excerpt is the first line with words, and a guide of blank lines is none', () => {
  assert.equal(guideExcerpt('\n  One step a week, on weekend sails with Maya.  \nKinds: …'), 'One step a week, on weekend sails with Maya.');
  assert.equal(guideExcerpt(''), '');
  assert.deepEqual([hasGuide(''), hasGuide(' \n\t'), hasGuide(undefined), hasGuide(' a ')], [false, false, false, true]);
});

test('a saved length leaves as one of five bounded labels', () => {
  assert.deepEqual([0, 1, 500, 501, 2000, 2001, 4500, 4501, 5000].map(guideLengthBucket),
    ['0', '1-500', '1-500', '501-2000', '501-2000', '2001-4500', '2001-4500', '4501-5000', '4501-5000']);
});

test('a failed save is offline only when the request never arrived and the browser reports no connection, refused on a 4xx that trying again cannot change or on inadmissible text, and else the fault of the door that failed', () => {
  const answered = (status) => Object.assign(new Error('private server sentence'), { status });
  const online = true;
  assert.deepEqual([
    saveFailureReason(answered(0), 'server', false),
    saveFailureReason(answered(0), 'server', online),
    saveFailureReason(answered(400), 'server', online),
    saveFailureReason(answered(401), 'server', online),
    saveFailureReason(answered(403), 'server', false),
    saveFailureReason(answered(404), 'server', online),
    saveFailureReason(answered(499), 'server', online),
    saveFailureReason(answered(408), 'server', online),
    saveFailureReason(answered(429), 'server', online),
    saveFailureReason(new InadmissibleGuide(), 'session', online),
    saveFailureReason(new InadmissibleGuide(), 'device', false),
    saveFailureReason(answered(500), 'server', online),
    saveFailureReason(answered(503), 'server', false),
    saveFailureReason(new TypeError('private'), 'server', online),
    saveFailureReason(new Error('local tree changed during a write'), 'device', online),
    saveFailureReason(new Error('private'), 'session', false),
    saveFailureReason(undefined, 'device', online),
  ], ['offline', 'server', 'refused', 'refused', 'refused', 'refused', 'refused', 'server', 'server', 'refused', 'refused', 'server', 'server', 'server', 'device', 'device', 'device']);
});

test('a paste carrying a NUL or a lone surrogate saves what the person sees: no NUL, the lone half as its replacement glyph', () => {
  const pasted = new GuideDraft('', 'One\u0000 step \uD83C a week \uDE00.');
  assert.deepEqual({ saved: pasted.saved, wellFormed: pasted.saved.isWellFormed(), length: pasted.length, admitted: admitsGuide(pasted.saved) },
    { saved: 'One step \uFFFD a week \uFFFD.', wellFormed: true, length: 20, admitted: true });
  assert.equal(new GuideDraft('', '\u0000 \n\u0000').saved, '');
  assert.equal(new GuideDraft('', '\u0000'.repeat(5001)).fits, true);
  assert.equal(new GuideDraft('', '🌊').saved, '🌊');
});

test('a guide is admitted as the server admits one: well-formed, no NUL, words or nothing, at most 5,000 code points', () => {
  const cases = { '': true, 'One step.': true, ' \n ': false, 'One\u0000': false, 'One \uD83C': false, [`${'🌊'.repeat(GUIDE_BOUND)}`]: true, [`${'a'.repeat(GUIDE_BOUND + 1)}`]: false };
  assert.deepEqual(Object.fromEntries(Object.keys(cases).map((text) => [text, admitsGuide(text)])), cases);
  assert.equal(admitsGuide(7), false);
});

test('a draft reads its guide with one line feed per line ending, so a stored CRLF is neither a change nor a late caret', () => {
  const stored = 'One step a week.\r\nKinds: Learn, Build.\rAgents: ask first.';
  const draft = new GuideDraft(stored);
  assert.deepEqual({ base: draft.base, changed: draft.changed, outdated: draft.outdatedBy(stored), retyped: draft.writing(`${draft.base}x`).writing(draft.base).changed },
    { base: 'One step a week.\nKinds: Learn, Build.\nAgents: ask first.', changed: false, outdated: false, retyped: false });
  assert.equal(draft.outdatedBy('Two steps a week.'), true);
});

test('blank against no guide is no change, while blank against a guide clears it', () => {
  assert.equal(new GuideDraft('', '  \n ').changed, false);
  assert.equal(new GuideDraft(' ', '').changed, false);
  assert.equal(new GuideDraft('One step a week.', '  ').changed, true);
  assert.equal(new GuideDraft('', 'One step a week.').changed, true);
});
