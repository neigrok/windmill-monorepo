// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { Fields, Id } from '../../../../src/platform/domain-kit/entities.js';
import { LocalDay } from '../../../../src/platform/domain-kit/time.js';
import { jcs } from '../../../../src/platform/sync/core/jcs.js';
import { Bodyweight, DeleteWeighIn, SaveWeighIn, WeighIn, WeighInValue } from '../../../../src/products/gym/domain/bodyweight.js';
import { GymRefusals, GymRules, refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { Preferences, PreferencesValue, SavePreferences, restSettings } from '../../../../src/products/gym/domain/preferences.js';
import { ProductCorpus } from '../../../platform/domain-kit/productCorpus.js';
import { RegistryCheck, RuleBookCheck, RuleBookParity } from '../../../platform/domain-kit/checks.js';
import { Contract, savedForm, withRecordsReversed } from '../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../platform/domain-kit/vectors.js').Vector} Vector */
/** @typedef {import('../../../../src/platform/domain-kit/values.js').Json} Json */

const book = GymRules.book;
const corpus = new ProductCorpus(book, GymRules.spec);
const rulesFile = 'gym/domain/rules.json';
const valuesFile = 'gym/domain/values.json';
const pending = [
  'gym/domain/notes-actions.json',
  'gym/domain/catalogue-actions.json',
  'gym/domain/routines-actions.json',
  'gym/domain/proposals-actions.json',
  'gym/domain/training-reads.json',
  'gym/domain/training-actions.json',
  'gym/domain/units.json',
  'gym-ladder.json',
];

/** @param {{ day: LocalDay, kg: number }} value */
const entryForm = (value) => ({ day: value.day.text, kg: value.kg });

/** @param {Bodyweight} value @param {any} input @returns {Json} */
function bodyweightForm(value, input) {
  /** @param {'recent' | 'all'} window */
  const chart = (window) => {
    const drawn = value.chart(window);
    return { dots: drawn.dots.map(entryForm), gaps: drawn.gaps.map((gap) => ({ after: gap.after.text, before: gap.before.text })) };
  };
  return {
    stance: value.stance, today: value.today.text,
    reading: value.reading === null ? null : { entry: entryForm(value.reading.entry), daysAgo: value.reading.daysAgo },
    recent: chart('recent'), all: chart('all'),
    list: value.list(input?.from ? LocalDay.parse(input.from) : null, input?.to ? LocalDay.parse(input.to) : null).map(entryForm),
  };
}

/** @type {Record<string, (vector: Vector) => unknown>} */
const handlers = {
  [valuesFile]: (vector) => corpus.value(vector),
  'gym/domain/bodyweight-actions.json': (vector) => {
    const input = vector.input.input;
    const id = new Id(input.day, WeighIn);
    if (vector.input.action === 'DeleteWeighIn') return corpus.decision(DeleteWeighIn(id), vector, () => null, refusalForm);
    assert.equal(vector.input.action, 'SaveWeighIn', 'unclaimed bodyweight action');
    return corpus.save(SaveWeighIn, vector, new WeighInValue(id),
      (value) => new WeighInValue(value.id, input.kg ?? null, value.recordedAt),
      (saved) => ({ id: id.json, fields: { ...saved.values } }), refusalForm);
  },
  'gym/domain/preferences-actions.json': (vector) => {
    const id = new Id('prefs', Preferences);
    if (vector.input.action) {
      assert.equal(vector.input.action, 'SavePreferences', 'unclaimed preference action');
      const value = vector.input.input.preferences;
      return corpus.save(SavePreferences, vector, new PreferencesValue(id),
        () => Preferences.decode(Fields.values('prefs', value.id, value.fields)), savedForm, refusalForm);
    }
    return corpus.read(vector, Preferences.scope, (read) => {
      if (vector.input.read === 'RestSettings') return restSettings(read);
      assert.equal(vector.input.read, 'Preferences', 'unclaimed preference read');
      const value = read.repository(Preferences).find(id, 'drawn') ?? new PreferencesValue(id);
      return { id: value.id.json, fields: value.fields() };
    });
  },
  'gym/rules/bodyweight.json': (vector) => corpus.read(vector, WeighIn.scope, (read) => {
    assert.equal(vector.input.read, 'Bodyweight', 'unclaimed bodyweight read');
    return bodyweightForm(new Bodyweight(read), vector.input.input);
  }),
};

test('the gym corpus is closed: each file is claimed or explicitly pending', (t) => {
  const claimed = [rulesFile, ...Object.keys(handlers)].sort();
  const files = [...Contract.files('gym'), 'gym-ladder.json'].sort();
  assert.equal(new Set([...claimed, ...pending]).size, claimed.length + pending.length, 'a file is claimed twice or still pending');
  assert.deepEqual([...claimed, ...pending].sort(), files);
  assert.ok(pending.length <= 8, 'the W1 pending set can only shrink');
  for (const path of [rulesFile, valuesFile, 'gym/domain/bodyweight-actions.json', 'gym/domain/preferences-actions.json', 'gym/rules/bodyweight.json']) assert.ok(claimed.includes(path), `W1 claim regressed: ${path}`);
  const count = Object.keys(handlers).reduce((total, path) => total + Contract.vectors(path).length, 0);
  t.diagnostic(`gym corpus: ${claimed.length}/${files.length} files, ${count} vectors, ${pending.length} pending files`);
});

test('the complete nine-entity gym rule book equals the pinned bytes', () => RuleBookParity.check(book, rulesFile));

test('every gym LOCAL rule is exercised and every server code maps on both paths', () => {
  RuleBookCheck.check(book, GymRefusals, valuesFile, Contract.files('gym/domain').filter((path) => path.endsWith('-actions.json')));
});

test('every book entity agrees with the registry and every writable sample round trips', () => {
  const values = Contract.vectors(valuesFile);
  for (const type of book.entities) {
    if (!type.isWritable) { RegistryCheck.entity(type, null, book); continue; }
    const sample = values.find((vector) => vector.input.entity === type.type);
    assert.ok(sample, `${type.type} has no entity sample`);
    RegistryCheck.entity(type, type.decode(Fields.values(type.type, sample.input.id, sample.input.fields)), book);
  }
});

for (const [file, run] of Object.entries(handlers)) for (const vector of Contract.vectors(file)) {
  test(`${file} · ${vector.name}`, () => {
    assert.equal(jcs(run(vector)), jcs(vector.expect));
    assert.equal(jcs(run({ ...vector, input: withRecordsReversed(vector.input) })), jcs(vector.expect), 'reversed records');
  });
}
