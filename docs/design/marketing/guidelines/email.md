# Windmill Transactional email (X7)

The canonical spec for every email the system sends. One shared shell; the
**magic-link auth email is the flagship** — it exists so the link is the one
obvious thing to tap. Copy contracts come from `auth.md` (X6 §3: works once,
15 minutes, one door); the reminder's content comes from the quest-log
frontier (product log #11/#12). Live templates: `ui_kits/email/` ·
specimens: `explorations/transactional-email.html`.

> **Principle: an email is a hosted surface with one verb.** Same as X5's
> share page — brand chrome stays quiet, the button is the page. If a second
> action wants in, it goes in the footer or it doesn't go.

---

## 1. The shell — every template, no exceptions

| Piece | Spec |
|---|---|
| **Canvas** | `#F9F5EB` full-bleed (the product canvas, never white or gray) |
| **Header** | wordmark "Windmill", text-set in the display stack, terracotta `#BC6C42`, centered. No logo file exists (readme policy) — text *is* the images-off fallback; when a real mark ships, swap in a hosted `<img>` with `alt="Windmill"`. |
| **Card** | white `#FFFFFF`, 1px `#E5D9C0`, radius 24, max-width **520px**, centered. Outlook squares the corners — acceptable. |
| **The one button** | table-based pill, `bgcolor #BC6C42`, white 16px extra-bold label, 15/38 padding. One per email, ever. |
| **Raw URL** | always present under a divider, mono stack, on its own line, `word-break:break-all` — the button's honest fallback. |
| **Footer** | outside the card, 12.5px `#92805F`: why-you-got-this line · brand line. Manage links only on non-transactional mail (§4). |

## 2. Client realities — decided

- **Layout is tables + inline CSS.** `role="presentation"`, no flex/grid, no
  external stylesheet. The `<style>` block carries only: resets, one mobile
  padding query, and dark mode.
- **Fonts never load in email.** The stacks are the contract:
  display `'Baloo 2','Trebuchet MS','Segoe UI',sans-serif` · body
  `'Nunito','Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif` · mono
  `'JetBrains Mono','SFMono-Regular',Consolas,'Courier New',monospace`.
  No webfont `@import` — Trebuchet's rounded humanism is the chosen degrade.
- **Light-only**: email ships light, always — the app's dark theme does not
  extend to mail. `color-scheme` + `supported-color-schemes` metas declare
  `light` so clients don't repaint the shell; there is no
  `prefers-color-scheme: dark` block. Gmail's auto-invert can't be opted out
  of and is tolerated — warm hues survive inversion legibly.
- **Preheader**: hidden `<div>` with `&zwnj;&nbsp;` padding; written per
  template (§5), never left to the client to harvest.
- **Width**: 520px card, fluid below; single column always. Mobile query
  drops card padding to 30/24.

## 3. Plain text — every template ships a pair

`.txt` alongside every `.html` (`magic-link.txt` etc.), sent as
`text/plain` alternative. Rules: wordmark line, title + dash underline, body
in ≤60-char lines, **the link alone on its own line** (tappable everywhere),
the trust line, `--` footer. No ASCII art, no bullets except the reminder's
step list.

## 4. The set + trust

| Template | From | Unsubscribe? |
|---|---|---|
| Magic link — sign-in (flagship) | `Windmill <sign-in@windmill.works>` | **Never.** Auth mail is the product's front door; the trust line ("nothing changes until the link is used") does the job. |
| Magic link — first-time | `Windmill <sign-in@windmill.works>` | Never. Same shell; only wording differs (§5) — the one door means no separate "verify email" ceremony. |
| Magic link — **fork variant** (`magic-link-fork.html`) | `Windmill <sign-in@windmill.works>` | Never (auth mail). Same shell + two additions: a tree strip (kind dot · title · author · N steps) and the disclosure — body **and** button say the click signs you in *and* plants the copy. The pending fork waits server-side (X5 §7). Spec: `explorations/email-family.html`. |
| Verify-email / future auth | `Windmill <sign-in@windmill.works>` | Never. Slots into the flagship layout: heading + one button + raw URL. |
| Weekly reminder (#12) | `Windmill <reminders@windmill.works>` | **Always**: "Pause reminders · Manage in settings" in the footer, one tap, no survey. Both destinations exist: the tokened pause page (`ui_kits/marketing/pause.html` — opens already-paused, no login, idempotent) and the settings **Reminders** block (switch · day · time · device timezone · quiet hours — amends X6 §5 to five sections). Spec: `explorations/email-family.html`. |

- **From-line is legible, never phishy:** display name is exactly
  "Windmill"; addresses are verbs on the product domain (`sign-in@`,
  `reminders@`) — never `no-reply@`, never a third-party domain. Reply-to:
  `hello@windmill.works`.
- **Sign-in vs sign-up is wording, not plumbing** — the server knows if the
  address is new; the one door stays (X6 §1).
- Trust copy canon inherited from X6 §6: state specifics, never perform
  security. The auth emails' entire trust apparatus is three quiet lines:
  the expiry, the didn't-request line, the why-you-got-this footer.

## 5. Copy — every string

| Where | Sign-in | First-time |
|---|---|---|
| Subject | "Your sign-in link" | "Welcome to Windmill — your sign-in link" |
| Preheader | "Works once and lasts 15 minutes — tap and you're in." | "One tap creates your account. No password — works once, lasts 15 minutes." |
| Heading | "Tap to sign in" | "Welcome — this way in" |
| Body | "This link signs you in to Windmill on this device. No password — the link is the key." | "You're new here, so this link creates your account and signs you in. Same door every visit after — no password, ever." |
| Button | "Sign in to Windmill" | "Create my account" |
| Expiry | "It works once and lasts 15 minutes." (X6 verbatim) | same |
| URL label | "Button not working? Paste this into your browser:" | same |
| Trust | "Didn't ask for this? You can ignore it — nothing changes until the link is used." | "Didn't sign up? You can ignore this — no account is created until the link is used." |
| Footer | "Sent because this address was entered at windmill.works." | same |

**Reminder:** subject "3 steps are ready · {tree}" · preheader "Your frontier
is waiting — finish one and the next branch unlocks." · heading "Your
frontier is waiting" · frontier block = tree name + mono "9/24 done" + up to
3 kind-dotted ready steps · button "Open your tree" · footer "You get this
once a week, only while a tree has steps ready."

**Fork variant:** subject `Your sign-in link — and your copy of "{tree}"` ·
preheader "One tap signs you in and plants a copy of {tree} in your trees." ·
heading "Plant your copy of {tree}" · button "Sign in & plant the copy" ·
mut adds "The copy waits for you — nothing is planted until you tap." ·
trust line "Didn't ask to fork this tree? …".

## 6. Constants — copy into the build

```
SHELL     canvas #F9F5EB · card #FFF/#E5D9C0 r24 · max-w 520 · one button #BC6C42
LIGHT     light-only: color-scheme metas declare `light` · no dark block
FONTS     never load: Baloo→Trebuchet MS · Nunito→Segoe UI/Helvetica · mono→Consolas
LINK      works once · 15 min (X6) · raw URL always, own line, mono, break-all
FROM      Windmill <sign-in@ | reminders@ windmill.works> · reply-to hello@ · no no-reply
UNSUB     reminders only ("Pause reminders · Manage in settings") · never on auth
PLAIN     .txt pair per template · link alone on its own line
```

## 7. Ownership map

| Concern | Owner |
|---|---|
| Link lifecycle, one door, expiry copy | `auth.md` (X6) |
| Reminder cadence + frontier content | quest log / reminders (product log #11–12) |
| Palette hexes | `tokens/colors.css` |
| Shell, client rules, the set, from-lines, plain text | **this doc** |
