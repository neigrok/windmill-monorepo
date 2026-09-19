# Android interaction polish

Status: implementation contract, 19 September 2026. These are acceptance requirements, not verification results. This contract extends [Gym feedback](feedback-contract.md) for routine detail density, streaming presentation and workout gestures. The existing [routine row](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=659-6856), [workout clocks](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=740-100) and [Coach specimens](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=744-3787) remain the visual references. Preserve their palette, typography families and native controls.

## Routine detail

Detail uses the same compact reading rhythm as Routines Home. It retains routine identity, all movement targets, optional rest information, real history and proposal states. Density comes from the spaces around content; text and controls remain readable and reachable.

| Element | Contract |
| --- | --- |
| Content | 20 dp horizontal inset, 8 dp top inset, 16 dp between sections |
| Routine name | 28 sp display; wraps without a fixed height |
| Routine summary | 14 sp dim; 4 dp from name; last-trained information remains subordinate |
| Movement row | Minimum 68 dp; 16 dp horizontal and 8 dp vertical padding; 4 dp between rows |
| Position | Existing 32 dp index treatment, 12 dp from text |
| Movement name | 16 sp bold, unrestricted wrapping |
| Target | 13 sp existing numeral role, readable dim ink; preserve values and units |
| Rest | Optional 13 sp dim line; preserve the actual applicable value |
| Text gaps | 4 dp between name, target and optional rest |
| Actions | Start workout minimum 56 dp, Edit routine minimum 48 dp; existing native bottom inset and 8 dp action gap |

The 68 dp value is a minimum, not a three-line box. A rest line, long movement name or larger font naturally increases row height. No ellipsis conceals a movement name or target. Keep one routine summary and one movement grouping surface; do not add dividers, badges or blank spacers merely to fill the screen. History has one section gap rather than a section gap plus redundant top padding. Controls retain at least 48 dp touch areas. Global spacing tokens and editor field metrics remain unchanged.

## Coach streaming

Use a purpose-built presentation coordinator around native Compose text. The existing answer is already native text, so a custom canvas or glyph engine is not the default solution. It would need to reconstruct font scaling, wrapping, bidirectional text, accessible text and message actions without evidence that shaping is the bottleneck. Measure transport cadence, state delivery, layout and scrolling separately before adding rendering machinery.

The active message has one stable identity through streaming, Stop, interruption, reconnection and completion. Text updates do not recreate its action menu, reset expanded receipts, replace the whole conversation or run entry animations. Completed messages do not participate in a per-token presentation loop. Preserve the existing typography and exact answer text, including newlines; do not add incremental Markdown interpretation as part of this change.

- Present available updates at display-frame cadence, coalescing superseded snapshots. Do not impose a characters-per-second cap, token-by-token fade, repeated crossfade or decorative cursor. Flush final and stopped state without a trailing animation queue.
- Keep any batching bounded. First available text should be visible promptly, and rendering must not wait for another token to flush the final batch. A burst may grow the answer immediately; artificial delayed typing must not conceal a network stall.
- Text grows below its existing content. Stable width, padding and type metrics prevent structural jumps; ordinary trailing-word wrapping and deliberate font/viewport changes remain legitimate reflow.
- Follow the newest rendered content only while the user is already following the end. Base scrolling on settled content geometry, not an independently restarted multi-frame wait for every network revision. Use a 48 dp end tolerance measured in density-independent units.
- A manual drag toward older content suspends following immediately. New deltas, receipts, reconnection, keyboard changes and completion do not pull the reader back. Returning to the end or tapping Jump to latest resumes following. Preserve the message/offset anchor when older history is prepended.
- Use one follow-scroll owner. Automatic following and the existing sent-question positioning must not issue competing scroll commands. Keep the composer stationary above the keyboard or navigation inset.
- New text has no travel, scale or fade. Jump to latest may use the existing native scroll animation when motion is enabled; system animation scale zero completes the action immediately.
- Both speakers retain long-press Copy and the accessible Copy action. An open message menu does not close because another delta arrived. Copy returns the rendered message text with line breaks and without receipt controls or metadata. Partial text is copyable. Do not lose native text semantics through a custom drawing surface; any added text selection must preserve the selection while deltas arrive.
- Streaming does not announce each token to accessibility services. Stop, Retry, actual failure messages, created-routine receipts and persisted partial output keep their current semantics. Reduced rendering work must not drop persisted text or duplicate a turn/tool effect.

This contract improves presentation latency and stability. It does not promise lower model or network latency. Verification uses deterministic local streams only; no automated real-provider calls.

## Workout exercise swipes

The horizontal navigation region covers the workout body: title, clock and history region, unused space, and rack surfaces that do not own a conflicting drag. This replaces the reading-region-only limitation in the earlier Android delivery contract. Native top/bottom navigation and modal surfaces retain their own behavior.

The gesture changes one exercise per deliberate swipe: left advances, right returns. At the first/last exercise it stays in place. It never wraps, opens the movement picker, finishes training or logs a set. Movement switching uses the existing domain transition and preserves clock anchors, entered rack values according to existing movement ownership, queued sets and save/refusal state.

| Competing interaction | Ownership |
| --- | --- |
| Horizontal workout drag | Claim only after native touch slop and clear horizontal intent; do not consume initial down |
| Vertical or vertical-dominant drag | Reading-region scroll; no exercise switch |
| Horizontal set strip or slider | Child drag wins once it consumes movement; parent does not also navigate |
| Button or editable value | Tap and long press retain their action; a deliberate horizontal drag can cancel the click and navigate if the child has not claimed a drag |
| System edge gesture | Android owns the gesture; respect actual system gesture insets and add no exclusion rectangle |
| Sheet, keypad, popup or menu | Modal surface owns the interaction; underlying workout navigation is disabled |
| Cancel, additional pointer, owner/state change | No navigation caused by the canceled gesture |

Once a gesture is owned by an axis or a child, it cannot change owners midway and trigger a second action. A drag below the navigation threshold changes nothing. Preserve existing pressed feedback; do not add a new sound, haptic or page animation. Existing previous/next controls and semantic actions remain discoverable alternatives to swiping. A gesture does not become a requirement for operating training with accessibility services.

## Acceptance and structure

Verify routine Home and Detail with the same fixture and scale, in both skins, at normal and 200% text, and at a 320 dp viewport. Include long movement names, three-line entries, explicit/default/no rest, pending proposals and visible Start/Edit controls.

Exercise deterministic streaming with rapid bursts, isolated single characters, long paragraphs, newlines, Unicode, pauses, completion, Stop and reconnection. Record time to first visible fixture text and whether older-message anchors stay fixed while new content arrives. Check long-press Copy during streaming, menu persistence, Jump to latest, IME changes and reduced motion. Separate native observation from assertions that only exercise state or layout in tests.

Exercise left/right swipes from the title, clocks, history, blank reading space, rack background and a button surface. Verify vertical scrolling at large text, horizontal set-strip scrolling, ordinary taps/long presses, first/last bounds, system Back edges and every open modal. Confirm no unintended set is logged and no timer anchor changes. Record accessibility checks actually performed rather than inferring TalkBack behavior from semantics.

Keep gesture arbitration in one feature-level owner and streaming presentation in one feature-level owner. The store remains responsible for persisted data and domain transitions. After implementation, remove redundant title-only gesture handlers, competing scroll effects and text-keyed transient-state resets covered by the new owners. Do not broaden these changes into global spacing or text infrastructure without another concrete consumer.
