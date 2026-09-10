# Bubble graduation

The roadmap opens in bubble layout. Its caption reserve is 168px, with up to two fixed 14px/20px
lines and ellipsized overflow. Bubble and the radial fallback are bundled; rings and mindmap stay
available through explicit URLs. The effective layout identity follows the positions into camera
storage and reorder behavior.

## Structure observations

- Layout selection, fallback and preview rendering share `layout/index.js`; consumers use its
  effective result instead of deriving behavior from the requested URL.
- Caption dimensions live in `theme.js` and feed both layout footprints and on-screen placement.
  The 168px value reserves text width rather than imposing uniform center-to-center spacing.
- Bubble's reorder is scoped to a trunk parent's open fan. Packed root islands have no reorder
  gesture; one order write triggers the normal layout and sync pipeline.
- Tuck work is capped at `max(1,000,000, 2048 × nodeCount)`. On exhaustion, an unfinished move
  is discarded and remaining subtrees keep their enclosing-circle seats. Wide rectangles are
  stored once in the spatial index; the deterministic budget can leave large trees looser.
- Focus and All steps share the working-view contract across desktop and phone. The camera
  floor accounts for both the fit and working zoom, including tiny trees.

## Remaining work

- Layout runs synchronously on the main thread; structural edits and caption changes can repeat
  that work. Large and deeply nested trees need a measured interactive latency budget, including
  repeated edits. A deterministic geometry rule must keep its limits consistent across devices.
- The hand-authored Figma marketing compositions and landing scenes need the bubble design pass
  recorded as F50 in `../consistency.md`.
- Cross-branch visibility at rest and an alternative visitor entry remain evaluation questions
  in `readability-research.md`; the current visitor entry is whole-tree fit plus arrival.

## Verification

Local verification drove a browser through CDP against the backend and live MCP edits:

- Create, long rename, active progress and delete projected without a page reload.
- A real sibling drag persisted the expected order; Cmd+Z restored the original server order.
- Saved selection and camera restored; a camera stamped with the lab format was invalidated.
- The run reported zero JavaScript exceptions.

Font-correct captures covered desktop 1440×900, phone 390×844 and tablet 820×1180. Phone and
tablet used reduced motion. Real selection and crowded overview taps worked; captions measured
14px, with zero caption-pair or body overlaps and no console errors or JavaScript exceptions.
All three selected-state PNGs received visual inspection.

Offline layout medians and geometry checks for the final bubble engine are recorded in
`readability-research.md` §7. They measure synchronous layout calls, not browser frame times.
The benchmark environment is Node v20.13.1 on macOS arm64, Apple M3 Pro; each timing is the median
of five calls. The reproducible command is
`node scripts/benchmark-roadmap.mjs --layouts bubble --sizes 5000 --json bubble-bench.json`
from `web/`.

`npm run build` passes all 1,773 tests with no failures or skips, builds the production bundles,
and generates the landing shells. The final suite includes crown-body hit precedence and long
bowed-ribbon caption regressions. A final desktop capture and live-edit/reorder/reload run
after those fixes again passed with no overlaps or JavaScript exceptions.
Real-device pixels, GPU frame timing, and sustained large-tree editing are not verified here.
