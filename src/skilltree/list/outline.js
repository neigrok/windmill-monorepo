// The outline shape (X8 L2): the list is the tree read top-to-bottom. Section heads are the
// root's children in the canvas's own order (cmpOrder — the fractional-index register the
// RadialLayoutEngine sorts by), and each section is a depth-first walk of that head's subtree.
// A global `placed` set carries across sections so a multi-parent step lands once, under the
// first parent the walk reaches; depth counts rings below the head, the head itself depth 1.
// Everything the list reads that isn't rendering — the shelf, the fruit treatment, the indent
// rule, the progress tally and crown — lives here, pure: the same model the canvas draws.

import { cmpOrder } from '../model/TrunkTree.js';
import { planNextUp } from '../ui/nextUpPlan.js';

const CROWN_MIN_STEPS = 2; // a one-node tree is a single step, not a tree to crown (milestones.js)
const INDENT_STEP = 16;
const INDENT_CAP = 3;

export function buildOutline(tree) {
  const roots = tree.roots();
  const single = roots.length === 1;
  const rootId = single ? roots[0].id : null;
  const heads = (single ? tree.childrenOf(rootId) : roots).slice().sort(cmpOrder);

  const placed = new Set(single ? [rootId] : []);
  const sections = [];
  for (const head of heads) {
    const rows = [];
    walk(tree, head, 1, placed, rows);
    if (rows.length > 0) sections.push({ head: head.id, rows });
  }

  return { rootId, sections };
}

function walk(tree, node, depth, placed, rows) {
  if (placed.has(node.id)) return;
  placed.add(node.id);
  rows.push({ id: node.id, depth });
  for (const child of tree.childrenOf(node.id).slice().sort(cmpOrder)) {
    walk(tree, child, depth + 1, placed, rows);
  }
}

// The Next-up shelf (X8 L2): the shared whats-next offer, capped at the limit, minus the single
// root — you don't "do" the tree's own root as a next step. Multi-root trees have no such root
// (buildOutline's rootId is null), so their available roots stay in the shelf as true entry steps.
export function nextUp(tree, states, limit = 3) {
  const plan = planNextUp(tree, states);
  if (!plan.mount || plan.mode !== 'featured') return [];
  const roots = tree.roots();
  const rootId = roots.length === 1 ? roots[0].id : null;
  return plan.featured.map((entry) => entry.id).filter((id) => id !== rootId).slice(0, limit);
}

export function treatmentOf(state) {
  if (state === 'complete') return 'done';
  if (state === 'available') return 'ready';
  if (state === 'active') return 'active';
  return 'locked';
}

export function indentPx(depth) {
  return Math.min(Math.max(depth - 1, 0), INDENT_CAP) * INDENT_STEP;
}

// The tally the header repeats and the crown predicate (X8 L1 / F10): a tree wears the crown once
// every step is done and it has at least two — the same rule milestones.js crowns a whole tree by.
export function progressOf(tree, states) {
  const total = tree.nodes.length;
  let done = 0;
  for (const node of tree.nodes) if (states.get(node.id) === 'complete') done += 1;
  return { done, total, crowned: total >= CROWN_MIN_STEPS && done === total };
}
