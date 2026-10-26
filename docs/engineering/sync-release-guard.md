# Coordinated sync release guard

The backend image carries schema/minimum metadata generated from its composed registries. Deployment
reads that manifest from the inspected image content ID and the live anonymous hello before any
candidate migration, environment promotion or container replacement. Both server and migration use
that same immutable image ID. Automatic minimum changes refuse; manual changes require the exact
live and candidate minimums plus the expected image ID. Missing metadata and unavailable live state
refuse. A fresh host needs explicit minimum-zero acknowledgement.

Manual images must name a full commit reachable from main. Sentry's release identifies that selected
commit. Runtime acceptance checks the exact advertised schema/minimum and `426 upgrade-required`
at hello, push, pull and WebSocket upgrade for excluded schemas. Workflow failure output is static;
commands, environment values, credentials and response bodies are not exposed by the compatibility
helper. This operational flow has no product events or additional backend write route.

The current registry remains 7 / minimum 4. The explicit Other category's 8 / minimum 8 cutoff is
held until the coordinated replacement artifacts and upgrade availability are verified. The
[deployment runbook](../../backend/deploy/README.md#coordinated-client-cutoff) covers automatic web
deployment, TestFlight readiness versus tester access, Android publication, and the compatible
rollback floor. Android's approved equipment sheet does not approve new iOS or web pickers.

## Verification

- Deployment suite: 25 passed, zero failures or skips. It covers unchanged deployments, interrupted
  retries, credential preservation, missing metadata, unavailable live state, unapproved raises and
  lowers, mismatched acknowledgements/image IDs, explicit bootstrap, immutable server/migration
  identity, main ancestry, Sentry identity and the modeled 6/7 rejection at an 8 / minimum 8 cutoff.
- Auth environment render tests: 2 passed, zero failures or skips. Shell syntax, Python compilation
  and diff whitespace checks passed.
- Actual Docker Compose configuration resolves server and migration to the same content ID.
  Local Docker daemon access timed out; container creation/promotion is covered by the modeled
  lifecycle tests, not a live local Docker deployment.
- The production helper made five real requests through curl to the existing 7 / minimum 4 backend
  on isolated port 8108 and a disposable Postgres database: current hello returned 200; schema 3
  returned `426 upgrade-required` at hello, POST push, POST pull and WebSocket upgrade. The server
  stopped and the database was removed. The binary came from the verified sign-in worktree; this
  prerequisite changes no C++ code or registry. Actual schema 6/7 refusal against 8 / minimum 8 is
  a Task 20 candidate and final-cutover gate, not claimed here.

Review found and corrected manual-image ancestry and Sentry attribution. The simplification pass
removed the hardcoded schema-6 readiness path and grouped metadata, preflight and transport checks
in one deployment helper. No general rollout service or engine API is introduced. A production
cutoff has not been performed by this change.
