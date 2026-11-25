// @ts-check

import { Decision, decision } from '../../../platform/domain-kit/actions.js';
import { Draft, SaveDraft } from '../../../platform/domain-kit/drafts.js';
import { EntityType, Id } from '../../../platform/domain-kit/entities.js';
import { Check } from '../../../platform/domain-kit/validation.js';
import { ChoiceSpec, NumberSpec, Path } from '../../../platform/domain-kit/values.js';
import { GymRefusals } from './gymRules.js';

export const PreferencesRules = Object.freeze({ units: new ChoiceSpec('prefs.units', ['kg', 'lb']) });

// The rest registers of the same record are the web's to set alone, so their rule stays out of the book the three surfaces
// pin (`rules.json`) until a phone sets them too.
export const RestSettingsRules = Object.freeze({ seconds: new NumberSpec('prefs.restSeconds', { min: 15, max: 900, integer: true }) });

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

/** @type {EntityType<PreferencesValue, string>} */
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

// The default rest and the rest sound, the `prefs` record's other two registers: `seconds` is the rest a movement on
// Default takes, null for Off, and `sound` whether the rest reaching its target sounds.
export class RestSettingsValue {
  /**
   * @param {Id<RestSettingsValue>} id
   * @param {number | null} seconds
   * @param {boolean} sound
   */
  constructor(id = new Id('prefs', RestSettings), seconds = null, sound = true) {
    this.id = id;
    this.seconds = seconds;
    this.sound = sound;
    Object.freeze(this);
  }

  fields() {
    return { restSeconds: this.seconds, restSound: this.sound };
  }
}

/** @type {EntityType<RestSettingsValue, string>} */
export const RestSettings = new EntityType({
  type: 'prefs', scope: 'self/gym', savesGuarded: false,
  decode: (f) => new RestSettingsValue(new Id(f.id, RestSettings), f.optionalInt('restSeconds'), f.bool('restSound', true)),
  checks: [new Check('restSeconds', (value) => new RestSettingsValue(value.id,
    RestSettingsRules.seconds.applyOptional(value.seconds, new Path('restSeconds')), value.sound))],
});

/** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
export function restSettings(read) {
  return read.repository(RestSettings).find(new Id('prefs', RestSettings), 'drawn') ?? new RestSettingsValue();
}

// Settings' change of either rest setting, opened in the commit as a switch's is: `restSeconds` null is Off, and a setting
// the change leaves out keeps what the record holds. It writes the settings it changed and nothing of the phones' three.
/** @param {{ restSeconds?: number | null, restSound?: boolean }} change */
export function SaveRestSettings(change) {
  const { restSeconds, restSound } = change;
  return Object.freeze({
    scope: RestSettings.scope,
    refusals: GymRefusals,
    /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
    load(read) {
      const id = new Id('prefs', RestSettings);
      const current = read.repository(RestSettings).find(id, 'drawn');
      const draft = (current === null ? Draft.new(new RestSettingsValue(id)) : Draft.opening(current))
        .edit((value) => new RestSettingsValue(value.id, restSeconds === undefined ? value.seconds : restSeconds, restSound ?? value.sound));
      const save = SaveDraft.ofDraft(draft, GymRefusals);
      return { save, loaded: save.load(read) };
    },
    /**
     * @param {{ save: SaveDraft<RestSettingsValue, import('./gymRules.js').GymRefusal>,
     *   loaded: import('../../../platform/domain-kit/drafts.js').SaveDraftLoaded<RestSettingsValue> }} loaded
     * @param {import('../../../platform/domain-kit/actions.js').IDSource} ids
     */
    decide(loaded, ids) { return decision(loaded.save, loaded.loaded, ids); },
  });
}
