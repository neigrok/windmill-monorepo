# Remove remaining Android app-layer set-kind controls and filters

**Approved flow:** [Workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — ✅ Ready for dev, human-approved 2026-10-25. The compact ledger is headerless and has no kind control. Fix set (10) and import recovery (25) follow the same all-set semantics.

**Implementation status**
- App-layer set kinds, filters and controls are removed. Legacy saved kind fields decode without losing sets; new set writes omit the field.
- The shared sync model and legacy-input compatibility vectors remain unchanged.
- Debug source/test compilation, shared domain vectors and affected unit tests pass. Debug and Release real-wire suites each pass 17 cases with zero skips. Native batch acceptance counts eight routine sets and four imported legacy-kind sets without a kind control; first-party events and structured writes are verified. See [implementation status](../docs/engineering/android-implementation.md).

**Change**
- Remove the remaining app-layer `SetKind` plumbing, its serializer, kind filters, *W* ledger index, warm-up spoken prefix, raw kind notes, Record suffix and `warmupInk`. Count every set in volume, top set, records, last time, early-finish decisions, comparisons and routine-derived reads.
- Update the engine-to-UI adapter and store signatures to the simplified app model. Preserve decoding of existing saved/local recovery data by ignoring legacy kind fields; do not restore `kind` to the sync model or write `"working"` into new wire data.
- Reuse the already-shipped shared semantics and compatibility vectors. Change a fixture only if a separately demonstrated contract defect requires it; do not remove old-kind fixtures merely because the app no longer exposes kinds.
- Recovery has no kind picker or correction requirement. Task 25 owns the remaining import UI redesign.

**Out of scope:** rebuilding the completed shared-domain migration; the rack layout (09), Fix set layout (10), import UI (25) and Record copy (21).

**Done when**
- No app-layer `SetKind` API, filter or UI control remains; legacy input still loads and imports without losing sets.
- Totals, e1RM, records, last time, early-finish decisions and comparisons use all sets and preserve existing equipment load-count rules.
- Run the existing shared compatibility vectors and affected Android domain/store/UI tests. Add only missing regression cases for legacy local recovery input and adapter parity; keep the old-kind corpus cases.
- `gym_set_logged` and `gym_session_finished` retain their bounded event contracts. Unexpected load/import/write failures still use the existing static operation names; no kind or set contents are added to telemetry.

**Depends on:** none.

**Ledger:** 9c; dogfood `android-gym-target-page`.
