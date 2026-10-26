# Android sign-in fields

The account door uses stock Compose Material 3 outlined fields, with embedded labels, Email/Number
keyboards and existing accessibility descriptions. Email has no standing training paragraph. On the
code step, the full server refusal replaces the expiry helper directly below Code, followed by the
paste-link hint, Resend and pinned Sign in/Change email actions. The field outline, exact trailing
error glyph and refusal use the native error role in both appearances. The helper wraps at 12 dp
below the field.

The approved references are Shell Android 15a/15b/15c: Dark `33:1946`, `33:4237`, `33:4317` and
Daylight `34:753`, `34:792`, `34:834`. Their empty/unfocused 15b floating label differs from the
specified native component, whose empty label sits inside until focus. The native behavior is kept;
consistency ledger 11m records the drawing reconciliation. The error source is the kit's `error`
component, key `098af5abfc9952c8eba5ba9b0cefabe3a3afc906`; the unchanged 24×24 SVG and its 96×96
raster are retained under the platform assets/resources, with one 24 dp theme-tinted icon.

Auth refusal formatting joins nonblank server error/detail text without doubled punctuation. The
fallback remains available when a response has no server words. Offline and update-required text
remain distinct. Server words are displayed only on the form, never in events or technical issues.
Expected API refusals emit the existing bounded API metric; unexpected local completion/storage
failures use the static `auth_sign_in` boundary and keep the code available for retry.

Native capture uses the real AuthService, database and HTTP API. `ResendClient` accepts an injected
base URL with the unchanged production default `https://api.resend.com`; server configuration exposes
`RESEND_BASE_URL`. The capture rig supplies an explicit loopback URL, dummy credential and sender.
Its bounded private mail fixture retains the six-digit challenge only in memory and sends it to adb
through stdin. A wrong-code step guarantees a mismatch. Success checks a newly persisted session
and consumed challenge; only counts enter the manifest. Hosted credentials and mail bodies do not
enter fixture configuration or logs.

Simplification keeps field composition in the existing account door and refusal interpretation in
the existing auth boundary. The glyph is shared across appearances. Capture recipes live beside the
colour recipes and preserve their after-step hook and runtime-log output. No account, sign-out or
Coach flow changes are included.

Verification with task02 colour roles integrated: platform Debug/Release each pass 132 tests; the
Gym theme/auth suite passes 7, including raw-code and error-colour retention through dark/light/dark.
All 25 Android tool tests pass, including the seven focused capture-fixture cases. The matching backend server and adapter binary builds; adapter suite
passes 789 cases with 537 opt-in Postgres skips, zero failures. Five isolated real-HTTP scenarios verify
code request, wrong-code refusal, success/session persistence, replay refusal and private provider
failure. The API provider-failure test verifies exactly one static FailureReporter report and one
structured failed write; the transport probe verifies generic 502 and no private provider text.

Native API 37 acceptance combines explicit provenance. Ten baseline/focused captures on base
`2d57ca53` use APK SHA256 `f81522bff23a0bbb534d1ece56c629a573f1f88cf92c95bbee32a412b14250ab`.
The small-height code flow persists a session and consumes its challenge. Supplemental images on
that identical APK show the entire refusal at 320×640 dp/font scale 2 with the Number keyboard open,
and the pinned actions remain reachable. A subsequent bounded scroll activates Resend and completes
real code sign-in, verified by the committed session and consumed challenge before intentional stop.
The body scrolls; Code, the full refusal, paste hint and Resend need not all fit simultaneously.

The successful independent timing run uses base `23cc7877`, APK SHA256
`61e94e5be378eaaed3b20f2d4bf9f9581df5d42dcd717a59d404b3e70bb11507`: 1,521 ms cold readiness,
no ANR/fatal. Its real first-party intake contains five code-request events, five code-sent events,
five sign-in-start events and two signed-in events. The two successful events belong to fixture-link
sign-ins; the code completions are separately proven by the newer native manifests and database
checks. API refusal events contain bounded endpoint/status labels. Auth writes are one structured
line per request, and logs/events contain no email, code, mail body or dummy provider credential.

The ten-capture run's supplemental recipe stopped on a keyboard notice/scroll selector, and a second
supplemental run stopped after its full-refusal image on a transient Resend selector. Neither whole
run is labelled successful. The final supplemental run was intentionally stopped after its verified
code completion and clean runtime scan, before event export. Only the separate completed timing run
supplies exported event receipts. Rebase onto `e5a25fd4` changes four CI test/doc files only; all 27
owned files were restored byte-identically before these final evidence notes. No native benchmark
is attributed to that test-only rebase. All task-owned emulators, listeners and databases are cleaned.
