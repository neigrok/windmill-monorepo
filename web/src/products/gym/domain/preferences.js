// @ts-check

import { Decision, decision } from '../../../platform/domain-kit/actions.js';
import { Draft, SaveDraft } from '../../../platform/domain-kit/drafts.js';
import { EntityType, Fields, Id } from '../../../platform/domain-kit/entities.js';
import { Check } from '../../../platform/domain-kit/validation.js';
import { ChoiceSpec, Path } from '../../../platform/domain-kit/values.js';
import { GymRefusals } from './gymRules.js';

export const PreferencesRules = Object.freeze({ units: new ChoiceSpec('prefs.units', ['kg', 'lb']) });

export class PreferencesValue {
  /**
   * @param {Id<PreferencesValue>} id
   * @param {string} units
   * @param {boolean} confirmHaptic
   * @param {boolean} confirmSound
   */
  constructor(id = new Id('prefs', Preferences), units = 'kg', confirmHaptic = true, confirmSound = false) {
    this.id = id;
    this.units = units;
    this.confirmHaptic = confirmHaptic;
    this.confirmSound = confirmSound;
    Object.freeze(this);
  }

  fields() {
    return { units: this.units, confirmHaptic: this.confirmHaptic, confirmSound: this.confirmSound };
  }
}

/** @type {EntityType<PreferencesValue>} */
export const Preferences = new EntityType({
  type: 'prefs', scope: 'self/gym', savesGuarded: false,
  decode: (f) => new PreferencesValue(new Id(f.id, Preferences), f.string('units', 'kg'),
    f.bool('confirmHaptic', true), f.bool('confirmSound', false)),
  checks: [new Check('units', (value) => new PreferencesValue(value.id,
    PreferencesRules.units.apply(value.units, new Path('units')), value.confirmHaptic, value.confirmSound))],
});

/** @param {import('../../../platform/domain-kit/drafts.js').Draft<PreferencesValue>} draft */
export function SavePreferences(draft) { return SaveDraft.ofDraft(draft, GymRefusals); }

/**
 * @typedef {{ draft: Draft<PreferencesValue>, save: SaveDraft<PreferencesValue, import('./gymRules.js').GymRefusal>,
 *   loaded: import('../../../platform/domain-kit/drafts.js').SaveDraftLoaded<PreferencesValue> }} PreferenceChangeLoaded
 */

// A switch opens its draft in the commit, so two quick changes compare against the preceding save.
/** @param {{ units?: string, confirmHaptic?: boolean, confirmSound?: boolean }} patch */
export function ChangePreferences(patch) {
  const change = Object.freeze({ ...patch });
  return Object.freeze({
    scope: Preferences.scope,
    refusals: GymRefusals,
    /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
    load(read) {
      const id = new Id('prefs', Preferences);
      const current = read.repository(Preferences).find(id, 'drawn');
      const draft = (current === null ? Draft.new(new PreferencesValue(id)) : Draft.opening(current))
        .edit((value) => new PreferencesValue(value.id, change.units ?? value.units,
          change.confirmHaptic ?? value.confirmHaptic, change.confirmSound ?? value.confirmSound));
      const save = SavePreferences(draft);
      return { draft, save, loaded: save.load(read) };
    },
    /**
     * @param {PreferenceChangeLoaded} loaded
     * @param {import('../../../platform/domain-kit/actions.js').IDSource} ids
     */
    decide(loaded, ids) {
      const decided = decision(loaded.save, loaded.loaded, ids);
      if (decided.kind === 'refuse') return decided;
      const value = loaded.draft.take(decided.result).current;
      return decided.kind === 'write' ? Decision.write(decided.plan, value) : Decision.unchanged(value);
    },
  });
}

/** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
export function restSettings(read) {
  const record = read.repository(Preferences).record('prefs', 'drawn');
  if (!record) return Object.freeze({ seconds: null, sound: true });
  const fields = Fields.record(record);
  return Object.freeze({ seconds: fields.optionalInt('restSeconds'), sound: fields.bool('restSound', true) });
}
