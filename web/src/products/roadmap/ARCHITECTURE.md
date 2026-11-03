# Roadmap web architecture

Roadmap renders a DAG of steps on a hand-rolled WebGL2 canvas. React owns UI and lifecycle;
pure models own graph rules and layout. Tree writes are owner-only; another account can view a
shared tree and fork it. The shell mounts the product through `routes.js` and its registry;
`showcase.js` is the only entry point for the component showcase.

## Data flow

`SkillTreeView.jsx` loads a tree through `HttpTreeRepository` or the account's device fallback,
constructs `SkillTree`, derives progress through `UnlockRules`, runs layout and installs the render
model in `SkillTreeScene`. Layout is synchronous and cached by graph structure, effective engine
and, for caption-aware engines, labels.

After load, `SyncSession` owns the durable lattice. Both local gestures and remote frames produce
a projection through `syncStructure()` and `scene.applyModel`. `TreeEditor` holds that current
projection; undo/redo belongs to `SyncSession` and reissues inverse gestures with fresh stamps.

A saved camera is scoped to its layout engine and format. Without one, an owner opens at working
zoom over the frontier; a visitor receives the whole-tree fit and arrival ceremony. The initial
owner view reframes as chrome measurements arrive until the reader moves the camera.

With the Board gate closed, phones open owners on the outline List and visitors on the canvas; a
saved choice wins, and an empty or just-planted tree opens on the canvas. `board/gate.js` keeps the
Board closed in production; off production, localStorage `windmill:board:dev` set to `1` opens it.
With the gate open, `initialView` in `persistence/ViewPrefs.js` chooses the view: an owner's empty
roadmap opens on the Board on every band. A non-empty just-planted roadmap opens on the Graph;
otherwise a step link selects the Board, then a saved choice wins, then owners default to the Board
and visitors to the Graph. The selected step carries across views. With the gate open, the host mounts one
`RoadmapIdentity` above both layers for every non-demo role and band. The row persists across switches.
The demo keeps its existing chrome. While the Board awaits its roadmap, the row names no title or
progress and offers no Share; after a failed load it offers no switch. From 744px, `/` focuses
*Find a step* on either view and G switches Board and Graph for owners and readers. A non-empty
Graph search hands off to the Board with its query and field focus kept. The demo Board
resolves `/` from its own header. Ask AI keeps ⌘K.
Graph selection shortcuts do not act on the Board. C completes a focused Up next card; Backspace and Delete
start a nine-second held delete on a deletable owner card, without a confirm. `boardKey` in
`shortcuts/shortcutMap.js` owns these keys and their shared typing and covered-layer refusal: a step
open over the Board, a dialog or the composer prevents them from acting. With the gate open, the
host also refuses paste, global Undo/Redo and shortcut help while that layer covers it, including
the composer’s picker. An uncovered Board still shares the session’s global keyboard Undo stack.

`useRoadmapIdentityActs.js` owns the identity query handoff, read models and verbs that route to
the existing Share, Fork, TendBar and shortcuts surfaces. Each surface restores its own opener:
Dialog and the gated TendBar/Fork sheet share `useDialogFocus`; the composer uses
`useComposerFocus`. Gated restores leave an intentional focus target outside the surface alone.
More and the roadmap sheet close and focus their surviving trigger before invoking a verb. From
1280px Find and Ask AI have their full forms; 1024–1279px folds them to icons, and 744–1023px
puts Ask AI and Share in More. Phone owners open the roadmap sheet from the title. Its current
row comes from the host projection, with `sheet.current.upNext` and `locked` from the same
unfiltered Board model as Next. At 1,000 or more total steps, the sheet uses `exactProgress` when
both state counts are supplied; otherwise it uses the truthful done/total `progressLabel`.
The remaining roadmaps come from `listAllTrees`; navigation
uses the existing roadmap, new-roadmap and browse routes. Readers never receive the owner sheet.
Identity menus share keyboard and outside-dismiss rules through `BoardControls`. `TreeSwitcher`
owns its identity variant, and `theme.js` owns the DOM kind-hue fallback used by the row, sheet,
cards and List.
Export builds one Markdown file through `serializePlan` and `fileNameFor` in `exportArchive.js`,
using the same download edge as the settings archive. The paste format uses the roadmap title
as the root: a distinct root-step label and its completion are not preserved. Other exported
steps retain their completion marks. Settings exports all roadmaps as a zip.

On the gated Graph, the owner's Next chip reads the unfiltered `Board.upNext` in Roadmap order,
including a one-step roadmap, and hides at zero. Picking a row selects and reveals that canvas
step. Activity remains available through A; the feed never opens itself while identity is mounted.
From 744px the Graph camera controls form a bottom-right pill whose viewport block clears the
dock or tablet panel. Phone camera controls keep their shipped form beneath the measured row.
The identity replaces the plaque, wordmark and hairline, and only phones retain the Fork pill.
The anonymous/lapsed desktop status sits beneath the measured identity. On the phone and tablet
Graph, the existing device-only sign-in nudge sits beneath the row; the phone camera clears it,
and its measured bottom contributes to the Graph viewport. A row render failure reports
`roadmap-identity` and mounts legacy chrome with a view switch. Fallback chrome and switch
measurements feed the switch position and Board inset; their browser geometry remains an open
verification issue below. Gate-closed chrome, feed auto-open, shortcuts and viewport geometry
retain their existing paths; state words use `board/copy.js` without changing ceremony structure
or timing.

`SkillTreeView` owns the Board's query (`BoardQuery` in `board/Board.js`): the sort, the kinds on, the search text and the
branch in scope. It lasts the visit: leaving the roadmap or reloading starts it over, and nothing is stored. `viewBranch`
scopes the Board to a step, every ancestor and every descendant; availability and progress still read the whole roadmap.
Kinds narrow only among the kinds a roadmap wears (`kindOptions` in `model/Legend.js`), so a roadmap wearing one kind
shows no filter and a kind with no control left hides nothing. From 744px a strip over the columns holds the branch
scope, All and one named swatch per kind, and the sort menu (Roadmap order, or Created newest or oldest, for Locked and
Up next; Done keeps its newest completions); *Find a step* rides the host's identity row from 744px
(`board/BoardControls.jsx`). On phones the band's first row adds Sort beside the tabs and its second holds
*Find a step* and Filter, each of Sort and Filter opening a sheet; the branch scope and a removable chip per kind on and
for a non-default order sit over the panes, and Sort and Filter wear a dot while they narrow. A branch scope opens its
step's column, and its title selects that step and brings its card into view without opening it. All also drops a kind
no swatch offers any more, so it cannot come back on its own. A column the query emptied
names its way out: *Clear search*, *Clear filters* (the kinds; the branch clears only on its own) or *Clear both*; from
744px, when every column is empty, only Up next says so. A control the query took away hands focus to the columns' tab
stop.

From 1024px the Board stands Locked, Up next and Done side by side, each column scrolling under its
sticky heading and starting just under the identity row, whose measured bottom feeds the Board's
top inset on every band. From 744px to 1023px one side column folds to a rail, Done first; Show swaps which
one, and Up next never folds (`columnStage` in `BoardColumns.jsx`). Phones show one column at a time
behind Locked · Up next · Done tabs in a bottom band (`PhoneSegments.jsx`). No band draws the action
lane while the identity row is mounted; a phone reader's Fork pill lifts the columns and the band clear of it. Shown with a step
selected, the Board opens that step's column (its tab, past the Done fold, or out of the rail) and
scrolls its card into view. The layer stays mounted across Board/Graph switches, so each column keeps
its scroll there. Crossing 744px rebuilds the columns, and a column that folds to a rail starts at the
top when it stands again.
While the Board is shown, `coverBeneath` in `composerFocus.js` makes everything stacked under its layer
inert, the Graph's overlays and legend included. The host identity sits above that layer and stays
operable; step detail, composer and sheet layers cover it. Covered elements remain inert until the
last covering layer closes.

Each column renders only the cards in view plus ten either side (`ColumnCards.jsx`), estimating an
unmeasured card's height from its text and the column's width, measuring each card as it renders and
standing a spacer in for every stretch it skips. It keeps the first card in view still as cards above it
settle, in place of the browser's scroll anchoring, which the columns turn off and WebKit lacks. The
roving stop and the selected step always render, so focus and a reveal reach them anywhere in the column.
Above twelve, Done folds to its twelve newest completions and a Show all row (`Board.shownCards`).
The columns are one tab stop with roving focus (`traversal.js`). A stop is a card, the Show all row or a
rail's Show. Tab enters on the stop last focused while it still stands, else the stop a column last
held (Up next's before the others'), else the first Up next card, else the first stop of any column. Up and
Down move within a column, Home and End to its ends, and Left and Right to the neighbouring column's
stop at the nearest height, skipping an empty column; a rail offers only its Show. Enter is the stop's
own button, so a card opens its step. A focused stop that unmounts hands focus to the new stop, and
after Try again focus rests on the skeleton until the roadmap loads. On phones each pane has a roving
card stop with the same Up, Down, Home and End; an empty pane itself takes focus. The tabs keep their
own arrow keys. C follows an accepted completion to the same step in Done without expanding the
column. A refused action creates no pending focus request. Deletion reads the current projected membership
and leaves focus recovery to the surviving stop, or the phone's column tab while regroup settles.

`regroup` in `Board.js` derives departures, moves and arrivals. One `useRegroup` in `BoardView`
coordinates displayed cards and counts across columns. Query and other changes with no movement
render their current Board immediately; only a moving regroup holds the previous Board. Desktop
completion fades the departing card after 150ms, closes its gap over 280ms, travels newly Up next
cards for 320ms and updates counts on arrival. Phone completion closes the gap over 280ms and wakes
the arriving card over 480ms. Toast entry follows the last beat by 120ms. Any pointer, wheel or key
fast-forwards within 150ms; reduced motion uses opacity without travel or scale. Columns keep their
scroll, and moving and pending cards remain rendered through virtualization. Undo, including inline
Undo of Reset, dims in place for 280ms without a wake. User focus or pointer interaction ends a card's
wake; programmatic reveal focus preserves it. Equivalent Board rerenders preserve the running quiet phase.

`gestures.js` owns the phone card's reveal-only swipe, independent of the List gesture. Only Up next
cards offer it. The card preserves vertical scrolling, leaves the OS edge alone, claims a horizontal
drag after 10px within 30 degrees, tracks to 96px and resists beyond it. Release settles open or closed
and never completes. A real Complete button follows the card in DOM order; Tab reveals it, and Escape
or leaving focus closes it. Crossing the threshold offers one 8ms haptic where supported.

On an active owner phone Board, a 500ms touch hold within 10px starts pane-scoped selection.
`HoldGesture` and `SwipeGesture` cancel each other on claim; scroll and pointer cancellation stop
the hold, and its release never opens a step. Holding survives unrelated renders; card callbacks
keep their identities. `BoardView` mounts `useStepSelection`, which owns selection, history and focus
transitions separately from the Graph/List multi-select. Its current immutable `StepSelection` reads
the filtered pane and permanently drops choices that leave it. `deletable` in `acts.js` is the one sole-root rule for selection, keyboard deletion
and the step menu.

Selection replaces the phone band with `BulkBar`: count and Done, optional six named kind radios,
then equal-width Recolor and Delete. `KindChoice follow={false}` moves focus with arrows and
applies only on activation. Re-picking the shared kind closes only the kinds row and keeps the
selection, without writing, toasting or emitting an acted selection end. Recolor again also keeps
the selection. Back and Escape close the kinds before ending selection.
Selection owns same-URL history entries, separate from step visits. Ending selection waits for its
history entries to close, then restores its starting card only when it belongs to the filtered,
displayed pane and is not leaving; otherwise
focus returns to the pane's tab. If the pane is replaced, focus lands on its state action or loading
stop. Losing ownership restores focus while the same Board remains active. Selection also ends on an act, an empty
prune, leaving the Board, losing ownership or changing roadmaps. There is no keyboard entry into
multi-select. Recolor dispatches one `BulkRecolor`; its six-second toast Undo reverts that exact
receipt with a quiet regroup. A refused recolor keeps the selection and kinds available; delayed
apply reads the current selection. Bulk Delete creates one held projection and releases one
`BulkDelete` after nine seconds; it asks no confirmation. Neither act clears the query.

A card opens its step (`StepDetail.jsx`): from 744px a modal over the scrimmed roadmap, 760px wide and 24px in from the
window below that; below 744px a page pushed over the Board, which stays mounted beneath it with its pane and scroll.
Crossing 744px swaps the frame inside the same layer. The open step rides the hash as `?step=<id>` (`stepAddress.js`).
Each step opened from a card or from another step is a history entry, so Back steps out one step at a time and the page's
back row names the screen it returns to; closing pops the whole visit, and a link lands owner and visitor alike on the
Board with that step open. A view reads a step only on its own roadmap's route, and once that roadmap has loaded without
the step, the step leaves the URL in place, so restoring it reopens nothing; with the gate closed the URL is never
touched. While open the layer makes everything beneath it inert and wraps Tab inside itself; Escape, wherever focus is,
closes the topmost editor or confirmation before the detail. Edit step opens the shared composer over the detail.
Workspace and History use `StepWorkspace.jsx`: named checkboxes, the shared note renderer, personal links and static
activity rows grouped through `ActivityLog`. The note editor keeps a local draft and saves once through workspace actions;
changed Cancel asks to discard. System Back and remote detail closure silently discard the unsaved note draft,
consistent with the edit composer's G9 policy. Neither editor adds a navigation guard. Formatting uses pure
`formatNote`; phone keyboard sizing follows the composer viewport. The editor keeps
source ranges from the shared renderer; each browser edit changes only its mapped source span, preserving untouched note bytes.
A phone subtask check offers an in-page Undo for six seconds; desktop checks stay quiet. Editor completion returns focus
to its opener; other disappearing controls recover to the status row or dialog. Closing returns focus to the card
the visit began on, or to the columns' tab stop once that card has gone (deleted, or outside the branch View branch
scoped). After a held delete, roving recovery uses current membership and skips the deleted card
even while regroup still displays it. On phones, if no surviving card is visible yet, focus rests
on the selected column tab until its stop appears; moving focus cancels that handoff. `StepFacts.js` reads the step off the
whole roadmap, whatever the Board filters: its column, its prerequisites and the steps it unlocks with their columns, what
Complete would open and how many steps Reset would lock. Complete and Reset act in place through the Graph's progress
writes and toast nothing: the status row flips with an inline Undo for six seconds and a line names what moved, and
hovering or focusing Reset previews what it returns to Locked. Undo puts back the step's mark with no ceremony or activity, but not its completion
time: the progress lattice dates every mark it sends, so an Undo of Reset completes the step at the Undo's time and it
heads Done. On the Workspace section, a step whose every subtask is checked offers Complete step, which returns to
the overview's status row; subtasks never complete it. The ⋯ menu copies the step's link (the roadmap's share address
plus its step) only while the roadmap is public or unlisted, opens the step in the Graph, and offers
Delete to an owner unless the step is the roadmap's sole root. That rule reads the projected tree.
Delete first confirms in an anchored desktop popover or phone sheet. Its cost line counts the step's
children through `acts.deletionCost`, matching the Graph and List; it does not count newly spliced edges.
Confirm closes the detail and creates a `HeldDelete`, with no structural write yet. For its nine-second
Undo window, every Board surface reads the held projection: cards, counts, identity, topbar, detail
and composer. `SkillTree.without` and eventual `BulkDelete` share `respliceEdges`. Board release also
retires the deleted steps' incident edges in that same stamped gesture, so those edges cannot raise
the legacy masked-work Restore offer after the hold or after a switch to Graph. Graph and List
delete gestures retain their existing output.

`useBoardActs` injects session, progress, query, clock, toast and boundary collaborators. It owns one
held delete, which releases once on toast expiry or replacement, view exit, roadmap change, owner
loss, unmount or pagehide. Undo cancels it without sending. An already-absent step or a not-ready
session is an expected no-op, not a Sentry Issue; an unexpected release error restores the projection
silently and reports `roadmap-board-delete` with stack frames.

The host owns one toast slot. `BoardToast` serves both the Board and the gated Graph. Board toasts
render inside `BoardView`, with a six-second Complete, Create or Recolor hold and nine-second Delete
hold. A gated Graph completion without a milestone offer has a six-second toast with Undo through
`restoreStep`; a milestone offer keeps its canvas ceremony. Graph-toast Undo attempts focus on
the action’s captured control when it remains connected and uncovered, then falls back to the
pressed view switch. Focus after unrelated row activity remains an open verification issue below.
Graph creation has receipt-based Undo, and a reader's copied link uses the same slot without Undo.
Leaving a view dismisses its toast.
Remote completions keep their announcements. Gate-closed Graph/List toasts keep their renderer and timing. Regroup delays only a new toast's entry: a visible toast and its Undo remain available during
later motion. Complete Undo restores that step's progress; Create Undo reverts its exact session
receipt, so later unrelated gestures remain. Newer toasts replace older ones, with no coalescing.
Complete toast text reveals the single newly Up next step, or the completed step when zero or several
unlock; Create reveals the new step. Reveal clears only query dimensions that hide its target and
preserves sort. Delete toast text is not tappable. Board completion keeps activity emits and skips
the Graph ceremony and milestone offer.
The owner's up next and done steps offer View branch, which closes the step and scopes the Board to its branch. A
visitor gets the overview and the menu without Delete. Owners get Edit step beside Complete or Reset, or alone while
locked; the phone Workspace action is Add note or Edit note. The host opens Edit step only from an owner's
open detail and keeps the composer mounted only while that detail still names an existing step.
`BoardComposer` in `useBoardActs.js` shares the host’s open, display and save guards.
`BoardActs.edit` refuses missing, self or descendant prerequisites, diffs valid requests against the
held projection, quiets regroup, dispatches one `EditNode`, and emits rename activity when the name changes.
A clean diff writes nothing.
The edit result carries no toast or targeted Undo.

The Board draws its own states (`BoardStates.jsx`). Until the roadmap arrives it stands wherever it
would open: the saved choice, or the owner's default anywhere but a share or the demo. While the roadmap
loads, skeleton cards hold the columns under the identity row and band, with no counts and no spinner.
A failed load says *Couldn't load this roadmap* with Try again, which reruns the load. With the gate
open, an owner's empty roadmap shows *Your first step* and New step on every band. Once every step
is done, Up next rests on Roadmap complete: the owner gets its body line, Share it and New step; a
reader gets the title alone.

New step in the identity row on Board or Graph, phone Board band, empty state or complete state
opens `StepComposer` through the gated host mount. Graph allows creation only; editing requires
an open Board detail. A view change closes the composer. Edit step uses the same form with an existing step baseline; a clean Save closes
without writing. `StepDraft` owns validation, dirty comparison and placement with the edited step
replaced in the tree. The picker changes only draft prerequisites until Save; it groups the step
and its descendants as unavailable, excludes them from match counts, and drops newly blocked
selections with a notice that lasts until the next search or toggle. Deleted prerequisites leave silently. The host dispatches one `CreateNode` with the request's stable id and
all prerequisite edges stamped together; edits send the full intended state through `onEdit` and
return quietly to the detail, without a toast. Failure keeps the draft and exact request for Retry. Successful creation reveals and
wakes the step in its derived column, clears only hiding query dimensions and offers targeted Undo
on the Board. On Graph, creation selects and reveals the step without changing Board filters.
The composer sits inside an error boundary reporting `roadmap-board-composer` and portals its layer
to `document.body`, covering the viewport independently of the shell's containing blocks. Identity
row creation uses the `verbs` door. At 1440px and wider,
the picker is anchored beside the form; below that it replaces the form inside the composer, as a
page in the 600px dialog from 744px and a full-screen page on phones. `StepComposer` owns picker
selection and query so resizing between these layouts preserves them. With zero candidates the
Prerequisites row stays focusable but cannot open the picker. The draft starts in Sky; Graph roots
start in the first legend kind. Layout and focus handling live in `StepComposer.jsx`,
`PrerequisitePicker.jsx`, `composerFocus.js`, `DiscardDraft.jsx` and `composer.css`; `composerFocus.js` owns shared layer
focus, viewport hooks and `coverBeneath`, the single rule for making covered layers inert; `StepDetail` owns
fallback focus within the detail. `boardFocusTarget` in `traversal.js` owns fallback targets on the displayed
Board, excluding covered, hidden and leaving elements. The shared `KindChoice` lives in
`BoardControls.jsx` with its styles in `controls.css`.

## Package map

| Area | Responsibility |
|---|---|
| `model/` | Graph validation, trunk selection, unlock rules, legend, workspace and spatial queries. |
| `board/` | Gated roadmap identity and Board UI: query/columns, regroup, held actions and targeted Undo, shared Graph/Board toast, card gestures, step detail, composer/picker, view switch and copy. |
| `layout/` | Deterministic layout engines behind `index.js`. |
| `scene/` | WebGL batches, camera, DOM overlays, picking and pointer tools. |
| `sync/` | Shared structure and private progress lattices, gesture materialization, socket and IndexedDB. |
| `persistence/` | HTTP repository, account tree registry and device preferences/ledgers. |
| `ui/`, `ui/tree/`, `ui/mobile/`, `list/` | Canvas chrome, step details, phone editing and the outline view. |
| `selection/`, `shortcuts/` | Multi-selection rules and the shared keyboard map. |
| `activity/`, `ceremony/`, `presence/` | Activity presentation, animation sequencing and remote cursors. |
| `paste/`, `quests/`, `demo/` | Import grammar/composition, authored starter trees and the playable demo. |
| `share/`, `browse/` | Publishing, portraits and the public gallery. |
| `tending/`, `reminders/`, `settings/` | AI assistance, reminder preferences and account data export. |
| `marketing/` | Product landing, metadata and self-playing scenes. |

## Domain and shared geometry

`SkillTree` validates the DAG, builds indexes and derives render nodes. `renderableGraph.js` supplies a
best-effort projection when replicated state contains cycles. `TrunkTree` chooses one primary
parent per node for layout: same-kind parents first, then depth and id; siblings retain their
fractional order and creation-stamp order.

`UnlockRules.derive` is the authority for locked, available and complete states; the same file
answers what a step still owes (`owedStepsOf` and `gateOf` for one step, `owedCounts` for every
step in one pass) and what completing it opens (`unlocksOf`). An edge inherits its source node's
state. Legend order lives in the lattice and is written by `ReorderKinds`;
`Legend`'s array operations also serve import drafts. Genesis kinds and stamps come from
`packages/api-contract/genesis.js`, checked by `vite.config.js`.

`theme.js` supplies WebGL's resolved light/dark palettes and shared geometry. Kind chooses hue;
progress chooses tier; structural form distinguishes linked, unnamed and unlinked nodes. Node
bodies, root/selection scale, zoom floors and caption dimensions must agree across shaders,
overlays and layout. `model/footprint.js` estimates disc-plus-caption bounds from label length,
without DOM measurement. Everything under `model/` is independent of React and WebGL.

## Layout

`layout/LayoutEngine.js` defines the layout contract and each engine's caption and reorder capabilities.
`pageLayoutEngine()` and `layoutTree()` serve the canvas, quest thumbnails and paste ghosts.
`?layout=` accepts `bubble`, `radial`, `rings` or `mindmap`. Unknown names use bubble. Radial is the
synchronous fallback for an alternative import or layout failure; failure of the fallback itself
propagates. The returned effective engine controls reorder gestures and saved-camera identity.

| Engine | Geometry | Reorder |
|---|---|---|
| Bubble, default | Child fans, footprint-aware subtree tucking and packed root islands. | Parent arc |
| Radial, fallback | Trunk-depth rings and subtree-sized angular wedges. | Ring |
| Rings | Caption-aware contour packing on depth rings, with separate root islands. | None |
| Mindmap | Tidy branches distributed across twelve directions. | None |

Engines are synchronous, stateless and deterministic. `readsCaptions` declares whether renaming
requires layout. Bubble's tuck has a deterministic work ceiling; an unfinished move is discarded,
leaving the remaining subtrees in their enclosing-circle positions. This ceiling covers the tuck,
not every phase or wall-clock latency. Marketing scenes use hand-placed coordinates.

## Renderer and UI

`SkillTreeScene` owns `Camera2D`, `NodeBatch`, `ConnectorBatch`, overlays, `CeremonyDirector` and
input tools. React supplies models, progress, selection and viewport insets. The continuous frame
loop advances camera/motion, repositions overlays and draws one node batch and one connector batch.
Theme changes update GPU and DOM colours together.

Captions are keyed by node id. `captionLayout.js` prioritizes selection, hover, family, landmarks
and available steps, avoiding chrome, labels, discs and ribbons. Selected and hovered labels stay
visible when collision-free space runs out. Distant glyphs use `IconAtlas`; close glyphs use a
64-slot DOM pool. `edgeCurve.js` supplies connector and caption-collision geometry.

Picking accepts the drawn disc; pointer/touch hit floors stop halfway to the nearest neighbour.
A crowded hit zooms into the group. `ui/viewport.js` supplies the camera and captions with both
edge insets and corner obstacles; content-sized chrome measures itself.

Keep these boundary rules when changing the renderer:

- Place overlays from the live camera and do not transition their per-frame CSS transforms.
- Keep `NodeBatch` glyph colour math aligned with `NodeOverlay`'s `glyphCssColor`.
- Caption visibility is `st-label--shown` and computed opacity/visibility, not `display` alone.
- Use `CeremonyDirector.busy()` for ceremony state: pausing rendering does not cancel its timers.
- GPU selection comes from `setSelectedSet(selectedIds)`. Mixed node/edge selections cannot be
  represented by the single-node projection; reconciliation uses `projectEdge`, not a pick action.

Settles update affected GPU ranges once per frame. Reduced motion freezes pulses and snaps growth.
Spatial queries scan stored nodes when traversing grid cells would cost more. These bounds do not
establish a frame-rate guarantee. The [capture rig](../../../scripts/roadmap-rig/APPARATUS.md)
checks settled pixels and DOM geometry; hardware-backed timing needs a separate run.

## Synchronization and storage

The [graph synchronization contract](../../../../docs/GRAPH_SYNC_DESIGN.md) defines the wire format,
coverage, acknowledgements and durability limits. Shared structure and private progress use one
socket and HLC clock but separate frames. Pending writes are derived from lattice state.
`materialize.js` turns each local gesture into stamped field writes; refusal handling uses machine
codes rather than error sentences. `EditNode` stamps the changed name, description, kind and
prerequisite edge additions/removals together, preserving the existing gestures’ encodings.

`SyncSession.dispatch(gesture, { captureFailures = false })` returns an opaque receipt or null when
nothing applies. `revert(receipt)` restamps that captured inverse once and removes it from the global
Undo stack. Board structural actions opt into `captureFailures: true`: notification, persistence or
transport exceptions after the lattice join report static `roadmap-sync-notify`, `roadmap-sync-persist`
or `roadmap-sync-send` operations with stack frames, while the applied write retains its receipt.
Persistence and transport failures mark durability at risk. A failed pre-apply dispatch still throws.
Legacy callers retain their default exception behavior while the Board remains gated. `rb-simplify`
owns bringing all callers under one failure-containment policy when gate parity permits it.

Each projected step carries `createdMs`, the wall time of its add stamp: when it joined this tree.
Create and import stamp it, a fork re-adds every step at the fork, and edits never touch it. A
genesis seed reads `null`, unknown. A restore re-adds the step with a fresh stamp, so its
`createdMs` becomes the time of the restore.

`SyncStore` saves `{frame, progress, lastSeq}` in one IndexedDB record with transactional read-join-put.
Coverage is rebuilt on subscribe. Saves are queued before sending, but not awaited; transaction
failures are swallowed by the store's queue. Do not treat an in-memory edit as confirmed durable.

`LocalTreeRegistry` associates device trees with accounts, and device reads require identity
confirmed on this document load. A remembered face does not authorize a store read.
`ProgressStore.drainInto` migrates older local marks into the private lane. Displayed completion
dates use the server's `markedAt`; local completion clocks support only incomplete local history.

`ShareDialog` waits for successful publication before copying a public `/t/:id` link. The owner
sees that anyone can view/fork it and that it may appear in the gallery. Clipboard failure leaves
the URL selectable; owners can make a tree private again.

## Open work

- Graph completion Undo does not yet pass the browser case that returns focus to Complete after
  unrelated row activity. The crash-fallback switch and Board inset also have a failing browser
  case against measured legacy chrome. Both require browser verification and correction.
- Board, List and Graph each own a long-press recognizer; `rb-simplify` owns consolidation while
  preserving the Board hold/swipe exclusion and the legacy interaction contracts.
- Icon slots are reassigned by distance rank each frame; stable node ownership could remove
  unnecessary sorting and slot swaps.
- Remote structural deletion prunes scene selection without pruning React's selection sets, so
  the multi-select count can remain stale.
- Undo does not reconcile the append-only activity log; rows for removed nodes render muted.
- Layout runs on the main thread. Large trees and repeated live edits need an interactive latency
  budget beyond the tuck ceiling.
- The unlinked-node reconnect tag, activity burst coalescing and narrow activity-dock collapse
  are not built. Design gaps belong in the [consistency ledger](../../../../docs/design/consistency.md).
