# Windmill transactional email (X7)

The design spec for every email the system sends. One shared shell; the **magic-link auth
email is the flagship** — it exists so the link is the one obvious thing to tap. Link
lifecycle and expiry copy come from `../../roadmap/guidelines/auth.md` (X6 §3).

Live templates: `web/emails/`. That folder's `README.md` owns the wire contract — Resend
template ids, every variable, the plain-text twins and the unsubscribe headers. This doc does
not restate it.

> **Principle: an email is a hosted surface with one verb.** Brand chrome stays quiet, the
> button is the page. If a second action wants in, it goes in the footer or it doesn't go.

---

## 1. The shell — every template, no exceptions

| Piece | Spec |
|---|---|
| **Canvas** | `#F9F5EB` full-bleed (the product canvas, never white or gray) |
| **Header** | wordmark "Windmill", text-set in the display stack, terracotta `#BC6C42`, centered. No logo file exists — text *is* the images-off fallback. |
| **Card** | white `#FFFFFF`, 1px `#E5D9C0`, radius 24, max-width **520px**, centered. Outlook squares the corners — acceptable. |
| **The one button** | table-based pill, `bgcolor #BC6C42`, white 16px extra-bold label, 15/38 padding. One per email, ever. |
| **Raw URL** | always present under a divider, mono stack, on its own line, `word-break:break-all` — the button's honest fallback. |
| **Footer** | outside the card, 12.5px `#92805F`: why-you-got-this line · brand line. Manage links only on non-transactional mail (§3). |

## 2. Client realities

- **Layout is tables + inline CSS.** `role="presentation"`, no flex/grid, no external
  stylesheet. The `<style>` block carries only resets, one mobile padding query, and the
  color-scheme declaration. Single column always, 520px card, fluid below; the mobile query
  drops card padding to 30/24.
- **Fonts never load in email.** The stacks are the contract: display
  `'Baloo 2','Trebuchet MS','Segoe UI',sans-serif` · body `'Nunito','Segoe
  UI','Helvetica Neue',Helvetica,Arial,sans-serif` · mono
  `'JetBrains Mono','SFMono-Regular',Consolas,'Courier New',monospace`. No webfont `@import`.
- **Light-only.** `color-scheme` + `supported-color-schemes` metas declare `light`; there is
  no `prefers-color-scheme: dark` block. Gmail's auto-invert is tolerated.
- **Preheader**: hidden `<div>` with `&zwnj;&nbsp;` padding, written per template.
- **Plain text**: a `.txt` twin ships with every `.html`, sent as the `text/plain`
  alternative. Wordmark line, title + dash underline, body in ≤60-char lines, **the link alone
  on its own line**, the trust line, `--` footer. No ASCII art, no bullets except the
  reminder's step list.
- **Variables** are always triple-brace `{{{var}}}` — substitution is raw, no escaping tier.

## 3. The set + trust

| Template | From | Unsubscribe? |
|---|---|---|
| Magic link — sign-in (flagship) | `Windmill <sign-in@windmill.works>` | **Never.** Auth mail is the front door; the trust line ("nothing changes until the link is used") does the job. |
| Magic code — the app door's 6 digits | `Windmill <sign-in@windmill.works>` | Never. Same shell, no button and no link: the code is the whole credential. |
| Magic link — fork variant | `Windmill <sign-in@windmill.works>` | Never. Same shell + a tree strip (kind dot · title · author · N steps) and the disclosure — body **and** button say the click signs you in *and* plants the copy. |
| Weekly reminder | `Windmill <reminders@windmill.works>` | **Always**: "Pause reminders · Manage in settings" in the footer, one tap, no survey. Both destinations exist — `web/public/pause.html` (opens already-paused, no login, idempotent) and the settings **Reminders** block (switch · day · time · device timezone · quiet hours). |

- **From-line is legible, never phishy:** display name is exactly "Windmill"; addresses are
  verbs on the product domain (`sign-in@`, `reminders@`) — never `no-reply@`, never a
  third-party domain. Reply-to: `hello@windmill.works`. The `From:` lines in template headers
  are design intent; the sender writes one configured address on every message.
- **Sign-in vs sign-up is wording, not plumbing** — the one door stays (X6 §1).
- Trust copy: state specifics, never perform security. The auth mails' entire trust apparatus
  is three quiet lines — the expiry, the didn't-request line, the why-you-got-this footer.

## 4. Copy

**Magic link — sign-in**

| Where | String |
|---|---|
| Subject | "Your sign-in link" |
| Heading | "Tap to sign in" |
| Body | "This link signs you in to Windmill on this device. No password — the link is the key." |
| Button | "Sign in to Windmill" |
| Expiry | "It works once and lasts 15 minutes." (X6 verbatim) |
| URL label | "Button not working? Paste this into your browser:" |
| Trust | "Didn't ask for this? You can ignore it — nothing changes until the link is used." |
| Footer | "Sent because this address was entered at windmill.works." |

**Fork variant:** heading "Plant your copy of {tree_title}" · button "Sign in & plant the
copy" · muted line "The copy waits for you — nothing is planted until you tap."

**Reminder:** heading "Your frontier is waiting" · frontier block = tree name + mono "9/24
done" + up to 3 kind-dotted ready steps · button "Open your tree" · footer "You get this once
a week, only while a tree has steps ready."

## 5. Ownership map

| Concern | Owner |
|---|---|
| Link lifecycle, one door, expiry copy | `../../roadmap/guidelines/auth.md` (X6) |
| Template ids, variables, plain-text twins, unsubscribe headers | `web/emails/README.md` |
| Palette hexes | `web/src/styles/tokens/colors.css` |
| Shell, client rules, the set, from-lines, copy | **this doc** |
