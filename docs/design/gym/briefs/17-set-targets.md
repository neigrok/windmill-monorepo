# Set targets

A movement target is one ordered scheme of up to twenty sets. Straight sets, ramps, pyramids and
back-off sets share the same shape. [Web form](../web-form.md) and
[Android delivery](../android-delivery.md) own surface composition; this document owns semantics.

## Scheme

The wire and store use `sets: [{reps?, weightKg?}]`, one item per set in lifting order. Omit `sets`
for an open line; an empty array is invalid. Straight schemes still contain every set. There is
no `targetSets` / `targetReps` / `targetWeightKg` triple in the current contract.

- Missing reps means **max**; missing load means **last time**.
- Last time for slot N means the Nth working set from the previous matching session.
- Bounds are 1–20 sets, 1–100 reps per target and load within ±500 kg.
- Actual logged load/reps remain independent of the target. Extra sets have no invented target.

## Entry

**Every set** edits the entire visible scheme; **Set by set** edits individual rows. A mixed head
field reads **varies**. Writing a head value replaces that column for every visible row.
Native entry retains a Sets field; web uses its ladder as the count. Android's grouped-stepper
alternative remains under consistency entry F38.

Changing the count hides or restores rows without losing their draft values. Growing beyond the
retained rows copies the last row. Add set first restores a hidden row, then copies one. Clearing
the count hides the ladder and disables the other head fields; only committing open discards it.
Show **You decide the numbers at the rack.** above the fields while open and not refused.

Each row edits reps and load through native numeric entry, with Next/Done navigation. Use `max`
and `last time` placeholders. The planning sign control appears on bodyweight load fields,
independent of keyboard layout, and is named **Flip the sign — band-assisted**.

Add set is the last row and cannot exceed twenty. Deleting the final row makes the scheme open.
Target-row deletion is a draft operation recovered through Cancel, without a persisted-delete
window. Provide a visible or accessible Delete path; no per-set reorder handles.

**Fill** exposes:

| Action | Result |
|---|---|
| Ramp up | Interpolate reps and load between the first and last sets. Snap intermediate loads to the weight band's small plate step, half away from zero. Requires at least three valid rows and differing endpoints. |
| Match set 1 | Copy the first set's reps and load into every visible row. |

A row's long-press menu may expose the same actions, never as their only path. Neither action
requires confirmation.

The pinned commit uses **Set · 3 × 8 · 60** for straight schemes, **Set · {n} sets** for varied
schemes and **Set · open** for open. During a refusal it is disabled and reads **Set**.
Draw one refusal at a time: count first, then rows in order, reps before load. Exact copy belongs
to [routines](15-the-routine.md). Preserve invalid input and the caller's draft on cancellation.

## Readouts

Every routine, editor, proposal and plan line uses the same formulas:

| Value | Format |
|---|---|
| Scheme | `{sets} × {reps} · {load}` |
| Mixed column | Minimum–maximum, including placeholders at the top: `5–max`, `60–last` |
| Single-set scheme | `1 × 5 · 100` |
| One performed or planned set | `{load} × {reps}`, with `last` and `max` for missing targets |
| Open scheme | `open` |

Examples: `5 × 5 · 80`, `5 × 1–5 · 60–100`, `5 × 8–12 · 80` and `3 × 5–max · 100`.
Never mix a scheme's sets/reps/load order with a single set's load/reps order.

## Logging and prefill

On a straight scheme, the last landed working set carries forward: a change chosen for the day
continues into later sets. On a varied scheme, slot N prefills from its target; missing load uses
last time's Nth working set, then today's last set, then the empty bar. Missing reps use last
time's Nth set, then the last set's reps. The plan must not be flattened to the preceding slot.

Logged rows show actual values and open Fix. The current row shows its target; future rows remain
read-only and have spoken position/target names. Warmups do not consume working-set slots; extra
sets append without a target. Android's quiet ledger, iOS's current strip and the web mirror
follow [workouts](16-the-workout.md). A lock-screen offer uses the current slot's prefilled values.

At a movement boundary, the deviation offer retains its existing trigger: the heaviest working
set exceeds the heaviest planned load. Straight schemes keep their load offer. Varied schemes
show before/after ladders and **Save today’s sets**; offer this only when performed working sets
fit the twenty-set limit. Missing a rep alone must not raise the offer.

Keep-as-routine transcribes performed working sets per set.

## Coach review

Routine tools, plan snapshots and last-time reads use the same scheme shape. Tool descriptions
need both straight and varied examples.

A changed shape shows its compact readout and can expand into individual sets. If only one set
changed, name it directly: **set 4 · 100 × 1 → 102.5 × 1**. Keep the existing count of changed
routine rows, human Apply gate and persisted outcome receipt. Coach cards show at most three
compact changed rows; the full review owns expanded ladders.

## Fixtures and unresolved scope

Use Lower A / Back Squat for the varied fixture: `60 × 5 · 80 × 5 · 90 × 3 · 100 × 1 · 80 × 5`.
Its readout is `5 × 1–5 · 60–100`; the review changes set 4 to 102.5 kg. Push A / Bench Press uses
`3 × 8 · 60` for the straight fixture.

Per-set planning notes, percentage-of-training-max schemes and a lower deviation trigger are
outside the current contract. A training-max feature needs a source of that value before targets
can depend on it. The native Sets field versus web's ladder count remains unresolved in F38.
