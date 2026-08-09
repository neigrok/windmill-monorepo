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

Nothing needs an account first: the gym room opens and works signed out (sessions, routines and
movements live on the device in `LocalLog` + `SetQueue`), and signing in claims all of it onto the
account through `ClaimReplay` — movements first, then routines, then finished sessions
oldest-first, each replayed start → sets → finish with `joinOpenSession: false`.

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
