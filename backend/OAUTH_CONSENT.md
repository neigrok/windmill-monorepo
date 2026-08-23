# The MCP OAuth consent screen

The backend is a full OAuth 2.1 authorization server for the MCP resource server. Everything
cryptographic (codes, PKCE, tokens, audience binding) is server-side. The frontend owns exactly one
screen: the consent route (`web/src/shell/auth/OAuthConsent.jsx`). This is its contract.

## Where it sits in the flow

```
MCP client                          Backend                         Consent screen
  │ 1. calls /mcp with no token       │                               │
  │◀───────── 401 + WWW-Authenticate ─┤                               │
  │ 2. discovers metadata, registers, │                               │
  │    builds PKCE, opens the browser │                               │
  │    at  api/oauth/authorize?…      │                               │
  │                          3. GET /oauth/authorize (validates)      │
  │                                   ├── 302 redirect ──────────────▶│  #/oauth/authorize?…params
  │                                   │                               │ 4. require sign-in
  │                                   │                               │ 5. GET /v1/oauth/client → show it
  │                                   │                               │ 6. Approve / Deny
  │                                   │◀── POST /v1/oauth/decision ───┤ 7. { redirect } comes back
  │◀────────── redirect to client ───────────  window.location = redirect  (…?code=…&state=…)
  │ 8. exchanges code at /oauth/token │                               │
  │◀───────── access + refresh token ─┤                               │
  │ 9. calls /mcp with the token, as the signed-in user               │
```

The screen is steps 3–7. It never sees tokens, codes or PKCE secrets.

## The route

`GET {APP_URL}/#/oauth/authorize` — a hash route. `/oauth/authorize` redirects the browser here with
these query params in the hash (read `location.hash`):

| Param | Use |
|---|---|
| `client_id` | identifies the MCP client — look it up (below) to display it |
| `redirect_uri` | where the user is sent back after deciding — show its host |
| `code_challenge`, `code_challenge_method` | opaque PKCE values — pass back untouched |
| `resource` | the MCP server the token will be for — pass back untouched |
| `scope` | may be empty — pass back untouched |
| `state` | opaque anti-CSRF value — pass back untouched |

`code_challenge`, `resource`, `scope` and `state` are opaque strings echoed back verbatim.

## States

1. **Not signed in.** `GET {API_URL}/v1/me` (`credentials: 'include'`). On `401`, run the magic-link
   sign-in, then return to this route with the same params — they live in the URL, so a round-trip
   through sign-in preserves them.

2. **Signed in — show consent.** Fetch the verified client so no attacker-supplied text is rendered:
   `GET {API_URL}/v1/oauth/client?client_id=<client_id>` (`credentials: 'include'`).
   - `200` → `{ "client_id", "client_name", "redirect_uris": [...] }`. Display `client_name` and the
     host of `redirect_uri`, and check that `redirect_uri` is one of `redirect_uris`; if not, show an
     error and do not offer Approve. That check is a courtesy to the reader, never the gate: the
     authorization server parses and matches the redirect itself (userinfo refused, loopback host
     exact, only the port free to vary), and `/v1/oauth/decision` re-runs it before minting anything.
   - `404` → unknown application; error, no Approve.
   Copy: *"‹client_name› wants to access your Windmill roadmaps as you."* Buttons: **Authorize** /
   **Deny**.

3. **Decision.** `POST {API_URL}/v1/oauth/decision` (`credentials: 'include'`, JSON body):
   ```json
   { "client_id": "...", "redirect_uri": "...", "code_challenge": "...",
     "resource": "...", "scope": "...", "state": "...", "approve": true }
   ```
   On `200` the response is `{ "redirect": "https://…?code=…&state=…" }` (or
   `?error=access_denied&…` for Deny). Set `window.location.href = response.redirect`.
   - `401` → the session lapsed mid-flow; re-run sign-in and retry.
   - `400` → the authorization request expired (codes last ~10 min) or is malformed; show "this
     sign-in request expired — start again from your MCP client" and stop.

## Endpoints the screen calls (all on `{API_URL}`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/me` | is the user signed in? |
| `GET` | `/v1/oauth/client?client_id=…` | verified client name + redirect_uris |
| `POST`| `/v1/oauth/decision` | approve/deny → `{ redirect }` to navigate to |

All three send the `wm_session` cookie (`credentials: 'include'`); the backend grants credentialed
CORS to the app origin. The screen does not call `/oauth/authorize`, `/oauth/token`,
`/oauth/register` or the metadata endpoints — those belong to the MCP client and the backend.

## Rules

- **The server is the boundary, not this screen.** An unregistered or crafted `redirect_uri` is
  refused by `/oauth/authorize` and again by `/v1/oauth/decision`.
- **Show verified info, never raw params.** Client name and redirect host come from
  `/v1/oauth/client`. This is what stops a crafted consent link from spoofing a trusted app.
- **Echo the opaque params back byte-for-byte.** Don't parse or normalize them.
- **Follow the returned `redirect` exactly** — don't build the client redirect yourself.
- The whole screen is behind sign-in.
- No tokens or secrets touch this screen. Handling a `code` or `token` here means something is wrong.

## Local dev

`{API_URL}` defaults to `http://localhost:8088` and `{APP_URL}` to the Vite dev origin. The backend
reads `WINDMILL_API_URL` / `WINDMILL_APP_URL`; the consent path it redirects to is
`/#/oauth/authorize` (change both together if you route it elsewhere).
