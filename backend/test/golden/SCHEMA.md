# Golden-vector corpus

Language-neutral fixtures stating the primitive convergence laws that **every** replica of a
Windmill tree must reproduce bit-for-bit — the C++ lattice (`platform/domain/Crdt.h`,
`platform/domain/Ids.h`, `products/roadmap/domain/Subgraph.h`) and the JS lattice
(`web/src/products/roadmap/sync/lattice.js`, shipped since the graph-sync work).

**These fixtures gate nothing today.** Neither implementation reads them: `run.mjs` checks them
against its own reimplementation of the laws, and no build, test suite or workflow runs `run.mjs`
at all. So the two lattices are free to diverge and this corpus would not notice. It is worth
having as the written-down statement of the laws — it is not, yet, a release gate. The last
section says what it would take to become one.

A stamp is always the canonical text `physicalMs:counter:actor` (see `toString`/`parseHlc`
in `platform/domain/Ids.h`). The unset sentinel is `0:0:`.

## Files

- **`hlc.json`** — the total order on stamps and the unset sentinel.
  - `compare[]`: `{a, b, expect}` where `expect ∈ {lt, eq, gt}` for `a` vs `b`, comparing
    `(physicalMs, counter, actor)` in that order.
  - `sentinel[]`: `{text, isSet}` — whether a stamp carries any information.
  - `codec[]`: `{text}` — must survive `parse → serialize` unchanged.
- **`element-set.json`** — the add-biased life register (`ElementSet`).
  - `cases[]`: `{adds[], removes[], present}`. `present` iff the greatest add is set and no
    strictly-greater remove cancels it. A remove that exactly ties the add **loses** (keep
    more, lose less).
- **`version-vector.json`** — causal coverage (`VersionVector::covers`).
  - `cases[]`: `{marks[], query, covers}`. A vector covers a stamp iff it holds a mark for
    that actor that is `≥` the stamp. The unset sentinel is always covered.

## Running

`node backend/test/golden/run.mjs` — by hand, and only ever by hand. It executes every fixture
against the ~50 lines of reference semantics restated inside `run.mjs` itself, so a green run says
the corpus and that restatement agree, and nothing more.

Each lattice is proven separately, natively, and neither run touches this corpus:

- C++: `backend/test/products/roadmap/domain/SubgraphTest.cpp`, `LooseGraphTest.cpp` and
  `LegendTest.cpp` (the `domain` ctest binary).
- JS: `web/test/products/roadmap/sync/materialize.test.js`, `sync/reorder.test.js` and
  `paste/graftPlan.test.js` drive `TreeLattice` / `HlcClock` from `sync/lattice.js`.

## What it would take to make this a real pin

Recorded so the shape is not re-derived: move the three fixtures to
`packages/api-contract/crdt-golden/` beside `gym-ladder.json` — cross-surface truth belongs there
(`STRUCTURE.md`), and `gym-ladder.json` is the working example, read by both a web test and an iOS
test. Then give them two real consumers: a web test driving the exported `parseHlc`, `compareHlc`
and `VersionVector` out of `sync/lattice.js`, and a JSON-driven C++ case reading the same files (the
subgraph wire codec, `products/roadmap/adapters/json/SubgraphJson.h`, can already parse them).
`run.mjs`'s reimplemented semantics are then dead and go with it. State-level join/delta scenarios
(full `GraphState` in → converged `GraphState` out) join the corpus at the same time.

This is additive — new tests, never a refactor of either lattice.
