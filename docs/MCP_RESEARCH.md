# MCP contracts and open work

The HTTP MCP server publishes permission-filtered roadmap and gym tools. Platform owns transport,
authentication, public naming and forwarding; each product owns its reads and mutations. Journal
has no registered tools. The source catalogs are
[roadmap](../backend/products/roadmap/adapters/mcp/RoadmapToolCatalog.cpp) and
[gym](../backend/products/gym/adapters/mcp/GymToolCatalog.cpp).

### Product discovery and guidance

External tool names are `roadmap_<local>` and `gym_<local>`. The public catalog contains each tool
once. Unambiguous raw names remain compatibility aliases; both spellings pass the same scope and
argument checks and dispatch to the same product-local operation. Ambiguous raw names are refused.
Public name, alias and retirement collisions fail at construction. Human titles remain readable.
Only known tool references in descriptions and schema description fields are rewritten; enum,
constant, default and example data remain unchanged. See
[CompositeToolHost](../backend/platform/adapters/mcp/CompositeToolHost.cpp) and
[its contract tests](../backend/test/platform/adapters/mcp/CompositeToolHostTest.cpp).

Initialize instructions tell assistants to use known goals, preferences and constraints, read
relevant state, and ask targeted questions only for missing information that materially affects a result.
Roadmap guidance asks for balanced coverage, genuine dependencies, concise human titles and
standalone node descriptions. Gym guidance asks for friendly, systematic coaching with necessary
human context before training decisions. Recording supplied workout facts does not require coach
intake. Existing-routine changes remain proposals awaiting the user's Apply action. See
[roadmap instructions and quickstart](../backend/products/roadmap/adapters/mcp/RoadmapResources.cpp) and
[gym instructions](../backend/products/gym/adapters/mcp/GymToolCatalog.cpp).

### Batch coverage

| Workflow | Contract |
| --- | --- |
| Create/upsert a graph slice | `roadmap_import_subgraph`: one structural graft for nodes, kinds, prerequisites and tombstones; optional progress is a separate atomic phase |
| Patch existing nodes | `roadmap_patch_nodes`: 1–200 unique existing ids; omitted fields survive, supplied fields replace; one structural op |
| Add/remove graph edges | `roadmap_change_edges`: 1–500 combined pairs; full validation, absent removals are no-ops, cycles allowed |
| Delete nodes / remove edges | `roadmap_delete_node.nodeIds` (1–200); `roadmap_disconnect.edges` (1–500) |
| Mark several nodes | `roadmap_set_progress.updates` (1–1000), one SQL transaction and final-state prerequisite advice |
| Read exact graph nodes | `roadmap_get_nodes`: 1–200 unique ids, requested order, projections and explicit missing ids |
| Log performed sets | `gym_log_sets`: 1–200 ordered sets, one transaction, strict original-input replay |
| Import completed workout | `gym_import_session`: completed historical session plus 0–200 sets, one transaction, leaves live workout untouched |
| Read exact workouts | `gym_get_sessions`: 1–50 unique ids, requested order, missing ids and optional review |
| Read last workout evidence | `gym_get_last_times`: 1–50 unique exercise ids; distinguishes inaccessible/missing exercise from no completed non-warmup history |
| Create/propose routine | Existing entry/target arrays remain the routine workflow; prescription targets are distinct from performed sets |

Patch and edge tools support `expectedSeq` and `dryRun`; unchanged retries do not create another
structural op. Pure domain planners validate the whole candidate before room mutation, then the
room supplies one HLC stamp, persistence path and live broadcast. Imports retain their replacement
semantics and remain useful for complete graph slices. See
[roadmap domain plans](../backend/products/roadmap/domain/Command.cpp) and
[roadmap tool contracts](../backend/products/roadmap/adapters/mcp/RoadmapToolCatalog.cpp).

Progress updates hold the room strand across node validation, one repository commit, advisory
calculation and broadcast. Import receipts distinguish `graphApplied` from `progressApplied`, with
explicit errors or skipped ids when the requested overlay could not all be applied. Graph and
progress are not one database transaction. See
[progress repository](../backend/products/roadmap/adapters/postgres/PgProgressRepository.cpp) and
[import/progress orchestration](../backend/products/roadmap/adapters/mcp/RoadmapTools.cpp).

Gym's pure `SetBatch` validates size, uniqueness, decimal precision and time intervals. Repository
transactions reserve durable identities and commit rows together. Original request hashes survive
corrections and session deletion, so exact-id retries cannot recreate deleted facts. Single and batch
creation share the reservation mechanism; hashes use stored numeric precision and retain no
original note text. Typed admission failures include a failing set index/id where relevant and
confirm that the batch committed nothing. See
[domain batch](../backend/products/gym/domain/Training.cpp),
[gym repository](../backend/products/gym/adapters/postgres/PgLogRepository.cpp) and
[receipt schema](../backend/db/schema.sql).

### Results, limits and retry honesty

`roadmap_get_nodes`, `roadmap_patch_nodes`, `roadmap_change_edges`, `gym_log_sets`,
`gym_import_session`, `gym_get_sessions` and `gym_get_last_times` declare `outputSchema` and return
`structuredContent` plus compatibility JSON text from the same result object. The three selected-read tools cap the complete tools/call result
at 262144 bytes, including both representations. They reject oversized requests with a smaller
selection or projection retry; they do not silently truncate. Gym reads preserve their read tally.

`roadmap_annotate_node` conservatively declares non-idempotence because its append form can duplicate
text. Unexpected roadmap failures describe an uncertain outcome and require authoritative read-back
before retry; a failure after an in-memory change or broadcast cannot truthfully promise rollback.
An SQL transaction or a durable receipt does not make every downstream infrastructure error a known
non-commit. See [result contract](../backend/platform/ports/ToolHost.h) and
[roadmap error tests](../backend/test/products/roadmap/adapters/mcp/ToolErrorContractTest.cpp).

## Open work

### Protocol boundary

The engine defaults to `2025-06-18` and echoes a supplied initialization version rather than
negotiating a supported set. The HTTP edge reads `method` before the engine's type guard and ignores
the raw JSON parser's success flag. Session DELETE omits POST's authentication and Origin checks;
session entries store expiry without caller ownership. These are source findings, not reproduced
transport exploits. Validate the envelope before dispatch and share the session trust boundary
before extending protocol support.

Sources: [McpServer](../backend/platform/adapters/mcp/McpServer.cpp) and
[McpHttpEndpoint](../backend/platform/adapters/mcp/McpHttpEndpoint.cpp).

Tool listing is scoped, but initialize instructions combine registered products and static roadmap
resources are not grant-filtered. HTTP registers roadmap and gym; stdio registers roadmap only.

### Read bounds and retries

- Legacy roadmap pages default to 200 nodes and allow 1000. Description-bearing pages permit up to
  4 MiB; selected reads provide a smaller explicit path.
- Gym `get_stats` loads history before movement filtering and has no date window. `list_sessions`
  uses `before`/`beforeId` without an explicit continuation marker. `get_last_times` still queries
  history per exercise.
- Legacy tools do not all provide output schemas and structured results. Add both representations
  from one authoritative object when extending them.
- Native [iOS](../apps/ios/WindmillKit/Sources/WindmillGym/SetQueue.swift) and
  [Android](../apps/android/gym/src/main/kotlin/works/windmill/gym/store/SetQueue.kt) queues remint IDs
  on `session-id-taken`. That code also covers an owned deleted session with a durable receipt;
  a stale start can therefore become another workout under a fresh ID. The native queue needs a
  distinct terminal outcome or reconciliation rule for this case.

### Model-task evidence

Contract tests and the wire corpus verify software behavior, not model tool selection or coaching
quality. Manual local exploration should check target selection, scope, retries, concurrent edits,
read coverage and faithful explanations against known fixtures. No model success-rate or token
saving has been measured. Tests and CI use deterministic fixtures; actual-model exploration uses
an explicitly supplied local key and is not an automated delivery gate.
