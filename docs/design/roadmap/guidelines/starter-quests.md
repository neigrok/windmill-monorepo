# Windmill Starter quests — the shelf (F5)

The canonical spec for the quest picker: where it lives, the card, the roster,
and the card→plant ceremony. Cards descend from X2's gallery card
(`explorations/share-identity.html`); the plant beat is ceremony #3
(`motion-language.md`), seeded by the card's own thumbnail. **Supersedes X3
§2.3's "Plant your first tree" block for the first-run gallery route only**
(noted in `explorations/empty-loading-states.html`); X3's grammar still owns
every other empty state. Live specimens: `explorations/quest-picker.html`.

> **Principle: the inventory is the pitch.** Nine calm doors and a dashed one —
> no tour, no counts, nothing loops. The shelf screenshot should work as a
> marketing asset with no caption.

---

## 1. Placement

- **First run (no trees):** the gallery route renders the shelf full-bleed —
  wordmark · "Start a quest" · "Pick a tree to plant — or bring your own
  plan." · row **For developers** (4 quests) · row **For everything else**
  (5 quests + the bring-your-own card, pinned last, full-size).
- **After the first tree:** collapses to a one-row **"Starter quests"** rack
  pinned at the *end* of the gallery — never above your own trees.
  Dismissable per-account ("Hide starter quests" in the rack's overflow);
  returns only if the gallery empties again.
- **The TreeSwitcher stays lean** (F1·F2 §4): one birth row — "New tree" —
  which lands here when no trees exist, on the bud canvas otherwise. The
  switcher never lists quests.
- **Marketing site (decided):** the same shelf browses signed-out; picking a
  quest runs X4's one door first, then plants. The demo (F4) links here after
  fork: "More quests".

## 2. The card — a seed packet

- **Anatomy:** kind rule 3px top (the root's kind — X2's share-card rule) ·
  thumbnail · title (display) · readout ("17 steps · a season" — mono count,
  humble estimate) · kind dots bottom-right.
- **The thumbnail is the quest's real layout, rendered fresh:** crowned root
  available, first ring lit, the rest dim — a tree that hasn't happened yet,
  waiting. No illustration, no stock art; the product is its own imagery.
- **Rest 82% ink; hover wakes to 100%** (150ms feedback fade, not a loop) +
  the standard Card lift. Nothing on the shelf animates at rest. No tooltip —
  the card already says everything a hover could.
- **The crowned root is static — the shelf never breathes (ruling, Jul 2026).**
  A seed-packet root wears the crown as a *drawn signifier* — "this is the
  tree's root" — held at the resting halo (α .28), not the living breath. The
  breath is **earned at plant**: `motion-language.md` §4 budgets *exactly one*
  infinite halo loop and it lives on the canvas — your planted tree — never on
  the gallery. Nine cards, nine still crowns; "nothing loops" is the shelf's
  whole pitch (§Principle). The α-.28 freeze in §6 is not evidence of a resting
  loop — it's the reduced-motion end-state of the *plant* crown (§4), which is
  the only place the crown moves from here.
- **The kind dots are the quest's legend, previewed** — the same 3–5 hues the
  on-canvas key (F6) will show. The palette contract travels with the quest.
- **Click anywhere plants.** No detail page, no preview mode (the demo is
  where you feel the product; decided — revisit only if telemetry shows
  plant-then-delete churn). No progress, authors, or popularity counts — seed
  packets, not a feed; the social gallery (X5 §8) keeps that job.
- **Estimates stay humble and human** ("a season", "two weekends", "~3
  months") — never "12h 30m". Decided: numeric form ("~3 months") in locales
  where the idiom doesn't travel.

## 3. The roster — nine, authored

| Quest | Steps | Est. | Kinds (legend) |
|---|---|---|---|
| Frontend path *(dev)* | 24 | ~4 months | Build · Learn · Ship |
| Rust from zero *(dev)* | 21 | ~3 months | Core · Practice · Ship |
| ML foundations *(dev)* | 26 | ~4 months | Theory · Data · Practice |
| Ship v1.0 *(dev)* | 14 | ~6 weeks | Build · Polish · Launch |
| Learn to sail | 17 | a season | Seamanship · Knots · Weather · Safety · Harbor |
| Run a 10k | 12 | ~12 weeks | Training · Race prep |
| Room makeover | 9 | two weekends | Make · Build |
| Personal finance reset | 11 | ~1 month | Habits · Systems |
| Learn watercolor | 13 | ~2 months | Technique · Studies |

- **Authored, not generated:** each quest is a curated tree with real
  prerequisite logic (Rust's ownership gates its lifetimes; the 10k's long
  runs gate race day) — the derived-unlock cascade must feel earned on every
  one.
- **Run a 10k is ~12 weeks, and says so honestly (ruling, Jul 2026).** A
  curriculum review caught the old 8-week ramp reaching 9 km by week six — the
  too-much-too-soon pattern that hurts knees. Kept both build fixes: step one
  states plainly that the quest assumes you can already run ~3 km, and the
  estimate is now **~12 weeks** (also retiring the roster's one bare number —
  every other estimate carries a `~` or an idiom). Weeks, not months: a runner
  counts in weeks. We'd rather be honest than pinned — the number follows the
  safe curriculum, never the reverse.
- **Every quest passes F4's test on itself:** one obvious first move, visible
  cascade — or it doesn't ship.
- **Ownership (decided):** design owns the roster; seasonal review; grows
  editorially. A stale Frontend path is worse than none.
- The dev wedge leads; the second row proves the breadth. Same card, same
  dignity.

## 4. Card → plant — ceremony #3, seeded by the thumb

1. **0ms — click.** The other cards fade (150ms, chrome speed) and the picked
   card's chrome — rule, title, readout — fades with them. Only its thumbnail
   tree remains.
2. **The thumbnail is the seed:** it eases to canvas center on the camera
   curve (600ms `--ease-soft`) while the root wakes to full size and takes
   the crown at 90% settle. No cut, no swap (X3 §3.1).
3. **Then #3 verbatim:** rings on the 320ms cadence, seeded jitter, edges with
   their ring. The quest arrives fresh — root + first ring available,
   everything else dim. Toast: "Quest planted · 17 steps".
4. **Land selected-nothing, camera fitted,** plaque reading the quest's name,
   byline "yours". **No coach here** — the F4 chip belongs to the demo; the
   lit frontier is the invitation, and the first completion's ceremony (#4)
   teaches by itself.

- **Copies, not subscriptions:** yours diverges freely and never updates from
  the source — same rule as forks (X5). Undo = delete via the switcher's
  confirm (F1·F2 §4.3); the shelf returns if the gallery empties.

## 5. The bring-your-own card

- A **dashed card** (the bud's own not-yet-a-tree language — no plus icon, no
  illustration) carrying both X3 roads: **"Blank tree"** (births the
  single-bud canvas, X3 §2.2) and **"Paste a plan"** (same canvas with F3's
  composer already docked).
- Sits last but full-size — a peer, not an escape hatch. On narrow racks it
  collapses to "Start your own" and splits on click.

## 6. Reduced motion

| Beat | Fallback |
|---|---|
| hover wake | instant ink swap; lift skipped — cards never move |
| card → plant | shelf cross-fades out, tree cross-fades in — one simultaneous 280ms beat |
| crown (during card → plant) | lands frozen at the resting halo (α .28) — the crown never breathes *in* |
| crown (on the shelf) | already static at α .28 (§2) — nothing to reduce; it never breathed |
| shelf at rest | already static — nothing to reduce |

## 7. Copy — every string

| Where | String |
|---|---|
| Shelf title | "Start a quest" · sub "Pick a tree to plant — or bring your own plan." |
| Row labels | "For developers" · "For everything else" |
| Card readout | "17 steps · a season" |
| Ghost card | "Blank tree" · "Paste a plan" |
| Plant toast | "Quest planted · 17 steps" |
| Rack | "Starter quests" · overflow "Hide starter quests" |

"Quest" appears in shelf chrome only — planted, the tree is a tree; the plaque
never says quest. One metaphor word per string, X3 canon.

## 8. Constants — copy into the build

```
SHELF     first-run gallery route, full-bleed · rack (1 row, end of gallery) after
CARD      kind rule 3px · real layout, fresh tiers · rest 82% ink → hover 100% (150ms)
          click = plant · no detail view · no vanity numbers
ROSTER    9 authored · dev wedge first · F4 self-test gate · seasonal review
PLANT     ceremony #3 seeded by the thumb · shelf yields 150ms · camera 600ms
          land selected-nothing · no coach · toast "Quest planted · N steps"
GHOST     dashed card, full size, pinned last · Blank tree / Paste a plan
```

## 9. Ownership map

| Concern | Owner |
|---|---|
| Beat physics (#3), cadence, budget | `motion-language.md` |
| Card family anatomy (rule, readout, acid floor) | X2 (`explorations/share-identity.html`) |
| Every other empty state; the bud canvas both roads land on | X3 (`explorations/empty-loading-states.html`) |
| The paste road's composer + grammar | `paste-import.md` (F3) |
| Gallery placement, registry, switcher | F1·F2 (`explorations/progress-and-tree-registry.html`) |
| Shelf placement, the card, the roster, card→plant staging | **this doc** |

## Phone

The shelf is **one column** below 744 (X5 §8's grid; cards keep the 320px acid
floor) and the two rows stack under their headings — never a horizontal carousel:
these are the first thing a new user sees, not a shelf appended to work they
already have (contrast `gallery.md` §8). Card → plant is the same tap, the same
ceremony #3. The rack after the first tree keeps its place at the end of the
gallery and scrolls with it.
