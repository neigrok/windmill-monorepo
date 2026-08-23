# Windmill The public gallery (#18)

The share loop's repeat-discovery surface: a wall of **public** trees a stranger
can browse after arriving from one shared link. The wall itself shipped ahead of
the design (`/gallery`, server-rendered, fork-ranked); this doc is canon for the
half that was left open — **the in-product surface, the loading state, and the
sort control** — plus the rulings on the build side's five calls. The card is
X2 #12 / X5 §8 and is not reopened. Live specimens:
`explorations/gallery-surfaces.html`.

## 1. Three stances, two decisions
- **private → unlisted is reach.** Copying the link makes it.
- **unlisted → public is listing.** "And put my plan where strangers browse" —
  a separate switch in the share dialog, below the reach line, taken back as
  easily as it's given.

They read identically to anyone holding the link and each earns its own yes.
**Nothing else in the product may set a tree public.** The listing switch must
also show its consequence — when it flips on the dialog says where the tree went
("Listed at windmill.works/gallery", with the link). Consent that can't be
inspected isn't consent.

## 2. Where it lives
| Surface | Home | Character |
|---|---|---|
| **The wall** | `/gallery`, marketing shell | server-rendered, anonymous, real anchors, carries "How a tree gets here" + the empty state |
| **In-product** | the `/browse` route, entered through a door | client-rendered, state-aware, fork on the card |

- **There is no "your gallery" page to sit at the end of — and one must not be
  built to host this.** `front-door.md` §2 rules the signed-in landing: *never an
  interstitial page*, *never a landing tree list or dashboard*, and `/trees` = the
  app on your newest tree with the **TreeSwitcher** unfolded (F1·F2). A library
  page stays **reserved** (X5 §8). An earlier draft of this section pinned the
  public row to "the end of your own gallery" as though that surface existed; it
  never did (build finding 1, 2026-07-25).
- **In-product the public surface is `/browse`, and it is never a nav item.** A
  permanent seat would invite reading other people's plans over writing yours —
  that rule is the whole point, and a door honours it more cheaply than a shelf.
- **The door is the last row of the TreeSwitcher**, behind a rule, labelled
  **"Planted in public →"**. One quiet row beneath your own trees, in the surface
  you summon to see them — exactly where the shelf wanted to be, in the form that
  surface supports: the switcher is 264px of rows, and *switching into* a
  stranger's tree is not what switching means. No count on it (X5 §8: no vanity
  numbers).
- **The second door is the listing confirmation** (§1) — "Listed at
  windmill.works/gallery", with the link. The highest-intent moment there is.
- **Never the first-run quest shelf** (`#/app/start`). That is the zero-trees
  surface: a first-run user needs a seed packet, not a stranger's plan.
- **Two URLs, one index, never two rankings.**

### Held — the shelf, if a library page ever ships
If the reserved library page (X5 §8) ships, the public row **must** take this form
and no other: one row pinned **at the end of your own trees**, behind a rule,
labelled "Planted in public" with a line saying why it's there, never above your
work, never a nav item; **zero trees → it yields to F5's starter quests**; on a
phone one horizontal snap row with the next card peeking (§8) — the only
horizontal scroll in the product, earned because it is a shelf and not a list.
Until that page exists the shelf is **not built** and the door above stands in for
it. Nobody invents a host.

## 3. In-product differences (and only these)
These are `/browse`'s differences from the wall.
- **Same card, exactly** — X2 #12 frame, kind rule, the tree's own OG portrait as
  the thumb, `n/m`, fork count. A tree looks the same everywhere. *Exactly* means
  the frame and its parts, **not an author byline**: §7 binds both surfaces, so the
  card carries the wall's meta line (progress + recency) and no name.
- **It knows you:** your listed trees wear *Listed by you*; anything you've forked
  wears *Forked* and can't be forked twice by accident. Your own card offers no
  fork and opens at `#/app/:id`; everyone else's opens at `/t/:id`.
- **Fork is on the card** (hover; a persistent button below 1024 where there is no
  hover) — one click and no auth door **for a signed-in reader**; signed out, X4's
  email-carried fork door finishes it, because nothing can own the copy yet.
  **Forking never navigates** — you stay on the wall, or *Forked* could never
  appear on the card you just forked. The wall's card only travels to `/t/:id`.
- **No essay** — the wall's "How a tree gets here" is a one-line link here.
- **Unlisted trees never appear, not even to their owner.** This is not a preview
  of the wall.
- Grid per X5: 1-col <744 · 2-up ≥744 · 3-up ≥1180 · cards ≥320px.

## 4. Loading (X3 grammar, this card's anatomy)
Only the client-rendered surface has one — that asymmetry is why it needed a
design.
```
0–400ms   nothing at all (a loader that flashes is worse than none)
400ms     skeleton at the card's EXACT height — thumb block, kind rule, title
          line, meta line, fork slot — so content lands with no shift
arrival   150ms cross-fade · no rise, no pop, no stagger
```
- **Neutrals only** (`neutral-100 ↔ 200`, 2s linear). Kind hues never shimmer — a
  coloured skeleton promises a tree that may not arrive.
- **Chrome is never skeletonised**: header, chips and buttons render instantly.
- **Portraits fill in place** — the thumb owns its box from the first frame.
- **No spinners, anywhere** (X3 §3).
- Reduced motion: static `neutral-100`, no sweep.

## 5. The sort control — earned, not invented
- **None below 24 listed trees.** Fork-ranked and silent, exactly as shipped. The
  number is the trigger so it isn't re-argued per release.
- **At 24+, the chips already in canon** (X5 §8): **Popular · New · Finished**.
  Not a dropdown — a dropdown of three options is a menu wrapped around a row of
  buttons.
- **Ranking:** Popular = forks desc → last-active → id · New = last-active desc ·
  Finished = complete trees, then forks. Ties always break the same way, so a
  reload never reshuffles. `last-active` is defined in §6 and is load-bearing here.
- **Search** stays a quiet icon (X5 §8) and does not appear before **100** listed
  trees.
- **Paging is a "Show more trees" button**, never infinite scroll — endless scroll
  is the body language of the recommendation feed §7 rules out.

## 6. Eligibility
- Public only · has a name · **≥3 steps**. A one-node stub can't buy its way on
  with forks.
- **No progress floor.** An unstarted plan is still a plan, and the wall's pitch
  is that people are planning in public. Abandonment **must** be handled by
  *ranking*, not by a gate — which makes `last-active` load-bearing, so it has to
  mean what the ranking needs it to mean:
  - **`last-active` = `max(last structural edit, last progress mark)`.** Ticking a
    step is activity. (It wasn't until 2026-07-25 — the column moved only on a
    structural edit, so a tree worked on this morning ranked with one nobody had
    opened in a year and the whole answer to abandonment was inert.)
  - **A visibility change must not touch it.** Listing is not activity: otherwise
    putting a long-dead tree on the wall freshens it, and unlisted→public becomes
    a free ranking bump.
- **No author name.** The wall exhibits the tree. One amendment: a fork keeps its
  lineage as **"A fork of *{tree}*"** — the tree, never the person, matching the
  unfurl's attribution.
- **The empty state says why it's bare** ("listing is a deliberate choice — yours
  could be the first"), never reads as an error, and keeps "How a tree gets here"
  beneath it.

## 7. Never
A spinner · a second ranking · an author name · a recommendation feed · surfacing
an unlisted tree · the public shelf above your own trees · a library page invented
to host it · a consent control that
can't be operated from the keyboard (see `components/forms/Switch.jsx` — it sits
on a real checkbox for exactly this reason).

## 8. Phone (X8 §10)

- **`/browse` keeps X5 §8's grid on a phone** (1-col <744, 2-up ≥744, cards
  ≥320px), as does the wall. The shelf's horizontal snap row and its 150px peek
  thumbs are **held with the shelf** (§2) — they need a host to sit at the end of.
- **Fork is a persistent button below 1024** — there is no hover to reveal it.
- Loading, sort chips and the empty state are unchanged — they are already
  thumb-sized.
