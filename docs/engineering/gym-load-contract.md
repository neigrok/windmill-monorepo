# Gym loads and unavailable metrics

The composed source registry is 10/minimum 10. Gym loads have no fixed kg bound. A load must be a
finite Double on its normalized cent grid; exact zero is valid, while an absent routine target still
means last time. Reps, set counts, bodyweight and configured movement steps retain their own bounds.
The [coordinated cutoff](../../backend/deploy/README.md#coordinated-client-cutoff) remains held until
the replacement Android/iOS distributions and upgrade access are verified.

## Normalization and storage

The [engine number contract](../foundation/engine.md) preserves a canonical JCS decimal already on
the grid of an actual exact reciprocal scale `10^d` for `0 ≤ d ≤ 22`. Other finite values retain the shared
IEEE half-away rounding. Reciprocal scaling overflow preserves the original finite input because
its representable spacing exceeds the quantum. Results must remain finite, and negative zero
normalizes to positive zero. Repeating normalization does not move a stored load.

Only `gym_routine_entry_sets.weight_kg`, `gym_sets.weight_kg` and revision load storage use
unconstrained numeric. Live targets and sets retain finite/cent admission; revisions retain historical
facts. The sync projection inserts canonical JCS numeric text. Ordinary REST/Coach JSON carries 17
significant digits so every finite Double round-trips exactly; client readouts own human formatting.
Full-width JSON integers retain their integer encoding.

## Derived metrics

Volume remains external load: `max(load,0) × reps × effective historical load count`. Every complete
session, movement, range or whole-history aggregate folds its own flat constituent sets in canonical
set-ID order. Each surface retains its existing set eligibility rule. Each multiplication and each left-to-right addition is checked. A required unavailable
contributor or nonfinite operation makes the whole aggregate explicit null. Empty aggregates are
zero. Negative assistance never cancels positive work. SQL does not rescue a Double overflow with
a numeric sum or a partial total.

Estimate eligibility is independent of display availability. Exact ordering uses canonical
normalized decimal-cent digits, multiplication by 30 or `30 + reps`, and a bounded exponent with virtual
zero comparison. It uses no fixed-width score multiplication or platform-specific extended float.
An otherwise eligible unavailable historical estimate prevents a smaller unsupported record claim.
Raw performed facts remain intact. Existing unavailable metric slots render the unavailable state.

## Compatibility and input

Every bound sender obtains a fresh hello for its current owner, credential, replica and lifecycle
before numbering or delivery. The advertised server schema must meet the generated registry minimum,
and the captured local server epoch must still match the numbering transaction. A concurrent local
epoch recovery requests another hello; existing push/pull epoch recovery stays in place. New writes
remain queued against an older server.

Active Gym HTTP routes require the canonical Gym minimum before JSON, SSE, private images or public
share JSON is delivered. Missing/old carriers return 426, malformed carriers 400. Retired write routes
retain 410, OPTIONS retains CORS, and absent routes retain 404. MCP keeps its dynamic tool contract.

Native signed decimal keyboards retain their minus key. The existing iOS load wheel uses a bounded
sliding neighborhood with distinct finite normalized ticks, preserves an off-grid opening value,
and never enlarges a configured step to fabricate movement. No new hint, sign control or workflow is
introduced. The Regular numeric responsive design remains unapproved and unimplemented.

## Structure and observability

The domain owns normalization, exact estimate ordering and checked volume reducers. Existing UI
readouts reuse those implementations. The shared JSON seam owns wire precision; no second serializer
or general decimal-magnitude API is introduced. Shared vectors pin ordinary behavior, extremes,
negative assistance, explicit zero versus absence, aggregate order and unavailable completeness.

Expected numeric refusals retain existing bounded outcome events. Unavailable arithmetic is data,
not a technical failure. Unexpected transport/storage/decode failures retain their static Sentry
boundaries; backend writes retain structured observations. Loads, raw buffers, metric values and
refusal text never enter telemetry properties. The surface observability documents name those seams.
