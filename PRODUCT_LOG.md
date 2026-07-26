# Windmill — Product Log

The product strategy narrative. The **bet ledger lives in the dogfood tree**
(`t_9362d9bc883e0a1e`, via the windmill MCP): every bet below names its tree node, the
bet id IS the node id, and progress is tracked there — never here. This doc holds what a
tree node can't: the thesis, the metric contract, the cuts, and the risks.

> **Status (2026-07-16): reality reset.** The previous revision of this doc ("design
> phase, backend now in progress") had fallen months behind the code. A full three-way
> review (this doc ↔ dogfood tree ↔ both repos + the live site, multi-agent, code-verified)
> found: **the platform is finished and the funnel is fiction.** Of the old 19 bets,
> 8 shipped (most beyond spec), 4 are partial, 7 were never started — while the live
> landing page sells three of the never-started ones. This revision replaces the old plan
> with the one seeded into the tree on 2026-07-16.

---

## Where Windmill actually is

**Shipped and solid** (per code review, not per docs): magic-link accounts with 90-day
sessions; OAuth 2.1 authorization server; a 27-tool remote MCP endpoint at
`windmill.works/mcp` with a completed ergonomics program; full CRDT offline-first cloud
sync (row-lattice Postgres storage, HLC, O(delta) anti-entropy, per-user LWW progress,
IndexedDB outbox, d2d `.windmill` files); live WebSocket collaboration with presence;
multi-tree registry + switcher + per-tree routing; the node workspace (checklist, notes,
links, progress arc); server-authoritative color legend; the whole motion/ceremony system
with reduced-motion; PNG share export + share dialog + tree portrait; a real marketing
landing at the site root with SEO/OG head, robots, sitemap; mobile chrome + touch; Docker
one-VPS deploy with push-to-main CI. In flight: `fork-door`, `new-tree-birth`, `share-gif`.

**Broken or missing — the growth half:**
- The landing promises "no account needed", paste-a-list, and nine starter quests; the
  only creation path is sign-in-gated, no paste parser exists, and quest planting returns
  a literal 501. The Fork door emails real users about a fork that never executes
  (`handleForkSubmit() {}`).
- Every social unfurl serves a broken image — `og:image` points at a file that doesn't
  exist (the SPA fallback 200s it, so nothing screams). All app routes are hash routes:
  per-tree unfurls and SEO are architecturally impossible until `/t/:id` is a path.
- Browser progress marks stop at localStorage (cache clear still eats checkmarks); the
  server LWW store is ready and nothing sends to it.
- The "reminder" that shipped is an HTML template. There is no scheduler, gate,
  suppression, pause token, settings surface, or preferences table.
- **Zero instrumentation.** Not one event is captured anywhere; even the Cloudflare
  beacon 503s. Every metric this strategy ranks by is currently unmeasurable.
- Every tree is world-readable by id (the `visibility` column is never enforced); no
  backups; the collab core is structurally single-instance; Privacy/Terms are `href="#"`
  on a site that collects emails.

## Thesis

The old thesis ("activation-first, fold the backend in") is obsolete — the backend won.
The new thesis: **make the front door honest, measure it, then amplify.**

1. **Truth before traffic.** The product currently over-promises at every seam. Fixing
   copy, unfurls, the fork stub, and the email wall is cheaper than any feature and is a
   prerequisite for un-poisoned metrics — visitors betrayed by absent features don't
   convert and don't come back.
2. **Measure before optimizing.** Pre-production is the only cheap moment to wire a
   first-party event spine and define activation numerically. No phase-3 bet ships
   without a gate it can fail.
3. **Loops before amplification.** Close the k-loop's actual edges (artifact → URL →
   fork → claim) before buying reach; ship retention's substrate (progress on the wire,
   a frontier to return to) before nudging anyone by email.
4. **The craft is the moat.** The derived unlock cascade and the ceremony system are the
   differentiator — the plan makes strangers *feel* them (playable demo, return recap,
   milestone beat) rather than adding funnel machinery that cheapens the product.

## Metric contract

- **Activation** — an *activated visitor* plants a tree with **≥3 nodes** and marks a
  **first completion within 48h**. Measured land → birth → activated. (A one-bud tree is
  not activation.)
- **Virality** — `?ref`-attributed share-link visits → fork attempts → claimed forks per
  shared artifact. k is not declared real until measured end-to-end.
- **Retention** — W1 return rate; post-reminder 48h re-activation once the engine ships;
  guardrail: share of qualifying weeks correctly suppressed.
- **Monetization** — deliberately unmeasured this cycle (see Parked).

Numeric targets get set one week after `funnel-baseline` lands real data — targets
invented before a baseline exist to be gamed. Each phase-3 amplification bet must name
its kill rule when it starts.

## The plan (seeded in the tree, 2026-07-16)

**Phase 0 — land what's in flight.** `fork-door`, `new-tree-birth`, `share-gif` finish
before new bets open; nearly all of phase 1 stacks on the first two. Plus `plan-realign`
(this document + the seeded tree) — done.

**Phase 1 — the honest door. COMPLETE 2026-07-17.**
`truth-pass` (✓ 2026-07-16) · `event-spine` (✓) · `funnel-baseline` (✓) ·
`anon-first-tree` (✓ 2026-07-17) · `fork-claim` (✓) · `share-link` (✓) ·
`progress-wire` (✓) · `share-hardening` (✓) · `signed-in-home` (✓)
Every one is S/M, every one either stops a live lie, closes a loop edge that already has
both ends built, or makes the funnel measurable. All three review lenses independently
ranked this same set first; every claim behind them is code-verified.

> **Phase 1 close-out (2026-07-16/17).** Eight of nine shipped in two days, each through
> the gauntlet (parallel build → adversarial review → fix pass → e2e → push). The reviews
> earned their keep every wave: the truth-pass audit caught six dishonest claims the
> design spec's own truth-check missed (invented export pipeline, phantom reminder mail,
> undisclosed telemetry, a fabricated beta date); the fork-mail review confirmed the
> describe-before-rate-limit seam is bounded and moved title escaping to the sender where
> Resend's raw-substitution contract demands it; the tree-stewardship review turned an
> "accepted edge" into its real name — two silent unhealable CRDT divergence modes — and
> the fix made the tree title a durable LWW register (stamp column, dominance-guarded
> writes). Also landed out of phase order because designs arrived: `fork-mail`
> (the magic link now names the tree it plants) and `tree-stewardship` (rename & delete
> from the switcher; title ops flow through the live room). What phase 1 measured into
> existence: funnel views live over a real event spine; the demo tree real; windmill.works
> honest end-to-end. Next: `anon-first-tree` (X6 claiming spec) — then phase 2's on-ramps.

> **Phase 1 closed (2026-07-17).** `anon-first-tree` shipped last: signed-out ↵ births a
> real local tree (no email wall at peak intent) and signing in claims it — additive,
> resumable, narrated by the seat chip. The build's plan agent found the fact that made
> it small: the client and server genesis seeds are byte-equal, so claiming is just
> create-empty-under-the-kept-id plus the ordinary sync flush. The browser e2e then
> caught a wire bug that had been live since the sync cutover — the server echoed client
> 'flush' intents verbatim and clients re-baselined on them, so every offline-bank flush
> ping-ponged forever (silent traffic burn; content stayed correct, which is why it
> hid). Fixed on both sides of the wire. Two deploy-pipeline lessons also banked: CI had
> been silently failing for four pushes (a macOS/Linux jsoncpp divergence in a test),
> meaning prod ran days-old code while we shipped — the events endpoint was dark until
> 2026-07-17, so the funnel baseline effectively starts today. A push is not a deploy;
> the working agreement now says probe prod after every backend push.
> **What phase 1 bought:** windmill.works no longer lies anywhere a stranger can see,
> every promise on the landing page is executable, the funnel is measurable end-to-end,
> and the anonymous→claimed journey — the product's core adoption bet — works. Next:
> phase 2 on-ramps (`paste-import`, `quest-picker`, `playable-demo`) and the settings
> vertical (`settings-api` → `settings-seat`), all design-canon-backed.

**Phase 2 — on-ramps and surfaces.** (Most of it shipped 2026-07-17: paste-import,
quest-picker, tree-stewardship, settings vertical, playable-demo, mcp-listing on-site slice.
Remaining: `ops-guardrails` (partly owner/infra-gated: needs offsite backups + a restore
drill), `feedback-door` (S but low value pre-launch — park until near launch), plus the
`paste-shape-polish` follow-up (design finalized brief #8). One OWNER ACTION open: submit
windmill.works/mcp to MCP registries — code + public README page are ready.)
`tree-visibility` (✓ 2026-07-17 — private trees are actually private now: a single pure
`canRead` gates every read path (HTTP, socket, MCP, fork), private denies byte-identical to
absent so the id is no existence oracle, sharing flips private→unlisted. Two review passes;
the independent one caught a `set_progress` node-id oracle the first missed.)
`playable-demo` (✓ 2026-07-17 — windmill.works/#/demo: the Learn to sail tree a stranger
can actually play before signing up. Complete-only, session-local (never touches the
server), one coach chip, and forking trades read-only clothes for editing ones. The
front-door hook the "Try the demo" CTAs always promised.)
`paste-import` (✓ 2026-07-17 — the 8-rule deterministic grammar from canon, PLUS an
owner-decided hybrid: prose pastes offer AI shaping through /v1/compose (Sonnet-backed,
async, rate-limited), the model producing text in the same grammar the parser then
confirms — "paste is import" holds because the parser stays the only door into a tree)
· `playable-demo` · `quest-picker` (✓ 2026-07-17 — nine authored trees on a shelf at
`#/app/start`, now the first-run landing; the decision that made it small: quests are
client-shipped content planted down the roads paste-import already built, so the
`fromQuest` server-catalog stub died instead of growing) · `quest-log` (✓ 2026-07-16)
· `settings-api` → `settings-seat` (both ✓ 2026-07-17 — the account page the seat
menu always pointed at, live at `#/settings`: rename yourself, see and revoke every
signed-in device, disconnect AI tools, export every tree as paste-able Markdown, or
close the account behind a typed-email confirm with a 30-day "undo = sign in" grace.
Retires OAuthConsent's dangling "disconnect in Settings" promise and closes the paste
grammar's export half via `serializePlan`) ·
`tree-stewardship` (✓ 2026-07-17, pulled up — see phase 1 close-out) · `tree-visibility` ·
`ops-guardrails` · `mcp-listing` · `feedback-door`

> **Journey audit (2026-07-16).** Fourteen user journeys walked step-by-step through the
> code: 16 deduped gaps, of which 12 were already covered by the plan above — unshipped,
> not mis-planned. Two live blockers surfaced: the landing's "Try the live demo" CTA 404s
> in production (no demo tree exists anywhere), and "Start your tree" contradicts its own
> "no account needed" promise — both folded into `truth-pass`, whose mandate now covers
> every user-visible string (incl. OAuthConsent's "Settings → Connections" pointing at a
> route that doesn't exist). The product shell verdict: the engine and the canon are
> strong; the surfaces around the user — front door, settings, tree management, MCP
> discovery — are the gap between "impressive" and "payable."
The activation on-ramps the landing already sells (paste, quests, a demo you can feel),
the return-visit surface, and the trust/ops floor (privacy stance, caps, backups, legal
pages, a way to hear from users) that stranger-facing traffic requires.

**Phase 3 — amplify and retain (each behind a measured gate).**
`email-deliverability` → `reminder-engine` · `path-share-pages` → `og-tree-cards` ·
`milestone-share-beat` · `return-recap` · `launch-moment` · `sync-scale-out` (tripwire)
Reminders only after settings + deliverability + a frontier to link to; per-tree unfurls
only after path routing; the share beat only after share-link CTR exists; the launch
moment (Show HN / PH) only once the door is honest — a k-loop times zero visitors is zero.

## Disposition of the original 19 bets

| old bet | verdict | now |
|---|---|---|
| 1 durable-progress | shipped (server half) | browser half → `progress-wire` |
| 2 tree-registry | shipped beyond spec | closed |
| 3 paste-import | absent, sold on landing | `paste-import` (P2) |
| 4 playable-demo | partial (read-only museum) | `playable-demo` (P2) |
| 5 quest-picker | facade (cards → 501) | `quest-picker` (P2) |
| 6 color-legend | shipped exactly as designed | closed |
| 7 cloud-sync | shipped far beyond spec | closed |
| 8 hosted-share | partial (viewer yes; unfurl/links no) | `share-link` (P1), `path-share-pages` + `og-tree-cards` (P3) |
| 9 png-export | shipped | closed |
| 10 unlock-ceremony | shipped richer than spec | share hook → `milestone-share-beat` (P3) |
| 11 quest-log | absent | `quest-log` (P2) |
| 12 reminders | template only | `settings-seat` (P2), `email-deliverability` + `reminder-engine` (P3) |
| 13 gallery | absent (a card in the showcase) | **deferred** — see Cuts |
| 14 node-workspace | shipped | closed |
| 15 gif-export | in flight as `share-gif` | lands at scoped size; no MP4 escalation |
| 16 license-keys | absent | **parked** — see Cuts |
| 17 mcp-server | shipped far beyond spec | distribution → `mcp-listing` (P2) |
| 18 llm-generator | absent | **retired** — the MCP server is the LLM path |
| 19 subscriptions | absent | **parked** with 16 |

New bets with no old number: `truth-pass`, `event-spine`, `funnel-baseline`,
`anon-first-tree`, `fork-claim`, `share-hardening`, `tree-visibility`, `ops-guardrails`,
`feedback-door`, `return-recap`, `launch-moment`, `sync-scale-out`, `plan-realign`.

## Cut, retired, parked (what this plan refuses)

- **LLM goal-to-quest generator — retired, not parked.** The shipped 27-tool OAuth'd MCP
  server is the agent path; an in-app generator needs an LLM proxy and re-solves a solved
  problem. Revisit only if non-agent users demonstrably demand in-app generation.
- **Public gallery — deferred behind quest-picker + tree-visibility + a moderation
  story.** Greenfield on both ends; the curated-browse value ships via quests. Re-opens
  when telemetry shows real fork-per-view on shared pages.
- **All monetization (license keys, subscriptions, team seats) — parked behind
  `funnel-baseline` evidence of retention.** Pricing an unmeasured funnel anchors low and
  contaminates cohorts. Team seats additionally smuggle in a payments backend and a
  roles/authz surface. The watermark stays the only monetization primitive this cycle.
- **Streaks** — decoration on a return visit that doesn't exist yet; `progress-timestamps`
  make it cheap later.
- **Dark app chrome** — full token set exists, wiring it moves no funnel metric; share
  exports already cover dark feeds. Brand light-only for now, deliberately.
- **Short links / embeds / README badges / social auto-posting / paid acquisition** —
  amplification ahead of a working loop.
- **⌘K search** — still cut; bites only at tree scale the funnel hasn't produced.

## Risks carried

- **Email deliverability is an activation risk, not just a reminder risk** — magic link
  is the only sign-in and now carries fork/claim tokens. SPF/DKIM/DMARC + stream
  separation before any recurring send (`email-deliverability`).
- **Cross-browser claim hazard** — anonymous-tree claim assumes the magic link opens in
  the browser holding IndexedDB. Fork-claim solves this server-side (pending fork);
  anon-tree claim needs an explicit same-browser fallback design.
- **Single-instance collab core** — a successful launch cannot be absorbed by adding
  replicas; `sync-scale-out` is a tripwire with a designed fix, pulled forward on load.
- **Path-routing migration breaks pre-migration hash links** — ship `path-share-pages`
  before `share-link` proliferates URLs, or carry a permanent hash→path redirect shim.
- **WebGL2-only rendering sheds unknown visitors** — `event-spine` logs render-init
  failures from day one; a graceful fallback is a later call made on data.
- **Brand collision** — "Windmill" is an established dev-tools brand (windmill.dev)
  aimed at the same developer audience as the quest wedge. Watch discoverability data;
  a naming decision is cheapest pre-launch.
- **roadmap.sh content is CC-BY-SA** — attribution ships with `quest-picker`, on-surface.
- **Baseline poisoning** — activation numbers collected before `truth-pass` lands measure
  betrayed intent; fix the copy first or discount the early cohort.

## Feature specs

### Reminders — send rules · `reminder-engine`

**The promise (email footer copy, verbatim):**
> You get this once a week, only while a tree has steps ready.
> Pause reminders · Manage in settings

Everything below exists to make that line literally true.

**Eligibility**
- Requires an account with a **verified email** and reminders **enabled**. Default
  on-vs-opt-in is a launch decision made *after* `settings-seat` ships — flag, don't
  assume.
- Signed-out / local-only users get nothing.

**Send rule — weekly, gated on "steps ready"**
- Fixed weekly slot per user (default a calm weekday morning, user's timezone,
  adjustable). **At most one reminder per 7 days**, enforced by a DB send log.
- **The gate:** send only if ≥1 tree has a non-empty ready set (nodes deriving to
  `available`, not complete). Nothing ready → skip silently.
- **Active-user suppression:** skip if active within ~3 days.
- A skipped week resumes at the *following* week's slot — genuinely weekly.

**Content**
- One email per user. Feature the most recently active tree with ready steps: up to
  **3 ready steps** + a mini tree visual, deep-linking to that tree's frontier
  (`quest-log`). Other qualifying trees: a quiet "+N more ready."

**Controls (the footer links)**
- **Pause** — one click via **signed token, no login**, confirm page, pauses all.
- **Manage in settings** — `settings-seat`: enable/disable, day + time, quiet hours,
  pause/resume. Required list management (CAN-SPAM/GDPR); applies to reminders only,
  never to transactional auth mail (`email-deliverability` keeps the streams separate).

**Edge cases**
- New-account grace: no reminder until a ready step has existed a full week.
- Hard bounce / spam complaint: auto-suppress, surface in settings.
- Fully-complete user: nothing ready → nothing sent.
- One schedule per account regardless of devices; timezone per account.

**Metrics**
- Open rate, click-through, re-activation (return within 48h), pause/disable rate, and
  the suppression guardrail (share of qualifying weeks correctly skipped).

**Dependencies**
- `settings-seat` (prefs + pause page) · `progress-wire` (server-known progress) ·
  `quest-log` (the deep-link target) · `email-deliverability` (streams + auth) ·
  the shipped `email-reminder` template.
