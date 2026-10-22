# Sign out asks first, and offers Keep or Discard for unconfirmed changes (Shell file)

**Figma:**
- Shell · Android 16c Sign out?: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=52-1053) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=52-1215)
- Shell · Android 16e Sign out? with unconfirmed changes: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=52-1127) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=52-1257)
- System parts: the M3 kit Basic dialog (16e adds a third action); destructive actions in the M3 error role.

**Today** (paths start with `platform/` = `apps/android/platform/src/main/kotlin/works/windmill/platform/`, `gym/` = `apps/android/gym/src/main/kotlin/works/windmill/gym/`, `sync/` = `apps/android/sync-engine/src/main/kotlin/works/windmill/sync/engine/`)
- **Sign out** in You signs out at once, with no question (`platform/you/YouSheet.kt:101-121`, then `AuthStore.signOut`, `platform/auth/Auth.kt:214-230`, which calls the lifecycle's `signOut`).
- The gym's lifecycle always keeps unconfirmed changes: `GymEngineSession.signOut` opens the engine's sign-out and finishes it with `SignOutChoice.keep` (`gym/store/GymEngineSession.kt:116-124`), then emits `gym_sign_out` `action=keep`.
- The engine already offers what the dialog needs: `SyncRuntime.signOut()` returns a `SignOutSession` with `unsent` (ready + sent + pending), `finish(keep | discard)` and `cancel()` (`sync/Lifecycle.kt:39-55`).
- A failed sign-out says *Sign-out could not be saved. Your work is still on this phone. Try again.* (`platform/you/YouSheet.kt:112`).

**Change**
- **Sign out** opens the engine's sign-out first and reads `unsent`, then asks:
  - 16c, nothing unconfirmed: an M3 dialog *Sign out?* / *Your log stays in your account and leaves this phone.* / **Cancel** · **Sign out** (error role).
  - 16e, `unsent` > 0: *Sign out?* / *3 changes haven’t been confirmed by your account yet. Keep them on this phone until you sign in again, or discard them from this phone.* (*{n} changes* / *1 change hasn’t*) / **Cancel** · **Discard** (error role) · **Keep**.
- **Sign out** and **Keep** finish with `keep`: the changes stay hidden on this phone and are sent at this account's next sign-in. **Discard** finishes with `discard`: they are deleted from this phone only; a change already sent may already be in the account, so no word says *for good*.
- **Cancel** cancels the engine's sign-out and leaves the lifter signed in, with You still open.
- Only then does `AuthStore.signOut` end the session. Move the choice through the `AuthLifecycle` so the platform sheet asks and the gym session finishes with the lifter's answer; the platform stays product-neutral.
- The dialog survives recreation (a mode switch keeps it up with the same count).

**Out of scope:** You's rows (46); Delete account (48); the journal (Android carries the gym only).

**Done when**
- Screenshots of 16c and 16e match in Dark and Daylight; the rig (01) adds `16c-sign-out-dark/light`, `16e-sign-out-unsent-dark/light`.
- `gym_sign_out` carries the lifter's answer: `action=keep` / `discard` / `cancel`, `outcome=completed` / `failed`, plus `state=shown` when the dialog opens. `auth_signed_out` still fires once on a finished sign-out. List the new values in `docs/ANDROID_OBSERVABILITY.md`.
- A failed finish reports under `auth_sign_out` (as today) and keeps the lifter signed in with the reason in You.
- Tests: `YouSheetTests.kt` (no dialog → no sign-out; the two dialogs by count), `apps/android/gym/src/test/kotlin/works/windmill/gym/store/GymEngineSessionTests.kt` (keep, discard, cancel reach the engine), `apps/android/platform/src/test/kotlin/works/windmill/platform/auth/AuthStoreTest.kt` (cancel leaves the session).

**Depends on:** 46.

**Ledger:** 7c; dogfood `android-gym-target-page`.
