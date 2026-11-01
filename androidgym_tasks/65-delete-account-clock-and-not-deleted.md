# Delete account: an honest wrong-clock refusal (27h) and a way out when nothing was deleted (D6)

**Status:** Built on branch `wave-65` (from the native wave), not on main. The owner approved the boards on 2026-11-01; 27h and D6 are ✅ Ready for dev and built. JVM and Robolectric tests cover every Done-when line; local-stack acceptance on an emulator has not run (see Open).

**Figma** (Shell file, Android page):
- 27h Couldn't delete, date and time: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=139-2733) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=139-2786), caption `139:2838`
- D6 Not deleted: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=139-2867) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=139-2896), handoff notes `139:2895` / `139:2924`

**Current implementation** (`platform/.../you/AccountDeletion.kt`, `DeleteAccount.kt`)
- **One send path:** `AccountDeletionStore.send` sends the operation's close and reads what a refusal proves. The store keeps the monotonic instant (`SystemClock.elapsedRealtime`) of each operation it stamps, in memory only.
- **27h:** 409 `clock-ahead`, or 404 `unavailable` for a send that left under 5 minutes after the stamp by that clock, clears the record, lifts the fence and returns to Confirm with `AccountDeletionFailure.Clock`: the 27h sentence (live region) and an inline **Date & time** text button that opens `Settings.ACTION_DATE_SETTINGS`. The typed email stays; **Try again** mints a new operation with a fresh stamp.
- **D6:** a 404 `unavailable` close with no such proof (a late send, or any send after a restart) reads the receipt. When the receipt read answers `unavailable` and the request is under 35 days old, the identical close is sent again; a 404 `unavailable` then clears the record, lifts the fence and shows `AccountDeletionPage.NotDeleted` (title and text in one polite live region). **Try again** opens a fresh 27a with an empty email; **Back to You** leaves. A 401 or a request 35 or more days old stays on D3.
- **Unchanged:** inside the 5-minute window Check deletion re-sends the identical close first; a committed close whose reply was lost ends on 27d through the receipt.
- **Events:** `account_delete` `outcome` `clock_refused` and `not_deleted`; `action` `retry` (D6 Try again) and `date_time` (with `outcome` `failed` when settings cannot open). Every refusal is a log line, not an Issue.
- **Tests:** `AccountDeletionTests` (8-minute-slow clock, clock-ahead, in-window 27h, offline then back past the window, restart then D6, 401 and 35 days stay on D3, lost reply ends deleted, Date & time events), `DeleteAccountTests` (27h at 200 % text in reading order with the settings intent; D6 lifts the fence and Try again opens an empty 27a), `WindmillApplicationTests` (a pending record fences gym writes and clearing it lets a weigh-in land without a restart).
- **Open:** native local-stack acceptance (emulator, airplane mode, clock moved 8 minutes back) has not run in this wave. Renders of 27h and D6 in both modes come from Robolectric, not the capture rig. If date settings cannot open, the tap only emits `date_time` `failed`; the boards draw no copy for that case.

**Change**
- **27h:**
  - The refusal reads *Your account wasn't deleted. This phone's date and time look wrong. Fix them, then try again.*
  - An inline text button **Date & time** opens `Settings.ACTION_DATE_SETTINGS`.
  - **Try again** (error colour) mints a new operation with a fresh timestamp; **Cancel** leaves. The typed email stays.
  - When it shows: 409 `clock-ahead`, or 404 `unavailable` while the session is accepted and the send left under 5 minutes after the operation's `requestedAtMs` by the monotonic clock.
- **D6:**
  - Title *Your account wasn't deleted*; text *The request didn't reach Windmill in time, so nothing changed. Your account works as before.*
  - **Try again** (filled, normal colour) opens 27a; **Back to You** (text button).
  - When it shows: the receipt read answers `unavailable`, and re-sending the identical close with the still-accepted session answers 404 `unavailable`. A real close signs out every session, so an accepted session proves nothing was closed.
  - Then clear the pending record and release the fence.
  - If the session is refused (401), or the request is 35 or more days old, stay on D3.
- **iOS:** sends the older close with no timestamp or pending record, so it can reach neither state. It takes both if it moves to the recoverable close (ledger 12o).

**Done when**
- 27h and D6 match in Dark and Daylight.
- Local-stack acceptance:
  - A phone clock 8 minutes slow shows 27h and leaves no fence.
  - Offline at send, back after more than 5 minutes, shows D6 and gym writes work again.
  - A committed close whose reply was lost still ends on 27d.
- `account_delete` events gain the bounded outcomes for both states; expected refusals file no Sentry Issue. Update `docs/ANDROID_OBSERVABILITY.md`.

**Depends on:** 48.

**Ledger:** 12o.
