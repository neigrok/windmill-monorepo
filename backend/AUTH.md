# Auth — magic-link backend (X6)

Implements `guidelines/auth.md`: passwordless, one door keyed by email, 15-minute
single-use links, 90-day rolling sessions. This file is the contract the frontend consumes
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
ports/EmailSender.h                 sendMagicLink(to, url)
ports/TokenGenerator.h              mint() / digestOf() — secrets vs. stored digests
adapters/postgres/PgAuthRepository  the SQL
adapters/crypto/OpenSslTokenGenerator  32B RAND_bytes → url-safe base64; SHA-256 hex digest
adapters/email/ResendEmailSender    Resend HTTP API, 'magic-link' template, magic_link var
adapters/http/AuthApi               the REST surface + session cookie
adapters/clock/SystemClock          wall clock (tests inject a fake)
```

Secrets (link token, session token) travel in the URL / cookie; only their SHA-256 digest is
ever stored, so a database leak resurrects nothing.

## Endpoints

All JSON. The session rides in an `HttpOnly` `wm_session` cookie; a `Authorization: Bearer
<secret>` header is also accepted (API/tests). Copy is verbatim from `auth.md §7`.

### `POST /v1/auth/magic-link`  — request a link
Request `{ "email": "sam@example.com" }`

| Result | Status | Body |
|---|---|---|
| Link sent | `200` | `{ "status": "sent" }` |
| Address unfinished | `400` | `{ "error": "That address looks unfinished — check the ending.", "code": "invalid_email" }` |
| Too many in a row | `429` | `{ "error": "That's a few links in a row. Check your spam folder first — or try again in 10 minutes.", "code": "rate_limited" }` |
| Mail provider down | `502` | `{ "error": "Can't reach windmill.works", "detail": "Your trees are safe on this device.", "code": "unreachable" }` |

### `POST /v1/auth/verify`  — complete a link (the landing)
Request `{ "token": "<the secret from the emailed URL>" }`

| Result | Status | Body / effect |
|---|---|---|
| Valid | `200` | `{ "user": { "id", "email", "name" } }` + `Set-Cookie: wm_session=…` |
| Expired / used / unknown | `410` | `{ "error": "That link has expired", "detail": "Links work once and last 15 minutes.", "code": "expired" }` |

The account is created here on the first sign-in (one door). Expired, already-used, and
unknown all collapse to one screen — the remedy is identical and nothing leaks.

### `GET /v1/me`  — the seat
`200 { "user": {…} }` when the session resolves (window rolls forward on each call), else
`401 {}`. A lapsed session is a non-event: the UI quietly returns the seat to its ghost.

### `POST /v1/auth/logout`
Drops the session, clears the cookie, `204`. Local copies stay — no confirmation.

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
| `RESEND_FROM` | Verified sender | `Windmill <onboarding@resend.dev>` |
| `WINDMILL_APP_URL` | Base for the magic-link URL; always a trusted CORS origin | `http://localhost:5183` (compose: `https://${DOMAIN_APP}`) |
| `WINDMILL_COOKIE_DOMAIN` | Cookie `Domain`; empty = host-only | compose: `${DOMAIN_APP}` |
| `WINDMILL_ALLOWED_ORIGINS` | Extra credentialed-CORS origins, comma-separated | — |

## The Resend template

`ResendEmailSender` calls `POST https://api.resend.com/emails` with
`template.id = "magic-link"` (Resend accepts the alias here) and
`template.variables.magic_link = <sign-in URL>`. It sends `from` (which, per Resend, takes
precedence over the template's default) and **omits `subject`** so the template owns it.

> **The `magic-link` template must define its own subject.** When the payload omits it,
> Resend uses the template's default; a template with no default subject makes the send
> fail — the endpoint then returns `502` with Resend's validation message. Put the subject
> on the template, not in this adapter.

Any non-2xx response (or a network error) throws, which the endpoint surfaces as the `502`
"can't reach windmill.works" brick.

## Lifetimes (`domain/Auth.h`, one source of truth)

Link 15 min · single-use · rate 3 per email per 10 min · session 90 days, rolling.
