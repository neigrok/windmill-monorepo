# Roadmap on the sync engine

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
definitions (`D-n`), invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and
roadmap nodes can cite them.

## §0 Status and scope

**Status:** Specified; not approved, and nothing is built. Roadmap syncs through a sync of its own:
a lattice and a socket described in [graph sync](../GRAPH_SYNC_DESIGN.md) and
[the roadmap tree engine](../../backend/SPEC.md), on the web only. The [sync engine](engine.md)
serves gym and journal, and its roadmap binding (Appendix A.1) is a sketch nothing implements. The
build order lives in the Roadmap on the engine roadmap tree, which the dogfood tree
(`t_9362d9bc883e0a1e`) opens from the node `roadmap-on-the-engine`.

**Scope:** Roadmap's move onto the sync engine and the [domain kit](domain-kit.md): the registry
that replaces Appendix A.1, the rules every surface shares, the server's side, the move of
production's roadmaps, the web's move, and what retires.

**Out of scope:** The iPhone's Roadmap room ([Roadmap on iOS](roadmap-ios.md)), which is built on
what this document specifies. [Roadmap Coach](roadmap-coach.md). The Graph's renderer and layout,
which do not change. Android, which carries no roadmap.

**Depends on:** the sync engine and the domain kit as built.

## §1 Principles

- **P-1 One sync.** Roadmap's records are records of the sync engine. Nothing of roadmap's own sync
  remains: no lattice, no room, no socket, no store of its own. (R-1)
- **P-2 The device's copy is the roadmap.** Every surface reads and changes a roadmap in its replica
  and syncs. A roadmap opens from the device's copy, and works with no connection.
- **P-3 One set of rules.** What a gesture writes, what it refuses and what a reader derives are
  pure functions on the domain kit, in JavaScript and in Swift, held together by shared vectors
  (§9).
- **P-4 A person's change is never refused for what happened elsewhere.** A change made without
  knowing of another device's change lands. An odd result is the accepted price. (R-2)
- **P-5 The backend is called only for what is the server's by nature:** an account, a link a
  stranger opens, a model call, a mail it sends, and what an outside assistant writes.
- **P-6 Nothing a person made is lost in the move.** Every roadmap, mark and workspace, and every
  change a browser holds unsent, arrives in the engine. (R-5)

## §2 Vocabulary

*Scope*, *record*, *intent*, *gesture*, *hold*, *notice*, *command* and *replica* mean what the
[sync engine](engine.md) §1 defines; *entity*, *action*, *rule* and *draft* what the
[domain kit](domain-kit.md) defines. *Step* is the product's word for a `node` record.

- **D-1 Root, subtree, branch.** A *subtree* is a roadmap a step owns. A *root* is a roadmap no
  step owns. A root's *branch* is the root and every subtree under it.
- **D-2 Pointer.** A step's reference to another roadmap of the same owner, which the step *opens*.
- **D-3 Standing.** A subtree stands while its root stands and every step that owns a roadmap on
  its path is present.
- **D-4 Landing.** What a device does when a change it made meets a change it did not know of (§5).

## §3 The registry

Product `roadmap`, surfaces web and iOS, primary type `tree`. This table replaces
[sync engine](engine.md) Appendix A.1, which the build rewrites to it. `chars` and `bytes` are the
engine's units (D-9).

| Type | Scope | Identity | Life | Fields | Cap |
|---|---|---|---|---|---|
| `tree` | self/roadmap | minted global `^t_[0-9a-f]{16}$`, governs `tree:<id>` | terminal, keep | `parent` const server `{tree: ref<tree>, step}`, null for a root | — |
| `pointer` | self/roadmap | keyed `[tree, step]` | yes, keep | `opens` lww `ref<tree>` | — |
| `meta` | tree/T | singleton | — | `title` lww ≤200 chars; `guide` lww ≤5,000 chars; `guideInherited` server; `visibility` lww server ∈ {private, unlisted, public}; `reach` lww server ∈ {private, unlisted, public}, which `opens` at {unlisted, public}; `root` const server `ref<tree>`; `forkedFrom` const server | — |
| `node` | tree/T | derived ≤128 chars, fallback `step` | revivable, keep | lww: `label` ≤200 chars, `icon` ≤64 chars, `color`, `ord`, `status`, `description` ≤16,000 chars, `links` (at most 32 of {url ≤2,048 chars, label ≤200 chars}); `branch` const server `ref<tree>` | 10,000 |
| `edge` | tree/T | keyed `[from, to]` (`ref<node>` each) | yes, keep | — | 20,000 |
| `kind` | tree/T | derived ≤128 chars, fallback `kind`; genesis `build`, `learn`, `milestone` | revivable, keep | lww: `hue`, `label` ≤24 chars, `description` ≤80 chars, `ord` | 6 |
| `progress` | self/overlay/T | keyed (`ref<node>`) | none | `mark` lww `{status: complete\|none, outOfOrder: bool}` | — |
| `subtask` | self/overlay/T | minted | yes | `step` const `ref<node>`; lww: `label` ≤200 chars, `done`, `ord` | 20,000 |
| `stepLink` | self/overlay/T | minted | yes | `step` const `ref<node>`; lww: `url` ≤2,048 chars, `title` ≤200 chars, `ord` | 20,000 |
| `stepNote` | self/overlay/T | keyed (`ref<node>`) | none | `text` text ≤16,000 chars | — |

Roadmap Coach's records join this registry as [Roadmap Coach](roadmap-coach.md) §9 lists them.

- **Step ids.** A step's id is whatever it is today: valid UTF-8 without NUL, at most 128 code
  points. The type's pattern admits those, so no address changes. A new id is derived as the engine
  derives one (D-26).
- **Order.** `ord` is a fractional key the product compares among the steps of one trunk parent,
  and among a roadmap's kinds. The engine stores it and orders nothing by it.
- **A pointer is the owner's alone.** It lives in the owner's product scope, so a reader of a
  shared roadmap never receives it: a roadmap's id is what lets a person read an unlisted roadmap.
- **A subtree is said in the roadmap that holds its step:** `node.branch` names it, so a reader of
  a shared roadmap can go in.
- **`reach` decides who may read.** It is the root's `visibility` while the subtree stands (D-3),
  and `private` otherwise. A root's `reach` is its `visibility`.
- **The workspace** is `subtask`, `stepLink` and `stepNote`: a person's own, in their overlay of a
  roadmap, on every device they use. A reader has one of their own beside their marks. (R-3)
- A.1's `track` is not built: the list of a person's roadmaps is their own `tree` records.
- The registry joins the composition beside gym's and journal's, and the composition's version
  rises. Nothing a gym or journal client relies on changes, so the minimum version does not.

**Commands**

- `roadmap.setVisibility {visibility, stamp}` in a root's `tree/<T>`, by the owner. It writes the
  root's `visibility` and `reach`, and the `reach` of every subtree of the branch that stands.
- `roadmap.createSubtree {tree, step, subtree}` in `self/roadmap`. It creates the `tree` record
  with its `parent`, the subtree's `meta` with `root` and `reach`, and writes `node.branch`. A step
  that owns a subtree takes no pointer and no mark of its own.
- `roadmap.fork {src, dst, title?}` in `self/roadmap`. It copies the branch of `src`: every
  standing subtree, every step, link and kind, under new stamps, so a step's created time is when
  it joined the copy. `status` is cleared, the guide is marked inherited when it was another
  person's, and pointers are copied only into the owner's own fork.

**Consequences**

- A step's death that ends a subtree's standing writes `reach` `private` on every subtree under it,
  and the step's revival writes it back.
- A root's death kills its subtrees.

## §4 Gestures

Every gesture is an action on the domain kit, the same in each language.

- **Create a roadmap** is atomic: the `tree` record, then one intent in its tree scope with the
  title, the genesis kinds and the first steps.
- **Create a step** writes the step and one link from each prerequisite, in one intent.
- **Edit a step** writes its fields and its life as alive, under the gesture's stamp. So an edit is
  admitted whether or not the step was deleted elsewhere, and leaves it present. (P-4)
- **Delete a step** is held. It writes the step's death, and a link from each of its present
  prerequisites to each step that followed it, so nothing that followed is cut loose. Undo before
  release drops it; Undo after release revives the step and retires the links the delete added.
- **Delete a roadmap** is held. It kills the `tree` record and, in the same gesture, deletes every
  step of the owner's other roadmaps that opened it.
- **Recolour a kind** is atomic: the kind's hue and every step that wears it.
- **Complete and Reset** write the step's `progress` mark. A step that opens a roadmap or owns a
  subtree is complete exactly when that roadmap is, and takes no mark.
- **Import and paste** commit atomic intents of at most `IMPORT_CHUNK` records each, prerequisites
  before what follows them.
- **Limits are checked where the gesture is made:** the caps and bounds of §3, a cycle, a hue
  already worn by another kind. A gesture that would break one is refused there, before anything is
  written.
- Every other gesture is one intent per record, and a reorder writes the moved record's `ord`.

## §5 Landing

A device lands its own changes when the server has answered them.

- **A link to a step that is gone.** When a device learns that a step it linked from is absent, and
  the link was its own write, it retires that link and writes a link from each of the absent step's
  nearest present prerequisites. The person is told once, where the step is listed and on its page.
- **An edit of a step deleted elsewhere** has brought the step back (§4). The person is told once.
- **What still cannot land:** a change to a roadmap deleted on another device, one that would pass
  a cap another device filled first, and one made after write access ended. The engine keeps each
  as a notice with its content. The product lists them in one place with the reason, and the person
  may copy what they hold or discard them. Nothing else is ever shown as refused. (R-2)

- **INV-1.** A present step holds no link to an absent step once the device that wrote the link has
  synced.
- **INV-2.** Landing writes only keyed links, so two devices that land the same change write the
  same records.
- **INV-3.** No screen offers Retry or Discard for a change §5's first two rules cover.

## §6 Reading

- **A person's roadmaps.** A signed-in replica subscribes the tree and overlay scopes of every
  `tree` record it holds, so every roadmap a person owns is on the device, and the list, each
  roadmap's count of steps done and what a pointer's roadmap comes to are computed there.
- **Someone else's roadmap.** A device subscribes a readable roadmap when a person opens its link,
  signed in or not, and its subtrees as the person goes in. A signed-in reader's marks and
  workspace are their own overlay.
- **The owner's progress on a shared roadmap** is a backend read, as it is today. Overlays are
  private in the engine.
- **Signed out**, a roadmap a person makes lives in the device's `anon` replica. At sign-in the
  engine's lineage rule decides: added without asking to an account that holds no roadmaps, and
  otherwise by the person's Add or Discard. At sign-out it asks Keep or Discard for what is unsent.
  The silent adoption and the silent wipe the web does today both end.

## §7 The server

- **The binding.** `backend/products/roadmap/sync/` binds the registry's types and commands to
  roadmap's tables, as gym's and journal's bind theirs, with the rules of §3 and §4 the server
  enforces: bounds, caps, the kind hues, and no cycle among a roadmap's present links.
- **The door.** Every server write for a person goes through one door that admits server-origin
  intents: MCP's write tools, the routes that create, fork, delete and share a roadmap, and the fork
  at sign-up. Each MCP write tool takes an optional `requestId`, so a retried call writes once.
  Tending goes with [Roadmap Coach](roadmap-coach.md).
- **Read models** are fed from the typed tables: the activity feed, one headline a gesture; the
  gallery and the share page; the owner's progress shown to readers; diagnostics; reminders'
  readiness. None answers admission.
- **What stays a backend route:** create, fork and delete as server-origin doors for MCP and for a
  browser that has no replica yet; `GET /v1/trees/{id}/activity`; the owner's progress for readers;
  the share page, the gallery and the cards; compose; reminders. Reads of a roadmap's records and
  every single edit go through `/v1/sync`.
- **The public demo** is owned by a house account, since every scope has an owner.
- **Presence and remote cursors end.** (R-6)

## §8 The move

### §8.1 Production's roadmaps

The data moves in one planned cutover, rehearsed against a copy of production, with the site in
maintenance for its length and a verified backup to return to. (R-5)

- Roadmap's tables take the engine's envelope: scope, `seq`, `rc`, `ru`, `born`, life and a stamp
  for each field.
- A stamp roadmap already holds is kept where it is a stamp the engine accepts; an unset or
  malformed one becomes the adoption's base stamp, one server stamp for the whole move.
- Each scope's `seq` is assigned in one pass. `rc` and `ru` come from the rows' created and updated
  times. Deleted roadmaps become spent ids; deleted steps and kinds stay, dead.
- An empty `ord` becomes a key that keeps today's order, and a kind's `rank` becomes an `ord`.
- A pointer moves from its step to a `pointer` record. A subtree's place becomes `tree.parent`,
  `meta.root` and `node.branch`, and every `reach` is computed.
- A roadmap stored only as a whole document is unfolded into rows first.
- Marks move to their owners' overlays.
- The move is audited before writes resume: every roadmap reads the same through every route and
  MCP tool as before it, every scope's digest sums, and a second run changes nothing.
- A failure before writes resume restores the backup. After that the move goes forward only.

### §8.2 What a browser holds

The first load of the new bundle carries over what the old one kept, before it deletes it.

- Roadmaps made signed out become creations in the `anon` replica.
- Changes a signed-in browser had not sent are committed to the bound replica with the stamps they
  were made under, after its first pull.
- Workspaces kept in the browser become `subtask`, `stepLink` and `stepNote` records in the
  person's overlay, on the device that held them.
- The old stores are deleted once the engine has made the carried work durable.

- **INV-4.** A browser deletes nothing of the old stores that the replica does not hold.

### §8.3 Old bundles

- Before the cutover, a release teaches the roadmap room to reload when the server says its build
  is retired.
- After it, `/v1/socket` refuses every connection and roadmap's former write routes answer `410`
  `client-update-required`, before authentication or parsing.

### §8.4 The web

- The roadmap room reads through views of the replica and writes through the domain's actions. The
  Graph, the Board, the step page, the layout and the scene keep their own code.
- A roadmap opens from the device's copy; the network is not waited on.
- `web/src/products/roadmap/sync/`, the stores under `persistence/` that exist for it, and their
  tests are deleted.
- The screens that showed a refused change with Retry and Discard, the Restore offer for a hidden
  link, and presence are redrawn or removed on boards the owner approves (§10).

## §9 Testing

- **Vectors.** `packages/api-contract/roadmap/domain/` holds the rules, the actions of §4, the
  landing of §5 and the reads: what a step's state is, what it owes and unlocks, what an opened
  roadmap comes to, the Board's groups and order, the legend, search, sort and filter. JavaScript
  and Swift run every file, and a rule lands as a vector first.
- **The engine's corpus** gains roadmap's cases: the commands, the consequences, and a reader's
  access as `reach` changes. All four implementations run it.
- **Size.** Before the registry is fixed, the engine is measured at roadmap's size, 10,000 steps
  and 20,000 links, on the server and on each client: first pull, opening from the device's copy,
  and one gesture. A budget it misses is fixed in the engine first.
- **The move** runs against a copy of production in rehearsal, with fixtures for an interrupted run
  and a corrupted row, and the audit of §8.1.
- **The browser's carry-over** is tested from stores written by the last bundle before the cutover.

## §10 What a person sees

What changes is built only from boards marked ✅ Ready for dev: the quiet line for a change that
landed oddly, the place that lists what could not land, sign-in's Add or Discard and sign-out's
Keep or Discard for roadmaps, and the web without presence. The web's states for a refused change
(flow 43) retire.

## §11 Observability

- The server logs one line a write on every door, as it does for gym, and reports unexpected
  failures to Sentry under static names.
- Clients emit an event when a change lands by §5's rules and when one cannot land, with the rule
  or the refusal's code and no text of the person's.
- The cutover reports each stage, and its audit's counts.
- The browser's carry-over emits how much it carried, as counts, and reports a store it could not
  read.

## §12 What retires

- The backend's rooms, the roadmap socket, presence, the lattice and its JSON, the op log's
  land-sequence columns and the routes for a roadmap's whole document.
- The web's roadmap sync and its stores.
- [Graph sync](../GRAPH_SYNC_DESIGN.md), and the parts of
  [the roadmap tree engine](../../backend/SPEC.md) and the web's roadmap architecture that describe
  them, rewritten in the change that removes each.
- `backend/test/golden`, which gates nothing.

## §13 Values

| Name | Value | Whose |
|---|---|---|
| Caps and bounds | as §3 states them, which are today's | the registry's |
| `IMPORT_CHUNK` | 500 records an intent | the domain's |
| Hold on a delete | 9 s, as today | the product's |

## §14 Gaps this build closes

- No vector holds roadmap's rules across two languages; the server and the web each test their own.
- A signed-in roadmap opens from the server and falls back to the device's copy only when that
  fails.
- The web adopts signed-out roadmaps without asking and wipes unsent work at sign-out without
  warning, both against canon.
- The server and the browser break a tie between two marks differently.
- A step's workspace lives in one browser.
- The engine's tree and overlay scopes have run only against its test product: production's build
  refuses any composition but gym and journal, and the domain kit lets an entity live only in a
  product scope.
- Roadmap's MCP write tools take no `requestId`.

## §15 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | Roadmap's sync | Roadmap moves onto the shared sync engine, on the web and the backend, and the iPhone's room is built on it. This replaces the iPhone design's ruling of a Swift client for roadmap's own sync. (2026-11-17) |
| R-2 | A change that meets a change made elsewhere | It is never refused, on any surface: an edit brings a deleted step back, and a new step re-links past a deleted one. Limits are checked on the device before a change is made. (2026-11-17) |
| R-3 | A step's workspace | It syncs across a person's devices as private records. (2026-11-17) |
| R-4 | Nested roadmaps and guides on the iPhone | Full parity with the web in the first version. (2026-11-17) |
| R-5 | How the data moves | One planned cutover with a short maintenance window and a verified backup. What browsers hold is carried over at their next load. (2026-11-17) |
| R-6 | Presence and remote cursors | They end with the move. (2026-11-17) |
