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

Source and production advertise schema 11 / minimum 11 after deployment `40873633845`. Digest resum
`41101251226` completed across three scopes and corrected two digests. Web promotion `41101256320`
serves verified source `667bbc88`. Read-only run `41117835993` verifies iOS 0.2.0 (23) availability in
one established internal beta group with two testers. Android 0.13.0 and the coordinated iOS
replacement remain pending. The
[deployment runbook](../../backend/deploy/README.md#coordinated-client-cutoff) records the exact local
schema-11 queued-delivery proof, its production/current-client qualifications and the compatible rollback floor. Approved Android equipment controls do not approve new iOS or web pickers.

Each replacement sender requires a fresh hello for its current owner, token, replica and epoch
before numbering or delivering work, with server schema at least its generated registry minimum.
Local edits remain queued while the server is below that minimum. Active Gym HTTP handlers enforce
the canonical Gym minimum before JSON, public-share JSON, private images or SSE can reach a legacy
client. Retired write routes retain410, OPTIONS retains CORS, and unknown or unmounted routes retain404.
MCP keeps its dynamic tool contract.

The deployment guard validates image metadata and exact live/candidate minimums before migration or
promotion. Candidate runtime verification must cover all four sync doors, current-header successful
Gym payloads and queued delivery after a fresh compatible hello. A passing mount/auth rejection
matrix does not prove successful payload decoding, nullable metrics or distribution availability.

Web promotion has its own fail-closed check under the same `deploy-vps` serialization. Its composed
client schema must be at least the live backend minimum, and the live backend schema must be at
least the client minimum. An anonymous hello runs inside the current server container without
changing the environment, containers, epoch or live web files. Missing, malformed or unavailable
compatibility produces a static `HOLD web deployment` failure before mkdir or rsync. Build and test
steps still run; a source merge cannot promote an incompatible web client.

Before that check, Web Deploy retains the complete `dist`, composed compatibility metadata and a
release manifest with the full source SHA and every file's size/SHA256. The artifact name includes
the source, workflow run and attempt, so retrying a held run retains its earlier candidate. The
release still requires current native lifecycle acceptance and replacement availability. Task 25's
local schema-11 queue proof is retained with the runbook's exact source/APK/backend pins. Public hello
and served-artifact checks verify deployment compatibility; no production queued-write delivery is
claimed. An artifact or passing compatibility check alone proves neither delivery nor native availability.
