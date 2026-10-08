// @ts-check

import { DecodeError, Fields, Id } from '../../../platform/domain-kit/entities.js';
import { Session, TrainingSet } from './training.js';

/** @typedef {import('../../../platform/domain-kit/values.js').Json} Json */
/** @typedef {import('./training.js').SessionValue} SessionValue */
/** @typedef {import('./training.js').TrainingSetValue} TrainingSetValue */

export class SignedOutWorkout {
  static key = 'rack:adoption';

  /** @param {SessionValue} session @param {readonly TrainingSetValue[]} sets */
  constructor(session, sets) {
    this.session = session;
    this.sets = Object.freeze(sets.filter((set) => set.sessionId.equals(session.id))
      .sort((a, b) => a.completedAt.ms - b.completedAt.ms || Id.compare(a.id, b.id)));
    Object.freeze(this);
  }

  /** @param {Json} value */
  static decode(value) {
    const fields = Fields.object(value);
    const rawSession = fields.json('session');
    if (rawSession === undefined) throw new DecodeError(Session.type, 'adoption', 'missing session');
    const sessionFields = Fields.object(rawSession);
    const id = sessionFields.ref('id', Session);
    const rows = fields.json('sets');
    if (!Array.isArray(rows)) throw new DecodeError(Session.type, 'adoption', 'invalid saved workout');
    const session = Session.decode(Fields.values(Session.type, id.record, sessionFields.values));
    const sets = rows.map((row) => {
      const setFields = Fields.object(row);
      const setId = setFields.ref('id', TrainingSet);
      return TrainingSet.decode(Fields.values(TrainingSet.type, setId.record, setFields.values));
    });
    return new SignedOutWorkout(session, sets);
  }

  get json() {
    return { session: { ...this.session.fields(), id: this.session.id.json },
      sets: this.sets.map((set) => ({ ...set.fields(), id: set.id.json })) };
  }

  /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
  static read(read) {
    const rows = read.device(SignedOutWorkout.key);
    if (rows === null || typeof rows !== 'object' || Array.isArray(rows)) return Object.freeze([]);
    return Object.freeze(Object.values(rows).map(SignedOutWorkout.decode).sort((a, b) => Id.compare(a.session.id, b.session.id)));
  }
}
