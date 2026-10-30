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
  document hides or the room unmounts; Android's workout/conversation windows on room disposal
  (`GymRoom.kt`, `abandonWithheld`). Android weights use durable engine holds and the application
  process lifecycle, preserving remaining time through recreation and releasing on true backgrounding.
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
- **6w · Keyboard bars on iOS 26.** The app avoids SwiftUI `.keyboard` toolbars because their
  retained layout can reduce later sheets' keyboard avoidance. Coach's *Done* is above its composer;
  the note editor has none. The combined routine movement editor uses `KeyboardBar` with *Next* and
  *Done* in its bottom inset while a field is focused, above the form's Done/Add action. Its keyboard
  and commit clearance are part of the compact-phone and large-text verification in 10y.

### iOS against the drawings and the other phone

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
  the Gym boards state none. The sync registry (v11) and the shared gym vectors carry no set kind:
  every logged set counts, and no surface carries one. Copy: every surface labels a workout's count
  *Sets* / *N sets* (finish receipts, workout detail, Coach's read card and sources, the web review tile
  and landing). The Gym boards say the same (mirrored 2026-10-29): iOS tiles 05.3 `1185:5019`
  `1185:5078`, 05.4 `1188:5824` `1188:5876`, 07.2 `1138:2287` `1138:2330`, 07.4 `1283:38779`
  `1283:38902`, 07.5 `1283:38851` `1283:38949`, the 02.13 History rows `1283:42197`–`1283:42264`,
  the 00.2 log row `1057:357` and Coach's read card `I1172:3646;138:1244` `I1172:3716;138:1244`;
  Android 03.7 `1254:32396` `1254:34576`, 03.8 `1254:32481` `1254:34638`, 03.14 `1283:41944`
  `1283:42013`, 03.15 `1283:42310` `1283:42386`, 03.16 `1449:32871` `1449:33786`, 07.2 `1284:16844`
  `1285:17001`, 07.8 `1284:17222` `1285:17108`, Coach's read card `1253:28726` `1254:41271`, and
  every *N sets · duration* / *N sets · N movements* line across 02.13, 03, 05, 06 and 07 (124 text
  nodes in all).
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
  Android pins a full-width button under the list (`LogScreen.kt:148-150`, `BodyweightScreen.kt:83-90`).
- **9r · No Gym settings anywhere (owner ruling, 2026-10-22; Android build).** Neither phone has a
  Gym settings page. On iOS, Notes and Connected log are reached from You's Settings
  (`AccountSheet.swift:419-431`) and a hidden workout from the tab bar's accessory on iOS 26 and the
  **Hidden** row at the head of The log on iOS 18 (board 03.5). Android draws the same: You holds
  *Notes*, *Connected log*, *About Windmill* (Shell · Android 16a/16b), the workout bar's trailing
  action is *Hide*, and Units go. Android still ships Gym settings (`ui/SettingsScreen.kt:81-129`)
  with a kg/lb toggle that draws nothing in lb,
  and Coach's ⋮ More with Notes, Connected log, New chat and Account (`coach/AskScreen.kt`).
  The workout bar has no settings action; its trailing slot awaits task 45's Hide behaviour.
- **9s · Notes' lines (owner ruling, 2026-10-22; Android build).** Both phones head Notes with *Any
  agent you connect can read these too.* only: no subtitle and no *Top note wins.* (iOS 09.1; Android
  09.1 `1254:39045`). Android's task 26 implementation uses that single line and removes both
  obsolete strings from `ui/NotesScreen.kt` and `domain/Notes.kt`.
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
- **10f · What Coach did, in iOS's words.** Web and Android put the phrase table's words in a step
  list behind the read receipt. iOS draws no step list: the receipt row opens *What Coach read*
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
  with no number; web and Android print the server's weeks (`coach.js` `readLine`,
  `Ask.kt`). The fix belongs to the backend: dogfood node `coach-receipt-weeks-provable`.
- **10o · The page is the target.** The Gym iOS page holds the current target. 🚀 means the
  drawing matches verified implementation; 🔨 means implementation; ✅ means human-approved design
  ready for development; 🚧 means design or approval remains open and its caption names that work. The six flow
  corrections in 10y are approved, with their implementation status on each flow. Device or fixture evidence is also pending where captions name it:
  04.1, 04.3, 04.4, 05.8's pan, 08.6 and 08.7.
- **10p · Gym iOS target boards.** The Gym file's iOS page holds Dark and Daylight targets.
  Each flow carries its delivery status; the six-flow contract in 10y covers the revised interactions.
  Target inventory:
  - 01 and 08: listed under 10q.
  - 02: editor always sortable 02.5 `1149:2200`; empty Routines with the floating + 02.7 `1149:2477`;
    remove by the trash circle 02.8 `1149:2275`.
  - 03: rack with Dumbbells 03.1 `1150:2352`; its states pressed 03.10 `1150:2495`, changed with 56 pt
    hit areas 03.11 `1150:2638`, Bodyweight with added load 03.12 `1150:2793`.
  - 04: the compact Lock Screen card 04.7 `1723:15733` (✅, task 69); the build draws it 141 pt
    tall at default text and 156 pt at the largest, under ActivityKit's 160 pt cap.
  - 05: The log with its labelled Weigh in 05.1 `1153:2765`; Edit movement 05.9 `1153:2559`; the
    Equipment menu 05.10 `1153:2603`.
  - 08: Coach updates a movement 08.9, listed under 10q.
  - Floating actions are Liquid Glass with their symbol in the accent: `_Gym / Floating action`
    (`1190:195`, Gym Components page) — Label=None, the 60 pt + for New routine (02.1, 02.7);
    Label=Text, the labelled *Weigh in* capsule on The log (05.1), since a bare + did not say what it
    adds.
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
    first words; iOS History draws such a row on one line unless its latest turn did not complete.
  - 08.31's **Sign in** under a signed-out answer shows when one of the answer's calls was refused for needing an
    account, or when an onboarding answer an earlier version kept says `needsAccount`. The server sends an `anon` turn
    no call that needs an account, and the backend's onboarding schema and prompt do not produce `needsAccount`, so the
    button shows only on the simulator fixture.
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
    - 08.9, 08.25 and 08.26: the *Saved a note* card carries the note's title and body, read from the record the
      call created. No movement card is drawn: Coach is not offered `update_exercise` (withheld,
      [gym_coach.md](../foundation/mobile/gym_coach.md) B-1), so 08.9 and 08.26 are unreachable, and a
      `create_exercise` call draws no card.
- **10r · Swipe delete is the native trash circle (owner ruling, 2026-10-22).** Everywhere in gym a
  trailing swipe slides the row and reveals a round red trash circle with no text label, drawn with
  the local component `_Gym / Swipe actions` (`1190:172`). iOS draws it with one shared modifier,
  `TrashSwipe` (`Gym/Components/GymRows.swift`), on the Routines list, the movement editor's per-set target rows, The log,
  workout detail sets, Bodyweight entries, Notes, Coach History and the routine editor's movements
  (02.8 `1149:2275`) and This workout's movements (03.4 `1135:1875`), both lists out of edit mode
  that draw their own handles and drag on a long press. A one-line row draws the system's capsule
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
    exercise and the combined routine movement form read the same words.
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
  04.6, 04.7 and 08.54–08.57 with a READ ME in section 03 (`1717:15737`); the written half is
  [workout-in-flight.md](ios/workout-in-flight.md) and the build tasks are `iosgym_tasks/60`–`69`.
  Owner ruling 2026-10-30: a movement with a logged set keeps its plan. The build draws the rest
  target (03.20–03.22), the typed load and the one reps wheel (03.23–03.25), Coach during a workout
  (08.54) with routine proposals applied for next time (08.56's routine card), and the rest target
  outside the app on the expanded Island (04.6) and the compact Lock Screen card (04.7, task 69),
  neither of which says what is unsent. It differs from the editable plan's boards: the plan stays
  frozen, so the movement menus, Edit sets, Swap movement, the receipt's plan card and Coach's
  workout cards (03.26–03.32, 08.55–08.57's workout cards; tasks 63–66 and 68) are not built yet.
  04.3's expanded presentation draws a moving rest bar the build does not carry; 04.6 is what it draws.
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

- **Web reconciliation evidence.** All 25 current Roadmap screen/state families are mapped in the
  [evidence log](roadmap-web-reconciliation.md) and linked from the [flow index](../index.md#roadmap--web).
  🚀 marks source/runtime reconciliation; runtime limits are separate. Native graphs and SwiftShader
  captures do not establish WebGL lighting, animation timing or real-GPU performance.
- **Web AI failure copy.** `tending/receipts.js` says the submitted sentence remains available, but
  `TendBar.jsx` clears it on submit and `SkillTreeView.jsx` closes the desktop overlay on terminal
  outcomes. Preserve the prompt or correct the copy; current drawings retain the implemented face.
- **Web shortcuts layout.** `skilltree.css` keeps two columns and nonshrinking keycap groups.
  At 390px, Pan/Zoom overlap View; Windows desktop Zoom also extends slightly into Edit. Local
  owner/reader and Mac/Windows captures confirm this. Adapt columns/key wrapping in the implementation;
  current Figma deliberately shows the defect. Phone owners receive Navigate/View only because
  `SkillTreeView.jsx` passes its canvas read-only flag, despite mobile ownership editing support.
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
- **Web mobile empty tree.** `SkillTreeView.jsx` mounts the “Add your first step” empty card only
  when `!readOnly`, which excludes phone and tablet canvas. Mobile owners can edit populated trees;
  an existing zero-node mobile tree needs an explicit recovery affordance. The Figma empty-card
  specimen is scoped to desktop.
- **Marketing capability copy.** `RoadmapLanding.jsx` says starter quests and paste-list creation
  are still growing in, although `QuestShelf.jsx` and `PasteComposer.jsx` provide both. Its promise
  that a first branch unlocks tonight also exceeds the completion-dependent unlock behavior.
  Marketing owns the copy correction; Roadmap drawings must not reproduce these promises as canon.
- **Board vocabulary drifts from the tiers.** The Board proposal pages name the three tiers
  *Closed · Up next · Done* and the same state *ready*, *blocked* and *locked* in toasts and empty
  states; canon names them locked · available · complete and the card glyph is a lock. Owner ruling
  2026-10-28: **Locked · Up next · Done**, one word per state ([review](roadmap-board-review.md));
  redraw both pages before any Board flow is Ready for dev.
- **Board says node where the product says step.** Both Board pages use *node* in every control
  (*Search nodes*, *New node*, *Needs 2 nodes*); the shipped roadmap and the L4 vocabulary say
  *step*. Redraw with *step*; the proposal's validation list must stop naming node terminology as a
  requirement.
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

- **11a · The page is the target.** Journeys 00–09 carry the iOS numbers; Android-only boards
  take the next free number in their journey. The six revised Coach, Log, Weigh-in, Workout, Finish
  and Routine editor flows were human-approved on 2026-10-25: 92 frames and 46 captions are
  **✅ Ready for dev**. Their current links and task scope are in `androidgym_tasks/README.md`.
  Other Gym and Shell boards retain their individual delivery status. Sign-in, email code and You
  live in the Shell file's Android page (section `33:1568`). A visual state absent from an approved
  flow still needs its own design handoff; completing the drawings does not complete app delivery.
- **11b · Deletion follows the resource.** Use the shared Material end-to-start swipe row with
  the error-red ground and trash icon (`Android / Swipe row` `337:2217`). Routine, set and note
  deletes commit immediately where their tasks specify it; workout discard and conversation delete
  ask once. The approved Log/Weigh-in flow keeps a nine-second held weight deletion and Undo, so
  `WithheldDelete.kt` remains while that path uses it. Do not remove all holds as shared-row cleanup.
  Android routine/editor/detail-set rows use the shared ground. Immediate actions are application-owned;
  weights project exact durable receipts. The remaining row migrations belong to their screen tasks.

  | Place | Code today | Board | Build work |
  |---|---|---|---|
  | Routines list | `ui/RoutinesScreen.kt`, shared row, immediate | 02.10 `1253:29196` | deletion and FAB verified in Dark/Daylight |
  | Routine ⋮ Delete | `ui/RoutinesScreen.kt`, shared error-role menu, immediate | 02.12 `1253:29480` | verified in Dark/Daylight |
  | Editor movement | `ui/RoutineBuilder.kt`, shared row, draft-only removal | 02.8 `1252:30621` | swipe verified in Dark/Daylight; editor geometry remains 18 |
  | Target set row | `ui/TargetBlock.kt:264-277`, word ground | 02.11 `1253:29263` | shared row |
  | This workout row | `ui/AssemblySheet.kt:163-195`, both directions, *Remove* on raised | 03.4 `1253:29834` | end-to-start, shared row |
  | Workout detail set | `ui/SessionScreen.kt`, shared row, immediate | 05.4 `1252:27713` | swipe verified in Dark/Daylight; Session copy remains 23 |
  | The log row | `ui/LogScreen.kt:241-267`, no swipe; long-press *Discard session*, held | 05.2 `1252:27527` | swipe + *Discard this workout?* |
  | Receipt and workout detail Discard | `ui/SessionScreen.kt:313-328`, no confirmation, held | 03.14 `1283:41920`, 05.3 `1252:27642` | confirm once |
  | Bodyweight | `ui/BodyweightScreen.kt`, no swipe; *Delete weigh-in* uses a durable nine-second hold | 06.2 `1254:32141`, 06.3 `1254:32246` | shared swipe, nine-second held delete and Undo |
  | Notes | `ui/NotesScreen.kt`, shared row swipe and immediate error-role editor deletion | 09.1 `1254:39045`, 09.2 `1254:39104` | verified in Dark/Daylight; handle reorder stays separate |
  | Coach History | `coach/ThreadsScreen.kt:164-187`, held, *Conversation deleted.* | 08.4 `1253:28552`, 08.34 `1254:31663` | *Delete this conversation?* |

  The refusal notice's swipe (`ui/RefusalBanner.kt:52-89`) dismisses a notice, not a record, and
  keeps its *Dismiss*.
- **11c · Destructive actions use the M3 error role (owner ruling, 2026-10-22).** Library Theme
  `android/system/error` (#E46962 dark · #B3261E light) and `on-error` (#410E0B · #FFFFFF). The app
  maps M3 `error` and `onError` to those roles in `ui/GymMaterial.kt`. Direct destructive
  controls still use other roles: brick (*Discard session* `ui/SessionScreen.kt:322-326`, *Delete
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
  `1252:30392`, 02.11. The owner's 2026-10-25 clarification approves the native keyboard's minus
  key for assisted loads; verify signed decimal entry on the target emulator and add no app-level
  sign control. The approved Workout has at most three headerless 48 dp
  ledger rows, inline load units and visual position markers instead of visible counts or arrows.
  Add movement lives in This workout. Weigh-in uses a native decimal keyboard and date picker;
  task 24 still needs its approved compact sheet, calendar and IME-state implementation.
- **11e · Equipment, units and Edit movement.** Routine summary, editor, finish receipt and
  workout detail use equipment-aware units with a preceding space: *kg each* for paired dumbbells,
  *kg total* for barbell/machine, *kg added* for bodyweight, and *kg* for one dumbbell, cable,
  kettlebell, Other or unknown equipment. Coach presentation retains its own formatter.
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
- **11f · New routine is a FAB (owner ruling, 2026-10-22).** Routines uses the shared M3 FAB (+),
  bottom-end 16 dp above navigation, with its accessible *New routine* label at every text scale.
  The root bar holds only title/account; the paired 03/17 native check verifies full/empty Dark and
  Daylight, a 56 dp FAB and a 48 dp account target at standard and 320 dp/200% text.
  Boards 02.1 `1252:27415`, 02.7 `1252:30574`. *Weigh in*: 9q. The current Coach proposal card and
  Review destination remain while action appearance changes are deferred at the user's request.
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
- **11k · Proposals decided on the card — postponed from this Android release.** Preserve the current
  action cards, review route and outcome wording under the owner's 2026-10-25 scope decision.
  Android decides a proposal in a review sheet
  (`ui/ReviewSheet.kt`: apply after scrolling to the end, *Turn this down* behind a confirm), its card
  says *Review* under the promise line (`coach/CoachAnswer.kt:327-341`, `Ask.promise`), and receipts
  say *Turned down* (`domain/Proposal.kt:184-274`, `coach/Thread.kt:53,77,88`). The boards decide on
  the card with a per-field diff and Apply / Reject: 08.2 `1252:27854`, 08.3 `1253:28311`, 08.12–08.14,
  the catalogue 08.15–08.31 (`1254:37242` … `1254:38214`). 10v covers the words on every surface.
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
- **11n · Android specimens.** The boards set text in Nunito and JetBrains Mono, standing in for the
  app's system sans and mono (`ui/GymMaterial.kt:57-81`); system parts come from the team Material 3
  Design Kit, themed with the Windmill Theme roles. Native implementation uses Compose Material 3.
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
  | `android-coach-partial-drafts-design` · deferred, unapproved | 41, 42 | Excluded from this release with Coach action-presentation changes; the proposed mixed-result cards are not approved. |
  | `android-coach-bound-installation-design` · access approved | 36, 38 | 08.6b Dark `1489:49152` / Daylight `1489:49306` are human-approved 2026-10-28 and Ready on the Android design page. History and Sign in remain available; anonymous Send is absent. The separate B.2 recovery card is unapproved. |
  | `android-account-delete-recovery-design` · approved | 48 | [D1–D5 recovery](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=116-754) is ✅ Ready for dev, human-approved 2026-10-25; Android integration remains task 48. |
  | `account-delete-reconciliation` · resolved | 48 | Backend account-scoped closure receipts and session-independent recovery are deployed in `ac1e0c75`; Android integration and acceptance remain task 48. |

- **11q · Routine editor field and picker geometry (owner: task 18).** Installed Android
  `ui/RoutineBuilder.kt` still paints the Name field with a filled rounded container; approved
  [02.3 Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44602)
  uses the native outlined-field anatomy. Its movement picker nearly fills the native viewport,
  while approved [02.4 Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44782)
  leaves the editor toolbar visible. Task 02 aligns the field accent and picker surface only;
  task 18 owns the remaining editor/picker geometry, and task 03 owns the toolbar.

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
  This workout shows *Notification off* · *Show*. Android today cannot leave the logger before Finish
  (`GymRoom.kt:163,180`), and a swiped notification sets *Workout hidden* / *Show workout* in Gym
  settings (`ui/SettingsScreen.kt:113-118`, `notification/WorkoutNotifications.kt:211`).
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
- **12h · Coach details follow iOS.** What Coach read is a sheet; a movement's details read *Weight
  is · Total → Each dumbbell*; the day's cap uses the server's actual `retryAtMs`/`Retry-After`
  with *Use your own AI agent*, and a nonnumeric fallback when timing is absent; *This Windmill
  does not have Coach. You can still read your log.* with no doors;
  *No conversations*; *New chat*; *Copy question* / *Copy answer*; no ⋮ More on Coach (Android 08.5
  `1253:28654`, 08.7 `1253:28776`, 08.8 `1253:28820`, 08.26 `1254:37761`, 08.32 `1254:31101`, 08.34
  `1254:31663`). Android: `coach/Ask.kt:180,218,225-240`, `coach/AskScreen.kt:142-153,282-315,332-343`,
  `coach/Thread.kt:157,168`, `coach/CoachAnswer.kt:225-228`. The cap's hours come from the 429's `retryAtMs`, as iOS
  says them (`Coach/CoachWire.swift`, `CoachCopy.daily`); Android does not read the field yet (10v).
- **12i · Shipped iOS states, drawn on both pages.** Coach's choice chips (01.17), *Draft kept on this
  phone* / *Continue saved draft* (01.18), the routine editor's History (02.13), *· yours* on a custom
  movement (02.2) and the Copy menu (08.32). The iOS boards are drawn from the code and await a
  device check; Android builds none (01.17 `1283:40111`, 01.18 `1283:40674`, 02.13 `1283:39087`).
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

### Coach on the client

Spec: [Gym Coach on the client](../foundation/mobile/gym_coach.md), implemented on the backend and
iOS. It and the product differ in these places.

- **6p · Android signed-out Coach.** Android's Coach is account-only (*Coach reads your log, so it
  needs you signed in.*, `coach/AskScreen.kt` `AskSignedOutStance`); it calls neither
  `/v1/gym/coach/onboarding`, the turn routes nor `/v1/ai/installations`. The owner decided on 2026-09-26 that Android carries signed-out Coach;
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
- **6t · Coach recovery proposals awaiting approval.** Android specimens for provider refusal,
  truncated output and unavailable or invalid installation credentials are in
  [Gym Proposals](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1494-5069), with
  [waiting/local saving](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1494-5070)
  and [bound pending-result recovery](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49219).
  These recovery cards remain unapproved; local-save cards A2.3/A2.4 are postponed with tasks 41/42.
  The access-only 08.6b pair is human-approved 2026-10-28 and moved to the Android design page:
  [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49152) /
  [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1489-49306).
  Anonymous waiting and local saving are distinct states; “Stop waiting” cannot promise that provider spending stopped. Existing
  anonymous and account allowance-exhaustion boards are ✅ Ready for dev; the Windmill One
  variant remains excluded while checkout is closed.
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
  `1186:5415` / `1186:5477` and caption `1117:1740`); 01.5 carries the picture line under R8
  `1589:39166` / `1690:14706` / `1589:39294` (replaced `1173:4111` / `1173:4983` and caption
  `1174:5318`); the 08 section's flow instruction is `1589:13082` (replaced `1117:1706`, still
  ✅ Ready for dev). Drawing facts: 08.37 is drawn on the Changed row with its word overridden because the Added
  row holds one field; 08.41 says characters where the contract limit is bytes. Where the build and
  the drawings differ: the step line and the What Coach read rows take the catalog's own phrases
  (*read your program*, *wrote a proposal for one of your routines*) where 08.35 and 08.36 drew
  *read your routines* and *proposed a change*; 08.37 draws no receipt row, the build keeps it
  (brand foundations: always visible); 08.49 and 08.50 draw a *Changed a movement* card, which no
  ability can land (`update_exercise` is withheld, B-1), so the build's landed write is *Made a
  movement*; 08.41's line counts UTF-8 bytes under the word *characters*, and its field grows to five
  lines with the pasted draft where the board draws one; 08.44's reset day needs
  `budgetResetsAtMs` on the turn route's refusal, which the backend does not send yet, so the line
  ends at *this month* until it does, and the day follows the phone's locale (*Nov 1* in en_US).

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
  Task 17 native captures reproduce clipped *Routines* and *The log* labels in both appearances
  at 320 dp/200% text; the hierarchy retains their complete names. Evidence:
  `/private/tmp/windmill-android-task17/native2/02.7-no-routines-fab-large-dark.png` and
  `02.7-no-routines-fab-large-light.png`. Tracking: `android-gym-large-text-tab-label`.

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
  stays in code and on the wire. The approved Android Workout uses visual position dots and speaks
  *Movement 3 of 5* through accessibility; the count is not a visible pager label. The tab is
  *The log*, and Android uses it for both its tab and root title. Code still differs: Android
  *Exercise {i} / {n}* (`domain/LiveSession.kt:134`), *Rename movement*,
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
