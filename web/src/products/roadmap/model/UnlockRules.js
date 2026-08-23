// The only place that derives NodeState; nothing else may hand-set a node state.

export class UnlockRules {
  static derive(tree, progress) {
    const states = new Map();

    for (const node of tree.nodes) {
      if (progress.completed.has(node.id)) {
        states.set(node.id, 'complete');
        continue;
      }
      if (progress.inProgress.has(node.id)) {
        states.set(node.id, 'active');
        continue;
      }
      const unlocked = node.prerequisites.every((prereqId) => progress.completed.has(prereqId));
      states.set(node.id, unlocked ? 'available' : 'locked');
    }

    return states;
  }
}
