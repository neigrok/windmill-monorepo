# Roadmap's adoption onto the sync engine

The move of production's roadmaps from roadmap's own tables (`trees`, `tree_nodes`, `tree_edges`, `tree_kinds`,
`node_progress`) into the engine's (`sync_scopes` and the `roadmap_*` tables), and its audit
([Roadmap on the sync engine](../../../../docs/foundation/roadmap-on-the-engine.md) §8.1, §11). The cutover runs it in its
maintenance window with `windmill_roadmap_adopt` (`platform/infra/roadmap_adopt.cpp`), one stage at a time or `all` in
order. It never touches `tree_ops`, `tree_og_images` or `tree_og_videos`: the activity and the share cards stay keyed by
the roadmaps' ids, which do not change.

- `Adoption` is the move's domain: roadmap's rows as the move reads them, §8.1's rules, the `Survey` that decides each
  roadmap's owner, place, standing and reach and what stops the move, and the `Plan` of every scope it writes.
- `Audit` is the audit's document: one a roadmap, built from roadmap's tables (`documentsBefore`) and from the engine's
  records through the binding and the read domain (`documentsAfter`), and the parts in which two differ.
- `PgAdoption` reads roadmap's tables whole, writes one owner's plan in one transaction through the binding's stores,
  reads the engine back, and sums every scope's digest.
- `ReadModels` asks one server's read models the audit's questions — MCP's reads, the progress and activity routes, the
  share page, the gallery and reminders' readiness — through the code the routes and tools answer with, and compares
  two servers' answers.
- `Cutover` runs the stages.

## Stages

Each stage prints one JSON line on stdout — `{"stage", "verdict", "ms", "counts"}` — and logs one write line on stderr
(`roadmap.adoption.<stage>`, door `tool`, the verdict as its outcome). Neither names a roadmap, a step, an account or a
text: the counts' names are the code's words. Everything finer goes to the private record, the directory
`ROADMAP_ADOPTION_PRIVATE_DIR` names, one JSON value a line, files readable by their owner alone, meant to be encrypted
before they leave the machine; without it nothing finer is kept, and the two read-model stages cannot run. The tool exits
0 when every stage it ran passed, 3 at the first that did not (the run stops there), 2 without its configuration and 1
on a failure, which it reports to Sentry by the failure's type alone.

| Stage | What it does | Verdicts | Private record |
|---|---|---|---|
| `unfold` | The old server (`RoomRegistry`) opens every roadmap and closes it, writing what it writes on opening one: a roadmap stored only as a whole document unfolded into rows, a head behind its activity taken past it. | `unfolded` | — |
| `read-models-before` | The old server's read models answer the audit's questions. | `asked`; `noPrivateRecord` fails | `read-models-before.jsonl` |
| `before` | Reads every roadmap, writes the old server's reading of each as a document, counts what the move would do, and says whether anything stops it. Writes nothing. | `ready`; `stops` fails | `before.jsonl`, `stops.jsonl` (each stop with its roadmap) |
| `adopt` | Adopts every owner's roadmaps that hold no `tree` record yet, one owner a transaction under an advisory lock, after inserting the house account when absent. Nothing is written while anything stops the move. | `adopted`, `unchanged` (a second run); `stops` fails | — |
| `demo` | Adopts the public demo from the rows `db/schema.sql` seeds, under the house account, where the engine holds no record of it; one it holds is never written again. | `present`, `seeded`; `noSource` and `stops` fail | — |
| `after` | Reads every adopted roadmap back through the binding and the read domain and compares its document with the old server's; checks each deleted roadmap's id is spent. | `same`; `differs` fails | `after.jsonl`, `differences.jsonl` |
| `read-models` | The new read models answer the same questions; compares them with `read-models-before`'s. | `same`; `differs` and `nothingAskedBefore` fail | `read-models.jsonl` (the differing answers) |
| `digests` | Sums every alive scope the catalog binds from its rows (engine.md §6.12) against the digest its row holds, and checks its seq stands at or past every row's. | `summed`; `differs` fails | `digests.jsonl` (the scopes that differ) |

Configuration: `DATABASE_URL`; `ROADMAP_ADOPTION_PRIVATE_DIR`; `ROADMAP_ADOPTION_EXPECTED_OWNERLESS`, a file of the
ownerless roadmaps the move adopts under the house account, one id a line, which the public demo (`t_9e407a96b5330ebe`)
joins always; and the tools' `SENTRY_DSN` and `SENTRY_ENVIRONMENT`.

A run cut short is run again from its first stage: `unfold` and the read stages change nothing the second time, and
`adopt` takes up at the first owner it had not committed. A stage killed mid-transaction commits nothing of it.

## The rules as the move applies them

- **Envelope.** Each owner's `acct:<A>/roadmap` holds a `tree` record for each of their roadmaps, born and alive at the
  lowest server stamp `0:0:srv`, its place in `parent` for a subtree; `rc` and `ru` are `trees.created_at` and
  `updated_at`. Each roadmap's `tree:<T>` holds its `meta`, steps, links and kinds; each account's `acct:<A>/overlay/<T>`
  its marks, and the owner's its pointers. Rows are numbered in the registry's type order, then by id; the scope's seq is
  the last, its digest the sum over its alive rows, its counters the alive count of each capped type, and a tree's
  `open` whether its reach opens it. Each scope is new: the move creates no row in a scope it did not create, and adds
  each owner's records at the next seqs of their roadmap scope.
- **Stamps.** A stamp that parses as D-1 is kept, unless it lies more than `MAX_SKEW_MS` past the move's start, which
  the engine would never have stored (INV-14). `''` and `0:0:` are unset. Every other stamp, and a future one, takes the
  lowest server stamp. An unset register that holds its field's default stays unset; one that holds another value — the
  title every roadmap was created with, under no stamp — takes the lowest server stamp, as a root's `visibility` and a
  true `guideInherited`, which roadmap holds under none, do. The registers the move computes (`reach`, `root`,
  `parent`, `depth`, `forkedFrom`, `branch`) take it too.
- **Life.** A step, link or kind is alive when its add stamp is set and not older than its remove stamp, dead when the
  remove stamp is newer, its life at the greater; born at its add stamp, or the lowest server stamp when only its
  remove stamp is set. A row with neither is not adopted.
- **Sequence.** Each tree scope's rows are numbered above the greater of `trees.head_seq` and its last `tree_ops.seq`.
- **Times.** A step's, link's and kind's `rc` is its add stamp's time and `ru` its newest stamp's, each kept between the
  roadmap's `created_at` and `updated_at`, so no record reads as changed after the roadmap did; a mark's are the time the
  server recorded it; a pointer's its stamp's.
- **Order.** Steps keep a key that is one (D-25); an empty or malformed one becomes a key in its place in today's order,
  `(ord, created, id)` with an empty key first, over the whole roadmap, which keeps every trunk parent's order. Kinds take
  `a0`, `a1`, … by `(rank, id)`, under their rank's stamp when it is kept and the lowest server stamp otherwise.
- **Values.** As the old server reads them: a colour or hue it does not know is terracotta, a status `active` or
  `inProgress` is `none`, a link is its lenient reading of it (`linksFromJson`), a mark of `complete` keeps its
  out-of-order word. A step status, or a mark's, outside `none`, `complete`, `active` and `inProgress` stops the move.
- **Pointers and subtrees.** A step's `opens` becomes a `pointer` alive at its stamp in the owner's overlay; a cleared one
  becomes none. A subtree's place becomes `tree.parent`, `meta.root`, `meta.parent`, `meta.depth` and its owning step's
  `branch`; `reach` is the root's visibility while every owning step on its way down is present, `private` otherwise.
- **Marks** move to their owners' overlays, each a row of its own, a mark of `none` included.
- **Whole documents** are unfolded first by the old server (`unfold`); one it cannot read is unfolded by the move, with
  each stamp's text kept for the rules above.
- **Not adopted, each counted:** a mark whose owner is no account; a link from a step to itself, or to or from an id no
  adopted step holds; a step, link or kind with neither stamp; and the rows of a deleted roadmap — one whose row, or a row
  above it, is deleted — whose `tree` record is adopted dead, so its id is spent, and its tree scope dead since then.
- **Owners.** A roadmap's owner is its root's; an owner that is no account counts as none. A roadmap with no owner goes to
  the house account when it is expected, and stops the move otherwise.
- **What else stops the move:** a roadmap id outside `^t_[0-9a-f]{16}$`; a step, kind or marked step id outside 1–128
  code points; a subtree whose parent no row holds, whose way up meets itself, whose root, depth or owner does not follow
  from its parent's, which sits past depth 8, or whose owning step no row holds; a visibility outside the three; a whole
  document whose shape the old server's reading refuses.
- **The house account** (`kHouseAccount`, `products/roadmap/domain/Access.h`) has an address that takes no mail, so
  nobody signs in as it. The gallery lists none of its roadmaps, as it listed no ownerless one.

## The audit

The document holds what a person and a reader see of a roadmap — its owner, title, guide, place, steps with their
fields and life, links, kinds, every account's marks with when the server received them, its visibility, who may read
it and whether it stands — and never a stamp or an order key, which the move may give: the order is the documents'
order of steps and kinds. The read models' answers leave out what changes by design (`ReadModels.h`). A roadmap holding a
stamp the old server cannot parse is unreadable today: the old server throws on it (`roadmapStamp`), so its questions are
counted apart, as `unreadableToday`.

## Tests

`test/platform/infra/roadmap_adopt_test.py` (ctest `roadmap_adopt`) runs the tool under `WM_PG_TEST` on databases of its
own built from `db/schema.sql` and `roadmap_adopt_fixture.sql`, one §8.1 case a row: every stage's counts, a second run,
a run killed between stages and in the middle of `adopt`, the rows that stop the move, and that nothing printed names a
record. `test/products/roadmap/adoption/AdoptionTest.cpp` holds the rules (`windmill_domain_tests`), and reads a plan's
rows back through `recordsOf` and the read domain over fakes. `test/e2e/roadmap_adoption.mjs` serves an adopted fixture
with `ROADMAP_ENGINE_ENABLED=1` and reads it back through the browser engine (`test/e2e/README.md`).
