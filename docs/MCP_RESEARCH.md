# Windmill MCP: current-model research

Research date: 2026-09-08. Scope: official MCP, OpenAI and Anthropic guidance, source review, contract
tests and local-stack checks. The implementation exposes 52 tools: 30 roadmap and 22 gym. No model
benchmark establishes a task-success or token-saving percentage; catalog bytes are not token counts.

The primary design is a deterministic, permission-filtered product catalog with focused operations,
explicit retry behavior and bounded selected reads. Product prefixes and batch operations fit the
existing platform/product seam. Model-task evaluations and transport modernization remain separate
workstreams.

## What current guidance changes

OpenAI's current model guide covers GPT-6 Astra and programmatic and asynchronous tool workflows. These are model/host capabilities; they do not require Windmill to run another model internally. Windmill should expose explicit operations that remain understandable when a host loads only a few definitions. [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)

Both vendors support discovering tools on demand. OpenAI supports deferred MCP servers; Anthropic supports deferred MCP toolsets. The server supplies a deterministic, searchable, permission-filtered catalog. The client controls which definitions enter model context. A custom `search_tools`/`execute_tool` pair would add an extra protocol without demonstrated value here. OpenAI's small-namespace guidance is not a requirement to split Windmill into many remote servers. [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search), [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)

Programmatic calling favors predictable data flow: fetch several results, join/filter them in code, and return the evidence needed for a decision. OpenAI currently supports MCP in this mode. Anthropic's managed programmatic-calling documentation explicitly excludes tools supplied through its MCP connector; other clients can provide their own wrappers. Consequently, “supports MCP” does not imply identical orchestration behavior across hosts. [OpenAI programmatic calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling), [Anthropic restrictions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)

The current MCP revision is **2026-07-28**. It uses per-request metadata and `server/discover`, with documented compatibility for older initialization-based revisions. Adoption requires protocol and lifecycle changes. Improving tool results can proceed independently of that work. [Current version](https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning), [compatibility specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)

## Current implementation

### Product discovery and guidance

External tool names are `roadmap_<local>` and `gym_<local>`. The public catalog contains each tool
once. Unambiguous raw names remain compatibility aliases; both spellings pass the same scope and
argument checks and dispatch to the same product-local operation. Ambiguous raw names are refused.
Public name, alias and retirement collisions fail at construction. Human titles remain readable.
Only known tool references in descriptions and schema description fields are rewritten; enum,
constant, default and example data remain unchanged. See
[CompositeToolHost](../backend/platform/adapters/mcp/CompositeToolHost.cpp) and
[its contract tests](../backend/test/platform/adapters/mcp/CompositeToolHostTest.cpp).

Initialize instructions include the user's existing goals, preferences and constraints, relevant
state reads, and targeted questions only for missing information that materially affects a result.
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

All seven new tools declare `outputSchema` and return `structuredContent` plus compatibility JSON
text from the same result object. The three selected-read tools cap the complete tools/call result
at 262144 bytes, including both representations. They reject oversized requests with a smaller
selection or projection retry; they do not silently truncate. Gym reads preserve their read tally.
Structured results are an optional MCP capability, not a requirement to remove compatibility text.
[MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

`roadmap_annotate_node` conservatively declares non-idempotence because its append form can duplicate
text. Unexpected roadmap failures describe an uncertain outcome and require authoritative read-back
before retry; a failure after an in-memory change or broadcast cannot truthfully promise rollback.
An SQL transaction or a durable receipt does not make every downstream infrastructure error a known
non-commit. See [result contract](../backend/platform/ports/ToolHost.h) and
[roadmap error tests](../backend/test/products/roadmap/adapters/mcp/ToolErrorContractTest.cpp).

## Remaining recommendations

### Evaluate actual model tasks

Existing contract tests, adversarial review, a versioned wire corpus and live app checks verify
software behavior. They do not measure tool selection or coaching quality across models. Build
20–30 realistic tasks with fixed fixtures and repeated trials in target clients and an API harness.
Grade resulting app/database state and the assistant's explanation, without requiring one exact
call sequence. [Metadata evaluation](https://developers.openai.com/plugins/guides/optimize-metadata),
[agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

| Task | Required outcome |
| --- | --- |
| Find available work in a large graph | Correct derived frontier and honest source coverage |
| Resolve similarly named nodes | Correct target or a necessary clarification |
| Update 15 node descriptions | Intended replacements, unrelated fields preserved, descriptions self-contained |
| Retry a lost response | No duplicated append or exact-id resurrection; original identity or state reconciliation |
| Edit after another client changes the graph | Explicit sequence conflict or intentional supported merge |
| Review six weeks of one movement | Correct dates, units and source coverage |
| Propose a routine change with missing context | Necessary human information gathered before a proposal, no invented answers |
| Apply a proposed routine through an agent | No tool can bypass the user's Apply action |
| Request another account's data | Permission/privacy boundary holds |
| Retrieve a hostile note | Host ignores embedded instructions; server grants and authorized task remain unchanged |

Track task success, unwanted changes, repairs, tool-selection failures, returned bytes/tokens,
rounds and latency. Separate cold discovery from warm runs. Tune metadata and defaults from those
results, not a quota of tools. [Effective tool design](https://www.anthropic.com/engineering/writing-tools-for-agents),
[OpenAI tool planning](https://developers.openai.com/plugins/plan/tools)

### Extend existing reads where measurements justify it

Legacy roadmap pages default to 200 nodes, allow 1000, and limit description-bearing node pages to
4 MiB. That ceiling protects transport size but can still exceed useful model context. Selected
reads now offer a smaller explicit path; evaluate whether legacy defaults and summaries need
further tuning. [ReadShape](../backend/products/roadmap/adapters/mcp/ReadShape.h)

Gym `get_stats` still loads full history before movement filtering and offers no date window.
`list_sessions` requires reconstructing `before`/`beforeId` and has no explicit continuation/end
marker. `get_last_times` batches tool requests but still uses per-exercise database reads. Consider
bounded date queries, explicit continuation and a repository bulk history query when usage warrants
them. [TrainingService](../backend/products/gym/application/TrainingService.cpp),
[GymTools](../backend/products/gym/adapters/mcp/GymTools.cpp)

Legacy tool results do not all have output schemas/structured results. Extend those contracts to
high-use reads and proposal receipts with compatible text from the same authoritative object,
checking actual client behavior because some hosts may expose both copies to the model.

### Separate protocol and transport work

The implementation retains the initialization-based `2025-06-18` engine. Source review identifies
remaining work; these findings are not reproduced transport exploits:

- Initialize echoes a requested version rather than negotiating a declared supported set.
- The HTTP edge reads `method` before the engine's type guard and ignores the JSON parser's success
  result; validate the envelope before dispatch.
- Request/notification/response handling needs one explicit validated boundary.
- Session DELETE does not use POST's authentication and Origin checks, and session records contain
  only expiry. A leaked session id can therefore terminate that session; this is not evidence of
  account-data access.

See [McpServer](../backend/platform/adapters/mcp/McpServer.cpp),
[McpHttpEndpoint](../backend/platform/adapters/mcp/McpHttpEndpoint.cpp),
[shared parser](../backend/platform/adapters/json/JsonText.cpp) and
[legacy negotiation requirement](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).
Add compatibility tests before advertising newer protocol semantics. Cancellation, Tasks or MCP
Apps should follow concrete long-running or interactive requirements.

Tool listing is scoped, but initialize instructions combine registered products and static roadmap
resources are not grant-filtered. The HTTP roots register roadmap and gym; stdio registers roadmap.
Documentation scoping and transport registration parity remain explicit future choices.

## Verification and structure

[The implementation log](MCP_BATCH_LOG.md) records contract and live-stack verification. Tests cover
invalid-last-item rollback, omission preservation, no-op retries, revision conflicts, scopes,
selected ordering/missing ids, strict replay, correction/deletion preservation, numbering and
cross-path id reservation. The wire corpus remains versioned. No model performance gain is claimed.

Keep platform responsible for transport, authentication, public naming and result forwarding.
Product domain/application layers own retrieval and mutation semantics. No universal query/mutation
language, arbitrary-code tool or cross-product context dump is needed for this scope. Journal has
no registered MCP tools; adding it is a separate product and privacy decision.
