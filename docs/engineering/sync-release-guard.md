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

The source registry is 10 / minimum 10. Production's last verified backend is 8 / minimum 4;
web's deployed schema 9 does not change that backend receipt. The coordinated cutoff remains held
until replacement Android/iOS artifacts and upgrade availability are verified. The
[deployment runbook](../../backend/deploy/README.md#coordinated-client-cutoff) covers independent web
deployment, TestFlight readiness versus tester access, Android publication and the compatible
rollback floor. Approved Android equipment controls do not approve new iOS or web pickers.

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
No production cutoff is performed by the shared-load source change.

Web promotion has its own fail-closed check under the same `deploy-vps` serialization. Its composed
client schema must be at least the live backend minimum, and the live backend schema must be at
least the client minimum. An anonymous hello runs inside the current server container without
changing the environment, containers, epoch or live web files. Missing, malformed or unavailable
compatibility produces a static `HOLD web deployment` failure before mkdir or rsync. Build and test
steps still run; a source merge cannot promote an incompatible web client.

Before that check, Web Deploy retains the complete `dist`, composed compatibility metadata and a
release manifest with the full source SHA and every file's size/SHA256. The artifact name includes
the source, workflow run and attempt, so retrying a held run retains its earlier candidate. The
coordinated cutoff verifies native upgrade availability, performs the acknowledged backend cutoff,
then retries the compatible web promotion and proves queued delivery. An artifact or passing
compatibility check alone proves neither that delivery nor production availability.
