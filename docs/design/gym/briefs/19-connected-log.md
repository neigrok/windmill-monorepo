# Connected log — the screen where a lifter hands their log to their own AI

A native gym screen, reached from gym settings on iOS and Android: **what connecting an MCP tool grants, and the one action that starts it.** A lifter with
their own Claude, Cursor or Codex connects it here and never opens Coach.

This brief replaces every word the screen carries today. The ruling it lands is the owner's:
*remove these endless descriptions in the connected log*. A second ruling lands with it: **the CSV
export is out of the product on every surface** — sets, notes, Coach conversations and weigh-ins —
so every door, line and mention of it goes in the same change.

## What the screen is for

A lifter opens it to decide one thing: *do I connect my AI tool to this log?* That is a **decision
surface** in `../../guidelines/text-budget.md`'s sense, and it gets forty words of chrome on first
paint. Today it spends between 236 and 503 before the button.

The four moves in the guideline dispose of almost all of it:

- **Already said.** The Sunday/Monday exchange, the pitch title, the three pitch bullets and the
  "free" line are marketing, and every one of them is on the crawlable connect page already
  (`web/public/connect.html`, the two gym paragraphs) — word for word, in the exchange's case. A
  product screen does not sell a feature to someone who has already opened it.
- **Belongs at the moment of consequence.** Which levels a tool asked for, and that delete is
  permanent, are decided on the OAuth consent screen (`web/src/shell/auth/OAuthConsent.jsx`) —
  *See / Add to and change / Delete from your training log*, with *Deleting is permanent* drawn
  only when delete is asked. That screen exists and is the destination; this one does not rehearse
  it.
- **Structure explaining itself.** Three prose paragraphs on what a level can and cannot do are one
  three-row list of facts.
- **Two sentences doing one job.** *It reads and proposes*, *there is no apply tool*, *a change
  arrives as a diff and waits*, *nothing changes until you tap Apply* — four sentences on every
  surface, all saying the one fact this screen owns. It is said once, as the screen's one caption.

**Honesty is not verbosity.** The mission line forbids hiding what a grant reaches; it does not ask
for a paragraph. A short structured notice performed as well as a long one in the trial the
guideline cites, and short prose lost. So the grant is a list, the surprising part is one sentence,
and everything else is one disclosure deep — never a third layer.

## The screen — nothing connected

Top to bottom on iOS and Android, with platform-native chrome.

1. **Title** — `Connected log`. The bar's title on the phones.
2. **Head line** — `Your log, read by Claude, Cursor or Codex.` One line, and it carries the
   precondition by naming the tools: a lifter who uses none of them reads their own answer. The
   longer "if you use none of them this one is not for you yet" is gone; the head is the same fact
   in eight words, and the web's `#/connect` page keeps the *Any client* tab for the rest of MCP.
3. **The grant, as three rows** — one per level, in the ladder's order. Row label 1 word, row meta
   facts and never a sentence:

   | Level | Meta |
   |---|---|
   | `Read` | `sets, workouts, routines, records, notes, weigh-ins` |
   | `Write` | `logs sets · adds routines · shares workouts · proposes changes` |
   | `Delete` | `discards a workout · ends a share` |

   Each row is a claim about `backend/products/gym/adapters/mcp/GymToolCatalog.cpp` and nothing
   else: read is the eight `Access::read` tools, write the seven `Access::write`, delete the three
   `Access::del`. **The enumeration is the disclosure.** The rest dial and the reading unit are not
   in the read row because no tool fetches them; nothing needs to say *and not your settings*.

   These rows are **content, not chrome** — they are the thing a lifter opened the screen to read —
   and they close two ledger entries at once: one word for the thing (`workouts`, the word the MCP
   server's own descriptions use), and the weigh-ins named, which no surface did (`5l`).
4. **The caption** — the screen's one, and the surprising part:

   > **A routine change waits for your Apply; the rest lands at once.**

   Not the reassuring half. A lifter connecting Claude expects it to read the log; what they would
   not guess is that a write grant logs sets and creates routines **without asking**, and that the
   one thing that waits is a change to a routine that already stands. Both halves in one sentence,
   second person, concrete. This is the line the four old sentences were circling.
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

   That is the whole of the long form. Two levels of disclosure, and the second is these five
   lines; there is no third. Nothing here is *inline* prose, and nothing on the screen repeats it.

**The arithmetic.** Chrome on first paint — title, head, caption, action, disclosure label — is
**28 words**. With the three level rows drawn it is 52; with the disclosure open, 110. The old
screen's first paint was 236 (Android), 323 (iOS) and 443 (web) before the button.

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

   The date is `Readout.when` on the phones.
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

**Android reads its grants.** Today Android's row is state-blind (`2r`): it pitches connecting to a
lifter who has connected. This brief rules that both native surfaces draw the same two states from
the same two reads, so Android takes the read iOS already does (`ConnectedLog.read` in
`ConnectedLog.swift`).

## The native settings row

One row, title `Connected log`, meta the state and nothing else:

| State | Meta |
|---|---|
| read not back | `your AI tools` |
| nothing connected | `nothing connected yet` |
| one | `<name> · <levels>` — `Claude Desktop · read · write` |
| several | `2 tools` (a numeral) |

The row opens this screen on both native surfaces. Android's row today opens the web and stacks
the whole card beneath itself; both go. No precondition, no *what it can never do*, no caption under the row: the
door's meta is the state, and the screen behind it is where the words are.

## The other doors onto this screen

- **The Coach room's door** (`FREE_DOOR_LINE` / `FREE_DOOR_VERB` in `coach/coach.js` and its twins)
  is `09-coach.md`'s and does not change here.
- **The movement picker's card on iOS** (`ConnectInvite`, drawn only while nothing reaches the log)
  is an empty state and takes the empty-state budget — a line and an action, ≤ 15 words:
  `A written program? Your AI tool can build it.` over `Connect a tool`. The Sunday/Monday
  sentence and *Connecting is free* go with the rest of the pitch.
- **Web connection setup** is the shell’s `/app/connect` page
  (`web/src/shell/connect/ConnectPage.jsx`). The Coach action opens it directly; the legacy
  `#/gym/connect` route replaces itself with the shared page. Gym settings has no Connected log
  row or duplicate credential reads. Shared Connected tools and API keys manage access. The
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
| level.read.meta | `sets, workouts, routines, records, notes, weigh-ins` | meta ≤ 8 · 6 |
| level.write | `Write` | label |
| level.write.meta | `logs sets · adds routines · shares workouts · proposes changes` | meta ≤ 8 · 8 |
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

**The 30 days stays a numeral** on every surface (the ruling in `3k`): a consent line states a
duration the way a reader can check it against a calendar.

## The strings that go, and where each fact went

Every deleted line is one of the four moves, and each true fact has a drawn destination:

| Gone | Fact | Where it is now |
|---|---|---|
| pitch title, sub, Sunday/Monday exchange, three bullets | the pitch | `connect.html`, verbatim, already |
| precondition (both phones, web) | who it is for | the head line names the tools |
| *free* line (iOS, web) | connecting costs nothing | nothing in gym is for sale; the paid line is Windmill One and gym is not behind it — a price of zero is not a fact a decision needs |
| *desk* / *onTheWeb* / *deviceOnly* | it happens in a browser; needs an account | the button's glyph; `Sign in first` |
| five *can* lines, three *never* lines, `canDo`/`cannotDo`/`deleteLevel` | the grant | the three level rows, `how.3`, `how.4` |
| *approve with care* (web) | write acts without asking; delete is permanent | the caption; `how.4`; the consent screen |
| *ending* / *disconnect* line | where to end one | `how.5`; `Manage connections` |
| *grant line* (web) | one URL | `how.1` |
| *your rest dial and the unit you read in are yours alone* | dials are not read | the read row's enumeration |
| `settingsFallback` (iOS) | — | the settings row's state meta |
| `accountWide` paragraph (iOS) | the grant is the whole account | `whole account` in the row meta |

`10-notes.md` pointed at the connect panel's *cannot* column as the home of *and nothing else you
have set*; that home is now the read row, and the notes brief says so.

**The trust line from `10-notes.md` — *Any agent you connect can read these too.* — stays where it
is, on the Notes screen, unchanged.** It is not repeated here: the read row names `notes` as a
fact, and a notes-shaped sentence on this screen would be the *already said* move in reverse.

## The CSV export, removed

The ruling: **no export door anywhere in gym.** The four routes' doors and every mention:

| Surface | Goes |
|---|---|
| web settings (`settings/GymSettingsSection.jsx`) | the `Export`, `Export notes`, `Export weigh-ins` doors and their `hasLog` / `hasNotes` / `hasWeighIns` reads |
| web threads (`coach/Threads.jsx`, `threads.js`) | the `Export conversations` door |
| web strings | `EXPORT_*` in `notes.js`, `bodyweight.js`, `threads.js`; `EXPORT_*_HREF` in `gymApi.js`; *and the CSV* in `FREE_LINE` (the whole line goes anyway) |
| iOS settings (`SettingsScreen.swift`) | the `CSV export` and `Export conversations` doors |
| iOS strings (`ConnectedLog.swift`) | *and the CSV* in `free` (the whole line goes anyway) |
| Android settings (`ui/SettingsScreen.kt`) | the `CSV export` `ListItem` in `ClosingNote` |
| marketing | `marketing/landingHead.js` — three descriptions naming *a CSV of every set*; `web/public/pricing.html` — *CSV out* on the gym feature row |
| canon | `BUILD.md`'s *third CSV* / *fourth CSV* lines; `11-bodyweight.md`'s export mention |

What stays: the shell's **account** export, which is the shell's and not gym's, and the sentence in
`10-notes.md` that notes leave with it. Whether the four backend routes under `/v1/gym/export` are
deleted with their doors is the build's call, recorded here as owed: a route with no door is a dark
feature, and the mission line is against those.

## Native idiom, per surface

`12-native-idiom.md` rules the containers; the strings above do not change between them.

**iOS.** A screen on the settings tab's `NavigationStack`, inline title `Connected log`, no drawn
heading repeating the bar's. A `List`: the head line as a plain row (or the `Connected` section
with its rows); a section of the three level rows with the caption as its footer; the
`How this works` section as a `DisclosureGroup`; `Manage connections` as a `Link` row with
`arrow.up.forward`. `Connect a tool` is a filled button in the bottom safe-area inset, a `Link`
with the same glyph; signed out it is `Sign in first` and opens the You seat. `.refreshable` on the
list. Prose in the platform's text styles.

**Android.** A `Scaffold` with a `TopAppBar` titled `Connected log`, system back. A `LazyColumn`
of `ListItem`s: head line, the three levels as `headlineContent` / `supportingContent`, the caption
as the group's one supporting caption, `How this works` as an expandable `ListItem` with
`expand_more` rotating to `expand_less`, `Manage connections` with `open_in_new`. The bottom bar
holds `Connect a tool`, `open_in_new` beside it, `contentDescription` *opens in your browser*.
`PullToRefreshBox` around the list. Edge to edge as the room already is.

**Web.** Uses the shared Connect setup and shared connection-management sections described above.
Gym settings retains Units, Notes and its export doors. It has no Rest timer, Set confirmation,
or alarm caption; units updates preserve the remaining preference fields.

## Before and after

Words a lifter reads, counted off the string literals on 2026-09-08. *Before the action* means
every word above the button in the nothing-connected state; *whole* includes what follows it.

| Surface | Before, to the action | Before, whole | After, first paint | After, disclosure open |
|---|---|---|---|---|
| iOS `ConnectScreen` | 323 | 366 | 52 | 110 |
| iOS connected state (one tool, three levels) | — | 203 | 55 | 113 |
| Android settings card | 236 (255 signed out) | 236 | 52 | 110 |
| settings row | iOS 15 · Android the whole card | — | 3–6 | — |
| iOS picker card | 32 | — | 12 | — |
| CSV doors | web 23 + 8 (threads) · iOS 12 · Android 5 | — | 0 | — |

*After, first paint* counts the title, the head, the three level rows, the caption, the action and
the disclosure label; chrome alone is 28.

## Decisions for the owner to ratify

1. **One native screen, two states, on both phones.** Android gets its own screen and reads its
   grants; the state-blind card under the settings row goes. Closes `2r`.
2. **The head names the tools** — `Your log, read by Claude, Cursor or Codex.` — and that is the
   whole precondition. *Any MCP client* lives on the `#/connect` page's tab.
3. **The grant is three rows of facts**, content rather than chrome, worded off the tool catalog.
   `workouts` is the one word; the weigh-ins are named. Closes `5l`.
4. **One caption**: `A routine change waits for your Apply; the rest lands at once.` The four
   "there is no apply tool" sentences collapse into it.
5. **`Connect a tool`** is the action everywhere; **`Sign in first`** on a signed-out phone.
6. **`How this works` is the only long form**, five lines, closed by default, the platform's
   disclosure control. No third layer, no link out from it except the sentence naming Settings.
7. **The pitch is off the product screens.** Its drawn home is `connect.html`; nothing in-app
   advertises a feature to someone standing on it. The `free` line goes with it — nothing in gym is
   for sale.
8. **The consent screen is where levels are approved**, and this screen does not rehearse it.
   *Delete is permanent* is `how.4` here and the consent screen's own line there.
9. **The notes trust line does not move** and is not repeated here.
10. **The native settings row prints the state only.** The picker card on iOS takes the empty-state
    budget.
11. **CSV is gone from every surface**, doors and mentions, including the landing descriptions and
    the pricing feature row. The four backend routes are owed a decision in the build.
12. **`Manage connections` is a door to the shell's settings**, on the phones a browser door. The
    native alternative — swipe a connected row to disconnect, withheld nine seconds with Undo under
    `13-gestures.md` Law 2 — is a good phone feature and would need a revoke call on both phones;
    it is proposed, not ruled, and the door is the shape until it is.
13. **The unknown state is one row and pull-to-refresh**, not a paragraph.

## What the build must also touch

The strings are pinned by suites, and a string that moves takes its test with it: iOS
`ConnectedLogTests.swift` walks every constant and `SheetChromeHostingTests` / `AskTests` touch
some; Android's unit tests reference `canDo`, `deleteLevel`, `precondition`, `connect`, `onTheWeb`
thirty times; the web's `screens.test.js` pins the connect page's shape (`'the connect pitch keeps
two homes…'`, `'the connected-log row names the grant state…'`, the `LEVEL_LINES` read, and the
export rows at `:577`). `web/public/connect.html`'s gym paragraphs are pinned at `:867-870` and do
not change.

## Open

- **Whether the caption lands.** The easiness effect says a plain line raises confidence faster
  than understanding; *the rest lands at once* is the half a lifter needs to have absorbed before
  they approve a write grant. Test on recall.
- **Swipe-to-disconnect on the phones** (decision 12).
- **The `#/connect` page's lede** names roadmaps only — *Claude, Cursor, or Codex can plant and
  tend your roadmaps* — on the page every gym surface now lands on. The shell's, and filed to the
  ledger rather than fixed here.

## Ruled

Decisions 1–13 ratified whole. The four `/v1/gym/export*` routes and the CSV adapter behind them
are deleted with their doors: a route with no door is a dark feature. Swipe-to-disconnect on the
phones (decision 12) stays proposed; the browser door is the shape.
