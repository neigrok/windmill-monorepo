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
| `roadmaps-actions.json` | Create a roadmap (genesis kinds, first steps, chunks), delete a root held, title and guide |
| `steps-actions.json` | Create a step with its links, change and reorder with the step's life, delete held, prerequisites added and retired through absent steps, loops, import in chunks |
| `kinds-actions.json` | Create, change, reorder, delete; a worn hue; the cap; `roadmap.recolourKind` and its predictions |
| `progress-actions.json` | Complete and Reset; a step that opens or owns a roadmap takes no mark; pointers |
| `workspace-actions.json` | Subtasks and links in their step's order; the note saved as text |
| `landing-actions.json` | The landing read and its clearing; the one list of what cannot land |

**Scenes.** An action case is `{action, input, scopes: {<scope>: {drawn, stored?}}, device?, ids?, now,
offsetSeconds}`: each scope's records are engine rows (`stored` defaults to `drawn`), `device` holds
device rows by key, and `ids` are minted in order across scopes. Its `expect` is `{decision}`:
`{write: {segments: [{scope, gesture}], result}}` with each segment's gesture in the kit's form,
`{unchanged: {result}}` or `{refuse: <refusal>}`. A read case replaces `action` with `read`.
Scopes are `self/roadmap`, `tree/<T>` and `self/overlay/<T>`; the device row is `landing:<T>`.

| Action | Input | Result |
|---|---|---|
| `CreateRoadmap` | `{title, steps?: {steps: [{key, label, icon?, color?, description?, links?}], links: [[fromKey, toKey]]}}` | `{tree, steps: {key: id}}`; the `tree` record, then its tree scope: the title, the genesis kinds at `a0`–`a2`, and the steps, chunked |
| `DeleteRoadmap` | `{tree}` | `null`; held; a subtree's record refuses `notARoot` |
| `WriteRoadmap` | `{tree, title?, guide?}` | `null`; the changed fields of `meta` |
| `CreateStep` | `{tree, step: {label, icon?, color?, description?, links?}, prerequisites}` | the step's id; the step after the steps its first prerequisite leads to (or after the first steps), one link from each prerequisite, and the landing note |
| `ChangeStep` | `{tree, step, changes}` | `null`; a `revive` naming the changed fields; a step `drawn` holds dead is noted `revived` |
| `MoveStep` | `{tree, step, below, siblings}` | `null`; `siblings` are the trunk parent's steps the layout names; the key between `below` and the next sibling, as a `revive`; a drop in place writes nothing |
| `DeleteStep` | `{tree, step}` | `null`; held; the step's death alone |
| `ChangePrerequisites` | `{tree, step, add, remove}` | `null`; a removed prerequisite followed through an absent step retires each link the step reaches it by |
| `ImportSteps` | `{tree, imported, under?}` | `{key: id}`; under `under`, each step the import has no prerequisite for follows it |
| `CreateKind`, `ChangeKind`, `MoveKind`, `DeleteKind` | `{tree, kind: {hue, label?, description?}}`, `{tree, kind, changes}`, `{tree, kind, below}`, `{tree, kind}` | the kind's id, or `null` |
| `RecolourKind` | `{tree, kind, hue}` | `null`; the command, predicting the kind's hue and every step wearing the old hue, present or not, by id |
| `Complete`, `Reset` | `{tree, step, outOfOrder?}`, `{tree, step}` | `null`; the step's `mark` |
| `SetPointer`, `ClearPointer` | `{tree, step, opens}`, `{tree, step}` | `null` |
| `AddSubtask`, `ChangeSubtask`, `MoveSubtask`, `DeleteSubtask` | `{tree, step, label}`, `{tree, subtask, changes}`, `{tree, subtask, below}`, `{tree, subtask}` | the subtask's id, or `null`; a move lands below another of its step's subtasks |
| `AddStepLink`, `ChangeStepLink`, `MoveStepLink`, `DeleteStepLink` | `{tree, step, link: {url, title?}}`, `{tree, link, changes}`, `{tree, link, below}`, `{tree, link}` | as subtasks |
| `SaveStepNote` | `{tree, step, text}` | the draft save's `{values, exists}`; the note opened from `drawn` or new |
| `ClearLanding` | `{tree, told: {nodes?, edges?, revived?}}` | `null`; the note less what was told, or no row |
| read `landing` | `{tree}` | `{follows, cameBack, note}`: `landing` facts over the note's steps and links, and its revived steps now present |
| read `cannotLand` | `{notices}` | `{listed: [{id, gestureId, reason, subject, values}], unexpected: [{id, code}]}`; `reason` ∈ `roadmapDeleted` (`scope-dead`), `capFilled` (`cap`), `accessEnded` (`forbidden`, `not-found`), `noteTooLong` (`too-large` on a note) |

Limits refuse before anything is written, in this order where a case meets several: the bounds of
the values written, a prerequisite or step the roadmap never held (`gone`), a loop among what steps
follow (`edge.cycle`, `custom` `loop` or `self`; a loop of absent steps alone is admitted), a hue
another present kind wears (`kind.hue.worn`), then the caps by the growth rule. A step that owns a
subtree or opens a roadmap refuses `progress.opening`. Imports chunk at 500 records and half
`PUSH_MAX_BYTES`, measured as each record's JCS bytes, a step with the links that lead to it.

**Refusal forms.** `{invalid: violation}`, `{gone | taken | tooLarge: {subject, path}}`,
`{full: {type, cap, path}}`, and `{roadmapGone | unreachable | notARoot | stepOpensARoadmap |
depthLimit | other: {code, subject, detail, path}}`.

**Waiting on the kit.** The kit refuses a keyed create that writes no field (§8.3 rule 8), and an
`edge` has none, so the six cases that write a link fail on that rule on the web, as the corpus
asserts, until the kit admits it. `roadmap.setVisibility` and `roadmap.createSubtree` have no cases:
the first takes the gesture's stamp as an argument, which a decision cannot know, and the second
predicts records in other scopes, which the kit's predictions cannot name.

