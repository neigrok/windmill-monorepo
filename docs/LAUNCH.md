# Launch plan — pricing, packaging, GTM

Written 2026-07-19 from two outside advisory panels (pricing/packaging and go-to-market),
convened deliberately without code access so the advice wasn't anchored on what already exists.
PRODUCT_LOG.md remains the running strategy narrative; this is the launch-specific decision record.

Everything marked **SHIPPED** is live. Everything marked **OPEN** is a decision waiting on you or
a build not yet done. Anything marked **VETOABLE** is a call I made while you were away.

---

## The packaging decision

The frame that drove it: the person planning a personal goal is **distribution**, not the buyer.
They make public trees, they fork, they finish their 10k, they leave. The buyer is the person using
this for work, and the agent-native user already paying for Claude/Cursor — the cohort the MCP
server attracts, and the only one with a reason to still be here in month three.

So: make the individual's experience permanently, unapologetically free, and monetise where stakes
and volume appear.

### Free — forever, no card
Unlimited trees and nodes · the whole editor (kinds, layout, reorder, progress, the unlock
ceremony) · unlimited deterministic paste-import · public + unlisted sharing · unfurl cards ·
fork in and out · all nine quests · export · mobile · the playable demo and anonymous creation ·
**the MCP server and one API key**.

### Pro — superseded
The paid line is **tending**: one flat plan for a larger monthly allowance of the in-app AI.
The canonical spec is `docs/design/marketing/guidelines/pricing.md`; this section's
original 2026-07-19 packaging is withdrawn and deliberately not restated here.

### The three calls worth arguing with
1. **MCP stays free.** It's the sharpest differentiator, so the instinct is to charge for it. But
   the agent's owner pays the tokens, not us; it's the only real distribution channel at zero
   users; and a rate error inside an agent loop is the worst support surface imaginable for a solo
   founder — the user never sees a paywall, the agent just sees a tool fail and improvises.
2. **$12, not $9.** $9 reads as hobby-novelty and invites churn the moment the goal completes. $12
   clears that band without inviting the "where's the SLA / team plan?" scrutiny of $20.
3. **No free trial.** The free tier *is* the trial — permanent, no card, no expiry emails, no
   dunning. Better: give new signups a one-time burst of AI imports at peak intent.

### Status
- Pricing/packaging status now tracks `marketing/guidelines/pricing.md` and the tending flag
  (`TENDING_ENABLED`); the 2026-07-19 packaging bullets are withdrawn. New trees default to
  `private` (schema default); visibility is not a billing surface.
- **OPEN** — silent abuse ceilings (trees/account, nodes/tree). Partially done: the node cap now
  applies on the PUT path too. Never market these as limits.

### The upgrade moments (none of the three is built)
1. ~~User picks **Private** in the visibility control → 402 `pro_required` → offer Pro inline, then
   set private on success.~~ **Reverted 2026-07-19**, when the private-tree paywall was withdrawn
   and the paid line moved to the in-site AI (`docs/EXPLORATION-in-site-ai.md`). There is no 402 and
   no `pro_required` anywhere in the backend: the visibility PATCH
   (`backend/products/roadmap/adapters/http/TreeRegistryApi.cpp`) answers 400/404/403/204 and reads
   no entitlement. Visibility is not a billing surface, as the Status bullet above already says.
2. Sixth AI import in a month → the paste box keeps working via the deterministic grammar.
   *(No per-account import allowance exists — compose is anonymous by design, so there is no account
   to meter. It is guarded by per-IP and global rate limiters, a 24KB paste cap, and since
   2026-08-09 the process-wide AI spend fuse, which degrades it to the deterministic grammar rather
   than refusing — the birth canvas never 503s on our own ceiling.)*
3. Attempt to create a second API key. *(`McpKeyService` caps nothing; a user may mint any
   number of keys.)*

---

## Go-to-market

### Beachhead — pick one
**Self-directed learners who already post progress publicly**: the `#100DaysOfCode` /
learn-in-public crowd, the self-taught-dev population orbiting roadmap.sh. Not "people with goals".

The reason is narrow and specific: their existing weekly habit *is publishing a progress update*,
and they are chronically short of something to show. "Day 47, refactored a reducer" is a bad post;
a skill tree with three new nodes lit is a good one. We manufacture content for people under a
standing content obligation. They also already accept the dependency-graph model, they play the
games so the metaphor needs no explanation, and forking is native to them.

Honest caveat: this cohort pays badly. It's chosen for share coefficient, not ARPU — at zero users
the binding constraint is distribution. Revenue comes later, possibly from a different segment.

### The wedge
The **picture** is the wedge. Paste-import is the on-ramp. Fork is the loop. MCP is the story.
Don't confuse them — nobody clicks because of an MCP server.

> **Windmill turns any plan into an RPG skill tree — paste your goal, get a map you unlock node by node.**

Hero: **"Your plan, as a skill tree."** / *"Paste messy notes. Get a map. Unlock it as you go."*
Never lead with "roadmap tool", "goal tracker" or "planning app" — those categories are graveyards
and they set the wrong comparison set. Lead with the noun **skill tree**.

### Channels, ranked
1. **Reddit, artifact-first.** Never post "I built X" — post the tree, titled as the thing it's
   about, and mention the tool in a comment. r/InternetIsBeautiful (link the no-signup demo) is the
   single best shot; then r/learnprogramming or r/webdev; then r/ObsidianMD / r/PKMS. One sub every
   3–4 days. Budget two hours *in the comments* on post day.
2. **Show HN**, Tue–Thu 8–10am ET. Two things HN will chew on: a hand-rolled WebGL2 renderer with
   no three.js, and an MCP server for agent-authored plans. Be in the thread all day.
3. **X via replies, not posts.** Keep 8–10 GIFs ready; reply into `#100DaysOfCode` day-updates and
   MCP threads. Highest-signal manual move: find people publicly stating a learning goal, build
   their tree, send it with no ask.
4. **MCP directories** — one afternoon, evergreen, low volume, high intent.

**Deprioritise Product Hunt** until there are testimonials and real trees (6–8 weeks out).

### The share loop — what has to be true
The tree must be about *them* (their goal, their progress, their handle — our branding small); it
must be legible at thumbnail size (a rendered poster, not a canvas screenshot); the prompt must
fire at the moment of pride (right after an unlock); the recipient must be able to **fork in one
click without signing up**; and it must not be embarrassing to share (nudge after a completeness
threshold).

Highest-leverage build named by the panel: **an auto-generated ~3-second looping video of the
unlock ceremony attached to every shared tree.** Our advantage is that the thing *moves*, and a
static OG image throws that away — X, Reddit and Discord all autoplay video. Nobody in productivity
tooling has this. Then: milestone share prompt, fork attribution in the unfurl, a public gallery
sorted by forks, and a repeat-share surface ("week 3" progress image) that matches the
#100DaysOfCode habit.

### Do not
Build more product · build teams/collaboration/comments/permissions · refactor the renderer ·
Product Hunt now · build analytics · write SEO blog posts about goal-setting · run paid ads ·
**touch pricing tiers or coupons before 20 paying users** · start a Discord at zero users · post
"feedback?" in founder subs · submit to 50 launch directories · let the first ten users' feature
requests become the roadmap (take *usage* as the roadmap, their words as colour).

### First 30 days (~20 hours)
- **Week 0 (5h)** — instrument six funnel events; make the **15-second paste → tree → unlock
  GIF**; three stills + a 40-second MCP clip; write the canonical paragraph once; seed 15–20 good
  public trees on searched topics.
- **Week 1 (5h)** — r/InternetIsBeautiful, then r/learnprogramming. Ship share-on-unlock.
- **Week 2 (5h)** — Show HN + all MCP directory submissions + the engineering writeup.
- **Week 3 (5h)** — manual outreach: 30 trees built for people who posted a goal; message everyone
  who created a tree and ask what they were actually trying to plan. Don't skip this week.
- **Week 4 (5h)** — double down on whatever converted; fix the one thing the funnel demands.

**First action:** record the 15-second paste → tree → unlock GIF. Every channel is blocked on it.

### What success looks like in 30 days
3,000–10,000 visitors · 150–500 trees created · 100–300 signups · 20–60 shared trees · 5–25 forks ·
**10–25 people who came back in week two and unlocked a node** ← the only number that matters ·
0–3 paying (treat any payment as a qualitative event).

Pass/fail: 20 week-2-retained users, at least one tree shared by someone who isn't you that brought
in a new user, and ten real conversations. 300 signups with 2 retained means marketing worked and
the product is the problem — worth knowing in 30 days rather than six months.
