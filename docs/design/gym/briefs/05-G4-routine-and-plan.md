# G4 · Routines, the plan snapshot, and plan-vs-actual

**Blocks:** `routines` (phase 2, M), `plan-vs-actual` (phase 3, S).

## The structural idea to get right

In Lift the plan and the log were the **same object**. Editing a template mid-workout permanently
rewrote the program, and a finished session stored only a reference plus a copied name — so the app
could tell you what you did and never what you were *supposed* to do.

Gym separates them. Starting a session **snapshots the plan**: what the routine said at that moment
is frozen into the session. Change the routine tomorrow and last Tuesday still reads correctly.
Change something mid-session and it applies to today only, with an explicit "save this to the
routine" offer.

That snapshot is what makes `plan-vs-actual` possible, and it is the difference between a log and a
program you can actually run.

## Routines

A routine is a named, ordered list of exercises with targets — sets, reps, and a starting weight.
Design:

- **The list of routines.** Our named user has three to five (Push A, Pull A, Legs, Push B…). Not
  dozens. Sorting by "most recently trained" probably beats "recently created".
- **The editor.** Add, remove, reorder. Reordering on a phone with a drag handle that is actually
  visible — Lift's had none.
- **Duplicate.** "Push B from Push A" was Lift's most obviously missing affordance: programs are
  variations of each other, and retyping eight exercises is the reason people give up on a program
  app.
- **Start a session from it.** The handoff into `G1`.

## Ad-hoc is a first-class path

Lift made a template the **only** entry point, which is why you could not add face pulls without
permanently editing your program. In gym you can start logging with no routine at all, and you can
add an unplanned exercise to a planned session. Neither is an exception state and neither should look
like one.

## Exercises are things, not strings

An exercise has a stable identity and a name that can be corrected without forking its history. The
picker is search-first over a seeded list of ~60 movements, with "create «Incline DB Press»" inline
when the search finds nothing. Design:

- The picker (this is the second-most-used interaction in the product after logging a set).
- What a newly created exercise looks like versus a seeded one.
- The disambiguation problem: `Bench Press`, `Barbell Bench Press`, `BB Bench` are one movement. How
  does the UI let a user merge them later without a taxonomy screen?

Note: muscle-group tagging is **cut**. Lift's was lopsided (one `legs` bucket against separate
biceps, triceps and forearms, so quads versus hamstrings could not be expressed), double-counted by
construction, and read its tags from live templates so deleting a program erased history's labels.
Do not design a muscle chart.

## Plan versus actual (phase 3)

Planned 5×5 at 100 kg; did 5, 5, 5, 5, 4. Design the honest readout — on the live screen (what am I
meant to do next?) and on the finished session (how did that go?). The tone is a fact, not a grade.
There is no adherence score, no percentage, no green/red report card.

## What to deliver

The routine list, the routine editor with reordering and duplication, the exercise picker with
inline creation, the session-start handoff, the mid-session change and its "save to routine" offer,
and the plan-vs-actual readout in both places.
