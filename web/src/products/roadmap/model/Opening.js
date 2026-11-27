// How trees link to each other: down, from a step to the tree it opens, and up, from a subtree to the step that owns it.
//
// What the tree a step opens comes to: the subtree the step owns, which anyone who may read the tree is told, or the
// tree its pointer names, which only the owner of both is, as the read that found it, or as the tree picker knew it
// when the person chose it here. Nothing pushes it: it stands until the roadmap is read again, on a load or once the
// server has confirmed a pointer.

export class Opening {
  constructor({ treeId, read, valid = false, complete = false, title = '', done = 0, total = 0, loop = false, own = false, provisional = false, owned = false }) {
    this.treeId = treeId;
    this.read = read;
    this.owned = owned;
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

  // The subtree a step owns, as a node read carries it (`subtree: {id, done, total, state}`), or by its id alone where
  // nothing of it was read. It is named by the step's own label, so it never stands beside the step, and it never loops.
  static owned({ id, done, total, state }) {
    const read = Number.isInteger(done) && Number.isInteger(total);
    if (!read) return new Opening({ treeId: id, read: false, owned: true });
    return new Opening({ treeId: id, read, valid: true, complete: state === 'complete', done, total, owned: true });
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

// A step that opens a tree is never marked by hand: no door offers its completion and no mark is sent for it. A step
// the roadmap no longer holds opens nothing.
export function takesMark(step) {
  return !step?.opening;
}

// What one load read of the trees a roadmap's steps open, by step: the pointers in `byStep`, and the subtrees the steps
// own in `owned`. `read` is false where the load read no pointer: the device's own copy, or a server that could not
// follow them. `pointers` is false for a room that is not its owner's, which takes no pointer at all.
export class Openings {
  constructor(byStep = new Map(), read = false, owned = new Map(), pointers = true) {
    this.byStep = byStep;
    this.read = read;
    this.owned = owned;
    this.pointers = pointers;
  }

  // A tree read's `opens`, answered to its writer alone, and the `subtree` its nodes carry to anyone who may read it.
  static fromWire(opens = {}, nodes = []) {
    const owned = new Map(nodes.flatMap((node) => (typeof node.subtree?.id === 'string' ? [[node.id, Opening.owned(node.subtree)]] : [])));
    return new Openings(new Map(Object.entries(opens).map(([stepId, entry]) => [stepId, Opening.fromWire(entry)])), true, owned);
  }

  // What a room that is not its owner's stands: the subtrees, and no step that opens a tree by its pointer.
  subtreesAlone() {
    return new Openings(new Map(), true, this.owned, false);
  }

  // The subtree a step owns, as this load read it or as the session has since been told (`subtrees`, by step: `{id,
  // fresh}`): one created since the load, `fresh`, is empty, and one the load did not read is unread.
  ownedBy(stepId, subtrees) {
    const read = this.owned.get(stepId) ?? null;
    const told = subtrees.get(stepId);
    if (!told || told.id === read?.treeId) return read;
    return told.fresh ? Opening.owned({ id: told.id, done: 0, total: 0, state: 'open' }) : Opening.owned({ id: told.id });
  }

  // What a roadmap's steps know of the trees they open, as one word for a signal: none opens one, every one was read,
  // or one was not.
  static known(steps) {
    const openings = steps.flatMap((step) => step.opening ?? []);
    if (openings.length === 0) return 'none';
    return openings.every((opening) => opening.read) ? 'read' : 'unread';
  }

  // The projection with every step that opens a tree carrying its opening. A step that owns a subtree opens it, whatever
  // its pointer holds. For any other, until the projection holds what the server holds, the load is the newer word: a
  // step it named opens that tree and one it did not opens none, whatever an older copy on the device says, but for the
  // steps in `own`, whose pointer this device wrote and the server has not confirmed. From then on the projection's
  // pointer decides. One the load read nothing of, or read for another tree, takes what `known` holds of it
  // (`<step>><tree>`, as the picker knew it) or is unread.
  onto(treeData, { joined, own = new Set(), known = new Map(), subtrees = new Map() }) {
    const standing = (step) => {
      const owned = this.ownedBy(step.id, subtrees);
      if (owned) return owned;
      if (!this.pointers) return null;
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

// Where a tree sits among the trees: a root, or a subtree that one step of its parent owns, under the path of steps from
// its root down, each with its tree's name. A tree read answers it to anyone who may read the tree.
export class TreePlace {
  constructor({ root, parent = null, path = [], depth = 0 }) {
    this.root = root;
    this.parent = parent;
    this.path = path;
    this.depth = depth;
    Object.freeze(this);
  }

  // The place a tree read answers, or null where the answer is not one: a root says `parent: null` and `path: []`, and a
  // subtree its parent and the steps above it, root first.
  static fromWire({ root, parent, path, depth } = {}) {
    const hop = (entry) => typeof entry?.tree === 'string' && typeof entry?.step === 'string';
    if (typeof root !== 'string' || !Number.isInteger(depth) || !Array.isArray(path)) return null;
    if (parent !== null && !hop(parent)) return null;
    if (!path.every((entry) => hop(entry) && typeof entry.title === 'string')) return null;
    if ((parent === null) !== (path.length === 0)) return null;
    return new TreePlace({
      root, depth,
      parent: parent && Object.freeze({ tree: parent.tree, step: parent.step }),
      path: Object.freeze(path.map(({ tree, step, title }) => Object.freeze({ tree, step, title }))),
    });
  }

  get subtree() { return this.parent !== null; }

  // The way up from a subtree: its parent, the step there that owns it and the parent's name.
  get up() {
    if (!this.parent) return null;
    return { treeId: this.parent.tree, stepId: this.parent.step, title: this.path.at(-1).title };
  }
}

