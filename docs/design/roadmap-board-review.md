# Roadmap Board design review

Review date: 2026-10-25. Status: 💡 proposal awaiting human approval.

The review covers the [mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900)
and [desktop](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901) proposals.
The [proposal contract and flow inventory](roadmap-board-proposal.md) remain the implementation reference.
No application code, production screen or approval status changes.

## Resolved findings

| Issue | Severity / priority | Evidence and current result |
|---|---|---|
| Selected Overview contrast | High / P1 | Three light mobile node tabs now resolve the semantic card surface to white with the existing dark label. Measured label/surface contrast is 17.06:1; dark remains 15.72:1. The selected labels are readable in the rendered node page. |
| Outcome routes discard state | High / P1 | Completion and reset keep coherent Undo routes. Creation outcomes are terminal specimens retaining their 3/9 or 0/1 counts and derived categories. They contain no route that silently returns to the initial 3/8 fixture. |
| Large-roadmap specimen changes roadmap | High / P1 | The 320px Coastal navigation Board opens its own full-title context. It has no inherited Learn to sail node or Graph route. |
| Dark routes change appearance | Medium / P2 | Mobile dark Board ↔ Graph and Board → node → Board stay dark. Desktop dark modal Close returns to its dark Board. Unmodeled dark controls have no cross-theme prototype route. |
| Clearing prerequisite search changes selections | High / P1 | Explicit empty-query and next-window states preserve zero, tidal-only, weather-only or two selected IDs. Review, Results and Apply return the matching selection; clearing a query does not select a node. |
| Existing eight-node picker cannot change prerequisites | High / P1 | Creation and edit now demonstrate removing a prerequisite, reviewing the changed selection and applying it to the matching parent draft. Unchanged Apply remains inactive. The creation draft with only completed boat parts derives Up next. |
| Desktop review cannot remove a selected prerequisite | Medium / P2 | Desktop review now removes weather, retains tidal and returns the correct one-selection draft. The original creation review retains both prerequisites until an explicit removal. |

## Verification

The frozen inventory contains 78 mobile and 37 desktop screen compositions plus 17 transparent
overlay assets. Native checks found no missing prototype destinations, active click targets below
44px, full-screen image fills or overlapping journey sections. Shared card dimensions, the compact
identity row, lower exploration controls and 320px content wrapping retain their reviewed geometry.
No additional interaction variants are introduced beyond the states required to demonstrate the
correct selection or appearance.

Visual inspection covers mobile 320px and 390px, desktop, corrected node tabs, dark Graph/context/modal,
empty-query zero selection, existing eight-node removal, and desktop selected review and draft return.
The picker audit compares selected stable IDs across its represented search, review and Apply routes.
Dedicated tidal and weather review specimens return to their originating queries; arbitrary query
combinations remain an implementation requirement.
The native invalid-selection state permits Cancel or removal; no hidden Clear control bypasses it.

Completion/reset → outcome → Undo, creation → derived category, and dark exploration remain
reviewable paths. Terminal outcome controls keep the intended product appearance; an unwired Figma
control is not a requirement to disable that control in the product. The prototype is a fixture
walkthrough, not an application capable of arbitrary state transitions.

Evidence is saved under
`/Users/vs/.codex/visualizations/2026/10/23/01a16a42-7a67-7e02-ba5e-15aa6d67f46a/roadmap-board-review-20261025`.
The evidence includes before/after node screenshots, dark states, native inventory and route audits.
Native geometry and paint measurements do not establish browser accessibility, focus behavior or
5,000-node performance. Those remain implementation validation requirements.

## Structure observations

The review verifies route semantics as well as destination existence: a valid node ID can still
represent the wrong selected set, progress count, roadmap or theme. Shared visual components keep
geometry consistent; fixture-specific reactions belong to each demonstrated journey. Empty-query
states are distinct from an empty selected set. Only changes to selection enable Apply.
