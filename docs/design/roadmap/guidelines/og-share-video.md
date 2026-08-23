# Windmill Per-tree share video (og-share-video)

The motion companion to the per-tree unfurl card (`og-tree-cards.md`). Feeds that autoplay muted
video — X, LinkedIn, and the tree's own `windmill.works/t/<id>` landing hero — get a ~3-second
looping clip instead of a flat image: the tree grows itself, root to frontier, then rests. It is the
share-artifact cascade (`motion-language.md` §7) rasterized to a loop: same TreePortrait fit as the
card, same identity strip, same light-only single asset per tree.

## Scope

The clip attaches to every shared tree at whatever progress it happens to be, so it grows the whole
tree and ends on the finished portrait — which is also the poster and a legible thumbnail. Per-unlock
motion stays in-app as the unlock ceremony and as the milestone share offer, which shares the still
card.

## The loop — ~3s, seamless

Frame 0 == frame N == the grown tree, so there is no begin/end flash. Every transient (crown breath,
frontier pulse, travel heads) is windowed to zero at the cut.

```
HOLD    0–560ms    grown tree, crown breathing — identical to the poster
EXHALE  560–860    light dissolves to dormant — OPACITY ONLY
GROW    860–2650   root+crown ignite → depth rings bloom @320ms cadence, travels wake edges
PULSE   2600–2980  the newly-open frontier breathes ×2, decaying (exempt from budget)
SETTLE  →3000      rested === frame 0 → loops
```
- The grow obeys `CEREMONY_MAX` (≤2400ms first-ignite→last-settle); deep trees compress to the 160ms
  cadence floor.
- The readout ticks: `n/m` climbs with the blooms and the gradient bar fills.

## Frame

Identical TreePortrait viewBox-fit and `k = w/1200` chrome (mat `28·k`, rule `6·k`, panel radius
`18·k`, strip `96·k`, safe `4%`). Two ratios:
- **1:1 · 1080²** — primary; X & LinkedIn feed.
- **16:9 · 1280×720** — landing hero, embeds. Its center 1:1 crop is the square, so one render
  serves both by changing only the frame box.

## Autoplay & safe-frame

- Muted, no audio track.
- Keep the wordmark out of the bottom-right (mute / duration chrome) and the readout above the
  bottom 12% caption band. Type and root stay in the 4% safe inset; still and clip share one
  safe-frame.
- Poster = the tree's OG still (grown) = the first video frame, so the poster → autoplay handoff is
  invisible.

## Fallback

No autoplay (data saver, email) and `prefers-reduced-motion` both get the poster still. The clip is
an enhancement over the image, never a replacement — one light-only asset, no dark variant.

## Shipping

Generated from the tree's stored positions + progress at share time, same pipeline as the still card
(a headless capture of this timeline). One `<meta og:video>` + `og:image` poster per tree id. Target
≤2.5MB, ~24fps.
