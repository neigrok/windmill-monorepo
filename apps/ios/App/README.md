# Windmill Journal

The product app uses `works.windmill.app`, the previous TestFlight bundle identifier. iOS 18 is the
minimum. Generate the project with `xcodegen generate`, then open `Windmill.xcodeproj`.

The default build connects to `https://windmill.works` and saves on the phone without an account.
Configure `WM_SERVER_BASE_URL` with a local server origin, such as `http://127.0.0.1:8089`, or launch
with `-server` followed by that URL. The engine appends `/v1/sync`; native authentication uses
`/v1/auth`. The server must enable and admit the journal engine.
See [the full local server recipe](../../../backend/RUNNING.md). Sessions come from the response body
and are kept in Keychain; native authentication does not retain cookies.

Apple sign-in is off by default and the built app declares no Sign in with Apple entitlement.
Set `WM_APPLE_SIGN_IN_ENABLED=YES` only for a server configured for native Apple verification; the
release workflow reads it from the repository variable `IOS_APPLE_SIGN_IN_ENABLED` (default NO). Device
Release builds use automatic development signing with your team; App Store export signs for distribution. Enable Sign in with Apple for this bundle ID.
An actual Apple ID on a device is required for the production Apple flow.

Debug simulator launches support `-model-server` for the full engine model transport. It supplies
email code `482913` and a fake Apple identity; these authentication shortcuts are absent in Release.
An unbound fake Apple identity returns a memory-only ticket before any account or session exists.
`-apple-fixture linking` uses a relay address; `offline` loses connectivity after Apple authorization;
`expired` advances that ticket past its 15-minute lifetime; `taken` binds Apple to an account with
data; `empty` binds it to an empty account whose door can move. Boards `23-start`, `23a`–`23d` and
`24a`–`24d` seed the existing email account through the real engine. `23-start` opens Keep for full
interaction; `23c` holds the linked receipt for screenshot inspection. A new address plus a valid
code exercises `no-account`; wrong digits exercise the collapsed code refusal. `hello-failure` fails
the first authenticated engine hello after an Apple ticket, so Try again exercises recovery without
reusing the consumed ticket. `-restore-board` retains the board database and skips reseeding for
relaunch content checks. The model also
supports subject/email matches, spent/unknown tickets, code reuse and a concurrent subject-binding
race in `AppleLinkingTests`. All writes and reads use the existing auth diagnostics with bounded
labels; no fixture secret enters telemetry.
`-board <PNG stem>` isolates a fixed-date fixture using the real journal actions and engine.
`-scenario <name> -report <absolute JSON path>` exercises anonymous writing, Keep, email sign-in,
backup, session revocation, same-account reauthentication, sign-out Keep, and a second sign-in. A local
server run supplies `-code-file <absolute path>` with development codes in its isolated database.
The report pauses at `revoke-session` and `signed-out`; a local verifier performs the server step and
writes that checkpoint name to `<report>.ready`. The signed-out checkpoint includes the credential
for local replay verification; the final report contains no credential.

Run the `WindmillTests` scheme tests for deterministic domain and lineage flows, and
`WindmillUITests` for the native sheet/keyboard round trip. All product persistence is in the engine's
protected Application Support directory. `JournalDomain` owns writing and first-run state.

Native editing writes today's page only; past days are read-only. Tapping today's page from its date
through the space above the mood rows opens the keyboard with the caret at the end. The body reserves
at least three lines at the current text size. An empty, unfocused page shows a still lamp caret.
The 44 pt Write seat at bottom-right returns from history to today and opens writing; the same seat
becomes Done writing above the keyboard. It hides during read-only transitions and account sheets.
The one-room header is a plain Journal heading; the account button opens You.
`journal-empty-later`, `journal-one-line` and `journal-history` board fixtures seed past pages through
the journal actions. A `-RM` suffix exercises the journal's Reduce Motion scroll and glyph swap.
Focus and dismissal emit the bounded `first_run_choice` actions `write` and `done_writing` on the
`journal` screen, without page content. When the local day changes at
midnight or after a timezone change, the whole open draft, including its saved prefix, carries into
today and is combined with today's existing page. Yesterday's saved page stays intact. The draft is
persisted on each edit in the active replica before autosave, and is restored across backgrounding,
termination and relaunch. An over-limit combined page stays as a durable draft until shortened.

The editor and account sheet stay locked while an account transition awaits the server. Adoption and
sign-out flush dirty writing and recount before completion. A paused session plainly shows that backup
is paused and offers email or Apple sign-in to the same account; reauthentication retains its replica.
Confirmed Keep and Discard sign-out revoke the captured bearer session. If offline, a separate
Keychain queue retains every revocation and retries on the next launch with network, when connectivity
returns, and at most once per 30 seconds while open. Cancel leaves the server session active.

Fonts are bundled from official OFL sources, with licences alongside each family:

- [Inter](https://github.com/google/fonts/tree/main/ofl/inter), regular and semibold.
- [Nunito](https://github.com/google/fonts/tree/main/ofl/nunito), extra bold.
- [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono/tree/master/fonts/ttf), regular.
- [Baloo 2](https://github.com/google/fonts/tree/main/ofl/baloo2), bold introduction wordmark.

Inter and Nunito are static instances of the official variable fonts. Colour and type tokens
follow the supplied Figma `TOKENS.json`.

Telemetry uses Sentry Cocoa for failures and first-party `/v1/events` for product events. Debug
telemetry is off unless `WM_DEBUG_TELEMETRY=YES` is supplied; simulator verification can use
`-telemetry -sentry-dsn http://ios@127.0.0.1:8091/42`. Release builds require `IOS_SENTRY_DSN`.
See [iOS observability](../../../docs/IOS_OBSERVABILITY.md) for the complete 22-event allowlist,
privacy rules, queue behavior and release verification. CI uses `python3 Tools/generate_project.py`
with a nonproduction DSN. The manual release workflow uses `--release` with the signing secrets,
builds with Xcode 26.3 and uploads to TestFlight; it does not run on push.
