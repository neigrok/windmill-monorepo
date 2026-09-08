# Roadmap — open design asks

Four asks. Numbers are stable identifiers; `guidelines/mobile.md` cites them.

## 21 · The fruit tiers in daylight

The locked fruit is `color-mix(kind 18%, transparent)` with a 35% ring — the fill measures
**1.14–1.29:1** against the canvas in both themes, so a locked step and an available step of the
same kind differ by an 11px smudge on a phone in daylight.

Not a token swap: locked steps are the majority of a healthy tree and must stay quiet while
separating at arm's length.

**Deliver:** the three fruit tiers (done / available / locked) at 24px, both themes, all six
kinds, with the measured contrast for each pair.

## 23 · One input or two

`mobile.md` §7 forbids a header search field and the AI input being up at once: with the keyboard
raised they bracket a ~200px sliver of results and both read as "type here". Typing in the header
is a lookup (read), the AI input is intent (write).

The alternative to rule on: **one input at the bottom** — typing filters the list live, **send**
hands the same sentence to the agent. It puts the field where the thumb is and answers
recognition ("show me the backend stuff") rather than recall. Counterweight: one field with two
outcomes split only by pressing send, where a mistaken send is a write and a mistaken filter is
nothing — and it wears the body language of a conversation composer.

**Deliver:** the ruling, and if one input, the surface — how a live filter and a pending sentence
share a field, what send looks like versus typing, how results and theatre share the screen.
The AI assistance redesign owns the final interaction.

## 26 · Review flags

`guidelines/ai-assistance.md` §5 asks review findings to identify affected steps. The redesign
brief owns whether those findings become flags and how the user applies a correction.

**Deliver:** the flag as it reads on the canvas fruit and in the list row, plus the two response
chips a finding invites (**Keep as is** / **Re-pace**).

## 27 · Readable large roadmaps

The web canvas uses ordered radial rows with modest seeded variation inside equal major-branch
sectors, 52px ordinary bodies in Focus, and attached 14px/20px captions. Unequal angular intervals
and gently varied radii soften the rows; within-row radial spread stays at most 56px. Adjacent-row
radial gaps stay within 224–360px and generation gaps within 264–408px, while reserved branch
footprints keep a 128px gutter at working zoom. The variation is deterministic, not animation.
The Figma canvas boards need to show that contract at the densities covered by
`readability-research.md`.

**Deliver:** a named and counted branch overview, an unselected working view with quiet local
parent links, a selected branch with prerequisite/dependent emphasis, and phone
Focus / All steps controls. Use the existing kind palette and authored long names; show caption
priority and truncation, full names in the detail panel, and clearance around the legend, minimap,
editing affordances, and phone controls. Include the real roadmap and a 5,000-node overview in
both themes; make no claim that every title is simultaneously visible. Keep the real snapshot's
nine roots and unequal subtree sizes visible in the evaluation: varied spacing does not change
that authored structure or redistribute the equal sectors.
