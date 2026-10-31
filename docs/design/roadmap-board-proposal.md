# Roadmap Board proposal

Status: 💡 awaiting human approval. No Board flow is Ready for dev. The production Graph and List
canon stays on the Roadmap file's Web and Web Mobile pages. The [review](roadmap-board-review.md)
holds the rulings, the findings and the limits.

Drawn on two pages of the Roadmap file:
[💡 Board · Web Mobile](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900) (below
744px) and [💡 Board · Web](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901)
(744px and up). Start at the [phone Board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433)
and the [desktop Board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543).
Every board carries 💡. Desktop boards come in light and dark pairs; phone dark specimens sit in
their sections and in section 19.

## The idea

A board for doing, a graph for seeing. The Board answers *what can I do right now*; the Graph shows
shape and distance. Both read one roadmap and one model. On phones the Board replaces the List.

## Model

- Every step is one card, the root included. Edges are prerequisites. A step's colour is its kind.
- The three columns are derived, never chosen. This must be true, as `model/UnlockRules.js` derives
  it: a completed step is **Done**; an unfinished step whose prerequisites are all complete is
  **Up next** (no prerequisites counts); every other step is **Locked**. Completion wins.
- Nothing is dragged. No assignees, deadlines or new status field.
- **Steps left.** A Locked step's distance is the count of unfinished steps in its transitive
  prerequisite closure. The card says *Needs Read the wind · 1 to go*; with several missing direct
  prerequisites, *Needs Sail a triangle +1 · 4 to go*. The step page and modal use the same number.
  No other count of the same distance appears.
- **Unlocks.** An Up next card names the step that completing it moves to Up next:
  *Unlocks Leave the dock*. A card that would move nothing has no reason line.
- **Reset** changes only that step. Its unfinished dependents regroup; completed descendants stay
  Done, as `model/progress.js` keeps them.
- **Subtasks never complete a step.** When the last subtask is checked, the page or modal offers
  *All subtasks done · Complete step*, one tap, never automatic.
- **Roadmap order** is the default for Locked and Up next: fewest steps to go first, then most
  unlocks. Done lists the most recently completed first.
- **Kind names travel with colour.** Controls use the legend label (Build, Learn, Milestone); a hue
  name appears only for an unnamed hue (Sky). *Filter by kind*, never by colour.
- **Numbers.** From 744px, full numbers with thousands separators (3,200). Phones abbreviate from
  1,000 (1.8k) on the segments and the progress figure only.

## Layout by band

| Band | Board | Verbs | Filter | Step | Picker |
|---|---|---|---|---|---|
| Phone, below 744 | One column; identity top, controls in the bottom band | Title-tap roadmap sheet | Filter sheet | Pushed page | Full screen |
| Tablet, 744–1023 | Two columns plus a rail | Compact icon row | Inline strip | Modal, 680 | Anchored panel |
| Desktop, 1024 and up | Three columns | Full row | Inline strip | Modal, 760 | Anchored panel |

**Phone.** Identity: roadmap title, progress, Board/Graph switch. The bottom band holds the
segments with counts (*Locked 3 · Up next 2 · Done 3*), Sort, *Find a step*, Filter and a 44px
New step. Tapping a segment changes column; there is no column swipe, because the card swipe owns
horizontal drags. Tapping the title opens the roadmap sheet: Ask AI, Share, Export, Settings. Owners
land on Board, visitors on Graph.

**Tablet.** Locked and Up next take the columns; Done folds into a rail of stacked cards with
*Show*. Showing a rail swaps which column folds (05.02, 05.03).

**Desktop.** Columns run in flow order, **Locked · Up next · Done**. Up next is weighted: a tinted
column, an accent dot and a filled count. Each heading carries its count. The verbs row holds
*Find a step* (`/`), *Ask AI* (⌘K), Share, **New step** and More (Export, Settings, Keyboard
shortcuts). The filter strip holds *All* and one chip per used kind, with *Roadmap order* on the
right. Graph wears the same row and adds **Next · N** with a compass glyph, never a bell or a badge.
Next · N lives on Graph only; on the Board the Up next column is its answer.

Every surface lands visitors on Graph, the Board one tap away. A desktop reader's Board is the
switched-to state.

## Cards

- A 4px kind rail on the leading edge, a neutral border, the title, the reason line, and a two-line
  excerpt of the authored description on every card at every size. Done cards have no reason line.
- Locked cards sit at the dimmed tier. No trailing glyph; every card opens its step.
- Card states are drawn on the state sheets, light and dark (353:5571, 353:5686), with the 320px
  truncation specimen (353:5801). Focus is a 2px `:focus-visible` ring with 2px offset in the brand colour.
- Accessible names: the view switch is a two-option group named *View* with `aria-pressed` on the
  active option; *3/8* reads *3 of 8 steps done*; a heading reads *Up next, 2 steps*.

## Step page and modal

- Phone: a pushed page. Desktop: a URL-addressable modal. Tabs sit under the title: Overview,
  Workspace, History. Actions are pinned at the bottom.
- Overview: description, status row with a leading glyph, step links, Prerequisites (*1 / 1*),
  Unlocks, *View branch*.
- Up next: *Edit step* and the primary **Complete**. Locked: *Locked · 1 to go*, the unfinished
  prerequisite row marked with its state, *Edit step* only. Done: *Edit step* and a secondary
  **Reset**.
- **Complete and Reset stay in place.** The status row flips with an inline **Undo** that lasts the
  hold window; a secondary line names the outcome. No toast from a page or a modal. Reset is always
  secondary and quiet.
- The `…` menu holds the same three verbs on both pages: *Copy link · Open in Graph · Delete step*.
- **Delete step:** a confirm with the cost line from `ui/mobile/editorSheet.js`
  (*Removes this step · 1 branch resplices*), then a delete held for nine seconds with Undo, as
  `guidelines/system-architecture.md` §3 requires on the web, then the regrouped Board.
- A step pushed from a step names the previous screen in its back label.
- A shared step link lands everyone on the Board with that step open: the modal on desktop, the
  pushed page on phones. A reader sees Overview and History, a link icon, and no workspace.
- Workspace: subtasks, the note and personal links. The note editor commits with **Save**; *Done*
  is a state word.

## Acting from the Board

Toasts come only from actions taken on the Board itself: swipe, keyboard **C**, bulk, create and
delete. The toast text is tappable and reveals the card. A step that arrives in Up next wakes once
(*Arrived*: fade, scale 1→1.02→1, a settling ring) and carries no persistent badge.

**Swipe to complete (phone, Up next cards only).** The card sets `touch-action: pan-y`. A leading
swipe claims the drag after 10px within 30° of horizontal, tracks 1:1 to 96px, then resists at
0.35×. Released past 96px it settles open; short of it, closed. A full swipe never commits: only a
tap on Complete does. One light haptic tick at 96px where the browser supports it. The action is a
real button after the card link in DOM order; Tab focus reveals it. Reduced motion keeps direct
tracking and turns removal and entrance into 150ms cross-fades. Spec: 379:17279.

**Select several (phone).** Long-press a card to enter selection. The bottom bar carries the shipped
`ui/mobile/BulkBar.jsx` verbs: the count with Done beside it, then **Recolor** and *Delete N steps*
at equal width, so the destructive action is never the widest target. Recolor reveals the kind
swatches.

**Keyboard (desktop).** The Board is one tab stop with roving focus; first focus lands on the first
Up next card. ↑ ↓ move within a column; ← → move to the neighbouring column at the nearest height,
skipping an empty one. ⏎ opens the step; esc closes it and returns focus to its card. **C**
completes the focused Up next card, and focus follows it to Done; C does nothing on Locked or Done.
⌫ deletes, held nine seconds with Undo. **G** switches Board and Graph. `/` focuses *Find a step*;
⌘K stays Ask AI. Locked and Done cards stay focusable.

**Motion.** Complete is a full bloom; the newly up-next step wakes; the toast speaks last, 120ms
after the last beat, and holds 6s with Undo. A second completion inside the hold coalesces into one
toast. Downward changes are a silent 280ms dim with no toast. The live region announces the done
step and how many steps are up next.

## Find, filter and sort

- *Find a step* searches every column. Empty: **No steps match
  "astronomy"** with **Clear search**, and for the owner **New step "astronomy"**.
- Filter by kind combines kinds with OR across all columns. Progress never changes with a filter. A
  roadmap with one kind shows no filter.
- Sort: **Roadmap order** (default), then **Created**, newest or oldest, within each column. A
  non-default order puts a dot on the phone's Sort control and a removable chip (*Created · newest*)
  above the column.
- **Done collapse.** Above 12 cards Done shows the 12 most recently completed, newest first, then
  *Show all 3,200*. The expanded list is newest completed first. A caption says so once per page.
- **View branch** scopes the Board to the step, every transitive ancestor and every descendant.
  Siblings drop out. Availability still reads the whole roadmap, and so does progress. The branch
  chip (*Branch · Read the wind ×*) clears only the scope; an empty intersection offers a specific
  recovery and keeps the scope.

## Create and edit

- **New step** is always visible: the plus in the phone band, the button in the desktop verbs row,
  the primary on an empty roadmap.
- Fields: Name (required), Description (optional), Kind, Prerequisites, and a read-only placement
  preview (*Locked · Read the wind isn't done*). No column selector. Commit **Create step** or
  **Save**; Cancel.
- Kind offers six choices inline: the legend kinds by name and the unnamed hues by hue name (Build,
  Learn, Milestone, Brick, Sky, Plum). A choice changes only the draft.
- The prerequisite picker shows each candidate's state, groups steps that cannot be prerequisites
  (*Comes after this step*), keeps the selection across queries in a chip strip, and enables Apply
  only when the draft changes. It writes nothing; the form's commit does. Phone: search sits above
  the keyboard; the keyboard rises only when the roadmap is large. Desktop and tablet: an anchored
  panel with search on top, chips under it, results below, Cancel and Apply at the bottom, the draft
  still visible.
- Title collisions are told apart by context: *after Tidal streams*, or *a starting step*. No IDs
  appear anywhere.
- Success returns to the step's derived column, scrolls it into view and highlights it. A filter
  that would hide it clears, and the toast says so.
- A failed save keeps the draft: **Retry** · **Keep editing**. Cancel with changes asks
  **Discard draft?** once.

## Large roadmaps

This must be true for 5,000 steps:

- Each column scrolls on its own; its heading stays pinned and shows a divider once scrolled.
- Render the visible window plus 10 cards of overscan per column. Card height is measured, not
  assumed (72–122px).
- Counts come from the model, never from rendered rows. Search and kind filters run on the model
  before the window.
- Each column keeps its scroll offset across Board ⇄ Graph, the modal and regroup ceremonies.
- Budget: 5,000 steps open the Board in under 1s on a mid laptop; scrolling holds 60fps.

## Strings

One string per event.

| Event | Copy |
|---|---|
| Complete from Board, unlocks one | *Read the wind done · Leave the dock up next* · **Undo** |
| Complete from Board, unlocks n>1 | *Read the wind done · 2 up next* · **Undo** |
| Complete from Board, unlocks none | *Read the wind done* · **Undo** |
| Complete on page or modal (secondary line) | *Leave the dock is up next* / *2 steps up next* / omitted |
| Reset on page or modal (secondary line) | *2 steps locked again* / omitted. No toast. |
| Reset preview before tapping | *Reset returns 2 steps to Locked* |
| Create | *Reefing basics added · Locked* · **Undo**; when a filter clears: *Reefing basics added · filter cleared* · **Undo** |
| Delete (held) | *Rig the boat deleted* · **Undo**; the confirm's cost line carries the resplice count |
| Bulk | *3 steps recolored* · **Undo** / *3 steps deleted* · **Undo** |
| Checklist item | *Try a small turn checked* · **Undo** |
| Copy link | *Link copied* |
| Not-done precondition | *Read the wind isn't done* |
| Empty roadmap | **Your first step** / *Give your roadmap a place to start.* / **New step** |
| Roadmap complete | **All 8 steps done** / *Add a step whenever you're ready.* / owner secondary **Share it** |
| Loading | Skeletons, no copy |
| Load error | **Couldn't load this roadmap** / *It may have moved, or the server is unreachable.* / **Try again** |
| Save failure | *Couldn't save. Your draft is kept.* / **Retry** · **Keep editing** |
| Discard confirm | **Discard draft?** / *Your changes will be lost.* / **Keep editing** · **Discard** |
| Filtered empty | **No steps match** / **Clear filters** |
| Search empty | **No steps match "astronomy"** / **Clear search** · owner **New step "astronomy"** |
| Pending sync | In the identity row: *Saving…* → *Saved*; offline *Offline · changes will sync* |
| Refused sync | *Couldn't sync this change.* / **Retry** · **Discard change** |
| Anonymous owner | *Saved on this device — sign in to keep it* |
| Lapsed session | *Signed out — saved on this device* (shipped, `SkillTreeView.jsx`) |
| Retry verb | **Try again** for a load, **Retry** for a failed write |

## Fixtures

**Learn to sail**, eight steps; the title is not a step. Initial state: 3 Done · 2 Up next ·
3 Locked, progress 3/8.

| Step | Prerequisites | Kind | Column | Description |
|---|---|---|---|---|
| Choose a sailing course | — | Build | Done | Book a beginner course with time on the water. |
| Name the boat parts | Choose a sailing course | Sky | Done | Identify the mast, boom, hull and rudder. |
| Rig the boat | Name the boat parts | Build | Done | Set the sails and check the boat before launch. |
| Tie a bowline | Name the boat parts | Learn | Up next | Tie a secure loop that is easy to undo. |
| Read the wind | Name the boat parts | Sky | Up next | Learn to spot shifts in wind direction. |
| Leave the dock | Rig the boat; Read the wind | Build | Locked · 1 to go | Cast off safely and steer clear of the dock. |
| Sail a triangle | Leave the dock | Learn | Locked · 2 to go | Practise reaching, tacking and returning to start. |
| Sail solo | Sail a triangle; Tie a bowline | Milestone | Locked · 4 to go | Plan and sail a short route on your own. |

- Completing Read the wind: 4/8. Leave the dock moves to Up next; Sail a triangle needs Leave the
  dock · 1 to go; Sail solo needs Sail a triangle +1 · 3 to go.
- Resetting Name the boat parts from the initial state: 2 Done · 1 Up next · 5 Locked; Rig the boat
  stays Done.
- Creating *Reefing basics* (*How to reduce sail area safely in stronger wind.*) with Read the wind
  as its prerequisite: Locked, *Needs Read the wind · 1 to go*, progress 3/9.
- Filtering Milestone leaves Sail solo in Locked and Up next empty. Sky shows Read the wind in Up
  next and Name the boat parts in Done. Progress stays 3/8.
- The Read the wind branch holds six steps: Read the wind, Choose a sailing course, Name the boat
  parts, Leave the dock, Sail a triangle, Sail solo. Rig the boat and Tie a bowline drop out.
- Created dates, synthetic and UTC: Tie a bowline 2026-10-22 10:00; Read the wind 2026-10-21 10:00;
  the other six share one import time, 2026-10-20 09:00. *Created · newest* shows Tie a bowline
  before Read the wind.

**Coastal navigation handbook**, 5,000 steps: 1,770 Locked · 30 Up next · 3,200 Done. Every
visible card must be internally consistent: a Locked card whose named prerequisite sits in Up next counts
it in its *N to go*. The picker walkthrough edits *Plan a coastal passage*. A large-fixture header
never sits above eight-step columns.

## Data prerequisites

- **Created sort** needs an immutable per-roadmap creation time: the first addition of the step to
  this roadmap, assigned on create, import and fork, unchanged by rename, edit, completion, reset or
  restore. Nothing stores that today. `sync/lattice.js` exposes `createdAt` from the CRDT add-life
  stamp; `sync/materialize.js` gives a pasted subgraph one shared stamp and writes a fresh
  `createdAt` on `ResurrectNode`. Unknown dates sort last in both directions; ties keep stable order,
  then stable ID. Never infer a date.
- **Unlocked sort** stays out until `unlockedAt` persists. `model/UnlockRules.js` derives present
  eligibility only.
- **Done order** reads `completedAt`, which `model/progress.js` records per step.
- **Creation** must be one intent for the step and all its prerequisite edges, with an idempotent
  retry. `CreateNode` in `backend/products/roadmap/domain/Command.h` carries `prerequisites` and
  `description`; the web `CreateNode` in `sync/materialize.js` writes a single `parentId` edge.
- Shipped behaviour the proposal changes is in the [consistency ledger](consistency.md#roadmap).

## Section index

Web Mobile ([page](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-900)):

| Section | Entry board |
|---|---|
| [00 · Board proposal · awaiting review](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-902) | [Proposal direction](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1424) |
| [01 · Choose, inspect, complete](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-903) | [01.01 · Up next](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-1433) |
| [02 · Create, edit, connect](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-904) | [02.01 · New step · blank](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-1631) |
| [03 · Empty, loading, recovery](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-905) | [03.01 · Empty roadmap](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-2149) |
| [04 · Graph handoff and contexts](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-1524) | [04.01 · Graph handoff](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=188-1528) |
| [05 · Filter and sort](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=209-2396) | [05.01 · Kind filter active](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=209-2397) |
| [06 · Create a step](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=226-602) | [06.01 · New step · prerequisites](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=226-603) |
| [07 · Step workspace and history](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-964) | [07.01 · Step workspace](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=228-994) |
| [09 · Exploration and narrow-width stress](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-4895) | [09.01 · 320px · large-roadmap exploration](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-4899) |
| [10 · Find prerequisites · 5,000-step fixture](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=258-4749) | [10.01 · Parent draft · large roadmap](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=381-8819) |
| [12 · Review repairs · dark navigation](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-8779) | [12.01 · Graph handoff · dark](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=276-8780) |
| [14 · Explore a branch](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=292-8701) | [14.01 · Branch · Up next](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=292-8702) |
| [15 · Step long content](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-10081) | [15.01 · Step long content · 390px](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-10082) |
| [16 · Format a note](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=324-5158) | [16.01 · Select text](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=324-5159) |
| [17 · Swipe to complete](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=378-16260) | [17.01 · Swipe in progress](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=378-16261) |
| [18 · Many steps · 5,000-step fixture](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=379-18852) | [18.01 · Up next 30 · top](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=379-18853) |
| [19 · Dark and 320px · new states](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=383-18664) | [01.05 · Step page · done · dark](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=383-18665) |
| [20 · Delete a step](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=397-28207) | [20.01 · Rig the boat · step menu](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=397-28208) |
| [21 · Select several steps](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=398-28881) | [21.01 · Long-press selects](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=398-28882) |
| [Later · Activity overlay](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=360-10601) | Out of the first wave; nothing routes into it |

Phone components: [Board · Proposal components](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-906),
[Shared Shell](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=290-7056),
[Kind choice](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=306-4751),
[Note editor](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=321-5044),
[Step card, kind swatch, sort menu](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=351-5571),
[Phase B components](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=369-10008).

Web ([page](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=183-901)):

| Section | Entry board |
|---|---|
| [01 · Board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1542) | [01.01 · Board](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1543) |
| [02 · Core loop](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=374-4540) | [02.01 · Complete in modal · outcome](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=395-26357) |
| [03 · Step detail](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=208-355) | [03.01 · Step modal](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=184-1693) |
| [04 · Signed out and shared](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=376-12774) | [04.01 · Visitor lands on Graph](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=398-29648) |
| [05 · Responsive](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=377-14651) | [05.01 · 1024 · three columns](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=377-14652) |
| [06 · Large roadmaps](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=379-8923) | [06.01 · 1,770 Locked · 30 Up next · Done collapsed](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=399-32785) |
| [07 · Find, filter and sort](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=387-26773) | [07.01 · Kind filter](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=210-363) |
| [08 · Roadmap verbs](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=260-5150) | [08.01 · More · 1440](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=380-19606) |
| [09 · Create steps](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-1086) | [09.01 · Empty roadmap](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=232-1688) |
| [10 · Keyboard](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=386-13311) | [10.01 · Focus traversal](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=386-13312) |
| [11 · Explore a branch](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-8978) | [11.01 · Branch board · Read the wind](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=294-8979) |
| [Later · Activity overlay](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=246-3690) | Out of the first wave; nothing routes into it |

Desktop components: [Board · Desktop components](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=367-10089).
