# Mobile Sentry routing

| Surface | Sentry project | Build or service configuration |
| --- | --- | --- |
| Android | [android](https://none-gcb.sentry.io/projects/android/) | `ANDROID_SENTRY_DSN`; local `-Pwindmill.sentryDsn` overrides it |
| iOS | [ios](https://none-gcb.sentry.io/projects/ios/) | `IOS_SENTRY_DSN` Xcode build setting |
| Backend | [backend](https://none-gcb.sentry.io/projects/backend/) | `SENTRY_DSN` |

Android and iOS CI receive separate repository secrets. Neither mobile build reads the backend DSN.
Mobile destinations are embedded in each app build. Installed apps retain their compiled destination
until updated; no Android or iOS release has been published as part of this change.

## Structure and privacy

Project selection belongs at each app's build boundary. Separate inputs keep deployment routing
independent without adding routing branches to product code or changing first-party behavioral events.
Android and iOS remove private event fields in the final SDK send hook; the reporting configuration
also disables optional capture features that could collect user content. The backend configuration
is unchanged.

## Verification — 2026-09-24

- Android's full Gradle build and lint passed: 1,290 executed JVM tests passed per variant, with
  12 skipped per variant. All 18 release-tool tests passed.
- Android validation rejects a backend-only DSN and an invalid Android DSN, accepts its dedicated
  environment variable, and preserves the explicit Gradle override. The release APK and generated
  BuildConfig contain Android project `4512141607043152`'s real DSN; the APK contains no placeholder DSN.
- Android diff review found no issues. The simplification pass kept selection in the existing Gradle
  provider and extended existing release-tool checks without adding configuration helpers.
- Both Sentry intake probes returned HTTP 200. The verification events appeared as
  [ANDROID-1](https://none-gcb.sentry.io/issues/149175856/) and
  [IOS-1](https://none-gcb.sentry.io/issues/149175857/). These probes establish project receipt;
  they are not a native-app crash test.
- iOS's two simulator tests passed with zero failures, and its Debug app compiled. The Release build
  passed with the real iOS DSN; its plist contains project `4512141613465680` and no backend DSN key.
  Release builds with no DSN or only the backend `SENTRY_DSN` both failed with the explicit
  `IOS_SENTRY_DSN` requirement. The SDK test confirms private crash data is removed before transport.
- The existing local backend on port 8088 passed authenticated identity and gym catalog reads through
  Postgres: 64 seeded exercises, the exact fresh-account last-set response, and the local web CORS
  header. Unauthenticated `/v1/me` returned 401. Scratch accounts and sessions were deleted, with
  zero matching rows confirmed after cleanup. Shared services were not restarted.
- Frontend behavior was not verified. The existing Vite process on 5173 points at
  `/private/tmp/windmill-baseline/web` and returns 404 for `/` and `/index.html`; it was left untouched.
  No full backend suite or native app installation was run.

Android SDK collector tests establish the existing privacy and delivery behavior locally. APK
inspection and direct intake probes do not establish crash delivery from an installed updated app.
