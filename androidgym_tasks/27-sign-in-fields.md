# Sign-in: outlined email and code fields, no standing line, the server's refusal (Shell file)

**Figma:**
- 15a Sign in, email: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-1946) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-753)
- 15b Check your email, code: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4237) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-792)
- 15c Check your email, code refused: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4317) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-834)
- Components: the M3 kit Text field (Outlined) and Keyboard on the Shell boards; `Android / Button` (Design System library). The Shell boards still use `Android / Root bar` until the Design System library publishes `Android / Top app bar`.

**Implementation** (paths start with `platform/` = `apps/android/platform/src/main/kotlin/works/windmill/platform/`)
- `platform/auth/SignInDoor.kt` uses native M3 outlined Email and Code fields with embedded labels, transparent containers, the default shape, a visible unfocused outline and the focused accent. The email step has no standing training line.
- The Code helper becomes the refusal beneath its field, followed by the paste-link hint, Resend and the pinned actions. The error outline, trailing icon and refusal share Material's error role.
- `platform/auth/Auth.kt` joins nonblank server `error` and `detail` text. Missing server words retain the existing link/code expiry fallback; offline and update-required responses retain their own text.
- The native capture recipe is `apps/android/tools/capture-recipes/sign-in-fields.json`. It uses the rig’s isolated mail fixture and the real auth API/database for code request, refusal and successful completion.
- `platform/design/WindmillMaterial.kt` maps error to #E46962 Dark / #B3261E Daylight. The verified 24×24 Figma error glyph is kept in `apps/android/platform/design-assets/auth-field-error.svg`, with its unchanged xxxhdpi raster in `apps/android/platform/src/main/res/drawable-xxxhdpi/auth_field_error.png`; Compose tints one asset at 24 dp.

**Change**
- *Email* and *Code* become M3 outlined fields with the label inside the outline (`OutlinedTextField(label = { Text("Email") })`), the standard outline colour unfocused and the accent focused. Delete the label above the field.
  - Keep the keyboards (`KeyboardType.Email`, `KeyboardType.Number`), placeholders and the TalkBack description.
  - Use the M3 default outlined shape; drop the 20 dp radius and the filled container.
- 15a: delete the standing line. Sign-in is suggested once, on the first receipt (14); the email step says nothing about training.
- 15c, refused code: the error outline and trailing error icon; directly below *Code*, replace *Works once. Expires in 15 minutes.* with the server's words in the error role: *That code didn’t work. Check the digits, or send a fresh one.* `MagicLink.refusal` prints the server's `error` and `detail` when it sends them, and keeps *That code has expired…* only for a reply that carries none. Offline and 426 keep their own lines. The shell's theme (`platform/design/WindmillMaterial.kt`) maps M3 `error` to the same values as the gym (#E46962 dark / #B3261E light, 02), so the field's error outline and the sentence agree.
- Keep *You can also paste the email link.*, *Resend*, *Sign in* and *Change email* in that order after the helper/refusal. The helper/refusal starts 12 dp below the field and wraps naturally. No other copy changes.

**Out of scope:**
- You, signed out and signed in (46), sign-out (47).
- The gym's error role (02).

**Done when**
- Baseline screenshots follow 15a with the Email keyboard shown and 15b/15c with the keyboard hidden, in Dark and Daylight. Keep the specified native field behavior: an empty, unfocused Code label stays inside; focusing floats it and reveals the placeholder. The 15b drawing's floating empty/unfocused label is tracked for Figma reconciliation in `docs/design/consistency.md` (11m). The rig (01) adds `15a-sign-in-email-dark/light`, `15b-sign-in-code-dark/light`, `15c-sign-in-code-refused-dark/light`.
- Separately focus the Code field in 15b/15c with the native Number keyboard. Insets and scrolling keep Code/refusal visible and Resend, Sign in and Change email reachable on a small-height screen and at large text sizes.
- `auth_code_requested`, `auth_code_sent`, `auth_sign_in_started`, `auth_signed_in` still fire; failures still report as `auth_sign_in`.
- Tests: `apps/android/platform/src/test/kotlin/works/windmill/platform/auth/SignInDoorTests.kt` (no standing line; a 410 refusal shows the server's sentence), `…/auth/AuthStoreTest.kt`, `…/auth/SignInDoorLayoutTests.kt`, and the gym's `ui/SignInDoorSkinTests.kt` (`apps/android/gym/src/test/kotlin/works/windmill/gym/`).

**Verification:** Native baseline/focused captures cover all six frames, with separate small-height and double-text Number-keyboard checks. Full evidence, exact APK provenance and harness limitations are recorded in `docs/engineering/android-sign-in-fields.md`.

**Depends on:** 02.

**Ledger:** 11m, 12f; dogfood `android-gym-target-page`.
