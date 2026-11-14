# Roadmap tree engine — spec

The collaboration engine behind the roadmap product: the loose-graph domain, the CRDT lattice
that syncs it, the HTTP and socket surfaces, and the tables underneath. Code lives in
`products/roadmap/`.

Other references: `AUTH.md` (sign-in) · `AUTHZ.md` (authorization) · `RUNNING.md` (local run) ·
`db/schema.sql` (schema) · `CLAUDE.md` (build, pool, CI).

## Model

A tree is a **loose graph**: a node set and a prerequisite-edge set that permits cycles,
self-edges and edges to absent nodes. Every write merges into it; graph writes are never
rejected for structure. Validity is a read model, not a gate.

- `LooseGraph` — the authoritative state. Nodes are `NodeRecord`s (an `ElementSet` life plus LWW
  registers: label, icon, color, order, status, description, links, opens); edges are an
  `ElementSet` per `(from, to)`.
- `opens` — a node's pointer at another tree: that tree's id, or empty for none. A document node
  carries it as `opens` and omits it when empty; a lattice entry carries `opens` and `opensAt`. The
  room, the socket and `PUT` hold a write to the id length and to nothing about its target, so a
  pointer may name a tree that is absent, deleted or someone else's. The MCP door is stricter: every
  non-empty `opens` a `create_node`, `update_nodes` or `import_subgraph` call carries must name a
  tree that stands and is the caller's (`TreeRepository::titlesOwnedBy`, one read for
  the whole call), or the call is refused with nothing written, in one sentence for a tree that is
  not there and for someone else's. That read is made before the tree's strand is taken, so an edit
  racing the target's removal can still set a pointer at it, which then points nowhere. A node may
  open the tree it is in. A tree id is the read capability of an unlisted tree, so only a caller who
  can write the tree receives the pointer: `readerView` (`domain/Subgraph.h`) is what every other
  reader gets from `GET /v1/trees/{id}` (`data` and `state`), the subscribe delta and a live frame —
  a document node without `opens`, a
  lattice entry with `opens` empty and `opensAt` unset, and no entry for a node the frame then says
  nothing about. MCP `get_tree`, `get_nodes` and `find_nodes` answer it when `fields` names `opens`,
  as `opens: {treeId, title, state}`, to a caller who can write the tree and only while the opened
  tree stands and is theirs; the key is omitted otherwise. A step that owns a subtree opens that
  subtree in every read, whatever this register holds (Subtrees).
- `OpenedTrees` (`domain/OpenedTrees.h`) — an owner's standing trees under the owner's marks, judged
  once. A pointer is valid when its target stands and belongs to the owner of the tree the node is
  in. A step that owns a subtree opens it, whatever its pointer holds, in every projection a read
  makes of a document — the room's (`TreeRoom::snapshot`, `pointers`), the stored rows'
  (`TreeRepository` lists, `openedFrom`'s walk) and reminder readiness — and that subtree is valid
  while its branch stands (Subtrees), so completion carries forward through ownership by this one rule. For a caller who can write the tree, a node with a valid pointer is complete exactly when the
  opened tree is complete for them, whatever its own prerequisites, as a mark made out of order is;
  until then it is locked or available by its prerequisites, and a mark stored on it is kept and
  ignored. A tree is complete for a reader when it holds at least one node and every node is
  complete: a node with a valid pointer by its tree, any other node by the reader's mark.
  Completeness is the least answer that satisfies this over all the owner's standing trees, one
  answer per owner whichever tree is being read: a tree on a loop is never complete, however long
  the loop, a chain of any length completes, and a tree reached along two ways is judged once. It is
  computed by one pass that walks each tree-to-tree pointer at most once. `completedAt` is the
  latest mark, by stamp, in what completed a tree: of the owner's complete marks on its nodes that
  follow no tree and, for each tree its nodes follow, of what completed that one. It is found in
  that same pass and carries the instant that mark was recorded; a mark a node holds beside a
  valid pointer completed nothing and is not among them, and a mark stored with no stamp (empty or
  `0:0:`) counts toward completion and never toward `completedAt`, which a tree completed by such
  marks alone does not have. `followed` gives a
  tree's completed set — marks on ordinary nodes, plus the nodes whose opened tree is complete —
  that `UnlockRules::derive` and `treeStats` are handed, so MCP `state`, the `state` filter, the
  registry counts (`GET /v1/trees`, `list_trees`) and reminder readiness agree. `openings` says
  what each pointer of a tree comes to: `missing` for one that is not valid, else the opened tree's
  title, whether it is complete and `done` of `total` (its present nodes, those complete for the
  reader); `leadingBackTo` names the trees whose pointers lead to a tree, at any distance. A node
  whose pointer is not valid is an ordinary node, and so is every node for a reader who cannot write
  the tree: their state follows their own mark, and nothing they receive says a node opens a tree
  but the subtree a step owns, which every reader is told (Subtrees).
  `diagnose` says what is wrong with a tree's pointers (`PointerDiagnostics`), each list in node id
  order. `treeLoops` holds one entry per node whose pointer leads back to the node's own tree, with
  a shortest way back: each tree on it with its title, the tree the node opens first and the node's
  own tree last — one entry, that tree, for a node that opens the tree it is in — and the smaller
  tree id wherever two ways are as short, so the way does not depend on the order the trees are
  visited in. `danglingPointers` holds one entry per node whose pointer is not empty and not valid,
  with the pointer as it is stored. A loop among other trees that does not lead back to the tree
  is not that tree's: it is reported when one of those trees is read. The answer is bounded where
  it is made: each list holds its first 50 nodes (`kMaxTreeLoops`, `kMaxDanglingPointers`) and
  counts the rest in `treeLoopsOmitted` and `danglingPointersOmitted`, and a way of more than 8
  trees (`kMaxLoopPath`) is cut to its first 8, so it does not end with the node's own tree, with
  `pathOmitted` counting the trees left off, that tree the last of them. What is past a cap is
  counted and never built. `waysBackTo` is the walk under it and under `leadingBackTo`: from the
  tree up its openers a level at a time, it reads each pointer between two standing trees at most
  once and leaves every tree that leads back its fewest pointers and the tree it steps to first,
  so `diagnose` costs the account's pointers plus the capped lists, whatever the tree holds.
  The raw mark (`status`, `get_progress`, and `GET …/progress` for a caller who can write the tree)
  stays the raw mark; every other reader of `GET …/progress`, and the gallery, are shown the
  owner's marks through `readerView`. `get_progress` answers the caller's own marks on the nodes the
  tree holds alone (`Progress::restrictedTo`): a mark on a deleted node stays stored, shows again on
  a revive, and still reaches the socket's overlay graft and, for a caller who can write the tree,
  `GET …/progress`, which serve the stored marks. For a tree that is absent, or that the caller
  cannot read, `get_progress` answers `no such tree`, the same for both, as every MCP read does.
- `readerView` (`domain/OpenedTrees.h`) — an owner's stored marks on a tree as a caller who cannot
  write it is shown them: the owner's derived completion, and nothing of the trees its nodes open. A
  node with a valid pointer has a row only while the tree it opens is complete for the owner, by the
  completeness `followed` reads, and none otherwise, whatever mark it holds. That row is `complete`
  and never `outOfOrder`. It is the node's stored mark when that says complete under a stamp; else
  its time is the later of the opened tree's `completedAt`, with the instant that mark was
  recorded as `markedAt`, and the stamp the node's pointer was set under, with that stamp's own
  milliseconds as `markedAt`. So the time never predates the pointer and never comes from a mark
  with no stamp, and a twin whose same steps were marked by hand at those stamps answers the same
  bytes. Every other node's row is the stored one, so a step that opens a tree that is not complete
  reads as a step nobody marked. `OwnerProgress::shownToReaders` feeds it for the two doors that
  serve an owner's marks to such a caller, `GET /v1/trees/{id}/progress` and the gallery. The
  pointers, each with the stamp it was set under, come from the tree's room, or for the gallery
  from the listed documents. Each owner whose trees hold a pointer is followed in one `openedFrom`
  read under a 750 ms budget (`kReaderFollowBudget`) after the strand is released, and trees that
  hold no pointer make none. The gallery follows its owners in the order the wall shows their cards
  as far as it is known before their marks are — by forks, then the tree's own last edit, then
  tree id — and spends at most 1,500 ms on follows in all (`GalleryApi::kFollowCap`): an owner the
  cap cuts short or never reaches is shown unread for that view alone. When an owner's read fails or
  runs its whole budget, the door still answers, leaving out the row of every node of that owner's
  that holds a pointer, so no step is shown done that may not be, and every other owner is followed
  as ever. That owner then cools off: for five minutes (`kFollowCoolOff`) every door shows them
  unread at once without trying, and the first follow after it that answers ends it. The cool-offs
  live in the process's memory, keyed by owner, at most 1,024 of them (`kMaxCoolingOff`), the one
  begun first let go to make room.
- A node with a valid pointer takes no mark from a caller who can write the tree. The room hands
  that caller, and nobody else, the nodes that open a tree (`TreeRoom::pointersFor`); `following`
  names the ones whose pointer is valid, and `ProgressService::mark`, which both doors that write
  progress call, leaves a mark on one of them, `complete` or `none`, out of the write and answers it
  refused under the code `opens-a-tree`: MCP `update_nodes` and the `progress[]` of an
  `import_subgraph` say so (`adapters/mcp/README.md`), and a socket `progress` frame's ack lists it
  (WebSocket surface). The other marks of the call are recorded, and each `prerequisitesMet` is
  judged on the `followed` set, so a step behind such a node is met when the opened tree is
  complete, whatever mark the node holds. A mark such a node already held stays stored until the
  node is deleted, when it is cleared as every mark of the caller's on what a delete removes is. From
  a caller who cannot write the tree the same mark is an ordinary one: recorded, answered exactly as
  on a node that opens nothing, and judged on their own marks.
- The domain is fed two ways. A read of one tree (`get_tree`, `get_nodes`, `find_nodes`,
  `GET /v1/trees/{id}`) takes the tree from its live room, a progress write (`update_nodes`, the
  `progress[]` of an `import_subgraph`, a socket `progress` frame) only its nodes that open a tree,
  and each asks `TreeRepository::openedFrom(owner, opened)` for each tree it opens that stands and
  is the owner's and every such tree their steps open — the subtree a step owns, found through
  `trees_parent_step`, else the tree its pointer names, a subtree standing while its branch does, its
  path read for a subtree alone: one statement over `trees`,
  `tree_nodes` and the owner's `node_progress` that reaches each tree once and answers, per tree and
  tree it opens, how many present nodes open it, how many of those the owner marked and the latest
  of those marks, beside the tree's title and its nodes that open none. Each reached tree's nodes
  are read through `tree_nodes_pkey`, and the owner's marks on it through an index that leads with
  both the tree and the reader (`node_progress_pkey`, or `node_progress_user_tree`, whichever the
  planner takes), so the cost follows the trees reached and the owner's marks on them, and not the
  size of the tables or other accounts' marks on the same trees. It is made once per reply, call or
  frame, after the tree's strand is released, and not at all for a read whose fields ask for neither
  `state` nor `opens`, for a write with no mark to judge, or for a tree that holds no pointer. On
  these doors a caller who cannot write the tree causes no such read, but for `GET /v1/trees/{id}` of
  a tree whose steps own subtrees, which follows those subtrees for them (HTTP surface); the two
  doors that show such a caller the owner's marks make it as `readerView` says. The tree's diagnostics (`get_diagnostics`,
  `GET /v1/trees/{id}/diagnostics`) make the same read for `OpenedTrees::diagnose`: once per reply,
  after the strand is released, for a caller who can write the tree and a tree that holds a pointer,
  and not for an MCP call that sends `includePointers: false`; under the strand they take the tree's
  pointers alone (`TreeRoom::pointers`). An MCP edit that changes the tree a node opens to a tree
  (`create_node`, `update_nodes` or `import_subgraph`) makes it once
  more, after the edit is saved and the strand is released, starting from the trees those nodes now
  open (`pointersSetSince`) and under a budget of its own, 750 ms, in place of the pool's statement
  limit: its receipt names in `introducedDiagnostics`, after the graph's errors and within that
  list's five lines, each of those nodes whose tree leads back, and a read that runs past the budget
  leaves the receipt `pointerDiagnosticsUnavailable: true`. No other edit makes that read: a dry
  run, an edit that only clears a pointer and one that re-sends the tree a node already opens among
  them. Where every tree of an owner is already loaded with its marks (`TreeRegistry::list`,
  `PgReminderRepository::readinessFor`), `openedAmong` (`domain/TreeSummary.h`) judges the account
  once in memory with no further read.
- `TreeDiagnostics::assess` — a pure report over a loose graph and its legend: `cycles`, `dangling`,
  `selfEdges`, `smells`, `maskedWork` (tombstoned parents with present children). `clean()` is
  true when cycles, dangling and self-edges are all empty. The assessment holds every error, since
  a receipt's `introducedDiagnostics` compares the one before an edit with the one after; a reply
  carries the first 50 of each list and the count of the rest (`Listed`) — cycles by the first
  member of each, dangling and self-edges by `from` and then `to`, masked work by node id — and of a
  cycle the count of its members and the first ten (`Cycle::counted`), so a tree broken at every
  node answers as shortly as one broken at fifty. Smell kinds: `label-too-long`
  (> 256 bytes), `empty-icon` and `high-in-degree` (> 4), one line each for every node they cover;
  `unclaimed-hue`, one line per hue present nodes wear that no kind does, with that `hue`; each line
  the `count` of its nodes and the first ten of them (`CountedNodes`), so the smells stay a few short
  lines whatever the tree's size; and `empty-legend`, one line naming no node for a tree with nodes
  and no kind, in place of the hue lines. It reads one graph and its legend, and no pointer: a loop of
  trees and a dangling pointer (`PointerDiagnostics`) are reported beside it, as smells are, and
  change neither `clean()` nor what it gates — the `SkillTree` projection and a receipt's
  `diagnosticsClean`.
- `SkillTree` — the validated projection, constructible only from a clean graph; it throws
  `InvalidTree` on a duplicate id, a dangling prerequisite or a cycle. Indexes the DAG, the topo
  order, ancestry and the render model.
- `Legend` — up to 6 kinds per tree, one per hue, sorted by `rank` then id. A tree created with no
  kinds is seeded with three: build · learn · milestone. A PUT omitting kinds on an existing tree
  preserves its legend.
- `title` and `guide` — the tree's own LWW text registers, beside its graph and legend. The title
  names the tree. The guide is one plain-text note the owner writes on what the tree is and how to
  work it, for agents and for people; an empty guide, or one of only whitespace, is no guide, and a
  guide a fork copied from someone else's tree stays its author's words until the owner writes one.
  Nodes carry no part of it.
- `guides` (`domain/Guides.h`) — guides add: one tree holds the method, each tree worked under it
  adds what is particular to it, and none overrides another. A tree P is directly above a tree T,
  both standing and one owner's, when T is a subtree whose parent is P (Subtrees), or when T is a
  root and a present step of P that owns no subtree points at T. So a subtree's trees above are its
  ancestors, read up its parents, and the trees above its root; a pointer at a subtree makes nothing
  above it. Above is that relation followed upward within 8 levels, each tree at its shortest
  distance, and a tree is never above itself, whatever loops exist. Only the reader's own trees count: for a caller who
  cannot write the tree being read, nothing is above it. `guidesFor` answers what a reading of a
  tree carries as `guides`, each entry `{treeId, title, text, yours}`: the guides of the trees
  above, farthest first and by tree id within one distance, then the tree's own guide last. A tree
  whose guide is empty is left out, the tree's own included; each tree appears once; and past 8
  entries the farthest are dropped, so the nearest trees and the tree's own guide keep their
  places. Where that cut falls inside one distance the smaller tree ids are kept, ids compared as
  bytes. `yours` says the reader owns that tree and wrote its current guide. The trees above come
  from `TreeRepository::guidedTreesAbove(owner, tree)`, which answers the 8 nearest that carry a
  guide by that same rule (`nearestGuided`), so a reply never loads a guide it cannot keep. It is
  one statement keyed on the owner's own standing trees: it takes each subtree's parent off the rows
  it read, reads the roots each tree's steps point at through `tree_nodes_pointers_idx`, leaving out a
  step that owns a subtree (`trees_parent_step`), walks those upward from the tree, a tree once per
  distance and no further than 8 levels, and reads the title and guide of the trees it keeps through
  `trees_pkey`, a subtree named by its owning step's label. Its cost follows the
  owner's own trees and the pointers among them, whichever tree is read, and does not grow with
  the pointers other accounts plant at a tree. It is made once per reply that answers the guides
  above, after the tree's strand is released, and not at all for a caller who cannot write the
  tree, who is answered the tree's own guide alone.
- Subtrees (`domain/Subtree.h`) — each tree has a place among trees. A root has no parent, is its
  own root and sits at depth 0. A subtree is owned by one step of another tree, its owning step in
  its parent tree; it has its parent's root and owner and sits one deeper, at most `kMaxTreeDepth`
  (8). Its path is its owning steps from its root down, one per level. It has no access of its own:
  it is read by its root's owner and visibility, and stands only while its branch does (Lifetime,
  below; Authorization). The place is written once, when the tree is created, and
  never changed, and a subtree is always a new tree under a standing one: a subtree has one parent,
  never moves, never closes a loop and is never another account's. A step owns at most one subtree.
  The store enforces all of it whatever writes it (Persistence). No door creates a subtree yet.

  A subtree reads as one step of its parent:

  - **Name.** A subtree's name is its owning step's label, read through on every read that names
    it — the tree read, a `path`, the guides read and every guide's title, the share page and its
    metadata, the subscribe answer's title, a pointer's `opens` title and MCP `get_tree`'s `title` —
    off the stored rows (`TreeRepository::placeOf`, and `treeNameColumn` in a statement). A read of
    the name that fails answers as the read's own failure does, and never with another name: the
    tree and guides reads `404`, the share page the shell unchanged, the subscribe a `server-error`
    reject, and `get_tree` a failed call. Its own title register is read by nothing: no read answers
    it and the subscribe answer neither sends nor covers it. A rename never writes it; the socket's
    `subgraph` frame and `PUT /v1/trees/{subtree}` still do. Renaming a subtree (`PATCH
    /v1/trees/{id} {title}`, MCP `update_tree {title}`) writes that label in the parent's room, under
    the parent's strand, as an ordinary label write of the step (`RenameNode`, one seq of the parent's
    stream, broadcast and logged as any other). A rename the step's label already holds lands nothing,
    and a step gone from its parent answers as an absent tree. MCP `update_tree` sending a title and a
    guide lands the title in the parent and then the guide in the subtree's own room, so a guide that
    fails leaves the label landed, and answers the seq of the subtree's own stream, its head when
    only the title moved. A rename whose save in the parent fails is held in the parent's room and
    retried there, as any write of the parent's is (Runtime): the caller is told it is applied and held
    (`PATCH` `202`, MCP `saved: false`, also when only the guide's save in the subtree's room is
    held), and the parent's room and its open pages show the new label at once. Meanwhile the
    subtree's name, read off the stored rows, is the label the store holds — the name before the
    rename — on the subtree's tree read, every `path` through it, its guides, its share page, its
    subscribe answer and `get_tree`; each reads the new name once the held save lands, and a restart
    before then loses the rename.
  - **Place.** A tree read answers `root`, `parent: {tree, step} | null`, `path: [{tree, step,
    title}]` — the trees above it, root first, each with its step the way passes through and its
    name — and `depth`, to anyone who may read it; a root answers `parent: null`, `path: []` and
    `depth: 0`.
  - **The owning step's child.** A step that owns a subtree opens it, whatever its pointer holds
    (`OpenedTrees`), so it takes no hand mark at any door (`opens-a-tree`), and its writer is
    answered its subtree wherever a pointer is answered. Every node read of `GET /v1/trees/{id}`
    carries `subtree: {id, done, total, state}` on such a step, to anyone who may read the tree:
    `done` of `total` the subtree's present steps, those complete for the owner, and `state`
    `complete` or `open`. A subtree is complete when it holds at least one step and every one is,
    however deep, so an empty one is unfinished and a leaf reopened reopens every owning step above
    it; nothing of it is stored. The subscribe answer lists the subtree each step owns (WebSocket
    surface), which heals a `subtree` frame a client missed.
  - **Lists show roots only.** A subtree is no row of `GET /v1/trees`, MCP `list_trees`, the gallery or
    reminder readiness; it counts in its parent as the one step that owns it, and a reminder names
    that step by its label.
  - **Links.** `GET /v1/trees/{subtree}` and `/t/{subtree}` open a subtree by its own id for anyone who
    may read its root while its branch stands, the share page indexed as its root is.

  A subtree's lifetime follows its owning steps and its root:

  - **Standing.** A subtree stands while its root stands and every owning step on its path is
    present; a branch is a subtree with everything under it. Deleting an owning step hides its branch
    at once, on every gate, for its owner and every reader alike, and the step's revive — the delete's
    Undo — shows it again, whether or not the parent's save has landed (Authorization). Every door asks
    the gate (`RoomRegistry::accessOf`, or a live room's `readableBy`) before it reads anything of a
    tree, and what it reads past the gate — the tree's place and name (`placeOf`) among it — does not
    judge standing again. A tree whose branch is hidden answers every read, and every write but a
    create at its id, as an absent tree does. The two doors that create at an id cannot: an absent id
    is one they create at, and a hidden tree's row is there. `PUT /v1/trees/{id}` answers a hidden
    tree's well-formed id `404`, where it creates at an absent one, and `POST /v1/trees` with its id
    answers `409` — `not-a-root` to its owner, `id-taken` to anyone else — where it creates at an
    absent one (HTTP surface). A new write aimed at a
    hidden tree is refused as one aimed at an absent tree — `no-such-tree` on the socket — and writes
    nothing; only a write the gate admitted before the delete landed — a frame in flight, a held save,
    a server-origin edit such as a removal's cascade — applies, and stays hidden. The refusal turns a
    client's writes back unwritten, and a client keeps them owed, so they land when the branch
    returns. A hidden branch counts nowhere — lists, the gallery, reminders, the derivation, its
    parent's `subtree` and `subtrees` — since in each only a present step owns a subtree, and every
    list and count over the stored rows applies the same condition (`branchStandsCondition`), lagging a
    held save as every read of the stored rows does (Runtime). Nothing purges: a hidden tree keeps its
    rows, its content and everyone's marks, and a subtree's row is never retired
    (`TreeRepository::softDelete` retires a root's alone).
  - **Not a root.** Nothing deletes, restores or forks a subtree by its own id. `DELETE
    /v1/trees/{subtree}`, MCP `delete_tree`, a fork (`POST /v1/trees/{subtree}/fork`, a signup's
    fork) and a visibility change are refused `not-a-root`, naming the step it hangs from and its
    root, to a caller who may read it; `POST /v1/trees` with a subtree's id, standing or hidden, is
    refused `not-a-root` to its owner, `id-taken` to anyone else, and is never answered `existed`. No door restores a tree: a root's deletion is final,
    and a subtree comes back only with its owning step's revive.
  - **The guarded delete.** A write that deletes an owning step names the subtree it takes in
    `branches: [subtreeId]`: the socket's `subgraph` frame, MCP `delete_node` and `import_subgraph`'s
    `tombstone[]`. One that does not is refused `branch-unconfirmed` whole, with nothing written,
    whatever the subtree holds, so a client that never saw the subtree cannot hide it. The parent's
    room decides alone (`TreeRoom::unconfirmedBranches`, over the pure `unconfirmedBranches`, asked at
    admission), and its join refuses an unconfirmed removal as a fault. Each unconfirmed branch is
    named with its size, `{step, subtree, steps, subtrees}` (`BranchSize`): `steps` the present steps
    of the subtree and of each standing subtree under it, `subtrees` how many those are, read off the
    stored rows once the parent's strand is released (`TreeRepository::branchSizes`) and left out when
    that read fails. `update_nodes` deletes no step and `PUT` tombstones none (HTTP surface). A root
    removal's cascade never reaches an owning step, which opens its subtree and not the removed root.
  - **A root's deletion** takes every branch under it, by standing alone: the subtrees' rows are left
    as they are and read as absent. Each row of `GET /v1/trees` carries `branch: {subtrees, steps}`,
    what the removal would take — its standing subtrees and the present steps of the root and of each
    — counted from the rows the list already reads, and the removal's answer repeats it.
  - **A fork** of a root copies the root and its standing branch in one transaction (Runtime).

  `TreeRegistry::createSubtree(parent, step, caller, {proposedId?, kinds?})` is the one operation
  that creates one, for every door to call. It is keyed by the pair (`parent`, `step`). The kinds,
  when sent, are judged first as `create_tree` judges its `kinds` (`admitBornKinds`: the same caps,
  refusals and words) and a refusal writes nothing. The rest runs under the parent's strand, so it
  is serialised with every other write to the parent, a step's deletion among them. In order it
  checks that the caller may read the parent (`no-such-tree` for an absent, deleted or
  private-denied tree, or one whose root is deleted, alike) and write it (`not-writer`), and that
  the step is present (`step-gone`). The create stores the parent's head at the room's next seq, in
  its own transaction, so it runs only over a room that is flushed (`RoomRegistry::flushed`): every
  write the room holds is stored and no save of it is running. A head stored past writes that are
  not would leave no gap to show them lost, and a save still running would write an older head over
  the create's. A parent whose save failed and is being retried (Runtime) refuses the create as
  `save-pending`, with nothing written; the refusal lifts when that save lands, and the caller sends
  the create again. A parent whose write is being saved is waited for, with the strand let go
  (`RoomRegistry::flush`), and judged again from the gates, three times at most, each wait letting
  another write in; a save that fails meanwhile, or a third look that still finds a write unsaved,
  is the same `save-pending`. It then reads the stored site (`TreeRepository::subtreeSite`),
  and a parent's room whose head is behind the stored one takes it. A step that already owns a
  subtree answers it, `created: false`, and writes nothing, so a retry after a lost reply and a
  create that lost a race both find the one child; a parent's room that missed it records it, with
  no seq. Otherwise it is refused when the child would sit
  deeper than the cap (`depth-limit`) and when the step's pointer is valid as `OpenedTrees` judges
  one, at a standing tree of the same owner, the parent itself included (`step-opens-a-tree`); a
  pointer that leads nowhere does not stop it. A `proposedId` that is a well-formed tree id and
  names no row, standing or deleted, anyone's, is kept, and any other is replaced by a minted id.
  The child is stored with its legend, and the parent's head moved to its next seq, in one
  transaction (`TreeRepository::createSubtree`) that holds the owner's account as `create` does: an
  empty tree with an empty title, at seq 0, its own room, born with the kinds it was sent or, with
  none, the default legend. A step another writer filled between the site and the store is read
  again and answered as owned, and an id another writer took is replaced by a minted one; a second
  conflict is a failure. The stored seq is then the parent's `subtree` event, which every
  subscriber of the parent is sent (WebSocket surface); it changes no register and leaves no
  `tree_ops` row. The answer is `{created, subtree: {id, root, parent: {tree, step}, depth, seq},
  parentSeq}`, `parentSeq` the seq the event took, or the parent's head when the step already owned
  the child, at or past the seq the child took. A failure before the transaction commits leaves no
  row, no seq and no event; one after it, in telling the subscribers, leaves the child and its seq
  taken, and a retry answers that child.

Derived read models:

- `UnlockRules::derive(nodes|tree, progress) → map<NodeId, NodeState>` where `NodeState ∈
  {locked, available, complete}`. It reads only nodes and prerequisites, so it also runs
  over a graph `SkillTree` would refuse: a prerequisite naming no node locks its dependant, and a
  cycle locks every member. The completed set it is handed is the reader's marks, or for the
  tree's owner `OpenedTrees::followed`.
- `TrunkTree` — elects one trunk parent per node (same-kind parents win, then shallowest, then
  smallest id) and derives branch root, trunk depth, leaf weight, and `EdgeKind ∈ {trunk,
  in_branch, cross_branch}`.

`NodeColor ∈ {terracotta, olive, gold, brick, sky, plum}`.

The server never computes layout and never renders, and a node holds no position: every client lays
the graph out itself. A document or a frame that still carries a node's `position` or `positionAt`
is taken without them, key by key, and is never refused for them.

### Progress

Private, per user, per tree — outside the lattice and outside the op log. A `Progress` holds a
`ProgressMark {status, at, markedAt, outOfOrder}` per node plus the projected `completed` /
`cleared` sets; `record` is the only way in, so the sets cannot drift from the registers.
`ProgressStatus ∈ {none, complete}`; **`none` is a value, not a row delete**, so a clear
converges across devices and a stale mark cannot resurrect it. `markedAt` is the server clock at
the moment the mark was recorded and is the only instant a reader may date a step by; the HLC
beside it orders writes and is never served back as a time.

Compatibility inputs `active` and `inProgress` normalize to `none` in progress and authored seeds.

One status per node is structural. "Complete only when every prerequisite is complete" is
advisory: the mark is recorded either way and the outcome reports `prerequisitesMet` so a surface
can warn. It reads the completed set `UnlockRules::derive` is handed: the caller's marks, or for the
tree's writer `OpenedTrees::followed`. `outOfOrder` is the marker's word that the inversion was
meant; it is part of the status value under the same stamp, so a later mark on the node carries its
own word or none. Only an MCP mark sets it — an `update_nodes` row or an `import_subgraph` progress
row; a socket `progress` frame lands it false. Progress therefore never depends on the tree being a
valid DAG.

## Convergence

All traffic flows through the server: one convergent lattice per tree, with the room as sequencer.
Replicas never merge with each other.

- **LWW register** (`Lww<T>`) — highest HLC wins. HLC text is `physicalMs:counter:actor`; the
  unset sentinel is `0:0:`.
- **Element set** (`ElementSet`) — add-biased: present iff added and no strictly-later remove
  cancelled it. A tie between add and remove favours add.
- **Join** — `LooseGraph::join(GraphState)` folds a partial state entry by entry, field by field.
  Absence at every granularity (missing entry, missing field, unset stamp) means "no information",
  so a join only ever adds. Commutative, associative, idempotent.

### Subgraph frames

Clients author `Subgraph` frames, not commands. A frame is a partial, stamped slice of one
tree's lattice: `{treeId, frameId, actor, intent, title?, guide?, graph, legend, gestures[], coverage?}`.

`SubgraphIntent`:

| Intent | Meaning |
| --- | --- |
| `live` | one gesture, sent now |
| `flush` | a coalesced offline session |
| `delta` | anti-entropy against a stated vector — the only intent carrying `coverage` |
| `graft` | state joined for its own sake (files, imports, device handoff); never advances coverage |

A `VersionVector` is the greatest stamp seen per actor, keyed by actor string. `frontier(graph,
legend)` folds a full state into one, and `frontier(frame)` every stamp one frame carries, its title
and guide included; `deltaBetween(graph, legend, since)` returns the slice a peer at `since` lacks,
with covered fields masked back to "no information", carrying the sender's full frontier as
coverage. `TreeRoom::deltaSince(since)` adds the title and guide registers the peer does not cover.
A frame's `title` or `guide` is null or absent for no information, or `{v, at}` with a string `v` and a
set stamp `at`; any other shape makes the frame `bad-frame`, so no value is coerced or read as a clear.

`TreeRoom::joinSubgraph` dedupes on `frameId`, folds the frame's stamps into the room clock,
joins graph + legend + title + guide, assigns the next `seq`, queues a headline deed for the op log,
and broadcasts to subscribers. The deed, the rows marked to save and the broadcast are all read off
what landed — each entry cut to the registers whose stamps took (`LooseGraph::join` and
`Legend::join` answer it), the title and guide only where they took — never off the frame as sent,
so a frame that echoes one node whole and recolours another is logged, told in the feed and sent on
as that recolour; a frame whose every register lands reads as it was sent. One deed states more
than landed: the one that brings a node or a kind into being — its creation stamp landed, a create
or a revive — is logged under the name, icon and hue the room holds for it after the join, whatever
of them the frame echoed (`headline`), so the feed still names a revived node once it is deleted
again. The broadcast and the rows marked to save stay what landed. The sender's ack is
unchanged: it names the `frameId` and the `seq`. A frame that sets only the title or the guide has no
headline deed, so it leaves no `tree_ops` row and no activity entry. A frame that lands nothing — a
duplicate `frameId`, one whose every stamp the room already holds, or one that carries no stamp, as
when its entries hold only keys no register keeps — takes no seq and leaves the room as it was, with
no record of an id only it named: it is not saved, logged or broadcast. Its sender is still
answered, by a `subgraphAck` that carries no `seq`. A frame that carries no stamp
(`Subgraph::carriesNoStamp`) asks for no write, so it meets only the read gate: whoever may read the
tree, a reader or a visitor without a session included, gets that ack, and no room is loaded for it;
for a tree the sender may not read it is answered as any frame is, the same for a private tree as
for an absent one. A frame that carries a stamp meets the write gate before the room, whatever the
room already holds. A broadcast carries the room's `seq` and always
states `intent: live`, whatever intent the frame arrived with — echoing a `flush` would make every
subscriber treat it as a re-baselining graft. Each subscriber is sent a tree's broadcasts in seq
order, the writer of a frame included: every fan-out is queued on the loop the subscriber's
connection lives on (`sendInOrder`, `adapters/ws/WsPresenceBus.h`), never sent straight from the
writer's handler, where it would go out ahead of earlier frames still queued behind that handler.
A reply is queued the same way, so a writer's ack follows the broadcast of its frame. A subscriber's
first frames take their places in that queue with the join, under the tree's strand, before they
are written out (`PlaceInOrder`, `WsPresenceBus::subscribe`): the delta's, so every broadcast made
after the head it reports follows it, and then the progress graft's, so every echo follows the
graft, whose marks are read after the join. No live frame goes out ahead of a subscription's first
frame; an echo of a mark made before the graft's read repeats what the graft holds.

A connection that stops taking what it is sent is dropped. A frame handed to a connection that
cannot write it stays in the server's memory, so every frame the server sends a tree-socket
connection is entered, with the bytes it takes on the wire, in what that connection has been handed
(`Outbound`, `adapters/ws/WsPresenceBus.h`): a subscription's first frames, a broadcast or an echo,
a reply, a presence frame. The bytes the connection has written to its socket (`bytesSent`, Drogon
patch `0004`) leave it oldest frame first, so what is pending is known to the byte and by kind; the
framework's own ping or pong, a few bytes, is not entered. Three rules drop a connection, each judged
on what was pending before the frame being handed, so one frame alone never drops it, whatever its
size:

- `stalled` — something is pending and not one byte was written for 120 s. It is judged when a frame
  is handed and by a timer every 5 s (`WsPresenceBus::dropStalled`), so a peer that stops reading on
  a tree nobody writes is dropped too. Any byte written is progress, a frame half-written included.
  The kernel takes a slow reader's bytes in bursts of about half a megabyte, so the time between two
  writes is that over the reader's rate — measured on loopback, 104 s at 5 KB/s — and 120 s is the
  shortest wait that never drops a reader taking 5 KB/s or more. The framework's own idle rule comes
  first for a peer that is silent too: it closes a connection that neither takes nor sends a byte
  for 60 s, with no line. A tab sends a ping every 20 s, so `stalled` is what reaches one that keeps
  sending and takes nothing.
- `behind` — more than 16 MiB of live frames, broadcasts and echoes, are pending and no first frame
  of a subscription is. A reader that takes bytes but cannot keep up with its trees is dropped, and
  its next subscribe is answered one delta in place of the backlog. A subscription's first frames,
  replies and presence never count toward it, so a large delta, or two back to back, is no backlog.
  Live frames wait behind a delta not yet written, so while a first frame is pending they are no
  measure of the reader: one slow to take a large delta is left to finish it, and is dropped as
  behind only if the live frames that waited are past the bound once the delta is written. A peer
  that takes nothing of a delta is `stalled`, or reaches the `ceiling`.
- `ceiling` — more than 320 MiB of any kind are pending: a peer that subscribes again and again
  without reading. The delta of the largest tree of plain text, 10,000 nodes each described in
  16,000 characters, is 156 MiB (measured), so two such deltas back to back stay under it.

The frame that finds a rule broken is not handed over and the connection is closed without a word,
which a tab reconnects on; its subscribe delta brings it level.

### Commands

`Command` is the server-and-agent-side write path (MCP, tending, imports); it rides the same op
log, undo and broadcast machinery, and `TreeRoom::applyCommand` emits its writes as one subgraph.
`CreateNode` and `AnnotateNode` carry the tree a node `opens` as an optional: unset leaves the
pointer, set writes it, and `""` clears it. MCP `create_node` always sets it, `""` when the call
names no tree, so a created node opens the tree its call names and no other, on an id a deleted node
held too; a stored `CreateNode` row without the field decodes as unset. An `import_subgraph` graft
(`graftState`) holds a node it brings back from a delete to the same rule: `opens` left out of the
batch is cleared there, where every other register left out keeps what the node held, and on a node
the tree holds a left-out `opens` stays as it stands. The activity feed projects
neither the pointer nor `AnnotateNode`.
`TreeRoom::applyCommands` lands several as one frame under one seq and queues them as one `Batch`
op, so the feed tells the whole edit; an empty list mints nothing.

A room never writes the op log itself: each write queues its row (`pendingOps`), and the room's
save — asked for by `RoomRegistry::persist`, the step every write path takes before it answers —
stores the lattice at the head it copied first and appends the rows queued at that copy after
(`RoomRegistry::land`); the ones that landed then leave the queue (`dropLandedOps`). One save of a
room runs at a time, so rows land in seq order, each after the save that covers it. A crash between
the two leaves a lattice at `N` with no row at `N`: the feed misses one deed and the tree nothing. A
row the lattice cannot back cannot be written. An append that fails is logged and never surfaced:
the lattice is durable, so the write answers as applied and the socket still acks; the rows stay
queued for the next save, and `tree_ops` is unique on `(tree_id, op_id)`, so a row that
committed before its connection dropped lands once. Only a room closing — `evict` after its save,
`retire`, shutdown — drops queued rows, and the room's teardown logs
`N op rows for <tree> never landed`.

`RenameNode` · `SetNodeColor` · `RepositionNode` · `CreateNode` · `AnnotateNode` · `AddEdge` ·
`RemoveEdge` · `ReconnectEdge` · `DeleteNode` · `TransitiveReduction` · `PruneDangling` ·
`RenameKind` · `DescribeKind` · `AddKind` · `RemoveKind` · `ReorderKinds` · `RecolorKind`.

- `DeleteNode` is a plain tombstone. The record and every field survive so the node can be
  resurrected; its edges stay in the document and are filtered from the derived DAG view. A child
  that loses its only live parent becomes a root — visible as `maskedWork`, never re-tethered.
- `RepositionNode`, `TransitiveReduction` and `PruneDangling` are written by nothing. A row of any
  of them that the log holds still decodes, for the feed, and lands nothing where it is merged. A
  node holds no position, so the feed skips a `RepositionNode`, alone or inside a `Batch` whose
  other members it tells, and a stored `CreateNode` row's `x` and `y` are read past. The Activity feed still tells a past
  `TransitiveReduction`.
- A `DescribeKind` without a description sets nothing, and the feed skips it,
  alone or inside a `Batch` whose other members it tells.
- `RecolorKind` is atomic: it swaps a kind's hue and repaints every node holding the old hue
  (`holdersOf`) — the present nodes wearing it (`wearersOf`, the ones a receipt counts) and the
  deleted nodes whose colour register holds it, stamped or not, so a deleted node moves with its
  kind and one brought back is under it. A record never created is not repainted. The frame carries
  a deleted node's colour as that one register, with no life stamp: a replica moves the colour and
  the node stays deleted. An import's re-hue repaints by the same rule (`repaintOf`), and so does
  the web client's own gesture (`materialize.js`), whose frame the server joins as sent.
- `validate(graph, legend, command)` runs at the edge. A graph command is refused only for a
  malformed or over-cap field, for a `CreateNode` that would take the tree past its node ceiling or,
  by the edges its prerequisites add, its edge ceiling (`growthWithin`, the sentence every door
  uses), or — `RenameNode` · `SetNodeColor` · `AnnotateNode` — an id no
  present node carries (`no node in this tree is named "x"`), so no edit plants a phantom. Legend
  commands may be refused — hue uniqueness, ≤6 kinds, no in-use removal, length caps are all locally
  decidable on the authoritative state.

### Bounds

Declared once in `domain/Command.h`. The MCP surface tells a cap in the refusal past it and publishes
none in a tool's schema (`adapters/mcp/README.md`). Every length
is counted in characters — Unicode code points, `codePointCount` — never bytes, and a refusal
names each field over its cap and by how much. Text that is not valid UTF-8 (an overlong form, a
surrogate, a code point past U+10FFFF, a lone or missing continuation byte) is refused at the same
door with `<field> is not valid UTF-8` — `isValidUtf8` runs before any cap is counted, on every
field including ids and edge endpoints, so a byte sequence Postgres would reject never reaches a
live room. A NUL, which a Postgres text value ends at, is refused the same way with `<field>
contains a NUL character`, so a room never holds text its row would cut short. The MCP surface adds two byte budgets on top: a `get_tree`/`find_nodes` page carrying
`description` ends at 4 MB of serialized nodes (the reply says `pageBytes` beside `nextCursor`),
and one `import_subgraph` call carries at most 6 MB of description text, under the 8 MB HTTP body limit.

| Bound | Value |
| --- | --- |
| id length | 128 characters |
| node `opens` | 128 characters (a tree id) |
| node label | 200 characters |
| icon token | 64 characters |
| node description | 16000 characters (an `AnnotateNode` append is held to the joined body) |
| links per node | 32 (label 200, url 2048 characters) |
| present nodes per tree | 10000 |
| present edges per tree | 20000 |
| tree title | 200 characters |
| tree guide | 5000 characters |
| legend kinds | 6 (label 24, description 80 characters) |

A title past its cap is refused wherever one is planted or copied: a posted document, a socket frame,
MCP `create_tree` and `update_tree`, and the `title` a fork is asked to carry. `PATCH /v1/trees/{id}`
alone cuts one to the cap, since a rename trims and truncates (`TreeRegistry::titleFrom`). A tree that
already holds a longer title keeps it and reads as it is.

`validate()` judges a single command; `admit()` judges arrivals that mint no command — a posted
document, an MCP graft, a client lattice frame. `admit` returns `Admission{verdict ∈ {tooLarge,
malformed}, reason}`; an HTTP door answers 413 for `tooLarge` and 400 for `malformed`. Caps are
asked against what the graph would **hold** once the arrival lands, joined not estimated.

## Runtime

One `TreeRoom` per open tree holds the lattice, the legend, the title and guide registers, the room
clock and the head `seq`, and runs under a single strand — one thread mutates it at a time. `RoomRegistry`
opens rooms on demand, hands out `strandFor(treeId)`, persists (`persist`) and evicts idle ones.

Rules:

- Hold the tree's strand across mutation, and never across a save. A write lands in the room under
  the strand, asks for its save there (`RoomRegistry::persist`, which sends no statement and answers
  a `PendingSave`), builds its reply, lets the strand go and only then waits (`PendingSave::wait`).
  The save copies under the strand what the room holds unsaved — the dirty slice, both registers,
  the head, the queued op rows — and lets go; it stores the copy and then its rows with no strand
  and no room-map mutex held; under the strand again it clears the room's marks only if no write
  landed meanwhile (`TreeRoom::writes`), and otherwise leaves them all for the next save, which
  stores them again with the rest. So a store that hangs holds up the writes waiting on it and no
  reader, of that tree or of any other.
- One save of a room runs at a time (`SaveLine::gate`, taken before the strand and never under it):
  two saves of one tree never pass each other, so a later snapshot is never overwritten by an
  earlier one. A write waits for its own save: it is answered `saved` once a save that copied the
  room at or past its seq is stored, whichever write ran it. Writes that queue behind a save that
  fails share its answer when it covered them, with no statement of their own; one that landed
  after its copy is tried once more.
- Whoever writes a tree's row itself — a subtree's create, a `PUT` — does so under the strand and
  only over a room that is flushed (`RoomRegistry::flushed`): no write unsaved, none held, no save
  running. Whoever waits on a save, or evicts, holds no strand at all: strands are a fixed stripe
  array shared by unrelated tree ids, so a wait under any of them could stand in the way of the very
  save it waits for. Never hold two strands at once, for the same reason.
- `accessOf(treeId)` answers authorization from the stored row; ask it **before** `open()`, which
  drags the whole lattice off disk and pins it.
- Persist before acking, so an ack attests durability or says what it cannot. Within a save the
  lattice is stored before the op rows are appended, so the log never runs ahead of the lattice. A
  save onto a row that is gone or soft-deleted writes nothing, retires the room and answers `gone`,
  as it does to a write whose room was retired before its save ran; the socket's `subgraph` frame,
  the guide and a live rename then answer as for an absent tree.
- A save that fails undoes nothing and throws nothing (`Saved::held`): every open page has already
  been sent the write, so the room keeps it, dirty and with its op rows queued, and the registry
  holds the room and retries the save until the store takes it, on its own timer: 1 s after the
  failure and then after twice the wait before, up to 60 s between tries (`kFirstRetry`,
  `kRetryCeiling`). Only that timer and a write that changes the room try a held room's save; a
  read, a write that changes nothing, the sweep, a `PUT` and a subtree's create send no statement
  for it and move no retry. The
  op rows land only after the save does. The writer is told the change is applied and on every open
  page, that saving it failed and is being retried, that sending it again is not needed, and that a
  server restart before the save succeeds loses it, in its door's shape: an MCP receipt carries
  `saved: false` and `saveError` and is not an error; the socket acks the frame with its seq and
  `unsaved: true`; `PATCH /v1/trees/{id}` answers `202` with `{saved: false, code: "held-unsaved",
  message}`; a removal lists the tree under `unsaved`. A call that changes nothing in a held room
  says so too, in a sentence of its own that claims no change — this call changed nothing in the
  tree, earlier changes are not saved yet and are being retried, a restart before the save succeeds
  would lose them — `unchanged: true` beside `saved: false`, an ack without a seq beside `unsaved: true`
  — since what the room holds is not saved. A held room is not closed by the sweep, and a `PUT`
  over one is refused `503 save-pending` until the save lands, as it is over a room an edit landed
  in while the `PUT` was flushing it. Only a room with something unsaved
  is ever held: one with nothing to save closes with no statement sent. As the registry stops —
  and one that goes away has stopped (`~RoomRegistry`) — it tries each held room once more, the
  wait for a retry or a write in mid-save and all of those saves within `kShutdownSaveBudget` together (5 s,
  `StatementLimits`), and reports the rooms it could not save as lost. A held write is lost only that way; marks a call stored beside it —
  `update_nodes` rows, the marks `delete_node` clears — are stored already.
- `open()` loads the stored lattice and nothing else: a room is its snapshot, and the op log is the
  history the Activity feed reads, never a second source of a tree's state. An op row states one
  deed of its frame — one node of an import, one kind of a re-hue of several — so merging it back
  could only approximate the frame, blanking fields the frame left alone or moving one kind of a
  swap. The room's head is the later of the snapshot's head and the last row's seq, so its next
  write collides with no row, and its clock observes the greatest stamp among the rows past the
  snapshot (`OpLog::past`) — not the last row's, which a replica with an honest clock leaves below
  an earlier row from one that ran ahead — so its next write is stamped after every deed those rows
  hold. Rows land after the save,
  so a snapshot is never behind its own rows. What is given up: a tree whose snapshot a crash left
  behind its op rows before 2026-09-06, when the ordering took hold, and that was never opened
  since, opens without those rows' effects; the feed still lists them. Such an open is reported
  once, as `roadmap.room.open_behind_log` with the count of rows past the snapshot, decodable or
  not (`OBSERVABILITY.md`), since the room's first save moves the stored head past them. Two things
  the lost writes left behind are not recovered. A stamp no row carries — a title's, a guide's, one
  of a frame that left no deed, any register's but the one its row is stamped with — is not
  observed, so the server can still stamp a later write of its own below it, and a client that holds
  the lost write then reads the server's as older. And the room has forgotten the frame ids it had
  seen: a client frame resent after such a reopen is joined as a new frame, its registers landing
  by their stamps over whatever the server wrote meanwhile under a lower one; only its op row is
  absorbed, by the log's `(tree_id, op_id)` uniqueness.
- The room clock mints a unique `(ms, counter)` per write, so writes to one tree are totally
  ordered and the actor tiebreak is moot. It observes the loaded stamps before minting;
  `AppliedOp.actor` records authorship independently of the clock actor `srv`.
- Sparse persistence: `dirtyState()` exports only entries dirtied since `markClean()`, which a save
  calls only when no write landed between its copy and the store taking it.
- Tree content reads use the room; the registry list reads persisted rows without opening rooms.
  A fork (`ForkService`) copies a root and its standing branch: the root, then each subtree a present
  step of a tree already read owns, a level at a time, each read from its own room under its own
  strand alone. Each copy snapshots its tree's graph, legend and guide, clears authored progress
  baselines (no one's marks are copied), and starts a fresh op log; the root copy alone records
  `forked_from`. Every copy takes a minted id, the root's the one asked for when one is, and each
  subtree's copy hangs from the copy of its parent under the same step, so a fork never shares a child
  with its source; a hidden branch is not copied. The copies are stored in one transaction that holds
  the forker's account (`TreeRepository::fork`), parent first, so each takes its place from its copied
  parent; a copy whose id is taken stores none of them. One `roadmap_tree_fork` line counts the trees a
  fork copied. A fork of the forker's own tree keeps every `opens` as it stands; a fork of anyone
  else's, or of nobody's, clears them all. Every present step of a tree is added to its copy afresh:
  a stamp from that tree's room clock, one counter tick apart in creation order, so a step's
  creation stamp is when it joined this tree and sibling ties keep their order. The root copy's title
  and every copy's guide take the first of those stamps, so a fresh subscriber's delta carries them
  beside the steps, and any later write of the new owner's outranks them. A subtree's copy takes no
  title of its own — its own title register, which nothing reads, stays empty — and is named by its
  copied step's label. A copied guide with text the forker did not
  write — the source is someone else's or nobody's, or its own guide is still inherited — is marked
  inherited (`trees.guide_inherited`): its author's words, which MCP `get_tree` answers `yours: false`,
  until a guide of the new owner's lands over it through any door. A fork of the forker's own tree
  keeps its guide theirs. A save carrying the copy's own stamp leaves the mark; a restart reads it back.

## Authorization

Read: `canRead(caller, owner, visibility)` — `private` is owner-only; `unlisted` and `public` are
readable by anyone holding the id. `parseVisibility` fails closed to private. New trees are
private.

Write: `canWrite(caller, owner)` — a tree is its owner's to change and nobody else's. An unowned
tree is readable by the world and writable by no one. `WriteRefusal ∈ {notYours, nobodysTree}`;
clients branch on the code, humans read the sentence.

`unlisted` vs `public` is consent, not permission: `public` admits the tree to the gallery and
lets its share page be indexed.

A subtree's access is its root's (Model, Subtrees), read at every access: the root's owner and
visibility, none at all while its root is deleted, and none while an owning step on its path is
absent. Every door asks it of `RoomRegistry::accessOf` before it opens a room, or of a live room's
`readableBy`; the tree's content (`TreeRepository::load`) answers no access question. A closed
tree's access is read off the stored rows with its root's and its path, and whether every step on the
path is present there, in one statement (`TreeRepository::loadAccess`). Every live room of one root's trees shares one
`RootAccess`, holding the root's owner, visibility and standing and the owning steps under the root
that are absent, so `accessOf`, the socket gates, the bus's read gate and the MCP reads answer a
subtree by its root and its path, from memory alone for a live room: the socket's fan-out reads no
store. That access is made under the root's lock from the root's row and its absent owning steps
(`TreeRepository::absentStepsUnder`), read while no room of the root's trees is live, so the store
then holds every write of theirs: a room's save runs off its strand (Runtime), and a room is still
closed only once the store holds every write it took and no save of it is running
(`RoomRegistry::flushed`). A change of the root's visibility or its removal writes the row
under the same lock, the narrower first: making the root private shuts its open subtrees before its
row says so, and opening it opens them after. Each owning step is recorded by its own tree's room as
every write lands, under that tree's strand and before the write is told to anyone
(`TreeRoom::joinSubgraph`, `applyCommands`), so a branch hides the moment its step's deletion lands
and shows with its revive, saved or not. A room records its owning steps as it opens too, from the
stored rows no other room of its tree can have written past. A `PUT`, which writes a tree's rows with
no room, then has the access take the owning steps of every tree under the root with no live room
from the store (`RoomRegistry::settleOwningSteps`), the rooms read before the rows, so a room that
saves and closes while the rows are read keeps the steps it recorded. When that read fails it is reported as itself, the
`PUT` answers what its save did, and the access is left unsettled — narrower than the store, never
wider, since a write without a room only revives steps — until the registry's sweep, every 30 s,
takes them from the store again. The live rooms below a step whose
presence changed are told, and the socket drops the readers they may no longer keep. A closed
subtree the stored rows admit is read again under its root's lock with no access live, so a parent
room that saves a deletion and closes between the first read and that check admits nobody; one they
hide is answered hidden at once, at worst missing a revive saved since, which is narrower, never wider.
No tree ever admits a reader its root and its path do not. A visibility change aimed at a subtree is
refused `not-a-root` (`PATCH /v1/trees/{id}`, `409`, naming the step it hangs from and its root).

Absent and private-denied answer identically on every surface — no existence leak.

## HTTP surface

Registered in `products/roadmap/routes.cpp`.

| Method | Path |
| --- | --- |
| POST · GET | `/v1/trees` |
| GET · PUT · PATCH · DELETE | `/v1/trees/{id}` |
| POST | `/v1/trees/{id}/fork` |
| GET | `/v1/trees/{id}/progress` |
| GET | `/v1/trees/{id}/guides` |
| GET | `/v1/trees/{id}/diagnostics` |
| GET | `/v1/trees/{id}/activity` |
| PUT | `/v1/trees/{id}/og-image` |
| PUT · GET | `/v1/trees/{id}/og-video` |
| POST | `/v1/trees/{id}/tend` |
| GET | `/v1/tend/{runId}` |
| GET | `/v1/tending` |
| GET · PATCH | `/v1/reminders` |
| POST | `/v1/reminders/pause` |
| POST | `/v1/reminders/unsubscribe` |
| POST | `/v1/admin/reminders/sweep` |
| POST | `/v1/compose` |
| GET | `/v1/gallery` |
| GET | `/gallery` |
| GET | `/t/{id}` |
| GET | `/og/{id}.png` |

Single edits have no REST endpoint — they ride the socket; `PUT /v1/trees/{id}` takes a whole
document and joins it as one write. A PUT that creates the tree stamps its steps at the moment of
creation, as `POST /v1/trees` does. A PUT into a standing tree replaces the stored row of every step
and edge it carries with the genesis stamp: those steps take the document's fields over any live edit
and read as unknown creation time. A PUT tombstones nothing: a step it leaves out is untouched, and a
deleted owning step it carries is revived, its subtree shown again (Model, Subtrees). A PUT aimed at
a tree whose branch is hidden answers `404 no such tree` and writes nothing, where one aimed at an
absent well-formed id creates the tree; one aimed at a tree the caller may not read answers `404`
too, as AUTHZ says of this door. The PUT flushes and closes the tree's live room before it takes
the strand, and under the strand closes one opened since only if the store holds all of it: over a
room that holds a save that failed, or an edit that landed while it was being flushed, it is
refused `503 save-pending` with nothing written, until that save lands. No client calls this door. Inbound models are suffixed `Request`, outbound `Response`.

`GET /v1/trees/{id}` answers `{seq, data, state, createdAt, visibility, mine, root, parent, path,
depth}`, the last four where the tree sits and `data.title` its name (Model, Subtrees); a subtree's
are read off the stored rows (`TreeRepository::placeOf`) after the tree's strand is released, and a
read that fails answers the `404` an absent tree gets. Each node of `data` that owns a subtree carries
`subtree: {id, done, total, state}`, and no other node carries one. When the caller can write the
tree the body also carries `opens`, an object keyed by node id with one entry per node that holds a
pointer, a step that owns a subtree among them: `{treeId, title, state, done, total, loop}` for a
valid one, `state` being `"complete"` or `"open"` and `loop` true when the opened tree leads back to
the tree being read, and `{treeId, missing: true}` for one that is not valid (`OpenedTrees`, Model).
Both are computed on the read, off one follow of the stored rows made after the tree's strand is
released, and nothing pushes them. For the tree's writer it follows every tree the steps open, and
when it fails the writer is answered `503 opens-unavailable`, not the `404` of an absent tree; for a
tree that holds no pointer it is not made, and `opens` is `{}`. Any other caller is never answered
`opens`, and is followed only the subtrees the steps own, under the budget and cool-off every reader's
follow of an owner shares (`OwnerProgress::followed`, Model, `readerView`): while the owner cannot be
followed each such step carries `subtree: {id}` alone and the read still answers `200`, and a tree
whose steps own none makes no follow for them.

`GET /v1/trees/{id}/guides` answers `{guides}` (Model), an array of `{treeId, title, text, yours}`.
A caller who can write the tree is answered the guides of their trees above it, farthest first,
and the tree's own last, read off the stored rows after the tree's strand is released; when the
trees above cannot be read they are answered `503 guides-unavailable`. Any other caller who can
read the tree is answered its own guide alone when it has one, `yours: false`, and nothing is read
for them but a subtree's name: a subtree's own entry is named by its owning step's label, read for
any caller (Model, Subtrees). An absent tree and one the caller may not read answer the `404` the
tree route gives.
The tree route carries no guides and never makes that read.

`GET /v1/trees/{id}/diagnostics` answers the graph's diagnostics, `{cycles, dangling, selfEdges,
smells, maskedWork}` (`TreeDiagnostics`, Model), to every caller who can read the tree: `cycles` an
array of `{count, nodes}`, `dangling` and `selfEdges` arrays of `{from, to}`, `maskedWork` an array
of node ids, each list its first 50 with `cyclesOmitted`, `danglingOmitted`, `selfEdgesOmitted` or
`maskedWorkOmitted` counting the rest, absent when that is nothing. A caller who
can write it is also answered `treeLoops`, an array of `{node, path: [{treeId, title}]}`, and
`danglingPointers`, an array of `{node, treeId}` (`PointerDiagnostics`, Model), read off the stored
rows after the tree's strand is released; both are `[]`, with nothing read, for a tree that holds no
pointer. When the pointers cannot be followed the owner is still answered `200` with the graph's
diagnostics, without those two keys and with `pointerDiagnosticsUnavailable: true`, a key that is
otherwise absent. Each list holds its first 50 nodes and a `path` its first 8 trees;
`treeLoopsOmitted`, `danglingPointersOmitted` and a loop's `pathOmitted` count what is left off and
are absent when that is nothing, and a path that is cut does not end with the tree being read
(`PointerDiagnostics`, Model). Any other caller is answered the graph's diagnostics alone, the same
bytes a tree without pointers answers, and nothing is read for them.

`PATCH /v1/trees/{id}` sets one register per call — `{visibility}`, `{guide}` or `{title}` — each the
owner's alone, and answers `204`; a guide or a title set in the tree's live room whose save failed
answers `202` with `{saved: false, code: "held-unsaved", message}` — applied, on every open page,
and being saved again by the server, so sending it again is not needed; a server restart before the
save succeeds would lose it. A body naming more than one is refused `400`, and a body that is not one JSON object
`400 invalid json body`. A guide past 5000 characters, not valid UTF-8 or carrying a NUL is refused
`400` with the admission's sentence, and an empty one clears it, as one of only spaces, tabs and line
breaks does (stored as `""`); a real guide keeps its leading and trailing spaces. A title carrying a
NUL is refused `400` too. A subtree's title is its owning step's label, so `{title}` aimed at a
subtree renames that step in its parent (Model, Subtrees). The guide's writes are this, the socket's `subgraph` frame and MCP
`update_tree`; a posted document (`POST`, `PUT`)
never sets it, and a tend is not offered `update_tree`. `GET /v1/trees/{id}` carries it as `data.guide` beside `data.title`, MCP `get_tree` as
`tree.guide: {text, yours}` on every page and no other MCP read at all, `yours` true when the caller
owns the tree and wrote its current guide. A fork copies it, marked inherited when it is someone
else's words (Runtime). The share page
and the gallery do not show it. `guides` (Model) is answered by `GET /v1/trees/{id}/guides` and by
MCP `get_tree` as `tree.guides` on the first page alone (a call without `cursor`), unless the call
sends `includeGuides: false`, which leaves the key out and makes no read. When the trees above
cannot be read, `get_tree` still answers: `tree.guides` holds the tree's own guide alone and
`tree.guidesAboveUnavailable` is `true`, a key that is otherwise absent. A tend's `get_tree`
carries `tree.guide` and no `guides`, and reads no tree above the tended one.

`POST /v1/trees/{id}/tend` runs only on a tree its caller can write, since the run writes as its
caller. A tree it cannot is a persisted refused run, answered `200` like every tend refusal and started
on no work: `no-such-tree` for an absent tree and a private one alike, `not-yours` or `nobodys-tree`
for one the caller may read.

A tree id is `t_` plus 16 lowercase hex characters (`wellFormedTreeId`); a client-supplied id
(claim-create, fork) must match byte for byte.

`POST /v1/trees` accepts initial `TreeData` plus an optional client-minted `id` and returns
`{treeId, existed}`. The initial steps share one stamp at the moment of creation; the legend takes
the genesis stamp, byte-equal to a device-born tree's. Retrying an owned existing ID returns `existed: true`. Another account's ID
returns `409 id-taken`; the caller's deleted ID returns `409 id-retired`, and the id of a subtree of
the caller's `409 not-a-root`. A client must not retry that deleted tree under a fresh ID.

`POST /v1/trees/{id}/fork` answers `201 {seq, data}`, the root copy's document (Runtime). A requested
`title` past 200 characters is refused `400` with the admission's sentence, and nothing is copied. A source
that is absent, hidden or not the caller's to read answers `404`; a subtree's id is refused `409`
`not-a-root`, `{code, error, parent: {tree, step}, root}`.

`GET /v1/trees` answers the caller's own standing roots, newest activity first, each row `{id, title,
total, done, createdAt, updatedAt, dominantKind?, openers, branch}`: a subtree is no row, and counts in its
parent as the one step that owns it, judged with every standing tree of theirs. `branch: {subtrees,
steps}` is what the root's removal takes (Model, Subtrees). `openers` names the caller's other
standing trees with a present step whose pointer names the row's tree, `[{treeId, steps}]` in tree id
order, `steps` counting those steps; the tree's own pointers at itself go with it and are not among
them, and it is `[]` when nothing opens the tree. It is what a removal would take with the tree, and
it is judged from the trees the list already holds (`OpenedTrees::openersOf`), with no further read.
MCP `list_trees` answers the same rows without `openers`, each with its `url`.

`DELETE /v1/trees/{id}` removes a root, and with it every branch under it and the steps that open it
in the caller's other trees: an opened tree goes as a node does. A removal is final. Aimed at a
subtree it is refused `409` `not-a-root`, `{code, error, parent: {tree, step}, root}`, to its owner,
and nothing is removed: a subtree goes and comes back with its owning step. What the removal took,
`TreeRepository::branchSizes` of the removed root, is read once the removal has passed every gate —
a refused removal reads nothing more than the gates do — and the answer carries it as `branch:
{subtrees, steps}`, left out when that read fails, which is reported and undoes nothing. First, with no strand held, the caller's standing trees
other than this one that hold a present step opening it are read in one statement
(`TreeRepository::treesOpening`, keyed on the caller's own trees and reading each one's steps through
`tree_nodes_pointers_idx`, so pointers other accounts plant at the tree are never read; for a tree
that is not the caller's it answers none). When that read fails nothing is removed and the delete is
refused `503` with code `cascade-unavailable`, which the caller may retry. Then, under the tree's
strand, the read gate, the owner check, the soft-delete and the room's retirement run in that order;
a step pointed at the tree between the read and the soft-delete is not among those read, and points
nowhere. Once that strand is released, each tree read, in tree id order and under its own strand
alone, has its steps that open the tree deleted as MCP `delete_node` with `prune: true` deletes nodes
(`NodeEdits::deleteNodes`): one op under one seq, broadcast to its open pages, the edges they dangle
removed with them and the caller's marks on them cleared, a closed tree opened for it and saved before
the next. The read and every tree's statements wait for a lock at most a second, and all of it ends
eight seconds after the read began (`StatementLimits`, `TreeRegistry::kCascadeLockWait` and
`kCascadeTime`), so a reply never waits on a stuck tree for longer. It answers `200` with what became of
those steps, per tree in tree id order:

- `removed: [{treeId, nodeIds}]`, always present: the steps were deleted and saved.
- `unsaved: [treeId]`, present only when it names a tree: the steps were deleted in the tree's room
  and sent to its open pages, and the save then failed. They are gone now, and the registry retries
  the save until it lands (a save that fails, Runtime); should the server restart before it
  does, they come back, without the caller's marks the delete cleared.
- `incomplete: [treeId]`, present only when it names a tree: nothing was deleted there — its room
  could not be opened, the marks not cleared, or the eight seconds ran out before it was reached — and
  the steps stay. Each points nowhere: it reads as an ordinary step, `get_diagnostics` lists it in
  `danglingPointers`, and the caller can clear its pointer or delete it by hand.
- `branch: {subtrees, steps}`, what went with the root.

MCP `delete_tree` answers `{deleted, id, removed, branch}`, with `unsaved` and `incomplete` on the same
rule, and refuses under `cascade-unavailable` with nothing removed, and a subtree's id under
`not-a-root`, as the REST door does. Each is answered to
the tree's owner alone and names only their trees; a refused delete edits nothing.

`GET /v1/trees/{id}/progress` answers the owner's overlay, `{marks: [{node, status, at, markedAt,
outOfOrder?}]}`, to anyone who can read the tree: the stored marks to a caller who can write it, whose
view derives completion again from the tree's `opens`, and `readerView` of them (Model) to every other
reader. It answers `200` whether or not the trees could be followed.

`/v1/gallery` and `/gallery` are anonymous-allowed; a session only adds the two facts a row wears
about its reader and never changes which trees are listed, the public roots alone. A card's `done` counts the owner's marks
as `readerView` shows them, in at most one follow per owner whose listed trees hold a pointer
(Model, `readerView`), and its time (`updatedAt`) is the later of the tree's own last edit and the
latest `markedAt` among those rows, so a card's time and place on the wall come from what a reader is
shown and from no mark they are not. `/v1/compose` is anonymous-allowed (the birth canvas has no
account) behind a rate limit. The reminders pause POST carries no
credential — only the secret from the recipient's own mail — and answers 204 either way. The admin
sweep is closed unless `REMINDERS_ADMIN_TOKEN` is set.

## WebSocket surface

`products/roadmap/adapters/ws/`. One socket, JSON frames, `t` names the frame type. The
credential is presented at the upgrade; every write re-proves the session, throttled to one lookup
a minute, and a revoked session narrows to a guest in place. Visibility is re-asked per frame.

Client → server: `ping` · `subscribe {treeId, vector}` · `subgraph` (a serialized `Subgraph`, with
`branches: [subtreeId]` naming the subtrees it takes with the owning steps it deletes) ·
`progress {treeId, frameId, marks[{node, status, at}]}` · `presence {treeId, …}`.

Server → client: `pong` · `subgraph` (intent `delta` carrying `seq` and `reach` as the subscribe
answer, with the title and guide registers when the vector does not cover their stamps; intent
`live` for a peer's broadcast, with no `reach`; either is the frame's `readerView` for a connection
that cannot write the tree, and the delta's `reach` is that same verdict: `writer` for a connection
that can, `reader` for any other) ·
`progress` (intent `graft` on subscribe, echo otherwise) ·
`subgraphAck {treeId, frameId, seq?, unsaved?}` · `progressAck {treeId, frameId, refused?}` ·
`skew {treeId, frameId, serverNow}` · `reject {treeId, code, reason, frameId?}` · `presence` ·
`peer` · `subtree {treeId, seq, step, subtree: {id, depth}}`.

`subtree` says a subtree was created under `step` (Model, Subtrees). It takes the tree's next seq and
goes to every subscriber, reader and writer alike, carrying the same bytes: whoever may read the tree
may read its subtrees, whose access is its root's. No door creates a subtree yet, so no connection is
sent one. The web client takes its seq as it takes a live frame's (`docs/GRAPH_SYNC_DESIGN.md`) and
changes nothing else.

The subscribe answer carries `subtrees: [{step, id, depth}]`, one per present step that owns a
subtree, read under the strand with the delta, so a client that missed a `subtree` frame heals on its
next subscribe; it goes to readers and writers alike and is absent when the steps own none. It is
told, never a register: no client writes it and no join reads it. A subtree's own subscribe answer
carries its name, its owning step's label under that label's stamp, as the `title` register whatever
the vector covers; the name is read off the stored rows after the strand is released, and its stamp is
the parent's and is never folded into the answer's coverage. The subtree's own title register is
neither sent nor covered. A read of the name that fails is answered by a `server-error` reject, as a
failed join is, and the client asks again.

`progressAck.refused` is present only when the frame carried a mark that was refused: an array of
`{node, code}`, one per refused mark in the frame's order. The one code is `opens-a-tree` — the node
holds a valid pointer and the connection can write the tree, so the node is complete when the tree
it opens is and takes no mark (`OpenedTrees`, Model). It names the node and nothing of the opened
tree. A mark that lost to a later stored stamp is not refused and is not listed. The frame is not
rejected: its other marks are recorded, echoed and acknowledged.

Reject codes are a stable wire contract — branch on `code`, never on `reason`:
`no-such-tree` · `server-error` · `sign-in-required` · `tree-too-large` · `bad-frame` ·
`not-yours` · `nobodys-tree` (the last two from `writeRefusalFor`, on the write lane) ·
`branch-unconfirmed`.

A `subgraph` frame that would delete a step owning a subtree its `branches` do not name is refused
whole as `branch-unconfirmed`, with nothing of it landed (Model, Subtrees): the reject carries
`branches: [{step, subtree, steps, subtrees}]`, one per such step in step order, and the first one's
`subtree`, `steps` and `subtrees` beside its code, the counts left out when they could not be read.
A frame whose `branches` is not a list of tree ids is refused as `bad-frame`. A frame's `branches`
are never broadcast. Deleting the step hides the subtree: each page open on a tree of its branch
whose room is live is sent the `no-such-tree` reject at once and is no longer sent its frames; one
whose room had closed is sent nothing of it, since only a live room makes a frame, and is told within
the 15 s re-proof of every open subscription, as a reader of a root made private is (`AUTHZ.md`). A
subscribe that joins while an owning step above it is deleted is asked the gate again once it has
joined, and is refused `no-such-tree` with nothing of the tree sent.

Limits and rules:

- Frame rate: 50/sec sustained per connection, burst 100. A flooding connection's frames are
  dropped before parse.
- Message size: an inbound message carries at most `kMaxSocketMessageBytes` (1 MiB,
  `domain/Command.h`; `packages/api-contract/roadmap-socket.json` names it and the size the web
  client packs its frames under). `main.cpp` sets it as the framework's limit, which is one limit
  for every socket the server serves and drops the connection of a larger message before any handler
  runs: nothing is answered and no write line is logged for it. A node entry at every field's cap
  fits a message of its own.
- Skew clamp: a frame stamped past `now + 5 min` is refused whole (a `skew` frame), title and guide
  registers included — a runaway stamp must not own a name or a guide for years. Both lanes apply it.
- A progress frame carries at most 2000 marks; a mark missing node, status or stamp refuses the
  whole frame.
- A progress frame is refused whole — a bad mark, a skewed stamp, a failed read gate — or applied
  per mark: each mark is its own last-writer-wins register, so the marks that landed are echoed and
  the ack names the ones `refused`. A replica's mark loses to a later stamp the row holds
  (`StampedBy::replica`); a server door's mark — MCP `update_nodes`, an import's `progress[]`, the
  clear a delete makes — always lands, at its own stamp or just after a later one it finds
  (`StampedBy::server`). Either way one statement reads the row and writes it
  (`ProgressRepository::setStatuses`), and what a mark did is that statement's answer
  (`ProgressWritten`). It joins no op log and echoes only to the same account's
  sessions — never to collaborators. The room is consulted under the tree's strand and the
  repositories are read and written after it is released.
- Presence is ephemeral, never persisted, flushed on a 50 ms timer (latest-wins per actor).
- Drogon does not wrap WS callbacks: an exception escaping the frame handler aborts the process.
  Decode failures are refused by code, never by throw.
- A frame whose text is not one whole JSON value — a break after a complete field, a lone
  surrogate, a second value after the first — is refused whole as `bad-frame`, carrying the
  `treeId` and `frameId` its readable head names; no part of it is applied.
- A guide register of only spaces, tabs and line breaks is refused as `bad-frame`: its sender
  stamped that text, so it cannot be stored as `""`, and a client sends `""` for no guide.
- A `subgraph` frame whose save fails is acked with its seq and `unsaved: true`: it has landed in
  the room and been broadcast, the registry retries the save, and the sender does not send it
  again. One whose room cannot be opened is answered `server-error` with its `frameId`, and one
  whose tree's row went away under the live room `no-such-tree`.

## Persistence

PostgreSQL; `db/schema.sql` is the one file, applied in order and idempotent.

| Table | Holds |
| --- | --- |
| `trees` | title and guide (each LWW: `<register>_hlc` plus the `<register>_ms`/`<register>_counter` numeric split), `guide_inherited`, `owner_id`, `visibility`, `head_seq`, `forked_from`, `deleted_at`, `document` jsonb; the tree's place: `parent_tree`, `parent_step`, `root_tree`, `depth` |
| `tree_nodes` | one row per node: `created_hlc`/`deleted_hlc` plus each register and its `_hlc`, and `present`; `tree_nodes_opens_idx` finds the present nodes that open a given tree, and `tree_nodes_pointers_idx` the trees a given tree's present nodes open, and whether they open a given one |
| `tree_edges` | one row per `(from_id, to_id)`: `added_hlc`, `removed_hlc` |
| `tree_kinds` | one row per legend kind: hue, label, description, rank, each with its stamp |
| `tree_ops` | append-only log — `(tree_id, seq)` pk, `unique (tree_id, op_id)` for idempotency |
| `node_progress` | per-user private overlay — status, `out_of_order`, `hlc`, `stamp_ms`, `stamp_counter` |
| `tree_og_images` / `tree_og_videos` | the share card PNG and loop, inline `bytea`, one row per tree |

Rules:

- The lattice is entry-grow-only. A save upserts only the rows it touched and deletes nothing; a
  delete is a tombstone stamp. Stamps are canonical HLC text and are never compared in SQL —
  `present` is computed by the writer for read-side projections.
- `trees.document` is the whole-tree jsonb blob, read only as a fallback for trees whose per-entry
  rows are not yet backfilled. Nothing new depends on it.
- `tree_ops` scales with edits, not nodes. `ActivityFeed` projects it; `open()` reads only the seq
  and stamp of the rows past the snapshot's head, none for a tree level with its log.
- A root's deletion writes its `deleted_at` and retires its room, then tombstones the steps of the
  owner's other trees that open it (HTTP surface, `DELETE /v1/trees/{id}`); a subtree's `deleted_at`
  is never written. Reads exclude deleted rows and every tree under a deleted root, and save never
  clears the tombstone. Recreating the caller's own deleted ID returns
  `Creation::retired`, so a client can stop replaying it instead of reminting an ID.
- An erased account's trees are deleted outright, its subtrees among them, whose rows carry their
  root's owner, with their rows, ops and everyone's progress on them (`backend/AUTH.md`), and their
  rooms are retired once that commits. A save lands only on a row
  that stands: a room whose tree row is gone saves nothing and lands no op rows.
- Progress upserts compare numeric `(stamp_ms, stamp_counter)` strictly; a tie loses without
  consulting the actor. Clears retain a stamped `none` row.
- The og-image and og-video rows carry no FK to `trees`: they are addressed by tree id and read
  behind the access gate every door asks (`RoomRegistry::accessOf`), so a stray row, or a hidden
  branch's, is simply unreachable.
- A tree's place (Model, Subtrees) is written once, at insert, by the store. `trees_place` makes a
  row inserted without a parent a root, `root_tree` its own id and `depth` 0, whoever inserts it, so
  a binary that knows nothing of subtrees still writes roots, and `db/schema.sql` makes a root of
  every row that has no `root_tree`. A row inserted with a parent takes its `root_tree`, its
  `owner_id` and its `depth` from the parent's standing row, held against its removal, whatever the
  insert names; a parent that does not stand is refused, and so is one at depth 8, and so is a place
  naming a parent without a step or a step without a parent. Its `visibility`
  column holds `private`, and no read of its access reads it. `trees_place_fixed` refuses an
  `UPDATE` that changes any of the four. `trees_parent_step` is unique on (`parent_tree`,
  `parent_step`) for rows with a parent, so a step owns one subtree whatever writes it.

Indexes that exist because their query runs on every render: `trees_owner` (the registry list),
`trees_forked_from` (fork lineage, asked once per share page and once per gallery card),
`trees_public` (the listed slice of a mostly-private table).

## Subtree inventory

`windmill_subtree_inventory` (`platform/infra/subtree_inventory.cpp`) counts how the pointers between
the stored trees meet a model in which each step owns at most one subtree and each subtree has one
owning step. It reads `DATABASE_URL`, prints one JSON object of counts on stdout and nothing else, and
never writes. A failure prints one fixed sentence on stderr and exits 2 without `DATABASE_URL`, 1
otherwise. Its completion is `roadmap.subtree.inventory` (`OBSERVABILITY.md`). On production it runs
inside the live server container through the **Ops · subtree inventory** workflow, which seals the
counts to the owner's certificate before the public job log sees them (`deploy/README.md`).

The read is `PgTreeRepository::eachAccountsTrees`: one statement over `trees` and the present pointers
in `tree_nodes`, read through `tree_nodes_pointers_idx`, in a `READ ONLY` transaction. A cursor fetches
it a thousand rows at a time, ordered by account, so the tool holds one account at a time. A step
counts when it is present in a standing tree of an account. Deleted steps, every step of a deleted
tree and every tree nobody owns are left out. `inventory` (`domain/SubtreeInventory.h`) judges each
account alone by the validity rule `OpenedTrees` holds (Model), and the accounts' counts are summed:

- `trees` — the standing trees, and the account's deleted trees a counted step still names.
- `roots` — standing trees no valid pointer opens. Another account's step is never a valid pointer, so
  a tree only someone else's step names is a root.
- `owned` — standing trees on no loop that exactly one step opens, from another tree. They convert with
  no choice.
- `hanging` — owned trees no root reaches through owned trees alone: they hang under a tree opened twice
  or under a loop, and `depth` leaves them out.
- `multiOpened` — standing trees on no loop that two or more steps open, with `sameTree` (two or more
  of those steps in one tree), `acrossTrees` (those steps in two or more trees; a tree may count in
  both) and `maxOpeners`, the most steps opening one of them, counted up to 100.
- `cycles` — standing trees on a loop of valid pointers, with `selfPointers`, the steps opening the tree
  they stand in, and `loops` by how many trees each holds: `1`, `2`, `3-8` and `9+`. A loop is a set of
  trees each of which leads to every other (`OpenedTrees::loops`), so two loops through one tree count
  as one. `byEntries` counts the loops again by how many present steps from outside the loop open one of
  its trees: `0` (the loop needs a root of its own), `1` (a cut that needs no choice) and `2+`.
  `alsoMultiOpened` counts the trees on a loop that two or more steps open, the loop's own steps and the
  tree's included; `multiOpened` does not count them.
- `dangling` — steps whose pointer is not valid, by what it names: `missing` (no row, shaped as a tree
  id), `deleted` (the account's own deleted tree), `foreign` (another account's tree or nobody's,
  standing or deleted) and `notATreeId` (no row, and not shaped as a tree id).
- `depth` — the trees a root reaches through owned trees alone, at `1`, `2`, `3` and `4+` pointers
  down, and the `deepest`. An owned tree under a tree opened twice, or under a loop, has no depth.
- `depthIfResolved` — every standing tree at the deepest any choice could nest it, in the same buckets,
  and the `deepest`: an upper bound on the nesting the conversion can make. It is the longest way down
  valid pointers, where a loop of n trees counts n deep. Whichever steps a choice keeps, a way down from a
  root enters a loop at most once and passes each of its trees at most once, so a loop cut into a chain
  can stack all its trees; every tree of the loop is counted at the depth of the deepest of them. A tree
  or a loop that nothing outside it opens starts at the top.
- `accounts` — `withPointers`, the accounts with any step that names a tree, and `needingChoice`, those
  with a tree opened twice, a tree on a loop or a dangling step.

Every standing tree is counted in exactly one of `roots`, `owned`, `multiOpened` and `cycles`. A tree
on a loop is counted under `cycles` whatever else is true of it, since a loop has no owning step until
one of its pointers goes. The other three are told apart by how many steps open the tree.

The doors that set a pointer are `POST /v1/trees` and `PUT /v1/trees/{id}` (a posted document), the
socket's `subgraph` frame, MCP `create_node`, `update_nodes` and `import_subgraph`, and a fork of the
owner's own tree, which keeps its pointers. A tend cannot set one. `tree_ops` does not record which
door set a pointer: a frame's row is its headline deed, which never carries `opens`, so a frame or an
`import_subgraph` graft that sets only a pointer leaves no row (Convergence), and a command's row
carries the pointer under the `srv-` op id that MCP, tending and a removal's cascade share. The
inventory counts no door.

What the inventory does not measure, because it is not in `trees` or `tree_nodes`:

- **The on-device store.** The web keeps each tree it holds, and the whole of every tree born signed
  out, in the browser's IndexedDB database `windmill-sync`, store `trees`: one record per tree with
  the structure lattice (each node's `opens` and `opensAt`), the confirmed baseline, the progress lane
  and the unsent gestures (`web/src/products/roadmap/sync/SyncStore.js`). The trees born signed out
  are indexed in localStorage under `windmill:device-trees` (`persistence/LocalTreeRegistry.js`,
  `sync/localTrees.js`) and reach the server only when claimed (`sync/claimLocalTrees.js`: `POST
  /v1/trees`, then the lattice through the socket); `repointDeviceSteps` moves the device's steps to a
  tree's new id when a claim mints one. Only web code running in that browser reaches this store, or
  the server door its writes arrive at.
- **Queued edits held in browsers.** A record's registers newer than its confirmed baseline are the
  browser's outbox (`sync/pendingWrites.js`), a node's `opens` among them. They arrive as socket
  `subgraph` frames, from whatever bundle the tab is running, and the room holds `opens` to its length
  alone (Model). localStorage may also hold marks under `windmill:progress:<tree>`, which
  `persistence/ProgressStore.js` drains into the progress lane; they are marks, never a pointer.
- **Document-only records.** A browser that refuses IndexedDB keeps the same records in the tab's
  memory alone (`DocumentRecords` in `SyncStore.js`); they reach the server only as that tab's frames
  and are gone with it. On the server, `trees.document` holds the lattice of a tree whose rows were
  never backfilled, and `load` backfills them on the tree's first open. Nothing has written the column
  since rows replaced it, before `opens` existed, so it holds no pointer; the inventory does not read
  it.

## Open items

- A tombstoned node's edges are retained for resurrection and nothing compacts them, so the
  lattice grows monotonically.
- `label` is LWW, so a concurrent rename drops the loser.
- A second server process can collide on `(tree_id, seq)`; room heads and presence are local and
  the server clock actor is not instance-qualified. Run one writer per database.
- `TreeRoom::appliedOpIds_` grows without a bound; `tree_ops` also enforces durable op-ID uniqueness.
- `ActivityFeed::displayActor` recognizes `dev` and guest IDs, but renders real user UUIDs as the
  tree itself. Offline flushes retain only one coarse headline for the coalesced gestures.

Cross-surface coverage and offline durability are specified in
[graph sync](../docs/GRAPH_SYNC_DESIGN.md). The
[golden corpus](test/golden/SCHEMA.md) does not yet test the real C++ and JavaScript implementations.
