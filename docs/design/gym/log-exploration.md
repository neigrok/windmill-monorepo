# Training history exploration and coach sharing

Status: Figma design proposal, 9 September 2026. Backend capabilities below are source-inspected, not performance-tested.

## Reading years of training

The log serves two tasks: finding a session and understanding the work recorded in it. Desktop keeps a compact chronological index beside the selected workout. Narrow web uses a list and reader with retained navigation context. Dates, routine names, set counts and external volume help scan rows without opening every session.

Date navigation jumps to a year/month without repeated Load older actions. Movement and routine filters apply to the entire authorized history, not just loaded pages. Previous and next move through the current result set. Returning to the index retains filters, selection and scroll position. Empty results provide Clear filters.

The reader leads with actual sets, reps, load and exercise totals. Planned targets remain separate reference values. e1RM is an optional per-movement estimate, not a workout-wide progress score. External volume is weight multiplied by reps, excludes bodyweight itself and is not a claim of improved performance. Scope summaries must use complete server aggregates with the same filters as the index.

Dense numeric tables use compact editable values on owner entry screens. Read-only history uses the same alignment without edit affordances. Short forms retain ordinary inputs. Inline controls and dedicated screens avoid modal dialogs.

## Sharing with a human coach

Sharing is read-only and scoped explicitly to the entire history or a date range. A snapshot and ongoing updates are distinct choices; selecting a date range must not silently enable future updates. Preview shows the recipient's view before a link is created. The active state exposes the scope, expiration and revoke action.

The proposed link grants access to anyone who possesses it; the UI states this plainly. AI Coach conversations and private Notes are excluded. Only completed workout data is in scope. Any future optional notes or bodyweight sharing must be enforced by the server, not hidden only in the UI. No real share link is created by the Figma prototype.

## Implementation gaps

- The owner sessions endpoint offers descending keyset pagination through `before`, `beforeId` and `limit`, with a maximum of 200 rows per request. It lacks full-history date-range, movement and routine filters, year/month indexes, facet counts and total result counts.
- Deep navigation needs stable cursors and persistent selection. The current web reload path retains at most 200 summaries, which can lose deeper exploration context.
- Movement filtering needs stable IDs and explicit semantics for renamed movements and deleted routines; display names are insufficient identities.
- Lifetime statistics are currently unbounded. The explorer needs bounded aggregates that share the index's filter and authorization rules. The record endpoint does not yet provide arbitrary history windows.
- Current sharing covers one workout for 30 days and reads its current values. It is not a frozen snapshot. Multi-workout scopes, public pagination/filtering, snapshot semantics and share management require backend work.
- Current metrics still depend on Kind/working-set classification. The proposed removal of Kind requires an explicit migration and aggregation rule before implementation.

Evidence: `web/src/products/gym/gymApi.js`, `useTrainingLog.js`; `backend/products/gym/adapters/http/TrainingApi.cpp`, `adapters/postgres/PgLogRepository.cpp`, `domain/Record.h`, `domain/Training.h`, and `adapters/json/TrainingJson.cpp`.

## Synthetic review data

The coherent small fixture contains eight workouts across 2024–2026: 30 sets and 10,560 kg external volume. The selected 7 September Push A has nine sets, 66 reps and 2,160 kg. It is separate from the unsaved 8 September entry draft.

A separate density fixture has one workout per day from 1 January 2024 through 8 September 2026: 982 workouts, 2,952 sets and 22,638 reps. This fixture tests the navigation and row density, not real account history. It must not be mixed with the eight-workout sharing sample.

## Figma review entry points

- [Owner history](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=470-8) and [narrow history](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=470-21).
- [Daily-history density](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=519-2166): a separate 982-workout stress fixture.
- [Share setup](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=508-1353), [preview](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=524-3765), and [read-only recipient history](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=524-2705).

The connected examples cover latest/previous workout, the 2024 date jump, empty-filter recovery, owner entry points, and default entire-history snapshot preview/create/view/revoke. Other selector options and nondefault sharing previews are illustrated states, not a complete functional simulation. The dense narrow date jump is a design state; the connected dense year-jump example is desktop. No actual share is published.
