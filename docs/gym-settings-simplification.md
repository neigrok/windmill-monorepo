# Gym settings simplification verification

Web Gym settings contains weight units, Notes, and the available data exports. Connection setup
belongs to the shared `/app/connect` page; Coach’s connection links lead there. The legacy
`#/gym/connect` route replaces itself with shared setup for both visitors and signed-in accounts.

Units writes preserve stored rest duration, rest sound, confirmation haptic, and confirmation sound
because the backend replaces the complete preferences document. Their native features and wire
fields remain intact. `restLabel` remains available to the live mirror and proposal displays.

## Verified locally

- The scoped settings, GymApp, screen, log, and Coach tests passed: 165 tests, zero failures or skips.
- Rendered settings assertions cover the complete section text and its only preference controls,
  kilograms and pounds. A units save preserves all native preference fields, including a custom
  rest duration. Delayed replies and rejected writes retain the correct confirmed unit.
- Legacy route tests cover plain, trailing-slash, and query-bearing hashes for visitors and members,
  through direct entry and navigation from Coach. Replacement followed by Back reaches `/app` or
  the original complete Coach URL without a loop.
- Browser verification confirmed the public legacy URL redirects to shared Connect and Back reaches
  `/app` without a loop.
- Marketing screen assertions still cover the retained exchange, prerequisite, and read/write/delete
  copy on Gym’s landing page. Coach assertions cover the shared setup destination under both limits.

The full workspace build reached 1,718 passing tests out of 1,719, then failed an unrelated
brand-root assertion in `shell-boundaries.test.mjs`: it expected `/roadmap` and received
`#/app/start` amid concurrent marketing changes. The isolated staged snapshot passed
`npm run build`: all 1,684 tests passed with zero failures or skips, followed by successful Vite
and landing-shell builds. Automatic approval review blocked signing into a disposable local test account because
explicit authorization for that login was absent. No authentication workaround was used. Signed-in settings behavior is covered by component
tests; it has not been verified in that browser session.

## Structure observations

The shared Connected tools section owns the account’s grants. Gym settings performs no duplicate
grant or key fetches. Removing the separate connection page also removes its state projection,
label helpers, and styles. The three constants still used by marketing live directly in GymLanding.

The units row has one consumer, so its row and choices markup is inline. Complete preference
serialization remains separate because it expresses the backend document contract. Legacy routing
uses the shell’s existing replacement navigation and does not introduce another return stack.

Baseline snapshots and diffs for touched files are saved at `/tmp/windmill-gym-settings-baseline`
to separate this work from pre-existing Gym changes during staging.

The designer aligned `docs/design/gym/briefs/19-connected-log.md` with the shared setup route.
That existing untracked brief remains untracked to preserve its owner’s work.
