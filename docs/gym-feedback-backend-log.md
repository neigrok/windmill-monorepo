# Coach backend observations

The durable unit is a generation identified by account, conversation and client request ID. The
operation's server identity and original routine ID are persisted before a write. Immutable routine
creation receipts and conversation deletion tombstones prevent retries from repeating an effect,
including after a routine or conversation is deleted.

Model context and history are separate reads. The context query filters completed turns before its
limit, while history uses stable message positions and preserves failed/stopped exchanges and their
receipts. JSON clients and SSE clients share this lifecycle and its authoritative snapshots.

Transport, parsing and cancellation remain at the provider edge. The neutral Anthropic SSE parser
preserves tool blocks, internal thinking/signatures and observed usage; only visible text reaches
Coach snapshots. Partial output usage can be incomplete when the provider disconnects before its
final usage event. No exact final billing is inferred from partial counts.

Image data has one private owner/thread binding. Draft uploads do not create history, and cleanup
only reclaims expired unlinked rows. The upload queue is bounded and decoding runs outside request
loops. Full JPEG/PNG decode, PNG CRC checks, dimension limits and a two-decoder bound protect the
allocation boundary. The vendored decoder's provenance/license is beside its header.

Admission captures local conversation overlap before queuing database work. One short admission
worker classifies requests independently of two reserved model workers; a 64-request bound refuses
excess load with `503 ask-busy`. The Postgres lease still excludes other processes. Stored replays
remain available when model slots are full, and failed lease acquisition revalidates the immutable
request payload after rereading it. Worker capacity is released only after the database lease.

The simplification pass consolidated result/attachment JSON shapes, removed the buffered Coach
transport and its private HTTP event loop, grouped schema additions by feature, projected stored
results without loading old answers, and corrected stale lifecycle/limit comments.

The owner’s exact prompt is installed. Its note-taking workflow uses an append-only `save_note`
operation and an immutable receipt, with one note and one routine/proposal operation per generation.
Recovered receipts describe historical saves; they never restore a user-deleted note or overwrite
a later edit. Orphaned Stop preserves recovered save steps in its receipt. A corrected failed write
clears its old failure result before execution so a lost acknowledgement remains reconcilable.

The protocol fixture verifies transport and persistence through the real service stack; it is not
evidence of a live Anthropic model response. The final Notes wave passed 967 domain, 272 MCP and
1,003 Postgres adapter cases with zero failures/skips. A local HTTP check through Caddy saved a
note and routine, interrupted output, preserved a later note edit on retry and replayed completion
without a new model call. Historical actual-provider observation passed at `a3c3c811`: five calls across three
generations, one saved routine, accurate quadrant-image interpretation and text visible 7.20079
seconds before completion. Completed replay made no additional call or write. This run chose no
note; faithful note creation and replay remain established by the live `3df4a889` run.

Validation: the optimized `RelWithDebInfo` build completed with `-j4`; the current schema applied
successfully twice to the isolated feedback database. `WM_PG_TEST=1 ctest --test-dir backend/build
--output-on-failure` passed all three binaries in 5.75 seconds, including the full Postgres adapter
suite and admission regressions for more simultaneous requests than model workers, delayed
admission across completion, conflicting payloads discovered on lease reread, and two independent
services contending on a real Postgres lease. `git diff --check` is clean. Local HTTP protocol-fixture checks are recorded separately by
the orchestration task.

Tests and automation use deterministic LLM fakes/fixtures only. Committed adapter/service tests
cover parser, tool, retry and persistence behavior without provider credentials. Actual-model
exploration is manual and local only with a user-provided local key; it is not a scripted acceptance
or deployment gate. Production provider configuration remains separate from test infrastructure.

All four surface/backend CI checks passed at `a3c3c811`; merge
`e0d43e690b0bd25718a0ca096e4f64845f94fec8` has the same tested tree. Main backend run
`35452461058` and deployment `35452985601` succeeded. Public read-only checks passed at 16:10:31 UTC
with zero model requests; they establish reachability and signed-out boundaries, not public
streaming. Web Deploy is held pending restoration; Android 0.9.0 signing, installation acceptance
and publication remain last.

Catalog metadata is deliberately small and does not describe every exercise variant or setup.
Coach states actual movement-pattern coverage and material gaps, names relevant variants, and asks
only for missing material setup details. Internal IDs remain tool references rather than ordinary
answer copy. The supplied persona and persistence contracts are unchanged; the optimized build,
13 focused Coach tests and independent review passed. Final live review accepted the explicit
variants and missing pulling coverage. A brief catalog preamble and the photo answer’s empty-log
aside remain minor copy observations. Persistence receipts establish what was saved; semantic
review separately establishes whether the explanation is faithful and useful.
