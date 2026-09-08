# MCP batch implementation log

## Current surface

The composite publishes 52 canonical tools: 30 `roadmap_` and 22 `gym_`. Unambiguous raw names are
compatibility aliases; product-only hosts retain local names. Permission gates, nested argument
validation and retired-tool refusals apply consistently. Module descriptions and initialize
instructions reference canonical tools without rewriting schema values or user payloads.

Roadmap adds exact-node reads, omission-preserving node patches and edge batches. Pure domain plans
validate before one structural op; patches and edges support dry runs, sequence preconditions and
unchanged retries. Progress commits as one repository batch while holding the room strand. Imports
report graph and progress outcomes separately. New gym operations log sets, import completed
workouts and retrieve selected workouts/last-times. Session/set ids have durable, transactionally
reserved original-request hashes across single and batch creation paths, including after deletion.

The seven new tools have output schemas and matching structured/compatibility results. Selected
reads bound the complete result to 262144 bytes and report missing ids explicitly. Initialize
instructions teach balanced roadmap authoring and friendly, context-aware gym coaching; factual
logging remains separate from training decisions and routine changes retain the user's Apply flow.

## Verification

Targeted domain, MCP and PostgreSQL regressions cover atomic rejection of a bad final item,
omission preservation, duplicate ids, dry runs, sequence conflicts, unchanged retries, permissions,
ordered selected reads, response bounds, progress rollback, strict workout replay, correction and
deletion preservation, normalized numeric identity, and concurrent single/batch writes.

Local PostgreSQL/MCP checks cover all seven new tools, canonical/legacy routing, initialization
instructions with preserved natural prose, invalid-final rollback, concurrent exact retries,
independent historical import while a live workout remains open, owner isolation and oversized
result refusal. Roadmap browser checks observe the live WebSocket sequence update and changed DOM
labels. Gym browser checks show the recorded workout and preserved human correction. Both pages
have no runtime exceptions.

Verified backend suites: domain **947/947**, MCP **262/262**, adapters **948/948**, with PostgreSQL
integration enabled. All three completed with zero stopped cases, zero skips and zero failed
assertions, including cross-session durable-id reservation and half-cent numeric replay. The
branch is integrated with main at `66fa0543`. These checks verify application behavior; no
model-task benchmark or token saving has been measured.

## Structure and simplification

- Product-local declarations stay authoritative; the composite owns public naming and routing.
- Pure roadmap planners share the existing command/room pipeline rather than a second mutation path.
- `ProgressRepository` owns the bulk commit, so callers cannot accidentally loop independent commits.
- Gym's pure `SetBatch` centralizes admission; one repository transaction pipeline serves logging and
  completed import. Single and batch paths share durable reservations and canonical hash generation.
- New selected results use the same payload for compatibility text and structured content. Byte
  checks cover both representations, and gym read tallies are attached before the check.
- Tests extend existing mirrored files; no new production class/file or CMake target is needed.

The simplification pass consolidated hash normalization, kept tool reference rewriting restricted
to schema-bearing fields, removed broad idempotency/rollback claims, and aligned product guidance
and quickstart with the actual operations.

`get_last_times` still performs per-exercise history queries; explicit continuation/date-bounded
legacy gym reads, broader output schemas, documentation scoping and protocol modernization remain
separate improvements. See [research and recommendations](MCP_RESEARCH.md).

Native queue follow-up: [iOS SetQueue](../apps/ios/WindmillKit/Sources/WindmillGym/SetQueue.swift)
and [Android SetQueue](../apps/android/gym/src/main/kotlin/works/windmill/gym/store/SetQueue.kt) automatically remint on
`session-id-taken`. That generic code now also covers an owned deleted session with a durable
receipt. MCP advises reconciliation, but a stale native start request may create another workout
under a fresh id. A terminal deleted-session outcome or queue reconciliation is a separate
cross-surface contract change; same-id reservation alone does not address fresh-id retries.
