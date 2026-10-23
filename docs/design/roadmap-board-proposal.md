# Roadmap Board proposal

Status: 💡 proposal awaiting human approval, 2026-10-24. No production code is changed and no Board
flow is Ready for dev. Current Graph/List reconciliation remains on the existing Web and Web Mobile
pages.

Design lives on separate [Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900) and [Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901)
proposal pages. Start with the [mobile board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433) and
[desktop board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543). The pages contain 22 mobile screens and three desktop screens.

## Behavior

- Every existing node is one task, including roots. Edges are prerequisites; one existing kind/color
  becomes one color tag. Labels accompany color. No assignees, deadlines or new task-status field.
- Completed tasks are Done. Incomplete tasks with every prerequisite complete are Up next; the
  remaining tasks are Backlog. No prerequisites means Up next. These are the current
  `model/UnlockRules.js` rules, with completion taking precedence.
- Up next is the initial mobile column. Desktop orders Backlog, Up next, Done. Existing stable task
  order is preserved within each category. Dragging never changes status or dependencies.
- Cards open details. Complete and Reset live in the pinned action band. Backlog details name the
  missing prerequisite and open it. Needs and Unlocks show each related task's actual state.
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
on desktop. It introduces a task composer, the same compact detail/editor on both widths, and
reachable mobile actions. Notes use the existing personal node workspace; authored descriptions and
links remain distinct. Search spans all categories; the Gold example shows a proposed tag-filter
empty state. Existing roadmap and task overflow actions continue to use their current canon.

## Shared fixture

Roadmap title: Learn to sail. The title is not an extra task. The eight task nodes are:

| Task | Needs | Color | Initial category |
|---|---|---|---|
| Choose a sailing course | — | Terracotta | Done |
| Name the boat parts | Choose a sailing course | Sky | Done |
| Rig the boat | Name the boat parts | Terracotta | Done |
| Tie a bowline | Name the boat parts | Olive | Up next |
| Read the wind | Name the boat parts | Sky | Up next |
| Leave the dock | Rig the boat; Read the wind | Terracotta | Backlog |
| Sail a triangle | Leave the dock | Olive | Backlog |
| Sail solo | Sail a triangle; Tie a bowline | Gold | Backlog |

Initial counts are 3 Done, 2 Up next, 3 Backlog. Completing Read the wind yields 4/2/2; Leave the dock
becomes ready. Resetting Name the boat parts from the initial state yields 2/1/5; Rig the boat remains
Done. The draft Practise reefing is not yet counted. Filtering Gold leaves one Backlog task and no
Up next or Done tasks; the overall roadmap progress remains 3/8.

## Responsive and interaction contract

Below 744px, show one full-width column with 16px outer padding. At 744–1023px, keep one focused
column up to 680px wide. At 1024px and above, show three equal columns of at least 280px, with 24px
gaps and 32–48px outer padding; details use a 440px side panel. Mobile details fill the viewport.

Column tabs and primary actions stay above the bottom safe area. Actions are 56px high and secondary
targets are at least 44px. The active input and commit action remain visible above the keyboard.
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
| 01.02 · Backlog | [183:1503](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1503) |
| 01.03 · Done | [183:1589](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1589) |
| 01.04 · Available task | [183:1672](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1672) |
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

| Desktop screen | Figma |
|---|---|
| 01.01 · Desktop board | [184:1543](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543) |
| 01.02 · Desktop task details | [184:1693](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1693) |
| 02.01 · Dark desktop board | [193:1494](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=193-1494) |

Prototype starts: [Mobile](https://www.figma.com/proto/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433&page-id=183%3A900&starting-point-node-id=183%3A1433)
and [Desktop](https://www.figma.com/proto/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543&page-id=183%3A901&starting-point-node-id=184%3A1543).
The prototype connects representative inspect, complete, reset/Undo, editor, dependency, tag,
recovery and Graph paths. It is a fixture walkthrough, not a functional app; outcome screens do not
link to contradictory pre-change counts, and data-entry commits remain static where no result is drawn.

## Validation and limits

All 25 screens are native editable Figma layers, with zero image fills. The proposal reuses the
published Windmill Button, shared semantic/spacing/radius variables, Nunito/Baloo type and existing
Skill Node components. One proposal-local Task card family carries three state variants; no new
global tokens or shared component edits were made. The reconciliation pages and AI proposal remain
untouched by this work.

Visual review covered the main mobile and desktop compositions, details, dependency cycle refusal,
completion, reset, create/keyboard and recovery screens. Programmatic checks found no text or
instance outside the 844px mobile frames. The Done detail scroll body was tightened to keep its
consequence message above the footer. Light and dark mobile/desktop compositions were rendered
using the existing Theme and Roadmap modes. Native keyboard geometry is illustrative, and Graph
lighting remains the existing static component approximation. No browser implementation, live
prototype user test, remote deployment or telemetry-arrival claim is made.

The simplification pass removed redundant ready text and inline completion controls, moved Undo
into the thumb band, and made dependency status explicit. Reuse one derived-category selector and
one responsive task editor when implementing; avoid persisting a second status model.

Review evidence and the complete node inventory are in `/tmp/roadmap-board-proposal/`. The proposal
is tracked by dogfood node `roadmap-board-design-20261024`.
