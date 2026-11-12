// The tree picker's choices for one step: the person's own roadmaps but the one they are in, the tree the step opens
// now, what Find a tree narrows the list to, and what a pasted roadmap address came to.

const RESERVED = new Set(['new', 'start']);

// The roadmap an address names, `…/#/app/<id>` or the share address `…/t/<id>`; null for anything else typed.
export function pastedTreeId(text) {
  const match = /^\S*(?:#\/app\/|\/t\/)([^/?#\s]+)(?:[?#]\S*)?$/.exec(text.trim());
  if (!match || RESERVED.has(match[1])) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export class TreeChoices {
  // `rows` are `{ id, title, done, total }` in the switcher's order. `pasted` is what the read of an address answered:
  // `{ id, card }` with the roadmap's card or null where none can be read, or `{ id, failed: true }`.
  constructor({ rows, standing = '', chosen = standing, query = '', pasted = null }) {
    this.rows = rows;
    this.standing = standing;
    this.query = query;
    this.address = pastedTreeId(query);
    this.pasted = pasted?.id === this.address ? pasted : null;
    this.own = this.address === null ? null : rows.find((row) => row.id === this.address) ?? null;
    this.chosen = this.own?.id ?? (rows.some((row) => row.id === chosen) ? chosen : '');
    this.unresolved = this.address !== null && this.own === null && this.pasted === null;
    this.failed = this.pasted?.failed === true;
    const card = this.pasted?.card ?? null;
    this.blocked = card && !card.mine ? card : null;
    const asked = query.trim().toLowerCase();
    this.shown = this.address === null ? rows.filter((row) => row.title.toLowerCase().includes(asked)) : this.own ? [this.own] : [];
    Object.freeze(this);
  }

  // What a pasted address came to, once known: one of the person's own roadmaps, one they can only read, or none they can read.
  get outcome() {
    if (this.address === null) return null;
    if (this.own || this.pasted?.card?.mine) return 'own';
    if (this.blocked) return 'readable';
    return this.pasted && !this.failed ? 'unreadable' : null;
  }

  get searched() { return this.query.trim() !== ''; }
  get count() { return this.shown.length + (this.blocked ? 1 : 0); }
  get attachable() { return this.chosen !== '' && this.chosen !== this.standing; }
  get chosenRow() { return this.rows.find((row) => row.id === this.chosen) ?? null; }

  search(query) {
    return new TreeChoices({ rows: this.rows, standing: this.standing, chosen: this.chosen, query, pasted: this.pasted });
  }

  choose(id) {
    return new TreeChoices({ rows: this.rows, standing: this.standing, chosen: id, query: this.query, pasted: this.pasted });
  }

  resolved(pasted) {
    return new TreeChoices({ rows: this.rows, standing: this.standing, chosen: this.chosen, query: this.query, pasted });
  }

  // The list read again, as after a fork: the search is over and the choice stands where its row still does.
  listed(rows) {
    return new TreeChoices({ rows, standing: this.standing, chosen: this.chosen });
  }
}
