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
2026-08-25, Waves 4, 7 and 5 on 2026-08-26 and Wave 6 on 2026-08-27, each in one change across four
surfaces. What that means in practice:

- **Notes is built end to end.** A `gym_notes` table, four owner-scoped routes under
  `/v1/gym/notes` (`routes.cpp:235-258`: list, reorder, save, delete), a read-level `list_notes` tool
  that opens every Coach conversation, a third CSV at `/v1/gym/export/notes` (`routes.cpp:305`), the
  account footprint, and a Notes screen on all three surfaces.
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
- **The containers are the platform's** (`12-native-idiom.md`). iOS is a `TabView` over three tabs
  with a `NavigationStack` per tab whose paths the room owns, `List` sections, `.toolbar`,
  `.searchable`, the finish as a sheet over the session it closed, and both shell doors in the
  room's own bar. Android is a `Scaffold` with a `TopAppBar` per screen, a `NavigationBar`,
  `LazyColumn`s, Material fields, switches, segmented rows, icons, a `SnackbarHost`, edge-to-edge
  and predictive back, all inside its own `GymMaterial` scheme. Web adopts the design system inside
  `.gym-root` — rail, toast, buttons, inputs, tags, icons, dialog — over a one-block-per-skin token
  bridge.
- **Every delete in the room is withheld, and the gestures ride on that** (`13-gestures.md`). One
  window over every verb that can still be taken back — a set, a routine, a conversation, a finished
  session, a line of an unsaved draft on the web, and on the phones the set just logged — a list
  rather than a slot, each act on its own 9000 ms clock and nothing on
  the wire until the clock closes; one transient per platform, hosted by the room, carrying the only
  Undo there is. **Leaving a screen keeps the window; leaving the room abandons it** — to the
  background, to another product, or by the process dying: the rows come back, nothing goes on the
  wire and nothing is said afterwards. One exception, and it is iOS's alone: a set's delete rides
  `SetQueue` on disk there and survives, where Android abandons it with the rest (ledger `2y`).
  On the phones: swipes on the set, routine, thread and refusal rows, a horizontal walk between
  movements in the logger, and a long press on the log's session row holding Share and Discard.
  The web takes no swipes — a pointer drag would be its only path — and reaches the same acts
  through the row overflow and the editor's `×`.
- **The routine is planned by typing.** The naming interstitial and the suggestion chips are gone;
  the target sheet is three typed fields with the six pinned refusals, one at a time; the picker
  shows the six and then the whole catalogue on an empty query and keeps the seven-row cap on a
  typed one; the open line says the one pinned sentence on all three.
- **Check the line, not the sentence.** Citations drift by a few lines between edits. Trust the
  structure and the counts; re-grep before editing at any line this document cites.

The two heaviest items in the programme — the type rebuild and Daylight — are XL on every surface
and neither can be measured from source. They are last, not first.

**Read `briefs/01-context.md` before anything else.** It carries the surface charters: the web
starts no sessions, the phone owns the queue. Several rulings in the wave were written for the
surface that finishes a workout and do not name a surface; §7 lists which.

---

## 2 · Do this first

One of these is still a decision — **P9**, Android's Daylight producer — and it blocks a build. The
other ten and all three device proofs are settled and recorded here as facts, so nobody re-opens
them.

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

**P4 · The undo window — ruled: 9000 ms on every surface, and it is two constants.** `fix.js:66`
`UNDO_MS = 9000` (held by `fix.test.js:171`), `SetQueue.swift:48` and `SetQueue.kt:52`
`undoWindowMs = 9_000`; `ARCHITECTURE.md:1233` states it as the invariant it is. `TOAST_MS`
(`useTrainingLog.js:21`) is a **second** span, pinned equal and never collapsed into the first: the
window is how long a delete is still the lifter's, the toast is how long a said sentence stands, and
`screens.test.js:428-433` reads the two declarations apart and asserts they agree (ledger `2m`, D5).
Every undo the gesture wave added — the routine delete, the thread delete, the conversation delete,
the session discard, the editor row `×` — takes that span.

**P5 · The web's hash grammar — ruled.** `#/gym` IS the routines home and `#/gym/routines` is an
alias that still resolves; the routine editor stays `#/gym/routines/<id>` (`new` included);
`#/gym/coach` is the Coach root and `#/gym/ask` an alias that resolves to it; threads are
`#/gym/coach/threads` and `#/gym/coach/threads/<id>` (old `#/gym/ask/…` shapes resolve to the same
screens); notes are `#/gym/notes`; the bodyweight chart is `#/gym/bodyweight` (`log.js:62`); `log`,
`connect`, `backfill`, `movement/…`, `stats/…`, `finish/<id>` and `shared/<token>` are unchanged,
and `proposals/<id>` still resolves but opens the review dialog over the routines home rather than
a screen of its own (`GymApp.jsx:26-29`); `home()` and `landingAfterSignIn()` return `#/gym`
(`log.js:28-62`, `:101-117`; `routes.js:21-27`). Today is gone as a screen and as a tab.

**P6 · Three design-system pieces, authored before any gym twin died — ruled and built.**
`12-native-idiom.md` says a component the wave needs is authored in the design system, not in the
gym folder, and all three are: `feedback/Dialog.jsx` takes `gate="scrolled"` and a `footer` that may
be a function of `{ seen }`, so the footer stays pinned while the caller disables its primary until
the body has been read to its end; `navigation/TabRail.jsx` is the bottom rail — N items of
`{label, href, active}`, `aria-current="page"` on the active one, keyed by label, no fourth slot,
and it **reserves its own height** (`RAIL_HEIGHT = 72`, an in-flow spacer beside the fixed rail) so
no page has to know how tall it is; `Icon.jsx` registers `arrow-left` beside `arrow-right` and
renders every glyph `aria-hidden="true"`. `Tabs.jsx` stays what it always was — the segmented pill
that switches a **view**, not a room. Gym's `.gym-tabs`/`.gym-tab` and `.gym-toast` twins are gone
and `grep -rn lucide web/src/products/gym` is empty.

**P7 · Gym's token vocabulary against the design system's — ruled: the renames stay, one bridge
block per skin.** Every design-system component styles itself with inline styles reading the shared
roles (`--surface-card`, `--text-primary`, `--color-brand`, `--border-*`), and inside `.gym-root`
those already resolve to gym's palette through `[data-brand="gym"]` (`palettes.css:199-260`, carried
at `GymApp.jsx:40,:47`). So the bridge names **only** the roles the room genuinely answers for
itself — `--text-on-accent`, `--color-danger`, `--focus-ring`, `--field-focus-edge`,
`--chip-selected-edge` — in one named block per skin at the head of `gym.css` (`:90-110`), with no
per-component override anywhere else. Re-pointing any other shared role back at gym's alias of it
would be a **CSS cycle** (`--gym-surface` *is* `var(--surface-card)`) and both properties would
resolve to nothing. Ledger `F6` closes with it.

**P8 · Android's Material ColorScheme — ruled: the room has its own.** `:gym` declares
`GymMaterial` (`ui/GymMaterial.kt`), a `darkColorScheme` built from `GymSkin` — primary/secondary =
iris, onPrimary = canvas ink, surface/background = canvas, `surfaceVariant` and the middle
`surfaceContainer`s = the card ground (the two lowest are the canvas, the highest is raised),
onSurface = ink, onSurfaceVariant = inkFaint, error = brick, `outline` = `lineStrong` (a control's
edge) and `outlineVariant` = `line` (a divider), `secondaryContainer` = accentSoft (the rail's
selected seat), `inverseSurface` = raised (the snackbar's ground) — plus a `Typography` built from
the room's own faces, display for the title roles and body for the rest, carrying
`fontFeatureSettings = "tnum"` on every one of them. **Gold is not in the scheme:** in
this room gold means a personal record (`GymSkin.prInk`) and is painted by hand where a record is,
so a Material control can never say *record* by accident. `MainActivity.kt` wraps the gym room in
`GymMaterial` inside `WindmillMaterial`, never in `WindmillMaterial` alone. Dynamic colour is off,
as a refusal (`12-native-idiom.md`): colour here is a legend and a wallpaper cannot recolour a
legend.

**P9 · Android's `LocalWindmillDark` producer, and GymSkin's shape — still open.** `Tokens.kt:32`
declares `staticCompositionLocalOf { true }` and **nothing provides it** — three hits repo-wide, the
declaration and two consumers (`Tokens.kt:40`, `WindmillMaterial.kt:12`). `isSystemInDarkTheme`
appears nowhere in `apps/android`. `GymSkin.kt:19-40` is a compile-time `object` of hard `Color`
constants read at **614 sites across 26 files**, and the accessor pattern it must adopt
(`Tokens.kt:34-41`) is `@Composable` — so the call graph moves too, including non-composable helpers
like `Modifier.dashedEdge` (`GymSkin.kt:76`). `GymMaterial`'s scheme (**P8**) is built out of those
same constants and is one skin by declaration, so it converts with them. **Blocks:** all Daylight
work on Android. Half-converting is worse than not starting: a light Material chrome painted over a
hard-coded dark room.

**P10 · Assign the refusals that a removed control carries — ruled and built on all three.**
`15-the-routine.md`'s own rule: "When a wave removes a control, it inherits that control's refusals
— and they are assigned to a named board on a named surface before drawing starts." The target
sheet's six live in the domain on every surface — `routines.js` (`refusalOf`, `targetRefusal`),
`TargetEntry.swift`, `domain/Program.kt` `TargetEntry` — drawn inline under the offending field,
**one per sheet**, computed in the order a lifter meets it: the refused keystroke, then the line's
shape, then sets → reps → weight. The **rack keypad keeps its own four** with the logger's 1–99 band
(`16-the-workout.md`: the keypad is a rack control). It is raised from the logger and from the fix
sheet on every surface — `logger/Keypad.jsx` from `FixSheet.jsx:9` and `Backfill.jsx:12`,
`KeypadSheet` from `FixSheet.swift:128-138` and `FixSheet.kt:78` — and from nowhere in the planning
sheet. The two bands are named constants on every surface and each names the other (ledger `2i`).

**P11 · Whether `androidx.navigation` enters the Android build — ruled: it does not.** There is no
navigation entry in `gradle/libs.versions.toml`, and `NavHost`/`androidx.navigation` return zero
hits. Back is a pure function of the room's own state instead: `backMeans(finished, live, building,
away, tab)` (`GymRoom.kt:148-161`) returning five meanings — `Nothing` on the finish screen (claimed
and inert), `StayInTheWorkout` (mid-workout the handler is CLAIMED, the logger stands, the app is
never backgrounded), `LeaveTheDraft`, `PopOnePushedScreen`, `ReturnToTheRoutinesTab` — with
`LeaveTheApp` at the routines home, where the handler is disabled so the platform's back exits
(`:335`). Three of those are not pops, which is the reason: a NavHost gives none of them for
free, saves the back stack `GymRoom.kt:242-245` deliberately does not, and takes only string
arguments where `Away.Session` carries a whole `SessionSummary` (`:181`) and `Away.NoteEditor` a
whole `Note` (`:189`).

### 2.2 · Device proofs — all three answered

**D1 · iOS: the shell's leading edge against a NavigationStack — proven on the simulator, and the
answer is depth.** The two gestures coexist. `Shell.swift:177` attaches the go-home swipe as
`.simultaneousGesture(homeSwipe, including: depth == 0 ? .all : .subviews)`, over a drag gated on
`startLocation.x <= edge` with `edge = 20` (`:166`, `:184`, `:188`); a room writes its depth outward
once at its root through `RoomDepthPreference` (`Platform.swift:97-123`), and gym writes the
**visible** tab's path count — zero whenever the stacks are not what is on screen
(`GymRoom.swift:145`, `stackDepth` at `:414-417`).
*What the proof found is not the naive outcome the brief predicted.* Over a `NavigationStack`'s own
frame the system's screen-edge pan wins the touch outright and cancels SwiftUI's drag, so "both
fire" never happens there. The defect is that the stack does not cover the room: the **tab bar's
band** sits outside its frame, and a leading stroke there at depth 1 never meets the navigation
controller's recogniser — so a handler-only depth guard still let the shell's gesture run alone and
throw the lifter out of a room they were only stepping back through. The gesture is therefore
**unattached** past depth 0, not merely declining. Pinned by real touches on iOS 26.3 in
`apps/ios/UITests/RoomEdgeGestureUITests.swift`, whose negative control (`including: .all`, nothing
else changed) fails exactly `testTheLeadingEdgeBesideTheTabBarDoesNotLeaveTheRoom` and nothing else.
Ledger `1k` closes with it.

**D2 · Android: edge-to-edge and predictive back at targetSdk 36 — answered, and the room now draws
that way on every version.** `app/build.gradle.kts:21` sets `targetSdk = 36`, where edge-to-edge is
enforced and the opt-out is disabled. `MainActivity.onCreate` calls `enableEdgeToEdge` with
transparent dark bar styles, `themes.xml` keeps only `windowBackground`, and the room's `Scaffold`
owns the insets and consumes them (`.systemBarsPadding()` returns zero hits in `apps/android`).
`AndroidManifest.xml:14` declares `android:enableOnBackInvokedCallback="true"` and `:25`
`android:windowSoftInputMode="adjustResize"` — edge-to-edge's other half, without which the keyboard
pans the top bar off instead of resizing the window. `BackHandler` stays the API (**P11**). Still
unproven: what a predictive-back animation does when the destination is a `when` branch inside one
composable (`GymRoom.kt:775-956`) rather than a NavHost entry — there is no second screen for the
system to reveal behind the peel, and no run recorded in §7 has been on a version where predictive
back applies. The Robolectric suite cannot see it either: twenty-two files pin
`@Config(sdk = [35], qualifiers = "w412dp-h915dp-xhdpi")`.

**D3 · iOS: where a Live Activity's button handler runs — answered.** A `LiveActivityIntent`'s
`perform()` runs in the app's process, not the widget extension's, so the lock-screen button reaches
the app's own `SetQueue` in-process; the second-writer question is the in-process one, which
`GymRoom.swift:13` (`TrainingStore()`, whose default queue is `TrainingStore.swift:74`) and
`GymModule.swift:78` already pose — two instances of a store that holds the
whole file in memory (`SetQueue.swift:68-69`) and writes it atomically as a last-writer-wins
whole-file replace (`:334-337`) into the app's own Application Support container (`:143-148`), and
the second can write (`:81`, `:86-101`). The Live Activity adds a third. `SetQueue.swift:443` says what is at
stake: an owed set is the only copy of something somebody lifted. Wave 9 stays blocked on a signing
team and a widget-extension target: `project.yml:20-109` declares the app and a UI-test bundle and
nothing else, with no team and `CODE_SIGNING_REQUIRED: "NO"` on both (`:34`, `:65`, the reason at
`:63-64`). It is also blocked on `14-live-activity.md`'s
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

Waves 0 (in part), 1, 2, 3, 3b, 4, 5, 6 and 7 are landed. What is left is Wave 8, Wave 9 and the
deferred programme, and each is blocked on something §2 names.

*Every wave below names its gates. A wave whose gate is unmet is not "start it carefully" — it is
not started.*

**Wave 0 · Decisions and proofs.** Everything in §2. No code. Ruled: P1, P2, P3, P4, P5, P6, P7, P8,
P10, P11. Answered: D1, D2, D3. Open: P9 alone, which needs a developer to pick and record.
*Unblocks:* everything below except Daylight on Android.

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

**Wave 5 · Native idiom — done**, with the routine editor that rode on its containers. iOS: a
TabView, a NavigationStack per tab, List conversions, `.toolbar`, `.searchable`, the finish sheet,
SF Symbols, `ProgressView`/`ContentUnavailableView`/`ShareLink`, and both shell doors in the room's
own bar. Android: `GymMaterial`, Scaffold and TopAppBar, NavigationBar, the five back meanings by
hand, Material icons with descriptions, `LazyColumn`s, `SwipeToDismissBox`, text fields, switches,
segmented rows, drag handles, a `SnackbarHost`, edge-to-edge and predictive back. Web:
design-system adoption inside `.gym-root` over the P7 bridge. Across all three: the naming
interstitial and the suggestion chips deleted, three typed target fields with the six pinned
refusals, the picker's six then the whole catalogue, and the open line's one sentence. Ledger `1k`,
`1l`, `2i`, `2j`, `2l` and `F6` are closed and `1v` is re-scoped.
*Unblocked by it:* the gesture wave, which needed Lists, a snackbar host and a real back.

**Wave 6 · Gestures — done.** The withheld delete first, as one abstraction over every verb that
deletes (`Withheld.swift`, `store/WithheldDelete.kt`, `withheld.js`): a set, a routine, a
conversation, a finished session, and on the web a line of an unsaved draft; the phones' windows
also hold the set just logged, which is the one thing in them that is not a delete. The window is a
**list** — each act on its own 9000 ms clock, a second one settling nothing — hosted by the room, so
leaving a screen keeps it and leaving the room abandons it. Every row-borne undo is gone and one
transient per platform carries the action and the fact that a window is open. With it: the set-row,
routine-row, thread-row and refusal-row swipes,
the logger's horizontal walk, the session row's long press carrying Share and Discard, the editor
row's undo on the web, RPE and a set note in every fix sheet, and one haptic vocabulary on both
phones. The Discard confirmation and the sentence *There is no undoing it.* are deleted from all
three surfaces. Ledger `1s` and `1z` close with it. Ten entries came out of the wave and its
follow-up: `2s`, `2t`, `2u`, `2z` and `3a` are closed; `2v`, `2w`, `2x`, `2y` and `3b` are open, and
three of those are an owner's call rather than a build. `3c` is older than the wave and was surfaced
by it.
*Unblocked by it:* nothing. It was the last purely additive wave.

**Wave 7 · Bodyweight — done.** The wire and the last claim-replay slot, the reading at the log
head, the chip in the reach band, the dated weigh-in sheet with its repair path, and the dot chart
as a new primitive — `design-system/charts/DotChart.jsx` on the web, Swift Charts and Compose
Canvas on the phones.

**Wave 8 · Type and Daylight.** XL on every surface, and both need measurements nobody has taken.
Type is additionally BLOCKED on web (`W37`). Daylight is gated on ledger `F4` — `--pr-ink`'s
stated 3.4:1 has never reproduced at any ground — and on P9 for Android.

**Wave 9 · Live Activity.** BLOCKED on a signing team and a widget-extension target in
`apps/ios/project.yml:20-109`, which today declares two — the app and its UI-test bundle — with
signing deliberately off on both, and on the four remaining simulator checks (D3).

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

Both of this surface's prerequisites are settled: **D1** (the leading edge, arbitrated by depth) and
the capsule inset. `Shell.swift:175` applies the top `.safeAreaInset` only for a room that does not
declare `hostsTopChrome`; `GymModule.swift:11` declares it, so the room draws the capsule leading and
the You seat trailing in its own toolbars and the shell lays nothing over it — the ~46pt the lane
cost is the room's again, and it is spent on a navigation bar. A room that declares nothing (journal,
roadmap) is byte-for-byte unchanged.

**I23 · [REBUILD / XL] The type ramp — 384 literal point sizes, and Dynamic Type does nothing.**
384 font call sites in WindmillGym carry a literal size (452 across `apps/ios`), spread across every
screen (32 in `AskScreen.swift`, 26 each in `ReviewSheet.swift` and `ConnectedLog.swift`, 25 in
`LoggerScreen.swift`, 23 in `FinishScreen.swift`, 22 each in `RoutinesScreen.swift` and
`NotesScreen.swift`). `Font.TextStyle`, `ScaledMetric` and `dynamicTypeSize` appear **nowhere** in
`apps/ios`. Instrument numerals are fixed points: `GymSkin.swift:64-66` pins weight at 104, reps at
36, the correction figure at 72, with `minimumScaleFactor` as the only guard
(`LoggerScreen.swift:327`, 0.55). Uppercase eyebrows carry 23 hand-set tracking values (`.tracking(`
ten times, `.kerning(` thirteen).
**What the containers changed, and what they did not.** The chrome the platform owns *does* scale
now — the navigation bar, the tab bar, and `List` section headers and footers the room does not
style — so at AccessibilityXXXL the editor's `Movements` header grows several times over beside a
name field that does not move. Every point size the room sets itself is still inert.
*Careless build:* the logger's today-column claims its height from named constants before its rows
lay out — `rowHeight = 52`, `columnCap = rowHeight * 3` (`LoggerScreen.swift:285-286`), used at `:279`
as `min(columnCap, rows.count * rowHeight)`. Under Dynamic Type the rows grow and the frame does not,
so rows clip silently at exactly the setting whose purpose is legibility. Every hand-set fixed-width
column breaks the same way: `SessionScreen.swift:284` (`width: 18`), `LoggerScreen.swift:293`
(`width: 16`), `AskScreen.swift:337` (`width: 54`). These become grids. `12-native-idiom.md` is
explicit that the point values at the largest accessibility sizes are read off the simulator's
accessibility inspector, not taken from published defaults.

**I24 · [REBUILD / XL] Daylight — the room forces itself dark in three places and declares one skin.**
`GymRoom.swift:135` is `private var skin: GymSkin { .instrument }`, a computed constant with no
producer; `:141` writes `.environment(\.colorScheme, .dark)` into the whole room and `:142` dresses
the capsule dark. `GymSkin.swift:28-49` declares exactly one skin and `:52-53` makes it the
environment key's default. The shell's Appearance control is real and working
(`YouScreen.swift:53-65`, `Shell.swift:15`, `:77`) — gym is the room ignoring it.
*Careless build:* the skin reaches the room through an environment key whose default is hardcoded to
`.instrument`, so any view presented outside the room’s environment keeps the dark skin — and gym
pins a sheet’s ground to the skin explicitly at twelve sites (`GymRoom.swift:158`, `:169`,
`SessionScreen.swift:171`, `LoggerScreen.swift:114`, `FixSheet.swift:136`,
`RoutineBuilderScreens.swift:204`, `:209`, `:225`, `LogScreen.swift:185`,
`BodyweightScreen.swift:52`, `NotesScreen.swift:47`, `RecordScreen.swift:67`). A half-conversion is
a light room with dark sheets. Gated on ledger `F4`.

**I25 · [BLOCKED / XL] The Live Activity target does not exist.**
`ActivityKit`, `WidgetKit`, `AppIntent` and App Group identifiers return nothing across `apps/ios`.
`project.yml:20-109` declares two targets — the app and the `WindmillUITests` bundle — both with
`CODE_SIGNING_REQUIRED: "NO"` (`:34`, `:65`) and no team, on purpose (`:63-64`). BLOCKED on that
signing team and a widget-extension target, and on the five simulator checks
`14-live-activity.md` names (**D3**). One separate build risk worth pinning now: "the app mints the id and hands it to the button
as part of the activity's state" — idempotency does not cover this on its own, because two taps mint
two ids and two ids are two sets.

**I26 · [BLOCKED / L] SetQueue is one-per-process by construction.** See **D3**.

### 4.3 · Android — `apps/android` (`:app :platform :gym`)

Surface prerequisite: **P9** alone. P8 is built (`GymMaterial`), D2 is answered and the room draws
edge-to-edge on every version; only the predictive-back animation over the hand-rolled dispatch is
still unproven — no run recorded in §7 has been on a version where it applies.

**A2 · [BUILD / XL] Navigation is a sealed list and a `when`.** *(Ruled against by **P11** — kept
because the shape is what every other Android item is read against, not because a NavHost is
coming.)* `gradle/libs.versions.toml` has no navigation entry; `NavHost` and `androidx.navigation`
return zero hits. Navigation is `var away by remember { mutableStateOf<List<Away>>(emptyList()) }`
(`GymRoom.kt:245`) over `sealed interface Away` (`:180-191`), dispatched by a 182-line `when`
(`:775-956`). The eight hand-drawn back rows are gone: back is the `TopAppBar`'s navigation icon in
the one shared container (`ui/GymScreen.kt:77-86`), which carries *where* it leads in its
description.
*Careless build:* a NavHost saves and restores its back stack, which is precisely what
`GymRoom.kt:242-245` refuses on purpose; and `Away.Session` carries a whole `SessionSummary` object
(`:181`) because, per the comment at `:175`, it "carries facts no other read gives back" — a route
argument is a string, so that screen needs a different data path before it can be a destination.
Doing this carelessly turns a documented decision into a silent regression.

**A24 · [REBUILD / XL] Type: every size is a literal; `MaterialTheme.typography` is never set.**
`WindmillFont.display/body/mono(size: Int)` builds a TextStyle from a raw Int
(`platform/design/Tokens.kt:75-91`), called with literals at 369 sites in `:gym` (171 through
`WindmillFont.`, 198 through `GymType.`). `GymType.weight` is
a fixed 104.sp with 92.sp line height (`GymSkin.kt:44-51`). The **Material** half is answered:
`GymMaterial` passes a `Typography` built from the room's own faces with `fontFeatureSettings =
"tnum"` on every numeric role (`ui/GymMaterial.kt:90`, `:93`), so no Material control in gym falls
back to stock — `WindmillMaterial` still passes none (`WindmillMaterial.kt:10-13`), which is the
brand's problem and not this room's. `tnum` is also on `GymType.weight` (`:50`) and `GymType.numeral`
(`:63`) and on **none** of the raw `WindmillFont` roles gym calls directly. Rows are pinned by
`heightIn(min = …)` at 92 sites; columns by `widthIn(min = 88.dp)` (`KeypadSheet.kt:219`) and
`size(width = 32.dp, …)` (`AssemblySheet.kt:303`). Four partial mitigations exist, all
`TextAutoSize.StepBased` (`KeypadSheet.kt:168`, `FixSheet.kt:121`, `LoggerScreen.kt:512`, `:627`).
***The brief's premise needs qualifying before anyone builds from it.*** `12-native-idiom.md` says
"Both phones hard-code point sizes, so Dynamic Type and font scale do nothing on either." On Android
`.sp` scales with the user's font scale by definition, so font scale is **not** inert here. What is
missing is the named role scale, tnum on the non-numeral roles, and the cap/reflow. The real damage
at a large scale is the opposite shape: a 104.sp numeral grows without a cap while every fixed
`heightIn` row and fixed-width column does not, so the room **clips** rather than ignores. Building to
"font scale does nothing" produces the wrong fix.

### 4.4 · Web — `web/src/products/gym/`

Surface prerequisites: **P4**, **P5**, **P10**. P6 and P7 are built.

**W34 · [REBUILD / L] Daylight: the room pins dark in two places.**
`routes.js:66` declares `scope: { theme: 'dark', brand: 'gym' }` and `Shell.jsx:76` reads
`room.scope.theme ?? appearance`. Outside `/app` the shell never mounts and `GymApp.jsx:40,:47`
hardcode `data-theme="dark"` on `.gym-root`, the attribute `gym.css` scopes its tokens to (`:5`,
`:43`). The light ground already exists (`palettes.css:208-228`, `:276-284`) and `gym.css:43-78`
declares a light block of mostly byte-identical aliases; **P7**'s bridge adds a light half of its own
(`:104-110`) which has never rendered either.
*Careless build:* dropping only the `routes.js` pin changes nothing a lifter sees — `.gym-root`'s own
`data-theme="dark"` still wins, and outside `/app` it is the only stamp there is, so `GymApp` has to
resolve appearance itself via `useAppearance`. The bigger risk is shipping the flag as the feature:
the light block has never been rendered, one of its tokens is excused in a comment for failing its own
gate (`gym.css:66-68`), and flipping the pin makes that comment's excuse false in the same commit.

**W37 · [BLOCKED / XL] Type: 258 hardcoded pixel sizes, and the shared scale is pixels too.**
`gym.css` contains 258 `font-size: Npx` declarations against **one** use of the
`--text-xs`…`--text-6xl` scale (`.gym-name-label`'s `var(--text-sm)`, which came in with the design
system's field-label treatment); its eleven other `var(--text-*)` reads are the colour roles
`--text-primary`, `--text-link` and kin. The shared scale is itself fixed:
`styles/tokens/typography.css:3-12` defines `--text-xs: 12px` through `--text-6xl: 60px`. Gym
extends it with `--weight-size: 104px` and `--reps-size: 54px` (`gym.css:36-39`, and the light
block's twins at `:74-77`). There are 40
`tabular-nums` declarations and no font-size media queries.
**Blocked, not merely large:** the web's equivalent of Dynamic Type is honouring the browser's root
font size, and the scale gym would adopt is pixel-valued — so adopting it changes nothing for a
reader who has set a larger font. Making the shared scale relative is a change to `typography.css`
that reaches roadmap and journal as well, and nobody has scoped it. Until then, converting 256
declarations to a px-valued token scale is churn that buys the accessibility gap nothing.

**W38 · [BLOCKED / S] Gym's screen titles are in the body face.**
`gym.css:137-143` `.gym-title` sets no `font-family`, inheriting `var(--font-body)` (Nunito) from
`.gym-root` (`:121`); the display face is reached seven times in the stylesheet — four instruments
(`.gym-keypad-echo`, `.gym-fix-kg`, `.gym-stat-value`, `.gym-record-tile-value`) and three headings
(`.gym-target-movement`, `.gym-picker-title`, `.gym-connect-title`).
Ledger `1y` records it as "a designer call, one way or the other" and does not decide it. **Deciding
it inside a build wave pins one answer for every gym title on three surfaces by accident.** Get the
ruling; the code change is one line.

**W39 · [BLOCKED / M] Whether the web's session review becomes a dialog.**
`FinishScreen` (`Finish.jsx:14-111`) is a pushed screen at `#/gym/finish/<id>` (`log.js:40`,
`GymApp.jsx:110`), reached only from "Session review ›" at `Log.jsx:255`; it owns the
keep-as-a-routine offer (`Finish.jsx:144-201`) and, for a `slight` session alone, the discard door
(`:113-142`, now a withheld delete with the room's transient rather than a confirmation — ledger
`3c`). `16-the-workout.md`'s ruling
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
(`gym_notes`, `/v1/gym/notes`, `routes.cpp:235-258`) and never move: `PUT /v1/gym/preferences` is a
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
which set they are deciding about. The full-swipe ban rests on the same fact and no longer on the
window's size — the window holds many now: a trailing action pulls the row's leading edge under
itself, so a stroke that fires without a lift fires over a row the lifter can no longer read.
`allowsFullSwipe: false` is pinned on every ruled iOS row (`SessionScreen.swift:232`,
`RoutinesScreen.swift:45`, `ThreadsScreen.swift:71`); Android's `SwipeToDismissBox` has no such
state, so what is pinned there instead is that a stroke carried the whole way across deletes exactly
once.

**A `⋮` on the log's session row.** `13-gestures.md` D7: the long press carries `Share this workout`
and `Discard session` and draws nothing (`LogScreen.swift:146-156`, `LogScreen.kt:279-340`). Adding a
drawn overflow to carry an act the menu already holds is Law 4 backwards. What Law 1 needs beside it
is a drawn door *elsewhere*, not on the row, and both phones draw one on the past-session screen
(`SessionScreen.swift:153`, `SessionScreen.kt:265-279`).

**A fixed partial detent on the review sheet.** `09-coach.md`: a half-height sheet does not grow with
the system text size, so at the larger accessibility sizes the visible diff goes to zero while Apply
stays enabled. Apply is never reachable while the diff is clipped. The review sheet is `.large` only
on iOS (`GymRoom.swift:159`) and skips the partial state on Android (`GymRoom.kt:255`); the weigh-in
sheet's `.medium` (`LogScreen.swift:186`, `BodyweightScreen.swift:53`) is proportional, not fixed,
and holds one field. The fix sheet gave its own fixed height up when it gained two fields — it is
`.large` now (`SessionScreen.swift:174`), for exactly this reason. iOS pins fixed-height detents in
**three** places, and all three hold a keypad or a switcher rather than prose:
`LoggerScreen.swift:50`, `FixSheet.swift:137`, `Shell.swift:61` and `:130`; the habit is what to
watch.

**A Dismiss/Apply button pair.** `09-coach.md`: the band holds one button and it is Apply — `Apply
all N`, `Apply` when N is 1, `Remove <routine>` — and turning down is a text row beneath it behind
its confirmation. Built that way on all three (`Proposals.jsx:166-181`, `ReviewSheet.swift:265-294`,
`ReviewSheet.kt:463-530`). A pair puts the one irreversible act exactly where a hand expects Cancel,
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
`:26`, and the light dot draws no shadow, `:592-593`).

**A "resting" reading, a countdown, or a Finish control on the web mirror.** Ledger `0t` keeps the
mirror's charter whole. The mirror (`Mirror.jsx`) ships none of the three, and `screens.test.js:96`
walks every gym file for "resting"; the risk is a rewrite introducing them.

**"Just start logging" as a web primary.** `screens.test.js:532` asserts the string appears in no
web file — the web's charter defended in a test. `12-native-idiom.md`'s reach-band ruling does not
scope itself by surface; do not carry it across (§7).

---

## 6 · Live ledger defects, by wave

The ledger (`../consistency.md`) is current; this is its gym remainder, placed.

**Closed by the containers:** `1k` the leading edge, arbitrated by depth and proven (**D1**) · `1l`
both shell doors in the room's own top chrome · `2i` the refusal strings and the two named bands ·
`2j` the picker's six and the typed-query cap · `2l` the clear-refusal, refused in place with its
mirror · `F6` `--focus-ring` in iris inside gym. `1v` is re-scoped rather than closed: Android
carries selection on four channels and iOS 26 paints the tab bar's labels itself, so what is left is
a ramp question for surfaces that still honour a tint.

**Closed by the gestures:** `1z` one haptic vocabulary on both phones — light on a reveal, medium on
a save, a closing note on a finish — a logged set spending the save's impact rather than a fourth
sensation · `1s` the set's RPE and note, given a control on every fix sheet rather than having their
render deleted, and printed on both phones' session rows as well as the web's.

**Opened by the gestures and closed after them:** `2s` the window's early close is one answer
everywhere now — leaving the room, to the background or for good, abandons what is held on all three
surfaces (`Withheld.swift:190-197`, `TrainingStore.kt:1333-1339`, `useTrainingLog.js:157-167`), so
*swipe · switch apps · come back* costs a row nothing · `2t` Android's past-session screen draws
`Discard session` (`SessionScreen.kt:172`, `:265-279`), so its three doors — review screen, finish
screen, long press — run through one act (`GymRoom.kt:540-545`) and one constant
(`FinishScreen.kt:56`), and no gesture is the only path.

**Owed a build, opened by closing those two:** `2y` a set's delete is durable on iOS, where it rides
`SetQueue` on disk with its own held-until instant, and abandoned on Android, where it sits in the
same in-memory list as every other verb — one rule for that surface's whole window, and no silent
loss, but the two phones differ. The item that ends it is Android's set delete riding `SetQueue` as
iOS's does, which is the whole of the build.

**Wave 8, and a brief:** `2h` *That is not a number yet.* naming no way out — the fix belongs in the
brief, not in one surface, and the sentence now ships on two screens per surface · `1y` Nunito vs
Baloo 2, a designer call (**W38**) · `F4` `--pr-ink` at 3.2:1 in Daylight with no darker gold in the
ramp, a designer's token before Daylight renders · `1w` the Daylight glow value still in the Figma
collection.

**Needing an owner rather than a build:** `2p` the rack keypad's own words
(the pad's hint and its empty-buffer line) held by a test and by no brief · `2q` the picker's
catalogue-read-failed sentence, byte-identical on three surfaces and in no brief · `2r` Android's
connect pitch, which cannot suppress itself because the surface never reads what is connected ·
`2v` the bare `—` in the `Top e1RM` tile on all three, a designer's call against the honesty rule
that says a missing fact draws nothing · `2w` two refusals of one shape reading differently in one
room — the server's lowercase `a note runs to 500 bytes` beside the room's own
`A set note runs to 4000 bytes.` — a copy owner's call, product-wide · `2x` five sentences the
gesture wave minted that no brief holds · `3b` a refused delete on Android says the log's own
fragment and names neither the subject nor that it is still there, because
`WriteFailure.line(subject)` (`TrainingStore.kt:1769-1772`) reads its subject only when the log went
quiet — and every `Deletion.stillThere` sentence is written and thrown away · `3c` the web draws
`Discard session` only for a `slight` session (`Finish.jsx:96`), so an ordinary past workout can be
discarded from no web door at all — not a Law 1 breach, since the web draws no gesture, but a
product call: either the review screen gains the door both phones draw, or discarding is a phone
act on purpose and a brief says so · `3d` the web's abandon fires at the room's unmount and not on
the surface leaving the foreground, so a window opened and then left in a hidden tab still spends its
row — the narrower trigger may be right for a page, but nothing written says it is.

**Recorded for the class, fixed in the instance:** `2u` both fix sheets could not reach `Save the
fix` or `Delete set` with a long note and the keyboard up, because content shorter than the viewport
scrolled nowhere. Both scroll now; the rule the entry keeps is that a board drawing a sheet with a
text field draws it once with the keyboard up. · `2z` Android's row swipe state was a
`rememberSaveable`, so a row put back by a refusal or an Undo returned already dismissed and spent
the delete again on a stroke nobody made — fixed by one shared `rememberRowDismiss`
(`ui/RowSwipe.kt:45-64`), and the class is that ANY per-row gesture state outliving the row's absence
will replay it. · `3a` a refused settle said nothing at all, because the room cleared the refusal
before showing the snackbar and so changed the key its own effect was running under — said first,
cleared after (`GymRoom.kt:426-437`); the class is that a keyed effect clears the state its key reads
only after the work is done, and the tell is silence rather than a crash.

**Any wave — a board fix:** `2f` the `W8` boards' `70 of 500 bytes` counter.

**Documentation that goes stale in these changes:** `2g` `Routine.h:40-44` saying a client never
sends `revision` while `TrainingJson.cpp:190-198` parses one and the web sends one ·
`SettingsScreen.kt:121` ("nothing on this screen converts one") once units convert ·
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
head, the chart and the review sheet.

**What Wave C executed** — the containers and the routine editor — per its builders' and reviewers'
reports: the backend was not touched. On **iOS**, the `WindmillKit-Package` suite (602 gym, 61
platform, 65 journal with 6 skipped, 4 roadmap) and **23 XCUITests driving real touches** on an
iPhone 17 simulator at iOS 26.3, on a freshly erased device — including the edge-gesture set that
answers **D1** and its negative control, the capsule/You-seat seating, the refused sets clear typed
key by key, and the picker's six; plus screenshots of every converted root at the default text size
and at `UICTContentSizeCategoryAccessibilityXXXL`, and the tab bar's rendered colours sampled off
the running build for `1v`. On **web**, `npm test` and `npm run build` green, and the whole room
driven at 390 px in headless Chrome with zero console errors — the routines home, the editor and its
two Save refusals, the target sheet's six refusals one at a time, the refused clear retyped, the
picker from the editor and from backfill, the log, a movement record, the notes room, and Duplicate
end to end. On **Android**, the unit and Robolectric suites (the UI classes now drawing on a
412 × 915 dp frame) and `:app:assembleDebug` green, plus emulator screenshots at the default font
scale and at `font_scale 2.0`, a `uiautomator dump` reading the semantics of a converted row, and
the assembly sheet's swipe performed on the device.

**What Wave D executed** — the withheld deletes and the gestures — per its builders' and reviewers'
reports. The backend's change was a **pin, not a build**: that a set PATCH carrying `note: ""` clears
the note and an absent `note` leaves it, driven against a live server and held in the suite. On
**iOS**, the `WindmillKit-Package` suite plus new files for the window, the withheld rows and the set
record, and **XCUITests driving real touches** on an iPhone simulator at iOS 26.3 — two deletes in
one second both restoring, swipe-then-back leaving the row alone, a full swipe deleting nothing, the
transient never moving the `Log set` button, the session row's menu holding Share and Discard, a
menu discard withheld and taken back, the review screen's own Discard withholding the same way, the
logger's horizontal walk with the chevrons gone and the walk stopping at the ends, and **leaving the
foreground keeping the row and sending nothing**. On **web**, `npm test` and `npm run build` green
with new suites for the window, the conversation delete and the set's RPE and note, and the room
driven in headless Chrome. On **Android**, the unit and Robolectric suites — new files for the
window, the send path, the pinned bytes, the set-row swipe, the row-swipe accessibility actions, the
log row's menu, the logger walk and its refusal, the fix sheet's effort fields and the haptic
vocabulary — with `:app:assembleDebug` green and emulator screenshots of the changed screens.
**The wire was watched, not assumed:** a withheld server-only delete was confirmed absent from the
backend's access log until its clock closed.

**What the Wave D follow-up changed, and what is not claimed for it.** Five things landed after the
report above and no run of any suite is recorded here for them — what follows is read from the
working tree, not watched: web and Android joined iOS in abandoning a held delete when the room
goes — `ON_STOP` and disposal on Android (`TrainingStore.abandonWithheld`, `GymRoom.kt:462`,
`:469`), the room's unmount and only that on the web (`useTrainingLog.js:157-167`, ledger `3d`);
Android's set delete lost its exemption from that abandon, and with it the no-argument
`settleWithheld()` and every trace of the exemption in the window's own data — `WithheldDelete` now
carries a deletion, an instant and `sent`, and nothing else; Android's past-session screen gained the
drawn `Discard session` iOS already had; Android's row-swipe state moved to a shared
`rememberRowDismiss` that never restores (`ui/RowSwipe.kt`); and the room's refused-settle effect now
says its sentence before clearing the flag its own key reads. The tree carries suites written against
all five — `store/WithheldWindowTests.kt` (`testLeavingTheRoomAbandonsWhatItHeldAndTellsTheLogNothing`,
`testASetsDeleteIsAbandonedWithEverythingElseBecauseNothingHereOutlivesTheRoom`),
`ui/SessionDiscardTests.kt` (`testTheThreeDoorsSayOneThing`), `ui/RowReturnReplayTests.kt` and
`RefusedSettleTests.kt` — and **that they exist is not that they were run.**

**Three things Wave D could not verify.** No screen on either phone was touched on **real
hardware** — iOS was a simulator and Android an emulator, so the haptic vocabulary is pinned by its
constants and by nobody's hand, and the feel of a swipe is still unwatched. **VoiceOver and TalkBack
themselves were not run**: every custom action is asserted in a suite, and no screen reader was
turned on. And the **predictive-back animation over the `when` dispatch** (**D2**) stays unproven,
because no run recorded here has been on a version where predictive back applies.

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

*iOS.* The five simulator checks `14-live-activity.md` names. The exact point values of any role at
the largest accessibility sizes — the room was **photographed** at AccessibilityXXXL, which showed
what the platform's own containers do and what the room's fixed points do not, but the accessibility
inspector was still not opened and no role's value was read off it. Whether `GymDevice.summary`'s
second SetQueue instance (`GymModule.swift:78`) actually clobbers the room's queue in practice — its
only write path is the legacy pre-seat migration (`SetQueue.swift:86-101`), so the window is narrow,
and no reproducing case was constructed. What is structural and certain: two instances of a
whole-file last-writer-wins store exist in one process today, and the Live Activity proposes a third
writer. Wave B's screens are still untouched by a finger: the review sheet's gate and the weigh-in
sheet were proven by the package suite and a hosted-window test, and no XCUITest since has revisited
them — Wave D's touched the fix sheet's keypad and its keyboard reach, and nothing else of Wave B's.

*Android.* What a predictive-back animation does over a hand-rolled `when` dispatch on an Android 16
device (**D2**) — Wave A's emulator was API 34 and no run since has named a newer one.
What the room looks like
**past** font scale 2.0: 2.0 was shot, the largest accessibility scale was not, and that is where
`GymType.weight` (104.sp) meets the 92 fixed `heightIn` rows and the fixed-width columns at
`KeypadSheet.kt:219` and `AssemblySheet.kt:303`. Whether the manifest’s `configChanges`
(`AndroidManifest.xml:24`, including `uiMode`, `fontScale`, `density`) changes how Compose sees a
theme or font-scale change — the Activity is not recreated, and this sits directly under the Daylight
work. The exact contrast ratios of the room's colours in either skin — `GymSkin.kt` carries measured
claims in comments (`:26` 6.18:1, `:31` 5.01:1, `:27` 3.66:1) that were not recomputed; the rail's
own numbers in `GymRoom.kt:965-971` are computed from the skin's own hexes, not sampled off a
screen.

*Web.* The review dialog's gate at a large browser font size — the dialog was rendered and driven
at 390 px, not at a large font, and nothing in the room has been driven at a large browser font.
Whether `12-native-idiom.md`'s reach-band ruling is meant to reach the web at all — the web starts no
sessions and `screens.test.js:532` asserts the string appears in no web file; the brief does not
scope the ruling by surface, and both phones now ship the ruling's inversion. Whether
`16-the-workout.md`'s "Finish becomes a sheet over the session" applies to the web's `FinishScreen`,
which is a review of a past workout
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
