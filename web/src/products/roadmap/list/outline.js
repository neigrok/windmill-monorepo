// Depth counts rings from the root: a section head is 1, its children 2.
// A global `placed` set carries across sections, so a multi-parent step lands under the first parent reached.

import { cmpOrder } from '../model/TrunkTree.js';
import { planNextUp } from '../ui/nextUpPlan.js';

const CROWN_MIN_STEPS = 2; // a one-node tree is not a tree to crown
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
    if (placed.has(head.id)) continue; // an earlier section already gave this step its one row
    placed.add(head.id);
    const rows = [];
    for (const child of tree.childrenOf(head.id).slice().sort(cmpOrder)) walk(tree, child, 2, placed, rows);
    sections.push({ head: head.id, rows });
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

// The what's-next offer minus the single root; under a lens the question is asked inside one kind.
export function nextUp(tree, states, limit = 3, kind = null) {
  const plan = planNextUp(tree, states);
  if (!plan.mount || plan.mode !== 'featured') return { entries: [], readyCount: 0 };
  const roots = tree.roots();
  const rootId = roots.length === 1 ? roots[0].id : null;
  const ofKind = kind ? [...plan.featured, ...plan.overflow].filter((entry) => entry.kind === kind) : plan.featured;
  const ranked = ofKind.filter((entry) => entry.id !== rootId);
  const readyCount = kind ? ranked.length : plan.readyCount - (rootId && states.get(rootId) === 'available' ? 1 : 0);
  return { entries: ranked.slice(0, limit).map((entry) => ({ id: entry.id, unlocks: entry.unlocks })), readyCount };
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

export function progressOf(tree, states) {
  const total = tree.nodes.length;
  let done = 0;
  for (const node of tree.nodes) if (states.get(node.id) === 'complete') done += 1;
  return { done, total, crowned: total >= CROWN_MIN_STEPS && done === total };
}
