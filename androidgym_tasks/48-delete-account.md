# Delete account, from You, signed in (Shell file)

**Figma:**
- Shell · Android 27a Delete your account?: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1269) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1667)
- Shell · Android 27b Email typed: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1328) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1693)
- Shell · Android 27f Delete your account?, with unsent changes: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=96-2122) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=96-2192)
- Shell · Android 27g Email typed, with unsent changes: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=96-2157) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=96-2227)
- Shell · Android 27c Deleting…: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1525) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1719)
- Shell · Android 27d Account deleted: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1588) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1746)
- Shell · Android 27e Couldn’t delete: [Dark](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1606) / [Daylight](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=54-1757)
- The entry is the last row of You signed in, *Delete account* in the error role (16b, linked from 46).
- System parts: `Android / Back bar`, the kit OutlinedTextField and circular progress indicator, the M3 error role.

**Today** (paths start with `platform/` = `apps/android/platform/src/main/kotlin/works/windmill/platform/`)
- No surface can delete an account. You has no such row (`platform/you/YouSheet.kt:83-121`).
- The server closes one: `DELETE /v1/me` with body `{"account": "<the signed-in user id>"}` (`backend/platform/adapters/http/AuthApi.cpp:572-597`). It answers 401 *sign in to close your account*, 400 `malformed`, 409 `account-mismatch` when the id is not the caller's, or 200 with `closesMs` and `closingOn`, now + 30 days (`backend/platform/domain/Auth.h:52`). Every session and every connected tool is revoked at once (`AuthService::closeAccount`, `backend/platform/application/AuthService.cpp:333`).
- The promise *After that, it is deleted for good.* holds: a sign-in before `closesMs` brings the account back, and from `closesMs` on the account is erased with all its data, by the first sign-in that meets it or an hourly sweep; a sign-in after that starts a new, empty account (`backend/AUTH.md`, `DELETE /v1/me`).

**Change**
- 16b's last row **Delete account** (error role) pushes a page in You (new `platform/you/DeleteAccount.kt`), signed in only. Signed out there is no such row.
- 27a: back bar *Delete account*; title *Delete your account?*; four facts, each with its kit symbol (`delete`, `move_item`, `schedule`, `download`):
  - *This deletes your Windmill account and its copy in the cloud: your roadmaps, journal pages and gym log.*
  - *Every device signs out, and connected tools lose access, right away.*
  - *For 30 days, you can sign in again to bring it all back. After that, it is deleted for good.*
  - *To keep a copy, export it first at windmill.works.*
  - *Type your email to confirm*, an outlined field *Email*; **Delete account** (filled, error role, at 38 % and off until the typed email matches the account's, case-insensitive and trimmed); **Cancel** (text button) goes back.
- 27b: the email typed (*lifter@example.com*), keyboard up, the button on.
- 27f, 27g: when the phone holds changes the account has not confirmed, a fifth fact row, last, with `cloud_off`: *3 changes on this phone haven’t been confirmed by your account. They are deleted too.* (*1 change on this phone hasn’t been confirmed by your account. It is deleted too.*) The count is the engine's unsent count (`ready + sent + pending`), live; the row goes when it reaches 0. No extra choice.
- 27c: **Deleting…** with the kit circular progress; the field off; Back and Cancel at 38 %. In order: the engine's sign-out flush (`SyncRuntime.signOut()`, at most 5 s), then `DELETE /v1/me`, then finish that session with Discard, which deletes this phone's copy of the account's data.
- 27d: *Your account is deleted* / *Sign in before Nov 21 to bring it back.* (the day from `closingOn`, in the phone's locale) / **Done** → the gym room signed out (16a). The phone is signed out and holds none of the account's data.
- 27e: the field keeps the typed email; the error line *Couldn’t delete your account. Check your connection and try again.*; the button reads **Try again**.
  - A 409 `account-mismatch` or a 401 means the account changed under the page: close it and return to You.
- The request names the signed-in user's id, never the typed email.

**Out of scope:** the backend's grace and deletion (`account-delete-grace-enforced`); export; the web and iOS pages.

**Done when**
- Screenshots of 27a–27g match in Dark and Daylight; the rig (01) adds `27a-delete-account-dark/light` … `27g-delete-unsent-typed-dark/light`, against the local stack.
- On the local stack, Delete account closes the account, every other session of it stops working, and the phone lands on 16a signed out.
- Events through `POST /v1/events`: `account_delete` with `state=shown` (27a), then `outcome=ok` / `failed` / `cancelled`; no email in any property. A failure other than offline reports to Sentry under `account_delete`. List both in `docs/ANDROID_OBSERVABILITY.md`.
- Tests: a new `apps/android/platform/src/test/kotlin/works/windmill/platform/you/DeleteAccountTests.kt` (button off until the email matches, the request body, each answer's screen) and `YouSheetTests.kt` (the row only signed in).

**Depends on:** 46, 47; backend `account-delete-grace-enforced`.

**Ledger:** 12e; dogfood `android-gym-target-page`, `account-delete-grace-enforced`.
