// The tree picker's choices for one step: the person's own roadmaps but the one they are in, the tree the step opens
// now, what Find a tree narrows the list to, and what a pasted roadmap address came to.

// A tree id as the server mints it: `t_` and sixteen lowercase hex characters.
const TREE_ID = /^t_[0-9a-f]{16}$/;

// The roadmap a text names: this app's share address `<origin>/t/<id>` or app address `<origin>/#/app/<id>`, with or
// without the scheme and with a step after it, or a bare tree id. Null for anything else, which only filters the list.
export function pastedTreeId(text, origin = globalThis.location?.origin ?? '') {
  const typed = text.trim();
  if (TREE_ID.test(typed)) return typed;
  let base;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  const { protocol, host } = base;
  const address = typed.startsWith(`${protocol}//`) ? typed.slice(protocol.length + 2) : typed;
  if (!address.startsWith(`${host}/`)) return null;
  const match = /^(?:t\/|#\/app\/)(t_[0-9a-f]{16})(?:#?\?step=[^\s]*)?$/.exec(address.slice(host.length + 1));
  return match ? match[1] : null;
}

export class TreeChoices {
  // `rows` are `{ id, title, done, total }` in the switcher's order. `pasted` is what the read of an address answered:
  // `{ id, card }` with the roadmap's card or null where none can be read, or `{ id, failed: true, reason }`. `origin` is
  // this app's, whose addresses name roadmaps.
  constructor({ rows, standing = '', chosen = standing, query = '', pasted = null, origin = globalThis.location?.origin ?? '' }) {
    this.rows = rows;
    this.standing = standing;
    this.query = query;
    this.origin = origin;
    this.address = pastedTreeId(query, origin);
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
  // Attach acts on a choice the person can see: the chosen row is on screen and is not the tree the step opens.
  get attachable() { return this.chosen !== '' && this.chosen !== this.standing && this.shown.some((row) => row.id === this.chosen); }
  get chosenRow() { return this.rows.find((row) => row.id === this.chosen) ?? null; }

  with(changes) {
    const { rows, standing, chosen, query, pasted, origin } = this;
    return new TreeChoices({ rows, standing, chosen, query, pasted, origin, ...changes });
  }

  search(query) { return this.with({ query }); }
  choose(id) { return this.with({ chosen: id }); }
  resolved(pasted) { return this.with({ pasted }); }

  // The list read again, as after a fork: the search is over and the choice stands where its row still does.
  listed(rows) { return this.with({ rows, query: '', pasted: null }); }
}
