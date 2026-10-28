# Android Coach messages

Task 28 uses the approved ordinary-message frames in Figma file `vdmdiKWrmZoS1FtcvJRf6O`:
empty `1252:27790` / `1254:41136`, Markdown `1254:30552` / `1254:41360`, streaming
`1254:30653` / `1254:41382`, Copy `1254:31101` / `1254:41499`, Jump to latest
`1254:31296` / `1254:41540`, and thinking `1253:30742` / `1254:39416`.
The frames are human-approved for development. Task 37 supplies the durable owner/chat lifecycle.

Ordinary messages use the native chat-bubble component `337:2761`, with 20 dp outer corners,
4 dp joined corners, 2 dp within a group, 12 dp between groups and 16 dp page gutters. A plain
paragraph has a 321 dp maximum width. Structured Markdown uses the full lane and includes tables.
Nunito comes from the existing Android font resources and is scoped to ordinary Coach, History
and sources text. Ordinary bubbles occupy the 16 dp lane. The scoped 4 dp receipt inset preserves
existing proposal, action and write-receipt containers in their 20 dp lane, with the read-only tally
text starting at 32 dp. Controls, typefaces and outcome words retain their current presentation.

The composer retains `TextFieldState` and uses the installed Material 3 filled-field decoration,
with a 56 dp minimum height, 28 dp pill and no indicator. Add photo has a 48 dp touch target and
24 dp image glyph. Send and Stop have a 40 dp visible circle inside a 48 dp target. The native
field component set is `1243:8725`; the approved placeholder instance uses `1243:8805`.
Signed-out local History reuses its Filled/Disabled variants `1243:8801` and `1243:8811`, with
4% container and 38% content opacity. Drafts and photos remain retained while editing and Send
are disabled. The approved task 36 access-screen body and anonymous network admission are
separate work.

The History, image, Send, Stop and down glyphs and both typing bubbles are native vectors
converted from the exact Figma SVG paths. The icons retain their 24 dp viewports, the down glyph
its 20 dp viewport and the typing bubbles their 64 by 40 dp geometry. The typing dots use the
approved 100%, 60% and 30% opacities. The source glyphs and per-file hashes are retained in the
private acceptance packet.

Streaming keeps one reveal owner from the empty pending exchange through its terminal answer.
Only text received after mounting is paced; revisiting a chat shows the retained text immediately.
Stop shows all text already received. Long press and the equivalent accessibility action copy the
whole plain-text message from the latest received answer, independently of its paced display.
An open paragraph menu remains anchored to a surviving bubble if replacement text removes that
paragraph. Copy failures keep the action available and report under the static
`gym.copyMessage` boundary. Copy and Jump emit only bounded event labels.

Coach keeps the full navigation rail while reading a selected chat. Choosing Routines or The log
clears the pushed chat route while retaining its owner-scoped draft. The composer follows the
native IME insets. Sources use the actual sheet top and thread viewport bottom to retain the
read tally above the sheet; content geometry is measured in screen coordinates.

The simplification pass shares bubble, timestamp and typography ownership, removes the unused
waiting label and More-menu implementation, and keeps the native text-selection pipeline. No
parallel chat storage or input framework is introduced. Message rendering and clipboard content
have separate inputs; paragraph anchors derive their surviving index without another state owner.

## Verification

Focused native-graphics Compose coverage verifies paragraph and Markdown geometry, table content,
phone clock formatting, streaming and Stop, long-press and accessibility Copy, full received-answer
Copy before paced display completes, paragraph replacement while Copy is open, Copy failure and retry, native double-tap selection, disabled retained drafts/photos, scroll anchoring and keyboard
viewport changes. Lifecycle and mixed read/write receipt regressions remain in the combined gate.
Native API 37 captures cover empty, Markdown, thinking, streaming, Copy and Jump states in both
appearances. Native checks verify exact input and Send text, double-tap replacement, caret
insertion, the whole two-paragraph answer through the real clipboard, stable History rail
navigation, system-picker photo retention, owner isolation and pending-request restart. The current
rendered Routines readiness measurement is 1,436 ms; completed lifecycle runtime scans contain no
ANR or fatal exception. First-party events and the controlled local Sentry draft-fault receipt are
verified with task 37. Hosted delivery and public-release acceptance are not claimed.

The capture recipes wait for exact native input echo before sending or navigating. Their History
group uses three asks per fresh appearance account, preserving the server's burst limit. The private
packet keeps interrupted runs and the unproven input-precondition failure outside complete
acceptance; later passing input checks are not a product-fix claim.

## Acceptance observations

Native input injection needs a semantic echo before the next action. The recipes enforce that
condition without repairing or retrying text. The actual EditText can have a separate Question
semantics wrapper, so native selection assertions inspect the observed editor at the same bounds.

Retired emulator userdata dominates capture storage. Acceptance cleanup removes only AVD
directories whose processes have stopped while retaining APKs, screenshots, XML, traces, logs,
events and manifests. The local sign-in check also exercises a staged account recovering after an
unreachable sync hello and restart; its connection-level cause is unproven.
