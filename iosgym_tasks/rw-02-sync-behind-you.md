# Sync behind You: the identity status and Not synced yet

**Status:** Designed (🚧, awaiting owner approval); not built.

**Figma** (Shell file, iOS page, section 4d `278:5587`):
- 16f changes not synced yet: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5588) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5661)
- 16i sign in to sync: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5734) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5807)
- 16j update to sync: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5880) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-5953)
- 16k a change didn't reach the log: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6026) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6099)
- 16g Not synced yet: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6172) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6280)
- 16h sign in to sync: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6388) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6490)
- 16l refused only: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6592) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6681)
- 16m everything is on your account: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6770) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6850)
- 16n update to sync, the link didn't open: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-6930) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=278-7033)

**Context:** the iOS form of Android 16f–16n (owner-approved 2026-11-03 for Android). iOS already says the account's one status under the identity card; it now speaks the shared words and opens the screen that lists what has not reached the account and why.

**Current implementation** (paths under `apps/ios/App/Sources/`)
- `AppModel.swift` `identityStatus` (`:231`–`:237`): *Syncing paused · update Windmill*, *Syncing paused · sign in again*, *Backed up* or *Not backed up yet*, counting `engine.status.ready + sent`.
- `AccountSheet.swift` `identityRow` (`:464`–`:476`) draws it; the update row *Get the update* (`:395`–`:399`) and `UpdateFailure` in the bottom inset (`:460`) exist.
- No screen lists unsynced records or refusals; refusals are not shown in You.

**Change**
- Status line: synced *Backed up*; waiting *N changes not synced yet* (N = the rows Not synced yet lists); paused *Sign in to sync*; update required *Update to sync* (shown even with nothing waiting); a refusal *1 change didn't reach the log* (plural follows). With any of these the identity card is a NavigationLink to Not synced yet.
- Not synced yet (pushed in You's stack, back *You*): status card (offline *They sync when you're online. Nothing to do.*, otherwise *They sync as soon as the log answers. Nothing to do.*; *Sign in to sync* / *Update to sync* lead with their cause and pin *Sign in* / *Get the update*); WAITING · N rows (title; *Kind · when*: *Workout · Today, 19:10*, *Weigh-in · Today*, *Note · edited today*, *Routine · edited today*, *Weigh-in · deleted today*; *Yesterday*, then the date); DIDN'T REACH THE LOG rows (*Bench Press · 22.5 kg total × 5*, *Push A · Thu 22 Oct*, *Note · Knee*; the log's reason; *Dismiss* button and trailing swipe action, removing the notice only); empty state *Everything is on your account.* No Retry.
- A failed update link: *The link didn't open. Try again, or visit windmill.works.* above the button, announced once, no red.
- Copy and counts come from one pure model shared with Android's package 120 (`SyncStanding`), claimed by a vector in `packages/api-contract`.

**Done when**
- Each of 16f–16n matches in Dark and Daylight; VoiceOver reads the card as "Sam, 2 changes not synced yet, button".
- Dismiss removes one notice; the screen turns into 16m when the last item goes.
- Events, named in the app's schema with Android package 120: opening Not synced yet and each Dismiss, as bounded labels; `client_update_required` with `action=update source=you`; no titles or reasons sent. `docs/IOS_OBSERVABILITY.md` lists them.

**Depends on:** the engine's unsent count, which Android package 120 extracts. rw-01 and rw-03 follow this task. Tree: `ios-rw-02-sync-behind-you`, under `ios-review-wave-parity`.
