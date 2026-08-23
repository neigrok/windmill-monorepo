# Brief 01 — roadmap replica: canonize the shipped landing as scaffold v2

The roadmap landing shipped at windmill.works/products/roadmap and it is the best page the
brand has — the product judged it "has all that a good landing needs". Canon has not caught
up: `templates/landing-roadmap` still follows the earlier, simpler scaffold. Your job in this
brief is replication, not invention — rebuild `templates/landing-roadmap` so the board matches
the shipped page exactly, and in doing so define **scaffold v2**, the skeleton
marketing/briefs-landings/02-journal-landing.md and marketing/briefs-landings/03-gym-landing.md
build on.

The family contract — the nine roles, the moat rule, fixed chrome, honesty rules — lives in
marketing/briefs-landings/00-README.md and is not restated here. This brief carries only what
is specific to the roadmap page: its exact copy, its exact mechanics, and the reconciliation
work. One thing to hold from the start: the shipped page predates the family contract, so in
two places (nav cross-nav, footer product cross-links) 00-README adds fixed chrome the shipped
page never had. Where that happens, 00-README wins over the replica — both places are called
out below, and both get ledgered.

You cannot see the shipped page's source. This brief is the copy spec — every string below is
carried verbatim from the live page.

## Section order and rhythm

The page order must be exactly:

Nav → Hero (+ hero band) → How it works (`#how`) → Paths (`#paths`) → Build with your AI
tools → Why Windmill → CTA band → Footer.

Each section must start at `padding-top: 96px` and use the shared header pattern: eyebrow
(small caps label) + sectionTitle (display font) + sectionSub (secondary text). A skip-link
"Skip to content" must lead the page. The template loads its kit per the kit rule fixed in
marketing/briefs-landings/00-README.md (`ds-base.js` → the trimmed marketing kit, never the
root bundle).

## Copy inventory — verbatim, do not rewrite

Every string in this section must appear on the board exactly as written. No paraphrase, no
title-casing, no punctuation "fixes". Em dashes, middle dots, and the arrow glyph are part of
the copy.

### Nav

- Wordmark "Windmill" — display font, 22px, links `#/`.
- Shipped links: How it works (`#how`) · Paths (`#paths`) · Connect (`#/connect`) · Changelog
  (`/changelog.html`).
- Family cross-nav: Roadmap · Journal · Gym · Pricing — fixed by 00-README role 1. The
  shipped page predates the contract and does not carry it; add it as a scaffold v2
  requirement layered on the verbatim copy above (00-README wins over the replica here), and
  ledger the shipped page's missing cross-nav in `consistency.md` (direction of fix: toward
  the family contract).
- Signed out cluster: ghost "Sign in" + primary "Start your tree".
- Account menu items: My trees / Settings / Sign out. Menu footer line: "Signing out keeps
  your trees on this device."
- Magic-link chip: "Link sent — check your email".

### Hero

| Element | Verbatim copy |
|---|---|
| Status badge (brand tone, with dot) | Now in public beta |
| H1 (clamp 36–60px) | Any goal, as a skill tree |
| Sub (max 620px) | Redecorating a room, learning to bake, training for a 10k, or planning a side project — Windmill turns any plan into a living tree. Finish one step and watch the next branch unlock. |
| Primary CTA, lg | Start your tree |
| Secondary CTA, lg | Try the live demo |
| Trust line (13.5px, tertiary) | No account needed — your first tree lives in your browser. |

The primary CTA must point at the quest shelf, never the bare app (which resumes). The
secondary must point at the read-only hosted demo tree. Neither href exists inside this
project — board both as named placeholder routes, `{quest-shelf}` and `{demo-tree}`, for
engineering to wire. Every later pointer in this brief to the quest shelf (the four Paths
cards, "Browse all nine starter quests →") or to the demo tree (the CTA-band ghost, the hero
band's Fork CTA) reuses the same placeholder.

### How it works

Eyebrow "How it works" · Title "Three beats, over and over" · Sub "That's the whole loop.
The tree keeps score, so you never wonder what's next." Each beat stage carries the title
tooltip "Click to replay".

| # | Beat title | Beat copy |
|---|---|---|
| 01 | Map your plan | Plant steps by hand — your plan arrives as a tree. Starter quests and paste-a-list are growing in. |
| 02 | Finish a step | Mark it done and the fruit ripens — progress you can see from across the room. |
| 03 | Watch it unlock | Light travels the branch. Whatever depended on that step wakes up, ready for you. |

### Paths

Eyebrow "For developers" · Title "Start from a real path" · Sub "Authored learning trees with
real prerequisite logic — ownership gates lifetimes, fundamentals gate frameworks. Pick one
and it's yours to grow."

| Quest card | Meta line |
|---|---|
| Frontend path | 24 steps · ~4-6 months |
| Rust from zero | 21 steps · ~3 months |
| ML foundations | 26 steps · ~6 months |
| Ship v1 | 14 steps · ~6 weeks |

Below the cards: link "Browse all nine starter quests →" and the attribution line "Dev paths
adapted from the roadmap.sh community maps (CC BY-SA)." The attribution must survive every
revision — it is an honesty rule, not decoration.

### Build with your AI tools

Eyebrow "Build with your AI tools" · Title "Your agent tends the tree with you" · Sub
"Claude, Cursor, or Codex can plant and tend your roadmaps. Pick your tool, paste one
snippet — your browser handles the rest."

Two-column calm panel, no WebGL. Left column:

- Label "Works with" + client chips: Claude Desktop · Claude Code · Cursor · Codex · any MCP
  client. Names as text — invented logos must never appear.
- Promise line: "First connect opens your browser to approve — no keys to paste."
- The can't-line: "It can't share roadmaps, delete them, or see your chats."
- CTA primary lg "Connect your tools" → `#/connect`.

Right column: label "Once connected it can" + five verb chips, each wearing a node hue:

| Verb chip | Hue |
|---|---|
| plant a roadmap | terracotta |
| add & connect steps | olive |
| paint with the legend | gold |
| mark progress | plum |
| read roadmaps | sky |

### Why Windmill

Eyebrow "Why Windmill" · Title "Made to share, and to sync". Two items, Lucide line icon +
title + copy:

- "Share a tree" (git-fork) — "Every tree is a page. Send the link — anyone can fork a copy
  and grow their own."
- "Everywhere you are" (monitor-smartphone) — "Sign in once and your trees follow — check a
  step off on your phone, tend the branches at your desk."

### CTA band

Title "Plant your first tree" — swapping to "Plant another tree" when the visitor already has
one. The swap rides the `hasTree` boolean prop (see Recognition states), not the auth-state
prop — a signed-out visitor with a browser-local tree has one too. Sub "It takes about a
minute, and the first branch unlocks tonight." Primary lg "Start your tree" + ghost lg "Try
the live demo" (→ `{demo-tree}`).

### Footer

Left: wordmark + "© 2026". Right links, in order (shipped): Feedback (opens the anonymous
feedback dialog — no account needed) · Pricing · Connect your AI tools · Privacy · Terms ·
Refunds · Changelog. To this, add the product cross-links (Roadmap · Journal · Gym → the
sibling landing templates) fixed by 00-README role 8 — the shipped footer predates the
contract and lacks them. Same resolution as the nav: 00-README wins, the cross-links are a
scaffold v2 requirement, and the shipped page's divergence gets its own `consistency.md`
entry alongside the nav one.

## The moat — hero band mechanics

The hero band is a full-bleed live self-playing tree scene beneath the hero copy: the "Learn
to sail" tree — the engine's built-in sail scene in `marketing/ui_kits/marketing/tree-scenes.js`,
17 named nodes, 6 kind hues, at its native world size (780×940). Reuse that engine and that
scene; do not redraw the tree by hand.

These mechanics must be true on the board and noted as requirements — they instantiate the
moat rule in marketing/briefs-landings/00-README.md, which is the single master for the
family's gating contract (briefs 02 and 03 cite 00, not this brief):

- Arrival cascade on load, then a calm self-playing unlock loop: finish → light travels the
  branch → the dependent node wakes.
- Motion cites `guidelines/motion-language.md`, never invents. Cite beats by name as well as
  number: the arrival cascade is the bloom beat (the shipped engine indexes it #14), the
  self-play unlock is the travel beat (indexed #4, verbatim), the reset is a plain 280ms
  dim — a settle, not a beat. The indices follow the engine's own numbering; if the doc in
  this project does not carry them, the named beat wins — ledger any numbering mismatch in
  `consistency.md`.
- Autoplay must be gated by an IntersectionObserver and `document.hidden` — off-viewport or
  hidden-tab, the scene rests.
- The scene must defer mount off the critical path (`requestIdleCallback`) so first input
  never competes with the renderer.
- Under `prefers-reduced-motion` the band must render the settled end-state — legible, no
  loop.
- The band must be the page's only infinite loop (the calm ceiling); every other scene on the
  page is finite or replay-on-click.
- The band carries a small Fork CTA pointing at the `{demo-tree}` placeholder route. Its
  verbatim label is the one string this inventory does not carry — board it as a marked
  placeholder ("verbatim from shipped page — product to supply"); do not invent the string.

## The other live scenes

The three how-it-works beats must each be a small live mini-scene stage — replayable on
click, tooltip "Click to replay" — built from the same engine's beat scenes, not static
frames. The four Paths cards must each carry a live canvas thumbnail of the actual quest
tree, with a coloured top rule and a kind-dot row, linking to `{quest-shelf}`. Both obey the
same viewport/tab gating and reduced-motion settling as the moat.

## Recognition states as template props

The shipped page never lies while auth resolves, and the template must encode that as props —
extend the existing `.dc.html` prop pattern (the `showStatus` / `showRibbon` booleans) with an
auth-state prop covering four variants, plus an explicit `hasTree` boolean alongside it:

| State | What must be true |
|---|---|
| signed out | Ghost "Sign in" + primary "Start your tree"; hero as specced above. |
| resolving | The Sign in slot keeps its exact box but stays invisible — no face flash, no layout jump. The nav must never claim zero trees before the registry answers. |
| link sent | The Sign in slot becomes a pill chip "Link sent — check your email" with a breathing gold ember dot (wm-ember). Clicking reopens the sign-in dialog on its wait panel; it never resends by itself; the chip expires with the link (15 min). |
| signed in | Nav primary becomes "My trees" (→ newest tree), or "Start your tree" if none; account seat avatar with the menu specced under Nav. |

Signed in with trees also swaps the hero: primary "Resume {tree name}" (18 code points max,
ellipsized) + ghost "My trees"; below, a fact line — kind-coloured dot in the tree's dominant
kind hue + "{name} · {done}/{total} done · last tended {ago}", count in mono. The fact line
is seeded from a per-email localStorage cache so the first frame paints right; the registry
corrects it. Board the signed-out and signed-in-resume hero variants both; the prop switches
them. The CTA-band title swap is driven by `hasTree` alone — it must be settable
independently of auth-state, because a signed-out visitor with a browser-local tree also sees
"Plant another tree".

## Why this page works — name these on the board

Scaffold v2 is these qualities, not just this markup. The board must carry them as an
annotated list so briefs 02 and 03 inherit them by name:

1. The product is the hero — the real renderer self-playing, not a screenshot.
2. Status honesty — the beta badge; a trust line stating the true cost of starting.
3. The loop taught in three animated beats, in the product's own vocabulary, replayable.
4. Proof with real numbers and honest attribution.
5. The agent section draws the trust boundary explicitly — the can't-line next to the cans.
6. One repeated CTA with a time-honest promise ("about a minute … tonight").
7. The page recognizes returning users — resume hero, fact line — without ever lying while
   data resolves.
8. The calm ceiling respected: the moat is where the motion budget is spent.

## Reconciliation

Two pieces of canon must be brought in line:

1. **`templates/landing-roadmap` — rebuild, not patch.** It currently follows the old
   scaffold: static SVG hero vignette, feature-card trios, text-only how-it-works, different
   copy throughout. That scaffold is superseded. Rebuild the instance to this spec on the
   shipped skeleton. Cross-links to `templates/landing-main`, to the journal and gym sibling
   templates, and to `../../marketing/ui_kits/marketing/*.html` must keep working after the
   rebuild.
2. **`marketing/ui_kits/marketing/roadmap.html` — diff and ledger.** It is the closest
   ancestor of the shipped page and stays the shippable page. Diff it section by section
   against this spec — copy strings, section order, moat gating, recognition states — and
   record every divergence as an entry in `consistency.md` (what diverged, exact values,
   direction of fix: toward this spec). Do not silently edit it into agreement; the ledger is
   the mechanism.

## Deliverables

- Rebuilt `templates/landing-roadmap` `.dc.html` board matching this spec, with 00-README's
  fixed chrome (nav cross-nav, footer product cross-links) layered on — this board is
  scaffold v2.
- The auth-state prop variants boarded (signed out · resolving · link sent · signed in with
  resume hero), plus the `hasTree` boolean.
- The why-this-page-works list annotated on the board.
- Entries in `consistency.md`: the drift from the roadmap.html diff; the shipped page's
  missing family cross-nav and footer product cross-links (direction of fix: toward
  00-README); and the family-wide Pro-vs-One naming drift as an Open entry per 00-README's
  honesty rules — this brief lands first, so it owns creating that entry; briefs 02 and 03
  append to it.

Order of work per marketing/briefs-landings/00-README.md: this brief lands first;
marketing/briefs-landings/02-journal-landing.md and marketing/briefs-landings/03-gym-landing.md
build on what you produce here. When the copy above and the board disagree, the copy above
wins — with one exception: the family-fixed chrome from 00-README (the nav cross-nav and the
footer product cross-links) is layered on top of the shipped copy and wins over the replica,
as specced above.
