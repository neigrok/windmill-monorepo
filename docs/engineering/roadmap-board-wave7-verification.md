# Wave 7 end-to-end fixes

The nine requested corrections are implemented. Browser behavior and live telemetry delivery need
the orchestrator's outside-sandbox run; Chromium cannot launch in this sandbox. No git commands,
network installs, dogfood writes or Figma mutations were performed.

## Fixes

1. Status compares writes with server-confirmed fields, separately from socket coverage. Discard
   does not manufacture Saving, Saved or an online Offline episode. The composer keeps its draft
   and disables submission during discard and rebaseline.
2. **Production data-loss fix:** session expiry retains pending work and the previous device owner.
   Refresh and the 20-second poll pause the bound replica; the same account resumes it on sign-in.
   A different account and explicit sign-out keep their cleanup, including cross-tab sign-out.
3. Refusal copy counts user gestures. A create with prerequisites or a bulk completion
   counts once. Persisted field references preserve counts across retries, partial acknowledgements,
   reload and lane-specific discard.
4. Phone toasts are hidden while a refusal stands; a toast waiting to appear waits for the refusal.
5. Discard immediately projects the confirmed lane and bypasses Board regroup animation. A failed
   storage replacement restores the pending projection. Projection exceptions report without
   stranding the transaction or reconnect.
6. The desktop status slot reserves 280 px, keeping room links stationary as its text changes.
7. The phone Graph device line starts at the identity row's bottom with the Board's 16 px text inset.
8. Anonymous phone owners get the approved Sign in action with the gate open.
9. A registered room owns offline messaging before paint, including initial layout publication.

## Production changes

Session lapse handling changes in both gate states: it preserves device data, pauses authentication
without detaching the replica, and exposes the existing legacy lapsed signal. Same-document
confirmed device access survives a lapse; a fresh document still requires account confirmation.
Unexpected auth-session failures now carry a real stack to the existing Sentry boundary.

Gesture tracking is opt-in through `BOARD_OPEN`. Closed-gate sessions retain their legacy wire
coverage, save shape and dispatch exception behavior. Shared discard/epoch adoption projects its
confirmed state immediately and contains projection callback failures. Local rename/remap retains
gesture metadata when present. The shared room-status hook reconciles layout publications; the
global offline notice yields to registered rooms. Roadmap registration and the visual changes
remain gated. There is no new gate-closed Fork or other presentation change in this fix pass.

## Source and documentation files

Paths in this table are relative to the repository root.

| Area | Files |
| --- | --- |
| Auth and device ownership | `web/src/shell/auth/accountChange.js`, `web/src/shell/auth/AuthProvider.jsx`, `web/src/products/roadmap/routes.js`, `web/src/products/roadmap/persistence/LocalTreeRegistry.js` |
| Sync | `web/src/products/roadmap/sync/SyncSession.js`, `SyncStore.js`, `status.js`, `localTrees.js`; new `pendingWrites.js` in the same directory |
| Roadmap host and UI | `web/src/products/roadmap/SkillTreeView.jsx`, `skilltree.css`, `board/BoardToast.jsx`, `board/BoardView.jsx`, `board/StepComposer.jsx`, `ui/mobile/MobileChrome.jsx` |
| Shell | `web/src/shell/chrome/chrome.css`, `web/src/shell/roomStatus.js` |
| Current contracts | `web/src/products/roadmap/ARCHITECTURE.md`, `web/OBSERVABILITY.md`, `docs/design/consistency.md` |
| Verification log | This file |

## Existing tests edited

All paths below are relative to `web/test/`. Existing assertions change only where the requested
behavior changes or an acknowledgment fixture needs the real sent writes.

| File | Reason |
| --- | --- |
| `shell/auth/accountChange.test.js` | Separate 401 lapse from explicit sign-out; retain same-account and different-account rules. |
| `products/roadmap/deviceScope.test.js` | Retain same-document confirmed access on lapse without loosening fresh-document privacy. |
| `shell/auth/browser.test.js` | Global notice yields to every room registration; first-frame regression with real AuthProvider. |
| `products/roadmap/sync/SyncSession.test.js` | Expanded snapshots, immediate discard/rollback, callback failures, gesture counting, partial acknowledgements, legacy gating. |
| `products/roadmap/sync/SyncStore.test.js` | Immediate projection expectations and persisted gesture coverage. |
| `products/roadmap/sync/status.test.js` | Rebaseline status and real pending work in the preserved lane. |
| `products/roadmap/sync/localTrees.test.js` | Gesture history through repeated local rename and remap. |
| `products/roadmap/SkillTreeView.test.js` | Discard timing and quiet projection, status timing, bulk gesture integration. |
| `products/roadmap/SkillTreeView.sync.browser.test.js` | Exact-frame acknowledgment fixture, phone Sign in and device-line placement. |
| `products/roadmap/SkillTreeView.refusal.browser.test.js` | Exact-frame acknowledgment fixture; create with a prerequisite counts once; slow discard clears projection and stays quiet. |
| `products/roadmap/board/BoardView.notices.test.js` | Phone toast/refusal exclusion with a fixed clock. |
| `products/roadmap/board/StepComposer.test.js` | Blocked submission retains the draft and hides false save failure at 390 and 1440 px. |
| `shell/chrome/Shell.browser.test.js` | Navigation remains stationary through status changes at 744 and 1440 px. |
| `shell/roomStatus.test.js` | Layout publication reaches the consumer before passive subscription. |

New tests: `shell/auth/AuthProvider.test.js`, `products/roadmap/board/BoardToast.test.js`, and
`products/roadmap/sync/pendingWrites.test.js`. The auth tests exercise the actual browser engine
with deterministic I/O, including refresh, polling, same/different accounts, and missed sign-out
broadcasts. New browser assertions use DOM state, existing fixtures, fixed clocks where timers
matter, and the shared fail-fast helper. Geometry and first-painted-frame assertions remain
unverified until Chromium runs outside the sandbox.

## Verification results

`cd web && npm test` exits 1 because Chromium launch is denied by the sandbox. Every failure
block is a Chromium launch failure; the five cancellations are browser-file teardown timeouts.
There are no non-browser assertion failures. The three phases print these counts:

```text
ℹ tests 4476
ℹ suites 0
ℹ pass 3950
ℹ fail 521
ℹ cancelled 5
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 149003.342541

ℹ tests 40
ℹ suites 0
ℹ pass 40
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 28213.20825

# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1290.544542
```

`cd web && npx vite build` exits 0: `✓ built in 14.28s`. It reports a large-chunk warning.
The final host fixture phase-name check reruns `SkillTreeView.test.js`: 29 tests, 29 pass, 0 fail,
0 cancelled, 0 skipped, 0 todo. Focused sync tests also pass 150/150; the combined auth/UI check
passes 69/69. Browser and local-stack visual/event/Sentry assertions are not claimed as passes.

Full logs: `/private/tmp/board-w7-final-npm-test.log`, `/private/tmp/board-w7-final-build.log`, and
`/private/tmp/board-w7-auth-ui-final.log`.

## Structure and follow-ups

The simplification pass gives pending field coverage one owner, `pendingWrites.js`, shared by the
session and store. Discard projection uses one guarded notifier. Room publication owns the
before-paint reconciliation instead of adding connectivity rules to individual consumers.

Two limits remain explicit:

- Old blobs without gesture history recover surviving HLC stamps; overwritten historical gestures
  cannot be reconstructed. New tracked gestures retain their field references.
- The pre-existing wire retry uses actor frontiers. A newer accepted write, or one accepted chunk,
  can cause a retry to omit older rejected fields. The new status/count preserves the actual
  pending work. Transport recovery needs a separate protocol regression pass and is recorded in
  the roadmap architecture's Open work section.

Figma status changes and live-stack event/Sentry verification remain orchestrator-owned under the
standing brief. Approved visual references include 04.02 (`188:1585`, `383:18997`, `487:13523`) in
`HM4d8YWzJZg5clVRJKNuDr` and the owner-approved Wave 7 refusal/offline frames.
