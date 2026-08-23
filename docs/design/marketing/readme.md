# Windmill Common — marketing & transactional surfaces

*The written canon for the brand-level surfaces. Brand-wide foundations are in
`../guidelines/` and `../brand-foundations.md`; drift ledger: `../consistency.md`.*

The brand-level surfaces that sit *around* the products rather than inside one: the
windmill.works site, the legal shelf, the commercial story, and every piece of mail the
platform sends.

**The design system is inherited, not copied.** Tokens, themes, and the product-neutral
component kit are shipped code (`web/src/styles/tokens/`, `web/src/design-system/`) and were mirrored here
read-only as `styles.css`, `tokens/`, `themes/` and `_ds_kit.js` in this folder (they were
missing, so every page's token references resolved to nothing — mirrored in on 29 Jul 2026).
Never fork a token into this mirror — change it at the source, then re-mirror
(last full re-mirror 2026-07-31, current; future drift gets ledgered in `../consistency.md`).

**The mirrored kit must be the trimmed one.** `_ds_kit.js` must contain only the DS bundle's
`components/*` (core · forms · feedback · navigation · tree) plus
`ui_kits/marketing/tree-scenes.js` and `tweaks-panel.jsx`. The design system's own
`_ds_bundle.js` must never be loaded by a shippable page: it also concatenates every
`explorations/*.js` specimen, and each of those is a self-executing IIFE that writes its own
demo document into `document.body` — loading it injected ~126 stray specimen sections into
every page under `ui_kits/marketing/` (32,714px of scroll height and horizontal overflow on
the landing) until it was replaced on 29 Jul 2026. Re-mirror by re-running that filter
against the source bundle; the same reasoning is in `_ds_kit.js`'s header comment.

## What lives here

- `ui_kits/marketing/` — the windmill.works site. **`index.dc.html` is the common landing
  for all three products** (roadmap · journal · gym): a three-panel hero where each product
  shows a small live vignette in its own brand scope, a shared-week "one account, one
  history" card, the one-door/MCP/cross-device trio, and one CTA. It says no price (pricing
  is not publishable yet) and states each product's real status — public beta · coming soon ·
  in design. Tweakable: headline, hero focus, hero motion, colour strategy.
  `roadmap.html` is the former landing, now the roadmap product page: its hero embeds the
  live playable-demo tree (arrival cascade, then a calm self-playing unlock loop —
  `tree-scenes.js`), plus a 3-beat "how it works", the starter-quest shelf, and a
  share/MCP/cross-device trio. Responsive at 744/1024. Wordmark-only lockup. Siblings:
  `pricing.html`, `refunds.html`, `privacy.html`, `terms.html`, `changelog.html` (calm
  one-column shells wired from the footer) and `pause.html` (the reminder's tokened pause
  page).
- `guidelines/pricing.md` — the commercial story: pay for tending, not the product; one Pro
  plan. It governs `pricing.html`. The tending mechanics it prices are specified in the
  Roadmap project (`guidelines/tending.md`); this doc must not restate them, only price them.
- `guidelines/email.md` — the X7 transactional-email spec: the shared shell, the magic-link
  flagship, client realities (tables + inline CSS, fallback stacks, email dark mode),
  plain-text pairs, from-lines, and the unsubscribe rule (reminders only, never auth).
- `ui_kits/email/` — the templates, each with a `.txt` plain-text pair: `magic-link.html`
  (flagship sign-in), `magic-link-signup.html`, `magic-link-fork.html` (the fork-carrying
  link — says what the click does), `reminder.html`.
- `explorations/` — the email specimen pages (`transactional-email.html`, `email-family.html`).

## Why the whole mail family is here

Two of these templates are triggered by the roadmap (`reminder`, `magic-link-fork`) and two
by platform auth. They stay together anyway: they are one designed family sharing one shell,
one voice, and one set of client constraints, and splitting them by trigger would fracture
the thing that makes them consistent. The *shell specimen card* stays in the design system
(`guidelines/email.card.html`) because the shell is a brand-level constraint on any
product's mail; the family and its spec live here.

## What is deliberately *not* here

- **Foundations and the brand identity brief** — `../brand-foundations.md` and `../brand-identity-brief.html`.
- **Anything whose subject is the tree** — Roadmap project. The landing page embeds the demo
  tree, but the tree's own canon (layout contract, node states, share cards) lives there.
