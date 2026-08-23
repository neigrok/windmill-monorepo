# Launch — pricing, packaging, GTM

The launch-specific decision record. `PRODUCT_LOG.md` is the running strategy narrative.

## Packaging

The individual's experience is permanently free. Money appears only where stakes and volume do.

**Free, no card:** unlimited trees and nodes · the whole editor (kinds, layout, reorder, progress,
the unlock ceremony) · unlimited deterministic paste-import · public and unlisted sharing · unfurl
cards · fork in and out · all nine quests · export · mobile · the playable demo and anonymous
creation · the MCP server and API keys.

**Paid:** the canonical spec is `docs/design/marketing/guidelines/pricing.md`. Visibility is never
a billing surface — the visibility PATCH reads no entitlement, and new trees default to `private`.

Three calls that stand:

1. **MCP stays free.** The agent's owner pays the tokens; it is the only real distribution channel
   at zero users; and a rate error inside an agent loop is the worst possible support surface — the
   user never sees a paywall, the agent just sees a tool fail and improvises.
2. **No free trial.** The free tier is the trial — permanent, no card, no expiry emails, no
   dunning.
3. **Do not touch pricing tiers or coupons before 20 paying users.**

Compose has no per-account allowance — it is anonymous by design, so there is no account to meter.
It is guarded by per-IP and global rate limiters, a 24KB paste cap, and the process-wide AI spend
fuse, which degrades it to the deterministic grammar rather than refusing.

Open: silent abuse ceilings (trees per account, nodes per tree). Never marketed as limits.

## Beachhead

**Self-directed learners who already post progress publicly** — the `#100DaysOfCode` /
learn-in-public crowd, the self-taught-dev population orbiting roadmap.sh. Not "people with goals".

Their existing weekly habit *is publishing a progress update*, and they are chronically short of
something to show. They already accept the dependency-graph model, they play the games so the
metaphor needs no explanation, and forking is native to them. The cohort pays badly; it is chosen
for share coefficient, not ARPU.

## The wedge

The **picture** is the wedge. Paste-import is the on-ramp. Fork is the loop. MCP is the story.
Nobody clicks because of an MCP server.

> Windmill turns any plan into an RPG skill tree — paste your goal, get a map you unlock node by
> node.

Hero: **"Your plan, as a skill tree."** / *"Paste messy notes. Get a map. Unlock it as you go."*
Never lead with "roadmap tool", "goal tracker" or "planning app". Lead with the noun **skill tree**.

## Channels, ranked

1. **Reddit, artifact-first.** Never post "I built X" — post the tree, titled as the thing it is
   about, and mention the tool in a comment. r/InternetIsBeautiful (link the no-signup demo) first;
   then r/learnprogramming or r/webdev; then r/ObsidianMD / r/PKMS. One sub every 3–4 days. Budget
   two hours in the comments on post day.
2. **Show HN**, Tue–Thu 8–10am ET. Two things HN will chew on: a hand-rolled WebGL2 renderer with
   no three.js, and an MCP server for agent-authored plans. Be in the thread all day.
3. **X via replies, not posts.** Keep 8–10 GIFs ready; reply into `#100DaysOfCode` day-updates and
   MCP threads. Highest-signal manual move: find people publicly stating a learning goal, build
   their tree, send it with no ask.
4. **MCP directories** — one afternoon, evergreen, low volume, high intent.

Product Hunt waits for testimonials and real trees.

## The share loop — what has to be true

The tree is about *them* (their goal, their progress, their handle — our branding small); it is
legible at thumbnail size (a rendered poster, not a canvas screenshot); the prompt fires at the
moment of pride (right after an unlock); the recipient can fork in one click without signing up;
and it is not embarrassing to share (nudge after a completeness threshold).

Highest-leverage build still open: an auto-generated ~3-second looping video of the unlock ceremony
attached to every shared tree. X, Reddit and Discord all autoplay video; a static OG image throws
away the one thing that moves.

## Do not

Build more product · build teams/collaboration/comments/permissions · refactor the renderer ·
Product Hunt now · build analytics · write SEO blog posts about goal-setting · run paid ads · start
a Discord at zero users · post "feedback?" in founder subs · submit to 50 launch directories · let
the first ten users' feature requests become the roadmap (take *usage* as the roadmap, their words
as colour).

## First 30 days (~20 hours)

- **Week 0 (5h)** — instrument six funnel events; make the 15-second paste → tree → unlock GIF;
  three stills plus a 40-second MCP clip; write the canonical paragraph once; seed 15–20 good
  public trees on searched topics.
- **Week 1 (5h)** — r/InternetIsBeautiful, then r/learnprogramming. Ship share-on-unlock.
- **Week 2 (5h)** — Show HN, all MCP directory submissions, the engineering writeup.
- **Week 3 (5h)** — manual outreach: 30 trees built for people who posted a goal; message everyone
  who created a tree and ask what they were trying to plan. Do not skip this week.
- **Week 4 (5h)** — double down on whatever converted; fix the one thing the funnel demands.

**First action:** record the 15-second paste → tree → unlock GIF. Every channel is blocked on it.

## What success looks like in 30 days

3,000–10,000 visitors · 150–500 trees created · 100–300 signups · 20–60 shared trees · 5–25 forks ·
**10–25 people who came back in week two and unlocked a node** ← the only number that matters ·
0–3 paying.

Pass/fail: 20 week-2-retained users, at least one tree shared by someone who isn't you that brought
in a new user, and ten real conversations.
