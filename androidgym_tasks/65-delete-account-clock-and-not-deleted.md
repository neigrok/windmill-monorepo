# Delete account: an honest wrong-clock refusal (27h) and a way out when nothing was deleted (D6)

**Status:** 🚧 **Pending owner approval.** The boards are 🚧 In progress; do not build the visuals until they are ✅ Ready for dev. The logic below that needs no new copy is already on main (task 48's fix pass).

**Figma** (Shell file, Android page):
- 27h Couldn't delete, date and time: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=139-2733) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=139-2786), caption `139:2838`
- D6 Not deleted: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=139-2867) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=139-2896), handoff notes `139:2895` / `139:2924`

**Current implementation** (`platform/.../you/AccountDeletionStore.kt`, `DeleteAccount.kt`)
- **Clock refusals:** a close answered 409 `clock-ahead`, or 404 `unavailable` for a request stamped more than 5 minutes ago, clears the pending record and returns to Confirm. The sentence it shows is `AccountDeletionStore.clockSentence`, a placeholder equal to the connection sentence ("Check your connection and try again"). That sentence is false here.
- **Re-send inside the window:** inside the 5-minute admission window, Check deletion re-sends the identical close.
- **D3 dead end:**
  - Outside the window, when the receipt read answers `unavailable`, the phone stays on D3 ("We can't confirm the result") with the account fence up.
  - That happens even when the server never received the close and the account is live.
  - Only clearing app data gets out; native acceptance reproduced it on 2026-10-31 (airplane mode, Delete, wait more than 5 minutes, back online, Check deletion).

**Change (once approved)**
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
