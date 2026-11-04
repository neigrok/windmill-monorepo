# The phone Coach on Android: build plan

**Status:** plan, nothing built. Branch `android-phone-coach`, cut from `origin/main` at `812698048`.
**Spec of record:** [gym_coach.md](../foundation/mobile/gym_coach.md) (cited as §, D-n, G-n, INV-n), with
[engine.md](../foundation/engine.md) and [domain-kit.md](../foundation/domain-kit.md).
**Dogfood node:** `gym-coach-phone-android`, under `gym-coach-on-client`.

This file is a working plan. It is deleted when the programme closes, and what stays true moves into
the spec, `apps/android/README.md` and `docs/ANDROID_OBSERVABILITY.md`.

## 1. What is being built

A Coach turn whose abilities run on the phone's replica. The server keeps the model loop, the prompt,
the tool list and the spending gate. The phone is the tool host: it runs each batch of ability calls in
local transactions and posts the results (§2, §4). iOS does this today; Android still speaks
`POST /v1/gym/ask`, where the server reads and writes the log.

**"And not only."** The brief says the agent is for gym Coach *and not only*. No second product has
abilities today and none is scheduled: journal is not on Android, and roadmap is web-only. This plan
reads the phrase as a structural requirement: the turn machinery is product-neutral now, proved by a
module wall, and gym is its first host. It does not build a second host. Decision O1 asks the owner to
confirm this reading.

**Out of scope:** web turns (§4.6), so `/v1/gym/ask` stays for the web; any change to iOS beyond claiming
new shared vectors; adding an agent to another product.

## 2. Where things stand

Established by reading the code at `812698048`, except the two production probes, which were run.

| Piece | Backend / contract | iOS | Android |
|---|---|---|---|
| Turn routes | Live: production answers `401` on `POST /v1/gym/coach/turns` with `Sync-Schema: 12`, `404` on an unknown sibling | speaks them | none |
| Catalog | `gym/catalog.json`, catalog/2: 37 abilities, 18 offered, of which the phone runs 16 (`share_session` and `revoke_share` run on the server) | generated Swift | none; `CorpusTests.kt:30` marks it not applicable |
| Conformance | `abilities/` 18 files, 68 cases; `turns/` 15 exchanges | claims both | marks both not applicable |
| Registry | v12: `thread`, `message`, `workoutProposal`, device rows `runningTurn`, `picture:<id>` | uses them | generated and modelled in `GymServerRules.kt`; no production code uses `thread` or `message` |
| Executor | n/a | `GymDomain/Coach/` | none |
| Driver and wire | n/a | `Gym/Coach/Turn/` | none |
| Room | n/a | engine records | REST threads + `LocalCoach` JSON archive (`CoachStore.kt`, 1,206 lines) |
| Reconnect, Stop, resume | n/a | §4.5 | no automatic reconnect; a dropped stream ends in Try again |
| Background lease | n/a | background task | none: no WorkManager, no foreground service for Coach |
| Step line | n/a | catalog phrases | none |
| Mid-workout Coach | n/a | yes | no |

What Android already has and reuses: JCS (`sync-core/Json.kt:51`) and SHA-256 (`Digest.kt`), `Fields`,
`Plan.device`, `Valid(fields:)`, the `Decider` composition, `Reader.device`, `firstPullComplete`,
`status.online`, `AiInstallation` (issue, read, bind), `CoachPhotos`, the bubbles, Markdown, reveal,
composer and History screen.

## 3. Architecture

### 3.1 The line

```text
:agent  (new, JVM, coroutines)              product-neutral: the turn
  depends on :sync-core
  TurnDriver · TurnHost · TurnTransport · TurnEvent · TurnSse · TurnRefusal · TurnTelemetry
       ^                  ^
       |                  | implements TurnTransport over OkHttp
:gym   |              :platform  platform/agent/TurnHttp.kt, seat credentials on the request
  coach/turn/  GymTurnHost implements TurnHost
               CoachTurns  one driver per seat; admission, sweep, lease, room state
  coach/       the room, on engine records
       |
       v
:gym:domain  (JVM, deterministic)           gym's abilities on its replica
  works.windmill.gym.domain.coach
  Conversation (entities, OpenTurn, EndTurn, StreamTurnText, WithdrawTurn, KeepPicture, DeleteConversation)
  RunAbility · AbilityReads · AbilityWrites
       |
       v
:domain-kit  (JVM, deterministic)           product-neutral: what an ability is
  Ability · AgentRule · AbilityClass · AbilitySeats · Seat · Catalog · JsonSchema · Collation
```

Two facts decide this shape:

- **`:gym:domain` needs the catalog types and may not use coroutines.** `KitLayeringTests` bans
  `kotlin/coroutines` from deterministic modules, so one module cannot hold both the catalog types and
  the driver. The catalog types go in the kit, because an ability is a door onto an action (§2 principle
  1) and the kit already models actions. `:platform` is ruled out for both: it is an Android library a
  JVM module cannot depend on.
- **With one consumer, the module wall is the only real proof of neutrality.** `:agent` cannot import
  gym; the compiler refuses it. A package inside `:gym` could.

`:agent` is an addition to a closed list: `domain-kit.md` §2.1 and `settings.gradle.kts` name every module,
and the layering test knows them. W0 amends all three, and also adds the catalog types to the kit's
documented contents, naming that Swift keeps them in `GymDomain` for now.

### 3.2 The ports

The driver owns the fixed sequence of §4: stream, coalesce text at the product's cadence, run each batch, post results
with retry, reconnect with backoff, Stop, withdraw on a refusal before the stream, end. Everything that
differs by product goes through `TurnHost`, **one instance per turn**, built by the product after its
opening transaction. It therefore needs no turn lookup and no seat argument: it already holds the thread,
the lifter message, the Coach message and the seat.

```kotlin
interface TurnHost {
    suspend fun open(): TurnOpen                      // §4.1 steps 3-5; carries the context reads' outcomes
    suspend fun execute(call: ToolCall): ToolOutcome  // one transaction, §4.3 step 2
    suspend fun writeText(text: String)               // replaces, so a snapshot is safe
    suspend fun end(end: TurnEnd)                     // terminal state + receipt in one transaction
    suspend fun withdraw(refusal: TurnRefusal)        // status, code and reset for the room to say
}

interface TurnTransport {
    fun open(open: TurnOpen, seat: TurnSeat): Flow<TurnEvent>
    fun resume(turnId: String, seat: TurnSeat): Flow<TurnEvent>
    suspend fun answer(turnId: String, batch: Int, results: List<ToolOutcome>, seat: TurnSeat)
    suspend fun stop(turnId: String, seat: TurnSeat): TurnState
}

class TurnDriver(transport: TurnTransport, telemetry: TurnTelemetry, beat: Duration) {
    val activity: StateFlow<TurnActivity>             // idle, or running with turnId, reconnecting
    suspend fun run(turnId: String, seat: TurnSeat, host: TurnHost)
    fun requestStop()
}
```

- Local admission and the opening transaction (§4.1 steps 1-2) run in `CoachTurns`, before the driver: a
  local refusal never reaches it, and it never sees an account or a replica.
- `TurnHost` methods suspend because the existing write path does: `withGymActionContext` is suspend
  (`EngineTraining.kt:993`).
- `GymTurnHost` writes through a replica decorated as `EngineTraining.writable` is and pinned to the opening
  replica. A raw `ActionRunner` would skip that authority check (`EngineTraining.kt:105-110`) and could write
  during an account deletion or transition.
- `:agent` defines `ToolCall`; the host maps it to the domain's `AbilityRequest`, so no domain type crosses.
- `TurnOpen` carries the context reads' outcomes, so the driver alone counts the tally and emits `coach_ability`
  (iOS counts them at `CoachTurnDriver.swift:360,419-424`).
- `:agent` owns the classification the sequence depends on: a lost connection against a server refusal
  (retry vs end, Issue vs not, Stop on the phone alone), and `coach-stream-replaced` as a resume, not an end.
- The route and the `Sync-Schema` value are constructor arguments of `TurnHttp`: `/v1/gym/coach/turns` stays gym's,
  and `:platform` keeps no dependency on `:sync-schema`.
- Ability input and result are opaque `Json` to the driver. Everything else is typed: no `Map<String, Any?>`.
- `TurnTelemetry` takes bounded enums and counts only, so content cannot pass through it. `:gym` adapts it
  to `Telemetry`, keeping the event names iOS uses (`coach_turn`, `coach_ability`, `gym_ask_*`).
- Each port method must name its caller in the wave that adds it. Nothing is added for a future product.

### 3.3 Lifetime

`CoachTurns` lives in the application scope, one driver per seat and replica. It never binds to a screen,
because navigation and Activity recreation must not end a turn. It never outlives the seat, because a
late write would land in another account's replica.

The seat-change signal is `activeReplicaChanged` (§4.5). It exists only as JSON through `Engine.events()` today
(`Lifecycle.kt:71`), so W4 adds a subscribable path. `GymEngineSession.beforeAccountChange` is **not** the signal:
it fires when the sign-out sheet is prepared (`GymEngineSession.kt:149`) and before the sign-in decision (`:61`),
both of which can be cancelled, so ending a turn there would kill it with no seat change. It is also skipped by
account deletion's `runtime.signOut()` branch. Admission additionally refuses while the account is not writable.

### 3.4 What is deliberately not generalised

Conversation entities and the message schema; receipts and their rendering; context reads; a product
registry or routing; all UI; the backend. Each stays gym's until a second product exists.

**The backend stays under `products/gym/coach/`.** The trigger for promoting `Turn`, `TurnService`,
`TurnApi` and `PhoneToolHost` to `platform/` is commissioning a second product's ability list.
`TurnGate` and `AbilityCatalog` carry gym's rules (G-4, G-5). The wire needs no change: its events carry
no gym nouns, and iOS has already frozen it.

**iOS is not refactored to match.** The Android seam should survive shipping first. The shared `turns/`
vectors protect the protocol in the meantime, with no shared code.

### 3.5 Deliberate differences from iOS

| Android | iOS | Why |
|---|---|---|
| Neutral `:agent` module | driver inside the gym feature | the "not only" requirement |
| `StreamTurnText`, `WithdrawTurn`, `KeepPicture`, `DeleteConversation` in the domain | app target | they are domain actions; the iOS log already names this as a follow-up |
| Catalog read from the contract at build time into assets, parsed once, injected | generated Swift (2,475 lines) | no generated code and no drift to pin. Domain code may not load resources (`java/lang/Class` is banned), so `:gym` loads it and passes a `Catalog` to the executor |
| `picture:<id>` rows hold metadata; the bytes live in app files | the row holds both as base64 | Android reads every device row through a cursor at engine open (`AndroidSqlite.kt:94`) and holds them on the heap. At the §9.3 bounds a row reaches about 8 MiB; the default cursor window is 2 MiB, so one picture could stop the engine opening |
| The record takes the streamed text every 5 s, at each batch and at the end; the room draws `CoachTurns.liveAnswer` | every 250 ms | each commit syncs the whole text so far, so the traffic is quadratic: a 9.6 KB answer over a minute went from 240 commits and 1.22 MB pushed to 12 commits and 69 KB pushed. A process death loses at most 5 s of partial text, which §4.4 allows |
| `EndTurn` clears `runningTurn` only when it names that message | clears it whatever it names | a sign-in's merge can leave a row naming the other side's running turn, which would then stay running. The vectors hold no such row, so they stay shared |
| An `anon` turn ends on a rebind, and a pending sign-in holds a turn's reads and writes | neither | D-10 names the rebind and §7.12 fires nothing for it; the Android door pins the seat. iOS is unchanged in this programme: it has both defects |
| A call re-run under the same `callId` keeps one record, in its place: this run's, holding every id either run created. A first record that answered stands only when this run was refused | `RunAbility` appends unconditionally, and `CoachTurnTests.swift:119-127` pins the double record | the server re-delivers only unanswered batches (`Turn.cpp:314`), so this is a defensive rule, not a live defect. The call re-runs either way, because `AbilityCall` stores no result. iOS is unchanged in this programme, so the rule stays out of the shared vectors |
| Until a frame arrives a reconnect opens again, same body and same id. A refused open on any attempt, every attempt lost, an unreadable answer, and a Stop the server did not hear all withdraw the turn | `CoachTurnDriver.swift:337` resumes after any loss and `:316` withdraws only on a first attempt's refusal, so a dropped POST ends `interrupted` on `coach-turn-unknown` with the question on the record | the server's open is idempotent (`TurnService.cpp:143-150`), so an open that did land loses nothing, and a turn that never began holds nothing worth keeping on a record. iOS is unchanged in this programme |
| An input nested past 32 levels is `invalid-arguments` at the gate; the engine's commit refuses a value too deep to read back; a call whose input holds U+0000, in a key or a value, records without its input | no depth bound, and a U+0000 in an input ends the turn `interrupted` | a value past what `AndroidSqlite.open` parses would stop the app opening. iOS is unchanged in this programme |

## 4. Waves

Each wave ends with the gauntlet (AGENTS.md): executing adversarial review, one fix pass, verification,
push. Size figures are estimates from the Swift sizes, in Kotlin lines excluding tests.

W0 to W4 add no visible change and need no board. **W6 cannot start until the design gate in §5 closes.**

### W0 · What an ability is (`:domain-kit`, `:agent` shell) · ~250

- Kit: `Ability`, `AgentRule`, `AbilityClass`, `AbilitySeats`, `Seat`, `Catalog(json)`, `JsonSchema` (the same
  keyword subset as `Catalog.swift:81`: `multipleOf` is ignored there, so it is ignored here),
  `Collation`, `Reader.replica`.
- `Nfc` gains `nfd`: `KitLayeringTests` pins `Nfc` to exactly one method, so that test changes too. Swift's
  twin already holds both functions.
- **Spike inside this wave: `Collation`.** The Swift rule reads the canonical combining class, which the JDK
  has no API for, and `android.icu` is not available to a JVM module. A general-category test cannot stand in
  for it: in Unicode 14, 1,496 marks have combining class 0 (U+FE0F, U+0E31, U+0941), and non-zero classes
  span 188 ranges. The corpus would not notice, since only one of the two `list_exercises` cases has non-ASCII.
  So add discriminating shared vectors first, then carry a generated range table in the kit. A vector run on
  both surfaces settles it.
- `:agent` module shell. Amended together: `domain-kit.md` §2.1, §2.2 (`:agent` fits no layer row; `:platform`
  gains its first project dependency), §2.3 and D-3; `settings.gradle.kts`; **both** layering tests,
  `KitLayeringTests.kt` and `sync-testing/.../LayeringTests.kt:192-201`, which carries its own project and edge
  lists.
- `CorpusTests.kt` claims `gym/catalog.json`.

**Exit:** `./gradlew build` green, the catalog parses and every offered ability's input schema compiles.

### W1 · Conversations as records (`:gym:domain`) · ~650

- `CoachThread`, `CoachMessage`, `AbilityCall`, `ReadServed`, `ReadTally`, `MessageState`, `Picture`, the
  receipt rule (§9.2), `OpenTurn`, `EndTurn`, `StreamTurnText`, `WithdrawTurn`, `KeepPicture`,
  `DeleteConversation`, and `CoachRules.book` (a separate book, as `gym/domain/README.md` states, so
  `RuleBookParity` holds).
- New shared vectors `gym/domain/coach-conversation-actions.json`, claimed by Kotlin **and** Swift (owner
  ruling: every surface passes the same vectors). They include the calls bound's fallback forms
  (§9.2 `readTruncated`) and the merge rank (§9.1).
- `ModelServerTests` covers `thread`, `message` and `workoutProposal`: Kotlin's rules exist but have no test
  (`GymServerRules.kt:304,310,335`), and Kotlin uses `!!` at `:337,:345` where Swift defaults to empty.

**Exit:** the vectors pass on both surfaces and CI is green on both workflows.

### W2 · The replica executor (`:gym:domain`) · ~750

- `RunAbility`, `AbilityRun`, the gate (§5 on the phone), the three-code refusal rule.
- `AbilityReads`: new ability documents. The existing `TrainingHistory` reads are **not** reusable as they
  stand: shape and order differ (default page 50 vs 20; `createdAt` on the proposal head; extra `id` and
  `updatedAt` on notes; session and last-time tie order inverted; no collation). The derived rules
  underneath are reused (INV-5).
- `AbilityWrites`: `CreateExerciseCall`, `CreateRoutineCall`, `SaveNoteAbility`, `ProposeRoutineCall`,
  `ProposeWorkoutCall`, with `proposed(over:)` split out in `Proposals.kt` and `WorkoutProposals.kt`, and
  `given` ids checked against the registry's `idPattern` (G-7).
- A corpus runner in `:domain-kit-testing` for `{given: {records}, call, expect}`: `Contract.vectors` only
  knows `{name, input, expect}` today. `CorpusTests.kt` then claims `abilities/`.

**Exit:** every ability case: results byte-equal (SHA-256 of the JCS bytes), refusals alike, writes compared, and
the 5 share cases refused on the phone (`share_session` 3, `revoke_share` 2).

### W3 · The turn (`:agent`, `:platform`, backend) · ~700

- `TurnDriver`, `TurnEvent`, `TurnSse`, `TurnRefusal`, the ports.
- `platform/agent/TurnHttp.kt`: `Sync-Schema` on every request (without it `GymRoutes` answers `426`
  `client-update-required`), a 60 s idle timeout, one credential per seat, host pinned to the configured base.
- **Tests:** the 15 `turns/` exchanges replayed through the real driver against a fake transport, with a fake
  echo host in `:agent`'s tests that proves the driver has no gym in it; `TurnHttp` against MockWebServer. This
  proves the protocol only: an echo host cannot check records, so W4 replays the exchanges again on a real engine.
- **Backend, small:** node `gym-coach-turn-allowance-reset`. A refusal before the stream and an `error` frame carry
  no `budgetResetsAtMs` (`done`'s allowance does), and `free_month_exhausted` answers 503 by `statusOf`'s default,
  so board 08.44 cannot say when capacity returns on either phone.

**Exit:** 15 of 15 exchanges pass.

### W4 · Gym as the host, dark (`:gym`) · ~600

- `GymTurnHost` as §3.2 specifies, with work on the storage dispatcher (`run` is synchronous and not cancellable,
  kit §9.2).
- `CoachTurns`: admission (§4.1), the sweep of a named `runningTurn` at engine start (never a live turn's), seat
  change, Stop. It calls `AiInstallation.markBound` and `markInvalid` on `device_bound` and `invalid_installation`:
  only `CoachOnboardingStore` calls them today (`CoachOnboardingStore.kt:210-211,238-239`).
- A subscribable `activeReplicaChanged` in `:sync-engine`.
- Pictures: the model copy made once beside the original. Bytes live in app files; `picture:<id>` rows hold
  metadata. Bytes go with `WithdrawTurn`, `DeleteConversation`, discard and account deletion. Tested on the JVM at the
  §9.3 bounds; the emulator run with a 5 MiB picture is W6's.
- `TurnLease`: an expedited WorkManager job (§4.5) that awaits the driver's work. WorkManager is a new
  dependency. Below API 31 an expedited job needs a foreground notification, which is visible and has no
  board, so API 26-30 takes no lease; there a killed turn ends `interrupted` at the next engine start.
- **Tests:** the 15 `turns/` exchanges again, through `GymTurnHost` on a real engine, asserting calls, receipt, state
  and text as `CoachTurnTests.swift:96-129` does; `CorpusTests.kt`'s not-applicable reason for `gym/turns/` updated. A
  Kotlin test pins `firstPullComplete` true on an `anon` replica: the code gives it (`Subscriptions.kt:8`,
  `Engine.kt:330`), and if it changed, signed-out Coach would refuse forever. A live-wire JVM test against the local
  backend and the fake vendor: signed in and signed out, a read batch, a `create_routine`, a proposal. No screen calls
  any of this yet.

**Exit:** the live test passes; kill-and-replay at each step of a batch holds on a real engine; the server logs `coach_turn` and `coach_batch` with `phone_refused=0`; events
arrive at the local intake and failures at the local Sentry collector.

### W5 · The design gate (designer + owner)

Runs in parallel from the start. No product code. See §5.

### W6 · The room (`:gym`) · net reduction expected

Starts when §5 closes and §6 is ruled.

- `CoachStore` splits: `CoachConversations` (read models over engine records), `CoachTurns` (W4), and a much
  smaller `LocalCoach` that holds composer drafts, kept drafts and the marks that are not engine records.
- `AskExchange` and `AskAnswer` stay as presentation models, derived from `message` records.
- Step line and receipt derive from `calls` (§9.2), with catalog phrases.
- On the phone that ran the turn, the executor commits a proposal with its call, so the arrival gap of
  `android-coach-proposal-arriving-state` and ledger 11w goes for local turns. It stays for a conversation synced
  from another phone, since a pull page applies in chunks (`engine.md:498`), and a refused or removed proposal is
  still a miss. The miss settling and the "no longer available" line stay.
- **The finish share:** `RoomSheets.kt:313-316` sends a question through `freshChat(id = request)`, `hasRequest` and
  `submit(requestId, ...)`, with `queuedShare` as its idempotence key. `OpenTurn` gets a request-keyed path, so a
  repeated share opens one turn.
- Mid-workout Coach: the open-workout context read, `propose_workout_change`, its cards. This closes the
  Android half of `coach-mid-workout-android-web`.
- Signed out: `anon` turns replace the onboarding chat. Retained onboarding answers stay readable and their
  drafts saveable, as on iOS.
- Each state follows its approved board; a developer task carries its Figma link, and I flip 🚀 after.

**Exit:** the room's Compose tests rewritten and green; capture recipes updated and passing; signed-in e2e on
the emulator through the real room.

### W7 · Delete and simplify (`:gym`)

The REST path goes in the same release as W6: `ask`, `stream`, `stop`, `confirmRoutine`, `uploadPhoto`,
`photo`, `threads`, `thread`, `deleteThread` in `GymRest`; `AskGeneration`, `AskQuestion`, `AskTurn`, `ThreadPage`,
`CoachRoutineConfirmation`, the `CoachEvents` parser; the `LocalCoach` chats, pending, snapshots and
confirmations; `CoachOnboardingHttp`, `CoachOnboardingStore`'s send path and the `resumeAnonymous` launch step
(`WindmillApplication.kt`), keeping only what reads retained onboarding answers and saves their drafts. Then the
one refactoring iteration AGENTS.md requires over the whole programme.

### W8 · Close

- **Spec hygiene:** `gym_coach.md` §0 adoption table, §3.5, §8.3, §10.2, B-4; `gym-coach-contract.md` first line
  and the anonymous section; `engine.md` A.2 ("web and Android keep writing them"); `apps/android/README.md`;
  `docs/ANDROID_OBSERVABILITY.md`; ledger 6p, 6x, 11k, 11w, 11h; delete this file.
- **Final gauntlet** on the whole diff, then a release through the `android-v*` flow with native acceptance
  (upgrade from the previous public APK retaining data; clean install).
- **Cross-device check**, new for this programme: a conversation started on iOS reads on Android and the
  reverse; a running turn shows as answering on another device; a seat change interrupts correctly. Web
  stays on legacy conversations and does not show engine conversations.
- Remove `android-phone-coach` when merged.

## 5. The design gate

Nothing visual is built without a ✅ board. The designer's read-only check found no Android board for most
phone-turn states. It read layer names and text on the Android, iOS and Proposals pages plus one screenshot,
so layouts are not pixel-checked. iOS boards exist for nearly all of them, so most of this is mirroring into
Material form, and numbers 08.35-08.53 are free on Android (ledger 11r).

| Kind | Boards |
|---|---|
| Mirror iOS, signed in | 08.35 step line, 08.36 answer, 08.37 Made a movement, 08.38 no connection, 08.40 log arriving, 08.41 over-length, 08.44 free month, 08.45 update required, 08.46-08.50 truncated, declined, failed, stopped, interrupted, 08.51 another device, 08.52 reconnecting, 08.53 empty History, 08.56-08.57 two kinds and out of date |
| Mirror iOS, signed out | 01.19 answer, 08.42 invalid installation, 08.43 device bound, a redraw of 08.6 for 08.58 |
| New on both pages | free_day_exhausted; a picture held on another phone |
| 🚧 waiting for approval | 08.54, 08.55, 08.64, 08.65, 03.46 |
| Redraw | 01.5 ("Saved only in this chat" fails on-phone pictures); 01.8 and 01.16 ("After Apply": the routine lands at once); 08.61; 08.8 (its "about 2 hours" needs a wait the driver does not have) |
| New, honesty | The sign-in decision (`OnThisPhoneScreen.kt:90-91`, iOS `AdoptionQuestion.swift:8`) names no conversations, so a phone holding only signed-out conversations says nothing of them, and Discard deletes them unnamed. Needs a conversation noun on both phones (ledger 6x) |
| Narrow, not retire | 08.63: moot for a turn run on this phone, still reachable for a conversation synced from another phone (W6) |
| Unreachable, retire on the Android page | 08.9, 08.26 (`update_exercise` is withheld); 01.7, 01.14, 01.15 become onboarding-draft states only |
| Mirrors with a fix | iOS 08.49 and 08.50 draw "Changed a movement", which cannot land: use Made a movement. iOS 08.41 says characters; the limit is bytes |

**Also for the designer to correct:** the 08 section header reads ✅ over 🚧 boards; captions read ✅ on 🚀
frames 08.1, 08.4, 08.5, 08.11 and 08.61; iOS 01.17 reads 🚀 though iOS deleted the chips.

## 6. Decisions for the owner

**Ruled 2026-11-03.** The owner approved the board set in §5, which draws O2 to O7 as their defaults below, and
asked for the plan to be implemented, which stands for O1. O8 is still open, because 08.31's redraw was flagged and
not part of the approved set.

| # | Question | Default | Cost of the default |
|---|---|---|---|
| O1 | Does "and not only" mean a neutral seam now (§1), or does a second product's agent belong in this programme? | The seam, no second host | A second host later moves the backend's turn machinery |
| O2 | **A routine Coach creates lands at once, as on iOS (`create_routine` is `runs`), or waits for Save as Android does today?** The Oct 21 iOS feedback node says Coach routines require explicit Save; the phone-turn catalog later made them land | Lands at once, with its card | Changes Android's current Save-only draft |
| O3 | Ledger 11k keeps Android's review sheet for proposals (owner's 2026-10-25 scope). Keep it through this programme? | Keep the sheet and today's card wording | Android's cards stay unlike iOS and the boards |
| O4 | Clarification chips (`ask_setup_details`, shipped as task 49) are not in the catalog, and iOS deleted its chips. Delete on Android, or add the ability as catalog/3 on every surface? | Delete, and retire 01.17 | Coach asks in prose; a recently shipped feature goes |
| O5 | Coach can edit a movement over `/ask` today; `update_exercise` is `withheld` on a phone turn (B-1). Accept the loss? | Accept | Coach can no longer rename a movement on Android |
| O6 | Open Android's signed-out seat to full turns (§8.3, B-4)? | Yes, in the same release, to keep one path | Adds the signed-out boards to the gate |
| O7 | Legacy Android conversations are not adopted (iOS ruling R5). The one Android user loses them from the phone's History; they stay on the server and on web | Not adopted | History starts empty on the phone. The alternative, a read-only earlier list, needs a board and keeps REST alive |
| O8 | Board 08.31 says "Coach only drafts" while the catalog offers proposals to `anon`. iOS 08.31 is also 🚀. Which is right? | Catalog stands; redraw | Touches iOS copy too |

Tasks to reconcile once ruled: `android-task-29`, `35`, `41`, `42` and `44` are postponed to keep the current
action cards. O2 and O3 settle whether they stay postponed or are superseded.

## 7. Carried from the iOS gauntlet

These were real defects on iOS. Each becomes a test here, not a review finding.

1. `result-too-large` is decided inside the executor's gesture, **before** any write. Refused after the commit,
   the server frees G-4/G-5 and a second proposal or note lands.
2. The receipt counts only what the model received; an over-bound result counts nothing.
3. A calls bound overflow degrades to counts with `readTruncated`, never a refusal the server would not give.
4. `get_last_times`, `list_sessions` and `list_exercises` use the server's tie and collation rules.
5. The server's refusal codes: `invalid-input`, `invalid-arguments`, `refused`, `load-floor`. A 501-byte note is `invalid-arguments`.
6. `WithdrawTurn` drops the `picture:` rows too.
7. An interrupted turn carries its code on `coach_turn`.
8. A seat change tells the server to Stop, so its slot is not held for `CALL_RESULT_TIMEOUT`.
9. A replayed create answers `created: []`, so it draws no second card.

## 8. Kotlin landmines

- **Bytes:** every bound is UTF-8 bytes. `jcs` returns a `String`, so measure `encodeToByteArray()`, never `length`.
- **`Plan` is mutable** in Kotlin and a value in Swift. Recording a call must not mutate the inner plan a
  refusal path reuses.
- **`Decider.decision` catches only `Violation`.** The gate must also turn `DecodeError` and `JsonError` into
  `invalid-arguments`.
- **Cancellation:** `CancellationException` extends `IllegalStateException`, so every catch rethrows it, or
  teardown files phantom failures.
- **`encodeDefaults=false`** silently drops defaulted DTO fields, so wire types carry no defaults on required
  fields.
- **Injected clocks:** nothing reads the ambient clock behind an injected one; Robolectric cannot see the
  violation, and CI's slower machines can.
- **The local gate is `./gradlew build`**, including `:gym:testReleaseUnitTest` and lint.
- **Unicode tables** differ between the JVM that runs the corpus and the device. An NFC or collation case can pass
  in CI and differ on API 26. Not covered by this plan's tests; see §11.
- **Performance:** a long history on the phone, with the context reads run on every turn. At 2,500 sessions and 5,025 sets on the SQLite store (JVM, CPU time): a full-log read 1.2 s, `open()` 3.6 s for its three of them, `get_stats` 1.3 s, a `writeText` 10 ms. The same reads on the memory store take a tenth of that, so the cost is the store's per-record read; the heap (512 MB against 2 GB) changes nothing. On an API 34 emulator from a release build, on a host under a load of 900 and so an upper bound: `open()` 22-49 s, `get_stats` 10-15 s, `writeText` 83-452 ms. `Engine.activeReplica()`, `readRevision()` and `EngineTraining.mayWrite` answer without the lock; every other read still waits for a running ability: on a Robolectric probe of the room over that log on an idle host, `get_stats` takes 0.4-0.5 s and a main-thread read behind it 0.22-0.38 s, and under the load above 1.5-3 s. What still waits on main is `TrainingStore.refreshEngine`'s own reads (`reconcileImports`, `HistoryReads.loadLog`, `RoutinesStore.readCatalogue` and `readReceipts`, `WorkoutSession.drawFromControls`).

## 9. Observability

Added in the waves that create each path, and listed in `docs/ANDROID_OBSERVABILITY.md`:

- **Events:** `coach_turn` (state, seat, code, ability calls, refusals, answer bytes, duration) and `coach_ability`
  (catalog name, outcome) per §10.2; `gym_ask_started` and `gym_ask_outcome` kept; the registry in `GymEvents.kt`.
- **Failures:** one static operation `gym.coachTurn` with bounded kinds `transport`, `decode`, `storage`,
  `refusal`, `http`. Lost network and cancellation are not Issues, and expected refusals are events.
- **Never sent:** question, answer, picture, history, context, ability input or result, ids.
- **W7 removes** the rows for the REST operations (`gym.readThreads`, `gym.thread`, `gym.coachRoutineConfirm` and
  their neighbours).
- **Gauntlet question for each wave:** when this fails in production, what will we see?

## 10. Coexisting with parallel work

Other Android work continues on `apps/android/gym/.../coach/`: that directory took a commit today. The plan keeps
out of its way.

- **W0-W4 mostly add new files**: a new module, a new package and a new `coach/turn/` folder. The edits to shared files
  are `CorpusTests.kt`, both layering tests, `Nfc.kt`, `settings.gradle.kts`, `libs.versions.toml`, `Proposals.kt`,
  `WorkoutProposals.kt`, `:sync-engine`'s events path, `GymEvents.kt`, `WindmillApplication.kt`, `TrainingStore`'s wiring
  and the `:gym` and `:platform` build files. Each is small; other sessions touching them see a one-line merge at most.
- **Merge W0-W4 to `main` as each passes its gauntlet**, dark, so the branch never drifts, and merge `main` back after
  each. A conflicting PR runs no CI, so check for conflicts first.
- **W6 and W7 are the one conflicting change.** They land last, in one release, and rebase onto `main` immediately
  before starting and before merging. Tell other Android sessions when W6 starts.
- **Implementation runs in isolated worktrees** with named scratch folders, never in the shared checkout. Stage by
  path and check the index before each commit.
- **Unmerged `codex/android-coach-*` branches** (latest 2026-10-31, 400+ commits ahead of `main`) touch up to 14
  coach files. Whether their work is already on `main` was not checked. Check before W6.

## 11. Verification

| Layer | Proof |
|---|---|
| Executor | `abilities/` byte-equal in `CorpusTests` (INV-1, INV-2) |
| Records | shared `coach-conversation-actions.json` on Kotlin and Swift |
| Driver | `turns/` through the real driver, then again on a real engine, with kill-and-replay at each step of a batch |
| Wire | MockWebServer, then the live-wire test against the local stack |
| Room | Compose tests, capture recipes, emulator e2e (`.claude/skills/verify`, `android-e2e-rig`) |
| Telemetry | events at the local intake, failures at the local Sentry collector |
| Release | native acceptance, cross-device check |

**Not covered by this plan:** the Unicode table difference on old devices (a device-run corpus would close it, and is
worth doing only if a real case fails); a real vendor round on Android until W8; multi-process routing of a turn
(production runs one process); whether WorkManager's expedited quota holds up in real use on Android 12 and later.

## 12. Order

```text
W0 ─ W1 ─ W2 ─┐
W0 ─ W3 ──────┼─ W4 ─┐
W5 (design) ─────────┼─ W6 ─ W7 ─ W8
Owner rulings (§6) ──┘
```

W1 and W3 can run in parallel after W0: their territories are disjoint, and the contract between them is §3.2. W5
starts now, and the rulings shape its board list, so O2, O3, O4 and O6 are worth settling first.
