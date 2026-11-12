// What the tree a step opens comes to for the owner of both, as the read that found it, or as the tree picker knew it
// when the person chose it here. Nothing pushes it: it stands until the roadmap is read again, on a load or once the
// server has confirmed a pointer.

export class Opening {
  constructor({ treeId, read, valid = false, complete = false, title = '', done = 0, total = 0, loop = false, own = false, provisional = false }) {
    this.treeId = treeId;
    this.read = read;
    this.own = own;
    this.provisional = provisional;
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

  // A pointer whose facts no read has found: the device's own copy, or a pointer set since the last read.
  static unread(treeId) {
    return new Opening({ treeId, read: false });
  }

  // A tree chosen in the picker, as its row said it: the row stands at once, and the server's read replaces it. Whether
  // it leads back is the server's to say.
  static chosen({ id, title, done, total }) {
    return new Opening({ treeId: id, read: true, valid: true, complete: total > 0 && done === total, title, done, total, provisional: true });
  }

  // The server found no tree of the owner's at the other end: an ordinary step that follows its mark, with nowhere to
  // go. An unread pointer is not taken for one, so no mark is trusted that the server may be ignoring.
  get dangling() { return this.read && !this.valid; }

  // The same opening where the tree it names is the one its step stands in.
  inItsOwnTree() {
    return new Opening({ ...this, own: true });
  }

  // Whether a door can lead there: not where nothing was found, and not into the tree the step stands in.
  get leads() { return !this.dangling && !this.own; }

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

// What one load read of the trees a roadmap's steps open, by step. `read` is false where the load read none: the
// device's own copy, or a server that could not follow the pointers.
export class Openings {
  constructor(byStep = new Map(), read = false) {
    this.byStep = byStep;
    this.read = read;
  }

  static fromWire(opens = {}) {
    return new Openings(new Map(Object.entries(opens).map(([stepId, entry]) => [stepId, Opening.fromWire(entry)])), true);
  }

  // What a roadmap's steps know of the trees they open, as one word for a signal: none opens one, every one was read,
  // or one was not.
  static known(steps) {
    const openings = steps.flatMap((step) => step.opening ?? []);
    if (openings.length === 0) return 'none';
    return openings.every((opening) => opening.read) ? 'read' : 'unread';
  }

  // The projection with every step that opens a tree carrying its opening. Until the projection holds what the server
  // holds, the load is the newer word: a step it named opens that tree and one it did not opens none, whatever an older
  // copy on the device says, but for the steps in `own`, whose pointer this device wrote and the server has not
  // confirmed. From then on the projection's pointer decides. One the load read nothing of, or read for another tree,
  // takes what `known` holds of it (`<step>><tree>`, as the picker knew it) or is unread.
  onto(treeData, { joined, own = new Set(), known = new Map() }) {
    const standing = (step) => {
      const named = this.byStep.get(step.id);
      if (this.read && !joined && !own.has(step.id)) return named ?? null;
      if (!step.opens) return null;
      if (named?.treeId === step.opens) return named;
      return known.get(`${step.id}>${step.opens}`) ?? Opening.unread(step.opens);
    };
    return {
      ...treeData,
      nodes: treeData.nodes.map((step) => {
        const opening = standing(step);
        if (!opening) return step;
        return { ...step, opening: opening.treeId === treeData.id ? opening.inItsOwnTree() : opening };
      }),
    };
  }
}
