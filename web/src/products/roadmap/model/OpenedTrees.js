import { Opening, Openings } from './Opening.js';

// One person's trees under their marks, judged once by the rule the server's OpenedTrees holds (SPEC.md, Model): a step
// that opens one of these trees is complete exactly when that tree is, its mark set aside, and every other step, one
// whose pointer names a tree not among them included, follows its mark. A tree is complete when it holds a step and every
// step is. Completeness is the least the rule allows, so a loop never completes. The device judges its own trees by it.
export class OpenedTrees {
  // `trees` holds each tree by id as `{ title, nodes, completed }`: its steps, each with the tree it `opens` if any, and
  // the ids of the steps its person marked complete.
  constructor(trees) {
    this.trees = trees;
    this.complete = new Set();
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, tree] of trees) {
        if (this.complete.has(id) || tree.nodes.length === 0 || !tree.nodes.every((step) => this.done(tree, step))) continue;
        this.complete.add(id);
        grew = true;
      }
    }
  }

  done(tree, step) {
    return this.trees.has(step.opens) ? this.complete.has(step.opens) : tree.completed.has(step.id);
  }

  // Done of total as the tree's own steps come to under the rule.
  progressOf(treeId) {
    const tree = this.trees.get(treeId);
    return { done: tree.nodes.filter((step) => this.done(tree, step)).length, total: tree.nodes.length };
  }

  // What each step of `treeId` that opens a tree comes to, as a server's read of it says: a tree not among these is not
  // found, and one that leads back to `treeId` is a loop.
  openings(treeId) {
    const back = this.leadingBackTo(treeId);
    const byStep = new Map();
    for (const step of this.trees.get(treeId)?.nodes ?? []) {
      if (!step.opens) continue;
      if (!this.trees.has(step.opens)) {
        byStep.set(step.id, new Opening({ treeId: step.opens, read: true }));
        continue;
      }
      byStep.set(step.id, new Opening({
        treeId: step.opens, read: true, valid: true, complete: this.complete.has(step.opens), title: this.trees.get(step.opens).title,
        ...this.progressOf(step.opens), loop: back.has(step.opens),
      }));
    }
    return new Openings(byStep, true);
  }

  // The trees whose pointers lead to `treeId` at any distance, itself among them; none where it is not among these.
  leadingBackTo(treeId) {
    const leading = new Set();
    const pending = this.trees.has(treeId) ? [treeId] : [];
    while (pending.length > 0) {
      const reached = pending.pop();
      if (leading.has(reached)) continue;
      leading.add(reached);
      for (const [id, tree] of this.trees) if (tree.nodes.some((step) => step.opens === reached)) pending.push(id);
    }
    return leading;
  }

  // The other trees whose steps open `treeId`, in id order, each with how many of its steps do: what goes with it when
  // it is removed. Its own steps that open it go with it and are not among them.
  openersOf(treeId) {
    if (!this.trees.has(treeId)) return [];
    return [...this.trees.keys()].filter((id) => id !== treeId).sort().flatMap((id) => {
      const steps = this.trees.get(id).nodes.filter((step) => step.opens === treeId).length;
      return steps > 0 ? [{ treeId: id, steps }] : [];
    });
  }
}
