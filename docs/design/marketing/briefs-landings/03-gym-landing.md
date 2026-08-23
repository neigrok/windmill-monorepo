# Gym landing — the log that remembers (brief 03)

You are building the gym landing at windmill.works/products/gym as a rebuilt
`templates/landing-gym` board on scaffold v2. The family contract — the nine roles, the moat
rule, fixed chrome, honesty rules — lives in `marketing/briefs-landings/00-README.md`, and the
scaffold itself is defined by `marketing/briefs-landings/01-roadmap-replica.md`. Neither is
restated here; this brief spends its length on what makes gym's instance gym.

One inheritance note, binding for this board. 00's roles 1 and 8 fix family cross-nav
(Roadmap · Journal · Gym · Pricing) and footer product cross-links. The shipped page that
`marketing/briefs-landings/01-roadmap-replica.md` replicates carries neither — 01 already
rules that 00 wins and layers both onto scaffold v2, with the divergence ledgered. Build them
here the same way; if 01's board turns out to be missing them, that is a defect in 01's
execution to fix there, not a licence to drop them on this board.

One scope line before anything else. `gym/briefs/02` through `gym/briefs/08` own the product's
own screens — the set logger, sessions, routines, the diff view. This brief owns only the
landing. Wherever the landing shows product surfaces (the moat, the loop scenes), it must
render what those briefs and `gym/gym-tokens.css` already define; it never redesigns them.

Who this page speaks to, in one breath: a lifter on a written barbell program. Three to five
sessions a week, the same movements for months, weight up in small steps. Knows what they're
doing; wants the app out of the way. Every word on the page is addressed to that person.

## Two modes, one template

Gym is in design, not built. The landing ships now anyway — but a landing must never offer a
door that opens onto nothing. The template therefore carries two modes behind a prop (the
`showStatus` / `showRibbon` pattern from scaffold v2 — call it `preOpen`), and both modes must
be designed on the one board as variants.

| Slot | Pre-open (ships now) | Launch (flipped later) |
|---|---|---|
| Status badge | "In design" | "Now open" — board placeholder, visibly tagged verify-at-flip; whoever flips `preOpen` replaces it with the true state at that time (00, honesty rule 1) |
| Nav CTA slot | No start verb — the slot stays empty or carries the door below | "Start your log" |
| Hero primary | "See what's already open →" to the brand root, where Roadmap and Journal are the open rooms | "Start your log" |
| Hero secondary | "See how it works" — scrolls to the loop; a real section, no start semantics | "See how it works" (same scroll) |
| Trust line | "Gym joins the same account and subscription when it opens." | Board placeholder: "Part of your Windmill account and subscription." — visibly tagged verify-at-flip; replaced with gym's verified truth at launch (00, honesty rule 5) |
| CTA band | The same door and the same when-it-opens line again | "Start your log" + "Log the first set of your next session. That's the whole setup." |
| Recognition | No resume verb — no gym state exists; the nav's signed-in seat is the only recognition | "Open your log" |

Three requirements on top of the table. In pre-open mode, no element anywhere on the page may
read as a start door — not the nav, not the band, not a link buried in the trust panel. The
launch trust line must not copy roadmap's "No account needed" unless it is verified true for
gym at that time (00, honesty rule 5). And the badge must be true in both modes — it is the
family's word.

Two of the pre-open cells drop fixed chrome: role 1's nav CTA verb and role 9's resume verb
have no honest referent before gym exists. 00's pre-open carve-out sanctions exactly this —
cite it on the board; no ledger entry is needed for a sanctioned variant.

## The claim

Gym's register is matter-of-fact (00's register table): a tool that respects that you're tired
and holding a bar. The claim territory is memory — the app knows what you did last week and
puts the number in front of you before you ask.

| | Candidate H1 | Read |
|---|---|---|
| A | It remembers what you lifted. | The thesis in five words. Dry, slightly strange, sticks. |
| B | A log that puts last week's number in front of you. | The mechanism spelled out — true, but it reads like a sub, not a headline. |
| C | Log the set. Next week it's already there. | Two beats, the moat in words. Good, but it explains what A lets the moat prove. |

Recommendation: A. It is the shortest true sentence about the product, and the moat directly
beneath it spends its entire runtime proving it — claim above, evidence below, nothing in
between. B's substance moves into the sub.

Draft sub (one concrete-uses line, naming the user honestly):

> A training log for barbell programs — squat, bench, deadlift, press, rows, chins. Two taps
> between sets, a small jump when it's time, and next session opens with last week's numbers
> already in the field.

You may tighten this, but it must keep all three honest markers: the barbell program, the
between-sets moment, the small steps. "Small steps" stays generic in copy — the literal
"+2.5 kg" is the lifter's program step, not a ladder action, and it may appear only if the
tier canon supports that tap at the load shown, which today it does not (see the ledger entry
below).

## The moat — one set, logged, then remembered

The hero band is a self-playing vignette of the set logger — a dark window on the light page.
This is the family pattern journal established (see
`marketing/briefs-landings/02-journal-landing.md`): the moat wears the product's true skin
while the page around it stays warm cream. Gym's true skin is the dark instrument skin from
`gym/gym-tokens.css` — basalt, volcanic stone, lit by iris inside the window only (steel was
retired 2026-08-07; brief G2 is resolved). Numbers inside the window are JetBrains Mono.

The cast is the set logger exactly as the gym briefs define it: exercise header (Squat), the
weight field, the four-button weight ladder, the reps stepper, the log action, and the
session list beneath.

**Beat A — the set.** The weight field opens at 95 — last week's top set, already there. The
+5 button presses and the field steps 95 → 100. At that load the ladder reads −10 / −5 / +5 /
+10 — the tier table is owned by the gym briefs (±1/±5 under 20 kg, ±2/±5 under 50, ±5/±10
above), and the labels visibly scale with the weight; render them exactly. Reps tick to 5.
The set lands in the session list with a quiet tick — a small check, no glow, no scale-up, no
fanfare of any kind.

One known contradiction, settled here so you never stall on it: gym canon names +2.5 kg as
the lifter's program step, but the tier table offers no ±2.5 button at any load. This board
renders the real ladder — the 95 → 100 script above is the binding one; do not invent a ±2.5
tier under any circumstance. The product-level question belongs to the gym briefs, not this
page. Add this entry to `consistency.md`: "Open — weight-ladder tiers (±1/±5 <20 · ±2/±5 <50
· ±5/±10 >50) offer no ±2.5 step at any load, while gym canon names +2.5 kg as the lifter's
program step; the landing moat renders the real ladder (95 → +5 → 100); direction of fix
owned by gym/briefs."

**Beat B — next week.** The card flips to the next session. Same exercise — and 100 is
already sitting in the weight field before anything is tapped. Hold this frame. It is the H1
made visible, and it must be unmistakable that nobody typed it.

**Optional held frame — the PR.** One muted line beneath the field: "100 × 5 — best yet."
One line of text. No gold, no crown, no pulse. If it crowds the beat, cut it; the flip to a
prefilled field is the moment that sells.

Gating is the family contract's (00, the moat rule): in-viewport, visible tab, deferred off
the critical path, and this vignette is the page's single infinite-motion budget. Under
prefers-reduced-motion the moat must settle to a legible two-panel still: the logged set in
the list on one side, next week's card with 100 prefilled on the other.

## The loop — three beats

Scaffold v2's 01/02/03 pattern. Each scene is a small window of the instrument skin, same
dark-on-light treatment as the moat, replayable under the scaffold's gating. Draft copy below
is the starting point — tighten if you can, but never soften the register.

| # | Title | Two lines | Scene |
|---|---|---|---|
| 01 | Log the set | Two taps between sets. Big targets for one thumb and chalked hands — the ladder steps at the size the load calls for. | The ladder tap and the reps tick, close-up. |
| 02 | It remembers | Next session opens with last time's numbers already in the field. You never scroll back to find what you lifted. | A session card arriving prefilled. |
| 03 | See the line | e1RM per lift, week over week — the long line of showing up. A PR gets one line. | A sparkline drawing left to right; the last point ticks up, quietly. |

## Proof — built for the barbell

The proof slot is a shelf of six movement cards — squat, bench, deadlift, press, rows,
chins — each with a small climbing e1RM sparkline and a specimen number in mono. Each card is
a small instrument-skin window, the same dark-on-light treatment as the loop scenes. The
purpose is recognition: the named user sees their own program on the page at a glance, and a
generic fitness app could never show this shelf. Define e1RM once, quietly, in the section
copy (Epley: weight × (1 + reps/30)).

The numbers must survive a lifter's glance. Use this specimen row (twelve weeks of a linear
cycle): squat 140 · bench 100 · deadlift 170 · press 62.5 · rows 90 · chins BW+20. If you
adjust values, keep the ratios — bench under squat, squat under deadlift, press well under
bench. Chins are always written as added load over bodyweight ("BW+20", never a bare total);
their e1RM is computed over bodyweight plus added load.

Honesty: gym has no users, so these are specimen numbers and must be labelled so — one quiet
caption for the whole section, in the register of "Example: twelve weeks of a linear cycle."
Nothing in this section may read as a usage claim.

The alternative I weighed and did not pick: the weight ladder itself as an interactive
specimen. Not picked because the ladder already stars in the moat — repeating it makes the
page a one-trick pitch, and the proof slot's job here is fit, not mechanics. Six barbell
movements answer "is this for me" for the person on a written program; a second ladder does
not.

## Trust — the connected log

Gym is the MCP-forward product, and this section is the thesis said plainly — no mystique,
no agent theatre.

Title direction: **"Your log is an endpoint your own AI tools can read."**

Clients, as text, never invented logos: Claude Desktop · Claude Code · Cursor · Codex · any
MCP client.

The can-list (three items):

- Read your last twelve weeks of squats.
- Draft next block's progression.
- Propose a routine change.

The can't-line is mandatory and it is the diff-gate, both sentences:

> Nothing an agent suggests touches your program until you tap Apply. And there is no
> chatbot in here.

You may show propose → approve → apply as a tiny typed-diff card with an Apply button —
static or single-play, never competing with the moat's motion budget.

This section also names the paid layer, honestly: the log is free; the connected log is the
paid layer. New power, never a re-sold default — the full absent-not-locked register and the
no-price-numbers rule are 00's honesty rule 2, binding here verbatim (price numbers are
pricing.html's job per `marketing/guidelines/pricing.md`). Refer to it generically as "the
paid layer" (00, honesty rule 3), and check `consistency.md` for the family-wide Pro-vs-One
Open entry — it belongs to the family, not to any one brief. If a sibling board has already
added it, do not duplicate it; if it is absent when you build, add it.

## Why Windmill

A duo, not a trio:

- **One account, three rooms** — mode-varied copy, like the trust line. Pre-open: "Roadmap
  and Journal are open today; Gym joins the same account and subscription when it opens."
  Launch: "Roadmap, Journal, Gym behind one sign-in and one subscription." The family-true
  rule is 00's honesty rule 7: any brand-level line that names gym carries its true state in
  the same breath until it opens — if a sibling board presents gym as open without that, it
  is drift; ledger it.
- **Everywhere you are** — the phone in the gym, the desk between blocks. Same log.

This section must not claim share (nothing shareable is designed) and must not claim export
(no canon supports one). If scaffold v2's slot wants a third card, run two rather than pad
with an untrue item.

## Register guard

The base register is 00's and is not restated here: gym's row in the register table (no XP,
no levels, no badges, no streaks, no "fitness", no "coach"; game metaphor belongs to
roadmap), one quiet line for a PR, and gold never a state (00, honesty rule 6). On top of
that, this page adds:

- "Tracker" joins the forbidden list, and the whole motivational register with it — crush,
  grind, beast, smash, "no excuses".
- No exclamation marks anywhere on the page. Not one.
- The product vocabulary is the schema and must be used exactly: set, session, exercise,
  routine (never "template"), plan snapshot, e1RM, set kind.
- The page must read like a tool, not a membership pitch.

## Deliverables and ledger

- Rebuilt `templates/landing-gym` `.dc.html` board on scaffold v2, both modes as prop-driven
  variants (`preOpen`), light family chrome throughout, the instrument skin appearing only
  inside the moat, loop, and proof windows as specced above.
- Kit mirror rule per 00 must hold: the trimmed `marketing/_ds_kit.js`, never the root
  bundle.
- Cross-links to `templates/landing-main`, the sibling landing templates, and
  `../../marketing/ui_kits/marketing/*.html` must keep working after the rebuild — plus the
  role 1/role 8 cross-nav and footer cross-links per the inheritance ruling above.
- Motion cites `guidelines/motion-language.md`; the moat is the page's one infinite loop.
- Ledger in `consistency.md`: the Pro-vs-One naming drift (owned by brief 01 — add only if
  absent when you build); the weight-ladder ±2.5 entry pre-written in the moat section;
  anything else you find drifting between this page and gym's product canon.
