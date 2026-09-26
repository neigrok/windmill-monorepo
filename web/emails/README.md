# Transactional emails

Resend templates have `.html` and plain-text `.txt` parts; send both. HTML uses tables, inline CSS
and system-font fallbacks. Backend senders mint credentials and URLs; templates never hardcode them.

## Templates

| Files | Resend id | Subject / trigger |
|---|---|---|
| `magic-link.html`, `.txt` | `magic-link` | Your sign-in link; new and returning addresses. |
| `magic-code.html`, `.txt` | `magic-code` | Your sign-in code; native `door:"app"` requests. |
| `magic-link-fork.html`, `.txt` | `magic-link-fork` | Your sign-in link — and your copy of "{{{tree_title}}}"; signed-out forks. |
| `reminder.html`, `.txt` | `reminder` | {{{ready_phrase}}} ready · {{{tree_name}}}; eligible weekly roadmap reminders. |

`magic-link-signup` is an unused template. `ResendNudgeSender` references `journal-nudge`, but
its template source is not checked in.

`ResendClient` sets the actual sender from `RESEND_FROM`; template-header `From:` lines do not
control delivery. Keep provider-side Reply-to at `hello@windmill.works`. Hidden preheaders at the
top of each HTML file supply preview text; their padding prevents body text spilling into previews.

## Variables

Use triple-brace `{{{var}}}` substitution. It is raw: URL punctuation survives, but user text must
be sanitized by the sender for its context. The reminder test checks the variable inventory and
brace form.

| Template | Variable | Value |
|---|---|---|
| magic-link, magic-link-fork | `{{{magic_link}}}` | `${WINDMILL_APP_URL}/#/auth?token=<secret>`; button and paste fallback. |
| magic-code | `{{{sign_in_code}}}` | Six server-minted decimal digits, once in text content; no link/button. |
| magic-link-fork | `{{{tree_title}}}` | Subject/display title; `emailSafeTitle` strips markup and control bytes. |
| magic-link-fork | `{{{tree_meta}}}` | Finished summary supplied through `SignupFork`; template does no counting. |
**reminder**

| Template | Variable | Value |
|---|---|---|
| reminder | `{{{tree_name}}}` | Tree display name. |
| reminder | `{{{tree_url}}}` | Owner's `https://windmill.works/#/app/<treeId>` URL, not a public share URL. |
| reminder | `{{{done}}}`, `{{{total}}}` | Progress counters. |
| reminder | `{{{ready_phrase}}}` | Finished count, e.g. `1 step` or `3 steps`, for subject and body. |
| reminder | `{{{more_on_tree}}}` | Finished remainder sentence, or empty. |
| reminder | `{{{more_ready}}}` | Finished sentence counting other **trees**, or empty. |
| reminder | `{{{settings_url}}}` | `https://windmill.works/#/settings`; preserve the hash. |
| reminder | `{{{pause_url}}}` | `https://windmill.works/pause.html#t=<secret>`; pauses only on button press. |
| reminder | `{{{step_1_label}}}`, `{{{step_1_color}}}` | First ready step and its hex hue. |
| reminder | `{{{step_2_label}}}`, `{{{step_2_color}}}` | Second ready step, or both empty. |
| reminder | `{{{step_3_label}}}`, `{{{step_3_color}}}` | Third ready step, or both empty. |

Reminder slots are fixed, at most three; there is no `{{#each}}`. Colour values come only from the
six server-defined node hues because they enter a style attribute. Empty slots have no row padding;
plain-text empty slots must have no trailing whitespace. `{{{more_on_tree}}}` and `{{{more_ready}}}` count
different things and remain separate finished phrases.

Pause tokens stay in the URL fragment, outside ordinary HTTP requests/logs. A mail rewriter that
encodes the whole URL can still see them.

## Dark mode

Templates are light-only: declare light `color-scheme` and `supported-color-schemes` metadata plus
`color-scheme: only light` on root/body. `magic-link-fork.html` lacks that CSS rule; the gap is in
[the design consistency ledger](../../docs/design/consistency.md).

Headers keep the Windmill wordmark as text so blocked images do not hide it. Assets and logo rules
live in [brand logo](../../docs/design/brand-logo.md).

## Unsubscribe

Auth messages are transactional and have no unsubscribe link. Roadmap reminders keep the pause
and settings links and the promise "once a week, only while a tree has steps ready". Eligibility
also requires the activity window and new-account grace in
[Reminders.h](../../backend/products/roadmap/domain/Reminders.h).

`reminderUnsubscribeHeaders` supplies `List-Unsubscribe` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Roadmap reminders use
`POST /v1/reminders/unsubscribe?t=<secret>`; journal nudges use
`POST /v1/journal/nudge/unsubscribe?t=<secret>`. GET does not unsubscribe, protecting against
mail scanners. The headers use the same secret as the body link and are pinned by
`ResendEmailSenderTest.cpp`.
