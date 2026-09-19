# Gym feedback execution

19 September 2026. The feedback comes from an Android app user. Android is the primary acceptance target. Implementation, independent review, simplification and local verification are complete for feedback 1–11. The owner’s exact Coach prompt is applied, with durable note saves and explicit equipment/variant and movement-coverage guidance. PR #3 is merged and its backend deployment succeeded. Read-only public endpoint checks passed without model requests. Web deployment is held; Android 0.9.0 signing, native release acceptance and publication remain last.

Tests and automation use deterministic LLM fakes/fixtures only. Actual-model interaction is manual and local only, using a user-provided local key. Recorded provider runs below are historical evidence, not instructions to repeat them or automated release gates.

The [plan](gym-feedback-plan.md), [Coach wire contract](gym-coach-contract.md), [design contract](design/gym/feedback-contract.md) and [Android visual audit](design/gym/feedback-verification.md) define the scope and current behavior.

## Workspace

- Isolated checkout: `/private/tmp/windmill-gym-feedback`, branch `codex/gym-feedback`, baseline `b52a2f11cbb2c6e40d40d7e6d0b97cbeeca420d7`. The original `/Users/vs/Desktop/windmill` checkout has unrelated changes and is preserved.
- Isolated PostgreSQL database: `postgresql:///windmill_feedback_20260919?host=/tmp`.
- Backend 8188, Vite 5183, local Caddy proxy 8189 and Anthropic-protocol fixture 8191. The fixture is external test infrastructure; the application uses its normal provider transport.
- Native verification uses Android emulator 5562 and the dedicated Windmill Feedback iOS simulator. Existing Android emulator 5556 is preserved. Android display size, font scale and appearance were restored after verification.
- Local evidence and test fixtures are in `/private/tmp/windmill-feedback-runtime/`. Credentials and image bytes are not committed.

## Implemented behavior

| Feedback | Current behavior and Android acceptance |
| --- | --- |
| 1 · Pictures | Native picker, preview/remove, optional caption, upload, durable draft restoration after process restart, and private retained-image reopening passed. Image-only send and ownership/validation passed through fixture-backed HTTP. Recorded actual-model observation identified the synthetic quadrant image correctly. |
| 2 · Copy | Long-press Copy works for both speakers in retained conversations; pasting preserves the exact message text. Current and historical messages share the renderer and accessible action. |
| 3 · Continue history | Retained conversations reopen with an editable composer and durable request identity. HTTP retrieved 205 unique conversations and 60 paged messages; browser reached the oldest retained page. Android continuation and reopened stopped history passed. |
| 4 · Streaming | Native incremental text and Stop preserving partial output passed. Local fixture-backed proxy tests passed reconnect, terminal replay, failure recovery and concurrent-request exclusion. Recorded actual-provider text arrived 7.20079 seconds before completion and continued growing. Public streaming has not been exercised; read-only public checks do not establish it. |
| 5 · Coach prompt | The exact supplied prompt is installed. Coach reads training records and Notes before responding and can append one useful note alongside a routine action. Note receipts survive retries, user edits/deletion and Stop. Final live-model review accepted the direct, friendly answer and explicit setup/coverage limits. |
| 6 · Create routines | The normal backend tool loop created a persisted routine with a durable receipt during native and HTTP fixture tests. Interrupted output followed by the same request produced exactly one routine. Android history shows one named/count creation outcome. Final actual-provider acceptance saved exactly one routine; completed replay made no extra model call or write. Live note creation and replay passed separately at `3df4a889`. |
| 7 · Routine density | Compact rows retain touch targets and grow for large text. Full header title fits at 320 and 411 dp with 200% text through the accessible Add action. |
| 8 · Two clocks | Both clocks start together; a set resets only the since-set reading. Process restart, deletion of the only set and immediate Undo preserve/recompute the correct anchors. |
| 9–11 · Quiet UI and overall review | Empty Last time content, visible clock labels, opening Coach pitches and redundant history metadata are removed. Both themes and captured large-text states passed visual review. The surrounding editor, picker, log/detail, finish, progress and settings received a bounded source audit; contextual facts and controls remain. |

The design audit distinguishes captured native layouts from source-only findings. It does not claim every unpictured state or device was exercised.

## Tests and live verification

- **Android:** full gym run 1,195 tests, 12 skips, zero failures; platform 85 tests, zero skips/failures. Later lifecycle/recovery checks passed 58 focused tests; final header/history checks passed 49. The reviewed debug APK was installed against 8188 with SHA256 `b9cbea8db7f157a8952a615d56eacc1acf82695fa2a46140983cfa0daaf1fa75`. It is a local test build, not the release artifact.
- **Backend:** optimized build passed; `WM_PG_TEST=1` suites passed 3/3 in 5.75 seconds, including four final admission/concurrency regressions. Schema applied twice. Valid PNG/JPEG decoding, PNG CRC checks and bounded image workers are included.
- **Prompt and Notes:** the Notes implementation passed 967 domain, 272 MCP and 1,003 Postgres adapter cases in the optimized backend, with no skips or failures. Focused client receipt tests passed: Android 14, iOS 7 and web 7.
- **Notes through Caddy:** a fixture-backed HTTP run saved a note and routine, interrupted the response, edited the note and retried the same request. It completed with exactly one note and routine, preserved the edit, retained the save receipt in history and made no provider call on completed replay. Evidence: `notes-http.json`.
- **Web:** 1,760 tests passed; production build and landing-shell generation passed. Browser acceptance covered complete paged history, exact Copy, the native workout mirror, Android’s private photo and retained routine receipts. The browser picker upload itself was not established by the attempted chooser run.
- **iOS:** full gym 795 and platform 64 tests passed; later expiry/refusal recovery checks passed 36 focused tests, in addition to cancellation/transport checks. Simulator builds passed. An installed update preserved its local workout and both clocks. Authenticated native picker/Coach acceptance remains unverified; it is separate from Android release.
- **Final HTTP through Caddy:** six creation snapshots, first visible text at 5.01 seconds and terminal completion at 8.40 seconds. Same-ID replay made no new provider call. Deleting a conversation prevented delayed resurrection while preserving its routine. Stop preserved partial text; stopped replay made no model call. Interrupted creation retry retained exactly one routine.
- **Concurrency and compatibility:** an overlapping different request returned 409 in 0.01 seconds while the first generation was running. Disconnect/reconnect kept one generation with no extra provider call; one terminal exchange persisted. Foreign Stop returned 404. Legacy JSON without a request ID remained supported.
- **Private pictures:** upload/read, identical replay, changed-payload conflict, no empty conversation on upload, foreign-account 404, corrupt/dimension/wrong-MIME refusal, image-only history, immutable retry payload and linked-image deletion all passed.

Local protocol-fixture exchanges establish application and transport behavior, not live model output quality or vision understanding. The chosen JPEG/PNG transport is supported by the [provider’s vision contract](https://platform.claude.com/docs/en/build-with-claude/vision). Actual-provider evidence is recorded separately below.

All four remote CI checks passed at [a3c3c811](https://github.com/neigrok/windmill-monorepo/commit/a3c3c811a24be1e742434fd5cbd5cb6ceb50c96a): [Android](https://github.com/neigrok/windmill-monorepo/actions/runs/35451849893), [iOS](https://github.com/neigrok/windmill-monorepo/actions/runs/35451849898), [Web](https://github.com/neigrok/windmill-monorepo/actions/runs/35451849899), and [backend](https://github.com/neigrok/windmill-monorepo/actions/runs/35451849895). [PR #3](https://github.com/neigrok/windmill-monorepo/pull/3) merged at 15:38:48 UTC as [e0d43e690b0bd25718a0ca096e4f64845f94fec8](https://github.com/neigrok/windmill-monorepo/commit/e0d43e690b0bd25718a0ca096e4f64845f94fec8); its Git tree equals the tested head.

The historical [actual-provider run](https://github.com/neigrok/windmill-monorepo/actions/runs/35451856987) passed at `a3c3c811`. Text appeared at 2.005904 seconds and grew until completion at 9.206694 seconds, a 7.20079-second lead. The photo response identified all four colors/positions correctly. Routine creation saved the requested three catalog movements at two sets of eight, zero added weight and 60-second rest. Completed replay preserved the routine and history without another model call or write. Three logical generations used five provider calls and created one routine. No note was chosen in this run; [live Notes acceptance at `3df4a889`](https://github.com/neigrok/windmill-monorepo/actions/runs/35450872921) remains evidence of faithful note creation and unchanged completed replay. Disposable resources were removed.

Manual review accepts rollout: the final routine answer names the intended variants and missing pulling coverage, and the text/photo answers are useful and accurate. A short catalog preamble and an unnecessary empty-log aside in the photo answer remain minor copy issues. The owner prompt is unchanged. The compact grounding instructions passed an optimized build, 13 focused Coach tests and independent review without actionable findings.

The diagnostic transport wave passed 6 compiled parser tests and 7 real libcurl fixture cases. Unknown SSE events before the first message are tolerated; safe diagnostics distinguish HTTP/provider, network and parser failures without retaining raw payloads. A full local fixture-backed HTTP/Caddy run with an unknown pre-start event preserved note/routine creation, later note edits, interrupted recovery and no-call completed replay (`notes-http-diagnostics.json`). The cause of the earlier provider failure remains unproven; successful diagnostic acceptance does not establish it retroactively.

[Main backend CI 35452461058](https://github.com/neigrok/windmill-monorepo/actions/runs/35452461058) and [deployment 35452985601](https://github.com/neigrok/windmill-monorepo/actions/runs/35452985601) succeeded. At 16:10:31 UTC, read-only public checks returned 200 for `/` and 401 for `/v1/me`, `/v1/gym/threads?limit=1` and `/v1/gym/exercises`, with zero model requests (`public-no-model-http.json`). These checks establish page reachability and signed-out endpoint boundaries, not public streamed model behavior. The historical deployed verifier run `35453811475` failed at `registry_identity` before fixture creation or Coach requests; it supplies no acceptance evidence and is not a remaining gate.

## Review and simplification

Independent review and subsequent live testing produced corrections for request identity after a retry refusal, deleted-thread resurrection, completed-context selection after failed exchanges, web Stop racing a failed stream, expired unlinked photo drafts, and model-worker scheduling of overlapping requests. Regression tests cover those cases.

Current and retained conversations share a state owner and renderer on each surface. Provider/image transport stays at the boundary. Model admission uses two actual worker reservations plus a bounded queue for short checks; it does not queue a conflicting message into a later turn. Upload workers and stream snapshot readers keep long work off HTTP loops. Image and operation references remain durable, account-scoped facts rather than inferred answer text.

Native review also corrected over-wide photo controls, short-message Jump visibility, zero-set auto-scroll, large-text header crowding and missing creation outcomes. [The backend log](gym-feedback-backend-log.md) and [design audit](design/gym/feedback-verification.md) record their structural observations and limits.

## Remaining delivery gates

1. Restore and dispatch Web Deploy, then verify public assets and endpoint behavior without model calls. The web workflow is temporarily `disabled_manually`; the compatible backend and read-only public checks have passed.
2. Build the Android 0.9.0 signing input with a workflow version code greater than 76, verify source/run provenance, sign with the retained key, test clean installation and supported in-place upgrade, then publish and verify public assets. Android release is last. Automated Coach smoke uses deterministic fixtures; any actual-model exploration remains manual and local only.

Release preflight passed: public Android 0.8.2 digest/certificate match the retained public pin, the local encrypted key opens through its dedicated Keychain item, and the encrypted backup matches. No candidate has been signed or published. A dedicated offline emulator (5564), currently stopped, retains the public 0.8.2 APK with a routine, finished workout, settings and a queued offline set. Its identities and timestamps survived relaunch and are recorded in `upgrade-082/expectations.json`; the final APK must preserve them through an in-place update.

## Test-data cleanup

Automatic approval review rejected deleting empty audit workout `ses_4bb4e2b97db1100c` from the isolated synthetic account because that specific deletion lacked explicit authorization. It has zero sets and remains intact; permission is optional and does not block delivery. No retry or workaround was attempted.

An earlier iOS authentication-fixture helper was also rejected because it would use the application’s Keychain access group. No credentials were seeded by that helper. That optional simulator approach is not needed for Android delivery.
