# Release mappings and accessible headings

**Status:** On main. Checked on a fresh API 34 Google APIs emulator with a minified release build, debug-signed and pointed at a local origin so it reaches no production service: V1 non-debuggable badging and `assets/sentry-debug-meta.properties` present (7.9 MB release, 20.1 MB debug); V3 an empty crash buffer and none of the listed exceptions in logcat; V4 a routine draft with Vary by set open, the logger's Fix sheet, the Finish sheet and session detail survive process death; V5 a set logged offline survives force-stop and the workout finishes offline; V7 a clean install opens the introduction, then empty Routines. Movements, History and Performed carry heading semantics in the accessibility tree. Not run: V2, which needs the retained release key; V6, which would send a production magic link; the logger's Assembly and Picker sheets under process death; TalkBack navigation by heading, since TalkBack is installed but its gestures were not driven; and the Sentry Debug Files listing, due at the next release.

**Context:** release APKs need retained R8 mappings tied to their provenance without changing telemetry labels or adding CI credentials. Movements, History and Performed need heading semantics for TalkBack navigation.

**Current implementation** (paths under `apps/android/`)
- `app/build.gradle.kts` enables release minification/resource shrinking, generates the deterministic Sentry UUID asset and gates assembly on the mapping and dependency rules. AGP owns the effective configuration output; the guard derives its sibling path from the mapping artifact. Debug remains unminified. `app/proguard-rules.pro` preserves throwable names and line numbers.
- `tools/release.py` uses schema 3 provenance with `apk.proguardUuid` and `mapping`. Stage retains an R8 mapping snapshot; finalize compares its filename/digest before reading the password and retains that snapshot. The CI stage supplies the mapping path without new secrets or permissions.
- `ui/RoutineBuilder.kt` and `ui/FinishScreen.kt` expose the three existing texts as headings with no visual or copy changes. F2 is dropped; the form-wide signed-decimal interceptor and its existing test remain untouched.
- `ReleaseMappingTests` checks the release asset and its UUID in a real SDK envelope sent to MockWebServer. Routine editor and Finish tests assert heading semantics in existing fixtures.
- The README covers mapping finalization/upload and minified device acceptance. Mapping upload is local and Sentry-only; no production Issue is forced. Missing local credentials leave upload pending in release notes.
- Review and simplification: stage and finalize share one mapping snapshot/validation function, so the copied bytes are exactly the bytes hashed. Strict metadata parsing rejects values Python might otherwise accept but Java Properties would interpret differently. Build checks remain self-contained tasks with declared inputs and outputs.

**Done when**
- The Python release suite and orchestrator tasks `:gym:testDebugUnitTest :app:testDebugUnitTest :app:assembleRelease :app:testReleaseUnitTest` pass.
- The release guard verifies R8 output, the four listed throwable names and dependency consumer rules.
- V1–V7 pass after review on the retained-key release candidate; sizes and any skipped signed-in checks are recorded in release notes. TalkBack heading navigation is checked where available.
- The next release uploads its finalized, digest-matched mapping and confirms its UUID in Sentry Debug Files, or records that step pending if no local token is available.

## Open

`TelemetryPolicy.failureKind` uses `javaClass.simpleName`. On ART, a nested throwable reaching that fallback needs its outer class and `InnerClass` annotation to survive R8, or should be top-level; checking mapping names alone does not prove this runtime property. `WorkoutImports.Companion.RefusedImport` loses its annotation but is caught inside `WorkoutImports`, so it currently cannot reach the fallback. Future fallback changes need verification of the runtime `simpleName` value in the minified app.

**Depends on:** orchestrator Gradle verification and release-stage device acceptance. Tree: `android-111-release-mapping-headings`.
