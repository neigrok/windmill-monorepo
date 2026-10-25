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
| Node sections are duplicated frames with inconsistent corners | High / P1 | The Overview/Workspace/History control is component set 286:3838 with three selected variants. All 19 screen controls are actual instances; native main-component linkage, equal-width 44px targets and bound 16px outer/12px inset radii pass. Semantic light and dark surfaces remain readable. |
| Checklist completion changes the node automatically | High / P1 | All three checked subtasks leave Read the wind Up next and roadmap progress 3/8. Undo changes only the checklist; explicit Complete reaches 4/8. The proposal records the current web 600ms automatic-completion call as an implementation gap. |
| Storage architecture occupies interface space | Medium / P2 | Storage/sharing/synchronization badges and explanatory copy are absent from both proposal pages. Subtasks, Note, Personal links and Node links remain. The engineering contract still records browser-local tree-scoped storage without claiming account privacy or synchronization. |
| Description fields constrain writing | Medium / P2 | One authored-description component 291:4098 supplies 224px inputs to all 19 composer/edit/returned-draft screens. Mobile, desktop and keyboard specimens preserve final actions outside a clipped vertical scroll body. No read-only description or note editor is enlarged by this change. |
| Color dots reserve a card row | Medium / P2 | The 185 existing cards preserve their exact tag variable in a 2px full perimeter border; 13 branch cards reuse the corrected masters, giving 198 instances. The native audit finds no palette mismatch, obsolete marker/spacer, empty facts row or content bounds failure in the corrected baseline. Titles, authored descriptions and Closed dependency information remain. |
| Shared Shell is copied as frames | High / P1 | Shared Shell component set 290:7085 supplies Mobile and Desktop masters. All 57 Shell controls are actual linked instances at 52px high, with 44px target wrappers and inherited appearance. No plain Shared Shell frame copies remain. |
| Long node content lacks narrow-screen proof | Medium / P2 | The 390px and 320px specimens show the complete long title, 358-word description and six long resource links, including a URL fallback. Their 648px clipped vertical body leaves the 128px footer fixed at y716. Linked section controls and 44–60px link rows remain within their widths. Top views and native scroll-content excerpts pass visual inspection. |
| A node has no focused Board exploration path | Medium / P2 | View branch exposes the anchor plus every ancestor and descendant while retaining full-roadmap prerequisite rules and progress. The six-node Read the wind fixture excludes collateral Rig the boat and Tie a bowline. Native routes cover categories, ancestor/related/anchor inspection, full Graph return and clearing only scope. |

## Verification

The frozen inventory contains 89 mobile and 39 desktop screen compositions plus 19 transparent
overlay assets. Native checks found no missing prototype destinations, active click targets below
44px, full-screen image fills or overlapping journey sections. Shared card dimensions, the compact
identity row, lower exploration controls and 320px content wrapping retain their reviewed geometry.
The added branch and long-content specimens remain in separate numbered journeys.

Visual inspection covers mobile 320px and 390px, desktop, corrected node tabs, dark Graph/context/modal,
empty-query zero selection, existing eight-node removal, and desktop selected review and draft return.
The picker audit compares selected stable IDs across its represented search, review and Apply routes.
Dedicated tidal and weather review specimens return to their originating queries; arbitrary query
combinations remain an implementation requirement.
The native invalid-selection state permits Cancel or removal; no hidden Clear control bypasses it.

The final Node sections inventory verifies all 19 screen instances plus three showcase instances against
their actual main components. It finds no remaining Node sections frame copies. The composer audit
verifies 13 mobile and 6 desktop description instances at 224px, with Nunito text and vertical scroll
containment. The three creation dialogs measure 600×722px at y119 in 960px viewports; their 52px action
row stays separate from the 554px scroll body. The 760px-tall large-roadmap dialogs use 556px bodies and
88px action areas fully within their bounds. The keyboard specimen separates the form at y68–486,
action strip 486–592 and keyboard 592–844. Visual inspection covers all these changed roles.

Completion/reset → outcome → Undo, creation → derived category, and dark exploration remain
reviewable paths. Terminal outcome controls keep the intended product appearance; an unwired Figma
control is not a requirement to disable that control in the product. The prototype is a fixture
walkthrough, not an application capable of arbitrary state transitions.

Evidence is saved under
`/Users/vs/.codex/visualizations/2026/10/23/01a16a42-7a67-7e02-ba5e-15aa6d67f46a/roadmap-board-review-20261025`.
The evidence includes before/after node screenshots, dark states, native inventory and route audits.
Component linkage, neutral-copy/checklist routes, enlarged descriptions, card borders and shared
Shell evidence is saved under
`/Users/vs/.codex/visualizations/2026/10/23/01a16a42-7a67-7e02-ba5e-15aa6d67f46a/roadmap-board-refinement-20261025`.
Native geometry and paint measurements do not establish browser accessibility, focus behavior or
5,000-node performance. Those remain implementation validation requirements.

## Structure observations

The review verifies route semantics as well as destination existence: a valid node ID can still
represent the wrong selected set, progress count, roadmap or theme. Shared visual components keep
geometry consistent; fixture-specific reactions belong to each demonstrated journey. Empty-query
states are distinct from an empty selected set. Only changes to selection enable Apply.
