// @ts-check

import { Decision } from '../../../platform/domain-kit/actions.js';
import { DecodeError, Fields, Id } from '../../../platform/domain-kit/entities.js';
import { Plan } from '../../../platform/domain-kit/plans.js';
import { Refused } from '../../../platform/domain-kit/refusals.js';
import { Valid } from '../../../platform/domain-kit/validation.js';
import { Path, Violation } from '../../../platform/domain-kit/values.js';
import { hashText } from '../../../../../packages/api-contract/sync/reference/core/encoding.js';
import { jcsBytes } from '../../../../../packages/api-contract/sync/reference/core/jcs.js';
import { sha256 } from '../../../../../packages/api-contract/sync/reference/core/sha256.js';
import { Catalogue, Exercise } from './catalogue.js';
import { GymRefusals } from './gymRules.js';
import { Routine, RoutineValue, SetTarget, createRoutineMovement } from './routines.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('../../../platform/domain-kit/reading.js').Reader} Reader */
/** @typedef {import('../../../platform/domain-kit/time.js').Moment} Moment */
/** @typedef {import('./catalogue.js').ExerciseValue} ExerciseValue */
/** @typedef {import('./routines.js').RoutineEntry} RoutineEntry */

const receiptPrefix = 'rack:coachImport';
const lowerHex = /^[0-9a-f]+$/;

/** @param {string} custom @param {string} at */
const refused = (custom, at) => new Violation('coach.import', new Path(at), { kind: 'custom', custom });

// One routine of a first-run conversation's result, under the id its turn gave it.
export class CoachRoutineImport {
  /** @param {Id<RoutineValue>} id @param {string} name @param {readonly RoutineEntry[]} entries */
  constructor(id, name, entries) {
    this.id = id;
    this.name = name;
    this.entries = Object.freeze([...entries]);
    Object.freeze(this);
  }
}

// What a result imported, kept under its receipt key: a replay of the same result answers it and writes nothing.
export class CoachImportReceipt {
  /** @param {string} resultId @param {string} fingerprint @param {readonly Id<RoutineValue>[]} routines @param {readonly Id<ExerciseValue>[]} movements */
  constructor(resultId, fingerprint, routines, movements) {
    this.resultId = resultId;
    this.fingerprint = fingerprint;
    this.routines = Object.freeze([...routines]);
    this.movements = Object.freeze([...movements]);
    Object.freeze(this);
  }

  /** @param {Json} value */
  static decode(value) {
    const f = Fields.object(value);
    /** @param {string} name @returns {string[]} */
    const ids = (name) => {
      const listed = f.json(name);
      if (!Array.isArray(listed) || !listed.every((id) => typeof id === 'string')) throw new DecodeError(Routine.type, name, 'not a list of ids');
      return /** @type {string[]} */ (listed);
    };
    return new CoachImportReceipt(f.string('resultId'), f.string('fingerprint'), ids('routines').map((id) => new Id(id, Routine)),
      ids('movements').map((id) => new Id(id, Exercise)));
  }

  get json() {
    return { resultId: this.resultId, fingerprint: this.fingerprint, routines: this.routines.map((id) => id.json), movements: this.movements.map((id) => id.json) };
  }
}

// A first-run conversation's result, its routines and the movements they need, imported as one gesture with its receipt,
// on the replica the conversation was had on: all of it or nothing, and once.
/**
 * @param {{ replica: string, resultId: string, fingerprint: string, receiptKey: string, routines: readonly CoachRoutineImport[],
 *   movements?: readonly ExerciseValue[] }} input
 */
export function ImportCoachRoutineBatch({ replica, resultId, fingerprint, receiptKey, routines, movements = [] }) {
  return Object.freeze({
    scope: Routine.scope,
    refusals: GymRefusals,
    fingerprint,
    receiptKey,
    routines,
    /** @param {Reader} read */
    load(read) {
      const saved = ImportCoachRoutineBatch.validReceiptKey(receiptKey) ? read.device(receiptKey) : null;
      return { replica: read.replica, receipt: saved === null ? null : CoachImportReceipt.decode(saved),
        routines: read.repository(Routine).all('stored'), catalogue: new Catalogue(read, 'stored'),
        visible: new Catalogue(read).exercises.map((exercise) => exercise.id), moment: read.moment };
    },
    /**
     * @param {{ replica: string, receipt: CoachImportReceipt | null, routines: readonly RoutineValue[], catalogue: Catalogue,
     *   visible: readonly Id<ExerciseValue>[], moment: Moment }} loaded
     */
    decide(loaded) {
      if (loaded.replica !== replica) throw refused('seatChanged', 'replica');
      if (resultId.length < 1 || resultId.length > 128 || [...resultId].some((character) => character < '!' || character > '~')
        || fingerprint.length !== 64 || !lowerHex.test(fingerprint)) throw refused('invalidResult', 'resultId');
      if (!ImportCoachRoutineBatch.validReceiptKey(receiptKey)) throw refused('invalidReceiptKey', 'receiptKey');
      if (loaded.receipt !== null) {
        if (loaded.receipt.resultId !== resultId || loaded.receipt.fingerprint !== fingerprint) throw refused('payloadConflict', 'resultId');
        return Decision.unchanged(loaded.receipt);
      }
      if (routines.length < 1 || routines.length > 3
        || routines.some((routine) => routine.entries.length < 1 || routine.entries.length > 6 || routine.entries.some((entry) => (entry.sets?.length ?? 0) > 8))) {
        throw refused('invalidCount', 'routines');
      }
      /** @param {readonly { id: Id<any> }[]} values */
      const distinct = (values) => values.every((value, at) => !values.slice(0, at).some((before) => before.id.equals(value.id)));
      if (!distinct(routines) || !distinct(movements)) throw refused('duplicateIdentity', 'routines');
      if (movements.some((movement) => !routines.some((routine) => routine.entries.some((entry) => entry.exerciseId.equals(movement.id))))) {
        throw refused('unusedMovement', 'movements');
      }
      const plan = new Plan();
      for (const movement of [...movements].sort((a, b) => Id.compare(a.id, b.id))) {
        if (loaded.catalogue.find(movement.id) !== null) return Decision.refuse(GymRefusals.ofRefused(new Refused('id-taken', movement.id.ref, null, 'predicted')));
        createRoutineMovement(plan, new Valid(movement, loaded.moment), loaded.moment);
      }
      /** @param {Id<ExerciseValue>} id */
      const movementOf = (id) => movements.find((movement) => movement.id.equals(id)) ?? loaded.catalogue.find(id);
      const first = loaded.routines.reduce((last, routine) => Math.max(last, routine.position), -1) + 1;
      for (const [index, routine] of routines.entries()) {
        if (loaded.routines.some((stored) => stored.id.equals(routine.id))) {
          return Decision.refuse(GymRefusals.ofRefused(new Refused('id-taken', routine.id.ref, null, 'predicted')));
        }
        if (routine.entries.some((entry) => !loaded.visible.some((id) => id.equals(entry.exerciseId)) && !movements.some((movement) => movement.id.equals(entry.exerciseId)))) {
          return Decision.refuse(GymRefusals.ofRefused(new Refused('unknown-exercise', routine.id.ref, null, 'predicted')));
        }
        routine.entries.forEach((entry, line) => {
          const movement = movementOf(entry.exerciseId);
          if (movement !== null) SetTarget.floored(entry.sets ?? [], movement, new Path('routines').plus(index).plus('entries').plus(line).plus('sets'));
        });
        const position = first + index;
        if (position > 2_147_483_647) throw refused('positionExhausted', 'routines');
        plan.create(new Valid(new RoutineValue(routine.id, routine.name, position, routine.entries), loaded.moment));
      }
      const receipt = new CoachImportReceipt(resultId, fingerprint, routines.map((routine) => routine.id), movements.map((movement) => movement.id));
      plan.device(receiptKey, receipt.json);
      return Decision.write(plan, receipt);
    },
  });
}

// A result's drafts normalized by their checks: the fingerprint hashes that payload, the receipt key the result id.
/**
 * @param {{ replica: string, resultId: string, drafts: readonly CoachRoutineImport[], movements?: readonly ExerciseValue[], moment: Moment }} input
 */
ImportCoachRoutineBatch.of = ({ replica, resultId, drafts, movements = [], moment }) => {
  const routines = drafts.map((draft) => {
    const checked = new Valid(new RoutineValue(draft.id, draft.name, 0, draft.entries), moment).value;
    return new CoachRoutineImport(draft.id, checked.name, checked.entries);
  });
  const checked = movements.map((movement) => new Valid(movement, moment).value);
  const payload = { routines: routines.map((routine) => ({ name: routine.name, entries: routine.entries.map((entry) => entry.json) })),
    movements: [...checked].sort((a, b) => Id.compare(a.id, b.id)).map((movement) => ({ id: movement.id.json, fields: movement.fields(), loadCount: movement.loadCount })) };
  return ImportCoachRoutineBatch({ replica, resultId, fingerprint: sha256(jcsBytes(payload)), receiptKey: ImportCoachRoutineBatch.receiptKey(resultId),
    routines, movements: checked });
};

/** @param {string} resultId */
ImportCoachRoutineBatch.receiptKey = (resultId) => receiptPrefix + hashText(resultId).slice(0, 48);

/** @param {string} value */
ImportCoachRoutineBatch.validReceiptKey = (value) => value.startsWith(receiptPrefix) && value.length === receiptPrefix.length + 48
  && lowerHex.test(value.slice(receiptPrefix.length));
