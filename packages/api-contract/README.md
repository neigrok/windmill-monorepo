# api-contract

The wire shapes shared across surfaces — backend, web, and (later) native. One place so the
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
held only while there was one language; a native Swift logger writes copy #2 on its first day.
So the rule moves here, and both copies run this file.

**The bands.** The step pair is chosen by the **magnitude** of the weight, never its sign: under
20 kg it is ±1 / ±5, under 50 kg ±2 / ±5, at or above 50 kg ±5 / ±10. Magnitude and not sign,
because a band-assisted pull-up logs at −20 kg — a point on the number line, never a mode.

**The lightening rule.** A step that *reduces the load* is sized by the band just below the
current magnitude rather than the one it sits in. What it buys is that a step **landing on** a
boundary is undone by its opposite: the +1 that carried you 19 → 20 is answered by a −1 back to 19,
not a −2 down to 18. It buys no more than that, and the narrow claim is the true one — `49 +2→ 51
−5→ 46` *crosses* the boundary instead of landing on it and does not come back. Reversibility at
the edge, not everywhere. In code it is one comparison that tightens from `<` to `<=` — the limit
of `magnitude − ε` with no epsilon to pick.

**Mirror symmetry is the law that ties the two together**, and it is exactly checkable:

```
bump(−w, −direction, big) == −bump(w, direction, big)      for every w, direction, big
```

Because "lightening" is defined as *reducing the magnitude* (`direction × weight < 0`) rather than
*going down*, the ladder walks through zero into assisted territory without a toggle in sight, and
the assisted side behaves identically. The visible consequence, and the reason this golden exists:
at +20 kg the row reads `−5 · −1 · +2 · +5`, so at −20 kg it must read `−5 · −2 · +1 · +5`. Any
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
`2.505 × 100` is exactly `250.5` and rounds *up* to `2.51`. Both shipped copies are doubles and
agree bit for bit. A future surface that parses the string into a decimal type — C++, or Postgres
`numeric` — would disagree with both, which is the one way left for this contract to be read
correctly and implemented wrongly.

Read as a test by:

- `web/test/products/gym/logger/ladder.test.js` → `web/src/products/gym/logger/ladder.js`
- `apps/ios/Tests/WindmillGymTests/LadderTests.swift` → `apps/ios/Sources/WindmillGym/Ladder.swift`

Both read *this* file from the repo rather than a bundled copy — a copied fixture is a copy, and
copies are the thing this package exists to prevent.
