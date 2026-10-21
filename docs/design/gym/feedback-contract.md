# Gym feedback contract

Current layout and interaction requirements, alongside [Android delivery](android-delivery.md) and the gym briefs.

## Structure and density

Keep the existing three destinations, native bars/sheets, palette, typography roles and current set classification behavior. Change feature layout values rather than shrinking global spacing tokens. Android controls retain 48 dp targets; iOS controls retain 44 pt targets. Visual icon size and hit area are separate.

Routines use a 68 dp minimum two-line row, 4 dp between rows, 20 dp horizontal content inset and 8 dp top inset on Android. Preserve 16 sp bold names, 13 sp readable ink-dim metadata and a 4 dp name/meta gap. The More target is 48 dp. Rows grow with long text and accessibility sizes. Remove the redundant routine count and emit refusal content only when a refusal exists. A pending proposal remains discoverable; empty routines have one invitation and a creation action. Keep Start logging fixed above navigation. iOS and narrow web use this compact hierarchy with native row metrics rather than copying Android dimensions.

At large Android text sizes, the New routine action uses a native 48 dp Add icon with the full accessible name. Preserve a recognizable Routines heading; give the title a separate row if the controls still leave too little room. Do not reduce the user's text scale to make the bar fit.

Routine detail/editor, movement picker, log/detail, finish, progress and settings receive the same limited audit: remove duplicate titles, repeated summaries, unnecessary borders and empty layout slots. Preserve units, editable value labels, failure explanations, consequences and primary-control reach. Do not change unrelated flows.

## Workout clocks

Show one compact, non-interactive clock pair in the reading region below movement identity and above the set records. Use a native outlined clock for workout elapsed and stopwatch for since-set elapsed, each 16 dp with a 6 dp gap to 14 sp tabular numbers; separate the metrics by 16 dp. Use ink-dim in both skins. The pair has no visible labels, timer cards, target, countdown or progress ring, and replaces the logger’s displayed rest-target/elapsed block. It introduces no chime or rest setting. Android has no rest-target preferences or alerts; its workout notification follows `android-delivery.md`. Keep the weight/reps controls and Log set the dominant content.

| Reading | Anchor | Accessible name |
| --- | --- | --- |
| Workout elapsed | Active session start | Workout time |
| Since-set elapsed | Latest non-deleted completed set anywhere in this session | Since last set |
| Since-set before any set | Session start | Since start |

Both readings are `max(0, now - anchor)` from persisted timestamps; after finish use the finish timestamp in place of now. Include accepted offline sets and every retained set kind. Logging failure does not reset an anchor; server acknowledgement does not reset it twice. Exercise changes, load/reps corrections, refresh, backgrounding, relaunch and reconnect preserve anchors. Deleting the newest set selects the prior set or start; Undo restores the original timestamp. Web shows the same facts for server records available to its read-only mirror and preserves freshness/connection status.

Use minutes/seconds below one hour and hours/minutes/seconds thereafter without clipping or layout jumps. Group each metric semantically, read its full duration on focus, and do not announce ticks. A timer is not a button. Preserve the existing clock-skew policy and clamp negative readings.

## Coach conversation

The iOS room shows one local conversational welcome until its first accepted user message, with
**Add screenshot**, **Build myself** and the composer. It survives picker cancellation, tab changes,
relaunch and failed/refused sends. No goal form, required chips, Just log or remaining-allowance
indicator is drawn. Automatic empty-account entry waits for account hydration and preserves active
workouts, adoption and saved conversation state. Empty Routines instead has one bottom-right plus
opening the routine builder. See [Coach](briefs/09-coach.md).

Keep Coach as the native title and History as a navigation action. iOS Notes and Connected log
live in You and settings; New chat is in History. Other surfaces retain their own native More
menus. The composer stays above navigation/keyboard insets while conversation content scrolls.
Placeholder: **Ask about your training**. After onboarding, an empty conversation needs no repeated
capability text. Coach supports natural dialogue and contextual follow-up questions.

| State | UI and action |
| --- | --- |
| First message (iOS) | Local greeting, Add screenshot, Build myself and the composer |
| Empty after onboarding | Empty reading region and composer |
| History / resumed | The same editable conversation, ordered messages and factual outcomes |
| Copy | Native Copy for either speaker, including partial text; web keeps selection/context access |
| Attachment draft | One thumbnail, Remove photo, optional text; retain the draft on failure |
| Uploading | Thumbnail progress and Cancel upload; no duplicate Send |
| Upload failed | Photo didn’t upload. · Retry; preserve image and text |
| Unsupported | Choose a supported photo. · accepted formats/size follow the API |
| Generating | Incremental text and Stop in Send's target; no internal reasoning |
| Reconnecting | Only after transport failure; recover the same turn and clear after recovery |
| Interrupted | Preserve partial text, Response interrupted. and Retry; saved receipts remain |
| Stopped | Preserve partial text; never describe completed actions as undone |
| At limit | Actual refusal and available recovery; no new-chat reset claim |
| Exhausted anonymous | Sign-in recovery, preserving draft and conversation |
| Exhausted signed-in | Windmill One information for eligible non-One accounts; no unavailable checkout |
| Routine draft | Actual name/count and Review; the human confirms Save routine |
| Routine saved | Routine created · N movements and Open routine, only after successful saving |

Installation access uses the server-issued lifetime grant with no promised question count. Shared
budgets, individual allowance, request size and concurrent-call limits remain distinct refusals.
Sign-in preserves usage attribution and does not guarantee capacity. While checkout is closed,
the Windmill One destination says **Subscriptions aren’t available yet.** Existing One users receive
recovery for their actual limit. There is no standing allowance/balance line.

Signed-in text accepts 8,000 UTF-8 bytes; anonymous conversation text accepts 4,000. Overlong input
remains editable and receives a length refusal. Routine drafts, save outcomes and counts come from
typed contract data; clients never parse generated prose to invent controls or completed writes.

Copy returns only the message's visible textual content, preserving line breaks. It excludes timestamps, hidden metadata, receipt controls and image filenames. Do not offer an empty text Copy for an attachment-only message. Partial text remains copyable. Proposal actions stay separate from message context menus.

Android history omits the redundant Your conversations caption and ordinary Read only/no changes proposed status. “Read only” must not imply a retained conversation cannot continue. A created routine has one outcome fact: “Created {routine}” when named, otherwise the actual count of routines created. Preserve meaningful proposal outcomes and conversation receipts; do not repeat the same state as both a badge and a subtitle.

Use native photo pickers and menus. The attachment control is an accessible Add photo icon. Send accepts a photo with optional text. An attachment-only first conversation uses Photo as its neutral title. Signed in, sent images are kept privately with the account's conversation and reopen from authenticated storage. The draft caption says “Sent to Coach when you send. Kept privately with this chat.” Signed out, the caption says “Sent to our AI provider when you send. Windmill keeps this photo only on this phone.” The application server processes the image inline without persisting it; the caption makes no claim about provider retention. Do not fake an image asset or promise unsupported file types in the drawing.

While streaming, follow new text only when already at the end. Reading older messages preserves position; a quiet Jump to latest affordance appears when needed. Retry/reconnect reattach to the existing logical turn, preserving ordered text and completed tool effects. Signed-in Stop stops generation and does not reverse a completed routine creation or Apply. Anonymous setup uses one request: “Stop waiting” cancels local waiting and saving, while “Check response” recovers the same request without another charge. “Saving your routines…” lasts until the atomic local commit succeeds; only then show creation receipts.

## Verification and systematization

Review both skins, small screens, keyboard open/closed, long text and the largest supported text size. Exercise routine selection/editing, start/log/finish, first/later sets, exercise switch, offline set, deletion/Undo, background/relaunch, history resume, both message-copy paths, photo preview/remove/retry, streaming/Stop/reconnect and proposal review. Preserve stable primary targets and spoken names.

Figma edits reuse existing masters for routine rows, logger, composer and native chrome. State specimens share these controls; redundant copies and obsolete captions are removed in the same design pass. This document's acceptance cases are requirements, not test results.

## Drawings

Updated Android masters: [routine row](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=659-6856), [workout clocks](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=740-100), [composer](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=741-99). Current root and workout frames retain their existing URLs. [Coach feedback specimens](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=744-3787) show More, Copy, photo draft, streaming and interruption, with Daylight references. [Resumed conversation](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=678-10531) now includes the shared composer.

The clock icon comes from the subscribed Material kit; the stopwatch uses Google’s official Material outlined timer SVG. The attachment specimen uses an equipment photo from [LSG Fitness](https://www.lsgfitness.com.au/blogs/news/getting-started-with-weight-training) as an attributed design fixture, not a bundled product asset. The displayed response is illustrative fixture copy and is not the requested replacement system prompt.

## Unchecked acceptance

- Web photo-picker upload acceptance remains unverified. Exercise real selection, upload,
  preview/remove/retry and authenticated image reads.
- Real iOS photo selection, upload retry and authenticated image reads remain unverified in the
  setup phase. Signed-in conversation fixtures cover draft-only starters, clarification selection,
  creation receipts, routine opening and workout start; they do not establish live-provider behavior.
  Android acceptance does not establish those platform behaviors.
