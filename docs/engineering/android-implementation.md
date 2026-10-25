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
