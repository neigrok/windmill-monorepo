# Windmill transactional emails

Ready-to-paste templates for the email service (Resend). Each email is a `.html`
file plus a plain-text `.txt` twin — always send both parts so clients that block
HTML still get a readable message. The HTML is table-based with inline CSS so it
survives Gmail, Outlook and Apple Mail; the brand fonts never load in email, so the
font *stacks* in each file are the real contract, not a nicety.

Domain is **windmill.works**. The sign-in URL itself is minted by the backend
(`${WINDMILL_APP_URL}/#/auth?token=<secret>`) and arrives as the `{{magic_link}}`
variable — the templates never hardcode a link.

## The templates

| File | From | Subject | When |
|------|------|---------|------|
| `magic-link.html` / `.txt` | `Windmill <sign-in@windmill.works>` | `Your sign-in link` | Returning address requests a link |
| `magic-link-signup.html` / `.txt` | `Windmill <sign-in@windmill.works>` | `Welcome to Windmill — your sign-in link` | New address requests a link |
| `reminder.html` / `.txt` | `Windmill <reminders@windmill.works>` | `{{{ready_phrase}}} ready · {{{tree_name}}}` | The weekly slot came round and a tree has steps ready |

Reply-to for every email is `hello@windmill.works` — never a no-reply address.
The two magic-link mails are the same shell with different words; the server picks
sign-in vs sign-up by whether the address already has an account.

### Preheaders (the grey line after the subject)

- magic-link: `Works once and lasts 15 minutes — tap and you're in.`
- magic-link-signup: `One tap creates your account. No password — works once, lasts 15 minutes.`
- reminder: `Your frontier moved — a few steps just came within reach.`

Each lives as a hidden `<div>` at the top of the HTML and is padded with
`&zwnj;&nbsp;` so the client doesn't spill body copy into the preview.

## Variables

Resend substitutes `{{var}}` in both subject and body. If your engine
HTML-escapes values, use the triple-brace form for anything containing a URL
(the magic link, tree/settings links) so `&`, `=` and `?` survive intact.
The reminder is triple-braced throughout — a test enforces it, along with the rule
that every variable below appears in a template and every template variable appears below.

**magic-link / magic-link-signup**

| Variable | Meaning |
|----------|---------|
| `{{magic_link}}` | Full sign-in URL. Appears in the button href and the raw paste-fallback (as href and visible text). |

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

**Not shipped — wave 2:** RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post`. Nothing
sets those headers today, so Gmail's and Yahoo's native unsubscribe button does not appear
on a Windmill reminder. It wants a `headers` field on the Resend payload plus a form-encoded
endpoint; that one IS a one-click POST, which is safe, unlike a bare GET link in the body —
and it is also the answer to a link scanner that runs JavaScript *and* presses buttons. Until
it lands, the in-body pause link and the settings link are the whole opt-out story.
