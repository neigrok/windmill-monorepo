// A step's rank is how many children THIS completion ALONE would open (the child isn't done and its
// every other prerequisite already is), ties broken by id.

import { DEFAULT_NODE_COLOR } from '../theme.js';

const FEATURED_CAP = 3;
const KIND_CAP = 2;

export function unlocksOf(tree, states, id) {
  return tree.childrenOf(id).filter((child) =>
    states.get(child.id) !== 'complete'
    && child.prerequisites.every((prereqId) => prereqId === id || states.get(prereqId) === 'complete')).length;
}

export function planNextUp(tree, states) {
  if (tree.nodes.length <= 1) return { mount: false };

  const row = (node) => ({
    id: node.id,
    kind: node.color ?? DEFAULT_NODE_COLOR,
    unlocks: unlocksOf(tree, states, node.id),
  });
  const byRank = (a, b) => b.unlocks - a.unlocks || (a.id < b.id ? -1 : 1);
  const ready = tree.nodes.filter((node) => states.get(node.id) === 'available').map(row).sort(byRank);
  const doneCount = tree.nodes.filter((node) => states.get(node.id) === 'complete').length;
  const totalCount = tree.nodes.length;

  if (doneCount === totalCount) {
    return { mount: true, mode: 'allDone', pill: `${doneCount}/${totalCount}`, doneCount, totalCount, readyCount: 0, featured: [], overflow: [], blockers: [] };
  }
  if (ready.length === 0) {
    const blockers = tree.nodes.filter((node) => states.get(node.id) === 'active').map(row).sort(byRank);
    return { mount: true, mode: 'blocked', pill: '0 ready', doneCount, totalCount, readyCount: 0, featured: [], overflow: [], blockers };
  }

  const featured = [];
  const wornByKind = new Map();
  for (const candidate of ready) {
    if (featured.length === FEATURED_CAP) break;
    const worn = wornByKind.get(candidate.kind) ?? 0;
    if (worn === KIND_CAP) continue;
    wornByKind.set(candidate.kind, worn + 1);
    featured.push(candidate);
  }
  const overflow = ready.filter((candidate) => !featured.includes(candidate));
  return { mount: true, mode: 'featured', pill: `${ready.length} ready`, doneCount, totalCount, readyCount: ready.length, featured, overflow, blockers: [] };
}
