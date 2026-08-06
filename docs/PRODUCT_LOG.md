# Windmill — Product Log

The product strategy narrative. The **bet ledger lives in the dogfood tree**
(`t_9362d9bc883e0a1e`, via the windmill MCP): every bet below names its tree node, the
bet id IS the node id, and progress is tracked there — never here. This doc holds what a
tree node can't: the thesis, the metric contract, the cuts, and the risks.

Everything above the "Gym" heading is **roadmap's** narrative. Journal's design lives in
`backend/products/journal/ARCHITECTURE.md`; gym's plan is the last section of this file.

> **Status (2026-07-29): two corrections, and the third product gets a plan.**
> **(a) Monetization is no longer parked — it shipped while this doc said otherwise.** The metric
> contract below ("deliberately unmeasured this cycle") and the Cuts section ("all monetization —
> parked behind `funnel-baseline` evidence") are **stale as of the Windmill One work**. One paid
> tier now exists and gates three live surfaces through one predicate,
> `Entitlements::hasWindmillOne` (`backend/platform/application/Entitlements.h`, committed in
> `516ef23`): roadmap's tending, journal's echoes (`EchoSweep.cpp:69`), and journal's Talk
> (`VoiceApi.cpp:26`). What is still true is the *restraint*: no price is open
> (`paidPlansOpen()` in `web/src/shell/billing/checkout.js` still returns `false` — the constant
> `PAID_PLANS_OPEN` this line used to name is gone, see the shell-inversion note below), and no
> bet's success is defined by revenue this cycle. Products do
> not define their own paid axis — they contribute surfaces to the one Windmill One funnel.
> **(b) Gym has a plan** — see the final section. Written against a code-verified inventory of
> **Lift**, a shipped standalone iOS training log; the inventory itself is `docs/lift-dossier.md`.

> **Status (2026-07-27): brand restructure.** Windmill became a **monorepo brand of three
> self-growth products** — `roadmap` (shipped), `notes` and `gym` (scaffolded) — on one shared
> backend, presented as one superapp per surface (web · iOS · Android), behind one account and one
> subscription. The old two repos (`windmill-backend`, `windmill`) were grafted with full history
> under `backend/` and `web/`; the flat backend split into product-neutral `platform/` +
> `products/roadmap/`, the web app into `design-system` + `shell` + `products/roadmap`. Behavior-
> identical relocation — 610 backend + 399 web tests green, and the full stack verified end-to-end
> (server boots with platform+roadmap routes, MCP `create_tree` persists, the demo scene renders
> with zero console errors). Native slots: a compilable iOS SwiftPM scaffold, a structured Android
> one. See `STRUCTURE.md` for the layout, the one dependency rule, and the known follow-ups. Not yet
> pushed to a remote — the GitHub topology decision is pending. This does not change the product
> thesis below; it changes the house the products live in.

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

---

# Gym — the third product

> **Status (2026-08-01): phase 0 is built.** `gym-architecture` shipped the contract before any code
> (`backend/products/gym/ARCHITECTURE.md`); `gym-schema` (five tables, 64 seeded movements),
> `gym-backend-seam` (`windmill_gym`, six routes, four lines in `main.cpp`) and `gym-web-seam` (the
> module shell at `#/gym`, `pwa-shell` beside it) followed in one wave. The seam is real: a set
> logged by curl survives a server restart. The shell `status` stays `'pre-open'` until the logger
> exists — `/app/gym` still redirects to the landing, and the author dogfoods at `#/gym`.
>
> **What the gauntlet cost, and why it was worth it.** Four executing reviewers found 21 defects,
> every one reproduced independently by a second agent before it was believed. One was a **blocker**:
> `insertSet` read its row back by id alone, so replaying another lifter's set id returned their
> weight, reps, RPE and free-text note — and silently dropped the caller's own write. 376 green
> tests missed it because `Fakes.h` mirrored the same unscoped lookup. That is Lift's proposal-apply
> bug, the one this plan banked as a risk ("its mock could not reproduce it because the fake didn't
> model the persistence boundary"), reproduced by us, in our own code, in the first wave — the rule
> now holds by construction and the fake enforces it. A second lesson: the reviewers' proposed
> one-liner for the duplicate-set-number race (`FOR UPDATE` inside the INSERT…SELECT) was **proved
> not to work** under READ COMMITTED, and only fell to a two-statement lock. A fix nobody executes
> is a guess.
>
> This plan was written against a code-verified inventory of **Lift**, a shipped standalone
> SwiftUI/SwiftData iOS training log with an LLM coach (~8.7k lines of Swift, 35 commits, ~57 tests
> — one of them red for the last ten commits and nobody noticed). The inventory is
> `docs/lift-dossier.md`; this section holds only what a dossier and a tree node can't.
> **Lift is not a codebase we migrate. It is a spec written in Swift and a bug ledger.**

## Who this is for

A lifter who follows a written program — barbell-shaped, 3–5 sessions a week, the same movements for
months, weight going up in small steps. Not a class-goer, not a runner, not a beginner looking for
guidance. This is stated first because every cut below follows from it, and because leaving it
unstated is how a training log becomes a fitness app.

## What Lift established

**Thesis: one value at a time, not a spreadsheet.** Every competitor shows a grid you fill in. Lift
shows one exercise, one weight, one rep count, one button, and spends all its cleverness making
those need as few taps as possible. Its best code is the weight ladder
(`lift:Lift/Shared/Formatters.swift:36-60`): ±1/±5 under 20 kg, ±2/±5 under 50, ±5/±10 above, with
down-steps evaluated at `weight − 0.01` so stepping down from exactly 20 kg lands on 19, not 18. Its
second best is the coach's write path — the model cannot mutate anything; it emits a typed diff, the
agent suspends on a continuation, and the user's tap is fed back as the tool result
(`lift:Lift/Services/Chat/ChatService.swift:156-187`).

**Where it stopped, structurally:**

1. **Exercise identity is a free-text string, everywhere.** Rename a lift and its history forks.
   Put the same lift twice in one template and both collapse into one set counter
   (`uniquingKeysWith`, `lift:Lift/Services/ActiveWorkoutManager.swift:114-117`). The coach can only
   address exercises by exact string, so "bench press" returns nothing.
2. **The plan and the log are the same object.** Sessions store `templateId` plus a copied name,
   never a snapshot. The app can tell you what you did and never what you were supposed to do, and
   editing a template mid-workout permanently rewrites the program.
3. **No prefill from last week.** Weights come from a static `startWeight` the user edits by hand.
   Progressive overload — the entire point of a training log — is unautomated.
4. **The paid tier never transacted.** `PaidLLMBackend.send` is an unconditional
   `throw "Lift Intelligence is coming soon"` (`lift:Lift/Services/Chat/PaidLLMBackend.swift:14`)
   behind a complete StoreKit funnel: $4.99/mo, a 1-week trial, entitlement listening, restore.
   Worse, `isAvailable` is hardcoded `true` and `ChatService.send()` auto-adopts the backend for any
   subscriber, so the lock UI never fires and a **paying** user gets an error bubble instead of a
   gate. **Zero purchases were ever possible: there is no pricing evidence, no conversion data, and
   no willingness-to-pay signal of any kind.** What Lift produced is a *placement hypothesis* — gate
   at the post-workout peak, never at the log.

Everything else is device-local: SwiftData, Keychain, `@AppStorage`, chat history as JSON files. No
account, no sync, no export, no backup. A corrupt store is "recovered" by deleting the user's entire
training history and retrying (`lift:Lift/LiftApp.swift:18-32`).

## What gym gets free from the platform

Gym writes none of this; it is load-bearing for two products already. Accounts, magic-link sessions
(90 days), Google sign-in, device list and revoke, soft close with a 30-day revival
(`backend/platform/application/AuthService.h`). The trust boundary — `callerUserOf`
(`backend/platform/adapters/http/Caller.h`) — is every handler's first two lines. Billing: Paddle
webhooks, checkout and the subscription mirror, asked exactly one question,
`Entitlements::hasWindmillOne` (`backend/platform/application/Entitlements.h`, `516ef23`), the same
predicate journal's Talk and echoes read. **This is Lift's missing `throw`, already written and
already tested.** The settings surface composes each product's registered sections off the registry
(`web/src/shell/settings/SettingsPage.jsx` flatMaps `settingsSections.main` and `.data`), so gym
contributes a section and rebuilds nothing. Email is one `ResendClient` under a product-owned port
(journal's `NudgeMailSender` + `ResendNudgeSender` is the two-file template). Plus telemetry, the
error ledger, CORS, the rate limiter, `pgThreadConnection`, the 18-component design system, and a
plug-in seam that is one `gym::registerRoutes(app, GymDeps&)` call.

## Thesis

**The log is free. The *connected* log is Windmill One.**

Every competitor sells "tracker free, AI coach paid" — Hevy, Strong, Fitbod, and every wrapper
shipped since 2023. Building a fifth in-app chatbot is not a product bet, it is a subscription to
someone else's tokens. Windmill has something none of them do and it is already shipped: an OAuth 2.1
MCP server with a 27-tool endpoint at `windmill.works/mcp`. This doc already ruled on this once, for
roadmap: the in-app LLM generator was **retired, not parked**, because "the shipped MCP server is the
agent path." Gym inherits that ruling rather than quietly reversing it.

So gym's coach is not a chat tab. **Your training log is an endpoint your own Claude or ChatGPT can
use** — it knows your last twelve weeks of squats, and it drafts next block's progression. The user
brings their own agent, and the safety model is the **grant**: three levels per product, approved one
at a time, and a level nobody approved is a tool the connection cannot even see.

**Amended 2026-08-06 (`gym-coach`).** Two of the refusals above did not survive contact with the
owner, and both reversals are written down rather than made quietly. First, *Lift's propose-apply
contract*: a granted MCP write lands directly, exactly as roadmap's tending writes, so the sentence
that once said changes "arrive as a typed diff you tap to apply" was describing a contract this
product does not hold — what stands where the human's Apply stood is the grant, and the fact that the
three destructive tools sit behind `gym:delete` alone. Second, *no in-app chat*: there is now a
**panel under any finished workout**, and it is the same system with a second door rather than a
second system — the same fifteen tools, the same LogService, handed a read-only scope. So gym does
now ship a prompt, a tool loop and a token bill (`adapters/llm/AnthropicCoach`), all three bounded:
read-only, one workout, six iterations, Windmill One, and dark — no `ANTHROPIC_API_KEY`, no route.
What is still not built and stays cut: streaming, proposal chrome, and any chat that is not attached
to one session that already happened.

1. **The log must survive the gym, and the phone.** Lift spent more code protecting data than
   presenting it and still ships a path that deletes a user's history to stay alive. A training log
   is a multi-year artifact nobody can regenerate. Server-as-truth is not a feature of gym; it is the
   reason gym exists here.
2. **Identity before analytics.** Every structural bug in Lift traces to one line: an exercise is a
   display string. Stable ids are a schema decision taken in the first migration — never a screen.
3. **One tap is the product.** The ladder, sticky carry-forward, last-time prefill. The craft is the
   number being right before you touch it.
4. **The tools are the only way a model touches data, and the grant decides which tools exist.**
   Corrected 2026-08-07, because the previous wording ("the model proposes; the human applies —
   the same contract roadmap's tending holds") described a safety property roadmap's tending has
   never had: `products/roadmap/domain/Tending.h` says an agent's edits "land through the tree's
   room and into the op log exactly as a person's do". The contract that IS held, in both products,
   is narrower and more honest — a scoped catalog with the destructive tools removed outright, one
   sentence to one undo, and an iteration cap that is a failure rather than a success. Gym's grant
   model makes it explicit: `delete` is never implied by `write`, and a client without it cannot
   see a destructive tool, let alone call one.

**Gym's version of "the craft is the moat"** is the strength graph. Roadmap is a shipped RPG skill
tree; strength progression *is* a prerequisite graph — bodyweight dip unlocks weighted dip unlocks
muscle-up; a 100 kg squat unlocks the next block. A strength tree that lights up from sets you
actually logged exists nowhere. The rule that keeps it legal: **gym publishes, gym never imports.**
Gym emits an achievement (weight X for reps Y on exercise id Z) or exports a paste-grammar tree that
roadmap's already-shipped `paste-import` plants. No product-to-product dependency; the coupling is
the account and the user's own hand.

Roadmap is the plan you set, journal is the day you noticed, gym is the rep you did.

## The plan

Ordered for shipping. Each bet is a node in `t_9362d9bc883e0a1e`; the bet id is the node id.

**Phase 0 — the seam.** Gym has zero backend. This is the honest cost of the first screen.

| bet | what + why | size | deps |
|---|---|---|---|
| `gym-architecture` | `backend/products/gym/ARCHITECTURE.md` before code, on journal's template: what gym owns, what it deliberately does not, the model as annotated SQL, the HTTP table, the wiring, the open decisions. Settles the four things that cost a migration later: exercise ids, session snapshots, set kinds, canonical units. Also settles namespacing — every gym type in `namespace wm::gym`, so `gym::Set` reads right at a call site and bare `Set` reads right inside (journal pays a prefix tax we decline to inherit) | S | — |
| `gym-schema` | One idempotent `-- ── Gym ──` section in `backend/db/schema.sql`: `gym_exercises` (stable ids, **seeded with ~60 movements in the migration**), `gym_routines`, `gym_sessions` (with a plan snapshot), `gym_sets` (canonical kg, reps, kind, rpe, note, `completed_at`, **client idempotency key**). Metadata columns land now though their UI is phase 2 — Lift's lesson is that this is a schema decision, not a feature decision. All date/time work stays in SQL; no C++ calendar code | S | `gym-architecture` |
| `gym-backend-seam` | `windmill_gym` in `backend/CMakeLists.txt` (core always; adapters under the `Drogon_FOUND AND libpqxx_FOUND` guard), `domain/ · ports/ · application/ · adapters/ · routes.{h,cpp}`, `gym::registerRoutes` called from `platform/infra/main.cpp`, tests appended to the **existing** executables (a new binary means editing `backend/Dockerfile`'s target list) | M | `gym-schema` |
| `gym-web-seam` | Replace the `ComingSoon` scaffold: sub-route parsing, `gymApi.js` owning the whole backend conversation (`credentials: 'include'`, a typed `GymError`), `gym.css` scoped to `.gym-root` | S | `gym-backend-seam` |
| `pwa-shell` | **Platform, and overdue.** `web/public/site.webmanifest` declares `display: standalone` and there is no service worker anywhere in `web/` — an installed Windmill in a basement with no signal renders nothing. App-shell cache + install prompt. Gym is the product that makes this non-optional; all three benefit | M | — |

**Phase 1 — a training log a person uses for a week.** The single feature without which none of this
is a training log: **a durable set write bound to an account.** Everything else is optional on top of
that row. Deliberately inverts Lift: **ad-hoc first, routines second** — Lift's "template is the only
entry path" is why you cannot add face pulls without permanently rewriting your program.

| bet | what + why | size | deps |
|---|---|---|---|
| `set-logger` | The product. Pick an exercise, log weight × reps, done — one value at a time on the web. The ladder, sticky carry-forward, tap-to-type (comma parses as decimal), negative weight for band-assisted work, extra sets past target, the completed-set list with wall-clock timestamps. Local-first write with a background flush and a **client-generated idempotency key per set** — a set log is an append-only event stream from one device at a time; there is nothing to converge, so no HLC and no lattice. Workout mode: Wake Lock, no chrome | L | phase 0 |
| `lift-import` | A one-shot JSON export from the Swift app, imported server-side onto seeded catalog ids. Without it gym launches empty: prefill has nothing to prefill from, charts have one point, and no PR can fire during the entire dogfood period. Small, throwaway, and it turns months of real training into the corpus every later bet is tested against | S | `gym-schema` |
| `last-time-prefill` | "Last time: 82.5 × 8, 82.5 × 8, 80 × 7" above the input, weight pre-dialled from it. Lift's single biggest missing mechanism — it never once reads last week to seed today | S | `set-logger`, `lift-import` |
| `training-log` | Session list + detail: per-exercise grouping in first-performed order, per-set rows. **Read-only.** The fix-it path is phase 2 | S | `set-logger` |

Cut from phase 1 against the first draft, deliberately: `exercise-catalog` as a screen (the identity
decision is a `gym-schema` column and a seeded list; search/create/merge follows the logger — a
taxonomy screen with nothing to log into is not a first artifact), `unit-preference` (canonical kg at
rest is already a schema decision; a second untested lb ladder doubles the surface of the one thing
that must be perfect, and the named user is not American), and `session-resume` as a bet (it becomes
a domain rule: an open session with no set in N hours auto-closes at its last set's timestamp —
Lift's three-way recovery UX existed to survive a device-local store that server-as-truth deletes).

**Phase 2 — the fix-it path, the plan, and the public face.**

| bet | what + why | size | deps |
|---|---|---|---|
| `set-kinds` | Warmup / working / drop / failure, RPE, per-set note. Ships **before** anything aggregates, because a warmup must not count toward volume and because assisted work logs negative weight — `volume = weight × reps` makes that −200 and silently subtracts from every total. The volume contribution of a set kind is a domain decision, not a formatter bug | S | `set-logger` |
| `log-editing` | Edit a set, delete with renumbering so history shows no hole, add a missed set cloned from the last. Edits go through a draft and commit on save — Lift binds text fields straight to the persisted model, so Done is decorative and there is no Cancel | S | `training-log` |
| `rest-timer` | A rest target with a countdown and a Notification-API alert, reset on exercise switch. Lift's counts up forever, has no target, no alert, and never resets | S | `set-logger` |
| `routines` | Named ordered exercise lists to start a session from, duplicate, reorder. The session **snapshots the plan** at start; mid-session changes are session-scoped with an optional "save to routine". For the named user, the prefill that matters is what the program says today, not what last week said | M | `log-editing` |
| `pr-line` | e1RM (Epley, `weight × (1 + reps/30)` — already in Lift's coach tool output and never once shown to a user) plus PR detection and a "vs last time" line on the finish screen. The words "PR", "streak" and "record" appear nowhere in Lift's codebase | S | `set-kinds` |
| `gym-mcp` | **The wedge.** Gym's tools on `windmill.works/mcp`: read the log, read progression, propose a routine change as a typed diff the user applies. Needs a platform bet first — `McpServer` binds exactly one `ToolHost` (`McpServer.h:39`) and `main.cpp` binds roadmap's — and the right shape is a **scoped** composite, where the client's grant selects which products' tools it sees, not a flat union that regresses every roadmap user's `tools/list` right after we fought to shrink it | M | platform scoped ToolHost |
| `gym-landing` | Flip the Gym card in `BrandLanding.jsx` from `live: false` and add the static product page on journal's template. Not before the product behind it is true | S | `pr-line` |
| `gym-export` | A `GymDataSection` registered through `gymRoutes.settingsSections.data` — CSV of every set. `SettingsPage.jsx` already composes product sections, so this needs zero platform work. A multi-year artifact with no way out has no trust argument | S | `training-log` |

**Phase 3 — behind a measured gate.** `progress-charts` (one chart: per-exercise e1RM + volume, no
scrub — charts serve week four, and the craft in Lift's scrub/annotation/tooltip work is a later
polish bet if retention ever justifies it) · `plan-vs-actual` (adherence against the snapshot;
impossible in Lift by construction) · `strength-tree` (the brand bet: gym publishes achievements,
roadmap plants them — designed once, never a product import) · `gym-nudge` ("you usually train
Tuesday") · `gym-native-shell` (Live Activity, Dynamic Island, App Intents, haptics — parked until a
native surface exists, named so the single-value model stays a constraint rather than an accident).

**Two platform bets gym depends on and does not own.** Both are promotions, not copies — the second
consumer earns the abstraction and we are at the third:

- **A shared sweep primitive.** Roadmap's reminder engine and journal's `NudgeSweep` are already two
  implementations of one skeleton (heartbeat, decide/claim/send, PK mutex, allowlist, suppression).
  The second build found 13 defects. `gym-nudge` must not be a third copy: the sequence belongs on a
  platform base with a product-supplied `decide()` and `render()`, journal refactored onto it as the
  proving move.
- ~~**`PAID_PLANS_OPEN` must leave roadmap.**~~ **DONE (`97e1f1b`), and better than asked.** The
  constant no longer exists anywhere in `web/`; the predicate is `paidPlansOpen()` in
  `web/src/shell/billing/checkout.js`, beside `EntitlementsProvider.jsx` exactly as specified. The
  improvement on the brief: the gate moved *up* from inside the component's render to the registry
  (`products/roadmap/routes.js`), so while plans are shut `PlanSection` is never mounted — no chunk
  fetched, no subscription read. **Gym monetization is no longer blocked by this.** The residual
  edge is smaller and is recorded in `STRUCTURE.md`: `PLAN_COPY`, the tier vocabulary for the one
  brand-wide subscription, is still in roadmap's settings folder. The second consumer earns that
  move; today there is none.

## What the canon filed back at us (2026-08-01)

The gym design board carries a card titled *"Where I think the briefs are wrong."* A designer who
argues with the brief is doing the job; these are decisions to take, not things to code around.
Recorded here because a scratchpad does not survive the session.

- **Bodyweight lifts have no honest number — a schema gap, and `pr-line` depends on it.** Chin-ups
  log at 0 kg, so Epley is undefined; the design already handles it in words ("bodyweight — no
  e1RM") rather than showing a confident wrong number. But *"without a bodyweight field on the
  account, a third of this user's sets can never be compared."* Note the tension with our own plan:
  body weight is **parked** until the set logger is boring. Both stand — the park is a product
  decision, this is its cost, and `pr-line` is where it gets paid. If it returns it is a time series
  (bodyweight moves) plus a per-exercise *bodyweight-loadable* flag, not an account field.
- **"A four-hour auto-close will eat real sessions" — checked, and it does not.** The finding
  assumes a session-length cap; `autoCloseAt` measures from **last activity**, so a two-hour squat
  session with ten-minute rests has a ten-minute idle and never trips it. Tripping it takes four
  hours of silence between sets, which is an abandoned session by any reading. **No setting is
  needed**, and this is written down so nobody builds the dial the finding asked for.
- **The copy promises what phase 0 cannot do.** The drawn delete sheet and its toast say *Trash,
  recoverable for 30 days in Settings*, and the draft editor assumes update/delete for sets and
  sessions — the phase-0 contract is POST-only. This is a mission line, not a nit: no copy that
  promises what the product doesn't do. `log-editing` either builds the endpoints and the trash, or
  the copy changes before it ships. It must not ship as drawn.
- **The plan wins the prefill — a deliberate deviation from G1**, flagged as such by the designer:
  plan snapshot → else last time → else 20 kg, *and last time is never hidden*. The brief said dial
  in last time; a lifter on a written program wants what the program says today. The compensation is
  part of the deal.
- **Reps needed typing** — the brief asked the question, the canon answered it: an AMRAP of 14 is
  twelve taps on +1 and two on a keypad.
- **Comparison is top-set e1RM, never volume** — *"volume says four light sets beat three heavy
  ones."* Up is olive, down is plain ink, never red.
- **Two filed at the platform rather than at gym:** the daylight skin is *demonstrated, not proven*
  until the shell owns theme scope (until then no gym template may read a brand semantic directly —
  always through a gym-named token restated in both skins); and re-pointing a brand hue onto olive
  would make "the accent" and "logged" the same colour, *"silently deleting the distinction the log
  depends on."*

## Metric contract

A training log's activation is not a roadmap's. Roadmap activates on planting something; gym
activates on **coming back**. One logged session is a trial, not a habit.

- **The dogfood gate (phases 0–2, the only one that can actually run).** Every population metric
  below is unmeasurable at N≈1 for months, and the working agreement is dogfood-driven. The gate:
  **the author logs 8 consecutive training sessions on gym without opening Lift or a spreadsheet, and
  the prefill is right on set one in at least 6 of the 8.** If that fails, no amount of charts saves it.
- **Activation** (post-`gym-landing`) — an activated lifter logs **≥2 sessions of ≥5 sets within 7
  days of their first set**. Instrumented on `web/src/telemetry/beacon.js` from the first
  `set-logger` commit, never retrofitted.
- **The prefill number** — share of logged sets where the weight was accepted **unchanged, or changed
  by exactly one ladder step in the progression direction**. The naive version (unchanged only) is
  backwards: a lifter running linear progression *should* add 2.5 kg every session, so a healthy
  lifter would score near zero and a stalled one would score 100%. What we are measuring is "the
  number was right, or one tap away."

  > **Open conflict this metric depends on (consistency ledger 0d).** The ladder inherited from Lift
  > offers no ±2.5 step at any load — at 100 kg it gives ±5/±10 — while the named user's program
  > step *is* +2.5 kg. So a healthy lifter's most common action isn't one ladder step, and the
  > metric above cannot be measured as written.
  >
  > The resolution, and why it is ours to take: **Lift's load-adaptive tiers are a workaround for
  > not having exercise identity.** With only free-text names it could not know whether you were
  > holding a barbell or a dumbbell, so it guessed the plausible step from the load. Gym knows —
  > `gym_exercises.step_kg` is seeded per movement (2.5 barbell, 2.0 dumbbell, 5.0 machine/stack,
  > 4.0 kettlebell) and already ships. So the **small step should come from the exercise** and the
  > load-adaptive tier should supply only the **large** step, which is for warm-up ramping. At
  > 100 kg on a bar that reads −2.5 / −10 / +2.5 / +10: the program step under the thumb, the big
  > jumps still there. Not built — `set-logger` builds the canon ladder as drawn, because canon
  > wins over a suggestion of mine, and the ladder lives in one module so this is a one-file change.
  > Decide it on dogfood evidence, then fix canon and the ledger together.
- **Retention** — W1 and W4 return, plus **sessions per active week** (a lifter trains 3–5× a week or
  the product isn't working).
- **Correction rate** — share of sessions edited after finishing. Meaningful only from `log-editing`;
  before that it is structurally zero and will look perfect for the wrong reason.
- **Monetization — no gym-specific axis.** Gym contributes surfaces to the one Windmill One funnel
  and sets no price. What gets measured is MCP connect → first agent read → retained connection. No
  gym bet's success is defined by revenue this cycle.

Numeric targets get set one week after `set-logger` and the beacon produce real data.

**Gym's kill rule.** If the dogfood gate fails twice — the author will not use it for eight sessions
without falling back — gym is not the third product, and the work stops at phase 2 with the log as a
personal tool. Every phase-3 bet names its own kill rule when it starts.

## Cut, retired, parked

- **An in-app coach chat — RETIRED, THEN REVERSED (`gym-coach`, 2026-08-06).** The ruling was
  roadmap's `llm-generator` ruling applied to gym: the MCP server is the agent path, so no tool loop
  and no token bill. The owner asked for the panel anyway, and the resolution is that the panel and
  the MCP server are **one system with two doors** rather than two systems — the same fifteen tools,
  the same LogService, the same grant model, reachable either from the lifter's own Claude or from a
  panel for someone who has no agent. So gym does ship a second tool loop
  (`gym/adapters/llm/AnthropicCoach`, a sibling of roadmap's rather than a lift of it — a *third*
  consumer is what would earn promoting the shape into platform). What did not come back: streaming,
  proposal chrome, and any chat not attached to one workout that already happened. The bounds it
  ships under are read-only scope, one session, six iterations, Windmill One, and absent-when-unkeyed.
- **BYO API keys, the four-provider picker, on-device inference — cut permanently.** They exist in
  Lift only because the hosted tier didn't. The abstraction spanned a ~4k on-device window and a 200k
  hosted one, and the panel that came back is hosted-only on one model we choose, so the reason is
  still gone. (Every model id Lift ships is fabricated and 404s.)
- **StoreKit, IAP, trial mechanics — cut.** Paddle is the rail.
- **Supersets, circuits, EMOM/AMRAP — cut from v1.** Grouping is a modelling decision worth making
  once, on evidence.
- **Cardio, distance, duration, bodyweight-only movements — cut.** Strictly weight × reps. A plank
  logs as 0 kg and contributes nothing; a second measurement axis is a different product.
- **Body weight, measurements, progress photos — parked** until the set logger is boring.
- **Muscle-group volume — cut, and its taxonomy refused.** Lift's is lopsided (one `legs` bucket
  against biceps/triceps/forearms, so quads vs hamstrings is unrepresentable), double-counts by
  construction (a bench set credits its full volume to chest *and* triceps, pinned by its own test),
  is all-time only, and reads attribution from *live* templates so deleting a program erases history's
  tags. If it returns, tags live on the catalog, weighted primary/secondary, windowed.
- **Streaks — cut**, exactly as roadmap cut them. `pr-line` is the celebration that earns its place.
- **Plate calculator, bar weight, warm-up generator, microplates — cut.** Revisit on the correction
  rate.
- **Ambient sound — cut**, with two functional exceptions that are not decoration: the set-saved
  confirmation and the rest-done alert.
- **Social, leaderboards, human coaching — cut.** Same reason roadmap deferred the gallery.
- **Dark chrome — cut at the brand level.** If gym wants a night look it is journal's shape: scoped
  inside `.gym-root`, from canon, never touching the global theme.
- **Message-count context truncation — refused.** Lift's last-50-*messages* window can split a
  `tool_use` from its `tool_result`. Moot without an in-app coach; recorded so it is never rebuilt.
- **One-gesture destruction — refused as a pattern.** Lift will delete an entire training program on
  a full swipe with no confirm and no undo.

## Risks carried

- ~~**Gym is a README and a placeholder.**~~ **Retired 2026-08-06.** Phase 0 and phase 1 shipped
  (`windmill_gym`, six `gym_*` tables, twenty routes), and the 2026-08-06 wave took the decided
  design across all three surfaces: routines and the server-frozen plan snapshot, start-from-a-routine,
  the mid-session save-to-routine, the finish screen with its record rule and its comparison, discard,
  a warmup that can actually be logged, the web's backfill door — and the **iOS room**, which is the
  one that matters, because until it existed no surface owned the open session and the phase-1 dogfood
  gate could not run at all. What remains open is named below and in the tree, not here.
- **The dogfood gate is now runnable and has not been run.** Eight consecutive real sessions on the
  phone without falling back to Lift, prefill right on set one in at least six. Every claim about
  whether gym is good is unearned until that happens; the wave that unblocked it did not run it.
- **Section D has no surface and the landing already sells it.** `gym-mcp` waits on the platform
  scoped-composite ToolHost, so the connected log — the product's whole paid thesis — is drawn in the
  design and absent from the build. `/gym` is pre-open and says so, but `marketing/GymLanding.jsx`
  states the capability in the present tense ("Works with Claude Desktop…"), which stops being
  honest on the day gym opens. Either that section moves to the future tense or gym does not open
  without it.
- **Exercise identity is the bug we must not inherit.** Root of Lift's mid-workout crash, its
  duplicate-name collapse, its rename-forks-history behaviour, and its coach's exact-string failures.
  It costs one column now and a migration across every set ever logged later.
- **Negative weight poisons volume.** −20 kg assisted × 10 reps is −200 in `weight × reps`, silently
  subtracting from totals, charts and trends. Assigned explicitly to `set-kinds`.
- **An approved proposal is one transaction.** Lift's `ProposalService.apply` is name-keyed and
  sequential, and one commit fixed rows that were assigned to a relationship but never inserted — an
  approved change could silently not persist. Its mock could not reproduce it because the fake didn't
  model the persistence boundary. Gym's fakes apply the **same rule** as the SQL, the way
  `backend/test/products/journal/Fakes.h` does.
- **Session creation must be idempotent.** A double-tapped Start in Lift minted a phantom session
  that polluted history and analytics until a `guard !isActive` was added. `POST /v1/gym/sessions`
  cannot mint a second session on a retry — which is also why every set write carries a client key.
- **A green suite is not evidence.** Lift's has been red for ~10 commits and nobody noticed: a test
  still asserts a clamp deliberately deleted in `0730f4b`. Its riskiest layers have zero tests.
- **Client-side cache invalidation.** Lift keys chart caches on `sessions.count`, so editing a past
  session leaves every chart wrong. Invalidate on a data version, never a collection length.
- **UI hazards banked from Lift's dogfood wave.** Reserve space for optional chrome rather than
  conditionally mounting it (a target capsule at `.opacity(0/1)` still jumps the header); scrub
  selection is sticky with a separate dismiss gesture; a floating primary action needs bottom scroll
  padding; never call a trend computation from inside a view body on the screen users land on.
- **Silent failure is Lift's house style and must not be ours.** Intents no-op when a singleton is
  nil, Live Activity failures go to `print`, save failures go to OSLog, a template-less resume deletes
  logged sets without a word. Lift filed `structured-error-handling` and never built it. Gym's
  user-visible error surface is defined in `gym-architecture`, before the first handler.
- **The magic-link return path lands on roadmap.** `activeProduct('#/auth')` matches no `switchHash`
  and falls back to `PRODUCTS[0]`, so a lifter signing in from gym lands on the skill tree.
- **CI gotchas that bite a training log specifically.** `pqxx::result[i]` is `row_ref` on macOS and
  `row` on CI Linux — every mapper is `template <typename Row>`. **All date/time work stays in
  Postgres**; gym is dates everywhere. jsoncpp writes an infinity no parser reads back. A green local
  build is not green CI: watch `gh run list` after every backend push, then probe prod.
