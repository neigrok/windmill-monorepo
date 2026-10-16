# Design consistency

Open disagreements between written canon, drawings and code. Remove an entry when its fix lands;
current behavior belongs in its owning contract. Source checks establish code shape, not rendered
acceptance. Figma review tasks below need a fresh file inspection before editing.

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
- **F40 / F52 / F54 · Figma components.** Give shared Buttons room-scoped brand bindings;
  rename Room Switch Button text layers by role; add sheet-radius tokens where needed.
  Shared component typography and mixed prose/numeral runs must not be flattened into one Gym style.
- **F5 / 1w · Unused glow.** Audit the Gym library's Daylight `glow/set-done` values and remove
  unused bindings. Daylight web has no set-done glow.

### Sync engine

Spec: [Windmill sync engine](../foundation/engine.md), built in the server and the web, iOS and
Android clients; every gym and journal surface writes through it. Canon states the owner's rulings
of 2026-09-26 on its lifecycle; the entries below are where an app still differs from them.

- **7a · Leaving the app.** Canon (`gym/briefs/13-gestures.md` "Leaving the app"; owner ruling
  2026-09-26): a held delete is stored on the device. Leaving the app — Android to the background,
  the last iOS scene to the background, on the web no Windmill tab visible past a short debounce or
  the last tab closing — lets it go into the queue, which sends it when it can, and Undo is not
  offered on return. A screen recreated in place keeps the Undo with its remaining time; sign-in lets
  holds go before its question, and a discarded room's go with it unsent; a hold cut off by the
  process dying is let go on the next start. The web's engine-held deletes follow this: the engine
  stores and releases them, and the gym room draws their Undo from the engine's offers
  (`useTrainingLog.js`). These holds still go the other way, putting the row back and sending
  nothing: the web's Coach conversation delete, a REST call held in the gym room's memory, when the
  document hides or the room unmounts; iOS's withheld Coach deletes when the scene goes to the
  background (`CoachHistory.swift`); and Android's holds, which are in memory, on `ON_STOP` and on
  disposal (`GymRoom.kt`, `abandonWithheld`).
- **7c · Sign-out.** Canon (`guidelines/superapp-flow.md` §3 and §7, `roadmap/guidelines/auth.md`
  §4, `roadmap/guidelines/front-door.md` §2; owner ruling 2026-09-26): signing out takes the
  account's synced data off the device. When the account has not confirmed some changes, the
  confirmation states how many and offers **Keep** (hidden on the device, sent at the same
  account's next sign-in) or **Discard** (destructive, from this device only), and Where to
  start?'s signed-out line has a kept-changes variant.
  - The copy must stay within what the engine can guarantee. The count is ready plus sent entries,
    and a sent change may already be in the account, which Discard cannot recall; so the alert
    says *haven't been confirmed* and *discard them from this phone*, never *for good*.
  - Android signs out from the You sheet with no confirmation (`YouSheet.kt`).
  - The web asks for journal and gym with the count, Keep and Discard (`SyncDecisions.jsx`), but on
    sign-out or any change of account it wipes the account's roadmap trees from the browser,
    unsynced edits included, with no warning: `accountChange.js` calls each product's
    `forgetDevice`, and the roadmap's (`routes.js`) runs `forgetDeviceTrees` (`localTrees.js`),
    which deletes every account-stamped registry row, sync blob and per-tree store.
  - Figma: board [16c](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=152-2661) draws only the base alert and needs the unconfirmed-changes variant;
    board [16d](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=152-2780) needs the kept-changes line; the first-run READ ME (`128:1151`) still
    lists sign-out with unsent changes as open question 6; the Android *Account / Profile* board
    ([`669:8214`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/?node-id=669-8214)) draws no confirmation. The web's confirmation is not drawn.
- **7d · Signing in with local data.** Canon (`guidelines/superapp-flow.md` §6 "Signing in with work
  already on the phone", `roadmap/guidelines/auth.md` §4, `gym/android-delivery.md`; owner ruling
  2026-09-26): work made signed in belongs to that account and syncs without asking. Work made signed
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
  - Figma: the Gym board *Account · Sign-in and connections* (`678:11123`) draws the claim row
    *Unclaimed log* (`678:11183`, These are mine / Not mine) and its *Local log removed* Undo
    (`678:11192`), which the sign-in question replaces; the Android *Account / Sign in* board
    ([`669:8237`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/?node-id=669-8237)) says *What you made on this device joins your account when you sign
    in.*, true only for an account with no gym records; the first-run READ ME line `174:4274` says
    signed-out work *moves to the account on sign-in* with no question. No surface draws the sign-in
    question or its Discard confirmation.
- **7f · Notes stored verbatim.** `gym/briefs/10-notes.md` stores a note's title and body
  *verbatim* but bounds them *after trim*; the domain kit's example (`../foundation/domain-kit.md`)
  trims and NFC-normalises before saving. Rule whether a saved note is normalised.
- **7g · Notes account-only.** `10-notes.md` makes notes account-only (signed out, Notes is a
  sign-in door); `../foundation/mobile/gym_coach.md` Appendix C gives `save_note` `seats: any`, so a
  signed-out Coach turn could write one. Rule which holds.
- **7h · A weigh-in's day written again on iOS.** `gym/briefs/11-bodyweight.md` names the one seam
  on the web and Android that retires a held delete's Undo when the lifter writes that day again.
  The iOS app saves a weigh-in as a domain draft (`BodyweightScreen.swift` `logSaveWeighIn`), and
  the brief names no iOS seam; the engine keeps the newer save over the held delete either way. Rule
  what iOS's Undo offer does when the day is written again, and name its seam in the brief.
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
  failing instead. Confirm one storage sentence for both products. `gym/briefs/11-bodyweight.md`
  still says the web's weigh-in delete reaches the log and pins *That weigh-in wasn’t deleted. Try
  again in a moment.*; the web holds that delete on the device like the phones, and says *That
  weigh-in wasn’t deleted — this device couldn’t store it.* when its store fails. The same brief has
  the web's window come down before a day written again goes in; the web's save retires the held
  delete in its own write.
- **7k · A guard read beside a write.** `../foundation/domain-kit.md` §8.3 rule 2 refuses a plan in
  which two operations name one record. Android's kit counts a `guardRead` among them (`Plans.kt`);
  iOS's counts only writing operations (`Translation.swift`), and the iOS gym relies on it: saving a
  workout's deviation guards the routine's `revision` with a `guardRead` and updates the same
  routine in one plan (`SaveWorkoutDeviation`, `WorkoutState.swift`). Rule whether a guard read may
  accompany a write to its record, then align the kit spec and both kits. Owner: domain kit.

### Durable draft adoption on native clients

The owner ruling in domain-kit C.2 and engine §7.10 requires device-only drafts to participate in
sign-in and keeps distinct colliding writing recoverable. Web and the reference implement that
contract. Native lifecycle follow-ups remain: iOS `SyncReplica/Lifecycle.swift` gates adoption on
outbox entries and keeps the destination row on a device-key collision; Android
`sync/engine/Lifecycle.kt` counts device work but also keeps the destination row on collision.
Their owners need collision-safe transfer or a refusal that preserves both replicas. These are
source-review findings; native sign-in behavior has not been exercised in the web journal gate.

### Sign-in doors

Canon: `guidelines/account-linking.md` and the Figma section
[4b · Apple sign-in · one account](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=194-3698).
Apple sign-in is off in every build, so no surface draws it yet.

- **8b · The fork-guard footnote.** Canon and boards 14, 02b and 16a carry no footnote;
  `AccountSheet.swift` `authDoors` still draws *Signed up with email before? Use email, so it stays
  one account.* Remove it in the change that ships 23a, never before: until then it is the only
  guard.
- **8c · The link door in AUTH.md.** `backend/AUTH.md` ("The resolution ladder", "The link door")
  says the app offers `/v1/auth/link` on `created && privateEmail`. No client implements it, and
  the condition misses an Apple ID that shares a different real address. Canon asks on every
  create and carries an Apple ticket through the code door instead (account-linking §8). Owner:
  backend — restate AUTH.md when the ticket lands.
- **8d · Apple's revoke notification.** `backend/AUTH.md` (Native surface notes) says Apple's
  `REVOKE` server-to-server notification unbinds a door; nothing in `backend/` receives it or
  unbinds an identity. Build it or cut the line. Owner: backend.
- **8e · "Expired" for a typo.** Canon (account-linking §4, `roadmap/guidelines/auth.md` §7)
  answers a wrong, expired or used code with *That code didn't work* · *Check the digits, or send a
  fresh one.* `AuthApi.cpp` answers *That code has expired* · *Codes work once and last 15
  minutes.*, pinned by `AuthApiTest.cpp`; Android `Auth.kt` `expiredCode` keeps its own *expired*
  sentence; iOS `NativeAuth.exchange` shows *Can't complete sign-in right now* for every refusal,
  a wrong code included.
- **8f · How you sign in, everywhere.** Canon (account-linking §5–6): every surface lists the
  account's doors, which `GET /v1/me` returns as `signInMethods` and iOS You lists under **How you
  sign in**. Web `ProfileSection.jsx` reads *Magic link to {email}* and *Continue with Google —
  coming soon.* while `SignInDialog.jsx` already offers Continue with Google; Android `YouSheet.kt`
  lists no doors.
- **8g · Web Google forks the same way.** On the web, a Google address that differs from the
  account's creates a second account with no question. Decide whether Continue with Google asks
  *Already on Windmill?* too (account-linking §8, optional 3).
- **8h · The room in the sign-in question.** Canon (`guidelines/superapp-flow.md` §6) asks one
  room at a time: *Add to your account?* · *2 workouts · 1 routine from before you signed in are
  only on this phone, and your account already has training. Add them, or discard them for good.*
  iOS asks Journal, then Gym, and prefixes the room to the message: *Gym · 2 workouts · 1 routine
  from before you signed in …* (`AppModel.swift`, `adoptionAlertMessage`). `account-linking.md` §2
  and board 23d show a journal question only. Rule whether a question names its room when one
  sign-in asks two, then align canon, boards and the app.

## iOS

`apps/ios/App` carries the Journal room and the Gym room on the engine, with the workout Live
Activity. First-run canon: `guidelines/superapp-shell.md`, `guidelines/superapp-flow.md`,
`gym/briefs/09-coach.md` and the Figma page
[iOS · First run](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=112-2). The
rendering contract is [`ios/ios-redesign.md`](ios/ios-redesign.md).

- **6v · Briefs that cite the deleted app.** Several gym briefs state the previous native app's
  code or behavior as current. Restate each as the rebuilt room's requirement or drop it:
  `gym/briefs/09-coach.md` (`Proposal.swift`, `Ask.swift`, `ReviewGate`), `10-notes.md`
  (`.onMove`), `11-bodyweight.md` (the iOS sheet, chart, empty-window, refusal and
  `TrainingStore.weighIn` paragraphs), `13-gestures.md` (full swipe), `15-the-routine.md` (History
  and routine detail), `17-set-targets.md`, `19-connected-log.md` (`ConnectInvite`),
  `12-native-idiom.md` and `guidelines/superapp-shell.md` §8 (F4, 4j), and
  `gym/feedback-contract.md` (iOS acceptance).
- **6k · Backend: signed-out Coach.** Coach is account-only: `AskRation` keys an in-memory token
  bucket by account (`kAskPerDay` 10, `kAskBackToBack` 3; a deploy refills it) under the account's
  30-day AI ceiling. Signed-out Coach needs a device-scoped identity, a durable 5-per-phone count
  that never refills, its own refusal reason, and a decision on what Coach reads for a phone whose
  log is not on the server. [Gym Coach on the client](../foundation/mobile/gym_coach.md) specifies all four.
- **6l · Backend: signed-out routines.** Coach creates routines on the server for an account.
  Signed out they must land on the phone with a stable, retry-safe identity and be adopted once on
  sign-in under the sign-in rule (7d), without duplicates.
- **6m · Backend: signed-out photos.** A sent photo is kept in private storage with the account's
  conversation. Signed out it must be sent inline for Coach to read and not persisted server-side;
  the phone keeps the only copy.
- **6n · Backend: the conversation on sign-in.** A signed-out conversation must move to the account
  on sign-in with the same identity, receipts included, so the chat continues where it stopped.
- **6o · First-run boards against the gym briefs.** Boards 13a/13b title the finish receipt with
  the routine name; `ios/ios-redesign.md` §7.9 rules the title *Well done.* / *Ended early.* with
  the routine name as the subtitle. Board 02d labels the Routines primary *Start logging* where
  `gym/briefs/12-native-idiom.md` uses *Just start logging*. Redraw 13a/13b and 02d.
- **6w · Keyboard bars on iOS 26.** On iOS 26 a SwiftUI `.keyboard` toolbar, once shown, leaves
  later sheets' keyboard avoidance 82 pt short: after the routine targets' bar, the weigh-in sheet
  drew *Save weight* under the decimal pad. The spec draws no keyboard toolbar: Coach's *Done* is a
  glass circle above the composer (`ios/ios-redesign.md` §7.3), the note editor has none, and
  Targets commits from its bar. The app draws *Next* and *Done* as `KeyboardBar` in the bottom inset
  while a field is focused (routine targets, the Coach note); align those two sheets.

### iOS redesign

Spec: [`ios/ios-redesign.md`](ios/ios-redesign.md) (iteration 3). It rules the iOS rendering;
these are the places it disagrees with a drawing, a brief or the build.

- **9a · Light gym accent.** The Gym file's `brand/base` aliases to iris `#4C4374` in Daylight
  (F44); the spec, the owner's 2026-09-06 ruling and the decided onboarding boards use verdigris
  `#137A6C`. The iOS boards bind a file-local `ios/accent`. Repoint `brand/base` or keep both and
  say which surface each serves.
- **iOS gym and shell day contrast (owner decision).** As text, `gym/accent` Daylight `#137A6C`
  measures 4.24:1 on `gym/canvas` `#EBE7E3`, 4.84:1 on `gym/card` `#F8F6F4` and 3.76:1 on
  `gym/raised` `#DFDAD5`, and it is text over the canvas in nearly every Gym screen: *Finish*, *Ask
  Coach* on the Review canvas, *Clear note*, the selected tab's label, the ladder keys on raised.
  `shell/brand` light `#BC6C42` measures 3.60:1 on `shell/canvas` `#F9F5EB` and 3.92:1 on
  `shell/card` `#FFFFFF` (the same 3.92:1 for a white label on it), so it fails even on a card: *Done*
  on every You and Keep sheet, *Use email instead*, *Change*, *Resend code in 0:28*, *Get the update*
  and the clay refusal on *Finish signing in*. Recommendation: `gym/accent` `#106B5F` (5.19:1
  canvas · 5.92:1 card · 4.60:1 raised · white on it 6.38:1), with the light `accent-soft` tracking
  it, and `shell/brand` `#9F5B38` (4.79:1 canvas · 5.21:1 card · 5.04:1 raised · 4.42:1 sunken, where
  no text sits). Dark values and both roles' meanings stay; adopting them closes 9a's accessibility
  half, not its Figma-alias half. The owner rules; the spec and the build keep the current values
  until then. On adoption the Figma colour collections follow: the Gym file's `ios/accent` and
  `ios/accent-soft` (`1055:201`–`1055:202`) and the Design System's `shell/brand`.
- **9b · Phones weave.** `gym/briefs/18-progress.md` gives web and iOS the movement strip and
  Android the woven moments; the spec gives both phones the woven timeline and only the web the
  strip. The brief now says so; the Progress section's iOS strip boards (`459:29`, `531:532`)
  are superseded.
- **9c · The rack's kind picker.** `16-the-workout.md` kept iOS's kind picker at the rack; the
  spec moves Kind off the rack into the Fix sheet on iOS, and a new set is Working, as on web and
  Android. The brief now says so. Android's Fix sheet has no Kind control: `FixSheet.kt` carries a
  set's kind through unchanged.
- **9d · Two gym light grounds.** Design System `iOS First Run · Colour` has `gym/canvas` light
  `#F4F4EB` and `gym/card` `#F9FDFC`; `Onboarding · Colour` and the Gym file have `#EBE7E3` and
  `#F8F6F4`, which the spec adopts. Align the first-run collection.
- **9e · First-run boards' chrome.** The first-run and Coach-wave boards draw a *W* capsule, a
  hand-drawn glass fill and a drawn account glyph; the spec's room menu and `person.crop.circle`
  on system glass replace them. Redraw the top band of boards 02d, 05–07d, 08a–09k, 10–13b, 21a/21b
  and the Gym file's Coach-wave iOS boards from the new section's bar anatomy.
- **9h · Journal day inks.** `iOS First Run · Colour` light `journal/ink` `#2A2118`, `ink-dim`
  `#74654F`, `ink-faint` `#8E8272` are warm; the web's journal day (`palettes.css`), the spec and
  the app's onboarding glimpse are cool paper (`#161E28` / `#4E5968` / `#5E6979`). Align the
  collection.
- **9i · The proposal card.** `gym/briefs/09-coach.md` ("One · the turn") gives a phone card its
  summary, its counted changes on their own line and **Review**, says iOS's card shows no diff rows,
  and keeps the promise on the card while pending; ("Two · the review") a closed review leaves the
  card reading *still waiting*, and the sheet heads its quote with *Coach wrote:*. The spec (§6)
  draws no summary on the card (the answer above is the reasoning), up to three change rows and
  *+ N more* as Android's skim does, a door *Review changes* with no count, no caption while pending
  and *Applied* / *Turned down* once settled, and no kicker: the sheet's subtitle names the source.
  Restate the brief for both phones.
- **9j · The Review band's slots.** `09-coach.md` ("Two · the review") holds the gate's refusal
  and the atomic promise as two slots, the promise always drawn; the spec (§6) gives the band one
  caption slot that reads the gate sentence until the diff is seen and the promise after, so Apply
  never moves and the band never says two things. Restate the brief; the Android band keeps the
  brief's shape until its owner decides.
- **9k · Where a signed-out workout waits.** The spec (§7.16) puts the account's untaken workout in
  one **On this phone** row at the head of The log — a door to a pushed list from two workouts — with
  the Log tab's system badge as the one door from other tabs; Android draws a card in Settings and a
  *Saved workouts need review (N)* door on every tab (`android-delivery.md`). The Gym Figma boards
  draw neither. Decide whether Android adopts the log row; draw the row, the pushed list, the
  Inspect screen and the Fix sheet.
- **9l · Live Activity labels.** `gym/briefs/14-live-activity.md` lists the workout clock and the
  since-last-set clock without ruling labels; the iteration-1 build labels both (*Workout*, *Since
  last set*), which `16-the-workout.md` bans in the app. The spec (§7.7) draws both unlabelled.
  Restate the brief and draw the banner, expanded and compact Island.
- **9m · Iteration-1 boards.** The Gym file's *iOS redesign · iteration 1* boards (`1055:204`)
  predate the spec's §5–§7: the composer's disabled state, the one-slot Review band and the diff as
  rows, the body-less proposal card, the current row's readout, the Record tiles and axis labels,
  moments as doors, *Weigh in* in The log's bar, Bodyweight rows, the Fix sheet's subtitle and bar
  commit, the glass transient band, You's native sections, **On this phone**, the update-required
  alert and the Live Activity. Redraw from the spec, or retitle the section as superseded.
- **9n · The set-note footer.** The iteration-1 Fix sheet drew *A record for you — not an
  instruction to Coach.* under the set note; `09-coach.md` rules the set-note field says nothing,
  and the spec (§7.10) draws no footer. Check the Android Fix sheet for the same line.
- **9o · Moments are doors on iOS.** `18-progress.md` has Android expand a moment in place to its
  compact chart and *Open record*; the spec (§7.6) makes every iOS moment a row that navigates — a
  best moment opens the Record with its session's point selected, a weigh-in moment opens
  Bodyweight, a month moment opens nothing — so no expander shares a list with navigation chevrons.
  The brief states both. The iOS build still expands a moment in a `DisclosureGroup`
  (`LogTab.swift`). Decide whether Android follows.
- **9p · A record stated once.** The spec (§7.6) states a record by its moment, or by a
  `gym/record` dot after a session's name when the one-a-week cap leaves it without one; a session
  row's second line is always its facts, and a movement's first logged session sets no record.
  Android states a record twice — the row's second line *Record · Bench Press 84 × 5*
  (`LogReadout.kt`) and the woven *new best* moment — and the iOS build draws both
  (`LogPresentation.swift`). Decide whether Android follows, and rule the first-session case for
  every surface.
- **9q · Weigh in is a bar action on iOS.** `18-progress.md` keeps one control in Android's reach
  band, the weigh-in chip; the spec (§4, §7.6) and the iOS build put *Weigh in* in The log's bar
  (`scalemass`, before the account button) and float nothing over the list, since a floating control
  over rows that end in dates and chevrons always covers one. The brief states both. Decide whether
  Android follows.
- **9r · No Gym settings on iOS.** The spec (§6) draws no Gym settings page: Notes and Connected
  log are reached from Coach's More, and a hidden workout from the **Hidden** row at the head of The
  log.
  `guidelines/superapp-shell.md` §5–6 has You list each room's settings, and Android's You carries
  *Gym settings* and *Connected log* (`GymRoom.kt`). `gym/briefs/10-notes.md` and
  `19-connected-log.md` now give iOS Coach's More as the one door and keep settings as Android's
  second; `10-notes.md` still calls Coach's door a row, where iOS's is a More item. The iOS build
  still draws a Gym settings page, opened from You onto the Routines tab (`GymRoom.swift`). Decide
  whether Android and the shell canon follow.
- **9s · Notes' lines.** `10-notes.md` heads Notes with *Any agent you connect can read these too.*
  and, under it, *what you write for Coach*, a line it calls load-bearing, and puts *Top note wins.*
  on screen for the order. The spec (§6) draws the first line only and lets the drag handle in Edit
  carry the order; Android pins *Top note wins.* (`Notes.kt`). Rule whether both lines hold on every
  surface.
- **9t · Connected log with a connection.** On Android (`19-connected-log.md`, `android-delivery.md`)
  the level rows and the caption stay on screen in both states, **How this works** opens in place,
  and a *Manage connections* row joins once something is connected. On iOS (spec §6, which the brief
  now states) a connected screen leads with **Connected**, each row opening the shell's connection
  settings, puts the level rows, the caption and the five lines behind one **How this works** door
  row, and draws no *Manage connections*; with nothing connected the level rows and caption are on
  screen and **How this works** is the same door. Decide whether Android follows.
- **9u · Dates in the person's locale.** The spec (§3) formats every Gym and shell date in the
  person's locale through one formatter (*Sep 23*, *Wed, Sep 23*); the briefs pin day-first strings
  for every surface — `18-progress.md` (*heaviest 120 × 5 · 28 Aug*, *no session · 7 Jul – 4 Aug*,
  the scrub readout's *3 Sep*), `19-connected-log.md` (*since 12 Aug*) — and the domain kit's
  `Readout.briefDay` orders *26 Sep* by hand. Rule whether shared readouts follow the locale on
  every surface or iOS keeps its own forms, then align the briefs' pinned strings.
- **9v · Signed-out sharing.** The spec (§7.8) makes Share this workout's primary a sign-in door,
  *Sign in to share*, signed out or paused. Android draws *Share this workout* on session detail and
  in every Log row's menu whatever the account state, and its sheet offers *Get a link* / *Try
  again* with no sign-in door (`SessionScreen.kt`, `LogScreen.kt`, `WorkoutSharing.kt`). No brief
  rules signed-out sharing. Rule it in `16-the-workout.md` and align Android.
- **9w · You's sections.** `guidelines/superapp-shell.md` §6 gives signed-out You *Not signed in ·
  Everything lives on this phone*, each room's settings and **Erase data**, and signed-in You the
  name and how they signed in, **Your data** (Backup with its state, On the web) and **Delete
  account**. The spec (§7.11) gives the identity row one status line (*Not signed in* · *Backed up*
  · …), draws no **Your data** and no room settings, and has neither **Erase data** nor **Delete
  account**, which no iOS build draws. Decide whether the shell canon follows the spec; if the owner
  wants *Erase data* and *Delete account* on iOS, they are build work for the dogfood tree.
- **9x · The room menu.** `guidelines/superapp-shell.md` §3 rules that the room menu carries rooms
  only — *You is never a row*, no item of a room's own — and describes iOS as one room, Journal
  alone. The spec (§4) and the build draw the rooms, then **You** after a divider, then Journal's
  **Show ink notes**. The Design System's `_Room capsule` disagrees with itself: the set's
  description (`226:4315`) says rooms only and *iOS today: Journal alone*; the `Menu=On` and
  `Menu=Off` descriptions (`117:52`, `226:4310`) say *Journal · Gym · You*. Rule one menu, then
  align the shell canon and the component descriptions, and check boards 21a/21b.
- **9y · Progress strings in the iOS build.** `18-progress.md` pins the window line *last 12 weeks ·
  9 sessions* / *the whole series · 23 sessions* and the month moment *Trained 4 of the last 4
  weeks*, and the spec follows it. The iOS build draws *Last 12 weeks · N sessions* and *All · N
  sessions* (`MovementRecordScreen.swift`, pinned by `GymLogFlowTests.testMovementRecordWindows`)
  and *Trained 4 of 4 weeks* (`LogTab.swift`). Align the build.
- **10a · The Undo band's words.** The spec (§5 Confirmations, §7.6) has every Undo band name the
  object and the act: *Workout discarded*, *Weigh-in deleted*, *Set deleted*, *Conversation
  deleted*. The build names what went only for a hold it keeps outside the engine (a saved workout's
  discard, a Coach conversation); the engine's Undo offers read *Change deleted* / *N changes
  deleted* (`GymTransient.swift`, `Message.undo`), as after a workout discarded from session detail.
  Give each offer its noun.
- **10b · The newest weigh-in woven.** The spec (§7.6) and `18-progress.md`'s iOS paragraph weave a
  weigh-in moment only once a newer weigh-in exists, since the newest is the head's *Bodyweight*
  row. The build weaves every weigh-in up to today, the newest included (`LogPresentation.swift`),
  so the latest weight reads twice, in the head and in a moment. Align the build.
- **10c · Your data in You.** The spec (§7.11) draws no **Your data** section and gives the
  identity row one status line (*Backed up* · *Not backed up yet* · …). The build still draws **Your
  data** and the line *Signed in with email* (`AccountSheet.swift`, `identityState`). Align the
  build; 9w holds the shell canon's own **Your data**.
- **10d · Two search shapes in the pickers.** The iteration-3 ruling (spec §7.5): the builder's *Add
  movement* searches from a field in the list's first row, a plain native row; *Next movement* and
  *Movements* use `.searchable`. The builder pushes Create movement inside its own sheet, and the
  phase-2 consolidation's probe on iOS 26.5 found `.searchable` there either swallows the pushed
  bar's ✓ or, when the search is ended first, shows only its placeholder after Create movement's
  Cancel while the query still holds its text — against `15-the-routine.md`, which preserves the
  query on Cancel. This differs from that brief's "native search on phones" and from one search
  shape for every picker. Revisit when the system's search keeps its text across a pushed step.
- **10e · The Gym door's line.** The build draws the *Where to start?* Gym door as *Log sets · see
  last time* (`WindmillApp.swift`), and no written canon pins the line; the rack draws no *Last
  time* line (spec §7.7), so the door promises what the room does not show. The spec (§7.12) rules
  *Log today's sets*, beside the Journal door's *Write tonight's page*. Align the build, and check the
  first-run *Where to start?* boards for the old line.
- **Proposal · the open workout as a tab-bar accessory (owner decision).** While a session is open,
  both phones draw the logger over every other screen (`16-the-workout.md`, `09-coach.md`). On
  iOS 26, `tabViewBottomAccessory` is the native slot for something running (Music's mini player):
  *Lower A · 32:10 · Set 3*, tap to return, so a lifter could glance at The log mid-workout without
  leaving the app. It changes canon — `09-coach.md` says no review is reachable mid-workout and Coach
  is refused there — so it waits on the owner and is not in the spec. A narrower use changes no
  canon: the accessory only while the lifter has hidden the workout, as the restore door the spec's
  **Hidden** row (§7.6) is today, with the row staying on iOS 18.
- **Proposal · Controls and App Intents (owner decision).** An iOS 18 `ControlWidget` for Control
  Center, the Lock Screen and the Action button: *Start workout* when none is open, *Log set* while
  one is — the intent the Live Activity's button already runs (`WorkoutLogSetIntent`) — with the
  prefilled set (*100 × 5*) as the control's value, so nothing logs that the lifter has not seen.
  Siri phrases (*Log 100 for 5*) would let the room's most frequent act need no drawn control. It
  waits on the owner and is not in the spec.

## Onboarding

Brief: `guidelines/onboarding.md`; drawings: Design System page
[Onboarding · 2026-10-04](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=209-2). The
four-screen introduction was decided on 2026-10-04 — direction A · Three rooms, iOS page 4 leads to
Where to start?, About Windmill in You and the account sheet, and the four screens are the accepted
exception to `guidelines/superapp-flow.md` §3 and §8. Both phones draw it (`Onboarding.swift`,
`OnboardingPager.kt`).

- **9a · Platform lines.** The Marketing superapp landing boards (`98:2538`) print *Web · iOS* for
  journal and *Web · iOS · Android* for gym; the shipped `landing.root.platforms` in each product's
  `routes.js` reads *Web* and *Web · Android*, and the onboarding's per-phone tags follow the code.
  Redraw the boards from the code, or change the code when the iOS app ships.
- **9c · The roadmap glimpse.** `_Glimpse / Roadmap` (`210:2`) fans the sail tree from the root to
  the right, like the landing boards; the product renders radially (0k). The glimpse is an
  illustration, not a layout specimen; if it is ever drawn from the product, draw it from a live
  screenshot.
- **9d · Gym day accent on the boards.** The onboarding light boards use verdigris `#137A6C` for gym
  (owner ruling 2026-09-06) where Android's `GymSkin.kt` ships iris `#4C4374` by day (F44). The
  boards follow the ruling; the skin follows when F44 closes.
- **9e · About Windmill is written, not drawn.** `guidelines/superapp-shell.md` §6 and
  `gym/android-delivery.md` Profile list the **About Windmill** row; the iOS You boards (first-run
  section *4 · Account*, `120:81`) and the Android Profile sheet (`669:8214`, `678:10634`) do not draw
  it. Add the row to both drawings.
- **9f · The gym glimpse draws a rack neither phone has.** `onboarding.md` §4's page-4 fixture
  (*Squat · set 3 of 5 · … Set 3 · target 100 × 5 · … Last time · 97.5 kg × 5 · Set 3 logged ·
  Log set*) and `_Glimpse / Gym` (`210:56`) draw a slot target, a *Last time* line and the mono face,
  and both phones' glimpses draw that fixture (`OnboardingGlimpses.swift`, `OnboardingGlimpses.kt`).
  The iOS rack has none of the three (`16-the-workout.md`, `ios/ios-redesign.md` §7.7), and the spec
  (§7.12) has the iOS glimpse draw the current rack: name, the ledger with its current row, the
  numeral, *Log set*. Redraw the fixture and the component from the current racks — one shared, or
  one per phone — and align both glimpses.
- **9g · Where each product lives.** `onboarding.md` §4's tag table gives the iOS app Journal *In
  this app* and Gym *On the web and Android*, and says the iOS app is the journal. The iOS app
  carries the gym room and tags both rooms *In this app* (`Onboarding.swift`); Android tags Journal
  *On the web* and Gym *In this app* (`gym/src/main/res/values/onboarding.xml`). Restate the table,
  and decide whether Android's tags name the iPhone, in the release that moves gym.

## Roadmap

- **1e · Available-node treatment.** `tree-layout-contract.md` and the DOM specimen specify a
  card-coloured available node; `NodeBatch.js` paints available and complete with saturated fills,
  distinguishing complete with a halo. Choose one treatment and align shader, specimen and canon.
- **1f · Gallery columns.** `responsive.md` specifies at most two columns; `BrowsePage.jsx`
  adds a third at 1180px. Reconcile the breakpoint table, gallery rules and implementation.
- **1g · Touch reorder.** `mobile.md` calls arrange desktop-only; `angular-reorder.md` specifies
  touch behavior. Set one interaction rule and update both documents.
- **F20 · Unstyled classes.** Audit `.st-list-bud`, `.st-list-jump-chip` and `.st-action-lane`
  against their stylesheet consumers; remove empty hooks that have no styling or test role.
- **F32 · Quest roster icons.** An optional `node.icon` can leave an empty reserved glyph well.
  Give the roster a fallback or remove the unused well.
- **F50 · Marketing silhouettes.** The app uses bubble layout; `marketing/treeScenes.js` and
  the Marketing drawings use authored radial compositions. Redraw the marketing scenes in bubble
  while preserving their names, progress states and unlock ceremony. Engine output alone does not
  define the marketing framing. Gallery portraits and minimap use the live canvas positions.
- **Readability evaluation.** Measure sustained large-tree edits on a real GPU and review
  cross-branch visibility and the visitor's whole-tree entry. Layout runs synchronously; the
  deterministic tuck budget does not guarantee interactive latency. The checked-in capture rig
  uses SwiftShader and cannot establish production frame timing.

## Journal

- **iOS journal first run · R117.** AX3 keeps the longer privacy fact and scales in a scrollable page.

- **Mood and energy entry.** [Input alternatives](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=176-837)
  compare quiet rails, a folded picker and a number ribbon. The folded picker is the recommendation,
  pending entry-frequency and focus/caret checks. Preserve independent optional integers 0–10,
  null versus zero, Clear, keyboard-up suppression and 44px targets; update `journal.md` and
  `scales.md` together only when a replacement is chosen.

- **F22 · Landing accent.** `marketing/landingHead.js` still uses `#C29A4E`; the live day
  accent is `#986B1E`. Align the crawlable shell and verify CTA contrast.
- **F28 · Echo layout drawings.** Above the margin breakpoint, the echo form is margin-only.
  Boards showing an in-page desktop form must state a width where that form can appear.
- **Echo drawings · included passages.** [Caption 33:426](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=33-426)
  still describes a cut passage, withheld words and a free path. `journal.md` §6 requires full
  passages for everyone, without AI credits or a paywall; notes `34:294` and `43:360` agree.
  Reconcile the caption and the free-path labels on the phone echo boards `31:211` and `33:327`.
- **iOS Journal daylight.** The journal room answers light with the spec's Day column
  (`ios/ios-redesign.md` §2): the canvas, source pages, the echo ink and the reader. Its lamp is
  `#90651C` (4.82:1 on `#F7F7F5`); the web's day lamp `#986B1E` (`palettes.css`) measures 4.39:1 on
  the same paper, under the 4.5:1 text floor. Move the web and the Figma Day collection to `#90651C`.
- **The one fact over the scales.** `journal/onboarding.md` pins *Only you. No prompts, no fields,
  nothing to fill in — write a line or a page.*; on iOS the canvas draws it above the mood and
  energy scales (`ios/ios-redesign.md` §7.13), so *no fields* reads against two fields. Copy owner:
  reword it (*nothing you have to fill in*) or keep it.
- **F34 · Type roles.** Reconcile the journal's unassigned first-run, talk, verdict, nudge,
  week-count and narrow scale styles with the named type ramp.
- **F36 · Phone tools.** Check the fixed `.journal-tools` rail against the writing measure at
  narrow widths; reserve space or move the rail so it cannot cover text.
- **1i · Month navigation.** The web uses an in-flow `MonthDivider`; `journal.md` still describes
  a floating month pill and desktop month rail. Decide whether to specify those controls or align
  the canon to the divider.
- **1j · Today's glyphs.** Web `DayMarker` draws no glyphs for today; `journal/scales.md` still
  names a difference from iOS, which has no journal room (6v). Decide whether today draws glyphs,
  a breathing mood pip, on any surface. The motion budget is at most one infinite loop, not a
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

### Set kind · product direction

Web and Android entry/correction omit Kind. New sets use Working; corrections preserve stored
classification. Historical warmups remain readable and do not consume planned working-set numbers.
Targets are references: actual weight/reps remain independent for every set, including extra or
skipped sets and substituted movements.

### Open concepts

- **Strength tree.** Determine whether a gym-to-roadmap handoff helps lifters following a written
  program. Before designing screens, choose authorship, an evidence-based unlock rule and the
  smallest useful surface; “not yet” remains valid. Any integration must preserve product
  independence and must not introduce XP, levels, badges or streaks into gym. Tracking: `strength-tree`.

### Coach on the client

Spec: [Gym Coach on the client](../foundation/mobile/gym_coach.md). The brief `gym/briefs/09-coach.md` disagrees with
it in these places.

- **6p · Android signed-out Coach.** The brief keeps Android Coach account-only and lists Android's
  signed-out Coach as open. The owner decided on 2026-09-26 that Android carries it. Draw Android's
  signed-out room and allowance line. Until Play Integrity device recall is enabled, the Android
  allowance is per install, so Android copy cannot say *per phone*.
- **6q · One agent rule per ability.** The brief never lets Coach log, fix or delete a set, finish
  or discard a workout, or write a bodyweight. MCP runs `start_session`, `log_set`, `log_sets`,
  `finish_session`, `discard_session` and `import_session`. The spec gives each ability one agent
  rule for both doors and withholds these until the brief sets them (its Appendix B-1).
- **6r · Where a signed-out photo goes.** The brief says a signed-out photo is *stored only on the
  phone; the server keeps no copy*. A copy goes to the model vendor to read, under the vendor's
  retention terms. The copy must say so, with the terms verified at release.
- **6s · Pasted programs.** The brief leaves open whether a pasted program may exceed the
  1,000-byte question limit. The spec sets 8,000 bytes. Confirm the limit and its refusal sentence.
- **6t · States the room does not draw.** The spec adds a `declined` answer (the model refused), a
  truncated completed answer, a phone whose attestation fails (`coach-device-unverified`), and an
  iPhone whose allowance was spent on an earlier install (`coach-device-spent`). The brief draws
  none of them.

### Native and web differences

- **Coach Markdown.** Android renders answer Markdown blocks and paces streamed text; web
  `CoachRoom.jsx` renders plain text. Decide the shared block typography and pacing, then align the
  other clients and Figma specimens. Tracking: `gym-android-coach-stream-markdown`.
- **Workout display names.** The API's optional `routineName` changes a corrected workout's
  display name independently of its frozen plan. Native session readers need to prefer it,
  including an explicitly empty name for a free session.
- **F38 · Target entry.** Web uses the ladder as its count; native entry retains Sets. Decide
  whether that difference is intentional. [Android alternatives](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=815-5196)
  compare grouped steppers, copy-down, wheels, typed schemes, recalled schemes and sliders.
  Recalled schemes backed by grouped steppers are the design recommendation; the current create
  sheet uses grouped steppers. Preserve `TargetBlock(scheme, onChange)` until device tests cover
  varied reps/loads, keyboard, focus and TalkBack.
- **4k · Leaving drafts.** Reconcile the unsaved-routine exit policy across web and Android.
  Cover native Back, Cancel, navigation away and restored drafts before choosing confirmation rules.
- **4u · Delete scope.** Define whether a held session deletion also filters movement ranking,
  records and finish reads elsewhere in the room. Undo visibility and stored-count validation are
  already separate concerns under `gym/briefs/13-gestures.md`.
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

- **Connected-log write disclosure.** `GymToolCatalog.cpp` exposes append-only `save_note` at
  `gym:write`, but Android's ConnectedLog Write copy omits saving Notes. Add this capability to the
  disclosure under `gym/briefs/19-connected-log.md`; do not imply existing notes can be edited.

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
- **9z · *Session* and *workout*.** Both nouns name one thing on screen: *No sessions yet*, *First
  session*, *28 sessions*, *This session* and *Free session* beside *Start workout*, *Discard
  workout*, *Hide workout* and *Fix workout*. The canon uses both (`gym/briefs/20-past-workout.md`,
  `gym/android-delivery.md`). Rule one noun, or when each is used, for every surface. Owner: copy.

### Figma reconciliation

- **F53 · Retired boards.** Archive or remove Today/Ask generations on the Gym `Boards` page
  (`6:3`, `9:42`, `25:23`) so they cannot be mistaken for current delivery.
- **5x · Logger masters.** Promote the quiet-ledger shape to canonical Android logger frames
  (`659:7175`, `660:7955`); remove the after-log Undo from proposal frame `805:4536` because logging
  is corrected from its set row. Preserve delete Undo.
- **F35 / 2c / 2f / 2k · Fixtures.** Reconcile old board calendars, reproducible e1RM values,
  performed-set ordinals, Notes counters near their threshold, abbreviated dates and the Coach name.
  Use the current fixture maps in `gym/web-build-contract.md` and `gym/android-delivery.md`.
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
