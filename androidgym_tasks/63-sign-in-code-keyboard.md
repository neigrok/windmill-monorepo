# Sign-in: a digit keyboard for the code, autofill for email and code

**Status:** ✅ Conformance to the approved Shell board; behaviour only, with nothing visual changing. Implemented on its task branch; not yet on main or in a release.

**Figma:** Shell 15b Sign in, code focused: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4237) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-792). The caption reads "Code takes the number keyboard".

**Current implementation** (`platform/auth/SignInDoor.kt`)
- The code field opens the digit keyboard (`KeyboardType.NumberPassword`, input type `0x12`); the rig's `15b-sign-in-code-focused` capture shows the 0–9 pad. The keyboard enters digits only; the field still takes a pasted email link, which the board's *You can also paste the email link.* promises.
- The email field carries `ContentType.EmailAddress` (`emailAddress`); the code field carries `smsOTPCode` and `emailOTPCode`.
- TalkBack names the fields "Email" and "Code"; the capture recipes tap those labels.
- `SignInDoorTests.emailAndCodeOfferAutofillAndTheCodeOpensTheDigitKeyboard` asserts the hints and the platform input types.

**Change**
- **Code field:** the digit keyboard (`KeyboardType.NumberPassword`). The keyboard enters digits; the field still accepts a pasted email link, which the board promises.
- **Autofill:** content types for the email address and the one-time code (Compose `ContentType` semantics, or `autofill` modifiers on the platform this targets), so SMS and email code suggestions and saved emails appear.
- The TalkBack label "Email field" becomes "Email".

**Done when**
- The uiautomator dump of 15b shows the code field's input type as number and its autofill hints present.
- Captures are unchanged against 15a–15c.
- Tests assert the semantics: the content types and the keyboard type.

**Depends on:** 27.
