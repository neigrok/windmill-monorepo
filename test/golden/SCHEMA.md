# Golden-vector corpus

Language-neutral fixtures pinning the primitive convergence laws that **every** replica of
a Windmill tree must reproduce bit-for-bit — the C++ lattice (`domain/Crdt.h`,
`domain/Ids.h`, `domain/Subgraph.h`) and the future JS lattice (`sync/lattice.js`). When the
two implementations disagree, trees diverge; this corpus is the shared release gate that
makes disagreement a red test instead of a silent bug.

A stamp is always the canonical text `physicalMs:counter:actor` (see `toString`/`parseHlc`
in `domain/Ids.h`). The unset sentinel is `0:0:`.

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

- JS (today): `node test/golden/run.mjs` — executes every fixture against the reference
  semantics that `sync/lattice.js` must match. When that module lands, its test imports
  these same fixtures and checks the real implementation against them.
- C++: the semantics are proven natively in `test/domain/SubgraphTest.cpp`,
  `LooseGraphTest.cpp`, and `LegendTest.cpp`. A JSON-driven C++ runner over this corpus
  wires in with the subgraph wire codec (`adapters/json/SubgraphJson`), which can parse it.

State-level join/delta scenarios (full `GraphState` in → converged `GraphState` out) are
proven in the C++ property tests today and join this corpus once the JS lattice exists to be
checked against them.
