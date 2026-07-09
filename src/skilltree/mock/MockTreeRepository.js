// The mock TreeRepository: serves the hand-authored showcase tree or the
// generated perf tree, plus a plausible in-progress Progress so first paint
// looks alive. Backed only by data + the domain SkillTree — no I/O yet, but
// shaped exactly like a real backend-backed repository would be.

import { TreeRepository } from '../model/ports.js';
import { SkillTree } from '../model/SkillTree.js';
import { handAuthoredTree } from './handAuthoredTree.js';
import { generateBigTree } from './generateBigTree.js';

export class MockTreeRepository extends TreeRepository {
  constructor({ size = 'demo' } = {}) {
    super();
    this.size = size;
    this.cachedTree = null;
  }

  async loadTree() {
    await Promise.resolve();
    this.cachedTree = this.size === 'huge' ? generateBigTree(5000) : handAuthoredTree;
    return this.cachedTree;
  }

  async loadProgress(treeId) {
    await Promise.resolve();
    const treeData = this.cachedTree ?? (await this.loadTree());
    const tree = new SkillTree(treeData);

    const firstRing = new Set();
    for (const root of tree.roots()) {
      for (const child of tree.childrenOf(root.id)) firstRing.add(child.id);
    }

    const completed = new Set([...tree.roots().map((root) => root.id), ...firstRing]);

    const secondRing = new Set();
    for (const id of firstRing) {
      for (const child of tree.childrenOf(id)) secondRing.add(child.id);
    }
    const inProgress = new Set([...secondRing].filter((id) => !completed.has(id)));

    return { completed, inProgress };
  }
}
