# Windmill Starter quests — the shelf

The spec for the quest picker: where it lives, the card, the roster, and the card→plant ceremony.
The plant beat is ceremony #3 (`motion-language.md`), seeded by the card's own thumbnail.

> The inventory is the pitch. Nine calm doors and a dashed one — no tour, no counts, nothing loops.
> The shelf screenshot should work as a marketing asset with no caption.

---

## 1. Placement

- **First run (no trees):** the gallery route renders the shelf full-bleed — wordmark · title + sub
  (§7) · row **For developers** (4 quests) · row **For everything else** (5 quests + the
  bring-your-own card, pinned last, full-size).
- **After the first tree:** collapses to a one-row "Starter quests" rack pinned at the *end* of the
  gallery — never above your own trees. Dismissable per-account ("Hide starter quests" in the rack's
  overflow); returns only if the gallery empties again.
- **The TreeSwitcher stays lean:** one birth row — "New tree" — which lands here when no trees exist,
  on the bud canvas otherwise. The switcher never lists quests.
- **Marketing site:** the same shelf browses signed-out; picking a quest runs the one door first,
  then plants. The demo links here after fork: "More quests".

## 2. The card — a seed packet

- **Anatomy:** kind rule 3px top (the root's kind) · thumbnail · title (display) · readout (mono
  count + humble estimate) · kind dots bottom-right.
- **The thumbnail is the quest's real layout, rendered fresh:** crowned root available, first ring
  lit, the rest dim. No illustration, no stock art; the product is its own imagery.
- **Rest 82% ink; hover wakes to 100%** (150ms feedback fade, not a loop) + the standard Card lift.
  Nothing on the shelf animates at rest. No tooltip.
- **The crowned root is static — the shelf never breathes.** A seed-packet root wears the crown as a
  drawn signifier held at the resting halo (α .28), not the living breath. `motion-language.md` §4
  budgets exactly one infinite halo loop and it lives on the canvas — your planted tree — never on
  the gallery.
- **The kind dots are the quest's legend, previewed** — the same 3–5 hues the on-canvas key will
  show. The palette contract travels with the quest.
- **Click anywhere plants.** No detail page, no preview mode — the demo is where you feel the
  product. No progress, authors, or popularity counts; the social gallery keeps that job.
- **Estimates stay humble and human** ("a season", "two weekends", "~3 months") — never "12h 30m".
  Numeric form ("~3 months") in locales where the idiom doesn't travel.

## 3. The roster — nine, authored

| Quest | Steps | Est. | Kinds (legend) |
|---|---|---|---|
| Frontend path *(dev)* | 24 | ~4-6 months | Build · Learn · Ship |
| Rust from zero *(dev)* | 21 | ~3 months | Core · Practice · Ship |
| ML foundations *(dev)* | 26 | ~6 months | Theory · Data · Practice |
| Ship v1 *(dev)* | 14 | ~6 weeks | Build · Polish · Launch |
| Learn to sail | 17 | a season | Seamanship · Knots · Weather · Safety · Harbor |
| Run a 10k | 12 | ~12 weeks | Training · Race prep |
| Room makeover | 9 | two weekends | Make · Build |
| Personal finance reset | 11 | ~1 month | Habits · Systems |
| Learn watercolor | 13 | ~2 months | Technique · Studies |

- **Authored, not generated:** each quest is a curated tree with real prerequisite logic (Rust's
  ownership gates its lifetimes; the 10k's long runs gate race day), so the derived-unlock cascade
  feels earned on every one.
- **A curriculum's safety sets its estimate, never the reverse.** Run a 10k states in step one that
  it assumes you can already run ~3 km, and counts in weeks because a runner counts in weeks. Every
  estimate carries a `~` or an idiom.
- **Every quest passes the demo's test on itself:** one obvious first move, visible cascade.
- **Ownership:** design owns the roster; seasonal review; it grows editorially. A stale Frontend path
  is worse than none.
- The dev row leads; both rows use the same card.

## 4. Card → plant — ceremony #3, seeded by the thumb

1. **0ms — click.** The other cards fade (150ms, chrome speed) and the picked card's chrome — rule,
   title, readout — fades with them. Only its thumbnail tree remains.
2. **The thumbnail is the seed:** it eases to canvas center on the camera curve (600ms
   `--ease-soft`) while the root wakes to full size and takes the crown at 90% settle. No cut, no
   swap.
3. **Then #3 verbatim:** rings on the 320ms cadence, seeded jitter, edges with their ring. The quest
   arrives fresh — root + first ring available, everything else dim, then the plant toast (§7).
4. **Land selected-nothing, camera fitted,** plaque reading the quest's name, byline "yours". No
   coach here — the lit frontier is the invitation, and the first completion's ceremony teaches by
   itself.

Quests are copies, not subscriptions: yours diverges freely and never updates from the source. Undo
= delete via the switcher's confirm; the shelf returns if the gallery empties.

## 5. The bring-your-own card

A dashed card (the bud's own not-yet-a-tree language — no plus icon, no illustration) carrying both
roads: **"Blank tree"** (births the single-bud canvas) and **"Paste a plan"** (same canvas with the
paste composer already docked). It sits last but full-size — a peer, not an escape hatch. On narrow
racks it collapses to "Start your own" and splits on click.

## 6. Reduced motion

| Beat | Fallback |
|---|---|
| hover wake | instant ink swap; lift skipped — cards never move |
| card → plant | shelf cross-fades out, tree cross-fades in — one simultaneous 280ms beat |
| crown (during card → plant) | lands frozen at the resting halo (α .28) — the crown never breathes in |
| crown (on the shelf) | already static at α .28 (§2) |
| shelf at rest | already static |

## 7. Copy — every string

| Where | String |
|---|---|
| Shelf title | "Start a quest" · sub "Pick a tree to plant — or bring your own plan." |
| Row labels | "For developers" · "For everything else" |
| Card readout | "17 steps · a season" |
| Ghost card | "Blank tree" · "Paste a plan" |
| Plant toast | "Quest planted · 17 steps" |
| Rack | "Starter quests" · overflow "Hide starter quests" |

"Quest" appears in shelf chrome only — planted, the tree is a tree; the plaque never says quest. One
metaphor word per string.

## 8. Constants — copy into the build

```
SHELF     first-run gallery route, full-bleed · rack (1 row, end of gallery) after
CARD      kind rule 3px · real layout, fresh tiers · rest 82% ink → hover 100% (150ms)
          click = plant · no detail view · no vanity numbers
ROSTER    9 authored · dev wedge first · demo self-test gate · seasonal review
PLANT     ceremony #3 seeded by the thumb · shelf yields 150ms · camera 600ms
          land selected-nothing · no coach · toast "Quest planted · N steps"
GHOST     dashed card, full size, pinned last · Blank tree / Paste a plan
```

## 9. Ownership map

| Concern | Owner |
|---|---|
| Beat physics (#3), cadence, budget | `motion-language.md` |
| The paste road's composer + grammar | `paste-import.md` |
| Gallery placement and card anatomy | `gallery.md` |
| Shelf placement, the card, the roster, card→plant staging | this doc |

## 10. Phone

The shelf is one column below 744 (`responsive.md` §8's grid; cards keep the 320px acid floor) and
the two rows stack under their headings — never a horizontal carousel, since these are the first
thing a new user sees. Card → plant is the same tap, the same ceremony #3. The rack after the first
tree keeps its place at the end of the gallery and scrolls with it.
