// The mock TreeRepository: serves Windmill's own roadmap (dogfood) or the
// generated perf tree, plus a Progress so first paint looks alive. Backed only by
// data + the domain SkillTree — no I/O yet, but shaped exactly like a real
// backend-backed repository would be.

import { TreeRepository } from '../model/ports.js';
import { SkillTree } from '../model/SkillTree.js';
import { roadmapTree } from './roadmapTree.js';
import { generateBigTree } from './generateBigTree.js';

export class MockTreeRepository extends TreeRepository {
  constructor({ size = 'demo' } = {}) {
    super();
    this.size = size;
    this.cachedTree = null;
  }

  async loadTree() {
    await Promise.resolve();
    this.cachedTree = this.size === 'huge' ? generateBigTree(5000) : roadmapTree;
    return this.cachedTree;
  }

  async loadProgress(treeData) {
    await Promise.resolve();
    const tree = new SkillTree(treeData);

    // The roadmap carries authoritative per-node `status`; honor `complete`/`active`
    // and let UnlockRules derive available/locked from prerequisites.
    if (treeData.nodes.some((node) => node.status)) {
      return {
        completed: new Set(treeData.nodes.filter((node) => node.status === 'complete').map((node) => node.id)),
        inProgress: new Set(treeData.nodes.filter((node) => node.status === 'active').map((node) => node.id)),
      };
    }

    // The generated perf tree has no statuses — complete the root and its first
    // three rings so all three tiers show at once (activated spine, available
    // frontier, dimmed leaves).
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
