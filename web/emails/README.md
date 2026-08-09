# Windmill transactional emails

Ready-to-paste templates for the email service (Resend). Each email is a `.html`
file plus a plain-text `.txt` twin — always send both parts so clients that block
HTML still get a readable message. The HTML is table-based with inline CSS so it
survives Gmail, Outlook and Apple Mail; the brand fonts never load in email, so the
font *stacks* in each file are the real contract, not a nicety.

Domain is **windmill.works**. The sign-in URL itself is minted by the backend
(`${WINDMILL_APP_URL}/#/auth?token=<secret>`) and arrives as the `{{{magic_link}}}`
variable — the templates never hardcode a link. The app door's 6-digit code is minted the
same way, server-side, and arrives as `{{{sign_in_code}}}`.

## The templates

| File | Resend template id | Subject | When |
|------|--------------------|---------|------|
| `magic-link.html` / `.txt` | `magic-link` | `Your sign-in link` | Any address asks for a link — new or returning |
| `magic-code.html` / `.txt` | `magic-code` | `Your sign-in code` | The mint carried `door:"app"`: the native apps ask for a code to type, and the mail carries the 6 digits instead of the link |
| `magic-link-fork.html` / `.txt` | `magic-link-fork` | `Your sign-in link — and your copy of "{{{tree_title}}}"` | A signed-out visitor forks a shared tree: one link signs them in and plants the copy |
| `reminder.html` / `.txt` | `reminder` | `{{{ready_phrase}}} ready · {{{tree_name}}}` | The weekly slot came round and a tree has steps ready |

Two more mails exist and are not in that table, in opposite directions:

- `magic-link-signup.html` / `.txt` **is never sent.** `ResendEmailSender` calls exactly three
  template ids — `magic-link` (line 13), `magic-link-fork` (line 26) and `magic-code` (line 36) —
  and a first-time address gets the same `magic-link` (or `magic-code`) a returning one does. The
  signup shell is written and unwired; wire it or delete it, but do not read it as shipping copy.
- `journal-nudge` **is sent and has no file here.** `ResendNudgeSender.cpp:18` sends it, and the
  template lives only in Resend, so there is nothing in this repo to paste, diff or review. That
  is a gap rather than a decision.

One sender, not several. `ResendClient` writes `RESEND_FROM` into the payload's `from` on every
message (`ResendClient.cpp:31`), so each mail arrives from the one configured address and the
`From:` lines in the template file headers are intent, not what a recipient sees. Reply-to is set
provider-side on the stored template — keep it `hello@windmill.works`, never a no-reply address.

### Preheaders (the grey line after the subject)

- magic-link: `Works once and lasts 15 minutes — tap and you're in.`
- magic-code: `Works once and lasts 15 minutes — type it and you're in.`
- magic-link-fork: `One tap signs you in and plants a copy of {{{tree_title}}} in your trees.`
- reminder: `Your frontier is waiting — finish one and the next branch unlocks.`
- magic-link-signup, the unsent shell: `One tap creates your account. No password — works once, lasts 15 minutes.`

Each lives as a hidden `<div>` at the top of the HTML and is padded with
`&zwnj;&nbsp;` so the client doesn't spill body copy into the preview.

## Variables

Resend substitutes variables in both subject and body, and every Windmill variable is written
triple-brace `{{{var}}}`: substitution is raw, there is no escaping tier, and a URL therefore
keeps its `&`, `=` and `?` intact. A test enforces that on the reminder, along with the rule
that every variable below appears in a template and every template variable appears below.

**magic-link**

| Variable | Meaning |
|----------|---------|
| `{{{magic_link}}}` | Full sign-in URL. Appears in the button href and the raw paste-fallback (as href and visible text). |

**magic-code**

| Variable | Meaning |
|----------|---------|
| `{{{sign_in_code}}}` | The 6 decimal digits, server-minted (never user text). Appears exactly once, as the big code line — a text-content position, honouring the raw-substitution contract below. There is no link and no button: the code is the whole credential. |

**magic-link-fork** — the same shell, plus the tree the link plants.

| Variable | Meaning |
|----------|---------|
| `{{{magic_link}}}` | The same sign-in URL; following it also plants the copy |
| `{{{tree_title}}}` | The shared tree's name. It is user text and it reaches the Subject line, so the sender strips markup and control bytes first (`emailSafeTitle`, `ResendClient.cpp:13`) |
| `{{{tree_meta}}}` | The one line printed under the title, already worded by the product that owns the words (`ports/SignupFork.h`) — this template counts and pluralises nothing |

**reminder**

| Variable | Meaning |
|----------|---------|
| `{{{tree_name}}}` | Display name, e.g. `Frontend path` |
| `{{{tree_url}}}` | The OWNER's tree, e.g. `https://windmill.works/#/app/t_1a2b3c` — not the public `/t/:id` share page; a reminder goes to the person whose tree it is |
| `{{{done}}}` / `{{{total}}}` | Progress counters, e.g. `9` / `24` |
| `{{{ready_phrase}}}` | The ready count already worded by the server — `1 step`, `3 steps`. Drives the subject and the lede, so the template never has to guess a plural |
| `{{{more_on_tree}}}` | The in-tree remainder, already worded: `and 4 more on this tree`, or `''` when the three slots show everything ready in the featured tree |
| `{{{more_ready}}}` | The other-trees line, already worded: `2 other trees have steps ready`, or `''` when this is the only one. The number counts **trees** — the server names the unit, because a bare `+2` reads as steps |
| `{{{settings_url}}}` | `https://windmill.works/#/settings` — the hash is load-bearing, the app is hash-routed and a bare `/settings` path falls through to the SPA root |
| `{{{pause_url}}}` | `https://windmill.works/pause.html#t=<secret>` — the one-tap pause. The secret rides in the FRAGMENT, which a browser never puts on the wire, so it never reaches **our** logs; a corporate mail rewriter that percent-encodes the whole URL onto its own domain can still see it. The page only pauses on a button press |
| `{{{step_1_label}}}` `{{{step_1_color}}}` | First ready step: its text, and its hue as hex |
| `{{{step_2_label}}}` `{{{step_2_color}}}` | Second slot, or `''` in both fields |
| `{{{step_3_label}}}` `{{{step_3_color}}}` | Third slot, or `''` in both fields |

Fixed slots, **not** `{{#each}}`: the engine never sends more than three steps, and fixed
slots drop a dependency on provider-side iteration. `step_N_color` is one of the six node
hues rendered to hex by the server and is NEVER user text — it lands inside a `style="…"`
attribute, and the raw-substitution contract above explicitly does not cover attribute
positions.

The two remainder lines carry different facts and are therefore two variables, never one:
`more_on_tree` is about the tree the mail is already showing, `more_ready` is about the others.
Both are finished sentences — the template counts nothing and pluralises nothing.

An unused slot collapses to invisible space in the HTML (row height is line-height, never
padding, so an empty label leaves only the 8px dot). The `.txt` twin cannot collapse a line
it doesn't render — an unused slot leaves an *empty* line there, never a whitespace-only one,
because trailing spaces are what `format=flowed` clients join and quoted-printable encodes
as `=20`. A true collapse would need each value to carry its own newline; that is a wire
change, not a template one.

## Dark mode

These mails are **light-only** by design. Each declares `<meta name="color-scheme"
content="light">`, its `supported-color-schemes` twin, and `color-scheme: only light`
on the root/body. That tells Apple Mail and iOS Mail to render the designed light
palette even when the device is in dark mode — without it they auto-invert, which
muddied the white card to beige and flipped the white button text to dark.

There is deliberately no `@media (prefers-color-scheme: dark)` block: Gmail and Outlook
ignore it and apply their own transform anyway, so one consistent light treatment is
the reliable choice for a transactional mail. If a warm-night dark variant is ever
wanted back, it must be paired with the color-scheme signal set to `light dark`.

## Logo

There is no logo image — the header wordmark is real text, which doubles as the
images-off fallback. When a mark ships, swap the header cell for
`<img src="https://windmill.works/email/logo.png" alt="Windmill" width="…" height="…">`.

## Compliance note

The auth mails never carry an unsubscribe link (they're strictly transactional). The
reminder always carries the `Pause reminders` / settings link — keep it when you edit,
along with the promise line above it. That line ("once a week, only while a tree has
steps ready") is not decoration: the whole send rule in `backend/products/roadmap/domain/Reminders.h`
exists to make it literally true, so changing the copy changes a contract. It states a
*necessary* condition, not the whole rule — the recently-active window and the new-account
grace also have to pass, and settings §Reminders is where those are spelled out.

**Shipped:** RFC 8058 one-click unsubscribe, so Gmail's and Yahoo's native unsubscribe button
does appear. `reminderUnsubscribeHeaders` (`ResendClient.cpp:39`) sets `List-Unsubscribe` — the
URL in angle brackets — and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, riding as
message headers rather than template variables. Both mails with a weekly rhythm carry them: the
reminder points at `POST /v1/reminders/unsubscribe?t=<secret>` (`ResendReminderSender.cpp:37`,
route registered POST-only in `products/roadmap/routes.cpp:187`), the journal nudge at
`POST /v1/journal/nudge/unsubscribe?t=<secret>` (`ResendNudgeSender.cpp:18`). POST-only is the
point: a bare GET link in the body is unsubscribed by every prefetcher and link scanner that
walks a mail. The secret is the same one the in-body pause link spends, and the exact header
bytes are pinned by `ResendEmailSenderTest.cpp:81`.
