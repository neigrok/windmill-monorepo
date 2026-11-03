# iOS · review-wave parity

The Android review wave (D1–D7; `androidgym_tasks/design-brief-review-wave.md`) mirrored to iOS. Every board is 🚧 and waits for the owner; no task is built. The iPhone app targets iPhone only (`apps/ios/App/project.yml` `TARGETED_DEVICE_FAMILY: "1"`), so the large-screen boards (Android 00.9, 00.10, 02.27, 03.52, 03.53) have no iOS twin. iOS has no Target summary row (`Gym/Routines/RoutineTargets.swift`), so Android 02.26 has none either. Routine names may show on the lock screen; no iOS board says otherwise.

| Task | What | Boards |
|---|---|---|
| [rw-01](rw-01-no-sync-in-the-workout.md) | Nothing about sync in the workout or on log rows; no update alert mid-workout | none needed |
| [rw-02](rw-02-sync-behind-you.md) | The identity status and Not synced yet | Shell iOS 16f–16n |
| [rw-03](rw-03-account-button-sync-dot.md) | The account button's sync dot | Gym iOS 00.11 |
| [rw-04](rw-04-faint-ink-contrast.md) | Gym faint ink passes 4.5:1 in Dark | library `dark/ios/gym/ink-faint` |
| [rw-05](rw-05-coach-links.md) | Links in Coach answers | Gym iOS 08.66, 08.67 |
| [rw-06](rw-06-share-beside-copy-link.md) | Share beside Copy link | Gym iOS 05.23–05.25 |
| [rw-07](rw-07-rows-by-their-number.md) | Rows by their number | Gym iOS 03.24b, 03.25b |

The dogfood tree holds one node per task under **iOS · review-wave parity** (`ios-review-wave-parity`).
