# Gym · the build brief

What to build, what to rebuild, what to fix, and what is not safe to start. It serves the eight
briefs in `briefs/` — `09-coach.md` through `16-the-workout.md` — plus
`../guidelines/text-budget.md` and the drift ledger `../consistency.md`.

Every claim here is read off source at the line cited. **Nothing in this document was executed.**
No backend was compiled, no simulator launched, no emulator started, no test suite run, no screen
rendered, no contrast measured. Section 7 says so again, in detail, because a brief that overstates
readiness is worse than no brief.

---

## 1 · Start here

Gym ships on three surfaces. The web room is a mirror and a backfill tool; the phones own the open
session. One backend serves all three.

**The design is ahead of the build, deliberately, and by a lot.** The Coach wave
(2026-08-24) was a design-only wave: eight briefs and a set of rulings, no product code. What that
means in practice:

- **Two whole features have no backend at all.** Notes (`10-notes.md`) and bodyweight
  (`11-bodyweight.md`) have no table, no column, no route and no domain type. `backend/db/schema.sql`
  declares fourteen `gym_*` tables and none is either one; `backend/products/gym/routes.cpp:35-307`
  mounts 36 handlers and none is either one. Six client items in this brief are blocked behind them.
- **Some briefs assert facts about the code that are false.** `16-the-workout.md` says the set-kind
  control "no surface has ever offered" — both phones offer it today
  (`apps/ios/.../LoggerScreen.swift:377`, `apps/android/.../LoggerScreen.kt:264`).
  `09-coach.md` and `15-the-routine.md` assume an iOS naming interstitial and an iOS target-sheet
  keypad; neither exists. Section 7 lists all nine such cases. Do not plan from a brief sentence
  without checking the line.
- **Four ledger entries are wrong or stale.** They are named in §6 with the verification. One of
  them (`2f`) sends a developer looking for a byte counter the repository does not contain.
- **The three clients are pinned to the current strings by their own test suites.** A copy change
  that lands in one repository turns another repository's CI red. The Coach rename cannot be done
  one surface at a time.

The two heaviest items in the programme — the type rebuild and Daylight — are XL on every surface
and neither can be measured from source. They are last, not first.

**Read `briefs/01-context.md` before anything else.** It carries the surface charters: the web
starts no sessions, the phone owns the queue. Several rulings in the wave were written for the
surface that finishes a workout and do not name a surface; §7 lists which.

---

## 2 · Do this first

Eleven of these are decisions. Three must be proven on a device or a simulator before code is
written against them. None of them is a build, and every one of them blocks a build.

### 2.1 · Decisions owed before a line is written

**P1 · The note byte bound.** `10-notes.md:62` bounds notes at ten notes and five hundred bytes
each; `10-notes.md:159-160` says in its own Open section that the number is "proposed, not decided."
The number lands in three places at once — a schema CHECK, the domain constructor (the pattern at
`backend/products/gym/domain/Proposal.cpp:57-58`) and the MCP tool's `maxLength`, and
`GymToolCatalog.cpp:90-91` states the rule that a wider schema bound than domain bound invites a
value the entity then refuses the whole document over. Raising a bound later is cheap. Lowering one
strands stored rows, which is exactly why `schema.sql:918-920` carries no CHECKs at all on
`gym_proposal_changes`. **Blocks:** the whole Notes feature, on four surfaces.

**P2 · The bodyweight wire shape.** `11-bodyweight.md:117-119` names it as greenfield and says it
needs a backend contract before a board becomes a build, and a place in the sign-in claim replay.
`{ dateLocal, weightKg }` is proposed. Three things must be pinned in one place: the date encoding,
the unit (kilograms stored, the toggle a display transform, matching `schema.sql:1022-1023`), and
the collision rule for one write per local date. `ClaimReplay.kt:32-33` requires every write be
idempotent by a minted id; a `(user, dateLocal)` upsert satisfies that only if the design accepts
last-write-wins, which nobody has ruled. **Blocks:** bodyweight on all four surfaces. Decide it
per-surface and three clients will each pick a date encoding —
`15-the-routine.md:110-115` records what happened the last time a wave pinned rulings and not words.

**P3 · One owner for the server's "Ask" strings.** `09-coach.md:222-223` and ledger `1q`
(`consistency.md:615-624`) both record the change as owed and unassigned. It cannot land in the
backend alone: `AskTests.swift:156-170`, `AskVerdictTests.kt:13-29` and `ask.test.js:183,193` pin
the current bytes. It cannot land in the clients alone either — a client must never rewrite server
text, so a room called Coach would answer refusals in the name of Ask. **Blocks:** the Coach rename
on iOS, Android and the tab label on web.

**P4 · The undo window: 5000 or 9000.** `web/src/products/gym/fix.js:9` declares `UNDO_MS = 5000`
and `useTrainingLog.js:16` pins the toast to it by reciprocal comment.
`apps/ios/.../SetQueue.swift:48` and `apps/android/.../SetQueue.kt:51` both declare 9000.
`backend/products/gym/ARCHITECTURE.md:1078` states "The undo window is 9000 ms on every surface" as
a cross-surface invariant, and it is not one. `13-gestures.md` gates every destructive affordance on
"an undo already exists", so the gate silently means something weaker on web. **Blocks:** every new
undo in the gesture wave — the routine delete, the thread delete, the editor row `×`. Whichever way
it goes, `ARCHITECTURE.md:1078` moves in the same change.

**P5 · The web's hash grammar for a routines home.** `log.js:93-107` falls through to `return
'today'` for a bare `#/gym`, and `log.js:28` gives routines its own `#/gym/routines`; `routineIdOf`
(`log.js:19-22`) parses ids only under that prefix, and `routes.js:21-28` returns `#/gym` from both
`home()` and `landingAfterSignIn()`. Decide whether `#/gym` becomes an alias of the routines screen
or the routines child routes re-base — `log`, `ask`, `connect`, `backfill` and `movement` are all
bare words under `#/gym` and would collide. **Blocks:** the whole web IA convergence (ledger `0t`).

**P6 · Three missing design-system pieces, authored before any gym twin is deleted.**
`12-native-idiom.md` says a component the wave needs is authored in the design system, not in the
gym folder. Three are missing: `design-system/navigation/Tabs.jsx:3-31` is a segmented pill with
`value`/`onChange`, not a bottom nav rail; `design-system/Icon.jsx:150` registers `arrow-right` and
no `arrow-left`, which is why eight gym files import `ArrowLeft` from lucide directly; and
`design-system/feedback/Dialog.jsx:112` pins its footer outside the scrolling body, which is the
exact shape `09-coach.md` forbids for the review sheet. **Blocks:** web design-system adoption and
the web review dialog.

**P7 · Gym's token vocabulary against the design system's.** Every design-system component styles
itself with inline styles reading `--surface-card`, `--text-primary`, `--color-brand`
(`Button.jsx:12-40`, `Toast.jsx:10-38`, `Card.jsx:3-24`), while gym renames every role onto
`.gym-root` (`gym.css:5-77`: `--gym-surface`, `--gym-ink`, `--set-done`). There is no class hook to
redirect them. A dropped-in `Button` resolves the shared roles and comes out a different room.
**Blocks:** the same adoption as P6.

**P8 · Android's Material ColorScheme.** `WindmillMaterial.kt:26` sets `primary =
WindmillColor.gold400` (#D9B04C) on `surface = neutral0.dark` (#17120B, warm brown), and
`MainActivity.kt:61` wraps the whole gym room in it. The room paints iris on cool grey
(`GymSkin.kt:25` `#9A90BE`, `:20` `#1C1A1E`). Gold in this room means a personal record
(`GymSkin.kt:35 prInk = #D9B04C`); iris means the agent proposed it. Convert a Material control
before re-pointing the scheme and the legend breaks. **Blocks:** every M3 component on Android —
Scaffold, TopAppBar, NavigationBar, ListItem, Switch, SegmentedButton, TextField, Snackbar.

**P9 · Android's `LocalWindmillDark` producer, and GymSkin's shape.** `Tokens.kt:31` declares
`staticCompositionLocalOf { true }` and **nothing provides it** — three hits repo-wide, the
declaration and two consumers. `isSystemInDarkTheme` appears nowhere in the module. `GymSkin.kt:19-40`
is a compile-time `object` of hard `Color` constants read at **628 sites across 22 files**, and the
accessor pattern it must adopt (`Tokens.kt:33-40`) is `@Composable` — so the call graph moves too,
including non-composable helpers like `Modifier.dashedEdge` (`GymSkin.kt:76`). **Blocks:** all
Daylight work on Android. Half-converting is worse than not starting: a light Material chrome
painted over a hard-coded dark room.

**P10 · Assign the refusals that a removed control carries.** `15-the-routine.md`'s own rule: "When
a wave removes a control, it inherits that control's refusals — and they are assigned to a named
board on a named surface before drawing starts." Killing the web target sheet's custom keypad
(`Routines.jsx:406-414`) orphans the four refusals in `logger/entry.js:49-62`, and
`logger/Keypad.jsx` is shared with `FixSheet.jsx:75`, which no brief assigns to web. On iOS the six
pinned refusals have **no home at all** today, because iOS never had a typed target field
(`KeypadSheet` is logger-only, `LoggerScreen.swift:468-475`) — they are new work, not a move.

**P11 · Whether `androidx.navigation` enters the Android build at all.** There is no navigation
entry anywhere in `gradle/libs.versions.toml:1-40`, and `NavHost`/`androidx.navigation` return zero
hits. If it does enter, two invariants have to survive it: the four back meanings at
`GymRoom.kt:198-217` (three of which are not pops), and the deliberately unsaved `away` stack
(`GymRoom.kt:161-163` — "NOT saved, so no screen is drawn over a store that has not read the disk
yet") against a NavHost that saves its own back stack and takes only string arguments.
`Away.Session` also carries a whole `SessionSummary` object (`:126`) because it "carries facts no
other read gives back" (`:120`), and a route argument is a string. **Blocks:** `A2`, and the
Scaffold conversion's back affordance.

### 2.2 · Three things that must be proven on a device before code is written

**D1 · iOS: the shell's leading edge against a NavigationStack.**
`apps/ios/.../WindmillPlatform/Shell.swift:174-185` attaches the go-home swipe as a
`.simultaneousGesture` — the modifier whose meaning is *do not require exclusivity* — gated on
`startLocation.x <= 20` (`:159`). Its own comment at `:148-149` says the swipe is hand-rolled
because a hidden navigation bar disables the system pop. The only three `NavigationStack`s in the app
are `YouScreen.swift:13` and `SignInDoor.swift:22`, and both are presented as sheets
(`Shell.swift:63,:65`) — outside RoomHost's subtree. **The two gestures have never met in a running
build.** `12-native-idiom.md` rules the edge is arbitrated by depth; ledger `1k`
(`consistency.md:569-578`) says every iOS board in the wave rests on this until it is proven.
Prototype it on a simulator. The naive outcome is both firing — a back swipe that also slides the
room home. The quieter failure is a depth signal wired backwards, which disables go-home
permanently and leaves the switcher's Home row (`Shell.swift:287`) as the only way out of a room.
Nobody reviewing it will notice, because the room still works.

**D2 · Android: edge-to-edge and predictive back at targetSdk 36.** `app/build.gradle.kts:22` sets
`targetSdk = 36`. `themes.xml:3-8` still sets `android:statusBarColor`, `android:navigationBarColor`
and `windowLightStatusBar=false`, and `enableEdgeToEdge`/`WindowCompat`/`SystemBarStyle` appear
nowhere. The manifest declares no `android:enableOnBackInvokedCallback`
(`AndroidManifest.xml:1-28`). At targetSdk 35+ the platform is documented to enforce edge-to-edge
and ignore those two colour attributes — **if that is already in force, the app is drawing
edge-to-edge today with a theme that lies about it**, and `GymRoom.kt:451`'s `.systemBarsPadding()`
is what is holding the layout together. Building on "we are not edge-to-edge yet" gives double
insets or bars that vanish. The JVM suite cannot see the difference: the Robolectric tests pin
`@Config(sdk = [35])` (`RoutinesScreenTests.kt:31`). Also unproven: what a predictive-back animation
does when the destination is a `when` branch inside one composable (`GymRoom.kt:492-616`) rather
than a NavHost entry — there is no second screen for the system to reveal behind the peel.

**D3 · iOS: whether a Live Activity's button handler runs in the app's process or the widget
extension's.** The entire second-writer question turns on it. `SetQueue` holds the whole file in
memory (`SetQueue.swift:69`) and `flush()` writes it atomically — a last-writer-wins whole-file
replace (`:334-337`) — resolved into the app's own Application Support container, **not** an App
Group (`:143-148`). Two instances already coexist in one process: `GymRoom.swift:9` and
`GymModule.swift:76`, and the second can write (`SetQueue.swift:81,:86-102`). In-process ordering
and a cross-process App Group container are two different builds. `SetQueue.swift:443` says what is
at stake in as many words: an owed set is the only copy of something somebody lifted.
`14-live-activity.md` names four more simulator checks (stale-date re-render, `ProgressView` past
the end of its range, the one-point layout margin against the truncation threshold, the circular
presentation, and what a tap on an inactive locked-screen button shows). **None has been run.**

### 2.3 · Three coordination rules

**Rule 0 · Three tests assert the word "coach" is ABSENT, and they are not string-equality tests.**
A developer will read each as a bug and "fix" it in the wrong direction. They are rules this
programme deliberately reverses, and they must be changed in the same commit as the rename:

- `backend/test/products/gym/adapters/llm/AnthropicAskTest.cpp:168` —
  `CHECK(prompt.find("coach") == std::string::npos);`
- `apps/ios/WindmillKit/Tests/WindmillGymTests/AskThreadsTests.swift:225` —
  `XCTAssertFalse(AskThreads.empty.lowercased().contains("coach"))`
- `apps/ios/WindmillKit/Tests/WindmillGymTests/AskTests.swift:247` —
  `XCTAssertFalse(sentence.lowercased().contains("coach"), sentence)`

There is nothing to edit in these. Deleting the assertion is the change, and the reason belongs in
the commit message: `01-context.md` now names the room Coach, and the ban moved to the share.


**Every server string change lands with all three client suites in the same wave.** The repositories
are separate; the contract is not. A backend push that renames a string turns three client suites
red in a repository the backend developer is not watching. The reverse ordering is worse — iOS is
already in that state: `AskTests.swift:156-170` builds its own fixtures (`"that’s Ask for now"` with
a typographic apostrophe, and `"ask a question first"` where the server sends `"ask something about
your training"`, `AskApi.cpp:22`) and asserts only that the client echoes what it was handed. **The
suite is green today while the fixtures and the server disagree**, and it will stay green after a
rename that ships the wrong bytes.

**Every new tool needs its client phrase in the same commit.**
`web/src/products/gym/ask/ask.js:18` falls back to `TOOL_PHRASE[step.tool] ?? step.tool`, so a tool
absent from the table at `ask.js:1-10` prints its raw name on a lifter's screen. That is the defect
`09-coach.md:137-138` says this wave closes. Android is worse: `Ask.kt:9-11` prints the tool name
unconditionally, with no lookup to fall back from.

---

### 2.4 · There is no migrations directory, and three items need one

The whole migration mechanism is one line: `backend/deploy/docker-compose.yml:34-36` runs
`psql … -v ON_ERROR_STOP=1 -f /app/db/schema.sql` once, before the server starts. `backend/db/` holds
`schema.sql` and `funnel.sql` and nothing else. The file is idempotent DDL — `create table if not
exists`, `alter table … add column if not exists`.

**That is enough for a new table and not enough for a changed one.** B1 (notes) and B6 (bodyweight)
fit it. These do not, and each needs a backfill plan and a statement of what a stored row reads as
afterwards:

- **B7** — dropping `gym_proposals.routine_id`'s not-null FK (`schema.sql:894`) for a polymorphic
  subject, and extending the pending-uniqueness index (`schema.sql:911-912`). **Every existing
  proposal row must acquire a subject.**
- **B10** — a reason column on `gym_proposals`, and what the existing rows say.
- **B11** — `from_lifter boolean not null` (`schema.sql:1057`) becoming a three-valued source. Every
  existing turn is one of the two old values; which?

**Decide before B7:** does this product gain a migrations directory, or does `schema.sql` grow
backfill statements that are safe to re-run on every deploy? The second is possible and it is how the
file already works — but a backfill that is not idempotent will corrupt on the second deploy, and the
deploy runs it every time.

## 3 · The order of work

### Start with the notes backend resource (Wave 2, item B1).

**Why that one.** It is the only item on the critical path of three surfaces at once — the Notes
screen is BLOCKED on iOS, Android and web, and every one of those blocks is the same missing table.
It is pure greenfield: no rebuild, no migration, nothing to break, and `10-notes.md:146` explicitly
separates the notes **read** from the XL proposal-subject rebuild, so it ships this wave rather than
waiting on the largest schema item in the programme. Its only prerequisite is P1, a single number a
designer can rule in a sentence — and ruling it is the first hour of that item's work, not a
separate wave.

**Why not the alternatives.** The Coach rename looks like the headline and is a poor first item for
one developer: it is unassigned (P3), it spans four repositories, and it turns three client suites
red by design. The type rebuild and Daylight are XL on every surface and neither can be measured
from source. The gesture wave is gated on three separate prerequisites. The Live Activity is
blocked on D3.

### The waves

*Every wave below names its gates. A wave whose gate is unmet is not "start it carefully" — it is
not started. Three of the ten are BLOCKED on something nobody has proven on a device, and they are
marked as such rather than sized.*

**Wave 0 · Decisions and proofs.** Everything in §2. No code. P1 and P2 need a designer; P3 needs
an owner; P4, P5, P8, P9 and P10 need a developer to pick and record; D1, D2 and D3 need a device.
*Unblocks:* everything below.

**Wave 1 · The defect sweep.** The FIX items that need no decision, no wire and no other surface:
the prompt's retired-settings clause (`B4`), the false dismissal copy on all three surfaces (`I17`, `A17`, `W12`),
the two latent Daylight tokens and the three black shadows on web (`W35`, `W36`), the tap floor on
Android (`A7`), the rest clock's mid-rest flip on both phones (`I27`, `A27`), and the iOS wake lock
(`I31`). Small, independent, and each one leaves the area better than it found it.
*Unblocks:* nothing structurally — which is the point. It is safe work while Wave 0's decisions are
being made.

**Wave 2 · Notes.** Backend resource → one read-level MCP tool + its client phrase → the trust-boundary
sentence in the prompt → the settings-zone move on web → three Notes screens. Gated on P1.
*Unblocks:* the honesty line, and the settings line "Coach reads your notes, not your settings."
*Explicitly not in this wave:* note proposals. See §5.

> **Carry the phrase tables into this wave.** Neither phone has one: iOS prints the raw tool name at
> `Ask.swift:35-37` (`failed ? "\(tool) · no answer" : tool`), drawn at `AskScreen.swift:142`, and
> Android does the same at `Ask.kt:9-11`, drawn at `AskScreen.kt:327-341`. Adding a `list_notes` tool
> without them prints `list_notes` on a lifter's screen — **the exact defect `09-coach.md:137-138`
> says this programme closes.** So the iOS half of `I19` and all of `A21` move from Wave 3 into
> Wave 2, or `B2` waits for Wave 3. Do not ship the tool ahead of its words.

**Wave 3 · The Coach rename and the room's copy.** Server strings + three clients + the tab label,
in one wave, with the test suites. Gated on P3. Carries with it: the allowance line above the
composer, the cap-reached state, the thread-ceiling copy saying four, the two blessed stances, the
typographic apostrophe, and the raw tool trace coming off behind the read receipt.
*Unblocks:* nothing downstream, but it is the wave the programme is named after and it gets worse
the longer three surfaces drift.

**Wave 3b · The web IA convergence.** `P5` exists to unblock this and no wave scheduled it. Today is
deleted as a tab and as a screen, the tabs become Routines · The log · Coach, and the live-session
mirror moves to the head of Routines home. It touches the hash grammar, `routes.js`, and
`GymApp.jsx`'s flat dispatch (`W2`, `W3`, `W4`). Gated on P5.
*Unblocks:* nothing downstream, but it is the last surface still carrying a second home, and ledger
`0t` stays open until it lands.

**Wave 4 · The review sheet.** The proposal review becomes a sheet/dialog over the conversation on
all three surfaces, the button pair becomes one primary, kept rows collapse to a count, the model's
prose gets its kicker, the receipt lands in the thread as an ephemeral line. Gated on P6 (web) and
on the dismissal-copy fix from Wave 1, which is what makes the "Turn this down" confirmation honest
rather than ceremony.
*Unblocks:* nothing; it closes ledger `1o`, `1u` and `1x`.

**Wave 5 · Native idiom.** The largest wave. iOS: TabView, NavigationStack, List conversions,
`.toolbar`, `.searchable`, platform controls. Android: Scaffold, TopAppBar, NavigationBar,
NavHost-or-not, icons, TextField, Switch, SegmentedButton, snackbar. Web: design-system adoption.
Gated on D1 and the capsule-inset ruling (iOS), D2, P8 and P9 (Android), P6 and P7 (web).
*Unblocks:* the gesture wave, which needs Lists, a snackbar host and a real back.

**Wave 6 · Gestures.** The withheld delete for routines, threads and finished sessions **first**;
then the set-row swipe, the logger's horizontal walk, the session-row context menu, and the undo
moving to the transient. Gated on P4, on Wave 5's containers, and on the withheld-delete gate the
briefs put in front of two of the three swipes.
*Unblocks:* nothing. It is the last wave that is purely additive.

**Wave 7 · Bodyweight.** Backend contract + claim-replay slot → the reading at the log head → the
chip in the reach band → the chart primitive. Gated on P2. The chart is a **new** primitive, not a
reuse — see §5.

**Wave 8 · Type and Daylight.** XL on every surface, and both need measurements nobody has taken.
Type is additionally BLOCKED on web (`W37`). Daylight is gated on ledger `F4` — `--pr-ink`'s
stated 3.4:1 has never reproduced at any ground — and on P9 for Android.

**Wave 9 · Live Activity.** BLOCKED on D3, on the four remaining simulator checks, and on a signing
team and a second target in `apps/ios/project.yml:20-40`, which today declares one target with
signing deliberately off.

**Deferred · The subject-bearing proposal.** The XL schema rebuild, note proposals, the
`from_lifter` → source migration and the durable receipt ledger row. This is a coherent programme of
its own and none of Waves 2-7 need it. See `B7`, `B8`, `B10`, `B11`.

---

## 4 · Per surface

Sizes are S / M / L / XL. Every line cites the file it was read from.

### 4.1 · Backend — `backend/products/gym/`

**B1 · [BUILD / L] Notes: table, repository, service, routes.**
Nothing exists under any name. `routes.cpp:35-307` mounts 36 handlers and none is a note;
`schema.sql:801-1067` holds fourteen `gym_*` tables and none is a note. The only `note` in gym is
`gym_sets.note` (`schema.sql:979`), a per-set record that `09-coach.md:21-25` explicitly separates
from this. Asks: `10-notes.md:59-63` (title + body, verbatim, ten notes, five hundred bytes);
`:84` (order is precedence, top note wins — so a lifter-editable position, a reorder write, a
whole-list replace, not per-row PATCHes); `:113-115` (its own resource); `:117-126` (nothing stored
until the lifter types).
*Careless build:* hanging notes off `gym_preferences` because it is already there.
`schema.sql:1022-1025` says one row per account and `routes.cpp:208-224` says the write is a
whole-document replace with no PATCH — a note stored there is lost the first time two screens are
open. Gated on **P1**.

**B2 · [BUILD / S] One read-level MCP tool for notes.**
`gymToolCatalog()` (`adapters/mcp/GymToolCatalog.cpp:153-391`) declares sixteen tools, six at
`Access::read`, none reading notes. `AskTools::declareTools` (`application/AskService.cpp:82-88`)
offers every `Access::read` declaration plus `mintsProposal(name)`, so a read-level notes tool is
picked up by Coach with no further wiring.
*The honesty line is verified, not assumed.* `10-notes.md:11-17` heads the screen with "Any agent
you connect can read these too." That rests on a notes read being served to every agent holding the
gym read scope, and it is true: `backend/platform/ports/ToolHost.h:85-90` filters `tools/list` on
`(product, access)` alone, and `backend/platform/domain/ToolScope.h:73-77` makes the empty scope —
what every code and token at rest carries — `ToolScope::everything()`.
*Careless build:* shipping the tool before the phrase (§2.3), or counting notes in the read receipt
(`domain/ReadReceipt.h`) — notes are not log rows, and `09-coach.md:151-154` pins that a reply
serving no log rows says nothing at all. `AskServiceTest.cpp:156-158` pins the exact eight-name list
AskTools offers and changes in the same commit.

**B3 · [BUILD / S] Notes welded into the first user turn.**
`askOpeningMessages` (`adapters/llm/AnthropicAsk.cpp:91-106`) already welds one thing into the first
user turn — the `list_sessions` document, fetched by an ordinary declared tool call at `:118`.
`10-notes.md:88-93` asks for a second one beside it: never in the cached prefix, and the read is a
declared tool call so the step line can name it.
*Careless build:* interpolating notes into `kSystemPrompt`. The comment at `AnthropicAsk.cpp:21-22`
states the prompt must stay byte-stable because it and the tool catalogue are one cached prefix;
interpolation moves that prefix on every request.
*Unbudgeted:* ten notes at five hundred bytes is up to 5 KB of uncached tokens on every turn of
every conversation, against a question already capped at 1000 bytes (`AskService.h:72`). Nobody has
measured what that does to the spend meter.

**B4 · [FIX / S] The prompt promises a read that was retired.**
`adapters/llm/AnthropicAsk.cpp:29-30` tells the model it can read "their gym's settings". No such
tool exists: `get_preferences` is in the retired list at `adapters/mcp/GymTools.cpp:440-444` with the
sentence "retired, and nothing replaced it", repeated at `GymToolCatalog.cpp:418-421`. Ledgered as
`1p` (`consistency.md:611-614`). `10-notes.md:38-45` makes it worse than stale — the whole Notes
feature ships on the distinction that Coach reads notes and *not* settings.
*Careless build:* bundling this with an interpolated notes change. Alone it moves the cached prefix
once, which is fine. Bundled, the prefix moves on every request and nobody separates the two
afterwards. **Land it standalone.**

**B5 · [BUILD / S] The prompt's trust boundary has no sentence for a note.**
`AnthropicAsk.cpp:49-53` is the hard security rule and it names three things as user data, never
instructions: set notes, movement names and routine names. Nothing says any free text is directive,
because today none is. `09-coach.md:21-25` requires this wave to draw the boundary: two free-text
fields on adjacent screens with opposite trust — a set note is a record, a note is directive.
*This is the single highest-consequence line in the wave.* A careless edit generalises the rule into
a blanket "free text is data" stance and makes set notes directive, turning `gym_sets.note`
(`schema.sql:979`, 4000 bytes per `GymToolCatalog.cpp:255`) into a prompt-injection surface any
MCP-connected agent can write. The new sentence names notes specifically and leaves the three
existing sources exactly as they are.

**B6 · [BUILD / M] Bodyweight: table, repository, service, routes.**
Greenfield, confirmed by grep. Every hit for `bodyweight`/`body_weight`/`weigh_in` across the
backend is the `Equipment::bodyweight` enum (`domain/Training.h:32`, `Training.cpp:26,58,148`), a
tonnage sentence (`GymToolCatalog.cpp:172`), the prompt's ban on estimating one
(`AnthropicAsk.cpp:66`), or a catalogue seed row (`schema.sql:1086-1114`). Asks:
`11-bodyweight.md:80-90` (entered for any date, corrected, deleted); `:104-106` (kilograms stored,
the toggle a display transform); `:108-114` (one read-level declaration, and Coach may never write
one).
*Careless build:* declaring a write tool. The ban is structural, not a prompt sentence — it is the
same reason no tool edits a logged set (`routes.cpp:91-98`, `:175-183`, pinned by
`GymToolsTest.cpp:178-194`). A write tool at `Access::write` is reachable by every MCP connection,
and if it were ever named `propose_*` the prefix rule at `GymToolCatalog.h:20-23` auto-grants it to
Coach. Gated on **P2**.

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
B7.)* There is one apply path and it is routine-only: `routes.cpp:196-201` →
`ProgramApi::applyProposal` (`adapters/http/ProgramApi.cpp:168-200`) → `ProgramService::apply`
(`application/ProgramService.cpp:102-115`), with `gym_routines.revision` (`schema.sql:861`) as the
concurrency token, checked at `PgProgramRepository.cpp:557` and `:612`.
*Careless build:* reusing `gym_proposal_changes` for a per-line text diff. Its `exercise_id` is a
not-null FK to `gym_exercises` (`schema.sql:926`) and its payload is eight numeric target columns —
a note diff would need a sentinel exercise, which survives review and then poisons every read that
joins on it.

**B9 · [BUILD / S] One proposal per turn.**
`AskTools::callTool` (`AskService.cpp:90-123`) appends every minted id to `proposals_` at `:120-121`
and refuses nothing. There is no per-run cap anywhere. When a second mint lands,
`supersedeFromDoor` (`PgProgramRepository.cpp:268-276`, called at `:495` **before** the insert) sets
the earlier pending proposal on the same `(routine, door, connection)` to `superseded` — so the
first is dead while both ids come back. `09-coach.md:41-45` asks for a refusal the model can act on:
"you already wrote a proposal this turn; fold both into one document."
*Careless build:* putting the check after the call. It must return from `AskTools::callTool` before
`inner_.callTool` at `AskService.cpp:117`. And it belongs on `mintsProposal(name)`
(`GymToolCatalog.h:20-23`), not on a list of two tool names — `AskService.h:25-26` gives the reason:
the rule is read off the declarations, never off a list that can drift.

**B10 · [FIX / M] The superseded refusal has one branch and needs two.**
`ports/ProgramRepository.h:66` has one `superseded` value, reached from five places
(`PgProgramRepository.cpp:554-555, 557-563, 610-611, 612-618, 646-647`). Two are genuinely a moved
routine (the `revision != base_revision` checks at `:557` and `:612`). The others fire when the row
is already superseded, including by `supersedeFromDoor`, where the revision never moved at all. Both
surface as one 409 with one sentence — "that routine changed after this proposal was written, so it
was not applied" (`ProgramApi.cpp:186-191`, and `:215-221` for dismiss) — which is **false** in the
case `09-coach.md:41-45` cares about. Nothing changed but Coach's mind.
*Careless build:* writing the copy fix alone. The distinction cannot be recovered at settle time
from the state column: `gym_proposals` stores `state`, `settled_at` and nothing about who superseded
it (`schema.sql:892-908`). This needs a reason column, or a supersede that records the id that
replaced it. Guessing by comparing `revision` to `base_revision` is wrong the moment a routine also
moved after the second mint — a second sentence, false in a different case.

**B11 · [REBUILD / M] `from_lifter` is a boolean and the receipt needs three sources.** *(Deferred;
gated on B7's programme.)* `schema.sql:1057` declares `from_lifter boolean not null`. Blast radius:
`domain/Thread.h:17`, `ports/AskAgent.h:15`, the model mapping `turn.fromLifter ? "user" :
"assistant"` (`AnthropicAsk.cpp:103`), the load (`PgAskThreadRepository.cpp:49,54`), the insert
(`:176,180`), the export CASE (`:221-224`), the wire `turn["from"] = ... : "ask"`
(`TrainingJson.cpp:496`), and the prompt assembly (`AskService.cpp:182`).
*Three failure modes, and the wire one is worst.* `TrainingJson.cpp:496` is a two-value enum today;
three clients must tolerate an unknown `from` **before** the server emits one, or a ledger row
renders as an assistant message on a phone that has not shipped. Second: `AnthropicAsk.cpp:103` maps
every stored turn onto `user` or `assistant`, so a ledger row falling through that ternary is fed
back to the model as something it said — precisely the mis-statement `09-coach.md:107-108` says the
receipt exists to make impossible. Third: the export's `CASE WHEN n.from_lifter IS NULL`
(`PgAskThreadRepository.cpp:221-224`) carries a comment explaining that a plain CASE sends NULL down
the ELSE branch; the same trap waits for a third value.

**B12 · [BUILD / M] The receipt ledger row.** *(Deferred; gated on B11.)*
`appendTurns` is called from exactly one place — `AskService.cpp:231-232`, after a model run. The
settle routes (`routes.cpp:196-207`) touch no thread: `ProgramService` holds a `ProgramRepository`
and a `Clock` and nothing else (`ProgramService.h:69-71`). `ThreadProposal` (`Thread.h:25-34`)
carries `createdAtMs` and no settled-at, so on reopening a thread the receipt cannot be placed back
in chronology.
**Worth saying plainly: the *ephemeral* receipt needs no backend work at all.** The apply reply
already carries `proposal` and `routine` (`ProgramApi.cpp:196-199`) and `toJson(RoutineProposal)`
emits `baseName`, `name` and `changeCount` (`TrainingJson.cpp:441-449,556-560`). "Applied · Push A ·
4 changes" is derivable today. Only durability is not — and `09-coach.md:113-116` says that until
the row exists, the boards state the receipt is ephemeral. Shipping the receipt UI without the row
and calling it history is the failure the brief names.
*The seam:* wiring a `ThreadService` into `ProgramService` would put a conversation write inside the
program aggregate's apply transaction, against the dependency rule and against the file's own
comment at `ProgramService.h:34-36`. Either an application-level coordinator above both, or the
route composing the two — and the ledger row must not be inside the apply's transaction, because a
failed thread write must never roll back a routine that landed.

**B13 · [FIX / M] Nine server strings say "Ask", not four — and five ship a straight apostrophe.**
`adapters/http/AskApi.cpp` sends nine distinct lifter-facing messages containing the room name:
lines 16, 24, 27, 30, 33, 37, 42, 46 and 76 (verified by grep). Two more spellings reach a lifter:
the wire enum `turn["from"] = ... : "ask"` (`TrainingJson.cpp:496`) and the CSV export's `ELSE
'ask'` (`PgAskThreadRepository.cpp:224`), which lands as a column value in a file a lifter opens.
`AskApi.cpp` contains **zero** typographic apostrophes: lines 16, 27, 37, 46 and 76 ship `isn't`,
`can't`, `that's`, `isn't`, `didn't` with straight quotes, against `09-coach.md:204` — the
typographic apostrophe, everywhere, on every surface. The server is a surface.
*Two documents undercount this and are stale in the same change:* `consistency.md:616-618` says
"four server strings" and cites only `AskApi.cpp:33-38`; `ARCHITECTURE.md:1092-1096` says "the four
this file's own AskApi sends."
*Careless build:* changing the error **codes**. `ask-thread-taken`, `ask-thread-full`,
`ask-session-open`, `ask-daily-limit`, `ask-out-of-budget` and `ask-not-configured`
(`AskApi.cpp:19,31,34,39,44,46`) are the machine contract, and `ARCHITECTURE.md:1078` states it:
copy may change, the verdict codes may not. Gated on **P3**.

**B14 · [FIX / S] The cap-reached refusal restates the rule instead of saying what to do next.**
`AskApi.cpp:35-39` sends, on 429: "that's Ask for now — it answers about ten questions a day, three
back to back. The next one frees up in a couple of hours." The numbers are true (`kAskPerDay = 10.0`,
`kAskBackToBack = 3.0`, `AskService.h:77-78`, a token bucket at `AskService.cpp:42-43,61-69`).
`09-coach.md:170-176` wants the cap-reached state to say what to do next, with the rule itself
living above the composer in the room.
*Careless build:* trimming the server sentence before the three clients draw the standing line.
It is currently the **only** place the numbers are stated to a lifter mid-conversation, and four
client suites pin the substring (`ask.test.js:183`, `screens.test.js:133,142`, `AskTests.swift:252`,
`AskVerdictTests.kt:13-15`). Trim it first and nobody ever states the allowance.

**B15 · [BUILD / S] Notes and bodyweight must reach the export and the account footprint.**
**This is not a floating item: it ships INSIDE Wave 2 (notes) and Wave 7 (bodyweight), and it cannot
start before B1 / B6.** `backend/platform/infra/main.cpp:165-166` states the consequence in its own
words — *"EVERY product must appear: one missing reports an account empty that is not, and the link
door then deletes real data."* The footprint currently enumerates **twelve** gym tables
(`main.cpp:168-187`).
The export is two CSVs — `toCsv(std::vector<ExportedSet>)` and `toCsv(std::vector<ExportedThreadTurn>)`
(`adapters/csv/TrainingCsv.cpp:55-73`), served at `routes.cpp:232-245`. The account footprint
enumerates thirteen gym tables by name (`backend/platform/infra/main.cpp:167-188`) under a comment at
`:165-166`: "EVERY product must appear: one missing reports an account empty that is not, and the
link door then deletes real data." (`gym_preferences` is absent on purpose — settings are not data
an account holds.) `10-notes.md:153-155` says notes export with everything else and delete with the
account.
*Careless build:* skipping the footprint. An account whose only gym data is notes and weigh-ins
would read as empty. Deletion itself is safe if the new tables cascade on `users(id)` like every
other `gym_*` table (`schema.sql:802-805`) — but the footprint list is hand-maintained and nothing
enforces it.

**B16 · [BLOCKED / S] The note bounds are about to become schema CHECKs.** See **P1**. The shape of
what a decision costs is visible: `gym_routine_entries` carries `check (target_sets between 1 and
20)` and siblings (`schema.sql:876-879`), while `gym_proposal_changes` deliberately carries none,
with the comment at `:918-920` explaining why — a bound tightened later must never make an
already-stored row unreadable.

**B17 · [BLOCKED / S] Nobody has ruled whether a ledger turn is fed back to the model.**
Every stored turn goes to the model and every stored turn counts against the cap:
`AskService.cpp:180-182` builds the prompt from `opened.thread->turns` unconditionally; `:185-189`
refuses when `turns.size() + 2 > kMaxThreadTurns`, which is 8 (`Thread.h:70`); `AnthropicAsk.cpp:103`
has no third branch. `09-coach.md:180-182` fixes the lifter-visible ceiling at four questions
precisely because a question and its answer are two turns against eight. What the briefs do not say
— I looked — is whether a ledger row is shown to the model on the next turn.
*Both answers are defensible and they are not equivalent.* Hidden, the model can contradict a
receipt the lifter is looking at. Shown as an assistant message, the model reads a server-authored
sentence as something it said. Deciding it by filtering the load in the repository is the cheapest
implementation and the easiest to get silently wrong: `AskService.cpp:185` would count a filtered
list and the export at `PgAskThreadRepository.cpp:216-232` an unfiltered one.

### 4.2 · iOS — `apps/ios`

The two prerequisites specific to this surface are **D1** (the leading edge) and the capsule inset:
`Shell.swift:167-172` reserves the capsule lane with a top `.safeAreaInset` holding a 38pt button
plus `WindmillSpace.x2` padding, applied by RoomHost **outside** the room's view tree, so no gym file
can reclaim it. `12-native-idiom.md` is blunt: either the shell stops applying it for a room that
hosts its own top bar, or native costs vertical space and no board may claim otherwise. Build the
TabView conversion first and every board is drawn against a frame ~46pt taller than the device gives
— and the shortfall surfaces at the *bottom*, where the logger's elastic today-column
(`LoggerScreen.swift:265`, capped at 156pt) eats it silently and drops a row. **[PREREQUISITE / S]**

**I1 · [REBUILD / L] The hand-rolled capsule rail becomes a TabView; the You seat leaves the bar.**
`GymRoom.swift:227-248` draws an HStack of three text Buttons inside a `Capsule().fill(skin.surface)`
with `YouSeat()` as a fourth element at `:240`; tabs at `:33-39`. `TabView` appears nowhere in
`apps/ios`. `12-native-idiom.md` and ledger `1l` (`consistency.md:581-590`) move both shell seats
into the room's own top chrome — capsule leading, You trailing, on each stack root.
*Careless build:* deleting the You seat before the room has a top bar to receive it. It is the only
door to the account and to sign-in (`GymRoom.swift:190` routes `onSignIn` through
`shell.openYou()`), so an anonymous lifter loses the way to claim their log. Second: ledger `1v`
measures the selected/unselected tint separation at roughly 1.15:1 (`skin.accent` #9a90be,
`GymSkin.swift:34`, against `skin.inkFaint` #8d8896, `:45`) — a native tab bar's labels are
colour-only, so the conversion makes an existing legibility defect worse unless the tokens move
first.

**I2 · [REBUILD / XL] The hand-built `away` stack becomes a NavigationStack.**
`GymRoom.swift:15` holds navigation as `@State private var away: [Away]`, nine destinations at
`:41-66`, push/pop at `:215-225`, and a bottom-drawn back row at `:250-273` with a `chevron.left`
and the previous destination's name. There is no interactive pop — the room has no navigation bar,
which is exactly the condition `Shell.swift:148` names as the reason the home swipe is hand-rolled.
*Careless build — the item most likely to ship a state bug no test catches:* `GymRoom.swift:112-124`
arbitrates the whole stage in one switch where a finished session outranks a live session, which
outranks every away screen, which outranks the tab; `showing` returns nil whenever a session is open
(`:210-213`), so today starting a workout silently swallows any pushed screen. A NavigationStack owns
its own path, so the same event must now explicitly unwind it. A stack left standing behind a live
logger is a lifter who finishes a workout and lands three screens deep in a routine editor. Gated on
**D1**.

**I3 · [REBUILD / L] Session, Routines and Threads convert from ScrollView to List.**
WindmillGym holds 14 `ScrollView` sites across 13 files and exactly two `List {` —
`JumpSheet.swift:29` and `RoutineBuilderScreens.swift:140`, which are also the only two places
`.swipeActions` appears (`:36`, `:148`). The three screens the gesture wave needs are ScrollView +
VStack: `SessionScreen.swift:119`, `RoutinesScreen.swift:26`, `ThreadsScreen.swift:25`. The session's
sets are grouped by movement (`SessionScreen.swift:206-232`), so it becomes sections, not a flat list.
*Careless build:* every row is currently a `Button` wrapping a card with its own fill and stroke
(`SessionScreen.swift:250-275`, `RoutinesScreen.swift:169-215`, `LogScreen.swift:176-213`). A List
applies its own insets, separators and background; the two existing conversions already fight it
with `.listRowBackground(Color.clear)`, `.listRowSeparator(.hidden)`, `.listRowInsets(...)` and
`.scrollContentBackground(.hidden)` (`JumpSheet.swift:33-35,:44-46`). Lose the card frame and
nothing separates a set row from a movement heading.

**I4 · [BUILD / L] The withheld delete for the routine row, the thread row and a finished session.**
All three delete immediately, with no confirmation, no hold and no undo. Routine:
`GymRoom.swift:387-397` calls `store.deleteRoutine`, affordance three screens deep at
`RoutineBuilderScreens.swift:261`. Thread: `ThreadsScreen.swift:317-327` calls `doors.delete` and
leaves the screen. Discard session: `FinishScreen.swift:328` calls `onDiscard` into
`GymRoom.swift:373-380`. **The only `.confirmationDialog` in the entire app is
`LoggerScreen.swift:376`, for choosing a set kind** (verified by grep).
`13-gestures.md` makes this the gate for the whole gesture wave: those three get a withheld delete
before they get a gesture.
*Careless build:* skipping it, because the swipe is the visible half. `.swipeActions` on any of
those rows first puts an unrecoverable delete one careless thumb away — and on the routine row it
cascades the proposal ledger (`schema.sql:894`).

**I5 · [FIX / S] Discarding a session says "There is no undoing it" and asks nothing.**
`FinishScreen.swift:328` is a bare `Button("Discard session", action: onDiscard)`; `:333` prints
"Discarding deletes the session and its sets. There is no undoing it." directly beneath it. The tap
runs straight through. `16-the-workout.md` says Discard "keeps its confirmation" — it does not have
one. It sits directly under an accent-filled "Keep it" button of nearly the same width
(`FinishScreen.swift:322-331`). Low to build, high to leave: it is the only unconfirmed,
unrecoverable destruction of a whole workout in the product.

**I6 · [BUILD / M] A trailing swipe to delete on the set row of a past session.**
The only row ready today. `SessionScreen.swift:250-275` draws each performed set as a Button opening
the fix sheet, with `.accessibilityHint("Fix this set")` at `:274`; delete lives inside that sheet
(`FixSheet.swift:154`). The 9000 ms hold and its restore path exist: `SetQueue.swift:48`,
`TrainingStore.swift:914-933` and `:937-958`, with an inline undo row at `SessionScreen.swift:181-203`.
`13-gestures.md`: one action, Delete, trailing edge, nothing leading.
*Careless build:* adding a second trailing action — the brief measured that two actions eat about
half the row and push the set's ordinal and load off the leading edge. Or enabling full-swipe, which
makes two-deletes-in-a-second the fastest path while the undo holds one. Gated on **I3**.

**I7 · [FIX / M] The undo holds exactly one delete and nothing says so when the second arrives.**
`TrainingStore.swift:174` is `private var taken: Deletion?` — one slot, overwritten at `:914-916`,
so a second delete **settles** the first: the first set's DELETE stays queued with its own
`heldUntilMs` (`SetQueue.swift:280-283`) and goes out when the hold expires, with no way back.
`restorable` (`:176-179`) is time-gated and not published, which is why `SessionScreen.swift:183`
polls it with `TimelineView(.periodic(...))`. `13-gestures.md`: either the window holds more than
one, or the second swipe is refused with the reason said plainly. Tolerable behind a two-tap trip
through a sheet; dangerous behind a swipe.

**I8 · [FIX / M] Leaving the room force-sends a held delete, and nothing says it did.**
`GymRoom.swift:108` is `.onDisappear { Task { await store.flushPendingSets(force: true) } }`;
`force` reaches `TrainingStore.swift:1054`, `queue.nextOwed(skipping: blocked, readyAt: force ? nil :
now())`, and `SetQueue.swift:237-243` documents that a nil instant skips the hold entirely.
`TrainingStore.swift:472` already states the consequence in a comment. Behind a swipe this means
*swipe, then press back* — an ordinary pair of actions — destroys the row while the undo is still
nominally on screen. It becomes reachable by accident the day the edge-swipe back lands (**D1**): the
same stroke that used to go home now pops a screen, and the pop commits the delete.

**I9 · [REBUILD / M] The undo leaves the row and becomes a transient, on both screens.**
`LoggerScreen.swift:287-291` draws `Button("Undo")` inside the today-column row;
`SessionScreen.swift:181-203` draws a separate inline row at the top of the scroll.
`13-gestures.md` Law 4 sends both to an iOS bottom transient carrying the action **and** the fact
that a window is open, retiring itself when the window closes.
*Careless build:* growing the bottom inset. The logger's Log-set button is pressed five to forty
times a session (`LoggerScreen.swift:443-461`); a transient that reflows the screen makes it jump
twice per set. SwiftUI has no built-in transient here, so it is hand-rolled and must retire on a
clock the store does not publish (`TrainingStore.swift:176-179`).

**I10 · [BUILD / M] A horizontal swipe between movements in the logger.**
`LoggerScreen.swift:227-237` draws two 46×46 `walkButton`s stepping through `store.order`
(`:239-245`); the title between them is a full-width Button opening the JumpSheet (`:189-222`); the
today-column beneath is a nested vertical ScrollView (`:254-266`). Leaving a movement can raise the
DeviationSheet through `move(to:)`/`settleTheMove` (`:532-556`), a path written for taps.
*Careless build:* the deviation guard at `:533-538` keys on `asked` and on whether a sheet is up
(`:540-543`); at swipe velocity two movements can be crossed before `settleTheMove` runs, and the
pending deviation is a single `@State` slot (`:22`) the second swipe overwrites. This gesture also
starts in the body and must lose to the shell's leading-edge claim — unarbitrated until **D1**.

**I11 · [BUILD / S] A context menu on the log's session row — Share this workout, alone.**
`contextMenu`/`Menu {` return nothing across `apps/ios`. `LogScreen.swift:176-213` draws the session
row as a single Button with one action. Sharing lives only inside the session
(`SessionScreen.swift:127`), discarding only on the finish screen.
*Careless build:* adding the obvious second item. `13-gestures.md` is explicit that Discard does not
go in this menu until the withheld delete exists, and that a confirmation would not rescue it.

**I12 · [REBUILD / L] The target sheet's five affordances become three typed fields.**
`RoutineBuilderScreens.swift:294-484` offers hand-built sets and reps steppers (`:385-414`), a ±
plate ladder (`:463-483`), "take it to max" and "use last time" (`:447-461`) and "Leave it open ·
decide at the rack" (`:349-360`). **There is no typed entry at all** — `KeypadSheet` is reached only
from the logger (`LoggerScreen.swift:468-475`), so a target weight cannot be typed on iOS today.
`15-the-routine.md`: three fields, no escape hatch, placeholders carrying the null semantics, and
the ± ladder comes off.
*Careless build:* the six pinned refusals have no home on iOS (see **P10**). They are new work, not a
move, and the brief records that three surfaces already lost four of them once by leaving them
unassigned. Ledger `2l` (`consistency.md:797-810`) additionally records that iOS and Android draw the
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
(`GymRoom.swift:250-273`).
*Careless build:* converting the head to `.toolbar` without adding Cancel. `:57-58` keeps `opening`
precisely so an edit can be compared against what was loaded, so a silent back is a silent discard of
every edit. Delete must not reach the overflow before **I4**.

**I15 · [REBUILD / M] `.searchable` replaces the picker's hand-built field, and the seven-row cap
moves with it.** `MovementPicker.swift:95-104` is a bare `TextField` styled as a rounded rectangle
above a plain ScrollView (`:106-121`), and `:7` caps the list at `shown = 7` for every query,
including the empty one. `15-the-routine.md` wants the platform control and "an empty query shows
the six and then the whole catalogue"; ledger `2j` (`consistency.md:784-790`) records that **no
surface implements that ruling** and names this constant as the iOS blocker.
*Careless build:* swapping the control and leaving `shown = 7`, which ships the same defect under a
native chrome — worse, because the picker now looks like it browses the catalogue and does not.
`.searchable` also needs a List inside a NavigationStack to render where the system puts it, so this
is gated on **I2** and **I3**.

**I16 · [REBUILD / L] The proposal review becomes a sheet, and its button pair becomes one primary.**
`GymRoom.swift:136-139` renders `ProposalScreen` as an `Away` destination — a push.
`ProposalScreen.swift:163-193` draws Dismiss and Apply side by side at the same height, Dismiss on
the left; `decide(_:apply: false)` (`:206-220`) settles immediately with no confirmation. Kept rows
are dropped (`:114-115` is `case .kept: EmptyView()`, and `Proposal.swift:260` filters them before
the view sees them — ledger `1o`).
*Careless build:* the pair puts the one irreversible act where a thumb expects Cancel, and colour
does not undo position. The detent is the other trap: `09-coach.md` forbids a fixed partial detent
because a half-height sheet does not grow with the system text size, so at the larger accessibility
sizes the visible diff goes to zero while Apply stays enabled. iOS gym already pins fixed-height
detents in four places (`LoggerScreen.swift:49`, `SessionScreen.swift:146`,
`RoutineBuilderScreens.swift:126`, `Shell.swift:60`), so the habit is established and will be
repeated.

**I17 · [FIX / S] iOS promises a dismissed proposal can be taken back; the wire has no path.**
`Proposal.swift:292`: "Dismissed {when}. No reason asked for, nothing changed, and it stays in the
routine's history in case you want it back." `routes.cpp:197,203` carry apply and dismiss and
nothing that reopens one. Ledger `1u`. It gates **I16**: the confirmation on "Turn this down" is only
honest once this line is true.

**I18 · [REBUILD / M] The room is called Ask, and both stances carry the wrong words.**
`GymRoom.swift:36` declares `case ask = "Ask"`. `Ask.swift:173-178` holds `title = "Ask"`,
`subtitle = "reads your log · proposes only"`, `needsSignIn = "Ask reads your log, so it needs you
signed in."` and `absentLine = "Ask isn't available on this Windmill."`, drawn at
`AskScreen.swift:47,:344,:370,:387`. Ledger `consistency.md:257-263` records that iOS's shorter
signed-out wording **wins** and iOS's *available on* **loses** — nothing is broken and nothing is
coming back later, so a word implying a temporary fault would be a small lie.
*Careless build:* renaming on iOS alone produces a room called Coach that answers refusals in the
name of Ask (**B13**, **P3**). `AskTests.swift` pins several of these strings, so the rename breaks
tests by design — that is correct, not a signal to revert.

**I19 · [REBUILD / M] The raw tool trace prints under every answer; the allowance is only in the
empty room.** `AskScreen.swift:142` prints `steps(answer.steps)` under every answered turn as a raw
list of tool names — `AskStep.line` is the tool name itself (`Ask.swift:35-37`), no phrase lookup.
The read receipt is present and always visible (`AskScreen.swift:144`, `Ask.swift:16-23`). The daily
allowance is a three-line paragraph (`Ask.swift:198-201`) drawn only inside `opening`
(`AskScreen.swift:27,:77`); the composer (`:248-280`) carries no allowance line, and there is no
cap-reached state anywhere.
*Careless build:* deleting the paragraph without drawing the one-line promise and the cap-reached
state does not trim the cap, it deletes it. And the honesty claim rests on the receipt being always
visible, never on the collapsed step list — collapse both and the check is gone.

**I20 · [FIX / S] The thread ceiling is four questions and the copy states neither four nor eight.**
`Ask.swift:198-201` says nothing about the per-thread ceiling; hitting it arrives as a 409 handled at
`:110-114`, which surfaces the server's message and quietly opens a fresh thread
(`AskScreen.swift:309`). Ledger `1r`. **Stating eight because the code counts to eight is the wrong
answer, and it is the answer the wire hands you.**

**I21 · [BUILD / L] The Notes screen does not exist.** No screen, no model, no read. Gym settings
offers two doors — Export and Connected log (`SettingsScreen.swift:122-134`) — and Coach's room one,
to threads (`AskScreen.swift:55-60`). Settings is reached from a row at the foot of Routines
(`RoutinesScreen.swift:153-166`).
*Two careless builds the brief names in advance:* storing notes in the preferences document, which
`SettingsScreen.swift:4` already documents as "every tap writes the whole preferences document"; and
putting the Notes door in the top bar as a third icon, which implies Coach owns the notes — the
opposite of what the honesty line exists to say. Gated on **B1**.

**I22 · [BUILD / XL] Bodyweight does not exist, and the chart it needs is not the chart gym owns.**
The Log tab's head draws a title and a loaded-count line only (`LogScreen.swift:131-143`), and the
whole tab is one ScrollView with nothing pinned in the reach band (`:112-128`). Gym's only chart is
bars normalised to the series maximum: `Record.swift:139-149`, drawn at `RecordScreen.swift:120-128`
as `.frame(height: max(0, bar.height) * 122)`.
*The brief names the careless build outright:* "reaching for the existing one would have been the
obvious move" — normalised bars render every bodyweight between 82.0 and 84.5 as a near-identical
full-height block. The second named trap is reusing the ladder, which carries plate physics and
signed loads into a value that has neither. Gated on **B6**.

**I23 · [REBUILD / XL] The type ramp — 358 literal point sizes, and Dynamic Type does nothing.**
358 font call sites carry a literal size, spread across every screen (29 in `AskScreen.swift`, 27 in
`ConnectedLog.swift`, 26 each in `RoutinesScreen.swift`, `RoutineBuilderScreens.swift`,
`LoggerScreen.swift`). `Font.TextStyle`, `ScaledMetric` and `dynamicTypeSize` appear **nowhere** in
`apps/ios`. Instrument numerals are fixed points: `GymSkin.swift:64-66` pins weight at 104, reps at
36, the correction figure at 72, with `minimumScaleFactor` as the only guard
(`LoggerScreen.swift:320`, 0.55). Uppercase eyebrows carry 24 hand-set tracking values.
*Careless build:* the logger's today-column claims its height from named constants before its rows
lay out — `rowHeight = 52`, `columnCap = rowHeight * 3` (`LoggerScreen.swift:271-272`), used at `:265`
as `min(columnCap, rows.count * rowHeight)`. Under Dynamic Type the rows grow and the frame does not,
so rows clip silently at exactly the setting whose purpose is legibility. Every hand-set fixed-width
column breaks the same way: `SessionScreen.swift:256` (`width: 18`), `LoggerScreen.swift:279`
(`width: 16`), `AskScreen.swift:190` (`width: 92`). These become grids. `12-native-idiom.md` is
explicit that the point values at the largest accessibility sizes are read off the simulator's
accessibility inspector, not taken from published defaults.

**I24 · [REBUILD / XL] Daylight — the room forces itself dark in three places and declares one skin.**
`GymRoom.swift:68` is `private var skin: GymSkin { .instrument }`, a computed constant with no
producer; `:86` writes `.environment(\.colorScheme, .dark)` into the whole room and `:87` dresses the
capsule dark. `GymSkin.swift:28-49` declares exactly one skin and `:52-54` makes it the environment
key's default. The shell's Appearance control is real and working (`YouScreen.swift:52-65`,
`Shell.swift:55-56`) — gym is the room ignoring it.
*Careless build:* the skin reaches the room through an environment key whose default is hardcoded to
`.instrument`, so any view presented outside the room's environment keeps the dark skin — and gym
presents six sheets pinning their ground to the skin explicitly (`SessionScreen.swift:145`,
`LoggerScreen.swift:110`, `RoutineBuilderScreens.swift:105,:110`). A half-conversion is a light room
with dark sheets. Gated on ledger `F4`.

**I25 · [BLOCKED / XL] The Live Activity target does not exist.**
`ActivityKit`, `WidgetKit`, `AppIntent` and App Group identifiers return nothing across `apps/ios`.
`project.yml:20-33` declares one target with `CODE_SIGNING_REQUIRED: "NO"` and no team, on purpose
(`:37-40`). BLOCKED for the reason the brief states itself — nothing here has been run on a device
(**D3**). One separate build risk worth pinning now: "the app mints the id and hands it to the button
as part of the activity's state" — idempotency does not cover this on its own, because two taps mint
two ids and two ids are two sets.

**I26 · [BLOCKED / L] SetQueue is one-per-process by construction.** See **D3**.

**I27 · [FIX / S] The rest clock counts down and flips; it must count up throughout.**
`RestTimer.swift:31-35` computes `left = target - elapsed`, returns a countdown while `left >= 0` and
`"+" + clock(-left)` past zero. Drawn at `LoggerScreen.swift:137-163`. Ledger `2b`.
*Careless build:* `Rest.filled` (`RestTimer.swift:25-29`) and the chime task
(`LoggerScreen.swift:95-107`, with a five-second late-chime guard at `RestTimer.swift:12`) key off the
same target seconds. The **reading** changes; the target, the bar and the chime must not.
`RestTimerTests` pins some of this.

**I28 · [BUILD / S] The set kind offers two of its four values on the logger.**
`SetKind` has four cases (`Training.swift:6-7`); the logger's pill iterates `[SetKind.working,
.warmup]` only (`LoggerScreen.swift:376-380`), so drop and failure cannot be chosen while logging.
The fix sheet offers all four after the fact (`FixSheet.swift:120`). The pill disarms to `.working`
after every logged set (`:449`).
*Note the brief's premise is false here* — this is an extension, not a first build, and a developer
who reads "no surface has ever offered" will delete and rewrite a working control. *The real hazard*
is the disarm: a four-way control that forgets to reset files every working set after a drop as a
drop, which corrupts every statistic the product shows, silently.

**I29 · [REBUILD / L] Finish becomes a sheet over the session; the Finish action becomes a toolbar
item.** `GymRoom.swift:114-123` renders the finish screen above everything with `isAtRest` false and
`showing` nil (`:206-213`), so the bottom bar draws no back button at all. Its only exits are Done
and Discard. Finish itself is a hand-drawn Button inside the logger's header
(`LoggerScreen.swift:129-132`), not a `.toolbar` item — so this is a conversion, not a move from the
bottom band.
*Careless build:* `close()` (`GymRoom.swift:354-371`) only sets `finished` after the log answers, and
has two non-closing outcomes — `.stranded(count)` and `.failed(why)` — that leave the session open.
A sheet "over the session it just closed" needs that session navigated to underneath first, which
the room does not do, so the naive build presents a sheet over the live logger of a workout that is
still open.

**I30 · [REBUILD / M] Loading, empty and share states are hand-drawn where the platform has a
control.** `ProgressView`, `ContentUnavailableView`, `ShareLink` and `Stepper` appear nowhere.
Loading: `LogScreen.swift:229-238`, `ProposalScreen.swift:36`, `ThreadsScreen.swift:189`. Empty:
`RoutinesScreen.swift:66-101`, `LogScreen.swift:145-155`. Sharing writes to the pasteboard
(`CoachShare.swift:183`). Settings hand-builds segmented controls (`SettingsScreen.swift:49-62`,
`:85-100`); its `Toggle` at `:160` is the one genuinely native control in the room.
*Careless build:* `ContentUnavailableView` renders one description and one action, and the Routines
empty state ships two of deliberately different weight — "Build a routine" primary, "Just start
logging" beneath (`RoutinesScreen.swift:83-97`) — so a straight swap deletes the second. Replacing
the pasteboard copy with `ShareLink` also changes what the lifter gets: `Coach.card` reports a
`copied` state back into the card (`CoachShare.swift:59,:183`), and a share sheet has no equivalent.

**I31 · [FIX / S] No wake lock on the surface the architecture says owns the open session.**
`isIdleTimerDisabled` appears nowhere in `apps/ios` (zero matches). The room holds the workout
(`GymRoom.swift:124`). Ledger `2a` (`consistency.md:702-710`): `ARCHITECTURE.md:989` lists wake lock
among the things the phone owns, Android does it, iOS does not — so the screen sleeps mid-set on the
capture device.
*Careless build:* setting it without clearing it on every exit path. The room has three ways out that
already need handling — `onDisappear` (`:108`), scene phase (`:101-107`) and finishing (`:354-371`) —
and only one is obvious.

**I32 · [FIX / M] A set's note and RPE round-trip on the wire and appear on no iOS screen.**
`TrainingSet` carries `rpe: Double?` and `note: String` (`Training.swift:152-153`), decoded and
encoded (`:201-202,:214-215`), preserved through a fix (`:177`). `SetFix` carries only weight, reps
and kind (`:725-734`). **No iOS view reads either** — verified: the `.note` references at
`SessionScreen.swift:265` and `LoggerScreen.swift:283` are derived plan-comparison strings, not the
set's own. Ledger `1s` says RPE "is drawn on every surface"; it is drawn on none here (§6).
*Careless build:* `SetFix` is the wire body for the PATCH (`TrainingStore.swift:1061-1063`); adding
fields changes what a correction overwrites, and `TrainingStore.swift:960` already warns that a PATCH
filed over an owed append destroys the only copy of that set.

**I33 · [FIX / S] The mid-workout Apply caveat has no reachable state on iOS.**
While a session is open the logger outranks everything (`GymRoom.swift:124`, `showing` nil at
`:210-213`) and the Coach door is closed —
`Ask.doorIsOpen(signedIn:sessionIsOpen:onThisDeployment:)` requires `!sessionIsOpen`
(`Ask.swift:208-210`) and `GymRoom.swift:185-188` passes nil for `onAsk`. So no proposal review can
be reached mid-workout on this surface.
*Careless build:* drawing the caveat on a board iOS cannot reach. It will be signed off because it
looks correct in Figma. The honest resolutions are either to make the review reachable while a
session is open — a navigation change, not a copy change — or to record on the board that this state
does not exist on iOS. **Deciding by drawing is what produces a third answer nobody chose.**

### 4.3 · Android — `apps/android` (`:app :platform :gym`)

Surface prerequisites: **P8**, **P9**, **D2**.

**A1 · [FIX / M] Back has four meanings and a fifth that leaves the app mid-workout.**
`GymRoom.kt:198-217`: `BackHandler(enabled = finished != null || (!live && (building != null ||
away.isNotEmpty() || tab != Tab.Routines)))` with four bodies — claimed and inert on the finish
screen (`:204`), Cancel-and-discard-the-draft (`:206-209`), pop one (`:210-213`), return to
`Tab.Routines` (`:214-215`). **Mid-workout the handler is disabled by construction** (the comment at
`:193-195` says so), so a system back during a workout is plain platform back and leaves the room.
`13-gestures.md` corrects itself on exactly this point: the logger is the *most* exposed screen to an
edge-started horizontal gesture, not the safest.
*Careless build:* a NavHost gives none of the four for free — a NavHost pops a destination, and three
of the four are not pops. And closing the mid-workout hole has a cost the brief does not price:
`away` is deliberately not saved (`GymRoom.kt:161-163` — "NOT saved, so no screen is drawn over a
store that has not read the disk yet"), so a handler that keeps the lifter in the room during a
workout also has to not resurrect a screen over an unread store.

**A2 · [BUILD / XL] Navigation is a sealed list and five hand-drawn back rows.**
`gradle/libs.versions.toml:1-40` has no navigation entry; `NavHost` and `androidx.navigation` return
zero hits. Navigation is `var away by remember { mutableStateOf<List<Away>>(emptyList()) }`
(`GymRoom.kt:164`) over `sealed interface Away` (`:125-134`), dispatched by a 130-line `when`
(`:492-616`). Back is drawn by hand in five places: `GymRoom.kt:470-484`, `SettingsScreen.kt:105-115`,
`ProposalScreen.kt:180`, `RecordScreen.kt:168`, `ThreadsScreen.kt:310-320`.
*Careless build:* a NavHost saves and restores its back stack, which is precisely what
`GymRoom.kt:161-163` refuses on purpose; and `Away.Session` carries a whole `SessionSummary` object
(`:126`) because, per the comment at `:120`, it "carries facts no other read gives back" — a route
argument is a string, so that screen needs a different data path before it can be a destination.
Doing this carelessly turns a documented decision into a silent regression. Gated on **P11**.

**A3 · [REBUILD / L] Scaffold, TopAppBar and NavigationBar.**
The whole room is `Column(Modifier.fillMaxSize().background(GymSkin.canvas).systemBarsPadding())`
(`GymRoom.kt:447-452`). The tab rail is hand-rolled (`:641-690`): a 50dp Row, full-radius background,
1dp border, three 40dp pills, plus `YouSeat` (`:694-760`). There is **no top bar at all** — screen
titles are `Text` inside the scroll (`LogScreen.kt:117`). The rail draws only when `ended == null &&
!live && building == null && away.isEmpty()` (`:634`).
*Careless build:* those four conditions are load-bearing. A Scaffold's `bottomBar` slot makes it a
lambda returning nothing, and an empty NavigationBar still reserves height. Same for the top bar:
native costs vertical space, and the logger is the one screen where the numeral competes for every
point (`LoggerScreen.kt:239`: "One elastic region only, the history: sets can never push the 64dp
action out of reach"). Gated on **P8**.

**A4 · [BUILD / M] Icons at all — there are none.**
`Icon`, `Icons`, `IconButton` return zero hits across `gym`, `platform` and `app` main sources. Every
affordance is a text glyph: "‹"/"›" (`GymRoom.kt:479`, `LoggerScreen.kt:412,:426`,
`RoutinesScreen.kt:238,:291`, `SettingsScreen.kt:112`, `ThreadsScreen.kt:318`), "↑" for send
(`AskScreen.kt:509`), "+" (`RoutinesScreen.kt:160`), "✓"/"·" (`SessionScreen.kt:391`).
*Not missing:* `androidx.compose.material:material-icons-core` is an `api` dependency of material3
1.3.2 and is resolved at 1.7.8 in the local Gradle cache, so the `Icons.Filled` /
`Icons.AutoMirrored.Filled` core set compiles today with no build-file change.
*Careless build:* the core set is ~60 icons and is **not** Material Symbols;
`material-icons-extended` is not in the graph and is deprecated upstream, so "Material Symbols on
every affordance" needs a source decision first. And swapping a text glyph for an icon deletes the
only thing TalkBack reads *and* breaks the Robolectric suite, which locates nodes by visible text
(`onNodeWithText`, every file in `gym/src/test/.../ui/`). Every icon needs its `contentDescription`
and every affected test a new locator, in the same change.

**A5 · [BUILD / L] Accessibility: one contentDescription in the whole room.**
The only one is `LoggerScreen.kt:378`, on the rest clock. `LoggerScreen.kt:443` is
`clearAndSetSemantics { }`, which *removes* the progress dots from the tree. There are no
`customActions`, no `Role.`, no `stateDescription`, and no `onClickLabel` outside
`LoggerScreen.kt:376`. The hand-built switch (`SettingsScreen.kt:398-430`) is a `Row` with
`.clickable` and a coloured Box — TalkBack sees a button with no state and no role.
`13-gestures.md` Law 1: on Android a swipe is half-built until its custom action exists, declared by
hand on every row, and every Android board drawing a swipe says so.
*Careless build:* building the swipes first. The missing half is invisible in every screenshot and
every Robolectric test the project runs. This is the largest item on the surface by row count and the
easiest to under-scope.

**A6 · [FIX / M] The routine row carries no overflow control.**
`RoutinesScreen.kt:200-243` is a whole-row `.clickable` (`:213`) ending in a decorative "›"
(`:237-242`); its only other targets are two chips. `DropdownMenu` returns zero hits. Duplicate and
Delete live only in the editor's foot (`RoutineBuilder.kt:131-132`).
`13-gestures.md` prices the routine-row swipe as free on Law 1 because "that row already carries an
overflow control". **It does not.** The overflow has to be built first, or the swipe ships as the only
path to Delete for a TalkBack user, which Law 1 forbids. Anyone planning from the brief alone will
under-size this row by a whole control.

**A7 · [FIX / S] The tap floor is 46 dp, and three shipped controls sit under it.**
`GymSkin.kt:70-73`: `minimum = 46.dp`, `primary = 64.dp`, with the comment "Nothing tappable under
46". 46 is itself 2 dp under Material's minimum, and it is the floor at ~40 call sites. Three
clickable controls are under it: `SessionScreen.kt:384` at `GymTap.minimum - 12.dp` = **34 dp**
(clickable at `:388` — and this is exactly the row `13-gestures.md` puts the wave's only ready swipe
on), `SettingsScreen.kt:135` at 38 dp (`:139`), `AskScreen.kt:459` at 38 dp (`:463`).
*Careless build:* raising `GymTap.minimum` to 48 globally moves ~40 layouts at once and needs a look
at every screen, not a find-and-replace. Raising the 34 dp row also changes the density of the
session read-back, which `12-native-idiom.md` names as one of the room's identity properties.

**A8 · [REBUILD / S] Every ModalBottomSheet passes `dragHandle = null`.**
Four identical call sites: `SessionScreen.kt:226`, `RecordScreen.kt:124`, `RoutineBuilder.kt:145`,
`LoggerScreen.kt:291`. All four use `skipPartiallyExpanded = true`, which already satisfies
`09-coach.md`'s no-fixed-partial-detent rule.
*Careless build:* the handle adds ~28 dp of chrome at the top of every sheet. `KeypadSheet.kt` and
`MovementPicker.kt:295-300` (`fillMaxHeight(0.92f)`) are height-tuned against the current geometry;
the picker is a fixed fraction, so the handle eats content rather than growing the sheet.

**A9 · [BUILD / M] There is no snackbar.**
`Snackbar`/`SnackbarHost` return zero hits. Messaging is one `var note` (`GymRoom.kt:169`) drawn as a
12sp mono `Text` with `maxLines = 2` above the rail (`:618-631`), cleared on every navigation
(`:146-149`, `:151-155`) and every tab change (`:636`).
*Careless build:* reusing the `note` slot for the undo transient silently inherits clear-on-navigate
— and `13-gestures.md`'s whole point is that the window's state stays visible until the window
closes. The room also has no Scaffold to host a `SnackbarHost`, and a hand-placed host is the
invention `12-native-idiom.md` exists to remove. Gated on **A3**.

**A10 · [REBUILD / M] The undo is drawn inline in two places.**
`LoggerScreen.kt:525-533` draws a text "Undo" inside the today set row; `SessionScreen.kt:213` draws
`WithheldRow` (`FixSheet.kt:200-217`) inside the session's vertical scroll.
*Careless build:* the window is 9000 ms (`SetQueue.kt:51`) and the logger's row visibility is
recomputed against a 1-second ticker (`LoggerScreen.kt:157-163`, feeding `:246`). A transient
dismissed by the platform before 9 s, or outliving the window, breaks the one honest property the
change buys. **The duration is driven from `SetQueue.undoWindowMs`, never from a snackbar default.**

**A11 · [FIX / M] Leaving a session settles the withheld delete, and the window holds one.**
`GymRoom.kt:223-227`: a `LaunchedEffect(standingSession)` calls `store.settleWithheld()` the moment
the standing session changes — the comment at `:223` says "A withheld delete belongs to the screen
the gesture was made on, so leaving it ends the window." `settleWithheld`
(`TrainingStore.kt:1155-1163`) sends it. `withhold` (`:1140-1146`) replaces `withheld` and settles the
previous one, with the comment at `:1138-1139` stating "ONE SLOT". The room partly says what it did —
`GymRoom.kt:226` sets a note — but **only on failure**, never on the ordinary settle.
*This is the item most likely to be skipped because nothing about it is broken now.*

**A12 · [BUILD / L] A withheld delete for routines and threads.**
`Withheld` is set-shaped: `data class Withheld(val sessionId: String, val set: TrainingSet, val
untilMs: Long)` (`TrainingStore.kt:1576`), held in one field (`:137`). Routine delete fires
immediately (`dropRoutine`, `:798-818`, called from `GymRoom.kt:415-429`); thread delete fires
immediately (`ThreadsScreen.kt:230-249`, behind only a caption at `:224`).
*The brief's claim that this "generalises cleanly" is not supported by the type.* `dropRoutine`
writes through `localLog.orphanRoutine` for a device-held routine (`:800`) and through
`log.deleteRoutine` otherwise (`:808`); `deleteThread` is server-only. This is a new abstraction over
three different delete verbs, not a widened data class. Sizing it from the brief's sentence will
under-scope it, and getting it wrong means an undo that reports success while the row is already gone
from the server.

**A13 · [REBUILD / L] One LazyColumn in the whole room; every swipe is hand-built on raw pointer
input.** `LazyColumn` appears once — `AssemblySheet.kt:86`. Everything else is
`Modifier.verticalScroll` (28 hits), including the entire log: `LogScreen.kt:106-152` builds every
week and every session row eagerly inside one scrolling Column. The two swipes are hand-rolled
(`AssemblySheet.kt:110-121` with a px threshold at `:92` and an alpha ramp at `:101`;
`RoutineBuilder.kt:354-364` the same shape), and the reorder too
(`detectDragGesturesAfterLongPress`, `AssemblySheet.kt:134`). `SwipeToDismissBox` returns zero hits.
*Careless build:* the assembly sheet's swipe is **conditional** (`if (!row.canDrop) return@pointerInput`,
`:111`, gated on `LiveOrder.droppable`), and a `SwipeToDismissBox` has no "this row is not swipeable"
state short of not wrapping it — the conditional moves to the composition, not a gesture callback.
Converting `verticalScroll` to `LazyColumn` also changes what `rememberSaveable` state survives a
scroll, and `LogScreen`'s rows come from a fold producing nested groups (`LogFold.weeks`,
`LogScreen.kt:57-91`), so it becomes `items` inside `items`.

**A14 · [BUILD / M] Six hand-rolled BasicTextFields with decorationBox.**
`TextField`/`OutlinedTextField` return zero hits. Six sites: `RenameSheet.kt:70`,
`MovementPicker.kt:170` (search) and `:271` (create-movement), `FinishScreen.kt:331`,
`RoutineBuilder.kt:275` (routine name), `AskScreen.kt:471` (composer). One more in platform:
`SignInDoor.kt:188`. `SearchBar` returns zero hits.
*Careless build:* a Material `TextField` is 56 dp with its own label and supporting-text slots and
takes its colours from the ColorScheme — so this cannot land before **P8** without every field coming
up gold-focused. The routine-name field is also the one `15-the-routine.md` wants opened with the
keyboard already up (`RoutineBuilder.kt:227-232` does this with a `FocusRequester` +
`LocalSoftwareKeyboardController`), and that autofocus must survive the swap.

**A15 · [BUILD / S] Switch and SegmentedButton are hand-drawn.**
`ToggleLine` (`SettingsScreen.kt:398-430`) is a 46×27 dp Box with a 21 dp knob, animating nothing,
used three times. The units picker (`:126-155`) and rest-target picker (`:164-190`) are hand-built
segmented rows of Boxes. `Switch` and `SegmentedButton` return zero hits.
*Careless build:* `SingleChoiceSegmentedButtonRow` draws a leading check icon on the selected item by
default, which neither picker shows today, and Material's `Switch` is 52×32 dp against the hand-built
46×27 — both settings cards are laid out around the current sizes. The accessibility gain is the
actual reason to do it: the hand toggle exposes no `Role.Switch` and no on/off state.

**A16 · [REBUILD / L] The proposal review is a pushed screen with a Dismiss/Apply pair.**
`Away.Proposal` (`GymRoom.kt:129`) dispatched at `:552-567`, with its own back row
(`ProposalScreen.kt:180`). `Foot` (`:351-397`) draws an outlined Dismiss at `:368-379` beside a filled
Apply at `:380-390`, with no confirmation on the destructive half. `ProposalCard` (`:401-472`) draws
Review **and** a "Later" button at `:459-471`, where the brief allows one affordance.
*Careless build:* converting the container alone. `09-coach.md` also requires Apply be unreachable
while the diff is clipped, kept rows collapsed to a count, the model's prose under a "Coach wrote:"
kicker, and the mid-workout caveat above the diff and never in the band so the button does not move.
None exists in `ProposalScreen` today (the diff is `ChangeCard`s at `:253-338`).

**A17 · [FIX / S] Android ships the false dismissal copy the brief blames on iOS alone.**
`domain/Proposal.kt:215-219`: "Dismissed $on. No reason asked for, nothing changed, and it stays in
the routine's history in case you want it back." — with a straight apostrophe.
`09-coach.md` names one file on one surface, so a wave planned from the brief will fix iOS and leave
Android saying the opposite. Belongs in `consistency.md` as a brief correction as well as a code fix.

**A18 · [FIX / M] The room is called Ask — on the rail, in a pinned test, and in thirteen strings.**
`GymRoom.kt:110` `Ask("Ask")`, pinned by `GymTabsTests.kt:29`
(`assertEquals(listOf("Routines", "The log", "Ask"), ...)`). `domain/Ask.kt:38-106` holds `title =
"Ask"` (`:39`) plus twelve more strings naming it (`:48-75`). The back-label mapping says "Ask"
(`GymRoom.kt:461`). The store's refusals say it too (`TrainingStore.kt:200,:207`, `SetQueue.kt:410,:413`).
*Careless build:* renaming the client alone. `SetQueue.kt:410` passes `facts.sentence` straight
through, so a room called Coach quotes a server saying Ask (**B13**, **P3**). The tab label budget in
`text-budget.md` is 1–2 words / ~11 characters, which "Coach" clears.

**A19 · [FIX / M] The allowance is a 26-word paragraph, only where nobody has spent anything.**
`Ask.kt:53-55` reads "It answers about ten questions a day, three back to back — the cap that keeps
Ask open to everyone. There is nothing to buy here." It is drawn in exactly two places, both empty
rooms: `AskScreen.kt:282-286` and `:221-225`. The composer (`:469-513`) carries nothing above it.
There is **no cap-reached copy anywhere** in `apps/android`. `AskTests.kt:22` pins `Ask.dailyCap` by
identity.
*Careless build:* the paragraph is a section-footer-sized string doing a job the brief assigns to a
one-line promise plus a separate moment. Cutting it without drawing both halves is the failure the
brief names: a wave that removes the paragraph and draws neither has not trimmed the cap, it has
deleted it. The thread-ceiling copy does not exist here at all — it has to be written, and it says
four.

**A20 · [FIX / S] The signed-out stance is the long variant the brief rejects; four strings ship a
straight apostrophe.** `AskScreen.kt:208` draws "Ask reads your account's log, so it needs you signed
in before it has anything to read." `Ask.kt:75` is "Ask isn't part of this Windmill…" with a straight
`'`; so are `:61`, `:71-72`, `:77`. The rest of the module is mostly typographic
(`GymRoom.kt:339`, `RoutinesScreen.kt:475`).
*Careless build:* the ledger blesses Android's **wording** for the deployment-absent stance and
rejects Android's **wording** for the signed-out stance (`consistency.md:257-263`), and both live in
adjacent code. Change the wrong one and the line the ledger says wins is lost. The apostrophe fix
must not be a blind sed — `"What's stalled?"` at `Ask.kt:77` is an opener asserted in
`AskTests.kt:29`.

**A21 · [REBUILD / S] The raw MCP tool trace is printed under every answer.**
`AskScreen.kt:327-341` draws every `AskStep.line` in a bordered block; `Ask.kt:9-11` is `if (failed)
"$tool · no answer" else tool` — **the raw tool name, with no lookup at all.** The read receipt is a
separate line at `:345`.
*Careless build:* on Android there is no lookup to fall back from, so the phrase table is new code,
not a repair. Collapsing the list behind the receipt without writing the phrases ships a disclosure
whose expanded state is still developer output — the same defect one tap deeper.

**A22 · [BLOCKED / L] Notes: nothing on Android, and nothing to read from.**
`Notes`/`notes` return zero hits across `gym` and `platform` main sources. No door from settings
(`SettingsScreen.kt:88-97`), none from the Ask room. Gated on **B1**. When it starts, the two things
most likely to be lost are the ones `10-notes.md` calls owed rather than moved: the byte counter and
the "10 of 10 notes" row are drawn on neither phone today, and the honesty line heads the screen,
never foots it.

**A23 · [BLOCKED / L] Bodyweight: nothing on Android.**
`bodyweight` appears only as an equipment loading string (`domain/Training.kt:43,:58`). The log head
is a title plus one derived line inside the scroll (`LogScreen.kt:117-127`) and the Log tab has
nothing pinned in the reach band (`:106-152` is one `verticalScroll` Column). Gated on **B6** and
**P2** — on Android the claim-replay slot means `ClaimReplay.kt` (an ordered walk: settings,
movements, routines, sessions) and a per-seat store file beside SetQueue/LocalLog/LocalPreferences
(`GymRoom.kt:171-179`). Build the screen before that ordering is decided and the object vanishes on
sign-in. Note also `SettingsScreen.kt:152` currently says out loud: "This phone still draws every
weight in kilograms — nothing on this screen converts one."

**A24 · [REBUILD / XL] Type: every size is a literal; `MaterialTheme.typography` is never set.**
`WindmillFont.display/body/mono(size: Int)` builds a TextStyle from a raw Int
(`platform/design/Tokens.kt:73-91`), called with literals at ~200 sites. `GymType.weight` is a fixed
104.sp with 92.sp line height (`GymSkin.kt:44-51`). `WindmillMaterial` passes only a colorScheme —
no typography argument (`WindmillMaterial.kt:11-13`) — so every future Material component takes stock
Material typography, not gym's. `fontFeatureSettings = "tnum"` is set on `GymType.weight` (`:50`) and
`GymType.numeral` (`:63`) and on **none** of the `WindmillFont` roles. Rows are pinned by
`heightIn(min = …dp)` at ~40 sites; columns by `widthIn(min = 42.dp)` (`FixSheet.kt:126`) and
`size(width = 32.dp, …)` (`AssemblySheet.kt:252`). One partial mitigation exists:
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
logging" is a quiet text row beneath (`:122-135`). The empty state does the same (`:167-196`).
Neither is pinned — both are the last items in a `verticalScroll` Column.
*Careless build:* swapping the weights is trivial; making the primary **pinned in the reach band** is
not, because the button is a scroll item, and "reachable without changing grip" is false for a scroll
item at any list length. That means a Scaffold bottomBar or a pinned Box — gated on **A3**. Note the
empty state may want the opposite answer and the brief does not rule on it.

**A26 · [FIX / S] The connect pitch on the routines list — and what removing it leaves.**
`RoutinesScreen.kt:136` is the only call site of `ConnectCard.kt:29`. Android's other door is
`ConnectedLogRow` (`SettingsScreen.kt:216-245`). **There is no connect page on Android**, and the
proposal screen has never carried a pitch. `15-the-routine.md` enumerates four homes and keeps two —
but Android has two, so cutting the routines-list one leaves the settings row as the only door here.
That may be right; it is a decision the brief did not make for Android and should be recorded rather
than taken silently, especially since `09-coach.md` leans on the connect door as "the one path that
is not rationed" in a cap-reached state Android does not draw.

**A27 · [REBUILD / S] The rest clock counts down and flips.**
`domain/RestTimer.kt:16-32`: `left = targetSeconds - elapsed` (`:24`), `overrun = left < 0` (`:25`),
labels "resting"/"rest done" (`:26-27`), `"+" + clock(-left)` past target (`:28`), `fraction`
elapsed/target (`:30`). Drawn at `LoggerScreen.kt:392-412` and `:404-425`. Ledger `2b`.
*Careless build:* `Rest.Line` is pure and unit-tested, so the change is small — the risk is what sits
next to it. The chime is scheduled off the same target by a separate `LaunchedEffect`
(`LoggerScreen.kt:170-178`), `fraction` drives the bar, and a `contentDescription` is built from
`rest.label` and `rest.time` (`:378`) and has to follow.

**A28 · [FIX / S] Android has offered the set-kind control since it shipped.**
`var kind by rememberSaveable { mutableStateOf(SetKind.Working) }` (`LoggerScreen.kt:99`);
`KindPill(kind, onOpen = { sheet = LoggerSheet.Kind })` between the value block and the ladder
(`:264`); `KindSheet` at `:304-307`; disarmed on the tap with the comment "a warmup is a single set,
not a mode" (`:275-281`). The fix sheet offers all four (`FixSheet.kt:132-155`).
**Half of this is a ledger correction, not build work** — `16-the-workout.md`'s "no surface has ever
offered" is false. The other half is real: the brief rules that choosing the kind "must not cost a
trip", and a pill opening a bottom sheet is exactly that cost.

### 4.4 · Web — `web/src/products/gym/`

Surface prerequisites: **P4**, **P5**, **P6**, **P7**, **P10**.

**W1 · [REBUILD / S] The tab bar becomes Routines · The log · Coach.**
`GymApp.jsx:24` declares `const TAB_SCREENS = ['today', 'log', 'routines']` (verified); `:132-140`
draws three anchors; `:111` gates the rail on `TAB_SCREENS.includes(screen)`. `gym.css:1060-1073`
fixes the grid at `repeat(3, 1fr)` with a comment saying the count is stated in two places that move
together. Ledger `0t` (`consistency.md:245-252`).
*Careless build:* the count is asserted in **three** places — `GymApp.jsx:24`, the CSS grid, and
`screens.test.js:41-46`, which reads the grid out of the stylesheet and compares it to the anchor
count. And the label "Coach" must land with the room's rename (**W7**) or the tab points at a room
still calling itself Ask.

**W2 · [FIX / S] `#/gym` still resolves to Today.** `log.js:93-107` — `screenOf` matches routines at
`:99` and falls through to `return 'today'` at `:107`. `routes.js:21-28` returns `#/gym` from both
`home()` and `landingAfterSignIn()`, pinned by `routes.test.js:51-52`. Gated on **P5**.

**W3 · [REBUILD / M] The live mirror moves from Today to the head of Routines home.**
`Today.jsx:71-113` (`TrainingNow`) draws it on a 500 ms beat and is mounted only from `:23-30`.
`Routines.jsx:23-85` has no mirror and no knowledge of `log.session` beyond passing it to
`ConnectInvitation` at `:82`.
*Careless build:* `RoutinesList` reads through `useGymRead(() => gymApi.routines())`
(`Routines.jsx:24`) while the mirror lives on the polled `useTrainingLog` (`POLL_MS = 5000`,
`useTrainingLog.js:12`); mounting one inside the other gives the routines list a 500 ms re-render beat
it does not need. **The charter is the real hazard.** Ledger `0t` keeps it whole: the mirror never
offers a Finish, says "Not training now." in words rather than as a greyed control, and never says
"resting". Web today never says "resting" (zero hits across `src/products/gym/`) and prints an honest
count-up (`Today.jsx:102`). A rewrite that reaches for a countdown or a Finish breaks the one rule the
ruling names by name.

**W4 · [FIX / S] Six back-links point at a screen that will not exist.**
`Record.jsx:9` (`const BACK = '#/gym'`, used at `:39,:47,:60`), `Finish.jsx:28`,
`ask/AskRoom.jsx:66-68`, `connect/ConnectLog.jsx:42-44`. Nothing fails loudly — the link resolves, it
just lands somewhere that now means something else.

**W5 · [REBUILD / M] Coach becomes a tab root; the door card and the pushed-screen chrome go.**
`ask/AskRoom.jsx:16-25` (`AskDoor`) is mounted from `Today.jsx:54`. `AskRoom.jsx:27-92` opens with a
`.gym-back` to Today (`:66-68`) and carries its own header with a Threads door (`:69-75`).
`log.js:44`, `GymApp.jsx:106`. Ledger `0u`.
*Careless build:* a tab root must not keep a back link. The Threads list and thread detail stay
pushed screens under it (`log.js:46-55`), so the room becomes a two-level stack whose root has no
back and whose children do — get that wrong and the lifter can walk out of the tab bar.

**W6 · [REBUILD / S] The pending-proposal card loses its only home.**
`Proposals.jsx:15-27` (`PendingProposals`) is mounted from exactly one place, `Today.jsx:39`. The card
(`:29-44`) already carries only Review, which is correct.
*Careless build:* there are **two** proposal-card renderers on web — `Proposals.jsx:29-44`
(routine-derived) and `ask/AskRoom.jsx:198-226` (`AskProposal`, id-derived) — drawing different
kickers, metadata and diff detail. Deleting the wrong one loses the standing-pending surface: a
proposal minted by a connected agent over MCP arrives with no thread on web to appear in. **Decide
where a proposal with no conversation lives before removing `PendingProposals`.**

**W7 · [REBUILD / L] Rename Ask → Coach, and purge "coach" from the share vocabulary in the same
change.** The room is Ask everywhere: `ask/ask.js:49-51`, `:61-62`, `:83`, `:85`, `:87`, `:99`;
`proposals.js:36` maps `source.door === 'ask'` to the label `'Ask'`; `Proposals.jsx:181` draws "Ask
about your training ›"; the directory is `src/products/gym/ask/`; `gym.css` carries 41 rules starting
`.gym-ask`. Separately, "coach" is already taken by the human-coach share: `share/share.js:11`
`SHARE_OFFER = 'Share with a coach'`, `share/CoachShare.jsx:5`, and the word reaches the search index
from `marketing/landingHead.js:7,:26,:35` and `marketing/GymLanding.jsx:368`.
`01-context.md` is explicit: the word names exactly one thing, the room; the link handed to a human
coach is "Share this workout" and carries the word nowhere.
*Careless build:* doing half of it ships a room called Coach next to a button that says "Share with a
coach". Six gym test files pin the word, so a partial rename shows up as red tests rather than as the
copy defect it is. `marketing/landingHead.js` feeds structured data and the meta description — that
half is an SEO change and should be verified in the built head.
*Worth knowing:* **the server's Ask strings do not reach this surface.** `gymApi.js:173-178` maps
every failure to a locally-authored sentence and `ask.js:90-106` decides only off `status`/`code`. One
caveat: `settings/preferences.js:44` does return `error.detail` verbatim for a refused preference
write, so at least one path on this surface prints server text.

**W8 · [BUILD / S] The allowance line above the composer.**
`ask/AskRoom.jsx:69-75` puts `ASK_TERMS` — "reads your log · proposes only" (`ask.js:50`) — in the
head. The daily allowance is stated nowhere until it is spent: `ask.js:98-100` returns it only on a
429. The composer (`:142-166`) has nothing above it.
*Careless build:* reusing `ask.js:99` verbatim above the composer restates the rule where the brief
asks for the promise, and makes the 429 state say the same words twice. Both strings are pinned in
`09-coach.md`; write the pinned ones, not a paraphrase.

**W9 · [FIX / S] The raw tool trace prints under every answer, and its fallback prints the tool name.**
`ask/AskRoom.jsx:193` draws `stepsLine(turn.steps)` under every answer, always expanded;
`ask/ask.js:18` is `(TOOL_PHRASE[step.tool] ?? step.tool)`. The read receipt is beside it at `:192`
(`readLine`, `ask.js:29-35`). `TOOL_PHRASE` (`ask.js:1-10`) covers eight tools.
*Careless build:* collapsing the receipt along with the steps. `09-coach.md` is explicit that the
honesty claim rests on the receipt and never on the collapsed list — "a collapsed control is not a
check on anything."

**W10 · [REBUILD / L] The review moves from a pushed screen to a dialog, with one Apply in the band.**
`ProposalDiff` (`Proposals.jsx:59-186`) is a pushed screen at `#/gym/proposals/<id>` (`log.js:61-68`,
`GymApp.jsx:102`), opening with a `.gym-back` (`:127-129`). Its decide block (`:159-179`) draws a
**pair** of same-weight buttons — Dismiss `:162-168`, Apply `:169-175` — and Dismiss fires
immediately with no confirmation. Kept rows are drawn at full weight, one per line
(`proposals.js:180-183`, `Proposals.jsx:215-222`). There is no "Coach wrote:" attribution: the
model's summary is a bare paragraph at `:145`.
*Careless build:* the pair is the specific failure the brief names. Collapsing kept rows fights the
module header's own reasoning at `proposals.js:1-6` ("The change rows ARE the document as well as the
diff … the order is part of what applies") — the collapse must preserve position, or expanding shows
the document out of order. And the proposal keeps a URL today: making it a dialog either strands
`#/gym/proposals/<id>` (which a connected agent's link may point at) or requires a routable dialog.
Gated on **P6**.

**W11 · [BLOCKED / M] The design-system Dialog pins its footer.**
`design-system/feedback/Dialog.jsx:109` gives the body `flex: '1 1 auto', minHeight: 0, overflowY:
'auto'` and `:112` renders the footer outside it, pinned. Gym does not use `Dialog` at all today.
`09-coach.md` forbids exactly this for the review sheet: Apply is never reachable while the diff is
clipped. **This is the shape the brief rules out, offered by the component the brief tells you to
reach for.** Nobody has tried it at 390 px. Blocked on a design-system decision: either `Dialog`
gains a scroll-gated footer, or gym authors a review dialog in the design system with one. See **P6**.

**W12 · [FIX / S] The web promises a dismissed proposal can be taken back.**
`proposals.js:103-105` — verified: "Dismissed {when}. No reason asked for, nothing changed, and it
stays in the routine's history in case you want it back." — rendered at `Proposals.jsx:157`.
`routes.cpp:197,203` carry apply and dismiss and nothing that reopens one.
**Ledger `1u` gets this wrong** and says the web "states the opposite and is right", citing
`proposals.js:13` — which is a code comment, not a lifter-facing string. Anyone working from the
ledger will believe the web is already correct and skip it. See §6.

**W13 · [BUILD / M] The receipt line back in the thread, stated as ephemeral.**
Applying settles in place on the pushed screen (`Proposals.jsx:104-111`, `:157`). Nothing is written
back into the conversation, and the thread's stored shape (`gymApi.thread`, `gymApi.js:344`) carries
no settled-at.
*Careless build:* composing the receipt from `proposal.summary` rather than from the apply reply. A
model that mis-states what it just did is the failure the beat exists to prevent. And the count
inherits an undefined unit — ledger `1x` (`consistency.md:669-684`) rules a change is *a row of the
document*, and records that the reading "remains owed" in the domain, so a receipt built today counts
something no surface has pinned.

**W14 · [FIX / S] Coach's two stances ship build-authored copy the wave blessed differently.**
Deployment-absent: `ask/ask.js:83` `ASK_ABSENT_NOTE = 'Ask isn't switched on here.'`, returned at
`:92`. Signed-out: `:91` returns 'Sign in to open your training log.' on 401; the room is reachable
only signed-in (`GymApp.jsx:49-51`, ghosts get `SignInPitch` at `:77-85`). The blessed strings are in
`09-coach.md` and `consistency.md:253-263`.
*Note:* `09-coach.md`'s own Open says the brief does not bless a copy **owner** for these two. Ship
the pinned strings and flag them rather than inventing a third. The second sentence of the
deployment-absent stance is the load-bearing half — dropping it leaves a bare refusal with no way
out, which `text-budget.md` forbids.

**W15 · [FIX / S] The thread renders every proposal an answer minted.**
`ask/AskRoom.jsx:191` maps `turn.proposals`; `ask/ask.js:37-47` passes `reply.proposals ?? []`
through with no cardinality check.
*Careless build:* enforcement belongs on the server (**B9**) — the refusal is worded for the model. If
the client silently drops extras while the server still allows two, the lifter sees one card and the
second proposal is invisible but live, which is worse than drawing both. Either the server refusal
lands first, or the client draws what came back.

**W16 · [REBUILD / XL] The room uses no design-system component inside `.gym-root`.**
Three files import from the design system and **none is a room screen**: `RoutinesGhost.jsx:2`
(shell loading fallback), `settings/GymSettingsSection.jsx:2` (`Switch`, rendered inside the shell
settings page), `marketing/GymLanding.jsx:2` (marketing landing). Every control a lifter touches in
the room is hand-rolled in `gym.css`, which carries 531 `.gym-` selectors — `.gym-toast`
(`:582-631`), `.gym-sheet` (`:633-700`), `.gym-tabs`/`.gym-tab` (`:1060-1086`), `.gym-back`
(`:356-367`), plus buttons, inputs, cards and tags.
*The brief's "four times out of seventeen" overstates what the room does — inside `.gym-root` the
count is zero, so this is a bigger job than the brief's number suggests.* Gated on **P6** and **P7**.

**W17 · [REBUILD / S] Twenty hand-written `.gym-back` links across nine files.**
`Log.jsx:215,:223,:240`; `Finish.jsx:28,:39`; `Proposals.jsx:69,:77,:127`; `Record.jsx:39,:47,:60`;
`Routines.jsx:109,:117,:167,:267`; `Backfill.jsx:76`; `ask/AskRoom.jsx:66`;
`ask/Threads.jsx:80,:199`; `connect/ConnectLog.jsx:42`. Most repeat the same inline `<ArrowLeft
size={16} strokeWidth={1.9} aria-hidden="true" />`. Two files already factored theirs
(`Threads.jsx:78-84,:196-202`).
*Careless build:* twelve of the twenty sit inside `absent`/`failed` branches that render only when a
read fails — a happy-path check will not exercise them, and a factored component with the wrong
empty-state markup looks fine until the log is down. Six also change destination (**W4**), so doing
the two separately means touching each file twice.

**W18 · [REBUILD / S] The naming interstitial dies.**
`Routines.jsx:102` seeds `naming` from `fresh`, and `:126-134` returns `NameTheRoutine` whenever the
id is `new`. That screen (`:263-300`) carries a back link, a title, a subtitle, an autofocused field
with an always-on counter (`:280`) and three suggestion chips from `NAME_SUGGESTIONS`
(`routines.js:14`). The editor already has an inline name field at `:168-175`.
*Careless build:* taking the Save gate with the screen. `Routines.jsx:137` computes `missing` from
the trimmed name and disables Save at `:176-182`, enforcing `Routine.cpp:40` ("a routine needs a
name"). `:184` prints only one refusal at a time, which is what the brief asks for; keep it. The
editor's inline field has no autofocus today and needs it.

**W19 · [REBUILD / M] The target sheet becomes three typed fields, and the third overlay dies.**
`Routines.jsx:334-417` draws all five affordances: tap-to-type into a custom keypad (`:369-371`,
`:406-414`), "use last time" (`:372-376`), the ± ladder (`:378-393`), "take it to max" (`:361-365`)
and "Leave it open" (`:400-403`). The comment at `:406` explains the third layer: "Keep the keypad
outside the sheet; nested, a tap on it closes the sheet." `FixSheet.jsx:73` carries the identical
comment. The null-cascade helpers exist: `routines.js:140-147`, `:155-160`.
*Careless build:* `logger/Keypad.jsx` is mounted from **both** `Routines.jsx:408` (which the brief
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
*Careless build:* ledger `2i` (`consistency.md:767-776`) is precise — 1–99 is the **live logger's**
band and 1–100 is the **routine target's** (`Routine.cpp:23`), "but neither file says which band it
is enforcing, which is how they drifted". `entry.js` serves both the target sheet and the fix sheet,
so pinning one string in one module enforces the wrong bound on one of the two screens. **Split the
bands explicitly.** And ledger `2h` (`:777-783`) notes *That is not a number yet.* is the one pinned
refusal naming no way out and that the fix belongs in the brief — do not silently improve it here.

**W21 · [FIX / M] The picker caps every query at seven rows and has no "six most-used" section.**
`logger/movements.js:3` `PICKER_MATCHES = 7`, applied unconditionally at `:39`, including for an
empty query (`matchesQuery` returns true for every name when the term is `''`, `:26,:30-32`). The
placeholder is already correct: `MovementPicker.jsx:27` renders `Search ${catalog.length} movements`
— **do not report it as missing.**
*Careless build:* lifting the cap everywhere makes a typed query dump the catalogue; ledger `2j` says
it is lifted for the empty query and kept for a typed one. And "six most-used" needs a source of
truth: nothing on the web wire ranks movements by use — `gymApi.lastSets()` (`:188`) gives last-set
metadata, not a frequency order.

**W22 · [FIX / S] The open line is a different sentence and a different shape.**
`routines.js:163-170` (`openTargetsLine`) builds "{Movement} has no target — it will ask at the
rack.", drawn once per editor at `Routines.jsx:201`; the sheet's button says "Leave it open / decide
at the rack" (`:400-403`). The pinned string is one sentence on every surface: *You decide the
numbers at the rack.* Web's version also uses the third person about the app where the pinned string
uses the second person about the lifter.
*Careless build:* replacing the shape loses the roll-up's actual information — which lines are open.
Decide whether the per-row placeholder (`sets` cleared → *open*) carries that before deleting the
line.

**W23 · [FIX / S] The name counter is drawn from the first character, and not at all on the editor.**
`log.js:373-375` (`nameCountLabel`) produces the pinned `53/60` form against `NAME_MAX = 60`
(`:371`), rendered unconditionally at `Routines.jsx:280` (the dying interstitial),
`Record.jsx:185-186` and `logger/MovementPicker.jsx:96-97`. The editor's own inline field
(`Routines.jsx:168-175`) draws no counter at all. `15-the-routine.md` wants it only in the last fifth
— from 48 characters — and ties that threshold to the note editor's byte threshold.
*Careless build:* repeating the threshold at three call sites. It belongs beside `nameCountLabel` in
`log.js`, named, so the note editor's twin can read it.

**W24 · [BUILD / M] Delete routine, and Duplicate off the row into an overflow.**
**There is no way to delete a routine on the web at all:** `gymApi.deleteRoutine` exists
(`gymApi.js:290-292`) and is called from nowhere in `src/`. Duplicate exists twice — a `⧉` button on
every row (`Routines.jsx:70-77`, firing `duplicate()` at `:27-37`, which creates a routine
immediately) and a footer button three screens deep (`:209-227`).
*Careless build:* adding Delete without the withheld-delete pattern is what `13-gestures.md`'s gate
forbids. Web has a mechanism to copy — `Log.jsx:153-189` withholds a set delete for `UNDO_MS` with a
toast-borne Undo — but note two known limits before reusing it: `Log.jsx:177-182` sends every
still-withheld delete on unmount (leaving commits), and `withheld.current` is a list while the toast
holds one action, so a second delete's Undo replaces the first's on screen. Gated on **P4**.

**W25 · [BUILD / S] The editor row's `×` removes a line with no way back.**
`Routines.jsx:460-467` calls `onRemove(index)` → `withEntryRemoved` (`routines.js:122-124`), dropping
the entry from the unsaved draft. The only recovery is the back link at `:167`, which discards every
other edit made since the editor opened. `15-the-routine.md`: "A row's `×` is as destructive as a
swipe, and takes the same undo. **The gate is the act, not the gesture.**"
*Careless build:* drawing a duration on it. The mechanism exists (`log.say(text, action)`,
`useTrainingLog.js:66`; the toast renders an action at `GymApp.jsx:112-126`) but the toast retires
after `TOAST_MS` = 5000, which is not the 9000 every document in this project promises. Gated on
**P4**.

**W26 · [FIX / S] Discarding a session on web is one tap, with no confirmation and no consequence
stated.** `Finish.jsx:111-140` (`ShortSession`): one line — "Keep it in the log, or drop it?" — then
a "Keep it" link and a "Discard session" button (`:118-136`) calling `gymApi.discardSession(id)` on
first press. Verified: a grep for "There is no undoing" across `web/src/` returns nothing; both
phones ship the sentence (`FinishScreen.swift:333`, `FinishScreen.kt:406`).
`backend/products/gym/routes.cpp:136` is the only discard path and there is no restore.
**This is the highest-consequence single defect on this surface.** Both briefs say Discard "keeps its
confirmation" — on web neither the confirmation nor the copy exists, and a wave that reads that
sentence as no-work-required leaves a one-tap unrecoverable delete of a whole workout on the surface
with a mouse. (See §6: no surface actually has the confirmation.)

**W27 · [FIX / S] A set row prints an RPE and a note the lifter can touch on no surface.**
`Log.jsx:281` renders `set.rpe` and `:286` renders `set.note` (verified). `FixSheet.jsx:45-63` edits
weight, reps and kind only — `fix.js:12-14` and `:27-33` carry exactly those three fields. Ledger
`1s`: give it a control or delete the render.
*Careless build:* the two halves have opposite trust. A **note** (`10-notes.md`) is directive text
Coach follows; a **set note** is a record the prompt treats as data (`AnthropicAsk.cpp:49-53`). Adding
the set-note field with any hint that Coach reads it as instruction crosses the boundary `09-coach.md`
exists to draw. And `fixOf` sends only changed fields — adding two nullable ones needs care so that
clearing a note is distinguishable from not touching it.

**W28 · [REBUILD / S] The connect pitch loses two of its four homes.**
All four exist on web: `Routines.jsx:82`, `Proposals.jsx:183`, `settings/GymSettingsSection.jsx:119`
(→ `ConnectedLog` at `:128-153`), and `connect/ConnectLog.jsx:38`. The card self-suppresses when
anything is connected (`:22-35`). The settings row and the page stay.
*Careless build:* the routines list is about to become the room's home (**W3**), so remove the
invitation and add the mirror in one pass or the head gets rebuilt twice. `ConnectInvitation` is also
the only consumer of `INVITATION_KICKER`/`INVITATION_LINE`/`INVITATION_VERB`/`INVITATION_FREE`
(`connect/connect.js:33-38`); if both call sites go, those four exports go with them.

**W29 · [FIX / S] Gym's settings section is registered `data`, so it sits beside Close account.**
Verified: `routes.js:49-51` registers `settingsSections: { data: [GymSettingsSection] }`.
`SettingsPage.jsx:20` collects `data` and `:43` renders them immediately above `<CloseAccountSection
/>` at `:45`; the comment at `:17-18` says `main` "sits in the product zone after the account
identity; `data` renders last, beside the account's own close." `routes.test.js:105-108` asserts
`settingsSections.main === undefined` with the message "gym contributes nothing to the product zone".
`10-notes.md` calls this "one word, and it is the difference between sitting with the product's own
settings and sitting at the bottom of the account page beside the button that closes your account."
*Careless build:* the section is not small — rest timer, units, haptics, Export, Connected log — so
moving it changes the order of the whole settings page for every product. Check journal's and
roadmap's registrations before assuming the zones are empty.

**W30 · [BUILD / S] The settings dials gain one line.**
`settings/GymSettingsSection.jsx:67-122` draws Units, Rest timer, Set confirmation, Export and
Connected log and says nothing about what Coach reads. `10-notes.md` moves the line here: "Coach
reads your notes, not your settings."
*Careless build:* placing it under the haptic switches at `:97-107`, where it reads as a caption about
those two toggles. The brief's own rule applies literally to this file: it names what it excludes
rather than pointing, because a caption that changes meaning with its position is a bug. Gated on
**B1** — shipped alone it points at nothing.

**W31 · [BLOCKED / L] The Notes screen.** Grep for `notes` across `web/src/products/gym/` returns
only unrelated hits (`gymApi.js:57` a byte comment, `landingHead.js:24` a marketing key).
`gymApi.js:183-354` has no notes call. Gated on **B1**.
*Careless build:* dropping notes into the preferences document to ship faster.
`settings/preferences.js:1` states in its first line that the write is "the WHOLE document, not a
patch, so two screens open at once is last-write-wins" — the hostile container the brief names.

**W32 · [BLOCKED / L] Bodyweight — the reading, the chip, and a chart that is a new primitive.**
`gymApi.js:183-354` has no bodyweight call. Gym's one chart normalises to the series maximum:
`record.js:66-80`, `pct: round2((point.e1rm / top) * 100)`. Gated on **B6** and **P2**.
*Careless build:* reaching for the bar renderer gives near-identical full-height blocks for a series
between 82.0 and 84.5, which is why the brief calls it a new primitive.
`12-native-idiom.md` says a new primitive is authored in the design system, not in the gym folder.

**W33 · [BLOCKED / S] The Log's head carries the bodyweight reading — the other half of ledger `0t`.**
`Log.jsx:40-54` draws title, `loadedLine(...)` and "Add a past workout". `consistency.md:249-251`
writes the bodyweight line into the IA ruling as if it were free. It is not: it cannot ship until the
wire exists. **The IA convergence must be shippable without it, or the whole `0t` change waits on a
greenfield backend feature. Say which when planning the wave.**

**W34 · [REBUILD / L] Daylight: the room pins dark in two places.**
`routes.js:64` declares `scope: { theme: 'dark', brand: 'gym' }` and `Shell.jsx:76` reads
`room.scope.theme ?? appearance`. Outside `/app` the shell never mounts (`shell/App.jsx:200-208`) and
`GymApp.jsx:34,:41` hardcode `data-theme="dark"` on `.gym-root`, the attribute `gym.css` scopes its
tokens to (`:5`, `:42`). The light ground already exists (`palettes.css:208-227`, `:275-286`) and
`gym.css:42-77` declares a light block of mostly byte-identical aliases.
*Careless build:* dropping only the `routes.js` pin changes nothing a lifter sees — `.gym-root`'s own
`data-theme="dark"` still wins, and outside `/app` it is the only stamp there is, so `GymApp` has to
resolve appearance itself via `useAppearance`. The bigger risk is shipping the flag as the feature:
the light block has never been rendered, one of its tokens is excused in a comment for failing its own
gate (`gym.css:66-67`), and flipping the pin makes that comment's excuse false in the same commit.

**W35 · [FIX / S] Two Daylight tokens are wrong before the skin renders.**
`gym.css:63` declares `--set-done-glow: rgba(125, 140, 67, 0.4)` in the `[data-theme="light"]` block;
`:66-67` carries `--pr-ink: var(--accent-gold-600)` with the comment "It measures 3.4:1 at 10.5px on
the tinted record card, under the 4.5 gate; nothing renders this skin, gym pinning dark."
`12-native-idiom.md`: a token whose mechanism does not exist in a mode is **deleted** from that mode,
not dimmed (ledger `1w`, and nothing depends on it today, "which is exactly when to remove it").
*Careless build:* `.gym-toast` (`gym.css:576-580`) reads `--set-done-glow` in a `box-shadow`, so
deleting the token must be paired with removing that shadow in light rather than letting it resolve
to nothing silently.

**W36 · [FIX / S] Three hardcoded black shadows tuned for basalt.**
`gym.css:596` (toast), `:652` (sheet), `:1490` (a dragging routine entry) — the only three raw colour
values in the stylesheet below the token blocks. Ledger `1t`. On pietra (`--surface-canvas: #EBE7E3`,
`palettes.css:216`) a 55%-black drop reads as soot. Adopting the design system's `Toast` and `Dialog`
inherits the right shadow for the first two; `:1490` needs a hand.

**W37 · [BLOCKED / XL] Type: 253 hardcoded pixel sizes, and the shared scale is pixels too.**
`gym.css` contains 253 `font-size: Npx` declarations and **zero** uses of `var(--text-*)`. The shared
scale is itself fixed: `styles/tokens/typography.css:3-12` defines `--text-xs: 12px` through
`--text-6xl: 60px`. Gym extends it with `--weight-size: 104px` and `--reps-size: 54px`
(`gym.css:35-38`). There are 37 `tabular-nums` declarations and no font-size media queries.
**Blocked, not merely large:** the web's equivalent of Dynamic Type is honouring the browser's root
font size, and the scale gym would adopt is pixel-valued — so adopting it changes nothing for a
reader who has set a larger font. Making the shared scale relative is a change to `typography.css`
that reaches roadmap and journal as well, and nobody has scoped it. Until then, converting 253
declarations to a px-valued token scale is churn that buys the accessibility gap nothing.

**W38 · [BLOCKED / S] Gym's screen titles are in the body face.**
`gym.css:100-107` `.gym-title` sets no `font-family`, inheriting `var(--font-body)` (Nunito) from
`.gym-root` (`:89`); the display face is reached three times in the stylesheet, all for instruments.
Ledger `1y` records it as "a designer call, one way or the other" and does not decide it. **Deciding
it inside a build wave pins one answer for every gym title on three surfaces by accident.** Get the
ruling; the code change is one line.

**W39 · [BLOCKED / M] Whether the web's session review becomes a dialog.**
`FinishScreen` (`Finish.jsx:12-109`) is a pushed screen at `#/gym/finish/<id>` (`log.js:33-40`,
`GymApp.jsx:104`), reached only from "Session review ›" at `Log.jsx:250`; it owns the
keep-as-a-routine offer (`:142-198`) and the discard door (`:111-140`). `16-the-workout.md`'s ruling
is written for the surface that *finishes* a session, and `01-context.md` says the web never does —
here it is a review of a past workout. **The brief does not assign it to web.** Building it as a
dialog anyway puts the discard door and the keep-as-a-routine offer inside a modal, and neither has a
settled treatment there.

**W40 · [FIX / M] The tests pin the current IA, screen by screen, in string literals.**
`screens.test.js:41-46` reads the tab anchors out of `GymApp.jsx`, reads the grid column count out of
`gym.css`, asserts both are 3, and asserts the literal `const TAB_SCREENS = ['today', 'log',
'routines'];`. `:83` and `:164` assert the tuple again; `:87-88` pins the Ask door on Today;
`:502-503` pins `<PendingProposals />` on Today; `:392-402` pins Today's first-run copy; `:580`
repeats the literal. `routes.test.js:105-108` asserts the settings section is `data`. Ten `Today`
references in `screens.test.js`, nineteen `Ask` ones, six gym test files referencing Ask.
*Careless build:* these assert source text, not behaviour, so they fail loudly and can be "fixed" by
editing the literal without checking the screen still works. **Two of them encode rules worth
keeping:** `screens.test.js:404-421` asserts that "Start a session" and "Just start logging" appear
in no web file — that is the web's charter (it starts nothing) defended in a test, and it must survive
the convergence even though `12-native-idiom.md` names "Just start logging" as the Routines reach-band
primary on the phones. **Do not import the phone's primary into the web's routines home.**

---

## 5 · Do not build these

**`propose_routine_create`.** `09-coach.md:120,128-132`: three verbs, and Coach never creates.
Creating belongs to the lifter. A proposal is anchored to a routine that already exists and to a
revision it is atomic against; a create has neither. The domain already forbids it at compile time —
`classify(Subject, Standing)` (`domain/Proposal.h:26-30`) returns `Mutation::record` whenever
`standing == Standing::fresh`, and `createRoutine` asserts exactly that
(`GymTools.cpp:254`), while the two propose tools assert the opposite pairing (`:336`, `:388`).
Structurally a proposal cannot be built without a routine (`Proposal.cpp:55`,
`ProgramService.cpp:51-53`).
**But nothing pins the name's absence.** `GymToolsTest.cpp:178-194` pins `apply_proposal`,
`apply_routine_change`, `accept_proposal`, `dismiss_proposal` and `settle_proposal`;
`propose_routine_create` appears nowhere in the repository, which is a fact and not a guard. **[BUILD
/ S] Add the pin before anyone adds tools to the catalog** — because the `propose_` prefix is itself
a grant (`GymToolCatalog.h:20-23`, verified: "The prefix is the grant: any `propose_*` tool, at any
access level, is reachable by Ask"), so adding a tool by that name hands it to Coach automatically
with no review. The static_assert only fires if the new path calls `classify` with the right pair; it
does not stop a tool that skips it.

**A bodyweight write tool of any kind.** `11-bodyweight.md:110-114`: Coach may never write a weigh-in,
for the same reason no tool edits a logged set. The ban is structural, not a prompt sentence
(`routes.cpp:91-98`, `:175-183`, `GymToolsTest.cpp:178-194`). A write-level tool is reachable by
every MCP connection; named `propose_*` it is additionally auto-granted to Coach.

**Notes inside the preferences document.** `10-notes.md:113-115`. `PUT /v1/gym/preferences` is a
whole-document last-write-wins replace with no PATCH (`routes.cpp:208-224`,
`schema.sql:1022-1025`), and all three clients document it in their own first lines
(`Preferences.swift:3`, `SettingsScreen.swift:4`, `settings/preferences.js:1`). Two screens open at
once silently discards one.

**The existing bar chart, reused for bodyweight.** `11-bodyweight.md` calls it a new primitive
explicitly. Gym's chart normalises to the series maximum (`record.js:66-80`, `Record.swift:139-149`),
which renders every bodyweight between 82.0 and 84.5 as a near-identical full-height block. Also
banned on that chart: a goal line, a projection, and BMI.

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
stays enabled. Apply is never reachable while the diff is clipped. Android already satisfies the
mechanical half with `skipPartiallyExpanded = true` (`LoggerScreen.kt:106`,
`RoutineBuilder.kt:110`); iOS pins fixed-height detents in four places and will repeat the habit.

**A Dismiss/Apply button pair.** `09-coach.md`: the band holds one button and it is Apply. A pair
puts the one irreversible act exactly where a hand expects Cancel, and colour does not undo position.
Currently a pair on iOS (`ProposalScreen.swift:163-193`), Android (`ProposalScreen.kt:368-390`) and
web (`Proposals.jsx:162-175`).

**A "Later" affordance on the proposal card.** `09-coach.md` beat one: a single affordance, Review.
Android draws a second at `ProposalScreen.kt:459-471`.

**A client that rewrites server text.** `09-coach.md:222-223`, and the reason the rename cannot land
one surface at a time (**P3**).

**Material You / a wallpaper-derived palette on Android.** `12-native-idiom.md` refuses it: colour in
this room is a legend, not a brand — gold is a personal record (`GymSkin.kt:35`), iris is an agent
proposal (`:25`).

**A glow token in a light skin.** Ledger `1w`, `F5`: a token whose mechanism does not exist in a mode
is deleted from that mode, not dimmed (`gym.css:63`).

**A "resting" reading, a countdown, or a Finish control on the web mirror.** Ledger `0t` keeps the
mirror's charter whole. Web ships none of the three today (verified: zero "resting" hits across
`src/products/gym/`); the risk is a rewrite introducing them.

**"Just start logging" as a web primary.** `screens.test.js:404-421` asserts the string appears in no
web file — the web's charter defended in a test. `12-native-idiom.md`'s reach-band ruling does not
scope itself by surface; do not carry it across (**W40**, and §7).

---

## 6 · Known defects the build should fix while it is in there

The ledger's live ones, plus four ledger entries this brief corrects.

### 6.1 · Four ledger entries that are wrong, verified

**Ledger `1q` undercounts the server strings.** It says "four server strings say Ask" and cites
`AskApi.cpp:33-38`; `ARCHITECTURE.md:1092-1096` repeats it. **Nine** distinct lifter-facing messages
in `AskApi.cpp` contain the room name (lines 16, 24, 27, 30, 33, 37, 42, 46, 76), plus two more
spellings that reach a lifter — `TrainingJson.cpp:496` and `PgAskThreadRepository.cpp:224`. Five of
the nine additionally ship a straight apostrophe. Both documents are stale in the same change as the
rename.

**Ledger `2f` says the web ships a `70 of 500 bytes` note counter.** It does not. There is no notes
screen, no note editor and no notes API call in `web/src/products/gym/`, and a grep for "500 bytes"
across `web/`, `apps/` and `backend/` returns **nothing** (verified). A developer planning from that
line will search for a counter to move and find none.

**Ledger `1u` says the web "states the opposite and is right".** It cites `proposals.js:13`, which is
a code comment. The sentence a lifter reads is `proposals.js:104` and carries the same false promise
as `Proposal.swift:292` — verified. Android carries it too (`domain/Proposal.kt:215-219`). **All three
surfaces ship it**, and the ledger names one.

**Ledger `1s` says `set.rpe` "is drawn on every surface".** It is drawn on **web only**
(`Log.jsx:281`, verified). On iOS `rpe` appears in the model, the queue and the codecs and in no view
(`Training.swift:152-153,:201-202,:214-215`). On Android it is a single domain field
(`domain/Training.kt:107`) and nothing else. A build that trusts the ledger will go looking for
renders to remove and find nothing on the phones.

### 6.2 · Live ledger defects, by wave

**Wave 1 (safe now, no decision needed):**
`1p` the prompt's retired-settings read (**B4**) · `1u` the false dismissal copy on all three surfaces
(**I17**, **A17**, **W12**) · `1w` the light-mode glow token (**W35**) · `1t` the three black shadows
(**W36**) · `2a` the missing iOS wake lock (**I31**) · `2b` the rest clock's mid-rest flip (**I27**,
**A27**) · the 34 dp / 38 dp Android tap targets (**A7**) · the unconfirmed session discard on all
three surfaces (**I5**, **W26**, and Android — `FinishScreen.kt:395-412` goes straight to `onDiscard`,
and `AlertDialog` returns zero hits across `gym` and `platform` main sources).

**Wave 3 (with the rename):** `1r` the thread ceiling saying four, not eight (**I20**, **A19**, and it
does not exist on web) · the allowance line above the composer on all three (**I19**, **A19**, **W8**)
· the cap-reached state, which exists nowhere · the typographic apostrophe on the server and on
Android · the raw tool trace (**I19**, **A21**, **W9**).

**Wave 4 (with the review sheet):** `1o` kept rows collapsing to a count — drawn on web
(`proposals.js:180-183`), dropped on iOS (`ProposalScreen.swift:114-115`) and Android
(`Proposal.kt:151`) · `1x` the undefined denominator for "Apply all N", which the boards answered (a
change is a row of the document) and the domain still owes.

**Wave 5/6 (with the containers and gestures):** `2m` the undo window (**P4**) · `1v` the tab-bar
selected-state contrast at roughly 1.15:1 · `1z` two different haptics for one logged set —
`UIImpactFeedbackGenerator(style: .medium)` on iOS (`GymConfirm.swift:19`) against
`HapticFeedbackType.LongPress` on Android (`GymConfirm.kt:20`), both gated on the same `confirmHaptic`
preference; worth settling before the gesture wave adds a second and a third.

**Wave 7/8:** `2j` the picker's seven-row cap on all three surfaces (**I15**, **W21**, and
`MovementPicker.kt:50,112`) · `2i` the web's refusal strings and the wrong reps band (**W20**) · `2h`
*That is not a number yet.* naming no way out — the fix belongs in the brief, not in one surface ·
`2l` the two phones drawing the clear-refusal at two different moments · `1y` Nunito vs Baloo 2, a
designer call (**W38**) · `F4` `--pr-ink`'s 3.4:1 never reproducing at any ground, which gates
Daylight.

**Documentation that goes stale in these changes:** `ARCHITECTURE.md:1078` (the undo window, and it
also carries the verdict-code rule that must survive) · `ARCHITECTURE.md:1092-1096` and
`consistency.md:616-618` (the four/nine server strings) · `2g` `Routine.h:41-44` saying a client never
sends `revision` while `TrainingJson.cpp:190-198` parses one and the web sends one · `SettingsScreen.kt:152`
("nothing on this screen converts one") once units convert.

---

## 6.3 · This document was attacked, and here is what it got wrong

An adversarial pass re-read every citation against the repo. Its verdict on the first draft was
**do not hand this to a developer yet**, and it was right. What it found, fixed above:

- **Wave 2 shipped a tool ahead of its words** on both phones — the defect the programme exists to
  close.
- **The web IA convergence was in no wave at all**, despite a prerequisite existing to unblock it.
- **`B15` floated**, and it is the item whose omission makes the account-delete door report an
  account empty that is not.
- **No migration story**, on a deploy that runs one idempotent SQL file. Three items need one.
- **Three tests assert the word "coach" is absent** and none was named. They are not
  string-equality tests; a developer reads them as bugs.

Sizes and ordering held up. The hard counts held up — 358 iOS font sites, 253 web `font-size` rules,
628 `GymSkin.` references, nine "Ask" strings in `AskApi.cpp`, twenty `.gym-back` links across nine
files with every line exact.

**What did not:** roughly forty citations drift by one to five lines, and about a dozen name the
wrong thing entirely — five of eight Android glyph lines, a detent claim that is its own opposite, a
token whose only consumer is the live dot rather than the toast, a "zero uses of `var(--text-*)`"
that greps to twelve. **Trust this document's structure and its counts; re-grep before editing at any
line it cites.** Every correction the pass found is listed in the workflow transcript rather than
inlined here, because a list of forty off-by-ones is not something a person reads.

## 7 · What is not verified

Plainly, so nobody discovers it at the worst moment.

**Nothing in this brief was executed.** No backend compiled, no `xcodebuild`, no Gradle task, no
simulator, no emulator, no test suite, no browser. Where an item says a control "does not exist", it
means no matching symbol appears in the tree — not that anyone watched a screen fail to show it.
Where a comment states a measurement, the measurement was not reproduced.

**Nine places where a brief or a ledger entry asserts something about the code that is false.** Each
is flagged in the item it touches; collected here so nobody plans from the sentence:

1. `16-the-workout.md` — "no surface has ever offered" the set-kind control. iOS offers two of four
   (`LoggerScreen.swift:377`); Android offers all four (`LoggerScreen.kt:99,:264,:304-307`).
2. `09-coach.md` / `15-the-routine.md` — the routine naming interstitial. It does not exist on iOS;
   the name is already the editor's focused first field (`RoutineBuilderScreens.swift:92-95,:209-235`).
3. `15-the-routine.md` — the target sheet's custom keypad on iOS. `KeypadSheet` is logger-only
   (`LoggerScreen.swift:468-475`); iOS has no typed target field at all.
4. `13-gestures.md` — "iOS has eleven ScrollView screens". The count is 14 sites across 13 files (one
   of which, `LoggerScreen.swift:254`, is a nested column rather than a screen container). The "two
   Lists" half matches exactly.
5. `13-gestures.md` — Android's withheld delete "generalises cleanly". `Withheld`
   (`TrainingStore.kt:1576`) names a session and a set, and the three delete verbs share no shape.
6. `13-gestures.md` — the Android routine row "already carries an overflow control". It does not
   (`RoutinesScreen.kt:200-243`; `DropdownMenu` returns zero hits).
7. `12-native-idiom.md` — "Both phones hard-code point sizes, so Dynamic Type and font scale do
   nothing on either." True on iOS (zero `Font.TextStyle`/`ScaledMetric`/`dynamicTypeSize`). **Not
   true on Android**, where `.sp` scales by definition; what is missing there is the role scale, tnum
   on non-numeral roles, and the cap/reflow.
8. `12-native-idiom.md` — the gym room "reaches for [the design system] four times out of seventeen".
   Inside `.gym-root` the count is zero.
9. `16-the-workout.md` / `13-gestures.md` — Discard "keeps its confirmation" and "its own copy already
   says 'There is no undoing it.'". **No surface has the confirmation** (iOS: the only
   `.confirmationDialog` is the set-kind picker; Android: `AlertDialog` returns zero hits; web:
   `Finish.jsx:118-136` fires on first press). Web does not have the copy either.

**Where the surveys disagreed with each other, or could not agree:**

- The backend survey and the iOS survey both read ledger `1q`. The iOS survey reports "four server
  strings" from the ledger's citation; the backend survey read the file and found nine. **The file
  wins — I re-read it. Nine.**
- The web survey concluded the server's Ask strings do not reach web (`gymApi.js:173-178`,
  `ask.js:90-106` compose locally). It also found one path that does print server text verbatim
  (`settings/preferences.js:44` returns `error.detail` for a refused preference write). Nobody
  exercised a live server to confirm no other path renders `error.detail`.

**Specific unknowns, by surface:**

*Backend.* Whether changing `kSystemPrompt` actually costs a cache miss — `AnthropicAsk.cpp:21-22`
asserts it as a comment and there is no measurement anywhere in the repository. Whether up to 5 KB of
notes on every first user turn is affordable in latency or spend — the AI meter
(`Entitlements::aiAllowanceFor`, `AiFuse`) bounds dollars over 30 days, not per-turn size. Whether
dropping the `routine_id` foreign key loses a cascade path against real data — reasoned from
`schema.sql:894` and `applyRemoval`, not tested against a database. Whether the model ever mints two
proposals in one run in practice — no logged occurrence and no test that produces one, so **B9**'s
size is estimated from the code path, not from observed behaviour. Whether the note-proposal preview
can reuse any part of `gym_proposal_changes` — concluded it cannot from `schema.sql:921-936`, but the
design has not specified the note diff's row shape, so **B8**'s L sizing is the least reliable number
in this document.

*iOS.* Whether the shell's `.simultaneousGesture` and a system interactive pop can coexist at all
(**D1**) — and whether the depth-gated fix is sufficient, or the hand-rolled gesture has to go
entirely. Whether a Live Activity's button handler runs in the app's process or the widget
extension's (**D3**) — not checked against current Apple documentation. All five simulator checks
`14-live-activity.md` names. The exact point values of any role at the largest accessibility sizes —
the brief says explicitly not to take them from memory, and the accessibility inspector was not
opened. Whether `GymDevice.summary`'s second SetQueue instance (`GymModule.swift:76`) actually
clobbers the room's queue in practice — its only write path is the legacy pre-seat migration
(`SetQueue.swift:86-102`), so the window is narrow, and no reproducing case was constructed. What is
structural and certain: two instances of a whole-file last-writer-wins store exist in one process
today, and the Live Activity proposes a third writer.

*Android.* Whether the module compiles today (the default JDK on the survey machine is 1.8; the
project needs 17+, `README.md:26-28`). Whether the app is already drawing edge-to-edge at targetSdk
36 (**D2**). Whether `android:enableOnBackInvokedCallback` is still honoured at targetSdk 36 or
predictive back is default-on. What a predictive-back animation does over a hand-rolled `when`
dispatch. What the room looks like at the largest accessibility font scale — specifically where
`GymType.weight` (104.sp) clips against the ~40 fixed `heightIn` rows and the fixed-width columns at
`FixSheet.kt:126` and `AssemblySheet.kt:252`. Whether the manifest's `configChanges`
(`AndroidManifest.xml:20`, including `uiMode`, `fontScale`, `density`) changes how Compose sees a
theme or font-scale change — the Activity is not recreated, and this sits directly under the Daylight
work. Whether `material-icons-core` is on the **compile** classpath of `:gym` specifically — verified
as an `api` dependency of material3-android 1.3.2 in the module metadata and present in the local
cache, but `:gym:dependencies` was not run. Whether the Robolectric UI suite passes today, and how
much of it breaks under the M3 conversion — every locator read uses `onNodeWithText`, so icon-only
affordances and changed strings will break it, but the assertion count was not measured. The exact
contrast ratios of the room's colours in either skin — `GymSkin.kt` carries measured claims in
comments (`:26` 6.18:1, `:31` 5.01:1, `:27` 3.66:1) that were not recomputed, and ledger `F4` records
that a sibling measurement on the web did not reproduce.

*Web.* Whether `design-system/feedback/Dialog.jsx` can host the review sheet at 390 px without
putting Apply within reach of a clipped diff (**P6**, **W11**) — not rendered, not tested at a large
browser font size. Whether `12-native-idiom.md`'s reach-band ruling is meant to reach the web at all
— the web starts no sessions and `screens.test.js:404-421` asserts the string appears in no web file;
the brief does not scope the ruling by surface. Whether `16-the-workout.md`'s "Finish becomes a sheet
over the session" applies to the web's `FinishScreen`, which is a review of a past workout and not
the end of a live one; the brief names no surface. Whether the custom keypad should also come off the
web's fix sheet — `15-the-routine.md` removes it from the planning sheet and `16-the-workout.md`
keeps it "at the rack"; the web has a fix sheet and no rack, and `logger/Keypad.jsx` serves both call
sites. The `--pr-ink` 3.4:1 figure is quoted from the comment at `gym.css:66-67`; neither the ratio
nor the claim "nothing renders this skin" was independently checked. No screen's word count was
audited against `text-budget.md`.

*Cross-surface.* How iOS, Android and web behave on an unknown `from` enum value or an unknown tool
name — `ask.js:18` was read, nothing on the phones. The exact claim-replay slot a weigh-in should
take — Android's order was read (`ClaimReplay.kt:18-33`), neither iOS's nor web's, and the three may
not agree already. No Figma file was opened; where a brief or the ledger describes a board (`2c`'s
stray `w`, `2l`'s two drawings, the `iOS Tab Bar` component description), this document reports what
those documents say, not what the boards show. Whether a notes or bodyweight route exists on an
unmerged branch — the current working tree was checked and nothing else.
