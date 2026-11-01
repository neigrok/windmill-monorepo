# Design brief: Android quality wave

For the designer. Each item below is a screen or state the quality wave (tasks 73–105) cannot build until a board exists and the owner approves it as **✅ Ready for dev**. Some items are questions for the owner first. Developers never build a visual change from this brief alone. When a board is ready, set its status and link it in the task file's **Figma** line.

Files: Gym `vdmdiKWrmZoS1FtcvJRf6O`, Android page `56:2`; Shell `tkI7GnS6TcZvQSDi9lwrBf`, Android page `1:6`. Android numbers follow ledger 11r: no number names two screens across the phone pages. Draw every board in Dark and Daylight, and at 320 dp / 200 % text where the state can overflow.

## Boards a task waits for

| Item | Screen or state | Open question | Task |
|---|---|---|---|
| QW1 | Workout page, a movement with no plan | On a free workout, each movement heading keeps its 48 dp target with no line under the name, so a blank gap sits where 05.3b draws *Plan 3 × 8 · 75 kg total* (ledger 11u). What does a planless heading look like? Does it keep the gap, collapse, or say something? | [102](102-planless-movement-heading.md) |
| QW2 | Coach, an answer whose proposal is still arriving | Coach can answer before its proposal reaches the phone. Today nothing is drawn in the card's place for up to about 10 s, then either the card or *This proposal is no longer available.* (ledger 11w). Draw the waiting state, and say what it reads. Coach's action cards stay frozen otherwise. | [103](103-proposal-still-arriving.md) |
| QW3 | Record page before the account's first pull | The page lists the days this phone holds under *Recent sets* while the phone may hold only part of the history (ledger 11u). Does the heading stay, change (for example *On this phone*), or go until the pull lands? | [104](104-record-before-the-first-pull.md) |
| QW4 | Workout page and logger, the quiet set count | Owner questions from 2026-11-01: (a) do the live logger's ledger rows keep *Set 1*, *Set 2*, or take the quiet count? (b) does Android take iOS's stronger marker colour? (c) is Daylight's tertiary strong enough for the count? Designer: (d) at 200 % a two-digit count widens its 24 dp column and pushes that row's load inward; no board draws it. | [105](105-quiet-set-count-follow-ups.md), [87](87-large-text-everywhere.md) |
| QW5 | *On this phone*, a saved copy that partly reached the server | When one set id is already on the server (`id-taken`, `session-id-taken`, `id-spent`), the only action is Discard, which throws away the sets that never landed. Draw a "keep the rest" action and its outcome, on both phones. | [80](80-keep-the-rest-of-a-partly-landed-copy.md) |
| QW6 | Every board that shows a machine's load | The owner ruled on 2026-11-01 that a machine reads plain *kg* on every surface; a barbell keeps *kg total*. Update the boards that draw a machine as *kg total* (rack, Fix set, routine summary, receipt, workout page), and ledger 11e. | [81](81-machine-reads-kg.md) |
| QW7 | Web live mirror, planned rows | The phones read the load the rack will offer (*22.5 kg total × max*, *— × max* while unread), as 03.34 draws. The web mirror still reads *last × max*. Confirm the web board reads the offered load. | [94](94-web-planned-rows-offered-load.md) |
| QW8 | iOS receipt, what was lifted | Android's receipt reads every set as a range (*3 × 6–8 · 75–80*); the iOS receipt reads the top set only. Draw the iOS receipt's range. | [96](96-shared-performed-range.md) |
| QW9 | Coach during a workout, on Android | iOS answers mid-workout and applies workout proposals (`docs/design/ios/workout-in-flight.md`). Android refuses. Draw where Coach opens from the logger, the workout proposal card, Apply, and what the rack shows after. | [98](98-coach-during-a-workout.md) |
| QW10 | *What Coach read* with no workouts listed | Once the server counts only provable weeks, an answer that read only statistics has no number. iOS reads *Read your movement history*. Confirm the Android row's wording for that case. | [97](97-coach-read-receipt-weeks.md) |
| QW11 | 00.2 and 00.4, destructive actions | Confirm that these boards are ✅ Ready for dev, so the log row's *Discard workout*, the receipt's *Discard* and History's *Delete* can move to the error role (ledger 11c). | [99](99-destructive-actions-in-red.md) |
| QW12 | Any screen that overflows at 320 dp / 200 % | Task 87 sweeps every screen at large text and will add entries here for each state no board settles. Known so far: the routine editor's Target summary overlap (postponed by the owner on 2026-10-29; the proposal `1675:10931` stays unapproved until the owner reopens it). | [87](87-large-text-everywhere.md) |
| QW13 | Proposal review sheet, a load change | Owner question: the sheet writes *30kg → 32.5kg* with no space, against every other readout (ledger 11v). Is a unit space outside the freeze on Coach's action appearance? No drawing is needed if so. | [100](100-proposal-diff-unit-space.md) |

## Drawings with no build waiting

The app already behaves as described. These items bring the canon in line with it, or settle a question before anyone builds.

| Item | Screen or state | Open question |
|---|---|---|
| QW14 | The log's foot when the first pull fails | Android shows **Retry** · *That read failed.* when the first pull fails or none can run (task 72). The 05.18 caption names it, but no board draws it (ledger 11u). |
| QW15 | Receipt, *Ended early.* | Owner question: every surface says *Ended early.* below four sets, so a completed 1 × 12 plan is told it ended early. The proposal is *Ended early.* only when fewer sets were logged than planned, and *Well done.* for a free workout (tree `gym-receipt-ended-early-honesty`). |
| QW16 | Native wave B drift (ledger 11v) | The scrolled top bar's two-tone seam (00.1 draws no scrolled state). Receipt actions at 56 dp against 03.36's 72 dp. The navigation pill at 64 × 28 dp against 00.7's 56 × 32. The rack's ±5 load chips against 03.34's ±10, and its text ✓ against a check icon. Dialog width and the Daylight scrim. For each: does the board or the build move? |
| QW17 | You, after a confirmed closure | D4's state: the subtitle under *You* still reads *Deletion unconfirmed* while confirmed closure waits for cleanup (ledger 11t). Draw the subtitle for that state. |
| QW18 | Routine editor follow-ups from 02.20 | 02.3, 02.5 and the other editor boards still draw the label above the Name field, where 02.20 and the build use the outlined floating label. Confirm the blank-name wording (*This routine won't be saved.*). Word the saved-routine case (*<Name> won't be saved.* although only the edits are lost). Reconcile Save muted on a named draft, and the 16 dp margins with mono target lines (ledger 11s). |
| QW19 | Loads crossing zero | Owner question: at 0 kg the ladder steps silently into assisted load for every loading except barbell and paired dumbbells (tree `gym-zero-snap`). Should a step that crosses zero land on zero, and what should the assisted side's steps be? |
| QW20 | A progress strip on the phones | Web's log has the per-movement strip and its sentence; Android and iOS have the Record chart and a *Trained N of N weeks* line, but no strip (tree `gym-progress-build`). Should the phones carry it? |

## Still open from earlier waves

These gates are unchanged and remain on the tree:
- `android-gym-equipment-variants-design`: cable and kettlebell states.
- `android-gym-mcp-proposal-row-design`: a proposal with no Coach conversation.
- `android-gym-no-routine-picker-design`: an external workout without a routine.
- `android-coach-uncertain-apply-design` and `android-coach-partial-drafts-design`: deferred with the Coach action-card freeze.
