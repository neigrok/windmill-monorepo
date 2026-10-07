// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import { SaveDraft } from '../../../../src/platform/domain-kit/drafts.js';
import { DecodeError, Fields, Id } from '../../../../src/platform/domain-kit/entities.js';
import { LocalDay } from '../../../../src/platform/domain-kit/time.js';
import { Valid } from '../../../../src/platform/domain-kit/validation.js';
import { Violation } from '../../../../src/platform/domain-kit/values.js';
import { jcs } from '../../../../src/platform/sync/core/jcs.js';
import { Bodyweight, DeleteWeighIn, SaveWeighIn, WeighIn, WeighInValue } from '../../../../src/products/gym/domain/bodyweight.js';
import { Catalogue, CreateExercise, Exercise, RenameExercise, defaultStepKg, renamedAliases } from '../../../../src/products/gym/domain/catalogue.js';
import { GymRefusals, GymRules, refusalForm } from '../../../../src/products/gym/domain/gymRules.js';
import { MoveNote, Note, SaveNoteCall } from '../../../../src/products/gym/domain/notes.js';
import { Preferences, PreferencesValue, SavePreferences, restSettings } from '../../../../src/products/gym/domain/preferences.js';
import { ApplyProposal, DismissProposal, Proposal, ProposalState, ProposeRoutine, RoutineCreation, changesBetween } from '../../../../src/products/gym/domain/proposals.js';
import { DeleteRoutine, PlanSnapshot, ReorderRoutines, Routine, RoutineEntry, RoutineValue, SaveRoutine } from '../../../../src/products/gym/domain/routines.js';
import { SeedExercises } from '../../../../src/products/gym/domain/seedExercises.js';
import { ProductCorpus } from '../../../platform/domain-kit/productCorpus.js';
import { RegistryCheck, RuleBookCheck, RuleBookParity } from '../../../platform/domain-kit/checks.js';
import { Contract, momentOf, savedForm, withRecordsReversed } from '../../../platform/domain-kit/vectors.js';

/** @typedef {import('../../../platform/domain-kit/vectors.js').Vector} Vector */
/** @typedef {import('../../../../src/platform/domain-kit/values.js').Json} Json */

const book = GymRules.book;
const corpus = new ProductCorpus(book, GymRules.spec);
const rulesFile = 'gym/domain/rules.json';
const valuesFile = 'gym/domain/values.json';
const pending = [
  'gym/domain/training-reads.json',
  'gym/domain/training-actions.json',
  'gym/domain/units.json',
  'gym-ladder.json',
];

/** @param {{ day: LocalDay, kg: number }} value */
const entryForm = (value) => ({ day: value.day.text, kg: value.kg });

/** @param {import('../../../../src/products/gym/domain/catalogue.js').ExerciseValue} value */
const exerciseForm = (value) => ({ id: value.id.json, fields: value.fields(), aliases: [...value.aliases] });

/** @param {() => Json} body @returns {Json} */
function decoded(body) {
  try { return body(); }
  catch (error) {
    if (error instanceof DecodeError) return { decodeError: { type: error.type, field: error.field, reason: error.reason } };
    throw error;
  }
}

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
  'gym/domain/notes-actions.json': (vector) => {
    const input = vector.input.input;
    if (vector.input.action === 'MoveNote') {
      const below = input.below === null ? null : new Id(input.below, Note);
      return corpus.decision(MoveNote(new Id(input.id, Note), below), vector, () => null, refusalForm);
    }
    assert.equal(vector.input.action, 'SaveNoteCall', 'unclaimed notes action');
    const value = input.note;
    return corpus.decision(new SaveNoteCall(Note.decode(Fields.values('note', value.id, value.fields))), vector, (id) => id.json, refusalForm);
  },
  'gym/domain/catalogue-actions.json': (vector) => {
    const input = vector.input.input;
    if (vector.input.action === 'CreateExercise') {
      const value = input.exercise;
      return corpus.decision(new CreateExercise(Exercise.decode(Fields.values('exercise', value.id, value.fields))), vector,
        (id) => id.json, refusalForm);
    }
    if (vector.input.action === 'RenameExercise') {
      return corpus.decision(new RenameExercise(new Id(input.id, Exercise), input.name), vector, () => null, refusalForm);
    }
    assert.equal(vector.input.action, undefined, 'unclaimed catalogue action');
    return decoded(() => corpus.read(vector, Exercise.scope, (read) => {
      switch (vector.input.read) {
        case 'SeedExercises': return SeedExercises.all.map(exerciseForm);
        case 'Catalogue': {
          const catalogue = new Catalogue(read);
          const found = input.id === undefined ? null : catalogue.find(new Id(input.id, Exercise));
          return (input.id === undefined ? catalogue.search(input.query ?? '') : found ? [found] : []).map(exerciseForm);
        }
        case 'RenamedAliases': return [...renamedAliases(input.previous, input.next, input.aliases)];
        case 'DefaultStepKg': return Object.fromEntries(['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell']
          .map((equipment) => [equipment, defaultStepKg(equipment)]));
        default: throw new Error(`unclaimed catalogue read ${vector.input.read}`);
      }
    }));
  },
  'gym/domain/routines-actions.json': (vector) => {
    const input = vector.input.input;
    if (vector.input.action === 'SaveRoutine' || vector.input.action === 'CreateRoutine') {
      const value = Routine.decode(Fields.values('routine', input.routine.id, input.routine.fields));
      return vector.input.action === 'CreateRoutine'
        ? corpus.decision(SaveDraft.creating(value, GymRefusals), vector, savedForm, refusalForm)
        : corpus.save(SaveRoutine, vector, new RoutineValue(value.id), () => value, savedForm, refusalForm);
    }
    if (vector.input.action === 'ReorderRoutines') return corpus.decision(ReorderRoutines(input.order.map((/** @type {string} */ id) => new Id(id, Routine))), vector, () => null, refusalForm);
    if (vector.input.action === 'DeleteRoutine') return corpus.decision(DeleteRoutine(new Id(input.id, Routine)), vector, () => null, refusalForm);
    assert.equal(vector.input.action, undefined, 'unclaimed routine action');
    return decoded(() => corpus.read(vector, Routine.scope, (read) => {
      switch (vector.input.read) {
        case 'Routines': return RoutineValue.ordered(read.repository(Routine).all('drawn'))
          .map((value) => ({ id: value.id.json, fields: value.fields() }));
        case 'RoutineMetadata': {
          const value = read.repository(Routine).find(new Id(input.id, Routine), 'drawn');
          assert.ok(value);
          return { revision: value.revision, createdEntries: value.createdEntries, createdDoor: value.createdDoor, fields: value.fields() };
        }
        case 'SessionPlan': return PlanSnapshot.decode(input.plan)?.json ?? null;
        default: throw new Error(`unclaimed routine read ${vector.input.read}`);
      }
    }));
  },
  'gym/domain/proposals-actions.json': (vector) => {
    const input = vector.input.input;
    const fields = Fields.object(input);
    switch (vector.input.action) {
      case 'ProposeRoutine': return corpus.decision(ProposeRoutine({ id: fields.ref('id', Proposal), routineId: fields.ref('routineId', Routine),
        name: fields.string('name', ''), entries: fields.list('entries', RoutineEntry.decode), summary: fields.string('summary', ''),
        removing: fields.bool('removing', false) }), vector, (id) => id.json, refusalForm);
      case 'ApplyProposal': return corpus.decision(ApplyProposal(fields.ref('id', Proposal)), vector, () => null, refusalForm);
      case 'DismissProposal': return corpus.decision(DismissProposal(fields.ref('id', Proposal)), vector, () => null, refusalForm);
      case 'Diff': return { changes: changesBetween(fields.list('base', RoutineEntry.decode), fields.list('proposed', RoutineEntry.decode)).map((change) => change.json) };
      case 'ChangeCount': {
        const proposal = Proposal.decode(Fields.values('proposal', input.proposal.id, input.proposal.fields));
        const base = Routine.decode(Fields.values('routine', input.base.id, input.base.fields));
        return { changeCount: proposal.countChanges(base) };
      }
      case 'Metadata': {
        const value = Proposal.decode(Fields.values('proposal', input.id, input.fields));
        return { baseRevision: value.baseRevision, baseName: value.baseName, changeCount: value.changeCount,
          state: value.state, provenance: value.provenance };
      }
      case 'RoutineCreation': return { snapshot: RoutineCreation.decode(Fields.values('routineCreation', input.id, input.fields)).snapshot };
      case 'StateRefusal': {
        const drawn = ['proposal', 'routine'].flatMap((type) => {
          const value = input[type];
          if (value === null || value === undefined) return [];
          return [{ t: type, id: value.id, life: ['alive', '1000:0:r_aaaaaaaaaaaa'], born: '1000:0:r_aaaaaaaaaaaa',
            f: Object.fromEntries(Object.entries(value.fields).map(([name, field]) => [name, [field, '1000:0:r_aaaaaaaaaaaa']])) }];
        });
        const read = corpus.reader({ ...vector, input: { ...vector.input, records: { drawn } } }, Proposal.scope);
        const id = new Id('proposal1', Proposal);
        const refused = new ProposalState(read, id).refusal(id, fields.bool('applying'));
        return { refusal: refused === null ? null : refusalForm(refused) };
      }
      case 'ValidateProposal': {
        try { return { fields: new Valid(Proposal.decode(Fields.values('proposal', input.id, input.fields)), momentOf(vector.input)).value.fields() }; }
        catch (error) {
          if (error instanceof Violation) return { violation: error.json };
          throw error;
        }
      }
      default: throw new Error(`unclaimed proposal action ${vector.input.action}`);
    }
  },
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
  assert.ok(pending.length <= 4, 'the W4 pending set can only shrink');
  for (const path of [rulesFile, valuesFile, 'gym/domain/bodyweight-actions.json', 'gym/domain/preferences-actions.json', 'gym/rules/bodyweight.json']) assert.ok(claimed.includes(path), `W1 claim regressed: ${path}`);
  assert.ok(claimed.includes('gym/domain/notes-actions.json'), 'W2 notes claim regressed');
  for (const path of ['gym/domain/catalogue-actions.json', 'gym/domain/routines-actions.json']) assert.ok(claimed.includes(path), `W3 claim regressed: ${path}`);
  assert.ok(claimed.includes('gym/domain/proposals-actions.json'), 'W4 proposals claim regressed');
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
