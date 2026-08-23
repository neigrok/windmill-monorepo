# Golden-vector corpus

Language-neutral fixtures stating the primitive convergence laws that every replica of a Windmill
tree must reproduce bit-for-bit — the C++ lattice (`platform/domain/Crdt.h`, `platform/domain/Ids.h`,
`products/roadmap/domain/Subgraph.h`) and the JS lattice
(`web/src/products/roadmap/sync/lattice.js`).

**These fixtures gate nothing.** Neither implementation reads them: `run.mjs` checks them against its
own reimplementation of the laws, and no build, test suite or workflow runs `run.mjs`. The two
lattices are free to diverge and this corpus would not notice. It is the written-down statement of
the laws, not a release gate.

A stamp is always the canonical text `physicalMs:counter:actor` (`toString`/`parseHlc` in
`platform/domain/Ids.h`). The unset sentinel is `0:0:`.

## Files

- **`hlc.json`** — the total order on stamps and the unset sentinel.
  - `compare[]`: `{a, b, expect}` where `expect ∈ {lt, eq, gt}`, comparing `(physicalMs, counter,
    actor)` in that order.
  - `sentinel[]`: `{text, isSet}` — whether a stamp carries any information.
  - `codec[]`: `{text}` — must survive `parse → serialize` unchanged.
- **`element-set.json`** — the add-biased life register (`ElementSet`).
  - `cases[]`: `{adds[], removes[], present}`. `present` iff the greatest add is set and no strictly-
    greater remove cancels it. A remove that exactly ties the add loses.
- **`version-vector.json`** — causal coverage (`VersionVector::covers`).
  - `cases[]`: `{marks[], query, covers}`. A vector covers a stamp iff it holds a mark for that actor
    that is `≥` the stamp. The unset sentinel is always covered.

## Running

`node backend/test/golden/run.mjs` — by hand only. It executes every fixture against the reference
semantics restated inside `run.mjs` itself, so a green run says the corpus and that restatement
agree, and nothing more.

Each lattice is proven separately and natively, and neither run touches this corpus:

- C++: `backend/test/products/roadmap/domain/SubgraphTest.cpp`, `LooseGraphTest.cpp`,
  `LegendTest.cpp` (the `domain` ctest binary).
- JS: `web/test/products/roadmap/sync/materialize.test.js`, `sync/reorder.test.js` and
  `paste/graftPlan.test.js` drive `TreeLattice` / `HlcClock` from `sync/lattice.js`.

## Open

- Making this a real pin means moving the three fixtures to `packages/api-contract/crdt-golden/`
  beside `gym-ladder.json` and giving them two real consumers: a web test driving the exported
  `parseHlc`, `compareHlc` and `VersionVector`, and a JSON-driven C++ case reading the same files.
