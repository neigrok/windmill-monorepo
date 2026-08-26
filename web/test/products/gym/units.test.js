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

// The spelling is module-level state: every test must leave it reading kilograms.
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

test('the pound is defined in exactly one file in this product', () => {
  const carriers = sourceFiles(GYM)
    .filter((file) => /0\.45359237|2\.204\d*|2\.2046/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(GYM, file));
  assert.deepEqual(carriers, ['units.js']);
});

test('only the spelling and the weigh-in call the conversion, and no module that writes a set imports it', () => {
  const callers = sourceFiles(GYM)
    .filter((file) => /\binDisplayUnit\b/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(GYM, file))
    .sort();
  assert.deepEqual(callers, ['bodyweight/bodyweight.js', 'log.js', 'units.js']);

  const writers = ['gymApi.js', 'backfill.js', 'fix.js', 'routines.js', 'logger/entry.js', 'mint.js'];
  const reaching = writers.filter((file) => /from '\.\.?\/?[a-z/]*units\.js'/.test(read(file)));
  assert.deepEqual(reaching, []);

  // The one field typed in the display unit: a weigh-in comes back to kilograms before the write.
  const back = sourceFiles(GYM)
    .filter((file) => /\bfromDisplayUnit\b/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(GYM, file))
    .sort();
  assert.deepEqual(back, ['bodyweight/bodyweight.js', 'units.js']);
});

test('every field a lifter types into spells the kilogram, not the reading', () => {
  const fields = ['Backfill.jsx', 'backfill.js', 'FixSheet.jsx', 'logger/entry.js'];
  const wrong = fields.filter((file) => !/\bfmtKg\b/.test(read(file)) || /\bfmt\(/.test(read(file)));
  assert.deepEqual(wrong, []);
  // The target sheet's field is text the lifter types over: it is spelled by String and by nothing
  // else, so no transform can reach it on the way in or out.
  assert.equal(/\bfmt\(|inDisplayUnit|fromDisplayUnit/.test(read('routines.js')), false);
  assert.equal(read('routines.js').includes("weight: entry.targetWeightKg == null ? '' : String(entry.targetWeightKg),"), true);
  assert.equal(/\bfmt\(/.test(read('Routines.jsx')), false);
});

test('every kilogram field on a screen carries the word kg', () => {
  assert.equal(/\$\{fmtKg\(line\.weightKg\)\} kg`/.test(read('Backfill.jsx')), true);
  assert.equal(read('FixSheet.jsx').includes('<span className="gym-fix-unit">kg</span>'), true);
  // The unit rides in the field beside the sign control, and neither is part of the field's name.
  assert.equal(read('Routines.jsx').includes('<span className="gym-target-unit">kg</span>'), true);
  assert.equal(/WEIGHT_HINT = 'kg\b/.test(read('logger/entry.js')), true);
});

test('the two sheets that stand over a converted reading say what the other numeral is', () => {
  for (const file of ['FixSheet.jsx', 'Routines.jsx']) {
    assert.equal(read(file).includes('alsoReadsLabel('), true, file);
  }
  assert.equal(read('Backfill.jsx').includes('alsoReadsLabel'), false);
});

test('the shared workout’s page spells kilograms itself, in the render that prints the numbers', () => {
  const source = read('share/SharedSession.jsx');
  const set = source.indexOf('spellWeightsIn(KG);');
  assert.equal(set > 0, true);
  assert.equal(set < source.indexOf('view.phase'), true);
  assert.equal(source.includes('useEffect'), false);
  assert.equal((source.match(/spellWeightsIn\(/g) ?? []).length, 1);
});

test('the transform says out loud that the store holds kilograms and only kilograms', () => {
  const source = read('units.js');
  assert.equal(source.includes('The store holds kilograms and only kilograms'), true);
  assert.equal(source.includes('the one field typed in the display unit is a weigh-in'), true);
});
