# Brand foundations

The brand-level canon: the direction, the voice, the visual foundations, iconography, and the
standing policies on fonts and the logo. Product-specific canon lives in the product folders
beside this file; the drawn form of everything here is the Foundations page of the
Windmill · Design System Figma file, and the shipped values are `web/src/styles/tokens/`.

Carried from the design canon and trimmed to what is still binding — the sections describing an
older folder layout were dropped rather than kept as history.

## Direction (from the brief)
- Minimalistic, animation-rich
- Light, airy base with a warm Tuscan earth palette (terracotta / olive / gold)
- Organic vine/branch metaphor
- Warm, rounded, friendly typography
- Soft, glowy motion (pulses, fades) rather than mechanical or bouncy
- Simple line icons (Lucide)

## Caveats — please read
- **Built before the codebase existed.** This system was authored before the code existed — the repo had no commits at first build, so the visual direction here is original, inferred from the brief — not a
  recreation.
- **No logo file exists.** You described "spinning millstones" as a mark, but per policy this
  system never invents or draws a company's logo — only a wordmark (Baloo 2, plain type) is
  used wherever a mark would go. If you have an actual logo file, attach it and it'll be
  dropped into `assets/` and swapped in everywhere.
- **Fonts are Google Fonts substitutes**, not licensed brand fonts — see Typography below.

---

## Content fundamentals

No real product copy existed to study, so this voice is proposed, not observed — validate it
against how your team actually talks.

- **Voice**: encouraging and a little playful, but not jokey. Copy stays domain-neutral — it
  works for a room makeover, a fitness goal, or a product launch alike.
- **Person**: second person ("your roadmap", "you unlock") in the product; first-person
  plural ("we") only in about/company copy.
- **Casing**: sentence case everywhere — headings, buttons, nav. No ALL-CAPS except tiny
  badge/eyebrow labels, which use small-caps-style letter-spacing instead of visual shouting.
- **Emoji**: not used. The metaphor is carried by icons and glow, not emoji.
- **Sentence length**: short. One idea per sentence in UI copy; marketing copy allows one
  longer sentence per paragraph, max two clauses.

## Visual foundations

- **Colors**: warm Tuscan cream/sand canvas (`--neutral-50`, `#F9F5EB`) — never cold gray.
  Natural earth hues carry all brand/interactive meaning: **terracotta** (primary — CTAs),
  **olive** (available/success/growth), **gold** (ochre — warnings, small flourishes; a
  *kind*, never a state). Brick red is reserved for danger; a muted Tuscan-sky blue exists
  for info only. Nothing vivid or "chemical" — every hue is muted toward earth. See
  `guidelines/colors-*.card.html`.
- **Theming (light + dark)**: light is the default. A full dark theme ships as a token layer
  scoped to `[data-theme="dark"]` — set it on `<html>` for the whole app, or on any element
  to darken just that subtree. Because every surface, border, text and glow token is
  redefined under that scope, all components adapt with no per-component work. Dark is a warm
  brown-black "night sky" (never cold gray): a near-black canvas with slightly-elevated
  warm-dark cards, warm off-white text, brighter accent steps, and intensified glows. See
  `guidelines/colors-dark-theme.card.html`.
- **Type**: two families. **Baloo 2** (rounded, bold, high personality) for display — page
  headers, big numbers. **Nunito** (rounded, readable) for body/UI text. **JetBrains Mono**
  for count readouts ("6/17 done") and item IDs only — never for prose.
- **Spacing**: 4px base unit, scale runs 4→128px (`--space-1`…`--space-32`). Generous padding
  throughout — nothing feels cramped.
- **Backgrounds**: flat color, no photography, no gradients as backgrounds. The one gradient
  in the system is a two-stop terracotta→gold fill used only on a progress bar — a deliberate
  small flourish, not a motif.
- **Animation**: soft and glowy, never mechanical or bouncy. The full beat vocabulary,
  composition grammar, and calm ceiling are specified in `guidelines/motion-language.md` —
  treat that as canon for any animated moment.
  - Standard UI transitions: `--ease-standard` (150–280ms) for hover/press color changes.
  - Entrances: `--ease-soft` (expo-out), fade+rise (`wm-fade-in-up`) for panels, toasts,
    dropdowns.
  - `wm-pulse-node` is a colour-agnostic 2.4s breathing box-shadow loop that reads its glow
    from `--nd-glow`; `wm-ember` is the lower-amplitude sibling on the same clock, frozen at
    mid-breath under reduced motion. The calm ceiling — exactly one infinite loop on screen —
    is a motion-doc rule, and where those loops are spent is the consuming product's call.
  - No infinite decorative loops outside a product's own canvas.
- **Hover states**: backgrounds shift to a slightly darker neutral (`--surface-hover`) or the
  brand-soft tint for selected/active items — never pure opacity fades on solid fills.
- **Press states**: primary buttons scale to 0.97 (soft compress, not a bounce).
- **Borders**: 1–1.5px, always `--border-subtle`/`--border-default` (warm neutral), never
  pure black.
- **Shadows**: soft, warm-tinted, low-opacity (`rgba(33,27,19,…)`), 4 levels from `xs` to
  `lg`. A separate glow-shadow system (`--glow-olive`, `--glow-gold`, `--glow-terracotta`,
  `--glow-ember`) exists for products that light things up.
- **Corner radii**: generously rounded throughout — 8px (chips/inputs) up to 32px (large
  cards), full pill for buttons/tags/tabs.
- **Cards**: white surface, 24px radius, 1px subtle border, soft shadow; `hoverable` cards
  lift 2px and deepen their shadow on hover — no colored left-border accent.
- **Transparency/blur**: used only for the modal overlay (`--surface-overlay`, a translucent
  warm black) — no frosted-glass/backdrop-blur elsewhere.
- **Imagery**: none currently — no photography exists for this brand.
- **The skill-tree metaphor** — node geometry, kind × tier colouring, connector behaviour and
  the layout contract — is the roadmap's, and lives in `roadmap/`. The palette it
  draws from (`--kind-*`, `--connector-*`, `--color-bark`, `--color-leaf`) stays here,
  because a sibling product re-points those hues rather than redefining them.

## Iconography

- **System**: [Lucide](https://lucide.dev) — simple, consistent 2px-stroke line icons, loaded
  from CDN. This is a **substitution**: no icon set shipped with the brand brief, and Lucide
  was chosen as the closest free match to the "simple line icons" direction you picked.
- **Usage**: `<i data-lucide="name">` + `lucide.createIcons()`, or the small `Icon`/`WMIcon`
  wrapper. Components never bundle icons directly — `Button`/`IconButton` accept an `icon`
  prop so any icon source works.
- **Unicode glyphs**: used minimally for tiny UI chrome only (the `×` close glyph on
  Tag/Toast, the `▾` caret on Select) — not as illustrative icons.
- **No SVG illustrations exist** in this system — none were provided, and none were
  hand-drawn per policy.

## Font substitution — please provide real files if you have them
No font files were attached. **Baloo 2** and **Nunito** (plus **JetBrains Mono**) were chosen
from Google Fonts as the nearest match to "warm rounded sans." They're loaded via a Google
Fonts CSS import in `tokens/fonts.css`. If Windmill has licensed fonts, drop the `.woff2`
files in `assets/fonts/` and swap the `@font-face`/`@import` in that file — nothing else
needs to change.

## Logo
No logo file was provided. Every place a mark would appear uses the plain wordmark "Windmill"
set in Baloo 2 Bold — **no logo has been drawn or invented**, per policy. Attach a real logo
(SVG/PNG) and it will be copied into `assets/` and used everywhere a mark currently reads as
text.

---

### Components
Avatar, Badge, Button, Card, Checkbox, Dialog, IconButton, Input, Radio, Select, Switch,
Tabs, Tag, Toast, Tooltip.

No component source existed to define an inventory, so a standard set was authored, sized
to a small SaaS app. The five Windmill-specific families that were once grouped here —
**SkillNode**, **SkillConnector**, **Checklist**, **KindLegend**, **ProgressBar** — now live
with the roadmap product (`web/src/products/roadmap/ui/tree/`): they are the roadmap's
vocabulary, not the brand's, and a sibling
product would inherit words it has no use for. `ProgressBar` moved with them because its
only use was branch completion; if notes or gym needs a generic bar, author one here rather
than reaching across.
