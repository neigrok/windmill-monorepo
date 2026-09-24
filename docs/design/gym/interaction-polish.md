# Android interaction polish

Status: implementation contract with synchronized Figma specimens, 19 September 2026. These are acceptance requirements, not native verification results. This contract extends [Gym feedback](feedback-contract.md) for routine detail density, streaming presentation and workout gestures. The visual references are the updated [routine Detail](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=656-6696), [duplicate Detail with rest](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=677-10061), shared [routine entry](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=756-114), [workout gesture specification](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=677-10450), [following stream](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=744-3844), and [paused reader with Copy](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=744-3801). The [interaction annotation](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=746-4062) records behavior outside product frames; [workout clocks](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=740-100) retain their visual reference.

Figma screenshots and read-back checks confirm the edited frames’ dimensions, wrapping, existing color bindings and Nunito / Baloo 2 / JetBrains Mono role stand-ins. Android uses native sans and monospace fonts. Figma review does not establish the full skin, font-scale, viewport or TalkBack acceptance matrix.

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

The answer is native Compose text under one purpose-built presentation coordinator; there is no custom canvas or glyph engine. The transport delivers whole-answer snapshots about once a second (the server polls the durable generation at that cadence), so the phone owns two things: where the reader is, and how the text between two snapshots is revealed.

The active message has one stable identity through streaming, Stop, interruption, reconnection and completion. Text updates do not recreate its action menu, reset expanded receipts, replace the whole conversation or run entry animations. Completed messages do not participate in a per-frame presentation loop.

- Markdown is rendered, block by block: paragraphs, `#`–`###` headings, bullet and numbered lists (one nesting level), fenced code, rules, and inline bold, italic and code. Single newlines inside a paragraph stay line breaks. A marker the model has opened but not yet closed styles the text to the end of the block, so a reader never sees raw asterisks that later vanish; a bare block marker still waiting for its next token is held back. Settled blocks keep their text node and layout; only the growing tail block re-lays out. Paragraph type is the existing 19 sp / 27 sp body; headings step to 22/20/19 sp bold; list markers sit in a 24 dp column with 20 dp per nesting level; code uses the mono face on the surface tone.
- Between snapshots the live message reveals the newly received text at the rate the transport has been delivering it (the delta paced over the observed inter-arrival interval, never slower than 40 characters per second), cut only at grapheme boundaries. What is shown is always a prefix of what the server sent, every delta is fully shown within one interval of its arrival, a stalled stream reveals what it has and then stops, and completion, Stop and failure flush the whole text at the next frame. No token fade, crossfade or decorative cursor. Only a running generation is paced; history and completed answers draw whole.
- Text grows below its existing content. Stable width, padding and type metrics prevent structural jumps; ordinary trailing-word wrapping and deliberate font/viewport changes remain legitimate reflow.
- Scrolling is corrected in the layout phase of the conversation's scroll container, after content is measured and before it is placed: text that grew this frame is in view this frame, with no scroll animation following it. Follow the newest content only while the reader is already following the end, with a 48 dp end tolerance measured in density-independent units.
- A manual drag toward older content suspends following immediately. New deltas, receipts, reconnection, keyboard changes and completion do not pull the reader back. Returning to the end or tapping Jump to latest resumes following. Prepended older history keeps the visible message at its exact offset. A newly sent question snaps to the end of the conversation, which with the last exchange's minimum height places it at the top of the viewport; opening a conversation lands at its end too.
- One follow-scroll owner. Nothing else issues scroll commands into the conversation. Keep the composer stationary above the keyboard or navigation inset.
- New text has no travel, scale or fade. Jump to latest uses the native scroll animation when motion is enabled; system animation scale zero completes the action immediately.
- Both speakers retain long-press Copy and the accessible Copy action, and a tap on a message opens the same menu without a ripple. An open message menu does not close because another delta arrived. Copy returns the plain text of what is rendered (markers stripped, list prefixes and line breaks kept), without receipt controls or metadata. Partial text is copyable.
- Streaming does not announce each token to accessibility services. Stop, Retry, actual failure messages, created-routine receipts and persisted partial output keep their current semantics. Reduced rendering work must not drop persisted text or duplicate a turn/tool effect.

This contract improves presentation latency and stability. It does not promise lower model or network latency. Verification uses deterministic local streams only; no automated real-provider calls.

## Workout exercise swipes

The horizontal navigation region covers the workout body: the pinned head and clocks, the set ledger, unused space, and rack surfaces that do not own a conflicting drag. Native top/bottom navigation and modal surfaces retain their own behavior.

The native pager reveals the adjacent exercise while the finger moves. In a left-to-right layout, left advances and right returns; the platform mirrors direction in a right-to-left layout. Reversing a drag restores the current page. A released gesture settles using native position and velocity rules, one adjacent exercise at a time. At the first/last exercise it stays in place. It never wraps, opens the movement picker, finishes training or logs a set. Movement switching uses the existing domain transition and preserves clock anchors, entered rack values according to existing movement ownership, queued sets and save/refusal state.

| Competing interaction | Ownership |
| --- | --- |
| Horizontal workout drag | Claim only after native touch slop and clear horizontal intent; do not consume initial down |
| Vertical or vertical-dominant drag | Ledger scroll; the head stays pinned; no exercise switch |
| Horizontal slider | Child drag wins once it consumes movement; parent does not also navigate |
| Button or editable value | Tap and long press retain their action; a deliberate horizontal drag can cancel the click and navigate if the child has not claimed a drag |
| System edge gesture | Android owns the gesture; respect actual system gesture insets and add no exclusion rectangle |
| Sheet, keypad, popup or menu | Modal surface owns the interaction; underlying workout navigation is disabled |
| Additional pointer | Native scrolling may transfer the active pointer; a second contact performs no rack action during a drag |
| Cancel or owner/state change | No stale destination is committed; align the pager to the current selected exercise |

Compose owns touch slop, axis selection and snapping. The page — head and ledger — translates with the finger; the rack stays fixed. A cancelled or reversed drag preserves the rack draft. Selection and any departure question wait until the destination settles, and rack edits and logging are disabled during motion. Preserve existing pressed feedback and add no sound or haptic. The head’s ‹ and › buttons (48 dp) and the title’s Previous/Next movement actions remain discoverable alternatives to swiping. A gesture does not become a requirement for operating training with accessibility services.

## Acceptance and structure

Verify routine Home and Detail with the same fixture and scale, in both skins, at normal and 200% text, and at a 320 dp viewport. Include long movement names, three-line entries, explicit/default/no rest, pending proposals and visible Start/Edit controls.

Exercise deterministic streaming with rapid bursts, isolated single characters, long paragraphs, newlines, Unicode, pauses, completion, Stop and reconnection. Record time to first visible fixture text and whether older-message anchors stay fixed while new content arrives. Check long-press Copy during streaming, menu persistence, Jump to latest, IME changes and reduced motion. Separate native observation from assertions that only exercise state or layout in tests.

Exercise left/right swipes from the title, clocks, ledger rows, blank reading space, rack background and a button surface. Verify vertical ledger scrolling at large text, ordinary taps/long presses, first/last bounds, system Back edges and every open modal. Confirm no unintended set is logged and no timer anchor changes. Record accessibility checks actually performed rather than inferring TalkBack behavior from semantics.

Keep gesture arbitration in one feature-level owner and streaming presentation in one feature-level owner. The store remains responsible for persisted data and domain transitions. After implementation, remove redundant title-only gesture handlers, competing scroll effects and text-keyed transient-state resets covered by the new owners. Do not broaden these changes into global spacing or text infrastructure without another concrete consumer.
