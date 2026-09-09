// What the overlay chrome tells the camera: the px it covers on each side of the canvas, and the step a first view
// opens on. Insets are static per breakpoint and view state — nothing here observes the DOM.

import { planNextUp } from './nextUpPlan.js';
import { cmpOrder } from '../model/TrunkTree.js';

// Desktop: the control bar along the top and the 360 px dock at right: 24px when open. The minimap and legend hold
// only the bottom-left corner, so they take no full-width inset.
const DESKTOP = { top: 76, margin: 24, dock: 360 + 24 + 24 };
// Tablet: the plaque and wordmark row along the top, the 320 px panel at right when open, the action lane below.
const TABLET = { top: 120, margin: 12, panel: 320 + 24 + 24, laneGutter: 16 };
// Phone: the plaque row along the top, the sheet or the action lane below.
const PHONE = { top: 128, margin: 12, sheetGutter: 12, laneGutter: 16 };

export function viewportInsets({ breakpoint, dockOpen = false, sheetOpen = false, sheetHeight = 0, laneInset = 0 }) {
  if (breakpoint === 'desktop') {
    return { top: DESKTOP.top, right: dockOpen ? DESKTOP.dock : DESKTOP.margin, bottom: DESKTOP.margin, left: DESKTOP.margin };
  }
  if (breakpoint === 'tablet') {
    return { top: TABLET.top, right: dockOpen ? TABLET.panel : TABLET.margin, bottom: laneInset + TABLET.laneGutter, left: TABLET.margin };
  }
  const bottom = sheetOpen ? sheetHeight + PHONE.sheetGutter : laneInset + PHONE.laneGutter;
  return { top: PHONE.top, right: PHONE.margin, bottom, left: PHONE.margin };
}

// The frontier: the selection the device remembers, else the top Next-up row, else the most recent completion this
// browser witnessed, else the crown of the largest tree. Null only on an empty tree.
export function frontierTarget(tree, states, { selectedId = null, completedAt = {} } = {}) {
  if (selectedId && tree.nodesById.has(selectedId)) return selectedId;
  const plan = planNextUp(tree, states);
  if (plan.mount && plan.featured.length > 0) return plan.featured[0].id;
  const latest = tree.nodes
    .filter((node) => states.get(node.id) === 'complete' && Number.isFinite(completedAt[node.id]))
    .sort((a, b) => completedAt[b.id] - completedAt[a.id])[0];
  if (latest) return latest.id;
  const crown = [...tree.roots()].sort((a, b) => tree.trunk.leafCountOf(b.id) - tree.trunk.leafCountOf(a.id) || cmpOrder(a, b))[0];
  return crown?.id ?? null;
}
