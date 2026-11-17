# AI client

`AiClient` supplies `text`, GET-only `result`, `allowance`, and `clearPass`. It is independent of the
turn runner's records. A text request is serialized once and retried with the same call ID and
identical body. Event IDs deduplicate replay; the first observed event changes later requests to
result GET. Admission certainty only rises. Initial and resent PUTs retry transient refusals for
30 seconds from the first PUT. After an ambiguous dispatch, lost transport, temporary pass refresh
failures, busy, rate-limited and accounting-unavailable replies keep asking for 20 minutes from
the first PUT, or from recovery start. Temporary preparation loss also enters that recovery window
when a prior busy or accounting-unavailable refusal left admission possible. Other transient PUT
refusals retain the 30-second deadline; they do not restart it. A preparation result or failure
observed after the active deadline cannot extend it or dispatch text. A pass-expired or picture-gone
repair happens once; a lost repair upload retries only when admission is already possible.

Stop cancels retry waits, pass and picture preparation, and repeated text/result requests waiting
for headers or an error body. The initial in-flight text request drains. Once a successful event
response arrives, the transport detaches Stop so the stream and awaited host callbacks finish.
An event response exposes idempotent `dispose()` alongside its event iterator. The client disposes
every response in `finally`, including a seat change before iteration starts; the transport also
disposes rejected headers and completed iterators. Disposal clears the deadline, aborts the request
and cancels an unread body.

Offline behavior follows dispatch evidence. A pass or picture preparation failure before the first
text request restores the draft promptly. An attempted text request can have reached the service
even when the browser reports offline, so a cached pass can move the call into uncertain recovery.
No connectivity observer or persisted conversation is required. HTTP errors without a complete,
known service refusal envelope with its matching HTTP status are ambiguous transport loss, including
proxy HTML, unknown JSON and a lost error body. Pass refusals require exactly a known `code` and
string `error`, with the matching status. Malformed successful event streams remain wire defects and keep their
admission evidence. Recovery `call_unknown` interrupts quietly; the live equivalent is a defect.

Passes are in-memory and cached by use/version with a 60-second refresh margin. A generation fence
discards late pass responses after a seat change. `HttpAiTransport` sends account cookies and the
optional `X-Windmill-Installation` credential only to the backend pass door. Service text, result,
allowance and picture requests use only the Bearer pass, omit cookies, and refuse redirects without
following them. Picture uploads carry raw PNG/JPEG bytes; requests reference their picture IDs.
The SSE decoder validates complete event shapes and handles split UTF-8 and CRLF frames.

The default failure reporter uses `telemetry/sentry.js` under static `ai-pass` or `ai-call`.
Injected telemetry sees only that operation; it never receives an exception, credential, request,
call ID, content or service error text. Expected actionable refusals return to the caller and do not
produce Issues. Temporary pass unavailability and ambiguous HTTP errors are quiet. Product turn
events are the runner's telemetry port, not named by this client.

Tests replay the shared Coach stories through the real client, check every AI terminal, allowance
and refusal fixture, exercise clock deadlines without sleeping, and verify cookie isolation and
lock behavior in Chromium. No CI test calls a provider.
