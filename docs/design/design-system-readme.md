# Windmill Design System

Windmill is a brand of three self-growth products — **roadmap** (goals as an RPG skill
tree), **notes** (daily notes), and **gym** (training log) — behind one account and one
subscription, presented as one superapp per surface. This project is the layer all three
share: tokens, themes, the product-neutral component kit, and the brand itself.

**The root of this project holds nothing that belongs to one product.** A file earns a
place at the root only if it is provably free of product vocabulary. Product canon lives in
the product's own folder — `roadmap/`, `journal/`, `gym/`, `marketing/` — which inherits
this system by reference, one level up (`../tokens/`, `../styles.css`). The four satellite
projects were merged in on 2026-07-31 so consistency work happens in one place; the drift
found while merging is ledgered with exact values in `consistency.md`.

## Where everything lives

| Where | Holds |
|---|---|
| **root** — `tokens/` `themes/` `components/` `guidelines/` `explorations/` `assets/` | tokens · themes · core/forms/feedback/navigation components · foundation specimen cards · brand identity · the sibling-product recipe |
| **`roadmap/`** | the skill-tree product: `roadmap/components/tree/`, the app kit (`roadmap/ui_kits/app/`), every feature spec (paste-import, tending, gallery, mobile, auth, OG share family…) and the explorations behind them |
| **`marketing/`** | the windmill.works site, the legal shelf, pricing, and the transactional-email family — deliberately self-contained on a read-only kit mirror (see `marketing/readme.md` and `consistency.md` §5) |
| **`journal/`** | the daily-journal product: the canvas/system/landing boards and `journal/journal.md` canon |
| **`gym/`** | the training-log product: briefs `gym/briefs/00–08`, the scoped palette `gym/gym-tokens.css`, the iOS frame |
| **`consistency.md`** | the cross-product drift ledger — start there for consistency work |

## Direction (from the brief)
- Minimalistic, animation-rich
- Light, airy base with a warm Tuscan earth palette (terracotta / olive / gold)
- Organic vine/branch metaphor
- Warm, rounded, friendly typography
- Soft, glowy motion (pulses, fades) rather than mechanical or bouncy
- Simple line icons (Lucide)

## Index
- `consistency.md` — **the cross-product drift ledger**: what has forked between root and
  the product folders, exact values, and which direction each fix flows
- `roadmap/` · `journal/` · `gym/` · `marketing/` — the product folders; each keeps its
  satellite-era readme (or canon doc), opening with its place in the merged layout
- `guidelines/system-architecture.md` — **what travels to the next product**: the four layers
  (foundation · kit · patterns · product vocabulary), the colour contract (a sibling
  re-points one hue; semantics never move), the new-hue recipe, and the ten-step order for
  starting a sibling. Mechanism: `themes/brands.css` (`[data-brand="…"]`, composes with
  `[data-theme="dark"]`). Live proof: `explorations/system-layers.html`
- `guidelines/thumb-reach.md` — **where a phone screen puts its controls** (whole-system): the
  three bands (identity top · guidance centred middle · controls in the bottom reach band), what
  it forbids (top-anchored stacks with dead space, a primary button inside a mid-scroll card), and
  the five-second check. Live specimen: `guidelines/thumb-reach.card.html`
- `guidelines/motion-language.md` — **the motion cheat-sheet** (X1): the five beats (bloom,
  travel, camera ease, toast, crown/pulse), cascade cadence, the calm ceiling, the
  reduced-motion map. Products cite this instead of inventing motion. Live specimens:
  `explorations/motion-language.html`
- `guidelines/superapp-shell.md` — **the iOS superapp shell** (S1): how the three products
  sit in one app — the hub, the capsule, the switcher, and the two seats a product must
  reserve. Owns the chrome *between* apps and nothing inside them. Live boards:
  `templates/superapp-shell/` (resolved) and `templates/superapp-ios/` (the options archive)
- `guidelines/superapp-flow.md` — **the journey** (S2): where a first launch starts, what
  works signed out, when the claim is offered, and the one-screen onboarding each app owes.
  Live board: `templates/superapp-flow/`. Per-app expansions live in the product folders
  — first one: `journal/onboarding.md` (board: `templates/journal-onboarding/`)
- `styles.css` — root stylesheet, imports everything below
- `tokens/` — colors, fonts, typography, spacing, radius, shadows, motion (keyframes + easings)
- `themes/brands.css` — **per-product brand themes**: `[data-brand="clay"]` (Windmill's
  default), `"plum"` (a hue the palette already holds), `"iris"` (a new hue authored to
  the recipe) and `"journal"` (the night-default sibling — candle lamp on a cool dusk;
  the one neutral-ramp exception, `system-architecture.md` §4a) and `"gym"` (iris on stone —
  the giaggiolo; steel retired 2026-08-07, brief G2 resolved). Six declarations each, plus a dark pairing
- `guidelines/*.card.html` — foundation specimen cards (shown in the Design System tab):
  colour ramps, type, spacing, radius & shadow, motion beats, responsive breakpoints, the
  wordmark, the email shell, system layers, the project map (one brand · three products,
  with status per product)
- `components/core/` — Button, IconButton, Badge, Tag, Avatar, Card
- `components/forms/` — Input, Select, Checkbox, Radio, Switch
- `components/feedback/` — Tooltip, Dialog, Toast
- `components/navigation/` — Tabs
- `assets/` — production brand exports: `og-image.png` (1200×630 social preview), app icons
  (512/192/180), `favicon-32.png` + `favicon.ico`, `site.webmanifest`. Artboards +
  `<head>` wiring snippet: `explorations/brand-assets.html` (re-export from there). Icons
  are the Baloo "W" letterform — still no invented logo, per policy.
- `templates/landing-*` — the light-theme landing family (main + roadmap + journal + gym):
  one scaffold, four instances; the only style difference between pages is the
  `data-brand` scope (clay · clay · journal · gym), per the sibling contract
- `templates/superapp-shell/` — the resolved iOS shell (hub · capsule · switcher · You ·
  Windmill One), `templates/superapp-flow/` — entry, first runs and the claim, and
  `templates/superapp-ios/` — the three shell options they were chosen from
- `SKILL.md` — portable skill definition for Claude Code / other agents

### Components
Avatar, Badge, Button, Card, Checkbox, Dialog, IconButton, Input, Radio, Select, Switch,
Tabs, Tag, Toast, Tooltip.

No component source existed to define an inventory, so a standard set was authored, sized
to a small SaaS app. The five Windmill-specific families that were once grouped here —
**SkillNode**, **SkillConnector**, **Checklist**, **KindLegend**, **ProgressBar** — now live
in the Roadmap project: they are the roadmap's vocabulary, not the brand's, and a sibling
product would inherit words it has no use for. `ProgressBar` moved with them because its
only use was branch completion; if notes or gym needs a generic bar, author one here rather
than reaching across.

## Caveats — please read
- **Built before the codebase existed.** The `neigrok/windmill` repo had no commits at first
  build, so the visual direction here is original, inferred from the brief — not a
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
  the layout contract — is the roadmap's, and lives in the Roadmap project. The palette it
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

## How canon states a dependency on the code — convention

Where a doc leans on a mechanism that already exists, it says **"this must be true"**, never
"this is true." The second phrasing reads as a description, and a description nobody checks
can be false for a whole release without anyone noticing — the roadmap's `gallery.md` §6 once
asserted that ranking handled abandoned trees while the column it ranked on ignored progress
marks entirely. Requirement phrasing is what tells the build side a line is load-bearing.

Same rule for numbers: a figure that is a *reading* of the spec at one size ("lands near
`2.4·k` at the clamped fit") must be marked as such, and the spec itself stated in the units
the renderer works in — ratios where everything around it is a ratio.

## The merge — 2026-07-31

The four satellites (Roadmap `19f67675`, Journal `99259a8c`, Gym `7f9591c1`, Common
marketing `5b6ff5b3`) were collapsed into this project as `roadmap/`, `journal/`, `gym/`
and `marketing/`, each preserving its internal layout. The old projects hold only a
`MOVED.md` tombstone.

- Cross-project citations now resolve *inside* this project — prefix the folder:
  `guidelines/email.card.html` → `marketing/guidelines/email.md` + `marketing/ui_kits/email/*`;
  `guidelines/responsive.card.html` → `roadmap/guidelines/responsive.md`;
  motion-language's ceremony citations → `roadmap/guidelines/tree-layout-contract.md`.
- Kit references were re-aimed at the root: the gym/journal boards' `_ds/…/` paths became
  `../`, roadmap's boards and cards gained one `../` (the satellites resolved the kit at
  their own root), and marketing's once-dangling links to roadmap explorations now resolve
  via `../../../roadmap/explorations/…`. Marketing's own kit *mirror* was left untouched on
  purpose — see `consistency.md` §5.
- `_ds_manifest.json` is regenerated from the merged layout (the merge-day hand-patched
  copy is gone). `_adherence.oxlintrc.json` is generated and was left untouched.

### The curation pass — same day

The drift the merge exposed was closed the same day; `consistency.md` keeps the receipts
in its **Closed** section. Graduated to root: the `journal` brand block (with the
night-ramp exception written into `system-architecture.md` §4a) and the `wm-ember`
reduced-motion guard. Re-mirrored: marketing's `tokens/colors.css` (revised lamp ramp) and
`themes/brands.css`. Discarded: `journal/src/` (an unreferenced token fork — the boards
load the root kit; the repo owns shipped copies), `journal/scraps/`, and the brand-brief
print-export artifact. Fixed: two roadmap cards that never compiled (host preamble above
their `@dsCard` line), now grouped with the app kit under **Roadmap** in the Design System
tab. Still open, deliberately: gym's light-skin literals (ledger §1 — the fix is
build-side theme scoping) and the marketing mirror's standing rules (ledger §2).
