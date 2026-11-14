# Windmill AI service

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, definitions (`D-n`),
invariants (`INV-n`), integration decisions (`I-n`) and rulings (`R-n`) are numbered so reviews, code
and roadmap nodes can cite them.

## §0 Status and scope

**Status:** Specified; nothing is built. The C++ backend holds the AI allowance ledger
([USD AI allowances](../../backend/AI_ALLOWANCES.md)), the provider keys and every provider call. This
document specifies the service that replaces all three. The build order lives in the AI service
roadmap tree, which the dogfood tree (`t_9362d9bc883e0a1e`) opens from the node `windmill-ai-service`.

**Scope:** One service makes every hosted AI call Windmill pays for. It decides who may make a call
and what the call may cost, sends it to the provider, streams the answer back and settles the money.
It serves three capabilities: text (a model round), transcription (speech to text) and speech (text
to speech).

**Out of scope:** Prompts, tools, agent loops and conversations belong to whoever calls. Identity and
entitlement stay with the backend; what an account bought stays with the
[subscription service](subscriptions.md). How each existing feature moves onto this service is not
designed here: §12 holds the decisions those moves start from, and each move is designed once the
service is built.

## §1 Why a separate service

Provider spend is the one cost of Windmill that a stranger can drive. The service is kept apart so
that:

- it holds the only provider keys, so a call that is not metered cannot be made, by structure and not
  by convention;
- a call is sent and settled by one process, which reads it to its end whatever happens to its
  caller, so a deploy or crash elsewhere leaves no call unaccounted;
- no call waits on another service: a caller is verified offline, and between a caller's request and
  its answer the service asks nothing of the backend or the subscription service (INV-15);
- it holds its own database, which no product code can join against, and no content at all (INV-13);
- the code that decides what a call may cost is small enough to review whole.

It is written in Rust. It runs as one process in its own container on the production host beside
`server` and `embedder`, as the subscription service will, with its own image, workflow and health
check.

## §2 Vocabulary

- **D-1 Principal.** Who pays for a call: one installation or one account, named by the opaque id the
  backend gives it. The service knows no email, name or address for either.
- **D-2 Pass.** A short-lived statement signed by the backend that names a principal and what the
  backend knows about it (§4). It is the only credential a caller presents.
- **D-3 Plan.** What an account holds, as its pass states it: `none` or `one`. A later paid plan adds
  a value.
- **D-4 Tier.** The row of the tier table (§3) a call is admitted under: `anonymous` for an
  installation; `one` for an account whose plan is `one` while a grant is in force for it, an owner
  grant included (§3); `free` for every other account.
- **D-5 Capability.** What a call asks a provider to do: `text`, `transcription` or `speech`.
- **D-6 Model class.** The name a caller uses for a text model: `large`, `medium` or `small`. The tier
  table maps a class to a provider's model, so no caller names a provider or a model id.
- **D-7 Call.** One request the service sends to a provider for one principal. Its caller names it
  with a `callId`; the service gives it an `id` of its own that is unique across principals.
- **D-8 Price book.** The provider's list price of every model the tier table names, as data: each
  rate explicitly, by token, by second of audio or by character as the provider bills it, with the
  page and the date it was read on, under a version every call records.
- **D-9 Allowance.** A principal's own budget for one period: an installation's for its lifetime, a
  free account's for a UTC calendar month.
- **D-10 Free pool.** A budget every `anonymous` and `free` call shares: one for the UTC calendar
  month and one for the UTC day.
- **D-11 Grant.** Capacity funded for one account over one period `[start, end)`, with its source
  (`subscription` or `owner`), its amount and the funding reference that makes it unique.
- **D-12 Reservation.** The ceiling the service computes for a call's cost before it admits the call,
  held in every budget the call draws on until the call ends.

Instants are epoch milliseconds, UTC. Money is integer nano-USD inside the service and an exact
decimal USD string on every wire (INV-11).

## §3 Tiers

The tier table is data the service loads at start. A row holds everything that differs between
tiers, so adding a tier adds a row and a plan value and no code.

| | `anonymous` | `free` | `one` |
|---|---|---|---|
| Own budget | allowance of $0.25 for the installation's lifetime | allowance of $0.50 a UTC calendar month | the grant in force: $7 a funded period |
| Shared budgets | free month $100, free day $5 | free month $100, free day $5 | none |
| Calls in flight | 1 | 1 | 2 |
| Calls started a minute | 30 | 30 | 60 |
| Text classes served | `medium` (also for `large`), `small` | `large`, `medium`, `small` | `large`, `medium`, `small` |
| Output ceiling of a text call | 2,000 tokens | 16,000 tokens | 16,000 tokens |
| Transcription, speech | no | no | yes |

The amounts, the calls in flight and the anonymous row's model are the backend's policy as it stands
([USD AI allowances](../../backend/AI_ALLOWANCES.md)); `large` is `claude-opus-5`, `medium` is
`claude-sonnet-5` and `small` is `claude-haiku-4-5`, the models the backend calls. The output
ceilings, the calls a minute and `OWNER_GRANTS_MAX` are set here. (R-4)

- A class a tier serves as another is not refused: the call runs on the class served, and its answer
  says which.
- An account whose plan is `one` with no grant in force, as in a payment grace period, is `free` in
  every respect. A capability its tier lacks refuses it as `funding_required`, so transcription and
  speech never draw on a free pool. (R-5)
- A pass that states `ownerGrant` (§4) opens an owner grant. Whenever the service resolves such an
  account's tier, for a call or for `GET /v1/allowance`, and the account has no grant in force, it
  first funds one grant of the `one` amount for the current UTC calendar month, source `owner`, in a
  transaction of its own. An account receives at most one a month, and at most `OWNER_GRANTS_MAX`
  accounts receive one in a month; beyond that the account stays `free` and the refusal to fund is
  reported, so a fault in whoever signs passes cannot mint unbounded capacity.
- The table also lists the labels a caller may give its calls (§6.1), and for each voice capability
  the model, voices and formats served.
- **INV-1.** Every model the tier table names has a rate in the price book for every count its
  provider can report, or the service refuses to start. No call is priced by a guess.

## §4 The pass

A pass is `wm-pass.v1.<kid>.<payload>.<signature>`, at most `PASS_MAX_LENGTH` characters. `kid` names
one of the issuer's keys in 1 to 32 characters of `a–z 0–9 -`. `payload` is the unpadded base64url
of a JSON object. `signature` is the
unpadded base64url of an Ed25519 signature, verified strictly, over the ASCII bytes of
`wm-pass.v1.<kid>.<payload>`.

| Claim | Meaning |
|---|---|
| `aud` | `ai`. |
| `env` | `production` or `development`: the deployment the pass is for. MUST equal the service's own. |
| `iat`, `exp` | When it was issued and when it ends. |
| `sub` | `{"installation": id}` or `{"account": id}`: the principal (D-1). |
| `plan` | `none` or `one` (D-3). On an account's pass only, where it is required. |
| `ownerGrant` | `true` when the account is funded as owner access is (§3). Only with `plan: one`. |
| `installation` | On an account's pass: the installation this device was before it signed in, when the issuer holds that binding (§5.6). |
| `client` | `ios`, `android`, `web` or `server`: who is calling, for reporting only. |

The service verifies the signature before it reads the payload, and believes a pass only when all of
these hold. Otherwise it answers 401 with the code beside the rule and admits nothing:

1. The request carries one — `pass_missing`.
2. It has the prefix and its three parts within the length bound, and `kid` names a pinned public
   key under which the signature verifies — `pass_signature`.
3. The payload is a JSON object whose `aud` is `ai` and whose `env` is the service's —
   `pass_audience`.
4. It holds the claims above and no others, in a combination the table allows, and `exp − iat` is at
   most `PASS_MAX_LIFETIME` — `pass_malformed`. This code means the issuer is at fault, and a caller
   that meets it stops.
5. The clock is no earlier than `iat` less `PASS_SKEW` and is before `exp` — `pass_expired`. A
   caller fetches a new pass and asks once more.

A pass is read once, when a request arrives; a call outlives the pass that admitted it. The public
keys are configuration, a set keyed by `kid`. An issuer rotates by having the service pin the new key
before it signs under it, and drop the old one after its last pass has expired.

- **INV-2.** Nothing revokes a pass. What a pass states is believed until `exp` and no longer, so a
  change to an account takes effect here within `PASS_MAX_LIFETIME`.
- **INV-3.** A key whose private half is public never opens production. The service carries the
  fingerprint of every key the vectors and `pass_signer` publish, and such keys carry a `kid` starting
  `test-`. With `env` `production` it refuses to start while a pinned key matches a fingerprint or
  that prefix, under any `kid`.

The format's golden vectors belong in `packages/api-contract/ai/passes/`: for each, the payload's
exact bytes, a `test-` key and the pass it MUST produce, and one example of every refusal above. An
issuer in any language proves itself against them. `tools/pass_signer` signs passes for local use
and for checks against a deployment; it is never linked into the service.

## §5 The ledger

### §5.1 Budgets

A call draws on budgets, each with a limit and a period, and each holding two sums: `spent` and
`held`.

| Tier | Budgets a call draws on |
|---|---|
| `anonymous` | the installation's allowance, the free month, the free day |
| `free` | the account's allowance for the month, the free month, the free day |
| `one` | the grant in force |

- **INV-4.** A call is pinned to the tier, budgets and grant it was admitted under. Its cost lands in
  those budgets whenever it ends; a later period or grant never funds it.
- **INV-5.** A call that draws on a grant draws on nothing else, and no other tier's call draws on a
  grant.

### §5.2 A call's life

```text
reserved ──► dispatched ──► settled      the provider said what it cost
    │             ├───────► unconsumed   the provider did no work; costs nothing
    │             └───────► assumed      the provider may have worked and did not say; costs its
    │                                    reservation
    └─────────────────────► unconsumed   never sent
```

- **INV-6.** Every request a provider bills belongs to exactly one call, which is committed as
  `dispatched` before the first byte of it is sent.
- **INV-7.** A call is dispatched at most once. The mark is conditional on the call being `reserved`,
  the adapter makes no transport retry and follows no redirect, and a `callId` its principal has
  used attaches to the existing call (§6.4).
- **INV-8.** The service ends a dispatched call only at the provider's last event or at its
  `CALL_TIMEOUT`. Nothing a caller does after admission ends it sooner, since a provider bills work
  stopped part-way without stating its cost.
- **INV-9.** Every call ends in exactly one of `settled`, `unconsumed` or `assumed`, and holds
  nothing afterwards. A call no running task owns is ended by the sweep (§5.8), in a running process
  as at start. (R-1)

### §5.3 Admission

A call's reservation (D-12) is computed before admission:

- **Text.** The input is the provider's own count of the request exactly as the adapter will send
  it, plus `COUNT_MARGIN`. When the provider's counting door does not answer within `COUNT_DEADLINE`,
  the input is taken as one token for every byte of that request, plus the provider's largest count
  for each image and its stated overhead for tools, plus `COUNT_MARGIN`. A counting door that refuses
  the request refuses the call as `provider_rejected`. The input is priced as a cache write when the
  call caches (§6.2) and the whole output cap as output, both at the rates that apply to a prompt of
  that size.
- A text request states `maxTokens` and MAY state `minTokens`, which defaults to `maxTokens`. A
  `maxTokens` above the tier's ceiling is taken as the ceiling. Admission picks the largest output
  cap between the two that every budget of the call can hold, sends that cap to the provider, and
  refuses when `minTokens` does not fit. A `minTokens` above `maxTokens` or above the ceiling is
  `invalid_request`.
- **Transcription and speech.** The reservation is the ceiling §8.2 gives for the model.

Admission is one database transaction that locks the principal's budgets and every shared budget the
call draws on. It refuses with the first code that applies:

| Order | Check | Refusal |
|---|---|---|
| 1 | The principal has used this `callId`: answer as §6.4 says | the existing call, or `conflict` |
| 2 | The installation is known as bound to an account (§5.6) | `device_bound` |
| 3 | The tier lacks the capability | `funding_required` |
| 4 | The principal's calls in flight are at the tier's limit | `concurrency_exhausted` |
| 5 | The reservation fits the principal's own budget | `subject_exhausted` |
| 6 | It fits the free month | `free_month_exhausted` |
| 7 | It fits the free day | `free_day_exhausted` |

Admission writes the call as `reserved` with its pins, its reservation and the price book's version,
and adds the reservation to `held` in each budget. A second transaction marks it `dispatched`; only
then is it sent. A call refused at admission leaves no row, and its `callId` may be used again. A
call that cannot be marked `dispatched` answers `accounting_unavailable` and ends `unconsumed`; its
`callId` is spent.

- **INV-10.** At admission `spent + held` never exceeds a budget's limit. A budget ends above its
  limit only by a settlement's excess (§5.4), which is reported.

### §5.4 Settlement

A call that ends `settled` costs what the provider's usage statement comes to under the price book
version the call recorded. The cost moves from `held` to `spent`, and the rest of the reservation is
released.

A cost above the reservation means the provider billed more than it counted. The whole cost is still
written as `spent`, the excess is reported (§10), and nobody is locked: a budget left above its limit
refuses its next call as exhausted. (R-8)

A call that ends `unconsumed` releases its reservation. A call that ends `assumed` moves its whole
reservation from `held` to `spent`: the service was not told less, so it counts the most. An operator
who learns the true cost corrects it through the internal door (§6.5), which keeps both amounts.

A settlement that cannot be written is tried again for as long as the process lives, by the task
that owns the call, which keeps the provider's counts and nothing else of the answer. After
`SETTLE_RETRY` the caller is answered with `charged` null. Only a call no task owns is ended by the
sweep. Every write that ends a call is conditional on the state it leaves.

- **INV-11.** Every sum is integer nano-USD from the price book's rates, and every amount on a wire
  is its exact decimal string. No step uses floating point, and a reservation that would overflow is
  refused at admission as `invalid_request`.

### §5.5 Grants

Three operations, each idempotent, reached through the internal door (§6.5):

- **Fund** `{reference, accountId, plan, period}` creates one grant of that plan's amount, source
  `subscription`. It answers `ok`; `replay` when that reference already funded that account for that
  period; and `conflict` when the reference funded another account or another period, or the period
  overlaps another `subscription` grant of the account. A conflict funds nothing.
- **Close** `{reference, closedAt}` ends the grant at `min(end, closedAt)`. A grant already closed
  keeps the earlier instant. A closed grant funds nothing after that instant and counts toward the
  overlap rule only until it. What was spent stays spent. Closing a reference that funded nothing
  answers `not_found` and changes nothing.
- **Reopen** `{reference}` clears `closedAt`. It answers `conflict` when the reopened grant would
  overlap another `subscription` grant, and `not_found` for a reference that funded nothing, so its
  caller can fund the period instead.

A grant is in force while the clock is inside its period and before its `closedAt`. A `subscription`
grant and an `owner` grant may cover the same instant; calls then draw on the `subscription` grant,
and the two are never combined. Capacity a grant has left at its end is gone.

### §5.6 An installation that became an account

A free account's month counts what its device spent before it signed in. When an account's pass
names an `installation`, the service records that binding the first time it verifies such a pass,
on any route. From then on:

- the installation's calls pinned to the current UTC month count toward the account's allowance for
  that month, held and spent alike, and its calls in flight count as the account's;
- the installation is admitted for nothing more (`device_bound`), and the account reads and asks
  again for the installation's calls as its own (§6.4);
- a later pass naming the same installation under another account changes nothing and is reported,
  since the issuer is the authority on bindings and has contradicted itself.

Binding mints no allowance and moves no cost into a grant.

### §5.7 Guards

- **Fuse.** For each provider the service keeps the sum of what its calls settled and assumed over
  the trailing hour, computed from the ledger so that a restart forgets nothing. Above `HOURLY_FUSE`
  it refuses that provider's calls as `paused` until the sum falls, and reports while it stays open.
- **Rate.** Each principal may start at most its tier's calls a minute (§3), and make at most
  `READS_PER_MINUTE` other requests, a call asked for again among them. Beyond either a request is
  refused as `rate_limited` before its body is read.
- **Load.** The process carries at most `CALLS_IN_FLIGHT_MAX` calls. Beyond that a new call is
  refused as `busy` before its body is read.
- **Thresholds.** When a free pool's `spent + held` first crosses 50%, 80% and 95% of its limit in a
  period, the crossing is written in the transaction that caused it and reported once (§10). (R-2)

### §5.8 The sweep

One task runs at start and every `SWEEP_EVERY`:

- a call left `reserved` by a task that is gone ends `unconsumed`;
- a call left `dispatched` by another process instance, or by a task that is gone, ends `assumed`;
- a call's row is deleted `CALL_RETENTION` after the call ended; the budgets keep their sums. (R-9)

The service holds a database advisory lock for as long as it runs and takes it before its first
sweep, so two processes never serve at once and a starting process never ends calls a live one owns.
A service that loses the lock's session stops admitting until it holds the lock again.

## §6 Doors

The service listens on two ports. The public port is the only one the proxy forwards to, so an
internal route cannot be exposed by a path rule.

### §6.1 Public: what a caller reaches

The public routes are served on Windmill's API origin. The proxy forwards exactly `/v1/calls/*` and
`/v1/allowance` to the service's public port, ahead of the backend's own `/v1/*` rule, and removes
the `Cookie` and `X-Windmill-Installation` headers, so no credential of the backend reaches the
service. Every route takes the pass
as `Authorization: Bearer <pass>` and answers `Cache-Control: no-store, no-transform`.

| Route | Body in | Answer |
|---|---|---|
| `PUT /v1/calls/{callId}/text` | `TextRequest` (§6.2) | an event stream (§6.2) |
| `PUT /v1/calls/{callId}/transcription` | the audio bytes, with their `Content-Type` | an event stream (§6.2) |
| `PUT /v1/calls/{callId}/speech` | `{text, voice, format}` | the audio bytes, streamed |
| `GET /v1/calls/{callId}` | | `{callId, capability, state, stop, code, served, charged, endedAt}` |
| `GET /v1/calls/{callId}/result` | | the call's answer again, while it lingers (§6.4) |
| `GET /v1/allowance` | | `AllowanceResponse` (§6.3) |

- `callId` is minted by the caller from a cryptographic random source: 22 to 64 characters of
  `A–Z a–z 0–9 _ -`. Every public read is keyed by the principal and the `callId` together, and a
  `callId` that is absent or another principal's answers the same 404 `call_unknown`.
- Each `PUT` takes `?label=<label>`, naming what the caller is doing. A label the tier table lists is
  recorded as given and any other as `other`, so the labels in the ledger and the logs are a bounded
  set. The service decides nothing by a label.
- An audio body's `Content-Type` is one of the types the tier table lists for the model; any other
  is `invalid_request`.
- **INV-12.** The service names no product. It accepts any prompt and any tool list, and enforces
  only what §3 to §5 say about money.

### §6.2 The wire

`TextRequest`:

```json
{
  "model": "large",
  "system": ["You are…"],
  "tools": [{"name": "…", "description": "…", "input": {"type": "object"}}],
  "messages": [
    {"role": "user", "parts": [{"text": "…"}, {"image": {"mediaType": "image/jpeg", "data": "…"}}]},
    {"role": "assistant", "parts": [{"text": "…"}, {"toolCall": {"id": "…", "name": "…", "input": {}}}], "carry": "…"},
    {"role": "tool", "results": [{"id": "…", "content": "…", "isError": false}]}
  ],
  "output": {"maxTokens": 2000, "minTokens": 1024, "schema": null},
  "effort": "high",
  "cache": true
}
```

- A field this section does not name is refused, so nothing a caller writes passes to a provider
  unread. Also refused as `invalid_request`: a provider-hosted tool, a document or file part, an
  image by URL, a sampling parameter, a forced tool choice, more than `MAX_IMAGES` images or one that
  is not JPEG or PNG, a body nested deeper than `MAX_JSON_DEPTH`, and a `tool` message that does not
  answer every `toolCall` of the assistant message before it and nothing else.
- `tools[].input` is a JSON Schema and every tool is sent to the provider in strict mode. A model
  may call several tools in one answer. A tool's result is text.
- `carry` is an opaque string the service returned with that assistant message, sealed with a key
  only the service holds. A caller that continues a conversation SHOULD send each assistant message
  back with its `carry` unchanged: it holds what the provider needs to continue its own reasoning,
  which no caller reads. A message whose `carry` is absent, or whose seal does not verify, is rebuilt
  from its `parts`; a provider that will not continue from a rebuilt message refuses the call, which
  then costs nothing.
- `output.schema`, when present, constrains the answer to a JSON Schema.
- `effort` is `low`, `medium`, `high`, `xhigh` or `max`, default `high`. It is a hint the adapter
  applies as the served model allows. A model's reasoning tokens are output tokens and count against
  the output cap.
- `cache`, default `true`, lets the adapter place cache breakpoints (§8.1). A caller that will not
  repeat the request's beginning within minutes sends `false` and is not charged for a cache write.

A text or transcription answer is `text/event-stream`. Each event has an `id`, counting from 1, and
the service sends a comment line after every `HEARTBEAT` without one.

| Event | Data |
|---|---|
| `started` | `{callId, served, maxTokens}`: for text, the class serving the call and the output cap admission chose |
| `text` | `{delta}` |
| `toolCall` | `{id, name, input}`, whole, once its input is complete and parses |
| `ended` | `{stop, message, text, charged, allowance}` |
| `failed` | `{code, charged, allowance}` |

- `stop` is `completed`, `tool_calls`, `truncated` (the output cap was reached) or `declined` (the
  provider refused to answer).
- A caller acts on a tool call only after `ended` with `stop: tool_calls`. A `toolCall` event before
  that says what the model is doing and promises nothing.
- For text, `message` is the assistant message to append, with its `carry`. It holds whole parts
  only: a tool call the output cap cut short is left out. For transcription, `text` is the whole
  transcript and `message` is absent.
- `charged` is what the call cost its principal, and null when the settlement could not be written
  before the answer was due (§5.4).
- `failed` carries `provider_rejected` when the provider refused the request as malformed,
  `provider_unavailable` when it was unreachable or busy, and `provider_failed` when the provider
  began and its answer did not arrive whole, or it stopped for a reason §8 does not map.

A speech answer is the audio bytes. It carries no money: `GET /v1/calls/{callId}` says what it cost
and whether it ended whole. Its shape is provisional until a model is chosen (R-6).

An answer that breaks, or arrives without a `code`, as an answer cut by the network edge does, means
one thing to a caller: ask for the same `callId` again (§6.4).

### §6.3 Refusals and the allowance

A request refused before dispatch answers a status and `{code, allowance}`. `allowance` is null when
the service cannot know it: on a 401 and on `accounting_unavailable`. A caller branches on `code`,
never on the status.

| Status | Codes |
|---|---|
| 400 | `invalid_request` |
| 401 | `pass_missing`, `pass_signature`, `pass_audience`, `pass_malformed`, `pass_expired` |
| 403 | `funding_required`, `device_bound` |
| 404 | `call_unknown` |
| 409 | `conflict` |
| 410 | `result_gone` |
| 413 | `too_large` |
| 429 | `subject_exhausted`, `free_month_exhausted`, `free_day_exhausted`, `concurrency_exhausted`, `rate_limited` |
| 502 | `provider_rejected`, `provider_unavailable`, `provider_failed`, on a speech call that failed before its first byte |
| 503 | `busy`, `paused`, `accounting_unavailable` |

`AllowanceResponse` is `{tier, period, limit, used, reserved, remaining, resetsAt, budgetResetsAt,
code, capabilities}`:

- `period` is `lifetime`, `calendar_month_utc` (a free account, and an owner grant) or
  `billing_period` (a subscription grant); `resetsAt` is null for a lifetime.
- `code` is `ok`, or the refusal a call would meet now. `budgetResetsAt` is when the budget that code
  names returns: the end of the UTC day or month for a free pool, the end of the principal's own
  period for its own budget, and null for every other code.
- `capabilities` is `{text: {large, medium, small}, transcription, speech}`: for each class, the
  class that would serve it, and for each voice capability whether the tier has it.
- A positive `remaining` does not promise that a given call fits; its reservation may be larger.
- No answer states a shared budget's amounts. The output cap admission chose is the one thing a
  caller can infer from: it is never more than the budgets held.

### §6.4 Asking again

A caller that lost an answer asks for the same `callId` again. While the answer lingers it is
returned without a second charge.

- A `PUT` for a `callId` the principal has used is answered from the existing call when it names the
  same capability, and with `conflict` otherwise. Its body is not read, and the rate and the fuse do
  not stand in its way.
- `GET /v1/calls/{callId}/result` answers the call's result in its original form: the event stream
  from `?after=<id>` on, or the audio. While the call is still running, the stream continues live. A
  call has one live reader: a new one takes the place of the last.
- A result lingers in memory for `RESULT_LINGER` after its call ends. Each principal's lingering
  results are bounded by `LINGER_PER_PRINCIPAL` and all of them by `LINGER_TOTAL`, oldest first out,
  so one principal cannot push out another's. After that, and after a restart, the answer is 410
  `result_gone`: what the call cost was paid, and its answer is lost. The call's state, cost and
  failure code stay readable at `GET /v1/calls/{callId}`.
- A reader that is slow or gone never slows the read from the provider (INV-8).
- **INV-13.** Prompts, messages, tool inputs and results, images, audio, transcripts and every
  provider answer live in the service's memory only. A request's content is dropped once it is sent;
  an answer's, when its linger ends. None is written to the database, a log line, a Sentry report, a
  core file or any other store, and none is sent anywhere but to the provider that counts or serves
  the call.

### §6.5 Internal: the ledger's doors

Reached only on the container network. Funding and operating take different bearer secrets, so
whatever funds grants cannot correct a call.

| Route | Secret | Purpose |
|---|---|---|
| `PUT /internal/v1/grants/{reference}` | funding | Fund (§5.5). |
| `POST /internal/v1/grants/{reference}/close` | funding | Close. |
| `POST /internal/v1/grants/{reference}/reopen` | funding | Reopen. |
| `GET /internal/v1/principals/{kind}/{id}` | operator | The principal's budgets, grants, bindings and calls. |
| `GET /internal/v1/calls/{id}` | operator | One call by the service's own `id`, with its principal. |
| `GET /internal/v1/calls?state=&since=&callId=` | operator | The calls that ended in a state since an instant, or that carry a caller's `callId`. |
| `GET /internal/v1/budgets` | operator | The shared budgets and each provider's fuse. |
| `POST /internal/v1/calls/{id}/correct` | operator | State what an `assumed` call really cost, up or down. The budgets it was pinned to move by the difference. |

The shapes of both doors are golden fixtures that belong in `packages/api-contract/ai/`, one example
per state a caller must handle. The service checks itself against them, and so does every caller.

## §7 One call, in order

A call is a fixed pipeline. Each step either passes or ends the request with one code.

1. Read the headers within `HEADER_DEADLINE`. Verify the pass (§4).
2. Look the `callId` up for the principal. A known one leaves the pipeline here (§6.4).
3. Check the rate and the load (§5.7).
4. Resolve the tier, opening an owner grant when one is due (§3). Check that the tier has the
   capability and that the principal's allowance does not already answer a refusal (§6.3). Nothing of
   the body has been read.
5. Read the body within `BODY_DEADLINE`. One above `MAX_TEXT_BODY` or `MAX_AUDIO_BODY` is refused as
   `too_large`. Validate it (§6.2).
6. Build the provider's request. Count its input and compute the reservation (§5.3).
7. Check the provider's fuse (§5.7).
8. Admit (§5.3), which looks the `callId` up again under its lock.
9. Mark the call `dispatched` and send it.
10. Stream each event to the caller and into the call's lingering result.
11. At the provider's last event, settle from its usage (§5.4), then send `ended`.
12. Write the call's log line (§10).

Where a dispatched call ends:

| What happened | End | The caller sees |
|---|---|---|
| The provider answered, with usage the price book can price | `settled` | `ended` |
| No byte of the request was written, or the provider answered an error status before any event | `unconsumed` | `failed`: `provider_rejected` for a refused request, else `provider_unavailable` |
| The answer arrived whole and its usage is missing or cannot be priced | `assumed` | `ended`, charged its reservation |
| Anything else: the stream broke, the reply could not be read, the time ran out | `assumed` | `failed`, `provider_failed` |
| The provider stopped for a reason §8 does not map | `settled` from its usage | `failed`, `provider_failed` |
| The settlement could not be written within `SETTLE_RETRY` | `settled` once the database returns | `ended`, `charged` null |
| The service stopped mid-call | `assumed`, by the sweep | the connection closes |

A call is never sent twice, so a caller that wants another attempt mints a new `callId`.

On `SIGTERM` the service refuses new calls as `busy`, goes on serving results, and lets calls in
flight finish for `DRAIN`, which is longer than every `CALL_TIMEOUT`. The container's stop grace is
longer than `DRAIN`, and a check in CI holds the two together, so a deploy cuts no call short.

## §8 Providers

Each provider is one adapter that turns a call into that provider's request and its answer into
events and a usage statement. The keys are the service's alone, and once the backend's are deleted
(I-8) no other process can reach a provider. An adapter sends a provider nothing that names a
principal.

### §8.1 Text: Anthropic

- The adapter sends `POST /v1/messages` with a pinned API version, streaming. The input count of
  §5.3 comes from `POST /v1/messages/count_tokens` on the same request. Read on Anthropic's
  documentation on 2026-11-14: a count is not billed, has a rate limit of its own, and is an estimate
  that can differ from the billed input by a small amount, which `COUNT_MARGIN` and §5.4 cover.
- With `cache` on, it places a five-minute cache breakpoint after the tools and system prompt and one
  at the end of the conversation so far, and no other kind.
- Each model in the tier table has a profile saying how it takes reasoning and effort; the adapter
  shapes the request by it. Reasoning blocks travel only inside `carry`, and a `carry` whose seal
  verifies is sent as it is whatever model serves the call.
- Usage is read from the stream: input and cache counts from `message_start`, the output count from
  the last `message_delta`. Each count is priced at its own rate in the price book. A cache read's
  rate is not one fraction of the input rate across models, and some models charge a long prompt at
  a higher rate, so the book states each.
- `stop_reason` maps to `stop`: `end_turn` to `completed`, `tool_use` to `tool_calls`, `max_tokens`
  to `truncated`, `refusal` to `declined`. A declined call is settled like any other. The adapter
  asks the provider for no fallback model, since a fallback changes the price.
- An error status read before any stream event ends the call `unconsumed`: 400, 413 and 422 as
  `provider_rejected`, every other as `provider_unavailable`. A 401, 402 or 403 from the provider is
  reported at once, since the key or the account is at fault.

### §8.2 Voice: OpenAI

The voice doors are the same whatever model serves them. Which model does is the tier table's to
name and is not settled (R-6), because the provider is retiring the ones in use. Read on OpenAI's
documentation on 2026-11-14:

| Model | Door | Billed by | Shutdown |
|---|---|---|---|
| `gpt-4o-transcribe` (Journal Talk today) | `/v1/audio/transcriptions` | tokens: $2.50 per 1M input, $10.00 per 1M output | 2027-02-26 |
| `gpt-transcribe` | `/v1/audio/transcriptions` | audio duration: $0.0045 a minute | none published |
| `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` | `/v1/audio/speech` | characters, or text tokens in and audio tokens out | 2027-01-06, all of them |

The provider names its Realtime API as the replacement for the speech door, which is a session and
not a request. It documents no idempotency key for either door, no way to read one past request's
cost, and nothing on what a request costs when its caller disconnects (INV-7, INV-8).

Transcription:

- The body is at most `MAX_AUDIO_BODY`. A body's size bounds no duration, so the reservation is the
  model's ceiling. For a model billed by tokens that is its context window priced as input plus its
  output limit: 16,000 and 2,000 tokens for `gpt-4o-transcribe`, $0.06.
- A model billed by duration has no ceiling the service can state: the size bounds nothing and the
  provider documents no longest take. The service serves such a model only once it measures a take's
  length itself, by decoding it, before admission (R-6).
- The adapter asks for a streamed transcript. The last event's `usage` settles the call:
  `{type: "tokens", input_tokens, output_tokens}` or `{type: "duration", seconds}`. A transcript
  that arrives without usable usage was heard, and the call ends `assumed`, at the ceiling.

Speech is not built anywhere in Windmill. The rule its adapter follows: the reservation is the most
the chosen model can bill for the request's text, read from its documentation into the price book;
the call settles from the provider's usage statement when it gives one, and ends `assumed` when audio
was produced and no statement came.

## §9 Structure

```text
services/ai/
  Cargo.toml              the workspace
  ARCHITECTURE.md         what is built, the dependency rule and how it is checked
  config/
    tiers.toml            the tier table (§3)
    prices.toml           the price book (D-8)
  crates/
    domain/               D-1…D-12, the reservation, admission, settlement, grants, the fuse; no I/O,
                          no async
    providers/            one module per provider: its request, its count, its stream, its usage
    storage/              Postgres: calls, budgets, grants, bindings, threshold crossings
    server/               the composition root: both listeners, pass verification, the lingering
                          results, the sweep, configuration
  tools/
    pass_signer/          signs passes; never linked into the service
  migrations/
  tests/
    vectors/              admission and settlement stories with the budgets they must leave
```

`domain` depends on no other crate. `providers` and `storage` depend on `domain` and not on each
other. The clock, each provider's base URL and the pass keys are constructor arguments, so the whole
pipeline runs in tests against a provider the test plays, with no network.

Storage is a database of its own, `windmill_ai`, in the host's Postgres with its own role, which no
other service's role can read. It holds ids, labels, counts, instants, money, each call's `callId`
and each call's provider request id, and nothing else (INV-13). A provider request id leads to what
the provider itself kept of the call; it is deleted with the call's row.

Content never reaches a place that prints. The types that hold it implement neither `Debug` nor
`Display`; an error crossing a boundary carries a code and never a message built from a request;
Sentry is given static names and no request, header or URL; and the container writes no core file.
One test plants a marker in every content field of every door, and in the `callId`, and searches the
logs, the Sentry envelopes and a database dump for it; only the `callId` column may hold it.

- **INV-14.** Every call records the tier it was admitted under, the class asked for, the model that
  served it, the price book's version, the provider's counts and request id, and its cost, with the
  earlier amount when an operator corrected it. A `settled` charge can be recomputed from them.
- **INV-15.** Between a caller's request and its answer the service makes no request to the backend
  or the subscription service, and its public door holds no credential of either. With both down it
  admits, sends and settles as before, for as long as callers hold passes.

Configuration, with the values the service ships with:

| Name | Value | Name | Value |
|---|---|---|---|
| `PASS_MAX_LIFETIME` | 10 min | `CALL_TIMEOUT` | text 600 s; voice 300 s |
| `PASS_SKEW` | 60 s | `DRAIN` | 660 s; container stop grace 720 s |
| `PASS_MAX_LENGTH` | 2,048 characters | `HEARTBEAT` | 15 s |
| `HEADER_DEADLINE`, `BODY_DEADLINE` | 10 s, 60 s | `RESULT_LINGER` | 10 min |
| `MAX_TEXT_BODY`, `MAX_AUDIO_BODY` | 8 MiB, 6 MiB | `LINGER_PER_PRINCIPAL`, `LINGER_TOTAL` | 16 MiB, 256 MiB |
| `MAX_IMAGES`, `MAX_JSON_DEPTH` | 8, 64 | `SETTLE_RETRY`, `SWEEP_EVERY` | 30 s, 60 s |
| `COUNT_MARGIN` | 2% and 64 tokens | `HOURLY_FUSE` | $20 a provider |
| `CALLS_IN_FLIGHT_MAX` | 256 | `OWNER_GRANTS_MAX` | 25 a month |
| `CALL_RETENTION` | 90 days | `COUNT_DEADLINE` | 2 s |
| `READS_PER_MINUTE` | 120 | | |

## §10 Observability

- Every call logs one structured line when it ends, and so does every request refused after the
  pass verified, but for the two counted below: operation `call.text`, `call.transcription` or
  `call.speech`, the service's call `id` when the call was admitted, the caller's `label`, `client`,
  the deployment, tier, class asked and served, end state or refusal code, `stop`, duration, the
  reservation, the provider's counts and HTTP status, its error type mapped to a fixed list, and the
  cost.
- A request refused before or at the pass, and one refused as `rate_limited` or `busy`, is counted by
  code; a line with the counts is written at most once a second.
- The internal doors log `grant.fund`, `grant.close`, `grant.reopen` and `call.correct` with their
  outcome. Admission logs `grant.owner` when it funds or refuses an owner grant and
  `installation.bind` when it records a binding. The sweep logs `sweep.end` for each call it ends.
- Reported to Sentry under a static name, as errors: a failed admission or settlement transaction, a
  settlement's excess, a call that ended `assumed`, a provider that refused the service's key or
  account, a binding the issuer contradicted and an owner grant refused at the cap. As warnings: a
  threshold crossing, a fuse while it is open, a provider answering busy for minutes on end, and a
  Fund or Reopen that answered `conflict`, since a paid period is then left unfunded.
- An expected refusal is a log line and never an Issue.
- Nothing logs or reports content (INV-13), a pass, a principal's id, a caller's `callId`, a
  provider key, the internal doors' secrets, the key that seals `carry`, or a provider's error text,
  which can quote the request. A report names a call by the service's `id`, and an operator reads its
  principal through the internal door.
- A refused call has no row and its line names nobody, so support for a refusal starts from the code
  the person's device showed; for an admitted call, from its `callId`, through the internal door.
- The service emits no product event. What a person did is the calling device's to say; what it cost
  is read from the ledger.

## §11 When something is down

| Down | What happens |
|---|---|
| The backend | Calls go on until the passes devices hold run out, at most `PASS_MAX_LIFETIME`. |
| The subscription service | Nothing changes. Grants already funded serve; new periods wait at their source. |
| A provider, unreachable | Its calls end `unconsumed` with `provider_unavailable`; the other provider's go on. |
| A provider, breaking answers part-way | Each such call ends `assumed` and costs its reservation. The provider's fuse may trip and pause it; the other provider's calls go on. |
| The database | Every new call is refused as `accounting_unavailable`. A call in flight is read to its end and settled when the database returns, or ended `assumed`. |
| The provider's counting door | Text reservations fall back to one token a byte and grow severalfold, so a call near the end of a budget is refused that would have fitted. |
| This service, restarted | New calls are refused as `busy` until the calls in flight finish, at most `DRAIN` (§7). Lingering answers are lost. |
| This service, down | Coach, Talk and speech stop. Sync, the journal and the log are untouched. |
| The network edge cutting a long answer | The call goes on; its caller asks for the `callId` again (§6.4). |
| The service's clock behind the issuer's by more than `PASS_SKEW` | Every fresh pass is refused as `pass_expired`. Ahead of it, passes end early. |

## §12 Integrations

The decisions each later move starts from. They say what happens and when, not how; the how is
designed when the service is built, one integration at a time.

- **I-1 Identity.** The backend is the only issuer of passes. It signs one for a signed-in session or
  for an installation credential, stating `plan` from `Entitlements::hasWindmillOne` and `ownerGrant`
  for owner access and for an allowlisted sandbox subscriber. It applies its network limits before it
  signs for an installation, and signs none for an installation bound to an account.
- **I-2 Devices call directly.** When a person is waiting on an answer, their device calls this
  service itself. The backend is not in that path.
- **I-3 Coach runs on the device.** The loop, the gate on Coach's writes, the system prompt and the
  tool list belong to the device on every surface. Gym Coach and roadmap Coach are one engine with a
  different prompt and tools, and each product keeps its own conversations. This replaces principles
  4 and 5 of [phone-hosted Coach abilities](mobile/gym_coach.md), which is rewritten when the move is
  designed.
- **I-4 Tending becomes roadmap Coach.** Roadmap's server-side agent retires. In the browser, roadmap
  Coach runs its tools through the backend. The backend's tool door, `/mcp`, takes an OAuth token or
  an MCP key and no browser session, so this move includes a door a session can call.
- **I-5 Voice.** Journal Talk calls the transcription door and journal read-aloud calls the speech
  door, from the device. Both are part of Windmill One.
- **I-6 Work nobody waits on.** When the backend has AI work for an account with no device present,
  it calls the same doors with a pass it signs for that account. The queue of that work stays in the
  backend, and a refusal or an unreachable service leaves the work due. Such a call takes one of the
  account's calls in flight, as it does in the backend's ledger.
- **I-7 Funding.** When a paid period is recorded, one grant is funded for exactly that period. When
  it is refunded the grant is closed, and when the refund is reversed it is reopened
  ([subscriptions §6.3](subscriptions.md#63-funding-the-ai-allowance)). Whether a worker of this
  service follows the subscription feed or the feed's follower calls the grants door is open. Either
  way no call waits on it (INV-15). The amount a period funds then has one home, this service's tier
  table; where the buy sheet reads it from is settled with this move.
- **I-8 Cutover.** The backend's ledger rows are not carried over: every allowance starts empty in
  this service. The backend's ledger, its provider clients and its provider keys are deleted when
  their last caller has moved. (R-3)
- **I-9 Erasure.** When an account is erased the backend signs no further pass for it. The ledger
  keeps the account's opaque id on its budgets, grants and bindings, as accounting, and its call
  rows until `CALL_RETENTION` ends them.
- **I-10 Order.** Which integration is built first, and when, is the owner's to decide once the
  service is built.

## §13 Rulings

The owner's rulings. R-3, R-4, R-5 and R-7 are settled; the others are open, and each row holds what
this document assumes until it is ruled.

| | Question | Ruling |
|---|---|---|
| R-1 | A call the provider may have worked on without saying what it cost | Open. Assumed: it costs its whole reservation, at once, and an operator may correct it. |
| R-2 | Who hears that a shared budget is nearly spent | Open. Assumed: free-pool crossings and the fuse report to Sentry, where an alert rule writes to the owner. A person's own budget raises no report. |
| R-3 | The ledger rows the backend holds at cutover | Dropped. No subscription has been sold, so no paid grant is lost; each installation's lifetime spend and each account's month start again. (2026-11-14) |
| R-4 | The amounts and limits of each tier | One table with a row a tier, holding the backend's amounts as they stand. The output ceilings, the calls a minute and `OWNER_GRANTS_MAX` are values this document sets. (2026-11-14) |
| R-5 | Who may use transcription and speech | Windmill One only, from a grant. (2026-11-14) |
| R-6 | The models that serve transcription and speech | Open. Transcription is assumed to stay on `gpt-4o-transcribe` until the service can measure a take's length, and to move to `gpt-transcribe` before 2027-02-26. Nothing is assumed for speech: every model on the provider's speech door shuts down on 2027-01-06, so the capability is built after a model, and possibly another provider, is chosen (§8.2). |
| R-7 | Whose prompts the service accepts | Any. It enforces money rules only. (2026-11-14) |
| R-8 | A call the provider billed above its reservation | Open. Assumed: the whole cost is spent and reported, and nobody is locked out. |
| R-9 | How long a call's row is kept | Open. Assumed: 90 days, after which only the budgets' sums remain. |
| R-10 | Whether installations and free accounts share one daily pool | Open. Assumed: shared. The tier table can give each its own. |

What this service does differently from the backend's ledger, beyond moving it:

- A reservation is computed as a ceiling, from the provider's own count of the request; the backend
  estimates from the request's size, which a caller who chooses its own prompt can outrun.
- An uncertain call ends at once (R-1); the backend holds it until an operator acts.
- There is no debt (R-8); the backend refuses a principal that owes until an operator reconciles it.
- Only shared budgets raise a report (R-2); the backend emails the owner for every budget.
- A caller chooses its output cap and floor under its tier's ceiling; the backend fixes both per
  product.
- Each principal has a rate, and the fuse is kept per provider and survives a restart; the backend
  limits bursts per product and per network, and keeps one fuse in memory.
- A repeated `callId` is matched by capability; the backend also compares the cost offered.
- Grants of different sources never conflict, as in the backend, and an account whose plan is `one`
  with no grant in force is `free`, as [subscriptions §6.3](subscriptions.md#63-funding-the-ai-allowance)
  says and the backend's code does not yet do.
- A call's row is deleted after `CALL_RETENTION` (R-9).
