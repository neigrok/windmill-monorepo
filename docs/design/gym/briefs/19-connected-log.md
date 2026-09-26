# Connected log

The native gym screen for connected tools, reached from Settings and Coach. Web uses the shared
`/app/connect` page and shared connection management. Gym has no CSV export; account export
belongs to the shell.

## The screen — nothing connected

Top to bottom on iOS and Android, with platform-native chrome.

1. **Title** — `Connected log`. The bar's title on the phones.
2. **Head line** — `Your log, read by Claude, Cursor or Codex.` The shared Connect page
   carries setup for other MCP clients.
3. **The grant, as three rows** — one per level, in the ladder's order. Row label 1 word, row meta
   facts and never a sentence:

   | Level | Meta |
   |---|---|
   | `Read` | `sets, workouts, routines, records, notes, weigh-ins` |
   | `Write` | `logs sets · saves notes · adds routines · shares workouts · proposes changes` |
   | `Delete` | `discards a workout · ends a share` |

   Each row must agree with `backend/products/gym/adapters/mcp/GymToolCatalog.cpp`. `save_note`
   is an append-only write; it cannot edit, delete or reorder an existing note. Native Write copy
   still needs the saves-notes clause; see the consistency ledger. **The enumeration is the disclosure.** The rest dial and the reading unit are not
   in the read row because no tool fetches them; nothing needs to say *and not your settings*.

4. **The caption** — the screen's one, and the surprising part:

   > **A routine change waits for your Apply; the rest lands at once.**

5. **The action** — `Connect a tool`. The screen's one primary, in the reach band on both phones. On the phones it leaves the app for the browser, and
   the button says so in the platform's glyph (iOS `arrow.up.forward`, Android `open_in_new` with
   `contentDescription` *opens in your browser*). Signed out on a phone the log is device-local and a
   grant belongs to an account, so the label is `Sign in first` and the tap opens the sign-in door;
   no caption explains it, because the label names what will happen.
6. **The disclosure** — `How this works`, closed by default, the platform's own control: an iOS
   `DisclosureGroup` in its own `List` section, an Android expandable list item with the
   `expand_more` chevron. It opens in place and holds five lines, each a fact
   with a home nowhere else on the screen:

   > One URL pasted into your tool. Your browser opens once to approve.
   > A shared workout is public for 30 days, until you end it.
   > No tool can apply a proposal or edit a logged set.
   > Delete is approved on its own, and a discard is permanent.
   > End a connection under Settings → Connected tools; a key under API keys.

   Keep one disclosure level; do not repeat its contents elsewhere on the screen.


## The screen — something connected

The head line steps aside for the list of what is connected; everything else stays.

1. **Title** — `Connected log`.
2. **Section `Connected`** — one row per credential that reaches the log, from
   `GET /v1/oauth/grants` filtered to the gym scope or the account-wide grant, plus every row of
   `GET /v1/mcp-keys`. Row title is the tool's name (`A connected tool` / `A static key` where the
   wire carries none). Row meta is the levels it holds, then when it was made — never a last read,
   because the wire's `lastUsedMs` is a last-used and a card would read it as a last-read:

   | Credential | Meta |
   |---|---|
   | approved, levels listed | `read · write · delete · since 12 Aug` (only the levels held) |
   | approved, account-wide | `whole account · since 12 Aug` |
   | static key | `API key · whole account · since 12 Aug` |

   The date is `Readout.shortDate` on the phones — `since 12 Aug`, never today or yesterday.
3. **The three level rows**, unchanged — they are what *read · write · delete* in the meta mean.
4. **The caption**, unchanged.
5. **The action** — `Connect a tool`, unchanged. A second tool is the same act.
6. **`Manage connections`** — a text row under the action, a door to the shell's settings
   (`#/settings`, the *Connected tools* and *API keys* sections), the browser glyph on the phones.
   Disconnecting is the shell's act and is not drawn twice.
7. **The disclosure**, unchanged.

**Both reads or neither.** A static key reaches the same tools and never appears in the grants
list, so either read failing makes the answer *unknown*, never an undercount. Unknown is drawn as
one row in the `Connected` section — `Couldn’t read your connections.` — and the section takes the
platform's pull-to-refresh (`.refreshable`, `PullToRefreshBox`). The
invitation still stands under it: an invitation is not a claim about state.


## The native settings row

One row, title `Connected log`, meta the state and nothing else:

| State | Meta |
|---|---|
| read not back | `your AI tools` |
| nothing connected | `nothing connected yet` |
| one | `<name> · <levels>` — `Claude Desktop · read · write` |
| several | `2 tools` (a numeral) |

The row opens this screen on both native surfaces. Its metadata states connection status.

## The other doors onto this screen

- **The Coach room's door** (`FREE_DOOR_LINE` / `FREE_DOOR_VERB` in `coach/coach.js` and its twins)
  is `09-coach.md`'s and does not change here.
- **The movement picker's card on iOS** (`ConnectInvite`, drawn only while nothing reaches the log)
  is an empty state and takes the empty-state budget — a line and an action, ≤ 15 words:
  `A written program? Your AI tool can build it.` over `Connect a tool`. The Sunday/Monday
  sentence and *Connecting is free* go with the rest of the pitch.
- **Web connection setup** is the shell’s `/app/connect` page
  (`web/src/shell/connect/ConnectPage.jsx`). The Coach action opens it directly. Gym settings has
  no Connected log row or duplicate credential reads. Shared Connected tools and API keys manage access. The
  per-client recipe, ChatGPT and Codex authentication, and API-key fallback belong to
  `../../roadmap/guidelines/mcp-connect.md`.

## The pinned strings

Byte-for-byte. The apostrophe is the typographic one (’) everywhere. Where a surface differs it is
said; otherwise both native surfaces carry the same bytes, and each surface's suite pins its own copy.

| Key | String | Budget |
|---|---|---|
| title | `Connected log` | title ≤ 3 |
| head | `Your log, read by Claude, Cursor or Codex.` | line ≤ 12 · 8 |
| level.read | `Read` | label |
| level.read.meta | `sets, workouts, routines, records, notes, weigh-ins` | meta ≤ 8 · 7 (`weigh-ins` counts as two) |
| level.write | `Write` | label |
| level.write.meta | `logs sets · saves notes · adds routines · shares workouts · proposes changes` | capability disclosure |
| level.delete | `Delete` | label |
| level.delete.meta | `discards a workout · ends a share` | meta ≤ 8 · 6 |
| caption | `A routine change waits for your Apply; the rest lands at once.` | caption ≤ 12 · 12 |
| action | `Connect a tool` | CTA ≤ 3 |
| action.signedOut (phones only) | `Sign in first` | CTA ≤ 3 |
| opensInBrowser (phones only, the glyph's name) | `opens in your browser` | — |
| disclosure | `How this works` | ≤ 3 |
| how.1 | `One URL pasted into your tool. Your browser opens once to approve.` | ≤ 12 · 12 |
| how.2 | `A shared workout is public for 30 days, until you end it.` | ≤ 12 · 12 |
| how.3 | `No tool can apply a proposal or edit a logged set.` | ≤ 12 · 11 |
| how.4 | `Delete is approved on its own, and a discard is permanent.` | ≤ 12 · 11 |
| how.5 | `End a connection under Settings → Connected tools; a key under API keys.` | ≤ 12 · 12 |
| connected.head | `Connected` | section ≤ 2 |
| connected.meta.levels | `read · write · delete · since {day}` (held levels only, ladder order) | meta ≤ 8 |
| connected.meta.accountWide | `whole account · since {day}` | meta ≤ 8 |
| connected.meta.key | `API key · whole account · since {day}` | meta ≤ 8 |
| connected.unnamedGrant | `A connected tool` | — |
| connected.unnamedKey | `A static key` | — |
| connected.unread | `Couldn’t read your connections.` | refusal ≤ 12 |
| manage | `Manage connections` | ≤ 3 |
| settings.title | `Connected log` | row title |
| settings.unknown | `your AI tools` | meta |
| settings.none | `nothing connected yet` | meta |
| settings.one | `{name} · {levels}` | meta ≤ 8 |
| settings.many | `{n} tools` | meta |
| picker.line (iOS) | `A written program? Your AI tool can build it.` | empty ≤ 15 with action |
| picker.action (iOS) | `Connect a tool` | CTA ≤ 3 |

`{day}` is the credential's creation day in the surface's short day form. `{levels}` is the ladder
order joined by ` · `; account-wide reads `whole account`.

**The 30 days stays a numeral** on every surface: a consent line states a
duration the way a reader can check it against a calendar.


## Open

- Test whether readers understand that writes other than routine changes apply immediately.
- Native swipe-to-disconnect remains a proposal; Manage connections opens the browser.
