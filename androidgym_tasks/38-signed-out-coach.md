# Signed-out Coach on this phone (installation credential, retained answers)

**Status:** A signed-out question is an `anon` phone turn ([gym Coach](../docs/foundation/mobile/gym_coach.md) §4, §8.3). What this task built that stands is below. The onboarding client it also built is gone from the source; the published Android 0.14.0 still carries it.

**Figma:** none. The signed-out boards are 01.1, 01.4, 01.10, 01.16, 01.19, and 01.7, 01.14 and 01.15 for retained answers.

**What stands** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/` unless they start with `platform/`)
- `platform/ai/AiInstallation.kt` seals a separate installation credential and durable binding intent, and never re-issues over an existing credential. Sign-out retains both. The $0.25 lifetime allowance belongs to that installation.
- Routing, by `coach/CoachAccess.kt`:
  - Unbound valid installation: the composer, whose send is an `anon` turn.
  - `bound=true` or 409 `device_bound`: the bound stance over History and the drafts; no replacement installation.
  - 503 `anonymous_ai_unavailable` or any other unavailable access: the no-seat stance, retaining the archive and credential.
- `AiInstallationLifecycle` binds after account sign-in. 409 `installation_bound` for another account does not block sign-in or account Coach.
- `coach/onboarding/` reads the answers earlier builds retained (`CoachOnboardingRecord`). `CoachRoutineImports` saves their drafts as one atomic batch with a per-result replay receipt on the replica they were had on (`coach-onboarding-actions.json`). A replay writes nothing; a failure leaves every routine out.
- `ai_installation` reports issue, read and bind failures, `gym.coachOnboarding` a failed import, and `gym_coach_import` tells each import's outcome.

**Ledger:** 11h, 6s; dogfood `android-gym-target-page`.
