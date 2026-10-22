# Coach conversation contract

The `/v1/gym/ask` JSON route accepts `{thread, question, requestId, purpose?, routineReview?}`. Questions are at most 8,000 UTF-8 bytes; invalid UTF-8 and NUL bytes are refused. `purpose` is `conversation` by default or `routine_setup`; setup clients keep that purpose on subsequent turns in the same setup conversation. An omitted purpose inherits the stored purpose on a retry, so older clients can reopen setup exchanges. An explicitly supplied purpose is immutable on a request retry and is emitted on generations and history turns only when it is `routine_setup`. `requestId` is a client-minted 8–64 character ASCII identifier containing letters, digits, `_` or `-`. Persist it with the draft before sending and reuse it, the same thread and the same question after a timeout, reconnect or retry. A different question requires a different request ID. Clients without `requestId` remain accepted; each legacy request is a new generation and cannot recover an ambiguous submission by identity. `routineReview` is a boolean: a client that renders routine drafts and their Save routine control sends `true` on every ask, retries included. The generation keeps the value its request created it with, and a generation without it is never offered `create_routine`; its prompt says new routines are not saved from that app version and the lifter can update the app or build the routine in Routines. A non-boolean value is `400`.

A completed reply contains `answer`, `steps`, `read`, `proposals`, `thread`, `receipt`, `generation` and `results`. `generation` contains `id`, `requestId`, `question`, `status` (`running`, `completed`, `failed`, `stopped`), `answer`, `at` (the original question acceptance time in epoch milliseconds), `steps`, optional `receipt`, and `results`. A result has `{kind:"routine-created", operationId, routineId, routineName, movementCount?}`. `movementCount` counts entries in the durable original creation document; it is absent on older receipts. These values are server-observed durable facts, including when answer generation fails after creating a routine. Open a result using the routine route and handle a routine that was subsequently deleted.

The server replays the stored completed reply for the same request without another model run or charge. Reusing a request ID with a different question, attachment set or purpose returns `409 ask-request-conflict`. One generation can run in each conversation. A retry while that generation is active receives `202` with its generation snapshot; a different request receives `409 ask-generation-active`. A failed generation returns `502` with `generation` and completed `results`, alongside the human-readable error. A retry of that request resumes the same generation and reconciles its persisted tool operations before asking the model again. `202` is pending, never a completed answer: retry the same request with backoff or read the conversation snapshot. Admission runs independently of model work, with two model slots and at most 64 queued admission requests per process. A request arriving while a different local request owns its conversation remains refused even if that generation finishes before admission reads the database. When capacity is full, new work returns `503 ask-busy`; stored completed/stopped replies and active-request snapshots remain readable through admission. If the admission queue itself is full, the refusal can precede the stored-generation read and omit a snapshot. Retry with backoff and preserve the same request ID and payload.

`GET /v1/gym/threads?limit=50&cursor=<cursor>` returns `{threads, nextCursor}`; `nextCursor` is null when no more rows remain. Pass it unchanged to fetch older conversations. Limits are 1–200. Omitting pagination parameters returns `{threads}`. The order is newest activity first, with thread ID as a stable tie breaker. Resume any row by submitting its ID to `/ask`.

`GET /v1/gym/threads/:id?limit=50&before=<cursor>` returns the thread object, with `turns` in chronological order for the latest page, `nextCursor` (null at the beginning), and its latest `generation`, when present. Pass the cursor as `before` to load older messages. Limits are 1–200. Messages include numeric `position` and, for durable generations, `generationId`, `requestId` and `status`. Assistant messages also carry immutable `results` using the shape above, plus optional typed `clarification` and `allowanceRefusal` from their generation. Merge pages by position and prepend older messages. Message page sizes round up to an even count from 2–200 so each page contains complete exchanges. Omitting pagination parameters preserves the complete legacy thread read. Terminal message pairs are persisted atomically, including failed questions and partial or empty failed answers. Retry updates that same pair at the same positions. Running questions live in `generation` until terminal persistence; reconcile them by generation ID when the pair arrives. A failed answer remains marked `failed` even when its text is empty, and its request ID supports safe retry.

Thread outcomes include `created` when the conversation created a routine; `changes` then counts created routines and a sole result carries its routine identity. Full history remains stored. Model context uses the newest successfully completed exchanges, at most 24 messages and 24,000 text bytes, plus the current question and freshly read Notes/log data. Historical receipts, routine results and proposals remain available in stored history even when their text is outside model context. Coach does not claim to have consulted discarded text.

For a client that reviews drafts, Coach can prepare up to six requested routine drafts, mint one existing-routine proposal and save one useful new user-provided insight per generation. The server requires successful Notes and movement-catalog reads before routine creation and a Notes read before an insight save. It persists each operation with its chosen ID and complete arguments before executing it, and its observed result before model continuation. Routine additions use ordered durable action slots and server-owned routine IDs. Repeated calls in one run reuse their original slot; a changed document is refused. After interruption the model must replay each held document in order before adding new routines, even if it invents different model IDs. Failed durable attempts count toward the six-slot cap. Syntactically invalid documents are rejected before reserving a slot. The operation collection also reads legacy single-operation records. Existing routine changes still use proposals and human Apply. A retry recovers those same operations and never chooses a new routine or note-save ID. Generation exclusion uses a database session lock, released on process exit; retrying the same unfinished request after restart recovers it. Deletion during an active generation returns `409 ask-generation-active`. Deleting a conversation removes its generations and messages and preserves routine, saved-note and applied-proposal consequences.

Refusals after reading a known generation retain `generation` and `results`, including later allowance or model-capacity refusals. Never discard an accepted or ambiguous request ID because a retry is refused. Deleted conversation IDs remain unavailable through an account-cascaded tombstone; delayed asks return `409 ask-thread-taken` and cannot recreate the conversation.

## Routine setup choices

Only `routine_setup` exposes `ask_setup_details`. It persists a typed question in the existing generation payload, with no additional workflow table. The optional `clarification` is `{id, question, groups:[{id,label,multiple,options:[{id,label}]}]}` and is also present on successful buffered replies. The server assigns `clarify_<generation-id>`; repeated calls must keep the same question and choices. Assistant history reads the same payload through an owner/thread/generation-scoped join.

Routine setup uses a focused tool catalog: `list_sessions`, `get_sessions`, `list_notes`, `save_note`, `list_exercises`, `list_routines`, `create_routine` (for a client that reviews drafts) and `ask_setup_details`. These retain owned training history, standing constraints, movement metadata and existing plans while creating new routines. Other tools, including existing-routine change/removal proposals, are refused at dispatch during setup. Ordinary conversations retain the full Coach catalog. Both purposes use the same prompt for the same `routineReview`, and the same model loop, authorization and durable action receipts.

Questions have 1–500 UTF-8 bytes, labels 1–80 bytes, and blank or unstorable text is refused. There are one or two distinct groups, named `days` or `equipment`, each with one to six options. `days` is single-select. Option IDs are unique within a group, 1–32 lowercase ASCII letters, digits, underscores or hyphens. Unknown properties and arbitrary UI actions are refused. Choices fill an editable draft and cause no network work until explicit Send. The model includes its question in prose for older clients. It uses supplied facts, asks only for materially missing days/equipment and offers mutually compatible multi-select equipment items.

## Streaming and pictures

Set `stream:true` on the ordinary ask body and supply a stable `requestId`. The response is `text/event-stream`, with `Cache-Control:no-cache` and proxy buffering disabled. Every visible event is named `snapshot`, carries `id: <generation-id>:<revision>`, and has JSON `{thread,generation}`. `generation` includes the fields above and monotonic numeric `revision`; `answer` is the complete current visible answer text. Replace that generation's text on each snapshot; never append the entire snapshot. Internal thinking and tool arguments are never sent. A reconnect repeats the same POST and begins with the authoritative snapshot, so clients need not retain every event. Ignore revisions already rendered. A terminal `completed`, `failed` or `stopped` snapshot closes the stream. Refusals before a generation exists use an SSE `error` event containing the ordinary `{error,status,code?}` body and close. Heartbeat comments keep idle connections open.

`POST /v1/gym/threads/{thread}/generations/{requestId}/stop` has an empty body. It requests cancellation and returns `{thread,generation}`. A running reply may include `stopRequested:true`; cancellation becomes final at `status:"stopped"`. Stop preserves partial text and completed routine/proposal/note actions. After a process restart, Stop reconciles already committed actions without executing an uncommitted pending write. A stopped request replays its terminal snapshot and does not restart; continuing is a new message/request ID. A failed request may retry the same ID. Disconnecting the client leaves the server generation running so reconnect can recover it. Stop is owner-scoped and idempotent; a missing/foreign request returns 404.

Upload one picture with `PUT /v1/gym/threads/{thread}/attachments/{attachmentId}`. The body is the original image bytes, with `Content-Type:image/jpeg` or `image/png`; IDs follow the same 8–64 character rule. Limits: 5 MiB encoded, 4096 pixels per edge, 16,777,216 decoded pixels. JPEG and PNG are decoded and validated (including PNG chunk CRCs); filenames/extensions are not trusted. Clients should convert unsupported picker formats to JPEG/PNG and retain the draft on upload failure. The response is `{attachment:{id,mediaType,width,height,bytes}}`. Repeating the same ID and same bytes replays the metadata; a changed payload with that ID returns 409. Upload alone creates no conversation or title. At most 30 new images may be uploaded per account in a trailing 24-hour window (`429 ask-image-limit`); identical replays do not count again. Two upload workers and a four-request in-flight bound protect request loops; a temporarily full queue returns `429 ask-image-busy`.

Add `attachmentIds:[attachmentId]` to the ask body (maximum one). The question may be empty when a picture is present. The first title is the question verbatim, or `Photo` for an image-only question. The generation and its user message carry `attachments:[{id,mediaType,width,height,bytes}]`; text and image references together are the request's immutable retry payload. The full image bytes are stored once privately, never duplicated as base64 in conversation history. `GET /v1/gym/threads/{thread}/attachments/{attachmentId}` returns the original validated bytes with a private/no-store cache policy, and returns 404 for absent/foreign images. Linked images live with their conversation and cascade on conversation/account deletion. Abandoned unlinked uploads expire after 24 hours; cleanup on subsequent uploads never removes an image linked to retained history. Model context includes at most the three newest pictures within its text context, including the current picture.

## Provider transport and usage

Coach uses incremental Anthropic Messages responses for both streaming and buffered clients. The server-owned `COACH_ANTHROPIC_BASE_URL` defaults to `https://api.anthropic.com`; tests may set a loopback HTTP endpoint implementing the same protocol. It never selects a canned Coach response path. Visible text from tool rounds remains in the ordered answer; thinking and signatures stay internal.

Each Opus 5 round uses the configured `COACH_MAX_OUTPUT_TOKENS` ceiling, default 2,000. The USD reservation includes that entire ceiling plus estimated input. Valid configuration is 1,024–8,000 tokens. Reaching the ceiling is a failed generation, with charged usage and completed routine receipts preserved.

The usage ledger preserves every input, cache and output token count reported by the vendor. Interrupted streams may end before the final cumulative output count arrives, so those observed counts can be incomplete; they are not represented as exact final billing. A stream that reached `message_start` counts as a model turn and does not refund the daily question ration.

## Coach Notes saves

`save_note` is a `gym:write` tool accepting `{id,title,body}`. It appends a useful NEW insight actually supplied by the user, using their own wording for constraints, at bottom precedence. It never edits, deletes or reorders an existing note. Coach must first read Notes and avoid repeating existing information. Bounds match Notes: ten per account, 1–60 Unicode code points in the trimmed title, at most 500 UTF-8 bytes in the trimmed body. Exact title/body duplicates reuse the existing note without moving or redating it, including at capacity.

Coach assigns `note_<generation-id>` and an independent `op_note_<generation-id>` operation identity. The tool returns `{saved:true,note:{id,position,title,body,updatedAt}}` only after a durable save. The receipt in `gym_note_saves` is owner-scoped and written atomically with the note insert or exact-text deduplication. Reusing an ID with different text is refused. Original receipts survive user edits/deletion so a lost-ack retry cannot overwrite or resurrect a note. They cascade on account deletion. A successful replay proves the original save, not the note's current presence; the model receives that distinction on recovery. Note saves appear in generic tool steps and the durable operation receipt, without a conversation `results` entry.

The conversational prompt in `AnthropicAsk.cpp` welcomes natural dialogue, practical questions and useful follow-ups. It retains factual tool, privacy and context rules. They require equipment/variant clarity and honest movement-pattern coverage, and keep internal IDs and tool narration out of replies unless useful to the user. The runtime still fetches current sessions and Notes before making a model request.

## Routine review and exercise edits

New routines remain drafts until the user reviews and saves them. Generations and their assistant
turns carry `routineDrafts:[{operationId,routineId,name,position,entries,state}]`; entries use the
existing routine entry shape and `state` is `pending` or `saved`. Drafts survive interrupted answers
and retries. They are not routine-created results.

`POST /v1/gym/threads/{thread}/generations/{requestId}/routines/{operationId}/confirm`, with `{}`,
authenticates the owner and applies the exact server-held draft. A draft is checked against the
movement catalog when Coach prepares it and again when a retry recovers it; a draft that fails the
check is stored as a failed action and never offered. Outcomes:

| Status | `code` | Meaning | Client |
|---|---|---|---|
| 200 | — | `{thread,generation,results}`: the draft is saved, including when an earlier or overlapping confirmation saved it | show the saved routine |
| 400 | — | malformed thread, request or operation id | — |
| 401 | — | signed out | sign-in note |
| 404 | `coach-draft-not-found` | no such draft for this account (absent and foreign are one answer) | "This draft is no longer available."; hide Save |
| 409 | `ask-generation-active` | Coach is still answering that request | retry copy |
| 409 | `routine-save-in-progress` | another confirmation still holds the conversation after a bounded wait | retry copy |
| 422 | `coach-draft-invalid` | the held document cannot be written: a movement it names is gone or its routine id is taken | "This draft can’t be saved. Ask Coach for a new one."; hide Save |
| 503 | `gym-engine-busy`, `gym-engine-unavailable` | the engine could not take the write now | retry copy |
| 503 | — | unexpected failure | retry copy |

Retry copy is "Couldn’t save the routine. Try again."; a lost reply never asserts the routine was not
saved. A double tap waits for the first confirmation and answers 200 with the same saved draft. The
server uses the same routine identity and immutable creation receipt for every retry, including after
later user edits or deletion. No model tool can call confirmation. Existing routine revisions still
require Apply.

`update_exercise` accepts `exerciseId` and optional `name`, `equipment` and `loadCount` (1 or 2).
An optional `requestId` makes an edit replayable without overwriting later changes. Coach supplies
this identity; the sync door commits the original result with the edit, and recovery reads that receipt.
Coach reads the catalog first and makes these edits only when the user requests them. Stable IDs
keep all historical sets together. Equipment controls load interpretation: barbell includes the bar,
dumbbell is per dumbbell, bodyweight is added load. Volume multiplies working-set load by the declared
number of dumbbells; it never changes the recorded kg, reps or one-rep-max units.

## Anonymous Coach dialogue

The installation-scoped API supports dialogue and routine drafts before sign-in. It reads the public
seed exercise catalog, makes one bounded model call, and returns an assistant message with optional
validated routine drafts. It
does not create an account, a Coach conversation, a server routine or a stored photo. Account Coach,
history, attachments and account tools still require account authentication.

Obtain a credential from `POST /v1/ai/installations` with `{}` and retain its opaque `credential`.
Send it as `X-Windmill-Installation` on the following requests. Malformed or conflicting account
credentials are refused even when an installation credential is valid. The installation is a
server-issued signal, not hardware attestation; resetting local credentials can evade device identity.
IP admission and shared free budgets bound that exposure.

`POST /v1/gym/coach/onboarding` accepts exactly one of these shapes:

```json
{"requestId":"12345678-1234-1234-1234-123456789abc","mode":"conversation","text":"Hello","context":[]}
{"requestId":"12345678-1234-1234-1234-123456789abc","mode":"goal","goal":"Build general strength","daysPerWeek":3,"equipment":"gym"}
{"requestId":"12345678-1234-1234-1234-123456789abc","mode":"program","program":"Bench Press 3x8"}
{"requestId":"12345678-1234-1234-1234-123456789abc","mode":"photo","image":{"mimeType":"image/png","data":"<base64>"},"note":"Preserve my program"}
```

Conversation text is at most 4,000 UTF-8 bytes and may be empty only with an image. `context` holds
at most twelve `{role:"user"|"assistant",text}` messages, each nonblank and at most 4,000 bytes,
with a total 16,000-byte text bound. An optional `image` uses the same validated photo shape below.
The goal/program/photo modes remain supported for existing clients.

Persist a lowercase UUID `requestId` before sending; reuse it and the exact input after a timeout or
relaunch. Goal text is 1–1,000 UTF-8 bytes and requires 1–6 weekly days plus equipment. Supported goal
equipment is `gym`, `dumbbells`, `barbell` or `bodyweight`. `bands` and `other` produce the durable
`unsupported_equipment` failure before provider dispatch. Program text is 1–4,000 bytes. Photo notes
are optional and at most 1,000 bytes. Photos are base64 JPEG or PNG, at most 1 MiB decoded, at most
4,096 pixels on either edge and 16,777,216 pixels total. The backend checks signature, PNG checksums
and complete image decoding. Accepted JSON bodies remain below Drogon's 2 MiB in-memory threshold;
accepted photos are held in memory and sent inline to the provider, with no application upload file.

New work returns `202` with `status:"pending"`. A terminal POST replay returns `200`.
`GET /v1/gym/coach/onboarding/{requestId}` returns `200` for every stored state and `404` for an absent
or another installation's request. Both routes return this shape with private/no-store caching:

```json
{
  "requestId":"12345678-1234-1234-1234-123456789abc",
  "resultId":"onb_<stable digest>",
  "status":"completed",
  "expiresAtMs":1800000000000,
  "message":"Here is a draft to review before saving.",
  "routines":[{"name":"Push","entries":[{"exerciseId":"bench-press","sets":[{"reps":8,"weightKg":null}],"restSeconds":120}]}],
  "errorCode":null,
  "allowance":{"code":"ok","currency":"USD","period":"lifetime","tier":"anonymous","configured":true,"limit":"0.050000000","used":"0.012000000","reserved":"0.000000000","remaining":"0.038000000","resetsAtMs":null,"budgetResetsAtMs":null}
}
```

`status` is `pending`, `completed`, `failed` or `expired`. `message` is the assistant reply, at most
4,000 UTF-8 bytes for conversation mode: the model is asked for at most 1,200 characters, and a longer
reply is clipped after its last whole word within the bound and ends with `…`. `routines` is empty until completed and may remain empty
for ordinary dialogue;
`errorCode` is null unless failed or expired. Poll at one-second intervals with the same credential.
Pending work becomes terminal after a 15-minute lease, including after a server restart. Replaying a
request never dispatches it again, including terminal failures. Changing input under the same ID
returns `409 request_conflict`. Clients must not automatically mint a new ID after failure.
The rollout switch stops new claims with `503 anonymous_ai_unavailable`; existing POST replays and
GET recovery remain available. Binding also preserves GET recovery.

A result with routine drafts contains 1–3 reusable routines, at most six distinct seed exercises per routine and at
most eight explicit set targets per exercise. It does not promise a six-day calendar. Names are
nonblank and at most 80 UTF-8 bytes. Reps are 1–100 or null, rest is 15–600 seconds or null, and kg
weights are finite numbers within the domain's −500 to 500 range, with at most two decimal places,
or null. Negative loads represent explicitly supplied assistance. Goal generation always returns
null weights. Program/photo instructions preserve supplied targets and leave unknown values null;
an empty `sets` array means the source omitted a set count. Unreadable, unsupported or oversized
programs return `insufficient_details`; incomplete model output returns `output_truncated` without
partial routines. Domain validation rejects invented IDs, duplicate exercises and malformed values.

The installation receives $0.05 of lifetime actual provider cost. Every call reserves its estimated
maximum before dispatch against that allowance and the free $5/day and $100/calendar-month pools,
then settles actual usage, including charged failures. Unknown provider outcomes retain their hold.
The current allowance accompanies stored results; an original refusal retains its own code and
original global reset time in `budgetResetsAtMs`. This distinguishes a shared daily/monthly pause from
lifetime exhaustion. A separate technical bound admits eight new request IDs per installation per
UTC day (`429 request_limit`); it does not renew the lifetime dollar allowance.

The server retains validated result content for seven days. A compact request digest and terminal
identity remain after expiry so an old request can never redispatch. No prompt or image is persisted.
Native clients retain completed drafts for review. Only explicit Save atomically imports the selected
result’s routines into the local engine together with a `resultId` replay receipt. A retained draft
can also be saved after account adoption. They can start a workout before sign-in after saving. Keep/sign-in and the existing
Add/Discard flow adopt those local records through sync. `POST /v1/ai/installations/bind` attributes
anonymous spend to the verified account; sign-up grants no second anonymous allowance.

The model is `claude-sonnet-5` with adaptive thinking, low effort, structured JSON output and a
2,000-token total output ceiling, reduced when the remaining allowance requires it. The provider's
[model overview](https://platform.claude.com/docs/en/models/sonnet-5/overview) lists it as active
(legacy), supports image input and adaptive thinking, and prices input/output at $2/$10 per million
tokens. [Effort guidance](https://platform.claude.com/docs/en/build-with-claude/effort) explicitly
supports low effort for Sonnet 5.
[Structured-output compatibility](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
includes Sonnet 5 and defines `output_config.format` with `type:"json_schema"`.
[Thinking cost controls](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)
make `max_tokens` the hard ceiling for thinking plus response text. These capabilities do not prove
routine quality or completion within the ceiling; the manual live verification exercises a
representative three-routine goal and two-routine program/photo without automatic paid retries.

## Structure observations

The generation payload owns setup purpose, clarification and allowance refusals; message reads derive those fields from that payload. Durable action slots reuse the existing operation list and creation receipts, keeping recovery and normal execution on the same Gym write door. Routine creation limits are a domain constant; text and choice validation stays in domain types while JSON shape validation stays at the adapter boundary. The bounded native `gym_setup_step` event uses the generic first-party intake and the native telemetry allowlist.

Anonymous onboarding is one feature package: pure input/result bounds, durable operation repository,
service orchestration, provider and HTTP boundaries. Explicit `seedCatalog()` prevents account-shaped
placeholder IDs from entering public catalog reads. The result receipt belongs to the local engine;
the server stores generation outcomes and cost accounting without a second routine ownership path.
