# Windmill — design tasks (supplement) · the share loop · July 2026

Supplements `briefs.md` — three new tasks (18–20), the remaining pieces of the share loop
(the launch wedge, LAUNCH.md) that need your eye before they can be built well. Three OTHER
share-loop pieces shipped this week without needing design (the share-on-unlock prompt built
from the ceremony-moments canon; shared trees now showing the owner's progress to a visitor —
a bug where an anon saw an empty tree; and fork attribution in the unfurl, backend-only). The
three below are design-first. Fold into `briefs.md` whenever convenient.

---

## 18 · The public gallery — browse trees, sorted by forks — *new, medium* — **BUILT 2026-07-25 · open half DESIGNED, see addendum**

**Why:** the share loop needs a repeat-discovery surface. A stranger who arrives from one
shared tree should find the next one, and the beachhead needs a proof-of-life wall — "look
how many people are planning in public here." The building blocks all exist and shipped:
`og-tree-cards` (the portrait), live fork counts (`loadForkLineage`), and public/unlisted
visibility. What's missing is the page.

**Design:** a gallery of public trees — a grid of tree cards (the portrait + title + "n/m
done" + a fork count), a sort control (by forks, by recently active), the empty state, and
how a card invites the click-through to `/t/:id`. Public trees only (canRead-gated; a private
or unlisted tree is never listed). **Deliver:** the card, the grid, the sort control, the
empty/loading states — and a ruling on whether unlisted trees appear (probably not: unlisted
means "reachable by link," not "listed").

---

## 19 · The unlock-ceremony video — a shared tree that MOVES — *new, large / highest-leverage*

**Why:** the go-to-market panel named this the single highest-leverage build — an
auto-generated **~3-second looping video of the unlock ceremony attached to every shared
tree.** X, Reddit and Discord all autoplay video; a static OG card throws away the one
structural advantage Windmill has (the thing *moves*), and nobody in productivity tooling
ships this. The `og-tree-cards` pipeline is the template — the client renders the artifact
and uploads it, the backend stores and serves it, the share page points `og:video` (and keeps
`og:image` as the fallback for platforms that don't render video).

**The design is the storyboard.** What does the 3-second loop SHOW — a single node's unlock
bloom, the cascade rippling one branch, or the whole tree lighting root-to-frontier? It must
reuse the shipped ceremony motion (bloom → travel → wake → crown-pulse) and the OG card's own
portrait so the still frame and the video agree. **Deliver:** the ~3s beat storyboard, the
frame recipe (portrait + motion, light-only, the loop seam so it repeats cleanly), the aspect
+ safe-frame for social autoplay, and the ruling on scope (per-unlock moment vs whole-tree
grow). Note the technical reality for the build that follows: browser canvas capture
(MediaRecorder / a GIF encoder) is the likely path, so the motion has to survive a short,
low-frame-rate loop — design for that, not a 60fps hero reel.

---

## 20 · The repeat-share surface — the week-N progress image — *new, medium* — **DELIVERED 2026-07-25**

**Why:** the `#100DaysOfCode` / learn-in-public beachhead lives under a *standing content
obligation* — their weekly habit IS posting a progress update, and they are chronically short
of something worth showing. `milestone-share-beat` (shipped) fires the ONE-TIME pride moment
when a branch or the tree completes; this is the RECURRING one — a "week 3" / "day 47"
progress image a user posts on a cadence, so a retained user keeps manufacturing shareable
artifacts long after the first milestone. It extends `og-tree-cards` into a *diff* poster:
what lit SINCE the last share (the welcome-back recap already tracks a per-device baseline of
seen completions — the same signal feeds this).

**Design:** the recurring progress card — how it renders "3 new this week" (the newly-lit
nodes highlighted against the settled tree? a subtle before/after? a streak/period line?),
the offer moment (when and how the cadence prompt appears — never nagging, always skippable,
in the milestone toast's grammar), and — critically — how it reads DIFFERENTLY from the
milestone card so a feed of someone's weekly posts doesn't look like the same image twice.
**Deliver:** the card recipe + the offer moment. Light-only, OG-sized, off the shared
`TreePortrait` recipe.

**Status — delivered.** Canon: `guidelines/og-progress-card.md` · specimens:
`explorations/og-progress-card.html`. The ruling on the three options you listed: **the
highlight, not a before/after, and the period line as a small ledger rather than the idea
itself.** The card is a **diff poster** — one tree, **two ink levels**: everything done before
the period drops its halo to 34% of its kind, this period's completions keep the *ordinary*
full-light done treatment, and the edges arriving at them light in their kind, so the week's
route reads as a bright path through a dim tree. No new node chrome; the picture is the
sentence. A before/after split was skipped (two half-size trees read as neither).

**How it avoids looking like the same image twice** (the brief's hard requirement, shown
side-by-side against #12 and as four consecutive weeks): the lit constellation is driven by
*where you worked* and the rule hue by the dominant kind of the **new** nodes — not all done —
so consecutive weeks come out different colours with nothing decorative added. The strip is
delta-led (a `+3` stamp where the milestone card puts its title), the readout is demoted to a
second line, and a ≤6-tick **ledger** — the only element the milestone card doesn't have —
says there'll be another one next week. Mat, rule, panel, fit and watermark are untouched: it
must stay unmistakably the same postcard.

**The offer** is one toast in the milestone toast's grammar, on the tail of the welcome-back
recap: *"Week 3 · 3 steps lit"* + [Share the week], first open after a period closes, +120ms
after the last recap beat, hold 6000. **A quiet period offers nothing** (no card, no toast, no
"0 new this week"), a milestone in the same window wins outright, and **two declines in a row
retire the offer** for that tree — silently, forever; the share menu keeps the verb. Baseline =
since your last posted card; label = **Week N** default, **Day N** opt-in in the sheet (the
`#100DaysOfCode` hashtag needs the day number), counted from planting. Still, not video —
a weekly render bill is worse than the one #19 already declined. Open: the 7-day period and
the 6-tick ledger window are assumptions about the beachhead, and the ledger publishes quiet
weeks too (default on, one toggle off).

---

## Addendum · #18 shipped ahead of the design — what we ruled, and what's still yours

*Filed 2026-07-25 by the build side. The gallery went out because the launch is gated on the
share loop and #18's card was already canon (X2 #12). We built the half we could build without
guessing at your work and left the half that is genuinely a design question. Nothing here is
precious — overrule any of it.*

**Your open ruling, answered — and it turned out to be the whole feature.** You asked whether
unlisted trees appear, and guessed not. Correct, and it went deeper than a filter: **nothing in
the product ever set a tree public.** Copying a link flipped private → *unlisted* and stopped
there, so the gallery would have been a permanently empty room. So the three stances are now
**two decisions**: private → unlisted is **reach** (copying the link makes it), unlisted →
public is **listing** ("and list me"). They read identically to anyone holding the link and are
chosen separately — a switch in the share dialog, below the reach line, that takes itself back
just as easily. "Anyone with this link can view" and "put my plan where strangers browse" each
earn their own yes.

**What we built to canon:** the card is X2 #12 rendered as plain HTML (same frame, kind rule,
progress readout, the tree's own OG portrait as the thumb, its dominant hue as a bar). The page
chrome follows the `connect.html` / `pricing.html` house style. The wall lives at `/gallery`,
server-rendered so the cards are real anchors — which is the point, since a public tree's share
page has always said `index, follow` and nothing ever linked to one.

**What we decided without you, and would like overruled if you disagree:**
- **No sort control.** Fork-ranked only (then freshness, then id). A sort control on a wall of
  four trees is furniture; it earns its place at a scale we don't have. Your call when we do.
- **No author on the card.** The wall exhibits the tree, not the person. Showing a display name
  publicly is a separate privacy decision we didn't want to make by default.
- **A floor on what's exhibited:** a tree needs a name and ≥3 steps. A one-node stub can't buy
  its way onto the wall with forks. The number is a guess — yours if you want it.
- **The empty state says why it's bare** ("listing is a deliberate choice — yours could be the
  first") rather than reading as an error, and the page carries a short "How a tree gets here"
  that spells out all three stances. A gallery that quietly lists people isn't one to run.

**One thing we changed in your components, and you should probably fold in.** `Switch` was a
`<span>` with an `onClick` — pixel-identical to a switch and **unreachable by a keyboard**. The
listing consent is its first use outside the Showcase, and a consent control you can only
operate with a mouse isn't shippable, so it now sits on a real checkbox: focus, the space key,
an announced on/off state, and a focus ring only for keyboard focus. Pixels unchanged.

**Still genuinely yours:** the sort control when scale earns it; whether an *in-product* gallery
(inside app chrome, for a signed-in browser) should exist alongside the marketing wall, and how
it should differ; and the loading state — the server-rendered page has none by construction,
but an in-product view would.

**Status — the open half is delivered (2026-07-25).** Canon: `guidelines/gallery.md` · specimens:
`explorations/gallery-surfaces.html`.

- **An in-product gallery: yes, as a shelf, not a destination.** "Gallery" already means *your*
  trees in-product (F1·F2), so the public wall enters the app the way starter quests do (F5 §1):
  **one row pinned at the end of your own gallery** — "Planted in public" — behind a rule, never
  above your work and **never a nav item** (a permanent seat invites reading other people's plans
  over writing your own). "Browse all" opens the full `/browse` route. At zero trees the shelf
  yields to F5. It differs from the wall in exactly four ways: app chrome instead of the essay,
  it knows your state (*Listed by you* / *Forked*), **fork is on the card** in one click, and
  being client-rendered it has a loading state. Same card, same index, never a second ranking —
  and unlisted trees never appear, not even to their owner.
- **The loading state** is X3's grammar against this card's anatomy: nothing at all for 400ms,
  then a skeleton at the card's exact height (thumb block, kind rule, title line, meta line, fork
  slot), then a 150ms cross-fade. Neutrals only — kind hues never shimmer; chrome is never
  skeletonised; portraits fill in place. No spinners.
- **The sort control: you were right, with a trigger.** Furniture at four trees; it stops being
  furniture at **24 listed**, and when it arrives it's the chip row already in canon (X5 §8):
  *Popular · New · Finished*, ranked forks → last-active → id so a reload never reshuffles.
  Search stays a quiet icon and waits for 100.

**Your five calls:** no sort control — **upheld** (with the 24 trigger). No author — **upheld**,
amended once: a fork keeps its lineage as "A fork of *{tree}*", the tree, never the person. The
≥3-step floor — **upheld**, and **no progress floor** on top of it (an unstarted plan is still a
plan; dead stubs sink by ranking, not by a gate). The empty state — **upheld verbatim**, it's
exactly X3's grammar. The `Switch` fix — **folded in**, thank you: `components/forms/Switch.jsx`
now sits on a real checkbox (tab + space, announced state, keyboard-only focus ring, pixels
unchanged). One thing back to you: the listing switch should state its consequence when it flips
on ("Listed at windmill.works/gallery", with the link) — consent that can't be inspected isn't
consent.

---

*Filed 2026-07-20 by the build side. Context: the share loop is the launch wedge (LAUNCH.md).
Three of its pieces shipped this week without needing your eye — the share-on-unlock prompt
(`milestone-share-beat`, built from the ceremony-moments canon), shared trees now showing the
owner's progress to visitors (a bug — an anon visitor saw an empty tree), and fork attribution
in the unfurl ("A fork of X · N forks", backend-only). The three above are the pieces that DO
need design before they can be built well — 18 and 20 are new share artifacts, 19 is the big
one the whole launch would most benefit from. No rush implied; filing so the canon leads the
build, not the other way around.*
