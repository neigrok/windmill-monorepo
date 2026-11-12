# Design consistency

Open disagreements between drawings, the written rules and code, and the questions they leave for
the owner. Remove an entry when its fix lands; current behaviour belongs in the code. Source checks
establish code shape, not rendered acceptance. Figma review tasks below need a fresh file inspection
before editing.

## Shared system

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
  document hides or the room unmounts. Android holds nothing in the room: its only held delete is
  a weigh-in's durable engine hold, which preserves remaining time through recreation and releases
  on true backgrounding.
  Workout/conversation confirmation migrations remain with tasks 14 and 37 (11b).
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
    explicit sign-out or a different account it wipes the account's roadmap trees from the browser,
    unsynced edits included, with no warning: `accountChange.js` calls each product's
    `forgetDevice`, and the roadmap's (`routes.js`) runs `forgetDeviceTrees` (`localTrees.js`),
    which deletes every account-stamped registry row, sync blob and per-tree store. Session expiry
    keeps the device copy and resumes syncing when the same account signs in.
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
    iOS 23d `2:2940`, 23f `49:4140`; Gym Android 07.11 `1254:33533`, 07.12 `1254:33632`); the nouns follow
    what the phone holds (12n). iOS asks in these words (`AdoptionQuestion.swift`); Android words it
    differently (`app/MainActivity.kt:287-304`). The first-run READ ME line `2:1029` still says
    signed-out work *moves to the account on sign-in* with no question.
- **7g · Notes account-only.** Signed out, Notes is a sign-in door, and the signed-out Coach greeting
  (boards 01.1–01.2) offers saving notes only after sign-in. `../foundation/mobile/gym_coach.md`
  Appendix C gives `save_note` `seats: bound` to match, so a signed-out Coach turn is not offered it.
  Rule whether Notes opens signed out, which would make `save_note` `seats: any`.
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
  iOS's counts only writing operations (`Translation.swift`); no iOS plan guards and writes one
  record. Rule whether a guard read may accompany a write to its record before a plan needs it,
  then align the kit spec and both kits. Owner: domain kit.

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
- **6w · Keyboard bars on iOS 26.** SwiftUI `.keyboard` toolbars carry two things only: the ± a Load row
  adds for a signed basis (`LoadRow`: Fix set, Edit sets and the routine's movement form), and the rack's
  single trailing glass ✓ (03.23D, task 72); the rack's own ± leads its ladder (03.30). A retained toolbar
  layout can reduce later sheets' keyboard avoidance, so no other field takes one; after the rack's ✓ has
  landed a load, Fix set's load, Coach's composer and Edit sets' load still stand clear of their keyboards
  (iOS 26.5, `testSheetsAvoidTheirKeyboardAfterTheRacksCheck`). iOS 26.5 sets the rack 34 pt short of its row
  until the first key, so the rack reloads the input views once its field takes focus; iOS 27 needs no help.
  Coach's *Done* is above its composer; the note editor has none. The
  movement form (02L.5) has its Name and Load as text fields and no *Next* or *Done* bar; a scroll lets
  the keyboard go.

### iOS against the drawings and the other phone

- **02 · Routines is Direction L on iOS alone** (owner, 2026-11-07). The routine editor, the movement form,
  the picker and the summary are the stock `Form` parts of 02L.1–02L.8 (`design/ios/routines.md`): the
  toolbar +, Lift-shaped rows, `EditButton`, Steppers for sets and reps, Load as a decimal field, Equipment
  and Rest as menu pickers, Varied sets as a toggle. Android keeps its M3 editor (stepper rows, the
  create-movement target block) and web its own; all three save the same `RoutineEntry(sets, restSeconds)`
  and `Exercise(equipment, loadCount)`, so the surfaces differ in form, not in data. Ledger drift, not a task.
  The boards read ✅ until their 🚀 flip after review. The summary row does not tell a lifter's own
  movement from the catalogue's (02.2 drew a *· yours* mark; the designer owes a drawing if it returns).
  Android's movement form fills a varied scheme with Ramp up and Match set 1; 02L.6 draws no fill, so iOS
  has none.

The Gym file's iOS page is the target (10o). These are the places it, the iOS build, older drawings
and Android disagree.

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
  the Gym boards state none. The sync registry (v12) and the shared gym vectors carry no set kind:
  every logged set counts, and no surface carries one. Copy: every surface labels a workout's count
  *Sets* / *N sets* (finish receipts, workout detail, Coach's read card and sources, the web review tile
  and landing). The Gym boards say the same (mirrored 2026-10-29): iOS tiles 05.3 `1185:5019`
  `1185:5078`, 05.4 `1188:5824` `1188:5876`, 07.2 `1138:2287` `1138:2330`, 07.4 `1283:38779`
  `1283:38902`, 07.5 `1283:38851` `1283:38949`, the 02.13 History rows `1283:42197`–`1283:42264`,
  the 00.2 log row `1057:357` and Coach's read card `I1172:3646;138:1244` `I1172:3716;138:1244`;
  Android 03.7 `1254:32396` `1254:34576`, 03.8 `1254:32481` `1254:34638`, 03.14 `1283:41944`
  `1283:42013`, 03.15 `1283:42310` `1283:42386`, 03.37 `1449:32871` `1449:33786`, 07.2 `1284:16844`
  `1285:17001`, 07.8 `1284:17222` `1285:17108`, Coach's read card `1253:28726` `1254:41271`, and
  every *N sets · duration* / *N sets · N movements* line across 02.13, 03, 05, 06 and 07 (124 text
  nodes in all).
- **9k · On this phone (owner ruling, 2026-10-22; build).** Both phones keep workouts the account
  has not taken in one **On this phone** row at the head of The log, a door to a pushed list (Needs
  you, Adding), Inspect, Fix workout and ⋯ *Discard workout*, with The log tab's badge as the door from
  other tabs (iOS section 07 `1116:1705`; Android 07.7 `1283:42660`, 07.1 `1283:42787`, 07.2
  `1284:16798`, 07.3 `1284:16888`, 07.8 `1284:17208`). Android builds it: the row heads The log
  (`ui/LogScreen.kt:112`), the list, Inspect, Fix workout and ⋯ *Discard workout* live in
  `ui/OnThisPhoneScreen.kt`, and the badge in `GymRoom.kt:1296`. iOS's discard question for a landed
  workout's stranded sets still says *This permanently removes the copy saved on this phone.*
  (`WorkoutInspectScreen.swift:49-53`); see 12g.
- **9m · Iteration-1 boards outside the Gym page.** The Gym iOS page was redrawn to the app on
  2026-10-22 (10o). Iteration-1 drawings of You's native sections and the update-required alert
  predate the native chrome; redraw them from the app.
- **9n · The set-note footer.** iOS's Fix set (board 03.3) draws no footer under the set note;
  Android's Fix sheet gives the field *A record for you — not an instruction to Coach.* as its
  state description (`FixSheet.kt`, `Training.kt` `noteCaption`). Rule one.
- **9o · Log entries are distinct doors.** The approved Android Log (05.1 `1283:39834`) separates
  filled workout cards, plain weigh-in rows between dividers, and slim gold record markers. Every
  weigh-in appears chronologically between the appropriate workouts; it neither competes for a
  decorative weekly moment slot nor moves to a top Bodyweight card. Workout cards open detail,
  weight rows open Bodyweight, record markers open Record, and month markers have no action.
  Unknown/backdated clock times are not invented. Android's current moment expansion and weekly
  selection need the task-22 read/presentation changes.
- **9p · A record stated once, and what counts as one.** iOS (section 05) states a record by its
  moment, or by a `gym/record` dot after a session's name when the one-a-week cap leaves it without
  one; a session row's second line is always its facts. Android states a record twice — the row's
  second line *Record · Bench Press 84 × 5* (`LogReadout.kt`) and the woven *new best* moment; the
  owner ruled (2026-10-22) that Android follows iOS: once, by the dot or the moment, and the Record
  lists *Earlier records* (Android 05.1, 05.6). What counts as a new best is ruled for every surface by the shared
  vectors (`packages/api-contract/gym/domain/training-reads.json`, `ProgressRecords`): a movement's first estimate is its baseline, and a new best beats
  the best before it as the log states both, to 0.1 kg. Android Record uses the shared superseded-record
  identities for Earlier records, excluding the standing best. Two iOS reads still compare exact estimates: the Record's **Earlier
  records** and *Best e1RM* walk `MovementProgress.records`, so a step the log does not call a new
  best can stand there at the same stated value as the best before it; and the receipt's *Personal
  record* is the server's (`Review.cpp` `recordFor`), which needs a prior estimate but compares
  exactly. Rule whether both follow the stated rule.
- **9q · Where Weigh in sits (owner rulings, 2026-10-22; build).** Both phones float *Weigh in*
  bottom-end over The log: iOS as the labelled glass capsule (target 05.1), Android as the M3
  extended FAB (Android 05.1). iOS builds it, the list's bottom inset keeping its last row clear;
  Android builds it as `GymExtendedFab` over The log (`ui/LogScreen.kt:183`), the list's bottom
  padding keeping its last row clear.
- **9r · No Gym settings anywhere (owner ruling, 2026-10-22; Android build).** Neither phone has a
  Gym settings page. On iOS, Notes and Connected log are reached from You's Settings
  (`AccountSheet.swift:419-431`) and a hidden workout from the tab bar's accessory on iOS 26 and the
  **Hidden** row at the head of The log on iOS 18 (board 03.5). Android draws the same: You holds
  *Notes*, *Connected log*, *About Windmill* (Shell · Android 16a/16b), the workout bar's trailing
  action is *Hide*, and Units go. Android builds this: the room gives You its *Notes* and
  *Connected log* rows (`GymRoom.kt:375-376`) beside *About Windmill* (`app/MainActivity.kt:282`),
  the workout's top bar trails *Hide workout* (`ui/LoggerScreen.kt:477-479`), no units control
  remains, and Coach's top bar holds History and the account seat (`CoachHead`, `coach/CoachAccess.kt`).
- **9s · Notes' lines (owner ruling, 2026-10-22; Android build).** Both phones head Notes with *Any
  agent you connect can read these too.* only: no subtitle and no *Top note wins.* (iOS 09.1; Android
  09.1 `1254:39045`). Android's task 26 implementation uses that single line and removes both
  obsolete strings from `ui/NotesScreen.kt` and `presentation/Notes.kt`.
- **9t · Connected log with a connection.** Android source (`ConnectedLogScreen.kt`) follows the
  approved connected/empty roots and separate disclosure page in 09.3–09.5. Browser rows use the
  drawn `arrow_forward`; the How door uses the matching Material chevron. Task 51's paired local
  native comparison passes with the physical camera-cutout inset accounted for. At 320 dp/200%,
  the complete body and How door are reachable by scrolling, with the root action pinned.
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
- **10f · What Coach did, in iOS's words.** The web puts the phrase table's words in a step
  list behind the read receipt. iOS and Android draw no step list: the receipt row opens *What Coach read*
  (board 08.5), and the table's words stand where iOS says what Coach did — the receipt's *Read your
  movement history* for a totals-only read and *Read nothing from your log*, *Also read your notes.*
  under *What Coach read*, and one row per act, *Open routine · Push A* and *Saved a note*, which iOS
  draws as a card under the answer (10v). The words
  differ too: the return receipt on boards 08.12–08.13 reads *Applied · Push A · 4 changes*,
  *Applied · Push A · routine removed* and *Rejected · Push A.*; the web's `receiptLine` still says
  *Turned down* (10v); iOS's card and History share one word per outcome — *Applied*, *Removed*,
  *Rejected* — and add *Out of date* for a superseded proposal (`CoachCopy.settled`). Decide whether the step list holds on every surface, and whether web and Android take
  *Removed* and *Out of date*.
- **10g · Backend: the read receipt's weeks.** The server's read receipt counts weeks no
  observation names: `GymTools.cpp` adds every week `get_stats` returns, empty ones included, and
  `ReadReceipt.cpp` each set's week. iOS counts weeks only from the workouts *What Coach read*
  lists and never prints `read.weeks`, so a totals-only answer reads *Read your movement history*
  with no number; the web prints the server's weeks (`coach.js` `readLine`), and Android the weeks its own
  receipt counts (`CoachReply.readLine`). The fix belongs to the backend: dogfood node `coach-receipt-weeks-provable`.
- **10o · The page is the target.** The Gym iOS page holds the current target. 🚀 means the
  drawing matches verified implementation; 🔨 means implementation; ✅ means human-approved design
  ready for development; 🚧 means design or approval remains open and its caption names that work. The six flow
  corrections in 10y are approved, with their implementation status on each flow. Device or fixture evidence is also pending where captions name it:
  04.1, 04.3, 04.4, 05.8's pan, 08.6 and 08.7.
- **10p · Gym iOS target boards.** The Gym file's iOS page holds Dark and Daylight targets.
  Each flow carries its delivery status; the six-flow contract in 10y covers the revised interactions.
  Target inventory:
  - 01 and 08: listed under 10q.
  - 02: Direction L (`design/ios/routines.md`), 02L.1–02L.8 `1992:18823`–`1992:19789`.
  - 03: rack with Dumbbells 03.1 `1150:2352`; its states pressed 03.10 `1150:2495`, changed with 56 pt
    hit areas 03.11 `1150:2638`, Bodyweight with added load 03.12 `1150:2793`.
  - 04: the compact Lock Screen card 04.7 `1723:15733` (✅, task 69); the build draws it 141 pt
    tall at default text and 156 pt at the largest, under ActivityKit's 160 pt cap.
  - 05: The log with its labelled Weigh in 05.1 `1153:2765`; Edit movement 05.9 `1153:2559`; the
    Equipment menu 05.10 `1153:2603`.
  - 08: Coach updates a movement 08.9, listed under 10q.
  - The one floating action left is Liquid Glass with its symbol in the accent: `_Gym / Floating action`
    (`1190:195`, Gym Components page), Label=Text, the labelled *Weigh in* capsule on The log (05.1),
    since a bare + did not say what it adds. New routine is the toolbar + (02L.1).
  - The rack names its equipment as a symbol in the movement header (03.1, 03.10–03.12); the
    build's *Two dumbbells · 32 kg total* line is gone from the rack, while totals keep its model.
  - The rack's load is typed in place on the system `.decimalPad` and its reps turn on one wheel in a
    compact sheet, and Fix set draws the same load field over the same wheel above Effort, Note and
    Delete set, as the 10z boards draw them (03.23 `1708:14353`, 03.24 `1708:14490`, Fix set 03.25
    `1709:14337`); the ladder keys stay for one-tap nudges. The weigh-in (06.1 `1191:5884`) uses the
    system `.decimalPad` in a focused field.

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
  01.5 `1589:39166`, 01.6 `1173:4264`, 01.7 `1173:4370`, 01.8 `1173:4471`, 01.9 `1182:4650`,
  01.10 `1173:4600`, 01.11 `1173:4678`, 01.12 `1173:4754`, 01.13 `1173:4833`; 08.1 `1170:2943`,
  08.2 `1203:6633`, 08.3 `1203:6896`, 08.4 `1172:3561`, 08.5 `1172:3621`, 08.8 `1170:3105`, 08.9
  `1170:3192`, 08.10 `1170:3266`,
  08.11 `1170:3364`, 08.12–08.14 `1203:7214`, `1203:7452`, `1203:7628`. Owner rulings since:
  proposals and drafts are decided inline on their cards (no review sheet), and the greeting is two
  bubbles of anchored capabilities. The iOS build draws the targets (`Coach/CoachMessages.swift`,
  `CoachTab.swift`): bubbles with tails, the lifter's in `gym/accent` set in `on-accent`, a sent photo
  as a 200 pt image bubble, timestamps, the typing bubble, Markdown in a full-width bubble, and the
  round + outside the field with the send arrow that appears with text. Android draws its own Material form of
  them (`coach/CoachBubble.kt`); the web still draws the older chat.
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
    routines*); the web and Android's retained onboarding answers still offer only Save. The card's loads read *60 kg* and *22 kg each*, the
    proposals' words, where 01.7 draws *60 kg total* and *22 kg, one dumbbell*.
  - Block order: a rename, moves, changes, removals, then additions, as the shared `ProposalDiff`
    vectors order them; iOS follows the vectors, and 08.2P and 08.27P draw that order.
  - Field lines: 08.21 draws only the fields that change (*Push-up · Reps*), where 08.2P and 08.27P draw a
    set's unchanged fields plain, as iOS and the shared vectors do. 08.21 also draws three blocks with no
    disclosure, where the card's rule shows two, then *1 more change* (08.2P).
  - The card's field diff (per field old → new, per-set lines once sets differ, *Max*, *Last time*,
    *None*, *No change: N movements*), the *Renamed* block for `proposedName`, and swap as removed +
    added are built on iOS from the domain's `ProposalDiff`, whose vectors Android's and the web's
    domains also pass; no Android or web screen draws them yet.
  - 08.4 gives a conversation that proposed and created nothing a second line — *Changed a movement*, or the answer's
    first words; iOS History draws such a row on one line unless its latest turn did not complete. Android 08.4's
    *Changed a movement* cannot land: `update_exercise` is withheld (B-1).
  - 08.31 (iOS `1217:8214`, Android `1254:38214`, both 🚀) draws *I need your account to change a routine. Sign in,
    then ask again.* over one Sign in. The catalog gives a signed-out turn `create_routine`, `create_exercise` and every
    `propose_*`; only `save_note`, `share_session`, `share_log` and `revoke_share` need an account. On a phone turn the
    bubble is the model's words, and the product fixes only the Sign in under the answer, shown when a call is refused
    `seat-required` (`coach/AskScreen.kt`, iOS `CoachMessages.swift`). The fixed sentence stands only over a retained
    onboarding answer. For the owner: whether the board is redrawn, with a caption such as *Signed out, Coach reads,
    creates routines and movements, and writes proposals on this phone. A saved note or a share needs an account: one
    Sign in under the answer.*
  - A failed apply's red line and **Try again** and Reject disabled while Applying (08.29, 08.30) are built
    on iOS only.
  - Strings in code still carry the cut and pre-simple-English copy: *You decide the numbers at the rack.* (Android
    `Program.kt`, web `routines.js`), and web `coach.js` *Coach reads your log, so it needs you
    signed in.*, *Coach isn’t part of this Windmill…* and *The next question frees up…*. Android's
    refusals name a moment only where the server's `budgetResetsAtMs` names one
    (`coach/turn/CoachTurnRefusal.kt`); web ignores the server's moments. iOS Coach's
    greeting, access states, allowance refusal and photo captions now read as 01.1–01.11 and 08.6–08.8, but for the
    departures below.
  - iOS departs from a board where the board's words claim more than the build can keep; the boards want redrawing:
    - 08.9, 08.25 and 08.26: the *Saved a note* card carries the note's title and body, read from the record the
      call created. No movement card is drawn: Coach is not offered `update_exercise` (withheld,
      [gym_coach.md](../foundation/mobile/gym_coach.md) B-1), so 08.9 and 08.26 are unreachable, and a
      `create_exercise` call draws no card.
- **10r · Swipe delete is the native trash circle (owner ruling, 2026-10-22).** Everywhere in gym a
  trailing swipe slides the row and reveals a round red trash circle with no text label, drawn with
  the local component `_Gym / Swipe actions` (`1190:172`). iOS draws it with one shared modifier,
  `TrashSwipe` (`Gym/Components/GymRows.swift`), on the Routines list, The log, workout detail sets,
  Bodyweight entries, Notes, Coach History, the routine editor's movements (02L.3 `1992:19044`, a list
  the system `EditButton` orders) and This workout's movements (03.4 `1135:1875`, a list out of edit mode
  that draws its own handles and drags on a long press). A one-line row draws the system's capsule
  rather than a circle (05.4's set row).

  Deletes outside swipes keep their native form: context-menu *Delete routine*, *Delete set*,
  *Delete conversation*, *Discard workout*; the editor's *Delete routine*; the sheets' *Delete set*,
  *Delete weigh-in*, *Delete note*; Inspect's *Discard workout*; and the receipt's top-corner
  options menu with *Discard workout* and its confirmation.
- **10x · Log and editing differences between the build and canon.** These differences remain
  alongside the six flow contracts in 10y:
  - Workout detail's tiles share one card parted by hairlines (05.3), and the one session
    constructor draws them so on Inspect too, where 07.2 draws one card without hairlines; the
    receipt sets each tile on its own card, as 03.7 draws them. Settle one form for 05.3 and 07.2.
  - The Equipment menu (05.10) draws Bodyweight third; the build lists it last, as Create movement
    does (Barbell, Dumbbells, Machine, Cable, Kettlebell, Bodyweight), from the one
    `MovementEquipment.choices`. Its basis help is the one `MovementEquipment.help`, so Edit
    exercise and the routine's movement form read the same words.
  - Notes (09.1, 09.2): on iOS a row and the editor are the note's one text, while the domain still
    stores a title and a body: the editor takes a first line of up to 60 characters as the title and
    the rest as the body, and a longer first line keeps the whole text in the body under a title cut
    at a word boundary with *…*, which is how it reaches the other surfaces. Coach's `save_note` and
    the rules are unchanged.
- **10y · Approved iOS Gym flow corrections.** The [six-flow handoff](../engineering/ios-gym-ui-flows.md)
  covers fresh Coach entry with retained history, stable tabs and composer; chronological and
  distinct Log entries with date headings and weigh-in separators; the compact weigh-in and native
  graphical calendar; the compact workout ledger and movement picker; two full-width receipt actions
  with the Coach crown and a top-corner Discard menu; and one movement form with inline targets. The affected
  Dark and Daylight boards have human approval. Designer runtime review accepts the captured states
  of all six flows; Coach and receipt large-text pixels are outside that review. Current delivery status
  lives on the Figma flows; scoped native and local-stack evidence is in the engineering handoff and PR. Dogfood
  nodes use the prefix `ios-gym-ui-oct23-`.

  The combined editor's Daylight board is `1367:10387`; references to removed `1181:4611` must use
  it. The original checkout's untracked `iosgym_tasks/done-30-targets.md` still points to the removed
  board and describes the separate Targets destination; its owner must reconcile that local task.
- **10z · The workout in flight (✅ Ready for dev, owner approved 2026-10-30).** Boards 03.20–03.32,
  04.6, 04.7, 08.54, 08.56P and 08.57 with a READ ME in section 03 (`1717:15737`); the written half is
  [workout-in-flight.md](ios/workout-in-flight.md) and the build tasks are `iosgym_tasks/60`–`69`.
  Owner ruling 2026-10-30: a movement with a logged set keeps its plan. The build draws the rest
  target (03.20–03.22), the typed load and the one reps wheel (03.23–03.25), Coach during a workout
  (08.54), both proposal cards (08.56P, 08.57: a change to this workout applies to the running plan, a
  routine change applies for next time), the in-flight plan edits (03.26–03.32), and the rest target
  outside the app on the expanded Island (04.6) and the compact Lock Screen card (04.7, task 69),
  neither of which says what is unsent. 04.3's expanded presentation draws a moving rest bar the build
  does not carry; 04.6 is what it draws. Where 03.32 and the build differ, for the designer to settle:
  the receipt's PLAN CHANGES card speaks the proposal card's diff language, so a changed set reads
  *Set 1 · 8 × 10 kg → 8 × 12.5 kg* and every set line of a changed movement stands (03.32 draws
  *10 × 8 → 12.5 × 8* and the changed set alone); and a reorder an applied Coach change made counts in
  *‹n› changes* but draws no Moved block, since the plan's diff carries no order lines.
  Web still refuses Coach while a workout is open (server Ask `ask-session-open`); iOS and Android
  answer during one.
- **The rack's load is its field (owner ruling 2026-11-06; 03.23A 🚀 In production 2026-11-07).** Board
  03.23 in the Gym · iOS file (`vdmdiKWrmZoS1FtcvJRf6O`) drew the numeral turning into a field while the
  ladder, reps and Log set stepped aside and ✓ and ± sat on the numeral's line; the owner ruled the controls'
  leaving and the numeral's travel on landing a bug. Direction A, approved 2026-11-07, is drawn as 03.23A
  (`1940:16624` at rest, `1940:16714` typing) with its [note](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1942-17441):
  the numeral is a permanent load field, the rack rides the keyboard as one block, nothing in it appears,
  goes, resizes or moves, and Log set commits the typed load and lands the keyboard.
  The build draws it as [workout-in-flight.md](ios/workout-in-flight.md) states (`WorkoutRack`, `LoadField`);
  the earlier 03.23 (`1708:14353`, its Daylight twin and caption) is marked 🗄 Superseded until the owner deletes it.
- **The sign key leads the ladder (03.30 🚀 In production 2026-11-07).** The earlier 03.30 drew ± in the
  keyboard row over Edit sets. Direction A redraws 03.30 for the rack (`1940:16984` at rest, `1940:17074`
  typing): for bodyweight and Other a fifth key, ±, leads the ladder, present in both states and for no other
  basis, and the build draws it (`WorkoutRack.ladder`). Fix set and Edit sets keep ± in their keyboard row
  until their boards are redrawn; the note says their ± belongs beside the field.
- **A ✓ on the rack's keyboard row (owner ruling 2026-11-10; 03.23D, built in task 72).**
  The decimal pad carries the system keyboard row, `ToolbarItemGroup(placement: .keyboard)` on `WorkoutRack`,
  holding one trailing `Button("Done", systemImage: "checkmark")` with `.labelStyle(.iconOnly)`: a clear glass
  disc, the ✓ in ink, read *Done*. It lands the typed load as a tap outside does and drops the pad without
  logging a set (03.23D.1 `2089:22046`, signed basis 03.23D.3 `2089:22300`, landed 03.23D.4 `2089:22433`,
  [note](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=2090-22691)). The row takes 48 pt from the
  page: on 402 × 874 pt the rack covers the clock row and cuts the dots on iOS 26.5, while iOS 27.0's shorter pad
  leaves the dots whole; on 375 × 812 pt (Display Zoom, 13 mini) the rack covers the movement name, which the owner
  accepted (03.23D.5 `2089:22565`); on 375 × 667 pt (iPhone SE, iOS 26.5 capture) it rises to about 5 pt under the
  bar's buttons and stays clear of them. Fix set's and Edit sets' keyboard rows stay as they are and take no ✓.
  The text *Done* (03.23D.2) is ❌.
- **Fix set's *Delete set* rests under the ± glass (build drift).** With the pad up on a signed basis, Fix set's
  form rests with *Delete set* under the ± keyboard-row disc, so the red label reads through the control and
  tints it pink in Daylight (iOS 26.5 capture, 2026-11-10). The form's bottom inset ignores the 48 pt keyboard
  row, and the input-views reload that settles the rack's row does not lift it (iOS 26.5 probe). Edit sets is
  unchecked.
- **03.23A draws the decimal pad 28 pt high (drawing drift).** 03.23A (`1940:16714`) and 03.30 (`1940:17074`)
  draw the pad with a 44 pt QuickType bar `.decimalPad` does not have, so its top sits at 538 pt where the
  iPhone 17 Pro capture puts it at 566; the key rows line up. The 03.23D boards draw the captured pad.
- **The drawn rack is about 20 pt taller than the build (drawing drift).** 03.23A, 03.30 and 03.34a–c draw
  Log set 52 pt tall and wider gaps between the ladder, reps and Log set; the build (`WorkoutRack`, a VStack at
  `RoomSpace.inset`, Log set about 61 pt) runs about 20 pt shorter from the numeral to Log set's foot. The
  03.23D boards follow the captures. The ledger boards L.1–L.3 (`2074:52825`) carry the same drift: on 402 × 874 pt
  the build's ledger card starts 23 pt lower (237 against 214, its movement head and facts taller than drawn) and
  its rack 43 pt lower (511 against 468), so seven rows get 266 pt of room against the drawn 246; on the SE the
  room is 135 pt against 139.
- **The rack's unit stands apart from a two-digit load (build drift).** 03.23A, 03.23D and the L boards draw the
  unit at the numeral's baseline right beside it. The build leaves about 75 pt between a two-digit load (16, 18) and
  *kg each* on 402 × 874 pt, at rest and with the pad up (iOS 26.5 and 27.0 captures, 2026-11-10), while *12.5*
  stands beside *kg added*. Why the field keeps that width is unchecked.
- **Planned rows read the plan, never today's set (owner ruling 2026-11-06; 03.34a–c 🚀 In production 2026-11-07).**
  The build before this drew the rows still to lift carrying the load the rack will offer, which after a logged
  set is that set's load; the Android 03.34 rack-height board (`1742:40960`, `1742:41112`, still canon for
  its own state) shows open rows at the rack's 22.5 only because its plan and rack coincide, and the planned-rows
  rule is drawn by its companion `1942:53327`. The owner ruled that a logged row is reality and an
  unlogged row is trajectory: a current or planned row reads the load the plan expects of it
  (`Prefill.expectedLoads`: the target's own load, else last time's as the rack resolves a "last" target), and
  no set logged today, nor anything on the rack, changes it; the rack's own prefill still follows today's last
  set. 03.34a (`1940:17164`) draws that, 03.34c (`1940:17344`) an unread last time whose load slot is a
  `.redacted(.placeholder)` bar, and the build draws both (`WorkoutLedgerRow.reading`), planned rows in
  `gym/ink-dim` as the boards draw them. Two things on these boards contradict the shared contract and are not
  built: 03.34b (`1940:17254`, a first time with no plan load and no history) draws *— × 10* and a rack at
  *0 kg*, and 03.34c draws its rack at *0 kg added*, where `Prefill` (`training-reads.json`, Android, iOS, web)
  prefills the empty bar, 20 kg, so the build reads *20 × 10* and *20* on the rack. Android's 03.34 pair
  awaits the same ruling (✏️ beside it on the Android page).
- **Proposal · one suggestion on an empty Coach (owner decision).** Outside first-use setup, board
  08.1 draws an empty Coach as the bar, canvas and composer. The
  proposal: while no conversation exists, at most one `.glass` capsule above the composer, chosen
  from the lifter's state and never from capability copy — *Build me a routine* with no routines,
  *How did today go?* after a workout today. A tap fills the composer without sending, and the
  capsule leaves with the first message. It waits on the owner and is not drawn.
- **List sections keep the system's corners (build drift, no SwiftUI API).** Every card on a room's canvas is
  `RoomSpace.cardRadius`, 22 pt continuous (`Theme/TypeScale.swift`, drawn as `.card`), as the approved sections
  draw it: Gym [`1811:64816`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1811-64816) and Journal
  [`231:431`](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=231-431), on the Figma variable
  `ios/radius/card`. The sections of the system's inset-grouped lists and forms keep the system's corners, about
  26 pt on iOS 26 and 27 and 10 pt on iOS 18: Edit movement, workout detail, the Record's *Earlier records*, the
  receipt's *Personal record* and *Performed*, Fix workout and the weigh-in. SwiftUI has no public API for a list
  section's radius. For the designer: whether the boards draw those sections at the system's radius.

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
- **9f · iOS onboarding gym drawing follow-up.** Shell · Android A4 (`2:10131`,
  Daylight `2:10203`) matches the approved current-rack substitution: three headerless rows,
  the checked current row, glyph clocks, *100 kg total*, *5 reps* and the full-width *Log set*.
  Its editable miniature preserves the Shell card, copy, pager, actions and surrounding geometry.
  The iOS code already reuses `MovementLedger`, `WorkoutLedgerRow` and `GymNumeral`
  (`OnboardingGlimpses.swift`); inspect the iOS A4 drawing and `_Glimpse / Gym` (`210:56`)
  against that current rack before editing them.
- **9g · Where each product lives.** The iOS app tags both rooms *In this app* (`Onboarding.swift`);
  Android tags Journal *On the web* and Gym *In this app* (`gym/src/main/res/values/onboarding.xml`).
  Decide whether Android's tags name the iPhone.
- **9h · The text leads at accessibility sizes.** iOS puts the text block first at the
  accessibility sizes, with the glimpse after it at 260 pt, so a page opens on its title and body;
  at the standard sizes the glimpse keeps the lead and shrinks to a 220 pt floor before any page
  scrolls; and a page that scrolls fades its bottom edge under the dots. Check Android at font scale
  2.0 on a device for the same cut.

## Roadmap

- **Guide · boards against tokens and undrawn desktop states (17).** The [desktop boards](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=856-69888)
  type `#884321` on Save, the field edge, the Read guide link, focus rings and the caret, and no token holds it. Web
  builds Save, the field edge, rings and the caret on `--color-brand` and the link on `--text-link`; Save's white label
  is 3.92:1 where the board's is 7.31:1. Four desktop states are built and not drawn: the card's place on the Board
  (first in its flow, above the filter strip), the reader's card with *Read note*, the compact *Add guide* card, and
  the device tree's footer line. 17.36 draws Save solid on an empty draft while 17.22 *Before typing* draws it off; web
  keeps it off, as it does after *Load latest*, where 17.33 draws Save solid on a draft equal to the guide. 17.38 and
  17.39 omit the device line that 17.29 draws; web shows it above the row. 17.32 draws a 513 px sheet over the
  keyboard where 17.23 draws 451; web keeps 17.23's cap, so the field gives up the notice's height.
  The recovery boards ([three save failures](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=858-75016),
  [17.31–17.32](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=856-69845)) type three tints no token holds:
  `#fcf0e8` under the desktop failure line, `#fbf3eb` under the phone's and `#f7f3e6` under the phone's *Guide changed
  elsewhere*. Web builds both failure lines on `--color-danger-bg` and the notice on `--surface-sunken`, the
  *Draft copied* tick on `--color-brand`, and the notice's text, typed `#312617`, on `--text-primary`. The
  design-system Button differs from the boards' buttons: 46 px tall where they draw 44, so the desktop failure block is
  74 px where the board's is 72; radius 16 and side padding 20 where they draw 12 and 18; and a ring on every focus
  where they draw none. The resting field keeps its 1.5 px edge in `--border-default` where the failure boards draw
  1 px. The `🧩 Board / Guide save failed` component (781:43205) still describes Save staying and a 12 px phone line,
  and its variants carry older copy (*Couldn’t save — you’re offline.*, *Copy your text to keep it.*); the boards it is
  placed on draw the line's act in Save's place, the phone line at 14 px and their own copy, and web follows the
  boards. Built and not drawn: a guide changed elsewhere from 744 px (one line, *Changed elsewhere. Saving replaces
  that version.*, with *Load latest*); *Draft copied* on phones (the phone's line on `--surface-sunken`, with Cancel
  and Done); a failed save's line under a *changed elsewhere* line when both stand; a clipboard that refuses, which
  leaves *Copy draft* standing and says nothing; the recovery states in the dark theme; and a save by someone who is no
  longer the owner, which shows the refused line though no request was sent.
- **Step relations · "Opens", "Unlocks" and "Tree" (18–22, 27, 28).** The approved step editor heads the steps a
  step unlocks with *Opens*; the Board card says *Unlocks*. The approved
  [28 · A node opens a tree](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=876-48881) calls the tree a
  step opens *Tree* (Open tree, Attach, Detach tree) to stay clear of both. *Opens* and *Unlocks* still name one
  relation with two words.
- **Section 28 · parts outside the library.** The Step card has no slot for the tree pill, so section 28 keeps a
  `🧩 28 · Parts` frame (Step card · tree, Tree pill, Step / Tree row, Back chip, loop and chevron-left icons). The
  Figma Skill Node has no form variant though `scene/NodeBatch.js` has, so the tree node is a composed frame. Move
  the parts into Components.
- **Section 28 · drawn on surfaces the web does not have (28.05, 28.09, 28.10, 28.24–28.28, 28.36–28.42).** The boards
  stand a step that opens a tree on the step editor of 19, the selected-step popover of 18.03 and the phone step card of
  27.08. The web has the step modal and page, the Graph's dock and tablet panel and the phone Graph's bar, so the parts
  sit in their equivalents there: the Tree section after Prerequisites and Unlocks, what completes the step and Open
  tree beside Edit step where Complete sat, done of total and Open tree in the dock and the panel, and the tree's mark,
  *Up next · 3 of 8* and Open tree in the bar. The swipe reveals Open and stops there, as it does for Complete; 28.10's
  full swipe that opens the tree is not built.
- **Section 28 · states with no board.** A tree whose facts the load did not read (the device's own copy, a `503` on the
  pointers, a pointer set while the roadmap is open until it is read again) shows the tree's mark on the node and Open
  tree, and no pill, row or words; its step stands by its prerequisites and is never done. A step whose pointer leads nowhere and whose own mark
  already completed it shows *Done* with the *Tree not found* row and no words where Complete sat. A locked step whose
  tree loops back or has no steps keeps the loop's or the empty tree's line. The tablet band and C on a card whose tree
  loops back (*Won’t complete by itself*) or is not found (*Can’t complete yet*) follow the desktop boards. 28.38, a
  tree removed since the roadmap loaded, cannot be told from what the server answers and is not built.
- **Section 28 · gaps ruled to stand.** The card's pill is not a control of its own: a pointer press goes in, and the
  keyboard's way is the step and its Open tree. Focus after going into a tree lands on the body. An opened tree
  deleted since the load shows the generic load error, with no way back but the browser's. During an outage
  `roadmap-opens-load` reports once per page load. The row's Export writes the raw marks, so a step done by its tree
  exports unchecked (filed with the export).
- **Section 28 · no door without an account.** A lapsed session, a device's copy with nobody signed in and a page
  that started with no connection (until the server answers for the account) show the tree's mark on such a step and
  no Open tree, pill press, swipe Open or way back; no board draws this state.
- **Section 28 · a step that opens the tree it stands in.** No board draws it. It keeps the loop's mark and words
  (*Loops back*, *Won’t complete by itself*) and has no door: no chevron on the pill, no Tree row to press, no Open
  tree.
- **Section 28 · read-me and fixtures.** The read-me 28.00 still lists the tree switcher's delete confirmation
  under "Not drawn"; it is drawn as 🚧 28.50–28.52. Coast trip reads "0 of 5" on 28.00 and 28.02 and "No steps" on
  28.14 and 28.44. The picker on 28.14 leaves out My life, though its NOTE says the rows are the switcher's list
  minus the current tree. 28.38 (the tree was removed between loads) has no phone twin.
- **Section 28 · making it is drawn twice (28.13–28.23, 28.44, 28.46 and 28.54–28.67).** Journey 3 stands attach, fork
  first, change and detach on the step editor of 19, which the web does not have. Journey 10 restates it on the step modal
  and page: a Tree section with *None* and a +, the picker as a page in the modal, Change tree and Detach tree under the
  section's own ⋯, so a step with a tree shows two ⋯ of different scope. Its picker takes the phone's context line
  (*For Learn to sail · 5 trees*) where 28.14 has a caption, lists My life and reads Coast trip as *0 of 5 done*.
  Journey 10 adds one toast Journey 3 does not draw, *Tree detached*, for a step that held no mark. Its four parts
  (Tree picker row, Tree heading, Tree menu, Tree sheet) sit in the journey's parts frame, not in Components.
- **Section 28 · making it on today's step page, states with no board (28.54–28.59, 28.61–28.66).** The person owns
  no other tree: the picker says *You have no other trees yet.*, Attach is disabled and the fork line stays. Find a
  tree matches nothing: *No trees match “…”* with Clear search, and *Your selection is kept.* where a row is chosen,
  as the prerequisites picker does. Attach waits whenever the chosen row is not on screen. Only this app's address or a
  bare tree id is taken for a roadmap; any other text only filters. The list could not be loaded: *Couldn’t load your
  trees* with Try again, never the empty state. The roadmap a pasted address names could not be read: *Couldn’t load
  this roadmap* with Try again in the address's place, the rest of the picker standing. A read refused for want of a
  session is the room's lapse, with no Try again. A pasted address that names no roadmap the person can read: *No
  roadmap you can read is at that address.*, and the list and the choice are as they were. A pasted address of the
  roadmap the person is in matches nothing. The hand-mark line has three forms: the drawn one with its count, *Your
  Done mark is set aside while it opens a tree.* where no step locks again (the tree chosen is complete, or the step's
  tree is being changed), and no line where the step holds no mark; before a row is chosen it counts as for a tree that
  is not complete. The ⋯ footnote drops the tree's name where none is known (*This step becomes ordinary.*). A write
  the session would not take says *Couldn’t change the tree. Try again.* in the toast and leaves the picker open; a step
  that already opens the tree chosen, as when another device set it meanwhile, closes the picker with nothing said. A
  step held in a pending delete has no page, and a roadmap whose session cannot take a write shows no + and no ⋯, as
  its Edit step cannot save. After Attach the row stands at once as the picker knew the tree, and the server's facts
  replace it once the server has confirmed the pointer.
- **Section 28 · making it on today's step page, against the boards.** The blocked row on 28.56 and 28.63 reads *By
  Maya · you can read it*; no server answer names a roadmap's author, so the row reads *Someone else’s · you can read
  it* and keeps the drawn sentence for an answer that names one. The phone sheet on 28.65 keeps the sheet shell's
  close button beside the tree's name. 28.39 and 28.42 draw Choose tree where Complete sat; the web offers Change tree
  under the section's ⋯ and no button in the band. The loop's and the missing tree's ways out (*Detach one side.*,
  *Choose another, or detach it.*) show only to the person who has the ⋯; a lapsed session and a device's copy with
  nobody signed in keep the fact alone. Crossing 744px with the tree picker open starts it again: the list is read again and the choice is gone. 28.60 and 28.67, the
  picker on a device with nobody signed in, are not built.
- **Phone step page · 20.01 against the build.** 🚀 20.01 (397:28208) draws the counts and chevrons short of the right
  edge, a two-colour identity rail and no Shell row; the build runs them to the edge under the Shell row.
- **Tree switcher · delete row.** The shipped confirmation is one line with an ellipsis (`confirmCopy` in
  `identity/TreeSwitcher.jsx`), while 🚀 03.03 draws it wrapping; 28.50 needs it to wrap. Rename and delete show
  on hover only, so a touch tablet from 744 px has no clear way to them. The open trigger has no left padding.
  Below 744 px no surface removes a tree.
- **Flow index · step editor.** The [flow index](../index.md#roadmap--web) has no rows for the step editor sections
  (18–22, 27) on Board · Web.
- **Web reconciliation evidence.** All 25 current Roadmap screen/state families are mapped in the
  [evidence log](roadmap-web-reconciliation.md) and linked from the [flow index](../index.md#roadmap--web).
  🚀 marks source/runtime reconciliation; runtime limits are separate. Native graphs and SwiftShader
  captures do not establish WebGL lighting, animation timing or real-GPU performance.
- **Web AI failure recovery.** Ask AI closes on submit on desktop and phone; `useRoomTend` keeps the
  sentence while the run continues. Failure reopens Ask AI with that sentence unless the user explicitly
  dismissed it during the run, in which case the next opening restores it. The toast copy is unchanged.
  Update the Figma Tend drawings ([desktop](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-152),
  [phone](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=185-194)) to show failure reopening
  with the sentence and recovery after a mid-run dismissal.
- **Web shortcuts layout.** `skilltree.css` keeps two columns and nonshrinking keycap groups.
  At 390px, Pan/Zoom overlap View; Windows desktop Zoom also extends slightly into Edit. Local
  owner/reader and Mac/Windows captures confirm this. Adapt columns/key wrapping in the implementation;
  current Figma deliberately shows the defect.
- **Published web input sizing.** The imported Design System Input field imposes 100px minimum height,
  while ForkDoor uses 46px. The product drawing uses an explicitly named local source adapter. The
  library owner should correct the primitive sizing before replacing that adapter with an instance.
- **Web sharing copy.** `ShareDialog.jsx` publishes private or unlisted trees directly to public
  before copying a link, and discloses gallery eligibility. `BrowsePage.jsx` empty copy instead says
  sharing keeps a tree unlisted and listing is a separate choice. Reconcile the gallery copy with the
  implemented publication action; the Figma share flow reflects the action, while the gallery
  empty-state specimen retains the current contradictory copy with a ledger annotation. Gallery
  search/filter thresholds in `galleryIndex.js` are not rendered by `BrowsePage.jsx` and are not
  current controls.
- **Marketing capability copy.** `RoadmapLanding.jsx` says starter quests and paste-list creation
  are still growing in, although `QuestShelf.jsx` and `PasteComposer.jsx` provide both. Its promise
  that a first branch unlocks tonight also exceeds the completion-dependent unlock behavior.
  Marketing owns the copy correction; Roadmap drawings must not reproduce these promises as canon.
- **Design system · Figma library focus effect.** The library's `shadow/focus-ring` effect still uses
  terracotta-100. The design-system owner must align it with the approved light focus ring:
  2px `surface/canvas` gap plus a 2px terracotta-500 ring
  ([design-system note 499:42374](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=499-42374)).
  Web's shared token and static-page chrome use that ring; dark, journal and gym overrides retain
  their own values.
- **Board · no Complete offer after the last subtask in the Graph.** The Board's step page and modal
  offer *All subtasks done · Complete step* once every subtask is checked (phone 07.06 231:1174,
  desktop 03.09 399:19282). Checking the last subtask in the Graph's step panel (`graph/StepPanel.jsx`)
  fills the gauge and nothing else; no drawing covers the Graph.
- **Board · a failed Copy link says nothing.** When the browser refuses the clipboard write from the step menu (01.09, 03.02) the
  build shows nothing. Proposed, awaiting the owner: toast *Couldn't copy the link* · **Show link**, then the link selected with
  **Retry** (phone 25.01–25.02, desktop 15.01–15.02).
- **Shell · signed-in avatar size.** The Shared Shell's Signed in variants (290:7065, 290:7079) draw a 28px avatar whose initial sits at the top. The shipped seat renders a 30px avatar centred in a 44px target, matching the Signed out variants (642:20246, 642:20267). Redraw the Signed in variants at 30px.
- **Board · Shell at 200% text.** The Shell defines no reflow: from 744px `web/src/shell/chrome/chrome.css` keeps room links in
  one row of 44px-high targets with no fill, bold-width reservation and `white-space: nowrap`. Below 744px room links are
  30px high with `white-space: nowrap`; Home, journal and gym use a filled active pill. The 18.05 specimen (380:18803) leaves
  the Shell out. Proposed, awaiting the owner: the links fold into one current-room menu by em width (phone 25.23–25.24).
  The Shell owner draws it in the Shell file and builds it.
- **Board · Roadmap complete for a reader.** The Board shows a reader the title alone, plus the crown and a secondary Fork offer on
  phones. Proposed, awaiting the owner: *All 8 steps done* / *Fork it to walk these steps yourself.*, with Fork primary on phones
  (25.03, 15.03).
- **Board · states at 744px.** At 744–1023px the build uses the desktop loading, load-error and empty frames, with three skeleton
  columns side by side rather than the tablet's rail. Proposed, awaiting the owner: 15.04–15.06; load error and empty have no columns,
  so no rail.
- **Board · New step on an empty phone roadmap.** An owner's empty roadmap reaches the Board on phone, tablet and desktop. Its New
  step opens the composer (185:2149, 226:1055); the tablet uses the desktop empty-state structure pending 15.06.
- **Board · composer and picker at 744px.** At 744–1023px the owner-approved picker is a page inside
  the 600px composer dialog: back chevron, Prerequisites, *for <draft>*, search, chips, results, Cancel
  and Apply. The implementation uses this page layout. The canon is ✅ 744 09.02–09.04: 470:23411,
  475:23809 and 470:23621, with darks 470:23881, 475:24021 and 470:24091.
- **Board · picker at 1024–1439px.** The picker opens as a page inside the composer because the anchored panel cannot fit beside the
  centred dialog. From 1440px it opens beside the form. Proposed, awaiting the owner: 15.10.
- **Board · empty-roadmap Prerequisites row.** With zero candidates the row stays focusable and shows *Prerequisites · None*, but is
  non-interactive (`aria-disabled`) and cannot open the picker. Proposed, awaiting the owner: hide the row (25.13, 15.13, recommended) or
  keep it as plain text with no chevron and no focus (25.14, 15.14).
- **Board · default kind across surfaces.** The composer defaults to Sky, as the blank composer
  frames show. The Graph plants new roots in the first legend kind (Terracotta if none exists),
  and children inherit their parent’s kind. Sky is the Board default; when no legend kind names
  that hue, the choice correctly uses its hue name.
- **Board · large-picker context at 744px.** On phones `pickerFor` adds *· N steps* above eight candidates. The composer page uses
  lowercase *for <draft>* and carries the total in its count line. Proposed, awaiting the owner: *for Passage plan · 5,000 steps* with
  the count line reduced to *4 matches* (15.11).
- **Board · picker without a draft name or with a removed prerequisite.** With no draft name the phone and composer-page headers show
  only *Prerequisites*, without a For line (drawn in 25.15, 15.12). A prerequisite deleted remotely is dropped silently from the draft
  and selection, and placement recomputes. Proposed, awaiting the owner: *Read the wind was deleted, so it left your selection.* in the
  picker (25.16, 15.15), and the placement preview naming the loss in the form (25.17, 15.16). 10.11 Selection revalidated is Edit copy.
- **Board · phone large-picker dark.** Phone 10.x dark uses the existing tokens with the light structure. Proposed, awaiting the owner:
  the 11 dark frames in section 539:16665, beside 10.05 dark (383:19007).
- **Board · shared Undo.** Backspace and Delete on an owner Board card start the nine-second held delete directly; the hold is its
  safety (wave-5 G10). A toast's Undo reverts its own act. Command-Z walks the session's global structural stack across both views, cancels
  a hold first, as the hold is the last act, and is refused under a covering layer and in a text field.
- **Board · multi-select entry for keyboard and screen readers.** Phone owners enter selection through a touch hold or *Select* in
  the step menu. A polite live region announces the count and the bulk bar is a named Selection region with a count heading.
  Proposed, awaiting the owner: *Select steps* in the roadmap sheet and a selection state with none chosen (25.18–25.22).
  The follow-up node is `rb-multi-select-keyboard`.
- **Board · desktop Activity without WebGL2.** At 1024px and above Activity lives in the Graph dock, so the row's Activity offer and
  A shortcut are absent when WebGL2 is unavailable. The tablet panel and phone sheet page remain available. No approved frame draws
  a Graph-less desktop Activity destination; the follow-up is to draw that destination and its entry.
- **Board · a reader's empty roadmap without WebGL2.** Every visit without WebGL2 opens on the Board. An empty reader roadmap keeps
  its identity and zero-step count without the owner's *Your first step* title, body or New step offer. No approved frame draws this
  reader state; the follow-up is an empty Board for a reader on every band.
- **Board · planted summary and welcome-back recap without WebGL2.** Both presentations belong to the scene: the planted roadmap's
  summary follows its arrival, and the welcome-back recap names progress since the previous visit. Without WebGL2 neither appears
  on the Board. No approved frame draws either Board presentation; the follow-up is to draw both on the applicable bands.
- **Board · the topbar before a roadmap loads.** Before the load answers, or after it fails, the build knows no name, so it shows none
  rather than *Untitled roadmap*, and it offers no Share. It shows the switch while loading, but not after a failed load: the Graph's
  load error veils the topbar, so the switch would lead where a pointer cannot come back from. Proposed, awaiting the owner: a still name
  skeleton with no chevron while loading (15.08), and *Your roadmaps* with its chevron after a failed load (15.09). The switch returns to
  the load error once the Graph's load error leaves the topbar reachable.
- **Board · Graph interims.** G2 hands a Graph search to the Board while keeping the query and field focus. G4 retains the phone Graph
  camera group under the row. Proposed, awaiting the owner: 25.11, 25.12.
- **Board · reader Graph title affordance.** G8-H1 makes the selected-step title open the reader's read-only step page, with Fork
  remaining primary. The approved [04.06 bar](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=377-14343) has no visual tap
  affordance on that title. Proposed, awaiting the owner: a 44px title row with a chevron (25.10).
- **Board · filter strip at 744.** The built strip ends at y=172; 08.13 draws it ending at y=160.
  The tablet Activity panel keeps the drawn 12px gap beneath the strip, so on the Board it stands at
  y=184 where [08.13](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=527-48638) draws
  y=172; on the Graph, with no strip, it stands at y=172. Reconcile the strip's padding with the frame.
- **Graph and Board · last root.** A roadmap keeps a root on every view and band. While a selection takes every root, the phone Board's bulk bar and the desktop and
  tablet selection bars drop Delete with nothing saying why, and the phone's Recolor sits at half width beside an empty half. Proposed, awaiting the owner: Delete keeps
  its place, dimmed and `aria-disabled`, with *A roadmap keeps one starting step* under the count, on all three bars
  ([25.25](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=591-19626)). The desktop dock drops *Delete step* for a sole root with nothing saying why, and no
  frame draws that dock.
- **Board · Activity shortcut in help.** From 744px A opens Activity on both Board and Graph where its destination is available. The Board shortcuts dialog does not list A.
  Proposed, awaiting the owner: an *Activity* row after *Board / Graph*, owner only (15.17), before adding it to `BOARD_SHORTCUT_GROUPS`.
  A does nothing on phones.
- **Board · dock beneath the row.** The step dock from 744px starts 8px
  below the measured identity row and clears any Graph refusal banner, so an open step never
  covers Share, Next, New step, More or refusal actions.
  Owner-approved ✅ 08.11 (1440) and 08.12 (1024), light and dark, draw the desktop Graph with a step
  in the dock beneath the row. On the Board a step opens in the step modal (03.01, 05.06), not the dock.
- **Board · Export and reader Share feedback.** G5 downloads this roadmap as one Markdown file in the paste format, with the browser
  download as feedback; Settings retains the all-roadmaps zip. G24 copies the reader's roadmap link and uses the existing *Link copied*
  toast; a refused clipboard shows nothing. Proposed, awaiting the owner: *Learn to sail exported* and *Couldn't export this roadmap* ·
  **Retry** (25.05–25.06, 15.18–15.19), and reader Share copied, failed and link shown (25.07–25.09, 15.20–15.22).
- **Board · device-only status.** The host carries the anonymous or lapsed line in the Shell
  from 744px and in the tappable Device note below the identity on both phone views. The phone
  Graph camera clears the measured note.
- **Board · single offline notice.** Approved 03.17 shows the room's Offline signal without the global
  notice. The global notice yields only to a published Offline. By orchestrator ruling under the
  owner's G-R6 approval, an anonymous owner offline keeps the global notice: a device line is not a
  connectivity statement. Readers, the demo and rooms without an Offline publication retain it.
- **Board · the drawings of what the lift retired.** The product has no List, phone editor sheet, phone aim, remove-link and bulk bars,
  ControlBar or Next up shelf. Their Web Mobile and Web boards (the [flow index](../index.md#roadmap--web)'s *02 · Find and edit in List*,
  *List vocabulary*, the phone owner sheets in *04 · Edit and complete steps* (Web Mobile 04.01–04.05, 04.08), and the Next up states in *05 · Progress and feedback*) still stand in Figma. The designer deletes them and their
  index rows in the 🚀 pass.
- **Board · loading strip.** 02.09 (374:5067) draws five sunken chip placeholders between the identity row and the columns. The build
  draws none, so its columns start higher.
- **Board · modal and the Shell.** The step modal frames (03.01 184:1693, 03.07 379:18290, 05.06 399:37361) draw the scrim over the Shared
  Shell and centre the modal on the whole viewport, 80px from the top. The build leaves the Shell clear and centres the modal beneath it,
  106px from the top.
- **Board · a reader's step modal.** 04.05 (376:13291) draws Overview and History sections, a Copy link icon and *View branch* for a
  reader. The build gives a reader the overview alone, the ⋯ menu and no *View branch*.
- **Graph · dock header.** 08.11 (523:32253) and Web 04.01 (33:105) draw a centred title and *Not started*. `graph/StepPanel.jsx` draws
  the title at the start and says *Up next*, the Board's word.
- **Graph · ticker over the selection bar.** Web 16's ticker and the selection bar share the bottom of the canvas with no drawn
  stacking. A rename on the dock followed by a selection inside the ticker's 4.5 seconds lays the ticker across the bar; presses pass
  through it to the bar. Draw where the ticker stands while a selection bar is up.
- **Shell · avatar visual.** From 744px the 30px avatar sits inside a 44px target. The signed-in visual uses the filled product
  `Avatar`; 16.01 and 16.02 draw a 28px `--surface-card` chip with an initial.
- **Shell · signed-out Appearance.** Home, journal and gym keep the ghost avatar's Appearance (Light, Dark, System), Sign in
  and Settings popover at every width. Shared or status rooms keep their Sign in text seat; a signed-out roadmap visitor
  reaches Appearance through Home's avatar. 16.01's Home signed-out row (626:38890 and dark 627:39049) and Shared Shell
  290:7085's Account=Signed out variant still draw *Sign in* for Home, journal and gym from 744px, against the owner's ruling
  to keep the avatar seat. A designer is updating those drawings.
- **Demo · coach card on a phone.** [P4](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=64-2) draws the
  card beside its step with an arrow. At phone width neither side fits, so the card seats under its step, or over it
  near the bottom and clear of the Fork pill and selected-step bar, with no arrow. Draw the phone seat.
- **Design System · Dialog close target.** The shared `Dialog` close control is 28×28 with a 14px
  glyph; the approved [04.03 Fork dialog](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=398-29874)
  and the other dialog frames draw ✅ Close at 44×44 with a 20px glyph. Align the shared control and
  title clearance in a Design System change, with screenshots of Fork, Shortcuts, Share, SignIn,
  Feedback and SyncDecisions. Keep this correction in `Dialog`, without a Fork-specific override.
- **Email me a link is over the CTA budget.** `web/src/shell/auth/SignInDialog.jsx` and
  `web/src/products/roadmap/share/ForkDoor.jsx` label the submit *Email me a link*, four words
  against the 1–3-word button budget in `guidelines/text-budget.md`.
- **1e · Available-node treatment.** The DOM specimen draws a card-coloured available node;
  `NodeBatch.js` paints available and complete with saturated fills, distinguishing complete with a
  halo. Choose one treatment and align shader and specimen.
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

- **iOS journal first run · R117.** AX3 keeps the longer privacy fact in a scrollable page.
- **iOS journal without mood and energy (owner, 2026-11-08).** The iOS room draws no scale rows, no
  invitation and no ratings on earlier pages; the stored values and sync keep them, and the web still draws
  all three. The Shell file's onboarding Journal glimpse still pictures the page with its scales unasked
  (`OnboardingGlimpses.swift`, `OnboardingSpecimen.unasked`); redraw it without them, or rule that the
  glimpse shows the product across surfaces.
- **iOS echo count while its sheet stands.** Journal · iOS 02.3P–02.6P draw the open count as
  `.borderedProminent`, a filled lamp capsule; the calm-and-private ruling admits no `.borderedProminent`
  and no filled accent button in the room, so the count is the same lamp-soft capsule in both states, in a
  44 pt target a stock mini capsule cannot hold, and its VoiceOver value says Open. Redraw the open count,
  or rule the exception.
- **iOS journal bar before Search and Talk.** 05.1A–05.6P draw Talk beside Write in the bottom bar and
  Search beside the account button; neither is built, so Write stands alone and the account button keeps
  its own capsule until they ship.

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
  `ios/ios-redesign.md` §2: the canvas, source pages and the echo sheet. Its lamp is
  `#90651C` (4.82:1 on `#F7F7F5`); the web's day lamp `#986B1E` (`palettes.css`) measures 4.39:1 on
  the same paper, under the 4.5:1 text floor. Move the web and the Figma Day collection to `#90651C`.
- **The one fact over the scales.** The first-run privacy line is *Only you. No prompts, no fields,
  nothing to fill in — write a line or a page.* (engine A.3); where the web draws it under the mood and
  energy scales, *no fields* reads against two fields. Copy owner: reword it (*nothing you have to fill
  in*) or keep it.
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
the target, numbered in the iOS page's journeys and indexed in [the flow index](../index.md). Paths below are
under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `platform/` or
`app/`. Build tasks: `androidgym_tasks/`.

- **11a · The page is the target.** Journeys 00–09 follow the iOS page, and no number names two
  different screens across the phone pages: a board drawn for both phones carries the iOS number,
  and an Android-only board takes a number free on both pages. The six revised Coach, Log, Weigh-in, Workout, Finish
  and Routine editor flows were human-approved on 2026-10-25: 92 frames and 46 captions are
  **✅ Ready for dev**. Their current links and task scope are in `androidgym_tasks/README.md`.
  Other Gym and Shell boards retain their individual delivery status. Sign-in, email code and You
  live in the Shell file's Android page (section `33:1568`). A visual state absent from an approved
  flow still needs its own design handoff; completing the drawings does not complete app delivery.
- **11b · Deletion follows the resource.** Use the shared Material end-to-start swipe row with
  the error-red ground and trash icon (`Android / Swipe row` `337:2217`). Routine, set and note
  deletes commit immediately where their tasks specify it; workout discard and conversation delete
  ask once. The approved Log/Weigh-in flow keeps a held weight deletion and Undo for the system's
  accessibility timeout, never less than nine seconds (05.17), so
  `WithheldDelete.kt` remains while that path uses it. Do not remove all holds as shared-row cleanup.
  Every Android record row uses the shared ground (`ui/RowSwipe.kt` `DeleteSwipeRow`). Immediate
  actions are application-owned; weights project exact durable receipts.

  | Place | Code today | Board | Build work |
  |---|---|---|---|
  | Routines list | `ui/RoutinesScreen.kt:166`, shared row, immediate | 02.10 `1253:29196` | deletion and FAB verified in Dark/Daylight |
  | Routine ⋮ Delete | `ui/RoutinesScreen.kt`, shared error-role menu, immediate | 02.12 `1253:29480` | verified in Dark/Daylight |
  | Editor movement | `ui/RoutineBuilder.kt:515`, shared row, draft-only removal | 02.8 `1252:30621` | swipe verified in Dark/Daylight; editor geometry remains 18 |
  | Target set row | `ui/MovementForm.kt:187`, shared row | 02.11 `1253:29263` | shared row |
  | This workout row | `ui/AssemblySheet.kt:145`, shared row, *Remove movement* | 03.4 `1253:29834` | shared row |
  | Workout detail set | `ui/SessionScreen.kt:500`, shared row, immediate | 05.4b `1793:27226` | swipe verified in Dark/Daylight; Session copy remains 23 |
  | The log row | `ui/LogScreen.kt:216`, shared row *Discard workout*, and the long-press menu's *Discard workout* (`:349`); both ask *Discard this workout?* (`ui/ConfirmDialog.kt:59`) | 05.2 `1252:27527` | swipe + *Discard this workout?* |
  | Receipt and workout detail Discard | the receipt overflow's *Discard* (`ui/FinishScreen.kt:287`) and the detail's *Discard workout* (`ui/SessionScreen.kt:383`) both ask *Discard this workout?* | 03.14 `1283:41920`, 05.14b `1793:27005` | confirm once |
  | Bodyweight | `ui/BodyweightScreen.kt:358` and the log's weigh-in row (`ui/LogScreen.kt:224`), shared row; *Delete weigh-in* uses a durable hold of at least nine seconds | 06.2 `1254:32141`, 06.9 `1254:32246` | shared swipe, held delete and Undo |
  | Notes | `ui/NotesScreen.kt`, shared row swipe and immediate error-role editor deletion | 09.1 `1254:39045`, 09.2 `1254:39104` | verified in Dark/Daylight; handle reorder stays separate |
  | Coach History | `coach/ThreadsScreen.kt`, asks *Delete this conversation?*, then deletes | 08.4 `1253:28552`, 08.60 `1254:31663` | *Delete this conversation?* |

  The refusal notice's swipe (`ui/RefusalBanner.kt:53-78`) dismisses a notice, not a record, and
  keeps its *Dismiss*.
- **11c · Destructive actions use the M3 error role (owner ruling, 2026-10-22).** Library Theme
  `android/system/error` (#E46962 dark · #B3261E light) and `on-error` (#410E0B · #FFFFFF). The app
  maps M3 `error` and `onError` to those roles in `ui/GymMaterial.kt`, and the workout's *Discard
  workout*, *Delete set*, the swipe deletes, the routine menu's *Delete* and the sign-in decision's
  *Discard* use them. Three destructive controls are still off the error role: the log row menu's
  *Discard workout* (`ui/LogScreen.kt:349`) and the receipt overflow's *Discard*
  (`ui/FinishScreen.kt:287`) draw in ink, and History's *Delete* confirm draws in `alarmInk`
  (`coach/ThreadsScreen.kt`). Boards 00.2 `1254:43776` and 00.4 `1254:38403`. *Sign out* stays ink.
- **11d · Number entry is a stepper (owner ruling, 2026-10-22).** Load and reps are M3 icon buttons
  − / + (48 dp) around a numeric text field; tapping the value opens the decimal keyboard, − / +
  nudge by the movement's step, and the plate ladder stays for bigger jumps. Pressing shows the M3
  state layer; an accepted change ticks the value and flashes the field. Android builds this: the rack and
  Fix set use `NumberStepper` (`ui/NumberStepper.kt`), whose icon buttons show the state layer and whose
  accepted change gives its feedback and flashes the field. Boards 03.1 `1252:28036`, 03.2 `1252:28178`,
  03.3 `1253:29581`, 03.10–03.13 (`1252:28389`, `1252:28534`, `1252:28687`, `1252:28829`), 02.6
  `1252:30392`, 02.11. The owner's 2026-10-25 clarification approves the native keyboard's minus
  key for assisted loads; verify signed decimal entry on the target emulator and add no app-level
  sign control. The Workout's ledger is a list of 56 dp Material list rows that wrap at large text. At rest it shows the
  rows around the set in hand that fit between the movement's head and the rack, each whole, one at least, with the
  room under the last row left as canvas (03.1N, 03.2N; L.5–L.7 `2074:52825`), and inline load units and visual position
  markers instead of visible counts or arrows.
  Add movement lives in This workout. Weigh-in uses a native decimal keyboard and date picker;
  task 24 still needs its approved compact sheet, calendar and IME-state implementation.
- **11e · Equipment, units and Edit movement.** Routine summary, editor, finish receipt and
  workout detail use equipment-aware units with a preceding space: *kg each* for paired dumbbells,
  *kg total* for barbell, *kg added* for bodyweight, and *kg* for one dumbbell, machine, cable,
  kettlebell, Other or unknown equipment, as on iOS and the web (approved section
  [`1814:13077`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1814-13077)). Coach presentation retains its own formatter.
  Standalone Edit movement uses plain **Barbell / Dumbbells / Other**, implicit 1/2/1, without a
  count selector or Name/Equipment hints. Its approved section is `1548:7642`; unchanged and
  name-only edits preserve legacy raw equipment/count and all historical loads. Record opens it
  through More → Edit movement and uses the existing equipment glyphs; Cable/Kettlebell retain
  their labels, and Other has no glyph. The combined/create editors' reconciled drawings share
  this control; tasks 18/19 own their implementation.
  Record draws one strongest point per local day and defaults its readout to that plotted point.
  The static 05.6/05.7 specimens still include a same-day vertical segment; the task's explicit
  daily-best rule governs live data. A Log link to a collapsed workout leaves the chart unselected
  while keeping the factual workout identity. Boards 05.6 `1252:30001`, 05.7 `1252:30215`.
- **Cable loads drawn as kg total (design drift, designer).** Against 11e, Android boards draw cable
  movements in *kg total*: Triceps Pushdown *25 kg total* on 02.2 `1252:28969` and its siblings 02.5, 02.6,
  02.8, 02.13, 02.16, 02.17, 02.21–02.25, 00.6 `1745:25871` and 03.4 `1253:29834`; Lat Pulldown *45 kg total*
  on 01.13 `1254:36454`. 02.2 also draws the custom *Landmine Press · yours* at *20 kg total* in a layer named
  *movement · Cable Fly*, with no equipment stated. The build reads a cable's load as plain *kg*. For the
  designer: redraw the cable loads in *kg*, and name the Landmine Press's equipment.
- **11f · New routine is a FAB (owner ruling, 2026-10-22).** Routines uses the shared M3 FAB (+),
  bottom-end 16 dp above navigation, with its accessible *New routine* label at every text scale.
  The root bar holds only title/account; the paired 03/17 native check verifies full/empty Dark and
  Daylight, a 56 dp FAB and a 48 dp account target at standard and 320 dp/200% text.
  Boards 02.1 `1252:27415`, 02.7 `1252:30574`. *Weigh in*: 9q. The current Coach proposal card and
  Review destination remain while action appearance changes are deferred at the user's request; its words are set in
  Nunito, as 02.1 sets the row it stands for.
- **11h · Coach-led setup on Android.** Journey 01 draws the iOS setup in Material form. The build draws the greeting
  with its anchors (01.1 `1252:4776`, 01.2 `1253:28196`), photos (01.4, 01.5), the signed-out answer (01.19), and the
  routines a turn creates, landed at once with their card (01.8 `1902:34546`, 01.16 `1902:34644`). An unavailable or
  bound installation takes the stances of 08.58 `1253:28737` and 08.58b `1489:49152`. What differs: a retained
  onboarding answer's drafts, the only drafts a phone still holds, keep their Save (`coach/CoachAnswer.kt`), where 01.7,
  01.14 and 01.15 draw Apply and Reject; allowance used is 11j.
- **11j · The allowance-used copy.** Boards 01.10–01.12 say *You have used all of your AI
  allowance.*, a sentence no server sends (the nearest is *Your AI allowance is fully used or
  reserved.*, 10v); Android says it for `subject_exhausted` when the server's allowance read shows the
  balance gone, and *Coach’s AI allowance is unavailable right now.*, which no board draws, on a balance
  that refused a round without being gone (`coach/turn/CoachTurnRefusal.kt`). It says when Coach
  comes back only of a paused pool (`free_month_exhausted`, `free_day_exhausted`), not of the seat's own
  allowance (01.11). Windmill One (01.12) ships only with checkout open.
- **11k · Proposals decided on a sheet.** The owner keeps Android's action cards, review route and outcome wording.
  Android decides a proposal in a review sheet
  (`ui/ReviewSheet.kt`: apply after scrolling to the end, *Turn this down* behind a confirm; 08.55b `1901:33869` draws it
  for a change to the open workout), its card says *Review*, the promise line stands once under the cards
  (`coach/CoachProposalCards.kt`, `Ask.promise`), and receipts say *Turned down* (`presentation/Proposal.kt`). The boards
  decide on the card with a per-field diff and Apply / Reject: 08.2 `1252:27854`, 08.3 `1253:28311`, 08.12–08.14,
  the catalogue 08.15–08.31 (`1254:37242` … `1254:38214`). A change to the open workout decides during the workout
  (`WorkoutReviewBinding`), and so does a routine's proposal, as on iOS: its card says *next time*, as 08.56 `1901:34078`
  draws, and its sheet is the ordinary routine review (`ReviewBinding`).
  10v covers the words on every surface.
- **11l · Outside the app.** The native ongoing notification and promoted Live Update show a
  chronometer from the last visible workout set, or workout start before the first set. The silent
  DEFAULT channel preserves a user's existing block. The public lock-screen card contains only
  the routine and clock, following the owner privacy ruling; set facts and actions appear after
  unlock. API 37 controls the stock card's launcher icon and system tint despite the requested
  exercise small icon and GymSkin accent; the promoted chip uses the exercise icon and clock.
  Reconcile the illustrative 04.2 card with this verified platform rendering without adding a
  custom notification layout. Boards: 04.2 `1254:46754`, 04.3 `1254:46826`, 04.4 `1254:46875`.
  Quick Settings tile 04.1 `1254:46694` remains task 16; with no workout open it opens Routines and
  never starts one (12b).
- **11m · Native sign-in field states.** Shell Android 15b [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4237)
  and [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-792) draw an empty Code
  field with a floating label, placeholder and unfocused outline. Task 27 specifies stock Compose
  `OutlinedTextField(label = …)`: an empty, unfocused field keeps its label inside; focus floats the
  label, reveals the placeholder and accents the outline. Reconcile the drawing's empty/unfocused
  state with the native component. Native acceptance must compare unfocused and focused states
  separately; this does not authorize a custom floating-label field.
- **11n · Android specimens.** The boards set text in Nunito and JetBrains Mono. The app bundles both
  for its chrome, native controls, number stepper, status line and Coach, and sets its reading text and
  readouts in the system sans and mono (`ui/GymType.kt`, `platform/design/Tokens.kt`); system parts
  come from the team Material 3 Design Kit, themed with the Windmill Theme roles. Native
  implementation uses Compose Material 3.
- **11o · A proposal with no conversation.** The waiting-proposal row on Routines (02.1) opens the
  proposal's Coach conversation at its card. A proposal written by a connected agent over MCP
  (`ProposalDoor::mcp`) has no conversation, and no board draws where it is decided. Rule where it
  opens on both phones.

- **11p · Additional states need their own handoff.** The six-flow approval does not cover the new
  states required by the corrected Android tasks. Track these gates in the dogfood tree;
  domain and transport work can proceed independently, but the affected visual state needs an
  approved Figma frame before implementation.

  | Gate | Task | Required handoff |
  |---|---|---|
  | `android-gym-signed-load-input-design` · resolved | 07, 10, 18 | Native keyboard minus entry is human-approved 2026-10-25; retain approved sizing and verify negative decimal entry. No app-level sign control. |
  | `android-gym-equipment-variants-design` | 08, 19, 20, 21 | Cable/kettlebell menu and icon states; preserve stored equipment and current presentation. |
  | `android-gym-empty-finish-design` · approved | 14 | [Zero-set Finish](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49458) is ✅ Ready for dev, human-approved 2026-10-25. |
  | `android-gym-no-routine-picker-design` | 13 | Changes to the existing picker for an externally started workout without a routine. |
  | `android-gym-mcp-proposal-row-design` | 17, 29 | A proposal with no conversation; retain its existing review route until the replacement is approved. |
  | `android-coach-uncertain-apply-design` · deferred, unapproved | 34 | Excluded from this release with Coach action-presentation changes; the proposed awaiting-receipt states are not approved. |
  | `android-coach-bound-installation-design` · access approved | 36, 38 | 08.58b Dark `1489:49152` / Daylight `1489:49306` are human-approved 2026-10-28 and 🚀 In production on the Android design page. History and Sign in remain available; anonymous Send is absent. |
  | `android-account-delete-recovery-design` · approved | 48 | [D1–D5 recovery](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=116-754) is 🚀 In production, human-approved 2026-10-25; Android task 48 ships it in 0.14.0. |
  | `account-delete-reconciliation` · resolved | 48 | Backend account-scoped closure receipts and session-independent recovery are deployed in `ac1e0c75`; Android integration and acceptance remain task 48. |

- **11q · Routine editor field and picker geometry (owner: task 18).** Installed Android
  `ui/RoutineBuilder.kt` still paints the Name field with a filled rounded container; approved
  [02.3 Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44602)
  uses the native outlined-field anatomy. Its movement picker nearly fills the native viewport,
  while approved [02.4 Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44782)
  leaves the editor toolbar visible. Task 02 aligns the field accent and picker surface only;
  task 18 owns the remaining editor/picker geometry, and task 03 owns the toolbar.
- **11r · Android board numbers (renumbered 2026-10-31).** No number names two different screens
  across the phone pages. These Android boards moved to numbers free on both pages:

  | Old | New | Board |
  |---|---|---|
  | 02.14 · 02.15 · 02.18 · 02.19 | 02.22 · 02.23 · 02.24 · 02.25 | Add movement and targets · Movement editor keyboard · Load keyboard · Load unit below |
  | 03.16–03.23 | 03.37–03.44 | Finish options · Add movement · Create movement · Added Dumbbell Shrug · Added Hammer Curl · Long name · Single movement · Swipe movement |
  | 06.3 · 06.4 · 06.5 | 06.9 · 06.10 · 06.11 | Correct a weigh-in · Native date picker · Date selected |
  | 07.4 · 07.5 | 07.11 · 07.12 | Sign-in decision · Discard 3 workouts? |
  | 08.6 · 08.6b · 08.33–08.36 | 08.58 · 08.58b · 08.59–08.62 | No seat · Signed out, earlier chats retained · Scroll · Delete a conversation · Another reply pending · Draft restored |

  These Android-only boards take numbers free on both pages: 07.15 · 07.16 · 08.55b · 08.68 · 08.69 · 08.70, *Sign-in
  decision, conversations only* · *Discard 2 conversations?* · *Review sheet, this workout* · *Send refused, the shared
  free day* · *Ended, the Stop could not reach the server* · *A picture held on another phone*. The redraw of 08.58
  `1898:33452` draws *account changing* under the number the no-seat original `1253:28737` still holds; the build draws
  both, so the original takes a number of its own (designer).

  The task files, capture recipes and engineering docs use the new numbers; `routine-targets.json`
  captures the movement editor's discard dialog as 02.17. Flows drawn on both phones under
  different numbers remain (Android 02.9 and iOS 02.14 *Create movement*; Android 03.38 and iOS
  03.16 *Add movement*).
- **11s · Android review boards, ✅ Ready for dev (owner approved 2026-10-31).** Drawn from the
  native emulator review; implementation pending.

  | Gap | Build today | Board (Dark · Daylight) |
  |---|---|---|
  | In-app predictive back and navigation motion | Built (task 53): `GymStage` previews pushed screens, the logger and the editor; `WindmillSheet` previews every sheet from its own window, so a busy sheet still swallows Back; shared axis X and fade-through, cuts with Remove animations | 00.5 `1743:26713` · `1743:27031`; 00.6 `1745:25871` · `1745:26174` |
  | Nav labels at 320dp/200% | Built (task 54): labels stay whole, spill into a neighbour's spare width and wrap only at a space (*The / log*) | 00.7 `1745:27419` · `1745:27475` |
  | Dirty routine draft on Back (4k) | Built (task 56): Back, the gesture and the back arrow ask on an unsaved draft; a clean one leaves at once | 02.20 `1742:39519` · `1742:39682` |
  | Movement editor discard wording | Built (task 56): *Keep editing* | 02.17 `1443:19730` · `1443:20852` (*Keep editing*) |
  | Load below zero for Barbell/Dumbbells | Accepted in targets and Fix set; the field shows a hyphen, summaries a minus | 02.21 `1742:39774` · `1742:40098`; 03.33 `1742:40425` · `1742:40717` |
  | Rack height and planned rows | Built (tasks 59 and 58): *22.5 kg total* fits inline and holds the rack's height; planned rows read the load the plan expects, *100 kg total × max*, or *— × max* while last time is unread, never a set logged today (owner ruling 2026-11-06, below) | 03.34 `1742:40960` · `1742:41112` |
  | Rack at 320dp/200% | Built (task 59): the movement head, the ledger and the rack scroll as one page above the pinned *Log set* band, and rows wrap instead of clipping. At rest the ledger shows the set in hand whole with no cut row; where a logged row wraps taller than the set in hand, the window stands that tall with canvas under the set in hand, so each logged row scrolls into it whole | 03.35 `1742:41245` · `1742:41402` |
  | Receipt at 320dp/200% | Built (task 60): the receipt opens full height, the facts wrap two to a row and the body scrolls to *Performed* under the pinned actions. A value no size fits on one line stays at the 16 sp floor and drops only its unit to the next line. *Share with Coach* and *Done* are Material filled tonal and filled buttons with one-line labels, which at 200 % run into the 24 dp side padding as the board draws them. The crown is the 24 dp drawable 8 dp before the label, where the board sets an emoji glyph at the label size | 03.36 `1742:41620` · `1742:41702` |
  | Weigh-in Undo | Built (task 61): the snackbar rises above a *Weigh in* that never moves, and the hold lasts the system's accessibility timeout, never less than nine seconds. Material's snackbar is 48 dp tall and Scaffold leaves 12 dp above *Weigh in*; the board draws 56 dp and 8 dp, and *Weigh in* measures 139 dp wide with Material's padding against the board's 132 dp | 05.17 `1742:41789` · `1742:41887` |

  Shared rules these change beyond Android: iOS and web accept a load below zero for Barbell and
  Dumbbells, and iOS planned rows read the load the plan expects, as Android's do. 03.34 adds a fit-first
  step to the O rule for the rack. 02.20 draws the routine Name field in the outlined
  floating-label idiom the movement sheet uses, and Android builds it (task 56); 02.3, 02.5 and the
  other editor boards still draw a label above the field (designer to redraw). 02.20 draws only a
  named draft: Android says *This routine won't be saved.* while the name is blank (designer to
  confirm). Editing a saved routine, Android says *<Name> won't be saved.* although only the edits are
  lost and the routine stays (designer to word that case). Under its dialog 02.20 also draws Save
  muted on a new draft that is named and holds a movement, where 00.1's rule enables it, and an
  editor body at 16 dp margins; Android's body keeps its 20 dp margins (designer to reconcile).

- **11t · You after a confirmed closure (designer).** D5's caption names the row *Finish deletion*
  once closure is confirmed, and Android builds that label (task 48). The subtitle under *You* is
  drawn only for an unknown result (*Deletion unconfirmed*); Android still shows it while the
  confirmed closure waits for local cleanup, where it is no longer true. Designer to draw the
  subtitle for D4's state.
- **11u · Before the first pull.** The log builds 05.18 (task 72): when the first pull fails or none
  can run (offline), its foot becomes **Retry** · *That read failed.*, which the caption names for a
  failed pull and no Android board draws.
  A movement's record page before the first pull lists the days this phone holds under *Recent sets*
  (`ui/RecordScreen.kt`) with nothing to say more may come. Board 05.20 (`1826:56648` · `1826:56764`,
  design brief QW3, task 104) keeps the heading and adds 05.18's *Reading your log…* foot under the
  days.
  - *Routines before the first pull (owner ruling, 2026-11-01).* Routines reads *No routines yet.*
    (`ui/RoutinesScreen.kt`) while the account it has not pulled holds routines; the owner keeps
    that line for now.
  - *Set numbers on a workout (owner ruling, 2026-11-01).* Each set row on a workout page leads
    with a quiet count: a bare digit with no *Set* word, the set's position within its movement
    counted 1..N in logged order, never the server's set number, so it never reads *2, 3, 1*;
    after a delete the rows that remain renumber. Fix set's subtitle carries the bare count, N by the
    same count (*Bench Press · 1*, 11z). Built on Android (`ui/SessionScreen.kt` `Performed.Row.position`, passed to
    `ui/FixSheet.kt`). Board 05.3b *Quiet set count* (Dark `1782:26943`, Daylight `1782:27019`,
    caption `1782:27095`, in section 05, 🚀 In production) draws the count in JetBrains Mono 12/16 in
    text/tertiary, in a 24 dp column on the load's baseline, inside each movement's one group of
    sets. Revisions 05.14b (`1793:27005`, `1793:27113`, caption `1793:27221`), 05.4b (`1793:27226`,
    `1793:27317`, caption `1793:27408`; the swipe, rows renumber), 05.5b (`1793:27413`,
    `1793:27501`, caption `1793:27589`) and 05.13b (`1793:27594`, `1793:27683`, caption
    `1793:27772`) carry the same rows. At 200 % text a two-digit count widens its row's column past
    24 dp and the count touches its load, since no gap follows the column; no board settles it.
    The options are on the Proposals page, section Q4 `1832:14186` (design brief QW4).
  - *A movement with no plan (designer, design brief QW1, task 102).* On a free workout (no plan) each movement heading keeps
    its 48 dp touch target (`GymTap.minimum`) with no line under the name
    (`Performed.Against.Silent` in `ui/SessionScreen.kt`), so a blank gap sits where 05.3b draws
    *Plan 3 × 8 · 75 kg total*. Board 05.19 (`1826:42663` · `1826:42749`) centres the name in the
    48 dp target with no second line.
  - *Movement headings are not headings (Android build, task 86).* TalkBack does not expose
    a workout page's movement headings as accessibility headings, so heading navigation skips
    them; the heading in `ui/SessionScreen.kt` sets no `semantics { heading() }`.
- **11v · Native wave B, measured against its boards (designer).** Captured on the local stack
  (Pixel 8 profile, API 37); none of these has a board to settle it:
  - *Scrolled top bar.* Android tints the 64 dp top bar to the surface colour on scroll and leaves
    the status-bar strip above it on the canvas, so a scrolled screen shows a two-tone seam. 00.1
    draws no scrolled state.
  - *Receipt actions.* *Share with Coach* and *Done* are M3 buttons 56 dp tall; 03.36 draws them
    72 dp tall at 200 % and 03.15 at 56 dp.
  - *Navigation pill.* M3 draws the active-tab indicator 64 × 28 dp at 320 dp / 200 %; 00.7 draws
    56 × 32 dp.
  - *Rack.* At 22.5 kg the load chips step ±5 (the load band) where 03.34 draws ±10.
  - *Dialogs.* The discard questions measure about 319 dp wide against 312 dp on 02.20 and 02.17,
    so *Changes to this movement won't be kept.* fits one line where 02.17 wraps it; the Daylight
    scrim reads #5e5c5b against the board's #6a6866.
  - *Proposal diff.* The review sheet writes a load change as *30kg → 32.5kg*, with no space before
    the unit (`ui/ReviewSheet.kt:384` over `presentation/Proposal.kt`); every other Android readout spaces it.
  - *Web planned rows.* Android and iOS planned rows read the load the plan expects
    (*100 kg total × max*); the web live mirror, which has no rack, still reads *last × max*
    (`web/src/products/gym/log.js`).
- **11w · An answer's proposal still arriving (designer, design brief QW2, task 103).** On the phone that ran a turn its
  proposal commits with its call, so the card stands with the answer. A conversation synced from another phone can land an
  answer before its proposal. Android then says *Reading proposal…* until a read misses, and until the miss settles draws
  nothing in a routine card's place and *Reading proposal…* in a workout change's (`coach/AskScreen.kt`,
  `coach/CoachProposalCards.kt`). No board draws those words. Board 08.63 (`1828:53638` · `1828:53718`, 🚧) draws the waiting
  state: a compact card in the card's place reading *Proposal arriving…* under a linear indicator. A miss settles 10 s after it,
  once the phone reads further into the account or a pull asked after its wait lands caught up; the
  wait's end asks for that pull, so an idle account settles too, and the place then reads *This
  proposal is no longer available.* `gym_proposal_missing` counts only answers this visit waited
  for: a proposal deleted before the visit, as on a reopened thread, draws the line and sends
  nothing.
- **11x · Type and colour roles against 00.2 (designer).** Android screens read colour from the
  Material scheme and four roles of the room's own (`MaterialTheme.gymColors`: faint ink, record ink,
  record wash, refusal ink; `ui/GymMaterial.kt`), and type from `MaterialTheme.typography`,
  `WindmillType` (`platform/design/Tokens.kt`) and `GymType` (`ui/GymType.kt`). Each role holds the
  value its screen drew, so the drift from 00.2's ramp now sits in those two files:
  - *Ramp.* 00.2 draws root title 24 Bold, sheet title 28 ExtraBold, section 17 Bold, row 16 Bold /
    13, target mono 13, label 13 Bold, button 16 Bold, note line mono 12 and weight numeral 104
    ExtraBold. Android draws the root title in Nunito 22 Bold on 28, and so the sheets headed by a ✕ Close
    (*Fix set*, *Edit movement*, *Weigh in*, the movement form, *Add movement*); other sheet titles at
    28 Bold on 36 (*This workout*), 26 ExtraBold on 32 (You, *Delete your account?*), 26 Bold on 36 (a proposal)
    and Nunito 28 ExtraBold on 36 (*What Coach read*); section titles at
    18 Bold on 24, 18 Bold on 25, 17 Bold on 23 and 17 Bold on 24; the rack's load in Nunito 88
    ExtraBold on 92. Row, target, label, button and note line match.
  - *Line heights.* One size stands on several leadings: 16 on none, 21, 22, 23 and 24; 14 on none,
    18, 20 and 21; 13 on none, 18 and 20; 12 on none, 16 and 17.
  - *Figures.* The Material slots carry tabular figures and no line height; the screens' sans styles
    carry neither. No screen reads a slot in their place, because the swap would change digit widths
    on a system face whose default figures are proportional, and every line height.
  - *Discard questions.* *Discard this workout?* is Bold, the routine editor's two questions Regular,
    both 24 on 32 in the system default face (`ui/ConfirmDialog.kt`, `ui/RoutineBuilder.kt`).
  - *Outlined fields.* The planning forms' fields set the stock field type in the system sans, the
    note editor's in the system default face (`ui/GymScreen.kt`, `ui/NotesScreen.kt`).
  - *Dynamic colour (decided).* Android paints the fixed brand palette in both modes; Material You
    dynamic colour stays off.
- **11y · Sets held back by an update the server requires (designer, task 75).** While the server
  needs a newer app, Android's workout draws no band (`store/EngineTraining.kt` `deliveryBlocker`
  names no blocker); only the app-wide *Update required* dialog says why
  (`app/MainActivity.kt` `EngineAccountDecision`). `store/WriteOutcomes.kt` `SaveState.line` words
  each state, but no screen draws it. iOS says it at Finish: *Finish needs the update — keep
  logging, or hide the workout.* (PARITY row 51). A 4xx refusal other than 401 and 426 likewise
  names no blocker. Under the owner's 2026-11-03 ruling (11z, D1) the update state belongs to the
  You row and the screen it opens, never to the workout.
- **11z · Review wave D1–D7 (owner rulings 2026-11-03).** The 2026-11-02 external review of the
  Android app raised seven visible items. Boards, links and rulings are in
  `androidgym_tasks/design-brief-review-wave.md`; the iOS mirror's tasks are in
  `iosgym_tasks/review-wave.md`.
  - *Row labels lose "set" (owner ruling).* A row is labelled by its number alone: *Set 1* reads
    *1*, at every width. Counts (*5 sets*), the routine editor's *Sets* field, *Vary by set* and
    the notification's *set 3 of 3* keep the word. The Fix set subtitle reads *Bench Press · 1*
    (Android 03.3, 03.33); iOS titles its reps and Fix set sheets with the movement and the row's
    place, *3 of 3* (iOS 03.24b, 03.25b, 🚧). Number-only boards: the logger rows on 00.6, 03.1, 03.3,
    03.4, 03.10–03.13, 03.33–03.35, 03.38–03.44, 03.46 and 03.52; Coach's diff rows on Android 08.22,
    08.23, 08.27, 08.54, 08.55 and 08.65; iOS 02.15, 03.32, 08.22, 08.23 and 08.27. Android's ledger
    rows (`ui/LoggerScreen.kt` `Ledger`) and Fix set's subtitle (`ui/FixSheet.kt`) both read the number
    alone; iOS titles its sheets *Set N*
    (`Gym/Workout/WorkoutScreen.swift:99`, `Gym/Components/SetEditor.swift:246`) and labels per-set
    rows *Set N* (`Gym/Routines/RoutineMovementEditor.swift:184`). Spoken labels keep *Set N*. The
    onboarding glimpse's current row reads *3* too: Shell Android's glimpse frames (`66:5725`,
    `66:5754`) and the Design System library's iOS `Onboarding / Glimpse / Gym` (`210:56`, *3 · target
    100 × 5*; it reaches Shell iOS once the library is published and accepted). Its *set 3 of 5* and
    its *Set 3 logged* confirmation keep the word. Android's glimpse still draws *Set 3*
    (`ui/onboarding/OnboardingGlimpses.kt:349`).
  - *D1 · Delivery and connection problems (owner ruling).* A workout says nothing about sync: a
    set it saved is expected to sync. Sync state lives in one static place, reached from You:
    Android Shell 16f–16n and the seat dot 00.11 (✅). The row and 16g count the things 16g lists;
    waiting reads *They sync when you’re online.* only while the phone is offline, otherwise *They
    sync as soon as the log answers.*; items read title, then *Kind · when*. Android differs: the
    logger draws the stranded band (`ui/LoggerScreen.kt` `StrandedBand`), a cloud-off glyph on each
    unsent ledger row and refusal rows beside the ledger (`ui/RefusalBanner.kt`); Update required
    is a modal (11y); the log's foot reads **Retry** · *That read failed.* (11u). iOS differs: the
    ledger draws an `iphone` glyph for an unsent set (`Gym/Workout/WorkoutScreen.swift:377`) and the
    log row one (`Gym/Log/LogTab.swift:248`); the Update required alert opens over a workout
    (`WindmillApp.swift` `UpdateRequiredAlert`); You's status reads *Not backed up yet* or *Syncing
    paused · …* (`AppModel.identityStatus`). The iOS form (Shell iOS section 4d, 16f–16n; Gym iOS
    00.11) is 🚧.
  - *D2 · Lock-screen notification (owner ruling).* A routine name is not sensitive: the public
    version may show it, as `notification/WorkoutNotifications.kt` and 04.4 do. The Quick Settings
    tile is unchanged. No iOS board redacts it.
  - *D3 · Links in Coach answers.* The link draws in the primary role and an answer with several
    links offers Copy answer only (owner rulings), as task 116 builds. One difference remains: the
    menu opens below the bubble over the composer, where 08.67 flips it above. iOS renders no link
    (`Gym/Coach/CoachMessages.swift`); 08.66–08.67 iOS are 🚧.
  - *D4 · Faint ink.* Android Dark `inkFaint` is `#898E88` (`ui/GymSkin.kt`, task 115), and the
    Design System library's `dark/text/tertiary` Gym value is `#898E88`, published; the Gym file has
    not accepted that update, so its boards still resolve `text/tertiary` Dark to `#727771`. The
    library's `dark/ios/gym/ink-faint` is `#898E88` too, not yet published. iOS `gym/ink-faint` Dark
    is still `#727771` (`Theme.xcassets/gym/ink-faint.colorset`, `ios/ios-redesign.md`) though iOS
    draws text in it (planned rows, Edit sets numbers). Web gym-night `--neutral-500` is still
    `#727771`.
  - *D5 · Window sizes (owner rulings).* Every screen no board draws uses the bounded column; the
    rail grows with 200 % text; 03.52 follows its caption and the rack stays as today. Every modal
    sheet is bounded to 560 dp and centred (`platform/design/WindmillSheet.kt`, 02.27). The rail,
    bounded column (00.9, 00.10) and logger layouts (03.52, 03.53) are not built. The iOS app
    targets iPhone only (`project.yml` `TARGETED_DEVICE_FAMILY: "1"`), so these have no iOS twin.
  - *D6 · Share sheet.* Android draws 05.23–05.24 (task 117). The copied state is a check icon with
    no word and the spoken *Link copied* (05.25, owner ruling); the build writes *Copied*, which
    breaks mid-word at 320 dp and 200 %. The system chooser heads itself *Sharing link*. Around the
    row the sheet keeps 05.13b's build values: Revoke 15 SemiBold at 48 dp against Bold 16 at 56 dp,
    body 16/21 against 15/22, block gaps 12 against 14, link padding 12 against 16 × 10, bottom
    inset 20 against 40, Daylight link ink primary `#137A6C` against `text/link` `#106B5F`. iOS
    offers Copy link only (`Gym/Log/SessionShareSheet.swift`); 05.23–05.25 iOS are 🚧.
  - *D7 · Target row at 200 % text.* `ui/MovementForm.kt` `RoutineTargets` still collapses the
    Target label at 320 dp and 200 %; 02.26's caption states the stacking rule and spacing. iOS
    draws targets as form rows and has no summary row.
- **11aa · Nativeness wave against its N boards (designer).** Captured with
  `capture-recipes/nativeness-wave.json` (Pixel 8 profile, API 37, Dark and Daylight). The commits of Fix set, the
  movement form, Edit movement, the weigh-in, the routine editor and the Note editor stay a 56 dp pill at the foot by the
  owner's ruling, as the redrawn boards show. What still differs:
  - *Margins.* Fix set, Edit movement, the rack and the routine editor keep the 20 dp gutter; 02.5N draws the editor
    at 16 dp. The picker and the routine summary align to the list rows' 16 dp inset, as 02.4N and 02.2N draw.
  - *Routines.* The list keeps 4 dp between its rows; 02.1N draws them touching.
  - *Picker height.* The picker sheet rises nearly to the status bar (11q); 02.4N leaves the editor's bar showing.
  - *Set note.* The stock field shows *Add a note* only once focused; 03.3N draws it on the empty field at rest.
  - *Rack while typing.* On a phone whose status bar is taller than the board's 24 dp, the head, one ledger row and the
    rack overflow the room above the keyboard, so the page scrolls and Reps sits under the fold; 03.2N fits all three.

### Parity rulings (owner, 2026-10-22)

The owner ruled the iOS ↔ Android parity report; both Gym pages and the Shell account boards draw the
rulings. Entries 9k, 9o, 9p, 9q, 9r, 9s, 9y, 9z, 7c and 7d carry the rulings that close an earlier
question; the rest are below. iOS paths are under `apps/ios/App/Sources/Gym/`, Android paths as above.

- **12a · Lifting above the plan is just logged.** Neither phone asks to change a routine when the
  lifter beats it; targets change through explicit routine-editor Save or accepted Coach proposals
  (catalogue 08.21). Boards 03.6 are deleted on both pages. No Coach entry point fits
  *should I go heavier?* beyond asking; none is drawn.
- **12b · Every app workout starts from a routine.** Neither phone offers a free-workout start.
  Boards 03.9 are deleted on both pages. Android Routines opens saved routines and the routine
  editor; its receipt has no *Save a routine*. A connected agent's `start_session` may still omit
  `routineId`. Android preserves **What are you lifting?** for that workout; iOS draws
  *Choose your first movement* (`Workout/WorkoutScreen.swift`, `WorkoutScreen.live`). Any replacement
  external-workout entry needs an approved design. The idle Quick Settings tile entry is task 16.
- **12c · Hide workout on Android.** The logger's *Hide* (and system Back) leaves a running workout,
  which waits in `Android / Workout bar` (*Push A · 12:34*) above the navigation bar on every tab root
  (Android 03.4 `1253:29834`, 03.5 `1283:41318`). Swiping the notification away only turns it off:
  This workout shows *Notification off* · *Show*. Android builds this: *Hide workout* in the
  logger's top bar (`ui/LoggerScreen.kt:477-479`), the bar (`ui/WorkoutBar.kt`), and the swipe's
  delete intent (`notification/WorkoutNotifications.kt:258`) feeding This workout's *Notification
  off* · *Show* row (`ui/AssemblySheet.kt:224-231`).
- **12d · The approved Finish receipt.** Android Finish (03.7 `1254:32362`, 03.8 `1254:32441`)
  has a readable receipt and two main actions: crowned *Share with Coach* and *Done*, each 56 dp
  with 12 dp between. *Discard* is in the native top-end overflow and asks once. Task 14 implements
  normal, ended-early and first signed-out variants; the first-workout Keep line follows 12f.
- **12e · Delete account (owner ruling; build on every layer).** Both phones, signed in, from You's
  last row: an explanation, *Type your email to confirm*, *Deleting…*, *Your account is deleted* /
  *Sign in before Nov 21 to bring it back.*, and *Couldn’t delete your account. Check your connection
  and try again.* (Shell iOS section 4c `47:3852`, boards 27a–27e; Shell Android `33:1568`, 27a
  `54:1269`–27e `54:1606`). iOS builds it (`AccountDeletion.swift`); Android does not. Two iOS states
  have no board: a failure on the phone itself (a room that cannot save, the discard owed after the
  close) says 27e's *Check your connection* sentence, and a 401 after the confirm closes the page onto
  You signed out, as 27d needs the day the server names; designer to rule. The server keeps the
  copy's promise: `DELETE /v1/me` closes with `closingOn` = now + 30 days, a sign-in before then
  brings the account back, and from then on it is erased with all its data (`backend/AUTH.md`).
- **12f · Sign-in is suggested once.** After the first finished workout, signed out, the receipt
  carries one line, *Only on this phone · Keep it*, and never again (03.15: iOS `1283:39725`, Android
  `1283:42292`). iOS builds it; Android's receipt line remains task 14. Routines has no standing
  sign-in suggestion.
- **12g · One message per destructive question, on both phones.** Discard a workout: *Discard this
  workout?* / *This deletes the workout and its 5 sets. You can’t undo this.* / *Cancel* · *Discard*.
  Delete a conversation: *Delete this conversation?* / *You can’t undo this.* / *Cancel* · *Delete*.
  The sign-in question: 7d. iOS asks every one of these through one question, `DestructiveQuestion`
  (`Gym/Components/GymRows.swift`), except that Inspect's stranded sets are not drawn: *Discard 2 sets*
  still asks *This permanently removes the copy saved on this phone.* as a dialog
  (`Recovery/WorkoutInspectScreen.swift`). A workout with no sets is not drawn either; iOS says *This
  deletes the workout. You can’t undo this.* Android asks nothing (11b).
- **12h · Coach details follow iOS.** What Coach read is a sheet; asked too often says *You can ask again later.* with
  *Use your own AI agent* and names no wait (08.8 `1898:33373`); *This Windmill
  does not have Coach. You can still read your log.* with no doors;
  *No conversations*; *New chat*; *Copy question* / *Copy answer*; no ⋮ More on Coach (Android 08.36
  `1898:32999`, 08.7 `1253:28776`, 08.32 `1254:31101`, 08.60 `1254:31663`). Android's access stances live in
  `coach/CoachAccess.kt`, and each refusal's words and door in `coach/turn/CoachTurnRefusal.kt`.
- **12i · Shipped iOS states, drawn on both pages.** *Draft kept on this
  phone* / *Continue saved draft* (01.18 `1283:40674`), the routine editor's History (02.13 `1283:39087`) and the Copy
  menu (08.32). The iOS boards are drawn from the code and await a
  device check. Neither phone draws Coach's choice chips and the catalog has no `ask_setup_details`, while 01.17 reads 🚀 on
  both pages (iOS `1283:41514`, Android `1283:40111`): retire it.
- **12k · No Erase data; Delete account removes the cloud copy.** No phone offers Erase data:
  removing the app erases its data. Delete account's first line says *This deletes your Windmill
  account and its copy in the cloud: your roadmaps, journal pages and gym log.* (12e).
- **12m · Delete account with unsent changes (owner ruling, 2026-10-22).** They are deleted with the
  account, said plainly and with no extra choice: a fifth fact *3 changes on this phone haven’t been
  confirmed by your account. They are deleted too.* (Shell iOS 27f `91:5187`, 27g `91:5256`; Shell
  Android 27f `96:2122`, 27g `96:2157`). The phone flushes for up to 5 s, then calls
  `DELETE /v1/me`, then discards its copy, as the web's closure does (`AuthProvider.jsx`
  `closeAccount`). iOS counts the engine's live unsent entries (ready and sent), which leaves out
  pending device work, as the engine's live status does not carry it; Android builds no Delete
  account (48). The fact's symbols (`iOS / Symbol / icloud.slash`, `Android / Symbol` `cloud_off`)
  are in the Design System but not published: until the owner publishes, those 8 boards draw local
  stand-ins named `⟳ DS publish · …`, which
  `.claude/scratch/android-gym-figma-verify/owner-answers-12/post-publish-swap.js` swaps.
- **12n · The sign-in decision names what the phone holds (owner ruling, 2026-10-22).** The words are
  7d's; the nouns are only the kinds present, in this order: workouts, routines, weigh-ins,
  movements, notes, journal pages. Sets go with their workout; settings, movement names and Coach
  drafts are not named. The account line names what the account holds; *it* for one item, else
  *them*; the confirm title is *Discard {phrase}?* for one or two kinds, *Discard all of it?* for
  three or more. One question answers both rooms (Shell iOS 23g–23j `94:5426`, `94:5455`, `94:5482`,
  `94:5511`; Gym Android 07.9 `1336:17333`, 07.10 `1336:17426`). iOS builds it
  (`AdoptionQuestion.swift`); Android does not (25). A room holding only unnamed kinds is not drawn:
  iOS counts its changes, also beside another room (*3 changes and 3 journal pages*), so the answer
  never reaches a room the question did not name; designer to rule.
- **12o · Delete account: two proven no-close states on Android (owner approved 2026-11-01).**
  Android's recoverable close (`backend/AUTH.md`, Recoverable deletion) can be refused for a wrong
  phone clock, or never reach the server while the account stays live. Android draws both
  (`platform/you/DeleteAccount.kt`, `AccountDeletion.kt`, task 65). Two boards, Shell Android:
  - **27h Couldn’t delete — date and time** (Dark `139:2733`, Daylight `139:2786`, beside 27g in
    `33:1568`): error line *Your account wasn’t deleted. This phone’s date and time look wrong. Fix
    them, then try again.*, an inline *Date & time* text button (Android date settings), **Try again**,
    **Cancel**. Condition: a send of the operation answers 409 `clock-ahead`, or 404 `unavailable`
    while the session is still accepted and the phone's monotonic clock puts that send at least 90 s
    inside the 5 minutes after the operation's stamp (Android allows that margin for transit and server
    lag; a later send goes the D6 way). Either proves the operation changed nothing.
  - **D6 Not deleted** (Dark `139:2867`, Daylight `139:2896`, in section D `116:754`): *Your account
    wasn’t deleted* / *The request didn’t reach Windmill in time, so nothing changed. Your account
    works as before.* / **Try again** (opens 27a; a new confirm mints a new operation) · **Back to
    You**. Condition: the receipt read answers `unavailable` and the identical close, sent with the
    phone's still-accepted session, answers 404 `unavailable` (past the 5-minute window by the
    server's clock, no receipt). A close revokes every session, so the accepted session proves no
    closure. On that proof the phone clears the pending record and releases the fence before drawing.
    A refused session (401) or a request 35 or more days old stays on D3.
  - After a restart the phone has no monotonic stamp, so a slow clock's refusal reads D6 (*didn't reach Windmill in time*), not 27h; Try again then shows 27h. Designer to rule whether D6's words should cover that case.
  iOS sends the body-only close (`AppRuntime.swift` `deleteAccount`), so it has no clock refusal and no
  pending record; its 27e stays as drawn. If iOS adopts the recoverable close, it takes both states.
- **12p · iOS receipt *Save to ‹routine›* and a load under 0 (needs words).** A barbell or two-dumbbell
  target under 0 is refused by every domain (`routine.loadFloor`). iOS `WorkoutReceipt`'s *Save to
  ‹routine›* sends the edited plan through `SaveRoutinePlan`, so such a target now reads the generic
  *‹routine› wasn't changed. Try again.*, which a retry cannot fix; Edit sets checks only the target's
  shape. The receipt needs its own refusal copy, or Edit sets refuses the load first.
- **12q · iOS recovery fix and a load under 0 (needs words).** A recovery fix that moves a barbell or
  two-dumbbell load under 0 is refused (`set.loadFloor`; Android `invalid-set`). iOS `WorkoutFixSheet`
  shows it through its existing `invalidSet` line, *Refused by the log — fix the workout, then retry.*,
  which does not say *0 or more*, the words Fix set and the editor use. Android's recovery fix edits
  through Fix set, whose inline line already says them. iOS needs that refusal copy.
- **12r · Web past workout: a barbell load of 0 reads as *bodyweight* (needs words).** The web
  past-workout form labels a load of exactly 0 as *bodyweight* for every movement
  (`web/src/products/gym/backfill/draft.js` `valueLabel`). Since 0 is the barbell and dumbbell floor,
  the lowest allowed barbell load reads as *bodyweight*. The same form labels a negative bodyweight load
  *kg added*, while the session page reads *kg assisted*. The form needs equipment-aware load words.
- **12s · Coach Apply and a target under 0 (designer to confirm).** Applying a Coach proposal whose
  added or retargeted line sets a barbell or two-dumbbell target under 0 is refused by every domain
  (`routine.loadFloor`). iOS, Android and web show the routine editor's line, *Load, 0 or more.*, where
  each shows an Apply refusal. No board draws this refusal; a designer confirms the reused line.
- **12t · Proposal card and sheet: iOS has the stock pass, Android the earlier layout (owner, 2026-11-08).**
  On iOS a proposal — Coach's or a connected tool's — is drawn by 08.2P, 08.12P–08.14P, 08.27P and 08.56P
  and, from its Routines row, by 02L.1P, 02L.9P, 02L.10P and 02L.11P (🚀 In production 2026-11-08, note `2023:21188`): a
  `GroupBox` card with kind symbols, `LabeledContent` fields, a `DisclosureGroup` (*3 more changes*) and
  Reject | Apply in one row; a `Form` sheet that lists every change, applies from the toolbar, dismisses on
  Reject, names its source with `link`, and asks before a connected tool's routine removal applies. Android's
  proposal card and review sheet (08 · Coach `1224:13123`) draw the earlier layout until an Android pass follows.
  Ledger drift, not a task.
  - On iOS the read line stands under the answer, above every card it carries (08.2P's rule, one placement in
    `CoachAnswerView`); the boards of an answer that wrote rather than proposed — a saved note (08.9), a created
    routine, a made movement (08.37), the ended states (08.46–08.50) — still draw it under their cards. The drafts
    card (01.x), a made movement (08.37) and the workout receipt's plan changes (03.32) keep the kind word over
    each change, where a proposal leads its movement with the kind's circled symbol. For a designer: redraw
    those boards to the proposal's language, or rule that they keep their own.

### Coach on the client

Spec: [Gym Coach on the client](../foundation/mobile/gym_coach.md), implemented on the backend, iOS and
Android. It and the product differ in these places.

- **6q · One agent rule per ability.** Coach never logs, fixes or deletes a set, finishes or
  discards a workout, or writes a bodyweight (`brand-foundations.md`, Gym). MCP runs
  `start_session`, `log_set`, `log_sets`, `finish_session`, `discard_session` and `import_session`.
  The spec gives each ability one agent rule for both doors and withholds these until the owner
  rules (its Appendix B-1).
- **6s · Pasted programs.** The Coach contract and both phones accept 8,000 UTF-8 bytes. The web's `QUESTION_BYTES`
  remains at 1,000, and the web textarea also limits character count to 1,000. Align the web when delivering its setup
  flow, preserving the complete draft and a specific length refusal rather than silently truncating a pasted program.
- **6t · Coach recovery proposals to delete (designer).** Gym Proposals still holds
  [A1](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1494-5069),
  [A2](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1494-5070) and
  [B.2](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49219), drawn for an onboarding client no phone's
  source holds. 08.42, 08.43 and 08.46–08.48 draw what a phone turn says, and no request waits on anything.
- **6v · Local Coach boards, 🚀 In production on iOS since 2026-10-29.** The Gym iOS page holds
  the states the local Coach adds (`gym_coach.md`, BUILD.md W4) as 🚀 In production Dark/Daylight
  pairs, each with a caption (Dark / Daylight / caption): 01.19 signed-out answer with its read
  receipt `1589:39083` / `1690:14725` / `1589:39289`; 08.35 step line from catalog phrases `1588:12617` /
  `1690:13258` / `1590:13207`; 08.36 What Coach read `1589:12790` / `1690:13279` / `1590:13212`;
  08.37 Made a movement `1589:12859` / `1690:13300` / `1590:13217`; send refusals 08.38 no connection
  `1588:11903` / `1690:13319` / `1590:13222`, 08.40 coach-replica-syncing `1588:11985` / `1690:13361` / `1590:13232`, 08.41 over
  8,000 bytes `1588:12026` / `1690:13380` / `1590:13237`, 08.42 invalid_installation `1588:12075` /
  `1690:13399` / `1590:13242`, 08.43 device_bound `1588:12116` / `1690:13420` / `1590:13247`, 08.44
  free_month_exhausted `1588:12157` / `1690:13441` / `1590:13252`, 08.45 coach-update-required
  `1588:12198` / `1690:13462` / `1590:13257`; ends 08.46 truncated `1588:12239` / `1690:13483` /
  `1590:13262`, 08.47 declined `1588:12300` / `1690:13502` / `1590:13267`, 08.48 failed `1588:12361` /
  `1690:13520` / `1590:13272`, 08.49 stopped `1588:12422` / `1690:13539` / `1590:13277`, 08.50
  interrupted `1588:12489` / `1690:13564` / `1590:13282`; 08.51 answering on another device
  `1588:12556` / `1690:13590` / `1590:13287`; 08.52 resume from the snapshot `1588:12654` /
  `1690:13605` / `1590:13292`; 08.53 empty History under R5 `1589:12977` / `1690:13626` /
  `1590:13297`. The build answers during a workout, as the ✅ board 08.54 in 08.39's slot draws it (10z);
  the refusal board 08.39 is deleted. Three
  redraws took their originals' slots and the originals were deleted: 08.6 is now
  the account-changing state `1589:13033` / `1690:13247` / `1590:13302` (replaced the no-seat pair
  `1186:5415` / `1186:5477` and caption `1117:1740`); 01.5 is the photo in the composer under R8
  `1589:39166` / `1690:14706` / `1589:39294` (replaced `1173:4111` / `1173:4983` and caption
  `1174:5318`); the 08 section's flow instruction is `1589:13082` (replaced `1117:1706`, still
  ✅ Ready for dev). Drawing facts: 08.37 is drawn on the Changed row with its word overridden because the Added
  row holds one field; 08.41 says characters where the contract limit is bytes. Where the build and
  the drawings differ: the step line and the What Coach read rows take the catalog's own phrases
  (*read your program*, *wrote a proposal for one of your routines*) where 08.35 and 08.36 drew
  *read your routines* and *proposed a change*; 08.37 draws no receipt row, the build keeps it
  (brand foundations: always visible); 08.35 and 08.36 omit the context reads the build lists; 08.56P and 08.57 draw *Read
  this workout · 6 weeks*, where `CoachReading` prints a count; 08.49 and 08.50 draw a *Changed a movement* card, which no
  ability can land (`update_exercise` is withheld, B-1), so the build's landed write is *Made a
  movement*; 08.41's line counts UTF-8 bytes under the word *characters*, and its field grows to five
  lines with the pasted draft where the board draws one; 08.44's reset day comes from
  `allowance.budgetResetsAtMs` on the turn route's refusal before the stream, and follows the phone's
  locale (*Nov 1* in en_US). The backend code sends it under dogfood node
  `gym-coach-turn-allowance-reset`; production sends it once that node is done, and until then the line
  ends at *this month*. A refusal mid-turn names the same moment on its `error` frame, where iOS reads
  only `code`, so that line always ends at *this month*.
- **6x · The iOS sign-in decision names no conversations.** Signed-out Coach conversations are engine records, and
  they join the account or are deleted with the rest of the signed-out gym data (gym Coach §9.1). Android names them
  (`PhoneSignInCopy`, 07.15 `1902:35369`, 07.16 `1902:35444`). iOS `AdoptionQuestion.named` lists workouts, routines,
  weigh-ins, movements, notes and journal pages, so a phone holding only conversations reads *N changes* and Discard
  deletes them unnamed. For iOS: `conversation` in `AdoptionQuestion.named`, which reads *This phone has 2 conversations
  from before you signed in. Your account already has training. Add them, or discard them from this phone.* and *Discard 2
  conversations?* / *They are deleted from this phone. You can’t undo this.*
- **6y · Android's exchange against its boards.** Where the build and the drawings differ: 08.36's rows are no doors,
  so What Coach read opens no workout; 08.35 and 08.36 draw no card beside their *wrote a proposal* step, and the build
  draws the card when the call lands, as iOS does; 08.35 and 08.52 end their running words on an ellipsis, which the
  build leaves out, as iOS does; What Coach read stands 502 dp where 08.36 draws 496, because a single line of Nunito
  keeps its font's height under a smaller leading (the title 38 dp against 36, a row's title 20.5 against 20) and the
  gaps round to whole pixels; 08.69's close glyph is the kit's inverse-on-surface, which barely reads on its band, so
  the build draws it in text/secondary; 08.70 stands the read tally 16 dp under the answer where 01.19 and 08.36 stand
  it 6 dp under, and the build holds the 6; the note card comes from 08.25, which draws one paragraph, so the build
  shows the note's body and its title stands in What Coach read; every board stands the rail's icons and labels 6 dp
  above where Material's NavigationBar lays them, and the build keeps Material's. An answer that read no workout and no
  movement history, where Coach itself asked for a read or a note or a routine stood by its message's moment past what
  its own turn made, says the catalog's phrases of the reads it ran, joined as the step line joins them with the first
  letter capitalised, over What Coach read; no board draws that line. 08.61 draws its disabled Send's glyph on-accent, which barely reads on
  its circle, and the build keeps Material's disabled colours. 03.46 draws a
  set as *1*, a ladder of −5, −2.5, +2.5, +5 and the movement in Nunito, where the shipped rack draws *Set 1*, −2.5, −1,
  +2.5, +5 and a sans name, and the rack stays as today (D5). 08.71 and 08.72 draw the kept row 20 dp tall
  and the build keeps its 48 dp target, so each sheet stands taller than its board. 08.71 draws 08.55b's sheet, and a routine's
  keeps its own type, row height, inset kept row and Ask Coach, as the caption says. A movement that moved and changed says
  *Order* over its targets, and a settled proposal draws no move, since a move reads against what the proposal waited on; no
  board draws either. No board draws the way back from 08.72's Sign in: the sheets close and sign-in stands over the rack, and
  after the code a new account lands on the rack with the proposal still waiting, and an account with training first asks *Add to
  your account?*. A refused write that is neither training nor a named record says *That change could not be saved.* over its
  reason, words the log's other refusals already use; no board draws it. A Stop refused for another
  reason (`stopUnheard`) says the first sentence of 08.69's band, *Coach is stopped on this phone.*, since the turn has
  already ended. No board draws an interruption with no words, and the build says the first sentence of 08.50's line,
  *Interrupted.*
- **6z · The Android boards after the phone Coach (designer).** Once it ships, delete the originals it replaced, with their
  Daylight pairs: 08.5 `1253:28654`, 08.8 `1253:28820`, 08.9 `1253:28915`, 08.26 `1254:37761`, 08.61 `1442:18583`, 01.5
  `1253:30626`, 01.8 `1254:32583`, 01.16 `1254:32725`, 01.17 `1283:40111`. The originals of 01.8, 01.16, 08.9 and 08.26 still read
  ✅, so a task links 01.8 and 01.16 by the redraw's id. 08.58's original and 08.58b stay, since the build draws them, and 01.7,
  01.14 and 01.15 stand for retained onboarding answers alone. 08.63 stays 🚧 under a section header that reads ✅. The page's
  Snackbar sets its words in Roboto (`1254:38382`), and `Android / Diff field`'s *Equipment* stands 78 px wide (08.26), which
  the designer measures 6 px past its label column.
- **6aa · Words the Android boards added, for the owner to check.** 08.41 *Too long by 1,400 bytes. The limit is 8,000 bytes.*
  / *English letters take 1 byte each. Other letters and emoji take more.*; 08.70 *Held on the phone that sent it*; 08.55b
  *removed from this workout*; 08.56 *Proposal · Push A · next time*; 07.15 and 07.16 *conversation* as the sign-in noun; the
  specimens *I made 3 routines.* and *I made Incline Dumbbell Press, then*. 08.45 says Android's *Get the update*, not iOS's
  *Update*. 08.68 offers *Use your own AI agent* on a shared free day, which iOS code does not (`CoachTurnRefusal.recovery`).
  A spent signed-out allowance says *You have used all of your AI allowance.* over *Sign in to continue.* on both phones; on
  Android one with too little left for a round says *Coach’s AI allowance is unavailable right now.* over the same line. That
  allowance is $0.25, and an account's month is $0.50, which counts this phone's spend from the same month, so about $0.25 is left
  after signing in and the line holds. An account truly run out says the same first sentence and *It comes back on {date}.*,
  08.44's words, on Android; iOS's signed-in notice names no date.

### Native and web differences

- **A retargeted line that moved, on the web.** A proposal's count is every line not kept and every kept line that moved, and the
  phones draw a move as *Order* on its row. The web never sees the base, so it marks the order only when the count holds more than
  its marked rows: one *order* row however many kept lines moved, and none when the only line that moved was also retargeted.
- **Web Coach capability line.** The Coach header says “Reads your log · proposes only”, while
  requested routine creation saves routines directly and returns creation receipts. Existing
  routine changes still require Review/Apply. Replace the inaccurate header with wording that
  distinguishes creation from proposed changes; the signed-in iOS setup phase does not change web
  chrome.
- **Coach Markdown.** Android renders answer Markdown blocks and paces streamed text; web
  `CoachRoom.jsx` renders plain text. Decide the shared block typography and pacing, then align the
  other clients and Figma specimens. Tracking: `gym-android-coach-stream-markdown`.
- **Shared workout set numbers.** The web single-workout share page prints each set's server set
  number (`web/src/products/gym/share/SharedSession.jsx`, `gym-set-number`), so sets numbered out
  of logged order read *2, 3, 1*. The owner's ruling (11u) counts each movement's sets 1..N in
  logged order as a quiet digit.
- **Workout display names.** The API's optional `routineName` changes a corrected workout's
  display name independently of its frozen plan. Native session readers need to prefer it,
  including an explicitly empty name for a free session.
- **F38 · Target entry.** Web uses the ladder as its count; native entry retains Sets. Decide
  whether that difference is intentional. Android's targets are drawn as number steppers (Android
  02.6, 02.11; 11d).
- **4k · Leaving drafts.** iOS asks *Discard routine changes?* (Discard · Keep editing) on a
  dirty Cancel and blocks swipe-dismiss (`RoutineEditor.swift`). Android follows the same rule and
  words (02.20, the revised 02.17; task 56): Back, the gesture and the back arrow ask
  on an unsaved draft, and the gesture previews nothing while it would ask. Web and restored drafts
  remain open.
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
- **Narrow tab label.** At 320dp/200% text Android keeps every navigation label whole (00.7,
  task 54): *Routines* spills into its neighbour's spare width and *The log* wraps
  at its space. The 00.7 caption draws the wrapped label at a 28 sp line; Android keeps the
  label's own 16 sp line scaled to 32 sp.

- **Android Display stepper overflow.** [O · Display overflow](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1523-6723)
  was human-approved on 2026-10-26. Task 04 implements the approved rule: retain the 88sp inline
  display where it fits, move the unit below on overflow, fit the numeral with a 32sp floor before
  system scaling, and use a full-width field with the existing 48dp controls below when enlarged
  text needs that width. Focused editing expands immediately and retains its largest layout until
  blur, preserving native caret and selection. Dark and Daylight specimens cover `-12.5`, `-102.5`
  and `-499.99`, ordinary and 320dp viewports, focus and 200% text. Native minus remains the sign
  input. API 37 Dark/Daylight captures verify complete signed values
  at rest and either caret end, focused expansion at 320dp/200% text, and native metric-driven field
  growth. The real editor retains its full value, caret and selection.

### Copy and review decisions

- **Connected-log write disclosure (Android build).** `GymToolCatalog.cpp` exposes append-only
  `save_note` at `gym:write`; the Write level reads *logs sets · saves notes · adds routines · shares
  workouts · proposes changes* on both phones (Android 09.3 `1254:39148`), but Android's copy omits
  *saves notes* (`presentation/ConnectedLog.kt:61`), and its head names *Claude, Cursor or Codex* where both
  phones now say *Your log, read by ChatGPT or Claude.* (`presentation/ConnectedLog.kt:10`).

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
  stays in code and on the wire. The approved Android Workout uses visual position dots and speaks
  *Movement 3 of 5* through accessibility; the count is not a visible pager label. The tab is
  *The log*, and Android uses it for both its tab and root title. Code still differs: Android
  *Exercise {i} / {n}* (`presentation/LiveSession.kt:134`), *Rename movement*,
  *No sessions yet*, *First session*, *This session*, *Discard session*, *Check my
  last session.* (`LoggerScreen.kt`, `LogScreen.kt`, `AssemblySheet.kt`, `FinishScreen.kt`); the web's *No sessions yet.*, *no
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
