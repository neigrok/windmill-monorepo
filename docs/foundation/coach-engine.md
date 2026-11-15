# Coach engine

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
definitions (`D-n`), invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and
roadmap nodes can cite them.

## §0 Status and scope

**Status:** Specified; nothing is built. The only Coach loop that exists runs on the server, for gym
([phone-hosted Coach abilities](mobile/gym_coach.md) §4.2). The build order lives in the Coach engine
roadmap tree, which the dogfood tree (`t_9362d9bc883e0a1e`) opens from the node `coach-engine`.

**Scope:** What every Coach shares once its turn runs on the device (AI service I-3): the engine
that runs a turn, the client that calls the [AI service](ai-service.md), and the door where the
backend signs a pass. It is written once in each of three languages: JavaScript for the web, Swift
for the iPhone and Kotlin for Android.

**Out of scope:** What a product gives the engine: its prompt, its abilities, its records and its
screens. [Gym Coach on the AI service](gym-coach-on-ai-service.md) and
[Roadmap Coach](roadmap-coach.md) hold those. The AI service itself. Journal Talk, which will use
the pass door and no turn; its move is designed apart (AI service I-5).

**Depends on:** the AI service's text door.

## §1 Principles

- **P-1 The device runs the turn.** The loop, the gate, the system prompt, the tool list and the
  model's side of the conversation are the device's. Each model round is one call to the AI
  service's text door. No server of Windmill's holds a turn. (R-1)
- **P-2 The engine names no product.** A product gives it a profile (D-3) and a tool host, and keeps
  its own conversations. (R-2)
- **P-3 One behaviour, three languages.** The three engines answer the same script with the same
  requests, the same host calls and the same end. Shared vectors hold them to it (§9).
- **P-4 The engine holds no money rule.** The AI service decides whether a round is admitted and
  what it costs. The engine carries its refusals to the person and decides nothing by an amount.
- **P-5 A record holds what a person reads.** What the model needs to continue a turn lives in the
  memory of the process running it and nowhere else.

## §2 Vocabulary

*Ability*, *catalog*, *executor*, *tool host*, *turn*, `turnId` and *seat* mean what
[phone-hosted Coach abilities](mobile/gym_coach.md) D-1 to D-10 define. This document adds:

- **D-1 Round.** One call to the text door within a turn, numbered from 1. Its caller names it with
  a `callId` ([AI service §6.1](ai-service.md#61-public-what-a-caller-reaches)).
- **D-2 Working conversation.** The messages the next round sends: the first content, each
  assistant message as the service returned it with its `carry`, and each tool message.
- **D-3 Profile.** What a product gives the engine for a seat: the system prompt, the catalog and
  which of its abilities are offered, the model class, the effort, the output cap and floor, the
  label, the limits of §6 and the groups of §5.
- **D-4 Pass.** The statement the backend signs for a principal
  ([AI service §4](ai-service.md#4-the-pass)).
- **D-5 AI client.** The code that fetches a pass and makes a call (§4). It knows no turn.
- **D-6 Mark.** A row the device keeps for itself that names the turn it is running. It does not
  sync.

## §3 Where things live

```text
packages/api-contract/
  ai/                       the AI service's wire fixtures and pass vectors
  agent/turns/              the engine's vectors (§9)
backend/platform/ai_passes/ the pass door (§4)
web/src/platform/agent/     the engine, in JavaScript
web/src/platform/ai/        the AI client, in JavaScript
web/src/platform/domain-kit the catalog types: an ability, a catalog, a schema check
apps/android/agent/         the engine, in Kotlin: the module `:agent`
apps/android/platform/      the AI client, in Kotlin
apps/ios/                   the engine, in Swift: a module `Agent`, the twin of `:agent`;
                            the AI client in `WindmillPlatform`
```

- The engine is in the layer the [domain kit](domain-kit.md) §2.2 calls *agent*: it depends on the
  sync engine's core types and on no kit, product or platform module. It reaches everything else
  through three ports: the tool host, the AI client and telemetry.
- The catalog types belong to the domain kit, where Kotlin and Swift already keep them. The web's
  kit gains them.
- The AI client is platform code. It is the only code that knows the service's wire, and it checks
  itself against `packages/api-contract/ai/wire/fixtures.json`.

## §4 The pass and the client

### §4.1 The pass door

`POST /v1/ai/passes` is served by the backend. It is the only place a pass is signed (AI service
I-1), and signing one asks nothing of any other service.

| Presented | Body | Answer |
|---|---|---|
| a session | `{"client": "ios" \| "android" \| "web"}` | `{pass, expiresAt}` for the account |
| a session and an installation credential | the same | the same, naming the installation when it is bound to this account |
| an installation credential alone | the same | `{pass, expiresAt}` for the installation |

- The pass states `plan` from `Entitlements::hasWindmillOne`, and `ownerGrant` for owner access and
  for an allowlisted sandbox subscriber. An installation's pass states neither.
- A pass lasts `PASS_LIFETIME`. `expiresAt` is its `exp`, in epoch milliseconds.
- An installation's request first passes the limits the backend keeps for installations by network
  address. The limit on generations an address may start in an hour becomes a limit on the passes
  it may be signed.
- The door is mounted only where a signing key is configured. The key is an Ed25519 private key the
  backend alone holds, under a `kid`; the issuer proves itself against
  `packages/api-contract/ai/passes/vectors.json`.
- The answer carries `Cache-Control: no-store`. The pass is written to no log line, report or event.

Refusals, each `{code}`:

| Status | `code` | Meaning |
|---|---|---|
| 401 | `unauthorized` | No session and no installation credential, or a session that has ended |
| 401 | `invalid_installation` | The installation credential is not one the backend issued |
| 403 | `device_bound` | The installation alone asked, and it is bound to an account: sign in |
| 403 | `account_closing` | The account is being erased (AI service I-9) |
| 429 | `rate_limited` | The address or the principal asked too often |
| 503 | `anonymous_ai_unavailable` | Signed-out AI is switched off on this server |

Issuing an installation credential and binding it to an account stay the backend's routes they are
([phone-hosted Coach abilities](mobile/gym_coach.md) §8). A binding is stated to the AI service by
the first account pass that names the installation
([AI service §5.6](ai-service.md#56-an-installation-that-became-an-account)).

- **INV-1.** A pass is held in memory only. It is never written to a store, a record, a device row
  or a backup, and it is dropped when the seat changes.

### §4.2 The AI client

- **A pass.** The client asks the pass door when it holds no pass, or one with less than
  `PASS_REFRESH` left. A call refused `pass_expired` fetches a new pass and asks once more under the
  same `callId`; a second `pass_expired` is a failure. `pass_signature`, `pass_audience` and
  `pass_malformed` are the issuer's fault: the client stops and reports.
- **A call.** `PUT /v1/calls/{callId}/text?label=<label>` with the pass as `Authorization: Bearer`.
  The client sends no cookie and no installation credential to the service's routes. They are on
  the API origin the device already talks to
  ([AI service §6.1](ai-service.md#61-public-what-a-caller-reaches)), so a device still reaches one
  host.
- **A `callId`** is 22 characters of unpadded base64url from 128 bits of a cryptographic random
  source, minted for each round and kept in memory with the turn.
- **Asking again.** An answer that breaks, or ends without `ended` or `failed`, is asked for again:
  - before any event arrived, by sending the same `PUT` with the same body, which attaches to the
    call if the service admitted it and admits it if it did not;
  - after one arrived, by `GET /v1/calls/{callId}/result?after=<id>` with the last event's `id`.

  The client asks again after 1, 2, 4 and 8 s. The fifth loss in a row ends the round as lost. A
  `GET` answered `result_gone` or `call_unknown` ends it as lost at once.
- **The allowance.** `GET /v1/allowance` answers what the seat has left. Every `ended`, `failed` and
  refusal carries it too.
- The client never retries a call under a new `callId`. Whether to make another round is the
  engine's to decide, and it never repeats one.

## §5 The turn

A product's send hands the engine a turn: its `turnId`, its seat, the question, the pictures and the
profile. The engine runs it in this order.

1. **Open.** The tool host writes the turn's records in one local write: the person's message, the
   Coach message in state `running` whose id is the `turnId`, and the mark (D-6).
2. **First content.** The tool host gives the history, the context reads and the pictures. The
   engine builds one user message holding, in order: the history as one text part marked as earlier
   conversation, the context, each picture as an image part, and the question. The request's
   `system` is the profile's prompt, and its `tools` are the offered abilities, each with its name,
   its description and its input schema, in catalog order.
3. **A round**, for each of `1..MAX_MODEL_CALLS`:
   1. If Stop was asked, end the turn `stopped`.
   2. Call the text door with the working conversation, the profile's model class, effort, output
      cap and floor, and `cache: true`.
   3. Hand each `text` delta to the tool host as it arrives. The host writes the text so far to the
      Coach message at the pace the product sets.
   4. On `ended`, append its `message`, `carry` included and unread, to the working conversation.
      Then by its `stop`:
      - `completed`: end the turn `completed`.
      - `tool_calls`: pass each call, in order, through the gate (§6). Run each admitted call on the
        tool host, one at a time, in order. Append one tool message that answers every call: an
        admitted call with its result as text, a refused one with its code as an error. Continue.
      - `truncated`: end the turn `completed` with `truncated`.
      - `declined`: end the turn `declined`.
   5. On `failed`, or a round lost (§4.2), end the turn `failed` with the code.
4. Reaching `MAX_MODEL_CALLS` without `completed` ends the turn `failed`.
5. **End.** The tool host writes the end in one local write: the state, the whole text,
   `truncated`, the code, and what the product derives from the calls. The same write clears the
   mark.

**A turn that never began.** When round 1 is refused before any event, or every attempt to reach
the pass door or the text door for round 1 is lost, the turn is withdrawn: the tool host removes
the records step 1 wrote, and the question and its picture return to the field. A turn is withdrawn
only while nothing of an answer has arrived and no ability has run.

**Stop.** Stop takes effect before the next round or the next ability call. The round in flight is
read to its end and paid for, as the service reads every call to its end
([AI service INV-8](ai-service.md#52-a-calls-life)). A round that ends `completed` completes the
turn. A round that ends `tool_calls` has its calls discarded, and the turn ends `stopped`. A round
lost after Stop ends the turn `stopped` with the text that arrived.

**The process ends.** A reload, a closed tab, a killed app or a crash loses the working
conversation (P-5). The turn is not resumed: when the engine next starts, a Coach message its mark
names that is still `running` ends `interrupted`, and the question stays on the record. A round in
flight when the process ended is paid for.

**The device sleeps.** A process that stayed alive while its connection dropped asks for the round
again (§4.2). The service keeps a finished round's answer for `RESULT_LINGER`, so a turn survives a
pause that long. A phone holds the platform's lease for work in progress while a turn runs, as
[phone-hosted Coach abilities](mobile/gym_coach.md) §4.5 says.

**The seat changes.** A sign-in, a sign-out or a change of the active replica first ends a running
turn `interrupted` and drops the pass (INV-1).

**One writer.** Only the engine instance that opened a turn writes its Coach message. On the web
the tab running a turn holds a browser lock named for the `turnId`; another tab shows the turn as
answering elsewhere, and a tab that finds a mark whose lock is free ends that turn `interrupted`.
Another device shows a `running` turn as answering on another device.

**A turn nobody ends.** A device that never returns leaves its turn `running`. Any device of the
same person MAY end a `running` Coach message that is `TURN_STALE` old, by writing `interrupted`
and nothing else. A writer's own end, written later, stands over it, as the record's ranked state
already rules (§8).

- **INV-2.** A round is made once. The engine never sends a round's request under a second
  `callId`, so nothing a device does makes the service work twice for one round.
- **INV-3.** An ability call runs at most once in a turn. A turn that loses its process ends; it
  does not run a call again.

## §6 The gate

Every ability call passes these, in order, before it runs. A refused call returns to the model as
an error result carrying its code, and the model continues.

| Rule | | Asked of |
|---|---|---|
| Offered | The name is in the profile's catalog, offered to this seat, and its `agent` is not `withheld` | the tool host, from the kit's catalog types |
| Seat | The ability's `seats` admits the turn's seat | the tool host |
| Shape | The input validates against the ability's schema at every depth | the tool host |
| Once | At most the stated number of calls succeed in a turn for each group the profile names, as one proposal for a target | the engine |
| Volume | At most `MAX_ABILITY_CALLS` calls in a turn, and at most `MAX_WRITES` that the catalog classes other than `read` and whose `agent` is `runs` | the engine |
| Product | Whatever more the profile's tool host refuses | the tool host |
| Stop | After Stop, every remaining call is refused | the engine |

- The codes are the ones gym's gate and executors answer today
  ([phone-hosted Coach abilities](mobile/gym_coach.md) §5 and §6.5), so a model and a vector read
  the same refusal on every surface.
- The gate guards a person's data against the model, not against the person, who can make every
  change the gate refuses with their own hand. It is therefore right on the device, and it is not a
  defence the AI service or the backend relies on.
- A product's executor MAY check again what the gate checked.

## §7 Access

The engine maps what the pass door and the AI service answer onto a small set of states. The words
for each are the product's.

| State | From |
|---|---|
| Allowance used up | `subject_exhausted`. The `allowance` beside it says whether anything remains or is held, so a product can tell a spent allowance from a round that did not fit |
| Shared capacity used up | `free_day_exhausted`, `free_month_exhausted`, with the `budgetResetsAt` of the same `allowance` |
| Busy | `concurrency_exhausted`, `rate_limited`, `busy`, `paused` |
| Sign in | the pass door's `unauthorized`, `invalid_installation` and `device_bound`; the service's `device_bound` |
| Switched off | the pass door's `anonymous_ai_unavailable`; a 404 from the pass door, which means this server has no AI |
| Offline | no connection |
| Did not answer | `provider_unavailable`, `provider_failed`, `accounting_unavailable`, a round lost |
| A defect | `invalid_request`, `too_large`, `provider_rejected`, `funding_required`, `conflict`, `pass_signature`, `pass_audience`, `pass_malformed`, `account_closing`: shown as did not answer, and reported |

- The engine reads `GET /v1/allowance` when Coach opens, and its `code` says before a question is
  sent whether one could be asked.
- No screen states an amount of money. A day an allowance returns is the `budgetResetsAt` of the
  allowance.

## §8 What a product keeps

The engine requires of a product's records, and no more:

- a Coach message whose id is the `turnId`, with its text, `truncated`, and a state of `running`,
  then `interrupted`, or one of `completed`, `declined`, `failed` and `stopped`, ranked so that an
  end the writer wrote stands over `interrupted` and both stand over `running`, as gym's `message`
  ranks it ([sync engine](engine.md) Appendix A);
- a mark (D-6);
- the writer's replica on the Coach message, so another device knows the turn is not its own.

- **INV-4.** Nothing of the working conversation is written to a record or a device row: not an
  assistant message's `carry`, not an ability's full result, not the system prompt.

## §9 Vectors

`packages/api-contract/agent/turns/` holds one file a story. A story gives a profile's limits and
groups, a seat, what the tool host answers for the open and for each ability call, and for each
round what the service plays: its events, a refusal, or a stream that breaks and what asking again
then finds. It expects the exact request of each round apart from its `callId`, the gate's
refusals, the host's calls in order, and the end.

- The stories cover: text alone; two rounds; several calls in one round; each gate rule; a round
  refused at round 1 and at a later round; each `stop`; `failed` with each provider code; a lost
  round before and after its first event; `pass_expired` once and twice; `result_gone`; Stop before
  a round, during one that completes and during one that calls tools; the process ending; a stale
  turn ended by another device.
- Each engine replays every story against a played AI client. No test in CI calls the AI service
  or a provider.
- The events a story plays are in the shapes of `packages/api-contract/ai/wire/fixtures.json`, and
  a check holds the two together.

## §10 Observability

- The engine reports through its telemetry port and names no event itself. A product emits, with no
  text of the person's or the model's: one event when a turn ends, with its state, seat, code,
  rounds, ability calls and refusals as counts, answer bytes and duration; and one for each ability
  call, with the ability's name and its outcome or refusal code.
- The AI client reports to Sentry under the static name `ai-call`: a transport failure that is not
  a lost connection, an answer it cannot read, and every code §7 calls a defect. The pass door's
  failures report under `ai-pass`. A refusal a person can act on is an event and never an Issue.
- The backend logs one line for each pass it signs or refuses: operation `ai.pass.sign`, the kind
  of principal, the plan, the client, the outcome or code and the duration. It logs nothing else of
  a turn.
- Nothing logs or reports a pass, a `callId`, a prompt, a question, an answer or an ability's
  result.

## §11 Values

| Name | Value | Whose |
|---|---|---|
| `PASS_LIFETIME` | 10 min, the service's `PASS_MAX_LIFETIME` | the pass door's |
| `PASS_REFRESH` | 60 s | the AI client's |
| `TURN_STALE` | 30 min | the engine's |
| `MAX_MODEL_CALLS`, `MAX_ABILITY_CALLS`, `MAX_WRITES` | set by the profile | the profile's |

## §12 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | Where the turn runs | On the device: the loop, the gate and the prompt. Each model round is a call to the AI service. (2026-11-14) |
| R-2 | One Coach or one a product | One engine; a separate Coach in each product with its own prompt, abilities and conversations. (2026-11-14) |
| R-3 | How long a pass lasts | Open. Assumed: 10 minutes. A sign-out, an erased account and a change of plan therefore reach the AI service within 10 minutes and no sooner (AI service INV-2). |
| R-4 | A turn whose process ends | Open. Assumed: it ends `interrupted` and is not resumed, as a phone's turn ends today. Resuming would need the working conversation written to the device, which P-5 rules out. |
| R-5 | A turn its device never ends | Open. Assumed: any of the person's devices ends it `interrupted` once it is 30 minutes old. No server ends a turn. |
