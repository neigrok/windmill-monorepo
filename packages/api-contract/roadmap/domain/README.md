# Roadmap domain corpus

Each JSON file holds `{name,input,expect}` cases, except `rules.json`, the pinned rule book. The web
corpus (`web/test/products/roadmap/domain/corpus.test.js`) claims every file by name and compares
complete outputs. The server's read domain (`backend/products/roadmap/domain/read/`) claims the reads
the table marks as the server's, by JCS, in `backend/test/products/roadmap/domain/read/ReadVectorsTest.cpp`,
which fails on a file it neither claims nor names as a device's. Swift's domain (`apps/ios/Domain/Sources/RoadmapDomain/`)
claims, by JCS, in `apps/ios/Domain/Tests/RoadmapDomainTests/`, the reads' files (`account`, `activity`, `board`, `diagnostics`, `graph`,
`guides`, `landing`, `legend`, `pointers`, `progress`, `replica` and `search`), `rules.json`, `values.json`, and every
`*-actions.json` (`roadmaps`, `steps`, `kinds`, `progress`, `workspace` and `landing`), each action case with its records
reversed too, and the scenes of `undo.json` (`UndoTests.swift`). Its `CorpusTests.swift` fails on a file it does not claim.
The pure reads below take normalized domain records; the actions, `values.json`
and `rules.json` follow [the domain kit](../../../../docs/foundation/domain-kit.md) §15.3 over engine
rows and `../../sync/roadmap.registry.json` (see [Actions](#actions)). No operation reads storage,
time, randomness or localization.

## Pure reads

`RoadmapTree` constructs the supplied normalized tree, nodes and kinds. Trees retain `present`,
`read`, `own` (the tree is in the person's own list), `updatedAt` (when the server last received any
record of it, or null), immutable `parent`, metadata (`meta: null` where its tree scope holds no meta),
every node record including absent ones, every edge's presence, marks and pointers. D-3: a root stands
once its tree scope holds its meta; a loaded root without it (a creation or a fork under way) is hidden,
with every subtree under it, so it has no title, count, list row or address and a pointer at it dangles.
An unread root keeps standing, as nothing is known of it. `born` is an engine stamp string or null; `rc`/`ru`, `recordedAt`/`deviceAt` are
millisecond instants or null. Optional `mark.stamp`, `pointer.setAt` and `node.branchStamp` are
full engine stamps, not instants. A mark is personal progress; authored node `status` never supplies it.

IDs compare as UTF-8 bytes through domain-kit `compareText`; stamps through `Stamp.compare`.
Authored and sibling order is `(ord, born, id)`, missing birth normalized to `Stamp.UNSET`
(zero). Empty order sorts first. Other ties keep authored order unless an operation specifies
ID byte order.

| Operation | Complete result | The server claims it |
| --- | --- | --- |
| `graph` | Present IDs and states in authored order; requested subjects with followed prerequisites, unmet IDs, owed IDs/count and completion-unlocks | yes |
| `account` | Trees by ID with standing, place/path/title, counts, completion and openings; pointer-loop components | yes |
| `progress` | Effective completed IDs and dates under openings, null for an unread/hidden tree | yes |
| `guides` | Nearest eight nonempty guides including own, displayed farthest first, ID byte ties | yes |
| `legend` | Authored kind IDs, hue owners and collisions, and the legend shown, which a paste reads over: each hue's owner in the kinds' order, then each hue a present step wears that no kind claims, in the palette's order, with a null id | yes |
| `search` | MCP node IDs, with independent kind/color filters and relevance order | yes |
| `board` | Overall progress, query facts, three columns, folding and structured card reasons | no |
| `diagnostics` | Bounded graph errors and warnings | yes |
| `pointers` | Shortest pointer-loop paths and known dangling targets, with omission counts | yes |
| `landing` | The device's own links (`edges`) whose current followed prerequisites bridge absence | no |
| `activity` | A roadmap's Activity, or one step's History: each present step's creation and completion the copy holds a time for, newest first; null for an unread/hidden tree | no |
| `roadmap` (`replica.json`) | One roadmap's records as a replica holds them, as the normalized tree | no |
| `openings` (`replica.json`) | One tree's openings as `account` reads them, without reading every tree, with what a read elsewhere tells (`told`) | no |
| `progress` (`replica.json`) | `progress` with what a read elsewhere tells (`told`) | no |
| `list` (`replica.json`) | The person's own roots that stand, newest first by `updatedAt`, none received last, ID byte ties | no |
| `listing` (`replica.json`) | One roadmap that stands, whoever owns it, as a list shows it, null for one that does not stand | no |

`readRoadmap` (`roadmaps.js`) reads one roadmap from a device's replica: its tree scope's steps and links as
`readTree` reads them, absent ones kept, each step with its `rc`, `ru` and the stamp of the subtree it owns;
its meta with the server's `parent`, `depth`, `reach`, `guideInherited` and `forkedFrom` (the roadmap a fork was copied from, null for
one that is no fork), null where the scope holds none; its kinds; and, from its owner's
overlay, the marks and pointers (a roadmap someone else owns takes no overlay). Its record in the person's
list, where there is one, makes it `own`, says whether it is present and where it sits; without one the meta
says where. A roadmap is read once the device holds the server's whole copy of it (`read`: the first pull of every
scope it is read through has ended), or where it holds records of its tree scope and the server has sent none of them,
nor of its overlay (none carries an `ru`): a roadmap the device made, which the server does not hold yet. A pull under
way leaves it unread, whatever rows it has brought. §5 Dates: the server has received a mark once no entry the device queues (held, ready, sent or
acked) still changes its record, and its `recordedAt` is that record's `ru`; a mark an entry still changes is the
device's, with no `recordedAt`. Every mark's `deviceAt` is its stamp's milliseconds. `updatedAt` is the newest `ru` among the
roadmap's record, its tree scope's records and its overlay's.

`FollowGraph` reads every live incoming edge. A present predecessor is a boundary. Any other endpoint
is traversed, including an ID with no node record. Missing records remain diagnosed separately from
known absent nodes. An absent-only cycle adds no phantom prerequisite. An effective self-follow is a
real blocker and cycle. Repeated routes count once; `incoming` retains each immediate edge `[from,to]`
entering the subject that reaches that followed ID, in endpoint byte order. `throughAbsent` says at
least one such route passes a nonpresent endpoint. Lists of prerequisites and owed IDs use authored
order. Owed closure stops at completed prerequisites and excludes the subject, even when the subject
itself was completed out of order. Completion-unlocks excludes the subject and nodes already
complete. Cycles terminate; no graph projection cuts their edges.

Unknown tree IDs and unread trees stay unknown/unread: neither is an empty complete tree or a
known dangling pointer. A known absent/nonstanding target dangles. Pointers target roots; a step's
standing subtree takes precedence. Unknown/unread branches retain precedence until resolved;
a known invalid/nonstanding branch falls back to the pointer, or to the ordinary mark when no
pointer remains. `pointers` diagnostics retain the stale branch independently of the effective
opening. Hidden subtrees have no address/count/title. A subtree's title is its owning
step's label. Completion is the least fixed point; empty/unread trees are incomplete. Valid and
unknown openings set personal marks aside; dangling pointers retain the mark's meaning.

`told`, which the `openings` and `progress` cases of `replica.json` give, is what a read elsewhere says roadmaps have come
to, `{tree, done, total}`, as a reader's progress answer names the subtrees a roadmap's steps own (`GET
/v1/trees/{id}/progress`, its `subtrees`). A roadmap the device holds no read copy of, unread or not held at all, and not
hidden, counts as it is told and completes once it has steps and every one is done; an opening of it keeps its `unread` or
`unknown` status and carries those counts, and a step it completes is dated by its own complete mark, stamped or not, as
that read dated it, else as any complete opening is. A roadmap the device has read counts from its copy whatever it is told.

`progress` dates an ordinary mark by when the person made it: its device time (`deviceAt`), falling back to the server's
receipt (`recordedAt`) where the mark holds no device time, none or one at the epoch.
For a complete opening it reproduces `readerView`: a stored complete mark with a non-UNSET stamp
keeps its date; otherwise the later stamp of target completion and the pointer/branch register
supplies the date. The target's latest mark is selected by full stamp, carrying that mark's date by
the same rule; a pointer/branch stamp carries its own physical milliseconds. Unstamped evidence cannot
supply an effective opening date. With neither source known, the date is null. `account.graph(id)`
passes these effective dates into Board reads. A standalone graph has ordinary mark dates only
and treats supplied opening identities as unresolved, setting their marks aside. `account.graph(id)`
resolves valid and dangling openings.

`activity` is what Activity and a step's History show, read from the device's copy alone (the iPhone's
[Roadmap on iOS](../../../../docs/foundation/roadmap-ios.md) §3, R-11). It reads `account.graph(id)`, so a step that
opens or owns a roadmap is completed as the Board's Done has it. A row is `{kind, step, at}` and says when the person did
it: `created` at the step's `born` stamp's milliseconds, the time of its create on the device that made it, else at its
`rc`, the server's receipt of the create, where the birth holds no time (unset, or at the epoch); `completed` at the date
`progress` gives a completed step, its mark's device time first, none where it gives none. A time the copy does not hold
makes no row. Newest first; at one time a completion before a creation, then the steps in reverse authored order, the
last authored first. With `step` it is that step's rows alone, none for a step that is not present. What the copy does
not keep makes no row: a step's earlier name (a row names its step by id, which a reader shows by its label now), a
removed step and its mark, a mark that was reset, and a step unlocking (R-7).

MCP search uses ASCII case folding and does not trim. It ranks exact ID, ID prefix, label
substring, ID substring, description substring, and keeps authored order within each rank. Board
search trims and uses Unicode lowercase, matches only label or description, and never relevance-ranks.
Board kinds are hues (OR); MCP kind is a present legend ID
and intersects color. Board branch includes that present step, ancestors and descendants; a missing
branch does not filter. Board roadmap order is owed count ascending then unlock count descending;
newest/oldest use the step's creation time (`createdAt`: its `born` stamp's milliseconds, else its `rc`), unknown last.
Done sorts by its effective date (an ordinary mark uses its `deviceAt`, else its `recordedAt`), newest first, unknown
last, and folds above twelve unless expanded. Filters never change states or overall counts.

Legend hue ownership is earliest birth (missing is `Stamp.UNSET`), then ID bytes; display order
is independent.
Diagnostics keep the existing limits: fifty entries per error list, ten named nodes per counted
warning/cycle; pointer paths at most eight and pointer lists at most fifty. Missing raw endpoints,
absent-only cycles and effective cycles are separate facts. No cap is a truncation of the graph used
for state or completion. Diagnostic hue order is terracotta, olive, gold, brick, sky, plum;
warning thresholds remain 256 UTF-8 label bytes and more than four effective prerequisites.
Each landing fact retains its bridged immediate `incoming` edges and the `followed` entries they
reach. An absent root or absent-only cycle can leave that followed list empty; it still changes the
new link's meaning and produces a fact. An absent step may have no record at all, as a step deleted elsewhere has
none on a device (engine.md §7.5): it is read through by its links alone. Landing facts are values only; the device's
note, the names its lines take and its clearing are `landing-actions.json`'s.

Run from `web`: `node --test test/products/roadmap/domain/corpus.test.js`.

The harness inputs are `{operation, tree, subjects}` for `graph`, `{operation, trees}` for `account` and `list`,
`{operation, trees, tree: id}` for `guides`, `progress`, `pointers` and `openings`,
`{operation, trees, tree: id, step?}` for `activity`,
`{operation, id, listed, tree, overlay: {drawn, queued} | null, read}` for `roadmap`, its records engine view records and
`queued` the overlay's records (`{t, id}`) a queued entry still changes, `{operation, tree, query}` for `board` and
`search`, `{operation, tree}` for `legend` and `diagnostics`, and
`{operation, tree, own: {nodes: [id], edges: [[from,to]]}}` for `landing`. `subjects` selects detailed graph reads only;
it never narrows states. `query` is Board's `{sort,kinds,search,branch,doneExpanded}` or MCP's `{query,color,kind}`.
Optional query fields have the defaults in `reads.js`.

The read modules are `records.js` (normalized values, authored ordering, the device's landing note, and each
tree's `TreeIndex`: its raw adjacency by slot and its own marks, derived once per tree), `graph.js` (iterative
strongly connected components and compact prerequisite/debt closure over a tree's index), `account.js`
(standing, least-fixed-point completion, effective dates, guides, one tree's openings and the person's list),
`reads.js` (Board, legend, search, landing facts and Activity), `diagnostics.js` (bounded findings), and `readRoadmap` in
`roadmaps.js` (a replica's records as the normalized tree). Detailed followed provenance is enumerated on demand.
A step's state, unmet count and first, followed count and owed count are kept by slot. A step whose parents
are all present follows them directly; only an absent step, and a step behind one, takes a bitset row, so no
read allocates an object for each implied edge through an absent hub. The debt closure takes rows for the
unfinished and absent vertices alone. Disconnected absent records remain in RoadmapTree but do not allocate
graph reachability rows; only present IDs and live-edge endpoints do.

The independent traversal test covers 1,000 random graphs with cycles, missing steps and bitset word
boundaries. Size tests cover 10,000 nodes/20,000 edges, sixteen million implied pairs through one absent
hub, 500 trees at depth eight, and the existing Board median construction/search budget of 50 ms at 5,000
nodes/1,800 unfinished. The timed Board path includes a fresh FollowGraph, state/debt derivation, cards,
sort and search; only normalized record construction, its `TreeIndex` included, stays outside it, as the
legacy Board's `SkillTree` does. Other size timings are reported, not assigned new budgets. Run all with
`node --test --test-concurrency=1 test/products/roadmap/domain/*.test.js`, then `npm run check:domain`.

## Actions

Every gesture of the spec's §5 is an act on the kit (§9.5) in `web/src/products/roadmap/domain/`:
`roadmaps.js` (`tree`, `meta`), `steps.js` (`node`, `edge`, and the import), `kinds.js`, `progress.js`
(`progress`, `pointer`), `workspace.js` (`subtask`, `stepLink`, `stepNote`) and `landing.js` (§6), with
`roadmapRules.js` (specs, limits, the genesis kinds, `RoadmapRefusals`) and `ruleBook.js` (the book over
the registry its caller composes). Files:

| File | Cases |
|---|---|
| `rules.json` | Entity facts and the rule book, compared by `RuleBookParity` |
| `values.json` | Every LOCAL spec, and each writable entity's check order |
| `roadmaps-actions.json` | Create a roadmap (genesis kinds or a legend of its own, first steps, chunks), delete a root held, title and guide, a root's visibility, a subtree made with no connection |
| `steps-actions.json` | Create a step with its links, change and reorder with the step's life, delete held, prerequisites added and retired through absent steps, loops, import in chunks |
| `kinds-actions.json` | Create, change, reorder, delete; a worn hue; the cap; `roadmap.recolourKind` and its predictions |
| `progress-actions.json` | Complete and Reset; a step that opens or owns a roadmap takes no mark; pointers |
| `workspace-actions.json` | Subtasks and links in their step's order; the note saved as text |
| `landing-actions.json` | The landing read and its clearing, by the server's order of a link and a delete; the one list of what cannot land |
| `undo.json` | Each gesture's Undo and Redo on the kit's harness over the reference server with roadmap's binding (K-3) |

**Scenes.** An action case is, as the kit's act form reads it (`ProductCorpus.act`), `{action, input, scopes: {<scope>: {drawn, stored?, confirmed?, spent?}}, device?, ids?, now,
offsetSeconds}`: each scope's records are engine rows (`stored` defaults to `drawn`), `confirmed` the server's copy as
the device pulled it, each row keeping its `seq` (by default `stored`: a record of the device's own the server has not yet
taken is one `confirmed` leaves out), its `spent` ids (`{t, id, born, seq?}`, `seq` that of the dead row, the server's
order of the delete; none by default) are what the device keeps of a step or kind another device deleted, `device` holds
device rows by key, and `ids` are minted in order across scopes. A device keeps no record of a step or kind deleted
elsewhere (engine.md §7.5), so a case draws one as a spent id; a dead record in `drawn` is the device's own delete that
has not yet settled. Its `expect` is `{decision}`:
`{write: {segments: [{scope, gesture}], result}}` with each segment's gesture in the kit's form,
`{unchanged: {result}}` or `{refuse: <refusal>}`. A read case replaces `action` with `read`.
Scopes are `self/roadmap`, `tree/<T>` and `self/overlay/<T>`; the device row is `landing:<T>`, the note
`{nodes, edges, revived, names}` (`names`: `[{id, name}]`, the name of each step a noted link comes from, as it was when
the device made the link, kept only while that link is noted). A line is said (§6) of a noted link, or of a live link into
a noted step, that is read through an absent step whose spent id's `seq` is below the `seq` of the link's `confirmed`
row, the link having landed: its `drawn` record equals its `confirmed` one. A delete the server took after the link, and
one the device knows no `seq` of (a spent id that keeps none, or the device's own delete, dead in `drawn` alone), says
nothing; a link that has not landed says nothing yet. Every act that writes the note first lets go of each entry whose
write has landed and that says nothing: a step or link of the device's whose `drawn` record equals its `confirmed` one,
or that the device holds no record of, and through which no line is said, and a step brought back that is absent again.
Before the tree scope's first pull completes nothing has landed.

| Action | Input | Result |
|---|---|---|
| `CreateRoadmap` | `{title, steps?: {steps: [{key, label, icon?, color?, description?, links?}], links: [[fromKey, toKey]]}, kinds?: [{hue, label?, description?}]}` | `{tree, steps: {key: id}}`; the `tree` record, then its tree scope: the title, the genesis kinds at `a0`–`a2` or the legend `kinds` under minted ids at `a0`, `a1`, … in its order (a kind refused as one made is, or wearing a hue a kind before it wears, at `kinds.<n>`), and the steps, chunked |
| `DeleteRoadmap` | `{tree}` | `null`; held; the device's notes of the root and of every subtree under it (`landing:<T>`) removed in the same segment, unheld; a subtree's record refuses `notARoot` |
| `SetVisibility` | `{tree, visibility}` | `null`; a write of the root's `meta.visibility` under `roadmap.captureTree`, predicting the root's `reach` and the `reach` of every standing subtree of its branch (`scopedPredict`); the visibility the root holds writes nothing; a subtree refuses `notARoot` |
| `CreateSubtree` | `{tree, step}` | `{subtree}`; `roadmap.createSubtree` in `self/roadmap`, predicting the subtree's record, its `meta` (`root`, `parent`, `depth`, `reach`) and genesis kinds, and the step's `branch`; a step the device knows as deleted (dead in `drawn`, or a spent id) is revived in a segment before it and noted; a step that owns a subtree answers it unchanged; a pointer refuses `stepOpensARoadmap`, a depth past eight `depthLimit` |
| `WriteRoadmap` | `{tree, title?, guide?}` | `null`; the changed fields of `meta` |
| `CreateStep` | `{tree, step: {label, icon?, color?, description?, links?}, prerequisites, id?}` | the step's id: `id` where its surface minted one to show the step before its write lands, else minted here; the step after the steps its first prerequisite leads to (or after the first steps), one link from each prerequisite, a prerequisite deleted elsewhere included, and the landing note with the name of each prerequisite the device holds; an `id` the roadmap holds, a deleted step's included, refuses `taken`; a prerequisite the device never knew is `gone` |
| `ChangeStep` | `{tree, step, changes}` | `null`; a `revive` naming the changed fields; a step the device knows as deleted is noted `revived`, and one it knows only by its spent id is revived with every field the change names, its other fields the server's |
| `MoveStep` | `{tree, step, below, siblings}` | `null`; `siblings` are the trunk parent's steps the layout names; the key between `below` and the next sibling, as a `revive`; a drop in place writes nothing |
| `DeleteStep` | `{tree, step}` | `null`; held; the step's death alone |
| `ChangePrerequisites` | `{tree, step, add, remove}` | `null`; a removed prerequisite followed through an absent step retires each link the step reaches it by; an added link is noted with the name of the step it comes from |
| `ImportSteps` | `{tree, imported, under?, done?}` | `{key: id}`; under `under`, each step the import has no prerequisite for follows it; the landing note takes the name of each step a link comes from; each key of `done` takes the person's `mark`, complete, in a segment of the same act in their overlay |
| `CreateKind`, `ChangeKind`, `MoveKind`, `DeleteKind` | `{tree, kind: {hue, label?, description?}}`, `{tree, kind, changes}`, `{tree, kind, below}`, `{tree, kind}` | the kind's id, or `null` |
| `RecolourKind` | `{tree, kind, hue}` | `null`; the command, predicting the kind's hue and every step the device holds wearing the old hue, present or not, by id; a kind the device knows as deleted is revived in a segment before it, and of one it knows only by its spent id it predicts the kind's hue alone, the server recolouring the steps |
| `Complete`, `Reset` | `{tree, step, outOfOrder?, opensStanding?}`, `{tree, step}` | `null`; the step's `mark`; `opensStanding`, read by the caller from the account, says the step's pointer opens a standing roadmap |
| `SetPointer`, `ClearPointer` | `{tree, step, opens}`, `{tree, step}` | `null` |
| `AddSubtask`, `ChangeSubtask`, `MoveSubtask`, `DeleteSubtask` | `{tree, step, label, id?, done?}`, `{tree, subtask, changes}`, `{tree, subtask, below}`, `{tree, subtask}` | the subtask's id, or `null`; one given its `id` is made once, nothing written where the overlay holds that id or knows it deleted; a move lands below another of its step's subtasks; a delete is held |
| `AddStepLink`, `ChangeStepLink`, `MoveStepLink`, `DeleteStepLink` | `{tree, step, link: {url, title?}, id?}`, `{tree, link, changes}`, `{tree, link, below}`, `{tree, link}` | as subtasks; a delete is held |
| `SaveStepNote` | `{tree, step, text}` | the draft save's `{values, exists}`, decided as `{write: {gesture, result}}`; the note opened from `drawn` or new |
| `ClearLanding` | `{tree, told: {nodes?, edges?, revived?}}` | `null`; written in `self/roadmap`: the note less what was told and less what has landed and says nothing, or no row; no row at all where the roadmap is gone from the person's list (its `tree` record dead or absent in `drawn` once `self/roadmap`'s first pull completes) |
| read `landing` | `{tree}` | `{follows, cameBack, note}`: `landing` facts over the links whose lines the note says, each with `removed` (`[{id, name}]`, the absent steps it is linked from) and each `followed` entry with its `name`; a step the device holds is named by its label, one deleted elsewhere by the note's name, and by `null` where the note holds none; and its revived steps now present |
| read `cannotLand` | `{notices}` | `{listed: [{id, gestureId, reason, made, subject, values}], unexpected: [{id, code}]}`; `reason` ∈ `roadmapDeleted` (`scope-dead`), `capFilled` (`cap`), `accessEnded` (`forbidden`, `not-found`), `noteTooLong` (`too-large` on a note); `made` where the refused content, or a dependent folded into it, creates its subject (its life made alive at its own `born`) |

Limits refuse before anything is written, in this order where a case meets several: the bounds of
the values written, a prerequisite or step the roadmap never held (`gone`), a loop among what steps
follow (`edge.cycle`, `custom` `loop` or `self`; a loop of absent steps alone is admitted), a hue
another present kind wears (`kind.hue.worn`), then the caps by the growth rule. A step that owns a
subtree, or whose pointer opens a standing roadmap, refuses `progress.opening`; a dangling pointer completes. Imports chunk at 500 records and half
`PUSH_MAX_BYTES`, measured as each record's JCS bytes, a step with the links that lead to it.

**Refusal forms.** `{invalid: violation}`, `{gone | taken | tooLarge: {subject, path}}`,
`{full: {type, cap, path}}`, and `{roadmapGone | unreachable | notARoot | stepOpensARoadmap |
depthLimit | other: {code, subject, detail, path}}`.

The web runs every action case through the kit's `ProductCorpus.act`, each with its records reversed too.
`web/test/products/roadmap/domain/harness.test.js` runs the held deletes and their Undo, a subtree and a
visibility predicted across scopes, and changes against another device's delete (INV-1) over the real engine, made
before the delete arrived and after, when the device keeps only the step's or kind's spent id, a link from such a step
with its landing line named from the note, and a link that landed before another device's delete, which tells nothing
and goes with the next write of the note;
against roadmap's reference binding it lands a subtree and a visibility as the server writes them, keeps a newer
private over a stale public sent after it, and ends and restores a subtree's standing with its step.

## Undo (K-3)

Each segment of an action case's write that opts into Undo carries `undo`, its recipes as the engine journals them
(the kit's `translateUndo`): `fields` naming targets `{scope, t, id, slot}` and, for a field unset before the act, the
value equivalent to unset; `createdRecord`; or a product `command` with its evidence. What each gesture names:

| Gesture | Undo | Redo |
|---|---|---|
| A change of a step or a kind, a move of either | `roadmap.restoreTree` of each changed field, and of the life where the device held the record as deleted; of a record it knows only by its spent id, the life alone (`dead`), its earlier values being the server's | writes the change back |
| Create a step, a link, a kind; an import's steps and links | `createdRecord` of each, deleted again while its own writes are all that changed it, and of an import's marks `roadmap.restoreOverlay` of each `mark`, unset `{status: none, outOfOrder: false}`; one act, so one Undo takes every chunk and every mark | revives the step, link or kind |
| Delete a step or a kind; remove a link | the life (`roadmap.restoreTree`); a step's delete is held, and an Undo in its hold cancels it in place | deletes it again |
| A roadmap's title, guide or visibility | the field (`meta`, unset `""` and `private`); the server writes the branch's reach back | writes the change back |
| Recolour a kind | the kind's `hue` and the `color` of each step that wore it; a revival before the command, its life; of a kind known only by its spent id, its life alone | writes them back |
| Complete, Reset | `roadmap.restoreOverlay` of the `mark`, unset `{status: none, outOfOrder: false}` | writes the mark back |
| Set or clear a pointer | `opens` and the life, or `createdRecord` of a pointer the overlay never held | writes it back |
| Add, change or move a subtask or a link | `createdRecord`, or the changed fields and `ord` | the change; a deleted subtask or link is terminal, so the Redo of an add brings nothing back |
| Delete a subtask or a link | none: the type is terminal. The delete is held nine seconds, and `cancelHeld` in the hold is its one Undo | — |
| Create a roadmap | `roadmap.undoCreateRoadmap {tree}` over the record and its tree scope, unchanged since: the roadmap dies while nothing changed in it, its owner's overlay included. Each tree segment is the Undo's evidence (`evidenceForUndo`, `undo: []`), journaled so its receipts prove the scope | none: a new roadmap is a new creation |
| Create a subtree | `roadmap.undoCreateSubtree {tree, step, subtree}` over the step's `branch`, the subtree's record and its tree scope; a step revived before it, its life | `redoCreateSubtree`: the product's slots (`redoCreateSubtree(creation, fresh)` in `roadmaps.js`) plant a new subtree under a fresh id while the `branch` is still the one the Undo cleared (R-8) |
| Delete a roadmap | none after its hold (R-7); `cancelHeld` in the hold | — |
| Save a step's note | the note's `text`, from the text the draft was saved from (`""` for a first note): `StepNote` saves reversibly, so each save is an act; it skips where a write the device had not seen changed the note | writes the saved text back |
| The landing note | none: device rows are the device's | — |

**Scenes** (`undo.json`). `{steps}` → `{outcomes}`, run on the kit's harness over the reference server with roadmap's
binding, and in Swift over the model server with `RoadmapServerRules`. A step is `{run: <action>, input, as?, on?}`, `{save: "StepNote", input: {tree, step, text}, as?}`, `{sync: true}`, `{advance: ms}`, `{undo | redo | read | cancelHeld:
<role>}` (`subtree: true` gives a Redo the product's slots), `{device: <name>}` or `{inspect: {scope, t, fields}}`. An
input names a role's result as `$role` or `$role.path`. Outcomes are a run's kind, a save's result kind, the `InverseResult` without its ids,
`{cancelHeld}`, and an inspection's visible records, each id named by the first role holding it, any other minted id
`<new>`. A product inverse (`undoCreateRoadmap`, `undoCreateSubtree`, `redoCreateSubtree`) draws nothing until the server
answers, so with no connection such an Undo waits and the roadmap or subtree stays drawn. Every restore draws at once:
fields and texts written back, a created record deleted, and a record revived with the fields it had (the Undo of a
delete, a pointer's clear among them, and the Redo of a creation or of an Undo that took a record away).

