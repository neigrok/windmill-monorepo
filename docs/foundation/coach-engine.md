# Coach engine

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
definitions (`D-n`), invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and
roadmap nodes can cite them.

## §0 Status and scope

**Status:** Approved by the owner on 2026-11-15. Product-neutral turn libraries and AI clients are
implemented for web, iOS and Android, together with the optional backend pass issuer and shared
turn stories. Gym's Coach on Android runs on the Kotlin libraries, and Roadmap Coach in the iPhone's room on the Swift ones, behind
a switch off in Release; the web's screens and the iPhone's gym Coach do not use theirs yet. Those integrations and production acceptance remain separate work. The build order lives in the Coach engine
roadmap tree, which the dogfood tree (`t_9362d9bc883e0a1e`) opens from the node `coach-engine`.

**Scope:** What every Coach shares once its turn runs on the device (AI service I-3): the engine
that runs a turn, the client that calls the [AI service](ai-service.md), and the door where the
backend signs a pass. It is written once in each of three languages: JavaScript for the web, Swift
for the iPhone and Kotlin for Android.

**Out of scope:** What a product gives the engine: its words, its abilities, its records and its
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
- **P-6 A round that was paid for is read.** While the service may still hold a round's answer, the
  engine goes on asking for it, and gives a turn up as never begun only when it knows the service
  admitted nothing.

## §2 Vocabulary

*Ability*, *catalog*, *executor*, *tool host*, *turn*, `turnId` and *seat* mean what
[phone-hosted Coach abilities](mobile/gym_coach.md) D-1 to D-10 define. This document adds:

- **D-1 Round.** One call to the text door within a turn, numbered from 1. Its caller names it with
  a `callId` ([AI service §6.1](ai-service.md#61-public-what-a-caller-reaches)).
- **D-2 Working conversation.** The messages the next round sends: the first content, each
  assistant message as the service returned it with its `carry`, and each tool message.
- **D-3 Profile.** What a product gives the engine for a seat, as plain data:
  - its name and version, as `gym.coach` and 1;
  - its words: the system prompt, the words of the first content (§5), and the sentence the model
    reads beside each refusal code (§6);
  - its tools: for each ability offered, the name, the description, the input schema, whether a
    call counts toward the write cap, and, where the product says, whether the tool is strict
    ([AI service §6.2](ai-service.md#62-the-wire));
  - the model class, the effort, the output cap and floor, and the label;
  - the limits and the groups of §6.
- **D-4 Pass.** The statement the backend signs for a principal
  ([AI service §4](ai-service.md#4-the-pass)).
- **D-5 AI client.** The code that fetches a pass and makes a call (§4). It knows no turn.
- **D-6 Mark.** A row the device keeps for itself, which does not sync. It names the turn the
  device is running, the `callId` of the round in flight, and how many bytes of the Coach message's
  text, as UTF-8, had arrived before that round began. Before the first round, `callId` is null.
  A product may keep the mark as more than one device row: gym keeps the turn in `runningTurn` and
  the round in `runningRound`, whose absence stands for the null `callId` before round 1
  ([gym Coach on the AI service §4.4](gym-coach-on-ai-service.md#44-text-the-mark-and-the-end)).

## §3 Where things live

```text
packages/api-contract/
  ai/                       the AI service's wire fixtures and pass vectors
  agent/turns/              the engine's vectors (§9)
backend/platform/ai_passes/ the pass door (§4)
web/src/platform/agent/     the engine, in JavaScript
web/src/platform/ai/        the AI client, in JavaScript
apps/android/agent/         the engine, in Kotlin: the module `:agent`
apps/android/platform/      the AI client, in Kotlin
apps/ios/                   the engine, in Swift: a module `Agent`, the twin of `:agent`;
                            the AI client in `WindmillPlatform`
```

- The engine is in the layer the [domain kit](domain-kit.md) §2.2 calls *agent*: it depends on the
  sync engine's core types and on no kit, product or platform module. A profile reaches it as plain
  data, and it reaches everything else through three ports: the tool host, the AI client and
  telemetry.
- The types that read a catalog (an ability, a catalog, a schema check) are not the engine's. Kotlin
  and Swift keep them in the domain kit; the web's domain kit gains them. A
  product's tool host builds the profile's tools from them and answers the gate's catalog rules
  (§6).
- The AI client is platform code. It is the only code that knows the service's wire, and it checks
  itself against `packages/api-contract/ai/wire/fixtures.json`.

## §4 The pass and the client

### §4.1 The pass door

`POST /v1/ai/passes` is served by the backend. It is the only place a pass is signed (AI service
I-1), and signing one asks nothing of any other service.

The body is `{"client": "ios" | "android" | "web", "use": "<profile name>", "version": <integer>}`.

| Presented | Answer |
|---|---|
| a session | `{pass, expiresIn}` for the account |
| a session and an installation credential | the same, naming the installation when it is bound to this account |
| an installation credential alone | `{pass, expiresIn}` for the installation |

- The pass states `plan` from `Entitlements::hasWindmillOne`, and `ownerGrant` for owner access and
  for an allowlisted sandbox subscriber. An installation's pass states neither.
- A pass lasts `PASS_LIFETIME`. `expiresIn` is the milliseconds it has left when it is signed, so a
  device counts them on its own clock and never compares the backend's clock with its own.
- **A build can be retired.** `use` and `version` say which profile the device will run. The
  backend holds, as configuration, the oldest version it signs for each use, and refuses an older
  one as `client-update-required`. A pass does not carry them, and the AI service does not read
  them: this retires an honest build whose Coach is found broken, and is no defence against anyone.
- A session presented as a cookie is believed only with an allow-listed `Origin` and a JSON body,
  as the backend's other doors that take a cookie require.
- An installation's request first passes the limits the backend keeps for installations by network
  address. The limit on generations an address may start in an hour becomes a limit on the passes
  it may be signed. What an address can spend in a day through this door is what it could spend
  before it: the installations it may be issued, each with its lifetime allowance, in fewer requests
  than before, since a pass admits any call the allowance still covers. The AI service keeps a ledger
  of its own, so while the backend's signed-out Coach still runs beside this door an address can
  spend that much on each, and the free budgets stand twice, until gym's cutover
  ([Gym Coach on the AI service](gym-coach-on-ai-service.md) R-5).
- The door is mounted only where a signing key is configured. The key is an Ed25519 private key the
  backend alone holds, under a `kid`; the issuer proves itself against
  `packages/api-contract/ai/passes/vectors.json`.
- The answer carries `Cache-Control: no-store`. The pass is written to no log line, report or event.

Refusals, each in the body the backend's other doors answer, `{error, code}`. The codes the
installation routes already answer keep their meaning:

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | The body is not the one above, the `use` is not one the backend knows, or the network address cannot be read |
| 401 | `unauthenticated` | No session and no installation credential, or a session that has ended |
| 401 | `invalid_installation` | The installation credential is not one the backend issued |
| 403 | `untrusted-origin` | A cookie request lacks an allow-listed Origin, or a presented Origin is untrusted |
| 409 | `device_bound` | The installation alone asked, and it is bound to an account: sign in |
| 415 | `unsupported-media-type` | The request's Content-Type is not JSON |
| 426 | `client-update-required` | The version of this use is retired |
| 429 | `rate_limited` | The address or the principal asked too often |
| 503 | `anonymous_ai_unavailable` | Signed-out AI is switched off on this server |
| 503 | `unavailable` | The backend failed to issue a pass; a technical failure under `ai-pass` |

Issuing an installation credential and binding it to an account stay the backend's routes they are
([phone-hosted Coach abilities](mobile/gym_coach.md) §8). A binding is stated to the AI service by
the first account pass that names the installation
([AI service §5.6](ai-service.md#56-an-installation-that-became-an-account)).

- **INV-1.** A pass is held in memory only. It is never written to a store, a record, a device row
  or a backup, and it is dropped when the seat changes.

### §4.2 The AI client

- **A pass.** The client asks the pass door when it holds no pass, or one with less than
  `PASS_REFRESH` left. A call refused `pass_expired` fetches a new pass and asks once more under the
  same `callId`; a second `pass_expired` is a defect. `pass_missing`, `pass_signature`,
  `pass_audience` and `pass_malformed` are defects too: the client stops and reports. Once a text
  request may have been admitted, a temporary refresh failure (connection loss, rate limiting or
  backend unavailability) stays inside that round's asking-again window; it cannot withdraw the
  turn or restart the clock. A definitive pass refusal ends it with its admission evidence intact.
- **A call.** `PUT /v1/calls/{callId}/text?label=<label>` with the pass as `Authorization: Bearer`.
  The client sends no cookie and no installation credential to the service's routes. They are on
  the API origin the device already talks to
  ([AI service §6.1](ai-service.md#61-public-what-a-caller-reaches)), so a device still reaches one
  host.
- **A `callId`** is 22 characters of unpadded base64url from 128 bits of a cryptographic random
  source, minted for each round.
- **Asking again.** An answer that breaks, ends without `ended` or `failed`, or is an HTTP error
  without a valid service refusal is asked for again
  under the same `callId`:
  - before any event arrived, by sending the same `PUT` with the same body. The service answers a
    call it admitted from its first event, and admits one it never saw;
  - after one arrived, by `GET /v1/calls/{callId}/result?after=<id>` with the last event's `id`.

  The client asks again after 1, 2, 4 and 8 s and then every 8 s, until `ASK_AGAIN_FOR` has passed
  since the round's first `PUT`: the longest a call can run and the service then keep its answer.
  An asking-again answered `rate_limited`, `busy` or `accounting_unavailable` waits and asks once
  more. One answered `result_gone` means the call was made and its answer is lost, and ends the
  asking. One answered `call_unknown` is a defect: the pass names another principal than the one
  that made the call. During process recovery, however, `call_unknown` is expected (§5): the mark
  may have been written before its request left the device.
- **A refusal that passes.** A call refused as `busy`, `paused`, `rate_limited`,
  `concurrency_exhausted`, `accounting_unavailable` or `provider_unavailable` is sent again under
  the same `callId`, after 1, 2, 4 and 8 s and then every 8 s, for `REFUSAL_RETRY`; the client then
  gives the refusal to the engine. Sending again is safe whatever became of the first: the service
  answers a call it admitted and admits one it did not. A resent first `PUT` keeps this rule even
  after a lost answer: `paused`, `concurrency_exhausted` and `provider_unavailable` wait up to
  `REFUSAL_RETRY` from its first dispatch. The asking-again refusals above keep their longer window.
  A refresh that finishes after the active refusal deadline returns that refusal, whether the
  refresh succeeded or failed; a late failure cannot reopen an expired window. A temporary
  preparation failure observed before that deadline, with possible admission, enters asking again
  under the original `ASK_AGAIN_FOR` clock. Every other refusal is given at once.
- **What a refusal proves.** `busy` and `accounting_unavailable` can be answered for a call the
  service did admit. Every other refusal of a `PUT` whose earlier attempts all had an answer proves
  that nothing was admitted. Only a known code in a valid service refusal is such evidence. An
  unreadable proxy response, including an HTML 502, proves nothing, is treated as connection loss
  and files no Issue. A malformed successful event protocol remains a reported wire defect; its
  turn retains possible admission and is never withdrawn.
- **A picture.** The client uploads a picture once, with `PUT /v1/pictures/{pictureId}`, and each
  round names it ([AI service §6.7](ai-service.md#67-pictures-a-caller-uploads)). A call refused
  `picture_gone` uploads the picture again and is sent once more under the same `callId`. A second
  `picture_gone` is a defect and ends that operation; it does not mint another call.
- **The allowance.** `GET /v1/allowance` answers what the seat has left. An `ended`, a `failed` and
  a refusal carry it too, or null where the service could not read it. Clients validate its wire
  types, formats and enums, never its arithmetic or the service's tier and transcription policy.
- The client never makes a call under a second `callId` for the same round (INV-2).

## §5 The turn

A product's send hands the engine a turn: its `turnId`, its seat, the question, the pictures and the
profile. The engine runs it in this order.

1. **Open.** The tool host writes the turn's records in one local write: the person's message, the
   Coach message in state `running` whose id is the `turnId`, and the mark (D-6). On the web the tab
   first takes a browser lock named for the `turnId`, and holds it until the turn ends.
2. **First content.** The tool host gives the history, the context and the pictures. The engine
   builds one user message holding, in order: the history as one text part, the context, each
   picture as an image part that names a picture the client uploaded, and the question. Every word around them is the profile's. The
   request's `system` is the profile's prompt, and its `tools` are the profile's, in the order the
   profile gives them.
3. **A round**, for each of `1..MAX_MODEL_CALLS`:
   1. If Stop was asked, end the turn `stopped`.
   2. Mint the round's `callId`. In one local write, write the text so far to the Coach message
      and the `callId` and that text's length to the mark.
   3. Call the text door with the working conversation, the profile's model class, effort, output
      cap and floor, and `cache: true`.
   4. Hand each `text` delta to the tool host as it arrives. The host writes the text so far to the
      Coach message at the pace the product sets.
   5. On `ended`, append its `message`, `carry` included and unread, to the working conversation.
      Then by its `stop`:
      - `completed`: end the turn `completed`.
      - `tool_calls`: pass each call, in order, through the gate (§6). Run each admitted call on the
        tool host, one at a time, in order. Append one tool message that answers every call: an
        admitted call with its result as text, a refused one with its code and sentence as an
        error. Continue.
      - `truncated`: end the turn `completed` with `truncated`.
      - `declined`: end the turn `declined`.
   6. On `failed`, on a refusal, or when the answer is lost for good (§4.2), end the turn `failed`
      with the code.
4. Reaching `MAX_MODEL_CALLS` without `completed` ends the turn `failed` with `model-call-limit`.
5. **End.** The tool host writes the end in one local write: the state, the whole text,
   `truncated`, the code, and what the product derives from the calls. The same write clears the
   mark. Every end keeps the text that arrived and every write an ability made.

**A turn that never began.** A turn is withdrawn, its records removed and its question and picture
returned to the field, only when the engine knows the service admitted nothing for round 1: the
pass door refused before any call was sent, the text door's refusal proves it (§4.2), or the device
reported no connection when round 1 was to be sent, so nothing left it. A turn sent with no
connection is therefore returned to the field at once, with or without a pass in hand, and Coach
says it needs a connection (R-6). A connection lost after a round was sent is asked for again as §4.2 says. A turn
whose round 1 may have been admitted is never withdrawn: it ends `failed` with the code the engine
was given, or `interrupted` when it was given none, with its question on the record.

**Offline before dispatch.** A turn begun while the device reports no connection sends nothing and
is withdrawn at once: the engine asks before round 1 writes its mark, uploads a picture or fetches a
pass (R-6). A failure while obtaining a first pass or uploading a picture likewise returns the
unsent question and picture to the field promptly. With no refusal code this is an `interrupted`
outcome whose records are withdrawn. Once the text transport is invoked, a connection error cannot
prove the request was unsent: the record stays and the same call is asked for again. No working
conversation is persisted for this retry.

**Stop.** Stop takes effect before the next round or the next ability call. The round in flight is
read to its end and paid for, as the service reads every call to its end
([AI service INV-8](ai-service.md#52-a-calls-life)). A round that ends `completed` completes the
turn. A round that ends `tool_calls` has its calls discarded, and the turn ends `stopped`. Stop
pressed while the engine is asking again ends the turn `stopped` with the text that arrived.

**The process ends.** A reload, a closed tab, a killed app or a crash loses the working
conversation (P-5). When the engine next starts and its mark names a Coach message that is still
`running`, it reads the marked round's answer with `GET /v1/calls/{callId}/result`. It never sends
the round's `PUT` again: it no longer holds the request.

- An answer that ends `completed`, `truncated` or `declined` ends the turn so, its text placed
  after the bytes the mark says came before that round.
- An answer that is `failed` ends the turn `failed` with its code.
- Everything else ends the turn `interrupted`, with the text that had arrived: an answer that ends
  `tool_calls`, an answer the service no longer holds, a pass or a read refused, and no answer
  within `ASK_AGAIN_FOR`. A recovered `call_unknown` is also an expected interruption with no
  failure report: the process may have ended between writing its mark and sending its request.

A recovered turn is never withdrawn, and a turn is not otherwise resumed. A round in flight when
the process ended is paid for. (R-4)

Recovery measures `ASK_AGAIN_FOR` from the recovery attempt's start; the mark holds no dispatch
time. A mark with no `callId` ends `interrupted` without making a service request. A live client
that exhausts its asking-again deadline gives the engine `answer-timeout`, retaining its admission
certainty.

**The device sleeps.** A process that stayed alive while its connection dropped asks for the round
again. A phone holds the platform's lease for work in progress while a turn runs, as
[phone-hosted Coach abilities](mobile/gym_coach.md) §4.5 says.

**The seat changes.** A sign-in, a sign-out or a change of the active replica ends a running turn
`interrupted` and drops the pass (INV-1). The end is written when the change begins, before a
sign-out sends what the device still holds, so the account's record carries it.
The caller awaits this barrier before replacing the seat or credentials. The host guards every
write and ability execution against that turn's seat and record identities within its commit;
a late response cannot write through an invalidated seat or recreate a removed record. A removed
record completes the barrier normally. Stop and seat validity are checked again while holding the
ability mutation lock, before an execution is counted or started.

**A record gone.** A Coach message removed under its running turn, as when the conversation is
deleted on another device, ends the turn. Nothing is written, and nothing is reported as a failure.

**One writer.** Only the device that opened a turn writes its Coach message's text and end, and on
the web only the tab that holds the turn's lock. Another tab shows the turn as answering elsewhere.
A tab recovers a marked turn only after it has taken that turn's lock, asking for it without
waiting, so two tabs never recover one turn. Another device shows a `running` turn as answering on
another device.

**A turn nobody ends.** A device that never returns leaves its turn `running`. Every device of the
same person, whenever it has synced, MUST end a `running` Coach message that no write has reached
for `TURN_STALE`, by writing `interrupted` and nothing else. The age is measured on the server's
clock: from the server's time of the message's last change, which every sync client holds for a
record, to the device's clock corrected by the offset its sync connection measures. A device whose
sync connection is not live ends nothing, and a device's uncorrected clock never enters it. A turn
that is being answered writes its text every few seconds, so it is never stale. (R-5)

A writer that finds `interrupted` on the message of the turn it is still running goes on. Its
abilities run, and its own end, written later, stands over `interrupted` as the record's ranked
state rules (§8).

- **INV-2.** A round is made once. The engine never sends a round's request under a second
  `callId`, so nothing a device does makes the service work twice for one round.
- **INV-3.** An ability call runs at most once in a turn. A turn that loses its process never runs
  a call again.

## §6 The gate

Every ability call passes these, in order, before it runs. A refused call returns to the model as
an error result holding its code and the profile's sentence for that code, and the model continues.

| Rule | | Code | Asked of |
|---|---|---|---|
| Offered | The name is one of the profile's tools | `not-offered` | the engine |
| Seat | The ability admits the turn's seat | `seat-required` | the tool host |
| Shape | The input validates against the ability's schema at every depth | `invalid-input` | the tool host |
| Once | At most the stated number of calls succeed in a turn for each group the profile names | the group's, as `one-proposal` | the engine |
| Volume | At most `MAX_ABILITY_CALLS` calls in a turn, and at most `MAX_WRITES` of those the profile counts toward the write cap | `coach-turn-volume` | the engine |
| Product | Whatever more the profile's tool host refuses | the host's | the tool host |
| Stop | After Stop, every remaining call is refused | `stopped` | the engine |

- The gate guards a person's data against the model, not against the person, who can make every
  change the gate refuses with their own hand. It is therefore right on the device, and neither the
  AI service nor the backend relies on it: what the server accepts of a device's writes is checked
  where the server admits them.
- A product's executor MAY check again what the gate checked.
- Volume counts calls admitted to execution, including executions the host then refuses; a gate
  refusal consumes no volume. Once groups count successful executions only.
- A tool is sent to the provider with its input schema. Whether the provider enforces that schema
  is the AI service's to say; the Shape rule holds either way.
- Duplicate tool-call ids within one terminal message are `invalid-answer`, a defect refused before
  any call from that message runs. Transport replay never dispatches an already executed call again.

## §7 Access

The engine maps what the pass door and the AI service answer onto a small set of states. The words
for each are the product's.

| State | From |
|---|---|
| Allowance used up | `subject_exhausted`. The `allowance` beside it, when it is not null, says whether anything remains or is held, so a product can tell a spent allowance from a round that did not fit |
| Shared capacity used up | `free_day_exhausted`, `free_month_exhausted`, with the `budgetResetsAt` of the same `allowance` |
| Busy | `concurrency_exhausted`, `rate_limited`, `busy`, `paused`, once `REFUSAL_RETRY` has passed |
| Sign in | the pass door's `unauthenticated`, `invalid_installation` and `device_bound`; the service's `device_bound` |
| Update | the pass door's `client-update-required` |
| Switched off | the pass door's `anonymous_ai_unavailable`; a 404 from the pass door, which means this server has no AI |
| Offline | no connection |
| Did not answer | `provider_unavailable`, `provider_failed`, `accounting_unavailable`, `result_gone`, `answer-timeout`, `model-call-limit` |
| A defect | `invalid_request`, `invalid-answer`, `untrusted-origin`, `unsupported-media-type`, `too_large`, `provider_rejected`, `funding_required`, `conflict`, a live `call_unknown` (not process recovery), a second `picture_gone`, every `pass_` code but one `pass_expired`: shown as did not answer, and reported |

- The engine reads `GET /v1/allowance` when Coach opens, and its `code` says before a question is
  sent whether one could be asked.
- A principal has a small number of calls in flight
  ([AI service §3](ai-service.md#3-tiers)), so a person answering on one device can be refused as
  busy on another. A turn does not meet its own limit, since a round's answer ends only after the
  call is settled. The one exception is a settlement the service is still retrying, whose answer
  says `charged` null: the next round can then be refused `concurrency_exhausted`, which passes
  (§4.2).
- No screen states an amount of money. A day an allowance returns is the `budgetResetsAt` of the
  allowance.

## §8 What a product keeps

The engine requires of a product's records, and no more:

- a Coach message whose id is the `turnId`, with its text, `truncated`, and a state of `running`,
  then `interrupted`, or one of `completed`, `declined`, `failed` and `stopped`, ranked so that an
  end the writer wrote stands over `interrupted` and both stand over `running`, as gym's `message`
  ranks it ([sync engine](engine.md) Appendix A);
- a mark (D-6);
- the writer's replica on the Coach message, so another device knows the turn is not its own;
- the server's time of the Coach message's last change, and the offset between the device's clock
  and the server's, as the sync engine's clients hold them.

- **INV-4.** Nothing of the working conversation is written to a record or a device row: not an
  assistant message's `carry`, not an ability's full result, not the system prompt. A `callId` is
  not part of it: the mark holds one, and it opens nothing without a pass.

## §9 Vectors

`packages/api-contract/agent/turns/` holds one file a story. A story gives a profile, a seat, what
the tool host answers for the open and for each ability call, and for each round what the service
plays: its events, a refusal, or a stream that breaks and what asking again then finds. It expects
the exact request of each round apart from its `callId`, the gate's refusals, the host's calls in
order, the mark at each step, and the end.

- The stories cover: text alone; two rounds; several calls in one round; each gate rule; round 1
  refused; a later round refused; a refusal that passes and one that does not; each `stop`; `failed`
  with each provider code; a round lost before and after its first event, found again, found gone
  and found unknown; `pass_expired` once and twice; a picture the service no longer holds; Stop before a round, during one that completes,
  during one that calls tools and while asking again; the process ending in a last round and in one
  that calls tools; the seat changing; the record gone; a stale turn ended by another device while
  its writer goes on.
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
  unexpected failures report under `ai-pass`; a recognized temporary pass refusal is quiet on the
  client because the backend reports its originating failure. Proxy errors treated as loss and
  recovery `call_unknown` file no Issue. A refusal a person can act on is an event and never an Issue.
  Unexpected host or runtime failures report under `agent-host`; a removed record or stale seat is
  an expected interruption and files no Issue.
- The backend logs one line for each pass it signs or refuses: operation `ai.pass.sign`, the kind
  of principal, the plan, the client, the use and its version, the outcome or code and the
  duration. It logs nothing else of a turn.
- Nothing logs or reports a pass, a `callId`, a prompt, a question, an answer or an ability's
  result.

## §11 Values

| Name | Value | Whose |
|---|---|---|
| `PASS_LIFETIME` | 10 min, the service's `PASS_MAX_LIFETIME` | the pass door's |
| `PASS_REFRESH` | 60 s | the AI client's |
| `ASK_AGAIN_FOR` | 20 min, the service's `CALL_TIMEOUT` and `RESULT_LINGER` together | the AI client's |
| `REFUSAL_RETRY` | 30 s | the AI client's |
| `TURN_STALE` | 30 min | the engine's |
| `MAX_MODEL_CALLS`, `MAX_ABILITY_CALLS`, `MAX_WRITES` | set by the profile | the profile's |

## §12 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | Where the turn runs | On the device: the loop, the gate and the prompt. Each model round is a call to the AI service. (2026-11-14) |
| R-2 | One Coach or one a product | One engine; a separate Coach in each product with its own prompt, abilities and conversations. (2026-11-14) |
| R-3 | How long a pass lasts | 10 minutes. A sign-out, an erased account and a change of plan therefore reach the AI service within 10 minutes and no sooner (AI service INV-2). (2026-11-15) |
| R-4 | A turn whose process ends | Its answer is recovered when the round in flight was the turn's last and the service still holds it; otherwise the turn ends `interrupted`. Carrying on a turn that was still calling abilities would need the working conversation written to the device, which P-5 rules out. (2026-11-15) |
| R-5 | A turn its device never ends | Any of the person's devices ends it `interrupted` once no write has reached it for 30 minutes by the server's clock. No server ends a turn. (2026-11-15) |
| R-6 | A question sent with no connection | It returns to the field at once and Coach says it needs a connection. Nothing is left trying. (2026-11-17) |
