# Gym equipment and Coach confirmation

A movement keeps its stable identity across renames and history. Its base `exercise` record holds the
original equipment, which never changes. The account's `exerciseName` record, keyed by the movement's
id, holds its current equipment and its one-or-two-dumbbell count. For a seed it also holds the
account's name for the movement. A custom movement's name lives only on its `exercise`; an
`exerciseName` keyed by a custom movement holds only `equipment` and `loadCount`, and a name there is
refused. An edit writes only the registers that changed and never a null register.

Creating a custom one-dumbbell movement is one atomic gesture: the `exercise` create plus an
`exerciseName` keyed by the new id with exactly `{loadCount: 1}`. A two-dumbbell or non-dumbbell
movement writes the `exercise` alone. A seed rename over an override that holds only equipment or a
count writes only `name`.

Entered loads remain unchanged. Working-set volume is the positive load times repetitions times a
count: for a dumbbell movement, its resolved dumbbell count (the override, else the seed's default,
else two), and one for every other equipment, so a count left on another equipment is ignored. Goblet
squat, dumbbell row, suitcase carry and overhead triceps extension default to one dumbbell by their
stable ids, so renames cannot change their default. Bodyweight movements count only positive added
load. Estimates stay in the entered weight unit. History projections, workout
detail totals and finish receipts all take the account's catalogue for this interpretation.

Coach prepares a durable routine draft only for a client that reviews drafts (`routineReview: true` on
every ask), and a separate confirmation door saves it; its outcomes are in
[the Coach contract](../gym-coach-contract.md). Clients review movements, target loads with their
basis, and equipment before the lifter selects Save routine. Web labels the basis "kg each" for a
pair of dumbbells, plain "kg" for one, "kg added" (or "assisted" for a negative target) for
bodyweight and "kg total" for barbells, shows targets in the lifter's display unit, and names a
movement it has not synced yet "New movement" with no basis. Retry keeps the thread, request and
operation identities. Stream and history merges preserve saved state and receipts against older
snapshots. Android retains confirmation receipts under their account and clears them with the
conversation. Late responses never publish across an account change.

Load interpretation lives in each surface's gym domain, and the same typed generation carries partial
replies, routine drafts and saved receipts; no screen writes a routine by another path. Confirmation
emits `gym_coach_routine_confirm` with a bounded outcome on web, iOS and Android, with static failure
operations and no conversation or training content.
