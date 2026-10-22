# Design consistency

Open disagreements between drawings, the written rules and code, and the questions they leave for
the owner. Remove an entry when its fix lands; current behaviour belongs in the code. Source checks
establish code shape, not rendered acceptance. Figma review tasks below need a fresh file inspection
before editing.

## Shared system

- **F4 · Gym Daylight PR ink.** Web and the [approved specimen](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=874-7735)
  use gold-700 `#6E5217`; Android `GymSkin.kt` still uses `#A17822`. Align Android and check native
  PR rows. iOS's shared `gym/record` asset uses gold-700 in Daylight.
- **F7 / F29 · Mono weights.** `web/src/styles/fonts.js` loads JetBrains Mono 400/500/600.
  Gym and journal CSS request heavier mono weights. Normalize the uses or supply the faces.
- **F8 · Unused numeral tokens.** `gymTokens.css` declares `--weight-size`, `--weight-leading`
  and `--reps-size`; no web rule consumes them. Remove them or give them a real consumer.
- **4j · Text scaling.** Check iOS layout reflow against the shared Dynamic Type ramp and
  web text resizing across the gym's pixel-sized type.
- **Published clay tokens.** Reconcile Design System `surface/card` dark mode with web's
  `#171719`. The recorded published value is `#17120B` (`VariableID:1:66`, key
  `f5e7a675adcd56fc6c985da0c7d8341fca46caac`). Gym's local `shell/clay/*` aliases must remain
  until shared imports resolve consistently. Verify `border/subtle` and `text/tertiary` imports too.
- **F52 / F54 · Figma components.** Rename Room Switch Button text layers by role;
  add sheet-radius tokens where needed.
  Shared component typography and mixed prose/numeral runs must not be flattened into one Gym style.
- **F5 / 1w · Unused glow.** Audit the Gym library's Daylight `glow/set-done` values and remove
  unused bindings. Daylight web has no set-done glow.

### Sync engine

Spec: [Windmill sync engine](../foundation/engine.md), built in the server and the web, iOS and
Android clients; every gym and journal surface writes through it. Canon states the owner's rulings
of 2026-09-26 on its lifecycle; the entries below are where an app still differs from them.

- **7a · Leaving the app.** Canon (engine §7.3; owner ruling 2026-09-26): a held delete is stored on the device. Leaving the app — Android to the background,
  on the web no Windmill tab visible past a short debounce or
  the last tab closing — lets it go into the queue, which sends it when it can, and Undo is not
  offered on return. A screen recreated in place keeps the Undo with its remaining time; sign-in lets
  holds go before its question, and a discarded room's go with it unsent; a hold cut off by the
  process dying is let go on the next start. The web's engine-held deletes follow this: the engine
  stores and releases them, and the gym room draws their Undo from the engine's offers
  (`useTrainingLog.js`). These holds still go the other way, putting the row back and sending
  nothing: the web's Coach conversation delete, a REST call held in the gym room's memory, when the
  document hides or the room unmounts; Android's holds, which are in memory, on `ON_STOP` and on
  disposal (`GymRoom.kt`, `abandonWithheld`). The phones hold no delete at all
  (`guidelines/system-architecture.md` §3), so Android's holds are build drift (11b).
- **7c · Sign-out.** Canon (engine §7.10; owner ruling 2026-09-26): signing out takes the
  account's synced data off the device. When the account has not confirmed some changes, the
  confirmation states how many and offers **Keep** (hidden on the device, sent at the same
  account's next sign-in) or **Discard** (destructive, from this device only), and Where to
  start?'s signed-out line has a kept-changes variant.
  - The copy must stay within what the engine can guarantee. The count is ready plus sent entries,
    and a sent change may already be in the account, which Discard cannot recall; so the alert
    says *haven't been confirmed* and *discard them from this phone*, never *for good*.
  - Owner ruling 2026-10-22: both phones confirm sign-out (*Sign out?* / *Your log stays in your
    account and leaves this phone.*; iOS names pages and log) and ask Keep / Discard with *3 changes
    haven’t been confirmed by your account yet. Keep them on this phone until you sign in again, or
    discard them from this phone.* Android signs out at once and always keeps (`plat/you/YouSheet.kt`,
    `store/GymEngineSession.kt:122`); iOS asks in these words (`AppModel.signOutMessage`).
  - The web asks for journal and gym with the count, Keep and Discard (`SyncDecisions.jsx`), but on
    sign-out or any change of account it wipes the account's roadmap trees from the browser,
    unsynced edits included, with no warning: `accountChange.js` calls each product's
    `forgetDevice`, and the roadmap's (`routes.js`) runs `forgetDeviceTrees` (`localTrees.js`),
    which deletes every account-stamped registry row, sync blob and per-tree store.
  - Figma: Shell iOS 16c `2:2031` and 16e `45:3936`, Shell Android 16c `52:1053` and 16e `52:1127`;
    16d's signed-out line is *Signed out.* The first-run READ ME (`2:984`) still lists sign-out with
    unsent changes as open question 6. The web's confirmation is not drawn.
- **7d · Signing in with local data.** Canon (engine §7.10; owner ruling 2026-09-26): work made signed in belongs to that account and syncs without asking. Work made signed
  out joins silently in a room where the account holds no records of its own; where it does, sign-in
  asks once — *Add to your account?* with real counts, **Add** · **Discard** of equal weight, no
  default and no "later". **Discard** opens a destructive second confirmation whose Cancel returns
  to the question. Another account's work never joins. The apps differ:
  - Silent adoption where canon asks. The web roadmap adopts every signed-out tree on this device,
    adding it beside the account's (`claimLocalTrees.js`).
  - Android uses the engine's one-time **Add** / **Discard** sign-in decision with real pinned
    counts, including retained refused workouts. Finished anonymous workouts become durable strict
    imports before adoption; an account's open workout does not block them. Unfinished workouts
    never join another automatically: they stay inspectable with explicit **Keep**, importing them
    finished at their last set. Refusals survive restart and remain retryable; dismissing a notice
    never removes workout content.
  - Figma: both phones draw the question in one wording (owner ruling 2026-10-22): *Add to your
    account?* / *This phone has 3 workouts from before you signed in. Your account already has
    training. Add them, or discard them from this phone.* / *Cancel sign-in* · *Discard* · *Add*, and
    its confirm *Discard 3 workouts?* / *They are deleted from this phone. You can’t undo this.* (Shell
    iOS 23d `2:2940`, 23f `49:4140`; Gym Android 07.4 `1254:33533`, 07.5 `1254:33632`); the nouns follow
    what the phone holds (12n). iOS asks in these words (`AdoptionQuestion.swift`); Android words it
    differently (`app/MainActivity.kt:287-304`). The first-run READ ME line `2:1029` still says
    signed-out work *moves to the account on sign-in* with no question.
- **7g · Notes account-only.** Signed out, Notes is a sign-in door, and the signed-out Coach greeting
  (boards 01.1–01.2) offers saving notes only after sign-in; `../foundation/mobile/gym_coach.md`
  Appendix C gives `save_note` `seats: any`, so a signed-out Coach turn could write one. Rule which
  holds.
- **7i · A weight at the bound.** Web and Android refuse 19.996 kg against the 20 kg minimum. Under
  the engine a commit rounds to the quantum (0.01) and admission checks the rounded value (A.2
  `weighin` `kg` 20–400; engine §7.1 step 4), so 19.996 is saved as 20.00. Rule whether the sheet
  accepts such an entry as 20 or refuses it before rounding, and align the clients.
- **7j · A write this device cannot store.** Canon names no sentence for an engine write that the
  device's own store fails (a full, closed or failing IndexedDB). The web gym ends the act's sentence
  with *this device couldn’t store it* (*That set is still in the log — this device couldn’t store
  it.*; `web/src/products/gym/errors.js` `failureReason`) and keeps *the log didn’t answer. Try again
  when you have signal* for its REST doors. The journal says *not saved — no room on this device*
  (`Canvas.jsx`) for every failed save, which claims a full store when the store may be closed or
  failing instead. Confirm one storage sentence for both products.
- **7k · A guard read beside a write.** `../foundation/domain-kit.md` §8.3 rule 2 refuses a plan in
  which two operations name one record. Android's kit counts a `guardRead` among them (`Plans.kt`);
  iOS's counts only writing operations (`Translation.swift`), and the iOS gym relies on it: saving a
  workout's deviation guards the routine's `revision` with a `guardRead` and updates the same
  routine in one plan (`SaveWorkoutDeviation`, `WorkoutState.swift`). That plan goes with the
  deviation question (12a). Rule whether a guard read may accompany a write to its record before
  another plan needs it, then align the kit spec and both kits. Owner: domain kit.

### Durable draft adoption on native clients

The owner ruling in domain-kit C.2 and engine §7.10 requires device-only drafts to participate in
sign-in and keeps distinct colliding writing recoverable. Web and the reference implement that
contract. Native lifecycle follow-ups remain: iOS `SyncReplica/Lifecycle.swift` gates adoption on
outbox entries and keeps the destination row on a device-key collision; Android
`sync/engine/Lifecycle.kt` counts device work but also keeps the destination row on collision.
Their owners need collision-safe transfer or a refusal that preserves both replicas. These are
source-review findings; native sign-in behavior has not been exercised in the web journal gate.

### Sign-in doors

Canon: `backend/AUTH.md` "Identities" and the Figma section
[4b · Apple sign-in · one account](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-2878).
Apple sign-in is off in every build, so no surface draws it yet.

- **8b · The fork-guard footnote.** Boards 14, 02b and 16a carry no footnote;
  `AccountSheet.swift` `authDoors` still draws *Signed up with email before? Use email, so it stays
  one account.* Remove it in the change that ships 23a, never before: until then it is the only
  guard.
- **8e · "Expired" for a typo.** Board 23e (section 4b) answers a wrong, expired or used code with *That code didn't work* · *Check the digits, or send a
  fresh one.* `AuthApi.cpp` answers *That code has expired* · *Codes work once and last 15
  minutes.*, pinned by `AuthApiTest.cpp`; Android `Auth.kt` `expiredCode` keeps its own *expired*
  sentence; iOS `NativeAuth.exchange` shows *Can't complete sign-in right now* for every refusal,
  a wrong code included.
- **8f · How you sign in, everywhere.** Boards 24a–24d (section 4b): every surface lists the
  account's doors, which `GET /v1/me` returns as `signInMethods` and iOS You lists under **How you
  sign in**. Web `ProfileSection.jsx` reads *Magic link to {email}* and *Continue with Google —
  coming soon.* while `SignInDialog.jsx` already offers Continue with Google; Android `YouSheet.kt`
  lists no doors.
- **8g · Web Google forks the same way.** On the web, a Google address that differs from the
  account's creates a second account with no question. Decide whether Continue with Google asks
  *Already on Windmill?* too.
- **8h · The room in the sign-in question.** Canon (Shell iOS 23g–23j): one question names every room
  due by kind, *This phone has 2 workouts and 3 journal pages from before you signed in. Your account
  already has training and journal pages. Add them, or discard them from this phone.*, and one answer
  covers them all; iOS follows it (`AdoptionQuestion.swift`). The web asks one room at a time in the
  older words, *… are only on this device, and your account already has … Add them, or discard them
  for good.* (`web/src/shell/auth/SyncDecisions.jsx`). Two iOS states are not drawn: one item confirms *It is
  deleted from this phone.*, and a phone holding only unnamed kinds (settings, movement names) counts
  its records as changes, *This phone has 1 change from before you signed in.*

## iOS

`apps/ios/App` carries the Journal room and the Gym room on the engine, with the workout Live
Activity. First-run drawings: the Figma pages
[Shell · iOS](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=1-5) for shared
first-run and account boards, and
[Gym · iOS](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-2)
for the canonical Coach-led flow, indexed in [the flow index](../index.md). Colour roles are
[`ios/ios-redesign.md`](ios/ios-redesign.md) §2.

- **6k · Backend: signed-out Coach.** Anonymous onboarding uses a separate installation boundary. The USD backend
  implements anonymous $0.05 lifetime, verified free $0.25 per UTC month including associated
  anonymous spend, and One $7 per funded period. Owner grants use calendar months. Free access
  shares $100/month and $5/day; paid funding is isolated. The launch identity is a server-issued
  installation credential with IP limits; it does not promise persistence across resets.
  Onboarding creates bounded local routines from one model call. The broader phone tool-host
  protocol remains separate work. Per-request input estimates are approximate and settle to actual usage. See
  [the mobile specification](../foundation/mobile/gym_coach.md) and
  [backend contract](../../backend/AI_ALLOWANCES.md).
- **6u · USD allowance drawings.** Canonical Coach onboarding (`1081:565`) uses the $0.05 lifetime
  installation allowance and current free/funded policy. Account · Usage · Proposal and
  Roadmap · AI requests · Proposal still need the current policy, which `backend/AI_ALLOWANCES.md`
  states in USD. Replace remaining drawing question/credit
  figures with server-backed USD and period labels. Customer usage drawings must show
  held/uncertain usage, free daily-pool pauses, individual exhaustion, request-capacity refusals
  and concurrency. Anonymous lifetime allowance has no reset; One billing periods can cross a
  calendar boundary. All hosted AI, including background Echoes, consumes the individual budget.
  Signing in binds the device and includes its current-month anonymous spend in free usage.
  Server-issued installation credentials are implemented; customer USD screens remain unbuilt.
- **6l · Backend: signed-out routines.** Coach creates routines on the server for an account.
  Signed out they must land on the phone with a stable, retry-safe identity and be adopted once on
  sign-in under the sign-in rule (7d), without duplicates.
- **6m · Backend: signed-out photos.** A sent photo is kept in private storage with the account's
  conversation. Signed out it must be sent inline for Coach to read and not persisted server-side;
  the phone keeps the only copy.
- **6n · Backend: the conversation on sign-in.** A signed-out conversation must move to the account
  on sign-in with the same identity, receipts included, so the chat continues where it stopped.
- **6w · Keyboard bars on iOS 26.** On iOS 26 a SwiftUI `.keyboard` toolbar, once shown, leaves
  later sheets' keyboard avoidance 82 pt short: after the routine targets' bar, the weigh-in sheet
  drew *Save weight* under the decimal pad. The iOS boards draw no keyboard toolbar: Coach's *Done*
  is a glass circle above the composer, the note editor has none, and Targets commits from its bar. The app draws *Next* and *Done* as `KeyboardBar` in the bottom inset
  while a routine target's field is focused; align that sheet.

### iOS against the drawings and the other phone

The Gym file's iOS page is the target (10o). These are the places it, the iOS build, older drawings
and Android disagree.

- **9a · Light gym accent.** Android's Daylight skin still uses iris `#4C4374` (F44),
  while its onboarding glimpse uses verdigris `#137A6C`. Figma's shared Gym light brand is
  `#137A6C`; its native `ios/gym/accent` is `ios/ios-redesign.md`'s darker `#106B5F`. Align Android's
  skin and glimpse with its intended platform accent.
- **iOS gym and shell day contrast.** `ios/ios-redesign.md` §2 and the iOS build use the light values the owner
  adopted for text: `gym/accent` `#106B5F` (5.19:1 on `gym/canvas` · 5.92:1 card · 4.60:1 raised ·
  white on it 6.38:1), with `accent-soft` tracking it, and `shell/brand` `#9F5B38` (4.79:1 on
  `shell/canvas` · 5.21:1 card · 5.04:1 raised). Darkening clay brought it within ΔE2000 6 of the
  brick `shell/danger` `#A84E35`, so on You *Done* and *Sign out* read as one colour; §2
  moves `shell/danger` to a red brick, `#A62B2B` light (6.43:1 on `shell/canvas`) and `#F2685A`
  dark, ΔE2000 14.8 and 15.3 from clay. `gym/alarm` keeps `#A84E35`: no clay sits in the gym
  room. The other surfaces keep the earlier values:
  Android's onboarding glimpses draw the gym accent `#137A6C` (`OnboardingGlimpses.kt`,
  `OnboardingPager.kt`), and the web's clay and roadmap `--color-brand` is `#BC6C42`
  (`--accent-terracotta-500`). Figma Theme roles `ios/gym/accent`, `ios/gym/accent-soft`,
  `ios/shell/brand` and `ios/shell/danger` use the iOS values.
- **9c · Sets have no type (build drift).** The owner removed set types from the product; canon and
  the Gym boards state none. The shared gym vectors and the iOS, Android and web domains count every
  set as a working set and read a stored `kind` only to ignore it. Still carrying a kind:
  Android's app layer, whose kind no longer reaches the log — `SetKind` (`gym/domain/Training.kt:17-23`),
  `FixSheet.kt:249` passing a set's kind through, the logger indexing warm-ups *W* in faint ink
  (`LoggerScreen.kt:770-781`, `LiveSession.kt:74,146-151`), workout detail printing the wire *warmup*
  / *drop* / *failure* as a set note (`SessionScreen.kt:128`), the Record's recent sets appending it
  (`domain/Record.kt:40-43`) and the saved-workout recovery's *Choose set kind*
  (`SettingsScreen.kt:240-242,268,293-308,370-383`), none of it on the Android boards (03.1, 03.3,
  05.3, 05.6, 07.2, 07.3); the web, whose new-set rows carry a dead `kind: 'working'`
  (`WorkoutEditor.jsx`, `backfill/draft.js`) that the domain's imported and corrected sets drop before
  the wire, and which draws the share page's kinds and a warm-up set on the gym landing
  (`GymLanding.jsx`); and the backend, whose reads count working sets only (`PgLogRepository.cpp`,
  `PgLogHistory.cpp`, `Review.cpp`: REST, MCP `gym_get_stats` and last time, the Coach's context) and
  whose MCP `gym_log_set` and Coach prompt still offer warm-up, drop and failure. An old row of another
  kind so counts on every client and not on the server. Build work: remove it on Android, the web and
  the backend.
- **9k · On this phone (owner ruling, 2026-10-22; build).** Both phones keep workouts the account
  has not taken in one **On this phone** row at the head of The log, a door to a pushed list (Needs
  you, Adding), Inspect, Fix workout and ⋯ *Discard workout*, with The log tab's badge as the door from
  other tabs (iOS section 07 `1116:1705`; Android 07.7 `1283:42660`, 07.1 `1283:42787`, 07.2
  `1284:16798`, 07.3 `1284:16888`, 07.8 `1284:17208`). Android builds none of it: it shows *Saved
  workouts need review (N)* above the bar on every tab (`GymRoom.kt:980-982`), puts the cards in Gym
  settings (`ui/SettingsScreen.kt:182-442`) with a dialog Inspect, a typed-format fix sheet
  (*Renumber sets for import*, *import limit 200*), *Choose set kind* and no Discard, and a refusal
  banner on Routines (`ui/RefusalBanner.kt`). iOS's discard question still says *This permanently
  removes the copy saved on this phone.* (`WorkoutInspectScreen.swift:52-58`); see 12g.
- **9l · Live Activity clocks carry no words (owner ruling, 2026-10-22; iOS build).** Boards 04.2
  and 04.4 draw the clocks with no names; VoiceOver names them. The widget's position line still
  adds *… since last set* (`WorkoutActivityWidget.swift`, `position`): build work in iOS task 59.
- **9m · Iteration-1 boards outside the Gym page.** The Gym iOS page was redrawn to the app on
  2026-10-22 (10o). Iteration-1 drawings of You's native sections and the update-required alert
  predate the native chrome; redraw them from the app.
- **9n · The set-note footer.** iOS's Fix set (board 03.3) draws no footer under the set note;
  Android's Fix sheet gives the field *A record for you — not an instruction to Coach.* as its
  state description (`FixSheet.kt`, `Training.kt` `noteCaption`). Rule one.
- **9o · Moments are doors (owner ruling, 2026-10-22; Android build).** On both phones every moment
  is a row that navigates: a best moment opens the Record at that workout's point, a weigh-in moment
  opens Bodyweight, a month moment opens nothing (iOS section 05; Android 05.1 `1283:39834`). Android
  expands a moment in place to its chart and *Open record* (`ui/LogScreen.kt:193-230`).
- **9p · A record stated once, and what counts as one.** iOS (section 05) states a record by its
  moment, or by a `gym/record` dot after a session's name when the one-a-week cap leaves it without
  one; a session row's second line is always its facts. Android states a record twice — the row's
  second line *Record · Bench Press 84 × 5* (`LogReadout.kt`) and the woven *new best* moment; the
  owner ruled (2026-10-22) that Android follows iOS: once, by the dot or the moment, and the Record
  lists *Earlier records* (Android 05.1, 05.6). What counts as a new best is ruled for every surface by the shared
  vectors (`packages/api-contract/gym/domain/training-reads.json`, `ProgressRecords`): a movement's first estimate is its baseline, and a new best beats
  the best before it as the log states both, to 0.1 kg. Android drifts: `LogTimeline.kt:52` weaves a
  moment for every exact record step (`newBests`), the first estimate's included. Two iOS reads still compare exact estimates: the Record's **Earlier
  records** and *Best e1RM* walk `MovementProgress.records`, so a step the log does not call a new
  best can stand there at the same stated value as the best before it; and the receipt's *Personal
  record* is the server's (`Review.cpp` `recordFor`), which needs a prior estimate but compares
  exactly. Rule whether both follow the stated rule.
- **9q · Where Weigh in sits (owner rulings, 2026-10-22; build).** Both phones float *Weigh in*
  bottom-end over The log: iOS as the labelled glass capsule (target 05.1), Android as the M3
  extended FAB (Android 05.1). iOS builds it, the list's bottom inset keeping its last row clear;
  Android pins a full-width button under the list (`LogScreen.kt:148-150`, `BodyweightScreen.kt:83-90`).
- **9r · No Gym settings anywhere (owner ruling, 2026-10-22; Android build).** Neither phone has a
  Gym settings page. On iOS, Notes and Connected log are reached from You's Settings
  (`AccountSheet.swift:419-431`) and a hidden workout from the tab bar's accessory on iOS 26 and the
  **Hidden** row at the head of The log on iOS 18 (board 03.5). Android draws the same: You holds
  *Notes*, *Connected log*, *About Windmill* (Shell · Android 16a/16b), the workout bar's trailing
  action is *Hide*, and Units go. Android still ships Gym settings (`ui/SettingsScreen.kt:81-129`)
  with a kg/lb toggle that draws nothing in lb, the workout bar's gear (`ui/LoggerScreen.kt:328-331`),
  and Coach's ⋮ More with Notes, Connected log, New chat and Account (`coach/AskScreen.kt:142-153`).
- **9s · Notes' lines (owner ruling, 2026-10-22; Android build).** Both phones head Notes with *Any
  agent you connect can read these too.* only: no subtitle and no *Top note wins.* (iOS 09.1; Android
  09.1 `1254:39045`). Android shows the subtitle *what you write for Coach* and *Top note wins.*
  (`ui/NotesScreen.kt:89,116`, `domain/Notes.kt:37,40`).
- **9t · Connected log with a connection.** On Android (`ConnectedLogScreen.kt`) the level rows and the caption stay on screen in both states, **How this works** opens in place,
  and a *Manage connections* row joins once something is connected. On iOS (board 09.3) a connected screen leads with **Connected**, each row opening the shell's connection
  settings, puts the level rows, the caption and the five lines behind one **How this works** door
  row, and draws no *Manage connections*; with nothing connected the level rows and caption are on
  screen and **How this works** is the same door. Owner ruling (2026-10-22): Android follows iOS
  (boards 09.3–09.5); build work in Android task 51. Neither library has Material's `open_in_new`,
  so 09.3's browser rows draw `arrow_forward`; the build uses `open_in_new`.
- **9u · Dates in the person's locale.** iOS formats every Gym and shell date in the person's locale
  through one formatter (*Sep 23*, *Wed, Sep 23*; `GymFormat.swift`); the domain kit's
  `Readout.briefDay` orders *26 Sep* by hand. Rule whether shared readouts follow the locale on
  every surface or iOS keeps its own forms.
- **9v · Signed-out sharing.** iOS makes Share this workout's primary a sign-in door,
  *Sign in to share*, signed out or paused. Android draws *Share this workout* on session detail and
  in every Log row's menu whatever the account state, and its sheet offers *Get a link* / *Try
  again* with no sign-in door (`SessionScreen.kt`, `LogScreen.kt`, `WorkoutSharing.kt`). Rule
  signed-out sharing and align Android.
- **9x · Shared room-menu drawings.** The iOS app uses Journal and Gym only in the room
  menu, with account/settings reached once through the account button. Ink notes are onboarding
  only. Update the Design System's `_Room capsule` variant descriptions (`117:52`, `226:4310`)
  and boards 21a/21b to this contract; its set description (`226:4315`) must name both iOS rooms.
- **iOS native specimens.** The Gym iOS boards use editable Inter
  specimens because Figma's SF Pro export returns zero-width glyphs, and local icon vectors
  because importing the subscribed Apple iOS 26 library is denied. Native implementation uses
  system text and controls. Replace these specimen assets when the native library can be imported.
- **9y · The month moment (owner ruling, 2026-10-22; Android build).** Both phones word a month
  trained in full by its own month, *Trained every week of February*, under the head's *Trained 3 of
  the last 4 weeks*. Android words it *Trained 4 of 4 weeks* (`LogReadout.kt:56`) and draws no head
  line.
- **10d · Two search shapes in the pickers.** On iOS the builder's *Add movement* searches from a
  field in the list's first row, a plain native row; *Next movement* and *Movements* use
  `.searchable`. The builder pushes Create movement inside its own sheet, and a probe on iOS 26.5
  found `.searchable` there either swallows the pushed bar's ✓ or, when the search is ended first,
  shows only its placeholder after Create movement's Cancel while the query still holds its text.
  Revisit one search shape for every picker when the system's search keeps its text across a
  pushed step.
- **10e · The Gym door's line.** The iOS build draws the *Where to start?* Gym door as *Log today's
  sets*, beside the Journal door's *Write tonight's page*, since the rack draws no *Last time* line. Check the first-run *Where to start?* boards and redraw any door that
  promises *last time*.
- **10f · What Coach did, in iOS's words.** Web and Android put the phrase table's words in a step
  list behind the read receipt. iOS draws no step list: the receipt row opens *What Coach read*
  (board 08.5), and the table's words stand where iOS says what Coach did — the receipt's *Read your
  movement history* for a totals-only read and *Read nothing from your log*, *Also read your notes.*
  under *What Coach read*, and one row per act, *Open routine · Push A* and *Saved a note* / *Could
  not confirm a note save*, which iOS draws as a card under the answer (10v). The words
  differ too: the return receipt on boards 08.12–08.13 reads *Applied · Push A · 4 changes*,
  *Applied · Push A · routine removed* and *Rejected · Push A.*; the web's `receiptLine` still says
  *Turned down* (10v); iOS's card and History share one word per outcome — *Applied*, *Removed*,
  *Rejected* — and add *Out of date* for a superseded proposal (`CoachCopy.settled`). Decide whether the step list holds on every surface, and whether web and Android take
  *Removed* and *Out of date*.
- **10g · Backend: the read receipt's weeks.** The server's read receipt counts weeks no
  observation names: `GymTools.cpp` adds every week `get_stats` returns, empty ones included, and
  `ReadReceipt.cpp` each set's week. iOS counts weeks only from the workouts *What Coach read*
  lists and never prints `read.weeks`, so a totals-only answer reads *Read your movement history*
  with no number; web and Android print the server's weeks (`coach.js` `readLine`,
  `Ask.kt`). The fix belongs to the backend: dogfood node `coach-receipt-weeks-provable`.
- **10o · The page is the target (owner decision, 2026-10-22).** The owner treats the Gym iOS page
  as the target: no board is 👀 Review. Boards that matched the app on the 2026-10-21/22 simulator
  pass (iPhone 17, iOS 26.5) stay 🚀; everything else is a target (✅ or 🚧). Where a drawing lagged behind the app's
  iteration 2 and 3, it was redrawn to the app first so no target asks for a regression: 00.1 top
  bar (no bar creation action), 00.3 transient band (no Undo; deletes are immediate), 01.10 summary
  sheet with Start, 02.1 Routines, 02.2 summary, 02.3 editor with ✓, 02.4 picker, 02.6 stepper
  Targets, 03.7 receipt, 03.8 Ended early as the same sheet, 05.2
  round red Delete, 05.3 workout detail, 05.4 immediate delete, 05.6–05.8 Record, 06.2 Bodyweight,
  08.3 Review, 08.6 no title, 08.7, 09.1 Notes, 09.2 note sheet. Relabelled without a redraw: 00.2
  colour roles, 00.4 native anatomy (Discard is system red; no Theme token yet), 04.1 Control
  Center control, 04.3 Dynamic Island, 04.4 Live Activity states (clock labels removed). Still
  needing a device or a fixture, named in their captions: 04.1, 04.3, 04.4, 05.8's pan, 08.6, 08.7.
- **10p · Target boards ahead of the gym-feedback build.** The Gym file's iOS page draws the owner's
  2026-10-21 feedback as targets (Dark, with a Daylight twin beneath). Each target holds
  the slot and number of the board it replaced; the replaced boards are deleted. Targets:
  - 01 and 08: listed under 10q.
  - 02: editor always sortable 02.5 `1149:2200`; empty Routines with the floating + 02.7 `1149:2477`;
    remove by the trash circle 02.8 `1149:2275`.
  - 03: rack with Dumbbells 03.1 `1150:2352`; its states pressed 03.10 `1150:2495`, changed with 56 pt
    hit areas 03.11 `1150:2638`, Bodyweight with added load 03.12 `1150:2793`.
  - 04: Live Activity with since-last-set top right 04.2 `1152:2533`.
  - 05: The log with its labelled Weigh in 05.1 `1153:2765`; Edit movement 05.9 `1153:2559`; the
    Equipment menu 05.10 `1153:2603`.
  - 08: Coach updates a movement 08.9, listed under 10q.
  - Floating actions are Liquid Glass with their symbol in the accent: `_Gym / Floating action`
    (`1190:195`, Gym Components page) — Label=None, the 60 pt + for New routine (02.1, 02.7);
    Label=Text, the labelled *Weigh in* capsule on The log (05.1), since a bare + did not say what it
    adds.
  - The rack names its equipment as a symbol in the movement header (03.1, 03.10–03.12); the
    build's *Two dumbbells · 32 kg total* line is gone from the rack, while totals keep its model.
  - Tapping the load or reps opens a native wheel, 03.2 `1180:3930`, load in the movement's steps
    and reps beside it; the ladder keys stay for one-tap nudges. Fix set, 03.3 `1180:4021`, is
    rebuilt on the same wheel with Effort and Note and Delete set as its last row. The weigh-in
    (06.1 `1191:5884`) uses the system `.decimalPad` in a focused field. The owner settled each of
    these.

  Choices the build forced or left open, for the owner:
  - The build's words win: *Equipment* (not *load basis*), *Dumbbells*, *Add screenshot*, *Sign in
    to continue.* The owner's later rulings replace two: *Build my own* (not *Build myself*) and
    **Apply** / **Reject** on drafts (not *Save routine(s)*) — build work in 10v.
  - The greeting's actions are drawn `.bordered` with the accent tint; the build uses `.borderless`.
  - The set-editing haptic is a `.selection` tick per accepted rack change. The build keeps the
    canon's silence on Log set, which the boards keep.
  - The library has no SF stand-ins for `minus`, `line.3.horizontal`, `pencil`, `photo.badge.plus`,
    `chevron.up.chevron.down`, the two `figure.strengthtraining.*` symbols, `wifi` and
    `battery.100percent`. The boards draw local `sf/…` vectors. Moving them into the library is a
    Design System change, which then needs a library publish from the Figma UI.
- **10q · Coach chat in the Messages language (owner decision, 2026-10-22).** The owner asked for
  the Coach chat to read like iOS Messages, drawn as targets over every Coach chat board in
  journeys 01 and 08, with local components on the Gym Components page: `_Coach / Bubble · Messages`
  (`1167:185`: sender × tail × text, image, typing) and `_Coach / Composer · Messages` (`1168:212`:
  empty, typed, photo). Boards: 01.1 `1173:3783`, 01.2 `1173:3860`, 01.4 `1173:3934`,
  01.5 `1173:4111`, 01.6 `1173:4264`, 01.7 `1173:4370`, 01.8 `1173:4471`, 01.9 `1182:4650`,
  01.10 `1173:4600`, 01.11 `1173:4678`, 01.12 `1173:4754`, 01.13 `1173:4833`; 08.1 `1170:2943`,
  08.2 `1203:6633`, 08.3 `1203:6896`, 08.4 `1172:3561`, 08.5 `1172:3621`, 08.8 `1170:3105`, 08.9
  `1170:3192`, 08.10 `1170:3266`,
  08.11 `1170:3364`, 08.12–08.14 `1203:7214`, `1203:7452`, `1203:7628`. Owner rulings since:
  proposals and drafts are decided inline on their cards (no review sheet), and the greeting is two
  bubbles of anchored capabilities. The iOS build draws the targets (`Coach/CoachMessages.swift`,
  `CoachTab.swift`): bubbles with tails, the lifter's in `gym/accent` set in `on-accent`, a sent photo
  as a 200 pt image bubble, timestamps, the typing bubble, Markdown in a full-width bubble, and the
  round + outside the field with the send arrow that appears with text. Android (11g) and the web
  still draw the older chat.
- **10s · Library swap (closed 2026-10-22).** The owner published the Design System additions; the Gym
  iOS and Components pages now use library symbols, the library keyboard (`delete.left`, and
  `Type=Decimal` on the weigh-in) and Theme `ios/system/red` for every destructive paint. The local
  `gym/destructive` variable is deleted.
- **10v · Coach's cards, words and change catalogue (owner rulings, 2026-10-22; build).** The owner
  ruled: proposals and drafts are decided with **Apply** and **Reject** (*Rejected*, never *Turned
  down*); Reject asks nothing; no promise, reassurance or restating lines; Coach's strings in simple
  English. Boards 01.1–01.15 and 08.1–08.31 say so. Build work:
  - *Turn down* / *Turn this down* / *Turned down* and the confirm alert live on in Android
    `Proposal.kt` and its review actions and web `proposals.js` `receiptLine`; iOS says *Apply*,
    *Reject* and *Rejected* and asks nothing.
  - Drafts have Apply and Reject on one card on iOS (Reject drops them on the phone and leaves *Rejected · N
    routines*); Android and the web still offer only Save. The card's loads read *60 kg* and *22 kg each*, the
    proposals' words, where 01.7 draws *60 kg total* and *22 kg, one dumbbell*.
  - Block order: 08.27 lists a rename, moves, changes, removals, then additions, as the shared
    `ProposalDiff` vectors order them; 08.2 and 08.3 draw Changed, Added, Removed, Changed, Moved. iOS
    follows the vectors, so 08.2's first two blocks read Moved and Changed; 08.2/08.3 want redrawing
    in that order.
  - Field lines: 08.21 and 08.27 draw only the fields that change (*Push-up · Reps*, *Lateral Raise · Reps*),
    where 08.2 and 08.3 draw a set's unchanged fields plain, as iOS and the shared vectors do. 08.21
    also draws three blocks with no *Show all*, where the card's rule shows two, then *Show all 3 changes*.
  - The card's field diff (per field old → new, per-set lines once sets differ, *Max*, *Last time*,
    *None*, *No change: N movements*), the *Renamed* block for `proposedName`, and swap as removed +
    added are built on iOS from the domain's `ProposalDiff`, whose vectors Android's and the web's
    domains also pass; no Android or web screen draws them yet.
  - 08.4 gives a conversation that proposed and created nothing a second line — *Changed a movement*, or the answer's
    first words — but the thread list the server sends carries only the question and a proposal or creation outcome, so
    iOS shows those rows on one line.
  - 08.31's **Sign in** under a signed-out answer needs the onboarding answer to say it needs an account: iOS reads
    `needsAccount` from it, which the backend's onboarding schema and prompt do not produce yet, so the button shows only
    on the simulator fixture.
  - A failed apply's red line and **Try again** and Reject disabled while Applying (08.29, 08.30) are built
    on iOS only.
  - `ios/ios-redesign.md` §2 (the `gym/alarm-fill` row, the brick line under the table, white on
    `alarm-fill`) gives a removal's primary a brick fill, where the boards draw **Remove routine** in
    the destructive style: iOS draws it quiet with its label in the system red and holds no
    `gym/alarm-fill` colour. §2 wants the row and the lines retired.
  - Strings in code still carry the cut and pre-simple-English copy: *You decide the numbers at the rack.* (Android
    `Program.kt`, web `routines.js`), and on Android `Ask.kt` and web `coach.js` *Coach reads your log, so it needs you
    signed in.*, *Coach isn’t part of this Windmill…* and *The next question frees up…*. The day's cap can say 08.8's
    *You can ask again in about 2 hours.* on both: `429 ask-daily-limit` carries `retryAtMs` (and `Retry-After` on a
    plain reply), which iOS reads and Android and the web ignore. iOS Coach's
    greeting, access states, allowance refusal and photo captions now read as 01.1–01.11 and 08.6–08.8, but for the
    departures below.
  - iOS departs from a board where the board's words claim more than the build can keep; the boards want redrawing:
    - 08.9, 08.25 and 08.26: *Changed a movement* and *Saved a note* stand alone on their cards, without the boards'
      *Changed* block or note text. The answer's steps name only the tool (`tool`, `failed`), so the phone cannot tell
      Coach's write from the lifter's later edit. Owner ruling (2026-10-22): the cards gain their content with the
      local Coach, whose abilities run on the phone's replica ([gym_coach.md](../foundation/mobile/gym_coach.md)),
      not before.
- **10r · Swipe delete is the native trash circle (owner ruling, 2026-10-22).** Everywhere in gym a
  trailing swipe slides the row and reveals a round red trash circle with no text label, drawn with
  the local component `_Gym / Swipe actions` (`1190:172`). iOS draws it with one shared modifier,
  `TrashSwipe` (`Gym/Components/GymRows.swift`), on the Routines list, Targets' per-set rows, The log,
  workout detail sets, Bodyweight entries, Notes, Coach History and the routine editor's movements
  (02.8 `1149:2275`) and This workout's movements (03.4 `1135:1875`), both lists out of edit mode
  that draw their own handles and drag on a long press. A one-line row draws the system's capsule
  rather than a circle (05.4's set row).

  Deletes outside swipes keep their native form: context-menu *Delete routine*, *Delete set*,
  *Delete conversation*, *Discard workout*; the editor's *Delete routine*; the sheets' *Delete set*,
  *Delete weigh-in*, *Delete note*; Inspect's *Discard workout*; the receipt's quiet *Discard*,
  which is the receipt's band action, not a swipe.
- **10x · The log's boards ahead of other canon (build, 2026-10-22).** The iOS build follows the
  🚧 targets (10o), and other canon still says otherwise in these places:
  - Workout detail's tiles share one card parted by hairlines (05.3), and the one session
    constructor draws them so on Inspect too, where 07.2 draws one card without hairlines; the
    receipt sets each tile on its own card, as 03.7 draws them. Settle one form for 05.3 and 07.2.
  - The Equipment menu (05.10) draws Bodyweight third; the build lists it last, as Create movement
    does (Barbell, Dumbbells, Machine, Cable, Kettlebell, Bodyweight), from the one
    `MovementEquipment.choices`. Its basis help is the one `MovementEquipment.help`, so Edit
    exercise, Targets and Create movement read the same words.
  - Weigh in (06.1): on a phone the keyboard lifts the `.medium` sheet to the top, where the board
    draws it at its detent.
  - Notes (09.1, 09.2): on iOS a row and the editor are the note's one text, while the domain still
    stores a title and a body: the editor takes a first line of up to 60 characters as the title and
    the rest as the body, and a longer first line keeps the whole text in the body under a title cut
    at a word boundary with *…*, which is how it reaches the other surfaces. Coach's `save_note` and
    the rules are unchanged.
- **Proposal · one suggestion on an empty Coach (owner decision).** Outside first-use setup, board
  08.1 draws an empty Coach as the bar, canvas and composer. The
  proposal: while no conversation exists, at most one `.glass` capsule above the composer, chosen
  from the lifter's state and never from capability copy — *Build me a routine* with no routines,
  *How did today go?* after a workout today. A tap fills the composer without sending, and the
  capsule leaves with the first message. It waits on the owner and is not drawn.

## Onboarding

Drawings: Shell iOS section
[Shell · iOS onboarding](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-9719). The
four-screen introduction was decided on 2026-10-04 — direction A · Three rooms, iOS page 4 leads to
Where to start?, About Windmill in You and the account sheet, and the four screens are the accepted
exception to opening on a choice. Both phones draw it (`Onboarding.swift`, `OnboardingPager.kt`).

- **9a · Platform lines.** The Marketing superapp landing boards (`98:2538`) print *Web · iOS* for
  journal and *Web · iOS · Android* for gym; the shipped `landing.root.platforms` in each product's
  `routes.js` reads *Web* and *Web · Android*, and the onboarding's per-phone tags follow the code.
  Redraw the boards from the code, or change the code when the iOS app ships.
- **9c · The roadmap glimpse.** `_Glimpse / Roadmap` (`210:2`) fans the sail tree from the root to
  the right, like the landing boards; the product renders radially (0k). The glimpse is an
  illustration, not a layout specimen; if it is ever drawn from the product, draw it from a live
  screenshot.
- **9d · Gym day accent on Android.** Android's Daylight skin ships iris `#4C4374`
  (F44); its onboarding glimpse uses verdigris `#137A6C`. The Figma Android boards use
  light `color/brand` `#137A6C`; iOS uses `ios/gym/accent` `#106B5F`. Align Android's glimpse and skin
  with the intended Android accent and identify any intentional platform difference.
- **9f · The gym glimpse draws a rack neither phone has.** The page-4 fixture (*Squat · set 3 of 5 ·
  … Set 3 · target 100 × 5 · … Last time · 97.5 kg × 5 · Set 3 logged · Log set*) and
  `_Glimpse / Gym` (`210:56`) draw a slot target, a *Last time* line and the mono face, and both
  phones' glimpses draw that fixture (`OnboardingGlimpses.swift`, `OnboardingGlimpses.kt`). The iOS
  rack (board 03.1) has none of the three. Shell · Android A4 (`2:10131`, Daylight `2:10203`) now
  draws the Android glimpse from today's rack as a target (Squat, the ledger with its current row,
  *100 kg total*, *5 reps*, *Log set*); `OnboardingGlimpses.kt` still draws the old fixture. The iOS
  A4 and `_Glimpse / Gym` (`210:56`) still draw it: redraw them from the iOS rack and align the iOS
  glimpse.
- **9g · Where each product lives.** The iOS app tags both rooms *In this app* (`Onboarding.swift`);
  Android tags Journal *On the web* and Gym *In this app* (`gym/src/main/res/values/onboarding.xml`).
  Decide whether Android's tags name the iPhone.
- **9h · The text leads at accessibility sizes.** iOS puts the text block first at the
  accessibility sizes, with the glimpse after it at 260 pt, so a page opens on its title and body;
  at the standard sizes the glimpse keeps the lead and shrinks to a 220 pt floor before any page
  scrolls; and a page that scrolls fades its bottom edge under the dots. Check Android at font scale
  2.0 on a device for the same cut.

## Roadmap

- **1e · Available-node treatment.** The DOM specimen draws a card-coloured available node;
  `NodeBatch.js` paints available and complete with saturated fills, distinguishing complete with a
  halo. Choose one treatment and align shader and specimen.
- **F20 · Unstyled classes.** Audit `.st-list-bud`, `.st-list-jump-chip` and `.st-action-lane`
  against their stylesheet consumers; remove empty hooks that have no styling or test role.
- **F32 · Quest roster icons.** An optional `node.icon` can leave an empty reserved glyph well.
  Give the roster a fallback or remove the unused well.
- **F50 · Marketing silhouettes.** The app uses bubble layout; `marketing/treeScenes.js` and
  the Marketing drawings use authored radial compositions. Redraw the marketing scenes in bubble
  while preserving their names, progress states and unlock ceremony. Engine output alone does not
  define the marketing framing. Gallery portraits and minimap use the live canvas positions.
- **21 · The fruit tiers in daylight.** The locked fruit is `color-mix(kind 18%, transparent)` with a
  35% ring; the fill measures **1.14–1.29:1** against the canvas in both themes, so a locked step and
  an available step of the same kind differ by an 11px smudge on a phone in daylight. Not a token
  swap: locked steps are the majority of a healthy tree and must stay quiet while separating at arm's
  length. Deliver the three fruit tiers (done / available / locked) at 24px, both themes, all six
  kinds, with the measured contrast for each pair.
- **23 · One input or two.** With the keyboard raised, a header search field and the AI input up at
  once bracket a ~200px sliver of results and both read as "type here", though typing in the header
  is a lookup (a read) and the AI input is intent (a write). The alternative to rule on: **one input
  at the bottom** — typing filters the list live, **send** hands the same sentence to the agent. It
  puts the field under the thumb and answers recognition ("show me the backend stuff") rather than
  recall. Counterweight: one field with two outcomes split only by pressing send, where a mistaken
  send is a write and a mistaken filter is nothing. Deliver the ruling, and if one input, how a live
  filter and a pending sentence share a field, what send looks like versus typing, and how results
  and theatre share the screen.
- **26 · Review flags.** Whether an AI review's findings become flags on the steps they affect, and
  how a person applies a correction. Deliver the flag as it reads on the canvas fruit and in the list
  row, plus the two response chips a finding invites (**Keep as is** / **Re-pace**).
- **Readability evaluation.** Measure sustained large-tree edits on a real GPU and review
  cross-branch visibility and the visitor's whole-tree entry. Layout runs synchronously; the
  deterministic tuck budget does not guarantee interactive latency. The checked-in capture rig
  uses SwiftShader and cannot establish production frame timing.

## Journal

- **iOS journal first run · R117.** AX3 keeps the longer privacy fact and scales in a scrollable page.

- **Mood and energy entry.** [Input alternatives](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=204-1159)
  compare quiet rails, a folded picker and a number ribbon. The folded picker is the recommendation,
  pending entry-frequency and focus/caret checks. Preserve independent optional integers 0–10,
  null versus zero, Clear, keyboard-up suppression and 44px targets.

- **F22 · Landing accent.** `marketing/landingHead.js` still uses `#C29A4E`; the live day
  accent is `#986B1E`. Align the crawlable shell and verify CTA contrast.
- **F28 · Echo layout drawings.** Above the margin breakpoint, the echo form is margin-only.
  Boards showing an in-page desktop form must state a width where that form can appear.
- **Echo drawings · included passages.** [Caption 33:426](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=33-426)
  still describes a cut passage, withheld words and a free path. `brand-foundations.md` ("Numbers and
  money") requires complete existing passages for everyone, with no new AI cost to read them or subscription paywall.
  Reconcile the caption and the free-path labels on the phone echo boards `31:211` and `33:327`.
- **Echo allowance drawings.** Journal and account drawing specimens must distinguish complete
  readable Echo passages from the cost of creating new ones, as `brand-foundations.md` requires. All hosted background AI debits the individual USD allowance; new work waits
  when its applicable capacity is unavailable. Remove drawing claims that automatic Echoes never
  consume allowance. Existing passages are not cropped or withheld to pressure an upgrade.
- **iOS Journal daylight.** The journal room answers light with the Day column of
  `ios/ios-redesign.md` §2: the canvas, source pages, the echo ink and the reader. Its lamp is
  `#90651C` (4.82:1 on `#F7F7F5`); the web's day lamp `#986B1E` (`palettes.css`) measures 4.39:1 on
  the same paper, under the 4.5:1 text floor. Move the web and the Figma Day collection to `#90651C`.
- **The one fact over the scales.** The first-run privacy line is *Only you. No prompts, no fields,
  nothing to fill in — write a line or a page.* (engine A.3); on iOS the canvas draws it above the
  mood and energy scales, so *no fields* reads against two fields. Copy owner:
  reword it (*nothing you have to fill in*) or keep it.
- **F34 · Type roles.** Reconcile the journal's unassigned first-run, talk, verdict, nudge,
  week-count and narrow scale styles with the named type ramp.
- **F36 · Phone tools.** Check the fixed `.journal-tools` rail against the writing measure at
  narrow widths; reserve space or move the rail so it cannot cover text.
- **1j · Today's glyphs.** Web `DayMarker` draws no glyphs for today. Decide whether today draws
  glyphs, a breathing mood pip, on any surface. The motion budget is at most one infinite loop, not a
  requirement to add one.
- **4x · Echo quote relocation.** Check first-load marks against current passage text before
  rendering; later-read relocation alone does not establish correct initial highlights.
- **4z / 5c · Echo arrival motion.** Reconcile journal's gradual luminance arrival with the shared
  feedback/ceremony categories and reduced-motion contract. `global.css` clamps transitions to
  `0.001ms`; journal currently overrides that clamp for its 1200ms arrival ramp.
- **5a · Held-panel copy.** Review the pin promise and foot line together: the text must explain
  which page is held and the effect of unpinning without promising that it will stay pinned.
- **5f · Echo tie tracking.** Evaluate the rule's tracking during compositor scrolling, not only
  at rest. A rule outside `.journal-scroll` can lag its day row; decide whether to anchor it to
  the row before relying on a “glued to content” description.
- **5g · Trail destination.** Check a trail hop before any manual scroll. The destination date
  must clear the fixed trail and remain reachable after layout changes; `openingRef` must not
  repeatedly restore it underneath the bar.

## Gym

### Sets · product direction

Sets have no type on any surface. Targets are references: actual weight/reps remain independent for every set, including extra or
skipped sets and substituted movements.

### Open concepts

- **Strength tree.** Determine whether a gym-to-roadmap handoff helps lifters following a written
  program. Before designing screens, choose authorship, an evidence-based unlock rule and the
  smallest useful surface; “not yet” remains valid. Any integration must preserve product
  independence and must not introduce XP, levels, badges or streaks into gym. Tracking: `strength-tree`.

### Android against the drawings

The Gym file's [Android page](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=56-2) is
the target, numbered like the iOS page and indexed in [the flow index](../index.md). Paths below are
under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `platform/` or
`app/`. Build tasks: `androidgym_tasks/`.

- **11a · The page is the target (owner decision, 2026-10-22).** Journeys 00–09 carry the iOS
  numbers; Android-only boards take the next free number in their journey. A board is 🚀 when it
  matched the emulator pass of 2026-10-22 (Pixel 10 Pro, API 37, a debug build of origin/main
  `cca4bd3b`), otherwise a target (✅ or 🚧). Daylight twins that show the accent stay targets until 9a
  lands. Sign-in,
  email code and You live in the Shell file's Android page (section `33:1568`). Boards drawn from
  code because no capture reaches them say so in their captions (16b). The parity rulings of
  2026-10-22 (12a–12n) apply to both pages.
- **11b · Swipe delete is immediate (owner ruling, 2026-10-22).** One Material swipe-to-dismiss row
  everywhere: the error-red ground with a trash icon, gone on release past the threshold, no
  Snackbar Undo and no hold (`guidelines/system-architecture.md` §3; component `Android / Swipe row`
  `337:2217`). Confirmations stay only for discarding a workout and deleting a conversation. Today
  every swipe draws the word *Delete* on brick at 18 % with no icon (`ui/RowSwipe.kt:68-81`), and
  routine, set, workout, note, weigh-in and conversation deletes are held 9 000 ms behind an Undo
  snackbar (`store/WithheldDelete.kt:108`, `GymRoom.kt:507-563`).

  | Place | Code today | Board | Build work |
  |---|---|---|---|
  | Routines list | `ui/RoutinesScreen.kt:184-206`, held, *{name} deleted.* + Undo | 02.10 `1253:29196` | immediate |
  | Routine ⋮ Delete | `ui/RoutinesScreen.kt:242`, ink, held | 02.12 `1253:29480` | error role, immediate |
  | Editor movement | `ui/RoutineBuilder.kt:392-397`, word ground | 02.8 `1252:30621` | shared row |
  | Target set row | `ui/TargetBlock.kt:264-277`, word ground | 02.11 `1253:29263` | shared row |
  | This workout row | `ui/AssemblySheet.kt:163-195`, both directions, *Remove* on raised | 03.4 `1253:29834` | end-to-start, shared row |
  | Workout detail set | `ui/SessionScreen.kt:449-488`, own ground (bleeds at the top-right corner), held | 05.4 `1252:27713` | shared row, immediate |
  | The log row | `ui/LogScreen.kt:241-267`, no swipe; long-press *Discard session*, held | 05.2 `1252:27527` | swipe + *Discard this workout?* |
  | Receipt and workout detail Discard | `ui/SessionScreen.kt:313-328`, no confirmation, held | 03.14 `1254:32499`, 05.3 `1252:27642` | confirm once |
  | Bodyweight | `ui/BodyweightScreen.kt:206-211,344`, no swipe; *Delete weigh-in* in the sheet, held | 06.2 `1254:32141`, 06.3 `1254:32246` | swipe, immediate |
  | Notes | `ui/NotesScreen.kt:276-279`, no swipe; *Delete note* in the editor, held | 09.1 `1254:39045`, 09.2 `1254:39104` | swipe, immediate |
  | Coach History | `coach/ThreadsScreen.kt:164-187`, held, *Conversation deleted.* | 08.4 `1253:28552`, 08.34 `1254:31663` | *Delete this conversation?* |

  The refusal notice's swipe (`ui/RefusalBanner.kt:52-89`) dismisses a notice, not a record, and
  keeps its *Dismiss*.
- **11c · Destructive actions use the M3 error role (owner ruling, 2026-10-22).** Library Theme
  `android/system/error` (#E46962 dark · #B3261E light) and `on-error` (#410E0B · #FFFFFF). The app
  maps M3 `error` to brick `alarmInk` (#D08268 · #A84E35; `ui/GymMaterial.kt:50`) and paints
  destructive controls four ways: brick (*Discard session* `ui/SessionScreen.kt:322-326`, *Delete
  note*), ink (*Delete set* `ui/FixSheet.kt:277-281`, *Delete weigh-in*, the log menu's *Discard
  session* `ui/LogScreen.kt:263`, the routine menu's *Delete*), accent (*Discard* in the sign-in
  decision `app/MainActivity.kt:290,303`, *Remove set* `ui/SettingsScreen.kt:344,359`). Boards 00.2
  `1254:43776` and 00.4 `1254:38403`. *Sign out* stays ink.
- **11d · Number entry is a stepper (owner ruling, 2026-10-22).** Load and reps are M3 icon buttons
  − / + (48 dp) around a numeric text field; tapping the value opens the decimal keyboard, − / +
  nudge by the movement's step, and the plate ladder stays for bigger jumps. Pressing shows the M3
  state layer; an accepted change ticks the value and flashes the field. Today the rack and Fix set
  open a custom keypad sheet (`ui/KeypadSheet.kt`), pressing only scales to 0.96
  (`ui/LoggerScreen.kt:1009-1020`) and nothing ticks. Boards 03.1 `1252:28036`, 03.2 `1252:28178`,
  03.3 `1253:29581`, 03.10–03.13 (`1252:28389`, `1252:28534`, `1252:28687`, `1252:28829`), 02.6
  `1252:30392`, 02.11. The weigh-in already uses the decimal keyboard (06.1, 🚀).
- **11e · Equipment, units and Edit movement (owner rulings, 2026-10-22).** The movement header
  carries the equipment icon; loads read *kg each* (dumbbells), *kg total* (barbell, machine) or *kg
  added* (bodyweight). Renaming renames the movement in history, and *Edit movement* holds the name and
  equipment, with *Dumbbells lifted: One / Two*. Today every screen outside Coach says plain *kg*
  (`ui/RoutinesScreen.kt:329`; `domain/Readout.kt:51-52` prints *80kg* with no space), Create
  movement offers four radio options and no count (`ui/MovementPicker.kt:411-431`;
  `store/TrainingStore.kt:1154-1166` passes none), the picker says *Dumbbell* where the form says
  *Dumbbells*, and the Record offers *Rename movement*, name only (`ui/RenameSheet.kt`). The model
  (`domain/Training.kt:38-45`, `loadCount`) is already on main. Boards 02.9 `1253:29027`, 05.6
  `1252:30001`, 05.9 `1253:6349`, 05.10 `1253:6469`, the racks under 11d.
- **11f · New routine is a FAB (owner ruling, 2026-10-22).** An M3 FAB (+) bottom-end on Routines,
  16 dp above the navigation bar; the top bar's *New routine* goes (`ui/RoutinesScreen.kt:93-105`). Boards
  02.1 `1252:27415`, 02.7 `1252:30574`. *Weigh in*: 9q.
- **11g · Coach chat in the Google Messages style (owner ruling, 2026-10-22).** Coach and lifter in
  grouped Material bubbles with timestamps, a typing bubble while Coach thinks, the answer streaming
  into its bubble, long Markdown at full width. Today the question is a raised bubble at 90 % width
  and the answer unbubbled prose (`coach/CoachAnswer.kt:58-65,236-311`), with no timestamps or
  grouping; waiting is the text *reading your log…* and, with the server polled at 1 Hz, the
  answer lands whole. Boards 08.1 `1252:27790`, 08.10 `1254:30552`, 08.11 `1254:30653`, 08.32
  `1254:31101`, 08.33 `1254:31296`, 01.6 `1253:30742`.
- **11h · Coach-led setup on Android.** Journey 01 draws the iOS setup in Material form: the greeting
  with its anchors (01.1 `1252:4776`, 01.2 `1253:28196`), photos (01.4, 01.5), drafts decided on
  their card (01.7, 01.14, 01.15), receipts (01.8, 01.16), allowance used (01.10–01.12) and the
  thread after sign-in (01.13). None is built: an empty Gym opens Routines, an empty Coach shows
  nothing above the composer (`Ask.openers` is unused), signed out Coach is a sign-in door (6p),
  and drafts are a *Review routine* card with *Save routine* (`coach/CoachAnswer.kt:84-133`). The
  signed-out build needs the onboarding endpoint, which runs only with `AI_INSTALLATIONS_ENABLED`
  and `AI_ALLOWANCES_ENABLED` (both default off).
- **11j · The allowance-used copy.** Boards 01.10–01.12 say *You have used all of your AI
  allowance.*, a sentence no server sends (the nearest is *Your AI allowance is fully used or
  reserved.*, 10v). Android reads only `ask-daily-limit` and `ask-out-of-budget`
  (`coach/CoachStore.kt:396-411`) and ignores `allowance.resetsAtMs`, so it cannot say when Coach
  comes back (01.11). Windmill One (01.12) ships only with checkout open.
- **11k · Proposals decided on the card.** Android decides a proposal in a review sheet
  (`ui/ReviewSheet.kt`: apply after scrolling to the end, *Turn this down* behind a confirm), its card
  says *Review* under the promise line (`coach/CoachAnswer.kt:327-341`, `Ask.promise`), and receipts
  say *Turned down* (`domain/Proposal.kt:184-274`, `coach/Thread.kt:53,77,88`). The boards decide on
  the card with a per-field diff and Apply / Reject: 08.2 `1252:27854`, 08.3 `1253:28311`, 08.12–08.14,
  the catalogue 08.15–08.31 (`1254:37242` … `1254:38214`). 10v covers the words on every surface.
- **11l · Outside the app.** The ongoing notification shows no time (`setShowWhen(false)`, no
  chronometer; `notification/WorkoutNotifications.kt:189-227`), so the Live Update chip is an icon
  only, and its channel is `IMPORTANCE_LOW`, hidden on the lock screen. No Quick Settings tile
  exists; with no workout open the tile opens Routines and never starts one (12b). Boards 04.1
  `1254:46694` (tile), 04.2 `1254:46754`, 04.3 `1254:46826`, 04.4 `1254:46875`.
  Owner ruling (2026-10-22): on the lock screen the notification shows only the routine and the
  clock, never set content — a private notification with a public version (board 04.4; build in
  task 15).
- **11m · Sign-in fields.** In Dark the email and code fields draw no outline until focused
  (`platform/auth/SignInDoor.kt`); Shell · Android 15a `33:1946`, 15b `33:4237`, 15c `33:4317` draw
  M3 outlined fields.
- **11n · Android specimens.** The boards set text in Nunito and JetBrains Mono, standing in for the
  app's system sans and mono (`ui/GymMaterial.kt:57-81`); system parts come from the team Material 3
  Design Kit, themed with the Windmill Theme roles. Native implementation uses Compose Material 3.
- **11o · A proposal with no conversation.** The waiting-proposal row on Routines (02.1) opens the
  proposal's Coach conversation at its card. A proposal written by a connected agent over MCP
  (`ProposalDoor::mcp`) has no conversation, and no board draws where it is decided. Rule where it
  opens on both phones.

### Parity rulings (owner, 2026-10-22)

The owner ruled the iOS ↔ Android parity report; both Gym pages and the Shell account boards draw the
rulings. Entries 9k, 9o, 9p, 9q, 9r, 9s, 9y, 9z, 7c and 7d carry the rulings that close an earlier
question; the rest are below. iOS paths are under `apps/ios/App/Sources/Gym/`, Android paths as above.

- **12a · Lifting above the plan is just logged.** No surface asks to change a routine when the
  lifter beats it; targets change only through Coach's proposals (catalogue 08.21). Both phones ask
  today: iOS an alert *Save {w} to {routine}?* or the sheet *Heavier than the plan*
  (`Workout/WorkoutSheets.swift:105-151`, `WorkoutState` `resolveDeviation`, `SaveWorkoutDeviation`),
  Android the sheet (`ui/DeviationSheet.kt`, `domain/Deviation.kt`). Boards 03.6 are deleted on both
  pages. No Coach entry point fits *should I go heavier?* beyond asking; none is drawn.
- **12b · Every workout starts from a routine.** No free workout on either phone, and the Control
  Center control and the Quick Settings tile open Routines when no workout is open (both 04.1).
  Boards 03.9 are deleted on both pages. Android still offers *Start logging*
  (`ui/RoutinesScreen.kt:162-177`), the first-movement picker (`ui/LoggerScreen.kt:364`) and *Save a
  routine* on the receipt (`ui/FinishScreen.kt:68,379-395`); iOS still draws *Choose your first
  movement* (`Workout/WorkoutScreen.swift:107-113`).
- **12c · Hide workout on Android.** The logger's *Hide* (and system Back) leaves a running workout,
  which waits in `Android / Workout bar` (*Push A · 12:34*) above the navigation bar on every tab root
  (Android 03.4 `1253:29834`, 03.5 `1283:41318`). Swiping the notification away only turns it off:
  This workout shows *Notification off* · *Show*. Android today cannot leave the logger before Finish
  (`GymRoom.kt:163,180`), and a swiped notification sets *Workout hidden* / *Show workout* in Gym
  settings (`ui/SettingsScreen.kt:113-118`, `notification/WorkoutNotifications.kt:211`).
- **12d · The receipt follows iOS.** *Well done.* / *Ended early.*, subtitle *Push A · Tue, Aug 18*,
  tiles *Duration* · *Working sets* · *Volume*, head *Performed*, *👑 Share with Coach* (payments open
  soon), *Discard* (asks once) and *Done* (Android 03.7 `1254:32362`, 03.8 `1254:32441`). Android
  says *Workout saved*, counts *Sets* · *kg lifted* · *Movements*, adds *Against plan*, and has
  neither *Discard* nor *Done* (`ui/FinishScreen.kt:232-312`).
- **12e · Delete account (owner ruling; build on every layer).** Both phones, signed in, from You's
  last row: an explanation, *Type your email to confirm*, *Deleting…*, *Your account is deleted* /
  *Sign in before Nov 21 to bring it back.*, and *Couldn’t delete your account. Check your connection
  and try again.* (Shell iOS section 4c `47:3852`, boards 27a–27e; Shell Android `33:1568`, 27a
  `54:1269`–27e `54:1606`). Neither phone has it. The copy promises deletion after 30 days, which the
  server does not do: `DELETE /v1/me` soft-closes with `closingOn` = now + 30 days, but
  `AuthService::revived` revives a closed account at any later sign-in and nothing deletes a closed
  account's data (dogfood `account-delete-grace-enforced`).
- **12f · Sign-in is suggested once.** After the first finished workout, signed out, the receipt
  carries one line, *Only on this phone · Keep it*, and never again (03.15: iOS `1283:39725`, Android
  `1283:42292`). Neither phone builds it: iOS offers Keep only from Coach's receipts and from Share
  with Coach signed out (`Coach/CoachTab.swift:318`, `GymRoom.swift:200`); Android shows a standing
  card on Routines (`ui/RoutinesScreen.kt:249-270`) and a standing line on the email step
  (`plat/auth/SignInDoor.kt:117`), both removed from the boards.
- **12g · One message per destructive question, on both phones.** Discard a workout: *Discard this
  workout?* / *This deletes the workout and its 5 sets. You can’t undo this.* / *Cancel* · *Discard*.
  Delete a conversation: *Delete this conversation?* / *You can’t undo this.* / *Cancel* · *Delete*.
  The sign-in question: 7d. iOS asks these words through one alert for every workout door
  (`Gym/Components/GymRows.swift`, `DiscardWorkoutAlert`), except Inspect's stranded sets, which are
  not drawn: *Discard 2 sets* still asks *This permanently removes the copy saved on this phone.*
  (`Recovery/WorkoutInspectScreen.swift`). A workout with no sets is not drawn either; iOS says *This
  deletes the workout. You can’t undo this.* Android asks nothing (11b).
- **12h · Coach details follow iOS.** What Coach read is a sheet; a movement's details read *Weight
  is · Total → Each dumbbell*; the day's cap reads *You can ask again in about 2 hours.* with *Use your
  own AI agent*; *This Windmill does not have Coach. You can still read your log.* with no doors;
  *No conversations*; *New chat*; *Copy question* / *Copy answer*; no ⋮ More on Coach (Android 08.5
  `1253:28654`, 08.7 `1253:28776`, 08.8 `1253:28820`, 08.26 `1254:37761`, 08.32 `1254:31101`, 08.34
  `1254:31663`). Android: `coach/Ask.kt:180,218,225-240`, `coach/AskScreen.kt:142-153,282-315,332-343`,
  `coach/Thread.kt:157,168`, `coach/CoachAnswer.kt:225-228`. The cap's hours come from the 429's `retryAtMs`, as iOS
  says them (`Coach/CoachWire.swift`, `CoachCopy.daily`); Android does not read the field yet (10v).
- **12i · Shipped iOS states, drawn on both pages.** Coach's choice chips (01.17), *Draft kept on this
  phone* / *Continue saved draft* (01.18), the routine editor's History (02.13), *· yours* on a custom
  movement (02.2) and the Copy menu (08.32). The iOS boards are drawn from the code and await a
  device check; Android builds none (01.17 `1283:40111`, 01.18 `1283:40674`, 02.13 `1283:39087`).
- **12j · A refused sign-in code.** Android says *That code has expired. Codes work once and last 15
  minutes — send a fresh one.* for every refusal, a typo included (`plat/auth/Auth.kt:261-266`); both
  phones draw the server's *That code didn’t work.* / *Check the digits, or send a fresh one.* (Shell
  Android 15c `33:4317`).
- **12k · No Erase data; Delete account removes the cloud copy.** No phone offers Erase data:
  removing the app erases its data. Delete account's first line says *This deletes your Windmill
  account and its copy in the cloud: your roadmaps, journal pages and gym log.* (12e).
- **12l · The greeting's *Changes* line.** Both phones say *Changes — ask me, and I suggest changes to
  your routines.*, because Coach proposes only inside a conversation the lifter starts
  (`Proposal.h` `ProposalDoor`). The iOS build still says *as you train*
  (`Gym/Coach/CoachSetup.swift:24` on branch `ios-gym-backlog`); Android has no greeting yet (11h).
- **12m · Delete account with unsent changes (owner ruling, 2026-10-22).** They are deleted with the
  account, said plainly and with no extra choice: a fifth fact *3 changes on this phone haven’t been
  confirmed by your account. They are deleted too.* (Shell iOS 27f `91:5187`, 27g `91:5256`; Shell
  Android 27f `96:2122`, 27g `96:2157`). The phone flushes for up to 5 s, then calls
  `DELETE /v1/me`, then discards its copy, as the web's closure does (`AuthProvider.jsx`
  `closeAccount`); neither phone builds Delete account yet (iOS 50, Android 48). The fact's symbols
  (`iOS / Symbol / icloud.slash`, `Android / Symbol` `cloud_off`) are in the Design System but not
  published: until the owner publishes, those 8 boards draw local stand-ins named `⟳ DS publish · …`,
  which `.claude/scratch/android-gym-figma-verify/owner-answers-12/post-publish-swap.js` swaps.
- **12n · The sign-in decision names what the phone holds (owner ruling, 2026-10-22).** Only the
  kinds present, in this order: workouts, routines, weigh-ins, movements, notes, journal pages (iOS).
  Sets go with their workout; settings, movement names and Coach drafts are not named. The account
  line names what the account holds; *it* for one item, else *them*; the confirm title is *Discard
  {phrase}?* for one or two kinds, *Discard all of it?* for three or more. On iOS one alert answers
  both rooms. Boards: Shell iOS 23g–23j (`94:5426`, `94:5455`, `94:5482`, `94:5511`); Gym Android
  07.9 `1336:17333`, 07.10 `1336:17426`. Build: iOS 48, Android 25.

### Coach on the client

Spec: [Gym Coach on the client](../foundation/mobile/gym_coach.md). It and the product differ in
these places.

- **6p · Android signed-out Coach.** Android's Coach is account-only (*Coach reads your log, so it
  needs you signed in.*, `coach/AskScreen.kt:268-278`); it calls neither `/v1/gym/coach/onboarding`
  nor `/v1/ai/installations`. The owner decided on 2026-09-26 that Android carries signed-out Coach;
  Android journey 01 draws it (11h), with no allowance indicator (owner ruling 2026-10-22). The
  approved launch identity is a server-issued installation credential with IP and global budgets;
  the identity does not guarantee protection against installation resets.
- **6q · One agent rule per ability.** Coach never logs, fixes or deletes a set, finishes or
  discards a workout, or writes a bodyweight (`brand-foundations.md`, Gym). MCP runs
  `start_session`, `log_set`, `log_sets`, `finish_session`, `discard_session` and `import_session`.
  The spec gives each ability one agent rule for both doors and withholds these until the owner
  rules (its Appendix B-1).
- **6r · Where a signed-out photo goes.** The anonymous caption identifies the AI provider as the
  processing destination and limits the phone-only storage claim to Windmill. The application
  server must not persist the image or input text. Native verification must cover draft retention,
  inline submission, and the local history/photo ownership decision at sign-in.
- **6s · Pasted programs.** The Coach contract and signed-in iOS setup accept 8,000 UTF-8 bytes.
  Android's `Ask.maxTurnBytes` and web's `QUESTION_BYTES` remain at 1,000; the web textarea also
  limits character count to 1,000. Align those clients when delivering their setup flow, preserving
  the complete draft and a specific length refusal rather than silently truncating a pasted program.
- **6t · States the room does not draw.** Add specimens for provider refusal, truncated output,
  unavailable or invalid installation credentials, permanent account binding, and lifetime
  allowance exhaustion. Anonymous waiting and local saving are distinct states; “Stop waiting”
  cannot promise that provider spending stopped. The drawings do not cover their full matrix.

### Native and web differences

- **Web Coach capability line.** The Coach header says “Reads your log · proposes only”, while
  requested routine creation saves routines directly and returns creation receipts. Existing
  routine changes still require Review/Apply. Replace the inaccurate header with wording that
  distinguishes creation from proposed changes; the signed-in iOS setup phase does not change web
  chrome.
- **Coach Markdown.** Android renders answer Markdown blocks and paces streamed text; web
  `CoachRoom.jsx` renders plain text. Decide the shared block typography and pacing, then align the
  other clients and Figma specimens. Tracking: `gym-android-coach-stream-markdown`.
- **Workout display names.** The API's optional `routineName` changes a corrected workout's
  display name independently of its frozen plan. Native session readers need to prefer it,
  including an explicitly empty name for a free session.
- **F38 · Target entry.** Web uses the ladder as its count; native entry retains Sets. Decide
  whether that difference is intentional. Android's targets are drawn as number steppers (Android
  02.6, 02.11; 11d). Preserve `TargetBlock(scheme, onChange)` until device tests cover varied
  reps/loads, keyboard, focus and TalkBack.
- **4k · Leaving drafts.** Reconcile the unsaved-routine exit policy across web and Android.
  Cover native Back, Cancel, navigation away and restored drafts before choosing confirmation rules.
- **4u · Delete scope.** Define whether a held session deletion also filters movement ranking,
  records and finish reads elsewhere in the room. Undo visibility and stored-count validation are
  already separate concerns (`guidelines/system-architecture.md` §3, the window rule).
- **3s · iOS bottom band.** Coordinate the routine Start refusal, room status and Undo transient
  so concurrent messages cannot hide a reachable action.
- **4v · Browser failure.** Android `ConnectedLogScreen.kt` swallows `openUri` errors. Show a
  recovery when a browser cannot open.
- **Native acceptance.** Keep API 26, notification promotion-disabled fallback, full TalkBack
  traversal and review-gate transitions in the Android acceptance matrix. Existing source or
  representative captures do not establish the full device matrix.
- **Narrow tab label.** Routines has a recorded clipping defect at 320dp/200% text in dark mode:
  the visible label loses its final “s”, while the accessible name remains complete. Fix the
  layout without reducing text scale or target size and verify both themes.
  Tracking: `android-gym-large-text-tab-label`.

### Copy and review decisions

- **Connected-log write disclosure (Android build).** `GymToolCatalog.cpp` exposes append-only
  `save_note` at `gym:write`; the Write level reads *logs sets · saves notes · adds routines · shares
  workouts · proposes changes* on both phones (Android 09.3 `1254:39148`), but Android's copy omits
  *saves notes* (`domain/ConnectedLog.kt:61`), and its head names *Claude, Cursor or Codex* where both
  phones now say *Your log, read by ChatGPT or Claude.* (`domain/ConnectedLog.kt:10`).

- **2h / 2w / 5k · Refusals.** Set one wording rule for invalid numeric entry, byte-limit errors
  and failed session deletion. A refusal must identify the affected act, retain the user's input
  and give a recovery; do not overwrite a useful server explanation.
- **2v · Missing estimate.** Give an absent Top e1RM an understandable spoken state while
  preserving the finish readout's structure; a bare dash is insufficient for that decision.
- **2q / 2x · Unowned strings.** Keep catalog-load refusal, set-note bounds, unrated labels and
  delete outcomes in their feature contracts when changing their wording.
- **3j / 3l / 3u · Proposal cards.** A removal says removal, not a positive change count. Align
  native cards and conversation projections, avoid repeating the routine name, and decide whether
  every routines-home preview needs a separate counted phrase.
- **3q / 4g · Long refusals.** Check Undo messages and Coach limit states at the smallest phone
  width with large text. Recovery actions must remain reachable alongside the explanation.
- **4l / 4q · Held deletions.** Define the copy while a full Notes list or the only weigh-in is
  hidden by Undo. Stored limits and visible rows must not imply that an unsettled delete has landed.
- **4r · Share expiry.** The pre-mint offer must state the 30-day window; an active link can show
  its actual expiry date.
- **9z · One noun per thing (owner rulings, 2026-10-16 and 2026-10-22).** Every phone screen says
  *workout* (never *session*), *movement* (never *exercise*) and *The log* (tab and title); *session*
  stays in code and on the wire. Both pages draw this (iOS 05.9 *Edit movement*; Android pager
  *Movement 3 of 5*, tab *The log*). Code still differs: Android *Log* (tab and
  title, `GymRoom.kt:153`), *Exercise {i} / {n}* (`domain/LiveSession.kt:134`), *Rename movement*,
  *Free session*, *No sessions yet*, *First session*, *This session*, *Discard session*, *Check my
  last session.* (`LoggerScreen.kt`, `LogScreen.kt`, `AssemblySheet.kt`, `FinishScreen.kt`,
  `domain/Deviation.kt`, `domain/WorkoutNotification.kt:54`); the web's *No sessions yet.*, *no
  session · …* and Coach's *… sessions* receipt (`Log.jsx`, `progress.js`, `coach.js`, `DateJump.jsx`).

### Figma reconciliation

- **Coach setup chrome.** The Design System's `iOS / Tab bar · Gym` (`118:93`) now draws Routines as
  `list.bullet.rectangle`, like the app; the Gym boards show it once the owner publishes the Design
  System. Short conversations start at the top in the targets; the app keeps them bottom-aligned.
- **Coach creation-row typography.** The app's receipt rows are the shared iOS `GymRow`: semibold
  body routine name and subheadline metadata. Target 01.9 (`1173:4471`) draws them with the library
  `iOS / List row`; compare the type treatment when the build lands.
- **F35 / 2c / 2f / 2k · Fixtures.** Reconcile old board calendars, reproducible e1RM values,
  performed-set ordinals, Notes counters near their threshold, abbreviated dates and the Coach name
  against the shared domain vectors and each surface's test fixtures.
- **F45 · History reach.** Verify that narrow scroll containers expose their final rows and end
  marker; a clipped drawing is not a usable scroll state.
- **F59 · Web navigation.** The owner deferred navigation changes. Reconcile narrow Coach
  shortcuts, contextual rail, public-reader chrome, back glyphs, sheet scrims and the empty-filter
  Log footer. Preserve Rename, More movement facts and contextual Log/Workout actions where a
  drawing omits them. Content implementation does not close complete-screen acceptance.
  Tracking: `gym-web-navigation-parity-deferred`. Figma owns the board status markers.

## Marketing and email

- **0g / 0h · Landing colour rules.** Clarify whether several product-skin windows are allowed
  and whether a roadmap kind may use brick when brick is excluded from landing chrome.
- **0i · Brand-root anatomy.** Reconcile the common landing roles with the root's product-band
  layout, including a useful loop, truthful limitations and the role of static scenes.
- **0m · First paint.** `appBoot.js` does not reset the browser's body margin before the main
  stylesheet arrives. Check and remove the resulting landing layout shift.
- **F23 / F24 · Email templates.** `magic-link-fork.html` lacks the light-only CSS rule used by
  the other templates. The dormant `magic-link-signup` asset pair uses double-brace URL
  interpolation; remove or reconcile it before use. The signup asset is not selected by the sender.
- **F25 · Changelog.** The public changelog contains only July entries. Keep its material-change
  record consistent with the commitment in Terms.
- **F27 · Nudge template.** `ResendNudgeSender.cpp` references `journal-nudge`, but no template
  is checked into `web/emails/`. Recover and version its source before editing its copy.
