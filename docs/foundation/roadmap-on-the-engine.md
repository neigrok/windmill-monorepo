# Roadmap on the sync engine

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
definitions (`D-n`), invariants (`INV-n`), engine changes (`E-n`) and rulings (`R-n`) are numbered
so reviews, code and roadmap nodes can cite them.

## §0 Status and scope

**Status:** Approved by the owner on 2026-11-17. Engine prerequisites are under development in
[draft PR #290](https://github.com/neigrok/windmill-monorepo/pull/290), kept unmerged for review.
Roadmap syncs through a sync of its own:
a lattice and a socket described in [graph sync](../GRAPH_SYNC_DESIGN.md) and
[the roadmap tree engine](../../backend/SPEC.md), on the web only. The [sync engine](engine.md)
serves gym and journal, and its tree and overlay scopes have run only against its test product. The
build order lives in the Roadmap on the engine roadmap tree, which the dogfood tree
(`t_9362d9bc883e0a1e`) opens from the node `roadmap-on-the-engine`.

**Scope:** Roadmap's move onto the sync engine and the [domain kit](domain-kit.md): the registry,
the rules every surface shares, what the engine and the kit must gain first, the server's side, the
move of production's roadmaps, the web's move, and what retires.

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
  (§10). Where the server derives the same thing, the same vectors hold it.
- **P-4 A person's change is never refused for what happened elsewhere.** A change made without
  knowing of another device's change lands. An odd result is the accepted price. (R-2)
- **P-5 The backend is called only for what is the server's by nature:** an account, a link a
  stranger opens, a model call, a mail it sends, a copy made of another person's roadmap, and what
  an outside assistant writes.
- **P-6 Nothing a person made is lost in the move.** Every roadmap, mark and workspace, and every
  change a browser holds unsent, arrives in the engine. (R-5)

## §2 Vocabulary

*Scope*, *record*, *intent*, *gesture*, *hold*, *notice*, *command* and *replica* mean what the
[sync engine](engine.md) §1 defines; *entity*, *action*, *rule* and *draft* what the
[domain kit](domain-kit.md) defines. *Step* is the product's word for a `node` record, and *link*
for an `edge` record.

- **D-1 Root, subtree, branch.** A *subtree* is a roadmap a step owns. A *root* is a roadmap no
  step owns. A root's *branch* is the root and every subtree under it.
- **D-2 Pointer.** A step's reference to another roadmap of the same owner, which the step *opens*.
- **D-3 Standing.** A subtree stands while its root stands and every step that owns a roadmap on
  its path is present.
- **D-4 Present, absent.** A step is present while its record is alive and absent otherwise.
- **D-5 Followed.** What a step comes after, as it is read (§5): its links from present steps, and,
  through each absent step it links from, what that step followed.

## §3 What the engine and the kit gain first

Roadmap needs of the engine what gym and journal never did. Each is a change to the engine's own
document, its four implementations and its corpus, made before the registry is bound.

- **E-1 A write into another scope of the same owner.** A type's check, a command and a
  consequence MAY write records of another live scope that the intent's owner owns. Admission locks
  those scopes after the intent's own, in key order, and each takes its own sequence number, digest
  and frames. Every admission door holds the owner's admission gate through publication.
- **E-2 Ids that are not ASCII.** A type MAY declare its ids by a domain, valid UTF-8 without NUL
  up to a stated number of code points, in place of a pattern. Every key built from such an id
  takes the domain with it.
- **E-3 A reader's own overlay.** Subscribing a tree a bound replica can read also subscribes that
  account's overlay of it, so a reader's own marks stay in view once the server has them.
- **E-4 The server's door in a tree.** A server-origin intent MAY be built in a tree scope and an
  overlay scope, reading the scope under its lock, as it can in a product scope today.
- **E-5 A replica held in memory.** A device MAY run a replica it does not keep, for a reader whose
  browser keeps nothing ([the web as a device](web-device-parity.md) §7).
- **E-6 The composition.** The server's build, both schema generators, the three model servers and
  the deploy's version check take a third registry, and Android's client leaves roadmap's scopes
  alone.
- **E-7 Predictions and receipts across scopes.** A command MAY predict records in every scope it
  changes. Each prediction remains only until its own scope covers the command's accepted sequence.
  An opted-in command returns the accepted versions of its changed slots and the before/after scope
  and row sequences, without values. These receipts support conditional Undo and survive retries
  unchanged; they describe the caller's own effects, never another reader's private overlay.
- **E-8 Typed references inside values.** A registry MAY declare literal object paths to record
  identities and the scope each names. Dependency tracking and ID remapping use those declarations,
  so a queued descendant's `parent.tree` follows a redirected subtree ID and a command's `step`
  names a node in its declared tree. Unannotated JSON and text stay untouched; references do not
  grant access or authorize effects in another scope.

And of the domain kit:

- **K-1 Entities outside a product scope.** An entity MAY live in a tree scope or an overlay
  scope, taking its scope from the action that writes it.
- **K-2 A gesture over several scopes.** A plan MAY write more than one scope. The runner commits
  one intent a scope, in a stated order, as one act of the person's: one hold and one Undo cover
  all of them.
- **K-3 Undo of an act.** Except for a released roadmap deletion, the kit offers an action that
  writes back each field's earlier value under a new stamp, leaves alone a field written since,
  and says whether anything was taken back (§5).

## §4 The registry

Product `roadmap`, surfaces web and iOS, primary type `tree`. `chars` and `bytes` are the engine's
units (D-9).

| Type | Scope | Identity | Life | Fields | Cap |
|---|---|---|---|---|---|
| `tree` | self/roadmap | minted global `^t_[0-9a-f]{16}$`, governs `tree:<id>` | terminal, keep | `parent` const server `{tree, step}`, null for a root | — |
| `meta` | tree/T | singleton | — | `title` lww ≤200 chars; `guide` lww ≤5,000 chars; `guideInherited` server; `visibility` lww server ∈ {private, unlisted, public}; `visibilitySetBy` lww server; `reach` lww server ∈ {private, unlisted, public}, which `opens` at {unlisted, public}; `root` const server `ref<tree>`; `parent` const server `{tree, step}`, null for a root; `depth` const server; `forkedFrom` const server | — |
| `node` | tree/T | derived, ids by domain (E-2) ≤128 chars, fallback `step` | revivable, keep | lww: `label` ≤200 chars, `icon` ≤64 chars, `color`, `ord`, `status`, `description` ≤16,000 chars, `links` (at most 32 of {url ≤2,048 chars, label ≤200 chars}); `branch` lww server nullable `ref<tree>` | 10,000 |
| `edge` | tree/T | keyed `[from, to]` (`ref<node>` each) | yes, keep | — | 20,000 |
| `kind` | tree/T | derived, ids by domain ≤128 chars, fallback `kind`; genesis `build`, `learn`, `milestone` | revivable, keep | lww: `hue`, `label` ≤24 chars, `description` ≤80 chars, `ord` | 6 |
| `progress` | self/overlay/T | keyed (`ref<node>`) | none | `mark` lww `{status: complete\|none, outOfOrder: bool}` | — |
| `pointer` | self/overlay/T | keyed (`ref<node>`) | yes, keep | `opens` lww `ref<tree>` | — |
| `subtask` | self/overlay/T | minted | yes | `step` const `ref<node>`; lww: `label` ≤200 chars, `done`, `ord` | 20,000 |
| `stepLink` | self/overlay/T | minted | yes | `step` const `ref<node>`; lww: `url` ≤2,048 chars, `title` ≤200 chars, `ord` | 20,000 |
| `stepNote` | self/overlay/T | keyed (`ref<node>`) | none | `text` text ≤16,000 chars | — |

Roadmap Coach's records join this registry as [Roadmap Coach](roadmap-coach.md) §9 lists them.

- **Ids.** A step or kind that exists keeps its id, so no address changes. A device mints a new
  step's or kind's id at random, so two devices that add the same title with no connection never
  collide. The server derives an id from a label (D-26) only for what it builds itself.
- **Order.** `ord` is a fractional key. The product compares it among the steps of one trunk
  parent, and among a roadmap's kinds, and places a moved step by the sibling above it.
- **A pointer and the workspace are the owner's.** `pointer`, `subtask`, `stepLink` and `stepNote`
  are admitted only in the overlay of the roadmap's owner. A reader therefore never receives a
  pointer, and has no workspace; a reader's overlay holds their marks alone. (R-3)
- **A subtree is said in the roadmap that holds its step:** `node.branch` names it, so a reader can
  go in. Its `meta` says where it sits, so a reader can come back: `root`, `parent` and `depth`. A
  subtree's name is its owning step's label; its own `title` is not read.
- **`reach` decides who may read.** It is the root's `visibility` while the subtree stands (D-3),
  and `private` otherwise. A root's `reach` is its `visibility`.
- **A kind's hue** is checked where a kind is made or changed. Where two present kinds still wear
  one hue, because two devices chose it at once, the one born first is that hue's kind, and
  diagnostics report the other.
- `guideInherited` is cleared by the server when the owner writes the guide.
- The list of a person's roadmaps is their own `tree` records. A.1's `track` is not built.
- The registry joins the composition beside gym's and journal's, and the composition's version
  rises. Nothing a gym or journal client relies on changes, so the minimum version does not.

**Commands**

- `roadmap.setVisibility {visibility, stamp}` in a root's `tree/<T>`, by the owner. It writes the
  root's `visibility`, `visibilitySetBy` and `reach`, and the `reach` of every standing subtree of
  the branch (E-1). A replay, whose `stamp` is `visibilitySetBy`, and a call whose `stamp` is older
  than it, answer ok and write nothing.
- `roadmap.createSubtree {tree, root, step, subtree}` in `self/roadmap`. It creates the `tree`
  record with its `parent`, the subtree's `meta`, and writes `node.branch` (E-1). A retry answers
  the subtree the step already owns. It refuses a step that is gone, a step that opens a roadmap,
  and a depth past `MAX_DEPTH`. A device predicts it, so a subtree is made with no connection.
- `roadmap.recolourKind {kind, hue}` in `tree/<T>`. It writes the kind's hue and the colour of
  every step that wears it, present or not, and revives none.

**Consequences** (E-1)

- A step's death that ends a subtree's standing writes `reach` `private` on every subtree under it,
  and the step's revival writes it back.
- A root's death kills its subtrees, and deletes each step of the owner's other roadmaps whose
  pointer opened it.

## §5 Gestures and reading

Every gesture is an action on the domain kit, the same in each language.

- **Create a roadmap** commits the `tree` record, then one intent in its tree scope with the title,
  the genesis kinds and the first steps. The second is dropped if the first is refused.
- **Create a step** writes the step and one link from each prerequisite, in one intent.
- **Any change to a step or a kind** carries the record's life as alive, under the gesture's stamp,
  so it is admitted whether or not the record was deleted elsewhere. Where the record is still dead
  once it has joined, the server revives it. So a step a person changed is present, whichever of
  the change and the delete was made first. (P-4)
- **Delete a step** is held, and writes the step's death and nothing else. Its links stay, unread
  while it is absent, and return with it. Undo, before release or after, is the step's revival.
- **What a step follows is read through absent steps** (D-5). So a step that followed a deleted
  step follows what that step followed, with nothing written, on every device and on the server
  alike. Removing a followed link that is read through an absent step retires the link from that
  step.
- **Delete a roadmap** is held, and writes the `tree` record's death. The server does the rest
  (§4). Undo cancels it only during its 9-second hold; after the hold ends the deletion is permanent.
- **Complete and Reset** write the step's `progress` mark. A step that opens a roadmap or owns a
  subtree is complete exactly when that roadmap is, and takes no mark. That is a rule of reading:
  a mark on such a step is kept and not read.
- **Import and paste** commit intents of at most `IMPORT_CHUNK` records and half the engine's push
  limit each, prerequisites before what follows them. One Undo takes back every chunk.
- **Limits are checked where the gesture is made:** the caps and bounds of §4, a cycle among what
  steps follow, a hue another kind wears. A gesture that would break one is refused there, before
  anything is written. The server refuses none of the three for structure: a loop two devices
  close between them lands, is read without harm, and is reported by diagnostics, as today.
- **Undo** of an act is the kit's (K-3). A surface keeps its own stack of acts for its keyboard's
  Undo and Redo. A roadmap deletion leaves that stack when its hold ends and cannot be restored.
- **Undo creating a subtree** conditionally clears its step's `branch` and deletes the created
  subtree together, only while both the connection and subtree contents remain unchanged since
  creation. Otherwise it changes neither. Redo creates a new subtree under a fresh id and
  conditionally reconnects it; it never revives the deleted subtree. (R-8)
- **Hidden.** A subtree that does not stand is hidden on every device, the owner's included: it is
  in no list, no count and no address.
- **A reader** subscribes a readable roadmap when a person opens its link, signed in or not, and a
  subtree as the person goes in, and drops both on leaving. A signed-in reader's marks are their
  own overlay (E-3). A reader whose browser keeps nothing reads into a replica held in memory
  (E-5).
- **Dates.** The date a completion shows is the time the server received the mark. A mark the
  server has not received shows the device's time.
- **Signed out**, a roadmap a person makes lives in the device's `anon` replica. At sign-in the
  engine's lineage rule decides: added without asking to an account that holds no roadmaps, and
  otherwise by the person's Add or Discard. At sign-out it asks Keep or Discard for what is unsent.
  The silent adoption and the silent wipe the web does today both end.

Other gestures are one intent per record.

## §6 Landing

What a device tells a person when a change of theirs met one made elsewhere.

- **A step that follows something else than the person linked.** When a device's own new step or
  new link turns out to follow through an absent step, the person is told once, where the step is
  listed and on its page. The device notes its own new steps and links in a device row when it
  makes them and clears the note once it has said so.
- **A step that came back.** When a device's change revived a step, the person is told once.
- **What still cannot land:** a change to a roadmap deleted on another device; one that would pass
  a cap another device filled first; one made after write access ended; a note whose two versions,
  merged, pass its bound. The engine keeps each as a notice with its content. The product lists
  them in one place with the reason, and the person may copy what they hold or discard them.
  Nothing else is ever shown as refused. (R-2)

- **INV-1.** No gesture of a person's on a step is refused because the step, or a step it links,
  was deleted on another device.
- **INV-2.** What a step follows is a pure function of the records, the same on every device and
  on the server.
- **INV-3.** No screen offers Retry or Discard for a change, except in the one list §6 names.

## §7 The server

- **The binding.** `backend/products/roadmap/sync/` binds the registry's types, commands and
  consequences to roadmap's tables, with the bounds and caps of §4.
- **The door.** Every server write for a person goes through one door that admits server-origin
  intents (E-4): MCP's write tools, tending until [Roadmap Coach](roadmap-coach.md) retires it, the
  fork of a roadmap, and the fork at sign-up. Each MCP write tool takes an optional `requestId`, so
  a retried call writes once.
- **MCP keeps its meanings.** `delete_node` deletes a step, with `prune`, the `branches` it must
  confirm and the caller's own marks cleared, as today. `import_subgraph` and `change_edges` land a
  loop and name it in their answer, as today. `expectedSeq` is the tree scope's sequence number,
  which continues from the roadmap's present one (§8.1). Reads derive what a step follows by D-5.
- **Fork is the server's.** It copies the branch of a readable roadmap into the caller's account
  under new ids and new stamps, so a step's created time is when it joined the copy. `status` is
  cleared, the guide is marked inherited when it was another person's, and pointers are copied only
  into the owner's own fork. A device forks with a connection and receives the copy by sync.
- **The activity feed** keeps `tree_ops`. The binding writes one row for each gesture that leaves a
  deed, with who made it. Until now it was one row a frame.
- **Other read models** are fed from the typed tables: the gallery and the share page; the owner's
  progress shown to readers, which also answers what each subtree has come to; reminders'
  readiness. None answers admission.
- **Account emptiness and erasure** count and remove roadmap's new tables with its old ones.
- **The public demo** is owned by a house account, seeded in the engine's shape when absent and
  never rewritten by a deploy.
- **Presence and remote cursors end.** (R-6)

**Routes**

| Route | After the move |
|---|---|
| `/v1/sync` | every read of a roadmap's records and every change a device makes |
| `POST /v1/trees/{id}/fork` | stays, through the door |
| `GET /v1/trees/{id}/activity`, `GET /v1/trees/{id}/progress` | stay as reads |
| The share page, the gallery, the cards and their uploads, compose, reminders, tending | stay |
| `GET /v1/trees`, `GET /v1/trees/{id}`, `/guides`, `/diagnostics` | retire: a device computes each from its copy |
| `POST /v1/trees`, `PATCH /v1/trees/{id}`, `DELETE /v1/trees/{id}`, `PUT …/subtree` | answer `410` (§8.3); MCP reaches the same acts through the door |
| `/v1/socket` | refuses every connection (§8.3) |

## §8 The move

### §8.1 Production's roadmaps

The data moves in one planned cutover, rehearsed against a copy of production, with the site in
maintenance for its length and a verified backup to return to. (R-5)

- Roadmap's tables take the engine's envelope: scope, `seq`, `rc`, `ru`, `born`, life and a stamp
  for each field.
- **Stamps.** A stamp roadmap holds is kept where it is a stamp as the engine writes one. An unset
  register stays unset. A register that holds a value under a malformed stamp takes the lowest
  server stamp, so nothing made later loses to it.
- **Life.** A step, link or kind is alive when its add stamp is set and not older than its remove
  stamp, and dead when the remove stamp is the newer; its life's stamp is the greater of the two. A
  row with neither set is not adopted.
- **Sequence.** Each tree scope's `seq` continues above the roadmap's present head, so the activity
  feed's cursor, tending's runs and MCP's `expectedSeq` stay in order. `tree_ops` is kept as it is.
- **Times.** A mark's `rc` and `ru` are its recorded time. A step's, link's and kind's `rc` is its
  add stamp's time, and `ru` its newest stamp's, neither later than the roadmap's own.
- An empty `ord` becomes a key that keeps today's order, and a kind's `rank` becomes an `ord`.
- A pointer moves from its step to a `pointer` record in its owner's overlay. A subtree's place
  becomes `tree.parent`, `meta.root`, `meta.parent`, `meta.depth` and `node.branch`, and every
  `reach` is computed.
- A roadmap stored only as a whole document is unfolded into rows first.
- Marks move to their owners' overlays.
- **What is not adopted,** each counted by the audit: a mark whose owner is no account; a link to
  or from an id no step row holds, and a link from a step to itself; the rows of a deleted roadmap,
  whose id becomes spent. A roadmap with no owner goes to the house account, and the move stops on
  any other it was not told to expect.
- **The audit.** Before the move, the old server writes one document a roadmap: title, guide,
  place, steps with fields and life, links, kinds, every account's marks with their times,
  visibility, and who may read each subtree. After it, the new server's tables must give the same
  document, and the MCP read tools, the owner's progress, the share page, the gallery, reminders'
  readiness and the tail of the activity feed must answer as before. Every scope's digest sums, and
  a second run changes nothing. What browsers hold is not proven by it.
- A failure before writes resume restores the backup. After that the move goes forward only.

### §8.2 What a browser holds

The new bundle carries over what the old one kept. It runs under a browser lock, on every load
while an old store still holds anything, and writes a ledger of what it carried: each old entry and
the outbox entry or notice it became.

- **A roadmap made signed out.** The browser first asks the server whether the id exists. An id the
  server does not hold becomes a creation in the `anon` replica. One the server holds as the
  person's own, a claim cut short, is carried as unsent changes to it. One that is another
  account's or spent is carried under a new id, with the device's pointers moved to it.
- **Changes a signed-in browser had not sent** are committed to the bound replica as new gestures,
  after its first pull. They take the time of the carry-over, so one made days ago with no
  connection counts as made now.
- **Marks** a device roadmap holds, and marks left undrained from before roadmap's present sync,
  are carried as marks; a step a claim would have marked from its seed is marked.
- **Workspaces** become `subtask`, `stepLink` and `stepNote` records, in the account the device's
  index names for the roadmap, or the `anon` replica's. Each carried item's id is derived from the
  old one's, so carrying twice writes nothing twice. A workspace of a roadmap the person does not
  own is not carried.
- An old store is deleted once the ledger shows every entry of it durable in the replica's outbox.
  The stores that are not sync's stay: the last place, the view, the legend and the ledgers.

- **INV-4.** A browser deletes no old store while the ledger lacks an entry of it.

### §8.3 Old bundles

- A release before the cutover teaches the roadmap room what a retired build is told, and to save
  what it holds and reload when it is. It ships long enough before the cutover for open tabs to
  take it.
- After the cutover, `/v1/socket` answers the upgrade `410` `client-update-required`, and so do the
  write routes of §7's table, before authentication or parsing.
- A tab older than that release stays offline and keeps what it writes in the old store, which the
  next load of the new bundle carries over (§8.2).

### §8.4 The web

- The roadmap room reads through views of the replica and writes through the domain's actions. The
  Graph, the Board, the step page, the layout and the scene keep their own code.
- A roadmap opens from the device's copy; the network is not waited on. The line that says Saving,
  Saved and Offline stays, read from the engine.
- Export reads the replica.
- `web/src/products/roadmap/sync/`, the stores under `persistence/` that exist for it, and their
  tests are deleted.
- The screens that showed a refused change with Retry and Discard, the Restore offer for a hidden
  link, and presence are redrawn or removed on boards the owner approves (§9).

## §9 What a person sees

What changes is built only from boards marked ✅ Ready for dev:

- the quiet line for a step that came back and for one that follows something else;
- the one place that lists what could not land;
- sign-in's Add or Discard and sign-out's Keep or Discard for roadmaps;
- a roadmap's delete held with Undo;
- the activity feed with one line an act;
- the web without presence, and without the refused-change states of flow 43.

## §10 Testing

- **Vectors.** `packages/api-contract/roadmap/domain/` holds the rules, the actions of §5, what a
  device tells by §6, and the reads: what a step follows through absent steps, its state, what it
  owes and unlocks, what an opened roadmap comes to, standing, the guides above a roadmap, the
  Board's groups and order, the legend and a hue two kinds wear, search, sort and filter, and
  diagnostics. JavaScript and Swift run every file, the server runs the reads it shares, and a rule
  lands as a vector first.
- **The engine's corpus** gains E-1 to E-5 on its test product, and roadmap's commands and
  consequences. All four implementations run it.
- **Size.** Before the registry is fixed, the engine is measured on the server and on each client:
  one roadmap of 10,000 steps and 20,000 links; an account of several hundred roadmaps and
  subtrees; and a signed-out roadmap held wholly as unsent entries. For each: first pull, opening
  from the device's copy, one gesture, and sign-in. A budget it misses is fixed in the engine first.
- **The move** runs against a copy of production in rehearsal, with fixtures for an interrupted run
  and a corrupted row, and the audit of §8.1.
- **The browser's carry-over** is tested from stores written by the last bundle before the cutover:
  a claim cut short, two tabs at once, a tab that never reloaded, and a second run.

## §11 Observability

- The server logs one line a write on every door, as it does for gym, and reports unexpected
  failures to Sentry under static names.
- Clients emit an event when a change of theirs landed by §6's rules and when one cannot land, with
  the rule or the refusal's code and no text of the person's.
- The cutover reports each stage, and its audit's counts.
- The browser's carry-over emits how much it carried, as counts, and reports a store it could not
  read.

## §12 What retires

- The backend's rooms, the roadmap socket, presence, the lattice and its JSON, the land-sequence
  columns on roadmap's tables and the routes §7's table retires.
- The web's roadmap sync and its stores.
- [Graph sync](../GRAPH_SYNC_DESIGN.md), and the parts of
  [the roadmap tree engine](../../backend/SPEC.md) and the web's roadmap architecture that describe
  them, rewritten in the change that removes each.
- `backend/test/golden`, which gates nothing.

## §13 Values

| Name | Value | Whose |
|---|---|---|
| Caps and bounds | as §4 states them, which are today's | the registry's |
| `MAX_DEPTH` | 8 subtrees deep, as today | the registry's |
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
- The engine's tree and overlay scopes have run only against its test product, and production's
  build refuses any composition but gym and journal.
- Roadmap's MCP write tools take no `requestId`.

## §15 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | Roadmap's sync | Roadmap moves onto the shared sync engine, on the web and the backend, and the iPhone's room is built on it. This replaces the iPhone design's ruling of a Swift client for roadmap's own sync. (2026-11-17) |
| R-2 | A change that meets a change made elsewhere | It is never refused, on any surface: a changed step comes back, and a step follows past a deleted one. Limits are checked on the device before a change is made. (2026-11-17) |
| R-3 | A step's workspace | It syncs across the owner's devices as private records. (2026-11-17) |
| R-4 | Nested roadmaps and guides on the iPhone | Full parity with the web in the first version. (2026-11-17) |
| R-5 | How the data moves | One planned cutover with a short maintenance window and a verified backup. What browsers hold is carried over at their next load. (2026-11-17) |
| R-6 | Presence and remote cursors | They end with the move. (2026-11-17) |
| R-7 | Undo after a roadmap's delete window | A roadmap deletion is permanent once its 9-second hold ends. Undo is available only during that hold. (2026-11-17) |
| R-8 | Undo creating a subtree | The connection is reversible: `node.branch` is nullable server LWW. Undo clears it and deletes the created subtree together only while the connection and subtree contents remain unchanged. Redo creates a fresh subtree. Approved by the owner on 2026-11-17. |
