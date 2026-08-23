# Windmill — design tasks · July 2026

The July 16 batch of seven (social assets/legal pages, signed-in front door, what's-next
panel, honesty moments, rename, email family, ceremony moments) is **delivered and
shipped** — thank you. Tasks **8 and 9 are resolved** (8 shipped as the AI-shaping paste
moment; 9's two rulings made — see the notes on each). A **new batch (10–17)** follows:
the functional-but-undesigned surfaces the recent editor + growth work created. They all
work today with placeholder styling built from the existing system — they want your eye,
not a rescue.

---

## 8 · Paste a plan: the AI-shaping moment — *DELIVERED / shipped*

**Status:** designed and shipped. The composer turns pasted text into a planted tree via
the deterministic line grammar, with an optional AI-shape escalation whose output *streams*
into the well (gutter lighting line by line, ghost skeleton growing), a reveal-with-undo if
the stream fails midway, the three quiet refusal faces (unconfigured → the handle never
appears; rate limit; call-failed with the text untouched), and the one-tap honesty
disclosure. Kept below for reference.

**Why:** the paste-to-tree composer parses outlines/checklists/markdown beautifully live,
but the most common paste is prose, which parses into one root and a pile of notes. So the
composer grows an optional escalation: one tap sends the text to a model that rewrites it
INTO the plan format, which re-parses through the same live preview. The model shapes; the
preview stays the confirmation; the original text is never lost.

---

## 9 · Two rulings the quest shelf needs — *RULED (yours to overturn)*

**(a) Does the crown breathe on the shelf?** → **YES.** The halo is the sanctioned
resting-motion exception: it breathes under the resting value and freezes exactly at α .28
under reduced motion. Nine cards, nine slow halos.

**(b) "Run a 10k" — ~12 weeks or back to 8?** → **KEEP ~12.** Honesty about the
too-much-too-soon knee pattern (one easy mile → 9 km by week six) beats the pinned "8
weeks"; the first step now states the ~3 km assumption and the roster reflects ~12 weeks.

Overturn either if you disagree — both are two-line changes.

---

## 10 · The multi-select power surface — *new, medium*

**Why:** the editor grew real multi-selection for desktop/laptop, and it works — but every
pixel of it is placeholder built from existing tokens, and multi-selection deserves its own
visual language. What's live now (design it properly):
- **Select many.** ⌘/Ctrl+A selects all steps; Shift+click toggles a step or a link into the
  selection; Shift+drag draws a marquee (a plain translucent brand-tinted rectangle today).
- **The highlight.** A selected node reuses the single-select look (size + glow); a selected
  *link* brightens toward white. A set of five selected nodes currently looks like five
  single-selections — is that right, or does a multi-selection want a quieter, unified
  "grouped" treatment so one selected step still reads as special?
- **The action bar.** When more than one is selected, a floating "N selected" bar replaces
  the single-step panel: it carries **Delete** and a row of legend **kind swatches** (bulk
  recolor). It's a plain bar in the toast lane. Design its home, weight, and how it grows
  (set-status, group, and future actions).

**Design:** the marquee, the multi-selection highlight (node + link), and the action bar —
desktop only (the phone keeps single-tap). **Deliver:** the three states + the bar's
resting/hover/act moments.

---

## 11 · Angular reorder (§07): the ruling + the interaction — *new, blocks a build*

**Why:** the free-pixel node-move gesture was removed (it had no effect after reload), so
the editing model is now **selection + structural actions**. §07's angular sibling reorder
— drag a node tangentially around the radial ring to reslot it among its siblings under the
same parent — is the intended successor and is **unbuilt**, because four questions need your
ruling before it can touch the CRDT:
1. Does angular reorder **replace** any remaining move, or stand alone as the only "arrange"
   gesture? (There is no free-pixel move anymore; reparenting is a separate reconnect gesture.)
2. Is the unit a **single node** reslotting among siblings, or a **whole branch**?
3. Are **roots** reorderable around the root ring too, or only non-root siblings?
4. The **affordance** — a tangential drag of the node itself, a dedicated handle, or a
   drag-into-the-gap insertion?

**Deliver:** the interaction spec + the four rulings. It adds an order register to the sync
lattice + the wire, so we want canon pinned before building.

---

## 12 · Per-tree share unfurl card (og-tree-cards) — *new, medium*

**Why:** shared trees are moving to real paths (`windmill.works/t/<id>`) so a pasted link
can unfurl as **itself** — this is the sharing/k-factor lever. The v1 unfurl uses the tree's
own title + a step-count line with the generic `og-image.png`. To finish it, each shared
tree wants its **own** 1200×630 unfurl card: this tree's portrait (crowned root, kind hues,
done/available/locked looks — the TreePortrait recipe) + its title + a "n/m done" readout,
in the share identity, sized and safe-framed for social crops.

**Design:** the 1200×630 per-tree card (extends `explorations/share-identity` /
`TreePortrait` to the OG size + a text-safe area; **light only** — scrapers don't render dark).
**Deliver:** the recipe (layout, portrait crop, type sizes off `k = w/1200`, safe inset).

---

## 13 · Mobile editing — the touch grammar for the editor — *new, large / foundational*

**Why:** editing is **desktop-only** today. A phone user can pan/zoom, mark a step done, and
fork — but cannot build or edit (create, connect, delete, select, multi-select, recolor are
all gated to desktop). That's a real ceiling on "plant your first tree from anywhere." This
is the biggest open design surface: the **touch grammar for the editor** — how you add a
step, draw a link between two steps, delete, select (single, and whether multi at all),
recolor, and rename on a phone, without the rim-ports / marquee / right-click affordances the
desktop leans on. It should degrade gracefully from the desktop model, not fight it.

**Design:** the phone-sheet editing model end to end. **Deliver:** the core gestures + the
add/connect/delete/rename moments, phone + tablet.

---

## 14 · Keyboard-shortcuts overlay — a design pass — *new, small*

**Why:** the editor accumulated real power (multi-select, marquee, paste-to-append, undo)
that was undiscoverable, so we shipped a shortcuts reference — the `?` key or a keyboard
button in the control bar opens a modal listing the real shortcuts, grouped (Navigate /
Select / Edit / History / View) as `<kbd>` chips over the shared dialog. It's honest and
accurate but plainly styled. **Design:** the kbd chip, the grouped layout, and the modal's
feel, so it reads as considered rather than a spec dump. **Deliver:** the chip + the panel.

---

## 15 · The price page — *WITHDRAWN, don't start*

**Status:** withdrawn the day it was filed. It asked you to design a pricing page around
"Pro buys one thing: private trees" — and that paid line has been removed entirely.

**What happened,** because it's worth knowing before the replacement lands: trees used to be
**private by default**. To have something to sell, the default was quietly changed to
*unlisted* (readable by anyone holding the link) so that setting a tree private could be
charged for. That is taking a default away in order to sell it back, and it took one question
from Sam — "aren't all trees private by default?" — to see it. Privacy is free again, it's the
default again, and there is now nothing to buy: the upgrade button is closed and the pricing
page says all of it is free.

A pricing page will be wanted again when the new paid line exists (see 16). It isn't worth
designing until the limits are decided, so this stays parked rather than reshaped. The
placeholder at [windmill.works/pricing.html](https://windmill.works/pricing.html) is honest
in the meantime.

---

## 16 · Tending — the AI that lives in the tree — *new, large / the next real feature*

**Why:** Windmill's sharpest capability is an agent that builds and tends your tree, and it's
reachable only by people who already run Claude Desktop or Cursor and will edit a JSON config.
That excludes phones completely — which is backwards, because writing a plan down is something
people mostly want to do *away* from a desk. The moment of intent is mobile; the tool for it
is desktop-only.

We already built the agent's hands: 27 MCP tools that create, connect, reorder, recolor,
annotate, set progress, import, find, prune and tidy, all behind the same auth as everything
else. What's missing is the head and the mouth. So this is less "add an AI feature" than
**host the agent we already serve** — which makes it mostly a design problem, and yours.

**The thing to hold on to:** it is *not* paste-shape. That's a transform — text in, text out,
planted, one shot, blind to the tree that already exists, and it should stay exactly that.
This is incremental and tree-aware, and the sentences it makes possible are ones no paste can
express:

- "add a testing branch under the backend node"
- "this is too granular — merge the first three steps"
- "mark everything in phase one done"
- "I only have two evenings a week. Is this realistic?"

**The surface is the whole design question, and the obvious answer is probably wrong.** A chat
panel down one side turns Windmill into a wrapper around a chatbot — generic, and at odds with
the one thing that makes it feel like itself. The alternative worth exploring first:

> **you say what you want, and you watch the tree do it** — nodes arriving, edges drawing, the
> settle glide running, the conversation staying thin while the canvas is the response.

Precedent exists and shipped: shape-on-paste streams into the well line by line while the
ghost skeleton grows. Same instinct, pointed at a live tree. It also disposes of the latency
problem instead of fighting it — an agent loop takes tens of seconds, which is dreadful as a
spinner and rather good as theatre, and this app already animates arrival and unlock.

**Design it on the phone first and adapt upward** — the opposite of how the editor went. The
phone is the reason this exists.

**Which raises whether you speak to it.** Planning is unusually talkative — *"learn to sail,
start with knots and safety, then handle a dinghy on my own, then navigation, maybe an
overnight passage by autumn"* is a natural sentence to say and a miserable one to thumb-type
on a train. It would also make the demo: the launch is waiting on a fifteen-second video, and
*talk at your phone, watch a tree grow* beats *paste a document, watch a tree grow* by a
distance.

Two things to know before you design around it. **Voice may already be free** — every iOS and
Android keyboard has a dictation mic, so if the input is an ordinary text field a phone user
can talk into it today, with no transcription bill and no browser-support problem. Custom
capture (hold-to-talk, a waveform, server-side transcription) is a separate and much larger
decision. And **the counterweight**: the moments this feature is for — a train, an open
office, a room with someone asleep in it — are often exactly where nobody will speak aloud.
So voice can be an accelerator on top of typing, never the only door.

**What it must keep:** every AI edit is an *ordinary gesture* through the same command path a
human's takes, so one undo reverses it — the safety net has to be visible, not merely present.
And destructive actions are a different category from additive ones: twelve new nodes are
cheap to undo, an hour-old branch is not.

**The second use, which may be the bigger one.** Building is obvious; **reviewing** might be
where the value is. Our own nine quests went through a curriculum review that caught a sailing
quest with a capsize drill and no buoyancy aid, and a 10k plan ramping one easy mile to nine
kilometres in six weeks. Those are *plan* failures, invisible to any code review — and every
user writing an ambitious plan makes the same class of mistake. The tree holds the data to
answer it: steps, dependencies, estimates, what's done. A chatbot on a notes app can't do
that. It needs the graph.

**Design:** the invocation, the working state, the finished state, and the refusals — phone
first, then desktop. **Deliver:** the surface and its moments, plus rulings on the open
questions below.

**Open questions, yours to rule:**
1. Canvas-first with a thin input, or a real conversation with scrollback? Does the agent's
   reasoning show at all, or only its effects?
2. **Voice-first, voice-optional, or text-only?** If the answer is anything but text-only,
   does the design lean on the system keyboard's own dictation (free, invisible, no new
   surface) or earn a dedicated hold-to-talk affordance of its own?
3. Does the camera follow it while it builds? Does the tree reflow continuously or settle once?
4. Confirmation before destructive edits — always, never, or past a threshold?
5. **Does it have a name or a character, or is it invisible machinery?** The product's
   vocabulary is planting, tending, growing, quests — "assistant" would be the single generic
   word in an otherwise specific world.
6. Running out of allowance is a new refusal face, alongside the shape door's existing three
   (unconfigured / rate-limited / failed). It should read without shame.

Fuller reasoning — including why this changes the go-to-market wedge, and the prompt-injection
risk that comes with forkable public trees whose node labels the agent reads as context — is
in `EXPLORATION-in-site-ai.md` in the repo root.

---

## 17 · The tending pricing page — the model, before the next visual pass — *new, ties to 16*

**Status:** you designed a pricing page for the tending model (`ui_kits/marketing/pricing.html`)
and the design is a keeper — it solves the thing #15 couldn't. It stops selling *access* and
sells *tending*, and it makes the receipt ledger the hero, which teaches "what is a tending"
by showing concrete receipts instead of defining it. Adopt that structure. This note is the
business constraint the next pass has to design around, not a redo.

**The one hard problem: "unlimited tending for $12" inverts the unit economics.** Every tending
is a server-side agent loop that bills *us* tokens per run — a multi-tool-call model loop, not
a free action. "Unlimited" on a per-use-cost feature means the heaviest users, the ones who
pay, are the ones we lose money on. This is the private-tree-paywall mistake turned inside out:
that one charged for something free; this gives away something costly. The no-tiers instinct is
right for a $0-marginal product and wrong here.

The fix keeps the whole design — it only changes one word and one number:
- **Pro is a large allowance, or "unlimited within fair use," not literal unlimited** — unless
  the per-run token cost has been modelled and genuinely supports flat-rate. "300 tendings a
  month" reads nearly as clean as "unlimited" and doesn't bleed on power users.
- **The numbers are all still open.** `30 free/month`, `$12`, the `18/30` meter state — these
  were placeholders to design against (correct), but none are decided. The free allowance number
  *is* the model's economics; $12 was the old private-trees price and may be the wrong number for
  a more valuable thing.

**Two smaller notes:**
- The meter shows a live state (`18/30`) on a logged-out page — it reads faintly like the
  viewer's own account. Worth a "for example" cue, or a neutral full-meter.
- **It can't go live until tending ships.** The feature is being built now, dark, behind a flag,
  with no user able to reach it. The page sells something that doesn't exist yet — fine as the
  plan, not publishable as a live price. The current all-free placeholder stays up meanwhile,
  and it has the virtue of being true.

**Status — delivered.** The tending page now carries the **allowance** model in place of
"unlimited": **Windmill Pro is $12/month for 300 tendings a month** (Free stays at 30), because
every tending is a server-side agent loop that costs real tokens — flat "unlimited" would invert
the unit economics and bleed on the heaviest (paying) users. The meter specimen now reads as an
**example** (tag + aside), not the viewer's account. Numbers (30 / 300 / $12) remain open until
per-run cost is modelled; the page is the plan, **not publishable until tending ships** — the
all-free placeholder stays up meanwhile. Structure unchanged. Canon: `guidelines/pricing.md` §3.
