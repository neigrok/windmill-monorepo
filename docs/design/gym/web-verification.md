# Gym web verification

The content proportion pass covers the 102 boards on [Web · Gym](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=466-132): 20 Plan, 42 Record, 14 Coach/Notes and 26 Share. Navigation is unchanged by instruction. The [build contract](web-build-contract.md) records board status; the [review](web-parity-review.md) and consistency ledger F59 identify the protected navigation differences. Content acceptance does not establish complete screen parity.

## Local verification

The full `npm run build` passes 1,832 tests with zero failures or skipped cases, builds the Vite bundle, and emits the three asserted landing shells and sitemap. Independent developer reviews and a simplification pass cover the changed code. Fixes cover switching between directly opened proposals, chart endpoint clipping, decimal and negative numeric fields, intermediate-width metadata, narrow totals and Save/Undo overlap. Notes and Progress presentation live with their features.

The browser matrix uses local PostgreSQL, the rebuilt backend at port 8088 and Vite at 5173. Every board has a state assertion and a render at its exact Figma dimensions in Instrument and Daylight, except the two explicit Daylight boards: 202 primary comparisons. Additional bottom-scroll captures check long forms. There is no horizontal viewport overflow. Deliberate stale-save 409 responses, anonymous account-probe 401 responses and revoked-link 404 responses are distinguished from unexpected browser errors.

Browser checks cover routine creation, set ladders, Copy-down, stale-save refusal with retained drafts, proposal Apply/Turn this down, Notes edits, correction Saving states, invalid-load refusal without a write, overlap refusal, past-workout saving, share preview/create/anonymous reads/revoke, date filters and dense history. Temporary records are deleted and shared fixtures are restored. Model requests are blocked.

Boundary checks cover 320px and intermediate widths including 801px and 903px. They verify 62.5 and −125.5 numeric fields, metadata containment and large saved totals. Native Backfill time editing changes 17:20 to 18:20 through ArrowUp; blur restores the 24-hour label, and a real save persists 18:20–19:20 in the API. A separate real pointer click on Save, with Undo visible at 390×844, persists the expected eight sets and timestamps. The generated sessions are deleted. Hit testing confirms Save remains reachable at 390×1292, 390×844 and 320×844, including after scrolling.

A baseline comparison at 1440px and 390px confirms unchanged shared-header and bottom-navigation geometry, type, colors and labels.

## Fixture and reference discipline

The history account has eight workouts, 30 working sets, 234 reps and 10,560kg external volume. Its Coach conversation uses deterministic stored data. Correction, past-workout variants, planning and density use separate accounts; no production account is modified.

The density fixture has 982 workouts, 2,952 sets and 22,638 reps; its 2024 scope has 366 workouts, 1,098 sets and 8,418 reps. Visible history rows and the selected 16-set workout reproduce the drawings. Fixture values, native editing affordances, focus/hover states, account identity and font antialiasing are distinguished from layout defects.

Fresh 1× Figma references exist for every board in both modes. Temporary mode overrides are restored after export. Reference corrections reconcile conflicting form variants, actual disabled states, active filters, consistent history rows and retained capabilities. Navigation fingerprints, board dimensions and status tags are preserved. The 62 Ready / 40 Built status split remains because the protected navigation gate is unresolved.

## Release verification

The deployed frontend is `aa78df1d72996f48142e42a4e9ea6a6275b1436a`, from successful
[Web Deploy 36184185479](https://github.com/neigrok/windmill-monorepo/actions/runs/36184185479).
CI passes the same 1,832 tests without failures or skips. The live HTML loads
`index-QB8Ziw9N.js`, which carries that release, and `GymApp-BqeZNxWz.js`.

All 202 primary comparisons pass again using those deployed frontend bytes with isolated local
fixtures. There is no horizontal overflow or unexpected browser error. The shared header and
bottom-navigation baseline match at both widths. Asset digests and per-capture geometry are
recorded alongside the images. Of the 202 primary screenshots, 188 are pixel-identical to the
reviewed local build. Independent review classifies the remaining 14 as six tiny rasterization
differences, four dynamic workout-start times and four generated share-link tokens; none is a
deployment regression. Production telemetry is blocked in the local fixture harness.

Separate read-only checks on the live site verify anonymous missing-link rendering at 1440px and
390px, an unauthenticated private-history 401 and a missing-public-link 404. These add no production
data. The complete fixture matrix verifies the deployed frontend against a local backend; it does
not claim an authenticated production-account test.

## Evidence

Local scripts, capture metadata and images are in `/tmp/gym-parity-2026-09-25`. The matrix scripts are `matrix-plan.mjs`, `matrix-record.mjs` and `matrix-coach-share.mjs`; `matrix.ndjson` records the captures. Independent findings are in `review-plan.json`, `record-acceptance.json` and `review-coach-share.json`. The comparison gallery pairs each reference with its runtime capture. The final build output is `build-release.log`. Release evidence is `production-smoke.json`,
`production-assets.ndjson`, `production-matrix-acceptance.json`,
`production-visual-comparison.json` and `production-independent-review.json`. The Figma bounds, navigation roots, modes and unchanged
status tags are verified in `reference-acceptance.json`.

The backend and native source trees are unchanged in this pass. Their separate release and platform follow-ups remain outside this frontend acceptance.
