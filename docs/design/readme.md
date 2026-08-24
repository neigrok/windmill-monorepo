# Design canon — the written half

Guidelines, briefs, and the drift ledger: what should be, and why.

The drawings live in five Figma files.

| File | Key |
|---|---|
| Windmill · Design System (the published library) | `qoOwNbWOYE1GFi0yR5uGY2` |
| Windmill · Roadmap | `HM4d8YWzJZg5clVRJKNuDr` |
| Windmill · Journal | `pC6ciOUnfLmI42oMihd7l3` |
| Windmill · Gym (web · iOS · Android) | `vdmdiKWrmZoS1FtcvJRf6O` |
| Windmill · Marketing | `uWLMdVmzTcobOh8hbeem81` |

Figma records what IS; these docs record what should be and why. A screen is drawn in Figma. A
decision, a constraint, an open question, or the reason behind either is written here. Neither is
the other's backup.

## Layout

| Path | Holds |
|---|---|
| `consistency.md` | The drift ledger — canon-vs-code disagreements. Start here for consistency work. |
| `brand-foundations.md` | Brand direction, voice, visual foundations, iconography, and the standing font and logo policies. |
| `brand-identity-brief.html` | The logo brief. No logo has been drawn; every mark is the Baloo wordmark. |
| `guidelines/` | Brand-wide: motion language, the superapp shell and journey, the four-layer system architecture, thumb reach, **the text budget**. |
| `roadmap/` | Feature guidelines and the open-asks briefs. The largest set. |
| `journal/` | Product canon (`journal.md`), the mood and energy scales (`scales.md`), first-run canon (`onboarding.md`). |
| `gym/briefs/` | Creation briefs for the gym room. |
| `marketing/` | The landing-family briefs, the pricing story, the transactional-email spec. |

## Rules for drawing a screen

**Words cost.** Read `guidelines/text-budget.md` before writing a caption. A screen's chrome gets
**40 words** before the decision window closes, and a screen where half the words are read at all is
under **111**. Content — the thing they came for — is not on the budget.

Two rules from it decide most cases. *A permanent caption is a confession that the design did not
carry its own meaning.* And **cutting is not the first move**: making the one fact that matters
salient outperformed cutting 40% of the words by 2.7× in the largest trial on this, so make it
impossible to miss and say it concretely before you shorten anything.

**Phone reach.** Read `guidelines/thumb-reach.md` before drawing any phone screen: controls at the
bottom, guidance centred in the middle band, identity on top. Never leave a top-anchored stack with
dead space below the last button, and never put a primary or destructive button inside a card
mid-scroll — pin it to the bottom band.

**Palette by scope, never by value.** A product room is entered with `data-brand="<product>"` plus
`data-theme="light|dark"`, and the product's own token file on top. Never type a hex on a board.
Check `consistency.md` before trusting any product-folder copy of a token file.

## Reading a citation

A path in these files is relative to `docs/design/` unless it starts at a repo root directory.
`tokens/*.css` is shorthand for `web/src/styles/tokens/`.

The repo is the truth and Figma is the picture. A citation points at intent, not at evidence that
something exists.

## Conventions

- Canon that leans on a mechanism which already exists says **"this must be true"**, never "this is
  true". Requirement phrasing is what tells the build side a line is load-bearing.
