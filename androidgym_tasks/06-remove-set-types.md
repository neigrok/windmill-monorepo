# Remove remaining Android app-layer set-kind controls and filters

**Approved flow:** [Workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-28036) — ✅ Ready for dev, human-approved 2026-10-25. The compact ledger is headerless and has no kind control. Fix set (10) and import recovery (25) follow the same all-set semantics.

**Today**
- The shipped Kotlin sync model in `apps/android/gym/domain/src/main/kotlin/works/windmill/gym/domain/sync/Training.kt` already omits `kind` from `TrainingSet`, decoding and writes; volume counts every set. `store/EngineTraining.kt` already omits it on writes and supplies `SetKind.Working` only when adapting to the older app model.
- Remaining drift is in `apps/android/gym/src/main/kotlin/works/windmill/gym/`: `domain/Training.kt` still defines `SetKind`, serializers, `TrainingSet.kind`, `SetFix.kind` and kind filters; `TrainingStore.logSet` accepts a kind. `LiveSession`, Record, logger, Fix set, workout detail, Finish and recovery UI still read those app-layer properties.
- Shared vectors contain legacy `warmup` / other kind input deliberately to verify compatibility. Their presence is not an unfinished sync migration.

**Change**
- Remove the remaining app-layer `SetKind` plumbing, its serializer, kind filters, *W* ledger index, warm-up spoken prefix, raw kind notes, Record suffix and `warmupInk`. Count every set in volume, top set, records, last time, early-finish decisions, comparisons and routine-derived reads.
- Update the engine-to-UI adapter and store signatures to the simplified app model. Preserve decoding of existing saved/local recovery data by ignoring legacy kind fields; do not restore `kind` to the sync model or write `"working"` into new wire data.
- Reuse the already-shipped shared semantics and compatibility vectors. Change a fixture only if a separately demonstrated contract defect requires it; do not remove old-kind fixtures merely because the app no longer exposes kinds.
- Recovery's kind picker and copy leave with 25. Coordinate that removal so import fix/retry never needs a kind choice.

**Out of scope:** rebuilding the completed shared-domain migration; the rack layout (09), Fix set layout (10), import UI (25) and Record copy (21).

**Done when**
- No app-layer `SetKind` API, filter or UI control remains; legacy input still loads and imports without losing sets.
- Totals, e1RM, records, last time, early-finish decisions and comparisons use all sets and preserve existing equipment load-count rules.
- Run the existing shared compatibility vectors and affected Android domain/store/UI tests. Add only missing regression cases for legacy local recovery input and adapter parity; keep the old-kind corpus cases.
- `gym_set_logged` and `gym_session_finished` retain their bounded event contracts. Unexpected load/import/write failures still use the existing static operation names; no kind or set contents are added to telemetry.

**Depends on:** none.

**Ledger:** 9c; dogfood `android-gym-target-page`.
