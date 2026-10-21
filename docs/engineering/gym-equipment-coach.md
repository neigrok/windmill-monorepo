# Gym equipment and Coach confirmation

A movement keeps its stable identity across renames and history. The immutable base exercise holds its
original equipment. Current equipment and one-or-two-dumbbell count resolve from the account’s keyed
exercise metadata before any training read. Custom names remain on the custom exercise; seed names
resolve from that metadata. A name-only edit writes only the name and preserves equipment changes.

Entered loads remain unchanged. Working-set volume uses positive external load times repetitions times
the resolved dumbbell count; other equipment counts once. Estimates stay in the entered weight unit.
History projections, workout detail totals and finish receipts all consume this interpretation. The four
single-dumbbell seeds have explicit stable IDs, so renames cannot change their default load count.

Coach has a durable routine draft and a separate confirmation door. Clients review movements, target
loads with their basis, and equipment before the lifter selects Save routine. Retry keeps the thread,
request and operation identities. Stream and history merges preserve saved state and receipts against
older snapshots. Android retains confirmation receipts under their account and clears them with the
conversation. Late responses never publish across an account change.

The simplification pass keeps load interpretation in each surface’s gym domain and the existing Coach
conversation boundary. The same typed generation carries partial replies, routine drafts and saved
receipts; no parallel routine-write path is introduced in a screen. Confirmation telemetry uses only a
bounded outcome, with static failure operations and no conversation or training content.

Local verification covers the complete web build: 3,078 ordinary tests passed, 14 existing cases
were skipped, and four performance tests passed; the domain typecheck, browser sync check and
production assembly passed. The final review-label test passed all 26 CoachRoom cases, including
kilogram targets while the account displays pounds, total barbell load, two-dumbbell load and a
bodyweight target without added weight.
The final Coach behavior and saved-workout editor checks passed 36 and 10 cases respectively;
the editor’s saved totals use the current equipment metadata as its history detail does.

The Android domain, Debug and Release suites passed: 65 domain tests and 1,172 Gym
tests in each variant, with 17 existing Gym cases skipped per variant. The transport test also
verifies that a reply for another conversation produces the static failure event and report,
and that a nonstream response preserves routine drafts from its generation.
The shared Gym corpus claims 568 cases and reports 14 pending
cases in the saved-workout recovery area. Its training-read expectations independently calculate
the current equipment-aware volume and emit dumbbell quantity only for dumbbells.

The complete Android README build passes app and Gym assembly, lint, client corpus coverage (52 files,
792 vectors), model-server coverage (27 files, 813 cases and seven protocol transcripts), and
all 1,594 sync-testing cases and 260 mandatory property checks, with no skips or failures in
those suites. Nine focused Kotlin schema composition and coverage tests pass.
Swift’s schema and mixed-version suites pass eight tests; its Gym server admission suite passes
all 219 shared cases. The JS reference mixed-version claim suite passes all 15 tests.
Both schema generators report current output.

The Journal replay oracle independently applies the shared blank-document rules: a blank save
clears ratings and restores the typed source; a blank claim preserves the account's writing and
metadata; a final blank document is normalized in both paths. The shared normalization stays in
the oracle's document value, while claim receipts retain the original arguments. Production
behavior is unchanged. The four focused tests pass, including exact document regressions for
zero ratings, null inheritance and raw-argument claim conflicts, byte-for-byte replay, and the
complete 30-start survey of 60 seeds and 160 steps without a coverage miss.
