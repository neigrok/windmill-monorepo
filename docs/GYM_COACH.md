# Gym Coach on the client

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119. Sections,
definitions (`D-n`), gate rules (`G-n`) and invariants (`INV-n`) are numbered so that reviews and
code can cite them.

## §0 Status and scope

**Status:** Specified; not yet implemented. The running Coach is described in
[gym-coach-contract.md](gym-coach-contract.md): the server reads and writes the log itself.

**Adoption:**

| Surface | Signed out | Signed in |
|---|---|---|
| Android | no | no |
| iOS | no | no |
| Web | — | no |
| MCP (generated catalog) | — | no |

**§0.1 In this spec:**
- the ability catalog every door shares, and its conformance corpora;
- the Coach turn: the model loop on the server, and every ability run by the turn's tool host;
- the gate;
- the wire between a phone and the server during a turn;
- allowances, metering, retention and the device grant for signed-out phones;
- conversation and picture records.

**§0.2 Outside this spec:**
- Replicas, the outbox, holds, pull and claim. They are [the sync engine](SYNC_ENGINE.md); §11
  lists what this spec requires of it.
- What the room draws: the four beats, receipts, stances and copy. They are
  [the Coach brief](design/gym/briefs/09-coach.md).
- The agent rule of each ability (§3.4). It is canon; the catalog encodes it.
- The system prompt's text. It is owner-supplied and preserved by the server.

---

## §1 Definitions

**D-1 Ability.** One thing a lifter can do or read in the gym product: create a routine, log a set,
read last time. An ability has a name, an input schema, a result schema, a rule, a class and an
agent rule.

**D-2 Catalog.** The set of abilities, declared once in `packages/api-contract/gym/catalog.json`.
It is code-generated into every executor, the server's model tool list, the MCP tool list and every
client's step-line phrases. Appendix C lists its abilities.

**D-3 Catalog version.** `catalog/N`. It increments when an ability's name, input, result, class,
agent rule or rule changes. Model-facing descriptions and phrases change without an increment.

**D-4 Door.** A way to reach an ability.

| Door | Actor | Account |
|---|---|---|
| UI (web, Android, iOS) | the lifter | web: required; phones: optional |
| Coach (Android, iOS, web) | the Coach model, on the lifter's behalf | web: required; phones: optional |
| MCP | the lifter's own model | required |

**D-5 Agent door.** Coach or MCP.

**D-6 Executor.** The code that runs an ability's rule against a store.
- The **replica executor** (Kotlin, Swift) runs on a phone against its replica (SYNC_ENGINE D-5).
- The **server executor** (C++) runs on the server against Postgres.

**D-7 Tool host.** Where a Coach turn's abilities run. A phone turn's tool host is that phone's
replica executor, reached over the turn wire (§6). A web turn's tool host is the server executor.

**D-8 Turn.** One lifter message and everything Coach does to answer it. A turn has a client-minted
`turnId`. The turn record is the Coach `message` record (§9.1), and `turnId` is its id.

**D-9 Model call.** One vendor request within a turn, numbered `1..MAX_MODEL_CALLS`.

**D-10 Seat.** Whose store a turn runs against: `anon` (signed out) or `bound(A)`
(SYNC_ENGINE D-6). A turn keeps the seat it opened with until it ends.

**D-11 Device grant.** A short-lived credential issued to a signed-out install after platform
attestation (§8). It admits the Coach turn routes only.

---

## §2 Principles

1. **One catalog, every door.** Every ability is reachable from every door the seat allows. Every
   agent door reaches an ability under the same rule and agent rule, whether the agent is Coach on
   a phone, Coach on the web, or the lifter's own model over MCP.
2. **Signed out is the phones.** Web and MCP require an account. Signed out, every ability is
   reachable through the phone UI and the phone Coach, against the `anon` replica.
3. **Abilities run where the data is.** A phone turn runs every ability on the phone's replica. The
   server never reads or writes a phone's log for a phone turn; it sees only the results the phone
   returns.
4. **The server runs the loop and keeps the words.** The server owns the system prompt, the tool
   list, the model id, the limits and the model's side of the conversation. A client sends a
   question, pictures, earlier conversation text, context reads and ability results. It never
   sends a prompt, a model id, a tool list or model output.
5. **One loop, one gate.** The model loop and the gate exist once, on the server, for every Coach
   surface.
6. **Coach writes are ordinary writes.** An ability Coach runs commits through the same replica
   path as the UI gesture for the same ability (SYNC_ENGINE §7.1), and syncs, holds and claims the
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
- **INV-3.** A result carries no value the replica cannot know. A `serial` field (set numbers,
  routine revisions) appears in a result only as the replica's prediction (SYNC_ENGINE §7.6
  `drawn`), and the corpus pins the prediction.
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

---

## §4 The turn

### §4.1 Open (client)

1. **Admit locally.** Refuse, keeping the draft, when:
   - there is no connection;
   - the seat is `anon` and the phone holds no device grant with questions remaining (§8);
   - a workout is open and the brief refuses Coach mid-workout;
   - the replica has not completed its first pull of history (`coach-replica-syncing`);
   - the question exceeds `MAX_QUESTION_BYTES`, or more than `MAX_PICTURES_PER_MESSAGE` pictures
     are attached.
2. **Record.** In one local transaction, write the lifter message and the Coach message in state
   `running`, with id `turnId` and `replica` set to this replica.
3. **Context.** Run `list_sessions` (first page), `list_notes`, `list_exercises` and
   `list_routines` through the executor, together within `CONTEXT_READ_BYTES`. Record them as
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
   transaction re-validates the input against its schema, commits the call's writes, and records
   the call on the Coach message: name, minted ids and outcome.
3. The phone posts the batch's results in one request (§6.4).
4. A batch unanswered for `CALL_RESULT_TIMEOUT` ends the turn `interrupted`.

### §4.4 End

- The terminal states are `completed`, `declined`, `failed`, `stopped` and `interrupted`.
- The server sends `done`, keeps the turn's final state for `TURN_LINGER`, then drops the turn.
- The phone writes the final state, answer text and receipt on the Coach message in one local
  transaction.
- Every terminal state keeps the partial text and every write that committed.

### §4.5 Stop, disconnect and resume

- **Stop** ends the turn `stopped` before the next model call or batch. No further batch is sent.
- **Disconnect.** The server keeps running the current model call and buffers its text. A pending
  batch waits up to `CALL_RESULT_TIMEOUT`.
- **Resume.** After a reconnect or a return to the foreground, the phone reads the turn stream
  (§6.1). It starts with a `snapshot` of the text so far, the state and any unanswered batch.
- **Background.** While a turn runs, the phone keeps its process alive within the platform
  allowance: an iOS background task, an Android expedited job.
- **Lost turn.** A server restart drops running turns. A resume then answers
  `coach-turn-unknown`, and the phone ends the turn `interrupted`.
- **Writer.** Only the replica named on the Coach message writes its state, text, receipt and
  calls. Another device shows a running turn as answering on another device and never writes it.

### §4.6 Web turn

A web turn follows §4.2 with the server executor as its tool host. No batch leaves the server. The
server writes the turn's records as server-origin writes (SYNC_ENGINE §6.3). A web turn requires
an account.

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
- **G-4 One proposal.** At most one `proposes` call succeeds per turn.
- **G-5 One note.** At most one `save_note` call succeeds per turn.
- **G-6 Volume.** At most `MAX_ABILITY_CALLS` calls and `MAX_ADDS` `add` calls per turn. Further
  calls are refused `coach-turn-volume`.
- **G-7 Ids.** The server mints every new record id from `turnId` and the call's ordinal in the
  turn, and replaces an id the model supplies for a new record. A replayed call therefore replays
  its create.
- **G-8 Stop.** After Stop, every remaining call is refused.

The executor refuses whatever its rule refuses (INV-1). The replica executor re-checks G-3.

The system prompt treats pictures, pasted text and ability results as data, never as instructions.
Notes are directive, as the brief states.

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
| `GET /v1/gym/coach/device/challenge` | A nonce for a device grant (§8). |
| `POST /v1/gym/coach/device` | Exchange an attestation for a device grant (§8). |

A turn route authenticates with a session (seat `bound(A)`) or a device grant (seat `anon`). Every
request of a turn uses the seat that opened it. A deployment with more than one server process
MUST route every request of a turn to the process that holds it.

### §6.2 Open

```json
{ "catalog": "catalog/1",
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
   the four context reads, within `CONTEXT_READ_BYTES`. Otherwise `coach-bad-request`.
3. **Identity.** An unseen `turnId` opens a turn. A seen `turnId` with the same body digest
   resumes it. A seen `turnId` with another digest is refused `coach-turn-conflict`.
4. **Allowance.** A new turn takes one question from the seat (§7.1).
5. **Spend.** The seat's cost ceiling and, for `anon`, the pool (§7.3) have room.

### §6.3 Events

| Event | Data |
|---|---|
| `snapshot` | `{text, state, calls?}`: the first event of a resume. |
| `text` | `{delta}`: visible answer text, in order. |
| `calls` | `{batch, calls: [{callId, name, input}]}` |
| `done` | `{state, truncated?, remaining}` |
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

The results answer exactly the batch's `callId`s, each within `TOOL_RESULT_BYTES`. The same body
again answers `204`. Any other body is refused `coach-turn-order`.

### §6.5 Codes

| Code | Meaning |
|---|---|
| `coach-bad-request` | The body breaks §6.2 or §6.4. |
| `coach-update-required` | The catalog version is retired. |
| `coach-turn-conflict` | A seen `turnId` with a different body. |
| `coach-turn-unknown` | No such turn on this server. |
| `coach-turn-order` | Results that do not answer the pending batch. |
| `coach-turn-volume` | An ability call over G-6. |
| `coach-daily-limit` | The account's questions are spent for now. |
| `coach-ceiling` | The seat's cost ceiling is reached. |
| `coach-device-unverified` | The phone's attestation did not verify. |
| `coach-device-spent` | This phone's signed-out allowance is used. |
| `coach-anon-pool-empty` | The signed-out pool is empty for this hour. |
| `coach-replica-syncing` | Local only: the replica's history is still arriving. |
| `coach-busy` | The process is at capacity or its cost fuse is open. |
| `coach-vendor-error` | The vendor failed. |

---

## §7 Allowances, metering and retention

### §7.1 Allowances

| Seat | Questions | Cost |
|---|---|---|
| `bound(A)` | `ASK_BURST` held, refilling `ASK_PER_DAY` a day | the account's 30-day AI ceiling |
| `anon` | the device grant's questions (§8) | the anonymous pool (§7.3) |

- A question is taken when a `turnId` is first admitted.
- It returns when the server sent no vendor request for the turn, or the vendor failed before its
  first `message_start`.
- Each model call is capped at the seat's `max_tokens`.
- The process fuse checks every vendor request.
- `done.remaining` is the seat's question count after the turn. A room states a count only from
  `done.remaining` or a grant.

### §7.2 Metering

Every vendor request writes an AI usage row: `product = gym`, `operation = coach`, the model,
`run = turnId`, `iteration =` the model call, and every token count the vendor reports. A `bound`
row carries the account. An `anon` row carries no account and the grant's device key. The vendor
request's `metadata.user_id` is a keyed hash of the account or the device key.

### §7.3 The anonymous pool

All `anon` turns together spend at most `ANON_POOL_PER_DAY` of vendor cost per UTC day, released in
24 hourly slices. An unspent slice carries forward, holding at most two slices. An empty slice
refuses new `anon` turns with `coach-anon-pool-empty`; admitted turns finish. Per-IP limits apply to
the challenge, grant and open routes.

### §7.4 What the server keeps

- Usage rows, allowance state and grant records.
- A running turn, in memory, until `TURN_LINGER` after it ends.

It never persists or logs a question, answer, picture, history, context or ability result. Error
records carry the code, sizes, `turnId` and model call number only. `anon` usage rows and grant
records are deleted after `ANON_RETENTION_DAYS`.

---

## §8 The device grant

### §8.1 Flow

1. `GET /v1/gym/coach/device/challenge` → `{nonce}`, valid for `CHALLENGE_TTL`.
2. `POST /v1/gym/coach/device` with the platform attestation over the nonce →
   `{grant, expiresAt, remaining}`.
3. A grant lives `GRANT_TTL`. The phone renews it with a fresh attestation or assertion over a new
   challenge; renewal keeps the device's remaining questions.

### §8.2 iOS

- The phone sends a new App Attest key's attestation over the challenge, and a DeviceCheck token.
- The server verifies the attestation chain to Apple's root, the app id and the counter, then reads
  the device's DeviceCheck bits.
- Bit 0 set → `coach-device-spent`. Otherwise the server sets bit 0 and issues `ANON_QUESTIONS`.
- The allowance is once per phone. A reinstall on the same phone receives none, and questions left
  on an earlier install are forfeited.
- Renewal uses an App Attest assertion with the same key.

### §8.3 Android

- The phone sends a standard Play Integrity token whose request hash is the challenge.
- The server requires `MEETS_DEVICE_INTEGRITY`, `PLAY_RECOGNIZED` and `LICENSED`, and a fresh
  timestamp.
- With device recall enabled, a set recall bit → `coach-device-spent`; otherwise the server sets it
  and issues `ANON_QUESTIONS`.
- Without device recall, the allowance is per install, `ANON_QUESTIONS_ANDROID`.

### §8.4 Failure and privacy

- Any verification failure is `coach-device-unverified`. The room offers sign-in and states no
  count.
- The device key is a keyed hash of the attested key id. It is never joined to an account.
- Signing in neither spends nor restores a device's allowance.

### §8.5 Deployment secrets

App Attest app id and Apple's root certificate; DeviceCheck key, key id and team id; the Play
Integrity Cloud project and service account; the grant signing key; the device-hash key.

---

## §9 Conversations and pictures

### §9.1 Records

Conversations are records in the `self/gym` scope. They sync for `bound` seats and stay on the
device for `anon`.

| Type | Identity | Fields |
|---|---|---|
| `thread` | minted | `title` const: the first text message verbatim, or `Photo` |
| `message` | minted, `parent: thread` | `threadId` const; `role` const ∈ {lifter, coach}; `replica` const; `text`; `state` ∈ {running, completed, declined, failed, stopped, interrupted}; `truncated`; `receipt`; `calls`; `pictures` const; `at` time |

- `state` moves from `running` to one terminal state. A terminal state is final and beats
  `running` in a merge regardless of stamp.
- `text`, `receipt` and `calls` are final once `state` is terminal.
- A lifter message carries `role`, `text`, `pictures` and `at` only.

### §9.2 Receipt

- The read receipt counts what the executor returned to the model in the turn, context reads
  included, by identity, under the brief's four rules.
- `results` lists the ids of records the turn created. A proposal minted in the turn carries
  `threadId`.
- A receipt stores ids only. The room reads names and serials from the records when it draws.
- The receipt and the step line derive from `calls`, never from the model's text.

### §9.3 Pictures

- The phone stores the original, within `PICTURE_BYTES` and `PICTURE_EDGE`.
- The **model copy** is a JPEG with a long edge of at most `MODEL_PICTURE_EDGE` and at most
  `MODEL_PICTURE_BYTES`, made once and stored beside the original.
- **Signed out**, a picture leaves the phone only as the model copy inside an open request. Its
  `pictures` entry is `localOnly: true`, and a later sign-in does not upload it. Another device
  draws it as a picture held on the phone that sent it.
- **Signed in**, the original is also uploaded to the account's private picture store, and the
  message references it.
- Copy about a sent picture says that a copy goes to the model vendor to read for the answer, that
  Windmill stores none when signed out, and the vendor's retention as verified at release.

---

## §10 Testing and telemetry

### §10.1 Testing

- The server loop runs in tests against the fake model provider, with a fake tool host playing
  phone results.
- Each phone's turn driver passes `turns/` against a fake server: text, batches, parallel calls,
  resume from `snapshot`, Stop, `max_tokens`, `refusal`, `error`, a lost turn and a result timeout.
- Each executor passes `abilities/` and `rules/` (§3.5).

### §10.2 Telemetry

A phone sends one `coach_turn` event per turn: state, model calls, ability calls by name, refusals
by code, duration and bytes. It never carries text, pictures or results.

---

## §11 Requirements on the sync engine

A phone Coach requires a gym replica per [SYNC_ENGINE](SYNC_ENGINE.md) with:
- the account's full history: no boot window on `session` and `set`;
- a signal that the replica's first pull of history is complete;
- `proposal` records mintable by a replica, with `changes` computed by the shared diff rule and
  re-checked by the server on admission;
- `thread` and `message` as full records with the fields and merge rule of §9.1, and
  `localOnly` pictures;
- the derived reads of INV-5 computed on the replica.

---

## Appendix A: Constants

| Name | Value |
|---|---|
| `MAX_MODEL_CALLS` | 8 |
| `MAX_ABILITY_CALLS` | 12 |
| `MAX_ADDS` | 6 |
| `MAX_QUESTION_BYTES` | 8,000 |
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
| `ANON_QUESTIONS` | 5 |
| `ANON_QUESTIONS_ANDROID` | open |
| `ANON_POOL_PER_DAY` | open |
| `CHALLENGE_TTL` | 5 min |
| `GRANT_TTL` | 24 h |
| `ANON_RETENTION_DAYS` | 35 |
| `CATALOG_RETIRE_DAYS` | 120 |

## Appendix B: Open decisions

- **B-1 Agent rules for the log.** Appendix C marks these abilities `withheld` until canon sets
  them. The brief's Coach never logs, fixes or deletes a set, finishes or discards a workout, or
  writes a bodyweight; MCP runs `start_session`, `log_set`, `log_sets`, `finish_session`,
  `discard_session` and `import_session`. Proposals exist only for routines, so `proposes`
  elsewhere needs a review drawn in canon.
- **B-2 The model per seat.** Whether `anon` turns use the same model and `max_tokens` as `bound`
  turns.
- **B-3 The anonymous numbers.** `ANON_POOL_PER_DAY` and `ANON_QUESTIONS_ANDROID`.
- **B-4 Android attestation.** Play Integrity verdicts pass only for installs from Google Play, and
  device recall is a beta granted on application. Decide the channel that carries signed-out
  Coach, and apply for device recall.
- **B-5 Evaluation.** Signed-out conversations exist only on phones. Decide whether a lifter can
  send a conversation to Windmill for review.

## Appendix C: The catalog

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
| `save_note` | add | runs | any | Notes, new note |
| `share_session` | add | runs | bound | Share |
| `share_log` | add | runs | bound | Share log |
| `propose_routine_change` | change | proposes | any | routine editor |
| `propose_routine_removal` | remove | proposes | any | routine delete |
| `revoke_share` | remove | runs | bound | Share |
| `start_session` | add | withheld (B-1) | any | Start workout |
| `log_set` | add | withheld (B-1) | any | logger |
| `log_sets` | add | withheld (B-1) | any | backfill |
| `import_session` | add | withheld (B-1) | any | backfill |
| `log_bodyweight` | add | withheld (B-1) | any | Bodyweight |
| `finish_session` | change | withheld (B-1) | any | Finish |
| `fix_set` | change | withheld (B-1) | any | set editor |
| `correct_session` | change | withheld (B-1) | any | workout correction |
| `rename_exercise` | change | withheld (B-1) | any | movement editor |
| `edit_note` | change | withheld (B-1) | any | Notes |
| `reorder_notes` | change | withheld (B-1) | any | Notes |
| `set_preferences` | change | withheld (B-1) | any | Settings |
| `delete_set` | remove | withheld (B-1) | any | set delete |
| `discard_session` | remove | withheld (B-1) | any | Discard |
| `delete_note` | remove | withheld (B-1) | any | Notes |
| `delete_bodyweight` | remove | withheld (B-1) | any | Bodyweight |
