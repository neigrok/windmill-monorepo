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
| `reminder.html` / `.txt` | `Windmill <reminders@windmill.works>` | `{{ready_count}} steps are ready · {{tree_name}}` | Steps on a tree became reachable |

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
HTML-escapes values, use the triple brace `{{{var}}}` for anything containing a URL
(the magic link, tree/settings links) so `&`, `=` and `?` survive intact.

**magic-link / magic-link-signup**

| Variable | Meaning |
|----------|---------|
| `{{magic_link}}` | Full sign-in URL. Appears in the button href and the raw paste-fallback (as href and visible text). |

**reminder**

| Variable | Meaning |
|----------|---------|
| `{{tree_name}}` | Display name, e.g. `Frontend path` |
| `{{tree_url}}` | Deep link, e.g. `https://windmill.works/t/frontend-path` |
| `{{done}}` / `{{total}}` | Progress counters, e.g. `9` / `24` |
| `{{ready_count}}` | Count of newly-ready steps (subject line) |
| `{{settings_url}}` | Pause-reminders link, e.g. `https://windmill.works/settings` |
| `{{#each ready_steps}}` | Rows to render; each item has `{{label}}` and `{{color}}` (a hex string for the dot) |

If the engine can't iterate over a list (plain `{{var}}` substitution only), replace
the `{{#each ready_steps}}…{{/each}}` block with fixed rows keyed by
`{{step_1_label}}` / `{{step_1_color}}`, `{{step_2_*}}`, `{{step_3_*}}` and have the
backend send empty strings for unused slots. The iterating form is preferred.

## Dark mode

Clients that honour `prefers-color-scheme` get the warm night palette from the
`@media (prefers-color-scheme: dark)` block (canvas `#0D0B07`, card `#17120B`, text
`#F4EEDF`). `!important` is required there — it's the only way to beat the inline
styles that older clients need. The button stays terracotta `#BC6C42` in both modes.

The duplicate `html.wm-dark-preview` rules are a browser-preview hook only (open the
file locally and add the class to `<html>` to see dark mode). Real clients ignore it;
it's harmless to ship, but you can delete those lines before uploading if you prefer.

## Logo

There is no logo image — the header wordmark is real text, which doubles as the
images-off fallback. When a mark ships, swap the header cell for
`<img src="https://windmill.works/email/logo.png" alt="Windmill" width="…" height="…">`.

## Compliance note

The auth mails never carry an unsubscribe link (they're strictly transactional). The
reminder always carries the `Pause reminders` / settings link — keep it when you edit.
