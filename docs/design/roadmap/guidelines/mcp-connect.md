# MCP Connect — LLM tools

The spec for connecting LLM tools to Windmill over MCP: the connect surface, the OAuth
grant, the API-key escape hatch, the verify states, and the directory artifacts. Motion
physics come from `motion-language.md`; the first build is ceremony #3 cited verbatim, and
this surface adds no motion of its own.

> **Principle: the snippet contains no secret, and the proof is the product working.** One
> hosted URL, OAuth in the browser, no keys on the default path, no "test connection"
> button — the tree growing *is* the verification.

## 1. The server

- **Remote only.** One hosted server, streamable HTTP at `https://windmill.works/mcp`. No
  SSE transport; a GET answers 405. No npm package to version, no local process to babysit.
- **Agent writes are user writes.** Same ceremonies, same coalescing, same undo history.
  The tree does not know or care who tends it.

## 2. The connect surface — the workbench

`windmill.works/app/connect` — one page, one URL, stable and shareable. Answers exactly three
things: which tool, what to paste, what happens next.

- **Entry:** account business, never canvas chrome — one row in the account menu ("Connect
  your LLM tools"), plus settings and the marketing footer. The tree canvas never learns
  about MCP. Signed out, the same page shows with a sign-in gate on Copy.
- **Anatomy, top to bottom:** title + one-sentence promise · **tool tabs** (Claude Desktop ·
  Claude Code · Cursor · Codex · Any client — tools, not transports; adding a tool later is
  adding a tab) · **one dark snippet well** with one Copy, the only dark surface on the page
  · per-tool follow-up steps · the waiting seat · capability chips.
- **Per-tool snippets:** Claude Desktop gets the connector URL + settings steps; CLI tools
  get their one-liner; Cursor/Codex get their config file block; "Any client" gets standard
  `mcpServers` JSON. The URL inside never varies.
- **Copy** flips to olive "Copied" for 1.4s (150ms fades).
- **The promise line replaces the auth wall:** "first connect opens your browser to approve
  — no keys to paste." The page never shows a token.
- **Never:** a packet or card shelf, or a terminal-first page that makes Claude Desktop the
  exception.

## 3. The grant — OAuth in the browser

OAuth 2.1 + PKCE, the MCP-standard flow.

- **The screen:** wordmark · "{Tool} wants access to your Windmill account" · account row
  with "Not you?" · **the capability lines the client actually asked for** · the can't line
  · Cancel / **Allow** · a foot line naming the redirect host.
- **Scopes are `<product>:<level>`**, space-delimited, levels `read` · `write` · `delete`
  (`shell/auth/scopes.js`, mirroring `backend/platform/domain/ToolScope.h`). The card
  renders the request grouped by product — "Your roadmaps", "Your training log" — one line
  per level, delete styled as the destructive one. It never renders a fixed list.
- **Three reaches, not two.** An empty scope is the account-wide grant and is named as such
  ("Everything in your account — every product, including deleting"). A scope the
  server cannot read confers nothing and says so ("Nothing — this request names no part of
  your account"). They look alike and mean opposites; never collapse them. Allow still works
  for both.
- **The can't line does the trust work**, and it follows the grant: with delete, "Deleting
  is permanent — this tool can remove things you made. It can't see your chats or read
  anything you didn't grant above."; without, "It can only do what's listed above. It can't
  see your chats, and nothing else in your account is reachable."
- **No red.** Authorization is not a danger moment.
- **Allow blooms once:** an olive check wakes (no confetti), "Connected · Returning to
  {tool}…", then the browser follows the redirect. Cancel gets the quiet twin: "No changes
  made."
- **Key custody:** the token returns to the client and lives in *its* keychain; Windmill
  stores a hashed record + the client's name, never the conversation. Silent refresh. A
  revoked or expired client's next call returns a fresh grant link in the error. Signed out
  at the grant? Sign-in first, then the same screen — nothing re-runs in the client.
- **Revoke:** Settings → Connections, one row per client (client-reported name + monogram
  badge, granted date, last activity). Disconnect asks once, acts immediately, toasts
  quietly. Revoking access never touches content the tool created.

### 3b. API keys — for clients that can't do OAuth

OAuth is the front door; a handful of clients can't open it (an older or self-built tool, a
CI job, a home server). For those only, Windmill mints a personal key. Deliberately off the
happy path.

- **Placement — both, quietly.** A folded "Advanced — connect with an API key" row (tagged
  `NO OAUTH`) at the bottom of `/connect`, and the API keys section in Settings. Both mount
  the same mint-and-reveal panel (`shell/connect/McpKeyPanel.jsx`).
- **Create — named, shown once.** Name the key for the tool or machine that will hold it
  ("CI · deploy bot", "home server"). On create it is revealed once in a single well with
  Copy and a plain caution: "This is shown once. Treat it like a password — store it now,
  you won't see it again." No red.
- **Use — one canonical form.** An `Authorization: Bearer <key>` header, shown as the
  client's `mcpServers` config.
- **Manage & revoke.** Settings lists each key by name with its created date and last-used;
  the full secret never returns. Revoke asks once, acts on the spot, toasts quietly, and
  never touches content the key created. Multiple named keys per account.

## 4. Capability chips

The connect page carries five compact chips, each wearing its node hue: plant roadmaps ·
add & connect steps · color with your legend · mark progress · read your trees. Example
prompts are real, copyable, and domestic (a move, pottery — never assuming a software team).
Post-connect, three "first prompts" sit under the chips; they reference the user's actual
tree names once any exist.

## 5. Verify — one seat, three tenses

Verification is passive: no test button, nothing to click.

- **Waiting** (after Copy): gold seat, breathing dot — "Listening for a hello from {tool}…"
- **Verified** (first authenticated call): the same chip cross-fades to olive in place,
  280ms — "{Tool} said hello — it can see {n} roadmaps."
- **Settled** (return visits): the connections list + a dashed "+ Connect another tool" row.
- **The payoff is ceremony #3 on the canvas, verbatim:** camera fit → root wakes + crown →
  rings on the 320ms cadence → toast last ("Claude planted Learn pottery · 12 steps").
  Recoloring is feedback-class (silent 280ms recolor, no beat); marking done earns the same
  treatment a click earns. **Real bursts coalesce** — forty calls in two seconds is one
  arrival and one toast.
- **Reduced motion:** one simultaneous 280ms cross-fade, crown frozen mid-breath, toast
  fades without rising.

## 6. Directory presence

Two artifacts inside other people's chrome; both carry the cream, the wordmark, and the
capability chips.

- **Gallery card:** wordmark + three kind-dots (the legend as identity — no logo is
  invented) · REMOTE · OAUTH badge · outcome-first one-liner ("Any goal, as a skill tree.
  Your agent plants roadmaps, grafts steps, and marks progress — you watch the tree grow.")
  · server URL + Copy · the capability chips · "Works with any MCP client · setup at
  windmill.works/connect".
- **README block:** `# Windmill MCP` · one-liner · Quickstart `mcpServers` JSON · the
  capability chips · the can't line · link to /connect.

## 7. Copy

| Where | String |
|---|---|
| Page title | "Connect your LLM tools" |
| Page sub | "Claude, Cursor, or Codex can plant and tend your roadmaps. Pick your tool, paste one snippet — your browser handles the rest." |
| Copy button | "Copy" → "Copied" (1.4s, olive) |
| Waiting seat | "Listening for a hello from {tool}…" |
| Verified seat | "{Tool} said hello — it can see {n} roadmaps" |
| Grant title | "{Tool} wants access to your Windmill account" |
| Grant actions | "Allow" / "Cancel" · post: "Connected · Returning to {tool}…" / "No changes made" |
| Disconnect confirm | "{Tool} will lose access now." → "Disconnect" |
| First-build toast | "Claude planted {tree} · {n} steps" |
| Advanced pointer | "Advanced — connect with an API key" (tag: NO OAUTH) |
| Key reveal | "This is shown once. Treat it like a password — store it now, you won't see it again." |

One metaphor register throughout ("tend", "plant", "said hello"), sentence case, no keys or
transport jargon anywhere a user must read.

## 8. Phone

The connect workbench is a desktop errand — it ends in a config file on a machine — so the
phone gets the short version: what MCP is, the server URL, one Copy button, and a line
saying the rest wants a desktop. No key generation on a phone, no truncated code blocks. Tap
targets ≥44px, copy fields in the action lane (`mobile.md` §5).

## 9. Ownership map

| Concern | Owner |
|---|---|
| Beat physics, cadence, coalescing, reduced motion | `motion-language.md` |
| Sign-in door the grant borrows | `auth.md` |
| Parse door for pasted text | `paste-import.md` |
| Connect surface, grant, API keys, verify, directory | **this doc** |
