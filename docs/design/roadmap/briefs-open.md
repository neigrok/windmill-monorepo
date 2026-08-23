# Windmill — the open design queue, consolidated · 26 July 2026

One list of everything still on your plate, pulled together from the three live brief
files so nothing hides between them: `briefs.md` (batch 10–17), `briefs-mobile-explore.md`
(21–23), and the tail of your own `briefs-build-findings.md`. Numbers below keep their
original identifiers; this file supersedes nothing, it just gathers.

Read the first section before the rest — two of your recent rulings **closed build
blockers**, so those items have left your plate and you shouldn't spend an hour re-opening
them. The five that remain are genuinely open, and three of them are small.

---

## Cleared by you — moved to the build side (nothing owed)

- **§07 angular reorder — ruled AND built.** The `guidelines/angular-reorder.md` spec (four
  rulings + the fractional-index order register + the touch degrade) was complete, and the
  gesture now ships: dragging a node tangentially reslots it among its siblings, siblings
  ease to their recomputed angles, one undo, deterministic. `briefs.md` #11 is done — thank
  you for pinning the CRDT contract before the build touched the wire.
- **The phone Share door — ruled (finding 5), and the button ships.** Share is the ≥44px
  right-slot verb in the action lane, retirement gated on the door existing. What you still
  owe here is only the *picture* (below), not the decision.

**One thing your ruling unblocked that ISN'T built yet — flagging so it doesn't fall
through:** finding 1 re-sited the public shelf as **the last row of the TreeSwitcher, behind
"Planted in public →"**. `/browse` shipped fully to your §3–§5/§7 spec — but it currently
has **no in-product door at all**: nothing links to it, so it's reachable only by typing the
URL. The switcher row is the entrance, and until it exists the whole public wall is
stranded. It's build work, not design work — but it needs your drawn row (item 5 below)
before it reads as considered. Building it functional from your ruling in the meantime.

---

## Still open — yours to complete

Ordered small-to-large. The first three are the mobile-explore findings (21–23), each
measured on a real build; the last two are the items you named as owed at the foot of
`briefs-build-findings.md`, plus one design-gated feature.

### 21 · The dim fruit can't carry tier in daylight — *small but load-bearing*

Full statement in `briefs-mobile-explore.md`. The short of it: moving the "locked" signal
into the fruit (correct) exposed that the fruit doesn't carry it — the locked fill measures
**1.14–1.29:1** against the canvas, so a locked plum step and an available plum step differ
by an 11px smudge on a phone in daylight, and five of six kinds put the lock glyph under the
3:1 floor. It predates the wave and ships today on every locked row.

**Deliver:** the three fruit tiers (done / available / locked) as they read on a phone in
daylight — both themes, all six kinds, at 24px — with the measured contrast for each pair.
Not a token swap: locked steps are the *majority* of a healthy tree and must stay quiet
while still separating at arm's length (likely a solid ring at full kind strength with the
fill carrying the dimming — but yours). Maps to build node `phone-tier-legibility`.

### 22 · The phone type ramp vs iOS's 16px zoom floor — *small, one ruling*

Safari zooms the whole page when a focused input renders under 16px. `EditField` — every
inline rename/describe in the list, i.e. *the* canonical mobile edit — is 13.5px, so tapping
a row to rename it punts the viewport on a real iPhone. It sits inside a row, so bumping it
naively changes the row type ramp X8 measured, and a row whose text grows on entering edit
mode is its own kind of wrong.

**Deliver:** the ruling — row text moves to 16px (a consistent ramp change), or the field
renders at 16px and is visually scaled back into the row, or a third answer — plus the
corrected phone type scale if the ramp moves. One paragraph. Blocks nothing, but it's a real
defect on the primary platform and will keep being rediscovered until ruled. Maps to
`ios-input-zoom`.

### 23 · One input or two? — *medium, binds tending at arming*

`mobile.md` §7 now *forbids* a header search field and the Tend bar being up at once (they'd
bracket a ~200px sliver of results and both read as "type here"). That rule is a guard, and a
guard is what you write when you haven't decided the thing. Tending is dark today, so the
collision isn't live — which is exactly why now is the moment to rule it, before #16 arms.

The bolder answer to weigh: **one input at the bottom** — typing filters the list live,
**send** hands the same sentence to the agent. It dissolves the collision instead of
policing it and puts the field where the thumb is. The counterweight: it overloads one field
with two outcomes split only by pressing send, and a mistaken send is a *write*; it also
risks looking like the chat composer #16 exists to avoid.

**Deliver:** the ruling — one input or two — and, if one, the surface (how a live filter and
a pending sentence share a field, what send looks like vs typing, how results and theatre
share the screen). It binds #16's arming, so earlier is better.

### 24 · The phone Share button — the specimen you owe *(from build-findings tail)*

You ruled its home (action lane, right slot) and its behaviour (finding 5), and it ships —
but X8 §10 has the rule and **no picture**. **Deliver:** the button drawn on the phone
canvas — resting, and the sheet it opens (Download / Copy → `navigator.share`, the Week/Day
segment, the ledger toggle) — so the shipped control has a canonical specimen to hold to.

### 25 · The TreeSwitcher's public row — drawn *(from build-findings tail; unblocks the /browse door)*

You ruled the placement and the rule ("last row of the switcher, behind *Planted in
public →*, no count"). It wants **drawing** in `progress-and-tree-registry.html` — the row's
weight, the rule label, how it sits beneath your own trees without competing with them.
**This one has a build waiting on it:** `/browse` is orphaned until the switcher row ships,
so your drawn row directly unlocks the wall's only in-product entrance. Small, and it
converts a shipped-but-unreachable page into a reachable one.

### 26 · Tending review — the gold-flag treatment — *design-gated build*

Tending's *reviewing* half already works: ask "Is this realistic?" and the agent pins a
specific, expert concern onto each step (missing rest weeks, a too-steep ramp) as an
annotation, findable later on the node. What it lacks is a **visual** — a reviewed concern
currently reads as an ordinary note in the node's About block, indistinguishable from the
user's own text. Canon's own word for this feature is *review*, and a review finding wants
to look like a finding, not a footnote.

**Deliver:** the gold-flag treatment — how a review concern reads as a distinct, warm,
attention-worthy pin on a step (on the canvas fruit and in the list row), plus the two
response chips a finding invites (**Keep as is** / **Re-pace**). The data is already on the
node; this is purely how it shows and how you answer it. It's the last piece of the tending
feature that's function-complete but visually placeholder.

---

## Not on this list, deliberately

- **`briefs.md` #10 (multi-select), #13 (mobile editing grammar), #14 (shortcuts overlay)** —
  all delivered and shipped; #13's grammar lives in `mobile.md` §3 now.
- **#15 (private-tree pricing)** — withdrawn; **#17 (tending pricing)** — delivered, holds
  until tending ships.
- **The public-shelf spec (#18)** — held with no host, correctly, per your finding-1 ruling.

If any of the six open items is blocking a build you'd expect sooner, say which and it jumps
the queue — otherwise the natural order is the three small mobile rulings (21 / 22 / 23)
first, since two are one-paragraph calls and the third gates tending's arming.
