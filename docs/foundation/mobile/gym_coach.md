# Gym Coach on the client

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. Sections,
definitions (`D-n`), gate rules (`G-n`) and invariants (`INV-n`) are numbered so that reviews and
code can cite them.

## §0 Status and scope

**Status:** Implemented on the backend and iOS. The backend serves the turn routes (§6.1), and
iOS runs every Coach turn, signed out and signed in, as the tool host over its replica. Android and
the web keep the server Coach of [gym-coach-contract.md](../../gym-coach-contract.md): the server
reads and writes the log itself. Anonymous onboarding (`POST /v1/gym/coach/onboarding`) is a
separate, narrower route: one installation-authenticated request produces a bounded routine
document for atomic local import. No client sends it new requests; iOS draws the onboarding answers
earlier versions kept and imports the routines they drafted. Its installation identity follows §8.

Catalog version 2 adds `propose_workout_change`, the Coach's door to the open workout: the catalog
declares it and its corpus holds the calls (§3.5), and engine A.2 binds its `workoutProposal`
records. The server serves catalog/1 and catalog/2 side by side, and its executor runs
`propose_workout_change`; iOS speaks catalog/1, in which Coach is refused while a workout is open
(§4.1).

**Adoption:**

| Surface | Signed out | Signed in |
|---|---|---|
| Android | no | no |
| iOS | yes | yes |
| Web | — | no |
| MCP (generated catalog) | — | no |

**§0.1 In this spec:**
- the ability catalog every door shares, and its conformance corpora;
- the Coach turn: the model loop on the server, and every ability run by the turn's tool host;
- the gate;
- the wire between a phone and the server during a turn;
- allowances, metering, retention and installation identity for signed-out phones;
- conversation and picture records.

**§0.2 Outside this spec:**
- Replicas, the outbox, holds, pull and claim. They are [the sync engine](../engine.md); §11
  lists what this spec requires of it.
- What the room draws: the four beats, receipts, stances and copy. They are the Gym file's Coach
  boards ([section 08](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1117-1703)) and the
  clients' code.
- The agent rule of each ability (§3.4). It is canon; the catalog encodes it.
- The system prompt's text. It is owner-supplied and preserved by the server.

---

## §1 Definitions

**D-1 Ability.** One thing a lifter can do or read in the gym product: create a routine, log a set,
read last time. An ability has a name, an input schema, a result schema, a rule, a class and an
agent rule.

**D-2 Catalog.** The set of abilities, declared once in `packages/api-contract/gym/catalog.json`.
The server's tool declarations (`gymToolCatalog()`), which give the model tool list and the MCP tool
list, are written in C++ and pinned to it by test: each tool's name, description and input schema
byte-equal as JCS, and its class and agent rule against the tool's access level
(`CatalogContractTest.cpp`). An ability the server declares no tool for is marked
`"declared": false`. The Swift catalog, phrases included, is generated from it (`GymCatalogGen`)
and pinned to the checked-in file by test (`GymCatalogGenTests`). Appendix C lists its abilities.

**D-3 Catalog version.** `catalog/N`. It increments when an ability's name, input, result, class,
agent rule or rule changes. Model-facing descriptions and phrases change without an increment.
`catalog.json` declares the newest version; an ability that a version added carries `since` naming
it, so catalog/N is every ability whose `since` is absent or at most N. The server serves the
versions side by side: a turn opened with catalog/1 is offered and gated by catalog/1's abilities
and rules, a catalog/2 turn by catalog/2's, until §6.2 retires the older. catalog/2 adds
`propose_workout_change` and its gate rule (§5 G-4); its other abilities are catalog/1's.

**D-4 Door.** A way to reach an ability.

| Door | Actor | Account |
|---|---|---|
| UI (web, Android, iOS) | the lifter | web: required; phones: optional |
| Coach (Android, iOS, web) | the Coach model, on the lifter's behalf | web: required; phones: optional |
| MCP | the lifter's own model | required |

**D-5 Agent door.** Coach or MCP.

**D-6 Executor.** The code that runs an ability's rule against a store.
- The **replica executor** (Kotlin, Swift) runs on a phone against its replica (engine D-3).
- The **server executor** (C++) runs on the server against Postgres.

**D-7 Tool host.** Where a Coach turn's abilities run. A phone turn's tool host is that phone's
replica executor, reached over the turn wire (§6). A web turn's tool host is the server executor.

**D-8 Turn.** One lifter message and everything Coach does to answer it. A turn has a client-minted
`turnId`, a CSPRNG id of at most 58 characters (the gym seed bound, engine A.2). The turn record is
the Coach `message` record (§9.1), and `turnId` is its id.

**D-9 Model call.** One vendor request within a turn, numbered `1..MAX_MODEL_CALLS`.

**D-10 Seat.** Whose store a turn runs against: `anon` (signed out) or `bound(A)`
(engine D-3). A turn keeps the seat it opened with until it ends. Any seat change (a sign-in's
move or rebind, a discard decision, a sign-out; engine §7.10) first ends a running turn
`interrupted`.

**D-11 Installation credential.** An opaque server-issued credential held separately from account
authentication (§8). Its lifetime allowance belongs to an installation, without a guarantee
against resets. It admits the anonymous onboarding routes and the turn routes (§6.1) as the
`anon` seat; it grants no access to account routes, and once bound to an account it admits
nothing anonymously.

---

## §2 Principles

1. **One catalog, every door.** Every ability is reachable from every door the seat allows. Every
   agent door reaches an ability under the same rule and agent rule, whether the agent is Coach on
   a phone, Coach on the web, or the lifter's own model over MCP.
2. **Signed out is the phones.** Web and MCP require an account. Signed out, every ability is
   reachable through the phone UI and the phone Coach, against the `anon` replica.
3. **Abilities run where the data is.** A phone turn runs every ability on the phone's replica but
   the shares, which are server records (§4.3). The server never reads or writes a phone's log for
   a phone turn; it sees only the results the phone returns.
4. **The server runs the loop and keeps the words.** The server owns the system prompt, the tool
   list, the model id, the limits and the model's side of the conversation. A client sends a
   question, pictures, earlier conversation text, context reads and ability results. It never
   sends a prompt, a model id, a tool list or model output.
5. **One loop, one gate.** The model loop and the gate exist once, on the server, for every Coach
   surface.
6. **Coach writes are ordinary writes.** An ability Coach runs commits through the same replica
   path as the UI gesture for the same ability (engine §7.1), and syncs, holds and claims the
   same way.

---

## §3 The ability catalog

### §3.1 Declaration

Each catalog entry declares:

| Field | Meaning |
|---|---|
| `name` | Local name, `snake_case`. MCP publishes it as `gym_<name>`. |
| `description` | The model-facing text. One text for every agent door. |
| `input` | JSON Schema with `additionalProperties: false` and `required` at every depth. |
| `result` | JSON Schema of the success result. |
| `class` | `read`, `add`, `change` or `remove`. |
| `agent` | `runs`, `proposes` or `withheld` (§3.4). |
| `seats` | `any`, or `bound` for an ability that needs an account. |
| `phrase` | The step-line words every Coach client prints for this ability. |
| `ui` | The UI gesture that reaches the same ability, or `none`. |

### §3.2 One result, every executor

- **INV-1.** For the same store state, `now`, zone and call, every executor returns the same
  canonical result bytes (§3.3), or the same refusal code.
- **INV-2.** For the same store state and call, every executor writes the same records (type, id
  and field values), apart from stamps and server-assigned `serial` fields.
- **INV-3.** A result carries no value the replica cannot know. A result never carries a predicted
  `serial` value: set numbers in a result MUST come from confirmed rows, even when engine views
  overlay local predictions (engine D-9, §7.6).
- **INV-4.** A read has one projection. The projection MCP receives is the projection Coach
  receives.
- **INV-5.** Derived reads are shared domain rules computed by every executor from its own store:
  last time, last sets, statistics, records, e1RM, session summaries, proposal diffs and the weight
  ladder.

### §3.3 Canonical form

- Results are encoded as RFC 8785 (JCS) JSON.
- Text is NFC-normalized where it enters a store. Instants are integer epoch milliseconds.
- Every non-integer number in a result comes from a rounding step the rule declares (decimal
  places, half away from zero), applied last. The order of the rule's arithmetic is part of the
  rule.
- Every list in a result has a total order; ties break by id.
- A rule that depends on the current time or zone takes `now` and `zone` as inputs.

### §3.4 Agent rules

| `agent` | UI door | Agent door |
|---|---|---|
| `runs` | the gesture lands | the call lands, with a receipt |
| `proposes` | the gesture lands | the call mints a proposal; the lifter applies it |
| `withheld` | the gesture lands | not offered |

- **INV-6.** An ability has one agent rule, the same for Coach and MCP.
- **INV-7.** No ability applies or dismisses a proposal. Apply and dismiss are UI gestures only.
- An ability whose agent rule is not settled in canon is `withheld`.

### §3.5 Conformance corpora

Under `packages/api-contract/gym/`:
- `abilities/<name>.json`: cases of `{case, seat, now, zone, given: {records}, call: {name, input},
  expect}`, where `expect` is `{result, writes}` or `{refused: code}`;
- `rules/<rule>.json`: cases for each derived-read rule (INV-5);
- `turns/*.json`: scripted turn-wire exchanges (§10.1).

An executor **implements the catalog** iff it passes `abilities/` and `rules/` in CI: the C++ server
executor, and the Kotlin and Swift replica executors. CI compares the SHA-256 of canonical bytes.
The corpus MUST include ties, empty pages, a 10,000-set history, fractional loads, and text with
emoji and combining marks.

The corpora hold `abilities/` (18 files), `rules/bodyweight.json` and `turns/`; no case holds a
10,000-set history yet. The server executor writes the `abilities/` expectations, catalog/2's
`propose_workout_change.json` included, and claims every case (`AbilitiesCorpusTest.cpp`); it also claims the `GymEstimate` and training-read cases of
`domain/training-reads.json`, apart from the cases its test lists as other rules. The Swift replica
executor claims every case of catalog/1's files; the share cases, which run on the server executor (§4.3),
it checks as refused on the phone. The Swift, Kotlin and web domain suites claim
`rules/bodyweight.json`. The Kotlin suite marks `abilities/` and `turns/` not applicable, since
Android runs no replica executor. The server loop and the iOS turn driver replay `turns/`.

---

## §4 The turn

### §4.1 Open (client)

1. **Admit locally.** Refuse, keeping the draft, when:
   - there is no connection;
   - the seat is `anon` and the phone holds no installation credential with lifetime USD capacity (§8);
   - the replica has not completed its first pull of history (`coach-replica-syncing`);
   - the question exceeds `MAX_QUESTION_BYTES`, or more than `MAX_PICTURES_PER_MESSAGE` pictures
     are attached.
2. **Record.** In one local transaction, write the lifter message and the Coach message in state
   `running`, with id `turnId` and `replica` set to the id of the replica the commit writes to, which
   the engine gives the commit (engine §7.12), and the device row `runningTurn := turnId` (engine §2.5
   `DeviceRow`), cleared with the terminal state.
3. **Context.** Run `list_sessions` (first page), `list_notes`, `list_exercises` and
   `list_routines` through the executor, and, while a workout is open, `get_session` of it, together
   within `CONTEXT_READ_BYTES`. Record them as
   ability calls on the Coach message. They count toward the read receipt.
4. **History.** Take the text of the newest completed turns of the conversation: at most
   `CONTEXT_TURNS` turns and `CONTEXT_BYTES` bytes.
5. **Pictures.** Attach the model copies (§9.3) of the current message's picture and the previous
   lifter message's picture, at most `CONTEXT_PICTURES`.
6. **Send** the open request (§6.2).

### §4.2 The loop (server)

1. **First content.** One user message holding, in order: the history as one text block marked as
   earlier conversation, the context results, the pictures and the question. The prompt, the tool
   list, the model and the seat's limits are fixed for the whole turn.
2. **Cache.** Every model call marks a cache breakpoint after the tools and system prompt, and one
   on its newest content block.
3. For each model call `1..MAX_MODEL_CALLS`:
   1. If Stop was requested, end the turn `stopped`.
   2. Call the vendor. Stream visible text to the client as it arrives.
   3. On the stop reason:
      - `end_turn` → end the turn `completed`.
      - `tool_use` → pass each ability call, in order, through the gate (§5). Send the admitted
        calls to the tool host as one batch (§4.3) and wait for its results. Answer a refused call
        with an error result carrying its code. Continue.
      - `max_tokens` → end the turn `completed` with `truncated: true`.
      - `refusal` → end the turn `declined`.
      - anything else → end the turn `failed`.
4. Reaching `MAX_MODEL_CALLS` without `end_turn` ends the turn `failed`.

The model's reasoning and every assistant content block stay on the server.

### §4.3 Ability calls on a phone

1. The server sends one `calls` event per batch: `{batch, calls: [{callId, name, input}]}`.
2. The phone runs the batch in order through the replica executor. For each call, one local
   transaction re-validates the input against its schema, measures the result's canonical bytes
   against `TOOL_RESULT_BYTES` before anything commits — a result over it refuses the call
   `result-too-large`, writes dropped, and the record carries no read or minted id — then commits
   the call's writes and records the call on the Coach message: name, minted ids and outcome.
3. The phone posts the batch's results in one request (§6.4).
4. A batch unanswered for `CALL_RESULT_TIMEOUT` ends the turn `interrupted`.
5. The shares (`share_session`, `share_log`, `revoke_share`) are server records. In a `bound` turn
   the server runs them on the server executor and never sends them in a batch; an `anon` turn is
   offered none.

### §4.4 End

- The terminal states are `completed`, `declined`, `failed`, `stopped` and `interrupted`.
- The server sends `done`, keeps the turn's final state for `TURN_LINGER`, then drops the turn.
- The phone writes the final state, answer text and receipt on the Coach message in one local
  transaction.
- Every terminal state keeps the partial text and every write that committed.

### §4.5 Stop, disconnect and resume

- **Stop** ends the turn `stopped` before the next model call or batch. No further batch is sent.
  The model call in flight is never cancelled: it finishes, its tool calls are discarded, and it
  settles at its actual usage. A round that ends talking completes the turn.
- **Disconnect.** The server keeps running the current model call and buffers its text. A pending
  batch waits up to `CALL_RESULT_TIMEOUT`.
- **Resume.** After a reconnect or a return to the foreground, the phone reads the turn stream
  (§6.1). It starts with a `snapshot` of the text so far, the state and any unanswered batch. At
  engine start, a `running` Coach message the device row `runningTurn` names ends `interrupted`,
  whatever its `replica`: the death ended its stream, and the event that would have named it may have
  died with the process (engine §7.12).
- **Background.** While a turn runs, the phone keeps its process alive within the platform
  allowance: an iOS background task, an Android expedited job.
- **Lost turn.** A server restart drops running turns. A resume then answers
  `coach-turn-unknown`, and the phone ends the turn `interrupted`.
- **Writer.** Only the replica named on the Coach message writes its state, text, receipt and
  calls; another device shows a running turn as answering on another device and never writes it. One
  write is excepted: the device whose active replica's id changed from the named one —
  `activeReplicaChanged(previous, replica)` with `previous` the message's `replica` (engine §7.12) —
  ends that `running` turn `interrupted`, under its new id, since the turn's stream ended with its
  identity.
  When the server drops a turn (§4.4) whose `bound` Coach message is still `running`, it MAY write
  `interrupted` on it, as a server-origin write that sets only `state` (engine §6.3).

### §4.6 Web turn

A web turn follows §4.2 with the server executor as its tool host. No batch leaves the server. The
server writes the turn's records as server-origin writes (engine §6.3), and its Coach message
has `replica = srv`, the server's actor (engine D-2). Each create carries its seeded id (G-7) as
its `requestId` (engine §6.3), so a re-executed call replays its create. A web turn requires an
account.

---

## §5 The gate

The server passes every ability call of every Coach turn through the gate, in order, before it
reaches the tool host. A refused call returns to the model as an error result carrying its code,
and the model continues.

- **G-1 Offered.** The name is in the declared catalog version with `agent` other than
  `withheld`.
- **G-2 Seat.** The ability's `seats` admits the turn's seat.
- **G-3 Shape.** The input validates against the ability's schema at every depth. Tools are sent to
  the vendor in strict mode.
- **G-4 One proposal per target.** At most one `proposes` call succeeds per turn for each target
  kind: one for a routine (`propose_routine_change` or `propose_routine_removal`) and one for the open
  workout (`propose_workout_change`). One answer may carry one of each; the lifter decides them
  apart. A catalog/1 turn has the routine kind alone.
- **G-5 One note.** At most one `save_note` call succeeds per turn.
- **G-6 Volume.** At most `MAX_ABILITY_CALLS` calls and `MAX_ADDS` `add` calls per turn. Further
  calls are refused `coach-turn-volume`.
- **G-7 Ids.** The server mints every new record id as a seeded id (engine D-8): seed
  `turnId`, and `n` a turn-wide ordinal over every record the turn creates, in call order and then
  record order. It replaces an id the model supplies for a new record. A replayed call therefore
  replays its create.
- **G-8 Stop.** After Stop, every remaining call is refused.

The gate sends an admitted share (§4.3 step 5) to the server executor and every other admitted call
to the turn's tool host. The executor refuses whatever its rule refuses (INV-1). The replica executor
re-checks G-3.

The system prompt treats pictures, pasted text and ability results as data, never as instructions.
Notes are directive ([brand foundations](../../design/brand-foundations.md), Gym).

MCP calls pass G-1 to G-3 in the server executor, under the same agent rules (INV-6).

---

## §6 The wire

### §6.1 Routes

| Route | Purpose |
|---|---|
| `POST /v1/gym/coach/turns` | Open a turn. The response is `text/event-stream`. |
| `GET /v1/gym/coach/turns/{turnId}` | Resume a turn's stream. |
| `POST /v1/gym/coach/turns/{turnId}/results` | Answer a batch. |
| `POST /v1/gym/coach/turns/{turnId}/stop` | Request Stop. |
| `POST /v1/ai/installations` | Issue an installation credential (§8). |
| `GET /v1/ai/installations/current` | Read installation binding and allowance (§8). |
| `POST /v1/ai/installations/bind` | Bind its usage to a verified account (§8). |

A turn route authenticates with a session (seat `bound(A)`) or an installation credential (seat `anon`). Every
request of a turn uses the seat that opened it. A deployment with more than one server process
MUST route every request of a turn to the process that holds it.
The turn routes are served by `backend/products/gym/coach/` and mounted only where a vendor key
is configured, as `POST /v1/gym/ask` is. Installation credentials authorize them, beside
`POST /v1/gym/coach/onboarding` and its request-scoped recovery read; an installation bound to an
account is refused `device_bound` and signs in instead.

### §6.2 Open

```json
{ "catalog": "catalog/2",
  "turnId": "tn_…",
  "question": "…",
  "pictures": [{ "id": "…", "mediaType": "image/jpeg", "data": "<base64>" }],
  "history": [{ "role": "lifter", "text": "…" }, { "role": "coach", "text": "…" }],
  "context": [{ "name": "list_notes", "input": {}, "result": { } }] }
```

Admission, in order:
1. **Catalog.** A version retired more than `CATALOG_RETIRE_DAYS` after its successor shipped is
   refused `coach-update-required`.
2. **Shape.** The body is within `OPEN_BODY_BYTES`; the limits of §4.1 hold; `context` names only
   the context reads of §4.1 step 3 (`get_session` only in a catalog/2 turn, of the open workout),
   within `CONTEXT_READ_BYTES`. Otherwise `coach-bad-request`.
3. **Identity.** An unseen `turnId` opens a turn. A seen `turnId` with the same body digest
   resumes it. A seen `turnId` with another digest is refused `coach-turn-conflict`.
4. **Allowance.** Each vendor round reserves USD against the verified principal (§7.1).
5. **Capacity.** The applicable free pools or funded grant and principal concurrency limit have room (§7.3).

### §6.3 Events

| Event | Data |
|---|---|
| `snapshot` | `{text, state, calls?}`: the first event of a resume. |
| `text` | `{delta}`: visible answer text, in order. |
| `calls` | `{batch, calls: [{callId, name, input}]}` |
| `done` | `{state, truncated?, allowance}`; allowance follows the shared USD read contract |
| `error` | `{code}` |

Heartbeat comments keep an idle stream open. A refusal before the stream starts is an HTTP error
with a JSON body `{error, code}`. After the stream starts, it is an `error` event, and the stream
closes.

### §6.4 Results

```json
{ "batch": 2,
  "results": [{ "callId": "…", "ok": true, "result": { } },
              { "callId": "…", "ok": false, "code": "record-dead" }] }
```

The results answer exactly the batch's `callId`s, each result carrying exactly its keys and within
`TOOL_RESULT_BYTES`; the body holds at most `MAX_ABILITY_CALLS` results and
`MAX_ABILITY_CALLS × TOOL_RESULT_BYTES + 16 KiB`. The body that answered a batch, sent again,
answers `204`. Any other body — including one for a batch that timed out — is refused
`coach-turn-order`.

### §6.5 Codes

| Code | Meaning |
|---|---|
| `coach-bad-request` | The body breaks §6.2 or §6.4. |
| `coach-update-required` | The catalog version is retired. |
| `coach-turn-conflict` | A seen `turnId` with a different body. |
| `coach-turn-unknown` | No such turn on this server. |
| `coach-turn-order` | Results that do not answer the pending batch. |
| `coach-turn-volume` | An ability call over G-6. |
| `coach-rate-limited` | The technical burst or concurrency limit is reached; retry later. |
| `subject_exhausted` | The device/account USD allowance cannot cover this request. |
| `invalid_installation` | The installation credential is missing or invalid. |
| `device_bound` | This installation is permanently associated with an account; sign in. |
| `free_day_exhausted` | Shared free capacity is unavailable for this UTC day; include the daily budget reset. |
| `free_month_exhausted` | Shared free capacity is unavailable for this UTC month. |
| `concurrency_exhausted` | The principal already has its permitted number of unresolved calls. |
| `funding_required` | One access has no active funded allowance period. |
| `debt_outstanding` | An unresolved unfunded accounting overrun blocks further admission. |
| `coach-replica-syncing` | Local only: the replica's history is still arriving. |
| `coach-busy` | The process is at capacity or its cost fuse is open. |
| `coach-vendor-error` | The vendor failed. |
| `coach-stream-replaced` | Another stream took over this turn; sent as the closing `error` of the stream it replaced. |

---

## §7 Allowances, metering and retention

### §7.1 Allowances

The backend owns exactly three tiers. Amounts are USD of model cost, never question counts:

| Tier | Individual allowance | Period |
|---|---|---|
| Anonymous | $0.05 per installation credential | Lifetime |
| Verified logged-in | $0.25 per account, including associated anonymous spend from the current month | UTC calendar month |
| Windmill One | $7 per funded account period | Subscription billing period; owner grants use UTC calendar months |

Every hosted AI cost, including background Journal work, consumes the individual allowance.
Balances are shared across account devices and products. An installation binds permanently to one verified
account at sign-in, after which anonymous admission for that installation is closed. Binding retains
lifetime usage and carries current-month anonymous spend into the free account allowance. Existing
unresolved holds and debt remain attributable; sign-in cannot erase them.

Paid access requires a funded grant, not subscription status alone. A successfully paid,
non-prorated monthly One event funds its explicit billing period. Owner access automatically funds
a calendar month when no subscription grant is current. Grants cannot overlap within one account
and funding source. A current subscription takes priority over the owner grant; capacity is never
combined, and an expired subscription does not prevent owner calendar funding.
Unused paid capacity can cross a calendar boundary, but expires at its funded period end.

Every vendor round MUST estimate tokens for its actual system prompt, messages/history, tools,
results and images, then atomically reserve estimated input cost plus its full output cap sent to the provider
against individual and applicable shared capacity before dispatch. Coach can reduce that cap to
fit the locked balances, down to its 1,024-token policy floor; the input estimate remains complete.
The estimate is not a hard
spending ceiling. Complete usage settles once at actual cost; unused reservation is released and
underestimates are charged in full. Settlement atomically absorbs variance when every original
funding budget can cover it with other unresolved holds and bound-device account usage included,
and no existing debt. Covered variance creates no debt or Issue. Unfunded variance creates debt;
a new period cannot fund an old call. Ambiguous sends and incomplete usage remain held. Retrying
an already dispatched reservation MUST NOT send it again. Unresolved principal calls and overrun
debt remain effective after a period ends.

`done.allowance` carries exact decimal USD limit, used, reserved and remaining; its period;
individual `resetsAtMs`; and the constrained scope's `budgetResetsAtMs`. Lifetime reset is null.
A free daily pause must identify the daily boundary rather than the individual monthly reset.
A positive balance does not promise that a particular request can fit its reservation.

### §7.2 Metering and implementation boundary

Every provider request records bounded product, operation, run/iteration, model, outcome and
supported token usage. The durable ledger owns admission; telemetry mirrors do not. Neither logs
nor telemetry contain prompts, images, account/device identifiers or raw vendor errors.

[USD AI allowances](../../../backend/AI_ALLOWANCES.md) describes the implemented backend mode,
which defaults off in configuration and is enabled in production. Authenticated Claude paths use
it. Anonymous onboarding has a separate installation boundary. Account Coach over `POST /v1/gym/ask`
uses operation `ask`; a phone turn uses operation `turn` on both seats, reserving each round for
the account or for the installation.

Claude reservations use local per-request approximate token counts and the full output cap sent to the provider.
Anonymous onboarding uses one bounded model call with public exercises and no account tools.
Approximation does not guarantee that a request fits. Full actual cost is recorded; an overrun
creates debt only when original funding cannot cover it. Voice also needs supported audio
accounting and complete audio/text pricing. This spec does not promise that either unsupported
edge is available.

### §7.3 Shared capacity and owner alerts

Anonymous and free accounts share $100 per UTC calendar month and $5 per UTC day. Paid calls use
only their funded grants and cannot consume either free pool. There is no additional generic
service-wide monthly ceiling. Admission checks estimated reservations against the free pools or
funded grant; actual cost can exceed an estimate and is recorded in full. The process fuse is an
additional safeguard.

A principal may have one unresolved free call or two unresolved paid calls. Reservations,
dispatched calls and uncertain calls all occupy slots. A vendor error answered before the message
started consumed nothing and settles at zero; only a send the vendor may have taken stays uncertain.
The backend enforces this across processes, tier changes and permanent device binding. Product burst
protection remains separate. A process runs two model calls at once; a turn holds that capacity only
while its round streams, never while it waits on its phone, and at most 64 turns are alive in a
process in any state. Both bounds refuse an open `coach-busy`.

Each budget emits a durable owner-email alert when settled plus held usage crosses 50%, 80% or 95%.
Alert enqueue is atomic with the budget write, and delivery uses leased claims and retry. The
configured owner receives bounded scope, funding source and amounts, without user identifiers or
content. These operational alerts are not customer upgrade messages.

### §7.4 What the server keeps

- Usage rows, allowance state and grant records.
- A running turn, in memory, until `TURN_LINGER` after it ends.

It never logs a question, answer, picture, history, context or ability result. Anonymous onboarding
persists an input digest and a validated routine result for request recovery, without the input
text or image. Its result expires after seven days; a compact replay tombstone prevents redispatch.
Conversations are gym records (§9.1); the server holds a `bound` seat's as it holds the rest of
the account's gym records. Pictures stay on the phone (§9.3).
Error records carry the code, sizes, `turnId` and model call number only. `ANON_RETENTION_DAYS` applies to expendable operational records. The lifetime allowance and
permanent binding must survive record cleanup and account erasure without allowing a fresh grant.

---

## §8 Installation identity

### §8.1 Flow

1. `POST /v1/ai/installations` issues a 256-bit opaque credential and its lifetime USD allowance.
2. The client stores the credential securely and sends it in `X-Windmill-Installation` for
   installation reads, anonymous onboarding and `anon` turns. The server stores only a digest of
   the token.
3. `GET /v1/ai/installations/current` reads binding and allowance without issuing a replacement.
4. After verified sign-in, `POST /v1/ai/installations/bind` carries both the account credential and
   installation credential. Binding attributes usage independently of Add/Discard content choices.
   Repeating the same binding is idempotent; another account cannot rebind it.

### §8.2 iOS

The installation credential uses a separate Keychain service from account credentials and survives
ordinary sign-out. A missing credential on first use may acquire one; an invalid existing credential
must not silently mint a replacement. Sign-in binds before account Coach becomes available.
App Attest and DeviceCheck are not launch requirements. Erasing or resetting the installation is
not guaranteed to preserve its identity; this is an installation allowance, not proof of a unique
physical phone. IP and global budgets bound that exposure.

### §8.3 Android

Android Coach remains account-only. Delivering anonymous Android onboarding requires its own
secure credential storage, local routine import and account-adoption integration. The shared
installation policy does not imply Android delivery or reinstall-resistant identity.

### §8.4 Failure and privacy

- Invalid credentials are refused; the room retains the draft and offers a recovery without
  silently replacing the credential.
- The subject is an opaque installation identity, absent from telemetry. Its backend binding to
  one account is permanent and cannot be changed to replenish free usage.
- Signing in retains lifetime usage, closes anonymous admission for that device and includes its
  current-month anonymous spend in the account's free allowance. Unresolved calls remain held.
- A caller that erases or deliberately omits the installation signal cannot be associated with it
  by this mechanism. No reset-proof or account-association guarantee is made for such a caller.
- Issuance and generation have durable IP limits. Only the configured trusted proxy's client-IP
  header is accepted in production; local direct mode uses the socket peer. IP rate records use
  keyed digests and bounded retention, and raw addresses never enter telemetry.

### §8.5 Deployment secrets

`AI_INSTALLATIONS_ENABLED` requires durable USD allowances and `AI_INSTALLATION_IP_HMAC_KEY`.
Production fixes `AI_INSTALLATION_PROXY_MODE=cloudflare` behind the Cloudflare-only Caddy gate;
the server has no public host port. Defaults are ten credential issues per IP per UTC day and
thirty new generations per IP per UTC hour. Secrets and credentials never appear in logs.

---

## §9 Conversations and pictures

### §9.1 Records

Conversations are records in the `self/gym` scope. They sync for `bound` seats and stay on the
device for `anon`. At sign-in, signed-out conversations join the account with the rest of the
signed-out gym data: silently where the account holds no gym records, otherwise under the gym
signed-out decision (engine §7.10). Gym's registry declares `thread` and `message` (engine A.2);
the server Coach's legacy conversations stay in the gym backend's Coach tables and are not adopted.

| Type | Identity | Fields |
|---|---|---|
| `thread` | minted | `title` const ≤`MAX_QUESTION_BYTES` bytes: the first text message verbatim, or `Photo` |
| `message` | minted, `parent: thread` | `threadId` const; `role` const ∈ {lifter, coach}; `replica` const; `text` (bytes: ≤`MAX_QUESTION_BYTES` from the lifter, ≤`MAX_ANSWER_BYTES` from Coach); `state` ∈ {running, completed, declined, failed, stopped, interrupted}; `truncated`; `receipt` ≤`MAX_RECEIPT_BYTES`; `calls` ≤`MAX_CALLS_BYTES`; `pictures` const; `at` time |

- `state` moves from `running` to a terminal state. A terminal state beats `running`, and a
  writer's terminal state (`completed`, `declined`, `failed`, `stopped`) beats `interrupted`, in a
  merge regardless of stamp: `state` is a `ranked` field (engine §3.2).
- Once `state` is a writer's terminal state, it and `text`, `receipt` and `calls` are final. A
  writer's terminal write, with its text, receipt and calls, is admitted over `interrupted`.
- A lifter message carries `threadId`, `role`, `text`, `pictures` and `at` only.
- `receipt` and `calls` are bounded in bytes of their JCS encoding.

### §9.2 Receipt

- The read receipt counts what the executor returned to the model in the turn, context reads
  included, by identity, under the read receipt's four rules
  ([brand foundations](../../design/brand-foundations.md), Gym).
- `results` lists the ids of records the turn created. A proposal of either kind minted in the turn carries
  `threadId`.
- A receipt stores ids only. The room reads names and serials from the records when it draws.
- The receipt and the step line derive from `calls`, never from the model's text.
- A call's record holds the identities its read served that no earlier call of the turn holds.
  When `calls` has no room for them, the record holds their counts alone, `readTruncated: true`;
  the receipt adds those counts to its identity count and carries `truncated: true`. The call is
  never refused for `MAX_CALLS_BYTES`; only a call whose bare record does not fit is refused
  `coach-turn-volume`.

### §9.3 Pictures

- The phone stores the original, within `PICTURE_BYTES` and `PICTURE_EDGE`.
- The **model copy** is a JPEG with a long edge of at most `MODEL_PICTURE_EDGE` and at most
  `MODEL_PICTURE_BYTES`, made once and stored beside the original.
- On every seat, a picture leaves the phone only as the model copy inside an open request. Its
  `pictures` entry is `localOnly: true`, and a later sign-in does not upload it. Another device
  draws it as a picture held on the phone that sent it.
- A `pictures` entry is `{id, mediaType, localOnly?}`. Its `id` names the picture on the phone that
  sent it, in that phone's `picture:<id>` device row.
- Copy about a sent picture says that a copy goes to the model vendor to read for the answer, that
  Windmill stores none, and the vendor's retention as verified at release.

---

## §10 Testing and telemetry

### §10.1 Testing

- The server loop runs in tests against the fake model provider, with a fake tool host playing
  phone results.
- Each phone's turn driver passes `turns/` against a fake server: text, batches, parallel calls,
  resume from `snapshot`, Stop, `max_tokens`, `refusal`, `error`, a lost turn and a result timeout.
- Each executor passes `abilities/` and `rules/` (§3.5).

### §10.2 Telemetry

A phone sends one `coach_turn` event per turn that opened: state, seat, the code a failed turn
ended on, ability calls and refusals as counts, answer bytes and duration; and one `coach_ability`
event per ability call it ran: the catalog name and the outcome (`ok` or the refusal code). Neither
carries text, pictures, results or ids. iOS sends both
([IOS_OBSERVABILITY.md](../../IOS_OBSERVABILITY.md)): `coach_turn` with its ability calls,
refusals and answer bytes as counts, and a `coach_ability` for every call its executor ran, the
four context reads included. Android sends neither. The server logs its own side of a turn
(`coach_turn` and `coach_batch` lines, `backend/OBSERVABILITY.md`), the calls a phone refused
counted by code.

---

## §11 Requirements on the sync engine

A phone Coach requires a gym replica per [the engine](../engine.md) with:
- the account's full history: no boot window on `session` and `set`;
- a signal that the replica's first pull of history is complete;
- the active replica's id, given to a commit, and the `activeReplicaChanged` event that announces
  every change of it (engine §7.12);
- a device row `runningTurn` in `device/gym`;
- `proposal` and `workoutProposal` records mintable by a replica, with `changes` computed by the shared diff rule and
  re-checked by the server on admission;
- `thread` and `message` as full records with the fields and merge rule of §9.1, `localOnly`
  pictures held in `picture:<id>` device rows, and a proposal's `threadId` a `ref<thread>` its
  replica writes. Gym's registry declares `thread`, `message`, `runningTurn` and `picture:<id>`
  (engine A.2, §2.4); a proposal's `threadId` stays a plain string until the server Coach's legacy
  conversations are gone;
- the derived reads of INV-5 computed on the replica.

---

## Appendix A: Constants

| Name | Value |
|---|---|
| `MAX_MODEL_CALLS` | 8 |
| `MAX_ABILITY_CALLS` | 12 |
| `MAX_ADDS` | 6 |
| `MAX_QUESTION_BYTES` | 8,000 |
| `MAX_ANSWER_BYTES` | 128 KiB |
| `MAX_RECEIPT_BYTES` | 16 KiB |
| `MAX_CALLS_BYTES` | 32 KiB |
| `MAX_PICTURES_PER_MESSAGE` | 1 |
| `CONTEXT_TURNS` | 24 |
| `CONTEXT_BYTES` | 24,000 |
| `CONTEXT_PICTURES` | 2 |
| `CONTEXT_READ_BYTES` | 64 KiB |
| `PICTURE_BYTES` | 5 MiB |
| `PICTURE_EDGE` | 4096 px |
| `MODEL_PICTURE_EDGE` | 1568 px |
| `MODEL_PICTURE_BYTES` | 1 MiB |
| `TOOL_RESULT_BYTES` | 16 KiB |
| `OPEN_BODY_BYTES` | 4 MiB |
| `CALL_RESULT_TIMEOUT` | 60 s |
| `TURN_LINGER` | 10 min |
| `ASK_BURST` | 3 |
| `ASK_PER_DAY` | 10 |
| `AI_ANONYMOUS_LIFETIME_USD` | 0.05 |
| `AI_LOGGED_IN_MONTHLY_USD` | 0.25 |
| `AI_ONE_PERIOD_USD` | 7 |
| `AI_FREE_MONTHLY_USD` | 100 |
| `AI_FREE_DAILY_USD` | 5 |
| Free principal concurrency | 1 |
| Paid principal concurrency | 2 |
| `AI_INSTALLATION_ISSUES_PER_DAY` | 10 |
| `AI_INSTALLATION_GENERATIONS_PER_HOUR` | 30 |
| `ANON_RETENTION_DAYS` | 35 |
| `CATALOG_RETIRE_DAYS` | 120 |

## Appendix B: Open decisions

- **B-1 Agent rules for the log.** Appendix C marks these abilities `withheld` until canon sets
  them. Coach never logs, fixes or deletes a set, finishes or discards a workout, or writes a
  bodyweight ([brand foundations](../../design/brand-foundations.md), Gym); MCP runs `start_session`, `log_set`, `log_sets`, `finish_session`,
  `discard_session` and `import_session`. Proposals exist for routines and for the open workout,
  whose review the Gym file's Coach boards draw (08.55–08.57); `proposes` elsewhere needs a review
  drawn in canon.
- **B-2 The model per seat.** Decided: an `anon` turn runs on Sonnet 5 under the anonymous
  onboarding effort and 2,000-token output ceiling, so a round of the full catalog fits the
  $0.05 lifetime allowance; a `bound` turn runs on the Coach model (Opus 5) under
  `COACH_MAX_OUTPUT_TOKENS`. Both reserve adaptively down to the 1,024-token floor.
- **B-3 Reservation estimates.** Evaluate per-request estimates against actual usage across text,
  tools and images. Do not describe approximate admission as a hard spending ceiling. Original
  funding absorbs covered variance; unfunded overrun debt and ambiguous holds remain accounted
  for. The free pools and concurrency policy are set.
- **B-4 Android delivery.** Implement and verify secure installation storage, local onboarding
  import and account adoption before opening anonymous Coach on Android.
- **B-5 Evaluation.** Signed-out conversations exist only on phones. Decide whether a lifter can
  send a conversation to Windmill for review.

## Appendix C: The catalog

`save_note` is `bound`: signed out, Notes is a sign-in door on the phone (ledger 7g).

| Ability | Class | Agent | Seats | UI |
|---|---|---|---|---|
| `list_routines` | read | runs | any | Routines |
| `list_exercises` | read | runs | any | movement picker |
| `list_sessions` | read | runs | any | Log, history filters |
| `get_session` | read | runs | any | workout detail |
| `get_sessions` | read | runs | any | none |
| `last_time` | read | runs | any | logger prefill |
| `get_last_times` | read | runs | any | logger prefill |
| `get_stats` | read | runs | any | Progress |
| `get_record` | read | runs | any | movement record |
| `list_notes` | read | runs | any | Notes |
| `list_bodyweight` | read | runs | any | Bodyweight |
| `get_preferences` | read | runs | any | Settings |
| `create_routine` | add | runs | any | routine editor |
| `create_exercise` | add | runs | any | movement editor |
| `save_note` | add | runs | bound | Notes, new note |
| `share_session` | add | runs | bound | Share |
| `share_log` | add | runs | bound | Share log |
| `propose_routine_change` | change | proposes | any | routine editor |
| `propose_routine_removal` | remove | proposes | any | routine delete |
| `propose_workout_change` (catalog/2) | change | proposes | any | This workout, Edit sets |
| `revoke_share` | remove | runs | bound | Share |
| `start_session` | add | withheld (B-1) | any | Start workout |
| `log_set` | add | withheld (B-1) | any | logger |
| `log_sets` | add | withheld (B-1) | any | backfill |
| `import_session` | add | withheld (B-1) | any | backfill |
| `log_bodyweight` | add | withheld (B-1) | any | Bodyweight |
| `finish_session` | change | withheld (B-1) | any | Finish |
| `fix_set` | change | withheld (B-1) | any | set editor |
| `correct_session` | change | withheld (B-1) | any | workout correction |
| `update_exercise` | change | withheld (B-1) | any | movement editor |
| `edit_note` | change | withheld (B-1) | any | Notes |
| `reorder_notes` | change | withheld (B-1) | any | Notes |
| `set_preferences` | change | withheld (B-1) | any | Settings |
| `delete_set` | remove | withheld (B-1) | any | set delete |
| `discard_session` | remove | withheld (B-1) | any | Discard |
| `delete_note` | remove | withheld (B-1) | any | Notes |
| `delete_bodyweight` | remove | withheld (B-1) | any | Bodyweight |
