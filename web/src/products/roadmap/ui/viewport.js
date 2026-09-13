// What the overlay chrome tells the camera and the captions: the px it covers on each side of the canvas, the corners it
// holds, and the step a first view opens on. Every number is view state — nothing here observes the DOM.

import { planNextUp } from './nextUpPlan.js';
import { cmpOrder } from '../model/TrunkTree.js';

// The docked panels' widths, applied as inline widths by the panels themselves so one number moves both the chrome and
// the camera behind it.
export const DOCK_WIDTH = 360;
export const TABLET_PANEL_WIDTH = 320;

// Desktop: the control bar along the top and the dock at right: 24px when open. The minimap and legend hold only the
// bottom-left corner, so they take no full-width inset — they are blocks a caption may not sit under.
const DESKTOP = { top: 76, margin: 24, dock: DOCK_WIDTH + 24 + 24 };
// Tablet: the plaque and wordmark row along the top, the panel at right when open, the action lane below.
const TABLET = { top: 156, margin: 12, panel: TABLET_PANEL_WIDTH + 24 + 24, laneGutter: 16 };
// Phone: the plaque row along the top, the sheet or the action lane below.
const PHONE = { top: 156, margin: 12, sheetGutter: 12, laneGutter: 16 };
// The minimap: its 168x128 canvas, 8 px of padding and a 1 px border, in the corner margin.
const MINIMAP = { width: 186, height: 146 };
// .st-legend-dock: --space-6 from the left on every breakpoint, clear of the minimap's seat below it.
const LEGEND_CORNER = { left: 24, bottom: 24 + 196 };

export function viewportInsets({ breakpoint, dockOpen = false, sheetOpen = false, sheetHeight = 0, laneInset = 0, legendBox = null }) {
  if (breakpoint === 'desktop') {
    return {
      top: DESKTOP.top, right: dockOpen ? DESKTOP.dock : DESKTOP.margin, bottom: DESKTOP.margin, left: DESKTOP.margin,
      blocks: [{ left: DESKTOP.margin, bottom: DESKTOP.margin, ...MINIMAP }, ...legendBlocks(legendBox)],
    };
  }
  if (breakpoint === 'tablet') {
    return {
      top: TABLET.top, right: dockOpen ? TABLET.panel : TABLET.margin, bottom: laneInset + TABLET.laneGutter, left: TABLET.margin,
      blocks: legendBlocks(legendBox),
    };
  }
  // The lane rides above an open sheet, so the phone's bottom band clears whichever of the two reaches higher.
  const bottom = Math.max(sheetOpen ? sheetHeight + PHONE.sheetGutter : 0, laneInset + PHONE.laneGutter);
  return { top: PHONE.top, right: PHONE.margin, bottom, left: PHONE.margin, blocks: [] };
}

// The legend dock publishes its own measured box, since its height is its rows'; the phone hides it altogether.
function legendBlocks(legendBox) {
  if (!legendBox || legendBox.width <= 0 || legendBox.height <= 0) return [];
  return [{ ...LEGEND_CORNER, width: legendBox.width, height: legendBox.height }];
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
