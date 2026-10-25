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
- Android You has no Delete account row (`platform/you/YouSheet.kt`). iOS and web already expose account deletion; iOS `App/Sources/AccountDeletion.swift` demonstrates account-pinned owed local cleanup, not proof of an unknown server result.
- The server closes one: `DELETE /v1/me` with body `{"account": "<the signed-in user id>"}` (`backend/platform/adapters/http/AuthApi.cpp`, `AuthApi::deleteMe`). It answers 401 *sign in to close your account*, 400 `malformed`, 409 `account-mismatch` when the id is not the caller's, or 200 with `closesMs` and `closingOn`, now + 30 days (`backend/platform/domain/Auth.h:52`). Every session and every connected tool is revoked at once (`AuthService::closeAccount`, `backend/platform/application/AuthService.cpp`).
- The promise *After that, it is deleted for good.* holds: a sign-in before `closesMs` brings the account back, and from `closesMs` on the account is erased with all its data, by the first sign-in that meets it or an hourly sweep; a sign-in after that starts a new, empty account (`backend/AUTH.md`, `DELETE /v1/me`).

**Backend prerequisite — `account-delete-reconciliation`**
- Owner: platform/auth backend, with its contract in `backend/AUTH.md` and transport tests. The existing grace enforcement is implemented; this prerequisite is the missing recoverable result after session revocation.
- Before the Android deletion flow ships, provide an account-scoped deletion operation identity and a durable result receipt. The authenticated request must pin the confirmed account and a client-persisted operation identity; identical retries resolve one operation and return the same close deadline rather than restarting the grace.
- Recovery must still work after the calling session is revoked. Define a narrowly scoped proof/capability for reading that operation's result, sealed on the client and stored hashed on the server, with documented bounded retention covering the retry window. It grants no account reads/writes and must never restore the account. Keep the credential out of URLs, logs and events; responses are private/no-store and cannot disclose another account's closure.
- Persist the closure result/close deadline and its receipt atomically. Distinguish definitive not-closed/refused, unresolved and confirmed-closed outcomes, including an expired/unavailable receipt that proves neither success nor failure. Document the exact request/recovery wire API before wiring the client; the current `DELETE /v1/me` alone does not satisfy this contract.

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
- Pin the confirmed account id, operation id and private recovery proof in a durable pending-deletion record before sending. The request names that account id, never the typed email. Lock account transitions while starting the operation, and never attach a late result to whichever account is currently selected.
- 27c: **Deleting…** with the kit circular progress; the field off; Back and Cancel disabled during the active attempt. First obtain the engine's sign-out session/flush, then submit the close operation. Until the outcome is known, fence new writes for that account.
- A confirmed closed receipt creates a durable owed-cleanup record for that exact account and returned deadline. Finish its held sign-out with Discard, remove its owner-scoped Coach archive/credentials and clear the owed record only after cleanup succeeds. A cleanup failure leaves the record recoverable and the affected account unavailable; retry performs cleanup, not another close.
  - If the app restarted, reopen the cleanup session for that account. If a different account is active, discard only the original account's dormant data; never finish a sign-out or clear storage belonging to the new account. Follow the existing engine lifecycle APIs and the account-pinned iOS cleanup pattern.
- 27d appears only after a confirmed closed receipt **and** successful local cleanup: *Your account is deleted* / *Sign in before Nov 21 to bring it back.* (the actual `closingOn`, localized) / **Done** → signed-out gym (16a). Do not invent the deadline or claim success from an unauthorized response.
- 27e is for a definitive not-closed/refused result or a proven failure before submission. Preserve typed email; use the appropriate error sentence and **Try again**. Cancel the engine's sign-out hold on this path. `account-mismatch` returns to You after releasing the hold, preserving both accounts.
- A timeout, lost response, 5xx after possible mutation, or 401 on retry is an **unknown closure outcome**. A successful close revokes the session before its response; 401 alone proves neither an account switch nor deletion. Keep the operation record, recover the same result using the backend receipt contract, and do not send a fresh close operation or sign in to check (sign-in restores a closing account).
- Every sign-out session has a disposition: finish Discard after proven closure; cancel on proven no-close, explicit pre-send cancellation or when releasing a transient session at a lifecycle boundary. An unresolved operation retains its durable write fence and recovery record independently of that transient hold, so process death neither leaks an in-memory hold nor resumes account writes. Resolve/reacquire the correct session during recovery.
- `android-account-delete-recovery-design` owns the unknown-result/check-again, expired/unavailable-receipt and local-cleanup-pending presentations beside 27c/27e. Obtain human-approved ✅ Ready for dev states before implementing those visuals. Existing 27a–27g and the six Gym-flow approval do not supply them.

**Out of scope:** rebuilding the shipped grace/erasure implementation (`account-delete-grace-enforced`); export; the web and iOS pages. The backend reconciliation prerequisite is required for this Android task, not assumed to exist.

**Done when**
- Screenshots of 27a–27g match in Dark and Daylight; the rig (01) adds `27a-delete-account-dark/light` … `27g-delete-unsent-typed-dark/light`, against the local stack.
- On the local stack, Delete account closes the account, every other session of it stops working, and the phone lands on 16a signed out.
- Fault cases: drop the response after the server closes; restart before/after receipt persistence and during local cleanup; refuse before close; switch accounts during a late reply; expire/unavailable recovery proof; fail Discard then retry. Assert one close deadline, no false success, correct account cleanup, and a disposition for every sign-out hold.
- Events through `POST /v1/events`: `account_delete` with `state=shown` and bounded outcomes distinguishing `pending_confirmation`, `cleanup_pending`, `ok`, `refused`, `failed`, `cancelled`. `ok` requires proven closure plus cleanup. Report unexpected transport/storage/cleanup failures to Sentry under static operations; expected refusals/offline are events. No email, account/operation id, proof, deadline or response body in telemetry; update `docs/ANDROID_OBSERVABILITY.md`. The backend prerequisite has one structured write observation per close/reconciliation mutation and no receipt secrets.
- Tests: a new `apps/android/platform/src/test/kotlin/works/windmill/platform/you/DeleteAccountTests.kt` (button off until the email matches, the request body, each answer's screen) and `YouSheetTests.kt` (the row only signed in).

**Depends on:** 46, 47; backend `account-delete-reconciliation`; design `android-account-delete-recovery-design`. Verify the already-implemented `account-delete-grace-enforced` behavior in the deployed/local backend used for acceptance.

**Ledger:** 12e; dogfood `android-gym-target-page`, `account-delete-grace-enforced`, `account-delete-reconciliation`, `android-account-delete-recovery-design`.
