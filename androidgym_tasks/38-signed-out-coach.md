# Signed-out Coach on this phone (installation credential, onboarding endpoint)

**Figma:** none. This task builds the plumbing that 39–44 draw on. The signed-out boards are 01.1, 01.4, 01.7, 01.10, 01.14, 01.15, 01.16.

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `platform/` or `backend/`)
- Signed out, the Coach tab is a sign-in door (`GymRoom.kt:1152-1153`): `AskSignedOutStance` (`coach/AskScreen.kt:267-278`) says *Coach reads your log, so it needs you signed in.* (`coach/Ask.kt:216`) above a **Sign in** button.
- Android has no installation credential. Nothing in `apps/android` calls `/v1/ai/installations` or `/v1/gym/coach/onboarding`, or sends `X-Windmill-Installation`.
- One question is at most 1,000 bytes: `Ask.maxTurnBytes = 1000` (`coach/Ask.kt:175`). The signed-in contract accepts 8,000.
- Photos are re-encoded down to 5 MB and a 4,096 px edge (`coach/CoachPhotos.kt:15-16`). That fits the signed-in upload, but not the onboarding route's 1 MiB inline limit.
- Backend, already live behind two switches:
  - `POST /v1/ai/installations` issues the credential. `GET /v1/ai/installations/current` reads it, and `POST /v1/ai/installations/bind` binds it to an account (`backend/platform/infra/main.cpp:832-836`).
  - `POST /v1/gym/coach/onboarding` and `GET /v1/gym/coach/onboarding/{requestId}` (`backend/products/gym/routes.cpp:33-44`).
  - Mode `conversation` (`backend/products/gym/onboarding/Onboarding.cpp:44-71`) takes `text` (at most 4,000 bytes), up to 12 `context` turns (16,000 bytes in all) and an optional inline `image`.
  - The reply carries `status`, `message`, `routines`, `errorCode` and `allowance` (`backend/products/gym/onboarding/OnboardingApi.cpp:24-31`).
  - Both routes run only with `AI_ALLOWANCES_ENABLED=true` and `AI_INSTALLATIONS_ENABLED=true`. Both default to `false` (`backend/AI_ALLOWANCES.md`). With the switch off, new work answers 503 `anonymous_ai_unavailable`.

**Change**
- Installation credential, in `platform/` because it is product-neutral (for example `platform/ai/Installation.kt`):
  - Issue it once with `POST /v1/ai/installations` and `{}`. Seal the opaque `credential` with `platform/auth/SecretVault.kt` (class at :15), in its own slot apart from the account session.
  - Send it as `X-Windmill-Installation` on the onboarding calls only.
  - Never re-issue over a credential that exists. A 401 `invalid_installation` is shown and reported; it is not silently replaced.
  - Signing out keeps the credential. The $0.05 lifetime allowance belongs to the installation.
- Onboarding client and store, in one feature package (for example `coach/onboarding/`):
  - Mint a lowercase UUID `requestId`. Persist it with the exact input before sending.
  - After a timeout or a relaunch, resend the same ID and the same body, or `GET` it. Poll once a second while `status` is `pending`.
  - Never mint a new ID on its own after a failure. A new ID only follows a new Send from the lifter.
  - Every turn uses mode `conversation`, with the earlier turns of this phone's thread as `context` (at most 12 turns).
  - Coach's `message` becomes Coach's bubble.
  - Completed `routines` become routine drafts, decided on their card (41).
  - Apply imports every routine at once into the signed-out local engine through `TrainingStore.saveRoutine` (`store/TrainingStore.kt:894`), with the `resultId` as a replay receipt so a replay never imports twice.
  - The thread, the pending request and the photo stay on this phone only. The server stores no prompt and no photo.
- Byte limits (6s). Do not truncate. Keep the whole draft and say which limit was hit.
  - Signed-in questions: raise `Ask.maxTurnBytes` to 8,000.
  - Signed-out text: 4,000.
  - Signed-out photo: JPEG or PNG, at most 1 MiB decoded and a 4,096 px edge. Re-encode to fit.
- Signed out, Coach can only draft routines. There are no notes, no proposals and no history (36 draws a signed-out change request).
- Routing in `GymRoom.kt`:
  - Signed out with the credential live: the Coach tab is the signed-out conversation (39–44).
  - Signed out and issuance answers 503 `anonymous_ai_unavailable`: the tab falls back to the no-seat state (36).
- Sign-in: bind before account Coach is enabled.
  - From the `AuthLifecycle.signedIn` hook (`platform/auth/Auth.kt:234`), call `POST /v1/ai/installations/bind` with the account credential and the installation credential.
  - A same-account retry is idempotent. A 409 `installation_bound` (another account) does not block sign-in or account Coach.
  - Adopting the signed-out routines stays with the existing Add / Discard decision (`app/MainActivity.kt:248`).
- Refusals keep the draft:
  - `invalid_installation`, `installation_rate_limited`, `request_limit`, `insufficient_details`, `output_truncated` and `anonymous_ai_unavailable`. No board draws these lines yet (6t). File the copy with the designers.
  - The lifetime allowance exhausted is drawn by 43.

**Out of scope:** every visible state: the greeting (39), the photo (40), the drafts card (41), receipts (42), allowance used (43), after sign-in (44), the no-seat state (36).

**Done when**
- On a local stack with both switches on:
  - a signed-out phone gets a credential, sends a conversation turn with and without a photo, and receives drafts;
  - it survives a kill mid-poll and resumes the same `requestId`;
  - Apply imports once, even when replayed.
- With the switches off, the tab falls back to 36's state and nothing is reported as an Issue.
- Observability:
  - `gym_ask_started` and `gym_ask_outcome` fire for signed-out sends too, with `state=anonymous`.
    - Outcomes: `answered`, `refused`, `capped` (`cap=allowance`), `failed`, `cancelled`.
    - `duration_ms` stays as it is.
  - New Sentry ops:
    - `ai_installation`: unexpected issue, read or bind failures.
    - `gym.coachOnboarding`: unexpected start, poll or import failures.
  - Expected refusals (401, 409, 429, 503 codes above) are events, not Issues.
  - No credential, request ID, text, photo or routine name in any event.
  - List both ops and the `state=anonymous` label in `docs/ANDROID_OBSERVABILITY.md`.
- Tests:
  - New tests in `apps/android/gym/src/test/kotlin/works/windmill/gym/coach/`: persist before send, replay with the same ID, no new ID after a failure, one import per `resultId`, the byte limits keeping the draft.
  - A credential test beside `apps/android/platform/src/test/kotlin/works/windmill/platform/auth/SecretVaultTest.kt`: sealed, kept on sign-out, bound on sign-in.
  - Update `coach/AskTests.kt`: it pins `Ask.signedOut` and the 1,000-byte limit.

**Depends on:** none.

**Ledger:** 6p, 11h, 6s; dogfood `android-gym-target-page`.
