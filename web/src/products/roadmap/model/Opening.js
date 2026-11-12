// What the tree a step opens comes to for the owner of both, as the load that read it found it. Nothing pushes it:
// it stands until the roadmap loads again.

export class Opening {
  constructor({ treeId, read, valid = false, complete = false, title = '', done = 0, total = 0, loop = false }) {
    this.treeId = treeId;
    this.read = read;
    this.valid = valid;
    this.complete = complete;
    this.title = title;
    this.done = done;
    this.total = total;
    this.loop = loop;
    Object.freeze(this);
  }

  // One entry of the answer's `opens`: a pointer that is not valid says only that; a valid one says how far its tree is.
  static fromWire(entry) {
    if (entry.missing) return new Opening({ treeId: entry.treeId, read: true });
    return new Opening({
      treeId: entry.treeId, read: true, valid: true, complete: entry.state === 'complete',
      title: entry.title, done: entry.done, total: entry.total, loop: entry.loop === true,
    });
  }

  // A pointer whose facts this load did not read: the device's own copy, or a pointer set since.
  static unread(treeId) {
    return new Opening({ treeId, read: false });
  }

  // The server found no tree of the owner's at the other end: an ordinary step that follows its mark, with nowhere to
  // go. An unread pointer is not taken for one, so no mark is trusted that the server may be ignoring.
  get dangling() { return this.read && !this.valid; }

  // The one of six ways a surface shows it.
  get face() {
    if (!this.read) return 'unread';
    if (!this.valid) return 'missing';
    if (this.complete) return 'complete';
    if (this.loop) return 'loop';
    return this.total === 0 ? 'empty' : 'open';
  }

  // Going in is the way forward: the tree is there, not done, and not waiting on a loop.
  get workable() { return this.face === 'open' || this.face === 'empty'; }

  // Done of total as the Graph's arc draws it, or null where there is nothing to count.
  get gauge() {
    if (!this.valid) return null;
    return this.total === 0 ? 0 : this.done / this.total;
  }

  // The tree's title where it says more than the step's own.
  titleBeside(step) {
    return this.title && this.title !== step.label ? this.title : null;
  }
}

// The openings one load read, by step.
export class Openings {
  constructor(byStep = new Map()) {
    this.byStep = byStep;
  }

  static fromWire(opens = {}) {
    return new Openings(new Map(Object.entries(opens).map(([stepId, entry]) => [stepId, Opening.fromWire(entry)])));
  }

  // None for a step with no pointer; unread when what was read is about another tree, or nothing was.
  of(step) {
    if (!step.opens) return null;
    const read = this.byStep.get(step.id);
    return read?.treeId === step.opens ? read : Opening.unread(step.opens);
  }

  // The projection with every step that opens a tree carrying its opening.
  onto(treeData) {
    return {
      ...treeData,
      nodes: treeData.nodes.map((step) => {
        const opening = this.of(step);
        return opening ? { ...step, opening } : step;
      }),
    };
  }
}
