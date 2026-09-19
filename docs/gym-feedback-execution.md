# Gym feedback execution

19 September 2026. The feedback comes from an Android app user. Android is the primary acceptance target. Implementation, independent review, simplification and local verification are complete for feedback 1–11. The owner’s exact Coach prompt is applied, including durable note saves for useful user insights. Actual-provider text, image interpretation, incremental delivery, routine creation, note saves and replay passed. Manual review found that catalog-only evidence did not justify the answer’s equipment-variant and balanced-coverage claims; a compact grounding correction passed independent review and 13 focused backend tests. Its actual-provider acceptance is pending. Android release remains the final step, after the remaining delivery gates below.

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
| 1 · Pictures | Native picker, preview/remove, optional caption, upload, durable draft restoration after process restart, and private retained-image reopening passed. Image-only send and ownership/validation passed through HTTP. Real Anthropic interpretation of the synthetic quadrant image passed; deployed-proxy acceptance remains pending. |
| 2 · Copy | Long-press Copy works for both speakers in retained conversations; pasting preserves the exact message text. Current and historical messages share the renderer and accessible action. |
| 3 · Continue history | Retained conversations reopen with an editable composer and durable request identity. HTTP retrieved 205 unique conversations and 60 paged messages; browser reached the oldest retained page. Android continuation and reopened stopped history passed. |
| 4 · Streaming | Native incremental text and Stop preserving partial output passed. Proxy tests passed reconnect, terminal replay, failure recovery and concurrent-request exclusion. Actual-provider text arrived 6.78 seconds before completion and continued growing. Deployed-proxy acceptance remains pending. |
| 5 · Coach prompt | The exact supplied prompt is installed. Coach reads training records and Notes before responding and can append one useful note alongside a routine action. Note receipts survive retries, user edits/deletion and Stop. Live-model tone was direct and friendly; catalog/setup grounding now states material limits; the final wording awaits live acceptance. |
| 6 · Create routines | The normal backend tool loop created a persisted routine with a durable receipt during native and HTTP fixture tests. Interrupted output followed by the same request produced exactly one routine. Android history shows one named/count creation outcome. Actual-provider acceptance saved exactly one routine and one faithful note; completed replay changed neither. |
| 7 · Routine density | Compact rows retain touch targets and grow for large text. Full header title fits at 320 and 411 dp with 200% text through the accessible Add action. |
| 8 · Two clocks | Both clocks start together; a set resets only the since-set reading. Process restart, deletion of the only set and immediate Undo preserve/recompute the correct anchors. |
| 9–11 · Quiet UI and overall review | Empty Last time content, visible clock labels, opening Coach pitches and redundant history metadata are removed. Both themes and captured large-text states passed visual review. The surrounding editor, picker, log/detail, finish, progress and settings received a bounded source audit; contextual facts and controls remain. |

The design audit distinguishes captured native layouts from source-only findings. It does not claim every unpictured state or device was exercised.

## Tests and live verification

- **Android:** full gym run 1,195 tests, 12 skips, zero failures; platform 85 tests, zero skips/failures. Later lifecycle/recovery checks passed 58 focused tests; final header/history checks passed 49. The reviewed debug APK was installed against 8188 with SHA256 `b9cbea8db7f157a8952a615d56eacc1acf82695fa2a46140983cfa0daaf1fa75`. It is a local test build, not the release artifact.
- **Backend:** optimized build passed; `WM_PG_TEST=1` suites passed 3/3 in 5.75 seconds, including four final admission/concurrency regressions. Schema applied twice. Valid PNG/JPEG decoding, PNG CRC checks and bounded image workers are included.
- **Prompt and Notes:** the final optimized backend passed 967 domain, 272 MCP and 1,003 Postgres adapter cases, with no skips or failures. Focused client receipt tests passed: Android 14, iOS 7 and web 7. The isolated provider harness/bootstrap passed 15 offline tests.
- **Notes through Caddy:** a fixture-backed HTTP run saved a note and routine, interrupted the response, edited the note and retried the same request. It completed with exactly one note and routine, preserved the edit, retained the save receipt in history and made no provider call on completed replay. Evidence: `notes-http.json`.
- **Web:** 1,760 tests passed; production build and landing-shell generation passed. Browser acceptance covered complete paged history, exact Copy, the native workout mirror, Android’s private photo and retained routine receipts. The browser picker upload itself was not established by the attempted chooser run.
- **iOS:** full gym 795 and platform 64 tests passed; later expiry/refusal recovery checks passed 36 focused tests, in addition to cancellation/transport checks. Simulator builds passed. An installed update preserved its local workout and both clocks. Authenticated native picker/Coach acceptance remains unverified; it is separate from Android release.
- **Final HTTP through Caddy:** six creation snapshots, first visible text at 5.01 seconds and terminal completion at 8.40 seconds. Same-ID replay made no new provider call. Deleting a conversation prevented delayed resurrection while preserving its routine. Stop preserved partial text; stopped replay made no model call. Interrupted creation retry retained exactly one routine.
- **Concurrency and compatibility:** an overlapping different request returned 409 in 0.01 seconds while the first generation was running. Disconnect/reconnect kept one generation with no extra provider call; one terminal exchange persisted. Foreign Stop returned 404. Legacy JSON without a request ID remained supported.
- **Private pictures:** upload/read, identical replay, changed-payload conflict, no empty conversation on upload, foreign-account 404, corrupt/dimension/wrong-MIME refusal, image-only history, immutable retry payload and linked-image deletion all passed.

These model exchanges use a local Anthropic-protocol fixture. They establish application and transport behavior, not live model output quality or vision understanding. The chosen JPEG/PNG transport is supported by the [provider’s vision contract](https://platform.claude.com/docs/en/build-with-claude/vision); actual provider acceptance remains separate.

Remote CI passed at [3df4a889](https://github.com/neigrok/windmill-monorepo/commit/3df4a8899e646c04bdf79282ff0c7b66285c3f80): [Android](https://github.com/neigrok/windmill-monorepo/actions/runs/35450871376), [iOS](https://github.com/neigrok/windmill-monorepo/actions/runs/35450871385), [Web](https://github.com/neigrok/windmill-monorepo/actions/runs/35450871382), and [backend](https://github.com/neigrok/windmill-monorepo/actions/runs/35450871389). [PR #3](https://github.com/neigrok/windmill-monorepo/pull/3) remains draft pending final prompt acceptance and delivery gates.

The isolated [actual-provider run](https://github.com/neigrok/windmill-monorepo/actions/runs/35450872921) passed at `3df4a889`. Text appeared at 2.008 seconds and grew until completion at 8.788 seconds. The photo response identified all four colors/positions correctly. Routine creation saved the requested three catalog movements at two sets of eight, zero added weight and 60-second rest, plus one note faithfully reflecting the supplied context. Completed replay preserved the routine, note and history without another model run. Three logical generations used six provider calls; every call completed with HTTP 200, curl code 0 and no recorded parser/provider error. Observed usage was 12 input, 2,082 output, 51,534 cache-read and 14,359 cache-write tokens, costing 167,620,750 nanos. All disposable resources were removed and image publication was skipped.

Manual review found direct, friendly answers and accurate image/Notes content. The routine answer overclaimed balanced general-strength coverage and inferred a mat-compatible back-extension variant from limited catalog metadata. The final factual instructions preserve catalog limitations and keep internal tool IDs/narration out of ordinary replies. The optimized build and 13 focused Coach tests passed; independent review found no actionable issue. These findings do not invalidate the persisted-creation contract, but final prompt quality remains a delivery gate.

The diagnostic transport wave passed 6 compiled parser tests, 29 script tests and 7 real libcurl fixture cases. Unknown SSE events before the first message are tolerated; safe diagnostics distinguish HTTP/provider, network and parser failures without retaining raw payloads. A full local HTTP/Caddy run with an unknown pre-start event preserved note/routine creation, later note edits, interrupted recovery and no-call completed replay (`notes-http-diagnostics.json`). The cause of the earlier provider failure remains unproven; successful diagnostic acceptance does not establish it retroactively.

## Review and simplification

Independent review and subsequent live testing produced corrections for request identity after a retry refusal, deleted-thread resurrection, completed-context selection after failed exchanges, web Stop racing a failed stream, expired unlinked photo drafts, and model-worker scheduling of overlapping requests. Regression tests cover those cases.

Current and retained conversations share a state owner and renderer on each surface. Provider/image transport stays at the boundary. Model admission uses two actual worker reservations plus a bounded queue for short checks; it does not queue a conflicting message into a later turn. Upload workers and stream snapshot readers keep long work off HTTP loops. Image and operation references remain durable, account-scoped facts rather than inferred answer text.

Native review also corrected over-wide photo controls, short-message Jump visibility, zero-set auto-scroll, large-text header crowding and missing creation outcomes. [The backend log](gym-feedback-backend-log.md) and [design audit](design/gym/feedback-verification.md) record their structural observations and limits.

## Remaining delivery gates

1. Run the isolated Actions provider check against the exact reviewed candidate, using the existing Actions secret and disposable synthetic data. Review actual answers, vision, streaming timing, routine creation and replay evidence. No real local Anthropic key is configured.
2. Complete compatible backend rollout; verify deployed streaming/proxy behavior.
3. Build the Android signing input, verify source/run provenance, sign with the retained key, test clean installation and supported in-place upgrade, then publish and verify public assets. Android release is last.

Release preflight passed: public Android 0.8.2 digest/certificate match the retained public pin, the local encrypted key opens through its dedicated Keychain item, and the encrypted backup matches. No candidate has been signed or published. A dedicated offline emulator (5564), currently stopped, retains the public 0.8.2 APK with a routine, finished workout, settings and a queued offline set. Its identities and timestamps survived relaunch and are recorded in `upgrade-082/expectations.json`; the final APK must preserve them through an in-place update.

## Test-data cleanup

Automatic approval review rejected deleting empty audit workout `ses_4bb4e2b97db1100c` from the isolated synthetic account because that specific deletion lacked explicit authorization. It has zero sets and remains intact; permission is optional and does not block delivery. No retry or workaround was attempted.

An earlier iOS authentication-fixture helper was also rejected because it would use the application’s Keychain access group. No credentials were seeded by that helper. That optional simulator approach is not needed for Android delivery.
