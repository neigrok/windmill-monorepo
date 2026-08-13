// UNITS, AND THE PROOF THAT THEY ARE ONLY EVER A SPELLING. Two halves, and the second is the one
// that matters: the transform is pinned by value, and then the SOURCE is walked to show it cannot
// reach a write. A test that only exercised the function would stay green through the exact change
// this rule exists to forbid — a client that converted a typed pound into a kilogram on its way into
// the log, quietly making every stored weight a function of a display setting.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inDisplayUnit, KG, LB, spellWeightsIn, UNITS, weightUnit } from '../../../src/products/gym/units.js';

const GYM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/products/gym');
const read = (file) => fs.readFileSync(path.join(GYM, file), 'utf8');

function sourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (['.js', '.jsx'].includes(path.extname(entry.name))) files.push(full);
  }
  return files;
}

// Every test here leaves the module reading kilograms, because the spelling is module-level state
// and a test that forgot would be handing the next one a surface in the wrong unit.
function reading(t, units) {
  spellWeightsIn(units);
  t.after(() => spellWeightsIn(KG));
}

test('the two units are the two the wire spells, and kilograms is where an unread account stands', () => {
  assert.deepEqual(UNITS, ['kg', 'lb']);
  assert.equal(KG, 'kg');
  assert.equal(LB, 'lb');
  assert.equal(weightUnit(), KG);
  assert.equal(inDisplayUnit(102.5), 102.5);
});

test('kilograms are handed back untouched — the display transform is the identity on the stored unit', (t) => {
  reading(t, KG);
  assert.equal(inDisplayUnit(102.5), 102.5);
  assert.equal(inDisplayUnit(0), 0);
  assert.equal(inDisplayUnit(-20), -20);
  assert.equal(inDisplayUnit(1.25), 1.25);
  assert.equal(inDisplayUnit(0.01), 0.01);
});

test('pounds are a reading of the kilogram, landing on a tenth', (t) => {
  reading(t, LB);
  assert.equal(weightUnit(), LB);
  assert.equal(inDisplayUnit(100), 220.5);
  assert.equal(inDisplayUnit(102.5), 226);
  assert.equal(inDisplayUnit(20), 44.1);
  assert.equal(inDisplayUnit(2.5), 5.5);
  assert.equal(inDisplayUnit(1.25), 2.8);
  assert.equal(inDisplayUnit(0), 0);
});

// The bands the ladder is a mirror about are the same bands a reading has to be a mirror about: an
// assisted pull-up sits below zero, and a rounding that is half-UP would send −2.475 kg one way and
// +2.475 kg the other.
test('a band-assisted load reads as the mirror of its own magnitude', (t) => {
  reading(t, LB);
  for (const kg of [20, 102.5, 2.5, 0.05, 47.5]) {
    assert.equal(inDisplayUnit(-kg), -inDisplayUnit(kg), `${kg} kg`);
  }
});

test('a unit this build has never heard of reads as kilograms rather than throwing', (t) => {
  reading(t, 'stone');
  assert.equal(weightUnit(), KG);
  assert.equal(inDisplayUnit(102.5), 102.5);
});

// THE RATIO LIVES ONCE. A second copy is how two screens end up disagreeing about the same bar —
// and the one that would be written by hand is a rounded 2.20462, which is a different bar again.
test('the pound is defined in exactly one file in this product', () => {
  const carriers = sourceFiles(GYM)
    .filter((file) => /0\.45359237|2\.204\d*|2\.2046/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(GYM, file));
  assert.deepEqual(carriers, ['units.js']);
});

// THE CONVERSION MAY NOT REACH A WRITE, and this is what says so. `inDisplayUnit` is the only
// function here that changes a number, and exactly one module calls it: the one that spells a weight
// on a screen. Every module that BUILDS a body for the log is named below, and none of them may
// import this file at all — not the wire, not the backfill, not the correction, not the routine
// write, and not the keypad that parses what a lifter typed.
test('only the spelling calls the conversion, and no module that writes to the log imports it', () => {
  const callers = sourceFiles(GYM)
    .filter((file) => /\binDisplayUnit\b/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(GYM, file))
    .sort();
  assert.deepEqual(callers, ['log.js', 'units.js']);

  const writers = ['gymApi.js', 'backfill.js', 'fix.js', 'routines.js', 'logger/entry.js', 'mint.js'];
  const reaching = writers.filter((file) => /from '\.\.?\/?[a-z/]*units\.js'/.test(read(file)));
  assert.deepEqual(reaching, []);
});

// A FIELD IS NOT A READING. Each of these five modules puts a number in front of a lifter that they
// then type over, and what they type lands in the log exactly as it stands — so each spells the
// KILOGRAM and prints `kg` beside it. One of them reaching for the converted spelling would draw a
// pound over a keypad that reads kilograms, which is the one way a display setting could reach a
// stored weight on this surface.
test('every field a lifter types into spells the kilogram, not the reading', () => {
  const fields = ['Backfill.jsx', 'backfill.js', 'FixSheet.jsx', 'Routines.jsx', 'logger/entry.js'];
  const wrong = fields.filter((file) => !/\bfmtKg\b/.test(read(file)) || /\bfmt\(/.test(read(file)));
  assert.deepEqual(wrong, []);
});

// AND IT SAYS SO ON ITS FACE. A bare numeral on this surface is spelled in the account's reading —
// that is the whole convention — so a bare one on a KILOGRAM field is read as pounds by the lifter
// who chose pounds, and then typed over as pounds. The backfill's line was exactly that: the one
// field of the four with no unit word anywhere on its screen.
test('every kilogram field on a screen carries the word kg', () => {
  assert.equal(/\$\{fmtKg\(line\.weightKg\)\} kg`/.test(read('Backfill.jsx')), true);
  assert.equal(read('FixSheet.jsx').includes('<span className="gym-fix-unit">kg</span>'), true);
  assert.equal(/\$\{fmtKg\(draft\.targetWeightKg\)\} kg`/.test(read('Routines.jsx')), true);
  assert.equal(/WEIGHT_HINT = 'kg\b/.test(read('logger/entry.js')), true);
});

// AND WHERE A FIELD STANDS OVER ITS OWN CONVERTED READING, ONE LINE RECONCILES THEM. Both sheets
// draw over a list that prints the same weight in the account's unit — the target sheet over the
// routine's rows, the correction sheet over the session's — so in pounds the screen holds two
// numerals for one weight. Nothing else needs the line: a form with no list behind it (the backfill)
// says `kg` and is done.
test('the two sheets that stand over a converted reading say what the other numeral is', () => {
  for (const file of ['FixSheet.jsx', 'Routines.jsx']) {
    assert.equal(read(file).includes('alsoReadsLabel('), true, file);
  }
  assert.equal(read('Backfill.jsx').includes('alsoReadsLabel'), false);
});

// THE PAGE WITH NO ACCOUNT BEHIND IT SPELLS KILOGRAMS, AND SETS THAT ITSELF. The spelling is module
// state, and the coach's page is answered before either surface that reads an account has run
// (GymApp.jsx) — so in a tab whose log was open in pounds it printed the shared workout in pounds
// too, with no unit word on the page to tell the coach's reading from the owner's. The call is in
// the RENDER on purpose: `fmt` reads the spelling while those numbers are being built, and an effect
// runs after the paint that already printed them and would redraw nothing.
test('the coach’s shared page spells kilograms itself, in the render that prints the numbers', () => {
  const source = read('share/SharedSession.jsx');
  const set = source.indexOf('spellWeightsIn(KG);');
  assert.equal(set > 0, true);
  assert.equal(set < source.indexOf('view.phase'), true);
  assert.equal(source.includes('useEffect'), false);
  // And it is the only reading this page can be in: nothing here sets any other spelling.
  assert.equal((source.match(/spellWeightsIn\(/g) ?? []).length, 1);
});

// And the other direction: what the store holds is named in the file that does the converting, so
// nobody reading it has to go looking for the rule.
test('the transform says out loud that the store holds kilograms and only kilograms', () => {
  const source = read('units.js');
  assert.equal(source.includes('The store holds kilograms and only kilograms'), true);
  assert.equal(source.includes('it is never on the way to a write'), true);
});
