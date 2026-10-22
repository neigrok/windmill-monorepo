# Sign-in: outlined email and code fields, no standing line, the server's refusal (Shell file)

**Figma:**
- 15a Sign in, email: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-1946) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-753)
- 15b Check your email, code: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4237) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-792)
- 15c Check your email, code refused: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4317) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-834)
- Components: the M3 kit Text field (Outlined) and Keyboard on the Shell boards; `Android / Button` (Design System library). The Shell boards still use `Android / Root bar` until the Design System library publishes `Android / Top app bar`.

**Today** (paths start with `platform/` = `apps/android/platform/src/main/kotlin/works/windmill/platform/`)
- `platform/auth/SignInDoor.kt`:
  - Step 1 *Sign in*, step 2 *Check your email* (:112); *Code sent to {email}.* (:120); *Works once. Expires in 15 minutes.* (:122); *Resend in Ns* / *Resend* (:125).
  - Fields come from `DoorField` (:145-160): a label *Email* / *Code* drawn ABOVE the field (:149), then an `OutlinedTextField` with placeholder *you@example.com* / *6-digit code* (:116, :121), radius 20, `unfocusedBorderColor = Color.Transparent` (:158).
  - In Dark the unfocused field has no outline at all, so the field is hard to find.
  - Under the email field, a standing line: *Training on this phone can join your account. If both have training, you choose Add or Discard.* (:117-118).
  - A refusal sets `isError` and prints a sentence under Resend in `noticeInk` (:128). Every refused code, a typo included, reads *That code has expired. Codes work once and last 15 minutes — send a fresh one.*: `MagicLink.refusal` (`platform/auth/Auth.kt:263-267`) returns `expiredCode` (:261) for anything but offline and 426.
- The server answers a refused code with *That code didn't work* / *Check the digits, or send a fresh one.* (`backend/platform/adapters/http/AuthApi.cpp:300-301`; iOS shows them as one sentence, `apps/ios/App/Sources/AppRuntime.swift:278`).

**Change**
- *Email* and *Code* become M3 outlined fields with the label inside the outline (`OutlinedTextField(label = { Text("Email") })`), the standard outline colour unfocused and the accent focused. Delete the label above the field.
  - Keep the keyboards (`KeyboardType.Email`, `KeyboardType.Number`), placeholders and the TalkBack description.
  - Use the M3 default outlined shape; drop the 20 dp radius and the filled container.
- 15a: delete the standing line. Sign-in is suggested once, on the first receipt (14); the email step says nothing about training.
- 15c, refused code: the error outline and, under *Resend* in the error role, the server's words as one sentence: *That code didn’t work. Check the digits, or send a fresh one.* `MagicLink.refusal` prints the server's `error` and `detail` when it sends them, and keeps *That code has expired…* only for a reply that carries none. Offline and 426 keep their own lines. The shell's theme (`platform/design/WindmillMaterial.kt`) maps M3 `error` to the same values as the gym (#E46962 dark / #B3261E light, 02), so the field's error outline and the sentence agree.
- No other copy changes.

**Out of scope:**
- You, signed out and signed in (46), sign-out (47).
- The gym's error role (02).

**Done when**
- Screenshots of 15a, 15b and 15c match in Dark and Daylight, keyboard up; the rig (01) adds `15a-sign-in-email-dark/light`, `15b-sign-in-code-dark/light`, `15c-sign-in-code-refused-dark/light`.
- `auth_code_requested`, `auth_code_sent`, `auth_sign_in_started`, `auth_signed_in` still fire; failures still report as `auth_sign_in`.
- Tests: `apps/android/platform/src/test/kotlin/works/windmill/platform/auth/SignInDoorTests.kt` (no standing line; a 410 refusal shows the server's sentence), `…/auth/AuthStoreTest.kt`, `…/auth/SignInDoorLayoutTests.kt`, and the gym's `ui/SignInDoorSkinTests.kt` (`apps/android/gym/src/test/kotlin/works/windmill/gym/`).

**Depends on:** 02.

**Ledger:** 11m, 12f, 12j; dogfood `android-gym-target-page`.
