# Authz wiring — enforcing the session on the data plane

`AUTH.md` gave us **identity** (magic link → `wm_session`). This is the **enforcement** counterpart:
wiring that session onto the tree / WebSocket / MCP surfaces so a caller can only touch what they're
allowed to. It closes the two findings the audit left open once auth landed:

- **#1 — no authz on the data plane.** `HttpApi` still runs as the fixed `devUser`
  (`infra/main.cpp:41`), the socket mints an anonymous `u<N>` per connection
  (`adapters/ws/Collab.cpp:onOpen`), and `windmill_mcp_http` is unauthenticated. Anyone can read/
  write any tree.
- **#8 — unauthenticated `PUT /v1/trees/{id}`** overwrites or creates any tree wholesale.

The seam is already in place: `AuthService::authenticate(secret) -> std::optional<User>`
(`application/AuthService.cpp`) resolves a cookie/bearer to a user and rolls the session. Reuse it
everywhere; never trust a client-supplied user/actor id.

## 1. REST (`windmill_server`)

**Resolve the caller per request, not at construction.** Today `HttpApi` holds one `caller_`
(`adapters/http/HttpApi.h:39`). Replace that with a principal resolved on each call.

- Add a small pre-routing step (a Drogon `HttpFilter`, or a shared helper each handler calls) that
  reads `wm_session` cookie → else `Authorization: Bearer` → `AuthService::authenticate`. Mirror the
  exact cookie/bearer extraction already in `AuthApi::me` (`adapters/http/AuthApi.cpp`).
- **Reads** (`getTree`, `getProgress`, `getDiagnostics`, `getActivity`): allow if the tree is
  `visibility='public'`, else require the caller to be `owner_id` (or an org member). Anonymous is
  fine for public trees only.
- **Writes** (`putTree`, `forkTree`): require an authenticated caller. `putTree` must additionally
  check the caller owns the target tree (or it doesn't exist yet → they become the owner). This is
  the direct fix for #8.
- **Progress** is already keyed by `user_id` in `node_progress` — once the real user flows in, the
  per-user overlay becomes genuine (today every write is `dev`).

## 2. Ownership columns (already in the schema, currently unwritten)

`trees.owner_id`, `trees.org_id`, `trees.visibility` exist (`db/schema.sql`) but nothing sets or
reads them.

- `PgTreeRepository::save`/`fork` (`adapters/postgres/PgTreeRepository.cpp`) must persist `owner_id`
  (= the creating caller) and a default `visibility` (suggest `'private'`).
- Extend `StoredTree` (`ports/TreeRepository.h`) + `PgTreeRepository::load` to surface `owner_id`
  and `visibility`, so `HttpApi` (and the room) can make the authz decision above.
- Decide the tenancy model first (**open question**): per-user only, or orgs + roles via the
  existing `orgs`/`org_members` tables? That choice shapes whether the check is
  `caller == owner_id` or an org-membership lookup — build it once.

## 3. WebSocket (`/v1/socket`)

Authenticate the **upgrade**, not each frame.

- In `TreeSocket::handleNewConnection` (`adapters/ws/TreeSocket.cpp`) the `HttpRequestPtr` is
  available — read the `wm_session` cookie / bearer, `authenticate`, and on failure close the
  connection (reject the upgrade). On success, store the real `UserId` in the connection context
  instead of the anonymous `"u"+N` in `Collab::onOpen`.
- Then `Collab` uses that real user for the op `actor`, the `undoKey`, and `progressUser_` — so undo
  and progress become correctly per-user, and presence shows real identity (the `PresenceHub` seat/
  name derivation can key off it).
- Keep the app-origin allowlist in mind: once the socket is credentialed, only allow upgrades whose
  `Origin` is in the same allowlist `main.cpp` uses for CORS (prevents cross-site socket hijack).

## 4. MCP-HTTP (`windmill_mcp_http`, public)

This is the most exposed write surface and has no cookie to lean on.

- Gate `/mcp` behind a **per-user API token** (a `Bearer` on the MCP request): either a new
  `api_tokens` table (digest-at-rest, same pattern as sessions) or reuse the session token. Check it
  in `McpHttpEndpoint::handlePost` before dispatch; map it to a `UserId` and pass that as the
  `RoadmapTools` caller instead of the env `WINDMILL_MCP_USER`.
- Gate **mutating** tools (`create_node`, `connect`, `delete_node`, …) behind a write scope and the
  same owner/visibility check as REST; read tools (`get_tree`, `get_diagnostics`) can follow the
  visibility rule.
- I'm hardening the transport in parallel (CSPRNG session id, TTL/expiry, Host/Origin checks) — that
  composes with, but does not replace, this token check.

## 5. Footguns to avoid

- **Never** read the acting user/actor from the request body or a client field — always from the
  server-resolved session. (The WS `cmd` frame carries no actor today; keep it that way.)
- The `wm_session` cookie is `SameSite=Lax`, which blocks cross-site POST — keep it; don't loosen to
  `None` without CSRF tokens.
- **Rolling-session write amplification:** `AuthService::authenticate` does a `refreshSession`
  (DB write) on *every* call. Once auth gates every request, throttle it (only roll when, say,
  <80 days remain) so reads don't each incur a write. Pairs with the connection-pooling work.
- Add a CI guard that fails if `server`/`mcp`/`db` ever get a `ports:` mapping or `network_mode:
  host` — the one change that would expose these processes directly instead of only via Caddy.

## Where my hardening meets your authz

My rate-limiter is a Drogon filter keyed on `X-Forwarded-For`; it's written to sit *in front of* an
auth filter, so ordering is: rate-limit → authenticate → authorize → handler. When you add the auth
filter, register it after the limiter. I'll flag the exact registration point in `main.cpp` once both
are in.
