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

    // Complete the root and its first three rings; the frontier just past them is
    // left unlocked ("available"), everything deeper stays locked. This shows all
    // three tree tiers at once: an activated spine, a saturated available frontier,
    // and dimmed leaves.
    const completed = new Set();
    let frontier = tree.roots().map((root) => root.id);
    for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
      const next = [];
      for (const id of frontier) {
        completed.add(id);
        for (const child of tree.childrenOf(id)) next.push(child.id);
      }
      frontier = next;
    }

    return { completed, inProgress: new Set() };
  }
}
