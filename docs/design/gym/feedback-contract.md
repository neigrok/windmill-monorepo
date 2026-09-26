# Gym feedback contract

Current layout and interaction requirements, alongside [Android delivery](android-delivery.md) and the gym briefs.

## Structure and density

Keep the existing three destinations, native bars/sheets, palette, typography roles and current set classification behavior. Change feature layout values rather than shrinking global spacing tokens. Android controls retain 48 dp targets; iOS controls retain 44 pt targets. Visual icon size and hit area are separate.

Routines use a 68 dp minimum two-line row, 4 dp between rows, 20 dp horizontal content inset and 8 dp top inset on Android. Preserve 16 sp bold names, 13 sp readable ink-dim metadata and a 4 dp name/meta gap. The More target is 48 dp. Rows grow with long text and accessibility sizes. Remove the redundant routine count and emit refusal content only when a refusal exists. A pending proposal remains discoverable; empty routines have one invitation and a creation action. Keep Start logging fixed above navigation. iOS and narrow web use this compact hierarchy with native row metrics rather than copying Android dimensions.

At large Android text sizes, the New routine action uses a native 48 dp Add icon with the full accessible name. Preserve a recognizable Routines heading; give the title a separate row if the controls still leave too little room. Do not reduce the user's text scale to make the bar fit.

Routine detail/editor, movement picker, log/detail, finish, progress and settings receive the same limited audit: remove duplicate titles, repeated summaries, unnecessary borders and empty layout slots. Preserve units, editable value labels, failure explanations, consequences and primary-control reach. Do not change unrelated flows.

## Workout clocks

Show one compact, non-interactive clock pair in the reading region below movement identity and above the set records. Use a native outlined clock for workout elapsed and stopwatch for since-set elapsed, each 16 dp with a 6 dp gap to 14 sp tabular numbers; separate the metrics by 16 dp. Use ink-dim in both skins. The pair has no visible labels, timer cards, target, countdown or progress ring, and replaces the logger’s displayed rest-target/elapsed block. It introduces no chime or rest setting. Existing optional Android rest-alert preferences and notification runtime remain; this feedback does not remove them. Keep the weight/reps controls and Log set the dominant content.

| Reading | Anchor | Accessible name |
| --- | --- | --- |
| Workout elapsed | Active session start | Workout time |
| Since-set elapsed | Latest non-deleted completed set anywhere in this session | Since last set |
| Since-set before any set | Session start | Since start |

Both readings are `max(0, now - anchor)` from persisted timestamps; after finish use the finish timestamp in place of now. Include accepted offline sets and every retained set kind. Logging failure does not reset an anchor; server acknowledgement does not reset it twice. Exercise changes, load/reps corrections, refresh, backgrounding, relaunch and reconnect preserve anchors. Deleting the newest set selects the prior set or start; Undo restores the original timestamp. Web shows the same facts for server records available to its read-only mirror and preserves freshness/connection status.

Use minutes/seconds below one hour and hours/minutes/seconds thereafter without clipping or layout jumps. Group each metric semantically, read its full duration on focus, and do not announce ticks. A timer is not a button. Preserve the existing clock-skew policy and clamp negative readings.

## Coach conversation

The initial room opens directly to the composer. Keep Coach as the native title, History as a navigation action, and a 48 dp/44 pt More menu. More contains Notes, Connected log and Account, and New chat when a conversation exists. Do not stack greetings, empty-state headings, repeated capability text, suggestions, connection pitches or permanent correction instructions. Composer placeholder: “Ask about your training”.

The composer is fixed above the navigation/keyboard inset while the conversation scrolls. Notes/connection details remain available in their destinations. Show allowance, access, connection and generation failures when they affect an action, with a concrete recovery. Preserve factual read receipts and creation/proposal results; optional tool detail stays collapsed. Keep existing human Apply semantics on each surface. Coach may create a routine when requested; routine edits continue through their existing proposal path. The owner's supplied prompt is preserved verbatim in the Coach implementation. Coach may also append useful new user-provided insights to Notes; existing notes remain under the user's edit and delete controls.

| State | UI and action |
| --- | --- |
| Empty | Empty reading region and composer; no unsolicited message |
| History | Retained conversations; selecting a row opens that same editable conversation; ordinary rows show a date, and creation/proposal rows add one concise outcome |
| Resumed | Ordered existing messages, unchanged conversation identity, active composer, New chat in More |
| Copy | Long press either speaker → native Copy; also expose accessibility Copy; web keeps selection and keyboard/context-menu access |
| Attachment draft | One image thumbnail above input, Remove photo target, optional text; retain draft on failure |
| Uploading | Thumbnail with progress and Cancel upload; no duplicate Send |
| Upload failed | “Photo didn’t upload.” with Retry; preserve photo and text |
| Unsupported | “Choose a supported photo.”; accepted formats and size come from the actual API |
| Generating | Incremental text, Stop in Send’s existing target; no raw tool trace or internal reasoning |
| Interrupted | Preserve partial answer; “Response interrupted.” and Retry; completed action receipts remain |
| Stopped | Preserve partial answer; “Response stopped.”; completed actions are not described as undone |
| At limit | Server’s accurate refusal and available recovery; New chat never implies an account limit resets |
| Routine created | Factual “Routine created” receipt with the actual routine name and Open routine |

Copy returns only the message's visible textual content, preserving line breaks. It excludes timestamps, hidden metadata, receipt controls and image filenames. Do not offer an empty text Copy for an attachment-only message. Partial text remains copyable. Proposal actions stay separate from message context menus.

Android history omits the redundant Your conversations caption and ordinary Read only/no changes proposed status. “Read only” must not imply a retained conversation cannot continue. A created routine has one outcome fact: “Created {routine}” when named, otherwise the actual count of routines created. Preserve meaningful proposal outcomes and conversation receipts; do not repeat the same state as both a badge and a subtitle.

Use native photo pickers and menus. The attachment control is an accessible Add photo icon. Send accepts a photo with optional text. An attachment-only first conversation uses Photo as its neutral title. Sent images reopen from private authenticated storage. Do not fake an image asset or promise unsupported file types in the drawing.

While streaming, follow new text only when already at the end. Reading older messages preserves position; a quiet Jump to latest affordance appears when needed. Retry/reconnect reattach to the existing logical turn, preserving ordered text and completed tool effects. Stop stops generation and does not reverse a completed routine creation or Apply.

## Verification and systematization

Review both skins, small screens, keyboard open/closed, long text and the largest supported text size. Exercise routine selection/editing, start/log/finish, first/later sets, exercise switch, offline set, deletion/Undo, background/relaunch, history resume, both message-copy paths, photo preview/remove/retry, streaming/Stop/reconnect and proposal review. Preserve stable primary targets and spoken names.

Figma edits reuse existing masters for routine rows, logger, composer and native chrome. State specimens share these controls; redundant copies and obsolete captions are removed in the same design pass. This document's acceptance cases are requirements, not test results.

## Drawings

Updated Android masters: [routine row](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=659-6856), [workout clocks](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=740-100), [composer](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=741-99). Current root and workout frames retain their existing URLs. [Coach feedback specimens](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=744-3787) show More, Copy, photo draft, streaming and interruption, with Daylight references. [Resumed conversation](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=678-10531) now includes the shared composer.

The clock icon comes from the subscribed Material kit; the stopwatch uses Google’s official Material outlined timer SVG. The attachment specimen uses an equipment photo from [LSG Fitness](https://www.lsgfitness.com.au/blogs/news/getting-started-with-weight-training) as an attributed design fixture, not a bundled product asset. The displayed response is illustrative fixture copy and is not the requested replacement system prompt.

## Unchecked acceptance

- Web photo-picker upload acceptance remains unverified. Exercise real selection, upload,
  preview/remove/retry and authenticated image reads.
- Authenticated iOS photo-picker and Coach conversation acceptance remains unverified.
  Android acceptance does not establish those platform behaviors.
