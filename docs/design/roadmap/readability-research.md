# Roadmap structure and readability

Updated 2026-09-09. The working web canvas uses separated major branches, ordered radial rows, fixed-size captions, and a restrained dependency hierarchy. The WebGL2 renderer and complete authored dependency graph remain in place. Visual acceptance concerns whether people can recognize branches and follow steps; a small bounding box or zero caption overlaps is insufficient.

## Layout contract

| Element | Current behavior at the reference working zoom |
| --- | --- |
| Ordinary body | 52 CSS px; roots retain the 1.55 size emphasis |
| Caption | 14px / 20px, up to two lines, maximum 168px including padding |
| Caption attachment | Below its node with an 8px gap; no distant free-floating fallback |
| Same-row spacing | At least 208px between centers, expanded for conservative caption footprints |
| Row spacing | 240px radially |
| Generation gap | 320px from the last row of one generation to the first row of the next |
| Major-branch gutter | 128px between reserved footprints across neighboring sectors |

A sole root sits at the origin and each of its trunk children owns one equal angular sector. In a forest, each root owns a sector. Within each sector, a breadth-first traversal preserves authored sibling order. Each logical generation fills an ordered row up to the radius's available arc capacity, then continues on another row. The next generation starts outside the whole preceding band. A dense branch does not expand unrelated branches.

This reserves deliberate space without forcing every node in a large generation onto one enormous circumference. Rows follow a visible rhythm; placement does not push individual nodes into arbitrary free gaps. The engine remains synchronous, deterministic and stack-safe for the tested 5,000-node chain. Its API is still `Map<id, {x, y}>`.

`NODE_SIZE` is 56 world units and the ordinary body occupies 0.84 of that diameter. The reference zoom remains `52 / (56 × 0.84)`. Caption size is independent of camera scale. Layout reserves conservative text footprints; the rendering boundary measures actual text and culls labels that cannot fit with their node, other captions, or canvas chrome.

## Visual hierarchy

Resting nodes use flat fills in the existing kind palette. Completed nodes retain a status ring and active nodes a dashed ring; completion does not create a continuous bright body glow. Selection has the strong visual emphasis. Arrival and completion feedback can still produce finite effects.

The unselected working view shows quiet, thin primary parent connections only when both endpoints are nearby. Ordinary strokes are 1.25 screen pixels and do not brighten simply because the parent is complete. Extra DAG dependencies appear for hover, selection, or explicit edge inspection. Context strokes are 2px, and the selected or hovered node's ancestor path remains traceable. Rendering and edge picking share the same visibility rule, so suppressed lines cannot intercept a click.

Below a 20px projected body diameter, the overview uses a bounded shallow backbone instead of thousands of overlapping ribbons. Major-branch summaries show the authored branch-root name and an accurate subtree count in the branch's occupied region, with distinct grouped styling. They describe groups, not relocated individual steps. Arbitrary active or completed leaves do not fill leftover caption slots. Summary collisions can suppress some names; the overview does not promise every branch title at every viewport size.

Focus honors a selected step and the saved working camera. Without either, it chooses a root with a useful nearby neighborhood, or a stable major-branch anchor when a high-degree root would appear isolated. All steps fits the complete graph and preserves the working camera. Owner, shared, and phone views expose both actions. The phone list remains available.

Reorder respects wrapped rows: radial pointer proximity chooses a row, its angular gap maps back to the full authored sibling order, and the ghost shows the target row. Reordering remains within one parent and keeps the existing fractional-order and undo semantics.

## Measurements

The deterministic benchmark covers mixed, broad, deep, and multiple-root shapes at 300, 500, 1,000, and 5,000 nodes, plus the real 462-node snapshot with 603 edges and nine roots. All 17 cases complete with finite positions and zero body overlaps. Layout tests also check caption footprints, sector gutters, row and generation spacing, authored order, input-order determinism, branch independence, and a literal 5,000-node chain.

| Graph | Current bounds, world units | Median edge, world units |
| --- | ---: | ---: |
| Real, 462 nodes | 10,949 × 11,890 | 1,065 |
| Mixed, 5,000 nodes | 22,704 × 29,726 | 1,720 |
| Broad, 5,000 nodes | 19,643 × 19,659 | 5,288 |

Bounds include 112 units of padding on each axis. Edge distance covers all authored dependencies, including links normally suppressed by the view. Large fan-out can still produce long relationships; focus and selection provide the local detail. Bounding area is a diagnostic, not the visual success criterion.

## Visual acceptance and reproduction

Inspect the actual initial overview, unselected Focus, a neighborhood reached by pan/zoom, and selected context on the real roadmap and large fixtures. Confirm visible row rhythm, branch gutters, attached readable labels, and a calm unselected state. Follow several consecutive parent connections and exercise hidden-edge picking, wrapped-row reorder and undo, shared controls, phone List→Tree and sheet focus, and a live MCP edit. Check the actual fonts, viewport, and theme before comparing captures.

The local validation stack is Postgres, a freshly built C++ backend, and Vite. Test copies are separate from the live dogfood roadmap. Live browser checks cover overview and Focus at 300, 462, 500, 1,000 and 5,000 nodes; selection, pan, and MCP rename/restore on 5,000; and phone List/Tree, selection, and sheet camera controls at 390 × 900. Direct visual review includes the real and 5,000-node views. A private on-device 300-step roadmap created through New → Paste a plan verifies wrapped-row drag and Cmd-Z restore through the normal guest editing flow; this does not verify authenticated server-owner persistence. A second private on-device outline contains 5,000 steps across 39 major branches; its overview shows counted groups and default Focus enters a branch with nearby children. This browser outline is distinct from the deterministic broad benchmark fixture. The full web build passes 1,696 tests, the Vite build, and landing-shell assertions. Archived prototype images and their measurements are historical comparisons, not evidence of the current visual result.

From `web/`:

```sh
node scripts/benchmark-roadmap.mjs --output /tmp/roadmap-metrics.json
node scripts/benchmark-roadmap.mjs --snapshot /path/to/tree.json --output /tmp/roadmap-with-snapshot.json
npm run build
```

The snapshot accepts a tree object or a `{ "tree": ... }` wrapper. The script reports runtime, platform, architecture, model/layout time, bounds, body overlaps, and edge-distance percentiles. Each timing is the median of three consecutive runs, without a separate warm-up phase. Fixtures live in `web/test/products/roadmap/fixtures/largeRoadmap.js`.

## Limits and follow-up

An overview cannot display thousands of full titles. A 5,000-node chain remains a long strip, and high-degree parents can still have distant children. Group summaries are a presentation aid; recursive cluster navigation is not implemented. The phone owner sheet still truncates its title and needs the name edit control for long names.

Figma canvas boards and standalone DOM node/connector specimens need reconciliation with the restrained GPU treatment. The drawing brief is `docs/design/roadmap/briefs.md` ask 27, and implementation observations are in `web/src/products/roadmap/NOTES.md`. Physical low-end device profiling, text enlargement, and broader reduced-motion validation remain follow-ups; local desktop timings are not universal frame-rate guarantees.

## Research basis

Priority labels at multiple scales are demonstrated in Microsoft Research's [Browsing Large Graphs](https://www.microsoft.com/en-us/research/publication/browsing-large-graphs-with-tile-pyramids-and-sleeve-routing-in-the-browser/). Treating label area as a layout input is described by [yWorks radial layout](https://docs.yworks.com/yfiles-html/dguide/layout/radial_layout.html) and [A Scalable Method for Readable Tree Layouts](https://arxiv.org/abs/2305.09925). These inform the design; their guarantees do not automatically apply to Windmill's DAG. The 14px size is a product choice; normal text contrast is evaluated separately under [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
