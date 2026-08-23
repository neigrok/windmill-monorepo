# Roadmap — open design asks

Three asks. Numbers are stable identifiers; `guidelines/mobile.md` cites them.

## 21 · The fruit tiers in daylight

The locked fruit is `color-mix(kind 18%, transparent)` with a 35% ring — the fill measures
**1.14–1.29:1** against the canvas in both themes, so a locked step and an available step of the
same kind differ by an 11px smudge on a phone in daylight.

Not a token swap: locked steps are the majority of a healthy tree and must stay quiet while
separating at arm's length.

**Deliver:** the three fruit tiers (done / available / locked) at 24px, both themes, all six
kinds, with the measured contrast for each pair.

## 23 · One input or two

`mobile.md` §7 forbids a header search field and the Tend bar being up at once: with the keyboard
raised they bracket a ~200px sliver of results and both read as "type here". Typing in the header
is a lookup (read), the Tend bar is intent (write).

The alternative to rule on: **one input at the bottom** — typing filters the list live, **send**
hands the same sentence to the agent. It puts the field where the thumb is and answers
recognition ("show me the backend stuff") rather than recall. Counterweight: one field with two
outcomes split only by pressing send, where a mistaken send is a write and a mistaken filter is
nothing — and it wears the body language of the chat composer tending is designed to avoid.

**Deliver:** the ruling, and if one input, the surface — how a live filter and a pending sentence
share a field, what send looks like versus typing, how results and theatre share the screen.
It binds tending at arming.

## 26 · Review flags

`tending.md` §5 requires the review half to answer "is this realistic?" by pinning gold honesty
flags on the offending steps. There is no visual treatment for one: a concern reads as an
ordinary note on the node.

**Deliver:** the flag as it reads on the canvas fruit and in the list row, plus the two response
chips a finding invites (**Keep as is** / **Re-pace**).
