// §6 The one list of what cannot land (flow 49, Kept here): roadmap's notices as the domain reads them (`cannotLand`),
// and the records the carry-over set aside in its ledger (§8.2, `carriedKept`), each in the list's words. A kept change
// names what it changed, holds the reason it cannot land and keeps every word the person wrote, which Copy takes. Every
// other notice is no refusal a person is shown: it is handed back as `unexpected`, by its code alone.

import { cannotLand } from '../domain/landing.js';

// What a record's words are, by type: the field that names it, and every field the person writes words in, in reading
// order.
const WORDS = {
  node: { name: 'label', words: ['label', 'description'] },
  kind: { name: 'label', words: ['label', 'description'] },
  meta: { name: 'title', words: ['title', 'guide'] },
  subtask: { name: 'label', words: ['label'] },
  stepLink: { name: 'title', words: ['title', 'url'] },
  stepNote: { name: null, words: ['text'] },
};

// The record a change goes by when it wrote no name of its own: a step, a kind or the roadmap itself, and a step's note,
// mark and pointer their step, whose id they share.
const NAMED_BY = { node: 'node', kind: 'kind', meta: 'meta', stepNote: 'node', progress: 'node', pointer: 'node' };

// The names the device last read of what its roadmaps hold, by roadmap: a step's and a kind's label and the roadmap's
// title. A step's id is its roadmap's own, so the same id in another roadmap is another step.
export class RoadmapNames {
  static NONE = new RoadmapNames(new Map());

  constructor(names) {
    this.names = names;
    Object.freeze(this);
  }

  // Each roadmap's drawn records, `[roadmap id, records]`.
  static read(roadmaps) {
    const names = new Map();
    for (const [roadmap, records] of roadmaps) {
      for (const record of records) {
        const name = record.f?.[record.t === 'meta' ? 'title' : 'label']?.[0];
        if (typeof name === 'string' && name.trim()) names.set(RoadmapNames.key(roadmap, record.t, record.id), name.trim());
      }
    }
    return new RoadmapNames(names);
  }

  static key(roadmap, t, id) {
    return JSON.stringify([roadmap, t, id]);
  }

  // The roadmap a scope stands for: `tree/T` and `self/overlay/T` stand for T, the account's list for none.
  static roadmapOf(scope) {
    const [kind, ...rest] = scope.split('/');
    if (kind === 'tree') return rest.join('/');
    if (kind === 'self' && rest[0] === 'overlay') return rest.slice(1).join('/');
    return null;
  }

  of(scope, subject) {
    const roadmap = RoadmapNames.roadmapOf(scope);
    const by = NAMED_BY[subject?.t];
    if (roadmap === null || !by) return '';
    return this.names.get(RoadmapNames.key(roadmap, by, subject.id)) ?? '';
  }
}

export class KeptChange {
  // `reason` is the domain's for a notice (roadmapDeleted, capFilled, accessEnded or noteTooLong), or for a record the
  // carry-over set aside its ledger's: one of those, or pastBound for one it kept whole rather than cut short (§8.2).
  // `carriedFrom` names the old roadmap whose ledger holds a carried record, null for a notice.
  constructor({ id, reason, title, text, carriedFrom = null }) {
    this.id = id;
    this.reason = reason;
    this.title = title;
    this.text = text;
    this.carriedFrom = carriedFrom;
    Object.freeze(this);
  }

  // One notice the domain lists, in the list's words. Its title is the name the person wrote, else the one the device
  // last read (`named`); its text every word they wrote, the title's own only where it is all of them.
  static of({ id, reason, subject, values }, named, carriedFrom = null) {
    const words = WORDS[subject?.t] ?? { name: null, words: [] };
    const written = (field) => (typeof values[field] === 'string' ? values[field].trim() : '');
    const title = (words.name && written(words.name)) || named;
    const all = words.words.map(written).filter(Boolean);
    const text = (all.length > 1 ? all.filter((each) => each !== title) : all).join('\n\n');
    return new KeptChange({ id, reason, title, text, carriedFrom });
  }

  // A record the carry-over set aside (§8.2), as its ledger holds it: by the record it would have been, the values it
  // held and its reason. Its id is the ledger's, apart from every notice's.
  static carried({ old, id, reason, subject, values, named }) {
    return KeptChange.of({ id: `carry:${id}`, reason, subject, values }, named, old);
  }

  // The ledger's id of a carried record.
  get ledgerId() {
    return this.id.slice('carry:'.length);
  }

  // A change that carries words of its own, which the list shows and Copy takes; a mark, a pointer or a link carries none.
  get worded() {
    return this.text !== '';
  }
}

// Roadmap's notices read by the domain, then the records the carry-over set aside (`carried`, the domain's
// `carriedKept`): the kept changes, the notices in the order the engine wrote them, and each other notice's id and code.
export function keptChanges(notices, registry, names = RoadmapNames.NONE, carried = []) {
  const scopes = new Map(notices.map((notice) => [notice.id, notice.scope]));
  const { listed, unexpected } = cannotLand(notices, registry);
  return { kept: [...listed.map((each) => KeptChange.of(each, names.of(scopes.get(each.id), each.subject))), ...carried.map(KeptChange.carried)], unexpected };
}
