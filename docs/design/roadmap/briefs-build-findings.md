# Build-side findings from implementing the July canon · filed 2026-07-25

Four things surfaced while building `og-progress-card.md` and `gallery.md`. Two are yours to
rule on, one is a claim in canon that wasn't true in the code (now fixed), and one is a surface
canon depends on that **does not exist**. Filed as its own file rather than appended to
`briefs-share-loop.md` so nothing of yours gets clobbered.

---

## 1. BLOCKING — the in-product shelf has no host

`gallery.md` §2 pins the public row "at the end of **your own gallery**", and says "'Gallery'
already means *your* trees in-product (F1·F2)".

**There is no such page.** Bare `#/app` resolves against the union of your account's trees and
this device's local ones and then *navigates straight into the newest one* — or to the quest shelf
when there are none (`SkillTreeApp.jsx`). `TreeSwitcher` is a sheet you summon from the header
caret, not a destination. Nothing in the product renders your trees as a browsable gallery.

So §2's shelf, §8's horizontal snap row, and "zero trees → the shelf yields to F5's starter
quests" all describe an attachment point that was never built. We've built the other half —
**`/browse` is going in now**, fully to §3/§4/§5/§7/§8 — and left the shelf alone rather than
invent a host for it.

**Ruling wanted:** does the gallery page itself belong in this work (it reads like F1/F2 scope
that quietly never landed), or should the public shelf re-site — onto the quest shelf at
`#/app/start`, into the switcher sheet, or somewhere else? We'd rather not pick a home for it by
default.

---

## 2. `gallery.md` §6 asserted a rule the code didn't implement — fixed, but you should know

> "Abandoned trees are handled by *ranking* (last-active breaks every tie), not by a gate."

Written as though already true. It wasn't. The wall broke ties on `trees.updated_at`, a column
written only by a structural edit, a rename, or a **visibility change** — a progress mark never
touched it. A tree whose owner ticked a step this morning ranked identically to one nobody had
opened in a year, so §6's whole answer to abandonment was inert.

Worse in the specific: because *listing* a tree wrote that column, putting a long-dead tree on the
wall freshened it — and flipping unlisted→public repeatedly was a free ranking bump.

Both fixed. Last-active is now genuinely `max(last structural edit, last progress mark)`, and a
visibility change no longer touches the timestamp. §5's `Popular = forks desc → last-active → id`
is now literally what the code does. **Nothing for you to change.**

**The general ask:** where canon leans on an existing mechanism, phrasing it as "this *should* be
true" rather than "this *is* true" tells us it's load-bearing. Both defects here survived a
release because we read a description and didn't think to check it.

---

## 3. `og-progress-card.md` — the strip's bottom margin is tighter than #12's social crop

A `76·k` stamp centred in a `120·k` strip leaves content **22·k** from the card's bottom edge,
against the `48·k` #12 holds for the social crop. Built as written and it reads well at full size,
but the bottom row (`n/m`, the bar, the watermark) sits close enough that a platform crop could
bite it.

**Ruling wanted:** keep 22·k and accept the risk, or grow the strip back to a 48·k margin? We'd
rather not silently split the difference.

---

## 4. `og-progress-card.md` — `2.4·k` for the route edge is a card-pixel measure in a world-unit place

The ink table gives the edge-into-a-new-node stroke as `2.4·k`. Everything else in that table is a
ratio (`34%`, `50%`, `12%`), and portrait strokes are **world units** scaled by the meet-fit — so
`2.4·k` is the only card-pixel measure among them, and its rendered weight depends on how far the
fit has zoomed.

Implemented as a ratio chosen to land on `2.4·k` at the card's clamped fit, so it stays consistent
across trees of different sizes. Flagging in case you meant it literally — a small tree fits
larger, so a literal `2.4·k` would read *thinner* there, which seems opposite to the intent.

One related call we made without asking: in period ink the cross-branch 0.8 fade sits out, because
canon states the three edge tiers flat and the route needs to read unambiguously at thumbnail
size. Say the word if the fade should survive.

---

*Everything else in both docs mapped cleanly and is built or building. The progress card's
recap-tail offer, Week/Day segment and ledger toggle are in flight now that the backend carries a
tree's planting time.*
---

## 5. BLOCKING ON A PHONE — two-declines-retires can strand someone permanently

`og-progress-card.md` says the offer is "an accelerator, never the only door", and that two
declines in a row retire it "permanently, silently". Both are right on desktop, where the share
menu is the door back.

**On a phone there is no door.** `ControlBar` is desktop-only and `MobileChrome` carries no Share
control, so the offer toast is currently the *only* entrance to the share sheet. Combined with
retirement-by-silence — and a decline needs no button, since a faded toast counts — a phone owner
who lets two toasts pass **can never share their week again, on that tree, ever.** Retirement is
by design unannounced, so they will never learn why it stopped.

We have not built a phone Share door (out of the wave's scope, and it is a chrome decision).
**Ruling wanted:** where does Share live on a phone? Until it exists, either retirement should not
apply on a phone, or the phone needs the door before the offer ships armed.

---

## 6. `og-progress-card.md` §"On a phone" contradicts a shipped toast ruling

Canon puts the offer toast in the phone's **bottom** undo lane, "above the sheet/Fork lane, clear
of the home bar". The product moved every transient toast to the **top**, just under the title
plaque, precisely because the bottom lane sits on the verb rail under your thumbs.

We did not move it back — a canon line shouldn't silently revert a shipped interaction ruling. The
substance canon asks for holds either way: it is still one lane, still above the sheet/Fork
surfaces, still clear of the home bar, and it replaces rather than stacks, so "never stacks with a
milestone toast" is true. **Ruling wanted:** confirm the top lane, or tell us the bottom was
deliberate and we will move it.

---

## 7. Smaller things we decided so the build could finish

- **"Same card, exactly" vs §7's "no author name".** The shipped `GalleryCard` carries an author
  byline. We read §7 as binding for this surface and gave `/browse` the wall's meta line instead;
  the byline survives as an opt-in slot for the design showcase.
- **"One click, no auth door"** can't hold for a signed-out reader — nothing can own the copy — so
  the existing email-carried fork door finishes it there. A signed-in click never sees a door.
- **Forking does not navigate.** You stay on the wall; otherwise "can't be forked twice by
  accident" can never fire, since you would have left.
- **Your own listed tree opens at `#/app/:id`**, everyone else's at `/t/:id`, and your own cards
  carry no fork offer. Canon only says they wear "Listed by you".
- **Paging is a "Show more trees" button, not infinite scroll** — endless scroll is the body
  language of the recommendation feed §7 rules out.

---

# Rulings · filed 2026-07-25 by the design side

All seven answered. No rebuilds asked for; every call in §7 upheld. Two blockers get real
rulings, two canon claims were wrong and are fixed, one convention adopted.

## 1 · The shelf has no host — right, and canon had already forbidden the host it assumed

**The gallery page does not belong in this work, and must not be built to hold a shelf.**
`front-door.md` §2 ruled the signed-in landing before #18 existed: *never an interstitial page*,
*never a landing tree list or dashboard*, `/trees` = the app on your newest tree with the
TreeSwitcher unfolded. X5 §8 reserves a "your library" density view as future work. So §2 cited
F1·F2 as though it had shipped a gallery when what it shipped was a 264px switcher dropdown. My
error — and the same failure mode as finding 2: a doc describing a surface instead of requiring one.

**The shelf re-sites as a door.** In-product the public surface is **`/browse`**, entered from
**the last row of the TreeSwitcher, behind a rule: "Planted in public →"**. That keeps every rule
the shelf existed to keep — beneath your own trees, in the surface you summon to see them, never a
nav item — in the form today's surfaces support. A row and not cards, because the switcher is
264px of rows and *switching into* a stranger's tree is not what switching means. No count on it
(X5 §8, no vanity numbers). The **listing confirmation** (§1) is the second and highest-intent door.

**Not `#/app/start`** — that is the zero-trees surface the shelf was required to *yield* to;
strangers' plans there invert F5. **The shelf spec is held, not deleted:** §2 carries a *Held*
block (end of your own trees, behind a rule, yields to F5 at zero, phone snap row) that activates
if the library page ever ships. Until then nobody invents a host. §8, `responsive.md` §8 and
`mobile.md` §10 are marked to match; the specimen frame is badged **HELD — NO HOST**. Your
`/browse` build stands — §3/§4/§5/§7 were always its spec.

## 2 · The phrasing ask — adopted, and written down

The most useful thing in this file. `readme.md` gains the convention: **where canon leans on a
mechanism that already exists it says "this must be true," never "this is true"** — your case
cited, because a doc that asserts a behaviour is a doc nobody thinks to check. Finding 1 is the
same defect in spatial form, so the convention covers surfaces too.

`gallery.md` §6 now earns the phrasing: abandonment **must** be handled by ranking, and the thing
it leans on is defined in canon — `last-active = max(last structural edit, last progress mark)`,
and **a visibility change must not touch it**, with your listing-freshens-a-dead-tree case as the
stated reason. §5 points at the definition so the dependency is visible from both ends.

## 3 · The strip's bottom margin — keep it. The premise was wrong, not the card

Neither option: **keep `22·k`, and there is no risk to accept**, because `48·k` was never the
bottom margin of either card. Measured on the built specimens before ruling:

| | tightest type | watermark | stamp fill |
|---|---|---|---|
| #12 (strip `96·k`) | readout **`17·k`** | `32·k` | — |
| #20 (strip `120·k`) | watermark **`23·k`** · readout `30·k` | `23·k` | `21·k` |

The recurring card is **already the more generous of the two**: the extra `24·k` of strip buys the
type `13·k` more clearance than #12 has, and the only thing at `~21·k` is the stamp's *fill* — a
shape, tight on purpose because the delta leads. Growing the strip would make the recurring card
the conservative one and cost the portrait 16–26·k.

`4%` is the **panel's** inset. It can't be a bottom rule: the mat is sides + top by construction,
so the card's bottom edge *is* the strip. Both docs now say so, and the bottom gets a real number:

> **`FLOOR 16·k` — nothing in the strip closer to the card's bottom edge.** The tightest ratio any
> client crops a 1200×630 asset to is 2:1, which takes `15·k` off each long edge. `16·k` survives
> it; `21·k` survives it with room. Re-measure when a strip changes.

For the crop that does exist: the 1:1 Reddit thumb cuts the **sides** and keeps full height — it
already drops the stamp *and* the watermark. That's why canon scopes it to "root + most lit nodes."

## 4 · `2.4·k` — your ratio is right; canon was wrong to state a card measure

**Upheld as implemented.** Your reasoning is the ruling: a small tree fits larger, so a literal
`2.4·k` would hold still while every stroke around it grew — the route reading *thinner* exactly
where the tree is most legible. The ink table now states all three widths as ratios of the
renderer's lit-edge stroke `E`, in the world units the rest of the portrait uses:

```
into a new node   target kind, α1, 1.25·E     (≈ 2.4·k at the clamped fit — a reading, not the spec)
other lit         bark, α.34,   0.8·E
dormant           α.5,          0.65·E
```

Your built numbers (`2.4 / 1.9 / 1.2` against `E = 1.9`), with the relationship made explicit:
**the route is the heaviest stroke on the card at every fit.** How you derive `E` is yours.
**The cross-branch fade: upheld and now stated** — the three tiers are exhaustive, the in-app `0.8`
sits out, and it's written down so nobody re-derives it.

## 5 · The phone has no Share door — you're right, and this is mine to fix

**Share on a phone is a ≥44px button in the action lane's *right* slot** — the owner's twin of the
visitor's Fork pill. Reasoning, in canon's own terms: X8 §11 forbids *a verb above the fold*, so
it cannot go in the plaque or the sticky head; the lane's **centre** must stay Fork / the Tend bar
so nothing moves when tending lands; left is the view pill. Right is the only slot, and it is
thumb-reachable, which is the whole point of the lane. It opens the same sheet desktop opens
(Download / Copy → `navigator.share`, the Week/Day segment, the ledger toggle, "Share this week").

**And retirement is now conditional on that door.** Canon: a toast that fades unanswered **is** a
decline — that was intended — but **retirement may only arm where the standing verb exists.** No
door, no retirement. Do not ship the offer armed on a phone before the button; either order works,
but armed-without-a-door is the one combination canon forbids. "An accelerator, never the only
door" was a claim about a surface that didn't exist on that platform — finding 2's lesson again,
and thank you for catching that it strands people silently, which is the worst possible failure
for a rule whose whole design is to say nothing.

## 6 · The toast lane — the top lane is confirmed; the undo lane stays undo's

**Move nothing back.** The bottom placement was deliberate but it was reasoning about the *undo*
lane's contract (X8 §5/§8: transient, thumb-reachable, offset from the touch point, inert 250ms) —
and the offer toast doesn't need that contract. Three reasons the top lane is right for it:
your product-wide ruling should not be broken by one doc; the offer is an accelerator with a
standing door behind it (see 5), so a missed tap now costs nothing; and with Share landing in the
action lane, a bottom-lane offer toast would sit directly on the door it points at.

The dividing line is now canon (X8 §10), so it stops being re-litigated per surface: **a transient
you can lose — undo, 4s — sits in the thumb's lane; an invitation you can accept later sits in the
top lane, under the plaque, off the verb rail.** Undo snackbars, tending receipts and the
multi-select bar are unchanged.

## 7 · The five smaller calls — all upheld, all folded into canon

- **No author byline: upheld, and §3 was the ambiguity.** "Same card, exactly" now says *exactly*
  means the frame and its parts, **not** a byline — §7 binds both surfaces. Keeping it as an
  opt-in showcase slot is the right disposition.
- **Signed-out fork keeps the email-carried door: upheld.** §3 now scopes "one click, no auth
  door" to a signed-in reader, since nothing can own the copy before there's an account.
- **Forking does not navigate: upheld, and the reason is now in canon** — you have to stay for
  *Forked* to be able to appear on the card you just forked. Good catch.
- **Own card → `#/app/:id`, no fork offer on it: upheld**, written into the "It knows you" bullet.
- **"Show more trees", not infinite scroll: upheld** — you cited §7 correctly; endless scroll is
  the body language of the feed we refuse to be. Now a §5 bullet.

*Canon touched: `gallery.md` §2/§3/§5/§6/§7/§8 · `og-tree-cards.md` (layout block) ·
`og-progress-card.md` (ink table, strip, offer, phone) · `mobile.md` §10 + constants ·
`responsive.md` §1/§8 · `readme.md` (convention + index). Specimens re-labelled:
`gallery-surfaces.html` frame A, `og-progress-card.html` notes + constants.*

**Two things I owe you next, not in this pass:** the Share button's specimen on the phone canvas
(X8 §10 has the rule but no picture), and the TreeSwitcher's public row drawn in
`progress-and-tree-registry.html`. Say if either blocks you and it jumps the queue.
