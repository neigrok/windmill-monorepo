# api-contract

Wire shapes shared across backend, web and native. Executable fixtures are tested by each implementing
surface; written contracts specify API behavior and compatibility.

## `sync/`

The sync engine's conformance contract ([engine.md](../../docs/foundation/engine.md) §11): the
authoritative registry schema, the test-only `probe` product, the reference model in plain Node.js,
and the golden corpus every engine implementation passes for its role. [sync/README.md](sync/README.md)
has the layout and commands; [sync/corpus/README.md](sync/corpus/README.md) the vector shapes.

## `subscriptions/`

Windmill One's wire shapes ([subscriptions.md](../../docs/foundation/subscriptions.md) §5): golden
fixtures of the entitlement, the feed, both claim doors and `GET /v1/subscription`.
[subscriptions/README.md](subscriptions/README.md) lists the files, who writes and reads each, their rules,
and the generator and checker that keep them.

## `gym/catalog.json`

The gym ability catalog ([gym_coach.md](../../docs/foundation/mobile/gym_coach.md) §3.1, Appendix C):
`{"catalog": "catalog/2", "abilities": [...]}`, one entry per ability with `name`, `description`,
`input`, `result`, `class`, `agent`, `seats`, `phrase` and `ui`. An ability a later version added
carries `since` (`propose_workout_change`: `"catalog/2"`), so the file also declares every earlier
version: catalog/1 is the abilities with no `since` (gym_coach.md D-3), which the server serves side
by side with catalog/2.

- The server reads this file's declarations for `catalog/1` and `catalog/2` turns, the turns released
  builds open (`declarationsOf(catalog2Text())`); MCP and the server Coach list `catalog-3.json`'s.
  Appendix C's `rename_exercise` is the server's `update_exercise`.
- An entry marked `"declared": false` names an ability the server declares no tool for (`get_record`,
  `get_preferences`, `share_log`, and the withheld log, note, bodyweight and settings edits). Its `input`
  and `result` are drawn from the domain; the pin skips it.
- `result` is the JSON Schema of the payload the server tool answers on success, its `read` tally
  included. Every object in every `result` and every `input` sets `additionalProperties: false` and
  lists `required`, except three `input` objects the test pins as open: `create_routine`'s
  `pendingProposal` and the set items of `create_routine` and `propose_routine_change`. Four tools
  (`log_sets`, `import_session`, `get_sessions`, `get_last_times`) publish their `result` as an MCP
  `outputSchema`.
- `class`, `agent` and `seats` follow Appendix C, with `save_note` at `seats: "bound"`. A `read` is a
  `read`-level tool, a `remove` a `delete`-level one, and only a `propose_*` tool `proposes`.
  `propose_workout_change`'s set items list an empty `required`, so they are not among the open
  `input` objects.
- `phrase` is the step-line text a Coach client prints for a call. Both phones take it from this file, and the
  web's `TOOL_PHRASE` holds the same words for the abilities it lists.

`windmill_gym` embeds this file and `catalog-3.json` at configure time (`catalog2Text()`,
`catalog3Text()`), and declares its tools from them: each tool's name, description and input schema
are the file's, and its grant level is its `class`'s. `CatalogContractTest.cpp` holds both files to
this shape, pins what MCP lists to `catalog-3.json` byte for byte, and checks that the two differ
only in their inputs; a change that breaks either fails `ctest -R mcp`.

## `gym/abilities/`

The ability conformance corpus (gym_coach.md §3.5): one `<name>.json` for every declared ability
Coach is offered (`agent` other than `withheld`), each an array of
`{case, seat, now, zone, given, call: {name, input}, expect}`.

- `given.records` are engine records as a page carries them (`engine.md` §9.1): `{t, id, seq, rc, ru,
  born?, life?, f: {field: [value, stamp]}, v?}`, in the field names of `sync/gym.registry.json`.
  `given.shares` lists workouts holding a live share link, a server record that only the server
  executor reads. `given.appBaseUrl` is the app origin an executor builds links on: every case of
  `propose_routine_change`, `propose_routine_removal` and `share_session` carries it, and an executor
  is handed it as an input: `reviewUrl` is `<appBaseUrl>/#/gym/proposals/<id>` and a share's `url`
  `<appBaseUrl>/#/gym/shared/<token>`. A case whose result links into the app without it fails.
- `expect` is `{result, sha256, writes}` or `{refused: <code>}`, written by the server with
  `WM_GENERATE_ABILITIES=1` (`AbilitiesCorpusTest.cpp`). `sha256` is the SHA-256 of the JCS
  bytes of `result`. A `result` carries only what every executor knows (INV-3): no `rc`, `ru` or
  server admission instant (a proposal's `createdAt`, a note's `updatedAt`), and a server-written
  register only where a replica computes it by rule, as a routine's `revision`.
- `writes` are the intent's own records (INV-2): each record whose `life` or **client-written**
  fields the call changed, by `t` and `id`, with `life` and those fields. A field
  `sync/gym.registry.json` declares `"writer": "server"` never appears (`revision`, `createdDoor`,
  `createdEntries`, note `updatedAt`, proposal `baseRevision`, `baseName`, `changeCount`, `threadId`,
  `state`, `supersededBy`, `settledAt`, set `setNumber`), and nor do stamps, `seq`, `rc` or `ru`. A
  record the server changed only in such fields, as the sibling proposal a new one supersedes, is no
  write of the call's, and a type with no client-written field (`routineCreation`) is never listed.
- An input's text may arrive decomposed. A field `gym/domain/rules.json` marks `nfc` is stored and
  answered in NFC (gym_coach.md §3.3), and a replay or duplicate is matched on that composed form,
  as the decomposed cases in `create_routine` and `save_note` pin.
- A refusal's code is the server tool's outcome code: `refused` for a rule's refusal, `load-floor`
  for a target below its movement's load floor, `invalid-arguments` for a malformed input.
- The server runs every case as Coach does, for the account, with proposals stamped `door: ask` and
  no thread.

Read as a test by `backend/test/products/gym/adapters/mcp/AbilitiesCorpusTest.cpp` under
`WM_PG_TEST` (`backend/RUNNING.md` §7): each case seeds its records into the account's gym scope on
`WM_SYNC_DATABASE_URL`, calls `GymTools`, compares the answer's JCS bytes and SHA-256, and holds a
result to the ability's `result` in `catalog.json`. The server
is the golden source: with `WM_GENERATE_ABILITIES=1` the same run writes each `expect` from the
server's answer instead of comparing it.

```sh
WM_PG_TEST=1 WM_GENERATE_ABILITIES=1 DATABASE_URL="postgresql:///wm_rest_test?host=/tmp" \
  WM_SYNC_DATABASE_URL="postgresql:///wm_sync_test?host=/tmp" ./backend/build/windmill_mcp_tests
```

## `gym/catalog-3.json` and `gym/abilities-3/`

`catalog/3` ([Gym Coach on the AI service](../../docs/foundation/gym-coach-on-ai-service.md) §3), the
catalog written to the provider's strict mode. It has `catalog.json`'s shape and abilities, and
differs only in its inputs and in `strict`: no keyword strict mode refuses, every object lists
`required`, and a bound strict mode cannot state is in the description of the parameter it bounds.
Each ability's `strict` says whether a device turn declares its tool strict to the provider:
`create_routine`, `create_exercise` and the three `propose_*` writes are, and the model's own
adherence holds the rest, so the grammar the provider compiles stays one it accepts. MCP and the
server Coach never send `strict`. The server reads it:
`gymToolCatalog()` declares its tools, so MCP lists its schemas, the server Coach offers them, and a
`catalog/3` turn is offered and gated by them. The web's and Android's replica executors read it too
(`web/src/products/gym/domain/coach/`, `apps/android/gym/domain/.../coach/`). `catalog.json` and `abilities/` are deleted when no
released build opens a `catalog/2` turn.

- `strict.py` checks it in the Coach contracts workflow: every ability says `strict` as a boolean,
  every ability's input holds only keywords and shapes strict mode accepts, strict or not, each
  seat's strict tools (`agent` `runs` or `proposes`, declared, admitting the seat, `strict`) stay
  within 20 strict tools, 24 optional parameters and 16 union-typed parameters, counted at every
  depth, and every `abilities-3/` input stands inside its schema.
  These are the limits the provider publishes, and it checks those only: the provider can still
  refuse a seat's tools together, which only a real round proves (the spec's §3 and §10).
  `python3 packages/api-contract/gym/strict.py` runs both and prints the counts; given a catalog
  path, it checks that catalog alone. `strict_test.py`, run in the same step, holds a schema for each
  rule it refuses and each way it counts.
- `abilities-3/` has `abilities/`'s case format. Its 18 files hold `abilities/`'s cases with the
  inputs `catalog/3` asks for (a required `review` or `limit`, `null` where a parameter is left
  empty) and the same `expect`, and a refusal for each value just outside every bound that moved out
  of a schema. The fields `list_routines` answers with that a write ignores are not in
  `catalog/3`'s write schemas, so no case sends them; that a day read back over MCP is a day sent is
  the server doors' own tests (`GymToolsTest.cpp`, `AskServiceTest.cpp`, `TurnGateTest.cpp`).
- `start_session`, `log_set`, `log_sets`, `import_session`, `finish_session` and `update_exercise`
  are withheld from Coach; their files hold the refusals of their moved bounds alone, for the server
  executor, which runs them for MCP.
- The server executor claims every case, by SHA-256 of canonical bytes, in
  `backend/test/products/gym/adapters/mcp/AbilitiesCorpusTest.cpp`, and holds each answer to the
  ability's `result`. The web's claims them in `web/test/products/gym/domain/corpus.test.js` and
  Kotlin's in `apps/android/gym/domain/src/test/.../sync/CorpusTests.kt`: a withheld ability's and a
  share's as `not-offered`, which each answers, and every other case byte for byte, but for one
  `create_exercise` case whose id no turn seeds. Swift's does not yet. Its refusals are hand-written, not the server's golden, so `WM_GENERATE_ABILITIES` never
  rewrites them: they are the contract each executor is held to when it moves onto `catalog/3`.
- A value outside a moved bound is refused `invalid-arguments` before any rule reads the store, so a
  refusal case's records need not make the rest of the call succeed, though each case's do.

## `gym/coach/`

The words the model reads in a gym Coach turn: the system prompt, the words of the first content and
the sentence beside each refusal code. The backend embeds them and the apps ship them as they are.
[gym/coach/README.md](gym/coach/README.md) has the files and how a turn puts them together.

## `genesis.js`

A locally-born tree's first sync converges with the server's empty tree only while this seed is
byte-equal to the backend's (`Legend::seededDefaults` + `Hlc{1,0,"genesis"}`). Read by
`web/vite.config.js`, which fails the build on drift; pinned backend-side by `TreeRegistryTest`.

## `roadmap/layout/`

Roadmaps and the picture the web's Graph draws of each — seats, tiers, link bows, framing and caption
placements — with the values of the arithmetic the picture is computed with
([roadmap-ios.md](../../docs/foundation/roadmap-ios.md) §5). The web writes the files and
`web/test/products/roadmap/layout/fixtures.test.js` fails when one is not what it draws; a port reproduces every
number. [roadmap/layout/README.md](roadmap/layout/README.md) has the format, how each number is derived, and the
arithmetic, ordering and text rules a port must keep.

## `roadmap/plan/`

The plan grammar's cases ([roadmap-ios.md](../../docs/foundation/roadmap-ios.md) §7.1): a pasted text read to a plan,
a plan as the input of the domain's `CreateRoadmap` and `ImportSteps`, and a roadmap written as Markdown and read back.
[roadmap/plan/README.md](roadmap/plan/README.md) states the grammar and each file's shapes. Read as a test by
`web/test/products/roadmap/paste/corpus.test.js`, which claims every file by name.

## `roadmap-addresses.json`

Where a roadmap and its steps open on the web, as what follows the app's origin: `/#/app/<treeId>` and
`/#/app/<treeId>?step=<id>` for a tree the reader owns, `/t/<treeId>` and `/t/<treeId>#?step=<id>` for
one they can only read. A tree id is always `t_` plus 16 hex and is written as it is; a step id is
encoded as `encodeURIComponent` does. The backend builds every case (`domain/WebAddress`, tested by
`WebAddressTest`, which reads the file at run time; the image copies it in `backend/Dockerfile`), and
`web/test/products/roadmap/addresses.test.js` proves the router opens each one. `localOrigin` is the
origin a local stack serves the app on: the backend's default when `WINDMILL_APP_URL` is unset
(`platform/infra/AppOrigin.h`) and the port `web/vite.config.js` pins the dev server to, each held to
it by the same two tests, so an address a locally run server hands out opens the local app.

## `roadmap-link-urls.json`

Which link urls a person is shown on a node: a url as the server stores it, trimmed of the whitespace
around it, and whether the web shows it — `http:`, `https:` or `mailto:`, in any case. The backend's
`shownLinkUrl` (`backend/products/roadmap/domain/Command`, tested by `CommandTest`, which reads the file
at run time; the image copies it in `backend/Dockerfile`) takes exactly the shown ones, and
`web/test/products/roadmap/graph/tree/NodeWorkspace.test.js` proves `SAFE_URL` shows exactly those.

## `roadmap-socket.json`

The size of a message on the roadmap socket, in bytes of its JSON text as UTF-8. `maxInboundBytes` is
the most the server takes: `kMaxSocketMessageBytes` (`backend/products/roadmap/domain/Command.h`, held
to the file by `CommandTest`, which reads it at run time; the image copies it in `backend/Dockerfile`),
set on the framework in `backend/platform/infra/main.cpp`, which drops the connection of a larger
message; `WriteRoutesTest` holds that line. `maxFrameBytes` is the most the web client sends in one
structure frame, but for a single entry that alone is larger: `MAX_FRAME_BYTES` (`web/src/products/roadmap/sync/frames.js`, held to the file and
under `maxInboundBytes` by `web/test/products/roadmap/sync/SyncSession.test.js`).

## `roadmap/quests/`

The roster of quests ([roadmap-ios.md](../../docs/foundation/roadmap-ios.md) §7.1): `roster.json`, the nine
ready-made roadmaps in their order, each with the input of the domain's `CreateRoadmap` it plants. The file
is the source: the web's shelf reads it, and `web/test/products/roadmap/quests/roster.test.js` holds what the
web plants to it. [roadmap/quests/README.md](roadmap/quests/README.md) has the shape, the rules every quest
keeps and how its words are shown.

## `gym-ladder.json`

- The step pair is chosen by the **magnitude** of the weight, never its sign: under 20 kg ±1 / ±2.5,
  under 50 kg ±2.5 / ±5, at or above 50 kg ±2.5 / ±10.
- A step that *reduces the magnitude* picks its band with `magnitude <= boundary` rather than `<`,
  so a step landing on a boundary is undone by its opposite (`19 +1→ 20 −1→ 19`) while a step that
  crosses one is not (`19.5 +1→ 20.5 −2.5→ 18`).
- Lightening is `direction × weight < 0`, not "going down": the ladder walks through zero into
  assisted territory. `bump(−w, −direction, big) == −bump(w, direction, big)` for every input.
- Weights are stored to two decimals, rounded **half away from zero**: `round(−x) == −round(x)`.
  JavaScript's `Math.round` is half-up, so round the magnitude and reapply the sign. The rounding is
  `round(x × 100) ÷ 100` in IEEE-754 doubles, not decimal rounding of the typed string.
- The rep floor is **1**, and it clamps into the range rather than holding: `bumpReps(0, −1)` is `1`.

Read as a test — each from this file in the repo, never a bundled copy — by:

- `web/test/products/gym/logger/ladder.test.js` → `web/src/products/gym/logger/ladder.js`
- `apps/android/gym/src/test/kotlin/works/windmill/gym/presentation/LadderTests.kt` → `apps/android/gym/src/main/kotlin/works/windmill/gym/presentation/Ladder.kt`

## `gym/turns/`

Scripted exchanges over the Coach turn wire ([gym_coach.md](../../docs/foundation/mobile/gym_coach.md)
§3.5, §6, §10.1), one JSON file per case. The backend replays each against its loop with a scripted
model and the test as the phone (`backend/test/products/gym/coach/TurnServiceTest.cpp`); a phone's
turn driver replays the same file against a fake server that emits `events` and expects `results`.

| Field | Meaning |
|---|---|
| `case` | The file's name. |
| `seat` | `anon` or `bound`: the seat the open runs under. |
| `clockMs` | Server side only: the server's clock through the exchange, where a frame names a moment derived from it. |
| `open` | The §6.2 body, verbatim. |
| `model` | Server side only: the vendor's reply per model call — `{stop_reason, content}`, `null` for a transport failure, `{"refused": code}` for a round the allowance refused. |
| `events` | The frames the server sends, in order, heartbeats aside. A `done` frame's `allowance` is omitted: it belongs to the environment, and the comparison drops it. An `error` frame's `allowance` is the script's: what the phone says depends on it, and the server's read of a seat with nothing spent is what the comparison expects. `{"await": …}` entries are not frames: they mark where the server waits for the phone — `results` of a `batch`, `stop`, `resume`, or the `timeout` of a silent phone. |
| `results` | The bodies the phone posts, in order, each on the `calls` frame of its `batch` — or of `on`, when a probe answers another batch on purpose. `expect` is `accepted` (the default, 200), `replay` (204) or `coach-turn-order` (409). |
| `stop` | `{"afterModelCall": n}`: Stop is requested as soon as the n-th model call returns, before its batch. |
| `resume` | `{"onBatch": n}`: the phone reconnects on that `calls` frame, before answering, and reads a `snapshot`. |
| `phone` | `silent`: the phone never answers, and the turn ends `interrupted` after `CALL_RESULT_TIMEOUT`. |
| `after` | Steps once the turn ended: `{"open": true}` (the same body again) expects `resumed` and the `snapshot` given; `{"open": {field overrides}}` expects `coach-turn-conflict`; `{"resume": turnId}` expects `coach-turn-unknown`; `{"results": body}` expects `replay`. |
| `modelRequests` | Server side only: per model call, the `toolResults` the request carried, in order — `callId`, `isError`, and the exact `content` or a `contains` fragment. A refusal's content starts with its code in brackets. |
| `notOffered` | Server side only: names absent from the tool list the first model call sent. |
| `serverCalls` | Server side only: the calls the server executor ran (ruling R2). |
| `end` | The terminal `state`, `truncated` where set, and the `code` of a `failed` turn. |

A `failed` turn ends with an `error {code, budgetResetsAtMs?, allowance?}` frame, every other terminal state with `done {state, truncated?, allowance}`.

## `gym-history.md`

Filtered workout history, complete scope totals and progress, local month indexes, snapshot/live log
links and the display name a workout correction sets. Backend HTTP and Postgres tests cover the
contract; session reads and workout shares keep their own fields.
