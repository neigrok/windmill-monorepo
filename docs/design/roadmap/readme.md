# Windmill Roadmap — product design

*Since 2026-07-31 this is the `roadmap/` folder of the one merged **Windmill Design
System** project — shared foundations sit one level up; drift ledger: `../consistency.md`.*

The RPG skill-tree app: steps are nodes, dependencies are branching paths, finishing one
step unlocks whatever comes next. This project holds everything whose subject is **the
tree** — the product's own components, its feature canon, and the explorations behind it.

**The design system is inherited, not copied.** Tokens, themes, and the product-neutral
component kit (core · forms · feedback · navigation) live in the *Windmill Design System*
project — which is now the root of this very project, one level up from this folder
(`../tokens/`, `../themes/`, `../components/`). Never fork a token into this folder —
change it at the source.

## What lives here

- `components/tree/` — the five roadmap-vocabulary components: **SkillNode** (the circular
  item node; locked/available/ember/complete, optional sub-task arc), **SkillConnector**
  (the curved branch), **Checklist** (the StepPanel sub-task list), **KindLegend** (the
  on-canvas colour key that is also its own editor), **ProgressBar** (branch completion).
  They sit here rather than in the design system because they are provably *not* free of
  product vocabulary — the same rule that keeps `web/src/design-system/` tree-free in the repo.
- `ui_kits/app/` — the web app kit: roadmap tree, item detail panel, dashboard, sidebar.
- `guidelines/` — the feature canon (see the decoder below).
- `explorations/` — the live specimen pages each spec cites.
- `briefs*.md` — the open-asks ledger to the designers.

## Spec codes — decoder

Canon lives where listed; some canon is an exploration file itself and never graduated to a
`guidelines/*.md`.

| Code | Concern | Canon |
|---|---|---|
| X2 | share identity (card / plaque / readout family) | `explorations/share-identity.html` |
| X3 | empty, loading & offline states; the bud canvas | `explorations/empty-loading-states.html` |
| X4 | account & sync chrome (seat, pill, conflict card) | `explorations/account-sync-chrome.html` — its old §2 auth sketch is superseded by X6 |
| X5 | read-only & mobile | `guidelines/responsive.md` |
| X6 | auth: claiming, not gating | `guidelines/auth.md` |
| X8 | mobile: the two view models + the input layer | `guidelines/mobile.md` |
| F1·F2 | durable progress & the tree registry | `explorations/progress-and-tree-registry.html` |
| F3 | paste-to-tree import | `guidelines/paste-import.md` |
| F4 | playable demo & fork | `guidelines/playable-demo.md` |
| F5 | starter quests | `guidelines/starter-quests.md` |
| F6 | colour legend (kinds as user vocabulary) | `explorations/color-legend.html` |
| F13 | node workspace (notes, links, checklist + ring) | `explorations/node-workspace.html` |
| F17 | MCP / LLM tools | `guidelines/mcp-connect.md` |
| editing v2 | on-canvas DAG editing | `explorations/dag-editing-interactions-v2.html` (v1 kept for its hover-gesture variations) |
| editing §07 | angular sibling reorder | `guidelines/angular-reorder.md` |
| editing §08 | multi-selection (marquee, grouped set, action bar) | `guidelines/multi-select.md` |
| shortcuts | keyboard-shortcuts overlay | `guidelines/keyboard-shortcuts.md` |
| gallery | the public wall + the in-product browse shelf | `guidelines/gallery.md` |
| X2 · og-tree | per-tree unfurl card | `guidelines/og-tree-cards.md` |
| X2 · og-video | per-tree share video (~3s loop) | `guidelines/og-share-video.md` |
| X2 · og-progress | the recurring week-N progress card | `guidelines/og-progress-card.md` |
| #16 · tending | the in-tree agent | `guidelines/tending.md` |
| — | the tree canvas geometry contract | `guidelines/tree-layout-contract.md` |
| — | the activity feed | `guidelines/event-log.md` |
| — | the Next up panel | `guidelines/whats-next.md` |
| — | capability-loss moments | `guidelines/honesty.md` |
| — | the signed-in landing | `guidelines/front-door.md` |
| — | node colour × state treatment | `guidelines/colors-node-states.card.html` |

## Tree layout & metaphor

Two deterministic modes, one identity rule. Small trees (≤ ~48 nodes — most personal
roadmaps) grow **radially from a centered root**, children fanning out in all directions. At
scale the canvas switches to **top-down dagre** (rank = dependency depth, laid out in a
worker, proven at 5k nodes). Manual nudges override either. The share portrait always uses
the tree's own canvas positions — mode follows the tree, never the surface, so a tweet, the
gallery, and the live page match.

Connectors are stroked bezier curves, even-width with a gentle stable bend; a branch that
starts in a **done** node lights up in that node's colour (no glow), otherwise it stays a
thin muted line. Nodes are flat, uniform circular discs, base size 56. **Colour and state are
decoupled**: a node's colour comes from its `kind` (one of six palette hues — terracotta,
olive, gold, brick, sky, plum), while progress is shown by treatment alone — **locked** nodes
are dimmed, **available** nodes are white discs with a solid kind ring, **in-progress** nodes
are the "ember" (kind-tinted fill, low breathing glow, no halo), and **complete** nodes are
bright and ringed by a glowing halo (breathing on the crowned root; static elsewhere). The
tier never re-hues a node.

The production renderer is a hand-rolled WebGL2 canvas (`src/skilltree/` in the repo);
`guidelines/tree-layout-contract.md` defines the visual contract it must match, and
`src/skilltree/theme.js` bridges the `--kind-*` tokens to hex for the GPU.

### Renderer sync — decided Jul 2026

The divergences found in the repo audit are resolved; this is the checklist until both sides
match.

| Decision | This canon | The repo |
|---|---|---|
| **Layout: both modes.** Radial for small trees (≤ ~48 nodes), dagre top-down at scale; share portraits always use the tree's own positions | ✓ contract §5 | make `RadialLayoutEngine` the small-tree default (engine already exists) |
| **Available tier = white fruit + solid kind ring**, no glow at rest | ✓ canon | re-sync the shader (it drew saturated fill per the retired dag-clean-colors exploration) |
| **Node base size = 56** everywhere | ✓ contract | ✓ already 56 |
| **Plum soft = `#D3ABC9`** (`--accent-plum-200`) | ✓ canon | fix the `#D9BDD4` typo in `theme.js` |

Also pending repo-side: the repo's `src/components/` and `src/styles/tokens/colors.css` are
stale forks of pre-kind×tier versions (old olive/gold state=colour SkillNode, the retired
`--node-active-*` gold ramp) and need a re-copy — tokens from the Design System project, the
tree components from here.

## What is deliberately *not* here

- **Foundations** — colour, type, spacing, radius, shadow, motion beats, the brand theming
  recipe. Design System project.
- **X1 motion language** — brand-wide, so it stays in the design system
  (`guidelines/motion-language.md`); ceremonies here cite it rather than inventing motion.
- **The marketing site, pricing, and transactional email** — Windmill Common marketing
  project. `guidelines/tending.md` here specifies the agent; the *price* of tending is
  stated there.
