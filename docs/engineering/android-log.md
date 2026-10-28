# Android Log

The Log is a newest-first sequence of finished workouts, date-keyed weights and selected decorative
record/month markers. Weight chronology retains the selected local date and a nullable validated
clock; it never uses an epoch or fabricated midnight for unknown provenance. Within one local day,
date-only facts follow timed entries; exact instant ties order workout, marker, weight, then identity.
Paging bounds decorative moments without hiding older weights.

Both marker and gold-dot decisions use the shared ProgressRecords projection. The marker states a
record once and opens its exact workout point directly. Cards keep all-set facts and valid time;
month summaries have no interaction. The native monitor_weight and existing Figma chevron assets
serve their approved row/FAB slots. The native Extended FAB uses the shared opaque accent tint over
the card surface. It is in the content overlay, so the list owns its clearance and there is no extra
backing panel.

Workout swipe requests the existing room confirmation and resets without mutating the row. Its
accepted local receipt owns removal. Weight swipe enters the same durable engine hold used by
Bodyweight, with the existing room Undo projection. The Share wrapper has only one caller, the Log;
its bounded result instrumentation is separate from Finish's Share-with-Coach receipt path.
A seat/revision-owned scope and final owner/revision/store-seat checks abandon late Share replies,
including replies that ignore cancellation across an account round trip. Clipboard failure reports
one static gym.share failure and leaves retry available; refusal creates no Issue.

The simplification pass removes expanded moment state, inline chart/sparkline rendering, the old
full-width WeighInChip, device-only row copy and the duplicate per-movement record calculation.
The read model holds time provenance explicitly instead of using a sentinel instant.

Read-model, row, sharing, navigation and restoration checks pass, including delayed Share account
replacement and round-trip replies, clipboard failure/retry, legal epoch/pre-epoch times, nullable
serialization and independent weights. The composed capture-tool suite passes 31 cases.

Installed Dark/Daylight acceptance covers ordinary Log, record, empty, confirmation and weight Undo
states. The 320 × 640 dp double-text Log wraps its full long title, keeps time readable and leaves
the final row above the FAB. Confirmed discard reaches the server. The accepted combined evidence
retains each source/APK/fixture qualification; it does not claim a single pristine whole run.
Legacy null timestamps remain unit/restoration coverage; native backdated saves use legal recorded
timestamps and render without an invented clock. First-party events contain bounded labels only.
Deterministic failure tests and installed SDK session receipts are separate verification boundaries.
