# Windmill Journal

The product app uses `works.windmill.app`, the previous TestFlight bundle identifier. iOS 18 is the
minimum. Generate the project with `xcodegen generate`, then open `Windmill.xcodeproj`.

The default build saves anonymously on the phone. Configure `WM_SERVER_BASE_URL` with the server's
origin, such as `http://127.0.0.1:18860`, or launch with `-server` followed by that URL. The engine
appends `/v1/sync`; native authentication uses `/v1/auth`. Production sync is not enabled by default.
See [the full local server recipe](../../../backend/RUNNING.md). Sessions come from the response body
and are kept in Keychain; native authentication does not retain cookies.

Set `WM_APPLE_SIGN_IN_ENABLED=YES` only for a server configured for native Apple verification. Device
builds need your development team and Apple signing identity (override the simulator's ad hoc
`CODE_SIGN_IDENTITY=-` and `CODE_SIGN_STYLE=Manual`). Enable Sign in with Apple for this bundle ID.
An actual Apple ID on a device is required for the production Apple flow.

Debug simulator launches support `-model-server` for the full engine model transport. It supplies
email code `482913` and a fake Apple identity; these authentication shortcuts are absent in Release.
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

Native editing writes today's page only; past days are read-only. When the local day changes at
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
- [Caveat](https://github.com/google/fonts/tree/main/ofl/caveat), regular ink notes.

Inter, Nunito and Caveat are static instances of the official variable fonts. Colour and type tokens
follow the supplied Figma `TOKENS.json`. Ink paths are vectors attached to live view anchors.
