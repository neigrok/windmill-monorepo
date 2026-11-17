# Roadmap pure reads

Each JSON file holds `{name,input,expect}` cases. The web corpus discovers every file and compares
its complete output. These are normalized domain records, not engine record envelopes. The adapter,
registry-backed ProductCorpus, actions and live UI binding are separate work. No operation reads
storage, time, randomness, personal acknowledgments or localization.

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

The production modules are `records.js` (normalized values and authored ordering), `graph.js`
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
