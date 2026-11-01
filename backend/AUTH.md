# Auth

Passwordless. One door keyed by email, 15-minute single-use links — every mint also carrying a
6-digit code twin a native app types instead of tapping — and 90-day rolling sessions. This file
is the contract the frontend consumes and the operator's wiring reference.

## Shape

```
domain/Auth.{h,cpp}                 email parsing, verdicts, lifetimes — pure, no I/O
application/AuthService.{h,cpp}     the lifecycle pipeline (load → domain → persist → email)
ports/AuthRepository.h              users + magic_links + sessions persistence
ports/EmailSender.h                 sendMagicLink / sendForkLink / sendSignInCode
ports/TokenGenerator.h              mint() / mintCode() / digestOf()
adapters/postgres/PgAuthRepository  the SQL
adapters/crypto/OpenSslTokenGenerator  32B RAND_bytes → url-safe base64; SHA-256 hex digest;
                                       mintCode() → 6 decimal digits, rejection-sampled (no bias)
adapters/email/ResendEmailSender    Resend HTTP API — 'magic-link' / 'magic-link-fork' /
                                       'magic-code' stored templates
adapters/http/AuthApi               the REST surface + session cookie
adapters/clock/SystemClock          wall clock (tests inject a fake)
```

Secrets (link token, session token) travel in the URL / cookie or an opted-in native response body; only their SHA-256 digest is stored,
so a database leak resurrects nothing.

## Endpoints

All JSON. The session rides in an `HttpOnly` `wm_session` cookie; `Authorization: Bearer <secret>`
is also accepted (API, native apps, tests). The copy in every reply below is the house copy: it is
written on the server, and clients render what they are given rather than composing their own.

### `POST /v1/auth/magic-link` — request a link (or, through the app door, a code)

Request `{ "email": "sam@example.com", "forkOf": "t_1a2b3c", "door": "app" }` — `email` alone is the
common case. `forkOf` (optional) is a tree id riding the credential: verify plants a copy of that
tree into whatever account signs in, and it is dropped silently when longer than 64 chars. `door`
(optional): `"app"` makes the mail carry the row's 6-digit code instead of the link; absent or any
other value sends the link mail. Every mint stores BOTH credentials on the one `magic_links` row —
either spends it, and one mint is one unit of the 9-per-window budget whichever mail it sends.

| Result | Status | Body |
|---|---|---|
| Mail sent | `200` | `{ "status": "sent" }` |
| Address unfinished | `400` | `{ "error": "That address looks unfinished — check the ending.", "code": "invalid_email" }` |
| Too many in a row | `429` | `{ "error": "That's a few links in a row. Check your spam folder first — or try again in 10 minutes.", "code": "rate_limited" }` |
| Mail provider down | `502` | `{ "error": "Can't reach windmill.works", "detail": "Nothing you've written is lost.", "code": "unreachable" }` |

### `POST /v1/auth/verify` — complete a link

Request `{ "token": "<the secret from the emailed URL>" }`. A client that keeps no cookie adds
`"sessionTransport": "bearer"`; the successful body then also carries `"session": "<secret>"`.
Omitting this opt-in leaves the web response unchanged, including every cookie line.

| Result | Status | Body / effect |
|---|---|---|
| Valid | `200` | `{ "user": { "id", "email", "name" } }` + `Set-Cookie: wm_session=…` |
| Expired / used / unknown | `410` | `{ "error": "That link has expired", "detail": "Links work once and last 15 minutes.", "code": "expired" }` |

The account is created here on first sign-in. Expired, already-used and unknown collapse to one
screen, so nothing leaks. A successful verify may also carry `"forkedTree": "<tree id>"` when the
link rode in with a `forkOf`; a fork that cannot be planted degrades to a plain sign-in rather than
blocking the door.

### `POST /v1/auth/verify-code` — complete a code (the app door)

Request `{ "email": "sam@example.com", "code": "483201" }`. The iOS engine client adds
`"sessionTransport": "bearer"` to receive the session secret in the successful response body.

| Result | Status | Body / effect |
|---|---|---|
| Valid | `200` | `{ "user": {…} }` (+ `forkedTree` when one rode the row) + `Set-Cookie: wm_session=…`; with `sessionTransport: "bearer"`, also `"session": "<secret>"` |
| Wrong / expired / used / exhausted / unknown email | `410` | `{ "error": "That code didn't work", "detail": "Check the digits, or send a fresh one.", "code": "expired" }` |
| Missing email or code | `400` | `{ "error": "Missing code", "code": "bad_request" }` |

The lookup is the NEWEST live row for the address — unspent, unexpired, fewer than 5 attempts — so a
resend supersedes the code before it. A wrong guess spends one attempt on that row (one atomic
`UPDATE … SET attempts = attempts + 1 RETURNING attempts`); at 5 the row is dead and a fresh request
is the remedy. A right guess burns the row through the same atomic `consumed_ms` flip the link uses,
then runs the identical `mintSessionFor` tail (find-or-create, revival in grace or erasure past it,
90-day rolling session). Every failure collapses to the one 410 body, so the endpoint cannot be
probed for which addresses hold pending codes or accounts.

Only the exact string `"bearer"` opts in. Web and Android requests without it retain their exact
serialized response body and cookie lines, covered by `AuthApiTest`. The secret in the native body
is the live cookie's secret; store it in Keychain and send `Authorization: Bearer <secret>`.
Native clients discard the cookies, including the expiry lines for retired cookie scopes.

A 6-digit code has 10⁶ states, so the bound is the defense, not the digest at rest: 15-minute life,
single use, 5 attempts per row, and a per-IP bucket on `/v1/auth/verify-code` (10/min, burst 10, in
`main.cpp`'s sync advice).

### `GET /v1/me`

`200 { "user": {…}, "signInMethods": [{ "kind": "email", "email": "sam@example.com" },
{ "kind": "apple", "email": "<email_at_link>", "relay": true }] }` when the session resolves
(the window rolls forward on each call), else `401 {}`. Email is first; bound providers follow.
Apple is absent when unbound. Its address and relay flag describe the door at attachment, not the
account's email or the latest sign-in token.

### `POST /v1/auth/logout`

Drops the session, expires the cookie in every one of its scopes (Frontend integration), `204`.

### `DELETE /v1/me`

Request `{ "account": "<the account id shown in the confirmation>" }`, with the caller's session.
The server compares that id with the authenticated account before closing anything. A different
account answers `409 { "error": …, "code": "account-mismatch" }`; a missing, empty or non-string
id answers `400` with code `malformed`. Both refusals retain every account, session and cookie.
Signed out answers `401`.

A match closes that account with a 30-day grace, revokes all its sessions and grants, clears the
session cookie, and answers `200 { "closingOn": "<ISO UTC>", "closesMs": <epoch ms> }`. A write
whose request authenticated before the close, such as a sync push in flight, may still commit after
it; it lands in the closed account, comes back with it or goes with its erasure.

#### Recoverable deletion

Native callers persist the following complete request privately before sending `DELETE /v1/me`
with their session. The existing request containing only `account` remains supported.

```json
{
  "account": "<confirmed account UUID>",
  "operationId": "<new random UUID>",
  "proof": "<32 cryptographically random bytes as 64 lowercase hex characters>",
  "requestedAtMs": 1792940000000
}
```

Both UUIDs use canonical lowercase spelling. `requestedAtMs` is a positive integer below 2^53,
captured once with the operation. The account, operation id, proof and instant never change on a
retry. The phone seals the proof in its account-pinned pending-deletion record; it sends the tuple
only in the JSON body, never a URL, log or event. A new operation is admitted only when its instant
is less than five minutes from the server clock, read once the account row is locked, so a request
held at the lock behind a stale answer is stale too. A known matching receipt can be read throughout
its retention period regardless of that admission window.

Closure, the immutable receipt, session revocation and OAuth grant/code/token revocation commit
in one database transaction. The session is rechecked under the account lock; a second request
authenticated before revocation cannot close it again, including with a different operation id.
The legacy close also preserves the first active close deadline. Only an explicit restoration
clears that deadline and permits a later, newly confirmed operation.

Success is `200` with the exact shape
`{ "state": "closed", "closesMs": <epoch ms>, "closingOn": "<ISO UTC>", "receiptExpiresMs": <epoch ms> }`.
This proves that this operation committed, not that the account remains closed now. Reading or
resubmitting a matching old operation after restoration returns its original receipt, without
revoking the new session, clearing its cookie, closing the account again or extending any deadline.

`POST /v1/account-deletion/result` takes the same JSON tuple and requires no account session.
Its capability reads only that operation's receipt. It never authenticates a session, reads account
content, changes credentials or restores/closes an account. Its `200` response is identical to the
close response. A wrong account, operation id, proof or instant, a missing receipt, and an expired
receipt all answer the same `404 { "state": "unavailable", "code": "unavailable" }`.
Unavailable proves neither closure nor failure: the close might still be in flight, the request
might never have arrived, or the receipt might no longer exist. Keep the pending account fence and
use this read endpoint for recovery; do not mint a new close operation or sign in to check.

Every recoverable response is `Cache-Control: private, no-store`. The remaining answers are:

| Status | Body | Meaning |
|---|---|---|
| 400 | `{ "state": "refused", "code": "malformed" }` | This malformed request made no mutation. |
| 409 | `{ "state": "refused", "code": "account-mismatch" }` | The close request names another account; this attempt made no mutation. |
| 409 | `{ "state": "refused", "code": "clock-ahead" }` | An unseen close request is at least five minutes ahead; this attempt made no mutation. Correct the clock before a newly confirmed operation. |
| 401 | `{ "state": "pending", "code": "unauthenticated" }` | The close session is unavailable. Recover the original operation; a successful close revokes this same session. |
| 503 | `{ "state": "pending", "code": "temporarily_unavailable" }` | Storage/transport failed. Recover the original operation; commit may have preceded the failure. |

`pending` describes an unknown client outcome, not a persisted server job. A lost response, any
unrecognized 5xx, and a refusal concerning a changed/malformed retry never disprove an earlier
possibly committed request. A close request older than the admission window with no matching
live receipt answers the same unavailable response, so receipt expiry cannot turn a replay into
a new close. Do not change `requestedAtMs` to bypass that boundary.

Receipts are readable for 35 days from the first close. They store only the account UUID, operation
UUID, SHA-256 of the domain-separated proof, original request instant, close deadline and receipt
expiry. No email, session token, raw proof or product content is retained. They survive the account's
30-day erasure so a late phone can confirm its owed local cleanup. The hourly retention sweep
removes expired rows in bounded batches; expiry is enforced on reads even before that sweep runs.
The proof grants no access after expiry. Post-expiry confirmation can be unavailable permanently.

Closure increments a durable OAuth account generation. Codes and refresh grants keep the generation
that admitted them; token insertion and access require a live account with that same generation.
Code admission rechecks the original session under the account lock. A pre-close authorization,
consumed code or rotated refresh cannot acquire credentials after closure or restoration. Initial
grant metadata and its token commit together. Restoration does not reset the generation.

Any sign-in before `closesMs` brings the account back whole. From `closesMs` on, the close is final:
the account is erased in one transaction with every database row any product keys to it, by the
first sign-in that meets it or by `ClosedAccountSweep` (hourly, 100 accounts a pass), whichever
comes first. A sign-in after that starts a new, empty account on the same address or door.
`closesMs` is `users.closes_at`, written with the close. An account closed before that column
existed was promised an unlimited undo; the deploy that adds the column dates it 30 days from that
deploy, never sooner than its own 30, and until a deploy dates it no close without a `closes_at`
is final.

Rows that a foreign key to `users` does not cascade from are named in
`PgAuthRepository::eraseAccount` (the sync engine, telemetry, billing, org membership, and feedback:
the account's own, plus feedback left signed out with its address; an open account's feedback
stays whatever address it typed) and, per product, in the `AccountErasure` list `main.cpp` passes
it. Roadmap's takes the account's trees and everything keyed to them, other people's progress on
those trees included, since the trees are gone; its hook then retires their live rooms, so no
reader is served one, no fork copies one, and no save writes one back. Three kinds of row stay: the
AI accounting relations keep the account's id, with no address or content
([AI_ALLOWANCES.md](AI_ALLOWANCES.md)); pending sign-in credentials belong to the address and go
at their expiry; account-closure receipts retain their narrow result until their 35-day expiry.
The retention sweep collects both expiring kinds. `PgAuthRepositoryTest` inventories every table
with an account-shaped column and fails on unexpected survivors.

Erasure reaches this database only. Events already forwarded to Amplitude, Sentry's issues and
logs, Resend's delivery records and database backups keep what they hold until their own retention
ends.

### `POST /v1/auth/apple` — the authorization-code door

Request `{ "authorizationCode": "<from ASAuthorizationController>", "name": "Sam Gold" }`. The name
is Apple's, and Apple sends it exactly once — on the first authorization for that Apple ID — so it
arrives here or never; it seeds a NEW account and never renames an existing one.

| Result | Status | Body |
|---|---|---|
| Signed in | `200` | `{ "user": {…}, "session": "<secret>", "created": bool, "privateEmail": bool }` + `Set-Cookie` |
| No subject binding or account at the verified address | `200` | `{ "appleTicket": "<secret>", "expiresAt": <epoch ms> }`; no session or cookie |
| Already signed in — the door was bound to the caller | `200` | `{ "user": {…}, "attached": true }` |
| Signed in, that Apple ID opens another account with data | `409` | `{ "error": …, "code": "identity-taken" }` |
| Apple refused, or the identity is unusable | `401` | `{ "error": "apple sign-in could not be completed" }` |
| Not configured (any of the four env vars missing) | `404` | `{ "error": "apple sign-in is not configured" }` |

`session` is the same secret as the cookie, returned in the body so a native client can keep it and
send it as `Authorization: Bearer`. An unmatched sign-in returns only an Apple ticket, for relay
and real addresses alike. Nothing is created or bound until the person answers. The ticket lasts
15 minutes, is single use and is stored only by its digest in `apple_tickets`, alongside the verified
subject, email, relay flag and once-only name. A ticket alone authenticates no request.

### `POST /v1/auth/apple/native` — the identity-token door

This route exists only with `APPLE_NATIVE_ENABLED=1` and a nonempty `APPLE_CLIENT_ID`; otherwise it
is an ordinary `404`. Request
`{ "identityToken": "<ASAuthorizationAppleIDCredential.identityToken as UTF-8>", "nonce": "<raw nonce>", "name": "Sam Gold" }`.
Before authorization, generate a fresh cryptographically random nonce, retain it for this attempt,
and set `ASAuthorizationAppleIDRequest.nonce` to its lowercase SHA-256 hex digest. Post the original
nonce here. `name` is optional and seeds a new account only.

The server fetches Apple's signing keys from `https://appleid.apple.com/auth/keys` over HTTPS and
verifies the RS256 signature and key id, issuer, bundle-id audience, expiry, issue time, optional
not-before time and hashed nonce. Client tokens never enter the payload-only parser used after a
trusted authorization-code exchange. A malformed body answers `400`; rejected token, keys or
provider response answers the same `401` as the authorization-code door. Successful bodies,
cookie lines, subject resolution, relay-email flags and authenticated attachment behavior share
that door's response pipeline. A matched signed-out sign-in includes `session` for Bearer use;
an unmatched one includes only `appleTicket` and `expiresAt`.

A verified subject with no email may open its existing `user_identities` binding, but cannot create
an account or bind a new door. Any supplied address must be verified. Normal Apple identity tokens
include the email on subsequent authorizations too; only the name arrives once. See
[Apple's authentication contract](https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple).

`AppleIdentityVerifier` is an injected port. HTTP tests use a fake verifier, and verifier tests use
locally generated RSA keys and a fixed clock; neither requires Apple secrets or an Apple network
response. Production has no fake-verifier environment switch.

### `POST /v1/auth/apple/create` — answer Create account

Request `{ "appleTicket": "<secret>" }`. A live ticket creates an account, binds its Apple door and
mints a session in one transaction. The normal Apple success body carries `created: true`,
`privateEmail`, `user` and `session`, with the session cookie. Redemption serializes by Apple subject;
creation spends every competing ticket for that subject, so their answers are `410 apple-ticket-expired`.
If the verified email gained an account meanwhile, create also answers `410`; repeat Apple sign-in
to open that account. A subject bound elsewhere
meanwhile answers `409 identity-taken` without creating or changing an account.

Missing, unknown, spent and expired tickets all answer `410` with
`{ "error": "Continue with Apple again", "detail": "Apple's sign-in lasts 15 minutes, and this one ran out. Nothing was created.", "code": "apple-ticket-expired" }`.

### `POST /v1/auth/verify-code` with `appleTicket` — answer Use my account

The optional `appleTicket` carries the Apple sign-in into email proof. The order is strict:

1. Check the ticket first. A dead ticket answers the same `410 apple-ticket-expired`, without
   consuming the code or a guess attempt.
2. Check the code. Wrong, expired, used, exhausted and unknown codes keep the one collapsed `410`
   refusal above: "That code didn't work" / "Check the digits, or send a fresh one."
3. Spend a valid code. An existing account at the proven address gains the Apple door and a session;
   the usual code success body gains `appleAttached: true`. `sessionTransport: "bearer"` also returns
   `session`; the session cookie is set either way. Ticket consumption, binding and session creation
   commit together. A subject bound to another account answers `409 identity-taken`, changing neither
   account. No account answers `404 { "error": "No account at this email", "code": "no-account" }`:
   the code is spent, nothing is created, and the ticket stays live for another address or Create account.

`/v1/auth/magic-link` keeps sending to any valid address, regardless of account existence.

### `DELETE /v1/me/sign-in-methods/apple`

Requires the caller's session cookie or Bearer credential. Deletes only the caller's Apple
bindings and answers `204`, or `404` if none exist; signed out answers `401`. The account, email
door, other providers and sessions remain. Removing Apple does not close an account.

### `POST /v1/auth/link` — fold this account into the one the link names

Request `{ "token": "<the secret from an emailed URL>" }`, sent **while holding a session**.

| Result | Status | Body |
|---|---|---|
| Linked | `200` | `{ "user": {…}, "session": "<secret>", "linked": true }` + `Set-Cookie` |
| Already the same account | `200` | `{ "user": {…}, "linked": false }` |
| The caller's account holds data | `409` | `{ "error": …, "code": "account-not-empty" }` |
| Expired / used / unknown link | `410` | `{ "error": "That link has expired", "code": "expired" }` |
| No caller | `401` | `{ "error": "sign in to link this account" }` |

The caller's row is deleted on success, and its session with it — which is why a fresh one comes
back in the reply.

Also on this surface: `PATCH /v1/me`,
`GET /v1/sessions`, `DELETE /v1/sessions/{id}`, `DELETE /v1/sessions`, and Google's two redirects
`GET /v1/auth/google/start` · `GET /v1/auth/google/callback`.

## Identities — one account, many doors

The Windmill account is an email address: one `users` row, `email citext unique`. Magic link,
Google and Apple all resolve onto it.

Four rules govern every door:

1. **Continue with Apple never makes a second account by surprise.** When Apple finds no account,
   nothing is created until the person answers (the Apple ticket).
2. **Accounts that both hold data never merge.** A door moves to another account only when the
   account it leaves holds nothing (`AccountFootprint::anyData`).
3. **Nothing is said about an address until the person proves it with a code.** No answer reveals
   whether an address has an account to someone who has not read that address's mail.
4. **The email door always exists.** Every account is an email address, so Apple is added beside
   email and can be removed without locking anyone out.

### `user_identities` — the key that outlives an address

```sql
create table if not exists user_identities (
  provider      text not null check (provider in ('google','apple')),
  subject       text not null,
  user_id       uuid not null references users(id) on delete cascade,
  email_at_link text not null default '',   -- what the provider said when we linked; never re-read
  relay         boolean not null default false,
  created_at    timestamptz not null default now(),
  primary key (provider, subject)
);
create index if not exists user_identities_user on user_identities (user_id);
```

The provider-issued subject IS the identity; the email is only a hint, consulted once, to find an
account that already exists. `(provider, subject)` is the primary key, so a provider that changes
the address behind an account — an Apple relay rotated, a Google primary email moved — still
resolves to the same user.

Apple's Hide My Email returns `<opaque>@privaterelay.appleid.com`. The name arrives exactly once,
on the first authorization; the email remains in subsequent identity tokens. A subject-only
identity resolves only an already-bound door.

### The resolution ladder

The subject resolves first. A known `(provider, subject)` opens its bound account regardless of
address or name changes. With no binding, a verified address finds an existing account and binds
the door. Google also creates on an unmatched verified address; Apple returns a ticket instead.
Apple relay addresses follow the same ladder. Unverified addresses never find or create accounts.
A subject-only Apple identity can only open or reuse its existing binding.

**A provider sign-in performed while already signed in attaches to the caller.** A free Apple door
binds to that account; an already-owned door is unchanged. If Apple opens another account whose
`AccountFootprint::anyData` is false, its Apple door moves to the caller and the empty account is
deleted, with all its sessions revoked and live sockets disconnected. The database locks only the two account rows, then rechecks the footprint in the deletion
transaction. Ownership foreign keys and the non-FK writers hold account key-share locks; unrelated
accounts can keep writing. An account with data is untouched
and answers `409 identity-taken`. Sign-in methods retain the original `email_at_link` and relay flag.
Google attachment refuses an identity owned by another account.

### The link door

The legacy `POST /v1/auth/link` endpoint consumes an emailed link while the caller holds a
session. It is independent of the Apple-ticket question. The server resolves the token to user A
and compares it with caller B:

| Case | Outcome |
|---|---|
| A == B | no-op, `200` |
| A != B and **B has no data** | every `user_identities` row of B moves to A, B is deleted, a session for A is returned |
| A != B and B has data | `409 account-not-empty` |

**Merge only while provably empty. Never write a general account merger.**

`AuthService` asks a platform port and never a table:

```cpp
// platform/ports/AccountFootprint.h
struct AccountFootprint {
  virtual ~AccountFootprint() = default;
  virtual bool anyData(const UserId&) = 0;
};
```

There is one implementation for every product. `PgAccountFootprint` takes a list of
`{table, ownerColumn}` probes and runs them as one `UNION ALL`; the probes are named in `main.cpp`,
so platform never learns which tables a product keeps. Identifiers cannot be bound as parameters, so
the constructor validates each against `[a-z_][a-z0-9_]*` and throws — a malformed probe takes the
server down at boot rather than reaching a query.

**A product missing from that probe list reports an account empty that is not, and the link door then
deletes real data.** The list is the review surface, an empty one is refused at construction, and a
fourth product adds one line to it.

The probes cover every user-owned product table in `schema.sql`, including text-owned
`node_progress`, history, reminders, settings and feedback, plus org membership, billing,
MCP/OAuth credentials and sync state. Child-only tables are covered by their owning parent.
`sessions` and `user_identities` are the doors, not an account's data; `magic_links` and
`apple_tickets` are pending credentials without user ownership. `events`, `server_errors` and
`ai_usage` are telemetry, excluded from emptiness. `paddle_customers` is email-addressed;
its user-owned subscription rows count.

Apple POST doors and verify-code with an Apple ticket require the `application/json` media-type essence. Requests
carrying cookies must supply an Origin from the same allowlist used for credentialed CORS;
any supplied untrusted Origin is refused before authentication or writes. Cookie-authenticated
Apple removal also requires JSON; native Bearer removal needs no body or Content-Type.
Native requests without cookies or Origin remain allowed.
Matched Apple sign-in binds, revives and inserts its session in one transaction, after minting
its session secret; an insert failure rolls back the binding and revival.

### Native surface notes

- `Caller.cpp` falls back to `Authorization: Bearer <session-secret>` when the `wm_session` cookie is
  absent, and `AuthService::authenticate` is transport-neutral. The sync engine's iOS client keeps
  each account's secret in the Keychain (`KeychainTokenStore`).
- The sync endpoints and the live upgrade (`SyncApi.cpp`, `SyncSocket.cpp`) read credentials as sent
  (`docs/foundation/engine.md` §9.1), from every header line the request was received with: the
  patched Drogon's `HttpRequest::headerOccurrences()` (`third_party/drogon`), read by
  `SentCredentials::fromOccurrences` (`platform/domain/sync/Credentials.h`). Every `Authorization` line
  and every `wm_session` piece of every `Cookie` line is a credential, a bare one included; header
  names fold ASCII case only, and only space and tab are trimmed. They resolve only as at most one
  `Authorization: Bearer <token>` (the scheme in any case) and at most one `wm_session=<token>` (the
  token verbatim), each held by a live session, naming one account; anything else answers `401` and
  is never served as anonymous. The REST surfaces read through `Caller.cpp`.
- Every session deletion runs through `AuthService` and is told to `LiveSessions`, which closes the
  sync sockets the session opened before they send another frame: a sign-out, a revoked session,
  sign-out everywhere, a closed account, and a folded account with every session its deleted row took
  along. The sockets' re-proof, once a minute, is a backstop.
- The Android app signs in by code: mint with `door: "app"`, post the typed digits to
  `/v1/auth/verify-code`, capture the session from `Set-Cookie`. A pasted magic link still works through `/v1/auth/verify`
  (sign-in) or `/v1/auth/link` (the merge above).
- The iOS engine client uses the same `door: "app"` mint, adds `sessionTransport: "bearer"` to
  `/v1/auth/verify-code` or `/v1/auth/verify`, and captures `session` from the response body.
- App Store guideline 5.1.1(v) requires in-app account deletion wherever Sign in with Apple ships;
  settings has close-with-grace.

## The link URL

`AuthService` builds `${WINDMILL_APP_URL}/#/auth?token=<secret>`. The token lives in the URL
**fragment**, so it never reaches server logs — the SPA reads `location.hash` and POSTs it to
`/v1/auth/verify`.

## Frontend integration

- Call every auth endpoint with `credentials: 'include'`. The server grants credentialed CORS only to
  allow-listed origins — the app's own origin (`WINDMILL_APP_URL`) plus any in
  `WINDMILL_ALLOWED_ORIGINS`. Any other origin gets no `Allow-Origin`; the Apple mutation and code doors also enforce
  Origin and JSON at the handler boundary.
- In production the cookie's `Domain` is the registrable domain (`WINDMILL_COOKIE_DOMAIN`), so `app`
  and `api.app` share it. On `https` origins the cookie is `Secure`.
- The cookie's scopes (engine.md §9.1 Session cookie scopes) are host-only, the configured `Domain`
  (`WINDMILL_COOKIE_DOMAIN`), and every `Domain` the deployment set it in before
  (`WINDMILL_COOKIE_RETIRED_DOMAINS`). `SessionCookieScopes` (`platform/domain/Auth.h`) names each once,
  whatever its case or leading dot. A response that sets `wm_session` writes the live cookie in the
  configured scope first, then expires it in every other scope; a response that clears it expires it
  in every scope. A variant left in another scope would ride beside the live cookie, and two session
  cookies answer every sync request `401`; this way it never outlives the next sign-in or sign-out.
- The live cookie is written first because the Android app lifts the first `wm_session` a response
  sets. Where the `Domain` equals the host that answers sign-in, as in production (`windmill.works`),
  every client must keep a host-only and a `Domain` cookie apart, as Chrome does for a host under a
  registrable domain, read the first `wm_session` of a response, as the Android app does, or keep no
  cookie, as the iOS sync engine's transport does, which sends its token as `Authorization: Bearer`. A
  store that took the two as one cookie would lose the live one to the expiry after it.
- A host with no registrable domain configures no `Domain`: at `localhost` Chrome files
  `Domain=localhost` as host-only, so the expiry after the live cookie removes it. The server refuses
  to start (`refusing to start: …`) with a `Domain`, current or retired, that is an IP address (an IPv6
  literal, or a name whose last label is a decimal or `0x` number), a single label, a name whose last
  label is `localhost`, or not a host name of letters, digits, `-` and `.` with at most one leading
  dot, each read with space and tab trimmed around it. Local runs keep the cookie host-only.

## Operator env

| Var | Purpose | Default |
|---|---|---|
| `RESEND_API_KEY` | Resend key; without it, sends are refused → `502` | — |
| `RESEND_FROM` | Verified sender, on a domain verified in Resend. Never Resend's shared `onboarding@resend.dev` outside a scratch box: Resend accepts it only for the account owner and rejects every other recipient `422`, so sign-up breaks for everyone except the person testing it. The deploy guards it | — |
| `RESEND_BASE_URL` | Provider origin override for isolated integration fixtures; use a local origin and dummy key, never hosted credentials | `https://api.resend.com` |
| `WINDMILL_APP_URL` | Base for the magic-link URL; always a trusted CORS origin | `http://localhost:5183` (compose: `https://${DOMAIN_APP}`) |
| `WINDMILL_COOKIE_DOMAIN` | Cookie `Domain`; empty = host-only. Every sign-in and sign-out also expires the cookie in each other scope: host-only, and each retired `Domain`. A `Domain` the server refuses (Frontend integration) stops it at startup | compose: `${DOMAIN_APP}` |
| `WINDMILL_COOKIE_RETIRED_DOMAINS` | Every `Domain` the deployment set the session cookie in before the current one, comma-separated. Add the old one here whenever `WINDMILL_COOKIE_DOMAIN` changes | compose: `${WINDMILL_COOKIE_RETIRED_DOMAINS:-}`, from the GitHub variable of the same name; empty |
| `WINDMILL_ALLOWED_ORIGINS` | Extra credentialed-CORS origins, comma-separated | — |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in; unset → the routes bounce to the app | — |
| `APPLE_CLIENT_ID` | The bundle identifier Sign in with Apple is issued for | — |
| `APPLE_NATIVE_ENABLED` | Mount the native Apple identity-token door when exactly `1` and `APPLE_CLIENT_ID` is configured | off |
| `APPLE_TEAM_ID` · `APPLE_KEY_ID` | The team, and the id of the Sign-in-with-Apple key | — |
| `APPLE_PRIVATE_KEY` | The `.p8` key's PEM contents, used to sign each ES256 client secret | — |

The authorization-code door stays dark until all four Apple inputs land: `configured()` is false
and `/v1/auth/apple` answers `404`. The client secret is minted per exchange (ES256, one-hour life)
rather than stored. The native identity-token door needs the bundle identifier and explicit enable
flag, plus outbound HTTPS to Apple's key endpoint; it does not need a team key or client secret.

### Apple sign-in activation

Compose defaults the native enable flag to `0` and the bundle identifier to empty. Deployment's
environment renderer supplies neither input, so both Apple doors stay off in production.

Native identity-token activation requires the Apple Developer app identifier for the app's actual
bundle id, the team's signing configuration and `com.apple.developer.applesignin` entitlement.
Configure `APPLE_CLIENT_ID` to that identifier and `APPLE_NATIVE_ENABLED=1` only on the intended
server. The owner must bind these inputs into deployment's environment renderer before enabling
production; Compose already carries them with off defaults. Authorization-code activation additionally requires the Apple team id, key id
and `.p8` private key. Its transport must preserve PEM newlines; the current renderer writes
single-line values. Setting GitHub secrets alone is insufficient because
[deploy.yml](../.github/workflows/deploy.yml) replaces the server environment.

Verify first authorization, an existing account and a relay-email account from a signed app.
Unsigned simulator launches and unit tests cannot verify Apple's flow. Identity resolution and
account linking use the rules above.

## MCP OAuth consent

`/oauth/authorize` validates the request and redirects to the web `/#/oauth/authorize` route.
[OAuthConsent.jsx](../web/src/shell/auth/OAuthConsent.jsx) requires a session, reads the registered
client from `/v1/oauth/client`, checks the redirect against its registered URIs, and displays the
requested product scopes. It posts the unchanged `client_id`, `redirect_uri`, `code_challenge`,
`resource`, `scope` and `state`, plus `approve`, to `/v1/oauth/decision` and follows its returned
`redirect`. A lapsed session returns to sign-in; an invalid request requires restarting from the
MCP client.

The server revalidates the redirect and owns codes, PKCE and tokens. The screen handles no token or
code exchange. MCP transport, credentials and scopes are documented in the
[adapter contract](products/roadmap/adapters/mcp/README.md).

## The Resend templates

`ResendEmailSender` calls `POST /emails` at `RESEND_BASE_URL` (default `https://api.resend.com`)
with a stored template id —
`magic-link` (`template.variables.magic_link`), `magic-link-fork` (plus `tree_title` / `tree_meta`),
or `magic-code` (`template.variables.sign_in_code`). It sends `from`, which takes precedence over
the template's default, and **omits `subject`** so the template owns it.

**Each template must define its own subject.** With the payload omitting it, a template with no
default subject makes the send fail and the endpoint returns its generic `502` refusal. Provider
response bodies are not read or logged.

**Operator step, not doable from this repo: the `magic-code` template must exist in the Resend
dashboard before any app release ships the code door.** A missing template makes every `door:"app"`
send fail into the 502 brick; a template pasted without the `{{{sign_in_code}}}` variable renders a
mail with an empty slot and no local test fails. Paste-source: `web/emails/magic-code.html` / `.txt`.

Any non-2xx response (or a network error) refuses delivery, which the endpoint surfaces as the `502`.

## Lifetimes (`domain/Auth.h`, one source of truth)

Link 15 min · single-use · 9 per email per 10 min · session 90 days, rolling. The 6-digit code lives
ON its link's row and inherits all of it, plus its own bound: 5 attempts, then the row is dead.
