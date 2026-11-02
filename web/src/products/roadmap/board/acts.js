import { progressChanges } from '../model/progress.js';
import { UnlockRules } from '../model/UnlockRules.js';
import { completedToast, createdToast, deletedToast, deletedStepsToast } from './copy.js';

export class HeldDelete {
  constructor(ids, subject) {
    this.ids = Object.freeze([...new Set(ids)]);
    this.subject = subject;
    Object.freeze(this);
  }

  projected(tree) { return tree.without(this.ids); }

  get message() {
    if (this.ids.length === 1) return deletedToast({ step: this.subject });
    return deletedStepsToast({ count: this.ids.length });
  }
}

export function deletionCost(tree, ids) {
  const deleted = new Set(ids);
  return tree.nodes.filter((step) => !deleted.has(step.id) && step.prerequisites.some((id) => deleted.has(id))).length;
}

export function completionOutcome(tree, before, after, id) {
  const { unlocked } = progressChanges(tree, before, after);
  const reveal = unlocked.length === 1 ? unlocked[0] : id;
  return {
    message: completedToast({ step: tree.nodeOrThrow(id).label, unlocked: unlocked.map((key) => tree.nodeOrThrow(key).label) }),
    reveal,
  };
}

export function creationOutcome(tree, progress, query, id) {
  const step = tree.nodeOrThrow(id);
  const nextQuery = query.revealing(step, tree);
  const column = UnlockRules.derive(tree, progress).get(id) === 'locked' ? 'locked' : 'upNext';
  const filterCleared = nextQuery !== query;
  return {
    message: createdToast({ step: step.label, column, filterCleared }),
    reveal: id,
    column,
    query: nextQuery,
    filterCleared,
  };
}

export function countBucket(n) {
  if (n < 1) return '0';
  if (n === 1) return '1';
  if (n <= 5) return '2-5';
  if (n <= 20) return '6-20';
  return '21+';
}
