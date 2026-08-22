# Windmill Android

One Kotlin/Compose superapp for the whole brand — the native mirror of `apps/ios` and `web/`.
One room is built: **gym**, because the phone is the device that owns the open session — workout
mode, the ladder, the keypad, the rest clock and the offline set queue all need a device that is
with you, awake and able to log in a basement with no signal
(`backend/products/gym/ARCHITECTURE.md` §11). `roadmap` and `journal` arrive as later modules,
mounted the same way. There is no subscription surface here yet.

## Layout

```
settings.gradle.kts   includes :app :platform :gym
platform/             the product-neutral seam: WindmillApi (the Bearer transport) · AuthStore +
                      the emailed-code door (magic-link paste as fallback) · SessionStore · Tokens ·
                      the ProductModule / Account seam · SignInDoor · YouSheet
gym/                  the room, ported file-for-file from apps/ios's WindmillGym —
                      domain/ (pure) · store/ (SetQueue, the offline-first flush queue) · net/ · ui/
app/                  the lean composition root — the only module that knows which rooms exist.
                      Portrait-only.
```

Each product depends on `:platform`, never on another product — the same one-directional rule the
backend, web and iOS follow (`STRUCTURE.md`). Enforced by Gradle: the dependency simply does not
exist in any product's build file.

## Build

```sh
export JAVA_HOME=…    # any JDK 17+; Android Studio's bundled JBR works
./gradlew build       # assembles every module and runs the JVM unit suite
```

`local.properties` names the SDK (`sdk.dir=…`); Android Studio writes it on first open.

The ladder suite reads its golden — `packages/api-contract/gym-ladder.json` — straight out of the
repo by walking up from the project directory, never a bundled copy, so the whole monorepo must be
checked out. The same drift gate web and iOS run: a rule changed in one language fails in the
others.

The unit suite includes a Robolectric half (`gym/src/test/.../ui/RoutinesScreenTests.kt`): real
screens composed on the JVM and really tapped, for the wiring a pure test cannot hold still. The
first run downloads Robolectric's android-all jar from Maven Central, so the very first `build`
wants a network.

## Sign-in

An emailed **6-digit code**: the door asks for an address, the mint rides `door: "app"` so the
mail carries a code instead of a link, and typing the code finishes the sign-in on this phone
(`POST /v1/auth/verify-code`). The same field still takes a pasted magic link or bare token
(`MagicLink.token`) as the fallback — older mails, and links minted from another surface, stay
usable; there are still no app links. The session secret rides `Authorization: Bearer` and sleeps
behind `SessionStore` beside the last user it was answered for; a restore that cannot reach the
server (or meets a 5xx) keeps the secret AND stands the seat up signed in and **unverified** on that
user — the gym room connects for the account, off the copies the device holds for it (`DeviceCopy`:
names, routines, the picker's meta) — and `reverify` asks again on every resume until `/v1/me`
answers. Only a definitive 401 spends the secret and signs the seat out.

The secret and the remembered user are **sealed on disk** (`SecretVault`: AES-GCM under a key
minted in the Android Keystore, which cannot be read out of the phone) and the app opts out of
backup entirely — `allowBackup="false"` plus `dataExtractionRules`/`fullBackupContent` that exclude
every domain. Both halves are deliberate: before them a 90-day bearer and an email address rode
Android's default cloud backup, device-to-device transfer and `adb backup` off the device in the
clear, and a restore stood the account up on a phone it never approved. An install upgrading into
this build re-seals what it already held on the first read; a phone whose Keystore refuses keeps
nothing rather than falling back to plaintext.

Nothing needs an account first, and **nothing starts by itself**: home is the routine list
(Routines · The log · Ask), a fresh install's empty state points at *Build a routine* with *Just
start logging* as the second path, and a session begins only when the lifter taps a start. The old
§J22 first-arrival auto-start — arriving opened a session by itself, once per install, remembered
under `firstSessionOpened` in the `works.windmill.gym` SharedPreferences — was retired 2026-08-13
(ruling R6: first-open testing named "why is a session already running" as a blocker); the stored
key is left where old installs wrote it and nothing reads it. There is still no tour, no splash, no
question about goals, and nothing anywhere that counts how many times an offer was walked past. The
account verb a lifter mid-first-session can reach is *Build my routine*, which opens the shell's
own door and comes back to the running session; it is drawn only while there is no account, because
the step after one is the MCP grant and that door is the web's on this surface.

The first-session picker (the six barbell movements pinned, `TrainingStore.firstSession`) still
keys on "nothing on the log", which is a question about reads that ANSWERED, never about lists that
came back empty: the log page has to have said *there is no more* and the routines page has to have
arrived, so a returning lifter whose phone has no signal is never treated as brand new.

A user-tapped start sends `joinOpenSession: false` explicitly (decisions §5 — a start is never a
silent join under a different plan); on the log's 409 `session-already-open` the room re-reads the
log, adopts the open workout through the ordinary read path, and repeats the refusal in the log's
own words, so the lifter resumes or discards deliberately.

Every gym route wants an account, so an anonymous install would otherwise have no catalog to pick
from; **the six** — back-squat · bench-press · deadlift · overhead-press · barbell-row · chin-up —
therefore ride with every seat as a client constant (`domain/Training.kt`, ids and names identical to
`backend/db/schema.sql`'s seed), filling only ids the catalog does not already hold. An anonymous
squat is logged against the real `back-squat`, so signing in lands it on the movement the log already
has instead of minting a duplicate.

The gym room opens and works signed out (sessions, routines, movements and the gym's own settings
live on the device in `LocalLog` + `SetQueue` +
`LocalPreferences`), and signing in claims all of it onto the account through `ClaimReplay` — the
settings first, then movements, then routines, then finished sessions oldest-first, each replayed
start → sets → finish with `joinOpenSession: false`, then the live session's start **only if the log
has not answered for it** (`SetQueue`'s persisted `unclaimed` bit; a claimed workout is never
re-started, because a start replay settles staleness on the server). On every connect the queue's
owed sets drain BEFORE the claim and before the log read, since an append settles nothing and both
of the others do; a settling read tapped mid-claim (a movement's record, an older page) waits for
the runner to end. Signed in with no signal — or a 5xx, or a `clock-ahead` 400 — Start, "keep as a
routine" and a new movement compose on the device exactly as signed out and the claim lands them on
the delivery cadence; a refusal with a reason (404 routine, 409 already open) is repeated as it
arrived. A device-held session with no activity for four hours is finished at that activity on the
next connect — the server's own auto-close, run on the shelf it never reaches. Settings lead because nothing else references
them and a rack set before signing in should survive the door; a settings write that does not land
halts none of the rest of it and re-arms none of it either — it retries by itself on the delivery
cadence (`ClaimReplay.runPreferences`) rather than putting the whole walk on a four-second poll,
which would re-send a live start the log has already refused. A phone whose settings screen was
never opened claims nothing rather than overwriting the account's own rack with untouched defaults,
and what this device still owes rides through a change of seat, because it has landed nowhere and
this is its only copy.

**Every one of those device stores is filed under a seat** (`Seat`: `u.<userId>`, or `anon` for
nobody), and the account id is in the KEY rather than in a field a read filters on — a shelf opened
for one seat can never resolve another's rows. So a workout composed offline while signed in as one
account is not replayed onto the next account to hold the phone, that account is never drawn the
previous lifter's live session, and the first lifter's owed sets are waiting under their own key
when they sign back in rather than being dropped to close the leak. The one carry is the anonymous
one — that is the anonymous-first door: work made with nobody signed in MOVES onto the first
account seat the server has confirmed **in this process** (`Account.verified`), because taking
ownership of unclaimed work is irreversible and a phone that could not be asked does not know
whether that remembered identity is still live. An unverified seat still draws its own room and
logs into it; it simply claims nothing.

A shelf or a queue written by a build from *before* the seats carries no name, so who it belongs to
is decided **when that file is opened, off the session the device is holding** — `PrefsSessions`,
read at the room's edge (`GymRoom`) and handed to `LocalLog`/`SetQueue` as `deviceOwner`. It is
emphatically **not** the arriving `Account`: the room mounts before `/v1/me` resolves, so the first
account it connects for is nobody on every launch, and a rule reading it would quarantine every
signed-in lifter's shelf and take the bar out from under anyone who upgraded mid-workout. A phone
that was **signed in** at the upgrade wrote those rows as that account: they are seated to it and
claim like any other shelf row, with no door to find. A phone holding **no session** says nothing of
the kind — *nobody is signed in now* is not *nobody wrote this*, and it may be exactly the last
account's work after they signed out, which is the original leak — so those rows are
**quarantined**: reachable by no seat, replayed to no account, and deleted by nothing. Either way
the decision is **written back at once**, so no later launch re-reads a legacy file and decides it
differently. Gym's settings section is the one door out of the quarantine, it takes a human, and it
takes a human **with an account** — nobody signed in can say whose that training is, and releasing
onto the anonymous seat would hand it to whoever signs in next. apps/ios decides the same branch off
its Keychain session.

Gym's settings — units, the rest dial and how a logged set confirms itself
(`domain/Preferences.kt`, `ui/SettingsScreen.kt`) — are reached from a row at the foot of the
Routines home rather than from You. `ProductModule` exposes a room and nothing else on this
surface, so the section carries its own door until that seam grows a settings slot.

## CI and releases

`.github/workflows/android.yml` builds and tests every push and pull_request touching
`apps/android/**`, `packages/api-contract/**` or the workflow itself. An `android-v*` tag builds a
release APK and publishes it as a GitHub Release — the tag is the version claim; the workflow makes
it installable. There is no store distribution: a release is a sideload.

Signing is armed by four repo secrets; with none set, the build falls back to the **debug key** —
sideload-ready and honest about what it is: no store identity, and not updatable in place once the
real key exists. Arm the real key once with:

```sh
gh secret set WINDMILL_ANDROID_KEYSTORE_B64 --body "$(base64 -i windmill.keystore)"
gh secret set WINDMILL_ANDROID_KEYSTORE_PASSWORD
gh secret set WINDMILL_ANDROID_KEY_ALIAS
gh secret set WINDMILL_ANDROID_KEY_PASSWORD
```
