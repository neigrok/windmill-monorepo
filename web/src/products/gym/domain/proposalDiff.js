// @ts-check

import { RoutineChange } from './proposals.js';
import { Readout } from './trainingReads.js';
import { GymUnits } from './units.js';

/** @typedef {import('../../../platform/domain-kit/entities.js').Id<import('./catalogue.js').ExerciseValue>} ExerciseId */
/** @typedef {import('./proposals.js').EntryTargets} EntryTargets */
/** @typedef {import('./proposals.js').ProposalValue} ProposalValue */
/** @typedef {import('./routines.js').RoutineValue} RoutineValue */
/** @typedef {import('./routines.js').SetTarget} SetTarget */
/** @typedef {'renamed' | 'moved' | 'changed' | 'removed' | 'added'} BlockKind */
/** @typedef {'changed' | 'same' | 'new' | 'gone'} FieldState */
/** @typedef {{ kind: BlockKind, exerciseId: ExerciseId | null, fields: readonly ProposalDiffField[] }} ProposalDiffBlock */

const blockOrder = Object.freeze(['renamed', 'moved', 'changed', 'removed', 'added']);

// One line of a block: *Load  82.5 kg → 90 kg*. A new line has no before, a gone line no after. Two sides that differ only in
// Unicode form read the same.
export class ProposalDiffField {
  /** @param {string} label @param {string | null} before @param {string | null} after */
  constructor(label, before, after) {
    this.label = label;
    this.before = before;
    this.after = after;
    Object.freeze(this);
  }

  /** @returns {FieldState} */
  get state() {
    if (this.before === null) return 'new';
    if (this.after === null) return 'gone';
    return this.before.normalize('NFC') === this.after.normalize('NFC') ? 'same' : 'changed';
  }
}

// A proposal as its card reads it: each change a block of field lines, in the card's order — a new name, movements that
// only moved, changed movements, removals, additions — and how many movements it leaves as they were. Moves are read
// against the routine while the proposal waits; once it settled, the routine no longer holds the order it replaced.
export class ProposalDiff {
  /** @param {ProposalValue} proposal @param {RoutineValue | null} routine @param {GymUnits} units @param {readonly ExerciseId[]} each */
  constructor(proposal, routine = null, units = GymUnits.kg, each = []) {
    const pending = proposal.state === 'pending';
    const moves = pending && routine !== null ? RoutineChange.moves(routine.entries, proposal.changes) : new Map();
    /** @type {ProposalDiffBlock[]} */
    const blocks = [];
    const name = proposal.baseName ?? (pending ? routine?.name ?? null : null);
    const rename = new ProposalDiffField('Name', name, proposal.proposedName);
    if (rename.state === 'changed') blocks.push(Object.freeze({ kind: 'renamed', exerciseId: null, fields: Object.freeze([rename]) }));
    let unchanged = 0;
    proposal.changes.forEach((change, index) => {
      const move = moves.get(index);
      const order = move ? [new ProposalDiffField('Order', ProposalDiff.ordinal(move.from), ProposalDiff.ordinal(move.to))] : [];
      const fields = ProposalDiff.fields(change.before, change.after, units, each.some((id) => id.equals(change.exerciseId)));
      /** @param {BlockKind} kind @param {readonly ProposalDiffField[]} lines */
      const block = (kind, lines) => blocks.push(Object.freeze({ kind, exerciseId: change.exerciseId, fields: Object.freeze(lines) }));
      if (change.kind === 'kept' && order.length === 0) unchanged += 1;
      else if (change.kind === 'kept') block('moved', order);
      else if (change.kind === 'retargeted') block('changed', [...order, ...fields]);
      else if (change.kind === 'removed') block('removed', fields);
      else block('added', fields);
    });
    const removing = proposal.intent === 'remove';
    this.blocks = Object.freeze(removing ? [] : blocks.sort((a, b) => blockOrder.indexOf(a.kind) - blockOrder.indexOf(b.kind)));
    this.unchanged = removing ? 0 : unchanged;
    Object.freeze(this);
  }

  // A movement's targets, before and after, as lines: *Sets*, *Reps* and *Load* while every set is the same, one line per
  // set once they differ, *Target* when one side is open, and *Rest* when it changed. A side that is absent — an added or
  // a removed movement — leaves every line new or gone, its rest unsaid.
  /** @param {EntryTargets | null} before @param {EntryTargets | null} after @param {GymUnits} units @param {boolean} each */
  static fields(before, after, units = GymUnits.kg, each = false) {
    const sides = [before, after].flatMap((targets) => targets === null ? [] : [targets.sets ?? []]);
    /** @param {string} label @param {(targets: EntryTargets) => string | null} read */
    const line = (label, read) => new ProposalDiffField(label, before === null ? null : read(before), after === null ? null : read(after));
    /** @param {number | null} kg */
    const load = (kg) => kg === null ? null : `${Readout.weight(kg, units)} ${units.value}${each ? ' each' : ''}`;
    /** @param {SetTarget} target */
    const scheme = (target) => target.weightKg === null ? `${ProposalDiff.reps(target.reps)} reps` : `${ProposalDiff.reps(target.reps)} × ${load(target.weightKg)}`;
    /** @type {ProposalDiffField[]} */
    const lines = [];
    if (sides.some((sets) => sets.length === 0)) {
      if (!(sides.length === 2 && sides.every((sets) => sets.length === 0))) {
        lines.push(line('Target', (targets) => {
          const sets = targets.sets;
          const first = sets?.[0];
          if (!sets || !first) return 'None';
          if (!ProposalDiff.uniform(sets)) return sets.map(scheme).join(', ');
          const weight = load(first.weightKg);
          return `${sets.length} × ${ProposalDiff.reps(first.reps)}${weight === null ? '' : ` at ${weight}`}`;
        }));
      }
    } else if (sides.every(ProposalDiff.uniform)) {
      lines.push(line('Sets', (targets) => targets.sets ? String(targets.sets.length) : null));
      lines.push(line('Reps', (targets) => targets.sets?.[0] ? ProposalDiff.reps(targets.sets[0].reps) : null));
      if (sides.some((sets) => (sets[0]?.weightKg ?? null) !== null)) {
        lines.push(line('Load', (targets) => targets.sets?.[0] ? load(targets.sets[0].weightKg) ?? 'Last time' : null));
      }
    } else {
      for (let index = 0; index < Math.max(...sides.map((sets) => sets.length)); index += 1) {
        /** @param {EntryTargets | null} targets */
        const read = (targets) => { const target = targets?.sets?.[index]; return target ? scheme(target) : null; };
        lines.push(new ProposalDiffField(`Set ${index + 1}`, read(before), read(after)));
      }
    }
    if (before !== null && after !== null && before.restSeconds !== after.restSeconds) {
      lines.push(line('Rest', (targets) => {
        const rest = targets.restSeconds;
        if (rest === null) return 'Default';
        return rest >= 120 && rest % 60 === 0 ? `${rest / 60} min` : `${rest} s`;
      }));
    }
    return Object.freeze(lines);
  }

  /** @param {number | null} reps */
  static reps(reps) { return reps === null ? 'Max' : String(reps); }

  /** @param {readonly SetTarget[]} sets */
  static uniform(sets) { return sets.every((set) => set.reps === sets[0]?.reps && set.weightKg === sets[0]?.weightKg); }

  /** @param {number} place */
  static ordinal(place) {
    const suffixes = /** @type {Record<number, string>} */ ({ 1: 'st', 2: 'nd', 3: 'rd' });
    const suffix = place % 100 >= 11 && place % 100 <= 13 ? 'th' : suffixes[place % 10] ?? 'th';
    return `${place}${suffix}`;
  }
}
