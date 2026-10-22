# Design canon — the written half

Brand-wide rules and open design gaps. Figma holds the drawings, with a status emoji on every
board; the code is the truth for behaviour. The product, shell and library drawings live in six
Figma files.

| File | Key |
|---|---|
| Windmill · Design System (the published library) | `qoOwNbWOYE1GFi0yR5uGY2` |
| [Windmill · Shell](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf) | `tkI7GnS6TcZvQSDi9lwrBf` |
| Windmill · Roadmap | `HM4d8YWzJZg5clVRJKNuDr` |
| Windmill · Journal | `pC6ciOUnfLmI42oMihd7l3` |
| Windmill · Gym (web · iOS · Android) | `vdmdiKWrmZoS1FtcvJRf6O` |
| Windmill · Marketing | `uWLMdVmzTcobOh8hbeem81` |

Gym's canonical Coach-led onboarding lives on the Gym file's page
[Gym · iOS](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-2),
in [Gym onboarding · Coach-led](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1081-565).
The Gym file's [iOS READ ME](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/?node-id=11-25)
links directly to this flow. Shared workout and account boards stay linked from the canonical flow.

The approved logo is [Windmill, node 9:129](https://www.figma.com/design/v21I1eIsWkyIaN7byJ8GdV/Windmill?node-id=9-129);
its assets and usage are in `brand-foundations.md`, "Logo".

These documents hold rules that outlive any one screen and the questions still open. A screen's
behaviour is not restated here: it is in the code, and its picture is in Figma.

## Layout

| Path | Holds |
|---|---|
| `consistency.md` | The drift ledger — disagreements between drawings, written rules and code. Start here for consistency work. |
| `brand-foundations.md` | Direction, voice, the honesty rules, visual foundations, iconography, fonts, the logo, and each product's standing principles. |
| `guidelines/system-architecture.md` | The four layers that travel between products, the colour contract, the interaction laws (native idiom, gestures), grounds. |
| `guidelines/motion-language.md` | The motion beats, their composition and the calm ceiling. |
| `guidelines/text-budget.md` | How many words an element may spend. |
| `guidelines/thumb-reach.md` | Where controls, guidance and identity sit on a phone. |
| `ios/ios-redesign.md` | The iOS app's principles and its colour roles by room, which `apps/ios/App/Tools/tests/test_theme_assets.py` checks against the colour assets. |

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
