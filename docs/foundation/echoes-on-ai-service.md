# Echoes on the AI service

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and roadmap nodes can cite
them.

## §0 Status and scope

**Status:** Approved by the owner on 2026-11-17, with the amounts of R-4 still open; nothing is
built. Echoes derives, on the server, links between a person's past journal pages
([Echoes](../../backend/products/journal/ECHOES.md)). Its two model calls, one that cuts a page into
passages and one that judges pairings, are made by the backend with its own provider key and metered
by the backend's ledger against the person's own AI allowance. The build order lives in the Echoes
on the AI service roadmap tree, which the dogfood tree (`t_9362d9bc883e0a1e`) opens from the node
`echoes-on-ai-service`.

**Scope:** Moving those two calls onto the [AI service](ai-service.md): the backend as a caller,
the pass it signs for itself, the budgets that pay, what an answer does to the work, the two
changes to the queue that Windmill's own money asks for, and what retires.

**Out of scope:** What Echoes shows a person. The embedder, which is Windmill's own sidecar and no
hosted call. The backend's other model callers: roadmap's compose and tending, gym's Coach until it
moves, and the web's Talk.

**Depends on:** the AI service's text door, with the background work §3 asks of it; the backend's
pass signer.

## §1 Principles

- **P-1 Nobody waits.** Echoes' calls are work no person is waiting on. A refusal or an unreachable
  service leaves the work due, and nothing is shown to anyone (AI service I-6).
- **P-2 Windmill pays for what nobody asked for.** An Echoes call draws on budgets of Windmill's
  own, never on the person's allowance, and never holds the slot or the rate a person's own
  question needs. (R-2, R-3)
- **P-3 Windmill's spend has a ceiling.** Background work is bounded for one account, across all
  accounts, and by the hour, and it can never stop a person's own calls.
- **P-4 The backend is a caller like any other.** It speaks the AI service's wire, checks itself
  against the same fixtures a device does, and holds no provider key for Echoes.
- **P-5 A call that was paid for is read, and only for the page it was made for.**
- **P-6 The move derives nothing again.** No page is cut or judged a second time because the calls
  changed their route.

## §2 What moves, and what changes

| | Today | After |
|---|---|---|
| Who calls the provider | the backend, with its own key | the AI service |
| Who meters | the backend's ledger, against the person's allowance | the AI service, against Windmill's background budgets |
| A slot and a rate | the person's own | the account's background ones |
| The prompts, the schemas, parsing and the rules of selection | the backend's | the backend's, unchanged |
| The queue of pages due | the backend's | the backend's, with the three changes below |
| The embedder | the backend calls Windmill's sidecar | unchanged |

Because Windmill now pays, the queue spends with more care:

- **A page is judged again only when its proposed pairings changed.** Today any save, a mood alone
  included, reopens every other page of the account for a new judgement.
- **Newest first.** Within a pass the most recent pages are derived first, so a budget that runs
  out has spent itself on what a person wrote last.
- **Nothing is judged for an account below the floor of pages under which no echo is shown.** Its
  pages stay due and are judged when it crosses.

## §3 What the AI service gains

The AI service's document holds the rule ([AI service §3](ai-service.md#3-tiers), I-6, R-18, R-19):
a call under a pass whose `client` is `server` is background work, admitted under no tier, paid by
a budget for the account and shared budgets across all accounts, under an hourly ceiling below the
fuse, with a slot and rate counters of its own. That change is made first, in the service's tier
table, ledger, admission and pass rules, with a pass vector for a server pass and for each
combination it refuses.

## §4 The backend as a caller

- **Configured** means the signing key, its key id and the AI service's address are all set. The
  signer is built apart from the pass door. Where any is missing, Echoes' two steps are
  unconfigured, as they are today without a provider key.
- **The pass.** The backend signs a pass in its own process for the account whose page is being
  derived: `client` `server`, the account as `sub`, `plan` `none`, nothing else. It signs it by a
  method of its own, which the pass door cannot reach, and keeps it in memory for less than its
  lifetime. A call refused `pass_expired` is signed for again and asked once more.
- **The call.** `PUT /v1/calls/{callId}/text?label=echoes`, on the service's public listener at its
  address inside the deployment, not through the proxy. The request carries the step's prompt as
  `system`, the page as one user message, the step's schema as `output.schema`, the class `medium`
  and effort `low`, which are what Echoes runs on today.
- **Cache** is off for cutting a page. For judging it is on only if a measurement shows a pass
  reads more of the cache than it pays to write.
- **The output cap.** `maxTokens` stays 16,000. `minTokens` for a step is the ninety-ninth
  percentile of the output tokens of its completed calls over the 30 days before the move, rounded
  up to a thousand. A call the service admitted under a cap below 16,000 and that ends `truncated`
  leaves the page due and counts no attempt.
- **The answer** is read to `ended` or `failed`, with a short time to connect and a deadline over
  the service's own for a call. A stream that breaks is asked for again under the same `callId`.
- **One at a time.** The backend makes one Echoes call an account at a time. The service's
  background slot holds that across processes.
- **Stopping.** A refusal or failure that is the service's own (§5) ends the whole pass. One that
  names the account ends that account's part of it.

**A call in flight when the process ends.** Before a call is made, the backend writes beside the
page its `callId`, its step, and a digest of the request's bytes.

- When the process starts, before any new call, it sends each such request again under the same
  `callId`. The service answers a call it holds from its first event, admits one it never saw, and
  says when a result is gone, in which case a new `callId` is minted.
- An answer is used only when the digest of the request the page needs now is the one written.
  Otherwise the answer is dropped, since the page has moved, and the step is made anew.
- The operator's explain route keeps nothing and is outside this rule. It signs for the account of
  the operator who calls it and draws on that account's background budget.

- **INV-1.** The backend makes no Echoes call to a provider, and holds no provider key for it.
- **INV-2.** No step of one page is paid for twice because the backend lost an answer the service
  still held, and no answer is applied to a page other than the one it was asked about.

## §5 What an answer does to the work

| The service says | The page | Told to Sentry |
|---|---|---|
| `ended` `completed` | the answer is parsed and validated as today | |
| `ended` `declined` | refused, as a provider's refusal is today | |
| `ended` `truncated` at the full cap; `failed` `provider_failed` | unsettled; an attempt is counted | yes |
| `failed` `provider_rejected`; `invalid_request`, `too_large`, `conflict`; an answer the backend cannot read | unsettled; an attempt is counted | yes |
| `ended` `truncated` under a lowered cap | deferred | |
| `subject_exhausted`, `concurrency_exhausted`, `rate_limited`: the account's | deferred; the account's part of the pass ends | |
| `background_exhausted`, `busy`, `paused`, `accounting_unavailable`, `provider_unavailable`; no answer from the service | deferred; the pass ends | |
| any `pass_` code but one `pass_expired`; a code no background call should meet | deferred; the pass ends | yes |

- *Deferred* is a status of its own: the page stays due and no attempt is counted.
- **The bound on attempts.** Six unsettled passes in a row stop a page being due until its words or
  a version change. Today that holds only for a page whose stamps already matched, so a page that
  fails every time is paid for on every pass; with this build it holds for every page.
- Nothing here is told to the person.

## §6 Versions

A page is derived again when the version of a step differs from the one it was derived under, and
that version names the model and effort. The service answers with a class, not a model.

- The backend keeps a tag for the model and effort its steps run on. At the move it is today's
  value, so every stored version still matches and nothing is derived again (P-6).
- The tag is changed by hand, in the change that makes the AI service's tier table serve another
  model for the class. A check in CI reads both and fails when they disagree.
- A changed tag derives every active account's pages again, newest first, within the background
  budgets. That is Windmill's cost and no person's.

## §7 What a person notices

- A person's AI allowance stops being spent by Echoes, so a free account's allowance lasts longer
  for Coach, and a question to Coach is no longer refused or slowed because Echoes was running.
- When an account's background budget for the month is spent, no new echo is derived for it until
  the next month. Nothing says so. This holds for every plan: a subscriber's Echoes drew on their
  $7 until now and draws on the background budget after.
- A mood changed on a page no longer sets every other page to be judged again.

## §8 What retires

- The backend's Anthropic adapters for Echoes, their use of the backend's ledger and fuse, and the
  usage rows and the `ai_spend` event they wrote. The AI service's call rows under the label
  `echoes` take their place.
- The passive cap of $2 a rolling 30 days, which production does not use, with its code and tests.
- The backend's provider key and ledger stay, for the callers §0 names.
- The lines that say Echoes debits a person's allowance or names Anthropic's adapters, in the
  backend's allowance and observability documents, its rules file, the AI usage review, the Echoes
  document and [Gym Coach on the AI service](gym-coach-on-ai-service.md), are corrected in the
  change that makes each false.

## §9 Testing

- **Measured first.** Before the amounts of §11 are set: from the backend's usage rows, what Echoes
  costs an account a month at the median, the ninetieth and the ninety-ninth percentile, and the
  output tokens of each step. Then again on a copy with the queue's three changes of §2.
- **The wire.** The backend's client runs the AI service's fixtures (`packages/api-contract/ai`),
  as a device's client does, and the pass vectors gain the server pass. Unit tests play the service
  from them. No test in CI calls the AI service or a provider.
- **The sweep's tests** keep their cases, with the service played in place of the provider, and
  gain: every row of §5's table; the bound on attempts for a page that never settled; a call in
  flight when the process ends, for a page unchanged and for one edited meanwhile; a `callId`
  written and never sent; the three changes of §2; the version tag unchanged at the move.
- **On a local stack**, with a played provider: a page saved and its echoes derived through the AI
  service; the service stopped, and the page deferred with no attempt counted; the backend
  restarted mid-call; an account's background budget spent, and the shared one; a person's Coach
  turn admitted and unslowed while an Echoes pass runs. Each checks the ledger's charge and that no
  log holds a word of a page.

## §10 Observability

- The backend logs one line a call: the operation, `echo.segment` or `echo.curate`, the outcome or
  refusal code, and the duration. It reports to Sentry, under the static names the sweep has, what
  §5's table marks. A deferred page is a log line, never an Issue.
- Nothing logs or reports a page's text, a passage, a pass or a `callId`.
- The AI service's own rows and reports cover cost: its ledger, its ceiling and fuse, and the
  crossings of the shared background budgets.

## §11 Values

| Name | Value | Whose |
|---|---|---|
| `BACKGROUND_MONTH` | open (R-4); $2 an account a UTC calendar month until it is set, the passive cap's amount | the AI service's tier table |
| The shared background month and day | open (R-4) | the AI service's tier table |
| `BACKGROUND_HOUR` | open (R-4), below the $20 fuse | the AI service's tier table |
| Background calls in flight | 1 an account | the AI service's tier table |
| Class and effort | `medium`, `low` | Echoes' |
| `maxTokens`, `minTokens` | 16,000; measured (§4) | Echoes' |
| Attempts before a page rests | 6, as today | Echoes' |

## §12 Gaps this build closes

- The backend has no client for the AI service, and its pass signer refuses `client` `server`.
- The AI service has no budget but a person's own, counts background work against the one call a
  free account may have in flight and against the person's rate, and has no ceiling of Windmill's
  for it.
- A page that fails every time is paid for on every pass, and any save sets every other page of
  the account to be judged again.
- [Echoes](../../backend/products/journal/ECHOES.md) said passive spend had an allowance of its
  own; in production it drew on the person's. That document now says so.

## §13 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | When Echoes moves onto the AI service | Before the iOS release. (2026-11-17) |
| R-2 | Whose budget pays for Echoes | Budgets of Windmill's own, apart from the person's allowance. (2026-11-17) |
| R-3 | Whether Echoes shares a person's call in flight | It does not. Background work has a slot of its own. (2026-11-17) |
| R-4 | The amounts: for one account a month, across all accounts a month and a day, and an hour | Open. They are set from the measurement of §9, since nothing shows what Echoes costs an account today. |
