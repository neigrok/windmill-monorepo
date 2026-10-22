# Sign-in: outlined email and code fields (Shell file)

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
  - A refusal sets `isError` and prints the server sentence under Resend in `noticeInk` (:128), for example *That code has expired. Codes work once and last 15 minutes — send a fresh one.* (`platform/auth/Auth.kt:261`).

**Change**
- *Email* and *Code* become M3 outlined fields with the label inside the outline (`OutlinedTextField(label = { Text("Email") })`), the standard outline colour unfocused and the accent focused. Delete the label above the field.
  - Keep the keyboards (`KeyboardType.Email`, `KeyboardType.Number`), placeholders and the TalkBack description.
  - Use the M3 default outlined shape; drop the 20 dp radius and the filled container.
- 15c, refused code: the error outline and the server sentence under *Resend*, in the error role. The shell's theme (`platform/design/WindmillMaterial.kt`) maps M3 `error` to the same values as the gym (#E46962 dark / #B3261E light, 02), so the field's error outline and the sentence agree.
- Copy unchanged everywhere. *Sign out* stays ink (no ruling).

**Out of scope:**
- You, signed out and signed in (16a, 16b match today).
- The gym's error role (02).

**Done when**
- Screenshots of 15a, 15b and 15c match in Dark and Daylight, keyboard up; the rig (01) adds `15a-sign-in-email-dark/light`, `15b-sign-in-code-dark/light`, `15c-sign-in-code-refused-dark/light`.
- `auth_code_requested`, `auth_code_sent`, `auth_sign_in_started`, `auth_signed_in` still fire; failures still report as `auth_sign_in`.
- Tests: `apps/android/platform/src/test/kotlin/works/windmill/platform/auth/SignInDoorTests.kt`, `…/auth/SignInDoorLayoutTests.kt`, and the gym's `ui/SignInDoorSkinTests.kt` (`apps/android/gym/src/test/kotlin/works/windmill/gym/`).

**Depends on:** 02.

**Ledger:** 11m; dogfood `android-gym-target-page`.
