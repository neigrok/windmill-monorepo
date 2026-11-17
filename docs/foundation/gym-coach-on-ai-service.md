# Gym Coach on the AI service

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and roadmap nodes can cite
them.

## §0 Status and scope

**Status:** Specified, and approved by the owner on 2026-11-15; nothing is built. Gym Coach runs on the server in two forms.
[Phone-hosted Coach abilities](mobile/gym_coach.md) is what the iPhone and Android speak: the server
runs the loop and the phone runs the abilities. The [Coach conversation contract](../gym-coach-contract.md)
is what the web speaks: the server runs everything. Both are metered by the backend's ledger
([USD AI allowances](../../backend/AI_ALLOWANCES.md)). This document says how gym Coach's turn moves
onto the device on all three surfaces, with each model round made by the
[AI service](ai-service.md). The build order lives in the Gym Coach roadmap tree, which the dogfood
tree (`t_9362d9bc883e0a1e`) opens from the node `gym-coach-on-ai-service`.

**Scope:** Gym's profile for the [Coach engine](coach-engine.md); what changes on the iPhone, on
Android and on the web; what the backend still does for Coach; the cutover; and what retires.

**Out of scope:** The engine, the AI client and the pass door, which the Coach engine document
holds. The screens: a screen is built only from a board the owner has marked ready, and the web's
Coach has no board for most of what §5 changes. Journal's AI (Talk, Echoes) and roadmap's, which
move apart. Funding a grant from a paid period (AI service I-7). The gym tools an outside assistant
reaches over MCP, which stay on the server.

**Depends on:** the Coach engine, and through it the AI service's text door.

## §1 What moves

| | Today | After |
|---|---|---|
| The loop, the gate, the prompt, the tool list | the server, for every surface | the device, on every surface |
| A model round | the backend's Anthropic client | one call to the AI service's text door |
| What a round may cost | the backend's ledger | the AI service's ledger |
| Abilities on a phone | the phone's replica | unchanged |
| Abilities on the web | the server, against Postgres | the browser's replica |
| The shares | the server, inside a turn | the device calls the door the Share sheet calls |
| Conversations on a phone | `thread` and `message` records | unchanged |
| Conversations on the web | the server's own tables | `thread` and `message` records |
| A picture on the web | uploaded and stored by the server | kept in the browser, as a phone keeps one |
| A picture on its way to the model | sent to the backend with the turn | uploaded once to the AI service, which holds it in memory for the turn |
| The catalog | `catalog/2` | `catalog/3`, written to the provider's strict mode, on every door |
| The words the model reads | texts in the backend's source | files every app ships |

What does not move: what each ability does, the executors on the phones, proposals and their
Apply, the records and their merge rules, installation identity, and every board the phones are
built from.

## §2 Principles

These replace principles 3, 4 and 5 of [phone-hosted Coach abilities](mobile/gym_coach.md) §2. Its
principles 1, 2 and 6 stand.

- **P-1 Abilities run where the data is, on every surface.** A turn runs every ability on the
  device's replica. The server never reads or writes a log for a turn, the web's included.
- **P-2 The device runs the loop and keeps the words.** The device holds the prompt, the tool list,
  the limits and the model's side of the conversation
  ([Coach engine](coach-engine.md) P-1). The backend sees nothing of a turn but the pass it signs.
- **P-3 One loop and one gate in each language, held together by vectors.** The loop and the gate
  are the engine's, the same on every surface (Coach engine P-3).
- **P-4 A backend ability is an exception with a reason.** An ability calls the backend only for a
  record the server alone can make. There are two, the shares (§4.3).

## §3 Gym's profile

What gym gives the engine, for each seat. Its name is `gym.coach` and its version starts at 1.

| | `bound` | `anon` |
|---|---|---|
| Model class asked | `large` | `large`, which the AI service serves an installation as `medium` |
| Effort | `medium` | `low` |
| Output cap and floor | 2,000 and 1,024 tokens | 2,000 and 1,024 tokens |
| Label | `coach` | `coach` |
| Tools | every ability of the catalog whose `agent` is `runs` or `proposes` and which the server declares | the same, less those whose `seats` is `bound` |

- **The words** are files in `packages/api-contract/gym/coach/`, which every app ships:
  - `prompt.md`, the system prompt the phones' turns are given today, with nothing put into it at
    run time;
  - the words of the first content: the sentence that leads each context read, the line that marks
    the earlier conversation, and the question that stands for a picture sent with none;
  - the sentence the model reads beside each refusal code.

  Today all three are in the backend's source. A person can read them in the app; they hold no
  secret. (R-8)
- **The catalog** is `packages/api-contract/gym/catalog.json` at `catalog/3` (below). The model
  reads each ability's `description` from the copy the app ships, so the iPhone's generated catalog
  carries it, which it does not today.
- **The limits** are those of [phone-hosted Coach abilities](mobile/gym_coach.md) Appendix A:
  `MAX_MODEL_CALLS` 8 and `MAX_ABILITY_CALLS` 12. The write cap is its `MAX_ADDS`, 6, and counts the
  abilities whose class is `add`.
- **The groups** the gate allows once in a turn (Coach engine §6): one routine proposal
  (`propose_routine_change` or `propose_routine_removal`) and one workout proposal
  (`propose_workout_change`), each refused as `one-proposal`; and one `save_note`, refused as
  `one-note`.
- The web offers no `propose_workout_change`: its room is closed while a workout is open, and no
  board draws a workout proposal there.

**The catalog and the provider's strict mode.** The AI service sends every tool to the provider in
strict mode ([AI service §6.2](ai-service.md#62-the-wire)); the backend sends none so. `catalog/2`
cannot be sent that way. Read on Anthropic's documentation on 2026-11-15: strict mode refuses the
bounds the catalog states on numbers, strings and lists (`minimum`, `maximum`, `maxLength`,
`maxItems`), allows 24 optional parameters across a request's strict tools, where the tools of a
`bound` turn have 31, and allows 16 parameters that take more than one type.

The catalog is therefore rewritten as `catalog/3`, for every door: Coach on each surface, the apps'
own executors and MCP. (R-11)

- Every input schema of `catalog/3` is one strict mode accepts, and the tools a seat is offered fit
  its limits together. A check in CI counts both from the file.
- A bound strict mode cannot state moves into the ability's rule, which refuses a value outside it,
  and into its description, which tells the model. What an ability does and returns is unchanged.
- Fewer inputs may be left out. Which become required, and which take null, is fixed when the file
  is written, ability by ability.
- The corpora under `abilities/` are written again for `catalog/3`, and every executor claims them:
  the server's, Swift's, Kotlin's and the web's.
- An outside assistant sees the new schemas over MCP. A build released before the move goes on
  opening `catalog/2` turns, which the server serves beside `catalog/3` until the cutover (§8).

## §4 The turn

A turn runs as [Coach engine](coach-engine.md) §5 says. This section says what gym's tool host
gives it.

### §4.1 Open

The host admits a send locally, as [phone-hosted Coach abilities](mobile/gym_coach.md) §4.1 step 1
says, and writes the records of its step 2. Then:

- **Context.** The four list reads, and the open workout's `get_session`, run through the executor
  and recorded as calls on the Coach message, within `CONTEXT_READ_BYTES`. Each enters the first
  content as its lead sentence and its result in canonical form.
- **History.** The newest completed turns, at most `CONTEXT_TURNS` and `CONTEXT_BYTES`.
- **Pictures.** The model copies of this message's picture and the previous lifter message's, at
  most `CONTEXT_PICTURES`. The device uploads each to the AI service once, and every round of the
  turn names it (Coach engine §4.2). (R-12)

The first content is the one the server builds today, word for word, from the files of §3. Where
those words name a phone, they are rewritten to name no device before the web ships.

### §4.2 Ability calls

- The host runs a call through the replica executor, which commits the call's writes and records
  the call on the Coach message in one local write, as it does today.
- A result returns to the model as its canonical bytes (RFC 8785), within `TOOL_RESULT_BYTES`. A
  refusal returns as its code and sentence.
- **Ids.** The host mints every new record id as a seeded id from the `turnId` and a turn-wide
  ordinal, as the server's gate does today (G-7), and replaces an id the model supplies.
- The executor runs a call only on this replica's own Coach message, and only while its writer has
  not ended it. A message another device marked `interrupted` is still the writer's to answer
  (Coach engine §5).

### §4.3 The shares

`share_session` and `revoke_share` make and remove a record only the server can make: a link a
stranger can open. In a `bound` turn the host runs them by calling
`POST` and `DELETE /v1/gym/sessions/{id}/share`, the door the Share sheet calls. The first answers
what the ability's result states, and the second answers nothing, so its result is built from the
call. The door answers one refusal for an unknown workout and for a workout with no share, and the
host gives the model the one code. An `anon` turn is offered neither.

### §4.4 Text, the mark and the end

- Text reaches the Coach message in coalesced writes at the pace each surface sets: every 250 ms
  on the iPhone; every 5 s on Android, whose room draws the answer so far from the engine; every
  second on the web.
- The mark is the device row `runningTurn` with, beside it, a row of its own for the round in
  flight and where its text begins (Coach engine D-6). The registry declares `runningTurn` as the
  message's id alone, and a mark already on a device must still read, so the round takes a new row.
  A device row never syncs, and declaring one moves no schema version.
- The end is one local write: the state, the whole text, `truncated`, the receipt derived from the
  calls, and the mark cleared.
- No server ends a turn. The server-origin door `interrupt` and the sweep that calls it retire, and
  a turn its device never ends is ended by another of the person's devices (Coach engine §5).

### §4.5 A proposal's conversation

A proposal's `threadId` is the server's field to write, and only the web's server Coach writes it;
a proposal a phone mints has none. After the move nothing writes it. Every surface places a proposal
under the answer whose call created it, from the call's record, as the phones do today.

- **INV-1.** A write Coach makes is the write the lifter's own gesture makes: the same action,
  through the same replica, synced, held and claimed the same way. This is principle 6 of
  phone-hosted Coach abilities, now true of the web.
- **INV-2.** No ability applies or dismisses a proposal, on any surface. Apply and dismiss stay the
  lifter's gestures and the server's commands.
- **INV-3.** The server relies on nothing the device's gate checks. What it accepts of a device's
  writes it checks when it admits them: a proposal's diff, a note's bounds and count, a record's
  shape.

## §5 The web

The web's Coach becomes the Coach the phones have. This is the largest part of the move.

**Built beneath the room:**

- The web's domain kit gains the catalog types, and `web/src/products/gym/domain/coach/` gains the
  replica executor: every ability the phones run, each over the reads and actions the web's gym
  domain already has. It claims every case of `packages/api-contract/gym/abilities/` and
  `rules/collation.json`, by the SHA-256 of canonical bytes, as the Swift and Kotlin executors do.
- The web's gym domain gains the `thread` and `message` entities and the actions of a turn's
  records, and claims `gym/domain/coach-conversation-actions.json`.
- A picture is kept in the browser: its original and its model copy in the device row
  `picture:<id>`, which the registry already declares. It leaves the browser only as the model copy
  the AI service holds for a turn, and its `pictures` entry is `localOnly`.
- The browser's mark is one for a browser, so a browser runs one gym turn at a time across its
  tabs.
- Signing out removes what Coach kept in the browser: drafts, pictures and the mark. Where the
  person keeps their unsent work, a picture an unsent message names stays with it.

**What a person on the web gets, and loses:**

| | Today | After |
|---|---|---|
| Conversations | the web's own; a phone's never appear | one History with the phones |
| A new routine | a draft in the answer, saved by **Save routine** | created at once, with its card, as on a phone (R-7) |
| Changing a movement | Coach may edit one | not offered: `update_exercise` is `withheld` (R-7) |
| How much one may ask | three questions back to back, refilling at ten a day, and the allowance | the allowance alone (R-7) |
| A question's length | 1,000 bytes | 8,000, as on a phone |
| Reloading or closing the tab mid-answer | the answer goes on and is there on return | an answer in its last round is recovered on return; a turn still calling abilities ends *Interrupted* (Coach engine R-4) |
| Stop | cuts the round short | takes effect after the round in flight, which is paid for |
| A picture | stored on the server, shown in every browser | held in the browser that sent it, gone when that browser clears its storage |
| Deleting a conversation | a request the room holds back for 9 s | a record's delete, held and undone as any record's is |
| A turn's records | written by the server | written by the browser; another tab or device shows it answering elsewhere |

- Existing web conversations are not carried into the records, and a draft waiting for
  **Save routine** on the day the web moves is lost with them. (R-6)
- Coach on the web stays closed while a workout is open, and signed out the gym room stays a sign-in
  door. Neither is this move's to change; [the web as a device](web-device-parity.md) changes both.
- A workout proposal a phone made appears in the shared History, where the web has no card for it.
- The room, History, a created routine's card, the read receipt, a turn answering elsewhere, the
  ends of a turn, a picture held elsewhere, a phone's workout proposal and the access states of §6
  each need an approved board before they are built.

## §6 Identity, the pass and access

- **Identity is unchanged.** A phone holds an installation credential, issued and bound by the
  routes of [phone-hosted Coach abilities](mobile/gym_coach.md) §8, which go on answering as they
  do. A signed-in device asks the pass door with its session, and a phone sends its installation
  credential beside it, so the pass can name the installation it was. A signed-out phone asks with
  the installation credential alone.
- **The allowance** a device on the engine reads is the AI service's (`GET /v1/allowance`), never
  the one the installation routes answer.
- **Binding and the first account pass.** A phone binds its installation at sign-in. Until the
  backend holds that binding, an account's pass names no installation, and the device's spend of
  the month before sign-in is not yet counted in the account's month. The gap is bounded by one
  installation's lifetime allowance.
- **Access.** The states are those of [Coach engine](coach-engine.md) §7. Gym's words for them are
  the ones its boards hold. These codes of the turn wire and of the web's contract end with their
  routes and need no word: `debt_outstanding`, `coach-rate-limited`, `coach-busy`,
  `coach-vendor-error`, `coach-update-required`, `ask-daily-limit`, `ask-out-of-budget` and the
  other `ask-` and `coach-turn-` codes.
- **One call at a time.** A free account has one call in flight, so a person whose phone is
  answering is refused as busy in a browser until it has finished. Today the same limit refuses the
  second device's turn.
- A plan is not shown on a phone, and nothing in this move shows one.

## §7 What the backend still does

- Signs passes ([Coach engine](coach-engine.md) §4.1), issues and binds installations.
- Syncs the records, checks a proposal a replica mints, and runs Apply and dismiss as commands.
- Serves the Share door.
- Serves the gym tools over MCP from the server executor, under the same catalog and agent rules.

It holds no prompt, no loop, no gate for Coach and no turn.

## §8 Cutover

The move lands one surface at a time, and each landing is whole: a build runs Coach on the device or
on the server, never some of each.

1. The AI service serves the text door in production, and the backend's pass door is live.
2. Each surface ships a build whose Coach runs on the device. A build before it goes on calling the
   server's Coach, which goes on being metered by the backend's ledger.
3. On a day the owner sets, the server's Coach closes. Its routes stay as tombstones that answer
   410 `client-update-required`, as the backend's other retired routes do, which the released
   phones show as *Update*. A route that is simply gone answers 404, which every released build
   shows as a Windmill without Coach. (R-5)
4. The server's Coach, its tables and its tests are deleted (§9). The tombstones stay.

Between steps 2 and 3 two ledgers meter Coach. A person with an old build and a new one holds two
allowances, an installation holds its lifetime allowance twice, and Windmill's free pools stand
twice: a day's and a month's in each ledger. The AI service's ledger starts empty for everyone
([AI service I-8](ai-service.md#12-integrations)). (R-5)

An old build and a new one write the same `thread` and `message` records, each by its own loop, and
a conversation begun on one continues on the other.

The backend's ledger and its provider clients outlive this move: Talk, Echoes, and roadmap's tending
and compose still use them.

## §9 What retires

- **The turn wire:** `POST /v1/gym/coach/turns`, its resume, results and stop routes; the server's
  loop and gate in `backend/products/gym/coach/`, the tombstones of stopped turns and the sweep; and
  the server-origin door `interrupt`. `AbilityCatalog`, which holds the MCP tools to the catalog,
  stays.
- **The web's server Coach:** `POST /v1/gym/ask`, the threads, attachments, stop and routine-confirm
  routes, the tables `gym_ask_threads`, `gym_ask_turns`, `gym_ask_generations`, `gym_ask_attachments`
  and `gym_ask_deleted_threads` with the conversations in them (R-6), the question ration, and the
  server's writing of a proposal's `threadId`. The receipts of a saved note and of an edited
  movement stay: MCP writes them too.
- **Anonymous onboarding:** `POST /v1/gym/coach/onboarding` and its read, and what it stores.
- **The words** in the backend's source, and the adapters that give Coach a model.
- **The address limit on generations**, which becomes the pass door's.
- **The corpus** `packages/api-contract/gym/turns/`, the stories of a wire that is gone. Their
  stories are told again in the engine's vectors.
- **In each app:** the turn wire's client, and on the web `coach/stream.js`, the photo upload, the
  routine-draft review and the localStorage a request is kept in.
- **Documents:** [phone-hosted Coach abilities](mobile/gym_coach.md) is rewritten to describe what
  is then true, and the [Coach conversation contract](../gym-coach-contract.md) is deleted.

What stays: the catalog at `catalog/3` with its `abilities/` and `rules/`, the server executor for MCP, the records, and
every proposal door.

## §10 Testing

- Each engine replays the engine's vectors; each executor claims `abilities/` and `rules/`, the
  web's included (§5).
- Every tool of the profile is sent to the provider in a real round, once by hand with the AI
  service's own key, on each seat. The provider counts tokens without compiling a schema, so a
  count proves nothing here.
- Each surface drives a turn end to end against a local stack: the backend signing passes, the AI
  service, and a provider the test plays. The stories are a question answered, an ability that
  writes, a proposal applied, a share, a picture, Stop, an allowance used up, a connection lost
  mid-round and found again, and an app killed in its last round.
- One turn on each surface is driven by hand in production with a real provider before the cutover
  day, and its evidence names what it cost.

## §11 Observability

- Each surface emits `coach_turn` and `coach_ability`
  ([phone-hosted Coach abilities](mobile/gym_coach.md) §10.2) from the engine's telemetry port, and
  `gym_ask_started` and `gym_ask_outcome` as the phones do. A turn on the web emits no event today
  and gains all four.
- Failures report to Sentry under each surface's own turn operation and under `ai-call` and
  `ai-pass` ([Coach engine](coach-engine.md) §10).
- The backend's `coach_turn` and `coach_batch` lines end with the turn wire. Its line for Coach is
  the pass it signed.
- They are listed in each surface's observability notes when built.

## §12 What must be built beneath

Reading the backend, the two phone apps, the web and the AI service as built against this document
on 2026-11-15 found these gaps. Each is work of this build.

- `catalog/2` breaks the provider's strict mode, which the AI service sends every tool in (§3).
- The AI service has no door that holds a picture between calls (R-12).
- The iPhone's generated catalog drops each ability's `description`, and no app holds the words the
  model reads. The sentences beside refusal codes and around the first content exist only in the
  server's loop.
- The iPhone keeps its turn in the app target; it has no engine module that names no product.
  Android's `:agent` is one, and holds the wire's driver, not a loop.
- The web has no catalog types, no executor, no `thread` or `message` entity, no agent or AI layer
  and no lock a turn could hold. A turn there emits no event and files no report.
- The web keeps a Coach draft and a photo in the browser under the account's name and removes
  neither at sign-out.
- The mark has no place for a round, and the registry declares it as an id alone.
- Both phones refuse an ability call, and stop writing text, once their running Coach message reads
  `interrupted`. A writer whose turn another device marked stale must go on (§4.2).
- The server's gate applies rules G-4 to G-7 that no phone applies; each moves into the device.
- The iPhone does not handle a sign-in that rebinds the signed-out replica or one waiting on its
  decision, which Android does; the engine's rule for a seat change must hold on both.
- A web bundle from before the cutover that a browser still holds does not read
  `client-update-required`, and nothing tells it to reload.

Read in the code and not run: the server admits `interrupted` written on a `running` Coach message
by any of the account's replicas, which a stale turn's end needs.

## §13 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | Where the turn runs | On the device, on every surface: the loop, the gate and the prompt. (2026-11-14) |
| R-2 | One Coach or one a product | One engine; gym keeps its own prompt, abilities and conversations. (2026-11-14) |
| R-3 | Where abilities run | On the device's copy by default, every change travelling by synchronization. An ability that calls the backend is a rare exception. (2026-11-14) |
| R-4 | Which Coach moves first | Both at once: gym's and roadmap's are built in parallel on the shared engine. Roadmap's goes live only after gym's cutover day (Roadmap Coach R-11). (2026-11-15) |
| R-5 | Builds released before the move | On a day the owner sets, the server's Coach closes and an old build asks for an update. Until then an old build is metered by the backend and a new one by the AI service, and Windmill's free pools stand twice. (2026-11-15) |
| R-6 | The web's existing conversations | Deleted with the server's Coach. Routines, notes and applied proposals they led to stay. (2026-11-15) |
| R-7 | Whether the web's Coach takes the phones' rules | Yes, as §5's table lists. A new routine is created at once, Coach edits no movement, and the question ration ends. (2026-11-15) |
| R-8 | Where the prompt lives | In each app's bundle, from shared files. A change to it reaches a phone with a release, and a person can read it. A build whose Coach is found broken is retired by its profile's version (Coach engine §4.1). (2026-11-15) |
| R-9 | Coach's shares | The two share abilities call the Share door, the one exception to R-3 gym has. (2026-11-15) |
| R-10 | Effort and output cap | As the backend sets them today, in §3's table. (2026-11-15) |
| R-11 | Tool schemas the provider's strict mode refuses | The catalog is rewritten as `catalog/3` to strict mode's limits, for every door, MCP included. The AI service goes on sending every tool in strict mode. (2026-11-15) |
| R-12 | A picture in a turn of several rounds | The device uploads it once to the AI service, which holds it in memory for a short time; each round names it ([AI service §6.7](ai-service.md#67-pictures-a-caller-uploads)). It is not sent again with every round. (2026-11-15) |
