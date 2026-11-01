# Every release is accepted signed in, on production, with a dedicated test account

**Status:** Not started. Needs the owner to create the account and hold its mailbox. Process and tooling; nothing visual changes.

**Context:** release acceptance today runs signed out against production. Signed-in checks ran on debug-key builds against a local backend, and the README records that signed-in acceptance was not repeated on the published-key APK. Sync, Coach, sharing, sign-out and account deletion are exactly what a local stack cannot prove, so a release can break them for every signed-in person without anyone seeing it first.

**Current implementation**
- `apps/android/README.md`, CI and releases: production acceptance is signed out on the `Pixel_API34_Root` emulator. Signed-in acceptance used debug-key builds against a local backend, and "Signed-in acceptance was not repeated on the published-key APK."
- The coordinated release runbook (`backend/deploy/README.md`, Coordinated client cutoff, step 3) asks for the signed Android update and its delivery to be verified, but names no signed-in production check.
- No dedicated production test account exists. Sign-in is an emailed six-digit code (`door:"app"`), so an operator must be able to read that account's mail.

**Change**
- **Owner:** create one production account for release acceptance, on a mailbox the release operator can read. Keep its address and access outside the repository. The account holds only synthetic training.
- **Script:** add a signed-in acceptance checklist to `apps/android/README.md`, run on the finalized, published-key APK against production before publishing. Each step names what to observe:
  1. Install over the previous published release, which is already signed in to the test account. The account, the open workout and local work survive.
  2. Log sets online and offline, then reconnect. The server holds them (check with `gym_get_session` over MCP as the test account).
  3. A routine edit on web arrives live on the phone, and a phone edit arrives on web.
  4. Coach answers one question. Share a workout, open its public page, then revoke the link.
  5. Sign out with Keep, sign back in, and the kept work arrives.
  6. Sentry shows no new Issue from the release, and Amplitude shows the flow's events with no content.
- **Telemetry:** decide with the owner how this account's events stay out of product numbers (an Amplitude filter on its user id, for example), and record the decision in `docs/ANDROID_OBSERVABILITY.md`.
- **Runbook:** step 3 of the coordinated release requires this checklist, and the iOS release names the same account.
- Account deletion stays on a throwaway account made for that run, never the standing one.

**Done when**
- The owner confirms the account exists and the operator can read its codes.
- The checklist is in the README, and the next release (after 0.14.x) is published only after it passes. The release notes say it passed.

**Depends on:** none. Tree: `android-release-test-account`.
