# Roadmap domain corpus

Each JSON file holds `{name,input,expect}` cases, except `rules.json`, the pinned rule book. The web
corpus (`web/test/products/roadmap/domain/corpus.test.js`) claims every file by name and compares
complete outputs. The pure reads below take normalized domain records; the actions, `values.json`
and `rules.json` follow [the domain kit](../../../../docs/foundation/domain-kit.md) §15.3 over engine
rows and `../../sync/roadmap.registry.json` (see [Actions](#actions)). No operation reads storage,
time, randomness or localization.

## Pure reads

`RoadmapTree` constructs the supplied normalized tree, nodes and kinds. Trees retain `present`,
`read`, immutable `parent`, metadata, every node record including absent ones, every edge's presence,
marks and pointers. `born` is an engine stamp string or null; `rc`/`ru`, `recordedAt`/`deviceAt` are
millisecond instants or null. Optional `mark.stamp`, `pointer.setAt` and `node.branchStamp` are
full engine stamps, not instants. A mark is personal progress; authored node `status` never supplies it.

IDs compare as UTF-8 bytes through domain-kit `compareText`; stamps through `Stamp.compare`.
Authored and sibling order is `(ord, born, id)`, missing birth normalized to `Stamp.UNSET`
(zero). Empty order sorts first. Other ties keep authored order unless an operation specifies
ID byte order.

| Operation | Complete result | Later server claim |
| --- | --- | --- |
| `graph` | Present IDs and states in authored order; requested subjects with followed prerequisites, unmet IDs, owed IDs/count and completion-unlocks | yes |
| `account` | Trees by ID with standing, place/path/title, counts, completion and openings; pointer-loop components | yes |
| `progress` | Effective completed IDs and dates under openings, null for an unread/hidden tree | yes |
| `guides` | Nearest eight nonempty guides including own, displayed farthest first, ID byte ties | yes |
| `legend` | Authored kind IDs, hue owners and collisions | yes |
| `search` | MCP node IDs, with independent kind/color filters and relevance order | yes |
| `board` | Overall progress, query facts, three columns, folding and structured card reasons | no |
| `diagnostics` | Bounded graph errors and warnings | yes |
| `pointers` | Shortest pointer-loop paths and known dangling targets, with omission counts | yes |
| `landing` | Own newly created steps/links whose current followed prerequisites bridge absence | no |

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

`progress` keeps an ordinary mark's server receipt time, falling back to its pending device time.
For a complete opening it reproduces `readerView`: a stored complete mark with a non-UNSET stamp
keeps its date; otherwise the later stamp of target completion and the pointer/branch register
supplies the date. The target's latest mark is selected by full stamp, carrying that mark's receipt
time; a pointer/branch stamp carries its own physical milliseconds. Unstamped evidence cannot
supply an effective opening date. With neither source known, the date is null. `account.graph(id)`
passes these effective dates into Board reads. A standalone graph has ordinary mark dates only
and treats supplied opening identities as unresolved, setting their marks aside. `account.graph(id)`
resolves valid and dangling openings.

MCP search uses ASCII case folding and does not trim. It ranks exact ID, ID prefix, label
substring, ID substring, description substring, and keeps authored order within each rank. Board
search trims and uses Unicode lowercase, matches only label or description, and never relevance-ranks.
Board kinds are hues (OR); MCP kind is a present legend ID
and intersects color. Board branch includes that present step, ancestors and descendants; a missing
branch does not filter. Board roadmap order is owed count ascending then unlock count descending;
newest/oldest use node `rc`, unknown last. Done sorts by its effective date (an ordinary
mark uses `recordedAt ?? deviceAt`), newest first, unknown last, and folds above twelve unless expanded. Filters never change states or overall counts.

Legend hue ownership is earliest birth (missing is `Stamp.UNSET`), then ID bytes; display order
is independent.
Diagnostics keep the existing limits: fifty entries per error list, ten named nodes per counted
warning/cycle; pointer paths at most eight and pointer lists at most fifty. Missing raw endpoints,
absent-only cycles and effective cycles are separate facts. No cap is a truncation of the graph used
for state or completion. Diagnostic hue order is terracotta, olive, gold, brick, sky, plum;
warning thresholds remain 256 UTF-8 label bytes and more than four effective prerequisites.
Each landing fact retains its bridged immediate `incoming` edges and the `followed` entries they
reach. An absent root or absent-only cycle can leave that followed list empty; it still changes the
new link's meaning and produces a fact. Landing facts are values only; persisting and clearing acknowledgments is the later device
adapter's responsibility.

Run from `web`: `node --test test/products/roadmap/domain/corpus.test.js`.

The harness inputs are `{operation, tree, subjects}` for `graph`, `{operation, trees}` for `account`,
`{operation, trees, tree: id}` for `guides`, `progress` and `pointers`, `{operation, tree, query}` for
`board` and `search`, `{operation, tree}` for `legend` and `diagnostics`, and
`{operation, tree, own: {nodes: [id], edges: [[from,to]]}}` for `landing`. `subjects` selects detailed
graph reads only; it never narrows states. `query` is Board's `{sort,kinds,search,branch,doneExpanded}`
or MCP's `{query,color,kind}`. Optional query fields have the defaults in `reads.js`.

The read modules are `records.js` (normalized values, authored ordering and the device's landing note), `graph.js`
(raw adjacency, iterative strongly connected components and compact prerequisite/debt closure),
`account.js` (standing, least-fixed-point completion, effective dates and guides), `reads.js`
(Board, legend, search and landing facts), and `diagnostics.js` (bounded findings). Detailed followed
provenance is enumerated on demand. Bulk state, debt and Board reads use bitsets and never allocate
an object for each implied edge through an absent hub. Disconnected absent records remain in
RoadmapTree but do not allocate graph reachability rows; only present IDs and live-edge endpoints do.

The independent traversal test covers cycles and bitset word boundaries. Size tests cover 10,000
nodes/20,000 edges, sixteen million implied pairs through one absent hub, 500 trees at depth eight,
and the existing Board median construction/search budget of 50 ms at 5,000 nodes/1,800 unfinished.
The timed Board path includes a fresh FollowGraph, state/debt derivation, cards, sort and search;
only normalized record construction stays outside it. Other size timings are reported, not assigned
new budgets. Run all with `node --test --test-concurrency=1 test/products/roadmap/domain/*.test.js`,
then `npm run check:domain`.

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
| `roadmaps-actions.json` | Create a roadmap (genesis kinds, first steps, chunks), delete a root held, title and guide, a root's visibility, a subtree made with no connection |
| `steps-actions.json` | Create a step with its links, change and reorder with the step's life, delete held, prerequisites added and retired through absent steps, loops, import in chunks |
| `kinds-actions.json` | Create, change, reorder, delete; a worn hue; the cap; `roadmap.recolourKind` and its predictions |
| `progress-actions.json` | Complete and Reset; a step that opens or owns a roadmap takes no mark; pointers |
| `workspace-actions.json` | Subtasks and links in their step's order; the note saved as text |
| `landing-actions.json` | The landing read and its clearing; the one list of what cannot land |
| `undo.json` | Each gesture's Undo and Redo on the kit's harness over the reference server with roadmap's binding (K-3) |

**Scenes.** An action case is, as the kit's act form reads it (`ProductCorpus.act`), `{action, input, scopes: {<scope>: {drawn, stored?}}, device?, ids?, now,
offsetSeconds}`: each scope's records are engine rows (`stored` defaults to `drawn`), `device` holds
device rows by key, and `ids` are minted in order across scopes. Its `expect` is `{decision}`:
`{write: {segments: [{scope, gesture}], result}}` with each segment's gesture in the kit's form,
`{unchanged: {result}}` or `{refuse: <refusal>}`. A read case replaces `action` with `read`.
Scopes are `self/roadmap`, `tree/<T>` and `self/overlay/<T>`; the device row is `landing:<T>`.

| Action | Input | Result |
|---|---|---|
| `CreateRoadmap` | `{title, steps?: {steps: [{key, label, icon?, color?, description?, links?}], links: [[fromKey, toKey]]}}` | `{tree, steps: {key: id}}`; the `tree` record, then its tree scope: the title, the genesis kinds at `a0`–`a2`, and the steps, chunked |
| `DeleteRoadmap` | `{tree}` | `null`; held; a subtree's record refuses `notARoot` |
| `SetVisibility` | `{tree, visibility}` | `null`; a write of the root's `meta.visibility` under `roadmap.captureTree`, predicting the root's `reach` and the `reach` of every standing subtree of its branch (`scopedPredict`); the visibility the root holds writes nothing; a subtree refuses `notARoot` |
| `CreateSubtree` | `{tree, step}` | `{subtree}`; `roadmap.createSubtree` in `self/roadmap`, predicting the subtree's record, its `meta` (`root`, `parent`, `depth`, `reach`) and genesis kinds, and the step's `branch`; a step `drawn` holds dead is revived in a segment before it and noted; a step that owns a subtree answers it unchanged; a pointer refuses `stepOpensARoadmap`, a depth past eight `depthLimit` |
| `WriteRoadmap` | `{tree, title?, guide?}` | `null`; the changed fields of `meta` |
| `CreateStep` | `{tree, step: {label, icon?, color?, description?, links?}, prerequisites}` | the step's id; the step after the steps its first prerequisite leads to (or after the first steps), one link from each prerequisite, and the landing note |
| `ChangeStep` | `{tree, step, changes}` | `null`; a `revive` naming the changed fields; a step `drawn` holds dead is noted `revived` |
| `MoveStep` | `{tree, step, below, siblings}` | `null`; `siblings` are the trunk parent's steps the layout names; the key between `below` and the next sibling, as a `revive`; a drop in place writes nothing |
| `DeleteStep` | `{tree, step}` | `null`; held; the step's death alone |
| `ChangePrerequisites` | `{tree, step, add, remove}` | `null`; a removed prerequisite followed through an absent step retires each link the step reaches it by |
| `ImportSteps` | `{tree, imported, under?}` | `{key: id}`; under `under`, each step the import has no prerequisite for follows it |
| `CreateKind`, `ChangeKind`, `MoveKind`, `DeleteKind` | `{tree, kind: {hue, label?, description?}}`, `{tree, kind, changes}`, `{tree, kind, below}`, `{tree, kind}` | the kind's id, or `null` |
| `RecolourKind` | `{tree, kind, hue}` | `null`; the command, predicting the kind's hue and every step wearing the old hue, present or not, by id; a kind `drawn` holds dead is revived in a segment before it |
| `Complete`, `Reset` | `{tree, step, outOfOrder?, opensStanding?}`, `{tree, step}` | `null`; the step's `mark`; `opensStanding`, read by the caller from the account, says the step's pointer opens a standing roadmap |
| `SetPointer`, `ClearPointer` | `{tree, step, opens}`, `{tree, step}` | `null` |
| `AddSubtask`, `ChangeSubtask`, `MoveSubtask`, `DeleteSubtask` | `{tree, step, label}`, `{tree, subtask, changes}`, `{tree, subtask, below}`, `{tree, subtask}` | the subtask's id, or `null`; a move lands below another of its step's subtasks; a delete is held |
| `AddStepLink`, `ChangeStepLink`, `MoveStepLink`, `DeleteStepLink` | `{tree, step, link: {url, title?}}`, `{tree, link, changes}`, `{tree, link, below}`, `{tree, link}` | as subtasks; a delete is held |
| `SaveStepNote` | `{tree, step, text}` | the draft save's `{values, exists}`, decided as `{write: {gesture, result}}`; the note opened from `drawn` or new |
| `ClearLanding` | `{tree, told: {nodes?, edges?, revived?}}` | `null`; the note less what was told, or no row |
| read `landing` | `{tree}` | `{follows, cameBack, note}`: `landing` facts over the note's steps and links, and its revived steps now present |
| read `cannotLand` | `{notices}` | `{listed: [{id, gestureId, reason, subject, values}], unexpected: [{id, code}]}`; `reason` ∈ `roadmapDeleted` (`scope-dead`), `capFilled` (`cap`), `accessEnded` (`forbidden`, `not-found`), `noteTooLong` (`too-large` on a note) |

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
visibility predicted across scopes, and a change against another device's delete (INV-1) over the real engine;
against roadmap's reference binding it lands a subtree and a visibility as the server writes them, keeps a newer
private over a stale public sent after it, and ends and restores a subtree's standing with its step.

## Undo (K-3)

Each segment of an action case's write that opts into Undo carries `undo`, its recipes as the engine journals them
(the kit's `translateUndo`): `fields` naming targets `{scope, t, id, slot}` and, for a field unset before the act, the
value equivalent to unset; `createdRecord`; or a product `command` with its evidence. What each gesture names:

| Gesture | Undo | Redo |
|---|---|---|
| A change of a step or a kind, a move of either | `roadmap.restoreTree` of each changed field, and of the life where the device held the record as deleted | writes the change back |
| Create a step, a link, a kind; an import's steps and links | `createdRecord` of each, deleted again while its own writes are all that changed it; one act, so one Undo takes every chunk | revives the step, link or kind |
| Delete a step or a kind; remove a link | the life (`roadmap.restoreTree`); a step's delete is held, and an Undo in its hold cancels it in place | deletes it again |
| A roadmap's title, guide or visibility | the field (`meta`, unset `""` and `private`); the server writes the branch's reach back | writes the change back |
| Recolour a kind | the kind's `hue` and the `color` of each step that wore it; a revival before the command, its life | writes them back |
| Complete, Reset | `roadmap.restoreOverlay` of the `mark`, unset `{status: none, outOfOrder: false}` | writes the mark back |
| Set or clear a pointer | `opens` and the life, or `createdRecord` of a pointer the overlay never held | writes it back |
| Add, change or move a subtask or a link | `createdRecord`, or the changed fields and `ord` | the change; a deleted subtask or link is terminal, so the Redo of an add brings nothing back |
| Delete a subtask or a link | none: the type is terminal. The delete is held nine seconds, and `cancelHeld` in the hold is its one Undo | — |
| Create a roadmap | `roadmap.undoCreateRoadmap {tree}` over the record and its tree scope, unchanged since: the roadmap dies while nothing changed in it, its owner's overlay included. Each tree segment names a restore of `meta.guide`, which the creation never writes, so the engine keeps its receipts, which prove the scope; that restore is dropped | none: a new roadmap is a new creation |
| Create a subtree | `roadmap.undoCreateSubtree {tree, step, subtree}` over the step's `branch`, the subtree's record and its tree scope; a step revived before it, its life | `redoCreateSubtree`: the product's slots (`redoCreateSubtree(creation, fresh)` in `roadmaps.js`) plant a new subtree under a fresh id while the `branch` is still the one the Undo cleared (R-8) |
| Delete a roadmap | none after its hold (R-7); `cancelHeld` in the hold | — |
| A step's note, the landing note | none: a draft's save does not opt into Undo, and device rows are the device's | — |

**Scenes** (`undo.json`). `{steps}` → `{outcomes}`, run on the kit's harness over the reference server with roadmap's
binding. A step is `{run: <action>, input, as?, on?}`, `{sync: true}`, `{advance: ms}`, `{undo | redo | read | cancelHeld:
<role>}` (`subtree: true` gives a Redo the product's slots), `{device: <name>}` or `{inspect: {scope, t, fields}}`. An
input names a role's result as `$role` or `$role.path`. Outcomes are a run's kind, the `InverseResult` without its ids,
`{cancelHeld}`, and an inspection's visible records, each id named by the first role holding it, any other minted id
`<new>`. A product inverse (`undoCreateRoadmap`, `undoCreateSubtree`, `redoCreateSubtree`) draws nothing until the server
answers, so with no connection such an Undo waits and the roadmap or subtree stays drawn. A restore that revives a
record (the Undo of a delete, the Redo of a creation) also draws nothing until the server answers; a restore of fields
and a deletion draw at once.

