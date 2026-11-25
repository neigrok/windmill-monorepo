import { RoadmapTree } from '../domain/records.js';
import { FollowGraph } from '../domain/graph.js';
import { EffectsRead } from '../domain/reads.js';
import { progressChanges } from '../model/progress.js';
import { UnlockRules } from '../model/UnlockRules.js';
import { DEFAULT_NODE_COLOR } from '../theme.js';
import { blockedPrerequisites } from '../step/StepDraft.js';
import { LABELS, completedToast, createdToast, deletedToast, deletedStepsToast, recoloredToast } from '../copy.js';

export class StepSelection {
  constructor(ids = []) {
    this.ids = Object.freeze([...new Set(ids)]);
    Object.freeze(this);
  }

  get count() { return this.ids.length; }

  toggle(id, board, column, options) {
    const ids = this.ids.includes(id) ? this.ids.filter((candidate) => candidate !== id) : [...this.ids, id];
    return new StepSelection(ids).prune(board, column, options);
  }

  prune(board, column, options) {
    const selected = new Set(this.ids);
    const cards = options ? board?.shownCards(column, options).cards : board?.[column]?.cards;
    const ids = (cards ?? []).filter((card) => selected.has(card.id)).map((card) => card.id);
    if (ids.length === this.ids.length && ids.every((id, index) => id === this.ids[index])) return this;
    return new StepSelection(ids);
  }
}

// A toast's Undo reverts the act it names and leaves everything later standing; a spent receipt reverts nothing.
export function receiptUndo({ session, receipt, before, onReverted, onFailure }) {
  return {
    label: LABELS.undo,
    receipt: true,
    run: () => {
      try {
        before?.();
        if (session.revert(receipt)) onReverted?.();
      } catch (error) {
        onFailure(error);
      }
    },
  };
}

// What a write's success says, once the write has landed: at once on roadmap's own session, whose writes stand as they are
// made; on the device's copy once every act of it is written, with their results, and never for one that was not.
export function onceLanded(receipt, landed) {
  if (!receipt.landed) {
    landed(null);
    return;
  }
  receipt.landed.then((results) => { if (results) landed(results); });
}

// The domain's graph of each tree with no step complete, read once and kept for every delete asked of that tree.
const unmarked = new WeakMap();

// What a delete of the steps `ids` would do, and a Reset of one, as the domain reads them (`EffectsRead`) over the room's
// tree: its steps in the order it holds them, which is the roadmap's, each following its prerequisites, complete as
// `progress` and their openings make them, with the person's marks. A delete reads no step's completion, so without
// `progress` none is complete. None without a tree.
export function effectsOf(tree, ids, progress = null) {
  if (!tree) return null;
  const width = String(tree.nodes.length).length;
  const roadmap = (marked) => new RoadmapTree({
    id: tree.id,
    nodes: tree.nodes.map((node, place) => ({ id: node.id, ord: String(place).padStart(width, '0') })),
    edges: tree.edges.map(({ from, to }) => ({ from, to, present: true })),
    marks: tree.nodes.filter((node) => marked.has(node.id)).map((node) => ({ node: node.id, status: 'complete', recordedAt: null, deviceAt: null })),
  });
  if (progress !== null) return new EffectsRead(new FollowGraph(roadmap(progress.completed), UnlockRules.completed(tree, progress)), ids);
  if (!unmarked.has(tree)) unmarked.set(tree, new FollowGraph(roadmap(new Set())));
  return new EffectsRead(unmarked.get(tree), ids);
}

// Whether the steps `ids` may be deleted: the one rule every door into a delete asks, on both views and every band, of
// the tree a hold leaves standing. A roadmap keeps a step it starts from.
export function deletable(tree, ids) {
  return effectsOf(tree, ids)?.deletable ?? false;
}

export function editGesture(tree, request) {
  const step = tree.nodesById.get(request.id);
  if (!step) return null;
  const gesture = { kind: 'EditNode', id: request.id };
  if ('label' in request && request.label !== step.label) gesture.label = request.label;
  if ('description' in request && request.description !== (step.description ?? '')) gesture.description = request.description;
  if ('color' in request && request.color !== (step.color ?? DEFAULT_NODE_COLOR)) gesture.color = request.color;
  if ('prerequisites' in request) {
    const blocked = blockedPrerequisites(tree, request.id);
    if (request.prerequisites.some((id) => !tree.nodesById.has(id) || blocked.has(id))) return false;
    const requested = new Set(request.prerequisites);
    const existing = new Set(step.prerequisites);
    gesture.addPrerequisites = [...requested].filter((id) => !existing.has(id));
    gesture.removePrerequisites = [...existing].filter((id) => !requested.has(id));
  }
  const fieldsChanged = ['label', 'description', 'color'].some((field) => field in gesture);
  const edgesChanged = (gesture.addPrerequisites?.length ?? 0) > 0 || (gesture.removePrerequisites?.length ?? 0) > 0;
  if (!fieldsChanged && !edgesChanged) return null;
  return gesture;
}

export function recolorOutcome(ids) {
  return { message: recoloredToast({ count: ids.length }) };
}

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
