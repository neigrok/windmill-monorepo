// @ts-check

import { SaveDraft } from '../../../platform/domain-kit/drafts.js';
import { EntityType, Id } from '../../../platform/domain-kit/entities.js';
import { Remove } from '../../../platform/domain-kit/standardActions.js';
import { LocalDay } from '../../../platform/domain-kit/time.js';
import { Check } from '../../../platform/domain-kit/validation.js';
import { NumberSpec, Path, Violation } from '../../../platform/domain-kit/values.js';
import { GymRefusals } from './gymRules.js';

export const WeighInRules = Object.freeze({
  kg: new NumberSpec('weighin.kg', { min: 20, max: 400, quantum: 0.01 }),
  day: 'weighin.day',
  /** @param {import('../../../platform/domain-kit/time.js').Moment} moment */
  latestDay: (moment) => moment.today,
});

export class WeighInValue {
  /**
   * @param {Id<WeighInValue>} id
   * @param {number | null} kg
   * @param {import('../../../platform/domain-kit/time.js').Instant | null} recordedAt
   */
  constructor(id, kg = null, recordedAt = null) {
    this.id = id;
    this.kg = kg;
    this.recordedAt = recordedAt;
    Object.freeze(this);
  }

  get day() { return this.id.day; }

  fields() {
    return { kg: this.kg, recordedAt: this.recordedAt?.ms ?? null };
  }
}

/** @type {EntityType<WeighInValue>} */
export const WeighIn = new EntityType({
  type: 'weighin', scope: 'self/gym', savesGuarded: false, heldRemoval: true, timestampField: 'recordedAt',
  decode: (f) => new WeighInValue(new Id(f.id, WeighIn), f.optionalDouble('kg'), f.optionalInstant('recordedAt')),
  checks: [
    Check.key((value, moment) => {
      const day = value.day;
      if (day === null) throw new Violation(WeighInRules.day, new Path('id'), { kind: 'custom', custom: 'notADay' });
      if (LocalDay.compare(day, WeighInRules.latestDay(moment)) > 0) {
        throw new Violation(WeighInRules.day, new Path('id'), { kind: 'custom', custom: 'future' });
      }
    }),
    new Check('kg', (value) => {
      if (value.kg === null) throw new Violation(WeighInRules.kg.path, new Path('kg'), { kind: 'notANumber' });
      return new WeighInValue(value.id, WeighInRules.kg.apply(value.kg, new Path('kg')), value.recordedAt);
    }),
  ],
});

/** @param {import('../../../platform/domain-kit/drafts.js').Draft<WeighInValue>} draft */
export function SaveWeighIn(draft) { return SaveDraft.ofDraft(draft, GymRefusals); }

/** @param {Id<WeighInValue>} id */
export function DeleteWeighIn(id) { return new Remove(id, GymRefusals); }

/** @typedef {{ day: LocalDay, kg: number }} BodyweightEntry */

export class Bodyweight {
  static gapDays = 7;
  static recentDays = 90;

  /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
  constructor(read) {
    const weighIns = read.repository(WeighIn);
    this.stance = weighIns.all('stored').length > 0 ? 'holding' : read.firstPullComplete() ? 'empty' : 'unknown';
    this.today = read.moment.today;
    this.entries = Object.freeze(weighIns.all('drawn').flatMap((value) => {
      const day = value.day;
      if (day === null || value.kg === null || LocalDay.compare(day, this.today) > 0) return [];
      return [Object.freeze({ day, kg: value.kg })];
    }).sort((a, b) => LocalDay.compare(a.day, b.day)));
    Object.freeze(this);
  }

  get reading() {
    const entry = this.entries.at(-1);
    return entry ? Object.freeze({ entry, daysAgo: entry.day.daysUntil(this.today) }) : null;
  }

  /** @param {LocalDay} day */
  entry(day) { return this.entries.find((entry) => LocalDay.compare(entry.day, day) === 0) ?? null; }

  /**
   * @param {LocalDay | null} from
   * @param {LocalDay | null} to
   */
  list(from = null, to = null) {
    return Object.freeze(this.entries.filter((entry) =>
      (from === null || LocalDay.compare(entry.day, from) >= 0) && (to === null || LocalDay.compare(entry.day, to) <= 0)));
  }

  /** @param {'recent' | 'all'} range */
  chart(range) {
    const dots = range === 'recent' ? this.list(this.today.adding(1 - Bodyweight.recentDays)) : this.entries;
    const gaps = dots.flatMap((entry, index) => {
      const before = dots[index + 1];
      return before && entry.day.daysUntil(before.day) > Bodyweight.gapDays
        ? [Object.freeze({ after: entry.day, before: before.day })] : [];
    });
    return Object.freeze({ 'window': range, dots, gaps: Object.freeze(gaps) });
  }
}
