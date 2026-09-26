# Design consistency

Open disagreements between written canon, drawings and code. Remove an entry when its fix lands;
current behavior belongs in its owning contract. Source checks establish code shape, not rendered
acceptance. Figma review tasks below need a fresh file inspection before editing.

## Shared system

- **F4 · Gym Daylight PR ink.** Web and the [approved specimen](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=874-7735)
  use gold-700 `#6E5217`; Android `GymSkin.kt` still uses `#A17822`. Align Android and check native
  PR rows. iOS defines only the Instrument gym palette; a Daylight palette must use gold-700.
- **F7 / F29 · Mono weights.** `web/src/styles/fonts.js` loads JetBrains Mono 400/500/600.
  Gym and journal CSS request heavier mono weights. Normalize the uses or supply the faces.
- **F8 · Unused numeral tokens.** `gymTokens.css` declares `--weight-size`, `--weight-leading`
  and `--reps-size`; no web rule consumes them. Remove them or give them a real consumer.
- **4j · Text scaling.** iOS `WindmillFont` uses fixed-size `.system(size:)` fonts. Define and
  implement Dynamic Type behavior, and check web text resizing across the gym's pixel-sized type.
- **Published clay tokens.** Reconcile Design System `surface/card` dark mode with web's
  `#171719`. The recorded published value is `#17120B` (`VariableID:1:66`, key
  `f5e7a675adcd56fc6c985da0c7d8341fca46caac`). Gym's local `shell/clay/*` aliases must remain
  until shared imports resolve consistently. Verify `border/subtle` and `text/tertiary` imports too.
- **F40 / F52 / F54 · Figma components.** Give shared Buttons room-scoped brand bindings;
  rename Room Switch Button text layers by role; add sheet-radius tokens where needed.
  Shared component typography and mixed prose/numeral runs must not be flattened into one Gym style.
- **F5 / 1w · Unused glow.** Audit the Gym library's Daylight `glow/set-done` values and remove
  unused bindings. Daylight web has no set-done glow.

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

- **F22 · Landing accent.** `marketing/landingHead.js` still uses `#C29A4E`; the live day
  accent is `#986B1E`. Align the crawlable shell and verify CTA contrast.
- **F28 · Echo layout drawings.** Above the margin breakpoint, the echo form is margin-only.
  Boards showing an in-page desktop form must state a width where that form can appear.
- **F34 · Type roles.** Reconcile the journal's unassigned first-run, talk, verdict, nudge,
  week-count and narrow scale styles with the named type ramp.
- **F36 · Phone tools.** Check the fixed `.journal-tools` rail against the writing measure at
  narrow widths; reserve space or move the rail so it cannot cover text.
- **1i · Month navigation.** The web uses an in-flow `MonthDivider`; `journal.md` still describes
  a floating month pill and desktop month rail. Decide whether to specify those controls or align
  the canon to the divider.
- **1j · Today's glyphs.** Web `DayMarker` omits today's glyphs while iOS `DayGlyphs` draws a
  breathing mood pip. Choose whether this platform difference should remain. The motion budget is
  at most one infinite loop, not a requirement to add one.
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

### Native and web differences

- **5m · iOS logger.** Android uses the [quiet ledger](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=805-4536)
  defined in `gym/briefs/16-the-workout.md`; iOS `LoggerScreen.swift` retains its horizontal slot
  strip and last-time line. Translate the current logger into native iOS controls.
- **Coach Markdown.** Android renders answer Markdown blocks and paces streamed text; web
  `CoachRoom.jsx` and iOS `AskScreen.swift` render plain text. Decide the shared block typography
  and pacing, then align the other clients and Figma specimens. Tracking: `gym-android-coach-stream-markdown`.
- **Workout display names.** The API's optional `routineName` changes a corrected workout's
  display name independently of its frozen plan. Native session readers need to prefer it,
  including an explicitly empty name for a free session.
- **F38 · Target count.** Web uses the ladder as its count; native target entry retains Sets.
  Decide whether the difference is intentional. Android target-entry alternatives remain in
  `gym/android-cleanliness-options.md`; preserve the shared `TargetBlock` contract until chosen.
- **4k · Leaving drafts.** Reconcile the unsaved-routine exit policy across web, iOS and Android.
  Cover native Back, Cancel, navigation away and restored drafts before choosing confirmation rules.
- **4u · Delete scope.** Define whether a held session deletion also filters movement ranking,
  records and finish reads elsewhere in the room. Undo visibility and stored-count validation are
  already separate concerns under `gym/briefs/13-gestures.md`.
- **3s · iOS bottom band.** Coordinate the routine Start refusal, room status and Undo transient
  so concurrent messages cannot hide a reachable action.
- **4v · Browser failure.** Android `ConnectedLogScreen.kt` swallows `openUri` errors; iOS
  `GymRoom.swift` opens the URL without a completion handler. Show a recovery when a browser cannot open.
- **Native acceptance.** Keep API 26, notification promotion-disabled fallback, full TalkBack
  traversal and review-gate transitions in the Android acceptance matrix. Existing source or
  representative captures do not establish the full device matrix.
- **Narrow tab label.** Routines has a recorded clipping defect at 320dp/200% text in dark mode:
  the visible label loses its final “s”, while the accessible name remains complete. Fix the
  layout without reducing text scale or target size and verify both themes.
  Tracking: `android-gym-large-text-tab-label`.

### Copy and review decisions

- **Connected-log write disclosure.** `GymToolCatalog.cpp` exposes append-only `save_note` at
  `gym:write`, but native ConnectedLog Write copy omits saving Notes. Add this capability to both
  native disclosures under `gym/briefs/19-connected-log.md`; do not imply existing notes can be edited.

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
- **3w · Sign-out residue.** Audit device-local gym state on account change against explicit local
  ownership and recovery; a design cleanup must not silently choose a data-deletion policy.

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
  Tracking: `gym-web-navigation-parity-deferred`. Board status IDs remain in `gym/web-build-contract.md`.

## Marketing and email

- **0g / 0h · Landing colour rules.** Clarify whether several product-skin windows are allowed
  and whether a roadmap kind may use brick when brick is excluded from landing chrome.
- **0i · Brand-root anatomy.** Reconcile the common landing roles with the root's product-band
  layout, including a useful loop, truthful limitations and the role of static scenes.
- **0m · First paint.** `appBoot.js` does not reset the browser's body margin before the main
  stylesheet arrives. Check and remove the resulting landing layout shift.
- **F23 / F24 · Email templates.** `magic-link-fork.html` lacks the light-only CSS rule used by
  the other templates. `magic-link-signup.html` uses double-brace URL interpolation while the
  other templates use raw triple braces. Reconcile both with the email contract.
- **F25 · Changelog.** The public changelog contains only July entries. Keep its material-change
  record consistent with the commitment in Terms.
- **F27 · Nudge template.** `ResendNudgeSender.cpp` references `journal-nudge`, but no template
  is checked into `web/emails/`. Recover and version its source before editing its copy.
