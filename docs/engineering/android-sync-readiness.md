# Android delivery readiness

Android checks each nonempty outgoing batch with a fresh authenticated hello before `nextPush`
assigns sequence numbers. The advertised server schema must meet the client's registry minimum.
This uses the registry contract, not a product or release number. Persisted schema remains available
to reads but cannot authorize delivery. The pinned replica/account/token is checked again under the
engine lock before numbering; a changed session cannot number the newly selected account's work.

Unknown or older servers retain ready intents unchanged. A separate `SenderWait` applies the
existing exponential jitter with a one-second minimum and honors a 503 retry floor. Commit,
foreground and leave wakeups cannot reset it; cancellation retains the floor. Once a compatible
hello arrives, delivery resumes normally. The existing older-client 426 upgrade path remains
independent. Pulls and live subscriptions keep their current behavior.

Idle, held-only and dependency-blocked work produces no delivery hello. Each nonempty push batch
costs one extra handshake. This intentionally avoids a persisted or generation-bound readiness
cache; a later optimization needs measurements and the same session-safety proof.

The rollout sequence is: ship this nonvisual prerequisite; prepare the compatible server image and
both replacement app artifacts; upload and verify iOS distribution availability; publish and verify
the Android replacement with this gate; then authorize the exact guarded server-minimum cutover.
Before cutover, the new Android client retains its writes locally. After cutover, its next successful
hello releases them. The cutoff still requires verified upgrade availability. Once new-category data
exists, maintenance and rollback images must retain the new schema and minimum. This prerequisite
changes no registry and performs no production cutoff.

Expected compatibility waiting has no new event, refusal, issue or UI. The normal user action event
records the local save. Existing hello transport telemetry covers actual faults and is bounded to
static operation, outcome, failure kind and status; account, replica, intent, token and content are
not emitted.

## Verification

- The complete Debug and Release sync-engine suites each pass 191 cases with zero failures or
  skips. Eight new cases cover additive client versions, exact old-server retention and one-time
  delivery, cached/unknown schema, cancellation and retry floors, idle/held/dependent work, account
  changes during hello, read continuity, and both HTTP-200/newer-minimum and 426 upgrade precedence.
- The HTTP transport regression uses real local HTTP requests: schema 7 yields no push, schema 8
  delivers the identical numbered intent once, and the newer client minimum stops subsequent work.
  Header, route, complete intent, retained entry and telemetry assertions are explicit.
- A temporary local-stack probe used the verified sign-in backend binary (schema 7 / minimum 4),
  isolated port 8108 and a fresh Postgres database. Client 7 / minimum 4 delivered an actual weigh-in;
  client 8 / minimum 8 retained its exact ready entry, sequence and identity with no refusal or fault.
  The backend emitted one successful `sync.push` observation for the delivered write and three
  `sync.hello` observations including the startup readiness check. The probe
  reported no engine refusals/failures. No product event or hosted Sentry delivery is claimed for
  this nonvisual flow. Its backend, database, credentials and temporary test source were removed.
- Layering passes: 12 projects, eight JVM modules, eight rejected model attacks, 55 rejected source
  attacks, five allowed fixtures, and zero findings across 489 deterministic-module classes.
  Diff whitespace checks pass.

Adversarial review checked account changes while hello is in flight, cached readiness, malformed
or unreachable responses, lower-bound upgrade precedence and retry wakeups. The fix pass made the
upgrade precedence explicit and covered it independently. Simplification reuses the existing
sender wait and held-dependency calculation; no engine/transport API or readiness cache was added.
The extra handshake is an explicit per-batch tradeoff; no native timing or hosted release claim is
made. Local evidence is in `/private/tmp/android-sync-readiness/` and the final Gradle log is
`/private/tmp/android-sync-readiness-final.log`.
