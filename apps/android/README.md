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

## Sign-in

An emailed **6-digit code**: the door asks for an address, the mint rides `door: "app"` so the
mail carries a code instead of a link, and typing the code finishes the sign-in on this phone
(`POST /v1/auth/verify-code`). The same field still takes a pasted magic link or bare token
(`MagicLink.token`) as the fallback — older mails, and links minted from another surface, stay
usable; there are still no app links. The session secret rides `Authorization: Bearer` and sleeps
behind `SessionStore`; a restore that cannot reach the server keeps the secret — only a definitive
401 spends it.

Nothing needs an account first, and the first launch shows that rather than saying it: with nothing
on the log at all, arriving **starts a session** and the room opens on the picker over it
(`TrainingStore.firstRun`, canon §J22) — no tour, no splash, no question about goals, and nothing
anywhere that counts how many times an offer was walked past. The account verb a lifter mid-session
can reach is *Build my routine*, which opens the shell's own door and comes back to the running
session; it is drawn only while there is no account, because the step after one is the MCP grant and
that door is the web's on this surface.

"Nothing on the log" is a question about reads that ANSWERED, never about lists that came back empty:
the log page has to have said *there is no more* and the routines page has to have arrived, so a
returning lifter whose phone has no signal is never handed a session over a history the room could
not see. The arrival opens its session **once per install** (`works.windmill.gym`
SharedPreferences, the twin of the iOS `windmill.gym.firstSessionOpened`) — that is what keeps a
**sign-out** from reading as a first run, since a signed-out account's log lives somewhere this phone
deliberately keeps nothing of, and it is what makes "once" true after a first session is discarded.
It counts nothing, holds no id and records one thing the room did.

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
start → sets → finish with `joinOpenSession: false`. Settings lead because nothing else references
them and a rack set before signing in should survive the door; a settings write that does not land
halts none of the rest of it and re-arms none of it either — it retries by itself on the delivery
cadence (`ClaimReplay.runPreferences`) rather than putting the whole walk on a four-second poll,
which would re-send a live start the log has already refused. A phone whose settings screen was
never opened claims nothing rather than overwriting the account's own rack with untouched defaults,
and what this device still owes rides through a change of seat, because it has landed nowhere and
this is its only copy.

Gym's settings — units, the rest dial and how a logged set confirms itself
(`domain/Preferences.kt`, `ui/SettingsScreen.kt`) — are reached from a row at the foot of Today
rather than from You. `ProductModule` exposes a room and nothing else on this surface, so the
section carries its own door until that seam grows a settings slot.

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
