# Windmill Android

One Kotlin/Compose superapp for the whole brand — the native mirror of `apps/ios` and `web/`.
One room is built: **gym**, the room that owns the open session — workout mode, the ladder, the
keypad and the offline set queue (`backend/products/gym/ARCHITECTURE.md` §11).
Android carries Gym only. There is no subscription surface here.

## Layout

```
settings.gradle.kts   includes :app :platform :gym
platform/             the product-neutral seam: WindmillApi (the Bearer transport) · AuthStore +
                      the emailed-code door (magic-link paste as fallback) · SessionStore · Tokens ·
                      the ProductModule / Account seam · SignInDoor · YouSheet — the door and
                      the sheet paint in `LocalWindmillPalette`, which a room's `Skin` provides,
                      so the shell's sheet wears whichever room is hosting it
gym/                  the room — domain/ (pure) · store/ (the durable queue and runtime) ·
                      net/ · notification/ (Android adapters) · ui/
app/                  the application composition root — one AuthStore, GymRuntime, TrainingStore
                      and notification adapter shared by the activity and receivers.
                      Portrait-only.
```

Each product depends on `:platform`, never on another product (`STRUCTURE.md`). Enforced by Gradle:
the dependency does not exist in any product's build file.

## Build

```sh
export JAVA_HOME=…    # JDK 17+; Android Studio's bundled JBR works, CI uses temurin 21
ANDROID_SENTRY_DSN=https://local-check@telemetry.invalid/1 ./gradlew build  # local verification only
```

- `local.properties` names the SDK (`sdk.dir=…`); Android Studio writes it on first open.
- Modules target `compileSdk 36` / `minSdk 26`, Java 17 source and JVM target.
- The ladder suite reads its golden — `packages/api-contract/gym-ladder.json` — out of the repo by
  walking up from the project directory, never a bundled copy, so the whole monorepo must be checked
  out. Same drift gate web and iOS run: a rule changed in one language fails in the others.
- The unit suite includes a Robolectric half (`gym/src/test/.../ui/`): real screens composed on the
  JVM and really tapped. The first run downloads Robolectric's android-all jar from Maven Central,
  so the very first `build` wants a network.
- `-Pwindmill.apiBase=http://10.0.2.2:8088` points a build at the local backend; `10.0.2.2` is the
  emulator's mapping to the host loopback. Empty (the default) means the production host.

## Observability

Release builds initialize Sentry before local account and workout storage. The shared HTTP boundary
reports unexpected handled failures, including timeouts and malformed replies; product stores report
handled local failures. Behavioral events persist in an account-isolated queue and reach Amplitude
through `/v1/events`. Coach events include outcome and numeric latency without question or answer
content. Release assembly requires `ANDROID_SENTRY_DSN`; signing-input CI consumes the repository
secret of that name for the dedicated Android Sentry project. `-Pwindmill.sentryDsn` overrides it for
local builds. Debug telemetry is disabled by default and can be enabled with `-Pwindmill.debugTelemetry=true`.
See [`docs/ANDROID_OBSERVABILITY.md`](../../docs/ANDROID_OBSERVABILITY.md) for event names, privacy,
delivery limits and collector tests. The placeholder DSN in the local build command is for validation
only; a distributable release requires the configured project DSN.

## Sign-in

An emailed **6-digit code**: the door asks for an address, the mint rides `door: "app"` so the mail
carries a code instead of a link, and typing the code finishes the sign-in
(`POST /v1/auth/verify-code`). The same field takes a pasted magic link or bare token
(`MagicLink.token`) as the fallback. There are no app links.

The session secret rides `Authorization: Bearer`. `SessionStore` seals the credential and its
verified user in one committed document. A restore that cannot reach the server (or meets a 5xx)
keeps a previously bound identity signed in and **unverified**; the room uses that account's
device copies. Legacy, partial or unreadable identity data stays unresolved until `/v1/me`
confirms it; it never becomes anonymous write authority. `reverify` asks again on resume.
Only a definitive 401 spends the secret and signs the seat out. Each account transport remains
bound to its selected user and credential, and local workout writes recheck current ownership.

The secret and the remembered user are **sealed on disk** (`SecretVault`: AES-GCM under a key minted
in the Android Keystore) and the app opts out of backup entirely — `allowBackup="false"` plus
`dataExtractionRules`/`fullBackupContent` excluding every domain. Keep both: without them a 90-day
bearer and an email address ride cloud backup, device-to-device transfer and `adb backup` off the
device in the clear. A phone whose Keystore refuses keeps nothing rather than falling back to
plaintext.

## Gym

Routines, Log and Coach are the three roots. Workouts begin only on an explicit start action.
Manual training and settings work signed out; Coach and Notes require an account. Gym supplies
settings and connected-log destinations through product-neutral `ShellActions`; the account sheet
dismisses before navigating. Product UI rules live in [gym design](../../docs/design/gym/briefs/00-README.md).

Coach uses the same renderer for current and retained conversations. `LocalCoach` persists
account-scoped drafts, request ids, attachments and partial generations through process death.
Retries retain request and attachment identity; Stop preserves partial words and completed
receipts. Routine edits require human Apply. Retained images use authenticated HTTP bodies,
never credential-bearing URLs. `CoachPhotos` normalizes orientation and limits JPEG/PNG to
4096 pixels per edge and 5 MiB. New chat clears the pending local request; server history remains.

**The room opens and works signed out**: sessions, routines, movements, weigh-ins and gym's own
settings live on the device in `LocalLog` + `SetQueue` + `LocalBodyweight` + `LocalPreferences`. The six barbell movements —
back-squat · bench-press · deadlift · overhead-press · barbell-row · chin-up — ride with every seat
as a client constant (`domain/Training.kt`, ids and names identical to `backend/db/schema.sql`'s
seed), filling only ids the catalog does not already hold, so an anonymous squat is logged against
the real `back-squat` and signing in lands it on the movement the log already has.

Signing in selects an account; it does not adopt anonymous records. Gym settings offers **These
are mine** and **Not mine** for the frozen local-data batch. Signed-out approval opens a specific
sign-in flow; verified identity binds that batch to one account before credentials are committed.
Signed-in approval uses that account directly. Canceling the flow revokes the pending intent.

`ClaimConsent` and `LocalClaimConsent` preserve the batch, source revisions, decision and owner.
The journal syncs its temporary file, atomically replaces the decision and syncs its directory
before publishing authority. A corrupt or uncertain journal blocks transfer. Each repository
persists its completed batch marker with the move or removal; a restart resumes only the approved
owner, and newer or changed anonymous records remain separate. Active-queue preflight must pass
before that owner's transfer or replay can proceed. Not mine holds the exact batch for a
9-second Undo, then removes only unchanged captured records.

Once records belong to the selected account, `ClaimReplay` delivers settings, movements, routines,
finished sessions oldest-first, the unanswered live-session start, then weigh-ins. Each finished
session replays start → sets → finish with `joinOpenSession: false`. The queue's persisted
`unclaimed` bit means the server has not answered a session start; it is not consent authority.

Rules that must hold:

- A claimed workout is never re-started: a start replay settles staleness on the server.
- After consent recovery clears its preflight, the selected account's owed sets drain before
  replay and the log read. A settling read waits for the replay runner; blocked recovery cannot
  bypass that gate through the ordinary delivery cadence.
- Settings lead the claim, and a settings write that does not land halts none of the rest and
  re-arms none of it; it retries on the delivery cadence (`ClaimReplay.runPreferences`) rather than
  putting the whole walk on a four-second poll, which would re-send a start the log has refused.
- Untouched preference defaults are not a local-data claim. Only a saved preference document
  participates, and a delayed response cannot overwrite another account or a newer local revision.
- A user-tapped start sends `joinOpenSession: false` explicitly — a start is never a silent join
  under a different plan. On the log's 409 `session-already-open` the room re-reads the log, adopts
  the open workout through the ordinary read path, and repeats the refusal in the log's own words.
- The first-session picker (`TrainingStore.firstSession`) keys on reads that ANSWERED, never on
  lists that came back empty: the log page must have said *there is no more* and the routines page
  must have arrived, so a returning lifter with no signal is never treated as brand new.

Signed in with no signal — or a 5xx, or a `clock-ahead` 400 — Start, "keep as a routine" and a new
movement compose on the device exactly as signed out, and the claim lands them on the delivery
cadence; a refusal with a reason (404 routine, 409 already open) is repeated as it arrived. A
device-held session with no activity for four hours is finished at that activity on the next
connect — the server's own auto-close, run on the shelf it never reaches.

## Seats

**Every device store is filed under a seat** (`Seat`: `u.<userId>`, or `anon` for nobody), and the
account id is in the KEY rather than in a field a read filters on — a shelf opened for one seat can
never resolve another's rows. So a workout composed offline under one account is never replayed onto
the next account to hold the phone, and the first lifter's owed sets wait under their own key.

Anonymous and quarantined records move only under the explicit consent journal. Selecting an
account or restoring cached credentials grants no ownership. An unverified account keeps its own
local room, while any incomplete approved transfer remains blocked until verified recovery.

**A shelf or queue carrying no seat name** is attributed when that file is opened, off the session
the device is holding — `PrefsSessions`, read by `WindmillApplication` and handed to
`LocalLog`/`SetQueue` as `deviceOwner`. Never the arriving `Account`: the room mounts before
`/v1/me` resolves, so the first account it connects for is nobody on every launch, and reading it
would quarantine every signed-in lifter's shelf mid-workout. Rows written while signed in are seated
to that account and claim like any other; rows on a phone holding no session are **quarantined** —
reachable by no seat, replayed to no account, deleted by nothing. The decision is written back at
once, so no later launch decides it differently. Gym's settings section is the one door out, and it
requires the local-data decision; a signed-out decision opens its bound sign-in flow. iOS attributes legacy files using its Keychain session.

## Workout runtime

`GymRuntime` is shared by the activity and notification receivers. Receivers restore local state
without starting HTTP authentication. The queue commits an offered set, consumed action and event
timestamp together before reporting success. Rack edits, movement/account changes and finish
invalidate old actions. Log set requires unlock and current action identity.

The ongoing workout notification shows routine, movement, rack and set count. Eligible systems
may promote it to a Live Update. Dismissing hides it for that workout; Show workout restores it.
Exercise paging uses native Compose scrolling; rack edits and logging wait for a settled page.

Workout elapsed and time since the latest retained set derive from saved timestamps, survive
relaunch and freeze at finish. There is no rest target, alert, exact-alarm permission or set
confirmation sound/vibration. The phone displays kilograms even when the account preference is lb.

Preference and routine replacements first read and preserve server-owned fields; failed reads
prevent writes. The saved-workout decoder accepts the four retired version-1 keys (`rest`,
`attemptedRest`, `alertAccess`, `restAlerts`) without interpreting them. Future versions, unknown
control fields and malformed current fields leave the queue read-only for recovery.

## CI and releases

`.github/workflows/android.yml` builds and tests main pushes and pull requests touching
`apps/android/**`, `packages/api-contract/**` or the workflow itself. An `android-v*` tag or a
versioned `workflow_dispatch` also produces an unpublished signing-input artifact containing a
non-debuggable APK, SHA-256 and source/run provenance. Its transient build signature is not the
retained release identity. CI has read-only repository permissions and receives no private signing
configuration. `versionCode` equals the workflow run number and must exceed the highest version code previously
published, including releases newer than the device used for acceptance.

Release signing happens locally with the retained encrypted PKCS12 key and its separately retained
password. `release-signing.json` pins only the public certificate SHA-256. `tools/release.py finalize`
takes independently checked commit, ref, version, workflow and run identities, verifies the
downloaded input, receives the password through stdin, and verifies the final certificate and
unchanged application contents. Its output includes the APK, digest and provenance linked to the
exact input bytes. It does not publish. Native acceptance and a same-key update check precede
uploading the public artifacts to the matching GitHub release.

Spoken TalkBack acceptance remains unverified. Routines tab-label clipping at 320dp with 200% text
is an open layout follow-up in the [design consistency ledger](../../docs/design/consistency.md).

Distribution is by sideload, not an app store. In-place updates require the installed APK's signing
identity. The historical published APKs through 0.7.1 used different debug certificates; the
retained release key cannot update those installations in place. Uninstalling removes app data,
including records saved only on that phone. Preserve those records before any installation change;
signing in alone does not transfer anonymous records.
