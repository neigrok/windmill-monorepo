# Windmill Per-tree unfurl card (og-tree-cards)

Each shared tree at `windmill.works/t/<id>` unfurls as itself — its own 1200×630 card, not the
generic `og-image.png`.

> Light only. Scrapers rasterize the meta image with no theme, so there is one asset per tree; the
> warm mat keeps it clean on dark feeds anyway.

## TreePortrait — the fit

- Take the tree's own node positions, compute their bounding box including glow radius, pad 8%, and
  render into an SVG whose `viewBox` is that padded box with `preserveAspectRatio="xMidYMid meet"`.
- Any tree — wide, tall, sparse — centers and scales to fill the panel with no per-tree tuning and
  no layout-mode branch: the portrait reads the tree's own positions, so mode follows the tree, not
  the surface.
- Clamp the fit scale so a 3-node tree sits centered at a sane size rather than filling the frame.
- Node treatments are the in-app ones: crowned root, kind hues, glowing done halos, white available
  rings, sunken locked.

## Layout — everything off `k = w/1200`

```
MAT     28·k  warm-white postcard border (sides + top)
RULE     6·k  dominant-kind bar, full width, top
PANEL   inset by mat; radius 18·k; 1.5·k border in kind-soft; holds the portrait
STRIP   96·k tall (min 84px) · padding 46·k · bottom edge · contents centred
SAFE     4%   (48px @1200) — the PANEL rule: the portrait, the root and where the
              strip's type starts must sit inside it on the sides and top
FLOOR   16·k  nothing in the strip may come closer to the card's BOTTOM edge
CROP    1:1   center square (Reddit thumb) must hold root + most lit nodes
```
- `4%` is not a bottom-edge rule. The mat is sides + top, so the strip's own centring sets the
  bottom clearance: the readout row sits `17·k` off the edge, the watermark `32·k`. `FLOOR` is the
  checkable rule — the tightest crop a client takes is 2:1, `15·k` off each long edge. Re-measure it
  whenever a strip changes.
- The 1:1 crop cuts the sides, keeping full height and dropping the strip's outer ends, so the crop
  requirement is scoped to the portrait, not the strip.

## Type & identity

- **Title** — Baloo 2 bold, `30·k`, sentence case, one line, `text-overflow: ellipsis`, led by a
  kind dot. The strip is title only; the readout is separate.
- **Readout** — `n/m` in JetBrains Mono `15·k` + the one terracotta→gold gradient bar.
- **Watermark** — "Made with **Windmill** →", `20·k`, wordmark always terracotta regardless of the
  kind rule.
- **Dominant kind** = most common kind among done nodes (tie → terracotta). Tints only the rule, the
  title dot and the panel edge.

## Shipping

- Render at @2x (2400×1260). One recipe serves X `summary_large_image`, LinkedIn, Slack, Discord and
  Reddit link previews.
- `<meta property="og:image">` per tree id; the card is generated from the tree's stored positions +
  progress at share time.
