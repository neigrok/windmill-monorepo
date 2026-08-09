# Auth — magic-link backend (X6)

Implements `guidelines/auth.md`: passwordless, one door keyed by email, 15-minute
single-use links — every mint also carrying a 6-digit code twin the native apps type instead
of tapping — and 90-day rolling sessions. This file is the contract the frontend consumes
and the operator's wiring reference.

> **Supersedes `SPEC.md §10`.** The founding spec sketched email+password with Argon2. The
> design system's `auth.md` is the newer decision — *"passwords never exist"* — so `users`
> lost `password_hash`/`handle` (see `db/schema.sql`) and the endpoints below replace
> `SPEC §7 → Auth`. SPEC §10 should be rewritten to point here.

## Shape

```
domain/Auth.{h,cpp}                 email parsing, verdicts, lifetimes — pure, no I/O
application/AuthService.{h,cpp}     the lifecycle pipeline (load → domain → persist → email)
ports/AuthRepository.h              users + magic_links + sessions persistence
ports/EmailSender.h                 sendMagicLink / sendForkLink / sendSignInCode
ports/TokenGenerator.h              mint() / mintCode() / digestOf() — secrets vs. stored digests
adapters/postgres/PgAuthRepository  the SQL
adapters/crypto/OpenSslTokenGenerator  32B RAND_bytes → url-safe base64; SHA-256 hex digest;
                                       mintCode() → 6 decimal digits, rejection-sampled (no bias)
adapters/email/ResendEmailSender    Resend HTTP API — 'magic-link' / 'magic-link-fork' /
                                       'magic-code' stored templates
adapters/http/AuthApi               the REST surface + session cookie
adapters/clock/SystemClock          wall clock (tests inject a fake)
```

Secrets (link token, session token) travel in the URL / cookie; only their SHA-256 digest is
ever stored, so a database leak resurrects nothing.

## Endpoints

All JSON. The session rides in an `HttpOnly` `wm_session` cookie; a `Authorization: Bearer
<secret>` header is also accepted (API/tests). Copy is verbatim from `auth.md §7`.

### `POST /v1/auth/magic-link`  — request a link (or, through the app door, a code)
Request `{ "email": "sam@example.com", "forkOf": "t_1a2b3c", "door": "app" }` — `email` alone is
the common case. `forkOf` (optional) is a tree id riding the credential: verify plants a copy of
that tree into whatever account signs in, and it is dropped silently when longer than 64 chars (an
id, not a payload). `door` (optional): `"app"` makes the mail carry the row's 6-digit code instead
of the link; absent or any other value sends today's link mail, byte-identical behavior. Every
mint stores BOTH credentials on the one `magic_links` row — either spends it, and one mint is one
unit of the 9-per-window budget whichever mail it sends.

| Result | Status | Body |
|---|---|---|
| Mail sent | `200` | `{ "status": "sent" }` |
| Address unfinished | `400` | `{ "error": "That address looks unfinished — check the ending.", "code": "invalid_email" }` |
| Too many in a row | `429` | `{ "error": "That's a few links in a row. Check your spam folder first — or try again in 10 minutes.", "code": "rate_limited" }` |
| Mail provider down | `502` | `{ "error": "Can't reach windmill.works", "detail": "Nothing you've written is lost.", "code": "unreachable" }` |

### `POST /v1/auth/verify`  — complete a link (the landing)
Request `{ "token": "<the secret from the emailed URL>" }`

| Result | Status | Body / effect |
|---|---|---|
| Valid | `200` | `{ "user": { "id", "email", "name" } }` + `Set-Cookie: wm_session=…` |
| Expired / used / unknown | `410` | `{ "error": "That link has expired", "detail": "Links work once and last 15 minutes.", "code": "expired" }` |

The account is created here on the first sign-in (one door). Expired, already-used, and
unknown all collapse to one screen — the remedy is identical and nothing leaks. A successful
verify may also carry `"forkedTree": "<tree id>"` when the link rode in with a `forkOf` — the copy
is planted into the signed-in account, and a fork that cannot be planted degrades to a plain
sign-in rather than blocking the door.

### `POST /v1/auth/verify-code`  — complete a code (the app door's landing)
Request `{ "email": "sam@example.com", "code": "483201" }`

| Result | Status | Body / effect |
|---|---|---|
| Valid | `200` | `{ "user": { "id", "email", "name" } }` (+ `forkedTree` when one rode the row) + `Set-Cookie: wm_session=…` — byte-for-byte the `/v1/auth/verify` shape; the session secret is never in the body |
| Wrong / expired / used / exhausted / unknown email | `410` | `{ "error": "That code has expired", "detail": "Codes work once and last 15 minutes.", "code": "expired" }` |
| Missing email or code | `400` | `{ "error": "Missing code", "code": "bad_request" }` |

The lookup is the NEWEST live row for the address — unspent, unexpired, fewer than 5 attempts — so
a resend supersedes the code before it. A wrong guess spends one attempt on that newest row (one
atomic `UPDATE … SET attempts = attempts + 1 RETURNING attempts`); at 5 the row is dead and a
fresh request is the remedy. A right guess burns the row through the same atomic `consumed_ms`
flip the link uses — one row, two credentials, one use — then runs the identical `mintSessionFor`
tail (find-or-create, revival-in-grace, 90-day rolling session). Every failure collapses to the
one 410 body above, so the endpoint cannot be probed for which addresses hold pending codes or
accounts.

**Security note:** a 6-digit code has only 10⁶ states, so hashing it at rest is hygiene, not the
defense. The defense is the bound: 15-minute life, single use, 5 attempts per row, and a dedicated
per-IP bucket on `/v1/auth/verify-code` (10/min, burst 10, in `main.cpp`'s sync advice) as the
outer wall.

### `GET /v1/me`  — the seat
`200 { "user": {…} }` when the session resolves (window rolls forward on each call), else
`401 {}`. A lapsed session is a non-event: the UI quietly returns the seat to its ghost.

### `POST /v1/auth/logout`
Drops the session, clears the cookie, `204`. Local copies stay — no confirmation.

### `POST /v1/auth/apple` — the native door
Request `{ "authorizationCode": "<from ASAuthorizationController>", "name": "Sam Gold" }`. The name
is Apple's, and Apple sends it exactly once — on the very first authorization for that Apple ID — so
it arrives here or never; it seeds a NEW account and never renames an existing one.

| Result | Status | Body |
|---|---|---|
| Signed in | `200` | `{ "user": {…}, "session": "<secret>", "created": bool, "privateEmail": bool }` + `Set-Cookie` |
| Already signed in — the door was bound to the caller | `200` | `{ "user": {…}, "attached": true }` |
| That Apple ID already opens another account | `409` | `{ "error": …, "code": "identity-taken" }` |
| Apple refused, or the identity is unusable | `401` | `{ "error": "apple sign-in could not be completed" }` |
| Not configured (any of the four env vars missing) | `404` | `{ "error": "apple sign-in is not configured" }` |

`session` is the same secret as the cookie, returned in the body because a native app keeps it in the
Keychain and sends it as `Authorization: Bearer` rather than holding a cookie jar. `created` **and**
`privateEmail` together are the condition the app offers the link door on.

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

## Identities — one account, many doors

The Windmill account is an **email address**: one `users` row, `email citext unique`, and every
door resolves to it. Magic link is the founding door. Google sign-in was the second, and it holds
**no provider state at all** — `AuthService::completeGoogle` resolves a Google-verified email the
same way a link does (found, or created, or revived within its close grace), so `sam@gmail.com`
through either door is one account. The native app adds Sign in with Apple as the third, and the
rule that kept the first two free of provider state does not survive it.

### What Apple breaks

Google always returns the real address, so "resolve the verified email" *is* a stable identity.
Apple gives three reasons it isn't:

- **Hide My Email** returns `<opaque>@privaterelay.appleid.com` — verified, stable for this app,
  and the human's real address is unknowable to us. Resolved by email, it creates a **second
  account**, and a lifter's training log then lives half on the phone and half on the web with no
  path between them. That silent fork is the failure this section exists to prevent.
- **The name and the real email arrive exactly once**, on the very first authorization for that
  Apple ID. Every later sign-in carries only `sub`. A first response dropped on the floor loses
  the name forever — there is no second chance and no endpoint to ask.
- So the durable key is the **subject**, never the address.

### `user_identities` — the key that outlives an address

```sql
-- The provider-issued subject IS the identity; the email is only ever a hint, consulted once, to
-- find an account that already exists. (provider, subject) is the PK, so a provider that changes
-- the address behind an account — an Apple relay rotated, a Google primary email moved — still
-- resolves to the same user. Google rides here too, not just Apple: a Google user who changes
-- their primary address forks their account under the email-only rule, which is the same bug
-- Apple would ship on day one.
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

**There is no backfill statement, and there cannot be one.** No Google subject was ever stored, so
there is nothing on disk to migrate — the table fills itself as each account's next provider sign-in
comes through step 2 below and binds its door on the way past. Until that happens an existing Google
user resolves by verified email exactly as they always did, which is why step 2 is not a legacy path
to be removed later but the permanent on-ramp onto step 1.

### The resolution ladder

One order, both providers, read top to bottom. The first step that answers, answers.

1. **`(provider, subject)` is known** → that user, and the email is never consulted. A relay
   address that rotated, a Google address that changed, a display name edited since — none of them
   can move an account once the subject is bound.
2. **No door bound** → the verified address finds or creates an account exactly as a magic link
   does, and the door is bound on the way through. Someone who signed up on the web and taps
   *Continue with Apple* without hiding lands on their own account, with no prompt and nothing to
   explain.

A **relay address runs step 2 unchanged**, and that is deliberate: it is stable for this app, so it
re-finds the same human and can collide with no one else. What it cannot do is find the account they
already have on the web — so the reply carries `privateEmail: true` beside `created`, and those two
facts together are what the client offers the link door on. The fork is made *recoverable*, not
prevented, because there is no honest way to guess which existing account a relay belongs to.

`email_verified == false` never reaches step 2. An unverified provider address that resolved onto
an existing account is an account takeover by anyone who can type an address — the rule
`GoogleOAuthClient` already states in its header, extended to every provider.

**A provider sign-in performed while already signed in is an ATTACH, never a resolve.** It binds
`(provider, subject)` to the caller's current account and returns that account unchanged. This is
the *Connect Apple* row in settings, and it is why the app must offer *Continue with Apple* as a
sign-in only while signed out — signing in by link and then tapping Apple must not be able to fork
the account the user is looking at.

### The link door — and why a merge is refused

A relay sign-in can leave a real human holding a brand-new empty account while their training log
sits under another. The remedy is one dismissible line on the app's home — *"Already use Windmill on
the web? Link this account."* — which runs the ordinary magic-link flow **inside** the app and posts
the token to `POST /v1/auth/link` while still holding the new account's session.

The server resolves the token to user A and compares it with the caller B:

| Case | Outcome |
|---|---|
| A == B | no-op, `200` — the link was already the same account |
| A != B and **B has no data** | every `user_identities` row of B moves to A, B is deleted, a session for A is returned |
| A != B and B has data | `409 account-not-empty` — *"this phone already has training logged on it"* |

**Merge only while provably empty, and never write a general account merger.** Two accounts each
holding trees, pages, sets, a Paddle subscription and their own OAuth grants is a swamp with no
correct answer — two live subscriptions alone have no defensible resolution — and it would cost
more than the product it is protecting. Emptiness is decidable, cheap, and true in the only case
that actually occurs: an account minted minutes ago by a relay sign-in.

Deciding it is the one place this touches products, and it obeys the `STRUCTURE.md` rule the same
way `SignupFork` does — `AuthService` asks a platform port and never a table:

```cpp
// platform/ports/AccountFootprint.h
struct AccountFootprint {
  virtual ~AccountFootprint() = default;
  virtual bool anyData(const UserId&) = 0;
};
```

There is **one** implementation rather than one per product, because every product's answer has the
same shape — a bounded existence check on a table it owns — and four six-line classes would earn
nothing. `PgAccountFootprint` takes a list of `{table, ownerColumn}` probes and runs them as one
`UNION ALL`; the probes are named in `main.cpp`, which composes products by nature, so platform
learns that a probe is a table and never which tables a product keeps. Identifiers can't be bound as
parameters, so the constructor validates each against a plain `[a-z_][a-z0-9_]*` and throws — a
malformed probe takes the server down at boot rather than reaching a query.

The failure direction is what to watch: a product **missing** from that list reports an account
empty that is not, and the link door then deletes real data. So the list is the review surface, an
empty one is refused at construction, and a fourth product adds one line to it.

### Native surface notes

- **The session transport already exists.** `Caller.cpp` falls back to
  `Authorization: Bearer <session-secret>` when the `wm_session` cookie is absent, and
  `AuthService::authenticate` is transport-neutral. The iOS app keeps the secret in the Keychain
  and needs **no backend change** — the `SameSite=Lax` cookie stays a browser concern.
- **The apps sign in by code**: they mint with `door: "app"` and post the typed digits to
  `/v1/auth/verify-code`, capturing the session from `Set-Cookie` — no universal link required. A
  pasted magic link / bare token still works through `/v1/auth/verify` (sign-in) or
  `/v1/auth/link` (the merge above), the token in the fragment for the same reason as the web.
- **Guideline 4.8 is not triggered by a magic link.** It applies to third-party and social login,
  so an app shipping magic link plus Sign in with Apple, and *not* Google, meets it by having
  nothing to be equivalent to. Confirm against the current guideline text before leaning on it.
- **Guideline 5.1.1(v)** requires in-app account deletion wherever SIWA ships; settings already has
  close-with-grace, so this is satisfied by what exists.
- **Apple's `REVOKE` server-to-server notification** unbinds a door, never an account. The identity
  row is dropped, the user's data is untouched, and the email door still opens — a revoked
  provider must never read as a deleted account.

## The link URL

`AuthService` builds `${WINDMILL_APP_URL}/#/auth?token=<secret>`. The token lives in the URL
**fragment**, so it never reaches server logs — the SPA reads `location.hash` and POSTs it to
`/v1/auth/verify`. Add an `#/auth` route to the frontend that does exactly that, then restores
the prior tree/zoom/selection (auth.md §3, "the landing").

## Frontend integration notes

- Call every auth endpoint with `credentials: 'include'`. The server grants credentialed
  CORS **only to allow-listed origins** — the app's own origin (`WINDMILL_APP_URL`) plus any
  in `WINDMILL_ALLOWED_ORIGINS`. Any other origin gets no `Allow-Origin`/credentials, so a
  hostile page can't drive a credentialed `/v1/auth/verify`. Serve the app from an
  allow-listed origin and the cookie flows between app and API.
- In production the cookie's `Domain` is the registrable domain (`WINDMILL_COOKIE_DOMAIN`),
  so `app` and `api.app` share it. On `https` origins the cookie is `Secure`.
- The "old tab wakes itself" behaviour (auth.md §3) is a client concern: poll `/v1/me` or
  listen for a storage event after the new tab signs in.

## Operator env

| Var | Purpose | Default |
|---|---|---|
| `RESEND_API_KEY` | Resend key; without it, sends throw → `502` | — |
| `RESEND_FROM` | Verified sender, on a domain verified in Resend. Never Resend's shared `onboarding@resend.dev` outside a scratch box: Resend accepts it only for the account owner and rejects every other recipient `422`, so sign-up breaks for everyone **except** the person testing it. The deploy guards it for that reason | — |
| `WINDMILL_APP_URL` | Base for the magic-link URL; always a trusted CORS origin | `http://localhost:5183` (compose: `https://${DOMAIN_APP}`) |
| `WINDMILL_COOKIE_DOMAIN` | Cookie `Domain`; empty = host-only | compose: `${DOMAIN_APP}` |
| `WINDMILL_ALLOWED_ORIGINS` | Extra credentialed-CORS origins, comma-separated | — |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in; unset → the routes bounce to the app | — |
| `APPLE_CLIENT_ID` | The iOS app's **bundle identifier** (the native flow's client id) | — |
| `APPLE_TEAM_ID` · `APPLE_KEY_ID` | The team, and the id of the Sign-in-with-Apple key | — |
| `APPLE_PRIVATE_KEY` | The `.p8` key's PEM contents, used to sign each ES256 client secret | — |

Apple stays dark until all four land: `configured()` is false and `/v1/auth/apple` answers `404`
rather than half-working. The client secret is minted per exchange (ES256, one-hour life) rather
than stored, so there is no long-lived secret to rotate.

## The Resend templates

`ResendEmailSender` calls `POST https://api.resend.com/emails` with
`template.id = "magic-link"` (Resend accepts the alias here) and
`template.variables.magic_link = <sign-in URL>`. It sends `from` (which, per Resend, takes
precedence over the template's default) and **omits `subject`** so the template owns it.

> **The `magic-link` template must define its own subject.** When the payload omits it,
> Resend uses the template's default; a template with no default subject makes the send
> fail — the endpoint then returns `502` with Resend's validation message. Put the subject
> on the template, not in this adapter.

The app door's mail is the stored `magic-code` template:
`template.variables.sign_in_code = <the 6 digits>`, subject on the template (`Your sign-in code`),
same `from` handling, no unsubscribe headers. Paste-source: `web/emails/magic-code.html` / `.txt`.

> **Operator step — cannot be done from this repo: the `magic-code` template must be pasted into
> the Resend dashboard before any app release ships the code door.** A missing template makes
> every `door:"app"` send fail into the 502 brick; a template pasted without the
> `{{{sign_in_code}}}` variable renders a mail with an empty slot and no local test fails.

Any non-2xx response (or a network error) throws, which the endpoint surfaces as the `502`
"can't reach windmill.works" brick.

## Lifetimes (`domain/Auth.h`, one source of truth)

Link 15 min · single-use · rate 9 per email per 10 min (raised from 3 — a retry usually means the
last mail never arrived; the rationale sits on `AuthPolicy::maxLinksPerWindow`) · session 90
days, rolling. The 6-digit code lives ON its link's row, so it inherits everything — the same 15
minutes, the same single use, the same 9-per-window budget — and adds its own bound: 5 attempts,
then the row is dead.
