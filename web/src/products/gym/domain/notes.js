// @ts-check

import { Decision, decision } from '../../../platform/domain-kit/actions.js';
import { SaveDraft } from '../../../platform/domain-kit/drafts.js';
import { EntityType, Id, sameJson } from '../../../platform/domain-kit/entities.js';
import { Placement } from '../../../platform/domain-kit/reading.js';
import { Move, Remove } from '../../../platform/domain-kit/standardActions.js';
import { Check } from '../../../platform/domain-kit/validation.js';
import { Path, TextSpec } from '../../../platform/domain-kit/values.js';
import { GymRefusals } from './gymRules.js';

export const NoteRules = Object.freeze({
  title: new TextSpec('note.title', { unit: 'chars', min: 1, max: 60, trim: true, nfc: true }),
  body: new TextSpec('note.body', { unit: 'bytes', min: 0, max: 500, trim: true, nfc: true }),
});

export class NoteValue {
  /**
   * @param {Id<NoteValue>} id
   * @param {string} title
   * @param {string} body
   * @param {import('../../../platform/domain-kit/time.js').Instant | null} updatedAt
   */
  constructor(id, title = '', body = '', updatedAt = null) {
    this.id = id;
    this.title = title;
    this.body = body;
    this.updatedAt = updatedAt;
    Object.freeze(this);
  }

  fields() { return { title: this.title, body: this.body }; }
}

/** @type {EntityType<NoteValue>} */
export const Note = new EntityType({
  type: 'note', scope: 'self/gym', orderField: 'ord', savesGuarded: true, heldRemoval: true,
  decode: (f) => new NoteValue(new Id(f.id, Note), f.string('title'), f.string('body', ''), f.optionalInstant('updatedAt')),
  checks: [
    new Check('title', (value) => new NoteValue(value.id, NoteRules.title.apply(value.title, new Path('title')), value.body, value.updatedAt)),
    new Check('body', (value) => new NoteValue(value.id, value.title, NoteRules.body.apply(value.body, new Path('body')), value.updatedAt)),
  ],
});

/** @param {import('../../../platform/domain-kit/drafts.js').Draft<NoteValue>} draft */
export function SaveNote(draft) { return SaveDraft.ofDraft(draft, GymRefusals); }

/** @param {Id<NoteValue>} id */
export function DeleteNote(id) { return new Remove(id, GymRefusals); }

/** @param {Id<NoteValue>} id @param {Id<NoteValue> | null} below */
export function MoveNote(id, below) { return new Move(id, below, GymRefusals); }

export class SaveNoteCall {
  /** @param {NoteValue} note */
  constructor(note) {
    this.note = note;
    this.scope = Note.scope;
    this.refusals = GymRefusals;
    this.save = SaveDraft.creating(note, GymRefusals, Placement.bottom);
    Object.freeze(this);
  }

  /** @param {import('../../../platform/domain-kit/reading.js').Reader} read */
  load(read) {
    const notes = read.repository(Note);
    return { save: this.save.load(read), stored: notes.all('stored'), slots: notes.capacity() };
  }

  /**
   * @param {ReturnType<SaveNoteCall['load']>} loaded
   * @param {import('../../../platform/domain-kit/actions.js').IDSource} ids
   */
  decide(loaded, ids) {
    const decided = decision(this.save, loaded.save, ids);
    if (decided.kind === 'unchanged' || (decided.kind === 'refuse' && decided.refusal.kind === 'taken')) {
      return Decision.unchanged(this.note.id);
    }
    if (decided.kind === 'refuse') return decided;
    const same = loaded.stored.find((note) => sameJson(note.fields(), decided.result.values));
    if (same) return Decision.unchanged(same.id);
    const full = loaded.slots.refusal(1, this.note.id.ref);
    if (full) return Decision.refuse(GymRefusals.ofRefused(full));
    return Decision.write(decided.plan, this.note.id);
  }
}
