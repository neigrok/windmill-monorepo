# The public gallery

The share loop's repeat-discovery surface: a wall of **public** trees a stranger can browse
after arriving from one shared link.

## 1. Three stances, two decisions

- **private → unlisted is reach.** Copying the link makes it.
- **unlisted → public is listing.** "And put my plan where strangers browse" — a separate
  switch in the share dialog, below the reach line, taken back as easily as it's given.

They read identically to anyone holding the link and each earns its own yes. **Nothing else
in the product may set a tree public.** When the listing switch flips on, the dialog says
where the tree went ("Listed at windmill.works/gallery", with the link).

## 2. Where it lives

| Surface | Home | Character |
|---|---|---|
| **The wall** | `/gallery`, marketing shell | server-rendered, anonymous, real anchors, carries "How a tree gets here" + the empty state |
| **In-product** | the `/browse` route, entered through a door | client-rendered, state-aware, fork on the card |

- **There is no "your gallery" page, and one must not be built to host this**
  (`front-door.md` §2: never an interstitial page, never a landing tree list).
- **`/browse` is never a nav item.** A permanent seat would invite reading other people's
  plans over writing yours.
- **The door is the last row of the TreeSwitcher**, behind a rule, labelled **"Planted in
  public →"**. No count on it.
- **The second door is the listing confirmation** (§1) — the highest-intent moment there
  is.
- **Never the first-run quest shelf** (`#/app/start`). A first-run user needs a seed
  packet, not a stranger's plan.
- **Two URLs, one index, never two rankings.**
- The horizontal public shelf is **not built**; it needs a host page that does not exist.

## 3. `/browse`'s differences from the wall — and only these

- **Same card, exactly** — the frame, kind rule, the tree's own OG portrait as the thumb,
  `n/m`, fork count. *Exactly* means the frame and its parts, **not an author byline**: the
  card carries the wall's meta line (progress + recency) and no name (§6).
- **It knows you:** your listed trees wear *Listed by you*; anything you've forked wears
  *Forked* and can't be forked twice by accident. Your own card offers no fork and opens at
  `#/app/:id`; everyone else's opens at `/t/:id`.
- **Fork is on the card** (hover; a persistent button below 1024) — one click and no auth
  door for a signed-in reader; signed out, the email-carried fork door finishes it.
  **Forking never navigates**, or *Forked* could never appear on the card you just forked.
  The wall's card only travels to `/t/:id`.
- **No essay** — the wall's "How a tree gets here" is a one-line link here.
- **Unlisted trees never appear, not even to their owner.**
- Grid: 1-col <744 · 2-up ≥744 · 3-up ≥1180 · cards ≥320px.

## 4. Loading

Only the client-rendered surface has one.

```
0–400ms   nothing at all
400ms     skeleton at the card's EXACT height — thumb block, kind rule, title
          line, meta line, fork slot — so content lands with no shift
arrival   150ms cross-fade · no rise, no pop, no stagger
```

- **Neutrals only** (`neutral-100 ↔ 200`, 2s linear). Kind hues never shimmer — a coloured
  skeleton promises a tree that may not arrive.
- **Chrome is never skeletonised**: header, chips and buttons render instantly.
- **Portraits fill in place** — the thumb owns its box from the first frame.
- **No spinners, anywhere.**
- Reduced motion: static `neutral-100`, no sweep.

## 5. The sort control

- **None below 24 listed trees** (`CHIPS_AT` in `products/roadmap/browse/galleryIndex.js`).
  Fork-ranked and silent below that.
- **At 24+, three chips: Popular · New · Finished.** Not a dropdown.
- **Ranking:** Popular = forks desc → last-active → id · New = last-active desc · Finished
  = complete trees, then forks. Ties always break the same way, so a reload never
  reshuffles.
- **Search** stays a quiet icon and does not appear before **100** listed trees
  (`SEARCH_AT`).
- **Paging is a "Show more trees" button**, never infinite scroll.

## 6. Eligibility

- Public only · has a name · **≥3 steps**.
- **No progress floor.** Abandonment is handled by ranking, not by a gate, which makes
  `last-active` load-bearing:
  - **`last-active` = `max(last structural edit, last progress mark)`.** Ticking a step is
    activity.
  - **A visibility change must not touch it.** Listing is not activity, or unlisted→public
    becomes a free ranking bump.
- **No author name.** The wall exhibits the tree. A fork keeps its lineage as **"A fork of
  *{tree}*"** — the tree, never the person, matching the unfurl's attribution.
- **The empty state says why it's bare** ("listing is a deliberate choice — yours could be
  the first"), never reads as an error, and keeps "How a tree gets here" beneath it.

## 7. Never

A spinner · a second ranking · an author name · a recommendation feed · surfacing an
unlisted tree · a library page invented to host the shelf · a consent control that can't be
operated from the keyboard (`design-system/forms/Switch.jsx` sits on a real checkbox for this
reason).

## 8. Phone

- **`/browse` keeps the §3 grid on a phone** (1-col <744, 2-up ≥744, cards ≥320px), as does
  the wall.
- **Fork is a persistent button below 1024** — there is no hover to reveal it.
- Loading, sort chips and the empty state are unchanged.
