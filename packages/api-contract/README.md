# api-contract

The wire shapes shared across surfaces — backend, web, and native. One place so the
four surfaces can never drift.

A tenant earns a place here by being **one truth several languages must state separately**. Not
shared code — no runtime crosses these language boundaries — but shared *answers*, checked in as
data, run as a test by every surface that implements them. Drift then fails CI instead of shipping.

## The genesis legend golden — `genesis.js`

A locally-born tree's first sync converges with the server's empty tree only while the frontend's
genesis seed is byte-equal to the backend's (`Legend::seededDefaults` + `Hlc{1,0,"genesis"}`).
Before the monorepo these two repos guarded against drift with a hand-copied constant in
`web/vite.config.js`; here the seed is defined once and imported, so the drift class disappears.

Read by: `web/vite.config.js` (build fails on drift), pinned backend-side by `TreeRegistryTest`.

## The weight ladder golden — `gym-ladder.json`

The ladder is the single highest-value pixel in gym: it is where a lifter's weight moves by a
tap, and a wrong number there is a wrong number in their training log. Lift — gym's predecessor —
pasted this rule into three targets and let them drift. Gym's rule was "exactly one module," which
held only while there was one language; a native Swift logger wrote copy #2 on its first day, and
Android's Kotlin logger wrote #3. So the rule moves here, and all three copies run this file.

**The bands.** The step pair is chosen by the **magnitude** of the weight, never its sign: under
20 kg it is ±1 / ±2.5, under 50 kg ±2.5 / ±5, at or above 50 kg ±2.5 / ±10. Magnitude and not sign,
because a band-assisted pull-up logs at −20 kg — a point on the number line, never a mode.

**Retiered 2026-08-11, and this is the point of the table.** The tiers mined from Lift put ±2 and
±5 in the middle band and ±5 / ±10 above it, so **above 50 kg the +2.5 kg step a barbell program is
written in was not on the ladder at all** — the row was a 5-spaced lattice, and 85 kg was
unreachable from 82.5 at any depth without leaving for the keypad. The phase-1 dogfood gate, which
asks whether the prefilled weight was accepted unchanged *or moved by exactly one step*, therefore
could not be measured at the loads its author trains at. The fine button is now the **program
step** and the coarse button is a **plate change**: ±1 survives only under 20 kg, where dumbbells
and the small stuff live. The rule stays a
pure function of the weight — nothing reads the exercise, the lifter, or their plate inventory —
which is what keeps it checkable as data in three languages.

**The lightening rule.** A step that *reduces the load* is sized by the band just below the
current magnitude rather than the one it sits in. What it buys is that a step **landing on** a
boundary is undone by its opposite: the +1 that carried you 19 → 20 is answered by a −1 back to 19,
not a −2.5 down to 17.5. It buys no more than that, and the narrow claim is the true one — `19.5
+1→ 20.5 −2.5→ 18` *crosses* the boundary instead of landing on it and does not come back.
Reversibility at the edge, not everywhere. In code it is one comparison that tightens from `<` to
`<=` — the limit of `magnitude − ε` with no epsilon to pick.

**Mirror symmetry is the law that ties the two together**, and it is exactly checkable:

```
bump(−w, −direction, big) == −bump(w, direction, big)      for every w, direction, big
```

Because "lightening" is defined as *reducing the magnitude* (`direction × weight < 0`) rather than
*going down*, the ladder walks through zero into assisted territory without a toggle in sight, and
the assisted side behaves identically. The visible consequence, and the reason this golden exists:
at +20 kg the row reads `−2.5 · −1 · +2.5 · +5`, so at −20 kg it must read
`−5 · −2.5 · +1 · +2.5`. Any
implementation that reads its down-band as "the band just below the *signed* weight" gets the
loaded side right and the assisted side wrong, and it will pass its own hand-written tests.

**Rounding.** Every weight is stored to two decimals, rounded **half away from zero** — and that is
a law, not a free choice, because it is the same mirror symmetry one level down: `round(−x)` must
equal `−round(x)`. The obvious implementation breaks it. JavaScript's `Math.round` is half-*up*,
so it sends `2.505` to `2.51` but `−2.505` to `−2.5`; Swift's `.rounded()` is already half away
from zero and disagrees. Nothing in the ladder itself reaches a tie — every step adds an integer or
a half to a weight already on the grid — but **typed entry does**: the keypad accepts `−2.505`, and
under the two default rules the web would store `−2.5` where the phone stored `−2.51`, for the same
string typed by the same lifter. `roundCases` pins it. Round the magnitude and reapply the sign.

**The rep floor.** Reps ride the same file because they ride the same buttons, and they have one
rule the weight does not: a set of zero reps is not a set. The backend says so — `Training.cpp`
refuses `reps < 1` — so a logger whose ladder floored at 0 drew a tappable `60 kg × 0` that the log
could only answer with a refusal. The floor is **1**, on the ladder and in typed entry both. What
`repCases` has to pin, and the reason it names 0 at all, is that the floor is a **clamp into the
range and not a hold at the value**: `bumpReps(0, −1)` is **1**, not 0, so a 0 rehydrated from a
live blob written before the floor moved is climbed out of by whichever button the thumb finds
first, and the down key is never the thing preserving an unloggable number. Two defensible answers,
one written down. The ceiling is the other way round on purpose: the keypad stops at 99 where the
server allows 500, because 99 is a keypad bound — two digits, no third — and not a contract one.

Read that as **`round(x × 100) ÷ 100` evaluated in IEEE-754 doubles**, not as decimal rounding of
the typed string — the two are different answers and `roundCases` pins the first. `2.505` is not
`2.505` as a double, it is `2.50499999…`, so a decimal reading rounds it *down* to `2.50` while
`2.505 × 100` is exactly `250.5` and rounds *up* to `2.51`. All three shipped copies are doubles and
agree bit for bit. A future surface that parses the string into a decimal type — C++, or Postgres
`numeric` — would disagree with all three, which is the one way left for this contract to be read
correctly and implemented wrongly.

Read as a test by:

- `web/test/products/gym/logger/ladder.test.js` → `web/src/products/gym/logger/ladder.js`
- `apps/ios/WindmillKit/Tests/WindmillGymTests/LadderTests.swift` → `apps/ios/WindmillKit/Sources/WindmillGym/Ladder.swift`
- `apps/android/gym/src/test/kotlin/works/windmill/gym/domain/LadderTests.kt` → `apps/android/gym/src/main/kotlin/works/windmill/gym/domain/Ladder.kt`

All three read *this* file from the repo rather than a bundled copy — a copied fixture is a copy,
and copies are the thing this package exists to prevent.

## The plate readout golden — `gym-plate-readout.json`

The second contract gym earned, and it earned it the hard way: on 2026-08-12 three languages wrote
this rule independently in one wave and **already disagreed on two edges** before any of it had
shipped a week. That is the drift this package exists to prevent, and the ladder's own history is
the precedent — a second implementation is a second opinion, and it found two defects the first copy
had hidden for as long as it existed.

**Why the rule exists at all.** §I of the decided design said the ladder's fine step comes from the
lifter's plate set. It does not, and it must not: the ladder is pinned above as a pure function of
the weight, and a step that depended on one lifter's inventory could not be pinned that way. What
the plate set feeds instead is the **readout** — the line under a load saying what to hang on the
bar, and saying plainly when this gym cannot make the number. The fine step is 1.25 kg a side, and a
lifter who owns no 1.25s cannot load it; the honest answer is a readout that says so, not a button
that hides the weight. A button that hides a weight is a product deciding what a lifter may lift.

**`platesKg` is ONE SIDE of the bar and the load is the TOTAL.** Anything mixing the two is wrong by
a factor of two, which is the one mistake here that looks plausible on screen.

**The search is exhaustive, not greedy.** Greedy is how a plate calculator is usually written and it
is wrong on ordinary racks: with 25s, 20s and 15s only, greedy takes the 25 for a 30 kg side, is
left with 5 it cannot make, and calls unloadable a side that two 15s make exactly. `80, 20, [25, 20,
15]` is that case, and it is in the file.

**The tie-break, which "exhaustive" does not imply and which the file would otherwise pin in
silence.** A 40 kg side is `25 + 15` **and** `20 + 20` — same plate count, so "fewest plates" does
not choose either. The rule that does: **at each step take the heaviest plate that leaves a
remainder these plates can still make.** A surface that writes a perfectly correct exhaustive walk
scanning its rack *ascending* answers `1.25 + …` for that same side, satisfies every other sentence
here, and fails eight cases with no idea why — reading like a bug in the golden rather than a defect
in itself. Sides of 40, 41.25, 42.5, 31.25 and 60 all have alternatives, and every one is pinned by
this rule. (`heaviest first` elsewhere in this section describes the *order the output list is
printed in*, which is a different thing from which multiset was chosen.)

**The five answers**, and every one of them is a real state a lifter reaches:

| answer | when |
|---|---|
| `loaded` | `perSide`, heaviest first, with a count per plate |
| `bare` | the load is the bar |
| `underBar` | the load is lighter than the bar — **say so**; it is true and it explains the missing plate list |
| `unloadable` | these plates cannot make it: `belowKg` and `aboveKg` are the nearest totals that CAN be loaded, either nullable |
| `none` | there is nothing true to say |

**The two edges the three implementations disagreed on, ruled here on merit** — one went each way,
which is the evidence they were ruled rather than picked:

- **A bar of 0 kg** is a machine or a pair of dumbbells: the lifter has said there is no bar, so
  there is no sentence about one. `none`. A per-side decomposition would claim a symmetry the
  equipment may not have.
- **A load lighter than the bar** says so rather than falling silent. Silence leaves a lifter
  wondering where the plate list went; `underBar` answers it.

Beyond `capKg` (1000) there is no readout: nobody past a tonne is reading a plate list, and the
keypad stops at 500 long before it, so the cap is the belt behind that rule rather than a second
opinion on it.

Read as a test by:

- `web/test/products/gym/settings/plates.test.js` → `web/src/products/gym/settings/plates.js`
- `apps/ios/WindmillKit/Tests/WindmillGymTests/PlatesTests.swift` → `apps/ios/WindmillKit/Sources/WindmillGym/Plates.swift`
- `apps/android/gym/src/test/kotlin/works/windmill/gym/domain/PlatesTests.kt` → `apps/android/gym/src/main/kotlin/works/windmill/gym/domain/Plates.kt`

The sentence each surface prints is its own — a readout is presentation and the languages spell a
number differently. What this file pins is the **answer**, which is the rule.
