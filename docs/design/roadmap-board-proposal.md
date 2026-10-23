# Roadmap Board proposal

Status: 💡 proposal awaiting human approval, 2026-10-24. No production code is changed and no Board
flow is Ready for dev. Current Graph/List reconciliation remains on the existing Web and Web Mobile
pages.

Design lives on separate [Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900) and [Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901)
proposal pages. Start with the [mobile board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433) and
[desktop board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543). The pages contain 39 mobile screens and 15 desktop screens.

## Behavior

- Every existing graph node is one Board card, including roots. Edges are prerequisites; one existing
  kind/color becomes one color tag. Cards show a small color marker without a written name; accessible
  tag names and picker labels remain. No assignees, deadlines or new node-status field.
- Completed nodes are Done. Incomplete nodes with every prerequisite complete are Up next; the
  remaining nodes are Closed. No prerequisites means Up next. These are the current
  `model/UnlockRules.js` rules, with completion taking precedence.
- Up next is the initial mobile column. Desktop orders Closed, Up next, Done. Date sorting
  applies within each derived category; Created date, newest first, is the default.
  Category tabs and headings show names without totals; overall progress and dependency counts
  remain. Dragging never changes status or dependencies.
- Each card shows a short excerpt of the existing authored node description below its title, up to
  two lines. This is not a second summary field. Empty descriptions omit the line; full node pages
  show the complete description. Node copy stays identical across category, size and appearance.
- Desktop cards open a centered modal with **Open node page**. Mobile cards open the dedicated node
  page directly. Both preserve Complete/Reset, Edit node, explicit Prerequisites and Unlocks. Closed
  details name the missing prerequisite and open it. The page identifies its parent roadmap and
  supports a direct link.
  Returning to Board preserves category, color selection, sort key/direction and scroll.
- Reset changes only the selected node's completion. Unfinished nodes regroup; completed descendants
  stay Done, matching `model/progress.js`. Undo restores the prior progress change.
- Dependency selection excludes the node itself and all direct or indirect descendants. The picker
  names cycle-blocked nodes. A dependency update is one save and reclassifies automatically.
- Graph stays available through Board/Graph. Switching preserves node ID and each view's own
  scroll or camera; returning to Board reveals the selected node's derived category. The Graph
  drawing is an editable focus illustration using current Skill Node components, not a replacement
  renderer specification.
- Anonymous owners retain manual creation and editing. Local-only storage is stated on the board.
  Sign-in is not a Board editing gate. Failed saves retain the draft and offer Retry.

The proposed layout changes the current phone Tree/List presentation to Board/Graph and adds Board
on desktop. It introduces a node composer, responsive node details and reachable mobile actions.
The device workspace is distinct from shared authored descriptions and node links.
Search spans all categories. The fast filter strip shows colors used by the
roadmap; multiple selections combine with OR across all three categories. Selected swatches show
a check and boundary, and Clear restores all colors. The Gold example has no Up next result; the
Sky example shows Read the wind in Up next and Name the boat parts in Done. Filtering never changes
overall 3/8 progress. If all six colors are used, the swatch strip scrolls horizontally while Sort stays
fixed. Existing roadmap and node overflow actions continue to use their current canon.

## Date sorting contract

Created date means the immutable first addition of this node to **this roadmap**. Creating a node,
importing it or making a fork copy assigns that roadmap's addition time. Rename, edit, completion,
reset and restore do not change it. Unlocked date means the most recent genuine transition to all
prerequisites satisfied, including transitions caused by edge edits. Roots use their known creation
date. Resetting only the node does not refresh its unlock date; resetting a prerequisite and later
satisfying it again can. Completed nodes retain their recorded unlock date, even if a prerequisite
is reset. A Closed node can have a historical unlock date; Closed does not mean never unlocked.

Both keys offer Newest first and Oldest first. Sort known dates inside each derived category and
keep unknown dates last in either direction; ties preserve stable node order, then stable node ID.
Do not infer missing dates from prerequisite completion times, the roadmap's creation time,
activity-feed observation or first view. Legacy/genesis or unavailable dates remain unknown and may
be presented as **Date unavailable** in details.

Reliable creation and unlock persistence are implementation prerequisites, not existing backend
capabilities. Current [`lattice.js`](../../web/src/products/roadmap/sync/lattice.js) exposes
`createdAt` from the CRDT add-life HLC. [`materialize.js`](../../web/src/products/roadmap/sync/materialize.js)
gives imports a shared import stamp and changes the add-life stamp on restore; forks preserve source
stamps. That does not guarantee the proposed immutable per-roadmap creation meaning. Current
[`UnlockRules.js`](../../web/src/products/roadmap/model/UnlockRules.js) derives present eligibility;
it does not persist `unlockedAt`.

The sorting screens use synthetic dates solely to make order reviewable:

| Fixture | Created date (UTC) | Unlocked date (UTC) |
|---|---|---|
| Tie a bowline | 2026-10-22 10:00 | 2026-10-23 10:00 |
| Read the wind | 2026-10-21 10:00 | 2026-10-24 10:00 |
| Other six nodes | Equal import time, 2026-10-20 09:00 | Closed examples unknown; completed examples retain known dates |

Thus Created/newest shows Tie then Read; Unlocked/newest shows Read then Tie; Unlocked/oldest shows
Tie then Read. Equal-date imported nodes retain their existing fixture order. These are design
fixture values, not dates claimed from a live account. The distinct unlock dates represent recorded
historical transitions, such as prior prerequisite edits, not an inference from their shared current
prerequisite.

## Shared fixture

Roadmap title: Learn to sail. The title is not an extra node. The eight nodes are:

| Node | Prerequisites | Color | Initial category |
|---|---|---|---|
| Choose a sailing course | — | Terracotta | Done |
| Name the boat parts | Choose a sailing course | Sky | Done |
| Rig the boat | Name the boat parts | Terracotta | Done |
| Tie a bowline | Name the boat parts | Olive | Up next |
| Read the wind | Name the boat parts | Sky | Up next |
| Leave the dock | Rig the boat; Read the wind | Terracotta | Closed |
| Sail a triangle | Leave the dock | Olive | Closed |
| Sail solo | Sail a triangle; Tie a bowline | Gold | Closed |

Internal fixture counts are 3 Done, 2 Up next, 3 Closed; these totals are not displayed beside
categories. Completing Read the wind yields 4/2/2; Leave the dock becomes ready. Resetting Name the
boat parts from the initial state yields 2/1/5; Rig the boat remains Done. The draft Reefing basics is
not counted until creation. Creating it yields 3/9 done; it is Up next without prerequisites, or Closed
when it requires the incomplete Read the wind. The first-node example is a separate empty-roadmap
context with 0/1 done. Filtering Gold leaves one Closed node and no Up next or Done nodes; the overall
roadmap progress remains 3/8.

The authored description fixture is shared by every card instance:

| Node | Authored description |
|---|---|
| Choose a sailing course | Book a beginner course with time on the water. |
| Name the boat parts | Identify the mast, boom, hull and rudder. |
| Rig the boat | Set the sails and check the boat before launch. |
| Tie a bowline | Tie a secure loop that is easy to undo. |
| Read the wind | Learn to spot shifts in wind direction. |
| Leave the dock | Cast off safely and steer clear of the dock. |
| Sail a triangle | Practise reaching, tacking and returning to start. |
| Sail solo | Plan and sail a short route on your own. |
| Reefing basics (creation fixture) | How to reduce sail area safely in stronger wind. |

## Creation contract

**+ New node** stays visible on populated, empty, filtered-empty and search-no-results Boards.
Clear filters or search is a separate contextual recovery. Loading and load failure may withhold
creation until roadmap ownership and content are known. Mobile uses a full-page form; desktop uses
a 600px modal. Opening the form does not create a node, and Cancel creates nothing.

The draft contains a required trimmed Name, optional authored Description, one current legend color,
and optional multi-select **Prerequisites**. These are graph edges, not checklist items. The chooser
shows each candidate's current state. No prerequisites is valid, including in an already populated
roadmap. The read-only placement preview is Up next when there are no prerequisites or all are
complete; an unmet prerequisite places the new node in Closed. There is no category selector.

Name is limited to 200 Unicode code points and description to 16,000. A nonempty trimmed name is a
proposed UX rule; the current domain permits blank labels and duplicate names. Validate lengths and
selected prerequisites before mutation. Exclude duplicates, self references and cycle-producing
choices. Preserve the complete draft on validation or save failure, with a specific message and Retry.
The keyboard specimen keeps the Create node action above the keyboard.

Success returns to the derived category, preserves the selected date sort, scrolls the new node
into view and briefly highlights it. Clear only search/color selections that would hide this node,
with explicit feedback; preserve nonconflicting filters. The **Created in Closed · Filters cleared**
mobile fixture starts with the Gold filter, which would hide the new Sky node. The unfiltered Up next
and desktop success examples do not clear filters. Overall progress becomes 3/9, or 0/1 in the
separate empty-roadmap example.

Creation must be one combined intent for the node and all prerequisite edges, with an idempotent
retry. The server command supports `prerequisites[]` and description; current web materialization
consumes a single `parentId`, with extra edges dispatched separately. That current sequence does not
yet provide this form's all-or-nothing contract. Existing web dispatch is optimistic and has no
success promise. Distinguish local pending persistence from server acknowledgement; never infer
“Saved” merely because dispatch ran. Refusals retain the draft and must not silently duplicate the
node on Retry. Multiple roots are already supported; the general Board creation entry is new UX.

Source boundaries: [`materialize.js`](../../web/src/products/roadmap/sync/materialize.js),
[`SyncSession.js`](../../web/src/products/roadmap/sync/SyncSession.js),
[`Command.h`](../../backend/products/roadmap/domain/Command.h),
[`Command.cpp`](../../backend/products/roadmap/domain/Command.cpp). The client guards invalid graph
choices; do not claim the server currently rejects every cycle or dangling edge.

## Activity, node details and workspace

Desktop Board has a 304px Activity sidebar containing the actual event feed. It does not repeat the
Up next column. The standalone mobile Activity view is reachable from the bottom action group and
may include Up next context. Activity is roadmap-wide; node History filters the available log to the
selected node. Both reuse the canonical avatar, verb badge, sentence and relative-time EventRow.
Removed or unavailable nodes are struck through and do not navigate.

Available activity combines a capped server feed, synthesized current completion records and local
session events. It is not a complete durable audit. History uses that same available log; workspace
note, link and checklist edits are not recorded there. The empty Activity view says that future
changes will appear. No separate remote history endpoint or invented loading/error behavior is
promised. See [`useActivity.js`](../../web/src/products/roadmap/activity/useActivity.js),
[`ActivityFeed.jsx`](../../web/src/products/roadmap/activity/ActivityFeed.jsx) and
[`ActivityLog.js`](../../web/src/products/roadmap/activity/ActivityLog.js).

Node Overview contains the shared authored description, **Node links**, explicit **Prerequisites**
and distinct **Unlocks**. Node links travel with the roadmap, accept safe http/https/mailto schemes
and open separately. Prerequisites are all incoming graph edges; Unlocks are direct children,
including cross-branch children. They are not subtasks or all descendants.

The owner workspace has its own visible **On this device / Not shared or synced** boundary. It
contains checklist subtasks, a note and personal links. Current storage is browser localStorage keyed
by tree ID, with no user-ID namespace or server synchronization; this is not an account-private
cloud vault. Shared readers receive authored node content and relations, without the owner
workspace, History or edit controls.

Subtasks are local checklist entries, not graph nodes. Checking the final item completes the parent
node after 600ms in the current workspace behavior. The Board proposal shows Done and Reset and
requires Undo to restore both the prior checklist and node progress as one coherent result; that
combined restoration is implementation work, not a verified current capability. The Board then
re-evaluates dependents. Note editing supports bold, italic, links and bullets; blur or Cmd/Ctrl+Enter
commits and Escape cancels. Personal-link removal never removes authored node
links. Existing workspace storage failures have no reliable save acknowledgement, so no new “Saved”
promise appears. See [`NodeWorkspace.jsx`](../../web/src/products/roadmap/ui/tree/NodeWorkspace.jsx),
[`useWorkspace.js`](../../web/src/products/roadmap/ui/tree/useWorkspace.js),
[`WorkspaceStore.js`](../../web/src/products/roadmap/persistence/WorkspaceStore.js) and
[`StepPanel.jsx`](../../web/src/products/roadmap/ui/StepPanel.jsx).

Mobile workspace and History are proposed Board extensions: the current phone editor does not
expose them. Desktop node details remain a modal plus a dedicated page, not a competing sidebar.
The dedicated page uses shared node information and History in the left column, and a distinct
local workspace column on the right. Returning preserves category, filter, sort and Board scroll.

## Responsive, density and thumb contract

Below 744px, show one full-width column with 16px outer padding. At 744–1023px, keep one focused
column up to 680px wide. At 1024px and above, use three equal columns with 16px gaps and 24px outer
padding; show the 304px Activity sidebar when the remaining Board columns can each stay at least
280px. At narrower desktop widths, Activity opens as an overlay instead of compressing the columns.
The 1440px specimen has 344px columns. Node modals are 760px wide with 20px padding; dedicated node
pages use the available width in two useful columns. Creation uses a 600px modal. Mobile details
fill the viewport and retain the parent roadmap in back navigation.

Cards use 12px padding, 8px internal gaps and a 100px minimum height. Content can grow for
two-line descriptions. Desktop Board uses 24px outer padding and 16px column gaps. The dedicated
node page uses two columns for shared content and local workspace. These are measured layout
choices, not user-testing results.

Mobile Board groups the color filter/sort strip, 44px category tabs, Activity and 52px **+ New node**
action at the bottom above the safe area. The list scrolls above this group; the four-node Closed
success example demonstrates capacity without filler. Sort stays fixed while six used-color
swatches can scroll horizontally. Mobile node pages put Overview/Workspace/History navigation above
the bottom action row. Overview retains Edit node; Workspace uses contextual Edit note at the lower
left, with Complete or Reset on the right. Subtasks toggle inline and personal link actions stay
inside their local section. Note editing replaces the footer with Cancel and Done. Primary and
secondary interactive targets are at least 44px.

The active input and commit action remain visible above the keyboard. Swipe may change categories;
the visible tabs provide the same navigation without gestures. Keyboard focus, arrow-key tab
navigation, Enter to inspect and Escape to close follow web patterns. No new global creation shortcut
is claimed. Use 180–240ms soft transitions, with immediate updates under reduced motion. Announce
completion and newly ready counts to assistive technology. Card titles and descriptions wrap to two
lines then truncate; full authored content remains readable in details.

## Flow inventory

| Mobile screen | Figma |
|---|---|
| 01.01 · Up next | [183:1433](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433) |
| 01.02 · Closed | [183:1503](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1503) |
| 01.03 · Done | [183:1589](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1589) |
| 01.04 · Node page · available | [183:1672](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1672) |
| 01.05 · Completion result | [183:1722](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1722) |
| 01.06 · Blocked node | [183:1795](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1795) |
| 02.01 · New node · blank | [185:1631](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1631) |
| 02.02 · Edit node | [185:1675](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1675) |
| 02.03 · Dependencies picker | [185:1717](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1717) |
| 02.04 · Choose color tag | [185:1765](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1765) |
| 02.05 · Completed node | [185:1819](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1819) |
| 02.06 · Reset result | [185:1885](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1885) |
| 03.01 · Empty roadmap | [185:2149](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2149) |
| 03.02 · Filtered Up next empty | [185:2196](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2196) |
| 03.03 · Loading nodes | [185:2250](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2250) |
| 03.04 · Load error | [185:2266](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2266) |
| 03.05 · Save retry | [185:2292](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2292) |
| 03.06 · Search no results | [185:2329](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2329) |
| 04.01 · Graph handoff | [188:1528](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-1528) |
| 04.02 · Local-only board | [188:1585](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-1585) |
| 04.03 · Create with keyboard | [188:1636](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-1636) |
| 04.04 · Dark board | [193:1193](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=193-1193) |
| 05.01 · Color filter active | [209:2397](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=209-2397) |
| 05.02 · Sort options | [209:2485](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=209-2485) |
| 05.03 · Unlocked · newest | [209:2573](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=209-2573) |
| 05.04 · Unlocked · oldest | [209:2661](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=209-2661) |
| 06.01 · New node · prerequisites | [226:603](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=226-603) |
| 06.02 · Choose prerequisites | [226:642](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=226-642) |
| 06.03 · Name required | [226:748](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=226-748) |
| 06.04 · Create retry | [226:788](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=226-788) |
| 06.05 · Created in Closed | [226:828](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=226-828) |
| 06.06 · Created in Up next | [226:950](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=226-950) |
| 06.07 · First node created | [226:1055](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=226-1055) |
| 07.01 · Node workspace | [228:994](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-994) |
| 07.02 · Node history | [228:1101](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-1101) |
| 07.03 · Roadmap activity | [228:1179](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-1179) |
| 07.04 · Shared node | [228:1283](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-1283) |
| 07.05 · Edit local note | [228:1352](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-1352) |
| 07.06 · Subtasks complete node | [231:1174](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=231-1174) |

| Desktop screen | Figma |
|---|---|
| 01.01 · Desktop board | [184:1543](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543) |
| 01.02 · Desktop node modal | [184:1693](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1693) |
| 02.01 · Dark desktop board | [193:1494](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=193-1494) |
| 03.01 · Dedicated node page | [208:359](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=208-359) |
| 03.02 · Color filter active | [210:363](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=210-363) |
| 03.03 · Date sort menu | [210:539](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=210-539) |
| 03.04 · Unlocked · newest | [210:714](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=210-714) |
| 03.05 · Dark node modal | [210:906](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=210-906) |
| 04.01 · Node modal · Workspace | [232:1090](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-1090) |
| 04.02 · Node modal · History | [232:1402](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-1402) |
| 04.03 · Empty Board | [232:1688](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-1688) |
| 04.04 · New node · blank | [232:1898](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-1898) |
| 04.05 · New node · prerequisites | [232:2139](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-2139) |
| 04.06 · Created in Closed | [232:2380](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-2380) |
| 04.07 · Choose prerequisites | [232:2615](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-2615) |

Prototype starts: [Mobile](https://www.figma.com/proto/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433&page-id=183%3A900&starting-point-node-id=183%3A1433)
and [Desktop](https://www.figma.com/proto/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543&page-id=183%3A901&starting-point-node-id=184%3A1543).
The prototype connects representative inspect, complete, reset/Undo, editor, dependency, tag,
recovery and Graph paths. It is a fixture walkthrough, not a functional app; outcome screens do not
link to contradictory pre-change counts, and data-entry commits remain static where no result is drawn.

## Validation and limits

All 54 screens are native editable Figma layers: 39 mobile and 15 desktop, with numbered journeys
on separate proposal pages. The page-tree audit finds no full-screen image fills; interface copy uses
node terminology and Closed, Up next and Done categories. Nunito, Baloo 2 and the existing monospace
caption font remain in use. No category totals or written color names appear on cards. Small color markers,
authored description excerpts, overall progress and real dependency counts remain.

The proposal reuses Windmill Buttons, semantic/spacing/radius variables, Skill Node components and
canonical EventRows. Local components consolidate the Node card family, filter/sort controls,
creation form, prerequisite choice, Activity content and device workspace. Current production
Graph/List pages and shared components are untouched. Repeated field, empty and error behavior is
specified once rather than multiplying every responsive combination.

Visual review covers the dense Board, four-node Closed success, blank/filled creation, prerequisite
picker, required-name and retry states, keyboard, shared reader, device workspace and note editing,
subtask completion/Undo, Activity and History, desktop creation and success, wide dedicated page,
and light/dark modal/Board compositions. Activity contains a single desktop event feed, external links
use native monochrome icons, and each footer has one contextual action. Fields and scroll areas
follow their responsive container widths.

Prototype links demonstrate representative fixture paths. They do not simulate arbitrary input,
all filter combinations, persisted date history or every save outcome. Native keyboard geometry is
illustrative, and Graph lighting remains a static component approximation. No browser implementation,
live user test, backend transaction completion, deployment or telemetry-arrival claim is made.

Current revision evidence, screenshots and inventory are in `/tmp/roadmap-board-node-creation/`.
The active design work is tracked by `roadmap-board-node-creation-20261024`. The proposal remains
💡 pending human approval; no flow is marked Ready for dev or In production.
