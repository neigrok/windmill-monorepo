# Gym feedback · Android design verification

19 September 2026. The reported feedback came from an Android user. This review checks the Android implementation against [feedback-contract.md](feedback-contract.md), with a bounded source audit of the surrounding screens. It does not certify every skin, device, interaction or model response. Native interaction evidence belongs to the delivery worklog; Figma specimens remain design references.

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

## Verification limits

No unresolved layout issue was found in the final captured states. The review covers normal-size native Instrument and Daylight plus the listed large-text Daylight states. It does not extend the screenshots to unpictured skin/font/IME combinations. Touch-target bounds for the scrolled Add movement action were measured by Android delivery; this audit inspected the resulting capture and source.

## Bounded overall review

These are source findings, not new native screenshot or gesture checks. The review does not call for a global spacing reduction or unrelated flow changes.

| Area and source | Current hierarchy and decision |
| --- | --- |
| Routine detail · `RoutinesScreen.kt`, `RoutineScreen` / `EntryRow` | Routine identity and one summary precede movement targets; Start workout is primary and Edit routine secondary. Movement rows also carry optional rest preferences, so the home list’s 68 dp two-line rule should not be copied blindly to these rows. History and pending proposals carry actual state. Retain this structure. |
| Routine editor · `RoutineBuilder.kt`, `BuildStep` / `TargetSheet` | Name, ordered movements and targets are separate editable groups. 72 dp movement rows use compact name/target text; reorder/delete use gestures and accessibility actions. Target fields adapt at large text or narrow width. Preserve labels, validation and Save; no additional persistent instructions are needed. |
| Movement picker · `MovementPicker.kt`, `MovementPicker` / `MovementRow` | Search leads to grouped results, then one Create movement action. Name, equipment and last-use facts support selection; alias/loading/error text is conditional. 64 dp minimum rows grow with actual content. Retain the contextual metadata and native sheet instead of collapsing distinct facts into icons. |
| Coach history · `ThreadsScreen.kt`, `ThreadRow`; `Thread.kt`, `ThreadOutcome` | Ordinary conversations show the date without Read only/no changes proposed. A creation adds one named/count fact; proposal outcomes remain. The History title has no duplicate Your conversations caption. Conversation receipts keep full action details. |
| Log · `LogScreen.kt`, `LogScreen` / `SessionRow` | Week headings organize session facts; progress/bodyweight and local/record notices appear only when relevant. Share/discard stay in long-press/accessibility actions. Keep the secondary summaries because this is the review destination, and avoid adding them to the logger. |
| Session detail · `SessionScreen.kt`, `SessionHead` / `MovementCard` / `SetRow` | One session summary leads to movement groups and compact set rows. Correction is a row action; Delete is a swipe/accessibility action. Larger text moves notes below values. Preserve plan/provenance and units because they explain the saved record. |
| Finish · `FinishScreen.kt`, `FinishScreen` | Saved confirmation, three factual metrics and performed movements form the receipt. Review/share/keep-as-routine content depends on the result. Metrics stack at large text. Retain the honest saved state and consequences; no timer labels or extra celebration panel are needed. |
| Progress · `RecordScreen.kt`, `RecordBody` | Sparse states omit unavailable chart/record sections; metrics stack at large text. Chart labels and estimate qualification are necessary for interpretation. This reading surface can remain denser than the active workout. |
| Settings · `SettingsScreen.kt`, `SettingsScreen` | Training preferences, Coach connections and Account are grouped; rest alerts are configured inside a native sheet. Keep these explicit controls here. Their availability does not require persistent cards on Coach or the logger. |

Runtime tests for Copy, images, stream/Stop and clock lifecycle are recorded by their implementation owners. This visual audit adds no claim about TalkBack gesture execution, IME behavior, offline timing, notifications or real-model image understanding. The owner’s exact replacement Coach prompt is installed; this visual audit makes no claim about live-model tone.
