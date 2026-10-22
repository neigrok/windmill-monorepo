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
- **F52 / F54 · Figma components.** Rename Room Switch Button text layers by role;
  add sheet-radius tokens where needed.
  Shared component typography and mixed prose/numeral runs must not be flattened into one Gym style.
- **F5 / 1w · Unused glow.** Audit the Gym library's Daylight `glow/set-done` values and remove
  unused bindings. Daylight web has no set-done glow.

### Sync engine

Spec: [Windmill sync engine](../foundation/engine.md), built in the server and the web, iOS and
Android clients; every gym and journal surface writes through it. Canon states the owner's rulings
of 2026-09-26 on its lifecycle; the entries below are where an app still differs from them.

- **7a · Leaving the app.** Canon (`gym/briefs/13-gestures.md` "Leaving the app"; owner ruling
  2026-09-26): a held delete is stored on the device. Leaving the app — Android to the background,
  on the web no Windmill tab visible past a short debounce or
  the last tab closing — lets it go into the queue, which sends it when it can, and Undo is not
  offered on return. A screen recreated in place keeps the Undo with its remaining time; sign-in lets
  holds go before its question, and a discarded room's go with it unsent; a hold cut off by the
  process dying is let go on the next start. The web's engine-held deletes follow this: the engine
  stores and releases them, and the gym room draws their Undo from the engine's offers
  (`useTrainingLog.js`). These holds still go the other way, putting the row back and sending
  nothing: the web's Coach conversation delete, a REST call held in the gym room's memory, when the
  document hides or the room unmounts; Android's holds, which are in memory, on `ON_STOP` and on
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
  - Figma: board [16c](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-2031) draws only the base alert and needs the unconfirmed-changes variant;
    board [16d](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-2085) needs the kept-changes line; the first-run READ ME (`2:984`) still
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
    in.*, true only for an account with no gym records; the first-run READ ME line `2:1029` says
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
[4b · Apple sign-in · one account](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-2878).
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
`gym/briefs/09-coach.md` and the Figma pages
[Shell · iOS](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=1-5) for shared
first-run and account boards, and
[Gym · iOS](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-2)
for the canonical Coach-led flow. The rendering contract is [`ios/ios-redesign.md`](ios/ios-redesign.md).

- **6v · Briefs that cite the deleted app.** Several gym briefs state the previous native app's
  code or behavior as current. Restate each as the rebuilt room's requirement or drop it:
  `gym/briefs/09-coach.md` (`Proposal.swift`, `Ask.swift`, `ReviewGate`), `10-notes.md`
  (`.onMove`), `11-bodyweight.md` (the iOS sheet, chart, empty-window, refusal and
  `TrainingStore.weighIn` paragraphs), `13-gestures.md` (full swipe), `15-the-routine.md` (History
  and routine detail), `17-set-targets.md`, `19-connected-log.md` (`ConnectInvite`),
  `12-native-idiom.md` and `guidelines/superapp-shell.md` §8 (F4, 4j), and
  `gym/feedback-contract.md` (iOS acceptance).
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
  Roadmap · AI requests · Proposal still need the current policy. The written pricing, shell,
  Coach, roadmap and Journal contracts use USD. Replace remaining drawing question/credit
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

- **9a · Light gym accent.** Android's Daylight skin still uses iris `#4C4374` (F44),
  while its onboarding glimpse uses verdigris `#137A6C`. Figma's shared Gym light brand is
  `#137A6C`; its native `ios/gym/accent` is the spec's darker `#106B5F`. Align Android's
  skin and glimpse with its intended platform accent.
- **iOS gym and shell day contrast.** The spec and the iOS build use the light values the owner
  adopted for text: `gym/accent` `#106B5F` (5.19:1 on `gym/canvas` · 5.92:1 card · 4.60:1 raised ·
  white on it 6.38:1), with `accent-soft` tracking it, and `shell/brand` `#9F5B38` (4.79:1 on
  `shell/canvas` · 5.21:1 card · 5.04:1 raised). Darkening clay brought it within ΔE2000 6 of the
  brick `shell/danger` `#A84E35`, so on You *Done* and *Sign out* read as one colour; the spec (§2)
  moves `shell/danger` to a red brick, `#A62B2B` light (6.43:1 on `shell/canvas`) and `#F2685A`
  dark, ΔE2000 14.8 and 15.3 from clay. `gym/alarm` keeps `#A84E35`: no clay sits in the gym
  room. The other surfaces keep the earlier values:
  Android's onboarding glimpses draw the gym accent `#137A6C` (`OnboardingGlimpses.kt`,
  `OnboardingPager.kt`), and the web's clay and roadmap `--color-brand` is `#BC6C42`
  (`--accent-terracotta-500`). Figma Theme roles `ios/gym/accent`, `ios/gym/accent-soft`,
  `ios/shell/brand` and `ios/shell/danger` use the iOS values.
- **9b · Phones weave.** `gym/briefs/18-progress.md` gives web and iOS the movement strip and
  Android the woven moments; the spec gives both phones the woven timeline and only the web the
  strip. The brief now says so.
- **9c · Sets have no type (build drift).** The owner removed set types from the product; canon and
  the Gym boards state none. The shared gym vectors and the iOS, Android and web domains count every
  set as a working set and read a stored `kind` only to ignore it. Still carrying a kind:
  Android's app layer (`SetKind`, the `FixSheet.kt` and Settings kind pickers, the warm-up rows and
  counts in `LiveSession.kt` and `Training.kt`), whose kind no longer reaches the log; the web, whose
  new-set rows carry a dead `kind: 'working'` (`WorkoutEditor.jsx`, `backfill/draft.js`) that the
  domain's imported and corrected sets drop before the wire, and which draws the share page's kinds
  and a warm-up set on the gym landing (`GymLanding.jsx`); and the backend, whose reads
  count working sets only (`PgLogRepository.cpp`, `PgLogHistory.cpp`, `Review.cpp`: REST, MCP
  `gym_get_stats` and last time, the Coach's context) and whose MCP `gym_log_set` and Coach prompt
  still offer warm-up, drop and failure. An old row of another kind so counts on every client and
  not on the server. Build work: remove it on Android, the web and the backend.
- **9e · First-run boards' chrome.** The first-run and Coach-wave boards draw a *W* capsule, a
  hand-drawn glass fill and a drawn account glyph; the spec's room menu and `person.crop.circle`
  on system glass replace them. Redraw the top band of boards 02d, 05–07d, 10–13b and 21a/21b from
  the new section's bar anatomy.
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
- **9m · Iteration-1 boards outside the Gym page.** The Gym iOS page was redrawn to the spec on
  2026-10-22 (10o). Iteration-1 drawings of You's native sections and the update-required alert
  predate §5–§7; redraw them from the spec.
- **9n · The set-note footer.** `09-coach.md` rules the set-note field says nothing, and the spec
  (§7.10) draws no footer. Check the Android Fix sheet for an *A record for you — not an
  instruction to Coach.* line.
- **9o · Moments are doors on iOS.** `18-progress.md` has Android expand a moment in place to its
  compact chart and *Open record*; the spec (§7.6) makes every iOS moment a row that navigates — a
  best moment opens the Record with its session's point marked, a weigh-in moment opens
  Bodyweight, a month moment opens nothing — so no expander shares a list with navigation chevrons.
  The brief states both. Decide whether Android follows.
- **9p · A record stated once, and what counts as one.** The spec (§7.6) states a record by its
  moment, or by a `gym/record` dot after a session's name when the one-a-week cap leaves it without
  one; a session row's second line is always its facts. Android states a record twice — the row's
  second line *Record · Bench Press 84 × 5* (`LogReadout.kt`) and the woven *new best* moment.
  Decide whether Android follows. What counts as a new best is ruled for every surface by the shared
  vectors (`packages/api-contract/gym/domain/training-reads.json`, `ProgressRecords`;
  `18-progress.md`, "A new best"): a movement's first estimate is its baseline, and a new best beats
  the best before it as the log states both, to 0.1 kg. Android drifts: `LogTimeline.kt` weaves a
  moment for every exact record step, the first estimate's included, and `CorpusTests.kt` holds
  `ProgressRecords` pending. Two iOS reads still compare exact estimates: the Record's **Earlier
  records** and *Best e1RM* walk `MovementProgress.records`, so a step the log does not call a new
  best can stand there at the same stated value as the best before it; and the receipt's *Personal
  record* is the server's (`Review.cpp` `recordFor`), which needs a prior estimate but compares
  exactly. Rule whether both follow the stated rule.
- **9q · Weigh in floats on iOS.** `18-progress.md` keeps one control in Android's reach band, the
  weigh-in chip; the spec (§4, §7.6) and the iOS build float *Weigh in* bottom-trailing as a labelled
  glass capsule (`scalemass` and *Weigh in* in the accent), with the list's bottom inset keeping the
  last row clear. The brief states both. Decide whether Android follows.
- **9r · No Gym settings on iOS.** The spec (§6) draws no Gym settings page: Notes and Connected
  log are reached from Coach's More, and a hidden workout from the tab bar's accessory on iOS 26
  and the **Hidden** row at the head of The log on iOS 18 (§7.18).
  `guidelines/superapp-shell.md` §5–6 has You list each room's settings, and Android's You carries
  *Gym settings* and *Connected log* (`GymRoom.kt`). `gym/briefs/10-notes.md` and
  `19-connected-log.md` now give iOS Coach's More as the one door and keep settings as Android's
  second; `10-notes.md` still calls Coach's door a row, where iOS's is a More item. Decide whether
  Android and the shell canon follow.
- **9s · Notes' lines.** `10-notes.md` heads Notes with *Agents you connect can also read these.*
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
- **9x · Shared room-menu drawings.** The iOS contract uses Journal and Gym only in the room
  menu, with account/settings reached once through the account button. Ink notes are onboarding
  only. Update the Design System's `_Room capsule` variant descriptions (`117:52`, `226:4310`)
  and boards 21a/21b to this contract; its set description (`226:4315`) must name both iOS rooms.
- **iOS native specimens.** The Gym iOS boards use editable Inter
  specimens because Figma's SF Pro export returns zero-width glyphs, and local icon vectors
  because importing the subscribed Apple iOS 26 library is denied. Native implementation uses
  system text and controls. Replace these specimen assets when the native library can be imported.
- **9y · The month moment.** `18-progress.md` words a month trained in full *Trained 4 of the last
  4 weeks*, the head's own sentence, so a past month's moment and the head's *Trained 3 of the last
  4 weeks* answer one question twice on one screen and disagree. The spec (§7.6) words the moment by
  its own month, *Trained every week of February*, and weaves it whatever the head reads. Restate
  the brief for both phones, and check Android's month moment against it.
- **10d · Two search shapes in the pickers.** The iteration-3 ruling (spec §7.5): the builder's *Add
  movement* searches from a field in the list's first row, a plain native row; *Next movement* and
  *Movements* use `.searchable`. The builder pushes Create movement inside its own sheet, and the
  phase-2 consolidation's probe on iOS 26.5 found `.searchable` there either swallows the pushed
  bar's ✓ or, when the search is ended first, shows only its placeholder after Create movement's
  Cancel while the query still holds its text — against `15-the-routine.md`, which preserves the
  query on Cancel. This differs from that brief's "native search on phones" and from one search
  shape for every picker. Revisit when the system's search keeps its text across a pushed step.
- **10e · The Gym door's line.** The spec (§7.12) and the build draw the *Where to start?* Gym door
  as *Log today's sets*, beside the Journal door's *Write tonight's page*, since the rack draws no
  *Last time* line (spec §7.7). Check the first-run *Where to start?* boards and redraw any door that
  promises *last time*.
- **10f · What Coach did, in iOS's words.** `09-coach.md` puts the phrase table's words in a step
  list behind the read receipt ("What the room does not print") and gives *save a useful insight* a
  truthful saved-note step ("The verbs"). iOS draws no step list (spec §6): the receipt row opens
  *What Coach read*, and the table's words stand where iOS says what Coach did — the receipt's *Read
  your movement history* for a totals-only read and *Read nothing from your log*, *Also read your
  notes.* under *What Coach read*, and one row per act, *Open routine · Push A* and *Saved a note* /
  *Could not confirm a note save*. The brief is right that a saved note is never silent; the
  iOS build was the stale side, drawing no saved-note line anywhere, and the spec now rules the row.
  The settled words differ too: the brief's return receipt reads *Applied · Push A · 4 changes*,
  *Applied · Push A · routine removed* and *Rejected · Push A.* ("Four · the return"); the web's
  `receiptLine` still says *Turned down* (10v); the iOS Review's band says the word alone — *Applied*,
  *Removed*, *Turned down* — since its title names the routine and its header the count, and the card,
  History and band share one table that adds *Out of date* for a superseded proposal, which no
  canon word covers. Restate the brief's step-list and phrase-table paragraphs for iOS (6v already
  holds its `Ask.swift` reference), and decide whether web and Android take *Removed* and *Out of
  date*.
- **10g · Backend: the read receipt's weeks.** The server's read receipt counts weeks no
  observation names: `GymTools.cpp` adds every week `get_stats` returns, empty ones included, and
  `ReadReceipt.cpp` each set's week. iOS counts weeks only from the workouts *What Coach read*
  lists and never prints `read.weeks`, so a totals-only answer reads *Read your movement history*
  with no number (spec §6); web and Android print the server's weeks (`coach.js` `readLine`,
  `Ask.kt`). The fix belongs to the backend: dogfood node `coach-receipt-weeks-provable`.
- **10o · The page is the target (owner decision, 2026-10-22).** The owner treats the Gym iOS page
  as the target: no board is 👀 Review. Boards that matched the app on the 2026-10-21/22 simulator
  pass (iPhone 17, iOS 26.5) stay 🚀; everything else is 🚧. Where a drawing lagged behind the app's
  iteration 2 and 3, it was redrawn to the spec first so no target asks for a regression: 00.1 top
  bar (no bar creation action), 00.3 transient band (no Undo; deletes are immediate), 01.10 summary
  sheet with Start, 02.1 Routines, 02.2 summary, 02.3 editor with ✓, 02.4 picker, 02.6 stepper
  Targets, 03.7 receipt, 03.8 Ended early as the same sheet, 03.9 Choose your first movement, 05.2
  round red Delete, 05.3 workout detail, 05.4 immediate delete, 05.6–05.8 Record, 06.2 Bodyweight,
  08.3 Review, 08.6 no title, 08.7, 09.1 Notes, 09.2 note sheet. Relabelled without a redraw: 00.2
  colour roles, 00.4 native anatomy (Discard is system red; no Theme token yet), 04.1 Control
  Center control, 04.3 Dynamic Island, 04.4 Live Activity states (clock labels removed). Still
  needing a device or a fixture, named in their captions: 04.1, 04.3, 04.4, 05.8's pan, 08.6, 08.7.
  The Live Activity double tap (`177:29`, 04.5) draws what the app does not do: verify on a device
  and either rule it in or retire the board.
  00.2 still labels the Daylight `gym/accent` and `gym/accent-soft` `#137A6C`, while Theme
  `ios/gym/accent` resolves to `#106B5F` in Light, as the spec (§2) and the build do; and it gives
  `gym/alarm` to destructive labels, which are the system red (spec §2). Relabel the board.
- **10p · Target boards ahead of the gym-feedback build.** The Gym file's iOS page draws the owner's
  2026-10-21 feedback as 🚧 targets (Dark, with a Daylight twin beneath), from
  `gym/feedback-2026-10-21.md`. Each target holds
  the slot and number of the board it replaced; the replaced boards are deleted. Targets:
  - 01 and 08: listed under 10q.
  - 02: editor always sortable 02.5 `1149:2200`; empty Routines with the floating + 02.7 `1149:2477`;
    remove by the trash circle 02.8 `1149:2275`.
  - 03: rack with Dumbbells 03.1 `1150:2352`; its states pressed 03.10 `1150:2495`, changed with 56 pt
    hit areas 03.11 `1150:2638`, Bodyweight with added load 03.12 `1150:2793`.
  - 04: Live Activity with since-last-set top right 04.2 `1152:2533`.
  - 05: The log with its labelled Weigh in 05.1 `1153:2765`; Edit exercise 05.9 `1153:2559`; the
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
    these; the spec now states them (§4 Buttons, §5 Lists, §7.5, §7.6, §7.7, §7.10).

  Choices the build forced or left open, for the owner:
  - The build's words win: *Equipment* (not *load basis*), *Dumbbells*, *Add screenshot*, *Sign in
    to continue.* The owner's later rulings replace two: *Build my own* (not *Build myself*) and
    **Apply** / **Reject** on drafts (not *Save routine(s)*) — build work in 10v.
  - The greeting's actions are drawn `.bordered` with the accent tint; the build uses `.borderless`.
  - The build adds a *Windmill One* button to a signed-in refusal, opening *Subscriptions aren't
    available yet.* `superapp-shell.md` keeps One in You only, so the interim board (a) draws no One
    entry; board (b) is the owner's paid upsell and must wait for checkout.
  - The set-editing haptic is a `.selection` tick per accepted rack change. The build keeps the
    canon's silence on Log set, which the boards keep.
  - The library has no SF stand-ins for `minus`, `line.3.horizontal`, `pencil`, `photo.badge.plus`,
    `chevron.up.chevron.down` and the two `figure.strengthtraining.*` symbols, nor a system-red
    token (`ios/system/alert` resolves to an alert ground). The boards draw local `sf/…` vectors.
    System red lives locally as `gym/destructive` in *iOS · Gym roles* (#FF453A dark, #FF3B30
    light), used by the swipe trash circle and *Delete set*; older destructive labels on the boards
    still paint `ios/gym/alarm`. Moving both into the library is a Design System change, which then
    needs a library publish from the Figma UI.
- **10q · Coach chat in the Messages language (owner decision, 2026-10-22).** The owner asked for
  the Coach chat to read like iOS Messages, drawn as 🚧 targets over every Coach chat board in
  journeys 01 and 08, with local components on the Gym Components page: `_Coach / Bubble`
  (`1167:185`: sender × tail × text, image, typing) and `_Coach / Composer · Messages` (`1168:212`:
  empty, typed, photo). Boards: 01.1 `1173:3783`, 01.2 `1173:3860`, 01.4 `1173:3934`,
  01.5 `1173:4111`, 01.6 `1173:4264`, 01.7 `1173:4370`, 01.8 `1173:4471`, 01.9 `1182:4650`,
  01.10 `1173:4600`, 01.11 `1173:4678`, 01.12 `1173:4754`, 01.13 `1173:4833`; 08.1 `1170:2943`,
  08.2 `1203:6633`, 08.3 `1203:6896`, 08.4 `1172:3561`, 08.5 `1172:3621`, 08.8 `1170:3105`, 08.9
  `1170:3192`, 08.10 `1170:3266`,
  08.11 `1170:3364`, 08.12–08.14 `1203:7214`, `1203:7452`, `1203:7628`. Owner rulings since:
  proposals and drafts are decided inline on their cards (no review sheet; `09-coach.md`, §6), and
  the greeting is two bubbles of anchored capabilities. Still open against written canon, for the
  owner to settle before the spec moves:
  - `ios/ios-redesign.md` §6: *Coach's turn is plain prose on the canvas, no bubble*. The targets put
    Coach in a left bubble with a tail, full width for headings, lists and tables.
  - §6: the lifter's bubble is `gym/accent-soft`, radius 18, max 78 %. The targets fill it with
    `gym/accent` and set it in `on-accent`, with a tail, grouped Messages-style.
  - §6: a sent photo is a 56 pt thumbnail under the text, *not a bubble-wide image*. The targets send
    it as a 200 pt image bubble.
  - §6: the composer is one capsule with `photo.badge.plus` inside and a send circle that only
    dims when empty, *never a different size, shape or colour*. The targets put a round + outside the
    field and show the send arrow only when there is something to send.
  - The typing bubble, centred service notes and timestamps are not in canon.
  - iOS builds the targets (bubbles, tails, timestamps, the typing bubble, Markdown in a full-width
    bubble, the round + and the send arrow that appears with text), so the §6 lines above disagree
    with the iOS app as well as the boards; Android and web still draw the §6 chat.
- **10s · Library swap (closed 2026-10-22).** The owner published the Design System additions; the Gym
  iOS and Components pages now use library symbols, the library keyboard (`delete.left`, and
  `Type=Decimal` on the weigh-in) and Theme `ios/system/red` for every destructive paint. The local
  `gym/destructive` variable is deleted.
- **10u · Three more symbols awaiting a publish.** `iOS / Symbol / ellipsis` (renamed from the
  library's private `_sf/ellipsis`), `list.bullet.rectangle` and `plus.circle.fill` are in the
  Design System file but not yet in a published library version: importing their keys from the Gym
  file still fails (checked 2026-10-22, second try). Until the owner publishes the library from the
  Figma UI, the Gym boards draw them as local `sf/…` frames;
  `.claude/scratch/gym-figma-targets/post-publish.js` swaps them afterwards.
- **10v · Coach's cards, words and change catalogue (owner rulings, 2026-10-22; build).** The owner
  ruled: proposals and drafts are decided with **Apply** and **Reject** (*Rejected*, never *Turned
  down*); Reject asks nothing; no promise, reassurance or restating lines; Coach's strings in simple
  English. The spec (§6 table), `09-coach.md`, `feedback-contract.md` and boards 01.1–01.15 and
  08.1–08.31 now say so. Build work, none of it in code today:
  - *Turn down* / *Turn this down* / *Turned down* and the confirm alert live on in Android
    `Proposal.kt` and its review actions and web `proposals.js` `receiptLine`; iOS says *Apply*,
    *Reject* and *Rejected* and asks nothing.
  - Drafts have Apply and Reject on one card on iOS (Reject drops them on the phone and leaves *Rejected · N
    routines*); Android and the web still offer only Save. The card's loads read *60 kg* and *22 kg each*, the
    proposals' words, where 01.7 draws *60 kg total* and *22 kg, one dumbbell*.
  - Block order: `09-coach.md` and 08.27 list a rename, moves, changes, removals, then additions; 08.2 and 08.3 draw
    Changed, Added, Removed, Changed, Moved. iOS follows the written order, so 08.2's first two blocks read Moved and
    Changed; 08.2/08.3 want redrawing in that order.
  - Field lines: 08.21 and 08.27 draw only the fields that change (*Push-up · Reps*, *Lateral Raise · Reps*), where
    `09-coach.md`, 08.2 and 08.3 draw a set's unchanged fields plain; iOS and the shared vectors follow the written
    rule. 08.21 also draws three blocks with no *Show all*, where the card's rule shows two, then *Show all 3 changes*.
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
    on iOS only; the signed-out *Sign in* answer for a change request (08.31) is built nowhere.
  - `ios/ios-redesign.md` §7.5 has a removal the log refused read *Out of date* on its Routines row, but the card that row
    opens is not out of date: it reads *Not applied.* with **Try again**. iOS's row reads *Not applied*, as does a
    waiting change's row once the log refused its Apply; §7.5 and task 11's settled words want *Not applied* added.
  - Strings in code still carry the cut and pre-simple-English copy: *Your sets stay saved…* (iOS
    `WorkoutSheets.swift`), *You decide the numbers at the rack.* (iOS, Android `Program.kt`, web
    `routines.js`), and on Android `Ask.kt` and web `coach.js` *Coach reads your log, so it needs you
    signed in.*, *Coach isn’t part of this Windmill…* and *The next question frees up…*. iOS Coach's
    greeting, access states, allowance refusal and photo captions now read as 01.1–01.11 and 08.6–08.8, but for the
    departures below.
  - iOS departs from a board where the board's words claim more than the build can keep; the boards want redrawing:
    - 01.5: a signed-in drafted photo is captioned *Sent to Coach. Saved only in this chat.*, where the board draws
      *Saved only in this chat.* alone.
- **10r · Swipe delete is the native trash circle (owner ruling, 2026-10-22).** Everywhere in gym a
  trailing swipe slides the row and reveals a round red trash circle with no text label (spec §5
  Lists), drawn with the local component `_Gym / Swipe actions` (`1190:172`). iOS draws it with one
  shared modifier, `TrashSwipe` (`Gym/Components/GymRows.swift`), on the Routines list, Targets'
  per-set rows, The log, workout detail sets, Bodyweight entries, Notes, Coach History and the
  routine editor's movements (02.8 `1149:2275`) and This workout's movements (03.4 `1135:1875`), both
  lists out of edit mode that draw their own handles and drag on a long press. A one-line row draws
  the system's capsule rather than a circle (05.4's set row).

  Deletes outside swipes keep their native form: context-menu *Delete routine*, *Delete set*,
  *Delete conversation*, *Discard workout*; the editor's *Delete routine*; the sheets' *Delete set*,
  *Delete weigh-in*, *Delete note*; Inspect's *Discard workout*; the receipt's quiet *Discard*,
  which is the receipt's band action, not a swipe.
- **10x · The log's boards ahead of other canon (build, 2026-10-22).** The iOS build follows the
  🚧 targets (10o), and other canon still says otherwise in these places:
  - Workout detail's tiles share one card parted by hairlines (05.3), and the one session
    constructor draws them so on Inspect too, where 07.2 draws one card without hairlines; the
    receipt sets each tile on its own card, as 03.7 draws them. Settle one form for 05.3 and 07.2.
  - Record (05.6–05.8) and Bodyweight's chart draw dots only, no segment between them, where
    `briefs/11-bodyweight.md` and `briefs/18-progress.md` still join dots within the gap threshold.
    The Record draws no *Most reps* tile, no Recent sets and no estimates footer;
    `android-delivery.md`'s Movement record still keeps recent sets.
  - Edit exercise (05.10) draws Bodyweight third in the Equipment menu; the build lists it last, as
    Create movement does (Barbell, Dumbbells, Machine, Cable, Kettlebell, Bodyweight), from the one
    `MovementEquipment.choices`. Its basis help is the one `MovementEquipment.help`, so Edit
    exercise, Targets and Create movement read the same words.
  - Weigh in (06.1): on a phone the keyboard lifts the `.medium` sheet to the top, where the board
    draws it at its detent.
  - Notes (09.1, 09.2): a row and the editor are the note's one text, where `briefs/10-notes.md` keeps
    a title and a body. The domain still stores both (ios-redesign §7.10 Notes has the rule), so a
    long first line reaches other surfaces as a cut title over the whole text, and Coach's `save_note`
    and the rules are unchanged.
- **Proposal · one suggestion on an empty Coach (owner decision).** Outside first-use setup, the
  spec (§6) and `gym/feedback-contract.md` draw an empty Coach as the bar, canvas and composer. The
  proposal: while no conversation exists, at most one `.glass` capsule above the composer, chosen
  from the lifter's state and never from capability copy — *Build me a routine* with no routines,
  *How did today go?* after a workout today. A tap fills the composer without sending, and the
  capsule leaves with the first message. It waits on the owner and is not in the spec.

## Onboarding

Brief: `guidelines/onboarding.md`; drawings: Shell iOS section
[Shell · iOS onboarding](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-9719). The
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
- **9d · Gym day accent on Android.** Android's Daylight skin ships iris `#4C4374`
  (F44); its onboarding glimpse uses verdigris `#137A6C`. The Figma Android boards use
  light `color/brand` `#137A6C`; iOS uses `ios/gym/accent` `#106B5F`. Align Android's glimpse and skin
  with the intended Android accent and identify any intentional platform difference.
- **9e · About Windmill is written, not drawn.** `guidelines/superapp-shell.md` §6 and
  `gym/android-delivery.md` Profile list the **About Windmill** row; the iOS You boards (first-run
  section *4 · Account*, `2:1867`) and the Android Profile sheet (`669:8214`, `678:10634`) do not draw
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
- **9h · The text leads at accessibility sizes.** `onboarding.md` §7 shrinks the glimpse to 260 pt
  at AX sizes above the text and lets the page scroll. On iOS the spec (`ios/ios-redesign.md` §7.12)
  puts the text block first at the accessibility sizes, in the reading order §7 already gives, with
  the glimpse after it at 260 pt, so a page opens on its title and body; at the standard sizes the
  glimpse keeps the lead and shrinks to a 220 pt floor before any page scrolls; and a page that
  scrolls fades its bottom edge under the dots. Restate §7 for both phones, and check Android at
  font scale 2.0 on a device for the same cut.

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

- **Mood and energy entry.** [Input alternatives](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=204-1159)
  compare quiet rails, a folded picker and a number ribbon. The folded picker is the recommendation,
  pending entry-frequency and focus/caret checks. Preserve independent optional integers 0–10,
  null versus zero, Clear, keyboard-up suppression and 44px targets; update `journal.md` and
  `scales.md` together only when a replacement is chosen.

- **F22 · Landing accent.** `marketing/landingHead.js` still uses `#C29A4E`; the live day
  accent is `#986B1E`. Align the crawlable shell and verify CTA contrast.
- **F28 · Echo layout drawings.** Above the margin breakpoint, the echo form is margin-only.
  Boards showing an in-page desktop form must state a width where that form can appear.
- **Echo drawings · included passages.** [Caption 33:426](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=33-426)
  still describes a cut passage, withheld words and a free path. `journal.md` §6 requires complete
  existing passages for everyone, with no new AI cost to read them or subscription paywall.
  Reconcile the caption and the free-path labels on the phone echo boards `31:211` and `33:327`.
- **Echo allowance drawings.** Journal and account drawing specimens must distinguish complete
  readable Echo passages from the cost of creating new ones, as the written Journal and pricing
  contracts require. All hosted background AI debits the individual USD allowance; new work waits
  when its applicable capacity is unavailable. Remove drawing claims that automatic Echoes never
  consume allowance. Existing passages are not cropped or withheld to pressure an upgrade.
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

### Sets · product direction

Sets have no type on any surface. Targets are references: actual weight/reps remain independent for every set, including extra or
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
  signed-out room and lifetime USD allowance line. The approved launch identity is a server-issued
  installation credential with IP and global budgets. Android delivery remains separate from iOS
  onboarding; the identity does not guarantee protection against installation resets.
- **6q · One agent rule per ability.** The brief never lets Coach log, fix or delete a set, finish
  or discard a workout, or write a bodyweight. MCP runs `start_session`, `log_set`, `log_sets`,
  `finish_session`, `discard_session` and `import_session`. The spec gives each ability one agent
  rule for both doors and withholds these until the brief sets them (its Appendix B-1).
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
  cannot promise that provider spending stopped. The brief defines these recoveries, but the
  drawings do not cover their full matrix.

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
- **9z · *Session* and *workout*.** Ruled for iOS (owner, 2026-10-16): every iOS screen says
  *workout*, and *session* stays in code and on the wire (`ios/ios-redesign.md` §3, *Workout, never
  session*, whose table holds each string); the iOS build says *workout* on every screen. Web and
  Android copy must follow: both still put the two nouns side by side — Android's *Free session*,
  *No sessions yet*, *First session* and *This session* beside *Workout saved* (`LoggerScreen.kt`,
  `LogScreen.kt`, `AssemblySheet.kt`, `FinishScreen.kt`), the web's *No sessions yet.*, *no session
  · …* and Coach's *… sessions* receipt beside *N workouts* (`Log.jsx`, `progress.js`, `coach.js`,
  `DateJump.jsx`) — and the canon pins *session* strings for every surface
  (`gym/briefs/18-progress.md`'s window line and gap label, `gym/briefs/20-past-workout.md`,
  `gym/android-delivery.md`). Restate the briefs and align both surfaces. Owner: copy.

### Figma reconciliation

- **Coach setup chrome.** The tab bar component draws Routines as `list.bullet.clipboard`; the app
  uses `list.bullet.rectangle`, which joins the library with 10u. Short conversations start at the
  top in the targets; the app keeps them bottom-aligned.
- **Coach creation-row typography.** The app's receipt rows are the shared iOS `GymRow`: semibold
  body routine name and subheadline metadata. Target 01.9 (`1173:4471`) draws them with the library
  `iOS / List row`; compare the type treatment when the build lands.
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
