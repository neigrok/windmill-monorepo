// §6 The one list of what cannot land (flow 49, Kept here): the engine's notices for roadmap's scopes as the domain reads
// them (`cannotLand`), each in the list's words. A kept change names what it changed, holds the reason it cannot land and
// keeps every word the person wrote, which Copy takes. Every other notice is no refusal a person is shown: it is handed
// back as `unexpected`, by its code alone.

import { cannotLand } from '../domain/landing.js';

// What a record's words are, by type: the field that names it, and every field the person writes words in, in reading
// order. A step's note is named by its step, whose id it shares.
const WORDS = {
  node: { name: 'label', words: ['label', 'description'] },
  kind: { name: 'label', words: ['label', 'description'] },
  meta: { name: 'title', words: ['title', 'guide'] },
  subtask: { name: 'label', words: ['label'] },
  stepLink: { name: 'title', words: ['title', 'url'] },
  stepNote: { name: null, words: ['text'] },
};

export class KeptChange {
  // `reason` is the domain's: roadmapDeleted, capFilled, accessEnded or noteTooLong.
  constructor({ id, reason, title, text }) {
    this.id = id;
    this.reason = reason;
    this.title = title;
    this.text = text;
    Object.freeze(this);
  }

  // One notice the domain lists, in the list's words. Its title is the name the person wrote, else the one the device
  // last read (`named`, by record id); its text every word they wrote, the title's own only where it is all of them.
  static of({ id, reason, subject, values }, named) {
    const words = WORDS[subject?.t] ?? { name: null, words: [] };
    const written = (field) => (typeof values[field] === 'string' ? values[field].trim() : '');
    const title = (words.name && written(words.name)) || named.get(subject?.id ?? '') || '';
    const all = words.words.map(written).filter(Boolean);
    const text = (all.length > 1 ? all.filter((each) => each !== title) : all).join('\n\n');
    return new KeptChange({ id, reason, title, text });
  }
}

// The notices of roadmap's scopes, not dismissed, read by the domain: the kept changes in the order the engine wrote
// them, and each other notice's id and code.
export function keptChanges(notices, registry, named) {
  const { listed, unexpected } = cannotLand(notices.filter((notice) => !notice.dismissed), registry);
  return { kept: listed.map((each) => KeptChange.of(each, named)), unexpected };
}
