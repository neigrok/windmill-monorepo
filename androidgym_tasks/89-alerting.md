# Someone is told when the server is refusing or saturated

**Status:** Not started. Backend and operations; nothing visual changes. A backend push redeploys production, so plan it with the owner.

**Context:** since 5e0bb26d an outage answered in the server's own 503 envelope is an expected refusal, never a Sentry Issue, on both phones. That keeps Issues clean, but nothing now tells anyone that the server is refusing everyone. Saturation in gym's own worker pools reports nowhere either.

**Current implementation**
- The repository has no alert rules or uptime checks. The only alert is `AI_ALLOWANCE_ALERT_EMAIL` (`backend/deploy/docker-compose.yml:74`), plus Docker healthchecks.
- Only the main pool and `ai-installation-http` get `FailureWindow("worker_pool.saturated")` (`backend/platform/infra/main.cpp:157,519-520`). These gym pools have none:
  - `gym-sync` (`GymDoor.cpp:21`);
  - `gym-coach-turn` (`TurnService.h:86`);
  - `gym-coach-http` (`TurnApi.h:62`);
  - `gym-onboarding` (`OnboardingService.h:37`);
  - `gym-onboarding-http` (`OnboardingApi.h:21`).

**Change**
- Wire each gym pool to the saturation window, so a saturated pool files one Issue per five minutes, as the main pool does.
- Alerts, configured where the owner keeps operations (Sentry alert rules on the Logs stream, or the VPS's own checks), with where they are configured recorded in `backend/OBSERVABILITY.md`:
  - the rate of `unavailable` completions and 5xx access-log lines over a window;
  - one external uptime check of `/v1/sync` hello and the web root.
- The owner chooses who receives them and on what channel.

**Done when**
- On the local stack, saturating `gym-sync` files exactly one `worker_pool.saturated` Issue in a five-minute window.
- A staged outage (the server answering 503 envelopes) fires the alert to the chosen recipient. Record when and how it was seen.
- `backend/OBSERVABILITY.md` lists every alert, its threshold and its recipient.

**Depends on:** none. Tree: `observability-noise-ai-unavailable-and-pull-503`.
