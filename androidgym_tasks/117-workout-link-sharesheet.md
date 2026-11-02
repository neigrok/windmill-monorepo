# System share sheet for a workout link

**Status:** Reviewed, with one fix pass applied; `:gym` and `:app` unit tests are green. The chooser carries the link alone; a phone with no share target shows the approved 05.24 caption sentence and files no Issue; a copy that succeeds announces *Link copied*. At 320 dp and 200 % text, *Copied* breaks mid-word (*Copie / d*), recorded below for the designer. Not yet verified: the native Sharesheet on a device, TalkBack, live telemetry, and a comparison against boards 05.23 and 05.24 before they are marked 🚀.

**Context:** the live workout link has separate Copy link and Share actions. Sharing sends only the link through Android's chooser, without a routine name or other workout content.

**Figma:** 05.23 [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30064) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30158); 05.24 [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30252) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1850-30330).

**Current implementation**
- `sharing/WorkoutSharing.kt` exposes the Live card's Share label, chooser title and shared failure note. A share failure preserves the live link and its copied flag; a successful share clears only the share failure note, preserving a revoke failure note.
- `sharing/WorkoutShareCard.kt` owns the clipboard and synchronous activity boundaries. Copy is tonal on the left; Share is filled on the right, with equal widths, equal intrinsic heights, a 56 dp minimum and a 12 dp gap. Each centered label fills the button’s content width so its measured bounds and text-layout semantics use the same width. Other states retain the single action.
- The chooser wraps `ACTION_SEND`, `text/plain`, with exactly `EXTRA_TEXT` on the send intent. `ActivityNotFoundException` emits `session/share_link/unavailable` without an Issue. Other launch exceptions report `gym.shareLink` and emit `failed`. Both use the approved sentence “Sharing isn't available here. Copy the link instead.”
- A successful copy changes the visible label to “Copied” and exposes “Link copied” through a polite live region tied to the live state’s copied flag.
- `session/copy_link` records clipboard outcomes; `session/share_link/ok` means the chooser opened, not that someone received the link. `log/share` remains the long-press copy action.
- Tests exercise the production composable, exact intent payload and telemetry, clipboard failure/cancellation, action visibility across mint/revoke, large-text layout at 320/412 dp, and pure state preservation.

**Done when**
- Native acceptance confirms the chooser, unavailable path, bounded telemetry and spoken action order.
- The orchestrator accepts or schedules the recorded design drift before marking the boards 🚀 In production.

**Open**
- Caption telemetry drift for the D6 ledger: 05.24 caption `I1850:30413;1112:112` specifies `share_sheet/opened` and failure `gym.share`. The binding schema uses `gym_action session/share_link` with `ok`, `unavailable`, `failed`, and failure `gym.shareLink`. Caption copy and the 05.23 polite announcement are implemented.
- D6 ledger handoff: when the design brief's 11z lands, replace its “still offers Copy link only” claim with the implemented pair and retain the drift below. `docs/design/consistency.md` is outside this package by binding decision.
- Pre-existing 05.23 drift outside the action row: Revoke uses 15 SemiBold / at least 48 dp versus Bold 16 / 56 dp; body 16/21 versus 15/22; block gaps 12 versus 14; link padding 12 versus 16×10; bottom inset 20 versus 40; Daylight link ink primary #137A6C versus text/link #106B5F.
- QW12 / task 87 designer item: at 320 dp and 200% text, “Copied” breaks mid-word into `["Copie", "d"]`. “Copy link” wraps between words as `["Copy ", "link"]`; “Share” stays `["Share"]`. The regression test pins these measured lines. Keep the approved equal-width row; a design change belongs to the designer.
- The approved 05.23 buttons have zero vertical and 24 dp horizontal padding in both themes. The boards show default text size; visual comfort at 200% belongs to the large-text designer review.
- The card's remembered state does not survive recreation; rotation can offer another mint. This remains follow-up work.

**Structure observation:** the card owns each device boundary directly and the pure model owns the action availability. Centered labels explicitly fill their content width; no extra height, layout state or measurement callback is needed.

**Depends on:** approved 05.23/05.24 action-row and chooser designs. Tree: `android-task-117`.
