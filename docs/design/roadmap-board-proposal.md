# Roadmap Board proposal

Status: 💡 proposal awaiting human approval, 2026-10-25. No production code is changed and no Board
flow is Ready for dev. Current Graph/List reconciliation remains on the existing Web and Web Mobile
pages.

Design lives on separate [Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900) and [Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901)
proposal pages. Start with the [mobile board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433) and
[desktop board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543). The pages contain
89 mobile and 39 desktop screen compositions, plus 19 transparent overlay prototype assets.

## Behavior

- Every existing graph node is one Board card, including roots. Edges are prerequisites; one existing
  kind/color becomes one color tag. Cards show that tag as a 2px border around the full perimeter,
  without a dot, reserved dot row or written color name. Accessible tag names and selector labels remain.
  Lock/check indicators communicate status independently of color. No assignees, deadlines or new
  node-status field.
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
  names cycle-blocked nodes and keeps a draft selection across queries. Apply returns that selection
  to the parent form; its final save updates dependencies and reclassifies automatically.
- Graph stays available through Board/Graph. Switching preserves node ID and each view's own
  scroll or camera; returning to Board reveals the selected node's derived category. The Graph
  drawing is an editable focus illustration using current Skill Node components, not a replacement
  renderer specification.
- Anonymous owners retain manual creation and editing. Sign-in is not a Board editing gate.
  Failed saves retain the draft and offer Retry. Storage locality is not interface chrome.

The proposed layout changes the current phone Tree/List presentation to Board/Graph and adds Board
on desktop. It introduces a node composer, responsive node details and reachable mobile actions.
The device workspace is distinct from shared authored descriptions and node links.
Search spans all categories. Desktop shows a fast strip of colors used by the roadmap; mobile opens
that strip from the lower Filter control. An active mobile filter adds its color marker and selected
surface to the control. Multiple colors combine with OR across all three categories. Selected
swatches show a check and boundary; Clear restores all colors. The Gold example has no Up next
result; Sky shows Read the wind in Up next and Name the boat parts in Done. Filtering leaves overall
3/8 progress unchanged. Six used colors can scroll horizontally within their strip. Sort remains
visible separately. Existing roadmap and node overflow actions retain their current canon.

## Branch exploration

**View branch** follows reading a node's Prerequisites and Unlocks. It opens Board with that node as
the anchor and reveals its derived category. The visible set is the selected node plus every
transitive ancestor and descendant, deduplicated by stable node ID. Siblings and collateral nodes
are excluded; a prerequisite of a descendant is not included merely because of that relationship.
This is a dependency filter, separate from the renderer's trunk-branch terminology.

For Read the wind, the six-node subset is Read the wind, Choose a sailing course, Name the boat parts,
Leave the dock, Sail a triangle and Sail solo. It excludes Rig the boat and Tie a bowline. Availability
still uses the complete roadmap: Leave the dock retains Rig the boat and Read the wind as its two
prerequisites, and Sail solo retains both of its prerequisites. Branch categories contain three
Closed, one Up next and two Done nodes; overall roadmap progress remains 3/8.

The compact scope control replaces the redundant mobile column heading and sits in the existing
desktop filter row. Its label opens the anchor; the 44px clear target removes only branch scope.
Color and search intersect this subset, and the current date sort still applies within each category.
Clearing branch keeps the current category and other filters. An empty intersection offers a specific
color-clear recovery, without silently removing branch scope.

Related node and ancestor details return to the same scoped Board. Graph opens the full roadmap
focused on the anchor; returning restores the Board branch context. The native walkthrough covers
entry, category navigation, anchor/related/ancestor inspection, Graph return, clear scope and a
standalone Gold/Up next empty intersection. Arbitrary search/filter/sort combinations, editing and
completion while scoped remain implementation contracts, not fully simulated prototype states.
`SkillTree.ancestorsOf` and `childrenOf` provide current graph traversal; the shipped app has no Board
branch filter yet.

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

Creation is secondary to exploration. **More → New node** is available on populated, filtered-empty
and search-no-results Boards. An empty roadmap also offers a contextual **New node** button.
Clear filters or search is a separate recovery. Loading and load failure may withhold creation
until roadmap ownership and content are known. Mobile uses a full-page form; desktop uses a 600px
modal. Opening the form creates nothing, and Cancel retains the Board.

The draft contains a required trimmed Name, optional authored Description, one current legend color,
and optional multi-select **Prerequisites**. These are graph edges, not checklist items. The chooser
shows each candidate's current state. No prerequisites is valid, including in an already populated
roadmap. The read-only placement preview is Up next when there are no prerequisites or all are
complete; an unmet prerequisite places the new node in Closed. There is no category selector.

Color is selected inline in the current form. The [shared palette](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=306-4848)
offers Terracotta, Olive, Gold, Brick, Sky and Plum from the existing legend variables. Six 44px targets
with 4px gaps occupy 284px and fit inside a 320px viewport with 16px side insets. The selected swatch
has a check and an outline; accessible radio names carry the color names without a separate label row.
The [shared Color field](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=309-5034) stacks
the left-aligned label above the palette on mobile (72px) and uses one desktop row (44px).
All 20 create/edit/returned-draft specimens use actual field and palette instances. The large-roadmap
parent drafts use Sky as their fixture color.

A color choice changes only the current draft. It opens no picker page and requires no separate color
confirmation; Create node or Save persists the whole form, while Cancel/back discards its edits.
Use labelled radio semantics and visible keyboard focus. The prototype demonstrates Sky → Gold → Sky
within the same 390px edit-form composition, preserving all text and prerequisites, with no transition
or scroll reset. The Gold draft's Save is a terminal specimen rather than a false return to a Sky result.
Other swatches remain visual states with unmodeled prototype actions; they are not disabled product
requirements. Default Sky creation/edit routes remain reviewable. Current web `onSetKind`/recolor
handlers apply color immediately; draft-only persistence belongs to this proposed form contract.

Name is limited to 200 Unicode code points and description to 16,000. A nonempty trimmed name is a
proposed UX rule; the current domain permits blank labels and duplicate names. Validate lengths and
selected prerequisites before mutation. Exclude duplicates, self references and cycle-producing
choices. Preserve the complete draft on validation or save failure, with a specific message and Retry.
The keyboard specimen keeps the Create node action above the keyboard.

Create and edit use the same [authored-description field component](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=291-4098).
Its 224px writing area is used by all 20 composer and returned-draft specimens, including required-name,
save-retry and large-roadmap drafts. It preserves the full authored text and scrolls long input.
The form body scrolls independently of the final action. Focusing Description keeps the caret visible
above the keyboard; the mobile specimen places the 106px action strip directly above the 252px keyboard.
Desktop creation modals are 600×722px, centered in the 1440×960px specimen, with a 554px scroll body and
a separate 52px action row. Smaller viewports reduce the scroll body rather than clipping the action.

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

## Prerequisite search

The searchable checkbox list spans the entire roadmap by title, authored description and existing
stable node ID. Search stays directly above the mobile keyboard, with a 44px clear target when the
query is nonempty and a compact 72×44px Apply. At 320px, the 208px field still fits its icon, query and
clear target. Rows are 76px at 390px and 92px at 320px so description and ID remain readable.

Selected IDs survive query changes, clearing search and loading additional 20-result windows.
Review shows every selected node independently of the current query. Results returns to that query;
Find more resumes search. The represented weather and tidal review paths return to their respective
queries. Arbitrary query-return combinations remain an implementation requirement. Removing one
selection preserves the others. Duplicate names show
authored description and a shortened stable ID, without inventing one parent path for the DAG.
Fixture IDs are illustrative abbreviations, not a new sequential ID format. Expand abbreviations
on collision and expose the full existing ID in node details.

Apply is enabled only for a changed, valid picker draft. It revalidates self, deleted and
cycle-producing choices before returning selections to the parent edit/create draft. It writes no
node or edge. The parent's Save node or Create node performs the final write. Cancel discards only
picker-local changes, preserving the prior parent draft. An invalid selected node stays visible
with its reason and removal action; Apply remains disabled without discarding other selections.
The invalid fixture cannot navigate into a valid selection state without removing its invalid node.

The large fixture is **Coastal navigation handbook and practice**, with 5,000 nodes and 3,200 complete,
editing **Plan a coastal passage**. It is separate from Learn to sail's eight-node fixture. The
walkthrough searches “tidal,” selects a node, searches “weather” with the first selection retained,
selects another, reviews both, removes tidal and returns a weather-only parent draft. Separate
snapshots preserve the tidal-only and two-selection outcomes. The 20-row and 21–40 result windows,
unavailable rows, empty, loading, retry and concurrent-eligibility states are drawn explicitly.

Use a labelled search textbox and checkbox result list with Tab/Space, result and selection
announcements, and restored focus. Do not place interactive checkboxes inside an ARIA listbox
option. Query focus, windowed rendering and selection state must remain independent.

Current [NeedPicker.jsx](../../web/src/products/roadmap/list/NeedPicker.jsx) uses label-substring
matching, renders all matches and closes after one selection. Full-scope title/description/ID search,
retained multi-selection, result windows and revalidation are proposed implementation work.
The Figma prototype demonstrates explicit query states; it does not execute a 5,000-node search
index or provide performance evidence.

## Activity, node details and workspace

Activity is closed by default. The desktop **Activity** toggle opens a 380px overlay drawer over the
right side of the Board; the three columns keep their positions and widths. The lower mobile
Activity trigger opens a bottom modal sheet over the current Board. Both use the same event feed,
without repeating Up next. The panel hugs a short feed and scrolls internally when its content
reaches the available viewport height. The populated desktop specimen is 324px tall; mobile is
388px tall, with a 52px **Close activity** button at the bottom above the safe area.

Close, Escape and the outside scrim dismiss Activity; desktop also exposes the same expanded
Activity toggle. Opening and closing preserve category, search, color selection, sort direction/key
and Board scroll. The proposed implementation focuses the close control on opening, traps focus
inside the active modal, makes background controls inert, exposes dialog and expanded-control
semantics, and restores focus to the invoking Activity trigger on dismissal. The desktop expanded
toggle is part of the active overlay. Only one overlay is active: choosing an available node from
the feed closes Activity before opening the node modal or dedicated page. Returning to Board
preserves the same originating state.

Activity is roadmap-wide; node History filters the available log to the selected node. Both reuse
the canonical avatar, verb badge, sentence and relative-time EventRow. Removed or unavailable nodes
are struck through and do not navigate. Empty roadmaps open the feed's empty state. Light and dark
overlay targets explicitly retain both Theme and Roadmap color modes.

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

The [Node identity component](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=306-4743)
places a 4px color rail beside the title, with a 12px gap and 4px top/bottom rail inset. Its 15 detail
instances retain each node's existing tag variable and semantic title color. The title wraps at its
available width without truncation; rail height follows the title. No standalone color-dot row remains
on overview, shared-reader, dark, modal, dedicated-page, branch or stress details. This reclaims 24px
from the identity stack and leaves the Board's full perimeter card borders unchanged.

The owner workspace contains checklist subtasks, a note and personal links. The interface uses
content labels rather than badges or explanations about storage, sharing or synchronization.
Current storage is browser localStorage keyed
by tree ID, with no user-ID namespace or server synchronization; this is not an account-private
cloud vault. Shared readers receive authored node content and relations, without the owner
workspace, History or edit controls.

Subtasks are checklist entries, independent of graph prerequisites and node completion. Checking or
unchecking any entry changes only the checklist. The all-checked specimen remains Up next with 3/8
roadmap progress and a separate **Complete** action. Its Undo restores the prior checklist without
changing node progress. Explicit Complete produces the 4/8 completion result and re-evaluates dependents.
Current `useWorkspace.js` still calls node completion after 600ms when every subtask is checked;
removing that automatic call is required implementation work, not a change delivered by this design.
Note editing supports bold, italic, links and bullets; blur or Cmd/Ctrl+Enter
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
padding. Activity always overlays the Board and never reserves a column. The 1440px specimen has
three 453.33px columns, unchanged when Activity opens. At 1024px and above, Activity uses a 380px
right drawer, 24px from the edge; below 1024px, it uses a bottom modal sheet. Node modals are 760px
wide with 20px padding; dedicated node pages use the available width in two useful columns.
Creation uses a 600px modal. Mobile details fill the viewport and retain the parent roadmap in back
navigation.

Cards use 24px radius, 12px padding, 8px internal gaps and content-driven height, with a 44px minimum
interaction target. Regular Up next/Done cards measure 76px; Closed cards retain their real dependency
row at 102–122px. The 320px stress cards grow to 96–120px for wrapping. Desktop Board uses 24px outer
padding and 16px column gaps. The dedicated
node page uses two columns for shared content and local workspace. These are measured layout
choices, not user-testing results.

Mobile identity occupies one 60px row below the shared Shell: flexible title, inline progress and
44px Board/Graph icon targets. The title truncates; the icons never wrap. The 320px large-roadmap
specimen abbreviates progress to 3.2k/5k and opens a context sheet with the full title and exact
3,200 of 5,000 value. Desktop uses a 64px row; the title hugs up to a 480px maximum, followed by
progress and view icons, then flexible space before search, Activity and More. Icon controls require
accessible names and desktop tooltips; active view has a visible surface and accent.

The [shared Shell](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=290-7085) is a local
component set with Mobile and Desktop variants and an account-label text property. All 57
Shell controls are linked instances, with a 52px height, 44px interaction wrappers and inherited light
or dark appearance. This proposal component leaves the production Shell unchanged.

The 116px mobile exploration band contains 44px category targets and the current sort key/direction,
then a wide search field with Filter, Activity and More. It uses the same 16px outer edge as cards.
Search moves above the keyboard while results remain visible. Creation has no permanent primary
band. Category surfaces and input/sort controls use 16px radius, inset selected segments use 12px,
and modal sheets use 24px. Published circular Icon Buttons retain their canonical shape within
44px wrappers. These roles share tokens without forcing one radius on every control.

The list scrolls above the exploration band; the four-node Closed success example demonstrates
capacity without filler. Mobile node pages put Overview/Workspace/History navigation above
the bottom action row. Overview retains Edit node; Workspace uses contextual Edit note at the lower
left, with Complete or Reset on the right. Subtasks toggle inline and personal link actions stay
inside their local section. Note editing replaces the footer with Cancel and Done. Primary and
secondary interactive targets are at least 44px.

[Node sections](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=286-3838) is one local
component set with Overview, Workspace and History selected variants. All 19 screen controls
are instances, preserving each specimen's routes. The control uses equal-width 44px targets, a
16px outer radius, 4px inset and 36px selected surface with a 12px radius. The radius variables and
semantic surfaces/text inherit light or dark appearance. This matches the proposed Board category
control; published production Tabs retain their existing shape. The instance showcase includes
358px mobile and 720px desktop widths.

The active input and commit action remain visible above the keyboard. Swipe may change categories;
the visible tabs provide the same navigation without gestures. Keyboard focus, arrow-key tab
navigation, Enter to inspect and Escape to close follow web patterns. No new global creation shortcut
is claimed. Use 180–240ms soft transitions, with immediate updates under reduced motion. Announce
completion and newly ready counts to assistive technology. Card titles and descriptions wrap to two
lines then truncate; full authored content remains readable in details.

The 390px and 320px node stress specimens preserve a full long title, a 358-word description and six
long resource links. The 648px body scrolls between the 68px navigation and 128px fixed footer;
Overview/Workspace/History and the action row remain reachable. Resource links use one
[wrapping row component](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-10080),
with a 44px minimum height and a trailing external-link icon. Labels and URL fallbacks wrap without
ellipsis; implementation uses overflow wrapping for unbroken URLs. Native
[390px](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=296-8521) and
[320px](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=296-8562) link excerpts expose
content beyond the initial viewport for review. These synthetic content specimens
have no routes into the short eight-node fixture and do not replace its authored copy.

## Reference basis

Research and visual reference audit: 24 October 2026.

Official board screenshots were visually inspected for compact identity, view switching, restrained
creation and consistent card/control geometry: [Linear board layout](https://linear.app/docs/board-layout)
and [Asana Board view](https://help.asana.com/s/article/board-view). Windmill keeps its own typography,
colors and authored descriptions. [Notion boards](https://www.notion.com/help/boards) informs
consistent view-level card properties; [Trello search/filter documentation](https://support.atlassian.com/trello/docs/search-filter-and-custom-views/)
clarifies scoped filtering.

Frequent navigation in the lower mobile area follows the pattern in
[Linear mobile navigation](https://linear.app/changelog/2026-01-22-customize-your-navigation-in-linear-mobile).
[Apple's search guidance](https://developer.apple.com/videos/play/wwdc2026/292/) informs the reachable
keyboard-adjacent search pattern, proposed here for web. The
[WAI-ARIA listbox guidance](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) informs the distinction
between listbox options and a checkbox result list. The project's 44px touch target is a stronger
design standard than WCAG 2.2 AA's general 24 CSS pixel minimum with spacing exceptions.

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
| 02.04 · Edit node · Gold draft | [185:1765](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1765) |
| 02.05 · Completed node | [185:1819](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1819) |
| 02.06 · Reset result | [185:1885](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1885) |
| 03.01 · Empty roadmap | [185:2149](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2149) |
| 03.02 · Filtered Up next empty | [185:2196](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2196) |
| 03.03 · Loading nodes | [185:2250](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2250) |
| 03.04 · Load error | [185:2266](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2266) |
| 03.05 · Save retry | [185:2292](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2292) |
| 03.06 · Search no results | [185:2329](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2329) |
| 04.01 · Graph handoff | [188:1528](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-1528) |
| 04.02 · Anonymous owner | [188:1585](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-1585) |
| 04.03 · Create with keyboard | [188:1636](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-1636) |
| 04.04 · Dark board | [193:1193](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=193-1193) |
| 04.05 · Dark node page · Activity destination | [252:1157](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=252-1157) |
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
| 07.03 · Activity overlay · open | [228:1179](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-1179) |
| 07.04 · Shared node | [228:1283](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-1283) |
| 07.05 · Edit note | [228:1352](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-1352) |
| 07.06 · All subtasks checked | [231:1174](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=231-1174) |
| 10.02 · Search tidal · keyboard | [258:4760](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-4760) |
| 10.03 · One selected · retained query | [258:5181](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-5181) |
| 10.04 · Second query · selection retained | [258:5335](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-5335) |
| 10.05 · Two selected · separate queries | [258:5469](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-5469) |
| 10.06 · Review selected | [258:5607](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-5607) |
| 10.07 · Remove one · retain another | [258:5749](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-5749) |
| 10.09 · Unavailable nodes | [258:5879](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-5879) |
| 10.10 · No matches | [258:6021](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-6021) |
| 10.11 · Loading results | [258:6140](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-6140) |
| 10.12 · Search unavailable | [258:6259](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-6259) |
| 10.13 · Revalidate selection | [258:6380](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-6380) |
| 10.01 · Parent draft · large roadmap | [258:6523](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-6523) |
| 10.08 · Returned parent draft | [258:6660](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-6660) |
| 10.14 · Selected search · 320px | [258:6693](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-6693) |
| 10.15 · Review first selection | [258:7130](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7130) |
| 10.16 · Clear query · selection retained | [258:7174](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7174) |
| 10.18 · Parent draft · tidal selected | [258:7448](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7448) |
| 10.19 · Parent draft · two selected | [258:7491](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7491) |
| 10.17 · Load more · next result window | [258:7534](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7534) |
| 10.20 · Results after removal | [263:5814](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=263-5814) |
| 09.01 · 320px · large-roadmap exploration | [258:4899](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-4899) |
| 09.06 · Search nodes · keyboard results | [261:6696](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=261-6696) |
| 09.07 · Roadmap context open ·320px | [261:6926](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=261-6926) |
| 11.01 · Review 2 prerequisites | [260:4838](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-4838) |
| 11.02 · Review 1 prerequisites | [260:4994](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-4994) |
| 13.01 · Clear query · zero selection | [276:2838](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-2838) |
| 13.02 · Next results · zero selection | [276:3087](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-3087) |
| 13.03 · Clear query · two selection | [276:3340](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-3340) |
| 13.04 · Next results · two selection | [276:3589](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-3589) |
| 13.05 · Clear query · weather selection | [276:3846](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-3846) |
| 13.06 · Next results · weather selection | [276:4095](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-4095) |
| 13.07 · Creation · prerequisite removed | [276:4362](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-4362) |
| 13.08 · Creation · review one prerequisite | [276:4515](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-4515) |
| 13.09 · Creation · returned one prerequisite | [276:4559](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-4559) |
| 13.10 · Edit · all prerequisites removed | [276:4607](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-4607) |
| 13.11 · Edit · returned without prerequisites | [276:4758](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-4758) |
| 12.01 · Graph handoff · dark | [276:8780](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-8780) |
| 14.01 · Branch · Up next | [292:8702](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=292-8702) |
| 14.02 · Branch · Closed | [292:8798](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=292-8798) |
| 14.03 · Branch · Done | [292:8911](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=292-8911) |
| 14.04 · Branch · Related node | [292:9015](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=292-9015) |
| 14.05 · Branch · Anchor | [292:9084](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=292-9084) |
| 14.06 · Branch · 320px | [292:9156](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=292-9156) |
| 14.07 · Full Graph · return to branch | [294:9765](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-9765) |
| 14.08 · Branch and color · empty intersection | [296:8416](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=296-8416) |
| 14.09 · Branch ancestor · Name the boat parts | [296:8600](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=296-8600) |
| 15.01 · Node long content · 390px | [294:10082](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-10082) |
| 15.02 · Node long content · 320px | [294:10190](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-10190) |
| 13.12 · Review tidal selection · weather query | [279:7741](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=279-7741) |

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
| 05.01 · Activity open · light | [246:3694](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=246-3694) |
| 05.02 · Activity open · dark | [246:3918](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=246-3918) |
| 10.01 · Search all nodes | [259:7506](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=259-7506) |
| 10.02 · Selected across queries | [259:7625](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=259-7625) |
| 10.03 · Review prerequisites | [259:7730](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=259-7730) |
| 10.04 · One selected | [260:7377](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-7377) |
| 10.05 · Second query | [260:7526](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-7526) |
| 10.06 · Parent draft | [260:7657](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-7657) |
| 10.07 · Returned draft · two selected | [260:7709](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-7709) |
| 10.08 · Returned draft · one selected | [260:7782](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-7782) |
| 06.01 · Graph handoff · focus | [260:5978](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-5978) |
| 06.04 · Graph handoff · dark | [260:6193](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-6193) |
| 06.05 · Search nodes · results | [261:7058](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=261-7058) |
| 13.01 · Review after removing weather | [277:6860](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=277-6860) |
| 13.02 · Clear query · zero selected | [277:6916](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=277-6916) |
| 13.03 · Clear query · one selected | [277:6977](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=277-6977) |
| 13.04 · Clear query · two selected | [277:7044](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=277-7044) |
| 13.05 · Creation · prerequisite removed | [277:7115](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=277-7115) |
| 13.06 · Creation · returned one prerequisite | [277:7398](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=277-7398) |
| 13.07 · Creation · review one prerequisite | [277:7622](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=277-7622) |
| 13.08 · Creation · review two prerequisites | [277:8834](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=277-8834) |
| 13.09 · Review tidal selection · tidal query | [279:3962](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=279-3962) |
| 14.01 · Branch Board · Read the wind | [294:8979](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-8979) |
| 14.04 · Full Graph · return to branch | [294:9949](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-9949) |

| Transparent overlay asset | Figma |
|---|---|
| Desktop · light | [246:4142](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=246-4142) |
| Desktop · dark | [246:4198](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=246-4198) |
| Desktop · empty feed | [246:4254](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=246-4254) |
| Mobile · light | [246:4330](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=246-4330) |
| Mobile · dark | [246:4383](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=246-4383) |
| Mobile · empty feed | [246:4436](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=246-4436) |
| 09.02 · More | [258:7848](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7848) |
| 09.03 · Color filter | [258:7862](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7862) |
| 09.04 · Roadmap context | [258:7887](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7887) |
| 09.05 · Full title and progress | [258:7900](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7900) |
| 09 · More · dark overlay | [258:7913](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7913) |
| 09 · Color filter · dark overlay | [258:7923](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-7923) |
| Prototype overlay · color filter · sky | [263:7000](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=263-7000) |
| Prototype overlay · color filter · gold | [263:7022](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=263-7022) |
| 06.02 · More overlay | [260:5154](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-5154) |
| 06.03 · More overlay · dark | [260:5165](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-5165) |
| 12.02 · Roadmap context · dark overlay | [276:8806](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-8806) |
| 14.02 · Desktop branch anchor | [294:9153](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-9153) |
| 14.03 · Desktop related node | [294:9386](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-9386) |

Prototype starts: [Mobile](https://www.figma.com/proto/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433&page-id=183%3A900&starting-point-node-id=183%3A1433)
and [Desktop](https://www.figma.com/proto/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543&page-id=183%3A901&starting-point-node-id=184%3A1543).
The prototype connects representative inspect, complete, reset/Undo, editor, dependency, tag,
recovery and Graph paths. It is a fixture walkthrough, not a functional app.
Completion and reset outcomes retain only their coherent Undo route. Creation outcomes are terminal
specimens showing the correct derived category and progress. The 320px large-roadmap Board opens
its matching full-title context without navigating into Learn to sail. Product controls keep their
intended appearance when a prototype path is unmodeled; they are not disabled product requirements.
Arbitrary changed data, filter combinations and navigation state still require implementation.
Data-entry commits remain static where no result is drawn.
Activity triggers use native Figma OVERLAY actions. Their viewport-sized targets contain only the
scrim, panel and desktop expanded toggle; no copied Board is inside those targets. Explicit CLOSE
actions handle the scrim, close controls and Escape. The Read the wind feed row demonstrates closing
Activity before node navigation. The three full-context open compositions are review illustrations;
the six transparent targets provide the context-preserving prototype behavior.
Dark mobile Board, Graph, node details and roadmap context retain dark appearance; the desktop
dark modal closes to its dark Board. Other unmodeled dark controls have no cross-theme prototype
route. Their behavior follows the shared contract without duplicating every dark outcome.

## Validation and limits

All 128 screen compositions and 19 transparent overlay assets are native editable Figma layers,
with 89 mobile and 39 desktop compositions in numbered journeys on separate proposal pages. The page-tree audit
finds no full-screen image fills; interface copy uses
node terminology and Closed, Up next and Done categories. Nunito, Baloo 2 and the existing monospace
caption font remain in use. No category totals or written color names appear on cards. Colored perimeter borders,
authored description excerpts, overall progress and real dependency counts remain.

The proposal reuses Windmill Buttons, Icon Buttons, semantic/spacing/radius variables, Skill Node
components and canonical EventRows. Compact search adapts the canonical Input's tokens. Local
components consolidate the shared Shell, desktop/mobile identity, the mobile exploration toolbar, Node cards,
filter/sort controls, creation form, inline color field/palette, Node identity, authored description input,
Node sections, prerequisite result rows,
Activity content and device workspace. Current production
Graph/List pages and shared components are untouched. Repeated field, empty and error behavior is
specified once rather than multiplying every responsive combination.

Visual review covers the dense Board, four-node Closed success, blank/filled creation, prerequisite
picker, required-name and retry states, keyboard, shared reader, device workspace and note editing,
independent checklist toggle/Undo and explicit node completion, Activity and History, desktop creation and success, wide dedicated page,
and light/dark modal/Board compositions. Activity contains one reusable overlay feed, external links
use native monochrome icons, and each footer has one contextual action. Fields and scroll areas
follow their responsive container widths.

Prototype links demonstrate representative fixture paths. They do not simulate arbitrary input,
all filter combinations, persisted date history or every save outcome. Native keyboard geometry is
illustrative, and Graph lighting remains a static component approximation. No browser implementation,
live user test, backend transaction completion, deployment or telemetry-arrival claim is made.

The Activity revision checks default-closed and open geometry, light/dark targets, empty-feed routing,
explicit dismissal actions and 44px close targets. Browser focus trapping and focus restoration are
implementation requirements; native Figma reactions do not verify DOM accessibility behavior.

The [25 October review](roadmap-board-review.md) records the current route, component and contrast checks.
The current refinement evidence is in
`/Users/vs/.codex/visualizations/2026/10/23/01a16a42-7a67-7e02-ba5e-15aa6d67f46a/roadmap-board-refinement-20261025`.
Inline-color and Node identity verification is in
`/Users/vs/.codex/visualizations/2026/10/23/01a16a42-7a67-7e02-ba5e-15aa6d67f46a/roadmap-inline-color-20261025`.
The inventory check matches all 147 screen/overlay links to native Figma roots, with no omitted or extra
entries. The audits cover native destinations, active hit targets and section placement. The final
component inventory has 198 cards, 57 Shells, 19 screen Node sections, 20 screen description inputs,
20 screen inline color fields/palettes and 15 Node identities.
Node cards retain their 24px radius and content-driven height. The 320px Board stress specimen retains
long title wrapping, compact progress and reachable exploration controls.
The proposal remains 💡 pending human approval; no flow is Ready for dev or In production.
