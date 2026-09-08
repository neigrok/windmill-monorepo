# Roadmap readability and large-graph validation

Updated 2026-09-08. The web roadmap uses compact radial placement, fixed-size captions, and separate Focus / All steps camera actions. The hand-written WebGL2 renderer, authored names, and dependency graph remain the basis of the view.

## Implemented visual contract

| Element | Current behavior |
| --- | --- |
| Ordinary node body | 52 CSS px at the working focus zoom; roots are 1.55 times larger |
| Caption | 14px / 20px, independent of camera zoom, including selected captions |
| Caption footprint | At most 168px including padding; up to two lines with truncation |
| Full title | Desktop detail panel; the phone owner's single-line title needs the rename control for long names |
| Layout clearance | Conservative body-and-caption footprint, with 16px clearance at the reference working zoom |
| Local layout step | 170px at the reference working zoom; crowded nodes advance locally |
| Caption budget | 96 stable DOM slots, with at most 288 ranked placement candidates |
| Working view | Focus uses a readable scale and accounts for the detail panel and canvas chrome |
| Overview | All steps fits the graph and preserves the latest working camera for a return to Focus |

All pixel values are CSS pixels. The nominal world-space node size is 56, the ordinary body is 0.84 times that size, and the working zoom is `52 / (56 × 0.84)`. Changing the nominal size alone also changes layout spacing and therefore does not reliably improve readability after fitting a graph.

The pure layout reserves conservative caption dimensions instead of calling browser text measurement. The rendering boundary measures the actual caption, wraps it, and rejects placements that intersect another visible caption. Working captions also avoid visible node bodies, selected editing affordances, and measured canvas chrome, including camera controls, legend, and minimap. Overview captions may cover context dots smaller than 8px diameter; selected and hovered anchors remain obstacles. This deliberate semantic zoom keeps important names visible in dense overviews.

Selected and hovered steps receive priority, followed by related steps and useful branch context. Small camera changes preserve caption slots. Text measurement is cached and invalidated when web fonts load. The caption background separates names from connectors; truncated text does not change the authored label.

## Layout and interaction

The layout assigns sibling groups ordered angular wedges and advances each node along its ray until its full footprint fits. A local crowded branch no longer sets the radius of every node at that depth. Placement is deterministic, grows outward, and avoids recursion for deep chains. A spatial grid handles collisions and supports picking across the requested radius.

Layout caching includes node IDs, edges, sibling order, raw branch color, and creation stamps because all of these can affect the projection. Pan and zoom change caption visibility without recomputing world placement. Saved cameras carry a layout version: obsolete coordinates are discarded while the selected step is retained and refocused.

Focus and All steps are available to owners and visitors, including the phone tree view. Manual exploration updates the working viewpoint restored by Focus. Selection emphasizes immediate prerequisites and dependents, including secondary edges. The phone list workbench remains available.

## Measured compactness

The comparison uses the same benchmark script and input graphs against baseline commit `883132ce8a9d1456a275bca8c0cd763155a96db3` and the compact layout. The real snapshot contains 462 nodes, 603 edges, and nine roots. The synthetic mixed fixtures include branches, long labels, and secondary dependencies.

| Graph | Baseline bounds | Compact bounds | Bounding area reduction | Median edge distance |
| --- | ---: | ---: | ---: | ---: |
| Real, 462 nodes | 15,454 × 16,988 | 5,567 × 6,498 | 86.2% | 1,061 → 409 |
| Mixed, 300 nodes | 11,813 × 11,900 | 5,228 × 5,197 | 80.7% | 494 → 324 |
| Mixed, 500 nodes | 19,727 × 19,038 | 6,074 × 6,156 | 90.0% | 1,116 → 368 |
| Mixed, 1,000 nodes | 41,853 × 41,410 | 8,572 × 7,950 | 96.1% | 1,866 → 525 |
| Mixed, 5,000 nodes | 458,921 × 452,071 | 21,667 × 18,243 | 99.8% | 9,946 → 1,009 |

Bounds and edge distances are world units. Bounds include a fixed 112-unit padding on each axis; bounding area is not occupied screen area or a usability score. The especially large synthetic reductions reflect the baseline layout's sensitivity to narrow angular gaps and should not be extrapolated to arbitrary graphs.

The benchmark covers mixed, broad, deep, and multiple-root shapes at 300, 500, 1,000, and 5,000 nodes, plus the real snapshot: 17 cases in total. All completed without errors or node-body overlaps, including enlarged roots. Layout tests separately cover reserved-footprint collisions, determinism, sibling ordering, outward growth, and a literal 5,000-node chain.

## Local browser and timing results

The local stack uses Postgres, a freshly built C++ backend, and Vite. Browser measurements use Chrome
152.0.7977.77 with ANGLE Metal on an Apple M3 Pro, at DPR 1. Desktop captures are 1440×900 and the
phone-sized viewport is 390×900; this is browser emulation, not a physical-phone measurement.

The real snapshot's focused capture changes ordinary bodies from 28.2px to 52px and captions from
7.73px to 14px. All ten candidate captures (Focus and All steps for each of the five graphs) have
zero caption-to-caption overlaps. The 5,000-node overview retains 18 readable captions in the
captured state; it does not attempt to display every title. Expanded, collapsed, and re-expanded
legend checks on the real graph each show 17 captions with zero caption intersections against the
measured legend, minimap, and camera controls.

| Local workload | 95th percentile |
| --- | ---: |
| 5,000-node focused scene, camera moving every frame | 1.1ms |
| 5,000-node overview, camera moving every frame | 2.6ms |

These scene timings measure JavaScript work across 120 animation frames. The corresponding
animation-frame interval at the 95th percentile is about 16.7ms on this machine; it is not a GPU
completion measurement or a frame-rate guarantee on other devices. The benchmark's three-run
median layout time is 1.92ms for the real snapshot, 14.87ms for mixed 5,000 nodes, and 28.40ms for
broad 5,000 nodes under Node 20.13.1 on darwin/arm64. For the same mixed 5,000-node fixture, baseline
layout takes 1.12ms: compactness adds layout work, separate from steady camera interaction.

Actual pointer selection, canvas pan, wheel zoom, Focus / All steps, phone List→Tree, safe focus
above an open sheet, and anonymous shared-tree camera controls were exercised. A local MCP rename
reached the browser's live WebSocket model and readable caption in approximately 79ms, then the
original name was restored. These are reproducible local checks, not remote-service latency claims.

The full `npm run build` passes 1,682 tests and produces the Vite bundle and landing shells.
Final phone checks show six readable overview captions and zero caption intersections with the
action lane, camera controls, legend, or minimap. Selection stays above the open sheet.

## Reproduction

From `web/`, run:

```sh
node scripts/benchmark-roadmap.mjs --output /tmp/roadmap-metrics.json
node scripts/benchmark-roadmap.mjs --snapshot /path/to/tree.json --output /tmp/roadmap-with-snapshot.json
node scripts/benchmark-roadmap.mjs --source /path/to/baseline/web/src/products/roadmap --snapshot /path/to/tree.json --output /tmp/roadmap-baseline.json
npm run build
```

The snapshot accepts either a tree object or a `{ "tree": ... }` wrapper. The script reports runtime, platform, architecture, model construction and layout timing, bounds, body overlaps, and edge-distance percentiles. Each timing is the median of three consecutive runs; there is no separate warm-up phase. The deterministic fixtures are in `web/test/products/roadmap/fixtures/largeRoadmap.js`.

## Limits and follow-up

Compact placement costs more CPU than assigning shared depth rings, so layout caching matters. Frame timing must be measured separately from layout time and on the intended devices. A 5,000-node chain remains a long strip when fitted; Focus provides readable steps within it. No overview can display thousands of full titles simultaneously. Secondary edges can still be dense, and complete dependency inspection belongs in a focused neighborhood.

The phone owner sheet still uses a single-line title; long names need its rename control to view/edit. A wrapping detail title remains a follow-up. The written contract describes the implementation. The remaining drawing work is recorded in `docs/design/consistency.md`: update the Figma canvas boards with a dense overview, a readable selected branch, and the phone camera controls. Lower-end physical phones, both themes, text enlargement, and reduced-motion behavior need a broader visual validation pass before claiming universal readability or frame-rate results.

## Research basis

Priority labels at multiple scales are demonstrated in Microsoft Research's [Browsing Large Graphs](https://www.microsoft.com/en-us/research/publication/browsing-large-graphs-with-tile-pyramids-and-sleeve-routing-in-the-browser/). Treating label area as a layout input is also described by [yWorks radial layout](https://docs.yworks.com/yfiles-html/dguide/layout/radial_layout.html) and [A Scalable Method for Readable Tree Layouts](https://arxiv.org/abs/2305.09925). These informed the design; their guarantees do not transfer automatically to Windmill's DAG.

The 14px type size is a product choice, not a WCAG minimum. Normal text contrast is evaluated separately under [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
