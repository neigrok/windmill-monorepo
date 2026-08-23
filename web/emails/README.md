# Windmill transactional emails

Ready-to-paste templates for Resend. Each email is a `.html` file plus a plain-text `.txt` twin —
always send both parts. The HTML is table-based with inline CSS so it survives Gmail, Outlook and
Apple Mail; brand fonts never load in email, so the font *stacks* in each file are the contract.

Domain is **windmill.works**. The sign-in URL is minted by the backend
(`${WINDMILL_APP_URL}/#/auth?token=<secret>`) and arrives as `{{{magic_link}}}`; the app door's
6-digit code is minted the same way and arrives as `{{{sign_in_code}}}`. Templates never hardcode
either.

## The templates

| File | Resend template id | Subject | When |
|------|--------------------|---------|------|
| `magic-link.html` / `.txt` | `magic-link` | `Your sign-in link` | Any address asks for a link — new or returning |
| `magic-code.html` / `.txt` | `magic-code` | `Your sign-in code` | The mint carried `door:"app"`: the native apps ask for a code to type |
| `magic-link-fork.html` / `.txt` | `magic-link-fork` | `Your sign-in link — and your copy of "{{{tree_title}}}"` | A signed-out visitor forks a shared tree: one link signs them in and plants the copy |
| `reminder.html` / `.txt` | `reminder` | `{{{ready_phrase}}} ready · {{{tree_name}}}` | The weekly slot came round and a tree has steps ready |

Two mails sit outside that table, in opposite directions:

- `magic-link-signup.html` / `.txt` **is never sent.** `ResendEmailSender` calls exactly three
  template ids — `magic-link`, `magic-link-fork`, `magic-code` — and a first-time address gets the
  same `magic-link` (or `magic-code`) a returning one does. Wire the shell or delete it, but do not
  read it as shipping copy.
- `journal-nudge` **is sent and has no file here.** `ResendNudgeSender.cpp` sends it and the
  template lives only in Resend, so there is nothing in this repo to paste, diff or review.

One sender, not several. `ResendClient` writes `RESEND_FROM` into the payload's `from` on every
message (`ResendClient.cpp`), so the `From:` lines in the template headers are intent, not what a
recipient sees. Reply-to is set provider-side on the stored template — keep it
`hello@windmill.works`, never a no-reply address.

### Preheaders (the grey line after the subject)

- magic-link: `Works once and lasts 15 minutes — tap and you're in.`
- magic-code: `Works once and lasts 15 minutes — type it and you're in.`
- magic-link-fork: `One tap signs you in and plants a copy of {{{tree_title}}} in your trees.`
- reminder: `Your frontier is waiting — finish one and the next branch unlocks.`
- magic-link-signup, the unsent shell: `One tap creates your account. No password — works once, lasts 15 minutes.`

Each lives as a hidden `<div>` at the top of the HTML, padded with `&zwnj;&nbsp;` so the client
does not spill body copy into the preview.

## Variables

Every Windmill variable is written triple-brace `{{{var}}}`: substitution is raw, there is no
escaping tier, and a URL therefore keeps its `&`, `=` and `?` intact. A test enforces that on the
reminder, along with the rule that every variable below appears in a template and every template
variable appears below.

**magic-link**

| Variable | Meaning |
|----------|---------|
| `{{{magic_link}}}` | Full sign-in URL. Appears in the button href and the raw paste-fallback (as href and visible text). |

**magic-code**

| Variable | Meaning |
|----------|---------|
| `{{{sign_in_code}}}` | The 6 decimal digits, server-minted (never user text). Appears exactly once, as the big code line — a text-content position. There is no link and no button: the code is the whole credential. |

**magic-link-fork** — the same shell, plus the tree the link plants.

| Variable | Meaning |
|----------|---------|
| `{{{magic_link}}}` | The same sign-in URL; following it also plants the copy |
| `{{{tree_title}}}` | The shared tree's name. User text that reaches the Subject line, so the sender strips markup and control bytes first (`emailSafeTitle`, `ResendClient.cpp`) |
| `{{{tree_meta}}}` | The one line under the title, already worded by the product that owns the words (`backend/platform/ports/SignupFork.h`) — this template counts and pluralises nothing |

**reminder**

| Variable | Meaning |
|----------|---------|
| `{{{tree_name}}}` | Display name, e.g. `Frontend path` |
| `{{{tree_url}}}` | The OWNER's tree, e.g. `https://windmill.works/#/app/t_1a2b3c` — not the public `/t/:id` share page |
| `{{{done}}}` / `{{{total}}}` | Progress counters, e.g. `9` / `24` |
| `{{{ready_phrase}}}` | The ready count already worded by the server — `1 step`, `3 steps`. Drives the subject and the lede |
| `{{{more_on_tree}}}` | The in-tree remainder, already worded: `and 4 more on this tree`, or `''` |
| `{{{more_ready}}}` | The other-trees line, already worded: `2 other trees have steps ready`, or `''`. The number counts **trees** — the server names the unit, because a bare `+2` reads as steps |
| `{{{settings_url}}}` | `https://windmill.works/#/settings` — the hash is load-bearing; a bare `/settings` path falls through to the SPA root |
| `{{{pause_url}}}` | `https://windmill.works/pause.html#t=<secret>`. The secret rides in the FRAGMENT, which a browser never puts on the wire, so it never reaches our logs; a corporate mail rewriter that percent-encodes the whole URL onto its own domain can still see it. The page only pauses on a button press |
| `{{{step_1_label}}}` `{{{step_1_color}}}` | First ready step: its text, and its hue as hex |
| `{{{step_2_label}}}` `{{{step_2_color}}}` | Second slot, or `''` in both fields |
| `{{{step_3_label}}}` `{{{step_3_color}}}` | Third slot, or `''` in both fields |

Rules for the reminder's slots:

- Fixed slots, **not** `{{#each}}` — the engine never sends more than three steps.
- `step_N_color` is one of the six node hues rendered to hex by the server and is NEVER user text:
  it lands inside a `style="…"` attribute, which the raw-substitution contract does not cover.
- `more_on_tree` and `more_ready` carry different facts and are therefore two variables. Both are
  finished sentences; the template counts nothing and pluralises nothing.
- An unused slot collapses to invisible space in the HTML (row height is line-height, never padding,
  so an empty label leaves only the 8px dot). The `.txt` twin leaves an *empty* line, never a
  whitespace-only one — trailing spaces are what `format=flowed` clients join and quoted-printable
  encodes as `=20`.

## Dark mode

These mails are **light-only** by design. Each declares `<meta name="color-scheme" content="light">`,
its `supported-color-schemes` twin, and `color-scheme: only light` on the root/body, which tells
Apple Mail and iOS Mail to render the designed light palette on a dark device instead of
auto-inverting it.

There is deliberately no `@media (prefers-color-scheme: dark)` block: Gmail and Outlook ignore it
and apply their own transform anyway. A dark variant would have to be paired with the color-scheme
signal set to `light dark`.

## Logo

There is no logo image — the header wordmark is real text, which doubles as the images-off fallback.
When a mark ships, swap the header cell for
`<img src="https://windmill.works/email/logo.png" alt="Windmill" width="…" height="…">`.

## Compliance

The auth mails carry no unsubscribe link (they are strictly transactional). The reminder always
carries the `Pause reminders` / settings link — keep it, along with the promise line above it. That
line ("once a week, only while a tree has steps ready") is a contract: the send rule in
`backend/products/roadmap/domain/Reminders.h` exists to make it literally true. It states a
*necessary* condition, not the whole rule — the recently-active window and the new-account grace
also have to pass, and settings §Reminders spells those out.

RFC 8058 one-click unsubscribe rides as message headers rather than template variables.
`reminderUnsubscribeHeaders` (`ResendClient.cpp`) sets `List-Unsubscribe` — the URL in angle
brackets — and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Both weekly mails carry them:
the reminder points at `POST /v1/reminders/unsubscribe?t=<secret>` (`ResendReminderSender.cpp`),
the journal nudge at `POST /v1/journal/nudge/unsubscribe?t=<secret>` (`ResendNudgeSender.cpp`).
**POST-only is the point**: a bare GET link in the body is unsubscribed by every prefetcher and link
scanner that walks a mail. The secret is the same one the in-body pause link spends, and the exact
header bytes are pinned by `ResendEmailSenderTest.cpp`.
