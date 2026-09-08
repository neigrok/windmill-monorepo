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
- **Return:** Connect and Settings share a quiet left-arrow "Back" control at the card’s top,
  in both shell and standalone views, with a muted "Esc" hint. The control has a 44px target
  and visible keyboard focus. Back and unhandled Escape return to the previous in-app
  location; direct entry falls back to `/app`. Dialogs and popovers consume Escape
  before page navigation, and Escape in an editable field does not leave the page.
- **Anatomy, top to bottom:** title + one-sentence purpose · **tool picker** (ChatGPT ·
  Claude Desktop · Claude Code · Cursor · Codex · Any client) · selected tool settings ·
  **one theme-inverse snippet well** with one Copy · per-tool setup steps · API-key disclosure.
  ChatGPT is first and selected by default; its panel identifies OpenAI explicitly.
- **Tool picker:** native radio controls in a labelled group. Each option has a 44px target,
  visible keyboard focus, and an unmistakable selected state. The grid has three columns,
  switching to two at viewport widths of 380px or less.
- **Per-tool snippets:** ChatGPT and Claude Desktop get the server URL and setup steps;
  Claude Code gets its one-liner; Cursor and Codex get their config file blocks; Any client
  gets `mcpServers` JSON. The hosted server URL never varies.
- **Codex settings:** the well contains the `mcp_servers.windmill` TOML entry for
  `~/.codex/config.toml`, shared by desktop, CLI and IDE. Setup explicitly asks the user to
  run `codex mcp login windmill` or choose Authenticate in Codex’s MCP settings, then approve
  access in the browser. Restart Codex to load the configuration; `/mcp` checks the server
  connection in the CLI. The panel links the official
  [Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp). Authentication is an explicit
  step; the instructions do not promise an automatic first-call prompt.
- **ChatGPT settings:** name `Windmill`, server URL `https://windmill.works/mcp`,
  authentication `OAuth`. The page guides the user to enable Developer mode under
  Settings → Security and login, create a plugin from the Plugins plus button, enter the
  settings and approve Windmill access, then select it from the composer’s + → Developer mode.
  Availability depends on the account and workspace; link the official setup instructions
  beside that disclosure, without a plan checklist.
- **Copy** changes its label to "Copied" for 1.4s only after the clipboard write resolves.
  Failure offers manual copying and never claims success. Announce the result politely;
  changing tools clears feedback and its timer.
- **Approval:** each tool’s numbered setup steps include account approval. The default path
  never shows a token or asks for an OpenAI API key. Public endpoint settings are distinct
  from account credentials.
- **Rhythm:** 13px body copy and 12px code in a workbench capped at 560px. The snippet well
  follows the inverse neutral palette: dark in light mode and ivory in dark mode. Copy feedback
  keeps the neutral treatment. Tool selection uses 150ms standard easing, removed under
  reduced motion; copy feedback and the disclosure change immediately.
- **Advanced:** an "API keys" disclosure follows the setup instructions. It retains the shared
  key panel and exposes expanded state and its controlled region to assistive technology.

### ChatGPT reference

Setup terminology and OAuth support follow OpenAI’s
[Developer mode guide](https://developers.openai.com/api/docs/guides/developer-mode) and
[ChatGPT connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
The settings above describe connecting Windmill’s hosted MCP server to ChatGPT.

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

- **Placement — both, quietly.** A folded "API keys" row at the bottom of `/connect`, and the API keys section in Settings. Both mount
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

## 4. Setup scope

The connect page contains client settings and setup instructions. Product capabilities and
example prompts belong to product guidance; the setup page has no capability chips or first-prompt
shelf. The account grant identifies the access requested by the client.

## 5. Connection evidence

Connection verification must reflect observed server activity. Copying a setting only
confirms clipboard success; it does not establish a connection. The setup page has no
listening indicator or connected claim without that observation.

- **Waiting:** only when a real observation mechanism is active; no simulated progress.
- **Verified:** only after an authenticated call from the named tool. Any displayed account
  or roadmap count must come from that observation.
- **Settled:** a connections list belongs to connection management, not an inferred setup state.
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
| Page sub | "Use your AI tools with Windmill." |
| Copy button | "Copy URL" / "Copy" → "Copying…" → "Copied" (1.4s) |
| ChatGPT heading | "ChatGPT · OpenAI" |
| ChatGPT approval step | "Choose OAuth, then approve access to Windmill when prompted." |
| Grant title | "{Tool} wants access to your Windmill account" |
| Grant actions | "Allow" / "Cancel" · post: "Connected · Returning to {tool}…" / "No changes made" |
| Disconnect confirm | "{Tool} will lose access now." → "Disconnect" |
| First-build toast | "Claude planted {tree} · {n} steps" |
| Advanced pointer | "API keys" |
| Key reveal | "This is shown once. Treat it like a password — store it now, you won't see it again." |

Setup copy uses sentence case and names each client’s settings directly. Transport details
belong to Any client; key handling belongs to the API-key disclosure.

## 8. Phone

The same selected-tool setup remains readable on a phone. The tool grid changes to two columns
at 380px, setup Copy and tool controls have 44px targets, and settings labels stay with their
values. Long code wraps inside its well instead of widening the page. ChatGPT setup names the web
interface; do not imply that the native ChatGPT app provides these settings. The API-key
fallback starts collapsed.


## 9. Ownership map

| Concern | Owner |
|---|---|
| Beat physics, cadence, coalescing, reduced motion | `motion-language.md` |
| Sign-in door the grant borrows | `auth.md` |
| Parse door for pasted text | `paste-import.md` |
| Connect surface, grant, API keys, verify, directory | **this doc** |

## 10. Drawing handoff

The Roadmap Figma Workbench page (`16:2`) covers the list workbench, picker and editing
affordances. Its drawing gap is this responsive Connect workbench: ChatGPT selected, six-tool
grid, explicit OAuth settings, theme-inverse snippet well, clipboard success and failure states,
and collapsed API-key fallback. The setup contract is recorded above.
