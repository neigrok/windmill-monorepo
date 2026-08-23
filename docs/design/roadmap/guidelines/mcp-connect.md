# Windmill MCP Connect — LLM tools (F17)

The canonical spec for connecting LLM tools to Windmill over MCP: the connect
surface, the OAuth grant, the advanced API-key escape hatch, the capabilities
contract, the verify states, and the
directory artifacts. Motion physics come from `motion-language.md` (**the first
build is ceremony #3, cited verbatim — F17 adds no motion of its own**); status
chips use X4's sync grammar (`explorations/account-sync-chrome.html`); the
color tool honors F6's legend contract (`explorations/color-legend.html`).
Live specimens: `explorations/mcp-connect.html`.

> **Principle: the snippet contains no secret, and the proof is the product
> working.** One hosted URL, OAuth in the browser, keys nobody sees on the default path, no "test
> connection" button — the tree growing *is* the verification.

---

## 1. The server — decided

- **Remote only.** One hosted server, streamable HTTP at
  `https://mcp.windmill.works/mcp`, SSE fallback at `/sse`. No npm package to
  version, no local process to babysit.
- **The five verbs are the whole v1 API:** plant a roadmap · add & connect
  steps · color with the legend (F6) · mark progress · read roadmaps. No
  delete-roadmap, no share, no account tools — the explainer, the scopes, and
  the server capabilities are one list; copy can never drift from the truth.
- **Agent writes are user writes.** Same ceremonies, same coalescing (motion
  §4's while-editing rule), same undo history. The tree does not know or care
  who tends it.

## 2. The connect surface — the workbench

`windmill.works/connect` — one page, one URL, stable and shareable. Answers
exactly three things: which tool, what to paste, what happens next.

- **Entry:** account business, never canvas chrome — one new row in X4's
  account menu ("Connect your LLM tools"), plus settings and the marketing
  footer. The tree canvas never learns about MCP. Signed out, the same page
  shows with a sign-in gate on Copy.
- **Anatomy, top to bottom:** title + one-sentence promise · **tool tabs**
  (Claude Desktop · Claude Code · Cursor · Codex · Any client — tools, not
  transports; adding a tool later is adding a tab) · **one dark snippet well**
  with one Copy (the only dark surface on the page — it reads "code" on the
  cream canvas) · per-tool follow-up steps · the waiting seat · capability
  chips.
- **Per-tool snippets:** Claude Desktop gets the connector URL + two-click
  settings steps; CLI tools get their one-liner; Cursor/Codex get their config
  file block; "Any client" gets standard `mcpServers` JSON + the
  transport/fallback note. The URL inside never varies.
- **Copy** flips to olive "Copied" for 1.4s (150ms fades, chrome speed).
- **The promise line replaces the auth wall:** "first connect opens your
  browser to approve — no keys to paste." The page never shows a token, ever.
- **Never:** a packet/card shelf (the packet is F9's object — spending it on
  config cheapens it), or a terminal-first page (makes Claude Desktop, the most
  mainstream client, the exception).

## 3. The grant — OAuth in the browser

OAuth 2.1 + PKCE, the MCP-standard flow, at `windmill.works/authorize`.

- **The screen:** wordmark · "{Tool} wants to tend your roadmaps" · account
  row with "Not you?" · **three scope rows wearing node glyphs** (see your
  roadmaps · plant roadmaps & edit steps · mark progress) · the can't line ·
  Cancel / **Allow** · "Disconnect anytime in Settings → Connections."
- **No checkbox theater:** v1 is one grant, account-wide, all-or-nothing — the
  screen tells the truth instead of offering fake toggles. Per-tree scopes only
  if sharing demands them later.
- **The "can't" line does the trust work:** "It can't share roadmaps, delete
  them, or see your chats." Brick red appears nowhere — authorization is not a
  danger moment.
- **Allow blooms once:** the card swaps in 150ms, an olive check wakes (X1 wake
  shape, no confetti), copy says the useful thing: "Connected — you can close
  this tab." Cancel gets the quiet twin: "No changes made."
- **Key custody:** the token returns to the client and lives in *its* keychain
  — the user never handles a key; Windmill stores a hashed record + the
  client's name, never the conversation. Silent refresh; expiry after 90 days
  idle. A revoked or expired client's next call returns a fresh grant link in
  the error — back to the grant, never to a broken state. Signed out at the
  grant? Sign-in first, then the same screen — nothing re-runs in the client.
- **Revoke:** Settings → Connections, one row per client (client-reported name
  + monogram badge, granted date, last activity). Disconnect asks once
  ("Claude Code will lose access now"), acts immediately, toasts quietly.
  Revoking access never touches content the tool created.

### 3b · Advanced — API keys (for clients that can't do OAuth)

OAuth is the front door; a handful of clients can't open it — an older or
self-built tool, a CI job, a home server. For those only, Windmill mints a
**personal API key**. It is the honest escape hatch, deliberately kept off the
happy path — not the default.

- **Placement — both, quietly.** A folded "Advanced — connect with an API key"
  row (tagged `NO OAUTH`) sits at the bottom of `/connect`, beneath the verbs,
  and only *points to* **Settings → API keys**. `/connect` never mints or prints
  a key — the "shows no token" promise stays literally true; a secret appears
  only in Settings, at creation.
- **Create — named, shown once.** Name the key for the tool or machine that will
  hold it ("CI · deploy bot", "home server"). On create it's revealed once in the
  single dark well with Copy and a plain amber caution ("copy it now — this is
  the only time it's shown; store it like a password"). Brick red never appears;
  a key you hold is a responsibility, not a danger. Prefix `wml_live_…`.
- **Scope & expiry.** Same as OAuth — account-wide, all five verbs. **No expiry:
  a key works until it's revoked.**
- **Use — one canonical form.** An `Authorization: Bearer <key>` header, shown as
  the client's `mcpServers` config with
  `"headers": { "Authorization": "Bearer wml_live_…" }`.
- **Manage & revoke.** Settings → API keys lists each key by name with its last
  four chars (`wml_live_••••4a2f`), created date, and last-used — the full secret
  never returns. Revoke asks once ("this key stops working immediately"), acts on
  the spot, toasts quietly (the disconnect grammar from §3), and never touches
  content the key created. Multiple named keys per account — one per tool or
  machine.

## 4. Capabilities — five verbs, written once

One canonical block, reused verbatim in three places: the connect page
(compact chips), the grant screen (as scopes), and the README/directory card.
If the block can't say it in a line, the server shouldn't do it.

- **Each verb wears its node glyph** — bud (plant), ring (add & connect),
  kind-dot (color), halo (mark progress), dim (read) — teaching the tree's
  vocabulary before the canvas is ever open.
- **Example prompts are real, copyable, and domestic** (a move, pottery —
  never assuming a software team). Post-connect, three "first prompts" sit
  under the verbs; they rotate to reference the user's actual tree names once
  any exist.

## 5. Verify — one seat, three tenses

Verification is passive: no test button, nothing to click.

- **Waiting** (after Copy): gold seat, breathing dot (X4 chip grammar) —
  "Listening for a hello from {tool}…"
- **Verified** (first authenticated call): the same chip cross-fades to olive
  in place, 280ms — "{Tool} said hello — it can see {n} roadmaps." A toast
  would be ceremony spent on plumbing.
- **Settled** (return visits): the connections list + a dashed "+ Connect
  another tool" row.
- **The payoff is ceremony #3 on the canvas, verbatim:** camera fit → root
  wakes + crown → rings on the 320ms cadence → toast last ("Claude planted
  Learn pottery · 12 steps"). `paint_kinds` is feedback-class (silent 280ms
  recolor, no beat); `mark_done` earns the same done treatment a click earns.
  **Real bursts coalesce** (motion §4): forty calls in two seconds is one
  arrival and one toast, not forty ceremonies.
- **Reduced motion:** per motion §5 — one simultaneous 280ms cross-fade, crown
  frozen mid-breath, toast fades without rising.

## 6. Directory presence

Two artifacts inside other people's chrome; both carry the cream, the
wordmark, and the five verbs.

- **Gallery card:** wordmark + three kind-dots (the legend as identity — no
  logo is invented, per system policy) · REMOTE · OAUTH badge · outcome-first
  one-liner ("Any goal, as a skill tree. Your agent plants roadmaps, grafts
  steps, and marks progress — you watch the tree grow.") · server URL + Copy ·
  verb chips · "Works with any MCP client · setup at windmill.works/connect".
- **README block:** `# Windmill MCP` · one-liner · Quickstart `mcpServers`
  JSON · the five verbs · **the can't line ships even here** (it reads as
  confidence, not disclaimer) · link to /connect.

## 7. Copy — every string

| Where | String |
|---|---|
| Page title | "Connect your LLM tools" |
| Page sub | "Claude, Cursor, or Codex can plant and tend your roadmaps. Pick your tool, paste one snippet — your browser handles the rest." |
| Copy button | "Copy" → "Copied" (1.4s, olive) |
| Waiting seat | "Listening for a hello from {tool}…" |
| Verified seat | "{Tool} said hello — it can see {n} roadmaps" |
| Grant title | "{Tool} wants to tend your roadmaps" |
| Grant verbs | "See your roadmaps" · "Plant roadmaps & edit steps" · "Mark progress" |
| Grant can't | "It can't share roadmaps, delete them, or see your chats." |
| Grant actions | "Allow" / "Cancel" · post: "Connected — you can close this tab." |
| Disconnect confirm | "Claude Code will lose access now." → "Disconnect" |
| First-build toast | "Claude planted {tree} · {n} steps" |
| Advanced pointer | "Advanced — connect with an API key" (tag: NO OAUTH) |
| Key reveal | "Copy it now — this is the only time it's shown." / "Store it like a password." |
| Key scope | "Account-wide · all 5 verbs" · "No expiry" |
| Revoke key | "Stops working now." → "Revoke" · toast "Revoked · {name}" |

One metaphor register throughout ("tend", "plant", "said hello"), sentence
case, no keys or transport jargon anywhere a user must read.

## 8. Constants — copy into the build

```
SERVER     https://mcp.windmill.works/mcp (streamable HTTP) · /sse fallback · remote only
API        5 verbs: plant · add/connect · paint_kinds (legend F6) · mark_done · read
AUTH       OAuth 2.1 + PKCE · account-wide · client-held token · silent refresh
           90-day idle expiry · revoke = instant, next call returns a grant link
KEYS       advanced escape hatch · Settings → API keys · wml_live_… · account-wide
           no expiry · Authorization: Bearer header · shown once · revoke = instant 401
SURFACE    windmill.works/connect · tabs per tool · one dark well · one Copy
VERIFY     passive · gold "listening" → olive "said hello" · 280ms in place
CEREMONY   first build = ceremony #3 verbatim · bursts coalesce (motion §4)
NEVER      tokens on /connect · test-connection button · canvas chrome · brick red
```

## 9. Ownership map

| Concern | Owner |
|---|---|
| Beat physics, cadence, coalescing, reduced motion | `motion-language.md` |
| Account menu seat, status-chip grammar | X4 (`explorations/account-sync-chrome.html`) |
| Legend contract (paint_kinds palette) | F6 (`explorations/color-legend.html`) |
| Parse door for pasted text (the *other* door) | `paste-import.md` |
| Connect surface, grant, API keys, verbs, verify, directory | **this doc** |

## Phone

The connect workbench is a **desktop errand** — it ends in a config file on a
machine — so the phone gets the honest short version: what MCP is, the server
URL, one Copy button, and a line saying the rest wants a desktop. No key
generation on a phone (a secret shown once on a device you're likely to lose is a
trap), no truncated code blocks. Tap targets ≥44px, copy fields in the action
lane (`mobile.md` §5).
