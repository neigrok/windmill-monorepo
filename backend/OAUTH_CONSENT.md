# Frontend spec — the MCP OAuth consent screen

The backend is a full OAuth 2.1 authorization server for the MCP resource server. Everything
cryptographic (codes, PKCE, tokens, audience binding) is done server-side. **The frontend owns
exactly one new screen: the consent route.** This spec is the contract to build it against your
designs — no backend knowledge beyond the endpoints below is needed.

## Where it sits in the flow

```
Claude (MCP client)                Backend                         You (this screen)
  │ 1. calls /mcp with no token       │                               │
  │◀───────── 401 + WWW-Authenticate ─┤                               │
  │ 2. discovers metadata, registers, │                               │
  │    builds PKCE, opens the browser │                               │
  │    at  api/oauth/authorize?…       │                               │
  │                          3. GET /oauth/authorize (validates)      │
  │                                   ├── 302 redirect ──────────────▶│  #/oauth/authorize?…params
  │                                   │                               │ 4. require sign-in (magic link)
  │                                   │                               │ 5. GET /v1/oauth/client → show it
  │                                   │                               │ 6. user clicks Approve / Deny
  │                                   │◀── POST /v1/oauth/decision ───┤ 7. { redirect } comes back
  │◀────────── redirect to client ───────────  window.location = redirect  (…?code=…&state=…)
  │ 8. exchanges code at /oauth/token │                               │
  │◀───────── access + refresh token ─┤                               │
  │ 9. calls /mcp with the token → works, as the signed-in user       │
```

Your screen is steps **3–7**. You never see tokens, codes, or PKCE.

## The route

`GET {APP_URL}/#/oauth/authorize` — a hash route (like `#/auth`). The backend's `/oauth/authorize`
redirects the browser here with these **query params in the hash** (read `location.hash`):

| Param | Use |
|---|---|
| `client_id` | identifies the MCP client — look it up (below) to display it |
| `redirect_uri` | where the user is sent back after deciding — show its host so they see the destination |
| `code_challenge`, `code_challenge_method` | opaque PKCE values — **pass them back untouched** in the decision |
| `resource` | the MCP server the token will be for — opaque, pass back untouched |
| `scope` | may be empty — pass back untouched |
| `state` | opaque anti-CSRF value — pass back untouched |

Treat `code_challenge`, `resource`, `scope`, `state` as **opaque strings you echo back verbatim**.

## The screen's states

1. **Not signed in.** Call `GET {API_URL}/v1/me` (`credentials: 'include'`). On `401`, run the
   existing magic-link sign-in (the same `AuthClient` flow used elsewhere), then return to this
   route with the same params. The params live in the URL, so a full round-trip through sign-in
   preserves them — just navigate back to the current hash after sign-in completes.

2. **Signed in — show consent.** Fetch the *verified* client so you never render attacker-supplied
   text: `GET {API_URL}/v1/oauth/client?client_id=<client_id>` (`credentials: 'include'`).
   - `200` → `{ "client_id", "client_name", "redirect_uris": [...] }`. Display `client_name` and the
     host of `redirect_uri`. **Sanity-check** that `redirect_uri` is one of `redirect_uris`; if not,
     show an error and do not offer Approve.
   - `404` → unknown application; show an error, no Approve.
   Copy suggestion: *"‹client_name› wants to access your Windmill roadmaps as you."* Buttons: **Authorize** / **Deny**.

3. **Decision.** `POST {API_URL}/v1/oauth/decision` (`credentials: 'include'`, JSON body):
   ```json
   { "client_id": "...", "redirect_uri": "...", "code_challenge": "...",
     "resource": "...", "scope": "...", "state": "...", "approve": true }
   ```
   (`approve: false` for Deny.) On `200` the response is `{ "redirect": "https://…?code=…&state=…" }`
   (or `?error=access_denied&…` for Deny). **Do `window.location.href = response.redirect`** — that
   hands the browser back to the MCP client. You're done.
   - `401` → the session lapsed mid-flow; re-run sign-in and retry.
   - `400` → the authorization request expired (codes last ~10 min) or is malformed; show a brief
     "this sign-in request expired — start again from your MCP client" and stop.

## Endpoints you call (all on `{API_URL}`)

| Method | Path | Credentials | Purpose |
|---|---|---|---|
| `GET` | `/v1/me` | include | is the user signed in? (existing) |
| `GET` | `/v1/oauth/client?client_id=…` | include | verified client name + redirect_uris |
| `POST`| `/v1/oauth/decision` | include | approve/deny → `{ redirect }` to navigate to |

All three send the `wm_session` cookie (`credentials: 'include'`); the backend grants credentialed
CORS to the app origin. You do **not** call `/oauth/authorize`, `/oauth/token`, `/oauth/register`, or
the metadata endpoints — those are the MCP client's and the backend's.

## Rules of thumb

- **Show verified info, never raw params.** Client name + redirect host come from `/v1/oauth/client`,
  not from the URL. This is what stops a crafted consent link from spoofing a trusted app.
- **Echo the opaque params back byte-for-byte** in the decision (`code_challenge`, `resource`,
  `scope`, `state`). Don't parse or normalize them.
- **Follow the returned `redirect` exactly** — don't build the client redirect yourself.
- The whole screen is behind sign-in; an anonymous user must sign in before they can authorize.
- No tokens or secrets ever touch this screen; if you find yourself handling a `code` or `token`,
  something is wrong.

## For local dev

`{API_URL}` defaults to `http://localhost:8088` and `{APP_URL}` to the Vite dev origin. The backend
reads `WINDMILL_API_URL` / `WINDMILL_APP_URL`; the consent path it redirects to is `/#/oauth/authorize`
(change both together if you route it elsewhere).
