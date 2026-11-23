# Echoes on the AI service

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and roadmap nodes can cite
them.

## §0 Status and scope

**Status:** Approved by the owner on 2026-11-17 and built as a repoint (R-5). Echoes derives, on the
server, links between a person's past journal pages
([Echoes](../../backend/products/journal/ECHOES.md)). Its two model calls, one that cuts a page into
passages and one that judges pairings, go to the AI service's text door as the writer's background
work, paid from Windmill's own budgets. The prompts, the schemas, the parsing, the rules of selection
and the queue of pages due are the backend's, as they were before the move. The build order lives in
the Echoes on the AI service roadmap tree, which the dogfood tree (`t_9362d9bc883e0a1e`) opens from
the node `echoes-on-ai-service`.

**Scope:** Echoes' two calls on the [AI service](ai-service.md): the backend as a caller, the pass it
signs for itself, the budgets that pay, what an answer does to the work, and what the backend no
longer does for Echoes.

**Out of scope:** What Echoes shows a person. The embedder, which is Windmill's own sidecar and no
hosted call. The backend's other model callers: roadmap's compose and tending, gym's Coach until it
moves, and the web's Talk. The rework of Echoes the owner plans (R-5).

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

## §2 What moved

| | Where it is |
|---|---|
| Who calls the provider | the AI service |
| Who meters | the AI service, against Windmill's background budgets |
| A slot and a rate | the account's background ones |
| The prompts, the schemas, parsing and the rules of selection | the backend's |
| The queue of pages due | the backend's, as it was before the move (R-5) |
| The embedder | the backend calls Windmill's sidecar |

## §3 What the AI service gains

The AI service's document holds the rule ([AI service §3](ai-service.md#3-tiers), I-6, R-18, R-19):
a call under a pass whose `client` is `server` is background work, admitted under no tier, paid by
a budget for the account and shared budgets across all accounts, under an hourly ceiling below the
fuse, with a slot and rate counters of its own. That change is made in the service's tier table,
ledger, admission and pass rules, with a pass vector for a server pass and for each combination it
refuses.

## §4 The backend as a caller

- **Configured** means the signing key, its key id and the AI service's address are all set
  (`AI_PASS_PRIVATE_SEED`, `AI_PASS_KID`, `AI_SERVICE_URL`). Where any is missing, Echoes' two steps
  are unconfigured: the line-and-sentence rule cuts a page and no curator runs, so no echo is
  derived.
- **The pass.** The backend signs a pass in its own process for the account whose page is being
  derived: `client` `server`, the account as `sub`, `plan` `none`, nothing else
  (`AiPasses::serverPass`). The pass door cannot reach that method: its request refuses `server`. The
  client keeps an account's pass for half its lifetime. A call refused `pass_expired` is signed for
  again and asked once more.
- **The call.** `PUT /v1/calls/{callId}/text?label=echoes`, on the service's public listener at its
  address inside the deployment (`http://ai:8084`), not through the proxy, under a fresh `callId`. The
  request carries the step's prompt as `system`, the page as one user message, the step's schema as
  `output.schema`, the class `medium` and effort `low`.
- **Cache** is off for both steps.
- **The output cap.** `maxTokens` is 16,000, and the request names no `minTokens`.
- **The answer** is read to `ended` or `failed`, past the service's heartbeats. The client connects
  within 5 s, counts a stream silent for 60 s as broken, and gives up 660 s after the call began,
  past the service's own 600 s. A stream that breaks before its end, or a request that connected to
  nothing, is asked once more under the same `callId` and body; a second break is no answer.
- **One at a time.** The service's background slot holds one Echoes call in flight an account,
  across processes; a second is refused `concurrency_exhausted` and its page is deferred.
- **Stopping.** In the repair pass, a refusal of the account's own budget, slot or rate ends that
  account's part of the pass; a refusal that is the service's own, no answer, a refused pass or an
  answer no background call should get ends the whole pass (§5). A page the pass did not ask stays due
  with no attempt counted. A live derivation is one saved page and stops nothing past it.
- **A call in flight when the process ends** is lost with the process. Its page stays due and is
  asked again under a new `callId` on a later pass (R-5).
- **The operator's explain route** signs for the account of the operator who calls it and draws on
  that account's background budget.

- **INV-1.** The backend makes no Echoes call to a provider, and holds no provider key for it.
- **INV-2.** Within one call, an answer the stream lost is asked for under the same `callId`, so the
  service answers it without a second charge while it still holds it; and no answer is applied to a
  page other than the one it was asked about.

## §5 What an answer does to the work

| The service says | The page | The pass | Told to Sentry |
|---|---|---|---|
| `ended` `completed` | the answer is parsed and validated | goes on | |
| `ended` `declined` | refused: settled, and only an edit or a version change reopens it | goes on | |
| `ended` `truncated`; `failed` `provider_failed` or `provider_rejected`; `invalid_request`, `too_large`, `conflict`; an answer the backend cannot read | unsettled; an attempt is counted | goes on | yes |
| `result_gone` or `call_unknown`, when a stream that broke is asked again: the service restarted, or the answer outlived its linger | deferred; the next pass asks under a new `callId` | goes on | |
| `subject_exhausted`, `concurrency_exhausted`, `rate_limited`: the account's | deferred | the account's part ends | |
| `background_exhausted`, `busy`, `paused`, `accounting_unavailable`, `provider_unavailable`; no answer from the service | deferred | ends | |
| any `pass_` code, `pass_expired` once it has been signed for again | deferred | ends | yes, as a refused pass |
| a code no background call should meet: a person's free pool, `funding_required`, any other | deferred | ends | yes, as an unexpected answer |

- *Deferred* leaves the page due and counts no attempt; the queue records it as `budget_limited`.
- The background hour counts what calls in flight hold as well as what they spent, so with about six
  background calls in flight across all accounts a further call is refused `paused`: its page is
  deferred and the repair pass ends.
- **The bound on attempts.** Six unsettled passes in a row stop a page being due when its stamps
  already matched; a page that never settled stays due however many it has.
- Nothing here is told to the person.

## §6 Versions

A page is derived again when the version of a step differs from the one it was derived under, and
that version names the model and effort. The service answers with a class, not a model.

- The backend keeps the model the service serves `medium` from, `claude-sonnet-5`, and the effort
  `low` by hand (`backend/products/journal/adapters/llm/EchoModel.h`), so every version stored before
  the move still matches and nothing is derived again (P-6). Each step's test pins its version string.
- The model is changed by hand, in the change that makes the AI service's tier table serve another
  model for the class. Nothing compares the two automatically.
- A changed model derives every active account's pages again within the background budgets. That
  is Windmill's cost and no person's.

## §7 What a person notices

- A person's AI allowance is not spent by Echoes, so a free account's allowance lasts longer for
  Coach, and a question to Coach is not refused or slowed because Echoes was running.
- When an account's background budget for the month is spent, no new echo is derived for it until
  the next month. Nothing says so. This holds for every plan: a subscriber's Echoes draw on the
  background budget, not on their $7.

## §8 What the backend no longer does for Echoes

- It holds no Anthropic adapter for Echoes and charges no ledger row, fuse or `ai_spend` event for
  its calls; the AI service's call rows under the label `echoes` record them.
- It keeps no passive cap for Echoes.
- The backend's provider key and ledger stay, for the callers §0 names.

## §9 Testing

- **The wire.** The backend's client runs the AI service's fixtures (`packages/api-contract/ai`) as
  a device's client does: its tests play the service on loopback with every text event, terminal and
  refusal the fixtures hold, and `background_exhausted` beside them. A test pins the server pass's
  claims. No test in CI calls the AI service or a provider.
- **The sweep's tests** keep their cases, with the service's words in place of the provider's, and
  run every row of §5 for both steps: the outcome counted, the status and attempts stored, the line's
  outcome and whether Sentry is told.
- **The versions** of both steps are pinned to the strings stored before the move.
- **On a local stack:** a page saved and its echoes derived through the AI service; the service
  stopped, and the page deferred with no attempt counted; an account's background budget spent, and
  the shared one; no log holding a word of a page.

## §10 Observability

- The backend logs one `ai_text_call` line a call: the operation, `echo.segment` or `echo.curate`,
  the label, the outcome or refusal code, how many times it was asked, and the duration. The page's
  `journal.echo.derive` line carries what the answer did and the code, and the pass's
  `journal.echo.sweep` line the code that stopped it, if one did.
- Sentry is told what §5's table marks, once per request: an unsettled page as
  `journal.echo.derive`, a refused pass as `journal.echo.pass_refused`, an unexpected answer as
  `journal.echo.unexpected_answer`. The repair pass is one request; each live derivation is one. A
  deferred page is a log line, never an Issue, unless its cause is the backend's own fault.
- Calls the service has given no answer to for 15 minutes, with none answered between, are reported
  as `ai_service.unreachable`, at most once in five minutes: the service is down or its address is
  wrong. One unanswered call, or a deploy restarting the service, is a log line.
- Nothing logs or reports a page's text, a passage, a pass or a `callId`.
- The AI service's own rows and reports cover cost: its ledger, its ceiling and fuse, and the
  crossings of the shared background budgets.

## §11 Values

| Name | Value | Whose |
|---|---|---|
| `BACKGROUND_MONTH` | $2 an account a UTC calendar month (R-4) | the AI service's tier table |
| The shared background month and day | $30 a UTC calendar month and $3 a UTC day, across accounts (R-4) | the AI service's tier table |
| `BACKGROUND_HOUR` | $1, below the $20 fuse (R-4) | the AI service's tier table |
| Background calls in flight | 1 an account | the AI service's tier table |
| Class and effort | `medium`, `low` | Echoes' |
| `maxTokens` | 16,000, with no `minTokens` | Echoes' |
| Cache | off for both steps | Echoes' |
| A server pass kept | 5 min, half its lifetime | the backend's client |
| Connect, silence, deadline | 5 s, 60 s, 660 s | the backend's client |
| Unanswered before it is reported | 15 min | the backend's client |
| Attempts before a page rests | 6 | Echoes' |

## §12 Gaps

Closed by this build:

- The AI service has budgets of Windmill's own for work nobody waits on: one for each account and
  shared ones across all accounts, under an hourly ceiling below the fuse, with background work
  counted apart from a person's call in flight and rate.
- Echoes spends nothing of a person's allowance.

Left as they were before the move (R-5):

- Any save, a mood alone included, reopens every other page of the account for a new judgement.
- A pass derives an account's due pages oldest first, and an account below the floor of pages under
  which no echo is shown is derived like any other.
- The bound on attempts holds only for a page whose stamps already matched, so a page that never
  settles is paid for on every pass, within the background budgets.
- A call in flight when the process ends is not sent again under its `callId`.
- Nothing measured what Echoes costs an account before the amounts of R-4 were set.

## §13 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | When Echoes moves onto the AI service | Before the iOS release. (2026-11-17) |
| R-2 | Whose budget pays for Echoes | Budgets of Windmill's own, apart from the person's allowance. (2026-11-17) |
| R-3 | Whether Echoes shares a person's call in flight | It does not. Background work has a slot of its own. (2026-11-17) |
| R-4 | The amounts: for one account a month, across all accounts a month and a day, and an hour | $2 an account a UTC calendar month; $30 a month and $3 a day across all accounts; $1 an hour. (2026-11-23) |
| R-5 | What the move changes besides the route | Nothing: the calls are repointed and Echoes' spend path in the backend is deleted, with no measurement, no change to the queue or the bound on attempts, no recovery of a call in flight, the cache off for both steps and no `minTokens`. The owner plans to rework Echoes. (2026-11-23) |
