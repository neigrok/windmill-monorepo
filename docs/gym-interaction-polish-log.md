# Gym interaction polish

This Android phase follows [the interaction contract](design/gym/interaction-polish.md). Verification uses deterministic local responses; automated tests do not call a real model.

## Implementation

Coach keeps native Compose text and a stable request-keyed message slot through partial, stopped, failed and completed states. Copy menus and receipt disclosures belong to that slot rather than its changing text. A presentation coordinator publishes the newest authoritative snapshot at a display frame and owns scrolling from measured layout. Short new exchanges have enough height to place the question near the top; quota refusals remain visible beside their continuation controls. Upward reader movement pauses following immediately, including inside the 48dp end tolerance. Returning toward the end or choosing Jump resumes it. Older-history insertion preserves a visible message and offset. Automatic growth uses an 80ms native scroll animation with only the latest measured destination retained; the answer text has no typing animation.

The HTTP reader has one conflated snapshot slot. A slower durable consumer cannot accumulate an unbounded queue of obsolete full answers. The consumer drains the newest snapshot before propagating an interrupted stream. Request identity is persisted before HTTP; snapshot persistence runs on IO before publication. The same atomic write clears only the matching sent draft. Duplicate draft saves do no disk work, and a late snapshot cannot recreate a cleared request or erase a new draft. Account identity is rechecked after suspended persistence.

Routine detail uses compact rows with a 68dp minimum, 16sp names, 13sp targets and 4dp row separation. Content can grow for large text. Start and Edit keep 56dp and 48dp minimum targets. Logger movement swipes cover the workout body through native Compose scrolling and a horizontal pager. Adjacent reading pages follow the finger while the rack stays fixed; selection changes after settlement. Child drags, vertical scrolling, modal UI and system gesture edges retain ownership. Native pointer transfer is supported without performing a rack action during a drag. Reversal and cancellation retain the selected movement and draft.

## Structural observations and simplification

The previous Coach update path combined an animated new-question scroll, a per-revision two-frame delayed end scroll, and a measured tail spacer. One layout owner replaces those competing paths. Native text remains sufficient for this bounded change; no custom shaping engine or typewriter queue is introduced.

The stream callback previously waited for a full atomic JSON write on the UI thread. Moving snapshot persistence exposed a second path: the actual screen callback repeatedly cleared an already-empty draft. The persistence boundary now treats that as a no-op and combines the first matching draft clear with the snapshot write. This removes repeated serialization/fsync work instead of hiding it behind another queue.

The simplification pass also unifies partial and completed answer composition, removes text-dependent saved-state keys and unused imports, and keeps stream callback suspension within gym networking rather than changing shared platform transport. The logger uses one native body scroll owner and no custom gesture thresholds or domain direction recognizer.

## Verification

- Routine/logger focused checks: 44 passed, 0 failed, 0 skipped. Evidence: `/private/tmp/windmill-interaction-polish/logger-routine-tests/result.json`.
- Full Android debug unit suite: gym 1,214 cases with 0 failures and 12 existing skips; platform 85 cases with 0 failures/skips; app has no unit sources. The run completed in 58s. XML and counts: `/private/tmp/windmill-interaction-polish/android-full-tests/result.json`.
- Final draft-cache notification verification: 11 Coach ownership tests passed after the full run; the first snapshot sends exactly one UI draft-version update and later snapshots do no draft work. Evidence: `/private/tmp/windmill-interaction-polish/coach-final-tests/result.json`.
- Coach regressions cover exact Unicode replacement, burst delivery with a blocked consumer, newest partial receipt delivery before EOF failure, sent-draft/Stop races, account changes during final disk flush, copy-menu continuity, prepend offset and reader-controlled scrolling. One hundred incoming snapshots reduce to two consumer deliveries while it is blocked (first and newest), preserving full text/results both at terminal completion and before EOF failure. A deterministic display clock publishes 100 superseding revisions as one exact terminal replacement at its next frame. Snapshot writes are verified off the caller thread before UI publication.
- Integrated debug APK uses `http://10.0.2.2:8188` and a dummy local telemetry endpoint. Local deterministic provider fixtures supply long, burst, sparse and slower observation profiles.
- Native integrated-debug Coach observation: fixture text was visible by 2.05s (polling upper bound). The Copy menu remained open across successive deltas. After an upward reader swipe, two captures 4.21s apart were byte-identical while the authoritative answer grew from 2,496 to 3,312 characters; Stop and Jump remained visible. Jump after completion reached paragraph 18 and disappeared. The long fixture completed all 18 paragraphs including Unicode. Evidence: `/private/tmp/windmill-interaction-polish/observe-result.json`, `observe-after-menu1.json`, `observe-after-menu2.json`, `anchor1.png`, `anchor2.png`. These observations do not establish native Jump behavior during an active stream.
- Native integrated-debug routine/logger observation: detail row pitch is 72dp at normal type; 320dp/200% Instrument rows grow and Start/Edit remain reachable. Body swipes navigate in both directions without logging a set while both clocks continue; a modal sheet retains the movement, and a deliberate 50kg×8 set finishes as 400kg. Exact captures and bounds are in [Android design verification](design/gym/feedback-verification.md#interaction-polish--native-evidence). Large-type Daylight and spoken TalkBack were not verified.
- Uncontended long-fixture frame diagnostics: baseline 87 frames, p50/p90/p95/p99=28/57/69/109ms and 23 slow UI-thread frames; final 104 frames, 34/48/61/73ms and 29 slow UI-thread frames. The final run completed all 18 paragraphs. These mixed emulator measurements are diagnostic, not a production benchmark, and support no performance-percentage claim. An earlier after-change run overlapped host Gradle work and is excluded from this comparison. Evidence: `/private/tmp/windmill-interaction-polish/gfx-after-idle.txt` and `stream-after-idle.mp4`.

## Android 0.9.1 release

[Android 0.9.1/code89](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.9.1) was published on 19 September 2026 at 19:26:31 UTC. Tag `android-v0.9.1` identifies source/workflow commit `7010c3e04b9e0668e55b06baa9805ed99fc5fe3b`; [Android Actions run 35463302150](https://github.com/neigrok/windmill-monorepo/actions/runs/35463302150) succeeded on attempt 1 from a tag push. The APK SHA-256 is `3e7c9cafe0a2d6773fcd0964efc73f42b948487f40687d16e67363f2ee82416f`.

The signed APK and anonymously downloaded public APK pass retained-certificate, non-debuggable package, unchanged payload, version/code and linked source/run provenance checks. Code 89 exceeds the prior public floor 85. All three public assets are byte-identical to the accepted signed files and match GitHub's SHA-256 digests. Evidence under `/private/tmp/windmill-interaction-polish/`: `final-apk-verification.json`, `public-verification.json`, `published-release.json` and `public/`.

Both final signed native checks used the same accepted APK on isolated Android 14 emulators:

- **0.9.0 update, emulator-5566:** Release090 Clean and its 20kg×5=100kg workout remained visible before and after the update and after process restart. Evidence: `upgrade-detail-before.txt`, `upgrade-detail-after.txt`, `upgrade-log-before.txt`, `upgrade-log-after.txt` and `upgrade-log-restarted.txt`.
- **Independent clean install, emulator-5570:** Release091 Clean was created with Bench Press and Barbell Row. Horizontal swipes over Weight and Log set moved both directions without logging a set. An ordinary Log set and Finish then saved 20kg×5=100kg, retained after process restart. Evidence: `clean-routine-saved.txt`, `clean-weight-swipe.txt`, `clean-log-button-swipe.txt`, `clean-finished.txt` and `clean-log-restarted.txt`.

Notifications remained denied and the Coach account door was checked. These final signed checks made no actual-model calls; authenticated Coach evidence belongs to the integrated debug build and deterministic local fixture described above. The retained key supports updates from 0.8.2 and 0.9.0, but this release's native upgrade check started from 0.9.0. No full device/skin/font matrix, spoken TalkBack, final-signed authenticated Coach or measured performance improvement is claimed. The large-text Routines tab-label follow-up remains open. The synchronized Figma specimens and inspected exports are linked in [the interaction contract](design/gym/interaction-polish.md).

## Coach stream and Markdown · 24 September 2026

The owner reported that the Android Coach answer blinks, scrolls and shifts while streaming and shows the model's `**` and `- ` markers literally. Tracking node `gym-android-coach-stream-markdown`; contract in [interaction-polish.md § Coach streaming](design/gym/interaction-polish.md).

### Implementation

`CoachMarkdown` (`gym/domain`) is one O(n) line walk that yields blocks (paragraphs, headings, list items, fenced code, rules) with inline bold/italic/code spans, and `plain` for Copy from the same walk so the copied text and the rendered text cannot drift. A marker the model has opened but not closed styles the rest of its block; a bare block marker on the last line is held back until the next token; empty blocks are not emitted. `CoachAnswer` draws one text node per block under `key(index)`, so settled blocks keep their node and only the tail block re-lays out; both speakers share one `CoachMessage` with a tap/long-press menu and no ripple.

`CoachPresentation` is the one scroll owner. Its corrections run in a `Modifier.layout` placement block placed before `verticalScroll`: after the scroller has measured (`maxValue` fresh) and before it reads the offset it places at, the block shifts by the prepended height, snaps to the end on a new message key, and while following snaps to the end — so text that grew this frame is in view this frame with no scroll animation. The positions map, `onGloballyPositioned`, `withFrameNanos` coalescing, the anchor/layout data classes and the 80 ms per-revision tween are gone.

`CoachReveal` paces the live answer between transport snapshots. The server polls the durable generation once a second (`AskApi.cpp`, `runAfter(1.0, poll)`), so the phone receives 100–300 new characters per second whatever the model's cadence. The delta is spread over an EMA of the inter-arrival interval (floor 40 characters per second, no ceiling), cut at grapheme boundaries, stamped and advanced on the frame clock; completion, Stop and failure flush at the next frame. Only a running generation is paced.

### Structural observations

- The 1 Hz cadence is a backend property shared by web and iOS. A push from the vendor stream callback into the open reply (no poll) would make every surface smoother and cut one durable read per second per open stream; filed on the tracking node rather than changed here.
- Web (`pre-wrap`) and iOS (`Text(text)`) still show Markdown markers; recorded in the consistency ledger for design.
- The parser re-runs over the shown prefix once per frame while streaming. Measured on the JVM in review: a realistic 5,027-character answer of 132 blocks parses in 0.115 ms at p50 (0.135 ms p90), 20 kB in 0.38 ms; the worst adversarial input (20,000 `[`) takes 12.3 ms. Not measured on a phone.

### Verification

- Android module suite `:gym:testDebugUnitTest`: 1249 tests, 0 failures, 12 pre-existing skips. New: `CoachMarkdownTests` (20), `CoachRevealTests` (8), placement-invariant and burst tests in `CoachPresentationTests`, Markdown rendering and plain Copy in `CoachAnswerTests`, paced reveal and Stop flush in `AskScreenTests`.
- Deterministic emulator rig in `/private/tmp/windmill-coach-stream/` (`RUNBOOK.md`, `rig.sh`, `fake_anthropic.py`): the real backend on 8188 with `COACH_ANTHROPIC_BASE_URL` pointed at a stdlib fake Anthropic SSE server that streams a seeded 4,048-character Markdown answer in 2–12 character chunks every 25–60 ms; a real code sign-in; `adb screenrecord` plus `dumpsys gfxinfo` on the API 34 emulator.
- Same rig, same profile, three builds: baseline `2414e457` — 256 frames, 68% janky, p99 117 ms, markers rendered literally, mid-scroll blur in stills; wave 1 (layout-phase follow + Markdown, no pacing) — 162 frames, 76% janky, p99 101 ms, crisp stills, lines dropping in once a second; final, after the review fix pass — 1,128 frames over 35 s, 44% janky, p99 89 ms (the same build before the fix pass measured 1,294 frames, 36%, 81 ms; the spread is emulator variance), consecutive stills 200 ms apart show word-by-word growth with bold, headings and list markers in place and no scroll jumps. Burst profile: 73% → 47% janky, p99 117 → 97 ms. Emulator numbers under screen recording are diagnostic only.
- Executing adversarial review (scratch tests, not committed): 10,000 fuzzed strings never threw and `plain` round-tripped every marker-free one; 300 random reveal schedules kept the prefix and monotone invariants and settled at most 1.85 s after the last arrival; 200 revisions at 16 ms cost at most one recomposition and two placements each with no loop and nothing running once settled; viewport shrink and growth kept a follower at the end and a paused reader at the exact offset. It found a running answer re-typing from zero whenever its reveal was recreated (tab switch, thread reopen, retry, recreation) and numbered-list digits flickering as prose while the reveal typed, plus three smaller tail flickers (`--` before a rule, an unclosed fence's closer, an unfinished link); all fixed in the same wave with tests.
- Not verified: a physical device, TalkBack spoken output, Daylight code-span contrast in a capture, and a real provider.

## Android 0.9.3 release

[Android 0.9.3/code98](https://github.com/neigrok/windmill-monorepo/releases/tag/android-v0.9.3) was published on 24 September 2026 at 15:17:01 UTC. Tag `android-v0.9.3` identifies source and workflow commit `ce6ce1893476ba1f2a35d5887c959b7736bf6694` (the Coach stream commit `d61e9be6` plus its release notes); [Actions run 36016403780](https://github.com/neigrok/windmill-monorepo/actions/runs/36016403780), attempt 1, tag push, produced the signing input, which `tools/release.py finalize` signed locally with the retained key. Signed APK SHA-256 `6975fdf8610a1c58269896fa9d42228ffbb9fa9701abbeaa5ca2ad0e8081918d`, certificate `e911c9…e2bb`, version code 98 above the prior floor 93. All three anonymously downloaded public assets are byte-identical to the accepted files.

Native acceptance on emulator-5556 (Android 14), evidence in `/private/tmp/windmill-coach-release/acceptance/` (`RESULTS.md`, dumps and screenshots per step):

- **0.9.2 update in place:** clean 0.9.2 install, routine `Release093` (Bench Press), one 20 kg × 5 set finished ("100 kg lifted"); `adb install -r` of 0.9.3 succeeded without uninstall; the routine and the workout were present after the update and after two further restarts.
- **Signed-out Coach door:** the Coach tab renders "Coach reads your log, so it needs you signed in." with Sign in; nothing was signed in and no question was sent.
- **Independent clean install:** routine `Clean093`, one 20 kg × 5 set finished, retained after restart.
- Identity on device: the installed base.apk is byte-identical to the signed APK, carries the retained certificate, and has no debuggable flag.

Not verified for this release: anything behind sign-in on the signed build, granted notifications, real hardware, spoken TalkBack, and live-wire API cases. Coach streaming and Markdown evidence is the debug-build recording set in the section above.
