# Edit movement and coordinated Other compatibility

Task 20 uses one pure `EditExercise` action on Kotlin, Swift and JavaScript. The opening value pins
the fields the person saw; the action guards only changed fields, treats equipment/count as one
loading pair and writes one Batch. The accepted value is returned directly from that transaction.
A subsequent catalogue refresh cannot turn a committed save into a false failure. Android checks
the opening account, replica and anonymous/bound state inside the commit boundary; the observer
refreshes presentation only for the current owner.

The Android editor uses the approved three-choice control, with exact existing Barbell/Dumbbells
glyphs and the exported selected check. Fields use native Roboto 16/24 text and 12/16 labels, scoped
to this form. Other is text-only. Selecting the original displayed choice
retains legacy raw equipment/count, so a name-only edit cannot migrate history. The existing Record
trigger and draft-presence callback remain. The approved iOS compatibility state adds no picker
choice or target sign button; Other uses kg and the signed native load/Fix wheel, without an icon
or explanatory field footer. Web preserves Other reads and includes only positive loads in e1RM.

## Compatibility and deployment

Both source registries are schema 10 / minimum 10 and retain the additive Coach records. Explicit Other is
accepted by the backend parser, database checks, generated schemas and all shared domains. Legacy
records are retained without coercion. The conditional database upgrade widens the two existing
checks once; an unchanged reapplication keeps their identities and every existing trigger.

The deployment compatibility guard and Android fresh-hello delivery gate are on main. Production
cutoff remains held until the coordinated Android/iOS replacement artifacts and their distribution
availability are verified. Android keeps queued writes ready against a server below its registry
minimum. Existing iOS/web selectors cannot originate Other. Any rollback after Other data exists
must retain Other, finite unbounded loads and nullable metrics at schema 10 / minimum 10.

## Verification

- Android gym Debug: 1252 cases, zero failures, 17 opt-in LiveWire cases skipped. Release
  exercised the same 1252 cases; its three outdated sheet/observer expectations are corrected and
  the six affected cases pass on repeat. Exact XML archives distinguish the full and focused runs.
  The final field geometry/typography passes 12 focused UI cases. Telemetry policy passes all six
  cases in both Debug and Release, including every accepted edit outcome and invalid-label refusal.
- Shared Kotlin domain: 79 tests; 729 cases in 13 implemented corpus files, with 33 explicit
  server-owned Coach files not applicable and no unclaimed file.
- Swift GymDomain: 156 tests in 16 suites; generated Coach catalog: 3 tests. Sync schema: 7 tests;
  mixed-version cases: six pending-v4 ready/sent/acked rehydration cases and two claim-generation
  cases. The claim cases do not assert a pending claim upgrade.
- Web domain/progress: 771 passing tests and strict domain type checking. Reference retained-v4
  journal claim coverage: 15 passing tests. JS corpus, Swift schema/catalog and Kotlin schema
  generation checks report current sources.
- Backend Postgres: all ten CTest targets pass. Domain 2276/2304 has 27 explicit client-role corpus
  skips and one optional generated-pattern input skip; MCP 340/340, sync 765/765 and adapters
  1345/1345 have no skipped case. The no-database build gate passes separately and explicitly skips
  its opt-in Postgres cases.
- `backend/test/deploy/schema_reapplication_test.py`: all four cases pass. The Other case checks
  all six legacy categories, a one-dumbbell override and signed set history; it accepts new Other,
  refuses unknown values and proves unchanged reapplication preserves rows and constraint/trigger
  identities.
- iOS focused App: 47 tests. Eight native captures cover the approved Other rack, load wheel,
  Fix set and movement form in both appearances; root reviewed and accepted the narrow scope.
  The captures use the real local engine/model fixture, not the network backend.

The Task 20 verification receipt covers an isolated schema 9 / minimum 9 backend. Schema 6, 7 and 8 each received 426 on
hello, push, pull and a WebSocket upgrade (12 refusals). MCP creates and reads Other, then a
name-only update preserves its equipment, alias and exact −5/0/20 kg set history. Structured write
receipts arrive; synthetic names, email and credentials are absent from logs.

Android's final native run captures all eight canonical states and four responsive states. On a
320 × 480 dp screen the focused Name field and Save remain above the keyboard; at 200% text the
complete name refusal and disabled Save remain visible. Both appearances pass. Four successful
edits reach the first-party intake with exactly the bounded record/edit/ok labels plus common
application metadata. The backend retains all 72 historical set pairs and restores the original
Barbell metadata after the recipe. Structured sync and event-intake write receipts arrive without
fixture names in logs. Cold readiness is 1926 ms, with no ANR or fatal error; this is a local sample,
not a performance comparison under controlled host load.

The final APK SHA-256 is `5640736d640be754a590b32f8389ea9d2e574a4f8a846bc811394f1f95c1f161`.
The private evidence packet records source hashes, screenshots, intake/database receipts and exact
test archive paths. Unexpected storage failure and expected refusal are verified through the real
store boundary with test telemetry; no live storage failure was injected. No production release or
cutoff is claimed by these local checks.

The native remote-stale probe is not inline-refusal evidence: its edit committed locally before
the remote change reached that replica, and the server subsequently refused the stale intent.
The server retained its value. Deterministic transaction tests cover changed-field conflicts,
account switches/adoption and a successful commit followed by owner transition or remote removal.

## Review and simplification

Integration with main's Notes editor preserves both note_editor save/delete and record edit event
allowlists. The complete TrainingStore, Notes screen and Edit movement sheet suites and six
telemetry checks pass together; the integrated write boundary differs from the native source only
by Notes' already verified save event and typed deletion origin. No visual source changes during
integration.

The review removed post-commit catalogue reads from the save result, retained the account admission
check under the write lock and kept the UI choice mapping in the pure catalogue rules. No optional
loading register, engine metadata API, migration alias or new generic framework is introduced.
Write failures use static `gym.editExercise`; the first-party `gym_action` allowlist accepts
only bounded screen/action/outcome labels. Names, equipment, account/replica IDs and raw errors are
absent from event properties.
