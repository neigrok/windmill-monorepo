// A roadmap's deletion while it is held, nine seconds, and its Undo stands (roadmap-on-the-engine.md §5, R-7). It rides in
// the history entry of the page the person lands on, so that page offers its Undo, and in the entry of the roadmap an
// Undo returns them to, so the room says it was undone.

export const YOUR_ROADMAPS = '#/app/roadmaps';

const KEY = 'roadmapDeletion';

export class HeldDeletion {
  constructor({ treeId, actId, releaseAt, undone = false }) {
    this.treeId = treeId;
    this.actId = actId;
    this.releaseAt = releaseAt;
    this.undone = undone;
    Object.freeze(this);
  }

  // The deletion a history entry carries, or null.
  static of(state) {
    const held = state?.[KEY];
    return typeof held?.treeId === 'string' && typeof held.actId === 'string' && typeof held.releaseAt === 'number' ? new HeldDeletion(held) : null;
  }

  // A history entry's state without a deletion: what the room keeps once it has said one was undone.
  static without(state) {
    const rest = { ...state };
    delete rest[KEY];
    return rest;
  }

  // How long the hold still stands.
  remainingAt(now) {
    return Math.max(0, this.releaseAt - now);
  }

  // The person lands on their roadmaps, the deletion's Undo standing there.
  landOn(transaction) {
    transaction.navigate(YOUR_ROADMAPS);
    transaction.updateState((state) => ({ ...state, [KEY]: this.json }));
  }

  // Undone: back in the roadmap, which says so.
  returnTo(transaction) {
    transaction.navigate(`#/app/${this.treeId}`);
    transaction.updateState((state) => ({ ...state, [KEY]: { ...this.json, undone: true } }));
  }

  get json() {
    return { treeId: this.treeId, actId: this.actId, releaseAt: this.releaseAt, undone: this.undone };
  }
}
