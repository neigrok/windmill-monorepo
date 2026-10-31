// The only place that derives NodeState; nothing else may hand-set a node state. The questions
// below read those derived states: what a step still owes, and what finishing it would open.

const LINE_CAP = 6; // hops — a breadcrumb longer than a phone width stops being an answer

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

// The children THIS completion ALONE would open: not done, every other prerequisite already done.
export function unlocksOf(tree, states, id) {
  return tree.childrenOf(id).filter((child) =>
    states.get(child.id) !== 'complete'
    && child.prerequisites.every((prereqId) => prereqId === id || states.get(prereqId) === 'complete'));
}

// `clipped` says the six-hop cap dropped the far end; the near hops are the kept ones.
export function gateOf(tree, states, id) {
  const step = tree.nodesById.get(id);
  if (!step) return { blockedBy: 0, frontier: [], longestChain: 0, line: null, clipped: false };
  const unmet = (node) => unmetPrerequisitesOf(tree, states, node.id);
  const owed = new Map(owedStepsOf(tree, states, id).map((node) => [node.id, node]));

  const frontier = [...owed.values()]
    .filter((node) => unmet(node).length === 0)
    .map((node) => ({ node, unlocks: unlocksOf(tree, states, node.id).length }))
    .sort((a, b) => b.unlocks - a.unlocks || (a.node.id < b.node.id ? -1 : 1))
    .map((entry) => entry.node);

  // A cycle never peels, so a round that removes nothing ends the walk instead of hanging.
  const peeled = new Set(frontier.map((node) => node.id));
  let longestChain = peeled.size > 0 ? 1 : 0;
  while (peeled.size < owed.size) {
    const layer = [...owed.values()].filter((node) => !peeled.has(node.id) && unmet(node).every((parent) => peeled.has(parent.id)));
    if (layer.length === 0) break;
    for (const node of layer) peeled.add(node.id);
    longestChain += 1;
  }

  const walk = [step];
  const walked = new Set([step.id]);
  let above = unmet(step);
  while (above.length === 1 && !walked.has(above[0].id)) {
    walked.add(above[0].id);
    walk.push(above[0]);
    above = unmet(above[0]);
  }

  // A line is proven by running out of blockers AND covering the whole owed set.
  const straight = above.length === 0 && owed.size > 0 && walk.length - 1 === owed.size;
  return {
    blockedBy: owed.size,
    frontier,
    longestChain,
    line: straight ? walk.slice(0, LINE_CAP).reverse() : null,
    clipped: straight && walk.length > LINE_CAP,
  };
}
