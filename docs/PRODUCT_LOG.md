# Windmill — Product Log

The product strategy: what the three products are, what each sells, what is measured, what is
refused. The **bet ledger lives in the dogfood tree** (`t_9362d9bc883e0a1e`, via the windmill MCP):
the bet id is the node id, and progress is tracked there, never here.

Roadmap is the plan you set, journal is the day you noticed, gym is the rep you did. Journal's
design lives in `backend/products/journal/ARCHITECTURE.md`; gym's is the second half of this file.

## The paid line

Windmill One is one predicate, `Entitlements::hasWindmillOne`
(`backend/platform/application/Entitlements.h`). Nothing is on sale: `paidPlansOpen()`
(`web/src/shell/billing/checkout.js`) returns `false`, and `BillingApi` 503s a checkout with no
Paddle price id configured. Where the predicate is read:

| surface | what the plan changes |
|---|---|
| journal Talk (`VoiceApi.cpp`) | hard refusal |
| journal echoes (`EchoApi.cpp`) | passage truncated to eight words, never refused |
| roadmap tending (`TendingService.cpp`) | monthly run allowance; the feature is off unless `TENDING_ENABLED` is set |
| gym Ask (`AskService.cpp`) | nothing — the only read is `aiAllowanceFor`, the monthly AI spend ceiling |

Products do not define their own paid axis; they contribute surfaces to the one Windmill One
funnel. No bet's success is defined by revenue this cycle.

---

# Roadmap

## Thesis

Make the front door honest, measure it, then amplify.

1. **Truth before traffic.** No surface promises what the product does not do; honest copy is also
   the prerequisite for un-poisoned metrics.
2. **Measure before optimizing.** No amplification bet ships without a gate it can fail.
3. **Loops before amplification.** Close the k-loop's edges (artifact → URL → fork → claim) before
   buying reach; ship retention's substrate before nudging anyone by email.
4. **The craft is the moat.** The derived unlock cascade and the ceremony system are the
   differentiator; funnel machinery is not.

## Metric contract

- **Activation** — an activated visitor plants a tree with **≥3 nodes** and marks a **first
  completion within 48h**. Measured land → birth → activated. A one-bud tree is not activation.
- **Virality** — `?ref`-attributed share-link visits → fork attempts → claimed forks per shared
  artifact. k is not real until measured end-to-end.
- **Retention** — W1 return rate; post-reminder 48h re-activation; guardrail: share of qualifying
  weeks correctly suppressed.
- **Monetization** — unmeasured, because nothing is on sale.

Numeric targets get set one week after real funnel data exists. Each amplification bet names its
kill rule when it starts.

## Open

- `ops-guardrails` — offsite backups plus a restore drill (owner/infra-gated).
- `feedback-door` — a way to hear from users; park until near launch.
- Submit `windmill.works/mcp` to MCP registries (owner action; code and public page are ready).
- `email-deliverability` — SPF/DKIM/DMARC and stream separation, before any new recurring send.
- `og-tree-cards` · `milestone-share-beat` · `return-recap` · `launch-moment`, each behind a
  measured gate.
- `sync-scale-out` — a tripwire with a designed fix, pulled forward on load.

## Cut, retired, parked

- **In-app LLM goal-to-quest generator — retired.** The OAuth'd MCP server is the agent path; the
  quests are authored, and paste-import escalates to a model only to feed the one parser.
- **Team seats — cut.** They smuggle in a roles/authz surface.
- **Streaks — cut.** Decoration on a return visit; `progress-timestamps` make it cheap later.
- **Dark app chrome — cut.** Share exports already cover dark feeds; the brand is light-only.
- **Short links, embeds, README badges, social auto-posting, paid acquisition — cut.**
  Amplification ahead of a working loop.
- **⌘K search — cut.** Bites only at a tree scale the funnel has not produced.

## Risks carried

- **A device must not remember whoever used it last.** Anything the device holds needs a seat in its
  key or on its row; sign-out is not the only moment an account changes.
- **Per-IP limits key on `CF-Connecting-IP`**, which is trustworthy only while the origin refuses
  non-Cloudflare traffic. Check that edge rule with `caddy adapt`; an edge rule nobody has seen fire
  is not a control.
- **Unbounded compute on one shared process.** Analysis runs synchronously on a request thread with
  no queue, timeout or per-account quota, so the next expensive read invents the problem again.
- **Email deliverability is an activation risk.** Magic link is the only sign-in and carries
  fork/claim tokens.
- **Cross-browser claim hazard.** Anonymous-tree claim assumes the magic link opens in the browser
  holding IndexedDB; fork-claim is solved server-side, anon-tree claim still needs a same-browser
  fallback.
- **Single-instance collab core.** A successful launch cannot be absorbed by adding replicas.
- **WebGL2-only rendering sheds unknown visitors.** Render-init failures are logged; a fallback is a
  later call made on data.
- **Brand collision.** "Windmill" is an established dev-tools brand (windmill.dev) aimed at the same
  developer audience; a naming decision is cheapest pre-launch.
- **roadmap.sh content is CC-BY-SA.** Attribution ships on-surface with the quests.

## Reminders — send rules

The email footer promises, verbatim:

> You get this once a week, only while a tree has steps ready.
> Pause reminders · Manage in settings

The rules that make that line literally true:

- **Eligibility** — an account with a verified email and reminders enabled. Signed-out and
  local-only users get nothing.
- **Slot** — one fixed weekly slot per account, in the user's timezone, adjustable; at most one send
  per 7 days, enforced by the primary key of `reminder_week`, never by comparing timestamps at read
  time. A skipped week resumes at the following week's slot.
- **Gate** — send only if ≥1 tree has a non-empty ready set (nodes deriving to `available`, not
  complete). Nothing ready, nothing sent, silently. Skip if the user was active within 3 days, and
  for the account's first 7 days. A permanent bounce or a spam complaint suppresses; a transient
  bounce must not.
- **Arming** — every send passes `MailArming`: off means nobody, on means only the allowlist, and
  an empty allowlist is nobody. It is read at send time, never at decide time, so the ledger keeps
  recording while nobody can receive anything.
- **Content** — one email per user, featuring the most recently active tree with ready steps: at
  most 3 ready steps plus a mini tree visual, deep-linked to that tree's frontier; other qualifying
  trees are a quiet "+N more ready."
- **Controls** — Pause is one click via a signed token with no login and pauses all; settings carry
  enable/disable, weekday, time and timezone, and pause/resume. Reminders only, never transactional
  auth mail. Clearing a suppression is the owner turning reminders on again — `enabled` is never
  edited on their behalf.

---

# Gym — the third product

## Who this is for

A lifter who follows a written program — barbell-shaped, 3–5 sessions a week, the same movements for
months, weight going up in small steps. Not a class-goer, not a runner, not a beginner looking for
guidance. Every cut below follows from this.

## Thesis

**Your training log is an endpoint your own agent can use** — not a fifth in-app chatbot. Gym's
tools ride the OAuth 2.1 MCP server at `windmill.works/mcp` beside roadmap's, filtered per
connection by the grant its credential holds — read, write and delete per product, approved one at
a time, and a level nobody approved is a tool the connection cannot see. **Ask** is the same engine
behind a second door, for a lifter with no agent of their own.

Gym gates nothing on the plan: the connected log is free, Ask is free behind a stated cap, and no
surface may sell the connected log.

**The write split is the whole MCP contract.** Recording something that already happened lands
immediately — a set, a workout starting or finishing, a movement, a new day of the program — because
the lifter is using the agent as a transcription device and the consequence is visible in the room
within seconds. Changing a day of the program that already stands lands nothing: it mints a typed
field-level proposal that sits in the app until the lifter reads it and taps Apply. No tool applies
one at any grant level. `gym:delete` buys the right to propose a destructive change, never to make
one.

Two standing rules behind all of it: **the log must survive the gym and the phone** — a multi-year
artifact nobody can regenerate, which is why server-as-truth is the reason gym lives here — and
**one tap is the product**: the ladder, sticky carry-forward, last-time prefill. The craft is the
number being right before you touch it.

**The strength graph is gym's craft bet.** Strength progression is a prerequisite graph — bodyweight
dip unlocks weighted dip unlocks muscle-up. The rule that keeps it legal: **gym publishes, gym never
imports.** Gym emits an achievement, or exports a paste-grammar tree that roadmap's `paste-import`
plants. No product-to-product dependency; the coupling is the account and the user's own hand.

## What gym gets from the platform

Gym writes none of this. Accounts, sessions, sign-in, device revoke and account close
(`platform/application/AuthService.h`); the trust boundary `callerUserOf`
(`platform/adapters/http/Caller.h`), every handler's first two lines; billing and entitlements; the
settings registry that composes each product's sections (`web/src/shell/settings/SettingsPage.jsx`);
one `ResendClient` under a product-owned port and the mail sweep skeleton (heartbeat,
decide/claim/send, PK mutex, allowlist, suppression) with products filling in `decide()` and
`render()`; telemetry, the error ledger, CORS, the rate limiter, the Postgres pool, the design
system. The seam is one `gym::registerRoutes(app, GymDeps&)` call.

## Open

- `progress-charts` — one chart, per-exercise e1RM and volume, no scrub.
- `plan-vs-actual` — adherence against the session's frozen plan snapshot.
- `strength-tree` — the brand bet above.
- `gym-nudge` — "you usually train Tuesday", on the platform sweep.
- `gym-native-shell` — Live Activity, Dynamic Island, App Intents, haptics.
- The connect surface for a lifter with no agent of their own.
- Bodyweight lifts have no honest number: chin-ups log at 0 kg, so e1RM is undefined and the design
  says "bodyweight — no e1RM". If body weight returns it is a time series plus a per-exercise
  bodyweight-loadable flag, never an account field.

## Metric contract

A training log activates on **coming back**. One logged session is a trial, not a habit.

- **The dogfood gate (the only metric that can run at N≈1).** The author logs 8 consecutive training
  sessions on gym without falling back, and the prefill is right on set one in at least 6 of the 8.
- **Activation** — a lifter logs **≥2 sessions of ≥5 sets within 7 days of their first set**,
  instrumented on `web/src/telemetry/beacon.js`.
- **The prefill number** — share of logged sets where the weight was accepted unchanged, or changed
  by exactly one ladder step in the progression direction. "Unchanged only" is backwards: a lifter
  running linear progression *should* add a step every session.
- **Retention** — W1 and W4 return, plus sessions per active week.
- **Correction rate** — share of sessions edited after finishing.
- **Monetization** — no gym-specific axis. What gets measured is MCP connect → first agent read →
  retained connection.

**Kill rule.** If the dogfood gate fails twice, gym is not the third product and the work stops with
the log as a personal tool. Every later bet names its own kill rule when it starts.

## Product invariants

The wire and storage contract is `backend/products/gym/ARCHITECTURE.md`; these are the product
decisions behind it.

- An exercise is a stable catalog id, never a display string. Renaming a movement must not fork its
  history, and two entries of the same movement in one routine must not collapse into each other.
- Loads are kg and negative is legal (band-assisted work). Only **working** sets count toward
  volume, records or anything else — a warmup counts for nothing, and negative weight must never
  subtract from a total.
- A session's plan snapshot is frozen at start; editing a routine never rewrites what the log says
  you did.
- An open session with no set in four hours auto-closes at its last set's timestamp. The window
  measures idle time, not session length, so no setting is needed.
- The ladder is a pure function of the weight, pinned by `packages/api-contract/gym-ladder.json` and
  run as a test by web, iOS and Android: ±1/±2.5 under 20 kg, ±2.5/±5 under 50, ±2.5/±10 above,
  down-steps evaluated at `weight − 0.01` so stepping down from exactly 20 kg lands on 19. The fine
  step is the program step; the coarse step is a plate change.
- Prefill order: plan snapshot → last time → 20 kg, and last time is never hidden.
- Comparison is top-set e1RM (Epley, `weight × (1 + reps/30)`), never volume.
- Errors are user-visible. No silent no-op, no failure that only reaches a log line.
- No destructive gesture without a confirm and an undo.
- Invalidate client caches on a data version, never on a collection length.
- Never truncate model context by message count: it can split a `tool_use` from its `tool_result`.

## Cut, retired, parked

- **BYO API keys, provider pickers, on-device inference — cut.** Ask is hosted-only, on one model we
  choose.
- **StoreKit and IAP — cut.** Paddle is the rail.
- **Supersets, circuits, EMOM/AMRAP — cut.** Grouping is a modelling decision worth making once, on
  evidence.
- **Cardio, distance, duration, bodyweight-only movements — cut.** Strictly weight × reps; a plank
  logs 0 kg and contributes nothing.
- **Body weight, measurements, progress photos — parked** until the set logger is boring.
- **Muscle-group volume — cut.** If it returns, tags live on the catalog, weighted
  primary/secondary, windowed — never read from live templates.
- **Streaks — cut.** The PR line is the celebration that earns its place.
- **Plate calculator, bar weight, warm-up generator, microplates — cut.** This product guides a
  program and tracks activity; it does not manage equipment.
- **Ambient sound — cut**, with two functional exceptions: the set-saved confirmation and the
  rest-done alert.
- **Social, leaderboards, human coaching — cut.**
- **Dark chrome — cut at the brand level.** A night look would be scoped inside `.gym-root`, from
  canon, never touching the global theme.
- **Streaming Ask, proposal chrome, and any chat not attached to one workout that already happened —
  cut.**

## Risks carried

- **The dogfood gate has never run.** No claim about whether gym works is earned yet.
- **The magic-link return path lands on roadmap.** `activeProduct('#/auth')` matches no `switchHash`
  and falls back to `PRODUCTS[0]`, so a lifter signing in from gym lands on the skill tree.
- **Fakes must apply the same rules as the SQL.** A double that does not model the persistence
  boundary hides scoping and ordering bugs a green suite will not catch.
- **Take the advisory lock in its own statement before an insert.** Under READ COMMITTED an INSERT
  that both locks and reads `max(set_number)` misses the row it waited for.
- **UI hazards.** Reserve space for optional chrome rather than conditionally mounting it; scrub
  selection is sticky with a separate dismiss gesture; a floating primary action needs bottom scroll
  padding; never call a trend computation from inside a view body.
- **CI gotchas.** `pqxx::result[i]` is `row_ref` on macOS and `row` on CI Linux — every mapper is
  `template <typename Row>`. All date and calendar work stays in Postgres; no C++ calendar function
  is ever consulted. jsoncpp writes an infinity no parser reads back. A green local build is not
  green CI: watch `gh run list` after every backend push, then probe prod.
