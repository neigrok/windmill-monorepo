# AI client

`AiClient` supplies `text`, GET-only `result`, `allowance`, and `clearPass`. It is independent of the
turn runner's records. A text request is serialized once and retried with the same call ID and
identical body. Event IDs deduplicate replay; the first observed event changes later requests to
result GET. Admission certainty only rises. Transient refusals retry for 30 seconds; a lost answer
is read for 20 minutes from the first PUT, or from recovery start. No retry begins at the deadline.
Stop only cancels the wait between attempts. A pass-expired or picture-gone repair happens once.

Passes are in-memory and cached by use/version with a 60-second refresh margin. A generation fence
discards late pass responses after a seat change. `HttpAiTransport` sends account cookies and the
optional `X-Windmill-Installation` credential only to the backend pass door. Service text, result,
allowance and picture requests use only the Bearer pass, omit cookies, and refuse redirects without
following them. Picture uploads carry raw PNG/JPEG bytes; requests reference their picture IDs.
The SSE decoder validates complete event shapes and handles split UTF-8 and CRLF frames.

The default failure reporter uses `telemetry/sentry.js` under static `ai-pass` or `ai-call`.
Injected telemetry sees only that operation; it never receives an exception, credential, request,
call ID, content or service error text. Expected actionable refusals return to the caller and do not
produce Issues. Product turn events are the runner's telemetry port, not named by this client.

Tests replay the shared Coach stories through the real client, check every AI terminal, allowance
and refusal fixture, exercise clock deadlines without sleeping, and verify cookie isolation and
lock behavior in Chromium. No CI test calls a provider.
