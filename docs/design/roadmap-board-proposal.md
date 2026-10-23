# Roadmap Board proposal

Status: 💡 proposal awaiting human approval, 2026-10-24. No production code is changed and no Board
flow is Ready for dev. Current Graph/List reconciliation remains on the existing Web and Web Mobile
pages.

Design lives on separate [Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900) and [Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901)
proposal pages. Start with the [mobile board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433) and
[desktop board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543). The pages contain 26 mobile screens and eight desktop screens.

## Behavior

- Every existing node is one task, including roots. Edges are prerequisites; one existing kind/color
  becomes one color tag. Cards show a small color marker without a written color name; accessible
  tag names and picker labels remain. No assignees, deadlines or new task-status field.
- Completed tasks are Done. Incomplete tasks with every prerequisite complete are Up next; the
  remaining tasks are Closed. No prerequisites means Up next. These are the current
  `model/UnlockRules.js` rules, with completion taking precedence.
- Up next is the initial mobile column. Desktop orders Closed, Up next, Done. Date sorting
  applies within each derived category; Created date, newest first, is the default.
  Category tabs and headings show names without totals; overall progress and dependency counts
  remain. Dragging never changes status or dependencies.
- Each card shows a short excerpt of the existing authored task description below its title, up to
  two lines. This is not a second summary field. Empty descriptions omit the line; full task pages
  show the complete description. Task copy stays identical across category, size and appearance.
- Desktop cards open a centered modal with **Open task page**. Mobile cards open the dedicated task
  page directly. Both preserve Complete/Reset, Edit task, Needs and Unlocks. Closed details name the
  missing prerequisite and open it. The page identifies its parent roadmap and supports a direct link.
  Returning to Board preserves category, color selection, sort key/direction and scroll.
- Reset changes only the selected task's completion. Unfinished tasks regroup; completed descendants
  stay Done, matching `model/progress.js`. Undo restores the prior progress change.
- Dependency selection excludes the task itself and all direct or indirect descendants. The picker
  names cycle-blocked tasks. A dependency update is one save and reclassifies automatically.
- Graph stays available through Board/Graph. Switching preserves task ID and each view's own
  scroll or camera; returning to Board reveals the selected task's derived category. The Graph
  drawing is an editable focus illustration using current Skill Node components, not a replacement
  renderer specification.
- Anonymous owners retain manual creation and editing. Local-only storage is stated on the board.
  Sign-in is not a Board editing gate. Failed saves retain the draft and offer Retry.

The proposed layout changes the current phone Tree/List presentation to Board/Graph and adds Board
on desktop. It introduces a task composer, responsive task details and reachable mobile actions.
Notes use the existing personal node workspace; authored descriptions and links remain distinct.
Search spans all categories. The fast filter strip shows colors used by the
roadmap; multiple selections combine with OR across all three categories. Selected swatches show
a check and boundary, and Clear restores all colors. The Gold example has no Up next result; the
Sky example shows Read the wind in Up next and Name the boat parts in Done. Filtering never changes
overall 3/8 progress. If all six colors are used, the swatch strip scrolls horizontally while Sort stays
fixed. Existing roadmap and task overflow actions continue to use their current canon.

## Date sorting contract

Created date means the immutable first addition of this task to **this roadmap**. Creating a task,
importing it or making a fork copy assigns that roadmap's addition time. Rename, edit, completion,
reset and restore do not change it. Unlocked date means the most recent genuine transition to all
prerequisites satisfied, including transitions caused by edge edits. Roots use their known creation
date. Resetting only the task does not refresh its unlock date; resetting a prerequisite and later
satisfying it again can. Completed tasks retain their recorded unlock date, even if a prerequisite
is reset. A Closed task can have a historical unlock date; Closed does not mean never unlocked.

Both keys offer Newest first and Oldest first. Sort known dates inside each derived category and
keep unknown dates last in either direction; ties preserve stable task order, then stable node ID.
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
| Other six tasks | Equal import time, 2026-10-20 09:00 | Closed examples unknown; completed examples retain known dates |

Thus Created/newest shows Tie then Read; Unlocked/newest shows Read then Tie; Unlocked/oldest shows
Tie then Read. Equal-date imported tasks retain their existing fixture order. These are design
fixture values, not dates claimed from a live account. The distinct unlock dates represent recorded
historical transitions, such as prior prerequisite edits, not an inference from their shared current
prerequisite.

## Shared fixture

Roadmap title: Learn to sail. The title is not an extra task. The eight task nodes are:

| Task | Needs | Color | Initial category |
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
boat parts from the initial state yields 2/1/5; Rig the boat remains
Done. The draft Practise reefing is not yet counted. Filtering Gold leaves one Closed task and no
Up next or Done tasks; the overall roadmap progress remains 3/8.

The authored description fixture is shared by every card instance:

| Task | Authored description |
|---|---|
| Choose a sailing course | Book a beginner course with time on the water. |
| Name the boat parts | Identify the mast, boom, hull and rudder. |
| Rig the boat | Set the sails and check the boat before launch. |
| Tie a bowline | Tie a secure loop that is easy to undo. |
| Read the wind | Learn to spot shifts in wind direction. |
| Leave the dock | Cast off safely and steer clear of the dock. |
| Sail a triangle | Practise reaching, tacking and returning to start. |
| Sail solo | Plan and sail a short route on your own. |

## Responsive and interaction contract

Below 744px, show one full-width column with 16px outer padding. At 744–1023px, keep one focused
column up to 680px wide. At 1024px and above, show three equal columns of at least 280px, with 24px
gaps and 32–48px outer padding. Desktop details use a centered 560px modal, with a dedicated task
page whose body is up to 680px wide. Mobile details fill the viewport and identify the parent roadmap
in the back navigation. Date sorting uses a desktop popover and a mobile bottom sheet.

Column tabs and primary actions stay above the bottom safe area. Task lists scroll in a clipped
area above them, including the three-card Closed/Done lists after descriptions and filters are added.
Actions are 56px high and secondary targets are at least 44px. The active input and commit action
remain visible above the keyboard.
Swiping changes columns only; the bottom tabs provide the same navigation without gestures.
Keyboard focus, arrow-key tab navigation, Enter to inspect and Escape to close follow web patterns.

Use 180–240ms soft transitions, with immediate updates under reduced motion. Completion feedback
and Undo stay above the bottom tabs. Announce the completed task and newly ready count to assistive
technology. Card titles wrap to two lines then truncate with a full accessible name; detail titles
remain fully readable.

## Flow inventory

| Mobile screen | Figma |
|---|---|
| 01.01 · Up next | [183:1433](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433) |
| 01.02 · Closed | [183:1503](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1503) |
| 01.03 · Done | [183:1589](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1589) |
| 01.04 · Task page · available | [183:1672](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1672) |
| 01.05 · Completion result | [183:1722](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1722) |
| 01.06 · Blocked task | [183:1795](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1795) |
| 02.01 · Create task | [185:1631](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1631) |
| 02.02 · Edit task | [185:1675](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1675) |
| 02.03 · Dependencies picker | [185:1717](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1717) |
| 02.04 · Choose color tag | [185:1765](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1765) |
| 02.05 · Completed task | [185:1819](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1819) |
| 02.06 · Reset result | [185:1885](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1885) |
| 03.01 · Empty roadmap | [185:2149](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2149) |
| 03.02 · Filtered Up next empty | [185:2196](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2196) |
| 03.03 · Loading tasks | [185:2250](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2250) |
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

| Desktop screen | Figma |
|---|---|
| 01.01 · Desktop board | [184:1543](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543) |
| 01.02 · Desktop task modal | [184:1693](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1693) |
| 02.01 · Dark desktop board | [193:1494](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=193-1494) |
| 03.01 · Dedicated task page | [208:359](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=208-359) |
| 03.02 · Color filter active | [210:363](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=210-363) |
| 03.03 · Date sort menu | [210:539](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=210-539) |
| 03.04 · Unlocked · newest | [210:714](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=210-714) |
| 03.05 · Dark task modal | [210:906](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=210-906) |

Prototype starts: [Mobile](https://www.figma.com/proto/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433&page-id=183%3A900&starting-point-node-id=183%3A1433)
and [Desktop](https://www.figma.com/proto/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543&page-id=183%3A901&starting-point-node-id=184%3A1543).
The prototype connects representative inspect, complete, reset/Undo, editor, dependency, tag,
recovery and Graph paths. It is a fixture walkthrough, not a functional app; outcome screens do not
link to contradictory pre-change counts, and data-entry commits remain static where no result is drawn.

## Validation and limits

All 34 screens are native editable Figma layers. The revision retains all 25 original screens and
adds four mobile filter/sort screens and five desktop modal/page/filter/sort contexts. The proposal
reuses the published Windmill Button, shared semantic/spacing/radius variables, Nunito/Baloo type and
existing Skill Node components. One proposal-local Task card family carries three state variants;
a proposal-local filter/sort control is shared across widths. No category totals or written color
names appear on cards; no new
global tokens or shared component edits were made. The reconciliation pages and AI proposal remain
untouched by this work.

Visual review covered revised light/dark mobile and desktop boards, Closed card scrolling, the
centered modal, standalone task pages, completed task details, color-filter results/empty recovery,
sort choices and both Unlocked directions. Task and relation rows fill their containers; clipped
mobile scroll bodies keep the footer reachable. Existing create, dependency and recovery flows
retain their original prototype targets except the filter-empty action now clears filters. Light and
dark mobile/desktop compositions were rendered using the existing Theme and Roadmap modes. Native
keyboard geometry is illustrative, and Graph
lighting remains the existing static component approximation. No browser implementation, live
prototype user test, remote deployment or telemetry-arrival claim is made.

The simplification pass removed category totals, written card color labels, the duplicate filter
row and the superseded sidebar. It consolidates card descriptions and quick controls in local
components, keeps dependency cues and overall progress, and uses direct mobile task pages.
Reuse one derived-category selector and one responsive task editor when implementing; avoid
persisting a second status model.

Revision evidence, screenshots and the card/node audit are in `/tmp/roadmap-board-revision/`. The
proposal is tracked by `roadmap-board-design-20261024`; this revision is tracked by
`roadmap-board-card-clarity-20261024`. Prototype links cover representative fixture paths; they do
not simulate arbitrary filter combinations, persisted date history or every sort choice.
