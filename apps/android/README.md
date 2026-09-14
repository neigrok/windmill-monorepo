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
gym/                  the room — domain/ (pure) · store/ (SetQueue, the offline-first flush queue) ·
                      net/ · ui/
app/                  the composition root — the only module that knows which rooms exist.
                      Portrait-only.
```

Each product depends on `:platform`, never on another product (`STRUCTURE.md`). Enforced by Gradle:
the dependency does not exist in any product's build file.

## Build

```sh
export JAVA_HOME=…    # JDK 17+; Android Studio's bundled JBR works, CI uses temurin 21
./gradlew build       # assembles every module and runs the JVM unit suite
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

## Sign-in

An emailed **6-digit code**: the door asks for an address, the mint rides `door: "app"` so the mail
carries a code instead of a link, and typing the code finishes the sign-in
(`POST /v1/auth/verify-code`). The same field takes a pasted magic link or bare token
(`MagicLink.token`) as the fallback. There are no app links.

The session secret rides `Authorization: Bearer` and sleeps behind `SessionStore` beside the last
user it was answered for. A restore that cannot reach the server (or meets a 5xx) keeps the secret
AND stands the seat up signed in and **unverified** on that user — the gym room connects for the
account off the copies the device holds (`DeviceCopy`: names, routines, the picker's meta) — and
`reverify` asks again on every resume until `/v1/me` answers. Only a definitive 401 spends the
secret and signs the seat out.

The secret and the remembered user are **sealed on disk** (`SecretVault`: AES-GCM under a key minted
in the Android Keystore) and the app opts out of backup entirely — `allowBackup="false"` plus
`dataExtractionRules`/`fullBackupContent` excluding every domain. Keep both: without them a 90-day
bearer and an email address ride cloud backup, device-to-device transfer and `adb backup` off the
device in the clear. A phone whose Keystore refuses keeps nothing rather than falling back to
plaintext.

## The room

The three roots are Routines, Log and Coach. Routines supports named plans and direct logging;
a workout starts only when the lifter chooses a start action. Log reads performed workouts,
movement records and weigh-ins. Coach and Notes require an account, while local training and
settings remain available signed out.

The account sheet receives Gym settings and Connected log destinations through product-neutral
`ShellActions`. Gym owns their route callbacks; the sheet finishes dismissal before navigation.
`GymRoom` retains the originating tab and Back stack. Settings is reached from the account sheet
or the active workout’s gear. It contains units, rest timer, Notes,
Connected log and Account. There is no Kind or set-confirmation sound/haptic control. Selecting lb
retains the explicit notice that this phone still displays kg.

Coach's live and past answers share `CoachAnswer`: complete prose, versioned saved evidence and
scoped read details. A single directly read full workout can provide a metric card; summary-only
and multiple-session observations remain in the disclosure. Historical receipts are stored with
the answer, so later training edits cannot change what that answer says it read. Four successful
questions end a conversation; Ask new opens a new draft without sending it. Proposal reads distinguish
available, missing and failed: failed reads offer retry; confirmed missing proposals show a terminal
availability message. An immediate decision uses its actual response. A cold conversation cannot
reconstruct a deleted proposal ledger from the answer text.

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
the device is holding — `PrefsSessions`, read at the room's edge (`GymRoom`) and handed to
`LocalLog`/`SetQueue` as `deviceOwner`. Never the arriving `Account`: the room mounts before
`/v1/me` resolves, so the first account it connects for is nobody on every launch, and reading it
would quarantine every signed-in lifter's shelf mid-workout. Rows written while signed in are seated
to that account and claim like any other; rows on a phone holding no session are **quarantined** —
reachable by no seat, replayed to no account, deleted by nothing. The decision is written back at
once, so no later launch decides it differently. Gym's settings section is the one door out, and it
requires the local-data decision; a signed-out decision opens its bound sign-in flow. iOS attributes legacy files using its Keychain session.

## CI and releases

`.github/workflows/android.yml` builds and tests every push and pull_request touching
`apps/android/**`, `packages/api-contract/**` or the workflow itself. An `android-v*` tag builds a
release APK and publishes it as a GitHub Release; `workflow_dispatch` with a version does the same
build and leaves the APK as an actions artifact. There is no store distribution: a release is a
sideload. `versionCode` is the workflow run number, so a later tag can never ship a smaller code.

Signing is armed by four repo secrets. With none set, each CI runner can generate its own **debug
key**, so releases from different runs can carry incompatible signatures. The published
`android-v0.7.0` and `android-v0.7.1` APKs have different signing certificates: `0.7.1` cannot update
a `0.7.0` installation in place.

An in-place update that preserves app data requires the same key that signed the installed APK.
Configuring a new key does not restore compatibility with that installation. Future releases need
one retained release key supplied through all four secrets; setting only some fails the workflow.
Configure that key once with:

```sh
gh secret set WINDMILL_ANDROID_KEYSTORE_B64 --body "$(base64 -i windmill.keystore)"
gh secret set WINDMILL_ANDROID_KEYSTORE_PASSWORD
gh secret set WINDMILL_ANDROID_KEY_ALIAS
gh secret set WINDMILL_ANDROID_KEY_PASSWORD
```
