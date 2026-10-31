# Sign-in: a digit keyboard for the code, autofill for email and code

**Status:** ✅ Conformance to the approved Shell board; behaviour only, with nothing visual changing. Not started.

**Figma:** Shell 15b Sign in, code focused: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=33-4237) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=34-792). The caption reads "Code takes the number keyboard".

**Current implementation** (the sign-in fields from task 27)
- The 6-digit code field opens the full phone pad (− , . space): `runs/outside/15b-sign-in-code-focused-dark.png`.
- Neither field carries an autofill hint.
- The email field already uses `TYPE_TEXT_VARIATION_EMAIL_ADDRESS`.

**Change**
- **Code field:** a digits-only keyboard (`KeyboardType.NumberPassword`, or `Number` with no separators) that accepts digits only.
- **Autofill:** content types for the email address and the one-time code (Compose `ContentType` semantics, or `autofill` modifiers on the platform this targets), so SMS and email code suggestions and saved emails appear.
- The TalkBack label "Email field" becomes "Email".

**Done when**
- The uiautomator dump of 15b shows the code field's input type as number and its autofill hints present.
- Captures are unchanged against 15a–15c.
- Tests assert the semantics: the content types and the keyboard type.

**Depends on:** 27.
