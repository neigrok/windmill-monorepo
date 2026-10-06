# Web sync observability

The browser engine injects telemetry through `syncTelemetry`. Its defaults send events through
`src/telemetry/beacon.js` and technical failures through `src/telemetry/sentry.js`. A telemetry failure
cannot stop synchronization. The beacon adapter encodes the spec's hyphenated event labels with
underscores because `/v1/events` accepts snake_case names. Each engine instance permits at most 30 reports per rolling minute;
injected limits are capped at 100. No raw exception, stack, body, field value, ID, scope reference,
account, email or token is forwarded.

| Events | Meaning |
|---|---|
| `sync-start`, `sync-commit`, `sync-release`, `sync-undo` | Local engine and gesture steps |
| `sync-signin`, `sync-signout`, `sync-auth-paused` | Lineage decisions and authentication transitions |
| `sync-upgrade`, `sync-persist`, `sync-leader` | Upgrade stop, persistence request result and lock ownership |
| `sync-refused`, `sync-push-malformed` | Terminal refusals and malformed push responses |
| `sync-writer` | Transaction enqueue-to-durability latency and initial queue/read latency |
| `sync-digest-mismatch` | Confirmed scope digest disagreed with the server |

Properties are restricted to `scopeKind` (`product`, `tree`, `overlay`, `device`), a nonnegative safe
integer `seq`, `durationMs` and `queueMs` (capped at 60,000), and `outcome` (`ok`, `denied`, `unavailable`, `pending`, `paused`, `failed`, `acquired`,
`released`). Failures use only the static operations `storage`, `transport`, `live`, `leadership`,
`observer` and `auth`. Storage denial is explicit; no volatile fallback replaces durable work. A write
the device's store cannot commit reports `storage` once and reaches its caller as a `CommitError` of
kind `store`; an error a caller's read-and-commit function throws passes through unreported.

The shell reports cookie cleanup, session transition and auth-hint storage failures under static
`auth` operations. Opening and warming the offline shell reports `offline-shell` to Sentry.
The update-required reload emits `sync_upgrade` with `pending`, `ok` or `failed`; a failed
shell update reports the static `offline-shell-update` operation. A persisted page restore
reports storage failures and keeps its local records available for a retry.
Add/Discard and sign-out emit `sync_signin`/`sync_signout` with `outcome: pending`; the engine reports
completed transitions. Revoking this session uses the sign-out question before clearing its cookie.
Account closure persists its account and current session before the server request and discards local
account data after it succeeds. The request names the confirmed account; `account-mismatch` retains
its local data and reports the auth-session failure. A failed local discard reports the same failure; reload and
retry reconcile that session before recovering the discard. A new session keeps its cookie, including
one that reopens the same account. Closure refuses an unavailable session identity before deleting.
Offline copy identifies the REST features that need a connection.
No account identifier or decision content is included.

Journal reports migration, durable save, pending-claim reconciliation, invitation retirement and
REST transport failures using static `journal-*` Sentry operation names. Migration and recovery
emit `sync_commit` with bounded outcome labels; claim/save and first-run retirements use the engine's
gesture events. No page body, scales, date, claim identifier or account is reported.

Gym engine writes emit `gym_action` through the first-party events intake with only `operation`
and `outcome`. Operations are routine create/save, exercise create/rename, preferences save,
note save/reorder, bodyweight save, set/session correction, session import, proposal apply/dismiss,
delete, Undo and refusal. Outcomes are `saved-local`, `unchanged` (a rename to the name the store
holds, which writes nothing), `failed`, `held`, `undone`, `closed` and `refused`. A local save
records durability, not server admission. Unexpected product boundary failures use static
`gym-<operation>` Sentry names; projection failures use `gym-projection`. A gym refusal and a store
failure report no `gym-<operation>`: engine telemetry owns transport, storage, authentication and
admission failures. No workout or note content, identifiers, field values, refusal details or raw
exception messages are reported.
