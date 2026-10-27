# api-contract

Wire shapes shared across backend, web and native. Executable fixtures are tested by each implementing
surface; written contracts specify API behavior and compatibility.

## `sync/`

The sync engine's conformance contract ([engine.md](../../docs/foundation/engine.md) §11): the
authoritative registry schema, the test-only `probe` product, the reference model in plain Node.js,
and the golden corpus every engine implementation passes for its role. [sync/README.md](sync/README.md)
has the layout and commands; [sync/corpus/README.md](sync/corpus/README.md) the vector shapes.

## `gym/catalog.json`

The gym ability catalog ([gym_coach.md](../../docs/foundation/mobile/gym_coach.md) §3.1, Appendix C):
`{"catalog": "catalog/1", "abilities": [...]}`, one entry per ability with `name`, `description`,
`input`, `result`, `class`, `agent`, `seats`, `phrase` and `ui`.

- `name`, `description` and `input` are byte-equal under JCS to the `name`, `description` and
  `inputSchema` that `gymToolCatalog()` declares for the tool of that name, so MCP and Coach publish
  this file's words. Appendix C's `rename_exercise` is the server's `update_exercise`.
- An entry marked `"declared": false` names an ability the server declares no tool for (`get_record`,
  `get_preferences`, `share_log`, and the withheld log, note, bodyweight and settings edits). Its `input`
  and `result` are drawn from the domain; the pin skips it.
- `result` is the JSON Schema of the payload the server tool answers on success, its `read` tally
  included. Every object in every `result` and every `input` sets `additionalProperties: false` and
  lists `required`, except three `input` objects the test pins as open: `create_routine`'s
  `pendingProposal` and the set items of `create_routine` and `propose_routine_change`. Four tools
  (`log_sets`, `import_session`, `get_sessions`, `get_last_times`) also publish an MCP `outputSchema`
  of their own.
- `class`, `agent` and `seats` follow Appendix C, with `save_note` at `seats: "bound"`. A `read` is a
  `read`-level tool, a `remove` a `delete`-level one, and only a `propose_*` tool `proposes`.
- `phrase` is the step-line text a Coach client prints for a call, the same words the web and Android
  phrase tables hold today.

Read as a test by `backend/test/products/gym/adapters/mcp/CatalogContractTest.cpp`, which embeds the
file into `windmill_gym` at configure time (`catalogText()`). A change to this file or to a tool
declaration that breaks the pin fails `ctest -R mcp`.

## `gym/abilities/`

The ability conformance corpus (gym_coach.md §3.5): one `<name>.json` for every declared ability
Coach is offered (`agent` other than `withheld`), each an array of
`{case, seat, now, zone, given, call: {name, input}, expect}`.

- `given.records` are engine records as a page carries them (`engine.md` §9.1): `{t, id, seq, rc, ru,
  born?, life?, f: {field: [value, stamp]}, v?}`, in the field names of `sync/gym.registry.json`.
  `given.shares` lists workouts holding a live share link, a server record that only the server
  executor reads.
- `expect` is `{result, sha256, writes}` or `{refused: <code>}`. `sha256` is the SHA-256 of the JCS
  bytes of `result`. `writes` lists each record the call created, changed or killed, by `t` and `id`,
  with `life` and its field values, without stamps, `seq`, `rc`, `ru` or serials (INV-2).
- A refusal's code is the server tool's outcome code: `refused` for a rule's refusal,
  `invalid-arguments` for a malformed input.
- The server runs every case as Coach does, for the account, with proposals stamped `door: ask` and
  no thread, and share and review links on `https://windmill.works`.

Read as a test by `backend/test/products/gym/adapters/mcp/AbilitiesCorpusTest.cpp` under
`WM_PG_TEST` (`backend/RUNNING.md` §7): each case seeds its records into the account's gym scope on
`WM_SYNC_DATABASE_URL`, calls `GymTools`, and compares the answer's JCS bytes and SHA-256. The server
is the golden source: with `WM_GENERATE_ABILITIES=1` the same run writes each `expect` from the
server's answer instead of comparing it.

```sh
WM_PG_TEST=1 WM_GENERATE_ABILITIES=1 DATABASE_URL="postgresql:///wm_rest_test?host=/tmp" \
  WM_SYNC_DATABASE_URL="postgresql:///wm_sync_test?host=/tmp" ./backend/build/windmill_mcp_tests
```

## `genesis.js`

A locally-born tree's first sync converges with the server's empty tree only while this seed is
byte-equal to the backend's (`Legend::seededDefaults` + `Hlc{1,0,"genesis"}`). Read by
`web/vite.config.js`, which fails the build on drift; pinned backend-side by `TreeRegistryTest`.

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
- `apps/android/gym/src/test/kotlin/works/windmill/gym/domain/LadderTests.kt` → `apps/android/gym/src/main/kotlin/works/windmill/gym/domain/Ladder.kt`

## `gym/turns/`

Scripted exchanges over the Coach turn wire ([gym_coach.md](../../docs/foundation/mobile/gym_coach.md)
§3.5, §6, §10.1), one JSON file per case. The backend replays each against its loop with a scripted
model and the test as the phone (`backend/test/products/gym/coach/TurnServiceTest.cpp`); a phone's
turn driver replays the same file against a fake server that emits `events` and expects `results`.

| Field | Meaning |
|---|---|
| `case` | The file's name. |
| `seat` | `anon` or `bound`: the seat the open runs under. |
| `open` | The §6.2 body, verbatim. |
| `model` | Server side only: the vendor's reply per model call — `{stop_reason, content}`, `null` for a transport failure, `{"refused": code}` for a round the allowance refused. |
| `events` | The frames the server sends, in order, heartbeats aside. A `done` frame's `allowance` is omitted: it belongs to the environment, and the comparison drops it. `{"await": …}` entries are not frames: they mark where the server waits for the phone — `results` of a `batch`, `stop`, `resume`, or the `timeout` of a silent phone. |
| `results` | The bodies the phone posts, in order, each on the `calls` frame of its `batch` — or of `on`, when a probe answers another batch on purpose. `expect` is `accepted` (the default, 200), `replay` (204) or `coach-turn-order` (409). |
| `stop` | `{"afterModelCall": n}`: Stop is requested as soon as the n-th model call returns, before its batch. |
| `resume` | `{"onBatch": n}`: the phone reconnects on that `calls` frame, before answering, and reads a `snapshot`. |
| `phone` | `silent`: the phone never answers, and the turn ends `interrupted` after `CALL_RESULT_TIMEOUT`. |
| `after` | Steps once the turn ended: `{"open": true}` (the same body again) expects `resumed` and the `snapshot` given; `{"open": {field overrides}}` expects `coach-turn-conflict`; `{"resume": turnId}` expects `coach-turn-unknown`; `{"results": body}` expects `replay`. |
| `modelRequests` | Server side only: per model call, the `toolResults` the request carried, in order — `callId`, `isError`, and the exact `content` or a `contains` fragment. A refusal's content starts with its code in brackets. |
| `notOffered` | Server side only: names absent from the tool list the first model call sent. |
| `serverCalls` | Server side only: the calls the server executor ran (ruling R2). |
| `end` | The terminal `state`, `truncated` where set, and the `code` of a `failed` turn. |

A `failed` turn ends with an `error {code}` frame, every other terminal state with `done {state, truncated?, allowance}`.

## `gym-history.md`

Filtered workout history, complete scope totals and progress, local month indexes, snapshot/live log
links and the display name a workout correction sets. Backend HTTP and Postgres tests cover the
contract; session reads and workout shares keep their own fields.
