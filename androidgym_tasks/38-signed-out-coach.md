# Signed-out Coach on this phone (installation credential, onboarding endpoint)

**Status:** On draft pull request [#41](https://github.com/neigrok/windmill-monorepo/pull/41), not on main. This task has no board, and the deployed onboarding switches are off. Native acceptance on a local stack (2026-10-31) covers installation issue, binding at sign-in, a killed process recovering its request by GET, GET-only recovery after binding, a lost request replaced by a new question without replay on relaunch, one issuance request a day with the switches off, and Sentry reports only for injected failures. A question answered while the app was dead now clears its matching draft on relaunch, and every interrupted exchange keeps Try again with its own request id and body; both are covered by JVM tests and await native re-acceptance. Import has no native entry point until task 41, so `gym_coach_import` and a kill mid-import are verified only in JVM tests.

**Figma:** none. This task builds the plumbing that 39–44 draw on. The signed-out boards are 01.1, 01.4, 01.7, 01.10, 01.14, 01.15, 01.16.

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `platform/` or `backend/`)
- Signed-out access is projected by task 36: available installations keep their original local chat and composer; bound or unavailable installations use the approved access stance and retain local History.
- `platform/ai/AiInstallation.kt` seals a separate installation credential and durable binding intent. `coach/onboarding/` carries installation-authenticated requests, original-chat recovery and atomic routine import. Visible anonymous states remain the responsibility of 39–44.
- Signed-in questions accept 8,000 UTF-8 bytes through `Ask.maxTurnBytes`. The onboarding client keeps its separate 4,000-byte limit.
- `CoachPhotos.read` retains its signed-in 5 MiB / 4,096 px defaults and accepts the onboarding client's 1 MiB re-encoding bound.
- Backend routes are implemented behind two switches:
  - `POST /v1/ai/installations` issues the credential. `GET /v1/ai/installations/current` reads it, and `POST /v1/ai/installations/bind` binds it to an account (`backend/platform/infra/main.cpp:832-836`).
  - `POST /v1/gym/coach/onboarding` and `GET /v1/gym/coach/onboarding/{requestId}` (`backend/products/gym/routes.cpp:33-44`).
  - Mode `conversation` (`backend/products/gym/onboarding/Onboarding.cpp:44-71`) takes `text` (at most 4,000 bytes), up to 12 `context` turns (16,000 bytes in all) and an optional inline `image`.
  - The reply carries `requestId`, `resultId`, `status`, `message`, `routines`, `errorCode` and `allowance` (`backend/products/gym/onboarding/OnboardingApi.cpp:24-31`).
  - Both routes run only with `AI_ALLOWANCES_ENABLED=true` and `AI_INSTALLATIONS_ENABLED=true`. Both default to `false` (`backend/AI_ALLOWANCES.md`). With the switch off, new work answers 503 `anonymous_ai_unavailable`.

**Contract**
- Installation credential lives in `platform/ai/` because it is product-neutral. Issue once with `POST /v1/ai/installations` and `{}`, seal the opaque credential through `SecretVault`, and keep it separate from account sessions.
  - Read and persist the `bound` state returned by issuance/current/bind. Refresh through `GET /v1/ai/installations/current` before presenting anonymous Send when binding is unknown.
  - Send `X-Windmill-Installation` on installation/onboarding operations that require it. Never re-issue over an existing credential. A 401 `invalid_installation` is a refusal, not permission to reset the installation or its lifetime allowance.
  - Sign-out retains the credential and binding state. The $0.05 lifetime allowance belongs to that installation.
- Onboarding client and store form one feature package, for example `coach/onboarding/`.
  - Mint a lowercase UUID `requestId`; persist the exact input, request id and originating local chat/owner before sending. Use 37's stable local-chat contract.
  - After timeout/restart recover the same request via GET. A retry POST may resend the same id/body only while the installation is still unbound; after binding, GET remains the recovery route. A new request id requires an explicit new Send.
  - Poll once a second while pending. Bind each result, draft and failure to its original chat; navigation/fresh entry must not cancel it or deliver into the newly selected chat.
  - Use mode `conversation`, with up to 12 earlier turns from that chat as context. `message` supplies Coach's bubble; completed `routines` become the drafts in 41.
  - Local turns, drafts, pending input and photos stay in the owner-scoped archive. The server stores no prompt/photo. Signed-out History is local-only; no account history endpoint is called.
- This task owns the **atomic anonymous import** used by 41, not a loop over `TrainingStore.saveRoutine`.
  - Add a Gym-domain batch action taking the complete validated draft set, catalogue facts and preassigned record identities. It returns one Plan for all routines and required custom movements; reuse existing routine validation/plan composition rather than calling `SaveRoutinePlan` separately per routine.
  - The adapter commits that Plan and a local replay receipt for the installation result in one engine storage transaction. The receipt is scoped to the anonymous owner/replica and `resultId`, and holds a payload fingerprint plus the resulting record identities. Persist neither the receipt before its records nor the records before the receipt.
  - Use the engine's existing device-value/commit boundary for local metadata; extend the product-neutral commit contract only if needed to prove the shared transaction. Keep Gym mapping in Gym. `WorkoutImports` is an existing example of committing product records and recovery metadata through that boundary.
  - A replay with the same result and payload returns the same identities without writes. A different payload for an already imported result refuses; it must not import another copy. Any invalid draft or transaction failure leaves every routine, movement and receipt uncommitted.
  - Keep the receipt through process death and anonymous Add/adoption, remapping record identities through the engine's adoption hooks; Discard removes it with that anonymous data. A sign-in racing import cannot write into a different owner. The chat's displayed saved state is reconstructible from the durable receipt after a UI-cache failure.
- Byte limits (6s): do not truncate; retain the whole draft and identify the exceeded limit.
  - Signed-in questions: raise `Ask.maxTurnBytes` to 8,000.
  - Signed-out text: 4,000 bytes.
  - Signed-out photo: JPEG/PNG, at most 1 MiB decoded and a 4,096 px edge; re-encode to fit.
- Signed-out Coach drafts routines only; no note or proposal writes. Its retained local History is still available. The change-needs-account response is drawn by 36.
- Routing:
  - Unbound valid installation: anonymous Coach (39–44).
  - `bound=true` or 409 `device_bound`: retain draft/archive and route to 36's sign-in stance; no anonymous POST and no replacement installation. GET for an already pending anonymous result remains available.
  - 503 `anonymous_ai_unavailable`: fall back to 36's no-seat stance while retaining the archive and credential.
- Bind after account sign-in through `AuthLifecycle.signedIn`. Retry the same account binding idempotently. 409 `installation_bound` for another account must not block account sign-in/Coach or reset the credential; treat the installation as bound. Existing Add/Discard owns adoption of signed-out data (25/44).
- Refusals retain the originating draft: `invalid_installation`, `device_bound`, `installation_bound`, `installation_rate_limited`, `request_limit`, `insufficient_details`, `output_truncated` and `anonymous_ai_unavailable`. Expected 401/409/429/503 refusals are events, not Issues. Task 36's approved 08.6b supplies the bound access stance; other undrawn refusal copy stays a designer dependency (6t). Nonvisual transport can proceed independently. New request-recovery cards are not approved; local-save cards remain postponed with 41/42. Allowance exhaustion is 43.

**Out of scope:** every visible state: the greeting (39), the photo (40), the drafts card (41), receipts (42), allowance used (43), after sign-in (44), the no-seat state (36).

**Done when**
- On a local stack with both switches on:
  - a signed-out phone gets a credential, sends a conversation turn with and without a photo, and receives drafts;
  - it survives a kill mid-poll and resumes the same `requestId`;
  - Apply imports once even after a crash immediately after commit but before the chat saved-state update. Inject failure on the second routine/required movement and verify all-or-none records plus receipt; replay returns the same ids. Verify payload mismatch, concurrent Apply, sign-in/adoption and Discard.
- With the switches off, the tab falls back to 36's state and nothing is reported as an Issue.
- Observability:
  - `gym_ask_started` and `gym_ask_outcome` fire for signed-out sends too, with `state=anonymous`.
    - Outcomes: `answered`, `refused`, `capped` (`cap=allowance`), `failed`, `cancelled`.
    - `duration_ms` stays as it is.
  - New Sentry ops:
    - `ai_installation`: unexpected issue, read or bind failures.
    - `gym.coachOnboarding`: unexpected start/poll failures at the transport boundary and import failures at the import adapter, once per failure. Cards/stores consuming the reported outcome do not report it again.
  - Expected refusals (401, 409, 429, 503 codes above) are events, not Issues.
  - Record import started/committed/refused/replayed/failed with bounded labels through the first-party intake; report unexpected import/persistence failures under a static operation. No credential, request/result/record ID, fingerprint, text, photo or routine name in any event.
  - List both ops and the `state=anonymous` label in `docs/ANDROID_OBSERVABILITY.md`.
- Tests:
  - New tests in `apps/android/gym/src/test/kotlin/works/windmill/gym/coach/`: persist before send, same-id recovery, no new id after failure, results returning to their originating chat, atomic import/replay and receipt crash cases, and byte limits keeping drafts. Add domain batch-action/shared-vector cases and engine-adapter transaction fault tests.
  - A credential test beside `apps/android/platform/src/test/kotlin/works/windmill/platform/auth/SecretVaultTest.kt`: sealed, kept on sign-out, bound on sign-in, anonymous → bind → sign-out refusing new anonymous work, another-account binding, and pending GET recovery after binding.
  - Update `coach/AskTests.kt`: it pins `Ask.signedOut` and the signed-in 8,000-byte limit; signed-out requests keep their separate 4,000-byte limit.

**Depends on:** 37 for the durable owner/chat archive. Task 37 has no dependency on this task; ordinary fresh Coach entry can ship without anonymous transport/import.

**Ledger:** 6p, 11h, 6s; dogfood `android-gym-target-page`.
