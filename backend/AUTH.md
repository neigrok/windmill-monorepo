# Auth

Passwordless. One door keyed by email, 15-minute single-use links — every mint also carrying a
6-digit code twin the native apps type instead of tapping — and 90-day rolling sessions. This file
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

Secrets (link token, session token) travel in the URL / cookie; only their SHA-256 digest is stored,
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

Request `{ "token": "<the secret from the emailed URL>" }`

| Result | Status | Body / effect |
|---|---|---|
| Valid | `200` | `{ "user": { "id", "email", "name" } }` + `Set-Cookie: wm_session=…` |
| Expired / used / unknown | `410` | `{ "error": "That link has expired", "detail": "Links work once and last 15 minutes.", "code": "expired" }` |

The account is created here on first sign-in. Expired, already-used and unknown collapse to one
screen, so nothing leaks. A successful verify may also carry `"forkedTree": "<tree id>"` when the
link rode in with a `forkOf`; a fork that cannot be planted degrades to a plain sign-in rather than
blocking the door.

### `POST /v1/auth/verify-code` — complete a code (the app door)

Request `{ "email": "sam@example.com", "code": "483201" }`

| Result | Status | Body / effect |
|---|---|---|
| Valid | `200` | `{ "user": {…} }` (+ `forkedTree` when one rode the row) + `Set-Cookie: wm_session=…` — byte-for-byte the `/v1/auth/verify` shape; the session secret is never in the body |
| Wrong / expired / used / exhausted / unknown email | `410` | `{ "error": "That code has expired", "detail": "Codes work once and last 15 minutes.", "code": "expired" }` |
| Missing email or code | `400` | `{ "error": "Missing code", "code": "bad_request" }` |

The lookup is the NEWEST live row for the address — unspent, unexpired, fewer than 5 attempts — so a
resend supersedes the code before it. A wrong guess spends one attempt on that row (one atomic
`UPDATE … SET attempts = attempts + 1 RETURNING attempts`); at 5 the row is dead and a fresh request
is the remedy. A right guess burns the row through the same atomic `consumed_ms` flip the link uses,
then runs the identical `mintSessionFor` tail (find-or-create, revival-in-grace, 90-day rolling
session). Every failure collapses to the one 410 body, so the endpoint cannot be probed for which
addresses hold pending codes or accounts.

A 6-digit code has 10⁶ states, so the bound is the defense, not the digest at rest: 15-minute life,
single use, 5 attempts per row, and a per-IP bucket on `/v1/auth/verify-code` (10/min, burst 10, in
`main.cpp`'s sync advice).

### `GET /v1/me`

`200 { "user": {…} }` when the session resolves (the window rolls forward on each call), else
`401 {}`.

### `POST /v1/auth/logout`

Drops the session, clears the cookie, `204`.

### `POST /v1/auth/apple` — the native door

Request `{ "authorizationCode": "<from ASAuthorizationController>", "name": "Sam Gold" }`. The name
is Apple's, and Apple sends it exactly once — on the first authorization for that Apple ID — so it
arrives here or never; it seeds a NEW account and never renames an existing one.

| Result | Status | Body |
|---|---|---|
| Signed in | `200` | `{ "user": {…}, "session": "<secret>", "created": bool, "privateEmail": bool }` + `Set-Cookie` |
| Already signed in — the door was bound to the caller | `200` | `{ "user": {…}, "attached": true }` |
| That Apple ID already opens another account | `409` | `{ "error": …, "code": "identity-taken" }` |
| Apple refused, or the identity is unusable | `401` | `{ "error": "apple sign-in could not be completed" }` |
| Not configured (any of the four env vars missing) | `404` | `{ "error": "apple sign-in is not configured" }` |

`session` is the same secret as the cookie, returned in the body because a native app keeps it in
the Keychain and sends it as `Authorization: Bearer`. `created` **and** `privateEmail` together are
the condition the app offers the link door on.

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

Also on this surface: `PATCH /v1/me`, `DELETE /v1/me` (soft close with a 30-day grace),
`GET /v1/sessions`, `DELETE /v1/sessions/{id}`, `DELETE /v1/sessions`, and Google's two redirects
`GET /v1/auth/google/start` · `GET /v1/auth/google/callback`.

## Identities — one account, many doors

The Windmill account is an email address: one `users` row, `email citext unique`. Magic link,
Google and Apple all resolve onto it.

### `user_identities` — the key that outlives an address

```sql
create table if not exists user_identities (
  provider      text not null check (provider in ('google','apple')),
  subject       text not null,
  user_id       uuid not null references users(id) on delete cascade,
  email_at_link text not null default '',   -- what the provider said when we linked; never re-read
  created_at    timestamptz not null default now(),
  primary key (provider, subject)
);
create index if not exists user_identities_user on user_identities (user_id);
```

The provider-issued subject IS the identity; the email is only a hint, consulted once, to find an
account that already exists. `(provider, subject)` is the primary key, so a provider that changes
the address behind an account — an Apple relay rotated, a Google primary email moved — still
resolves to the same user.

Apple's Hide My Email returns `<opaque>@privaterelay.appleid.com`, and the name plus the real email
arrive exactly once, on the first authorization. Every later sign-in carries only `sub`.

### The resolution ladder

One order, both providers. The first step that answers, answers.

1. **`(provider, subject)` is known** → that user, and the email is never consulted. A rotated relay
   address, a changed Google address, an edited display name — none can move an account once the
   subject is bound.
2. **No door bound** → the verified address finds or creates an account exactly as a magic link
   does, and the door is bound on the way through.

A relay address runs step 2 unchanged: it is stable for this app, so it re-finds the same human and
collides with no one else. What it cannot do is find the account they already have on the web — so
the reply carries `privateEmail: true` beside `created`, and those two facts together are what the
client offers the link door on.

`email_verified == false` never reaches step 2. An unverified provider address resolving onto an
existing account is an account takeover by anyone who can type an address.

**A provider sign-in performed while already signed in is an ATTACH, never a resolve.** It binds
`(provider, subject)` to the caller's current account and returns that account unchanged. This is
the *Connect Apple* row in settings, and it is why the app offers *Continue with Apple* as a sign-in
only while signed out.

### The link door

The app's home carries one dismissible line — *"Already use Windmill on the web? Link this
account."* — which runs the ordinary magic-link flow inside the app and posts the token to
`POST /v1/auth/link` while still holding the new account's session. The server resolves the token to
user A and compares it with caller B:

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

### Native surface notes

- `Caller.cpp` falls back to `Authorization: Bearer <session-secret>` when the `wm_session` cookie is
  absent, and `AuthService::authenticate` is transport-neutral. The iOS app keeps the secret in the
  Keychain.
- The apps sign in by code: mint with `door: "app"`, post the typed digits to `/v1/auth/verify-code`,
  capture the session from `Set-Cookie`. A pasted magic link still works through `/v1/auth/verify`
  (sign-in) or `/v1/auth/link` (the merge above).
- App Store guideline 5.1.1(v) requires in-app account deletion wherever Sign in with Apple ships;
  settings has close-with-grace.
- Apple's `REVOKE` server-to-server notification unbinds a door, never an account. The identity row
  is dropped, the user's data is untouched, and the email door still opens.

## The link URL

`AuthService` builds `${WINDMILL_APP_URL}/#/auth?token=<secret>`. The token lives in the URL
**fragment**, so it never reaches server logs — the SPA reads `location.hash` and POSTs it to
`/v1/auth/verify`.

## Frontend integration

- Call every auth endpoint with `credentials: 'include'`. The server grants credentialed CORS only to
  allow-listed origins — the app's own origin (`WINDMILL_APP_URL`) plus any in
  `WINDMILL_ALLOWED_ORIGINS`. Any other origin gets no `Allow-Origin`, so a hostile page cannot drive
  a credentialed `/v1/auth/verify`.
- In production the cookie's `Domain` is the registrable domain (`WINDMILL_COOKIE_DOMAIN`), so `app`
  and `api.app` share it. On `https` origins the cookie is `Secure`.

## Operator env

| Var | Purpose | Default |
|---|---|---|
| `RESEND_API_KEY` | Resend key; without it, sends throw → `502` | — |
| `RESEND_FROM` | Verified sender, on a domain verified in Resend. Never Resend's shared `onboarding@resend.dev` outside a scratch box: Resend accepts it only for the account owner and rejects every other recipient `422`, so sign-up breaks for everyone except the person testing it. The deploy guards it | — |
| `WINDMILL_APP_URL` | Base for the magic-link URL; always a trusted CORS origin | `http://localhost:5183` (compose: `https://${DOMAIN_APP}`) |
| `WINDMILL_COOKIE_DOMAIN` | Cookie `Domain`; empty = host-only | compose: `${DOMAIN_APP}` |
| `WINDMILL_ALLOWED_ORIGINS` | Extra credentialed-CORS origins, comma-separated | — |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in; unset → the routes bounce to the app | — |
| `APPLE_CLIENT_ID` | The iOS app's bundle identifier | — |
| `APPLE_TEAM_ID` · `APPLE_KEY_ID` | The team, and the id of the Sign-in-with-Apple key | — |
| `APPLE_PRIVATE_KEY` | The `.p8` key's PEM contents, used to sign each ES256 client secret | — |

Apple stays dark until all four land: `configured()` is false and `/v1/auth/apple` answers `404`
rather than half-working. The client secret is minted per exchange (ES256, one-hour life) rather
than stored, so there is no long-lived secret to rotate.

## The Resend templates

`ResendEmailSender` calls `POST https://api.resend.com/emails` with a stored template id —
`magic-link` (`template.variables.magic_link`), `magic-link-fork` (plus `tree_title` / `tree_meta`),
or `magic-code` (`template.variables.sign_in_code`). It sends `from`, which takes precedence over
the template's default, and **omits `subject`** so the template owns it.

**Each template must define its own subject.** With the payload omitting it, a template with no
default subject makes the send fail and the endpoint returns `502` with Resend's validation message.

**Operator step, not doable from this repo: the `magic-code` template must exist in the Resend
dashboard before any app release ships the code door.** A missing template makes every `door:"app"`
send fail into the 502 brick; a template pasted without the `{{{sign_in_code}}}` variable renders a
mail with an empty slot and no local test fails. Paste-source: `web/emails/magic-code.html` / `.txt`.

Any non-2xx response (or a network error) throws, which the endpoint surfaces as the `502`.

## Lifetimes (`domain/Auth.h`, one source of truth)

Link 15 min · single-use · 9 per email per 10 min · session 90 days, rolling. The 6-digit code lives
ON its link's row and inherits all of it, plus its own bound: 5 attempts, then the row is dead.
