# Gym · the build brief

What to build, what to rebuild, what to fix, and what is not safe to start. It serves the eight
briefs in `briefs/` — `09-coach.md` through `16-the-workout.md` — plus
`../guidelines/text-budget.md` and the drift ledger `../consistency.md`.

Every claim here is read off source at the line cited, in the current working tree. Section 7 says
what has been executed and what has not, because a brief that overstates readiness is worse than no
brief.

---

## 1 · Start here

Gym ships on three surfaces. The web room is a mirror and a backfill tool; the phones own the open
session. One backend serves all three.

**Where the build stands.** The Coach wave's design (2026-08-24) landed Waves 1, 2, 3 and 3b on
2026-08-25 and Waves 4 and 7 on 2026-08-26, each in one change across four surfaces. What that
means in practice:

- **Notes is built end to end.** A `gym_notes` table, five owner-scoped routes under
  `/v1/gym/notes`, a read-level `list_notes` tool that opens every Coach conversation, a third CSV at
  `/v1/gym/export/notes`, the account footprint, and a Notes screen on all three surfaces.
- **Bodyweight is built end to end** (`11-bodyweight.md`). A `gym_bodyweight` table keyed
  `(user_id, date_local)`, three routes under `/v1/gym/bodyweight`, a read-level `list_bodyweight`
  tool and — pinned — nothing that writes one, a fourth CSV at `/v1/gym/export/bodyweight`, the
  footprint, the last slot in both phones' claim replay, and the reading, the chip, the dated
  weigh-in sheet and the dot chart on all three surfaces.
- **The review is a sheet over the conversation on every surface** (`09-coach.md` beat two): one
  Apply, unreachable until the diff has been seen to its end; kept rows folded in place; the
  writer's kicker; an ephemeral receipt derived from the server's apply reply; and a superseded
  refusal that names its reason off `gym_proposals.superseded_by`.
- **The room is Coach on every surface.** The server's strings, the three client suites and the tab
  labels moved together, because the suites pin the server's bytes: a copy change that lands in one
  place turns another suite red, which is why a server string never changes without its three
  clients (§2.3).
- **Check the line, not the sentence.** Citations drift by a few lines between edits. Trust the
  structure and the counts; re-grep before editing at any line this document cites.

The two heaviest items in the programme — the type rebuild and Daylight — are XL on every surface
and neither can be measured from source. They are last, not first.

**Read `briefs/01-context.md` before anything else.** It carries the surface charters: the web
starts no sessions, the phone owns the queue. Several rulings in the wave were written for the
surface that finishes a workout and do not name a surface; §7 lists which.

---

## 2 · Do this first

Six of these are still decisions, one of them half-answered. One must be proven on a simulator
before code is written against it. None of them is a build, and every open one blocks a build. Five
decisions and two proofs are settled and recorded here as facts, so nobody re-opens them.

### 2.1 · Decisions

**P1 · The note bounds — ruled.** Ten notes per account; a title of at most 60 characters (Unicode
code points, non-empty after trim); a body of at most 500 UTF-8 bytes after trim, which may be
empty. The numbers sit in the schema CHECK (`schema.sql:1087-1089`), the domain constants
(`domain/Note.h:17-19`, enforced by the constructor at `Note.cpp:82-85` in the wire's own sentences)
and the `list_notes` description, and `PgNotesRepositoryTest.cpp` proves the columns refuse exactly
what the domain refuses. A note's id is client-minted, `note_<hex>`, the `thr_<hex>` discipline.
Raising a bound later is cheap; lowering one strands stored rows.

**P2 · The bodyweight wire shape — ruled.** One row per `(user, dateLocal)`; the identity is the
local calendar date, `YYYY-MM-DD` and a real day, so every write is idempotent by that key.
Kilograms only on the wire, `numeric(5,2)`, `20.00 ≤ weightKg ≤ 400.00`; the unit toggle stays a
display transform. The collision rule is **the later `recordedAt` wins**: a write carrying an older
instant than the stored row is a 200 that answers the stored row unchanged, so a replayed stale
write never overwrites a newer correction. A day after the device's local today is refused at the
field, and the server refuses a day more than one past its UTC today, both with *A weigh-in is not
a forecast — today or earlier.* `latest` on the list read is the account's newest day whatever the
window. On the phones the claim replay runs settings → movements → routines → sessions →
**bodyweight**, last, after every session landed. The whole of it is `11-bodyweight.md` "The wire"
and `ARCHITECTURE.md` §3.10.

**P3 · The server's Coach strings — ruled: one wave, four surfaces, and the tokens stay.** Every
lifter-facing sentence `AskApi.cpp` sends (`:16-81`) names Coach with the typographic apostrophe,
pinned by `AskApiTest.cpp`; the phone suites carry the same bytes as fixtures (`AskTests.swift`,
`AskVerdictTests.kt`) and `coach.test.js` pins the web's handling of each code. The verdict codes
`ask-thread-taken`, `ask-thread-full`, `ask-session-open`, `ask-daily-limit`, `ask-out-of-budget`,
`ask-not-configured`, the wire enum `from: "lifter" | "ask"` (`TrainingJson.cpp:496`) and the
proposal door `ask` are machine tokens: copy may change, tokens may not (`ARCHITECTURE.md:1233`).
The CSV export's `from` column is an export value, `lifter`/`coach` (`PgAskThreadRepository.cpp:224`),
not the JSON enum.

**P4 · The undo window — ruled: 9000 ms on every surface.** `fix.js:9` `UNDO_MS = 9000`,
`useTrainingLog.js:16` `TOAST_MS = 9000` (pinned equal by comment, held by `fix.test.js:91`),
`SetQueue.swift:48` and `SetQueue.kt:52` `undoWindowMs = 9_000`; `ARCHITECTURE.md:1233` states it as
the invariant it is. Every new undo in the gesture wave — the routine delete, the thread delete, the
editor row `×` — takes that span.

**P5 · The web's hash grammar — ruled.** `#/gym` IS the routines home and `#/gym/routines` is an
alias that still resolves; the routine editor stays `#/gym/routines/<id>` (`new` included);
`#/gym/coach` is the Coach root and `#/gym/ask` an alias that resolves to it; threads are
`#/gym/coach/threads` and `#/gym/coach/threads/<id>` (old `#/gym/ask/…` shapes resolve to the same
screens); notes are `#/gym/notes`; the bodyweight chart is `#/gym/bodyweight` (`log.js:62`); `log`,
`connect`, `backfill`, `movement/…`, `stats/…`, `finish/<id>` and `shared/<token>` are unchanged,
and `proposals/<id>` still resolves but opens the review dialog over the routines home rather than
a screen of its own (`GymApp.jsx:26-29`); `home()` and `landingAfterSignIn()` return `#/gym`
(`log.js:28-62`, `:101-117`; `routes.js:21-27`). Today is gone as a screen and as a tab.

**P6 · Three design-system pieces, authored before any gym twin is deleted — one done, two missing.**
`12-native-idiom.md` says a component the wave needs is authored in the design system, not in the
gym folder. Done: `design-system/feedback/Dialog.jsx:13` takes `gate="scrolled"` and a `footer` that
may be a function of `{ seen }` — the footer stays pinned and the caller disables its primary until
the body has been scrolled to its end or fits without scrolling; the review dialog uses it. Still
missing: `design-system/navigation/Tabs.jsx:3` is a segmented pill with `value`/`onChange`, not a
bottom nav rail; `design-system/Icon.jsx:150` registers `arrow-right` and no `arrow-left`, which is
why gym's `Back.jsx:2` imports `ArrowLeft` from lucide directly. **Blocks:** the rest of web
design-system adoption — the rail and the back.

**P7 · Gym's token vocabulary against the design system's.** Every design-system component styles
itself with inline styles reading `--surface-card`, `--text-primary`, `--color-brand`
(`Button.jsx:12-40`, `Toast.jsx:10-38`, `Card.jsx:3-23`), while gym renames every role onto
`.gym-root` (`gym.css:5-40`, `:43-78`: `--gym-surface`, `--gym-ink`, `--set-done`). The shared roles
are re-pointed for the room under `[data-brand="gym"]` (`palettes.css:199-228`), which `.gym-root`
carries (`GymApp.jsx:39,:46`), and the review `Dialog` and the `DotChart` already ship inside
`.gym-root` on those roles. Undecided: whether the `--gym-*` renames fold into that brand scope or
stay beside it — every twin that goes resolves one or the other. **Blocks:** the same adoption as
P6.

**P8 · Android's Material ColorScheme.** `WindmillMaterial.kt:26` sets `primary =
WindmillColor.gold400` (#D9B04C) on `surface = neutral0.dark` (#17120B, warm brown), and
`MainActivity.kt:61` wraps the whole gym room in it. The room paints iris on cool grey
(`ui/GymSkin.kt:25` `#9A90BE`, `:20` `#1C1A1E`). Gold in this room means a personal record
(`GymSkin.kt:35 prInk = #D9B04C`); iris means the agent proposed it. Convert a Material control
before re-pointing the scheme and the legend breaks. **Blocks:** every M3 component on Android —
Scaffold, TopAppBar, NavigationBar, ListItem, Switch, SegmentedButton, TextField, Snackbar.

**P9 · Android's `LocalWindmillDark` producer, and GymSkin's shape.** `Tokens.kt:31` declares
`staticCompositionLocalOf { true }` and **nothing provides it** — three hits repo-wide, the
declaration and two consumers. `isSystemInDarkTheme` appears nowhere in the module. `GymSkin.kt:19-40`
is a compile-time `object` of hard `Color` constants read at **733 sites across 24 files**, and the
accessor pattern it must adopt (`Tokens.kt:33-40`) is `@Composable` — so the call graph moves too,
including non-composable helpers like `Modifier.dashedEdge` (`GymSkin.kt:76`). **Blocks:** all
Daylight work on Android. Half-converting is worse than not starting: a light Material chrome
painted over a hard-coded dark room.

**P10 · Assign the refusals that a removed control carries.** `15-the-routine.md`'s own rule: "When
a wave removes a control, it inherits that control's refusals — and they are assigned to a named
board on a named surface before drawing starts." Killing the web target sheet's custom keypad
(`Routines.jsx:423-431`) orphans the four refusals in `logger/entry.js:49-62`, and
`logger/Keypad.jsx` is shared with `FixSheet.jsx:75`, which no brief assigns to web. On iOS the six
pinned refusals have **no home at all** today, because iOS never had a typed target field
(`KeypadSheet` is logger-only, `LoggerScreen.swift:467-474`) — they are new work, not a move.

**P11 · Whether `androidx.navigation` enters the Android build at all.** There is no navigation
entry anywhere in `gradle/libs.versions.toml`, and `NavHost`/`androidx.navigation` return zero
hits. If it does enter, two invariants have to survive it: the four back meanings at
`GymRoom.kt:274-290` (three of which are not pops), and the deliberately unsaved `away` stack
(`GymRoom.kt:186-188` — "NOT saved, so no screen is drawn over a store that has not read the disk
yet") against a NavHost that saves its own back stack and takes only string arguments.
`Away.Session` carries a whole `SessionSummary` object (`:136`) because it "carries facts no other
read gives back" (`:124`), and `Away.NoteEditor` (`:139`) carries a whole `Note` — two non-string
payloads where a route argument is a string. **Blocks:** `A2`, and the Scaffold conversion's back
affordance.

### 2.2 · Device proofs — one owed, two answered

**D1 · iOS: the shell's leading edge against a NavigationStack — unproven.**
`apps/ios/.../WindmillPlatform/Shell.swift:174-185` attaches the go-home swipe as a
`.simultaneousGesture` — the modifier whose meaning is *do not require exclusivity* — gated on
`startLocation.x <= edge` with `edge = 20` (`:159`, `:177`, `:181`). Its own comment at `:148-149`
says the swipe is hand-rolled because a hidden navigation bar disables the system pop. The only
three `NavigationStack`s in the app are `YouScreen.swift:13`, `YouScreen.swift:125` (`ProScreen`,
inside the first) and `SignInDoor.swift:22`, and all are presented as sheets (`Shell.swift:63,:65`)
— outside RoomHost's subtree. **The two gestures have never met in a running build.**
`12-native-idiom.md` rules the edge is arbitrated by depth; ledger `1k` says every iOS board in the
wave rests on this until it is proven. Prototype it on a simulator. The naive outcome is both
firing — a back swipe that also slides the room home. The quieter failure is a depth signal wired
backwards, which disables go-home permanently and leaves the switcher's Home row (`Shell.swift:287`)
as the only way out of a room. Nobody reviewing it will notice, because the room still works.

**D2 · Android: edge-to-edge and predictive back at targetSdk 36 — answered.**
`app/build.gradle.kts:21` sets `targetSdk = 36`. On an Android 16 device edge-to-edge is enforced —
the opt-out attribute is disabled — so `themes.xml:5-7`'s `statusBarColor`, `navigationBarColor` and
`windowLightStatusBar` are ignored there, and predictive back is on by default (`onBackPressed` is
no longer called; the room’s `BackHandler` at `GymRoom.kt:274` is what runs). On the API 34 emulator
neither applies. In both cases `GymRoom.kt:555`’s `.systemBarsPadding()` is what holds the layout,
so the room already draws under the bars on a new device with a theme that says otherwise, and the
Robolectric suite cannot see the difference — seven files pin `@Config(sdk = [35])`. Still unproven:
what a predictive-back animation does when the destination is a `when` branch inside one composable
(`GymRoom.kt:596-773`) rather than a NavHost entry — there is no second screen for the system to
reveal behind the peel.

**D3 · iOS: where a Live Activity's button handler runs — answered.** A `LiveActivityIntent`'s
`perform()` runs in the app's process, not the widget extension's, so the lock-screen button reaches
the app's own `SetQueue` in-process; the second-writer question is the in-process one, which
`GymRoom.swift:10` and `GymModule.swift:76` already pose — two instances of a store that holds the
whole file in memory (`SetQueue.swift:69`) and writes it atomically as a last-writer-wins whole-file
replace (`:334-337`) into the app's own Application Support container (`:143-148`), and the second
can write (`:81`, `:86-102`). The Live Activity adds a third. `SetQueue.swift:443` says what is at
stake: an owed set is the only copy of something somebody lifted. Wave 9 stays blocked on a signing
team and a second target (`project.yml:20-46`, signing off at `:42`), and on `14-live-activity.md`'s
five simulator checks (stale-date re-render, `ProgressView` past the end of its range, the one-point
layout margin against the truncation threshold, the circular presentation, and what a tap on an
inactive locked-screen button shows). **None has been run.**

### 2.3 · Two coordination rules

**Every server string change lands with all three client suites in the same change.** The
repositories are one tree; the contract is the suites. `AskApiTest.cpp` pins every sentence
`AskApi.cpp` sends, and `AskTests.swift` and `AskVerdictTests.kt` carry those bytes as fixtures and
assert the client echoes what it was handed — so a server sentence that moves without its fixtures
turns a phone suite red, and a fixture that moves without the server ships wrong bytes under a green
suite. Change both halves, and read the server's file for the bytes, never a test's.

**Every new tool needs its client phrase in the same change.** On every surface a tool absent from
the phrase table prints nothing — `coach.js:22-33` (`stepsLine`), `Ask.swift:37`, `Ask.kt:15` —
and the receipt stays, so a tool shipped without its words is a step the lifter never sees.
`TOOL_PHRASE` (`coach.js:4-15`), `Ask.phrase` (`Ask.swift:185-196`) and `Ask.phrases`
(`Ask.kt:96-107`) carry the same words, and the phone suites pin their tables against the web’s.

---

### 2.4 · There is no migrations directory, and that is the rule

The whole migration mechanism is one line: `backend/deploy/docker-compose.yml:34-36` runs
`psql … -v ON_ERROR_STOP=1 -f /app/db/schema.sql` once, before the server starts. `backend/db/` holds
`schema.sql`, `funnel.sql` and `FUNNEL.md` and nothing else. The file is idempotent DDL — `create
table if not exists`, `alter table … add column if not exists` — and it stays the single file: no
wave adds a migrations directory. `gym_notes` (`schema.sql:1084-1093`) and `gym_bodyweight`
(`:1102-1109`) landed that way with no backfill, and so did `gym_proposals.superseded_by` (`:1074`,
`add column if not exists`): existing rows keep null and read as *this proposal was superseded
before it was applied* until their routine moves.

**That is enough for a new table or a nullable column and not enough for a changed one.** These do
not fit it, and each needs a backfill plan — statements safe to re-run on every deploy, because the
deploy runs the file every time and a backfill that is not idempotent corrupts on the second run —
and a statement of what a stored row reads as afterwards:

- **B7** — dropping `gym_proposals.routine_id`'s not-null FK (`schema.sql:894`) for a polymorphic
  subject, and extending the pending-uniqueness index (`schema.sql:911-912`). **Every existing
  proposal row must acquire a subject.**
- **B11** — `from_lifter boolean not null` (`schema.sql:1057`) becoming a three-valued source. Every
  existing turn is one of the two old values; which?

## 3 · The order of work

Waves 0 (in part), 1, 2, 3, 3b, 4 and 7 are landed. The next wave is 5.

*Every wave below names its gates. A wave whose gate is unmet is not "start it carefully" — it is
not started.*

**Wave 0 · Decisions and proofs.** Everything in §2. No code. Ruled: P1, P2, P3, P4, P5, and the
`Dialog` half of P6. Answered: D2, D3. Open: P6's rail and back arrow, P7, P8, P9, P10 and P11 need
a developer to pick and record; D1 needs a simulator. *Unblocks:* everything below.

**Wave 1 · The defect sweep — done.** The prompt's retired-settings clause, the dismissal copy on all
three surfaces, the two latent Daylight tokens and the three black shadows on web, the tap floor on
Android, the rest clock's mid-rest flip on both phones, the iOS wake lock, and the discard
confirmation on all three surfaces.

**Wave 2 · Notes — done.** Backend resource, `list_notes` and its phrase on every surface, the
trust-boundary sentence in the prompt, the settings-zone move on web, three Notes screens, the third
CSV and the footprint. *Explicitly not in it:* note proposals. See §5.

**Wave 3 · The Coach rename and the room's copy — done.** Server strings, three clients, the tab
label and the suites in one change; with it the allowance line above the composer, the cap-reached
state, the thread-ceiling copy saying four, the two pinned stances, the typographic apostrophe, and
the raw tool trace collapsed behind the read receipt.

**Wave 3b · The web IA convergence — done.** Today is gone, the tabs are Routines · The log ·
Coach, the live mirror heads Routines home, the hash grammar is P5's. Ledger `0t` is closed.

**Wave 4 · The review sheet — done.** A sheet on the phones and the design-system dialog on the web,
over the conversation and over the routines home; one Apply, disabled until the diff has been seen
to its end; kept rows folded in place; the writer's kicker; the ephemeral receipt from the server's
apply reply; the superseded refusal's three sentences off `gym_proposals.superseded_by`. Ledger `1o`
and `1x` are closed; the gate re-locks when a kept run unfolds on all three surfaces.

**Wave 5 · Native idiom.** The largest wave. iOS: TabView, NavigationStack, List conversions,
`.toolbar`, `.searchable`, platform controls. Android: Scaffold, TopAppBar, NavigationBar,
NavHost-or-not, icons, TextField, Switch, SegmentedButton, snackbar. Web: design-system adoption.
Gated on D1 and the capsule-inset ruling (iOS), P8 and P9 (Android), P6 and P7 (web).
*Unblocks:* the gesture wave, which needs Lists, a snackbar host and a real back.

**Wave 6 · Gestures.** The withheld delete for routines, threads and finished sessions **first**;
then the set-row swipe, the logger's horizontal walk, the session-row context menu, and the undo
moving to the transient. Gated on Wave 5's containers and on the withheld-delete gate the briefs put
in front of two of the three swipes; the undo span is P4's 9000 ms everywhere.
*Unblocks:* nothing. It is the last wave that is purely additive.

**Wave 7 · Bodyweight — done.** The wire and the last claim-replay slot, the reading at the log
head, the chip in the reach band, the dated weigh-in sheet with its repair path, and the dot chart
as a new primitive — `design-system/charts/DotChart.jsx` on the web, Swift Charts and Compose
Canvas on the phones.

**Wave 8 · Type and Daylight.** XL on every surface, and both need measurements nobody has taken.
Type is additionally BLOCKED on web (`W37`). Daylight is gated on ledger `F4` — `--pr-ink`'s
stated 3.4:1 has never reproduced at any ground — and on P9 for Android.

**Wave 9 · Live Activity.** BLOCKED on a signing team and a second target in
`apps/ios/project.yml:20-46`, which today declares one target with signing deliberately off, and on
the four remaining simulator checks (D3).

**Deferred · The subject-bearing proposal.** The XL schema rebuild, note proposals, the
`from_lifter` → source migration and the durable receipt ledger row. This is a coherent programme of
its own and none of Waves 4-7 needed it. See `B7`, `B8`, `B11`, `B12`.

---

## 4 · Per surface

Sizes are S / M / L / XL. Every line cites the file it was read from.

### 4.1 · Backend — `backend/products/gym/`

**B7 · [REBUILD / XL] A proposal is routine-shaped all the way down.** *(Deferred programme.)*
Schema: `gym_proposals.routine_id text not null references gym_routines(id) on delete cascade`
(`schema.sql:894`), `base_revision` (`:897`), `base_name`/`proposed_name` (`:898-899`), and the
pending-uniqueness index `on gym_proposals (routine_id, door, connection) where state = 'pending'`
(`:911-912`). `gym_proposal_changes` carries a not-null `exercise_id` FK (`:926`) and eight
routine-target columns (`:927-934`). Domain: `ProposalHead.routine` is a `RoutineId`
(`domain/Proposal.h:101`), the constructor throws "a proposal names a routine" (`Proposal.cpp:55`),
and `Subject` has exactly three values — `log`, `catalog`, `program` (`Proposal.h:17`). Wire:
`toJson` emits `routineId` (`adapters/json/TrainingJson.cpp:444`), `parseProposalWrite` requires it
(`:205,216`), `ThreadProposal` carries `routine` and `routineName` (`domain/Thread.h:25-34`).
`10-notes.md:138-147` names this rather than letting a build discover it.
*Two structural traps.* A polymorphic `subject_id` cannot keep the foreign key, and that FK is
load-bearing: the `on delete cascade` at `:894` is what takes a routine's proposals with it, and
`PgProgramRepository::applyRemoval` relies on it. Dropping it leaves orphan proposals pointing at a
routine that is gone. And `10-notes.md:143` is right about the index: making the column nullable
does not extend it, because nulls do not collide, so pending note proposals would be unbounded. The
guarantee is the index and never an application check — `schema.sql:909-910` says so in as many
words — so any change to it is proven at the index, not in C++.

**B8 · [BUILD / L] The note proposal's base version, apply route and preview.** *(Deferred; gated on
B7.)* There is one apply path and it is routine-only: `routes.cpp:201-206` →
`ProgramApi::applyProposal` (`adapters/http/ProgramApi.cpp:168-211`) → `ProgramService::apply`
(`application/ProgramService.cpp:102-114`), with `gym_routines.revision` (`schema.sql:861`) as the
concurrency token, checked at `PgProgramRepository.cpp:570` and `:625`.
*Careless build:* reusing `gym_proposal_changes` for a per-line text diff. Its `exercise_id` is a
not-null FK to `gym_exercises` (`schema.sql:926`) and its payload is eight numeric target columns —
a note diff would need a sentinel exercise, which survives review and then poisons every read that
joins on it.

**B11 · [REBUILD / M] `from_lifter` is a boolean and the receipt needs three sources.** *(Deferred;
gated on B7's programme.)* `schema.sql:1057` declares `from_lifter boolean not null`. Blast radius:
`domain/Thread.h:17`, `ports/AskAgent.h:15`, the model mapping `turn.fromLifter ? "user" :
"assistant"` (`AnthropicAsk.cpp:112`), the load (`PgAskThreadRepository.cpp:49,54`), the insert
(`:176,180`), the export CASE (`:221-224`), the wire `turn["from"] = ... : "ask"`
(`TrainingJson.cpp:496`), and the prompt assembly (`AskService.cpp:188-189`).
*Three failure modes, and the wire one is worst.* `TrainingJson.cpp:496` is a two-value enum today;
three clients must tolerate an unknown `from` **before** the server emits one, or a ledger row
renders as an assistant message on a phone that has not shipped. Second: `AnthropicAsk.cpp:112` maps
every stored turn onto `user` or `assistant`, so a ledger row falling through that ternary is fed
back to the model as something it said — precisely the mis-statement `09-coach.md:107-108` says the
receipt exists to make impossible. Third: the export's `CASE WHEN n.from_lifter IS NULL`
(`PgAskThreadRepository.cpp:221-224`) carries a comment explaining that a plain CASE sends NULL down
the ELSE branch; the same trap waits for a third value.

**B12 · [BUILD / M] The receipt ledger row.** *(Deferred; gated on B11.)*
`appendTurns` is called from exactly one place — `AskService.cpp:238`, after a model run, through
`ThreadService::appendTurns` (`ThreadService.cpp:30-35`). The settle routes (`routes.cpp:201-212`)
touch no thread: `ProgramService` holds a `ProgramRepository` and a `Clock` and nothing else
(`ProgramService.h:69-71`). `ThreadProposal` (`Thread.h:25-34`) carries `createdAtMs` and no
settled-at, so on reopening a thread the receipt cannot be placed back in chronology.
**The *ephemeral* receipt is built on every surface and needed no backend work:** the apply reply
carries `proposal` and `routine` (`ProgramApi.cpp:207-210`) and `toJson(RoutineProposal)` emits
`baseName`, `name` and `changeCount` (`TrainingJson.cpp:441-449,556-560`), which is what the three
clients derive "Applied · Push A · 4 changes" from. Only durability is missing, and `09-coach.md`
beat four says the receipt is stated as ephemeral until this row exists. Shipping it as history
without the row is the failure the brief names.
*The seam:* wiring a `ThreadService` into `ProgramService` would put a conversation write inside the
program aggregate's apply transaction, against the dependency rule and against the file's own
comment at `ProgramService.h:34-36`. Either an application-level coordinator above both, or the
route composing the two — and the ledger row must not be inside the apply's transaction, because a
failed thread write must never roll back a routine that landed.

**B17 · [BLOCKED / S] Nobody has ruled whether a ledger turn is fed back to the model.**
Every stored turn goes to the model and every stored turn counts against the cap:
`AskService.cpp:187-189` builds the prompt from `opened.thread->turns` unconditionally; `:190-196`
refuses when `turns.size() + 2 > kMaxThreadTurns`, which is 8 (`Thread.h:70`); `AnthropicAsk.cpp:112`
has no third branch. `09-coach.md:180-182` fixes the lifter-visible ceiling at four questions
precisely because a question and its answer are two turns against eight. What the briefs do not say
— I looked — is whether a ledger row is shown to the model on the next turn.
*Both answers are defensible and they are not equivalent.* Hidden, the model can contradict a
receipt the lifter is looking at. Shown as an assistant message, the model reads a server-authored
sentence as something it said. Deciding it by filtering the load in the repository is the cheapest
implementation and the easiest to get silently wrong: `AskService.cpp:192` would count a filtered
list and the export at `PgAskThreadRepository.cpp:216-232` an unfiltered one.

### 4.2 · iOS — `apps/ios`

The two prerequisites specific to this surface are **D1** (the leading edge) and the capsule inset:
`Shell.swift:167-172` reserves the capsule lane with a top `.safeAreaInset` holding a 38pt button
plus `WindmillSpace.x2` padding, applied by RoomHost **outside** the room's view tree, so no gym file
can reclaim it. `12-native-idiom.md` is blunt: either the shell stops applying it for a room that
hosts its own top bar, or native costs vertical space and no board may claim otherwise. Build the
TabView conversion first and every board is drawn against a frame ~46pt taller than the device gives
— and the shortfall surfaces at the *bottom*, where the logger's elastic today-column
(`LoggerScreen.swift:264`, capped at 156pt) eats it silently and drops a row. **[PREREQUISITE / S]**

**I1 · [REBUILD / L] The hand-rolled capsule rail becomes a TabView; the You seat leaves the bar.**
`GymRoom.swift:280-301` draws an HStack of three text Buttons inside a `Capsule().fill(skin.surface)`
with `YouSeat()` as a fourth element at `:293`; tabs at `:39-45`. `TabView` appears nowhere in
`apps/ios`. `12-native-idiom.md` and ledger `1l` move both shell seats
into the room's own top chrome — capsule leading, You trailing, on each stack root.
*Careless build:* deleting the You seat before the room has a top bar to receive it. It is the
standing door to the account and to sign-in — the signed-out stances route through
`shell.openYou()` too (`GymRoom.swift:184`, `:228`, `:235`), but only while one is on screen — so an
anonymous lifter on a screen with no stance loses the way to claim their log. Second: ledger `1v`
measures the selected/unselected tint separation at roughly 1.15:1 (`skin.accent` #9a90be,
`GymSkin.swift:34`, against `skin.inkFaint` #8d8896, `:40`) — a native tab bar's labels are
colour-only, so the conversion makes an existing legibility defect worse unless the tokens move
first.

**I2 · [REBUILD / XL] The hand-built `away` stack becomes a NavigationStack.**
`GymRoom.swift:16` holds navigation as `@State private var away: [Away]`, ten destinations at
`:53-62`, push/pop at `:255-259` and `:274-278`, and a bottom-drawn back row at `:303-326` with a `chevron.left`
and the previous destination's name. There is no interactive pop — the room has no navigation bar,
which is exactly the condition `Shell.swift:148` names as the reason the home swipe is hand-rolled.
*Careless build — the item most likely to ship a state bug no test catches:* `GymRoom.swift:149-244`
arbitrates the whole stage in one switch where a finished session outranks a live session, which
outranks every away screen, which outranks the tab; `showing` returns nil whenever a session is open
(`:250-253`), so today starting a workout silently swallows any pushed screen. A NavigationStack owns
its own path, so the same event must now explicitly unwind it. A stack left standing behind a live
logger is a lifter who finishes a workout and lands three screens deep in a routine editor. Gated on
**D1**.

**I3 · [REBUILD / L] Session, Routines and Threads convert from ScrollView to List.**
WindmillGym holds 18 `ScrollView` sites across 15 files and three `List {` — `JumpSheet.swift:29`,
`RoutineBuilderScreens.swift:140` and `NotesScreen.swift:71`; `.swipeActions` appears in the first
two only (`:36`, `:148`). The three screens the gesture wave needs are ScrollView +
VStack: `SessionScreen.swift:119`, `RoutinesScreen.swift:24`, `ThreadsScreen.swift:25`. The session's
sets are grouped by movement (`SessionScreen.swift:205-232`), so it becomes sections, not a flat list.
*Careless build:* every row is currently a `Button` wrapping a card with its own fill and stroke
(`SessionScreen.swift:250-275`, `RoutinesScreen.swift:165-211`, `LogScreen.swift:231-268`). A List
applies its own insets, separators and background; the two existing conversions already fight it
with `.listRowBackground(Color.clear)`, `.listRowSeparator(.hidden)`, `.listRowInsets(...)` and
`.scrollContentBackground(.hidden)` (`JumpSheet.swift:33-35,:44-46`). Lose the card frame and
nothing separates a set row from a movement heading.

**I4 · [BUILD / L] The withheld delete for the routine row, the thread row and a finished session.**
The routine and the thread delete immediately, with no confirmation, no hold and no undo; the
session discard is confirmed and then unrecoverable. Routine: `GymRoom.swift:467-477` calls
`store.deleteRoutine`, affordance three screens deep at `RoutineBuilderScreens.swift:261`. Thread:
`ThreadsScreen.swift:334-344` calls `doors.delete` and leaves the screen. Discard session:
`FinishScreen.swift:264-269` asks *Discard this session?* and then calls `onDiscard` into
`GymRoom.swift:453-460`.
`13-gestures.md` makes this the gate for the whole gesture wave: those three get a withheld delete
before they get a gesture.
*Careless build:* skipping it, because the swipe is the visible half. `.swipeActions` on any of
those rows first puts an unrecoverable delete one careless thumb away — and on the routine row it
cascades the proposal ledger (`schema.sql:894`).

**I6 · [BUILD / M] A trailing swipe to delete on the set row of a past session.**
The only row ready today. `SessionScreen.swift:250-275` draws each performed set as a Button opening
the fix sheet, with `.accessibilityHint("Fix this set")` at `:274`; delete lives inside that sheet
(`FixSheet.swift:154`). The 9000 ms hold and its restore path exist: `SetQueue.swift:48`,
`TrainingStore.swift:1057-1077` and `:1079-1102`, with an inline undo row at `SessionScreen.swift:180-203`.
`13-gestures.md`: one action, Delete, trailing edge, nothing leading.
*Careless build:* adding a second trailing action — the brief measured that two actions eat about
half the row and push the set's ordinal and load off the leading edge. Or enabling full-swipe, which
makes two-deletes-in-a-second the fastest path while the undo holds one. Gated on **I3**.

**I7 · [FIX / M] The undo holds exactly one delete and nothing says so when the second arrives.**
`TrainingStore.swift:178` is `private var taken: Deletion?` — one slot, overwritten at `:1058-1060`,
so a second delete **settles** the first: the first set's DELETE stays queued with its own
`heldUntilMs` (`SetQueue.swift:280-282`) and goes out when the hold expires, with no way back.
`restorable` (`:180-183`) is time-gated and not published, which is why `SessionScreen.swift:183`
polls it with `TimelineView(.periodic(...))`. `13-gestures.md`: either the window holds more than
one, or the second swipe is refused with the reason said plainly. Tolerable behind a two-tap trip
through a sheet; dangerous behind a swipe.

**I8 · [FIX / M] Leaving the room force-sends a held delete, and nothing says it did.**
`GymRoom.swift:142-145` ends `.onDisappear` with `store.flushPendingSets(force: true)`;
`force` reaches `TrainingStore.swift:1198`, `queue.nextOwed(skipping: blocked, readyAt: force ? nil :
now())`, and `SetQueue.swift:236-243` documents that a nil instant skips the hold entirely.
`TrainingStore.swift:613` already states the consequence in a comment. Behind a swipe this means
*swipe, then press back* — an ordinary pair of actions — destroys the row while the undo is still
nominally on screen. It becomes reachable by accident the day the edge-swipe back lands (**D1**): the
same stroke that used to go home now pops a screen, and the pop commits the delete.

**I9 · [REBUILD / M] The undo leaves the row and becomes a transient, on both screens.**
`LoggerScreen.swift:286-290` draws `Button("Undo")` inside the today-column row;
`SessionScreen.swift:180-203` draws a separate inline row at the top of the scroll.
`13-gestures.md` Law 4 sends both to an iOS bottom transient carrying the action **and** the fact
that a window is open, retiring itself when the window closes.
*Careless build:* growing the bottom inset. The logger's Log-set button is pressed five to forty
times a session (`LoggerScreen.swift:442-460`); a transient that reflows the screen makes it jump
twice per set. SwiftUI has no built-in transient here, so it is hand-rolled and must retire on a
clock the store does not publish (`TrainingStore.swift:180-183`).

**I10 · [BUILD / M] A horizontal swipe between movements in the logger.**
`LoggerScreen.swift:187` and `:222` draw two 46×46 `walkButton`s (`:226-236`) stepping through `store.order`
(`:238-244`); the title between them is a full-width Button opening the JumpSheet (`:188-220`); the
today-column beneath is a nested vertical ScrollView (`:253-262`). Leaving a movement can raise the
DeviationSheet through `move(to:)`/`settleTheMove` (`:531-555`), a path written for taps.
*Careless build:* the deviation guard at `:532-537` keys on `asked` and on whether a sheet is up
(`:539-542`); at swipe velocity two movements can be crossed before `settleTheMove` runs, and the
pending deviation is a single `@State` slot (`:22`) the second swipe overwrites. This gesture also
starts in the body and must lose to the shell's leading-edge claim — unarbitrated until **D1**.

**I11 · [BUILD / S] A context menu on the log's session row — Share this workout, alone.**
`contextMenu`/`Menu {` return nothing across `apps/ios`. `LogScreen.swift:231-268` draws the session
row as a single Button with one action. Sharing lives only inside the session
(`SessionScreen.swift:127`), discarding only on the finish screen.
*Careless build:* adding the obvious second item. `13-gestures.md` is explicit that Discard does not
go in this menu until the withheld delete exists, and that a confirmation would not rescue it.

**I12 · [REBUILD / L] The target sheet's five affordances become three typed fields.**
`RoutineBuilderScreens.swift:294-484` offers hand-built sets and reps steppers (`:385-414`), a ±
plate ladder (`:463-483`), "take it to max" and "use last time" (`:447-461`) and "Leave it open ·
decide at the rack" (`:349-360`). **There is no typed entry at all** — `KeypadSheet` is reached only
from the logger (`LoggerScreen.swift:467-474`), so a target weight cannot be typed on iOS today.
`15-the-routine.md`: three fields, no escape hatch, placeholders carrying the null semantics, and
the ± ladder comes off.
*Careless build:* the six pinned refusals have no home on iOS (see **P10**). They are new work, not a
move, and the brief records that three surfaces already lost four of them once by leaving them
unassigned. Ledger `2l` additionally records that iOS and Android draw the
clear-refusal at two different moments of the same keystroke and nothing has picked between them.

**I13 · [FIX / S] The routine editor's suggestion chips.**
`RoutineBuilderScreens.swift:238-253` draws capsule chips from `RoutineDraft.suggestions` while the
name field is empty. `15-the-routine.md` deletes them with the naming step.
*The opposite risk applies here:* **iOS has no naming interstitial.** The name is already the
editor's first field (`:209-235`), already focused on open (`.task` at `:92-95` sets `namingIt =
true`), and Save is already gated on `savable` (`:61-64`, `:202`). A developer reading the brief's
opening will look for a full-screen interstitial, not find it, and either invent work or assume the
file is wrong. Only the chips are owed here.

**I14 · [REBUILD / M] The editor's foot buttons move to an overflow, and the nav bar gains a Cancel.**
`RoutineBuilderScreens.swift:255-270` draws Duplicate and Delete routine as foot buttons; the head
(`:189-206`) carries a title and Save only; the only exit is the room's bottom back row
(`GymRoom.swift:303-326`).
*Careless build:* converting the head to `.toolbar` without adding Cancel. `:57-58` keeps `opening`
precisely so an edit can be compared against what was loaded, so a silent back is a silent discard of
every edit. Delete must not reach the overflow before **I4**.

**I15 · [REBUILD / M] `.searchable` replaces the picker's hand-built field, and the seven-row cap
moves with it.** `MovementPicker.swift:95-104` is a bare `TextField` styled as a rounded rectangle
above a plain ScrollView (`:106-121`), and `:7` caps the list at `shown = 7` for every query,
including the empty one. `15-the-routine.md` wants the platform control and "an empty query shows
the six and then the whole catalogue"; ledger `2j` records that **no
surface implements that ruling** and names this constant as the iOS blocker.
*Careless build:* swapping the control and leaving `shown = 7`, which ships the same defect under a
native chrome — worse, because the picker now looks like it browses the catalogue and does not.
`.searchable` also needs a List inside a NavigationStack to render where the system puts it, so this
is gated on **I2** and **I3**.

**I23 · [REBUILD / XL] The type ramp — 384 literal point sizes, and Dynamic Type does nothing.**
414 font call sites in WindmillGym carry a literal size (480 across `apps/ios`), spread across every
screen (34 in `AskScreen.swift`, 27 in
`ConnectedLog.swift`, 26 each in `RoutinesScreen.swift`, `RoutineBuilderScreens.swift`,
`LoggerScreen.swift`, `ThreadsScreen.swift`, `ReviewSheet.swift`). `Font.TextStyle`, `ScaledMetric` and `dynamicTypeSize` appear **nowhere** in
`apps/ios`. Instrument numerals are fixed points: `GymSkin.swift:64-66` pins weight at 104, reps at
36, the correction figure at 72, with `minimumScaleFactor` as the only guard
(`LoggerScreen.swift:319`, 0.55). Uppercase eyebrows carry 25 hand-set tracking values (`.tracking(`
eleven times, `.kerning(` fourteen).
*Careless build:* the logger's today-column claims its height from named constants before its rows
lay out — `rowHeight = 52`, `columnCap = rowHeight * 3` (`LoggerScreen.swift:270-271`), used at `:264`
as `min(columnCap, rows.count * rowHeight)`. Under Dynamic Type the rows grow and the frame does not,
so rows clip silently at exactly the setting whose purpose is legibility. Every hand-set fixed-width
column breaks the same way: `SessionScreen.swift:256` (`width: 18`), `LoggerScreen.swift:278`
(`width: 16`), `AskScreen.swift:339` (`width: 54`). These become grids. `12-native-idiom.md` is
explicit that the point values at the largest accessibility sizes are read off the simulator's
accessibility inspector, not taken from published defaults.

**I24 · [REBUILD / XL] Daylight — the room forces itself dark in three places and declares one skin.**
`GymRoom.swift:80` is `private var skin: GymSkin { .instrument }`, a computed constant with no
producer; `:98` writes `.environment(\.colorScheme, .dark)` into the whole room and `:99` dresses the
capsule dark. `GymSkin.swift:28-49` declares exactly one skin and `:52-54` makes it the environment
key's default. The shell's Appearance control is real and working (`YouScreen.swift:53-65`,
`Shell.swift:55-56`) — gym is the room ignoring it.
*Careless build:* the skin reaches the room through an environment key whose default is hardcoded to
`.instrument`, so any view presented outside the room’s environment keeps the dark skin — and gym
pins a sheet’s ground to the skin explicitly at ten sites (`GymRoom.swift:112`, `SessionScreen.swift:145`,
`LoggerScreen.swift:110`, `RoutineBuilderScreens.swift:105,:110,:125`, `LogScreen.swift:141`, `BodyweightScreen.swift:52`, `NotesScreen.swift:47`, `RecordScreen.swift:56`). A half-conversion is a light room
with dark sheets. Gated on ledger `F4`.

**I25 · [BLOCKED / XL] The Live Activity target does not exist.**
`ActivityKit`, `WidgetKit`, `AppIntent` and App Group identifiers return nothing across `apps/ios`.
`project.yml:20-46` declares one target with `CODE_SIGNING_REQUIRED: "NO"` (`:42`) and no team, on
purpose (`:40-41`). BLOCKED on that signing team and second target, and on the five simulator checks
`14-live-activity.md` names (**D3**). One separate build risk worth pinning now: "the app mints the id and hands it to the button
as part of the activity's state" — idempotency does not cover this on its own, because two taps mint
two ids and two ids are two sets.

**I26 · [BLOCKED / L] SetQueue is one-per-process by construction.** See **D3**.

**I28 · [BUILD / S] The set kind offers two of its four values on the logger.**
`SetKind` has four cases (`Training.swift:6-7`); the logger's pill iterates `[SetKind.working,
.warmup]` only (`LoggerScreen.swift:376-378`), so drop and failure cannot be chosen while logging.
The fix sheet offers all four after the fact (`FixSheet.swift:120`). The pill disarms to `.working`
after every logged set (`:448`).
*Note the brief's premise is false here* — this is an extension, not a first build, and a developer
who reads "no surface has ever offered" will delete and rewrite a working control. *The real hazard*
is the disarm: a four-way control that forgets to reset files every working set after a drop as a
drop, which corrupts every statistic the product shows, silently.

**I29 · [REBUILD / L] Finish becomes a sheet over the session; the Finish action becomes a toolbar
item.** `GymRoom.swift:151-160` renders the finish screen above everything with `isAtRest` false and
`showing` nil (`:250-253`), so the bottom bar draws no back button at all. Its only exits are Done
and Discard. Finish itself is a hand-drawn Button inside the logger's header
(`LoggerScreen.swift:129-132`), not a `.toolbar` item — so this is a conversion, not a move from the
bottom band.
*Careless build:* `close()` (`GymRoom.swift:434-451`) only sets `finished` after the log answers, and
has two non-closing outcomes — `.stranded(count)` and `.failed(why)` — that leave the session open.
A sheet "over the session it just closed" needs that session navigated to underneath first, which
the room does not do, so the naive build presents a sheet over the live logger of a workout that is
still open.

**I30 · [REBUILD / M] Loading, empty and share states are hand-drawn where the platform has a
control.** `ProgressView`, `ContentUnavailableView`, `ShareLink` and `Stepper` appear nowhere.
Loading: `LogScreen.swift:283-293`, `ReviewSheet.swift:41-43`, `ThreadsScreen.swift:32-34` and `:195-197`. Empty:
`RoutinesScreen.swift:64-99`, `LogScreen.swift:200-210`. Sharing writes to the pasteboard
(`CoachShare.swift:186`). Settings hand-builds segmented controls (`SettingsScreen.swift:53-68`,
`:89-104`); its `Toggle` at `:170` is the one genuinely native control in the room.
*Careless build:* `ContentUnavailableView` renders one description and one action, and the Routines
empty state ships two of deliberately different weight — "Build a routine" primary, "Just start
logging" beneath (`RoutinesScreen.swift:81-95`) — so a straight swap deletes the second. Replacing
the pasteboard copy with `ShareLink` also changes what the lifter gets: `Coach.card` reports a
`copied` state back into the card (`CoachShare.swift:60-62,:186`), and a share sheet has no equivalent.

**I32 · [FIX / M] A set's note and RPE round-trip on the wire and appear on no iOS screen.**
`TrainingSet` carries `rpe: Double?` and `note: String` (`Training.swift:152-153`), decoded and
encoded (`:201-202,:214-215`), preserved through a fix (`:177`). `SetFix` carries only weight, reps
and kind (`:725-734`). **No iOS view reads either** — verified: the `.note` references at
`SessionScreen.swift:265` and `LoggerScreen.swift:282` are derived plan-comparison strings, not the
set's own. Ledger `1s`: it is drawn on none here.
*Careless build:* `SetFix` is the wire body for the PATCH (`TrainingStore.swift:1205-1207`); adding
fields changes what a correction overwrites, and `TrainingStore.swift:1104` already warns that a PATCH
filed over an owed append destroys the only copy of that set.

### 4.3 · Android — `apps/android` (`:app :platform :gym`)

Surface prerequisites: **P8**, **P9**; D2 is answered, and only the predictive-back animation over the
hand-rolled dispatch is still unproven.

**A1 · [FIX / M] Back has four meanings and a fifth that leaves the app mid-workout.**
`GymRoom.kt:274-290`: `BackHandler(enabled = finished != null || (!live && (building != null ||
away.isNotEmpty() || tab != Tab.Routines)))` with four bodies — claimed and inert on the finish
screen (`:278`), Cancel-and-discard-the-draft (`:279-283`), pop one (`:284-287`), return to
`Tab.Routines` (`:288-289`). **Mid-workout the handler is disabled by construction** (the comment at
`:270-272` says so), so a system back during a workout is plain platform back and leaves the room.
`13-gestures.md` corrects itself on exactly this point: the logger is the *most* exposed screen to an
edge-started horizontal gesture, not the safest.
*Careless build:* a NavHost gives none of the four for free — a NavHost pops a destination, and three
of the four are not pops. And closing the mid-workout hole has a cost the brief does not price:
`away` is deliberately not saved (`GymRoom.kt:186-188` — "NOT saved, so no screen is drawn over a
store that has not read the disk yet"), so a handler that keeps the lifter in the room during a
workout also has to not resurrect a screen over an unread store.

**A2 · [BUILD / XL] Navigation is a sealed list and eight hand-drawn back rows.**
`gradle/libs.versions.toml` has no navigation entry; `NavHost` and `androidx.navigation` return
zero hits. Navigation is `var away by remember { mutableStateOf<List<Away>>(emptyList()) }`
(`GymRoom.kt:189`) over `sealed interface Away` (`:135-146`), dispatched by a 178-line `when`
(`:596-773`). Back is drawn by hand in eight places: `GymRoom.kt:576-588`, `SettingsScreen.kt:111-120`,
`BodyweightScreen.kt:333-340`, `RecordScreen.kt:171-180`, `ThreadsScreen.kt:363-373`, `AskScreen.kt:178-190`,
`NotesScreen.kt:537-549`, `RoutinesScreen.kt:367-374`.
*Careless build:* a NavHost saves and restores its back stack, which is precisely what
`GymRoom.kt:186-188` refuses on purpose; and `Away.Session` carries a whole `SessionSummary` object
(`:136`) because, per the comment at `:130`, it "carries facts no other read gives back" — a route
argument is a string, so that screen needs a different data path before it can be a destination.
Doing this carelessly turns a documented decision into a silent regression. Gated on **P11**.

**A3 · [REBUILD / L] Scaffold, TopAppBar and NavigationBar.**
The whole room is `Column(Modifier.fillMaxSize().background(GymSkin.canvas).systemBarsPadding())`
(`GymRoom.kt:551-556`). The tab rail is hand-rolled (`:809-850`): a 50dp Row, full-radius background,
1dp border, three 40dp pills, plus `YouSeat` (`:853-897`). There is **no top bar at all** — screen
titles are `Text` inside the scroll (`LogScreen.kt:143`). The rail draws only when `ended == null &&
!live && building == null && away.isEmpty()` (`:791`).
*Careless build:* those four conditions are load-bearing. A Scaffold's `bottomBar` slot makes it a
lambda returning nothing, and an empty NavigationBar still reserves height. Same for the top bar:
native costs vertical space, and the logger is the one screen where the numeral competes for every
point (`LoggerScreen.kt:235`: "One elastic region only, the history: sets can never push the 64dp
action out of reach"). Gated on **P8**.

**A4 · [BUILD / M] Icons at all — there are none.**
`Icon`, `Icons`, `IconButton` return zero hits across `gym`, `platform` and `app` main sources. Every
affordance is a text glyph: "‹"/"›" (`GymRoom.kt:585`, `LoggerScreen.kt:427,:462`,
`RoutinesScreen.kt:239,:293`, `SettingsScreen.kt:117`, `ThreadsScreen.kt:371`), "↑" for send
(`AskScreen.kt:621`), "+" (`RoutinesScreen.kt:158`), "✓"/"·" (`SessionScreen.kt:391`).
*Not missing:* `androidx.compose.material:material-icons-core` is an `api` dependency of material3
1.3.2 and is resolved at 1.7.8 in the local Gradle cache, so the `Icons.Filled` /
`Icons.AutoMirrored.Filled` core set compiles today with no build-file change.
*Careless build:* the core set is ~60 icons and is **not** Material Symbols;
`material-icons-extended` is not in the graph and is deprecated upstream, so "Material Symbols on
every affordance" needs a source decision first. And swapping a text glyph for an icon deletes the
only thing TalkBack reads *and* breaks the Robolectric UI suite, whose screen tests locate nodes by visible text
(`onNodeWithText`, seven of the fourteen files in `gym/src/test/.../ui/`). Every icon needs its `contentDescription`
and every affected test a new locator, in the same change.

**A5 · [BUILD / L] Accessibility: three contentDescriptions in the whole room.**
`LoggerScreen.kt:378` (the rest clock), `BodyweightScreen.kt:224` (the weigh-in field) and `:514` (a chart dot). `LoggerScreen.kt:443` is
`clearAndSetSemantics { }`, which *removes* the progress dots from the tree. `customActions` exist on
the note rows only (`NotesScreen.kt:285`); `Role.` and `stateDescription` on the two step
disclosures (`AskScreen.kt:437-438`, `ReviewSheet.kt:338-339`) and the window control (`BodyweightScreen.kt:425`); `onClickLabel` at `LoggerScreen.kt:376` and `BodyweightScreen.kt:515` only. The
hand-built switch (`SettingsScreen.kt:422-454`) is a `Row` with
`.clickable` and a coloured Box — TalkBack sees a button with no state and no role.
`13-gestures.md` Law 1: on Android a swipe is half-built until its custom action exists, declared by
hand on every row, and every Android board drawing a swipe says so.
*Careless build:* building the swipes first. The missing half is invisible in every screenshot and
every Robolectric test the project runs. This is the largest item on the surface by row count and the
easiest to under-scope.

**A6 · [FIX / M] The routine row carries no overflow control.**
`RoutinesScreen.kt:199-245` is a whole-row `.clickable` (`:218`) ending in a decorative "›"
(`:238-243`); its only other targets are two chips. `DropdownMenu` returns zero hits. Duplicate and
Delete live only in the editor’s foot (`RoutineBuilder.kt:400-421`).
`13-gestures.md` prices the routine-row swipe as free on Law 1 because "that row already carries an
overflow control". **It does not.** The overflow has to be built first, or the swipe ships as the only
path to Delete for a TalkBack user, which Law 1 forbids. Anyone planning from the brief alone will
under-size this row by a whole control.

**A8 · [REBUILD / S] Four of the room's ModalBottomSheets still pass `dragHandle = null`.**
`SessionScreen.kt:226`, `RecordScreen.kt:124`, `RoutineBuilder.kt:145`, `LoggerScreen.kt:291`; the
review sheet (`GymRoom.kt:522-529`) and the two weigh-in sheets (`LogScreen.kt:192-196`,
`BodyweightScreen.kt:364-368`) show the handle. All four use `skipPartiallyExpanded = true`, which
already satisfies `09-coach.md`'s no-fixed-partial-detent rule.
*Careless build:* the handle adds ~28 dp of chrome at the top of every sheet. `KeypadSheet.kt` is
height-tuned against the current geometry and the picker's body is a `verticalScroll`
(`MovementPicker.kt:202`), so the handle eats content rather than growing the sheet.

**A9 · [BUILD / M] There is no snackbar.**
`Snackbar`/`SnackbarHost` return zero hits. Messaging is one `var note` (`GymRoom.kt:193`) drawn as a
12sp mono `Text` with `maxLines = 2` above the rail (`:777-788`), cleared on every navigation
(`:239-243`, `:245-249`) and every tab change (`:795`).
*Careless build:* reusing the `note` slot for the undo transient silently inherits clear-on-navigate
— and `13-gestures.md`'s whole point is that the window's state stays visible until the window
closes. The room also has no Scaffold to host a `SnackbarHost`, and a hand-placed host is the
invention `12-native-idiom.md` exists to remove. Gated on **A3**.

**A10 · [REBUILD / M] The undo is drawn inline in two places.**
`LoggerScreen.kt:525-533` draws a text "Undo" inside the today set row; `SessionScreen.kt:213` draws
`WithheldRow` (`FixSheet.kt:199-218`) inside the session’s vertical scroll.
*Careless build:* the window is 9000 ms (`SetQueue.kt:52`) and the logger's row visibility is
recomputed against a 1-second ticker (`LoggerScreen.kt:160-166`, feeding `:246`). A transient
dismissed by the platform before 9 s, or outliving the window, breaks the one honest property the
change buys. **The duration is driven from `SetQueue.undoWindowMs`, never from a snackbar default.**

**A11 · [FIX / M] Leaving a session settles the withheld delete, and the window holds one.**
`GymRoom.kt:314-319`: a `LaunchedEffect(standingSession)` calls `store.settleWithheld()` the moment
the standing session changes — the comment at `:314` says "A withheld delete belongs to the screen
the gesture was made on, so leaving it ends the window." `settleWithheld`
(`TrainingStore.kt:1275-1282`) sends it. `withhold` (`:1260-1265`) replaces `withheld` and settles the
previous one, with the comment at `:1258-1259` stating "ONE SLOT". The room partly says what it did —
`GymRoom.kt:318` sets a note — but **only on failure**, never on the ordinary settle.
*This is the item most likely to be skipped because nothing about it is broken now.*

**A12 · [BUILD / L] A withheld delete for routines and threads.**
`Withheld` is set-shaped: `data class Withheld(val sessionId: String, val set: TrainingSet, val
untilMs: Long)` (`TrainingStore.kt:1697`), held in one field (`:151`). Routine delete fires
immediately (`dropRoutine`, `:825-847`, called from `GymRoom.kt:487-499`); thread delete fires
immediately (`ThreadsScreen.kt:243-273`, behind only a caption at `:242`).
*The brief's claim that this "generalises cleanly" is not supported by the type.* `dropRoutine`
writes through `localLog.orphanRoutine` for a device-held routine (`:827`) and through
`log.deleteRoutine` otherwise (`:834`); `deleteThread` is server-only. This is a new abstraction over
three different delete verbs, not a widened data class. Sizing it from the brief's sentence will
under-scope it, and getting it wrong means an undo that reports success while the row is already gone
from the server.

**A13 · [REBUILD / L] Two LazyColumns in the whole room; every swipe is hand-built on raw pointer
input.** `LazyColumn` appears twice — `AssemblySheet.kt:86` and the notes list, `NotesScreen.kt:256`.
Everything else is `Modifier.verticalScroll` (16 call sites), including the entire log:
`LogScreen.kt:135-179` builds every week and every session row eagerly inside one scrolling Column.
The two swipes are hand-rolled (`AssemblySheet.kt:110-122` with a px threshold at `:64` and an alpha
ramp at `:101`; `RoutineBuilder.kt:354-364` the same shape), and both reorders too
(`detectDragGesturesAfterLongPress`, `AssemblySheet.kt:134`, `NotesScreen.kt:294`). `SwipeToDismissBox` returns zero hits.
*Careless build:* the assembly sheet's swipe is **conditional** (`if (!row.canDrop) return@pointerInput`,
`:111`, gated on `LiveOrder.droppable`), and a `SwipeToDismissBox` has no "this row is not swipeable"
state short of not wrapping it — the conditional moves to the composition, not a gesture callback.
Converting `verticalScroll` to `LazyColumn` also changes what `rememberSaveable` state survives a
scroll, and `LogScreen`'s rows come from a fold producing nested groups (`LogFold.weeks`,
`LogScreen.kt:64-98`), so it becomes `items` inside `items`.

**A14 · [BUILD / M] Eight hand-rolled BasicTextFields, five of them with a decorationBox.**
`TextField`/`OutlinedTextField` return zero hits. Eight sites: `RenameSheet.kt:70`,
`MovementPicker.kt:170` (search) and `:271` (create-movement), `FinishScreen.kt:330`,
`RoutineBuilder.kt:275` (routine name), `AskScreen.kt:582` (composer), `NotesScreen.kt:511` (the
note editor), `BodyweightScreen.kt:209` (the weigh-in). One more in platform:
`SignInDoor.kt:188`. `SearchBar` returns zero hits.
*Careless build:* a Material `TextField` is 56 dp with its own label and supporting-text slots and
takes its colours from the ColorScheme — so this cannot land before **P8** without every field coming
up gold-focused. The routine-name field is also the one `15-the-routine.md` wants opened with the
keyboard already up (`RoutineBuilder.kt:224-225` does this with a `FocusRequester` +
`LocalSoftwareKeyboardController`), and that autofocus must survive the swap.

**A15 · [BUILD / S] Switch and SegmentedButton are hand-drawn.**
`ToggleLine` (`SettingsScreen.kt:422-454`) is a 46×27 dp Box with a 21 dp knob, animating nothing,
used three times. The units picker (`UnitsRow`, `:124`) and rest-target picker (`RestRow`, `:163`) are hand-built
segmented rows of Boxes. `Switch` and `SegmentedButton` return zero hits.
*Careless build:* `SingleChoiceSegmentedButtonRow` draws a leading check icon on the selected item by
default, which neither picker shows today, and Material's `Switch` is 52×32 dp against the hand-built
46×27 — both settings cards are laid out around the current sizes. The accessibility gain is the
actual reason to do it: the hand toggle exposes no `Role.Switch` and no on/off state.

**A24 · [REBUILD / XL] Type: every size is a literal; `MaterialTheme.typography` is never set.**
`WindmillFont.display/body/mono(size: Int)` builds a TextStyle from a raw Int
(`platform/design/Tokens.kt:73-91`), called with literals at ~240 sites. `GymType.weight` is a fixed
104.sp with 92.sp line height (`GymSkin.kt:44-51`). `WindmillMaterial` passes only a colorScheme —
no typography argument (`WindmillMaterial.kt:11-13`) — so every future Material component takes stock
Material typography, not gym's. `fontFeatureSettings = "tnum"` is set on `GymType.weight` (`:50`) and
`GymType.numeral` (`:63`) and on **none** of the `WindmillFont` roles. Rows are pinned by
`heightIn(min = …dp)` at ~117 sites; columns by `widthIn(min = 42.dp)` (`FixSheet.kt:126`) and
`size(width = 32.dp, …)` (`AssemblySheet.kt:253`). One partial mitigation exists:
`TextAutoSize.StepBased(20.sp…26.sp)` (`LoggerScreen.kt:432-436`).
***The brief's premise needs qualifying before anyone builds from it.*** `12-native-idiom.md` says
"Both phones hard-code point sizes, so Dynamic Type and font scale do nothing on either." On Android
`.sp` scales with the user's font scale by definition, so font scale is **not** inert here. What is
missing is the named role scale, tnum on the non-numeral roles, and the cap/reflow. The real damage
at a large scale is the opposite shape: a 104.sp numeral grows without a cap while every fixed
`heightIn` row and fixed-width column does not, so the room **clips** rather than ignores. Building to
"font scale does nothing" produces the wrong fix.

**A25 · [FIX / S] The routines home puts the filled primary on the planning act.**
`RoutinesScreen.kt:108-121` draws "New routine" as the accent-filled 56 dp button; "Just start
logging" is a quiet text row beneath (`:122-134`). The empty state does the same (`:143-196`, with
"Build a routine" filled at `:167-180`).
Neither is pinned — both are items in a `verticalScroll` Column, with the connect pitch (`:136`) and the settings door (`:139`) after them.
*Careless build:* swapping the weights is trivial; making the primary **pinned in the reach band** is
not, because the button is a scroll item, and "reachable without changing grip" is false for a scroll
item at any list length. That means a Scaffold bottomBar or a pinned Box — gated on **A3**. Note the
empty state may want the opposite answer and the brief does not rule on it.

**A26 · [FIX / S] The connect pitch on the routines list — and what removing it leaves.**
`RoutinesScreen.kt:136` is the only call site of `ConnectInvitation` (`ConnectCard.kt:29`). Android's
other door is `ConnectedLogRow` (`SettingsScreen.kt:238`). **There is no connect page on Android**, and the
proposal screen has never carried a pitch. `15-the-routine.md` enumerates four homes and keeps two —
but Android has two, so cutting the routines-list one leaves the settings row as the only door here.
That may be right; it is a decision the brief did not make for Android and should be recorded rather
than taken silently, especially since `09-coach.md` leans on the connect door as "the one path that
is not rationed" in the cap-reached state, which draws that door.

**A28 · [FIX / S] Android has offered the set-kind control since it shipped.**
`var kind by rememberSaveable { mutableStateOf(SetKind.Working) }` (`LoggerScreen.kt:99`);
`KindPill(kind, onOpen = { sheet = LoggerSheet.Kind })` between the value block and the ladder
(`:263`); `KindSheet` at `:304-307`; disarmed on the tap with the comment "a warmup is a single set,
not a mode" (`:274-279`). The fix sheet offers all four (`FixSheet.kt:132-155`).
**Half of this is a ledger correction, not build work** — `16-the-workout.md`'s "no surface has ever
offered" is false. The other half is real: the brief rules that choosing the kind "must not cost a
trip", and a pill opening a bottom sheet is exactly that cost.

### 4.4 · Web — `web/src/products/gym/`

Surface prerequisites: **P4**, **P5**, **P6**, **P7**, **P10**.

**W16 · [REBUILD / XL] The room uses two design-system components inside `.gym-root`; every other
control is a twin.** The review dialog is the design system's `Dialog` (`Proposals.jsx:2`) and the
bodyweight screen its `DotChart` and `Tabs` (`bodyweight/Bodyweight.jsx:2`); the other three
importers are not room screens — `RoutinesGhost.jsx:2` (shell loading fallback),
`settings/GymSettingsSection.jsx:2` (`Switch`, inside the shell settings page),
`marketing/GymLanding.jsx:2`. Everything else a lifter touches in the room is hand-rolled in
`gym.css`, which carries 575 `.gym-` rules — `.gym-toast` (`:586-632`), `.gym-sheet` (`:637-696`),
`.gym-tabs`/`.gym-tab` (`:1064-1090`), `.gym-back` (`:356-367`), plus buttons, inputs, cards and
tags. Gated on **P6** and **P7**.

**W18 · [REBUILD / S] The naming interstitial dies.**
`Routines.jsx:116` seeds `naming` from `fresh`, and `:140-146` returns `NameTheRoutine` whenever the
id is `new`. That screen (`:280-317`) carries a back link, a title, a subtitle, an autofocused field
with a counter that appears from 48 characters (`:297`, `log.js:384-388`) and three suggestion chips from `NAME_SUGGESTIONS`
(`routines.js:14`). The editor already has an inline name field at `:182-192`.
*Careless build:* taking the Save gate with the screen. `Routines.jsx:151` computes `missing` from
the trimmed name and disables Save at `:193-199`, enforcing `Routine.cpp:40` ("a routine needs a
name"). `:201` prints only one refusal at a time, which is what the brief asks for; keep it. The
editor's inline field has no autofocus today and needs it.

**W19 · [REBUILD / M] The target sheet becomes three typed fields, and the third overlay dies.**
`Routines.jsx:351-434` draws all five affordances: tap-to-type into a custom keypad (`:386-388`,
`:423-431`), "use last time" (`:389-393`), the ± ladder (`:395-410`), "take it to max" (`:378-382`)
and "Leave it open" (`:417-420`). The comment at `:423` explains the third layer: "Keep the keypad
outside the sheet; nested, a tap on it closes the sheet." `FixSheet.jsx:73` carries the identical
comment. The null-cascade helpers exist: `routines.js:140-147`, `:155-160`.
*Careless build:* `logger/Keypad.jsx` is mounted from **both** `Routines.jsx:425` (which the brief
kills) and `FixSheet.jsx:75` (the repair path, which no brief assigns to web) — deleting it outright
takes a control `16-the-workout.md` deliberately keeps at the rack. Second: the clear-cascade is the
brief's own open question. `routines.js:155-160` silently empties reps and weight when sets clears,
`Routine.cpp:17` refuses any other shape, and ledger `2l` records the two phones already drawing two
behaviours under one pinned sentence. **Do not let web invent a third.**

**W20 · [FIX / S] The typed field's six refusals are not the pinned strings, and one enforces the
wrong band.** `logger/entry.js:50` ships "One decimal point only — 72,5 or 72.5"; `:54` "Not a number
yet — 72,5 reads as 72.5"; `:57` "Over 500 kg — check the number"; `:61` "Whole reps, 1 to 99",
guarded at `:60`. There is no string for a typed zero and none for clearing sets while reps or weight
hold values.
*Careless build:* ledger `2i` is precise — 1–99 is the **live logger's**
band and 1–100 is the **routine target's** (`Routine.cpp:23`), "but neither file says which band it
is enforcing, which is how they drifted". `entry.js` serves both the target sheet and the fix sheet,
so pinning one string in one module enforces the wrong bound on one of the two screens. **Split the
bands explicitly.** And ledger `2h` notes *That is not a number yet.* is the one pinned
refusal naming no way out and that the fix belongs in the brief — do not silently improve it here.

**W21 · [FIX / M] The picker caps every query at seven rows and has no "six most-used" section.**
`logger/movements.js:3` `PICKER_MATCHES = 7`, applied unconditionally at `:39`, including for an
empty query (`matchesQuery` returns true for every name when the term is `''`, `:26,:30-32`). The
placeholder is already correct: `MovementPicker.jsx:27` renders `Search ${catalog.length} movements`
— **do not report it as missing.**
*Careless build:* lifting the cap everywhere makes a typed query dump the catalogue; ledger `2j` says
it is lifted for the empty query and kept for a typed one. And "six most-used" needs a source of
truth: nothing on the web wire ranks movements by use — `gymApi.lastSets()` (`gymApi.js:208`) gives last-set
metadata, not a frequency order.

**W22 · [FIX / S] The open line is a different sentence and a different shape.**
`routines.js:163-170` (`openTargetsLine`) builds "{Movement} has no target — it will ask at the
rack.", drawn once per editor at `Routines.jsx:218`; the sheet’s button says "Leave it open / decide
at the rack" (`:417-420`). The pinned string is one sentence on every surface: *You decide the
numbers at the rack.* Web's version also uses the third person about the app where the pinned string
uses the second person about the lifter.
*Careless build:* replacing the shape loses the roll-up's actual information — which lines are open.
Decide whether the per-row placeholder (`sets` cleared → *open*) carries that before deleting the
line.

**W24 · [BUILD / M] Delete routine, and Duplicate off the row into an overflow.**
**There is no way to delete a routine on the web at all:** `gymApi.deleteRoutine` exists
(`gymApi.js:310-312`) and is called from nowhere in `src/`; the one path that deletes a routine is applying a removal proposal (`Proposals.jsx:131-135`). Duplicate exists twice — a `⧉` button on
every row (`Routines.jsx:85-92`, firing `duplicate()` at `:30-40`, which creates a routine
immediately) and a footer button three screens deep (`:226-244`).
*Careless build:* adding Delete without the withheld-delete pattern is what `13-gestures.md`'s gate
forbids. Web has a mechanism to copy — `Log.jsx:170-206` withholds a set delete for `UNDO_MS` with a
toast-borne Undo — but note two known limits before reusing it: `Log.jsx:193-199` sends every
still-withheld delete on unmount (leaving commits), and `withheld.current` is a list while the toast
holds one action, so a second delete's Undo replaces the first's on screen. The window is P4's
9000 ms.

**W25 · [BUILD / S] The editor row's `×` removes a line with no way back.**
`Routines.jsx:477-484` calls `onRemove(index)` → `withEntryRemoved` (`routines.js:122-124`), dropping
the entry from the unsaved draft. The only recovery is the back link at `:181`, which discards every
other edit made since the editor opened. `15-the-routine.md`: "A row's `×` is as destructive as a
swipe, and takes the same undo. **The gate is the act, not the gesture.**"
*Careless build:* drawing a duration on it. The mechanism exists (`log.say(text, action)`,
`useTrainingLog.js:66`; the toast renders an action at `GymApp.jsx:118-132`) and the toast retires
after `TOAST_MS` = 9000 (`useTrainingLog.js:16`), the window P4 rules.

**W27 · [FIX / S] A set row prints an RPE and a note the lifter can touch on no surface.**
`Log.jsx:298` renders `set.rpe` and `:303` renders `set.note` (verified). `FixSheet.jsx:25-63` edits
weight, reps and kind only — `fix.js:12-14` and `:27-33` carry exactly those three fields. Ledger
`1s`: give it a control or delete the render.
*Careless build:* the two halves have opposite trust. A **note** (`10-notes.md`) is directive text
Coach follows; a **set note** is a record the prompt treats as data (`AnthropicAsk.cpp:49-53`). Adding
the set-note field with any hint that Coach reads it as instruction crosses the boundary `09-coach.md`
exists to draw. And `fixOf` sends only changed fields — adding two nullable ones needs care so that
clearing a note is distinguishable from not touching it.

**W34 · [REBUILD / L] Daylight: the room pins dark in two places.**
`routes.js:66` declares `scope: { theme: 'dark', brand: 'gym' }` and `Shell.jsx:76` reads
`room.scope.theme ?? appearance`. Outside `/app` the shell never mounts (`shell/App.jsx:200-208`) and
`GymApp.jsx:39,:46` hardcode `data-theme="dark"` on `.gym-root`, the attribute `gym.css` scopes its
tokens to (`:5`, `:43`). The light ground already exists (`palettes.css:208-228`, `:275-284`) and
`gym.css:43-78` declares a light block of mostly byte-identical aliases.
*Careless build:* dropping only the `routes.js` pin changes nothing a lifter sees — `.gym-root`'s own
`data-theme="dark"` still wins, and outside `/app` it is the only stamp there is, so `GymApp` has to
resolve appearance itself via `useAppearance`. The bigger risk is shipping the flag as the feature:
the light block has never been rendered, one of its tokens is excused in a comment for failing its own
gate (`gym.css:66-68`), and flipping the pin makes that comment's excuse false in the same commit.

**W37 · [BLOCKED / XL] Type: 277 hardcoded pixel sizes, and the shared scale is pixels too.**
`gym.css` contains 277 `font-size: Npx` declarations and **zero** uses of the `--text-xs`…`--text-6xl`
scale (its ten `var(--text-*)` reads are the colour roles `--text-primary`, `--text-link` and
kin). The shared
scale is itself fixed: `styles/tokens/typography.css:3-12` defines `--text-xs: 12px` through
`--text-6xl: 60px`. Gym extends it with `--weight-size: 104px` and `--reps-size: 54px`
(`gym.css:36-39`). There are 40 `tabular-nums` declarations and no font-size media queries.
**Blocked, not merely large:** the web's equivalent of Dynamic Type is honouring the browser's root
font size, and the scale gym would adopt is pixel-valued — so adopting it changes nothing for a
reader who has set a larger font. Making the shared scale relative is a change to `typography.css`
that reaches roadmap and journal as well, and nobody has scoped it. Until then, converting 277
declarations to a px-valued token scale is churn that buys the accessibility gap nothing.

**W38 · [BLOCKED / S] Gym's screen titles are in the body face.**
`gym.css:105-111` `.gym-title` sets no `font-family`, inheriting `var(--font-body)` (Nunito) from
`.gym-root` (`:89`); the display face is reached seven times in the stylesheet — four instruments
(`.gym-keypad-echo`, `.gym-fix-kg`, `.gym-stat-value`, `.gym-record-tile-value`) and three headings
(`.gym-target-movement`, `.gym-picker-title`, `.gym-connect-title`).
Ledger `1y` records it as "a designer call, one way or the other" and does not decide it. **Deciding
it inside a build wave pins one answer for every gym title on three surfaces by accident.** Get the
ruling; the code change is one line.

**W39 · [BLOCKED / M] Whether the web's session review becomes a dialog.**
`FinishScreen` (`Finish.jsx:13-110`) is a pushed screen at `#/gym/finish/<id>` (`log.js:34-41`,
`GymApp.jsx:109`), reached only from "Session review ›" at `Log.jsx:267`; it owns the
keep-as-a-routine offer (`:158-215`) and the discard door (`:114-156`). `16-the-workout.md`'s ruling
is written for the surface that *finishes* a session, and `01-context.md` says the web never does —
here it is a review of a past workout. **The brief does not assign it to web.** Building it as a
dialog anyway puts the discard door and the keep-as-a-routine offer inside a modal, and neither has a
settled treatment there.

---

## 5 · Do not build these

**`propose_routine_create`.** `09-coach.md:120,128-132`: three verbs, and Coach never creates.
Creating belongs to the lifter. A proposal is anchored to a routine that already exists and to a
revision it is atomic against; a create has neither. The domain already forbids it at compile time —
`classify(Subject, Standing)` (`domain/Proposal.h:26-30`) returns `Mutation::record` whenever
`standing == Standing::fresh`, and `createRoutine` asserts exactly that
(`GymTools.cpp:296`), while the two propose tools assert the opposite pairing (`:378`, `:430`).
Structurally a proposal cannot be built without a routine (`Proposal.cpp:55`,
`ProgramService.cpp:51-53`).
**And the name’s absence is pinned.** `GymToolsTest.cpp:183-200` pins `apply_proposal`,
`apply_routine_change`, `accept_proposal`, `dismiss_proposal` and `settle_proposal`;
`GymToolsTest.cpp:202-214` (`gym_publishes_no_propose_routine_create_at_any_level` — the catalog,
`tools/list` at every level, the dispatcher) and `AskServiceTest.cpp:126-127` pin
`propose_routine_create` absent. The pin matters because the `propose_` prefix is itself a grant
(`GymToolCatalog.h:20-23`: "The prefix is the grant: any `propose_*` tool, at any access level, is
reachable by Ask"), so a tool by that name would hand itself to Coach with no review. The
static_assert only fires if the new path calls `classify` with the right pair; the pin is what stops
a tool that skips it.

**A bodyweight write tool of any kind.** `11-bodyweight.md`: Coach may never write a weigh-in, for
the same reason no tool edits a logged set. The ban is structural, not a prompt sentence
(`routes.cpp:92-103`, `:180-188`, `GymToolsTest.cpp:183-200`), and for bodyweight it is pinned by
declaration — `GymToolsTest.cpp:326` `gym_publishes_no_tool_that_writes_a_bodyweight_at_any_level`:
the only tool whose name says bodyweight is `list_bodyweight` at `gym:read`, and every write-shaped
name is absent from the catalog, from `tools/list` at every level and from the dispatcher. A
write-level tool is reachable by every MCP connection; named `propose_*` it is additionally
auto-granted to Coach.

**Notes inside the preferences document.** `10-notes.md`. Notes have their own resource
(`gym_notes`, `/v1/gym/notes`, `routes.cpp:230-258`) and never move: `PUT /v1/gym/preferences` is a
whole-document last-write-wins replace with no PATCH (`routes.cpp:213-229`,
`schema.sql:1082`), and all three clients document it in their own first lines
(`Preferences.swift:3`, `SettingsScreen.swift:4`, `settings/preferences.js:1`). Two screens open at
once silently discards one.

**The existing bar chart, reused for bodyweight.** `11-bodyweight.md` calls it a new primitive
explicitly, and it is built as one (`design-system/charts/DotChart.jsx`, `BodyweightScreen.swift`,
`BodyweightScreen.kt`): dots on the series' own range, a segment only across a gap of seven days or
fewer. Gym's e1RM chart is bars — normalised to the series maximum on the web (`record.js:66-80`),
floated from a baseline on iOS (`Record.swift:286`) — and a bar implies a session on a day. Also
banned on the bodyweight chart: a goal line, a projection, BMI, a trend, a scrub.

**The ± plate ladder on a bodyweight field.** `11-bodyweight.md`: a plain decimal field, explicitly
not the ladder. The ladder carries plate physics and signed loads into a value that has neither.

**A second trailing action on the set-row swipe, and full-swipe.** `13-gestures.md`: two actions eat
about half the row and push the set's ordinal and load off the leading edge, so the lifter cannot see
which set they are deciding about. Full-swipe makes two-deletes-in-a-second the fastest path while
the undo holds one (**I7**, **A11**).

**Discard in the session-row context menu.** `13-gestures.md` is explicit that it does not go there
until the withheld delete exists, and that a confirmation would not rescue it. The menu ships with
Share this workout alone.

**A fixed partial detent on the review sheet.** `09-coach.md`: a half-height sheet does not grow with
the system text size, so at the larger accessibility sizes the visible diff goes to zero while Apply
stays enabled. Apply is never reachable while the diff is clipped. The review sheet is `.large` only
on iOS (`GymRoom.swift:113`) and skips the partial state on Android (`GymRoom.kt:199`); the weigh-in
sheet's `.medium` (`LogScreen.swift:142`, `BodyweightScreen.swift:53`) is proportional, not fixed,
and holds one field. iOS still pins fixed-height detents in four other places
(`LoggerScreen.swift:49`, `SessionScreen.swift:146`, `Shell.swift:60`, `:129`); the habit is what to
watch.

**A Dismiss/Apply button pair.** `09-coach.md`: the band holds one button and it is Apply — `Apply
all N`, `Apply` when N is 1, `Remove <routine>` — and turning down is a text row beneath it behind
its confirmation. Built that way on all three (`Proposals.jsx:167-179`, `ReviewSheet.swift:263-294`,
`ReviewSheet.kt:477-500`). A pair puts the one irreversible act exactly where a hand expects Cancel,
and colour does not undo position.

**A "Later" affordance on the proposal card.** `09-coach.md` beat one: a single affordance, Review,
and every card carries only that. "Later" is closing the sheet, after which the card reads *still
waiting*.

**A client that rewrites server text.** Where the server sends a sentence, every client — web
included (`coach.js:124-125`) — shows those bytes; local copy is only the wordless fallback (**P3**,
§2.3).

**Material You / a wallpaper-derived palette on Android.** `12-native-idiom.md` refuses it: colour in
this room is a legend, not a brand — gold is a personal record (`GymSkin.kt:35`), iris is an agent
proposal (`:25`).

**A glow token in a light skin.** Ledger `1w`, `F5`: a token whose mechanism does not exist in a mode
is deleted from that mode, not dimmed (`gym.css` declares `--set-done-glow` in the dark block only,
`:26`, and the light dot draws no shadow, `:582-584`).

**A "resting" reading, a countdown, or a Finish control on the web mirror.** Ledger `0t` keeps the
mirror's charter whole. The mirror (`Mirror.jsx`) ships none of the three, and `screens.test.js:77`
walks every gym file for "resting"; the risk is a rewrite introducing them.

**"Just start logging" as a web primary.** `screens.test.js:471-484` asserts the string appears in no
web file — the web's charter defended in a test. `12-native-idiom.md`'s reach-band ruling does not
scope itself by surface; do not carry it across (§7).

---

## 6 · Live ledger defects, by wave

The ledger (`../consistency.md`) is current; this is its gym remainder, placed.

**Wave 5/6 (with the containers and gestures):** `1k` the shell's leading edge, arbitrated by depth
and unproven (**D1**) · `1l` the You seat moving into the room's own top chrome · `1v` the tab-bar
selected-state contrast at roughly 1.15:1 · `1z` two different haptics for one logged set —
`UIImpactFeedbackGenerator(style: .medium)` on iOS (`GymConfirm.swift:19`) against
`HapticFeedbackType.LongPress` on Android (`GymConfirm.kt:20`), both gated on the same
`confirmHaptic` preference; worth settling before the gesture wave adds a second and a third.

**Waves 5 and 8:** `2j` the picker's seven-row cap on all three surfaces (**I15**, **W21**, and
`MovementPicker.kt:50,112`) · `2i` the web's refusal strings and the wrong reps band (**W20**) · `2h`
*That is not a number yet.* naming no way out — the fix belongs in the brief, not in one surface ·
`2l` the two phones drawing the clear-refusal at two different moments · `1y` Nunito vs Baloo 2, a
designer call (**W38**) · `F4` `--pr-ink` at 3.2:1 in Daylight with no darker gold in the ramp, a
designer's token before Daylight renders · `1w` the Daylight glow value still in the Figma
collection · `F6` `--focus-ring` terracotta inside gym, latent until the design-system twins land.

**Any wave — a board fix:** `2f` the `W8` boards' `70 of 500 bytes` counter.

**Documentation that goes stale in these changes:** `2g` `Routine.h:40-44` saying a client never
sends `revision` while `TrainingJson.cpp:190-198` parses one and the web sends one ·
`SettingsScreen.kt:157` ("nothing on this screen converts one") once units convert ·
`ARCHITECTURE.md:1233` carries the verdict-code rule that must survive every copy change.

---

## 7 · What is verified, and what is not

**What Wave A executed**, per its builders' and reviewers' reports: the backend built and its whole
ctest ran, the notes repository against a live Postgres (`WM_PG_TEST=1`) including a ten-thread
concurrent-save case, and the notes routes were probed on a live server; the web suite (`npm test`)
and `npm run build` ran green, and the cap-reached state, the export rows and the note bounds were
driven on the page in headless Chrome; the iOS app built on a simulator and the
`WindmillKit-Package` suite ran green; the Android unit suite and `:app:assembleDebug` ran green and
the screens were rendered on an API 34 emulator.

**What Wave B executed**, per its builders' and reviewers' reports: the backend's whole ctest
including every Postgres case, and every bodyweight route, the collision rule, the export,
`list_bodyweight` and the three superseded sentences probed on a live server; the web suite and
build, and the review dialog, the weigh-in sheet, the reading and the chart driven in headless
Chrome at 390 px; the `WindmillKit-Package` suite, the app build and a simulator launch on iOS; the
Android unit and Robolectric suites, `:app:assembleDebug`, and emulator screenshots of the log
head, the chart and the review sheet. Everything below is what those runs did not touch.

**Nothing in the remaining items was executed.** Where an item says a control "does not exist", it
means no matching symbol appears in the tree — not that anyone watched a screen fail to show it.
Where a comment states a measurement, the measurement was not reproduced. Citations drift by a few
lines between edits: re-grep before editing at any line this document cites.

**Specific unknowns, by surface:**

*Backend.* Whether changing `kSystemPrompt` actually costs a cache miss — `AnthropicAsk.cpp:21-22`
asserts it as a comment and there is no measurement anywhere in the repository. What up to 5 KB of
notes on every first user turn costs in latency or spend — it ships now, and the AI meter
(`Entitlements::aiAllowanceFor`, `AiFuse`) bounds dollars over 30 days, not per-turn size. Whether
dropping the `routine_id` foreign key loses a cascade path against real data — reasoned from
`schema.sql:894` and `applyRemoval`, not tested against a database. Whether the note-proposal
preview can reuse any part of `gym_proposal_changes` — concluded it cannot from `schema.sql:921-936`,
but the design has not specified the note diff's row shape, so **B8**'s L sizing is the least
reliable number in this document.

*iOS.* Whether the shell's `.simultaneousGesture` and a system interactive pop can coexist at all
(**D1**) — and whether the depth-gated fix is sufficient, or the hand-rolled gesture has to go
entirely. The five simulator checks `14-live-activity.md` names. The exact point values of any role
at the largest accessibility sizes — the brief says explicitly not to take them from memory, and the
accessibility inspector was not opened. Whether `GymDevice.summary`'s second SetQueue instance
(`GymModule.swift:76`) actually clobbers the room's queue in practice — its only write path is the
legacy pre-seat migration (`SetQueue.swift:86-102`), so the window is narrow, and no reproducing
case was constructed. What is structural and certain: two instances of a whole-file
last-writer-wins store exist in one process today, and the Live Activity proposes a third writer.
No Wave B screen was driven by touch on iOS: the review sheet's gate and the weigh-in sheet were
proven by the package suite and a hosted-window test, not by a finger on a simulator.

*Android.* What a predictive-back animation does over a hand-rolled `when` dispatch on an Android 16
device (**D2**). What the room looks like at the largest accessibility font scale — specifically
where `GymType.weight` (104.sp) clips against the ~117 fixed `heightIn` rows and the fixed-width
columns at `FixSheet.kt:126` and `AssemblySheet.kt:253`. Whether the manifest’s `configChanges`
(`AndroidManifest.xml:20`, including `uiMode`, `fontScale`, `density`) changes how Compose sees a
theme or font-scale change — the Activity is not recreated, and this sits directly under the Daylight
work. Whether `material-icons-core` is on the **compile** classpath of `:gym` specifically — verified
as an `api` dependency of material3-android 1.3.2 in the module metadata and present in the local
cache, but `:gym:dependencies` was not run. How much of the Robolectric UI suite breaks under the M3
conversion — seven of its fourteen screen-test files locate by `onNodeWithText`, so icon-only affordances and changed strings
will break it, but the assertion count was not measured. The exact contrast ratios of the room's
colours in either skin — `GymSkin.kt` carries measured claims in comments (`:26` 6.18:1, `:31`
5.01:1, `:27` 3.66:1) that were not recomputed.

*Web.* The review dialog's gate at a large browser font size — the dialog was rendered and driven
at 390 px, not at a large font. Whether `12-native-idiom.md`'s reach-band ruling is meant to reach the web at all
— the web starts no sessions and `screens.test.js:471-484` asserts the string appears in no web
file; the brief does not scope the ruling by surface. Whether `16-the-workout.md`'s "Finish becomes
a sheet over the session" applies to the web's `FinishScreen`, which is a review of a past workout
and not the end of a live one; the brief names no surface. Whether the custom keypad should also come
off the web's fix sheet — `15-the-routine.md` removes it from the planning sheet and
`16-the-workout.md` keeps it "at the rack"; the web has a fix sheet and no rack, and
`logger/Keypad.jsx` serves both call sites. `gym.css:66-68`'s 3.2:1 for `--pr-ink` is the
stylesheet's own figure, not independently reproduced, and "nothing renders this skin" was not
checked by rendering. No screen's word count was audited against `text-budget.md`.

*Cross-surface.* Whether Coach, given a real model, calls `list_bodyweight` and phrases it — the
tool, its phrase and its receipt rule are pinned in the suites, but no local run carries an
Anthropic key, so no conversation has exercised it. No Figma file was opened; where a brief or the ledger describes a board (`2c`'s stray `w`, `2l`'s two
drawings, `2f`'s counter, `1w`'s collection value, the `iOS Tab Bar` component description), this
document reports what those documents say, not what the boards show.
