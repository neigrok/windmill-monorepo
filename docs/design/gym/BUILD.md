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
`UNDO_MS = 9000` (held by `fix.test.js:171`), `SetQueue.swift:48` and `SetQueue.kt:53`
`undoWindowMs = 9_000`; `ARCHITECTURE.md:1233` states it as the invariant it is. `TOAST_MS`
(`useTrainingLog.js:21`) is a **second** span, pinned equal and never collapsed into the first: the
window is how long a delete is still the lifter's, the toast is how long a said sentence stands, and
`screens.test.js:439-444` reads the two declarations apart and asserts they agree (ledger `2m`, D5).
Every undo the gesture wave added — the routine delete, the thread delete, the conversation delete,
the session discard, the editor row `×` — takes that span.

**P5 · The web's hash grammar — ruled.** `#/gym` IS the routines home and `#/gym/routines` is an
alias that still resolves; the routine editor stays `#/gym/routines/<id>` (`new` included);
`#/gym/coach` is the Coach root and `#/gym/ask` an alias that resolves to it; threads are
`#/gym/coach/threads` and `#/gym/coach/threads/<id>` (old `#/gym/ask/…` shapes resolve to the same
screens); notes are `#/gym/notes`; the bodyweight chart is `#/gym/bodyweight` (`log.js:62`); `log`,
`connect`, `backfill`, `movement/…`, `stats/…`, `finish/<id>` and `shared/<token>` are unchanged,
and `proposals/<id>` still resolves but opens the review dialog over the routines home rather than
a screen of its own (`tabOf` in `GymApp.jsx`); `home()` and `landingAfterSignIn()` return `#/gym`
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
`KeypadSheet` from `FixSheet.swift:132-142` and `FixSheet.kt:78` — and from nowhere in the planning
sheet. The two bands are named constants on every surface and each names the other (ledger `2i`).

**P11 · Whether `androidx.navigation` enters the Android build — ruled: it does not.** There is no
navigation entry in `gradle/libs.versions.toml`, and `NavHost`/`androidx.navigation` return zero
hits. Back is a pure function of the room's own state instead: `backMeans(live, building, away, tab)`
(`GymRoom.kt:148-159`) returning four meanings — `StayInTheWorkout` (mid-workout the handler is
CLAIMED, the logger stands, the app is never backgrounded), `LeaveTheDraft`, `PopOnePushedScreen`,
`ReturnToTheRoutinesTab` — with
`LeaveTheApp` at the routines home, where the handler is disabled so the platform's back exits
(`:350`). The finish receipt is not among them: it is a sheet, and a sheet answers back by coming
down. Two of those are not pops, which is the reason: a NavHost gives none of them for
free, saves the back stack `GymRoom.kt:246-249` deliberately does not, and takes only string
arguments where `Away.Session` carries a whole `SessionSummary` (`:179`) and `Away.NoteEditor` a
whole `Note` (`:187`).

### 2.2 · Device proofs — all three answered

**D1 · iOS: the shell's leading edge against a NavigationStack — proven on the simulator, and the
answer is depth.** The two gestures coexist. `Shell.swift:177` attaches the go-home swipe as
`.simultaneousGesture(homeSwipe, including: depth == 0 ? .all : .subviews)`, over a drag gated on
`startLocation.x <= edge` with `edge = 20` (`:166`, `:184`, `:188`); a room writes its depth outward
once at its root through `RoomDepthPreference` (`Platform.swift:97-123`), and gym writes the
**visible** tab's path count — zero whenever the stacks are not what is on screen
(`GymRoom.swift:146`, `stackDepth` at `:415-418`).
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
composable (`GymRoom.kt:836-1009`) rather than a NavHost entry — there is no second screen for the
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
`TOOL_PHRASE` (`coach.js:4-15`), `Ask.phrase` (`Ask.swift:203-214`) and `Ask.phrases`
(`Ask.kt:112-123`) carry the same words, and the phone suites pin their tables against the web’s.

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
(`LoggerScreen.swift:324`, 0.55). Uppercase eyebrows carry 23 hand-set tracking values (`.tracking(`
ten times, `.kerning(` thirteen).
**What the containers changed, and what they did not.** The chrome the platform owns *does* scale
now — the navigation bar, the tab bar, and `List` section headers and footers the room does not
style — so at AccessibilityXXXL the editor's `Movements` header grows several times over beside a
name field that does not move. Every point size the room sets itself is still inert.
*Careless build:* the logger's today-column claims its height from named constants before its rows
lay out — `rowHeight = 52`, `columnCap = rowHeight * 3` (`LoggerScreen.swift:282-283`), used at `:276`
as `min(columnCap, rows.count * rowHeight)`. Under Dynamic Type the rows grow and the frame does not,
so rows clip silently at exactly the setting whose purpose is legibility. Every hand-set fixed-width
column breaks the same way: `SessionScreen.swift:284` (`width: 18`), `LoggerScreen.swift:290`
(`width: 16`), `AskScreen.swift:360` (`width: 54`). These become grids. `12-native-idiom.md` is
explicit that the point values at the largest accessibility sizes are read off the simulator's
accessibility inspector, not taken from published defaults.

**I24 · [REBUILD / XL] Daylight — the room forces itself dark in three places and declares one skin.**
`GymRoom.swift:136` is `private var skin: GymSkin { .instrument }`, a computed constant with no
producer; `:142` writes `.environment(\.colorScheme, .dark)` into the whole room and `:143` dresses
the capsule dark. `GymSkin.swift:28-49` declares exactly one skin and `:52-53` makes it the
environment key's default. The shell's Appearance control is real and working
(`YouScreen.swift:53-65`, `Shell.swift:15`, `:77`) — gym is the room ignoring it.
*Careless build:* the skin reaches the room through an environment key whose default is hardcoded to
`.instrument`, so any view presented outside the room’s environment keeps the dark skin — and gym
pins a sheet’s ground to the skin explicitly at twelve sites (`GymRoom.swift:158`, `:170`,
`SessionScreen.swift:171`, `LoggerScreen.swift:111`, `FixSheet.swift:140`,
`MovementPicker.swift:327`, `RoutineBuilderScreens.swift:202`, `:218`, `LogScreen.swift:185`,
`BodyweightScreen.swift:57`, `NotesScreen.swift:48`, `RecordScreen.swift:67`). A half-conversion is
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
(`GymRoom.kt:249`) over `sealed interface Away` (`:178-189`), dispatched by a 174-line `when`
(`:834-1007`). The eight hand-drawn back rows are gone: back is the `TopAppBar`'s navigation icon in
the one shared container (`ui/GymScreen.kt:77-86`), which carries *where* it leads in its
description.
*Careless build:* a NavHost saves and restores its back stack, which is precisely what
`GymRoom.kt:246-249` refuses on purpose; and `Away.Session` carries a whole `SessionSummary` object
(`:179`) because, per the comment at `:173`, it "carries facts no other read gives back" — a route
argument is a string, so that screen needs a different data path before it can be a destination.
Doing this carelessly turns a documented decision into a silent regression.

**A24 · [REBUILD / XL] Type: every size is a literal; `MaterialTheme.typography` is never set.**
`WindmillFont.display/body/mono(size: Int)` builds a TextStyle from a raw Int
(`platform/design/Tokens.kt:75-91`), called with literals at 369 sites in `:gym` (171 through
`WindmillFont.`, 198 through `GymType.`). `GymType.weight` is
declared at a fixed 104.sp with 92.sp line height (`GymSkin.kt:47-54`); the logger overrides both,
drawing it through `BasicText` auto-sized 44–80 sp on a 72 sp line (`LoggerScreen.kt:938`), and
`GymSkin.kt` carries two more sans roles the logger alone uses, `GymType.reps` (56 sp) and
`GymType.primary` (20 sp). The **Material** half is answered:
`GymMaterial` passes a `Typography` built from the room's own faces with `fontFeatureSettings =
"tnum"` on every numeric role (`ui/GymMaterial.kt:90`, `:93`), so no Material control in gym falls
back to stock — `WindmillMaterial` still passes none (`WindmillMaterial.kt:10-13`), which is the
brand's problem and not this room's. `tnum` is also on `GymType.weight` (`:50`) and `GymType.numeral`
(`:63`) and on **none** of the raw `WindmillFont` roles gym calls directly. Rows are pinned by
`heightIn(min = …)` at 92 sites; columns by `widthIn(min = 88.dp)` (`KeypadSheet.kt:222`) and
`size(width = 32.dp, …)` (`AssemblySheet.kt:295`). Four partial mitigations exist, all
`TextAutoSize.StepBased` (`KeypadSheet.kt:172`, `FixSheet.kt:121`, `LoggerScreen.kt:613`, `:938`).
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
`FinishScreen` (`Finish.jsx:15-106`) is a pushed screen at `#/gym/finish/<id>` (`log.js:40`,
`GymApp.jsx:110`), reached only from "Session review ›" at `Log.jsx:255`; it owns the
keep-as-a-routine offer (`Finish.jsx:139-199`) and, for a `slight` session, the `ShortSession`
discard door (`:111-137`, a withheld delete with the room's transient rather than a confirmation).
An ordinary finished session's discard is `SessionDetail`'s, on the log (`Log.jsx:348-350`, the
same withhold — ledger `3c`, closed). `16-the-workout.md`'s sheet ruling
is written for the surface that *finishes* a session, and `01-context.md` says the web never does —
here it is a review of a past workout, and **the brief now says so by name**: the sheet is both
phones', and the web's finish is a screen the room's one back opens — above the title on the ready
state, above the retry line on a failed read, above the line where the session is not in the log, and
absent only while the read is still running.
Building it as a dialog anyway puts the discard door and the keep-as-a-routine offer inside a modal,
and neither has a settled treatment there.

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
on iOS (`GymRoom.swift:159`) and skips the partial state on Android (`GymRoom.kt:260`); the weigh-in
sheet's `.medium` (`LogScreen.swift:186`, `BodyweightScreen.swift:58`) is proportional, not fixed,
and holds one field. The fix sheet gave its own fixed height up when it gained two fields — it is
`.large` now (`SessionScreen.swift:174`), for exactly this reason. iOS pins fixed-height detents in
**three** places, and all three hold a keypad or a switcher rather than prose:
`LoggerScreen.swift:47`, `FixSheet.swift:141`, `Shell.swift:61` and `:130`; the habit is what to
watch.

**A Dismiss/Apply button pair.** `09-coach.md`: the band holds one button and it is Apply — `Apply
all N`, `Apply` when N is 1, `Remove <routine>` — and turning down is a text row beneath it behind
its confirmation. Built that way on all three (`Proposals.jsx:166-186`, `ReviewSheet.swift:265-306`,
`ReviewSheet.kt:473-550`). A pair puts the one irreversible act exactly where a hand expects Cancel,
and colour does not undo position.

**A "Later" affordance on the proposal card.** `09-coach.md` beat one: a single affordance, Review,
and every card carries only that. "Later" is closing the sheet, after which the card reads *still
waiting*.

**A client that rewrites server text.** Where the server sends a sentence, every client — web
included (`askFailure`'s `note(…)` in `coach.js`) — shows those bytes; local copy is only the
wordless fallback (**P3**,
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

**"Just start logging" as a web primary.** `screens.test.js:542` asserts the string appears in no
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
surfaces (`WithheldWindow.abandon`, `TrainingStore.abandonWithheld`, the room's unmount effect in
`useTrainingLog.js`), so
*swipe · switch apps · come back* costs a row nothing · `2t` Android's past-session screen draws
`Discard session` (`SessionScreen.kt:172`, `:265-279`), so its three doors — review screen, finish
receipt, long press — run through one act (`GymRoom.discard`) and one constant
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
`WriteFailure.line(subject)` (`store/TrainingStore.kt`) reads its subject only when the log went
quiet — and every `Deletion.stillThere` sentence is written and thrown away · `5h` a plan naming
one movement twice, whose rest the phones read off the first entry and the web reads off the dial ·
`5i` Android's Rest group drawing no caption where iOS's footer states the app-awake fact · `5k`
one session discard refused in three sentences · `5l` the read grant saying `workouts` on one line
and `sessions` on the next, with the weigh-ins named on none.

`3d` was on this list and is off it: it said the web's abandon fires at the room's unmount and not on
the surface leaving the foreground, so a window left in a hidden tab still spent its row. The tree
has watched the tab for the window since `8104def` — one listener, calling the same `abandon`
(`useTrainingLog.js:211-221`), with three cases in `withheldWindow.test.js` behind it — so the entry
was describing a build that no longer existed. Closed at the tree by S2b's closing pass.

**Recorded for the class, fixed in the instance:** `2u` both fix sheets could not reach `Save the
fix` or `Delete set` with a long note and the keyboard up, because content shorter than the viewport
scrolled nowhere. Both scroll now; the rule the entry keeps is that a board drawing a sheet with a
text field draws it once with the keyboard up. · `2z` Android's row swipe state was a
`rememberSaveable`, so a row put back by a refusal or an Undo returned already dismissed and spent
the delete again on a stroke nobody made — fixed by one shared `rememberRowDismiss`
(`ui/RowSwipe.kt:45-64`), and the class is that ANY per-row gesture state outliving the row's absence
will replay it. · `3a` a refused settle said nothing at all, because the room cleared the refusal
before showing the snackbar and so changed the key its own effect was running under — said first,
cleared after (`GymRoom.kt`'s `deleteRefused` effect); the class is that a keyed effect clears the
state its key reads only after the work is done, and the tell is silence rather than a crash.

**Opened by the simplification programme (§8):** `3i` iOS's editor Duplicate copying the draft, a
deliberate divergence rather than drift · `3j` a proposal card naming its routine twice · `3l` a
removal counted where the intent is not asked, on iOS's two proposal cards and on every surface's
conversation rows, whose wire carries no intent for any client to read · `3s` three writers
sharing one bottom band on iOS under a rule that names two · `3u` the web's routines-home card saying
how much nowhere · `3w` a sign-out that does not clear this device's copy of the program on Android ·
`3x` a hardcoded out-of-reach literal on `domain/Thread.kt`, the last of the kind the routine history
block shed · `3z` *tap to rename* drawn on one finish card of three · `4d` `Keep it` dismissing the
receipt in place on the phones and navigating away from it on the web, with nothing in canon
deciding which · `4e` iOS's guard against a double keep having no seam a pin could use · `4l` the notes cap saying *delete one* over a list a delete is already
leaving, on all three · `4g` the cap-reached sentence pinned on iOS and read inside the scroller on
Android, both halves measured and neither shape ruled · `4j` Android's type answering the system's
text size where iOS's fixed point sizes and the web's all-`px` stylesheet answer nothing, which is
product-wide rather than gym's · `4k` the routine draft, asked about before it is thrown away on iOS
and eaten silently on the web and Android — the one destructive act in the room with no window
behind it · `4q` the state a held delete of the only weigh-in leaves, answered three ways — the web
nothing at all, Android a count line plus *no weigh-in in the last 90 days*, iOS a count line over an
empty chart in either window — and the same gap now on four more screens · `4r` iOS's pre-mint share
offer saying the window without its numeral, where `3k` ruled numerals for the consent screens ·
`4s` two true facts about Android's room — the wake lock and the syncing dials — that its settings
screen now states nowhere · `4u` how far a delete's window reaches beyond the screen the act was
taken on, undecided and answered differently by the web and the phones · `4v` a door that hands the
lifter to a browser and says nothing when no browser comes, on both phones.

**Closed by it, and recorded so the next wave reads them as settled:** `3h` iOS's routine home card
redrawing the routine screen behind it · `3m` the connect copy's claim on how your gym is set up,
gone from the web and iOS, and iOS's read line naming notes since N1 · `3n` the product invariant
that asked for a confirmation as well as an undo · `3o` Android's card and its row chip drawing one
proposal twice · `3p`, the web half by S2a — the editor handle a real button answering the drag, the
arrows and a single pointer alike — and Android's by N1, a handle that picks up and places plus
*Move up* / *Move down* actions · `3y`
the web's notes list, which took that same grip off the same hook · `4b` neither web drag reorder
being workable by a single pointer, closed on both lists by the pick-up / place-down path (`3y` and
`4b` are deleted entries, not open ones) · `3e` the atomic promise, now in the pinned band between
Apply and turn-down on all three · `3f` the AI ceiling, now sharing the cap-reached state and saying
the sentence the server sent · `4h`, opened and closed inside S2b: iOS took the other two surfaces'
bytes, so the wordless ceiling fallback is one string in three files · `4i`, likewise: the weigh-in
written into an open delete window is no longer destroyed on any surface · and S3's seven, each
checked at the symbol on every surface it named and then stamped **built 2026-08-31** in the ledger
with the symbols that now agree: `3k` iOS's `30 days` in numerals · `3t` the
proposal promise gated on pending on both phones · `4a` the faint ink for a form that is not finished
on both phones · `4c` the finish card's name capped at the room's 60 code points on all three ·
`4m` Android's gate `Text` off the semantics tree in both states, which makes all three
single-reading · `4n` the bodyweight stance reading the store on the web and Android · `4o` iOS's
weigh-in write-again guard moved inside `TrainingStore.weighIn`. S4 adds one, stamped
**built 2026-09-01**: `4p`, the same law on four more web screens and — once the phones were swept
for the first time — on four iOS screens and six Android instances besides. `3q` is NOT among them —
the detail was shortened and measured, and iOS still reads three lines at 390 points, which moves
the entry off the copy and onto the transient's row. N1 adds six, each stamped **built 2026-09-02**
with the symbols that agree: `3c` the web's `Discard session` on every finished session's detail ·
`3g` the rest target saying *from the routine* once, on the timer, on all three, and off every
settings screen · `3m`'s leftover, iOS's read line naming notes · `3p` Android's draft reorder ·
`3r` Android's `Start workout` in a pinned bottom band · `4f` one trim unit on the picker. And
`5j` — Android's assembly sheet drawing no Close where iOS's `JumpSheet` keeps one — is recorded as
legal under `12-native-idiom.md` rather than opened.

**Any wave — a board fix:** `2f` the `W8` boards' `70 of 500 bytes` counter.

**Documentation that goes stale in these changes:** `2g` `Routine.h:40-44` saying a client never
sends `revision` while `TrainingJson.cpp:190-198` parses one and the web sends one ·
the phones' lb-only Units line *This phone still draws kg.* (`Bodyweight.kilogramsOnly`,
`Settings.stillKg`), drawn under the Units control alone, once units convert ·
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
goes — `ON_STOP` and disposal on Android (`TrainingStore.abandonWithheld`, `GymRoom.kt`'s `ON_STOP`
observer and its `onDispose`), and the document going hidden or the room unmounting on the web —
one watch on the tab, calling the same `abandon` (`useTrainingLog.js:211-221`, `:227-231`;
ledger `3d`, closed at the tree by S2b's closing pass, which found the entry stale);
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

**What S4 did not verify.** The stances the wave fixed are pinned by suites and by one source-text
pin (iOS's `testEveryGymScreenReadsTheStoreForItsStateAndTheWindowForItsRows`), and **nothing was
driven in a real browser or on real hardware**. What did render, rendered in a harness: the web's
cases run in node's DOM harness (`test/products/gym/harness.mjs`), Android's under Robolectric with
`createComposeRule`, and on iOS the routines stance renders in `RoutineScreensHostingTests` while
the stances a host does not reach are pinned at the store or by that source-text pin. Two of the wave's own findings are recorded as unreachable-in-fact
rather than proven so: `TrainingStore.apply`'s remove-proposal verdict is drivable at the store's
API and not through the room's navigation today, and iOS's editor seam in `GymRoom` — the `editing:`
flag, `untested(_:)` and `save(_:)`'s replace-vs-create branch — asks `allRoutines` for the draft's
own id, over an editor no path opens above a withheld routine.

**What N1 verified, and what it did not.** Every surface's full gate ran green on the tree as it
stands (§8 carries the totals). What was proven in a harness: Android's four sheet dismissals under
Robolectric — `SheetDismissTests.kt` asserts that exactly one node in each raised sheet exposes
`SemanticsActions.Dismiss`, that invoking it calls `onDismissRequest`, and that the scrim commits
nothing — and the draft reorder's pick-up, place-down, both custom actions and the said line in
`RoutineEditorTests.kt`; iOS's five sheet chromes in `SheetChromeHostingTests.swift`; the web's
detail discard in all four directions in `withheldWindow.test.js`. **Nothing was touched on real
hardware and no screen reader was run**: the drag handle's semantics, the polite live region and
the Material segmented rows are asserted in suites, not heard. The four iOS UITest classes N1
repointed at the Units footer were run on the simulator (iPhone 17 Pro): **21 executed, 0 failures,
`TEST SUCCEEDED`**. The web half was also driven end to end on a local stack (Postgres + backend on
8094 + vite on 5199, headless Chrome over CDP): the backfill date field, the detail discard with its
undo and its settled DELETE, the coach doors, the routine menu and the settings rest copy all matched
the rulings. The Android half was installed on the `Pixel_API34_Root` emulator with no backend: the
editor's handle reorder, the pinned `Start workout` band, the `Settings` bar, the segmented rows, the
rename and keypad sheets dismissing by scrim and swipe, and the `resting · target 1:30` line were all
seen at font scale 1.0 and 1.3, with no crash in logcat; the ` · from the routine` variant was not
exercised there because no routine entry carried rest.

**What N2 verified, and what it did not.** The web gate was run by this pass — `cd web && npm test`,
**1650 pass, 0 fail** — and the Android total was read off the JUnit XML under
`apps/android/gym/build/test-results/` (both variants, from a deleted `test-results` re-run by the
wave owner after the last fix pass on 2026-09-02): **896 per variant, 0 failures, 12 skipped**, across
94 classes. The iOS package gate and the six UITest classes
named in §8 were run by their builders, not by this pass. The Android logger was installed on the
emulator at font scale 1.0 and 1.3 per its builder's report, and nothing in this section was watched
by the pass that wrote it. **Not run for N2 at all:** the web in a real browser — every web cut is
pinned in node's DOM harness and no page was driven end to end; the iOS UITest walks other than those
six classes; any screen reader; any real hardware. The screen's spoken names — *Set kind* and its
state, the clocks row's merged bytes, *Movement 1 of 3*, *on this device* on the cloud glyph — are
asserted under Robolectric (`LoggerRestTargetTests`, `LoggerMovementWalkTests`, `LoggerScreenTests`)
and heard by nobody.

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
`KeypadSheet.kt:222` and `AssemblySheet.kt:295`. Whether the manifest’s `configChanges`
(`AndroidManifest.xml:24`, including `uiMode`, `fontScale`, `density`) changes how Compose sees a
theme or font-scale change — the Activity is not recreated, and this sits directly under the Daylight
work. The exact contrast ratios of the room's colours in either skin — `GymSkin.kt` carries measured
claims in comments (`:26` 6.18:1, `:31` 5.01:1, `:27` 3.66:1) that were not recomputed; the rail's
own numbers in `TabRail`'s comment in `GymRoom.kt` are computed from the skin's own hexes, not
sampled off a screen.

*Web.* Whether the reorder's single-pointer path holds up under a real screen reader. Its builder
drove it in Chrome, which is where the trailing-click defect surfaced and where the node harness
could not have found it — but no VoiceOver or TalkBack session has touched either list, and the
criterion the path closes (SC 2.5.7) is about exactly those users. What is pinned is the behaviour,
not the announcement: `role="status"` is asserted to carry the sentence, and nothing has heard one
spoken. The review dialog's gate at a large browser font size — the dialog was rendered and driven at
390 px, not at a large font, and nothing in the room has been driven at a large browser font.
Whether `12-native-idiom.md`'s reach-band ruling is meant to reach the web at all — the web starts
no sessions and `screens.test.js:542` asserts the string appears in no web file; the brief does not
scope the ruling by surface, and both phones now ship the ruling's inversion. Whether the custom
keypad should also come off the web's fix sheet — `15-the-routine.md` removes it from the planning
sheet and `16-the-workout.md` keeps it "at the rack"; the web has a fix sheet and no rack, and
`logger/Keypad.jsx` serves both call sites. `gym.css:66-68`'s 3.2:1 for `--pr-ink` is the
stylesheet's own figure, not independently reproduced, and "nothing renders this skin" was not
checked by rendering. No screen's word count was audited against `text-budget.md`.

*Cross-surface.* Whether Coach, given a real model, calls `list_bodyweight` and phrases it — the
tool, its phrase and its receipt rule are pinned in the suites, but no local run carries an
Anthropic key, so no conversation has exercised it. No Figma file was opened; where a brief or the ledger describes a board (`2c`'s stray `w`, `2l`'s two
drawings, `2f`'s counter, `1w`'s collection value, the `iOS Tab Bar` component description), this
document reports what those documents say, not what the boards show.

---

## 8 · The simplification programme

One rule, and nine of the eleven cuts behind it are it applied: **draw each fact once, in the state
where it is true, and give every enforced refusal a sentence.** S1, S2a, S2b, S3 and S4 are in the
tree, and with S2b closed **the board's confirmed list is finished**: all eleven of its shippable cuts
have landed — 3, 6, 7, 9, 10 and 11 in S1, 1 and 2 in S2a, 4, 5 and 8 in S2b. **There is no next cut
on that list.** S3 was not a cut either: it closed the programme's own debt — the rulings the first
three waves MADE and RECORDED and never BUILT, which read as settled and were not true — and one
salvage. **S4 closed the last defect the programme itself created** — a window deciding what state a
screen is in — swept all three surfaces for it, and took the one salvage S3 left. What is left is
named at the end of this section, and anything further is a new board rather than a next wave.
**N1 followed, and it is not the programme's**: one wave of `briefs/12-native-idiom.md`'s law — where
the platform has a control, the platform's control wins — built under the programme's standing rules,
which is why its block sits here and why six of the entries below closed in it.

**What S1 landed.**

- **iOS's routine-home card stopped redrawing the routine screen behind it.** The card is the
  routine's name, `untested`, one meta line, a waiting row for a routine whose pending proposal is
  not the standing card's, and the accent border; the per-entry `MovementDoor` and the whole History
  block are gone, and `TrainingStore.history(of:)` went with its last caller. The movements, their
  targets and the settled history are read one tap deeper, on the routine's own screen — which draws
  them **with** the target column and the `· yours` suffix the card never had. Its precondition
  landed in the same change: `TrainingStore.routine(_:)` answers `RoutineRead`
  (`.read` / `.remembered` / `.failed`), falls back on this device's copy of the program when the log
  never answers, and says the log's own sentence when it refuses, so the movements are still named
  offline. **The bound is said honestly:** that history is the newest **twenty** proposals
  (`kRoutineHistoryProposals` = 20), and nothing anywhere writes *all*. `Start workout` moved into a
  bottom `safeAreaInset` on iOS — a pinned primary, per `../guidelines/thumb-reach.md` §3.1 and §3.6 —
  which Android matched in N1 (ledger `3r`, closed), and which puts a third writer in a bottom band
  whose rule names two (ledger `3s`).
- **The Coach card is a skim.** The web's card drops the folded document for the changed rows capped
  at three plus `+ N more`, with the counted phrase on its own line beneath the summary —
  `countedLabel` (`proposals.js:110`), which asks the intent first so a removal reads *a removal*,
  and which `historyLabel` calls. The rows a card may draw are enumerated rather than filtered by
  what they are not: `CARD_ROW_KINDS` is `added` · `removed` · `retargeted` (`proposals.js:176`), so
  the rename and the reorder pseudo-rows stay in the dialog, where the document they are claims
  about actually is. Nothing stops being counted — the phrase reads the server's `changeCount`. The
  document is drawn once, behind Review (`09-coach.md`). The conversation's rows still count a
  removal on every surface, because the thread payload carries no intent for them to ask, and no
  client can close that half (ledger `3l`).
- **The proposal eyebrow holds one line on all three; the review sheet's head takes two.**
  `Proposal · <routine name>` carries a lifter-typed string of up to 60 code points. On an eyebrow —
  which shares its row with a stamp — the name truncates and the stamp keeps its room:
  `.lineLimit(1)` on both iOS cards plus a hosting pin, `maxLines` + `TextOverflow.Ellipsis` +
  `weight(1f)` on all three Android eyebrows, and `.gym-proposal-name` / `.gym-proposal-when` on the
  web (`gym.css`). The web's rule was measured rather than reasoned, per its builder's
  report: headless Chrome against the real stylesheet at body widths 320 · 390 · 430 · 560 · 900,
  with a 60-character name and the full stamp — three wrapped lines before, one line at every width
  after, and a short name not clipped. **The sheet head is the exception and it is deliberate**: it
  wraps to two lines on both phones, because that is the screen the routine is decided on and
  clipping its name hides the subject of the decision.
- **Duplicate has one home, the routine row's overflow** (**R5**) — the menu that also carries
  Delete, and whose `duplicate` guards re-entrancy with `copying` and places the copy at the end of
  the list. The web editor head draws no overflow at all. iOS's editor head keeps one, and what it
  copies is the unsaved draft: a different act, recorded as a deliberate divergence (ledger `3i`).
- **The routine editor's rows stopped being a door out of an unsaved draft.** Name, `yours` tag and
  numbers are one row-body button opening the target sheet, and the record door is re-homed: a
  **Movements** anchor beside `New` on the routines home (`Routines.jsx:67`), the only drawn way to
  `MovementChooser` and the only door to a never-trained movement's record — and so to Rename — that
  does not go through a proposal's diff row.
- **The conversation caption became the transient's detail.** `heldDetail` on the web's window,
  byte-identical to `Withheld.threadDetail` and `WithheldDelete.Thread.detail`, and Law 4 enforced
  inside the function: past one held delete the count takes over and no detail is said.
- **The keypad's scrim cancels**, on the fix sheet and the backfill form both — the vocabulary rule
  in `12-native-idiom.md`, now written there and pinned in `logger/rackKeypad.test.js`.
- **One proposal, one rendering.** The standing card stays on every surface — it carries
  *still waiting*, which no survivor can host — and the duplicate goes: the web's `ProposalFlag`,
  iOS's inline waiting row for a routine whose one waiting proposal is the card's, and Android's row
  chip for the routine the card is about. A routine holding a second waiting proposal keeps its iOS
  row (`TrainingStore.waitingOnTheRow`): the card names one proposal and no count, and the count is
  the row's to say.
- **A caption is drawn only in the state it describes.** ` · nothing running` is off both phones'
  Routines heads — a device-local clock can support an omission, never an assertion — and Android's
  bodyweight gap rule is inside the branch that draws the chart.
- **Two consent-copy defects.** The web's and iOS's connect lines no longer claim a connection reads
  how your gym is set up (`get_preferences` does not exist), and the web's write level now carries
  the share link's public readability and its 30-day expiry.

**Four rulings closed the wave, and canon carries them now.**

- **The routine row's overflow item is `Delete`, on every surface.** Both briefs that draw the string
  say `Delete`, and all three surfaces now do. On Android the swipe's lane and the overflow spend one
  word for one act, which is what makes Law 1's per-row test true of that row.
- **The share link's window is written `30 days`, in numerals** — the backend's own *(30 days)*. All
  three surfaces say it; iOS's half landed in S3.
- **The Coach card's proposal promise is drawn while the proposal is pending and dropped once it is
  decided** — the web's shape, because a promise about what Apply will do is spent once Apply has
  been taken or turned down. Both phones' halves landed in S3.
- **An unread-history line inside a block draws alone.** *the log didn’t answer — this routine’s
  history is out of reach* is a line, never a line plus a full-width *Try again*: the retry belongs
  to the whole-screen failure, and a second full-width control inside one block of a screen that
  rendered fine competes with the screen's one primary (`../guidelines/thumb-reach.md` §3.1, §3.2).
  Written in `15-the-routine.md`; iOS's block-level use dropped the button and Android's line was
  already right.

**What S2a landed — the two cuts that redraw a screen.**

- **Minting a movement stops unmounting the picker**, on both phones (cut 1, narrowed to the sheet
  swap). `.creating` is off iOS's `Sheet` enum and `LoggerSheet.Create` / `BuilderSheet.Create` are
  off Android's; the picker presents the create step over itself and owns it — a `.sheet` on iOS
  driven by a file-private `Minting` modifier both pickers share, a nested `ModalBottomSheet` from the
  picker's own `rememberSaveable` slot on Android, seeded with `query.trim()`. So the picker stays
  mounted and Cancel comes back to the rows with the typed query in the field and the frozen six
  unshuffled. Android's `onCancel = { sheet = LoggerSheet.Picker }` is deleted rather than re-homed,
  and its picker `query` is now `rememberSaveable`. **The name field, the 60-code-point cap and its
  counter, the equipment chooser, `Create and add`, *not in the library*, iOS's disabled-until-
  answered state and both failure lines are unchanged** — the board's skeptic refuted deleting them,
  and `capped()`'s only call site is intact, which was the wave's named hazard.
- **The finish screen has one way out** (cut 2, all four parts). **Web:** the ready state opens with
  `<Back href={sessionHref(id)}>Session detail</Back>` through the `<Back>` component, and the
  footer holding a second *Session detail* and a *Done* that finished nothing is gone; it serves the
  slight and the ordinary branch alike, because the slight branch's own foot goes to the routines
  home and without it that state has no route to the session it reviews. The failed read's back
  moved to the head beside it, so the only branch drawing none is the read still running. The link
  is `align-self: flex-start` in the finish screen's column, or the flex ground would stretch a 44px
  navigation strip the width of the receipt. *tap to rename* is deleted with `.gym-keep-hint`; the
  field keeps its 44px height, its border, its ground, its focus edge and
  `aria-label="Routine name"`. *Just keep the session* **stays on the web**: it declines the routine
  offer in place rather than leaving, which is a different act. **iOS:** a toolbar `Done` in `.confirmationAction`
  replaces the card's *Just keep the session* and the drawn *Done*, suppressed on the slight branch
  where `Keep it` is already the affirmative half of a decided pair; `head.title` stays in the
  content; and the room's finish `.sheet` carries an `onDismiss` clearing `finishFailure`, so a
  refusal cannot outlive an interactive swipe-down. **Android:** `FinishScreen` is the room's
  `ModalBottomSheet` over the session it closed, and it carried all six mandatory items — a
  `failure: String? = null` parameter with the keep refusal routed off the Scaffold's bottom bar
  onto it, `head.title` moved into the sheet content so *Ended early* survives, `close()` pushing
  `Away.Session` **before** presenting so a dismissal lands on the workout that was finished,
  `railStands` and `backMeans` both losing their `finished` argument in the same change as
  `GymBackTests` (with `BackMeans.Nothing` deleted outright), `FinishScreen`'s own `verticalScroll`
  carried into the sheet body, and the slight branch's affirmative hoisted to `Finish.keepIt` beside
  `Finish.discard`. **All three:** *Name it to save it.* is drawn under the inert `Save routine` on
  the finish card, on the **empty name only** — never while the write is in flight, where it would
  name a cause that is not the one holding the button — and it is one constant per surface with no
  fourth copy (`NAME_IT_TO_SAVE_IT` lifted out of the web's literal, `RoutineDraft.nameItToSaveIt`,
  `Program.nameItToSaveIt`).
- **Both of the web's drag reorders gained a real single-pointer path** (ledger `3p` and the deleted
  `3y` / `4b`; the wave's **CR-A** correcting its own ruling **S2**). S2 held that making the handle
  keyboard-operable closed WCAG 2.2 SC 2.5.7. It does not — a keyboard path answers SC 2.1.1, and
  2.5.7 exists as a separate criterion for exactly that reason — and a phone browser has no arrow
  keys at all, so the lifter Law 1's own sentence names was still unserved. The handle now answers
  **three** paths: the drag unchanged, ArrowUp / ArrowDown, and an activation — click, tap, Enter,
  Space, an AT double-tap — that **picks the row up**, after which every other handle reads as a
  destination (*Place Back Squat at 3 of 3*), a second activation places it, the same handle again
  puts it down, and Escape puts it back. The move is said once on a `role="status"` line whichever
  path took it. **No drawn control was added**: the *Move up* / *Move down* row menu ledger `3p`
  itself proposed would have bought chrome in a wave whose subject is removing it. The state machine
  is one hook, `web/src/products/gym/rail.js`'s `useRail`, read by `EntryList` in `Routines.jsx` and
  by `NoteList` in `notes/Notes.jsx` — **so the notes list stopped being an `aria-hidden` span with
  four pointer handlers and no other caller (CR-B)**, and gained the `role="status"` line it never
  had. What did NOT go into the hook is what only a list knows: `entryPlaceLabel` stays in
  `routines.js` where the target sheet also reads it, and the focus-follow stays in `EntryList`,
  where the index keying that needs it lives — the notes rows are keyed by `note.id` and need none.
  `.gym-entry-said` became `.gym-said` in the same change, one visually-hidden rule for two lists.
  **A browser found a defect the node harness could not**: a drop that moved fires no trailing click
  on either rail — the row travels out from under the release — so the first shape's "a drag just
  happened" latch stayed armed and ate the next genuine tap. It is now cleared at the start of the
  next pointer sequence as well, and a keyboard activation (`detail === 0`) never spends it.
  **Android's missing draft reorder was NOT built** — ruling S1 makes it a feature the surface owes
  rather than this programme's work, and `3p` now says so.
- **A blank name means one thing per surface, and iOS reads the routine editor's** (**CR-C**). S2a's
  new `Finish.isNamed` trimmed in `.whitespaces` — Unicode `Zs` plus tab, **excluding** U+000A–U+000D
  — while `RoutineDraft.isNamed` one file away trimmed in `.whitespacesAndNewlines`, so `"\n"` was a
  name to the finish card and not to the editor, and both other surfaces said blank. `Finish.isNamed`
  is deleted; `RoutineDraft` states the rule once as `trimmed(_:)` + `isNamed(_:)` and
  `Finish.keepRefusal` and `FinishScreen.unnamed` both read it. The pin now **discriminates the unit
  it claims to pin** — its fixture carries `"\n"`, `"\r\n"` and `"\u{2028}"`, because `""` and
  `"   "` are blank under every unit there is and cannot tell two apart.
- **A successful keep is confirmed on every surface** (**CR-D**). Android drew *Kept as X.* in this
  wave and iOS said nothing at all, so after the toolbar `Done` landed the iOS card silently vanished.
  `Finish.keptAs(_:)` is now byte-identical to Android's `keptAs`, drawn where the form stood in
  Android's size and ink role. The web keeps its transient — it has no sheet covering the room's own
  note line, which is the whole reason the phones need a drawn line.
- **The double tap on `Save routine` is closed on iOS too** (**CR-E**). `keepingRoutine` guards
  `keep(_:as:)` exactly as `savingRoutine` guards `save(_:)`, for the reason Android's pin states in
  surface-neutral words: the log mints no id for a routine — `RoutineWrite(named:from:position:)`
  defaults `id:` to `Ids.routine()` — so a second tap is a second routine and not a replay. **It
  ships closed but UNPINNED on iOS, deliberately.** The UITest walk was written, passed, and then
  **passed again with the guard deleted** (twice: once tapping the element, once tapping the raw
  coordinate to remove the query round-trip), because the keep completes before a second XCUITest
  event can land. Dead-but-green is worse than red, so the two-tap half was cut and only the
  discriminating half — the confirmation line — kept. Ledger `4e` records the seam that is owed
  before a pin is reachable.
- **What S2a did not close.** Ledger `3c` stays **open**: `Finish.jsx` still gates `ShortSession` on
  `review.slight` alone, so an ordinary past workout still has no discard door on the web. Its wording
  about *Session detail and Done and nothing else* is corrected in the same change and no further.

**What S2b landed — the three cuts that name a refusal.**

- **The review band names its gate** (cut 4 and **R4**). The gate's sentence — since N2 *Scroll to
  the end to apply.* — is drawn on all three, byte-identical, in a slot laid out in **both** states so the band's height
  never changes — `APPLY_HINT` / `.gym-proposal-gate` with `min-height: 1.4em` on the web,
  `.opacity(gate.isOpen ? 0 : 1)` on iOS, `.alpha(if (seen) 0f else 1f)` on Android. It is bound to
  the gate **alone** and never to the disabled predicate, so it is silent while an apply request is
  in flight — the defect a hint drawn "whenever Apply is disabled" would have shipped. The screen is
  not the only channel: iOS keeps its `accessibilityHint`, Android gained a `stateDescription` on the
  Apply box, and the web's Apply became `aria-disabled` with a no-op handler plus
  `aria-describedby`, so a keyboard reader lands on the control instead of having it skipped.
  **`documentLine` was trimmed, not deleted** — the board refused the deletion, because `kept`
  requires `*before == after`, so a proposal that retargets every line folds no kept run and the
  candidate's named re-home never renders. It now reads *The whole routine, top to bottom — the
  marked lines change.* and the removal guard stands. **T2 rode with it:** the atomic promise moved
  into the pinned band between Apply and turn-down on the web and Android, so the band's order is one
  order everywhere (ledger `3e` closes). **The band was measured at fontScale 2.0, and it had to be:**
  it stacks four text elements and two tap targets where it stacked three, and Android's band sits
  outside a `weight(1f, fill = false)` scroller with no floor under the diff, so a band that grows
  takes the diff's room. The ordinary Robolectric suite cannot see that — its font metrics are
  stubbed, so nothing in it wraps — so the check lives in its own file under
  `@GraphicsMode(NATIVE)` (`ui/LargestTypeTests.kt`): with the gate SHUT in a 700dp sheet the band
  is 272dp and the diff keeps 317dp, still scrolling, and the case pins a 120dp floor rather than
  the number. **iOS's band is not measured at AX5**, and nothing in that suite covers it.
- **Every delete takes the window** (`13-gestures.md` Law 2) — cut 5 and **R1**. **Six**
  confirmations came off, not three: web and iOS and Android Notes, web and iOS and Android
  Bodyweight — plus Android's relabelling two-tap on the unclaimed shelf, which armed *Not mine* into
  *Delete for good?* with no cancel and no timeout. The only confirmation left over a **delete**, on
  any surface, is turning a proposal down; the one question still asked anywhere in the room is
  iOS's *Discard these edits?* over an unsaved routine draft, which has no window behind it because
  it was never on the wire, and which the web and Android answer by discarding silently (ledger
  `4k`, opened by this wave and undecided). `WITHHELD_KINDS`, `Withheld.Kind` and `Deletion` gained
  `note` and `bodyweight` (and `Unattributed` on Android), and `Deletion.stillThere` became nullable so a
  verb the log cannot refuse says nothing rather than a made-up sentence. The four carried states all
  landed: the notes cap reads the **store's** count so *10 of 10 notes.* stands through the window —
  and follows that count the moment the delete lands, so no surface goes on refusing an eleventh note
  over nine stored (the closing pass's fix on the third);
  the bodyweight hide is one filter in `useBodyweight` / `TrainingStore.bodyweight` / `drawBodyweight()`
  so the log's head cannot draw a weigh-in the chart dropped; the sheet or editor leaves with the
  withhold, and where the thing being left renders OVER the room's transient — the weigh-in sheet on
  both phones — it goes down first: `repairing = nil` before the task on iOS, and on Android the
  `ModalBottomSheet`'s hide is **awaited** before the hold, because an Undo raised under a sheet
  still animating out is an Undo nobody can reach. On the web the order does not bite:
  `.gym-toast-slot` sits at `z-index: 55` over `.gym-sheet-catch`'s `40`; and Android's shelf row
  goes **whole**, with the last-copy fact in the transient's own line — *Unclaimed training deleted —
  it was only on this phone.* **T4 rode with it:** `11-bodyweight.md`'s *Delete this weigh-in?* /
  **Delete** · **Keep it** left in the same change as the code. **Behaviour change, stated:** the
  window abandons non-disk holds when the room leaves the foreground, so a note or weigh-in delete
  abandoned on backgrounding puts the row — and the log's head reading — back.
- **The AI ceiling shares the cap-reached state** and says the sentence it was sent — cut 8 and
  **R3**, ledger `3f`. This **overruled a decision, not a bug**: `09-coach.md` tied the state to the
  daily bucket and three test names recorded the split deliberately. It was overruled because the
  premise under it was false — the cap-reached render preferred a local constant on all three, so an
  account at its 30-day ceiling was told *a couple of hours* over a thirty-day window, which is the
  copy the mission line forbids. The wordless fallback is now selected on the **code** and never on
  the state. **T3 rode with it:** under the account ceiling the connect door is the primary and *Ask
  something new* sits beneath it, told apart on the code rather than on the sentence. **And the
  allowance line came off that variant** — *Ten questions a day, three back to back.* is a promise
  about the DAILY bucket, so drawn above the sentence saying the account has spent thirty days of AI
  it reads as the rule that stopped this question and becomes the one lie in the room. It is drawn in
  the daily variant, where it is true, and not under the ceiling, on all three surfaces; the third
  surface and the brief both moved in the closing pass, and until they did canon agreed with the one
  surface still drawing it.
- **The transient's detail was shortened, and it buys two lines on the web and not on the phones**
  (`3q`, ruling **T1**): *your routine keeps what you applied*, six words, moved on all three at once.
  Measured, not reasoned from a character count. On the web, headless Chrome against the real
  stylesheet in the slot's own geometry, swept 320→430px a pixel at a time: three lines at every phone
  width up to 390px before, **two from 327px up** after. On iOS, hosted and swept a point at a time:
  the six words draw 249 points and the slot beside the 64-point `Undo` holds one line only **from
  402 points up**, so a 390-point phone still reads three — the detail is clamped at two lines rather
  than one, because a disclosure cut off mid-word is not a disclosure. Android's is unmeasured.
  **The ruling's ≤2 lines at 390 is therefore met on the web and missed on iOS, and the words are not
  what is stopping it** — the sentence shares its row with the Undo. `3q` stays open, on the row
  rather than on the copy.
- **What the closing pass landed, and it is six defects a cross-surface read found in S2b's own
  work.** Three were blockers, each on a different surface. **The allowance line under the account
  ceiling** came off Android, the last surface still drawing it, and `09-coach.md` gained the
  exception in the same change (above). **iOS's notes cap now hears the settle**: the screen derives
  a standing list — the store's notes less the ones whose delete has landed — and counts the cap, the
  empty stance, the Add row and the edit handle off it while only the rows read the window, so nine
  seconds after a delete at the cap it draws nine rows and offers *Add a note* again instead of
  standing on *10 of 10 notes. Delete one to add another.* over a way out already taken.
  **Android's note reorder names every note**: `reorderNotes` takes the DRAWN ids and rebuilds the
  order against the standing notebook, putting a withheld note back in the place it stands in — a
  drag inside an open window was sending an incomplete order the log refuses outright
  (`400 notes-order-mismatch`), dead-but-green because no case opened a window before a reorder, and
  the fix ships with the pin. Three smaller ones: **the web's empty-notes stance reads the store**, so
  deleting your only note no longer offers the two onboarding placeholders over a store that still
  holds it; **`threads.js`'s 340px** became the measured **327px**, the fourth time this programme has
  caught one bound written two ways; and **iOS's weigh-in write takes the window down** (`writtenAgain`
  before `weighIn`) rather than leaving a transient offering *Undo* beside a dot the chart is drawing
  again. Its two new refusal clauses took Android's bytes — *that conversation is still here*,
  *that note is still here* — which predate them, because a near-miss pair reads as a typo and not as
  a screen's own words. `13-gestures.md` now says that as a rule.
- **What S2b left alone, and what S3 then took.** Of the two salvages the board kept out of the
  candidates it killed, the **settings captions** landed in S3 on the web and Android. **iOS was never
  owed its part of it**: `SettingsScreen.swift:54` already draws the lb clause under
  `store.preferences.units == .lb`, and that gate is the shape the other two copied — the roll-up
  listing it as owed was reading the example as the debt. The last piece of that salvage — the
  **Android connect card narrowed to `sub`, `free` and `whereItLives`** — landed in S4, so none of it
  is open. S2b itself moved nothing in `products/gym`'s settings copy beyond the shelf's own
  control.
- **The moves the closing rulings left owed** — iOS's `30 days` (`3k`) and both phones' promise
  condition (`3t`) — were S3's opening two and are in the tree. Android's `Delete` and its `30 days`
  landed in S1.
- **Two S2b opened and closed inside itself.** The wordless ceiling fallback was the server's
  sentence on the web and Android and a parallel sentence of its own on iOS; iOS took the other two
  surfaces' bytes, so it is one 110-byte string in three files (`4h`). And a weigh-in written into an
  open delete window was destroyed by the settling delete on the web and Android — the one withheld
  subject whose id a lifter can write again, since it is a calendar date — which is now taken back by
  the write that names the day, iOS having enforced the same ruling by holding the instant (`4i`).
- **Five S2b found; four it did not build, and the fifth it half-built in its closing pass.** Where the cap-reached sentence sits is a phone divergence,
  and both halves are now measured — iOS's on the simulator, Android's under `@GraphicsMode(NATIVE)`
  after its first figure turned out to come from a stubbed harness — but which shape is right is
  undecided (`4g`). The routine draft is asked about before it is thrown away on iOS and eaten
  silently on the web and Android: the one destructive act in the room with no window behind it, and
  the reason the confirmation count is written for deletes (`4k`). The gate's refusal reached a screen
  reader **once on iOS and twice on the web and Android** — `4m` had exonerated the web on a premise
  that was never the reason for its conclusion, since `aria-describedby` does not take its target out
  of the accessibility tree. The web's drawn sentence took `aria-hidden` in both states in the closing
  pass and Android's `Text` took `clearAndSetSemantics { }` in both states in S3, so **all three are
  single-reading** and `4m` is closed. The notes cap now reads the store's
  count, which is the fix cut 5 owed — and for the nine seconds of the window that draws nine rows
  under *10 of 10 notes. Delete one to add another.*, a true count over an instruction naming a way
  out already taken (`4l`, a copy call on all three at once). And the largest-text hazard this
  wave measured on Android is testable on Android alone: iOS's fonts are all `Font.system(size:)`,
  fixed point sizes that do not scale with Dynamic Type, and gym's web stylesheet declares every
  `font-size` in `px` with no `rem` anywhere, so neither answers a reader's own setting and the three
  surfaces may not be read as equivalent on accessibility (`4j`, product-wide rather than gym's).
- **One canon line S2b found false and corrected.** `09-coach.md` said iOS keeps Apply open once
  seen and cited a ledger entry about the rack keypad. Both halves were wrong: `ReviewGate.isOpen`
  is `seenAt == end.inDocument`, so an unfolding kept run re-locks it exactly as the web's
  `seenHeight` and Android's `seenExtent` do, and `ReviewSheetTests`'s
  `testUnfoldingAKeptRunTakesApplyAwayUntilTheNewEndIsSeen` has pinned that all along. The brief now
  states one rule for three surfaces, which is what §3 of this file already said.
- **Two S1 found and did not rule.** Android's inline `Start workout` against iOS's pinned
  one (`3r`) and iOS's three-writer bottom band (`3s`) are one decision about where a phone screen's
  primary sits and what may share its lane. And whether a sign-out clears this device's copy of the
  program (`3w`) is **named, not ruled**: it is device residue, and the direction belongs to the
  security work's owner rather than to a builder.
- **Six S2a found and did not build**, each recorded rather than fixed. *tap to rename* now reads on
  one finish card of three, the web having dropped it and Android never having drawn it (`3z`).
  Two of the six were rulings S3 then built: the ink for *Name it to save it.* (`4a`) and the finish
  card's name cap (`4c`), both described under **What S3 landed** below. `Keep it` is one act with
  two destinations: dismissed in place on the phones, navigated
  away from on the web, and nothing in canon decides it (`4d`). iOS's new guard against a double keep
  has no seam a pin can use, and the pin that was written passed with the guard deleted (`4e`). And
  iOS's movement picker trims a search in `.whitespaces` where the create step it opens trims in
  `.whitespacesAndNewlines` — CR-C's shape one layer milder, on a screen this wave did not own (`4f`).

**What S3 landed — the rulings the programme made and never built, and the two defects it created.**
No cut, no new drawn control, and every item was already specified in `../consistency.md` at the entry
it closed.

- **Three rulings that had been recorded as settled and were not true.** iOS's share window says
  **`30 days`, in numerals** in both consent lines — `LogReach.Level.write.reach` and `canLines` in
  `ConnectedLog.swift` — matching the web's `connect/connect.js` and Android's
  `domain/ConnectedLog.kt` clause for clause (`3k`, closed). **Both phones' proposal promise is now
  gated on the state**: `(found?.state ?? .pending) == .pending` on iOS, `if (proposal.isPending)`
  on Android, so a card reading *Applied* no longer promises that nothing has been applied. A
  DECISION is the only thing that spends it: where the state is not yet known there is no card to
  promise on — the web leaves a bare door and Android leaves the row out — while iOS, which builds
  its card from the id alone, keeps the promise on it, because a read that failed leaves
  `minted[id]` unset for the rest of the visit and an unread proposal is not a decision (`3t`,
  closed). And **the two phones moved *Name it to save it.* to the faint ink** — `skin.inkFaint` on
  iOS's editor footer and on the finish card's unnamed branch, `GymSkin.inkFaint` on Android's
  `missing` and its empty-name branch — because both skins reserve the alarm ink for a failed read
  or write, and an empty name is a precondition not yet met. The log's OWN refusal keeps the alarm
  on both, chosen on the same predicate that chooses the sentence; the target sheet's invalid-field
  refusals keep it too (`4a`, closed, ruling **U1**).
- **The finish card takes the room's cap and not its counter** (`4c`, closed, ruling **U2**). All
  three fields now cut through the editor's own call — `cappedName` on the web (which replaces
  `maxLength={80}`), `RoutineDraft.capped` in an `.onChange` on iOS, `Program.capped` in
  `onValueChange` on Android — so the bound is 60 **code points** everywhere and not 80 UTF-16 units
  on one surface: `🏋️‍♀️` is one thing on screen and five code points, and the two units cut a name in
  different places. **The counter deliberately did not come with it**, and each surface says so in a
  comment beside the field: the counter earns its pixels on the surface a lifter works a name on, and
  a receipt that mints one in passing would be paying drawn chrome in a programme whose subject is
  removing it. `15-the-routine.md` records it as a decision so no later wave reads the gap as drift.
- **A window stopped deciding what state a screen is in** (`4n`, closed, ruling **U3**) — the defect
  this programme created the day `bodyweight` joined `WITHHELD_KINDS`, against the law
  `13-gestures.md:214-215` states in bold. The two surfaces that broke it answer the two questions
  from two lists: `useBodyweight` returns `entries` (the store) beside `rows` (what the window
  leaves), and Android's `TrainingStore` returns `allWeighIns` beside `bodyweight` — iOS's own half
  of that screen came with S4's sweep. The empty stance reads the store; the dots, the fix sheet,
  `latest` and the windowed sentence read the window. **The web's half needed a
  second change to be honest, and it belonged to the room**: `useTrainingLog`'s `settled` register
  is now exposed as `log.gone(kind)` beside `log.hidden(kind)`, and `entries` drops what it names,
  so the day leaves the READ as well as the drawn rows — without it the stance would have been
  suppressed forever rather than for nine seconds, and a record kept per screen would have let the
  chart and the log's head, two instances of one hook, disagree about a day written again. Android's
  half exposed a sentence that had become reachable in a state it was false in: *no weigh-in in the
  last 90 days* is now drawn only under the 90-day window, since under **All** the count line is the
  whole of what is true.
- **Android's gate stopped being read twice** (`4m`, closed). `ReviewSheet.kt`'s drawn refusal is
  `clearAndSetSemantics { }` in **both** states, not only once `seen`, so TalkBack navigating the shut
  band meets the gate's sentence once — on the Apply box's
  `stateDescription`, the control that is refusing. `ReviewSheetTests`'s
  `theShutBandExposesTheGatesRefusalOnExactlyOneNode` pins the count rather than the attribute. All
  three surfaces are single-reading; **still read off the source and the ARIA spec, with no screen
  reader driven for any of it.**
- **One write path owns the weigh-in window's guard on iOS** (`4o`, closed). `TrainingStore` carries
  `dayWrittenAgain` and calls it inside `weighIn(_:on:)`, wired once from `GymRoom`'s seat; the call
  from `BodyweightScreen` is gone, so the log's own weigh-in sheet takes the window down too. It sits
  **after** the date refusal, so a day the store would refuse anyway no longer costs a window — a
  small fix that rode along with the placement.
- **The settings-caption salvage, on the two surfaces that owed it.** **Web:** the clause *a haptic
  where the platform has one, a sound where it does not* is cut, re-verified false at the symbol first
  — `GymConfirm.swift` and `GymConfirm.kt` each honour `confirmHaptic` and `confirmSound`
  independently, so both phones have both — and the refusal that follows it is kept whole, because it
  is the charter and this section renders inside shell settings where none of the room's other homes
  reach. The Rest row's *This page never sounds an alarm of its own.* stops being a restatement inside
  one row and becomes the section's ONE caption above all of them: nine words, inside the ≤12-word cap
  `../guidelines/text-budget.md` sets for a caption on a reference surface — where the budget is per
  row and per group, not the forty-word one a deciding screen answers. The Units lb clause is untouched
  byte for byte, because it is correct *because* it enumerates — *a backfill, a correction, a routine
  target* — which is what excludes the weigh-in, the one field typed in the display unit.
  **Android:** the second Units caption is cut and the lb clause is gated on `units == Pounds` the
  way iOS's is, reading `Bodyweight.kilogramsOnly` instead of restating it as a literal (N2 then
  shortened the constant to *This phone still draws kg.* and cut it from the bodyweight screen, so
  the settings row is its only draw site). The two Rest captions collapse to one, and it is the **override** that is kept: a
  routine's own rest beating the dial is real — `Rest.target` is
  `planEntry?.restSeconds ?: preferences.restSeconds`, so an entry that carries one wins even when
  the dial is OFF, which is what the caption's *off included* names, and `RestTests` pins both
  branches — the number rides the wire on the entry, and this is the only place on that phone the
  fact is said. Being the sole carrier is what earns it a pin of its own:
  `SettingsConnectPitchTests` now asserts the sentence is on the screen, so a later salvage cannot
  cut it with the suite green. The 24-word Set-confirmation caption becomes one line for the
  system dependency, which N2 shortened again and moved onto the row it qualifies — the Haptic
  toggle's supporting text, *Silenced if Android’s touch feedback is off.*
  **Two true facts Android now states nowhere** rode out with those cuts — the wake lock and the
  syncing dials — and are ledger `4s` rather than a silent loss.
- **What S3 opened and did not build**, each recorded rather than fixed. The `4n` law survived on
  **four more web screens** — the log's sessions and its sets, the routines home, and the coach's
  conversations — all reading a window-thinned list for a claim about the account, and the routines
  home was the sharpest because its empty stance carried a drawn primary (`4p`, **closed by S4**,
  which also swept the phones and found the same class on both). The state a held delete of the only
  weigh-in leaves is still answered three ways (`4q`, open, and now a copy call only: S4 took the
  law's residue off iOS, so *no weigh-in yet* is drawn over a series that holds one on no surface).
  iOS's pre-mint share offer still says the window without its numeral, where `3k` ruled numerals for
  the consent screens (`4r`). And Android's wake lock and syncing dials are true and unsaid (`4s`).

**What S4 landed — the law on every surface, the first sweep of the phones, and the last salvage.**
No new drawn control anywhere, and every screen it touched was already named in `../consistency.md`
or found by the sweep it was asked to run.

- **A window decides which rows are drawn and nothing else, on all three surfaces** (`4p`, closed,
  stamped **built 2026-09-01**). Each screen with a drawn stance answers its read TWICE — one list
  is what the ACCOUNT holds, the other what the window leaves — and the stance reads the first while
  the rows read the second. **Web**: `Routines.jsx`'s `program` beside `routines`, with the empty
  stance AND its `Build a routine` primary on `program`; `LogList`'s `sessions` beside `shown`, with
  `LogFoot`'s *first session · …* on `sessions`; `SessionDetail`'s `logged` beside `sets`, with
  `closedOnItsOwn` on `logged`; `ThreadsList`'s `conversations` beside `threads`, with `NO_THREADS`
  and the `Export threads` door on `conversations`. **iOS**: `TrainingStore`'s `allSessions`,
  `allRoutines` and `allWeighIns` beside `recent`, `routines` and `bodyweight`, read by
  `RoutinesScreen`, `LogScreen`, `BodyweightScreen` and `ThreadsScreen` (`standing(_:outside:)`
  beside `drawn`). **Android**: `allSessions`, `allRoutines` and `allThreads` beside `recent`,
  `routines` and `threads`, read by `LogScreen` — its two silences and the *first session* line in
  its foot, which names the day training started — `RoutinesScreen`, and `ThreadsScreen`, whose
  screen-local `var threads by remember` snapshot went with the fix and whose rows are drawn only
  off a read this entry landed, since a failed read is not a shorter list either.
- **The second half is what makes the first honest, and it is owed on all four web screens.** The
  settled delete leaves the READ and not only the drawn rows: the room's `log.gone(kind)` register
  is folded out of the account lists whose own send never re-reads them — `notes/Notes.jsx`, whose
  send does, re-reads inside it instead — or a screen whose last row is deleted draws neither rows
  nor stance: a blank page with no words on it. `SessionDetail` needs it MOST: `dropSet` re-reads
  the log's page and never this session's own read, so without the fold *No sets in this session.*
  would never be drawn at all. Android's `deleteThread` spends the same half by dropping the row
  from `conversations` on the 200 and the 404 alike (`threads()` is `readThreads()` now, because it
  writes what it read); iOS needs none for sets, whose hold is on disk.
- **The claims a window was deciding that are not stances at all**, all found by the sweep. A
  WRITE: the position a new or duplicated routine is filed at, minted off the drawn list on all
  three surfaces — a collision, not only words. A VERDICT, three times: `TrainingStore.apply`'s 404
  branch on a remove-proposal answered `.removed`, *the routine and its ledger are gone*, over a
  routine an Undo still reached; Android's `ReviewSheet` called a proposal superseded off the drawn
  routines; and `Backfill.jsx` refused a span as *already in the log* over a session the
  store had already answered a delete for, with a door into a session the log no longer draws. And a
  FIRST-RUN predicate: Android's `TrainingStore.firstSession` opened the movement picker with *What
  are you starting with?* and a drawn `Build my routine` over a log that still held a workout —
  named by no entry, no board report and no contract before the sweep ran. The boundary kept on
  purpose: **a count captioning rows a reader can see follows the window; a claim about what the
  account HAS does not.**
- **The phones were swept for the first time, and the whole sweep is written down** in
  `briefs/13-gestures.md` beside the law — every screen checked, the clean ones included, so a fifth
  wave does not pay for it twice. Every web `.jsx` file in the room, four defective screens in three of them
  plus `Backfill.jsx`'s refusal, which named a session the store had already deleted; iOS four
  screens plus three non-stance claims and the editor seam nothing reaches today; Android six
  instances, and every other screen on the surface checked and clean.
- **The Android connect card took the third of the salvage the board could defend** — the last
  unbuilt cut anywhere. `sub` (the verbatim `PITCH_LINE`), `free` (re-said by `FREE_LINE` and by the
  kept precondition, which ends *the log stays free either way*) and `whereItLives`
  (`DISCONNECT_LINE` plus the live Connections block plus the header row's own label) are deleted —
  78 words, counted off the deleted string literals by this pass. **The structured can/cannot panel
  stays**, which is what `../guidelines/text-budget.md`'s *short AND structured* asks for and why
  the board refused the wider cut: three of its facts have no destination drawn anywhere on that
  phone. `notNamedHere` was rewritten in the same change because `whereItLives` was the antecedent
  of its *that list*, and N2 then deleted it outright: it explained an absence beside the door where
  the list lives. `onTheWeb` was kept (N2 cut it to its consent half, *Your tool’s first call opens
  the approval screen.*, and put the browser fact on the button's open-in-new glyph), so the
  `onClickLabel` / `say` half of the ruling never fired — a failed browser launch is still silent,
  on both phones, and is ledger `4v`.

**What N1 landed — the platform's own chrome.** Not a cut: one wave of `briefs/12-native-idiom.md`'s
law built under the programme's standing rules — a drawn control comes off only when its act is
re-homed somewhere drawn, each fact is drawn once, and every refusal gets a sentence. Twelve rulings
and six amendments after review; everything below is read at the symbol.

- **iOS sheet chrome is the system's.** Each of the five sheets — `FixSheet`, `JumpSheet`,
  `KeypadSheet`, `RenameSheet`, `ReviewSheet` — wraps its content in a `NavigationStack` and takes
  its title through `.navigationTitle` with `.navigationBarTitleDisplayMode(.inline)`; no
  fixed-point `WindmillFont.display` title remains in a sheet. The dismissal is the bar's
  `.cancellationAction` — `Close` on `JumpSheet` (`:22-23`), `Cancel` on `KeypadSheet` (`:154`),
  `RenameSheet` (`:34`) and `ReviewSheet` (`:31`) — and `FixSheet`'s bar carries the title alone,
  the scrim and the swipe being its dismissal (`FixSheet.swift:302-303`). **The commits did not
  move**: the keypad's `Set` (`KeypadSheet.swift:203`) and `Save the fix` (`FixSheet.swift:306`) are
  drawn in the reach band where they stood, per the brief's *committing actions stay in the reach
  band* — the review narrowed the first ruling back to that. `Rename` is the one commit in a bar,
  `.confirmationAction` (`RenameSheet.swift:37-39`), because a one-field sheet under a keyboard has
  no reach band; the brief's exception list carries it now. Strings byte-identical; detents
  unchanged. `SheetChromeHostingTests.swift` pins the shape. `FixSheet`'s four hand-drawn kind
  buttons are a segmented `Picker` (`:225-231`) beside the RPE picker it already had, both
  `.controlSize(.large)` (`:231`, `:262`) so the pair is one height.
- **iOS Settings is a `Form`** — one `Section` per group with the group's one caption as its footer
  (`SettingsScreen.swift:18`, the sections at `:30-46`, `:59-75`, `:82-91`, `:98`) — titled
  `Settings` by the room (`GymRoom.swift:106`) and by nothing else: the head line *how the room
  behaves at the rack* is gone, and the four UITest classes that keyed "settings is up" on it now
  key on the *Set confirmation* section head (`RoomContainersUITests`, `RoomEdgeGestureUITests`,
  `RoomTapFloorUITests`, `RoomChromeUITests`) — N1 pointed them at the Units footer, and N2 deleted
  that footer.
- **Android sheets dismiss the way Material does.** `RenameSheet` (`:44`), `AssemblySheet` (`:57`),
  the logger-hosted `KeypadSheet` and `CreateMovementSheet` (`MovementPicker.kt:333`) draw no Cancel
  or Close; the act is re-homed on the three paths the platform owns — the drag handle, the scrim and
  system back. **Proven, not assumed**: `SheetDismissTests.kt` asserts for each sheet that exactly one
  node exposes `SemanticsActions.Dismiss`, that invoking it calls `onDismissRequest`, and that the
  scrim commits nothing — the keypad's typed number stands, the rename renames nothing, the create
  step mints nothing and hands the query back. **The one drawn Cancel left** is the keypad's inside
  the fix sheet (`KeypadSheet.kt:219-227`, under `onCancel`, passed by `FixSheet.kt:85`), where the
  pad has taken over another sheet's body and the platform has no handle for *back to that body*
  (`:38-41`). Settings is named by its bar, `Settings` (`SettingsScreen.kt:69`), and its head line is
  gone. Sheet titles keep `WindmillFont.display`: it is sp-scaled (`Tokens.kt:78`), so the amendment
  that would have moved them to `titleLarge` did not apply.
- **The rest target says where it came from, once, on the timer, on all three** (`3g`, closed). The
  unit is `target m:ss` plus the bytes ` · from the routine` when the entry's own `restSeconds` is
  in force: `Rest.Target(seconds, fromRoutine)` and `Rest.fromRoutine` on Android (`RestTimer.kt:11-17`,
  `:35-37`); `Rest.targetLine` and `Rest.fromTheRoutine` on iOS (`RestTimer.swift:11-18`), whose rest
  row gains the target line under the reading it used to draw alone (`LoggerScreen.swift:140`);
  `restInForce` and `FROM_THE_ROUTINE` on the web (`log.js:461-468`), drawn on the mirror's meta as
  *target 2:00 · from the routine* (`Mirror.jsx:66`) where it read *rest 2:00*. Because the timer
  carries the fact, Android's Rest caption sentence about the override is gone
  (`SettingsScreen.kt:115-117` says why) and iOS's source comment on the settings rest row went with
  the `Form`; no settings copy on any surface mentions the override.
- **The web got its discard door** (`3c`, closed). `SessionDetail` draws `Discard session` for a
  finished session (`Log.jsx:348-350`, under `isFinished(session)`) through the same withheld window
  every other web delete takes, with the same landing and the same undo as the routine delete; the
  live mirror draws none, because the phone owns the open session. `ShortSession` on the finish
  screen stays for the slight branch. Pinned in all four directions in `withheldWindow.test.js`.
- **Backfill takes a date, not a chip.** `DAY_CHIP_OFFSETS` and `dayChips` are gone; the screen
  draws `<input type="date">` with `max={dateLocalOf(Date.now())}` (`Backfill.jsx:90-93`) — the
  weigh-in sheet's own field — defaulting to `yesterdayOf()` (`backfill.js:34`), so any day up to
  today is addressable. The screen's two doors to the log collapsed to one: the top `Back` (`:82`)
  stays and the bottom `Cancel` in the save band is gone. `DURATION_CHIPS` is a duration, not a day,
  and stays.
- **Android's routine draft reorders, with no new dependency** (`3p`, closed). Each row in
  `RoutineBuilder.kt` carries a drag-handle icon (`Icons.Filled.DragHandle`, described *Move*) whose
  tap picks the row up and whose tap on another row's handle places it there (`handleTapped`,
  `:244-256`), the handle's own name reading *Move X, 2 of 3 — picked up* and then *Place X at 3 of
  3* (`:258-263`) as the web's `nameFor` does, plus *Move up* / *Move down* as
  `CustomAccessibilityAction`s (`:391-395`) and the move said once on a `liveRegion = Polite` line
  (`:431`) in the web's sentence shape — `"${nameOf(from)}, ${placeOf(to)}"` (`:229`, `rail.js:63`).
  The state is `RoutineDraft.moving(from, to)` (`domain/Program.kt:214`). No long press this wave.
- **`Start workout` is under the thumb on Android** (`3r`, closed): `GymScreen` gained a
  `bottomBar` slot (`ui/GymScreen.kt:68`, `:99`) and the routine screen's primary left the
  `verticalScroll` body for it (`ui/RoutinesScreen.kt:490-504`, the scroll at `:516`, padded so the
  last row is never under the band), matching iOS's `safeAreaInset`.
- **Fixed-list choices on Android are Material's segmented row.** `GymSegmented`
  (`ui/GymScreen.kt:134-138`, over `SingleChoiceSegmentedButtonRow`) draws the bodyweight chart's
  window (`BodyweightScreen.kt:397-398`), Settings' Units and Rest rows (`SettingsScreen.kt:104`,
  `:126`) and the fix sheet's kinds (`FixSheet.kt:181`); strings unchanged, radio semantics the
  platform's.
- **Dead strings died.** Android's `ConnectedLog.head`, `sundayLabel`, `sundayLine`, `mondayLabel`,
  `mondayLine` and `truths` — declared and drawn nowhere since `df03334` — are deleted with their two
  test references (`ConnectedLogTests.everySentence`, the `assertDoesNotExist(head)` in
  `RoutinesScreenTests`).
- **Two small iOS debts.** `MovementPicker.swift:89` and `:158` trim in `.whitespacesAndNewlines`,
  the unit `CreateMovement.swift:131` already used (`4f`, closed). And iOS's consent panel names
  notes among what a read grants — `canLines[0]`, `ConnectedLog.swift:159` — as the web and Android
  do (`3m`'s leftover, closed).
- **The web's coach head holds both doors.** The notes door sits in the head's `gym-coach-doors`
  nav beside the Threads door (`coach/CoachRoom.jsx:70-74`), one band fewer, strings unchanged. And
  the gym-local `Overflow.jsx` is the design system's `Menu` — `web/src/design-system/core/Menu.jsx`,
  exported from `index.js:11`, styled by `.wm-menu*` in `styles/global.css:99-130` — imported by
  `Routines.jsx` from there, its behaviour and its cases moved with it (`test/design-system/Menu.test.js`),
  and `gym.css` carries no `.gym-overflow-*` rule any more. Nothing else in the design system changed.
- **What N1 found and recorded rather than built** — five ledger entries, each described at its id:
  which entry's rest is in force when a plan names one movement twice, where the phones take the
  first and the web falls to the dial (`5h`); Android's Rest group drawing no caption while iOS's
  footer states the app-awake fact (`5i`); Android's assembly sheet drawing no Close where iOS's
  `JumpSheet` keeps one — legal under brief 12 and recorded so it is not re-read as drift (`5j`);
  three refusal sentences for one session discard (`5k`); and the read grant saying `workouts` on
  the web and on one iOS line, `sessions` on the phones' panels, with the weigh-ins named on none
  (`5l`).

**What N2 landed — the quiet logger, and fewer words everywhere.** The owner's ask was two
screenshots of the Lift training screen and *still a lot of text on several screens*. Two halves:
the Android logger rebuilt to a written spec, and a nineteen-row cut table applied on all three
surfaces under the programme's standing rules. Everything below is read at the symbol.

- **The Android logger is the ruled shape**, and `briefs/16-the-workout.md` now carries it in
  words: `Finish` / the routine's name / a settings gear in the top bar; `Set 2 of 4` with its
  target tail and a kind `AssistChip` opening a `DropdownMenu` (`KindChip`) where the four-segment
  row was; a last-time `AssistChip` drawn only with history (`LastTimeChip`, the coming Nth working
  set from `LiveLines.lastTimeSet`, the whole old card spoken and its sets in the menu) and a
  disabled *didn’t load* chip for a read that missed; a clocks row — counting-up rest, ring, target —
  that is one node speaking the old label's bytes (`Clocks`, `"${rest.label}  ·  ${rest.time}"`),
  with *from the routine* drawn under it only when the entry's rest is in force; the stranded band
  and the refusal rows kept; a horizontal strip of logged-set pills (`LoggedStrip`, `SetPill`) each
  a door to `FixSheet` in the logger's own sheet (`LoggerSheet.Fix`), the cloud-off glyph speaking
  *on this device*; the dots and `+` pinned above the hairline (`Walk`, *Movement N of M*, *Add
  movement*); and the rack — `Weight`, the numeral with its unit, four equal ladder pills from the
  golden (`LadderRow`), `Reps` between two 64 dp `FilledIconButton`s (`RepsRow`), a full-width
  `Log set` with no echo (`LogButton`). **The store learned to fix what it still owes**:
  `TrainingStore.fixSet` and `deleteSet` rewrite the live session's queue, so a set the log has not
  taken yet is corrected in place and the corrected body is what the walk sends
  (`TrainingStoreTests`). Deleted with their tests: `LiveLines.Counter` and the `plan` half of
  `counter` (it answers the count string alone now), `GymType.movementHead`, `prefillCard`'s
  first-time branches (it answers null for no history), the picker subtitle *the session is already
  running*, `SET N`, `MOVEMENT N OF M`, `no target`, the `Log set  ·  20 × 5` echo. Two sans roles
  joined `GymSkin.kt` — `GymType.reps`, `GymType.primary` — and the four glyphs the screen needed
  from Material's extended set are drawn from their own path data rather than pulling the artifact
  in. **iOS's logger was not redrawn** and is ledger `5m`.
- **`Session · no routine` is `Free session` on all three** — `NO_ROUTINE` (`log.js`),
  `Readout.noRoutine` (`Readout.swift`, `Readout.kt`) — the log's rows, the finish sheet and the
  logger's title reading the one constant.
- **The cuts, by the spec's row number, with the bytes that landed.** #1 *Ask about your training.
  Coach can propose a routine change — you decide on the diff.* (`Ask.whatItIs` on Android,
  `Ask.scope` on iOS; the web has no twin of the paragraph). #2 the open line *You decide the
  numbers at the rack.* is drawn on the **target sheet only** on all three — the list draw sites,
  `hasOpenEntry`, `TargetEntry.openLineUnder` and the `RoutineRow` protocol are gone. #3 Android's
  unattributed shelf: *Logged before any sign-in. Nothing joins an account until you say it is
  yours.* #4 `ConnectedLog.onTheWeb` = *Your tool’s first call opens the approval screen.*, and
  `Connect my log` carries an open-in-new glyph named *opens in your browser*
  (`ConnectedLog.opensInBrowser`). #5 *One training day, written down.* on all three routine
  empties. #6 *Sign in to claim it — it opens on the web too.* on both phones' claim cards, the iOS
  card being the sign-in button itself. #7 the three decimal hints are gone — `DECIMAL_NOTE`,
  `DECIMAL_HINT`, `WEIGHT_HINT` on the web; `TargetEntry.decimalHint`, `Bodyweight.hint`,
  `KeypadEntry.weightHint` on iOS; `TargetEntry.decimalHint`, `Bodyweight.fieldHint` on Android —
  a valid weight's line is `kg`, and `±` is named *Flip the sign — band-assisted* on the keypad and
  the target sheet of every surface. #8 *Display only — nothing stored changes.* is gone from all
  three; the phones draw *This phone still draws kg.* under Units, lb only, and nowhere on the
  bodyweight screen or the weigh-in sheet; the web keeps *A backfill, a correction, a routine
  target — typed in kg.*, lb only (`5n`). #9 *Silenced if Android’s touch feedback is off.* as the
  Haptic row's supporting text. #10 *Coach reads your notes, not your settings.* is gone from every
  surface (`SETTINGS_LINE`, `Settings.coachReads`, `Notes.settingsLine`); the settings Notes door
  reads the notes' own line *what you write for Coach*. #11 the log empty's second line is gone on
  all three. #12 the gap rule is gone from the chart on all three (`GAP_RULE`, `Bodyweight.gapRule`;
  `DotChart` lost its `rule` prop). #13 `ConnectedLog.notNamedHere` deleted. #14 a `CSV export` row
  with supporting text *on the web* on both phones, a door to the web's `#/settings` page — iOS a
  `Link`, Android a `ListItem` with the open-in-new glyph (contract N2-3: never the fifteen words).
  #15 *Have a written program? An agent can build it — sign in first.* on both phones (iOS's
  signed-in branch ends *connect it to this log.*). #16 and #19 *e1RM needs your account — sign in
  for the chart.* (`Record.kt`, `RecordScreen.swift`), drawn only where a load above zero exists
  and the estimate is still missing; where no working set carries a load, both phones draw nothing
  (`Record.noEstimate` null, iOS's `noChart` nil for `.unloaded`). iOS's other three no-chart lines
  shortened to one clause each.
  #17 `applyHint` / `APPLY_HINT` = *Scroll to the end to apply.* on all three. #18 *Removes the
  routine from your program · every logged set stays.* on all three. Two iOS-only cuts of the same
  kind: the rest footer to *A rest that ends while the phone is locked ends quietly.* and the
  record screen's never-logged line to *A working set starts the record — warmups count toward
  nothing.* Kept, as the spec ruled: `$routine keeps its own numbers`, *Today's weights become next
  week's targets.*, *Top note wins.*, every consent block on the connect card, and every refusal.
- **Every dropped string left its domain file with its test** (contract N2-4): assertions moved
  with the strings, none deleted to pass. The six iOS UITest classes that walked cut bytes were
  repointed — the four that keyed "settings is up" on the Units footer now key on the *Set
  confirmation* section head — and the fix-sheet walk finds the sheet by its navigation bar.
- **Docs corrected in this pass**: `briefs/15-the-routine.md` (decimal hint, the open line's one
  placement, the sign's spoken name), `briefs/16-the-workout.md` (the kind control's cite, the
  logger's ruled shape, the keypad's words, the queue-behind open item), `briefs/09-coach.md`,
  `briefs/10-notes.md`, `briefs/11-bodyweight.md`, `../PRODUCT_LOG.md`; ledger `2p` closed, `4m`,
  `4s`, `4v` and `5i` re-cited, `5m` and `5n` opened; and the stale lines of this document above.

**What the programme owes, in full.** The board's list is finished, S3 closed the debt the first
three waves recorded and never built, S4 closed the last defect the programme created and took the
last salvage, N1 closed six entries under the programme's own rules, and N2 closed `2p` and opened
two — so this is everything S1, S2a, S2b, S3, S4, N1 and N2 opened and did not close. **There is no unbuilt *cut* left anywhere.**
Everything below is a ledger entry, and `../consistency.md` carries each one's evidence.

- **A build is owed, on a named surface** — `3l` (iOS's two proposal cards, and the wire behind the
  conversation rows) · `3x` (Android says the log went quiet for a log that answered with a reason)
  · `4e` (iOS's double-keep guard is in the tree and nothing can pin it: what is owed is the seam,
  an injectable store on `GymRoom` or a launch argument that slows the write) · `5m` (iOS's logger
  follows the Android shape N2 ruled — the kind menu, the last-time chip, the clocks row, the pill
  strip, the pinned dots, the equal ladder, `Log set` with no echo).
- **A ruling or a copy owner is owed** — `3b` · `3j` · `3q` · `3s` · `3u` · `3w` · `3z` · `4d` ·
  `4g` · `4j` · `4k` · `4l` · `4q` · `4r` · `4s` · `4u` · `4v` · `5h` · `5i` · `5k` · `5l`. Two of
  them are not gym's to answer alone: `4j` is product-wide, since two surfaces of three do not answer
  a reader's own text size at all, and `3w` is device residue, whose direction belongs to the
  security work's owner. The three S3 opened are all copy calls: the gap state a held bodyweight
  delete leaves (`4q`, and `4p` has just given that gap four more instances), whether the numeral
  rule reaches the pre-mint share offer (`4r`), and whether Android's wake lock and its syncing
  dials get a line of their own (`4s`). The two S4 opened are both about reach rather than words:
  how far a delete's window reaches beyond the screen the act was taken on, where the web and the
  phones already differ (`4u`), and whether a door that hands the lifter to a browser owes a
  sentence when no browser comes (`4v`). The four N1 opened are one ruling and three copy calls:
  which rest a twice-named movement runs at (`5h`), whether Android's Rest group owes a line — the
  wake lock would be the honest one, and closing `4s` closes this (`5i`), one sentence for a refused
  session discard (`5k`), and one word for the thing a read grant reads, with the weigh-ins named
  (`5l`).
- **Closed, nothing owed** — `3a` · `3c` · `3d` · `3e` · `3f` · `3g` · `3h` · `3i` · `3k` · `3m` ·
  `3n` · `3o` · `3p` · `3r` · `3t` · `3v` · `4a` · `4c` · `4f` · `4h` · `4i` · `4m` · `4n` · `4o` ·
  `4p` · `5j` · `5n`. Named here so no later wave re-opens one of them by reading its heading
  alone. `5n` is N2's, recorded as legal under brief 12 the way `5j` was: the web's and the phones'
  lb-only Units sentences differ because the surfaces' conversion does. `3c`,
  `3g`, `3m`, `3p`, `3r` and `4f` are N1's and carry a **built 2026-09-02** stamp; `5j` is recorded
  as legal rather than built. `4p` is S4's and carries a **built 2026-09-01** stamp; it is the widest
  of them, since the sweep behind it closed the same law on both phones as well as on the four web
  screens the entry named. The seven S3 closed carry a **built 2026-08-31** stamp and the symbols
  that now agree, which is `../consistency.md`'s own rule for a landed fix — an entry is deleted
  outright only when it turns out to have named no real divergence, the way `3y` and `4b` were.
  `3d` closed
  in the closing pass and closed as a **stale entry**: it described the web as abandoning a held
  delete on the room's unmount alone, and the tree has watched the tab for the window since
  `8104def` — a hidden document calls the same `abandon`, pinned by three cases in
  `withheldWindow.test.js`. The web's trigger is the phones' trigger, so `13-gestures.md`'s
  foreground rule is true of all three surfaces as written.

**Two of the open ones are worth stating in words, because a claim in the other direction is easy to
make.** §7's ruling
on whether the custom keypad comes off the web's fix sheet at all is open — all that has changed
there is what the sheet's scrim means. And a routine draft is still eaten silently on two surfaces:
the web's `Back` is a plain anchor (`Back.jsx` renders one `<a>`, and `RoutineEditor` hands it
`ROUTINES_HREF` and no handler) and Android's is `BackMeans.LeaveTheDraft -> building = null`, while
iOS asks *Discard these edits?* — so *a draft that cannot be eaten silently* is true of one surface
of three. That is ledger `4k`, opened by S2b and undecided: an unsaved draft was never on the wire,
so the window Law 2 answers every other destructive act with has nothing to hold.

**The suites.** The totals below are N2's, against the tree as it now stands — every N2 source edit
on all three surfaces included. The baselines are the tree at `cdb8e2c`, the commit N2 was built on,
as the wave contract recorded them: web 1650 · iOS `WindmillGymTests` 734 · Android 872 per
variant. Three things a runner has to know. Android needs its JDK named: `/usr/libexec/java_home -V` lists 1.8
alone and the toolchain Gradle builds on is the one it provisioned for itself, so the gate runs with
`JAVA_HOME=~/.gradle/jdks/eclipse_adoptium-21-aarch64-os_x.2/jdk-21.0.7+6/Contents/Home` and fails
configuration without it. **iOS's alarm-pixel reader lives in one file of its own** —
`Tests/WindmillGymTests/AlarmInk.swift`, which SwiftPM picks up by globbing the directory: both
`FinishSheetRefusalHostingTests` and `RoutineScreensHostingTests` call its `alarmPixels(of:)`, so
neither hosting suite compiles without it. And **the iOS device is `iPhone 17 Pro`, not `iPhone 17`**:
CI resolves its simulator by capability and picks the Pro, and `4t` is what a run on the other device
costs.

- **web** — `cd web && npm test`, run by this pass: **1650 tests, 1650 pass, 0 fail**, against
  1650 at `cdb8e2c`: cases moved with their strings and none was added or lost. Seventeen test
  files changed — the keypad's unit line and sign name in `logger/entry.test.js` and
  `logger/rackKeypad.test.js`, the open line's one placement in `screens.test.js`,
  `targetSheet.test.js` and `targetSheetDraw.test.js`, the gate's sentence in
  `ProposalReviewDialog.test.js` and `proposals.test.js`, the chart without its rule in
  `design-system/DotChart.test.js` and `bodyweight/*.test.js`, `Free session` in `log.test.js` and
  `withheldWindow.test.js`.
- **iOS package** — `xcodebuild -scheme WindmillKit-Package -destination 'platform=iOS
  Simulator,name=iPhone 17 Pro' test` from `apps/ios/WindmillKit`, `DEVELOPER_DIR` on Xcode, the
  builder's gate run and **not re-run by this pass**: **TEST SUCCEEDED**, `WindmillGymTests`
  **733 cases, 0 failed**, against 734 at `cdb8e2c` — one fewer, net: four cases went with their
  strings (the Ask empty state's old paragraph, the Notes settings line, the open line's two
  list-placement cases) and three took their place (the two-sentence empty state, the open line as
  the target sheet's alone, an open row named by its empty sets). Eleven test files moved with
  their strings: `AskTests`, `BodyweightTests`, `KeypadSheetTests`, `LogScreenTests`, `NotesTests`,
  `ProposalTests`, `ReadoutTests`, `ReviewSheetTests`, `RoutineBuilderTests`,
  `RoutineEditorCopyTests`, `SheetChromeHostingTests`.
- **iOS UITests** — seven classes edited by N2 for the cut bytes: the four that key "the settings
  screen is up" (`RoomContainersUITests`, `RoomEdgeGestureUITests`, `RoomTapFloorUITests`,
  `RoomChromeUITests`) now key on the *Set confirmation* section head, `RoomRoutineCopyUITests`
  asserts the open line is drawn on the sheet and never beneath a list, `RoomFixSheetUITests` keys
  on the keypad's `kg` line and the sign's new name and finds the sheet by its navigation bar, and
  `RoomUndoWindowUITests`' comments read `Free session`. Six classes were run on the simulator by
  the iOS builder — `RoomContainers` 10, `RoomRoutineCopy` 7, `RoomEdgeGesture` 7, `RoomTapFloor` 1,
  `RoomChrome` 1, `RoomFixSheet` 2, all green — and **not by this pass**; the rest of the scheme was
  not run this wave. These walks have no fake wire — `WMApiBaseURL` is empty, so they drive the real
  account at real speed.
- **Android** — `./gradlew build` (the CI-shaped gate, `:gym:test` plus the release variant) from
  `apps/android` with `JAVA_HOME` on the provisioned JDK 21, the wave owner's run after the last fix
  pass: **896 tests per variant, 0 failures, 12 skipped**, against **872** at `cdb8e2c`. The total is
  the JUnit XML under `apps/android/gym/build/test-results/` summed across all **94** classes per
  variant, read off disk by this pass (stamped 23:21, 2026-09-02) rather than off a console tail;
  the logger's builder was still editing spacing when it was read, so a later run may differ.
  Twenty-one more: `store/TrainingStoreTests.kt`'s cases for the live queue's fix and delete,
  `ui/LargestTypeTests.kt`'s logger case on a 360 × 780 frame at font scale 1.3 (`Log set` inside
  the window, the ladder labels unclipped), `ui/SettingsConnectPitchTests.kt`'s
  cases for the shortened consent lines and the CSV door, and the moved assertions in
  `LoggerRestTargetTests` (content description, same bytes), `LoggerMovementWalkTests` (*Movement 1
  of 3*), `LiveSessionTests` (the counter's one string, `lastTimeSet`, the null card),
  `RoutineEditorTests`, `TargetSheetTests`, `TargetSheetSignAndClearTests`, `KeypadEntryTests`,
  `FixSheetKeypadTests`, `BodyweightScreenTests`, `ProgramTests`, `ProposalTests`, `RecordTests`.

Everything else this section states is read off the tree at the symbols it names, in the same way as
the rest of this document.
