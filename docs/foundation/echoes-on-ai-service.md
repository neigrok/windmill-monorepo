# Echoes on the AI service

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and roadmap nodes can cite
them.

## §0 Status and scope

**Status:** Specified; not approved, and nothing is built. Echoes derives, on the server, links
between a person's past journal pages ([Echoes](../../backend/products/journal/ECHOES.md)). Its
two model calls, one that cuts a page into passages and one that judges pairings, are made by the
backend with its own provider key and metered by the backend's ledger against the person's own AI
allowance. The build order lives in the Echoes on the AI service roadmap tree, which the dogfood
tree (`t_9362d9bc883e0a1e`) opens from the node `echoes-on-ai-service`.

**Scope:** Moving those two calls onto the [AI service](ai-service.md): the backend as a caller,
the pass it signs for itself, the budget that pays, what a refusal does to the work, and what
retires.

**Out of scope:** What Echoes derives and what a person sees, which do not change. The embedder,
which is Windmill's own sidecar and no hosted call. The backend's other model callers: roadmap's
compose and tending, gym's Coach until it moves, and the web's Talk.

**Depends on:** the AI service's text door, with the background budget and slot §3 asks of it; the
backend's pass signer.

## §1 Principles

- **P-1 Nobody waits.** Echoes' calls are work no person is waiting on. A refusal or an unreachable
  service leaves the work due, and nothing is shown to anyone (AI service I-6).
- **P-2 Windmill pays for what nobody asked for.** An Echoes call draws on a budget of Windmill's
  own for that account, never on the person's allowance, and never holds the slot a person's own
  question needs. (R-2, R-3)
- **P-3 The backend is a caller like any other.** It speaks the AI service's wire, checks itself
  against the same fixtures a device does, and holds no provider key for Echoes.
- **P-4 A call that was paid for is read.** A call whose answer the backend lost is asked for
  again, not made again.
- **P-5 The move derives nothing again.** No page is cut or judged a second time because the calls
  changed their route.

## §2 What moves

| | Today | After |
|---|---|---|
| Who calls the provider | the backend, with its own key | the AI service |
| Who meters | the backend's ledger, against the person's allowance | the AI service, against the account's background budget |
| A slot | one of the person's calls in flight | the account's background slot |
| The prompts, the schemas, parsing and the rules of selection | the backend's | the backend's, unchanged |
| The queue of pages due | the backend's | the backend's, unchanged |
| The embedder | the backend calls Windmill's sidecar | unchanged |

## §3 What the AI service gains

A change to the AI service's document, its tier table and its code, made first.

- **Background work.** A call under a pass whose `client` is `server` is background work. It is
  funded from the account's *background budget* and nothing else: not the person's allowance, not
  a grant, not the shared free pools. It counts toward the account's *background calls in flight*,
  and not toward the calls a person may have in flight.
- **The background row** of the tier table holds, for every account whatever its plan: the
  budget, `BACKGROUND_MONTH`, a UTC calendar month; calls in flight, 1; the calls started a minute;
  the text classes served; and the output ceiling of a call. It has no transcription.
- An exhausted background budget refuses as `subject_exhausted`. A person's
  `GET /v1/allowance` says nothing of it.
- Only the backend can sign such a pass: the pass door refuses that `client` to every outside
  caller.
- The hourly fuse and the process's own limits cover background calls as they cover every call.

## §4 The backend as a caller

- **The pass.** The backend signs a pass in its own process for the account whose page is being
  derived, with `client` `server`, and keeps it in memory for less than its lifetime. Its signer
  refuses that `client` today. Where the signing key is not configured, Echoes' two steps are
  unconfigured, as they are today without a provider key.
- **The call.** `PUT /v1/calls/{callId}/text?label=echoes`, on the service's address inside the
  deployment, not through the public proxy. The request carries the step's prompt as `system`, the
  page as one user message, the step's schema as `output.schema`, the class `medium`, effort `low`
  and `cache` true: the model and effort Echoes runs on today.
- **The output cap.** `maxTokens` stays 16,000. `minTokens` is the smallest cap under which the
  step has completed in production, measured from the backend's usage rows before the move, so a
  budget that is nearly spent still admits a call.
- **The answer** is read to `ended` or `failed`. A stream that breaks is asked for again under the
  same `callId`, as the [Coach engine](coach-engine.md) §4.2 says of a device.
- **A call in flight when the process ends.** Before a call is made, its `callId` is written beside
  the page's derivation state. A later pass that finds one reads its result while the service still
  holds it, and makes no new call for that step until it has answered or the result is gone.
- **One at a time.** The backend makes one Echoes call an account at a time, across its live pass,
  its repair pass and the operator's explain route.

- **INV-1.** The backend makes no Echoes call to a provider, and holds no provider key for it.
- **INV-2.** No step of one page is paid for twice because the backend lost an answer the service
  still held.

## §5 What an answer does to the work

| The service says | The page |
|---|---|
| `ended` `completed` | the step's answer is parsed and validated as today |
| `ended` `truncated` | unsettled; an attempt is counted |
| `ended` `declined` | refused, as a provider's refusal is today |
| `failed` `provider_rejected`; `invalid_request`; an answer the backend cannot read | unsettled; an attempt is counted; reported |
| `subject_exhausted`, `concurrency_exhausted` | stays due; no attempt is counted |
| `busy`, `paused`, `rate_limited`, `accounting_unavailable`, `provider_unavailable`, `provider_failed`; no answer from the service; a pass the service refuses | stays due; no attempt is counted |

A page that stays due is tried by a later pass. Nothing here is told to the person.

## §6 Versions

A page is derived again when the version of a step differs from the one it was derived under, and
that version names the model and effort. The service answers with a class, not a model.

- The backend keeps a tag for the model and effort its steps run on. At the move it is today's
  value, so every page's versions still match and nothing is derived again (P-5).
- The tag is changed by hand, in the change that makes the AI service's tier table serve another
  model for the class. A check in CI reads both and fails when they disagree.
- A changed tag derives every page again, oldest first, within the background budget. That is
  Windmill's cost and no person's.

## §7 What a person notices

Nothing of Echoes changes. A person's AI allowance stops being spent by it, so a free account's
allowance lasts longer for Coach, and a question to Coach is no longer refused because Echoes was
running.

## §8 What retires

- The backend's Anthropic adapters for Echoes, their use of the backend's ledger and fuse, and the
  usage rows and the `ai_spend` event they wrote. The AI service's call rows under the label
  `echoes` take their place.
- The passive cap of $2 a rolling 30 days, which production does not use.
- The backend's provider key and ledger stay, for the callers §0 names.

## §9 Testing

- **The wire.** The backend's client runs the AI service's fixtures (`packages/api-contract/ai`),
  as a device's client does. Unit tests play the service from them. No test in CI calls the AI
  service or a provider.
- **The sweep's tests** keep their cases, with the service played in place of the provider, and
  gain: every row of §5's table; a call in flight when the process ends, read and not made again;
  one call an account at a time; the version tag unchanged at the move.
- **On a local stack**, with a played provider: a page saved and its echoes derived through the AI
  service; the service stopped, and the page left due with no attempt counted; the backend
  restarted mid-call; a background budget spent; a person's Coach turn admitted while an Echoes
  call runs. Each checks the ledger's charge and that no log holds a word of a page.

## §10 Observability

- The backend logs one line a call: the operation, `echo.segment` or `echo.curate`, the outcome or
  refusal code, and the duration. It reports to Sentry, under the static names the sweep has, an
  answer it cannot read and a refusal §5 calls reported. A page left due is a log line, never an
  Issue.
- Nothing logs or reports a page's text, a passage, a pass or a `callId`.
- The AI service's own rows and alerts cover cost: its ledger, its fuse and its budget crossings.

## §11 Values

| Name | Value | Whose |
|---|---|---|
| `BACKGROUND_MONTH` | $2 an account a UTC calendar month, the passive cap's amount | the AI service's tier table |
| Background calls in flight | 1 an account | the AI service's tier table |
| Class and effort | `medium`, `low` | Echoes' |
| `maxTokens` | 16,000 | Echoes' |
| `minTokens` | measured before the move | Echoes' |

## §12 Gaps this build closes

- The backend has no client for the AI service, and its pass signer refuses `client` `server`.
- The AI service has no budget but a person's own, and counts background work against the one call
  a free account may have in flight.
- [Echoes](../../backend/products/journal/ECHOES.md) said passive spend had an allowance of its
  own; in production it drew on the person's. That document now says so.

## §13 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | When Echoes moves onto the AI service | Before the iOS release. (2026-11-17) |
| R-2 | Whose budget pays for Echoes | A budget of Windmill's own for each account, apart from the person's allowance. (2026-11-17) |
| R-3 | Whether Echoes shares a person's call in flight | It does not. Background work has a slot of its own. (2026-11-17) |
