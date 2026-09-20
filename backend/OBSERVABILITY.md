# Backend observability

`SENTRY_DSN` enables Sentry Issues for uncaught request exceptions and handled failures reported
through `FailureReporter`. `SENTRY_ENVIRONMENT` identifies the deployment and `SENTRY_RELEASE`
identifies its build. Unexpected request exceptions carry their compiled exception type and matched
route, excluding their raw messages. Server `LOG_*` messages are forwarded separately as structured Sentry Logs;
a log at error level does not by itself create an Issue.

Coach's model adapter reports failed vendor/tool runs. `AskService` reports unexpected model and
conversation persistence exceptions once per request, with an operation (`ask.run`, `ask.persist`,
or `ask.cleanup`) and fixed diagnostic text. Exception messages, questions, answers and training
records are excluded. Refusals such as an open workout or exhausted question allowance are normal
API outcomes. An absent vendor key leaves the Coach POST route unmounted.

The `/v1/events` endpoint accepts anonymous or authenticated client batches:

```json
{
  "sessionKey": "client-session-uuid",
  "platform": "android",
  "events": [
    {
      "id": "event-uuid",
      "name": "gym_ask_outcome",
      "clientMs": 1789550000000,
      "props": {"outcome": "failed", "failure_kind": "timeout"}
    }
  ]
}
```

`platform` is optional and accepts `android`, `ios` or `web`. When present it overrides
`props.platform` for each event and becomes Amplitude's platform field. Without it, existing event
properties are preserved. The user comes exclusively from the Bearer session or session cookie.
Names must be lowercase snake case; properties must be flat JSON within 1 KB, including the
platform. Batches accept at most 50 valid events and sessions are limited to 2,000 events per day.
Clients own their event/property allowlists and must exclude user content and credentials.

An event's optional `id` uses the same bounded alphabet as `sessionKey`: 1–64 letters, digits,
hyphens or underscores. It gives Amplitude the stable insert ID `sessionKey:id`, including when a
client retries events in a different batch. Legacy events retain their timestamp/name/index key.

`202 {"accepted":N}` means the accepted events reached Postgres. It does not confirm delivery to
Amplitude. `AMPLITUDE_API_KEY` enables forwarding and `AMPLITUDE_HOST` chooses the region
(`api2.amplitude.com` by default, `api.eu.amplitude.com` for EU). Transport errors, 429 and 5xx get
up to three attempts with the same payload, waiting one then two seconds between retries. A numeric
`Retry-After` overrides that wait, capped at 30 seconds; other errors are terminal. Exhausted and permanent
failures create a `telemetry` Sentry Issue at `amplitude.forward`. Storage and dispatch exceptions
are also reported, using fixed diagnostics without event properties or API keys.

Forwarding is held in memory, has no durable outbox and stops on process exit. Postgres keeps the
accepted rows, but no automatic replay to Amplitude runs. Repeated accepted client batches can
create duplicate Postgres rows; the stable event ID deduplicates the Amplitude mirror. An unset
Amplitude key intentionally disables forwarding.
