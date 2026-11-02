# Auth failures say what happened, and REST keeps its boundaries

**Status:** Implemented, awaiting review. The reviewer reports the preceding `:platform:testDebugUnitTest` run green. The owner-approved code/link routing follow-up awaits an orchestrator rerun. Device sign-in flows, real SharedPreferences disk-failure retention, and live log/event/Sentry delivery remain unverified.

**Context:** Package 109 owns Android auth and REST failure boundaries: sign-in copy, required session capture, sealed legacy credential migration, network-loss reporting, and backend configuration validation. It makes no visual changes and introduces no user-facing sentences.

**Current implementation**

- `platform/…/auth/Auth.kt` accepts only `WindmillApiException` in `MagicLink.refusal`. Server words win except for 426; otherwise the existing failure line is shown. An unreadable paste uses *That code didn't work. Check the digits, or send a fresh one.* There is no local expiry sentence. `SignInDoor` treats entries containing `://` or `token=` as links and every other entry as a code; malformed codes use the same approved refusal locally without a request.
- `platform/…/net/WindmillApi.kt` requires a nonempty session cookie inside the session-capture request boundary. A successful HTTP response without it is `Malformed`, reports under `auth_request` with `network_phase=decode`, and stages no identity.
- `PrefsSessions` serves legacy plaintext only after sealing and persisting it. A refused migration retains the plaintext unused, reports `session_migrate` once, and suppresses further legacy migration attempts in that process until clear or a successfully persisted replacement secret resumes reads. A newly committed or published sealed identity remains readable. Sealing failures on writes throw `IOException`.
- `platform/…/telemetry/Telemetry.kt` suppresses Issues and `client_error` for a `Transport` cause that `networkLoss` accepts. `api_request_failed` remains, with its transport kind and network phase. Timeouts still report, and raw file exceptions remain reportable.
- Blank backend configuration selects production. Every nonblank `windmill.apiBase` must parse as an http(s) URL or launch throws a static `IllegalArgumentException`.
- Regression coverage lives beside the source layout in `auth/MagicLinkTest.kt`, `auth/AuthStoreTest.kt`, `auth/PrefsSessionsTest.kt`, `net/WindmillApiTest.kt`, and `telemetry/TelemetryTest.kt`. `you/YouSheetTests.kt` expects the existing generic failure line for a wordless 401.

**Done when**

- Sign-in failures show server words or their own existing failure line; malformed non-link entries are refused as codes without a request, and missing or empty session cookies cannot stage an account.
- A failed legacy migration sends no credential-bearing request, preserves recoverable plaintext, and reports once; a working vault on relaunch migrates it.
- Lost-network transport failures retain request-failure events without Issues; unexpected transports, timeouts and raw file failures remain reportable.
- Malformed nonblank backend configuration cannot select production.
- The orchestrator's Gradle checks and local device/telemetry verification pass.

**Observations and follow-ups**

- `platform/…/auth/SignInDoorLayoutTests.kt` is an additional test-only edit outside the original territory. Injected OkHttp responses and a direct executor remove real socket scheduling while preserving all layout and flow assertions. The reviewer reports the original fixture passed five of five runs under load; a dark cold start of about six to seven seconds exceeds its five-second wait. The accepted immediate fixture remains; production code is unchanged by this fixture edit.

- `androidgym_tasks/README.md` adds this task to the index, a documentation-only edit outside the original territory.
- The owner-approved routing follow-up keeps malformed code entries on the code path with the existing refusal. Bare link tokens are not accepted by the sign-in field; full links and `token=` parameters remain accepted.

- The ignored `apps/android/local.properties` points to `/Users/vs/Library/Android/sdk`, whose `platforms/android-36` directory is present.

- Legacy retry suppression applies only to legacy reads; it does not hide a newly sealed identity after commit or publish.
- Migration persistence-failure fakes fail before mutation. Retention after a real SharedPreferences disk failure still needs device verification.

- WP-E owns `EventQueue.kt`: its additional `!networkLoss` gate is redundant for `Transport` after the shared reporting policy, but remains untouched here.
- WP-I owns `app/build.gradle.kts`: optional build-time validation could reject malformed `windmill.apiBase` before installation. Launch validation is the current boundary.
- Timeout reporting is retained deliberately. Changing it requires an owner decision and matching tests/documentation.
- A bounded sign-in refusal outcome event is a possible follow-up; this package adds no event or operation name.

**Depends on:** none. Package WP-D, 109. Tree: `android-task-109-auth-rest`.
