# Android implementation

The [Android task backlog](../../androidgym_tasks/README.md) ships one commit per task, in dependency
order. Visual work requires the task’s human-approved Figma state. A batch reaches main after
adversarial review, simplification, targeted checks and native/local-stack acceptance.

## Task 06 — set semantics

The app model, rack acceptance, performed rows and saved-workout recovery have no set-kind API or
control. Every set contributes to counters, totals, history, last-time prefill and early-finish rules.
Legacy kind fields are ignored when decoding; new set writes omit them. Shared compatibility vectors
remain unchanged. Debug source/test compilation, the shared domain corpus and affected unit tests pass.
Debug and Release real-wire suites each pass all 17 cases with zero skips against the local
backend, with structured write observations present. Installed native and telemetry batch
acceptance are pending.

The simplified rack has one acceptance path for every logged set. Recovery retains source documents
for retry without a separate kind-correction state. Wire summary fields retain their existing names;
they count every set. The app still contains history/read projections alongside the shared domain;
future consolidation should preserve the shared estimate qualification and equipment-load rules.

## Task 12 — logging above plan

Movement navigation has no heavier-than-plan offer or implicit routine write. The logger retains
only the movement-transition guard and closes an active sheet before choosing the next movement.
Routine-editor saves and accepted Coach proposals remain the explicit routine-write paths. The
workout regression asserts unchanged routine content and revision, no dialog or transient message,
and one content-free set event per logged set. All 156 targeted tests pass with zero skips. The full
gym Debug unit suite passes 1,161 tests with 17 opt-in live-wire cases skipped. Installed native and
telemetry batch acceptance are pending.

The logger no longer coordinates offer state with movement state. Removing the isolated retarget
API leaves the guarded routine draft save as the editor’s one write path. Proposal comparison rows
are private to their remaining screen.

## Task 13 — routine-only app starts

App starts require a routine ID. The action decision checks the loaded routine and open-workout state
atomically before creating a workout, while a repeated session identity remains idempotent. Routines
has no free-start action, and receipts have no routine-save form or callback. Externally started
workouts and legacy imports retain the optional routine format, existing movement picker and
shared **Free workout** title. All 233 targeted tests pass with zero skips. The full gym Debug
unit suite passes 1,148 tests with 17 opt-in live-wire cases skipped. Installed native and telemetry
batch acceptance are pending.

Receipt state is keyed by the workout's session ID. Removing receipt-created routine identities,
first-workout flags, name drafts and save guards leaves one purpose for the receipt: read the saved workout and offer
its existing Coach action. App-start tests use explicit routines; external/import fixtures enter
through the engine boundary and exercise adoption separately.
