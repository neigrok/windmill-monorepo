# Roadmap's adoption onto the sync engine

The move of production's roadmaps from roadmap's own tables (`trees`, `tree_nodes`, `tree_edges`, `tree_kinds`,
`node_progress`) into the engine's (`sync_scopes` and the `roadmap_*` tables), and its audit
([Roadmap on the sync engine](../../../../docs/foundation/roadmap-on-the-engine.md) §8.1, §11). The cutover runs it in its
maintenance window with `windmill_roadmap_adopt` (`platform/infra/roadmap_adopt.cpp`), one stage at a time or `all` in
order. It never touches `tree_ops`, `tree_og_images` or `tree_og_videos`: the activity and the share cards stay keyed by
the roadmaps' ids, which do not change.

- `Adoption` is the move's domain: roadmap's rows as the move reads them, §8.1's rules, the `Survey` that decides each
  roadmap's owner, place, standing and reach and what stops the move, and the `Plan` of every scope it writes.
- `Audit` is the audit's document: one a roadmap, built from the old server's own reading of it — its repositories
  (`PgTreeRepository`, `PgProgressRepository`) and its graph's element sets, never the move's rules (`documentsBefore`) —
  and from the engine's records through the binding and the read domain (`documentsAfter`), and the parts in which two
  differ.
- `PgAdoption` reads roadmap's tables whole, writes one owner's plan in one transaction through the binding's stores,
  reads the engine back, and sums every scope's digest.
- `ReadModels` asks one server's read models the audit's questions — MCP's reads, the progress and activity routes, the
  share page, the gallery and reminders' readiness — through the code the routes and tools answer with, and compares
  two servers' answers.
- `Cutover` runs the stages.

## Stages

The server is stopped for the move, the cutover's maintenance, and nothing else writes roadmap's tables while it runs.
The tool checks it: every session it opens carries one random application name, and a stage refuses to start while
any other client session is connected to the database (verdict `othersConnected`, the count alone). `adopt` holds
roadmap's own tables in SHARE mode in each owner's transaction, reads that owner's rows again and stops if they differ
from those its plan was made from.

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
| `adopt` | Adopts every owner's roadmaps that hold no `tree` record yet, one owner a transaction under an advisory lock, after inserting the house account when absent. Nothing is written while anything stops the move. An owner whose transaction stops or fails is written not at all; the stage prints its counts so far with the reason's static code. | `adopted`, `unchanged` (a second run); `stops` fails; `failed` exits 1 | `adopt-failure.jsonl` (owner, roadmap, reason) |
| `demo` | Adopts the public demo from the rows `db/schema.sql` seeds, under the house account, where the engine holds no record of it; one it holds is never written again. | `present`, `seeded`; `noSource` and `stops` fail | — |
| `after` | Reads every adopted roadmap back through the binding and the read domain and compares its document with the old server's; checks each deleted roadmap's id is spent. | `same`; `differs` fails | `after.jsonl`, `differences.jsonl` |
| `read-models` | The new read models answer the same questions; compares them with `read-models-before`'s. | `same`; `differs` and `nothingAskedBefore` fail | `read-models.jsonl` (the differing answers) |
| `digests` | Sums every alive scope the catalog binds from its rows (engine.md §6.12) against the digest its row holds, and checks its seq stands at or past every row's. | `summed`; `differs` fails | `digests.jsonl` (the scopes that differ) |

Configuration: `DATABASE_URL`; `ROADMAP_ADOPTION_PRIVATE_DIR`; `ROADMAP_ADOPTION_EXPECTED_OWNERLESS`, a file of the
ownerless roadmaps the move adopts under the house account, one id a line, which the public demo (`t_9e407a96b5330ebe`)
joins always; and the tools' `SENTRY_DSN` and `SENTRY_ENVIRONMENT`.

A run cut short is run again from its first stage: `unfold` and the read stages change nothing the second time, and
`adopt` takes up at the first owner it had not committed. A stage killed mid-transaction commits nothing of it.

## How the rules land in the engine's tables

The rules are [§8.1](../../../../docs/foundation/roadmap-on-the-engine.md)'s; these are the facts of the envelope it does not
state.

- Each owner's `acct:<A>/roadmap` holds a `tree` record for each of their roadmaps, its place in `parent` for a subtree;
  `rc` and `ru` are `trees.created_at` and `updated_at`. Each roadmap's `tree:<T>` holds its `meta`, steps, links and kinds;
  each account's `acct:<A>/overlay/<T>` its marks, and the owner's its pointers.
- Rows are numbered in the registry's type order, then by id; the scope's seq is the last, its digest the sum over its
  alive rows, its counters the alive count of each capped type, and a tree's `open` whether its reach opens it. Every tree
  and overlay scope is new; each owner's records take the next seqs of their roadmap scope.
- The house account (`kHouseAccount`, `products/roadmap/domain/Access.h`) has an address that takes no mail, so nobody
  signs in as it. The gallery lists none of its roadmaps, as it listed no ownerless one.

## The audit

The document holds what a person and a reader see of a roadmap — its owner, title, guide, place, steps with their
fields and life, links, kinds, every account's marks with when the server received them, its visibility, who may read
it and whether it stands — and never a stamp or an order key, which the move may give: the order is the documents'
order of steps and kinds. The read models' answers leave out what §8.1 names as changed by design (`ReadModels.h`). A
roadmap the old server cannot read today, which throws on its stamps (`roadmapStamp`), has no document; it and its
answers are counted as `unreadableToday`.

## Tests

`test/platform/infra/roadmap_adopt_test.py` (ctest `roadmap_adopt`) runs the tool under `WM_PG_TEST` on databases of its
own built from `db/schema.sql` and `roadmap_adopt_fixture.sql`, one §8.1 case a row: every stage's counts, a second run,
a run killed between stages and in the middle of `adopt`, the rows that stop the move, and that nothing printed names a
record. `test/products/roadmap/adoption/AdoptionTest.cpp` holds the rules (`windmill_domain_tests`), and reads a plan's
rows back through `recordsOf` and the read domain over fakes. `test/e2e/roadmap_adoption.mjs` serves an adopted fixture
with `ROADMAP_ENGINE_ENABLED=1` and reads it back through the browser engine (`test/e2e/README.md`).
