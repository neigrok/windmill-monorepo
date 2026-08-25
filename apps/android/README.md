# Windmill Android

One Kotlin/Compose superapp for the whole brand — the native mirror of `apps/ios` and `web/`.
One room is built: **gym**, the room that owns the open session — workout mode, the ladder, the
keypad, the rest clock and the offline set queue (`backend/products/gym/ARCHITECTURE.md` §11).
`roadmap` and `journal` mount the same way when they arrive. There is no subscription surface here.

## Layout

```
settings.gradle.kts   includes :app :platform :gym
platform/             the product-neutral seam: WindmillApi (the Bearer transport) · AuthStore +
                      the emailed-code door (magic-link paste as fallback) · SessionStore · Tokens ·
                      the ProductModule / Account seam · SignInDoor · YouSheet
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

Nothing needs an account first, and **nothing starts by itself**: home is the routine list
(Routines · The log · Coach), a fresh install's empty state points at *Build a routine* with *Just
start logging* as the second path, and a session begins only when the lifter taps a start. No tour,
no splash, no question about goals, and nothing that counts how many times an offer was walked past.
The one account verb reachable mid-first-session is *Build my routine*, drawn only while there is no
account — the step after one is the MCP grant, and that door is the web's.

Gym's settings — units, the rest dial and how a logged set confirms itself
(`domain/Preferences.kt`, `ui/SettingsScreen.kt`) — are reached from a row at the foot of the
Routines home rather than from You: `ProductModule` exposes a room and nothing else on this surface.

**The room opens and works signed out**: sessions, routines, movements and gym's own settings live
on the device in `LocalLog` + `SetQueue` + `LocalPreferences`. The six barbell movements —
back-squat · bench-press · deadlift · overhead-press · barbell-row · chin-up — ride with every seat
as a client constant (`domain/Training.kt`, ids and names identical to `backend/db/schema.sql`'s
seed), filling only ids the catalog does not already hold, so an anonymous squat is logged against
the real `back-squat` and signing in lands it on the movement the log already has.

Signing in claims everything through `ClaimReplay`: settings first, then movements, then routines,
then finished sessions oldest-first — each replayed start → sets → finish with
`joinOpenSession: false` — then the live session's start **only if the log has not answered for it**
(`SetQueue`'s persisted `unclaimed` bit).

Rules that must hold:

- A claimed workout is never re-started: a start replay settles staleness on the server.
- On every connect the queue's owed sets drain BEFORE the claim and before the log read — an append
  settles nothing and both of the others do. A settling read tapped mid-claim waits for the runner.
- Settings lead the claim, and a settings write that does not land halts none of the rest and
  re-arms none of it; it retries on the delivery cadence (`ClaimReplay.runPreferences`) rather than
  putting the whole walk on a four-second poll, which would re-send a start the log has refused.
- A phone whose settings screen was never opened claims nothing, rather than overwriting the
  account's own rack with untouched defaults.
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

The one carry is the anonymous seat: work made with nobody signed in MOVES onto the first account
seat the server has confirmed **in this process** (`Account.verified`). Taking ownership of
unclaimed work is irreversible. An unverified seat draws its own room and logs into it; it claims
nothing.

**A shelf or queue carrying no seat name** is attributed when that file is opened, off the session
the device is holding — `PrefsSessions`, read at the room's edge (`GymRoom`) and handed to
`LocalLog`/`SetQueue` as `deviceOwner`. Never the arriving `Account`: the room mounts before
`/v1/me` resolves, so the first account it connects for is nobody on every launch, and reading it
would quarantine every signed-in lifter's shelf mid-workout. Rows written while signed in are seated
to that account and claim like any other; rows on a phone holding no session are **quarantined** —
reachable by no seat, replayed to no account, deleted by nothing. The decision is written back at
once, so no later launch decides it differently. Gym's settings section is the one door out, and it
takes a human with an account. `apps/ios` decides the same branch off its Keychain session.

## CI and releases

`.github/workflows/android.yml` builds and tests every push and pull_request touching
`apps/android/**`, `packages/api-contract/**` or the workflow itself. An `android-v*` tag builds a
release APK and publishes it as a GitHub Release; `workflow_dispatch` with a version does the same
build and leaves the APK as an actions artifact. There is no store distribution: a release is a
sideload. `versionCode` is the workflow run number, so a later tag can never ship a smaller code.

Signing is armed by four repo secrets. With none set, the build falls back to the **debug key** —
sideload-ready, no store identity, and not updatable in place once the real key exists. Some but not
all four set fails the workflow. Arm the real key once with:

```sh
gh secret set WINDMILL_ANDROID_KEYSTORE_B64 --body "$(base64 -i windmill.keystore)"
gh secret set WINDMILL_ANDROID_KEYSTORE_PASSWORD
gh secret set WINDMILL_ANDROID_KEY_ALIAS
gh secret set WINDMILL_ANDROID_KEY_PASSWORD
```
