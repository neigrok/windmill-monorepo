# Gym feedback · Android design verification

19 September 2026. The reported feedback came from an Android user. This review checks the Android implementation against [feedback-contract.md](feedback-contract.md) and [interaction-polish.md](interaction-polish.md), with a bounded source audit of the surrounding screens. It does not certify every skin, device, interaction or model response. The [interaction worklog](../../gym-interaction-polish-log.md) records implementation and test results; Figma specimens remain design references.

## Captured layout

Local evidence is in `/private/tmp/windmill-feedback-runtime/`. Captures are Daylight unless stated otherwise. “Large type” is 320 dp width at 200% font size except the explicitly named 411 dp capture. The screenshot names below identify the inspected state, not a claim about unpictured states.

| Surface | Inspected evidence | Assessment |
| --- | --- | --- |
| Routines | `android-routines-final.png` | Five compact two-line rows, restrained metadata and More, with Start logging above navigation. The empty lower area is unused list space, not padding inserted between rows. |
| Routines · large type | `android-routines-large-type.png`, `android-routines-411-large-type.png` | Rows grow and metadata wraps. Routines is fully visible beside the native Add action at both widths; source gives the action a 48 dp target and “New routine” name. Start logging remains visible. The bottom navigation label is recognizable at 320 dp and complete at 411 dp. |
| Workout · no prior sets | `android-logger-final.png` | Movement identity, two quiet clocks, load/reps and Log set have a clear hierarchy. No empty Last time card, target card or visible clock labels. Weight and Reps labels identify editable controls and remain useful. |
| Workout · large type | `android-logger-large-type.png` | Full movement name, clock pair, rack controls and Log set fit. Add movement is partly below the initial scroll viewport edge. Finish and the abbreviated session name are adjacent without overlapping. |
| Workout · scrolled large type | `android-logger-large-type-add-movement.png` | A small scroll reveals the full Add movement action while the rack remains fixed. Android delivery measured its clickable parent at 48 dp height inside the reading region. The cropped movement name is now above the scroll boundary. |
| Coach · large type | `android-coach-large-type.png` | Title, History, More and an empty reading area lead to the composer. Placeholder wraps without displacing the photo or Send controls. No opening pitch, quota block or repeated instructions. |
| Coach · attachment draft | `android-photo-draft-final.png` | One thumbnail and a quiet Remove photo action sit above the shared composer. The two-word action is clearer than an unlabeled removal glyph. |
| Coach · retained photo preview | `android-photo-history-final.png` | Contained image preview and Close are readable over the dimmed conversation. This capture checks the open preview, not every underlying message row. |
| Coach · stopped history | `android-stopped-history-final.png` | Partial text, collapsed read receipt and Response stopped remain visible in a reopened thread. No unnecessary Jump to latest control appears for the short content. |
| Coach · history list | `android-history-final.png` | Ordinary rows show their dates. The creation row shows “2 routines created” once. No repeated status badge or Your conversations caption. |
| Routines / workout · Instrument | `android-routines-dark-final.png`, `android-logger-dark-final.png` | Compact rows and the quiet clock pair retain readable secondary content in the native dark skin. Load and the primary action retain emphasis. |
| Coach · Instrument | `android-coach-dark-final.png` | Quiet initial room and composer use the native dark skin; Coach is the selected destination. |

Source confirms Account remains discoverable in Coach’s More menu (`AskScreen.kt`, `AskScreen`) alongside Notes and Connected log. The simplified header does not remove the account destination.

## Interaction polish · native evidence

Evidence for this phase is in `/private/tmp/windmill-interaction-polish/` on the retained Android emulator. These checks use the integrated debug build and synthetic local data.

| Surface | Inspected evidence | Assessment |
| --- | --- | --- |
| Routine detail · normal type | `detail-before.txt/png`, `detail-after.txt/png` | Movement-name row pitch measures 216 px at density 3, or 72 dp, matching Home. The comparison capture measures 336 px, or 112 dp. Routine identity, targets, History and Start/Edit retain their hierarchy. |
| Routine detail · 320 dp / 200% type | `detail-large-dark.png`, `detail-large-light.png`, `detail-large-scrolled.txt` | Targets wrap and rows grow in Instrument. Start workout and Edit routine remain reachable; vertical scrolling reveals the full History entry. Both image files show the dark skin despite the second filename, so these captures do not verify large-type Daylight. |
| Workout · body swipes | `swipes-after.txt` | Deliberate horizontal swipes over weight, clocks, blank space, Log set, history and title navigate in both directions across the sequence. First/last movement bounds hold. Set 1 of 3 remains unchanged throughout, and both clocks continue advancing. |
| Workout · controls and modal ownership | `modal-swipe-after.txt` and delivery observation | A normal Weight tap opens its sheet; a swipe with the sheet open leaves Bench Press selected. A subsequent deliberate Log set and Finish save one set of 8 × 50 kg, totaling 400 kg. |
| Coach · partial text and Copy | `observe-result.json`, `observe-after-menu1.json`, `observe-after-menu2.json`, `observe-after-menu-dismissed.json` | The final debug APK shows partial text by 2.05 seconds, a polling upper bound. Copy remains open across incoming text updates and can be dismissed while Stop remains visible. |
| Coach · reader position | `observe-after-anchor1.json`, `observe-after-anchor2.json`, `anchor1.png`, `anchor2.png` | After the reader pauses following, the screenshots are byte-identical across 4.21 seconds while the answer grows from 2,496 to 3,312 characters. Stop and Jump to latest remain visible in both states. |
| Coach · completed answer and Jump | `observe-final.txt`, `observe-after-jump.txt` | All 18 Unicode paragraphs of the long local fixture complete. Jump to latest after completion reaches the final paragraph and disappears. This check does not establish Jump behavior during an active stream. |

A new Coach draft also survives the APK update. Deterministic regression and full-suite results are recorded in the [interaction worklog](../../gym-interaction-polish-log.md#verification). These native checks use local fixtures, not an actual provider; observed timings are not production performance measurements. No spoken TalkBack run was performed.

## Verification limits

No unresolved layout issue was found in the changed routine-detail and Coach states inspected here. The existing 320 dp / 200% bottom-navigation label clipping remains tracked in the [consistency ledger](../consistency.md). Coverage is limited to the named normal and large-type captures and the listed Coach interactions. Screenshots do not verify unpictured skin/font/IME combinations. Touch-target bounds for the scrolled Add movement action were measured by Android delivery; this audit inspected the resulting capture and source.

## Bounded overall review

The routine-detail finding includes the native evidence above; the other rows are source findings. The review does not call for a global spacing reduction or unrelated flow changes.

| Area and source | Current hierarchy and decision |
| --- | --- |
| Routine detail · `RoutinesScreen.kt`, `RoutineScreen` / `EntryRow` | Routine identity and one summary precede compact movement targets. Native normal-type row pitch matches Home at 72 dp; the 68 dp minimum row grows for wrapped targets or optional rest preferences. Start workout and Edit routine keep 56 dp and 48 dp minimum targets. History and pending proposals retain actual state. |
| Routine editor · `RoutineBuilder.kt`, `BuildStep` / `TargetSheet` | Name, ordered movements and targets are separate editable groups. 72 dp movement rows use compact name/target text; reorder/delete use gestures and accessibility actions. Target fields adapt at large text or narrow width. Preserve labels, validation and Save; no additional persistent instructions are needed. |
| Movement picker · `MovementPicker.kt`, `MovementPicker` / `MovementRow` | Search leads to grouped results, then one Create movement action. Name, equipment and last-use facts support selection; alias/loading/error text is conditional. 64 dp minimum rows grow with actual content. Retain the contextual metadata and native sheet instead of collapsing distinct facts into icons. |
| Coach history · `ThreadsScreen.kt`, `ThreadRow`; `Thread.kt`, `ThreadOutcome` | Ordinary conversations show the date without Read only/no changes proposed. A creation adds one named/count fact; proposal outcomes remain. The History title has no duplicate Your conversations caption. Conversation receipts keep full action details. |
| Log · `LogScreen.kt`, `LogScreen` / `SessionRow` | Week headings organize session facts; progress/bodyweight and local/record notices appear only when relevant. Share/discard stay in long-press/accessibility actions. Keep the secondary summaries because this is the review destination, and avoid adding them to the logger. |
| Session detail · `SessionScreen.kt`, `SessionHead` / `MovementCard` / `SetRow` | One session summary leads to movement groups and compact set rows. Correction is a row action; Delete is a swipe/accessibility action. Larger text moves notes below values. Preserve plan/provenance and units because they explain the saved record. |
| Finish · `FinishScreen.kt`, `FinishScreen` | Saved confirmation, three factual metrics and performed movements form the receipt. Review/share/keep-as-routine content depends on the result. Metrics stack at large text. Retain the honest saved state and consequences; no timer labels or extra celebration panel are needed. |
| Progress · `RecordScreen.kt`, `RecordBody` | Sparse states omit unavailable chart/record sections; metrics stack at large text. Chart labels and estimate qualification are necessary for interpretation. This reading surface can remain denser than the active workout. |
| Settings · `SettingsScreen.kt`, `SettingsScreen` | Training preferences, Coach connections and Account are grouped; rest alerts are configured inside a native sheet. Keep these explicit controls here. Their availability does not require persistent cards on Coach or the logger. |

Runtime tests for Copy, images, stream/Stop and clock lifecycle are recorded by their implementation owners. This visual audit adds no claim about TalkBack gesture execution, IME behavior, offline timing, notifications or real-model image understanding. The owner’s exact replacement Coach prompt is installed; this visual audit makes no claim about live-model tone.
