# Windmill Roadmap — product design

Roadmap's written canon. Brand-wide foundations are in `../brand-foundations.md` and
`../guidelines/`; the drift ledger is `../consistency.md`.

The RPG skill-tree app: steps are nodes, dependencies are branching paths, finishing one step
unlocks whatever comes next. Everything whose subject is **the tree** lives here.

**The design system is inherited, not copied.** Tokens and the product-neutral component kit
(core · forms · feedback · navigation) live in code — `web/src/styles/tokens/` and
`web/src/design-system/`. Never fork a token into this folder; change it at the source.

## What lives here

- `guidelines/` — the feature canon (decoder below).
- `briefs.md` — the open asks to the designers.

## Spec codes — decoder

| Code | Concern | Canon |
|---|---|---|
| X5 | read-only & mobile | `guidelines/responsive.md` |
| X6 | auth: claiming, not gating | `guidelines/auth.md` |
| X8 | mobile: the two view models + the input layer | `guidelines/mobile.md` |
| F3 | paste-to-tree import | `guidelines/paste-import.md` |
| F4 | playable demo & fork | `guidelines/playable-demo.md` |
| F5 | starter quests | `guidelines/starter-quests.md` |
| F17 | MCP / LLM tools | `guidelines/mcp-connect.md` |
| editing §07 | angular sibling reorder | `guidelines/angular-reorder.md` |
| editing §08 | multi-selection (marquee, grouped set, action bar) | `guidelines/multi-select.md` |
| shortcuts | keyboard-shortcuts overlay | `guidelines/keyboard-shortcuts.md` |
| gallery | the public wall + the in-product browse shelf | `guidelines/gallery.md` |
| X2 · og-tree | per-tree unfurl card | `guidelines/og-tree-cards.md` |
| X2 · og-video | per-tree share video (~3s loop) | `guidelines/og-share-video.md` |
| X2 · og-progress | the recurring week-N progress card | `guidelines/og-progress-card.md` |
| tending | the in-tree agent | `guidelines/tending.md` |
| — | the tree canvas geometry contract | `guidelines/tree-layout-contract.md` |
| — | the activity feed | `guidelines/event-log.md` |
| — | the Next up panel | `guidelines/whats-next.md` |
| — | capability-loss moments | `guidelines/honesty.md` |
| — | the signed-in landing | `guidelines/front-door.md` |

Concerns with no written canon in this folder: **X2** share identity
(card / plaque / readout family) · **X3** empty, loading & offline states · **X4** account & sync
chrome · **F1·F2** durable progress & the tree registry · **F6** colour legend (kinds as user
vocabulary) · **F13** node workspace (notes, links, checklist + ring) · **editing v2** on-canvas
DAG editing.

## Tree layout & metaphor

The canvas lays out radially from a centered root: each node sits on the ring for its trunk
depth, at the center of an angular wedge, wedges split among children by subtree leaf count.
The share portrait always uses the tree's own canvas positions, so a tweet, the gallery and the
live page match.

Connectors are stroked bezier curves, even-width with a gentle stable bend; a branch that starts
in a **done** node lights up in that node's colour (no glow), otherwise it stays a thin muted
line. Nodes are flat, uniform circular discs, base size 56.

**Colour and state are decoupled.** A node's colour comes from its `kind` — one of six palette
hues (terracotta, olive, gold, brick, sky, plum) — and progress is carried by treatment across
four tiers: **locked** dimmed, **available**, **ember** (in-progress, low breathing glow, no
halo), **complete** (bright, glowing halo — breathing on the crowned root, static elsewhere).
The tier never re-hues a node.

The production renderer is a hand-rolled WebGL2 canvas (`web/src/products/roadmap/scene/`);
`guidelines/tree-layout-contract.md` defines the visual contract it must match, and
`web/src/products/roadmap/theme.js` bridges the `--kind-*` tokens to hex for the GPU.

## Deliberately not here

- **Foundations** — colour, type, spacing, radius, shadow, motion beats, the brand theming
  recipe: `../brand-foundations.md`, `../guidelines/system-architecture.md`.
- **X1 motion language** — brand-wide: `../guidelines/motion-language.md`. Ceremonies here cite
  it rather than inventing motion.
- **The marketing site, pricing, and transactional email** — `../marketing/`.
