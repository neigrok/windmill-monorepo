# Landing family — cover brief

This is the cover brief for the landing family. Read it once, keep it open; briefs
`marketing/briefs-landings/01-roadmap-replica.md`, `marketing/briefs-landings/02-journal-landing.md`,
and `marketing/briefs-landings/03-gym-landing.md` cite this file instead of restating it, and
spend their whole length on what is specific to their page.

## Why this brief set exists

We shipped a roadmap landing at windmill.works/products/roadmap and it is better than the
landing templates in this project. The earlier family — `templates/landing-main|roadmap|journal|gym/`,
one light scaffold with a static SVG hero and feature-card trios — predates the shipped page and
is superseded by it. This set rebuilds the three product instances on the shipped page's shape.

The bet: the shipped roadmap landing is not one good page, it is a family scaffold. It resolves
into nine roles that any Windmill product landing must fill. The family replicates the shape;
each product keeps its own soul — its claim, its voice, its moat, its register. Same skeleton,
three siblings.

## The nine roles

Every product landing must fill all nine. This table is the contract.

| # | Role | Fixed across the family | The product's own |
|---|------|------------------------|-------------------|
| 1 | Nav | wordmark → brand root; family cross-nav (Roadmap · Journal · Gym · Pricing); auth cluster contract (resolving slot keeps its box; link-sent chip; signed-in seat) | primary CTA verb ("Start your tree" / "Start writing" / "Start your log") |
| 2 | Hero | status badge (true state only) · H1 claim · one concrete-uses sub · primary + secondary CTA · trust line · the moat band beneath | the claim, the voice, the moat's content and skin |
| 3 | The loop | "three beats" pattern: 01/02/03, each a small live replayable scene + title + two lines | the product's actual core loop |
| 4 | Proof | one section of evidence with real numbers, honest attribution | quests / search specimen / the ladder |
| 5 | Trust boundary | a can + can't panel — the can't-line is mandatory | which boundary matters (agent · privacy · diff-gate) |
| 6 | Why Windmill | brand-level duo/trio: one account, everywhere; icon + title + copy pattern | swap any item that would be untrue (journal never claims share) |
| 7 | CTA band | repeat primary CTA + a time-honest line | the promise ("first branch unlocks tonight" equivalents) |
| 8 | Footer | legal shelf (Pricing · Privacy · Terms · Refunds · Changelog) + Feedback door + product cross-links + © | — |
| 9 | Recognition | signed-in visitors get their true state on the first frame; never claim zero while resolving | resume verb ("Resume {tree}" / "Open journal" / "Open your log") |

Two rulings on the table. Role 6's fixed part is the pattern — icon + title + copy, a
brand-level duo or trio. "One account, everywhere" is the default item, not a mandate: the
reference instance itself ships a swapped duo ("Share a tree" + "Everywhere you are", per
`marketing/briefs-landings/01-roadmap-replica.md`), and that swap is sanctioned. Swap any item
that would be untrue for the product; journal never claims share.

Pre-open carve-out. While a product's status badge is pre-open — gym's "In design" today — the
start-and-resume affordances lose their referent and may be dropped: role 1's primary CTA verb,
role 2's secondary CTA, role 9's resume verb. The product's brief says what stands in their
place. Every other role is still filled; pre-open is a state variant carried by the
`showStatus`/`showRibbon` prop pattern, not an exemption from the contract.

## The moat rule

Role 2's heart. Every landing's hero band must be a live, self-playing vignette built from the
product's real vocabulary — never a screenshot, never stock, never a static illustration.

Four things must be true of every moat: it autoplays only in-viewport and in a visible tab; it
defers off the critical path; it settles to a legible end-state under prefers-reduced-motion;
and it is the page's one infinite-motion budget (the calm ceiling of
`guidelines/motion-language.md`). Roadmap's moat is the sail tree via
`marketing/ui_kits/marketing/tree-scenes.js`; journal and gym author their own vignettes to the
same gating contract — specs live in their briefs.

## Fixed chrome, per-product register

Page chrome is light for all three — the static-marketing rule is light only. A product may
open a window of its own skin inside the moat (journal's night canvas is the canonical case),
but the page around that window must stay the family's warm cream. Type scale, 96px section
starts, the eyebrow/sectionTitle/sectionSub pattern, 744/1024 breakpoints, sentence case, no
emoji — all fixed.

On top of the house voice, each product owns a register:

- Roadmap: ceremony and unlocking — the game metaphor at full volume.
- Journal: quiet and warm — zero game metaphor (nothing unlocked, earned, or planted);
  `journal/journal.md` vocabulary is binding (page, the canvas, write, nudge, echo, talk,
  "Only you").
- Gym: matter-of-fact — a tool that respects that you're tired and holding a bar. No XP, no
  levels, no badges, no streaks, no "fitness", no "coach". One quiet line for a PR.

## Honesty rules

These must be true on every landing.

1. The status badge tells the truth: roadmap "Now in public beta" · journal's true current
   state · gym "In design" until it ships. The templates' `showStatus` prop pattern carries
   this.
2. Landings never show price numbers — that is pricing.html's job
   (`marketing/guidelines/pricing.md`: numbers are open until per-run cost is modelled; the
   page isn't publishable yet). A landing may name the paid layer honestly as new power, never
   a re-sold default: absent-not-locked, no blurred previews, no counters of what you're
   missing, no "upgrade to unlock".
3. Naming drift — do not resolve it, ledger it. Canon currently disagrees on the paid layer's
   name: `marketing/guidelines/pricing.md` says "Windmill Pro" (its $12 tendings figures live
   there); `journal/journal.md` §6 and the `gym/briefs` say "Windmill One". Brief 01 — the
   first to land — writes the Open entry in `consistency.md`: both sources, exact price and
   quota values transcribed directly from `marketing/guidelines/pricing.md` and the sibling
   docs, never from this brief's paraphrase; to be settled by pricing.md. Briefs 02 and 03
   check that the entry exists instead of duplicating it. Every landing says "the paid layer"
   generically until pricing.md settles the name.
4. Attribution stays wherever content is adapted — the roadmap.sh CC BY-SA line survives the
   rebuild.
5. Trust lines state true costs. "No account needed" is roadmap-true (the first tree lives in
   the browser). Journal and gym must state their own true line — copying roadmap's claim
   without verifying it for that product is a defect.
6. Brick never appears on these pages; gold is flourish, never a state.
7. Brand-scope copy counts only open rooms as fact. "One account" is present-tense true; a
   line that presents all three products as open — "one account, three rooms, one
   subscription" — is not, while gym is in design and not purchasable. This is the one family
   phrasing: any brand-level line that names gym carries its true state in the same breath
   ("…and gym, when it opens"). Briefs 02 and 03 use this form.

## Deliverables

| Deliverable | Notes |
|-------------|-------|
| `templates/landing-roadmap/` rebuilt | brief 01 — the replica that defines scaffold v2 |
| `templates/landing-journal/` rebuilt | brief 02 — on scaffold v2 |
| `templates/landing-gym/` rebuilt | brief 03 — on scaffold v2 |
| `consistency.md` entries | the Pro-vs-One Open entry (rule 3 above; written by brief 01) plus any drift you find while rebuilding |

All three are `.dc.html` boards. The template prop pattern (`showStatus` / `showRibbon`
booleans) must survive — briefs use it for state variants (signed-in hero, pre-open gym).

`templates/landing-main/` is out of scope for this set, but its cross-links to the three
product templates — and the templates' links back to it and to
`../../marketing/ui_kits/marketing/*.html` — must keep working after the rebuild.

## Order of work

Strictly 01 first. Brief 01 rebuilds `templates/landing-roadmap` from the shipped page's spec
and in doing so defines scaffold v2 — the concrete skeleton behind the nine roles. Brief 01
embeds that spec completely, so you never need to open windmill.works or the repo; the
in-project ancestor to consult for the shipped shape is
`marketing/ui_kits/marketing/roadmap.html`, the closest ancestor of the shipped landing. Where
the shipped page and this contract disagree, this contract wins: the shipped page has neither
the family cross-nav (role 1) nor the footer product cross-links (role 8) — scaffold v2 adds
both, and 01's replica includes them on top of the verbatim copy inventory. Briefs 02 and 03
build their instances on scaffold v2, not on the shipped roadmap page directly. Do not start
02 or 03 before 01's scaffold exists.

## The kit rule

Every rebuilt template must load `ds-base.js` and then the trimmed `marketing/_ds_kit.js` —
never the root `_ds_bundle.js`. This is consistency.md §2 and it is binding: loading the root
bundle once injected roughly 126 stray specimen sections into a marketing page. If a component
you need is missing from the trimmed kit, ledger the gap; do not reach for the bundle.
