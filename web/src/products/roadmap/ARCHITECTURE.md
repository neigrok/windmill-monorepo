# Roadmap web architecture

Roadmap is one DAG of steps shown two ways. The **Board** is DOM: three columns of cards for doing. The
**Graph** is a hand-rolled WebGL2 canvas for seeing shape and distance. React owns UI and lifecycle; pure
models own graph rules and layout. Tree writes are owner-only; another account can read a shared roadmap and
fork it. The shell mounts the product through `routes.js` and its registry; `showcase.js` is the only entry
point for the component showcase.

## Package map

| Area | Responsibility |
|---|---|
| `SkillTreeView.jsx` | The room's composition: it wires the hooks in `room/` and mounts every surface below |
| `i18n/`, `copy.js`, `resume.js`, `reportFailure.js` | The catalogs every visible string reads from; the words and count sentences several surfaces read; the newest roadmap as the home card and the landing offer it back; the static-name Sentry report |
| `OpeningMarks.jsx` | The marks of a step that opens a tree: one glyph and one bar for the Board, the step, the Graph's chrome and a node's centre |
| `room/` | What the room holds: the load, the view, progress, the scene, the open step, the tree a step opens and the way back, the row's verbs, the band and who holds the roadmap |
| `model/` | Graph validation, trunk selection, unlock rules, what a step's tree has come to, the rule the device judges its own trees by, and what attaching one sets aside, legend, workspace and spatial queries. Independent of React and WebGL |
| `identity/` | The row above both views: title, roadmap sheet and switcher, view switch |
| `guide/` | The tree's guide: its draft and bound, who sees it and where a save goes, the guides of the holder's trees above it, its entry on the tree (a card from 744px, a row on phones) and the note it opens |
| `board/` | Query and columns, regroup, held actions, the shared toast, card gestures and selection |
| `step/` | The step page and modal, workspace, composer and its picker, the tree picker and its choices, and the step's address |
| `graph/`, `graph/tree/`, `graph/tablet/` | Canvas chrome, docks, writes, selection and what a changed lattice does to the picture; the desktop step panel; the tablet's panel |
| `layout/` | Deterministic layout engines behind `index.js` |
| `scene/` | WebGL batches, camera, DOM overlays, picking and pointer tools |
| `sync/` | Shared structure and private progress lattices, gesture materialization, socket and IndexedDB |
| `persistence/` | HTTP repository, account tree registry and device preferences and ledgers |
| `shortcuts/`, `input/` | The room's keys and the pure hold recognizer |
| `activity/`, `ceremony/`, `presence/` | Activity presentation, animation sequencing and remote cursors |
| `paste/`, `quests/`, `demo/` | Import grammar and composition, authored starter roadmaps and the playable demo |
| `share/`, `browse/` | Publishing, Fork, portraits and the public gallery |
| `tending/`, `reminders/`, `settings/` | Ask AI, reminder preferences and account data export |
| `marketing/` | Product landing, metadata and self-playing scenes |

Every string a person sees is a `roadmap.*` message: in `i18n/entry/en.json` when a file the brand root loads shows
it (the route table, the landing head, the brand root's scenes, `marketing/treeScenes.js` and `resume.js`, which the
home card and the landing share), in `i18n/app/en.json` when the home card shows it, in `i18n/settings/en.json`
when a settings section or a module it imports shows it, in `i18n/landing/en.json` when the landing page shows it,
and in `i18n/en.json` otherwise. A surface's own copy is a `t()` call at
its site; a word or a count sentence several surfaces read is a `copy.js` export. Step titles, kind labels,
server lines, the demo tree and the starter quests' content are data and stay as they arrive.

## Bands, roles and views

| Band | Width | Board | Graph chrome |
|---|---|---|---|
| Phone | below 744px | One column at a time behind tabs in a bottom band | Selected-step bar; camera under the row |
| Tablet | 744–1023px | One side column folds to a rail | Tablet panel; camera pill at the bottom right |
| Desktop | 1024px and up | Three columns | Step dock and selection bar; camera pill |

| Role | Who | Can |
|---|---|---|
| `owner` | The account that owns the roadmap, on an app address | Everything |
| `reader` | Anyone on a shared address, anyone an app address loaded someone else's roadmap for, or a demoted owner | Read both views and the step page; Share copies the link; Fork |
| `demo` | The sample roadmap at `#/demo` | The reader's verbs, the sample byline and a coached completion |

`initialView` in `persistence/ViewPrefs.js` chooses the view and returns `{ view, door }`, so the opening
event uses the same branch that chose it:

0. Without WebGL2 every visit opens on the Board. Its door is `no_graph` when the rules below would choose
   the Graph, otherwise the door those rules choose. The saved view choice is preserved.
1. An owner's empty roadmap opens on the Board.
2. A non-empty just-planted roadmap opens on the Graph.
3. A tree gone into through a step opens in the view the person was in, and the roadmap they come back to opens in
   the view they left (doors `tree` and `back`). This holds once, for the room's holder: a reload or a Forward of the
   same entry, and anyone else at it, falls to the rules below.
4. A step link opens on the Board.
5. Non-demo readers of a not-owned or ownership-demoted roadmap open on the Graph, whatever they last chose.
6. Otherwise the saved choice stands, with owners defaulting to the Board and everyone else to the Graph. The
   demo and an owned roadmap opened through a shared address keep their saved choice. A saved `list` reads as
   `board`; `setLastView` never writes it.

Loading does not infer ownership. Until the roadmap arrives the Board stands wherever it would open. The
selected step carries across views. The Board layer stays mounted across switches, so each column keeps its
scroll; crossing 744px rebuilds the columns, and a column that folds to a rail starts at the top when it
stands again.

Share links and the demo mount inside the roadmap room's Shell (`inRoom` on the route's answer), keeping their
URLs; the Shell is their way home and their Sign in. From 744px every room shares one 52px head: no mark,
room links from the 16px edge with 16px gaps, and 44px-high targets that reserve each label's bold width. The active
room is bold primary text without a fill. Below 744px only roadmap registers `sharedShell`: every role gets
the drawn phone Shell, while Home, journal and gym keep their mark and phone geometry. Seat selection is the
same at every band: signed-out shared or status rooms show *Sign in*; other rooms keep the avatar with its
Appearance and Settings popover.

While the Board is shown, `coverBeneath` in `composerFocus.js` makes everything stacked under its layer inert,
the Graph's overlays and legend included. The identity sits above that layer and stays operable; step detail,
composer and sheet layers cover it. Covered elements stay inert until the last covering layer closes.
The same coverage owner keeps a hidden Board and every closed Graph dock inert. The Graph selection bar
mounts only while the Graph is shown, so none of these hidden controls enter the tab order.

A render failure in the Board reports `roadmap-board` and shows the Graph with focus on the row's pressed
switch; choosing Board tries again. Without WebGL2 it shows the design-system crash screen with Reload. A failure
in the row reports `roadmap-identity` and leaves `ViewSwitch` at
the row's position with focus on it: the Shell carries the way home, the camera group is separate, and the
fallback's measured bottom feeds the same insets. The step and the composer close on their own failures.
[`OBSERVABILITY.md`](../../../OBSERVABILITY.md) tables every event and failure.

## Loading a roadmap

`room/useRoomLoad.js` loads a tree through `HttpTreeRepository` or the account's device fallback, constructs
`SkillTree`, derives progress through `UnlockRules`, runs layout and installs the render model in
`SkillTreeScene` when one is available. Without WebGL2 it installs the tree and model with null scene bounds,
seeds activity and starts synchronization without any scene or camera calls. Layout is synchronous and cached
by graph structure, effective engine and, for caption-aware engines, labels.

The repository judges its own reads, and `BoundaryFailure` says so to any catch above it. A tree whose pointers the server
could not follow (`503 opens-unavailable`) reports `roadmap-opens-load` and falls to the device's copy like any failed read. A server tree whose marks can't be
read reports `roadmap-progress-load` and stops the load, so the room shows the load error and Try again rather than a false
count. A failed activity read reports `roadmap-activity-load` and costs only the feed. A device copy's activity read reports
nothing, as the tree's own read has already told what the server is doing, and its marks are those of the record its
session restores (`loadDeviceMarks`: the private lane's where it holds any, else the steps' seeds), so the room opens on
the marks it keeps and announces none of them as new.

After load, `SyncSession` owns the durable lattice. Local gestures and remote frames both produce a projection
through `graph/useGraphStructure.js` and `scene.applyModel`, and the room's `projectionRef` holds that
projection.

A saved camera is scoped to its layout engine and format. Without one, an owner opens at working zoom over the
frontier and a visitor receives the whole-tree fit and arrival ceremony. The owner's first view reframes as
chrome measurements arrive until the reader moves the camera. A plant from paste or a quest fits the whole tree,
cascades and ends on its one line. A fork opens on its Board and says what happened, counting its own steps. The
scene stays silent unless it is told what to say. Without WebGL2, the planted summary and welcome-back recap
have no Board presentation and are absent; their undrawn states are in the
[consistency ledger](../../../../docs/design/consistency.md).

## A step that opens a tree

A step can point at another tree of its owner's. The pointer is the node register `opens`; what it comes to is an
`Opening` (`model/Opening.js`): the opened tree's title, whether it is complete, done of total and whether it leads back,
or that nothing of the owner's stands at the other end. `GET /v1/trees/{id}` answers the openings to the owner, the
repository builds them, and `useRoomLoad` stands them on every projection it hands on (`Openings.onto`), so each such
step carries its `opening` through every tree built from it. Only the owner's room does: a reader, a shared address and
the demo see ordinary steps. A tree that lives only on this device is answered by the device instead (below). Until the session has joined the server's state the load is the newer word: a step it
named opens that tree and a step it did not opens none, whatever an older copy on the device holds. From then on the
projection's pointer decides, and one the load read nothing of is `unread`. A pointer this device wrote and the server
has not confirmed (`SyncSession.ownPointers`) stands over the load before the join too, as any own write does. A tree
chosen in the picker stands at once as the picker knew it (`Opening.chosen`, `provisional`, held by the room per step
and tree) until the server's read replaces it. Nothing pushes an opening. A pointer the room has no read facts of is
read once the server has confirmed it, on the session's confirmation (`onConfirmed`: this device's ack, a peer's frame,
a graft), after 600 ms and within ten seconds; a read that fails, or still says nothing of it, waits for the next
confirmation or reconnect, and the same round asks nothing twice. A load that read none at all (the device's own copy,
a `503`) leaves every pointer `unread` and asks nothing more.

The device's copy of a server roadmap holds its pointers, the ids of the trees its steps open, in the stored lattice,
and nothing else of those trees. It goes when the account that held the device signs out or another signs in
(`forgetDeviceTrees`), and a lapsed session keeps it.

**On the device.** A tree that lives only on this device (`LocalTreeRegistry.onDevice`: a row its holder sees that no
account has claimed) opens trees on this device. `model/OpenedTrees.js` holds the server's rule (`OpenedTrees` in
`backend/products/roadmap/domain`, whose cases its tests run): a step that opens one of these trees is complete exactly
when that tree is, its mark set aside, and any other step, one whose pointer names a tree not among them included,
follows its mark; a tree is complete when it holds a step and every step is, the least the rule allows, so a loop never
completes. The rule is the same; what it reads as marks differs. `readDeviceTrees` (`sync/localTrees.js`) reads every
such tree from the device store with the marks its room shows: the private lane's where it holds any, else its steps'
seeds, which the server never counts. A claim sends what the device showed (`SyncSession.adoptSeeds`): a step done by
its seed goes up as the person's mark, stamped as any mark made here, so the account's count is the device's. The room
works out its openings from them as it opens and whenever a pointer of its own changes, with its own steps as they
stand; a loop is a tree that leads back to this one. Its projection is the device's own word, so its pointers always
decide. A pointer at a tree the device does not hold this way, a server tree, someone else's or a removed one, is not
found. A record that does not join stands `unread` and degrades only itself: it is reported once as
`roadmap-device-opens-read` (`name: corrupt`), a pointer at it is unread, it is never complete, it opens nothing and the
picker leaves it out, while the rest are read. A device that cannot read its trees at all (its database will not open,
or a record cannot be read) reports the same under the name of what failed and leaves every pointer `unread` until a
pointer changes or the room loads again. Once a claim takes the tree to the account, in this tab or another (the claims
channel, `onTreeClaimed`), the room stops reading the device, and the facts it holds stand until the server's replace
them.

`UnlockRules.completed` is the one rule: a step that opens a tree is complete exactly when that tree is, whatever its
mark and its prerequisites, and one whose pointer leads nowhere follows its mark. No hand marks such a step
(`takesMark`): no door offers Complete or Reset on it, `markDoneTargets` leaves it out, and `RoomProgress.mark` changes
and sends nothing for one. A mark that such a step already holds, made before the pointer arrived, is set aside
(`SyncSession.owedFrames`): it stays on the device as it is, and while the lattice record holds a pointer it is not sent
and not counted as unsent, in the outbox, in the status the room shows or in what keeps a refusal standing. Nothing
else changes for it: no reconnect, no rebaseline, and Discard and Undo are what they are without it. When the pointer
goes, or once the room has found that it leads to no tree (`SyncSession.pointersLeadNowhere`, told on every projection
it stands: the device's rule on a device tree, the server's facts on any other, and at a claim what the device found),
the mark is an ordinary unsent one again and goes with the next flush, as the server records a mark on a step whose
pointer is not valid. A pointer nothing was read of keeps its mark aside. The return ledger and the milestones read
the same completed set. A roadmap with an `unread` opening does not know that set, so it recomputes nothing: it adds
the person's own marks to what the ledger holds, and a load in that state leaves the ledger as it was.

| Surface | What it shows of the tree |
|---|---|
| Card | A pill between the reason and the excerpt: done of total with a bar, *No steps*, *Loops back* or *Not found*, led by the tree's title where it differs from the step's. A press on it goes in. On phones an Up next card's swipe reveals Open in place of Complete |
| C on a card | Completes nothing: a toast says what completes the step, with Open tree where the tree can be gone into. A tree that is not found has the toast without the action, and an `unread` one has no toast |
| Step page and modal | A Tree section after the relations: the row goes in, and one line says what completes the step. Where Complete sat: the same in a few words, beside Open tree, primary while going in is the next thing to do |
| Graph node | The tree's mark at its centre (a loop's, or an alert where nothing is found) and done of total on the sub-task arc |
| Dock, tablet panel, phone bar | Done of total, and Open tree in place of Complete |

An `unread` opening shows the mark and Open tree and says nothing else: no pill, no row, no words. `Opening.leads`
says whether a door can lead there. A dangling one (`Not found`) and a step that opens the tree it stands in have no
door on any surface: the pill has no chevron and opens the step, the Tree row is not a button, and no Open tree, swipe
or toast action is offered. Such a step keeps its tree's mark and its loop's words.

`room/useTreeVisit.js` goes in and comes back. Going in pushes `#/app/<treeId>`; the entry of the tree gone into names the
roadmap the person came from, and the entry they left keeps the step they went through. Both are history state, never
tree data, so a direct link has no way back, a chain pops one tree per press and the browser's Back reads what the chip
reads. A history entry outlives a sign-out, so it holds ids and a view and no title. The room acts on it only for its
holder (`useRoomHolder` in `room/useRoomAuthority.js`, the one answer to who holds the room, `{ place }`): on a tree
that lives only on this device, whoever is at the device, signed in or not (`place: 'device'`), until a claim takes the
tree to the account and the hook asks again; on any other, the account that holds the room as its owner, once the server
has answered for it in this document (`confirmed` in the shell's auth context; a page that starts with no connection
stands on the cached account, which is not one) (`place: 'account'`). The way back shows where this device's index keeps
the roadmap it leads to for that holder, under the title the index keeps: as that account's (`LocalTreeRegistry.owned`),
or as a tree that lives only here (`onDevice`); `open` writes that row for the roadmap it leaves before it navigates, as
its session may not have stored anything yet. Without a holder there is no way back, no carried view or step, no door
into a tree and no event. So on a tree the server keeps, a lapsed session, its copy on a device with nobody signed in
and a start with no connection, and anywhere a reader, keep the tree's mark and go nowhere; on a tree that lives only on
this device the person at it holds it through a lapse. An arrival is settled as the room
opens: the step and the view leave the entry, which keeps the roadmap it was reached from, so a reload shows the way
back and is otherwise an ordinary visit. The identity row shows the way back as a chip in its first slot from 744px, and
as a chevron with the roadmap's title over the tree's on phones. Coming back mounts the roadmap again, so it loads
again; the step gone through is selected and brought into view, and on the Board its card wakes. A step that was open
on the entry come back to opens as one reached by going back. Surfaces that render a step reach `open` through the
`TreeDoor` context (`useTreeDoor`); the toast a C raises takes it from the Board's acts. Each names its door from
`TREE_DOORS`, and `open` refuses any other. Every event of a visit says where its holder acts (`place`).

One door leads up. The guide's note names the trees whose guides stand above this one, and a press on a name goes into
that tree by the door `guide`. No step here opens it, so `open` is given the tree and the entry left names no step:
the tree gone into shows the way back, and coming back restores the view, selects nothing and is said once, as any
return is.

### Attaching, changing and detaching

The person who holds the tree makes the pointer on the step itself, never in Edit step: the same holder a tree visit
acts for, where the roadmap's session can take a write (loaded, and not rebaselining). The room hands the step
`treeActs` (`{ view, trees, set, lapsed }`) for that person and null for anyone else, so a reader, and on a tree the
server keeps its copy with nobody signed in and a lapsed session, see no control. `trees` reads the trees where the holder's lives (`place`). With it the Tree section stands on every step: *None* and a + on one
that opens no tree, and a ⋯ on its heading on one that does, the heading and the ⋯ alone while the tree is `unread`.

The + and Change tree open `TreePicker`: a page in the step modal from 744px and a full-screen page over the Shell
on phones, with the field and the commit in the reach band. `TreeChoices` is its model: the person's roadmaps on the
server but the one they are in (`listServerTrees`, the switcher's order), one choice, the tree the step opens
arriving chosen, and Find a tree narrowing by title as the prerequisites picker does. On a tree that lives only on this
device the rows are this device's trees but the one they are in, newest first, done of total worked out on the device
(`listDeviceTrees`), each tagged *on this device* as the switcher tags them; the context says how many trees are on this
device, and with nobody signed in the closing line says what signing in adds where the fork line stands, with no line
for a signed-in person on such a tree until its claim lands. There an address names a roadmap only where it is one of
this device's (`readDeviceTreeCard`, no request made), and any other reads as one the picker cannot read; nothing is
blocked or forked. A device read that fails is a list that could not be read, *Couldn’t load your trees* with Try again,
reported once as `roadmap-device-opens-read` and not again by the picker. Attach acts only on a chosen row
on screen. Only this app's address (`pastedTreeId`: `<origin>/t/<id>` or `<origin>/#/app/<id>`, the scheme and a step
optional) or a bare tree id (`t_` and sixteen lowercase hex characters, the id the server mints) names a roadmap; any
other text only filters and sends nothing. One of theirs selects its row. Any other is read once it was pasted or the
field has been still for 300 ms, and once per id (`readTreeCard`): a roadmap they can only read is the one blocked row
and Fork tree is the only commit, and one they cannot read says so. Fork runs `ForkDoor`, which hands the copy back
instead of opening it; the list is read again and the copy is a row to choose, so attaching stays its own act. A list
that cannot be read says *Couldn’t load your trees* with Try again; an address whose read failed says *Couldn’t load
this roadmap* with Try again in its place, the rest of the picker standing. Each reports `roadmap-tree-picker-load`
with its read and reason. A 401 on either read is the room's lapse (`treeActs.lapsed`, the path a refused write takes),
with no Try again.

One line under the rows says what happens to a hand's mark. `treeAttachment` in `model/UnlockRules.js` answers it
from the tree and the marks the Board derives from: whether the step holds a mark, and how many steps up next lock
again once the step is done no longer, none where the tree chosen is complete. The ⋯ is a menu under the heading from
744px, standing in the step's layer so the scrolling step does not clip it, and a sheet on phones; its footnote names
the mark only where one was set aside.

Attach and Detach act at once. `BoardActs.setTree` dispatches `SetNodeTree` over either view and raises one toast in
the room's seat (*Tree attached*, *Tree detached · your mark is back*, or *Tree detached* where the step held no
mark) whose Undo reverts the gesture's receipt; the status row adds nothing. A step that already opens the tree chosen,
as when a peer set it while the picker stood open, closes the picker with nothing written or said; a write the session
refuses keeps the picker and says *Couldn’t change the tree. Try again.* The mark is not written: it stays on the
device, set aside while the pointer stands and owed again once it goes. The row stands at once from what the picker
knew, and the server's facts replace it once the room has read the confirmed pointer. The second press of a double
press on Attach lands where Attach was, on the step beneath, and the step takes no click with a count above one for
half a second after Attach. Escape leaves the picker, the menu or the sheet
before the step, and focus returns to the + or the ⋯, whichever then stands. A loop's and a missing tree's lines end
with the way out (*Detach one side.*, *Choose another, or detach it.*) for the person who has the ⋯.

## The identity row

The host mounts one `RoadmapIdentity` above both layers for every role and band, passing `demo` for the
sample. It persists across switches and precedes the Board in DOM and tab order. While the Board awaits its
roadmap the row names no title or progress and offers no Share; after a failed load it offers no switch.
`room/useRowVerbs.js` owns the query handoff, read models and verbs that route to Share, Fork, Ask AI
and shortcuts.

| Width | Row |
|---|---|
| 1280px and up | *Find a step* and Ask AI in full |
| 1024–1279px | Find and Ask AI fold to icons |
| 744–1023px | Ask AI and Share move into More |
| Below 744px | Owners open the roadmap sheet from the title |

A folded *Find a step* closes once the press that took its focus has landed, so closing never moves a control out from under that press.

Without WebGL2, Graph remains focusable and named, at 45% opacity with `aria-disabled="true"`, unpressed and
described by *Graph needs WebGL2, which this browser doesn’t support.* From 744px, hover, focus or a press
opens the product-local tooltip; Escape, blur, mouse-leave or an outside press closes it. On phones a press
uses the room's toast slot with no action, unless a held delete owns the slot. That press preserves the
held-delete toast and its deadline; the reason remains in the option's accessible description. The description
remains available to assistive technology while closed. Presses emit `roadmap_graph_unavailable`; hover and focus stay silent.

**Keys.** From 744px `/` focuses *Find a step* on either view, and G switches Board and Graph for owners and
readers when the Graph is available. Without WebGL2, G does nothing and its Board / Graph help row is absent.
A non-empty Graph search hands off to the Board with its query and field focus kept. ⌘K is Ask AI. A opens
Activity from 744px when its destination is available; on phones it does nothing. `boardKey` in `shortcuts/shortcutMap.js` owns the
Board's keys and their shared typing and covered-layer refusal: a step open over either view, a dialog or the
composer prevents them acting. C completes a focused Up next card, or says what completes one that opens a tree; Backspace and Delete start a nine-second
held delete on a deletable owner card, with no confirm. Graph selection shortcuts do not act on the Board. The
host (`useRoadmapKeys`) lets no key reach the room while a layer covers it, the composer's picker and the guide's
note being written included: paste, Undo and Redo, shortcut help, and the Graph's select all, delete and camera keys
wait wherever focus stands in the cover, and ⌘K with them, while Escape still closes Ask AI. In a text field ⌘Z and
⇧⌘Z belong to the field.

**Focus.** Each surface restores its own opener: Dialog and the Ask AI and Fork sheets share `useDialogFocus`;
the composer uses `useComposerFocus`. `design-system/feedback/dialogFocus.js` owns focusable elements and Tab
wrapping for Dialog and Board layers. Restores leave an intentional focus target outside the surface alone.
More and the roadmap sheet close and focus their surviving trigger before invoking a verb. Menus share
keyboard navigation through `BoardControls`. `popoverDismissal.js` owns outside-pointer, outside-focus
and Escape dismissal for More, What's next and Sort. Focus moving to a containing surface during an
inside pointer press keeps the popover open, including Safari's unfocused button clicks. Genuine focus
departure, to another control or off the page, preserves its destination. Escape returns to the trigger,
and so does an outside press on More or What's next, which also cancels the mousedown WebKit still sends
after a finger's cancelled pointerdown.

**The guide.** A tree carries one guide, plain text its owner writes on what the tree is and how to work it, which agents
receive through MCP; people see the same text. `GuideDraft` counts it in code points as the server does: the counter speaks
from 4,500, and past 5,000 nothing is cut and Save waits. Save writes the text as it shows: a NUL a paste carried goes and a
lone surrogate becomes the replacement glyph drawn for it, so no door sends text the server refuses, and `admitsGuide`,
the server's admission, guards the session's and the device's doors. `useRoomGuide` decides who sees it (the owner always, a reader on
the app route when it holds words, nobody in the shared-reader mode or the demo), holds whether its note stands open and routes a
save: `SyncSession.setGuide` when the session can take the write, else the device store for a tree that lives only here
(`setLocalGuide`, which refuses a tree whose record is gone), else `PATCH /v1/trees/{id}`. A save answers null once a door
took the guide and otherwise why none did, which `saveFailureReason` reads from the error, the door and what
`navigator.onLine` reports: `offline` for a request that never arrived while the browser reports no connection,
`refused` for a 4xx that trying again cannot change or text a door would not admit, `server` (a 408, a 429 and a
request lost while online among them), or `device`.

Guides add downward: an agent working a tree is given the guides of its owner's trees above it, farthest first, and
then the tree's own, and the note shows its holder the same stack. `useRoomGuide` reads them once each time the room
opens a tree the server keeps for its holder, the account the tree visit acts for (`GET /v1/trees/{id}/guides`,
`readGuides`), and hands them on as `above`, each `{ treeId, title, text }` (`guidesAbove` in `guide/GuidesAbove.js`):
the reply without the tree's own entry, since the room holds that guide and a save shows at once. A reader, the
shared-reader mode, the demo, a device with nobody signed in, a tree that lives only on this device and a lapsed session
make no read and are shown nothing from above. The guides from above live in memory alone. Leaving the tree aborts the
read and drops what it brought, as the holder going does, so a return reads again and nothing read earlier stands in
the meantime. A read that fails leaves the tree's own guide standing and says nothing. It reports once as
`roadmap-guides-load` under one tag, `reason`: `unavailable` where the server could not read the trees above, `server`
for any other 5xx, `network` for a request lost while visible and online, and `shape` for a 200 that is not the
contract's, one that is not JSON among them (`readFailureReason`; `guidesAbove` says whether an answer is shaped). What is well formed in such an
answer still shows. A tree answered twice stands once, where it stood farthest, a guide a fork brought with it stands
among the others, and a tree with no title takes *Untitled roadmap*. The open event says what the entry knew at the
press: `none`, `some`, or `unread` while the read has not answered or after it failed, by its status or its shape.

The guide is a note on the tree. `GuideEntry` is the note at rest, which the room hands to the view that shows it: from
744px a card, over the Graph's canvas under the row and first in the Board's flow, with the first line and Read guide; on
phones a row under the head of both views, beneath the device line when the tree carries one, with up to three lines.
A reader's entry says Author's note, and an owner without a guide gets Add guide. Under guides from above the card
adds one line naming their trees, the two farthest and then how many more (`namedAbove`), and the row a count beside
its title; a tree with no guide of its own then keeps the written entry without an excerpt. The line is one line and
never loses its count, whatever the font measures: the sentence's own words never shrink, and the titles alone give
way with an ellipsis; words too wide for the line together wrap rather than go. `GuideNote` is the note
open. From 744px it stands in place over its entry and shares the room while it reads; on phones it is a bottom sheet
as tall as its text. The guides from above stand first in it, farthest first, each under its tree's name and in the
secondary ink, then this tree's own under its name, and the whole stack scrolls inside the note. They are plain text
with no caret and no tint; a tree with no guide of its own has Add guide as its block and no pencil. This tree's text
is one mounted element with or without guides above it, so guides that answer while it is read move nothing: the
line read stays where it was, with its selection. The note's focus rests on this tree's text; under guides from above
that start that text below the fold it rests on the stack, ringed when a key brought it, which scrolls from the
keyboard, does nothing on Enter and leads by Tab to each name and then the text. A press on the text under a stack
writes from where it landed with the caret's line in view, the field scrolled as far as the text itself was, and
leaving the draft returns the stack to where it was read, this tree's guide in view. While the guide is
written from 744px the guides from above stay over the field, dimmed, scrolling by themselves, and their names do not
act. They take what the window leaves once the field has its height, and where that holds less than one name and one
line of text they are not drawn; on phones the editor holds this tree's guide alone. The draft, its count and
its save never hold them. The owner presses the prose, the hint beside this tree's name or the pencil, or Enter, and
writes in the same frame from where the press landed
(`caretPositionFromPoint`, or Safari's `caretRangeFromPoint`); writing holds the window, so everything beneath is inert
and a press outside asks to leave. The field is as tall as its draft until the note's bound makes it scroll, and on
phones the footer rides the keyboard. Save waits for a change and a draft that fits, ⌘↩ saves, and an empty Save removes
the guide, which closes the note unless guides from above remain to read. While a save is in flight the frame holds:
the field is read-only and nothing leaves until it settles. A save by someone who is no longer the owner writes through
no door and is refused. While the note holds
the window, Escape, ⌘↩ and Tab work wherever focus stands; ⌘↩ presses Save or Try again and no other act, and a held
key is one press. The note keeps its draft, and the focus a stop held, across a change of band, and closes
when the tree changes or the guide stops being shown. Leaving a draft returns to where writing began (the note read, or the tree for a guide begun from Add guide),
at once when nothing changed and through Discard draft? when something did. Closing hands focus back to the entry. The
footer keeps a status line with one act above who reads the guide: a guide changed elsewhere mid-edit says so there and
offers Load latest, which replaces the draft, so Cancel then leaves at once; on phones the line also says what Save
replaces, and it waits while a save is in flight. A save no door took keeps the draft and leaves one line
(`role="alert"`) where the footer says who reads the guide, and its act takes Save's place: Try again for `offline`,
`server` and `device`, which runs the same save, and Copy draft for `refused`, which puts the whole draft on the
clipboard and, once it is there, says Draft copied with Done. Done keeps the draft and returns to Copy draft, so a
changed draft leaves only through Cancel and Discard draft?. A clipboard that refuses leaves Copy draft standing. The
line moves no focus: after ⌘↩ focus stays in the field, where typing goes on and clears the line, and after a press on
the footer's button the button keeps it, with a ring on phones when a key put it there, and a phone's keyboard goes
down. From 744px the line and the actions share one tinted block and the field rests on its plain edge; on phones the
line is a block above the actions. A sheet too short for what it holds lets the field give up height first, the
caret's line kept in view, and then scrolls under Cancel and the footer's button, which stay at its foot. Editing the
draft or Load latest clears the line and brings Save back. A guide set elsewhere replaces the entry's line and the read note's text with one
crossfade (`useArrivalFade`), none under reduced motion; the note dissolves in and out over 160ms. On the Graph from
744px the card and the note read in place publish their boxes to `useGraphGeometry`: `viewportInsets` frames the tree
to their right while 320px of canvas stays, keeps captions out from under them, seats the card below a refusal banner
and ends it clear of an open dock or panel.

**The roadmap sheet.** `RoadmapSheet` owns title search above eight roadmaps and the keyboard-aware search and
New roadmap footer; `roadmapSearch.js` owns the threshold, trimmed title match and highlight offsets in the
original text after Unicode lowercasing. Its current row comes from the host projection, with up next and
locked counts from the same unfiltered Board model as Next. At 1,000 or more total steps it uses
`exactProgress` when both state counts are supplied, otherwise the truthful done/total `progressLabel`. Other
roadmaps come from `listAllTrees`. Readers never receive the owner sheet. `TreeSwitcher` is the row's
equivalent from 744px and owns rename and delete.

**The switcher's delete.** A row's trash turns the row into its confirmation: the question (*Delete Learn to sail?
This can’t be undone*), then Delete and Keep. A server that removes, with a tree, the steps in the person's other
trees that open it sends `openers` on every row of `GET /v1/trees`: one `{ treeId, steps }` per such tree, `[]` where
there are none. `listAllTrees` keeps it on a server row as sent; a device row never has it. Where the confirming row's
`openers` holds an entry, one line stands between the question and the buttons and says what goes with the tree
(`deleteCost` in `identity/deleteCost.js`): the steps summed, the first two of those trees by title in the menu's own
order and how many more; an opener the menu does not hold counts among the trees and is never named. The row then
aligns to its top, the ring on the question's first line, and Delete is described by the line. A row without the
field, or with `[]`, asks the question alone, centred. Nothing in the row is cut: the question and the line wrap. The
numbers are those the list read when the menu opened, and no request is made for the line; a delete in the open menu
takes the tree's row and its place among the other rows' openers, as its steps went with it. A tree that lives only on
this device has its openers counted on the device over the other trees here (`withDeviceOpeners`,
`OpenedTrees.openersOf`), read as the menu opens, so its row says the same line in the same sentence; a device read that
fails leaves the row asking its question alone. Deleting such a tree (`deleteDeviceTree`) reads the device's trees first:
a device that cannot read them refuses the delete with nothing removed, by the switcher's failed-delete path, and
deleting again tries again, so the person is never told less than the delete does. Then the tree goes and, after it, the
steps of the other trees here that open it, as the server's removal does (`PruneNodes`): each tombstoned with every edge
touching it, nothing respliced, and the person's mark on it cleared, each tree its own write. A tree whose record does not
join was not counted and is not taken from. The tree this tab has open takes it through its session
(`SyncSession.removeSteps`), as a local write outside the undo journal saved once, so its card goes at once; every other
tree takes it through its stored record, as any device edit, so another tab with that tree open shows it on its next
load. A write that fails reports `roadmap-device-cascade` once, under the name of what failed, and its tree keeps its
steps on disk: the open tab's own steps vanish from its screen and come back after a reload, each opening a tree that is
not found and following its mark, to detach or delete by hand. Nothing on the server is touched.

**Export** builds one Markdown file through `serializePlan` and `fileNameFor` in `exportArchive.js`, with a
`<!-- windmill:roadmap -->` marker: its title is metadata, its guide a quote between `<!-- windmill:guide -->` lines that a
replant reads past, and every step, including each root, is a list item with its own completion mark. Kind changes are inline comments, keeping the nested list uninterrupted in
Markdown viewers. Indentation preserves primary prerequisites; additional prerequisites become `needs also`
notes. Kind descriptions and link labels are outside the paste format. Settings exports all roadmaps as a zip. A roadmap it
can't read stays out, marks included, and the line says *Exported 1 of 2 roadmaps.*; with none read nothing downloads and the
line is the export's error.

**The device line.** The host derives an anonymous or lapsed line: the Shell carries it from 744px, and both
phone views receive the tappable `DeviceLine`. A restored paused account keeps `lapsed` true after reload;
the line reads `LAPSED_SESSION` and `roadmap_device_line` reports `line: 'lapsed'`.

**Activity.** Desktop and tablet owners open it through the row or A on either view. The feed never opens
itself and carries no unread signal. On desktop, opening it from the Board switches to the Graph dock, so
without WebGL2 neither the row nor A offers it. The tablet panel and phone page remain available. At
744–1023px a separate panel keeps the current view usable; its rows open step details, and X, Escape or the
callback closes it and returns focus to More, which reads `activityOpen` to stay pressed. It stands at 172px
from the page top, or 12px below the measured row, Board filter strip or Graph refusal banner when those reach
lower. The room mounts it in whichever layer the view shows, so it paints beneath the row's menus and the Board's
sort menu. Phone owners open
Activity as a page inside the roadmap sheet: with at most eight roadmaps the entry and the page share a 611px
footprint capped by the viewport; Back, an edge swipe or the first Escape
returns to the roadmap page, and a row closes the
sheet before opening its step. `activity/ActivityRows.jsx` owns the shared rows, removed-step treatment and
empty state.

**Ask AI** uses an overlay from 744px and a modal dock on phones, with examples above its field. The dock
reuses composer viewport tracking to clear the keyboard. Escape and the scrim dismiss it. Submitting closes
either presentation while the room retains the sentence. A failed answer reopens Ask AI with the sentence;
an explicit dismissal during the run keeps it closed and restores the sentence on the next opening. The
unchanged failure copy is also announced inside the active dialog while the room's toast is covered.

## The Board

### Query

The room owns the Board's query (`BoardQuery` in `board/Board.js`): sort, kinds on, search text and
branch in scope. It lasts the visit: leaving the roadmap or reloading starts it over, and nothing is stored.
`viewBranch` scopes the Board to a step, every ancestor and every descendant; availability and progress still
read the whole roadmap.

Kinds narrow only among the kinds a roadmap wears (`kindOptions` in `model/Legend.js`), so a roadmap wearing
one kind shows no filter. All also drops a kind no swatch offers any more, so it cannot come back on its own.
The order is Roadmap order, or Created newest or oldest, for Locked and Up next; Done keeps its newest
completions.

From 744px a strip over the columns holds the branch scope, All and one named swatch per kind, and the sort
menu, with *Find a step* on the row (`board/BoardControls.jsx`). On phones the band's first row adds Sort
beside the tabs and its second holds *Find a step* and Filter, each of Sort and Filter opening a sheet; the
branch scope and a removable chip per kind on and for a non-default order sit over the panes, and Sort and
Filter wear a dot while they narrow. A branch scope opens its step's column, and its title selects that step
and brings its card into view without opening it.

A column the query emptied names its way out: *Clear search*, *Clear filters* (the kinds; the branch clears
only on its own) or *Clear both*. From 744px, when every column is empty, only Up next says so. A control the
query took away hands focus to the columns' tab stop.

### Columns

From 1024px Locked, Up next and Done stand side by side, each scrolling under its sticky heading and starting
under the identity row, whose measured bottom feeds the Board's top inset on every band. From 744px to 1023px
one side column folds to a rail, Done first; Show swaps which one, a rail offers Show only while its column holds a card, and Up next never folds (`columnStage` in
`BoardColumns.jsx`). Phones show one column at a time behind Locked · Up next · Done tabs
(`PhoneSegments.jsx`). Shown with a step selected, the Board opens that step's column (its tab, past the Done
fold, or out of the rail) and scrolls its card into view.

Each column renders only the cards in view plus ten either side (`ColumnCards.jsx`), estimating an unmeasured
card's height from its text and the column's width, measuring each card as it renders and standing a spacer in
for every stretch it skips. It keeps the first card in view still as cards above it settle, in place of the
browser's scroll anchoring, which the columns turn off and WebKit lacks. The roving stop and the selected step
always render, so focus and a reveal reach them anywhere. Above twelve, Done folds to its twelve newest
completions and a Show all row (`Board.shownCards`).

### Keyboard traversal

The columns are one tab stop with roving focus (`traversal.js`). A stop is a card, the Show all row or a
rail's Show. Tab enters on the stop last focused while it still stands, else the stop a column last held (Up
next's before the others'), else the first Up next card, else the first stop of any column. Up and Down move
within a column, Home and End to its ends, and Left and Right to the neighbouring column's stop at the nearest
height, skipping an empty column; a rail offers only its Show. Enter is the stop's own button, so a card opens
its step. On phones each pane has a roving card stop with the same Up, Down, Home and End; an empty pane
itself takes focus, and the tabs keep their own arrow keys.

A focused stop that unmounts hands focus to the new stop, and after Try again focus rests on the skeleton
until the roadmap loads. C follows an accepted completion to the same step in Done without expanding the
column. A refused action creates no pending focus request. Deletion reads the current projected membership and
leaves recovery to the surviving stop, or the phone's column tab while regroup settles. `boardFocusTarget`
owns fallback targets on the displayed Board, excluding covered, hidden and leaving elements.

### Regroup

`regroup` in `Board.js` derives departures, moves and arrivals. One `useRegroup` in `BoardView` coordinates
displayed cards and counts across columns. Query and other changes with no movement render at once; only a
moving regroup holds the previous Board.

| Beat | Desktop | Phone |
|---|---|---|
| Departing card | Fades after 150ms | Gap closes over 280ms |
| Gap | Closes over 280ms | |
| Newly Up next cards | Travel for 320ms | Wake over 480ms |
| Counts | Update on arrival | Update on arrival |
| Toast | Follows the last beat by 120ms | Follows the last beat by 120ms |

Any pointer, wheel or key fast-forwards within 150ms; reduced motion uses opacity without travel or scale.
Columns keep their scroll, and moving and pending cards stay rendered through virtualization. Undo, including
inline Undo of Reset, dims in place for 280ms without a wake. User focus or pointer interaction ends a card's
wake; programmatic reveal focus preserves it. Equivalent rerenders preserve the running quiet phase. Regroup
delays only a new toast's entry: a visible toast and its Undo stay available during later motion.

### Phone gestures and selection

`gestures.js` owns the phone card's reveal-only swipe. Only Up next cards offer it, and a card that opens a tree
reveals Open in the same slot. The card preserves
vertical scrolling, leaves the OS edge alone, claims a horizontal drag after 10px within 30 degrees, tracks to
96px and resists beyond it. Release settles open or closed and never completes. A real Complete button follows
the card in DOM order; Tab reveals it, and Escape or leaving focus closes it. Crossing the threshold offers
one 8ms haptic where supported.

On an active owner phone Board, a 500ms touch hold within 10px starts pane-scoped selection. Board and Graph
share the pure `input/HoldGesture.js` recognizer; their adapters own timers and keep their movement boundaries
(Board cancels at 10px, Graph above 10px). `HoldGesture` and `SwipeGesture` cancel each other on claim; scroll
and pointer cancellation stop the hold, and its release never opens a step.

`BoardView` mounts `useStepSelection`, which owns selection, history and focus transitions separately from the
Graph's multi-select. Its immutable `StepSelection` reads the filtered pane and permanently drops choices that
leave it. `deletable` in `acts.js` is the one sole-root rule for selection, keyboard deletion and the step
menu. The host owns whether Board selection is open: phone, active Board and owner. A deletable step's page
menu offers Select under that rule. `useStepPage` closes the visit, selects the step, clears only query dimensions
that hide it through `BoardQuery.revealing` and records a request, keeping sort. After the step leaves the URL,
`BoardView` stands its column past any Done fold and consumes the request once through the hold's same `start`.
Successful start acknowledges its key to the host, which clears that request; a Board crash also clears any
pending request. Request keys increase independently of the pending request. The selected card receives focus,
including when the visit began on another card.

Selection replaces the phone band with `BulkBar`, a region named Selection: a non-focusable `h2` count and
Done, optional six named kind radios, then equal-width Recolor and Delete. The owner's phone Board keeps one
polite live region mounted and initially empty. Start announces *Selecting. 1 selected.*; later count changes
announce *N selected*, and ending clears it. Selected cards are `aria-pressed` toggles operated by tap, Space
or Enter. With no phone notices, Tab from a card reaches Done. `KindChoice follow={false}` moves focus with arrows and applies only on
activation. Re-picking the shared kind closes only the kinds row, keeps the selection and writes nothing.
Selection owns same-URL history entries, separate from step visits; Back and Escape close the kinds before
ending selection. Ending waits for its history entries to close, then restores the last toggled card, whether
toggled on or off, only if it belongs to the filtered, displayed pane and is not leaving; otherwise focus returns
to the pane's tab, or the
state action or loading stop if the pane was replaced. Selection also ends on an act, an empty prune, leaving
the Board, losing ownership or changing roadmaps. Recolor dispatches one `BulkRecolor` and keeps the selection
if refused. Bulk Delete creates one held projection and releases one `BulkDelete` after nine seconds, with no
confirmation. Neither act clears the query. The starter and the last toggled card stay rendered through
virtualization while selecting so focus can reach them.

### Step detail

A card opens its step (`StepDetail.jsx`): from 744px a modal over the scrimmed roadmap, 760px wide and 24px in
from the window below that; below 744px a page pushed over the current view. The Board keeps its pane and
scroll beneath it, and the Graph keeps its selection and camera. Crossing 744px swaps the frame inside the
same layer.

The open step rides the hash as `?step=<id>` (`stepAddress.js`). Each step opened from a card or from another
step is a history entry, so Back steps out one step at a time and the page's back row names the screen it
returns to; closing pops the whole visit, and a link lands owner and visitor alike on the Board with that step
open. A view reads a step only on its own roadmap's route, and once that roadmap has loaded without the step,
the step leaves the URL in place, so restoring it reopens nothing.

While open the layer makes everything beneath it inert and wraps Tab inside itself; Escape, wherever focus is,
closes the topmost editor or confirmation before the detail. Closing returns focus to the card the visit began
on, or to the columns' tab stop once that card has gone. Select hands focus to the selected card instead, and
closing leaves that deliberate target alone. After a held delete, roving recovery skips the
deleted card even while regroup still displays it; on phones, if no surviving card is visible yet, focus rests
on the selected column tab until its stop appears.

`StepFacts.js` reads the step off the whole roadmap, whatever the Board filters: its column, prerequisites,
the steps it unlocks, what Complete would open and how many steps Reset would lock. Complete and Reset act in
place and toast nothing: the status row flips with an inline Undo for six seconds and a line names what moved,
and hovering or focusing Reset previews what it returns to Locked. Undo puts back the step's mark with no
ceremony or activity, but not its completion time: the progress lattice dates every mark it sends, so an Undo
of Reset completes the step at the Undo's time and it heads Done. On the Workspace section, a step whose every
subtask is checked offers Complete step, which returns to the overview's status row; subtasks never complete
it.

The ⋯ menu copies the step's link (the roadmap's share address plus its step) only while the roadmap is public
or unlisted, opens the step in the Graph when it stands over the Board and the Graph is available, offers Select
to a phone owner over the Board for a deletable step, then offers Delete to an owner unless deleting the step
would leave the roadmap no root. With nothing to offer the menu hides. The owner's up next and done steps offer View branch. A visitor gets the overview and the menu without
Delete. Owners get Edit step beside Complete or Reset, or alone while locked; the phone Workspace action is
Add note or Edit note.

Workspace and History use `StepWorkspace.jsx`: named checkboxes, the shared note renderer, personal links and
static activity rows grouped through `ActivityLog`. The note editor keeps a local draft and saves once through
workspace actions; a changed Cancel asks to discard, and system Back or a remote closure silently discards.
Neither editor adds a navigation guard. Formatting uses pure `formatNote`; the editor keeps source ranges from
the shared renderer, and each browser edit changes only its mapped source span, preserving untouched note
bytes. A phone subtask check offers an in-page Undo for six seconds; desktop checks stay quiet.

### Held delete

Delete first confirms in an anchored desktop popover or a phone sheet, with a cost line counting the step's
children through `acts.deletionCost`. Confirm closes the detail and creates a `HeldDelete`, with no structural
write yet. For its nine-second Undo window every Board surface reads the held projection: cards, counts,
identity, topbar, detail and composer. A delete from the Graph's step page uses the same hold and projects it
into the Graph. `SkillTree.without` and the eventual `BulkDelete` share `respliceEdges`.

`useBoardActs` injects session, progress, query, clock, toast and boundary collaborators. It owns one held
delete, which releases once on toast expiry or replacement, view exit, roadmap change, owner loss, unmount or
pagehide. The toast's Undo and ⌘Z cancel it without sending.

A release while the roadmap changes reaches the server first: a closing session's socket waits for the sends already
on their way. A release as the page goes turns the session synchronous first (`SyncSession.leavePage`): the session
sends without its epoch read, and the store puts the whole record from the last one it saw and calls `commit()`, because
no read or callback will run again. Only a hold does this. The record is read afresh when a hold starts, so what its put can
overwrite is another tab's save made during those nine seconds, which that tab's next save restores unless it has closed.

An already-absent step is a quiet no-op. A session not ready at the start says *Couldn't delete Rig the boat* with Retry
at once and holds nothing, which logs a line and files no Issue. A release that fails on its timer brings the step back and
says the same; an unexpected error also reports `roadmap-board-delete`. Retry runs the delete again, hold included. A
release that fails as its toast is replaced or left emits the event and says nothing over what took its place.

### States

`BoardStates.jsx` draws them. While the roadmap loads, still skeleton cards hold the columns under the identity row
and band, with no counts, no spinner and no motion. A failed load says *Couldn't load this roadmap* with Try again, which
reruns the load. An owner's empty roadmap shows *Your first step* and New step on every band. An empty reader
roadmap without WebGL2 keeps its identity and zero-step count without the owner title, body or New step offer.
Once every step
is done, Up next rests on Roadmap complete: the owner gets its body line, Share it and New step; a reader gets
the title alone.

## Creating and editing steps

New step on the identity row, the phone band, the empty state or the complete state opens `StepComposer`
through the host; Edit step opens the same form from an owner's open detail on either view. A view change
closes the composer, and the host keeps it mounted only while its detail still names an existing step.
`BoardComposer` in `useBoardActs.js` shares the host's open, display and save guards.

`StepDraft` owns validation, dirty comparison and placement, with an edited step replaced in the tree. The
picker changes only draft prerequisites until Save; it groups the step and its descendants as unavailable,
excludes them from match counts, and drops newly blocked selections with a notice that lasts until the next
search or toggle. Deleted prerequisites leave silently. A clean Save closes without writing.

The host dispatches one `CreateNode` with the request's stable id and all prerequisite edges stamped together.
`BoardActs.edit` refuses missing, self or descendant prerequisites, diffs valid requests against the held
projection, quiets regroup, dispatches one `EditNode`, and emits rename activity when the name changes; it
returns quietly to the detail with no toast. Failure keeps the draft and exact request for Retry. A successful
create reveals and wakes the step in its derived column, clears only hiding query dimensions and offers
targeted Undo. On the Graph it selects and reveals the step without changing Board filters.

The composer sits inside its error boundary and portals to `document.body`, covering the viewport
independently of the shell's containing blocks. At 1440px and wider the picker is anchored beside the form;
below that it replaces the form, as a page in the 600px dialog from 744px and a full-screen page on phones.
`StepComposer` owns picker selection and query, so resizing keeps them. With zero candidates the Prerequisites
row stays focusable but cannot open the picker. The draft starts in Sky; Graph roots start in the first legend
kind. `composerFocus.js` owns shared layer focus, viewport hooks and `coverBeneath`. The shared `KindChoice`
lives in `BoardControls.jsx`, and every surface fills it from `kindChoices` in `model/Legend.js`, so the composer, the
bulk bars, the Graph's dock and its tablet panel show one order and a choice never reorders the row. The dock and the
tablet panel use it with `follow={false}`: arrow keys only move focus, a press saves at once and the kind in force writes
nothing. The dock previews a hovered kind on the node and adds Manage kinds beside the heading, which opens the legend.

## The Graph

From 744px the camera controls form a bottom-right pill whose viewport block clears the dock or tablet panel;
phone camera controls sit beneath the measured row. From 744px the selected-step dock sits beneath the
measured identity and any refusal banner, so neither is covered, and the row's menus stand over it. The tablet Graph keeps its panel editor, aim,
link removal and multi-select surfaces.

A roadmap keeps a root, by one rule for every door: `takesEveryRoot` in `board/acts.js`, which `deletable` builds on, asked of
the tree a held delete leaves standing. A sole root, the last root under a hold and a select-all on a many-rooted roadmap all
read the same. The desktop dock, the tablet panel, the selection bars and the phone Board's bulk bar stop offering Delete while
they hold such a selection, the Graph's writes refuse it, and a Delete key on it does nothing.

The owner's Next chip reads the unfiltered `Board.upNext` in Roadmap order, including a one-step roadmap, and
hides at zero. Picking a row selects and reveals that canvas step.

On the phone Graph, a single selected step shows a bottom bar with its title and derived state. Owners open
its step page from Open step; readers and the demo open it from the title and keep Fork as the primary action.
The detail opens over the Graph, and Back preserves selection. The bar replaces the reader's Fork pill while
visible. Its measured height clears the canvas, refusal card and Graph toast. Focus in the bar moves to the row's
pressed switch option when a tap deselects, and that tap's compatibility mousedown keeps it there. The phone Board receives its
Fork opener through `onFork`, without pill padding. From 744px Fork opens the centred dialog; phones open the
sheet.

Graph toasts keep their intrinsic width, centring in the free canvas when they fit or across the canvas
otherwise; `graphToastPlacement` owns measured clearance from the camera, minimap, panel and legend. Phone
Graph toasts hold the bottom slot, above the selected-step bar and any refusal card. Created steps reveal after the scene receives
their model and the selected-step panel's insets.

The demo's coach chip takes Escape only while it is the top thing on screen, and its card seats clear of the phone's
Fork pill and selected-step bar.

## Toasts and Undo

`useRoadmapToast` is the room's one toast slot, with one hold that starts when a toast is first shown; a newer toast
replaces the older, with no coalescing. The unavailable Graph reason is suppressed while a held delete stands,
so that press cannot replace its Undo or release the delete early; other Undo toasts follow the replacement rule.
`toastSeat` says where a toast stands: a Board toast inside `BoardView`,
where it waits out the regroup; a Graph toast over the canvas, leaving with it; anything else over whatever is
showing. `BoardToast` renders them all but Ask AI's answers, which keep `tending/TendToast.jsx` and its Why?. A plan pasted with
⌘V announces on whichever view took it, so its toast and Undo stand there, and the composer's count is what the graft adds.
Complete, Create, Recolor and a tree attached or detached hold six seconds and Delete nine. Remote completions keep their announcements.

Complete toast text reveals the single newly Up next step, or the completed step when zero or several unlock;
Create reveals the new step. Reveal clears only query dimensions that hide its target and preserves sort.
Delete toast text is not tappable. Board completion keeps activity emits and skips the Graph ceremony and
milestone offer. A Graph completion without a milestone offer has a six-second toast; a milestone offer keeps
its canvas ceremony. A reader's copied link uses the same slot without Undo. Graph-toast Undo tries focus on
the action's captured control when it stays connected and uncovered, then falls back to the pressed view
switch.

**Toast Undo is targeted; ⌘Z is global.** A toast's Undo reverts its own act and later unrelated gestures stand.
Complete restores that step's progress and a held delete cancels. Every other write holds its session receipt:
`SyncSession.dispatch(gesture)` returns an opaque receipt or null when nothing applies, and `receiptUndo` calls
`revert(receipt)`, which restamps that captured inverse once, leaving alone any field written since the receipt by this
person or a peer, and removes it from the stack. A write the session refused says nothing happened. Ask AI wrote on the
server, so its Undo deletes exactly what the run says it planted.

⌘Z and ⇧⌘Z walk the session's global structural stack across both views, refused under a covering layer and in a text
field. A held delete is the last act though it is not on the stack: ⌘Z during a hold cancels it as the toast's Undo does,
and touches nothing on the stack (`SyncSession.holdAct`). ⌘Z and ⇧⌘Z bump the session's `receiptVersion`, so a toast
backed by a receipt leaves: no Undo offer stands once there may be nothing to undo. A later write with no toast of its own
takes an earlier receipt's toast with it when ⌘Z undoes that write. A successful discard invalidates session Undo and Redo
and captured receipts, and dismisses only toasts backed by those receipts.

## Domain and shared geometry

`SkillTree` validates the DAG, builds indexes and derives render nodes. `renderableGraph.js` supplies a
best-effort projection when replicated state contains cycles. `TrunkTree` chooses one primary parent per node
for layout: same-kind parents first, then depth and id; siblings keep their fractional order and
creation-stamp order.

`UnlockRules.derive` is the authority for locked, available and complete, off the completed set `UnlockRules.completed`
gives; the same file answers what a step
still owes (`owedStepsOf` for one step, `owedCounts` for every step in one pass) and what completing it opens
(`unlocksOf`). An edge inherits its source node's state. Legend order lives in the lattice and is written by
`ReorderKinds`; `Legend`'s array operations also serve import drafts. Genesis kinds and stamps come from
`packages/api-contract/genesis.js`, checked by `vite.config.js`.

`theme.js` supplies WebGL's resolved light and dark palettes, shared geometry and the DOM kind-hue fallback.
Kind chooses hue; progress chooses tier; structural form distinguishes linked, unnamed and unlinked nodes; a node that
opens a tree draws that tree's mark as its glyph, by the names `TREE_GLYPHS` gives a render node's `icon`.
Node bodies, root and selection scale, zoom floors and caption dimensions must agree across shaders, overlays
and layout. `model/footprint.js` estimates disc-plus-caption bounds from label length, without DOM
measurement.

`copy.js` holds words and count sentences several surfaces read, and ceremony structure and timing read none of it.

## Layout

`layout/LayoutEngine.js` defines the layout contract and each engine's caption and reorder capabilities.
`pageLayoutEngine()` and `layoutTree()` serve the canvas, quest thumbnails and paste ghosts. `?layout=`
accepts `bubble`, `radial`, `rings` or `mindmap`; unknown names use bubble. Radial is the synchronous fallback
for an alternative import or layout failure; failure of the fallback itself propagates. The returned effective
engine controls reorder gestures and saved-camera identity.

| Engine | Geometry | Reorder |
|---|---|---|
| Bubble, default | Child fans, footprint-aware subtree tucking and packed root islands | Parent arc |
| Radial, fallback | Trunk-depth rings and subtree-sized angular wedges | Ring |
| Rings | Caption-aware contour packing on depth rings, with separate root islands | None |
| Mindmap | Tidy branches distributed across twelve directions | None |

Engines are synchronous, stateless and deterministic. `readsCaptions` declares whether renaming requires
layout. Bubble's tuck has a deterministic work ceiling; an unfinished move is discarded, leaving the remaining
subtrees in their enclosing-circle positions. This ceiling covers the tuck, not every phase or wall-clock
latency. Marketing scenes use hand-placed coordinates.

## Renderer

`SkillTreeScene` exports `GraphUnavailable`, thrown only when `getContext('webgl2')` returns null.
`useRoomScene` owns `graphAvailability` for the room's life: `pending`, `available` or `unavailable`. It catches
that typed answer before paint, never retries it and emits `webgl_init_fail { band }` once per visit. Absence reports no Sentry Issue, starts no frame loop and
keeps Graph chrome, Graph loading, canvas-only demo coaching and Graph toasts out of the painted view. The
renderer emits no availability telemetry. Minimap mounts only while the canvas view is active. Other
constructor errors propagate unchanged to the render boundary.

Scene construction runs in a layout effect. On WebGL2-capable devices, GL setup and shader compilation block
the first paint. A changed write handler reconstructs the scene in that effect and incurs the same synchronous
setup and compilation cost before the next paint.

`SkillTreeScene` owns `Camera2D`, `NodeBatch`, `ConnectorBatch`, overlays, `CeremonyDirector` and input tools.
React supplies models, progress, selection and viewport insets. The continuous frame loop advances camera and
motion, repositions overlays and draws one node batch and one connector batch, and stops while the Board is
shown. Theme changes update GPU and DOM colours together.

Captions are keyed by node id. `captionLayout.js` prioritizes selection, hover, family, landmarks and
available steps, avoiding chrome, labels, discs and ribbons. Selected and hovered labels stay visible when
collision-free space runs out. Distant glyphs use `IconAtlas`; close glyphs use a 64-slot DOM pool.
`edgeCurve.js` supplies connector and caption-collision geometry.

Picking accepts the drawn disc; pointer and touch hit floors stop halfway to the nearest neighbour. A crowded
hit zooms into the group. `graph/viewport.js` supplies the camera and captions with both edge insets and corner
obstacles; content-sized chrome measures itself.

Keep these rules when changing the renderer:

- Place overlays from the live camera and do not transition their per-frame CSS transforms.
- Keep `NodeBatch` glyph colour math aligned with `NodeOverlay`'s `glyphCssColor`.
- Caption visibility is `st-label--shown` and computed opacity and visibility, not `display` alone.
- Use `CeremonyDirector.busy()` for ceremony state: pausing rendering does not cancel its timers.
- GPU selection comes from `setSelectedSet(selectedIds)`. Mixed node and edge selections cannot be represented
  by the single-node projection; reconciliation uses `projectEdge`, not a pick action.

Settles update affected GPU ranges once per frame. Reduced motion freezes pulses and snaps growth. Spatial
queries scan stored nodes when traversing grid cells would cost more. These bounds do not establish a
frame-rate guarantee. The [capture rig](../../../scripts/roadmap-rig/APPARATUS.md) checks settled pixels and
DOM geometry; `scripts/benchmark-board.mjs` measures the Board under CPU throttling; hardware-backed timing
needs a separate run.

## Synchronization and storage

The [graph synchronization contract](../../../../docs/GRAPH_SYNC_DESIGN.md) defines the wire format, coverage,
acknowledgements and durability limits.

**Registers.** A node's last-writer-wins registers are one list (`NODE_REGISTERS` in `sync/lattice.js`) that the join's
clock, the frontier, the frame and Undo all read. `opens`, the tree a step opens, is one of them: joined by its stamp,
stored, owed to the server until confirmed and restored by Undo like the rest. The server hides the pointer from a
caller who cannot write the tree, so only a writer's answer speaks for pointers: `SyncSession.reach` is the subscribe
answer's `reach`, and a `sign-in-required` or `no-such-tree` refusal turns it to `reader`. A writer's full graft is the
server's word on pointers, an older or empty one included. A reader's, or an answer with no `reach`, leaves confirmed the
pointers the server confirmed before (`TreeLattice.pointers` carries them across the rebuilt baseline); while the session
reads as a reader no pointer write leaves the device, and one it wrote stays owed until a writer answers. An answer that
turns from reader to writer subscribes again from an empty vector, so a pointer changed meanwhile arrives.

**Gestures.** Shared structure and private progress use one socket and HLC clock but separate frames. Pending
writes are derived from lattice state. `materialize.js` turns each local gesture into stamped field writes;
refusal handling uses machine codes rather than error sentences. `EditNode` stamps the changed name,
description, kind and prerequisite edge additions and removals together. `SetNodeTree` stamps the tree a step opens,
`''` for none, and writes nothing for the tree it opens already. A local write that takes a pointer away releases
the mark set aside on its step, as a peer's frame does. `DeleteNode` and `BulkDelete` retire
all present incident edges of their deleted steps in the same stamped gesture as their tombstones and
respliced edges, so those edges cannot raise the masked-work Restore offer after a reload. Undo restores the
captured node lives and edges; concurrent peer edges stamped after that gesture stay recoverable through
masked work.

**Device storage.** The stores in `persistence/` keep what never syncs: the last place, the view, the legend, workspaces and
the ledgers. Each reaches the browser's storage through `browserStorage.js`, so a browser that refuses storage leaves a room
that opens and remembers nothing, with nothing reported.

**A write acknowledged is a write kept or a write that says so.** A browser that refuses the sync database leaves the same
records in the document's memory (`SyncStore`, one console warning, no Issue). The epoch check, saves and Discard run as ever,
a signed-in owner's writes reach the server, an unsent write survives a roadmap switch in that document, and only offline
durability is gone. A database that opens later in the document takes those records back. A read that fails on a database that
opened means the send cannot be made: the bank stays, `roadmap-sync-send` reports, and the lane stands the existing refused card
with Retry and Discard. A signed-out plant has nowhere else to stand: `bearLocalTree` and `bearImportedTree` throw a `SecurityError`
unless the device index takes a write and the database opens, and a save that fails takes its index row back.
The new-roadmap door asks `deviceKeepsTrees` first: short of a signed-in account, a browser that will not keep a plan says
*Couldn't open this device's saved work* and offers no field, and holds that line from the shell's own alert so it is said once.

**Local failures.** Every local structural apply, including dispatch, targeted revert, global Undo and Redo,
tree rename and guide write, contains notification, persistence and transport failures after the lattice join. Applied
dispatches keep their receipt, and persistence or transport failures mark durability at risk. Pre-apply
failures still throw. A progress mark's save reports the same way. The receive path stores the lattice and its
separate confirmed baseline. Socket send failures preserve pending writes and reconnect for a fresh graft.
A server frame whose notification fails reports `roadmap-sync-notify`; one that cannot be parsed or joined reports
`roadmap-sync-frame` once per session; a stored lane that cannot be read reports `roadmap-sync-restore` once, and the graft
fills it. Invalid progress rows are skipped individually and report `roadmap-sync-progress-mark` with only the
progress lane tag; valid marks in the same server frame, stored record or legacy drain still join. A socket with no inbound frame for ten seconds, online and in view, reports `roadmap-sync-socket` once; any frame
clears the count, including a refusal, so a signed-out device tree stays quiet.

**Status.** `SyncSession.subscribeStatus` delivers immutable snapshots of both lanes' unconfirmed user writes,
pending gestures, unconfirmed in-flight frames, socket phase, browser connectivity and the current refusal.
`sync/pendingWrites.js` owns unconfirmed-register comparisons and pending-gesture accounting for the session,
stored lanes and device-tree renames and guides. Status and transport share the per-register outbox rule against confirmed baselines, independently of
the subscription's actor coverage; transport excludes identical stamps already in flight. A full structure graft
replaces its confirmed baseline; a lower room sequence triggers an empty-vector resubscribe for that full state.
Partial grafts join structure confirmation, and every complete progress graft replaces its confirmed overlay.
Lost server writes then become pending and replay; write replies and heartbeat pongs settle unanswered frames.
Each local gesture contributes one HLC stamp, or one per frame when it is too large for one (`sync/frames.js`), and its written register references under its first. Pending gestures persist with each lane, survive retries and reload, and clear on confirmation of
their fields or discard. A partial acknowledgement or a newer unrelated write cannot confirm the rest of a
gesture. Legacy records recover distinct surviving stamps; overwritten gestures cannot be reconstructed. A stored
gesture's reference to a register its lane's lattice does not hold — a node position a stored record still names,
or a mark whose stamp no mark can carry — is dropped on load and save (`retainedGestures`), so it is never owed.

The session keeps one refusal per lane; ownership and authentication refusals keep their existing host path.
Reading the snapshot does not mutate those facts, and status emission does no work without subscribers. The
drain path clears refusals whose lane has no pending writes. `subscribeRefusals` delivers refusal records
independently of status snapshots; the host attaches one reporting callback per session, deduplicating bounded
codes without React state updates.

`sync/status.js` derives Offline after a three-second socket grace (immediately when the browser is offline),
Saving after 300ms pending, and Saved for two seconds after a live drain. Refusals suppress Saving and Saved.
Discard rebaselines do not count as user writes or produce a Saved announcement, and an online rebaseline does
not claim Offline. The host supplies the clock and publishes through the product-neutral
`shell/roomStatus.js`. Sync status belongs to signed-in owners; readers and the demo publish none, and a
device line takes precedence.

**The Shell's slot.** The room-status service separates its registration lease from the current payload. An
eligible owner keeps that lease while idle; releasing it removes the Shell slot, and a superseded lease can
neither publish nor release the next room. The Shell mounts an empty polite live region before its first text
and keeps the node across idle, Saving, Saved and Offline. From 744px the line is visible; phones show the
short form where supplied. Registered phone rooms reserve the status slot and keep the mark hidden throughout
the visit, so status changes do not move navigation. From 744px status hugs its words, 16px left of the seat;
the room links stay fixed as the status changes, and the seat's target ends 16px from the viewport edge.
Phone device-only rooms keep an empty publication for the Sign in seat, with their device text below the identity row. Readers
and the demo publish nothing: on phones `sharedShell` alone gives them the same links and seat, with no slot, and
the global offline notice stays theirs. The global offline notice yields only while a room publishes
`connectivity: 'offline'`, before first paint; a registration or device-only line does not replace it.
An eligible signed-in room subscribes to the platform sync session and publishes Offline inside the same
publish that turns it offline, so React renders both together and never commits the global notice; its
ordinary sync reading then keeps that publication.
Below 360px Saving and Saved are announced only, and Offline uses a named icon button
whose controlled Tooltip opens below the slot for four seconds, until another tap, an outside tap or Escape.

**Refusals.** The host passes refusal code, refused-lane gesture count and stable Retry and Discard actions to
the shared `RefusedSync` on both views. The notice owns capacity-specific Retry suppression and uses the
refused-lane count for its message and Discard label. The Graph measures its notice into the camera's usable
viewport and clears the selected-step dock from 744px; on the phone Graph the refusal card clears the
selected-step bar or the reader's Fork pill. Retry clears the refusal and reconnects through the existing
graft and flush path. Phone toasts wait while a refusal stands so Retry and Discard stay reachable, except a held delete and
its failure: a hold must run and its Undo stay reachable, so that toast stands above the refused card, as the bar's stacking in
03.13 does, with no overlap at 390 or 320.
Progress-based completion Undo stays available during a structure-only replacement and rebaseline, its durable
save waiting for the replacement's new epoch. Structure edits stay blocked during rebaselining, a
progress-lane replacement blocks progress editing, and the composer keeps its draft with saving disabled. An
unsent held delete stays available.

**Tree registers.** The title and the guide are the tree's own registers beside its graph and legend. A rename or a guide
write stamps one register outside the undo journal and saves with the structure lane; a flush sends its writes in stamp order,
each register in a frame of its own, so a refused register strands no step edit; a device tree's stamped guide reaches the
server through the claim's first flush, once the tree exists there, since a planted document never sets one.

**Created time.** Each projected step carries `createdMs`, the wall time of its add stamp: when it joined this
tree. Create stamps it, an import stamps it on a step the tree did not hold, a fork re-adds every step at the
fork, and edits never touch it, an import's re-send of a step the tree holds included. A genesis
seed reads `null`, unknown. A restore re-adds the step with a fresh stamp, so its `createdMs` becomes the time
of the restore.

**The store.** `SyncStore` keeps projected `frame` and `progress` lanes, `lastSeq`, per-lane `epochs`, and
separate server-confirmed baselines in one IndexedDB record. Baselines join server grafts and live writes, or
the exact retained sent writes after their acknowledgement; local pending writes never enter them early. A
legacy record starts at epoch zero with unknown confirmed baselines.

Every save carries the epochs its writer loaded. Its transaction joins only matching lanes and returns a typed
stale result for any older epoch; an unaffected lane can still save. Discard atomically takes the registers its tab
showed out of the refused lane, over the confirmed baseline, and increments only that lane's epoch; another writer's unsent
registers stay in the record, and the discarding tab flushes them with its next graft. The current session projects the
confirmed lane immediately, without waiting for storage or a server reply; a failed replacement restores the pending
projection. The Board skips regroup animation for the replacement. An offline reload opens the stored
confirmed roadmap. Discard prevents stale saves and re-sends after the atomic epoch bump; it cannot retract
frames already sent before that commit or undo writes the server has accepted.

Epoch notifications tell live tabs to adopt the stored lane and reconnect. An adopting tab keeps the writes its own
replica stamped and the server does not hold, stores them and sends them after its graft, so a discard elsewhere takes only what
that tab showed; it blocks new edits until the graft, as the discarding tab does. Every structure or progress write
send checks its epoch inside an IndexedDB read transaction, and a read failure keeps the pending bank; a
delayed epoch notification cannot bypass the check. A closing session's socket waits for sends that have begun. Epoch subscriptions close with the session. Renaming a
device tree or writing its guide carries the loaded epochs and retries a stale result; moving one keeps its source if the
destination rejects an epoch. Saves are serialized, expose their transaction result to the caller, and keep
the queue usable after failure. An in-memory edit alone is not confirmed durable.

A closed socket clears both lanes' in-flight bookkeeping without dropping their pending lattice writes.
Progress rejections also clear their in-flight entry. Events from superseded sockets do nothing, reconnect
timers are deduplicated, and closing a session sets its phase offline.

**Device trees.** `LocalTreeRegistry` associates device trees with accounts, and device reads require a server
answer or the shell's restored active bound replica. A remembered face does not authorize a store read. On a
cold 401 or offline read, the registry bounds its wait for the engine's holder answer to two seconds, so a
stuck engine cannot indefinitely hold public links, the demo or the roadmap list. The shell's owner rule
refuses restoration during sign-out or pending cleanup. A session lapse keeps the device owner and pending
work without granting session authority; the room shows the lapsed device line. The same account's sign-in
resumes synchronization without remounting the room. When the server confirms a different account, the shell
synchronously unmounts the previous holder's room and shows its loading state through device cleanup and
account binding. Pending cleanup also blocks the room on reload; a failed cleanup keeps it blocked for retry.
A fresh sign-in can retry an unavailable read; ordinary signed-in cold loads compare against
the owner the read actually used and do not reread when the shell settles. Explicit sign-out and account
replacement atomically record pending device cleanup with the replica transition. The shell replays it before
engine networking on reload and clears it only after product cleanup finishes; roadmap blob deletions must
commit before their index stamps are removed. A failed cleanup retains the marker for retry. The marker grants
no session or device-read authority. `ProgressStore.drainInto` migrates
older local marks into the private lane. Displayed completion dates use the server's `markedAt`; local
completion clocks support only incomplete local history.

**Sharing.** `ShareDialog` waits for successful publication before copying a public `/t/:id` link. The owner
sees that anyone can view or fork it and that it may appear in the gallery. Clipboard failure leaves the URL
selectable; owners can make a tree private again.

## Open work

- A WebGL2-capable device whose renderer fails to build still crashes the room through the existing render
  boundary; shader and program errors are not treated as WebGL2 absence.
- Context loss after a successful construction is unhandled.
- Desktop Activity has no destination without the Graph; its row offer and shortcut stay absent pending a
  design in the [consistency ledger](../../../../docs/design/consistency.md).
- Icon slots are reassigned by distance rank each frame; stable node ownership could remove unnecessary
  sorting and slot swaps.
- Remote structural deletion prunes scene selection without pruning React's selection sets, so the
  multi-select count can go stale.
- Undo does not reconcile the append-only activity log; rows for removed nodes render muted.
- Layout runs on the main thread, under the Board too. Large trees and repeated live edits need an interactive
  latency budget beyond the tuck ceiling.
- The unlinked-node reconnect tag, activity burst coalescing and narrow activity-dock collapse are not built.
  Design gaps belong in the [consistency ledger](../../../../docs/design/consistency.md).
