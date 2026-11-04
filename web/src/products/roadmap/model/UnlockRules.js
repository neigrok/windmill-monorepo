// The only place that derives NodeState; nothing else may hand-set a node state. The questions
// below read those derived states: what a step still owes, and what finishing it would open.

// The Board column each derived state stands in.
export const COLUMN_OF_STATE = { locked: 'locked', available: 'upNext', complete: 'done' };

export class UnlockRules {
  static derive(tree, progress) {
    const states = new Map();

    for (const node of tree.nodes) {
      if (progress.completed.has(node.id)) {
        states.set(node.id, 'complete');
        continue;
      }
      const unlocked = node.prerequisites.every((prereqId) => progress.completed.has(prereqId));
      states.set(node.id, unlocked ? 'available' : 'locked');
    }

    return states;
  }
}

// Authored order; a prerequisite listed twice still gates once.
export function unmetPrerequisitesOf(tree, states, id) {
  const owing = new Map();
  for (const parent of tree.parentsOf(id)) {
    if (states.get(parent.id) !== 'complete') owing.set(parent.id, parent);
  }
  return [...owing.values()];
}

// Every unfinished step in the transitive prerequisite closure: the steps left before `id` opens.
export function owedStepsOf(tree, states, id) {
  const owed = new Map();
  const pending = unmetPrerequisitesOf(tree, states, id);
  while (pending.length > 0) {
    const node = pending.pop();
    if (owed.has(node.id)) continue;
    owed.set(node.id, node);
    pending.push(...unmetPrerequisitesOf(tree, states, node.id));
  }
  return [...owed.values()];
}

// owedStepsOf's count for every unfinished step in one topological pass: a step owes its unmet
// parents and everything they owe, held as one bitset row over the unfinished steps.
export function owedCounts(tree, states) {
  const open = tree.topoOrder().filter((id) => states.get(id) !== 'complete');
  const slotOf = new Map(open.map((id, slot) => [id, slot]));
  const words = Math.ceil(open.length / 32);
  const owed = new Uint32Array(open.length * words);
  const counts = new Map();

  for (const id of open) {
    const row = slotOf.get(id) * words;
    for (const parent of unmetPrerequisitesOf(tree, states, id)) {
      const parentSlot = slotOf.get(parent.id);
      for (let word = 0; word < words; word++) owed[row + word] |= owed[parentSlot * words + word];
      owed[row + (parentSlot >>> 5)] |= 1 << (parentSlot & 31);
    }
    let count = 0;
    for (let word = 0; word < words; word++) {
      let bits = owed[row + word];
      bits -= (bits >>> 1) & 0x55555555;
      bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
      count += Math.imul((bits + (bits >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
    }
    counts.set(id, count);
  }

  return counts;
}

// The children THIS completion ALONE would open: not done, every other prerequisite already done.
export function unlocksOf(tree, states, id) {
  return tree.childrenOf(id).filter((child) =>
    states.get(child.id) !== 'complete'
    && child.prerequisites.every((prereqId) => prereqId === id || states.get(prereqId) === 'complete'));
}
