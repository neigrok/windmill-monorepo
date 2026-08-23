# Marketing & transactional surfaces

The written canon for the brand-level surfaces — the ones that sit *around* the products
rather than inside one: the windmill.works site, the legal shelf, the commercial story, and
every piece of mail the platform sends.

Brand-wide foundations: `../brand-foundations.md` and `../guidelines/`. Drift ledger:
`../consistency.md`.

## What lives here

| Path | What it governs |
|---|---|
| `briefs-landings/` | The landing family — three product landings plus the brand root, one skeleton and nine fixed roles |
| `guidelines/pricing.md` | The commercial story: pay for the AI's work, not the product; one plan. Governs `web/public/pricing.html` |
| `guidelines/email.md` | The transactional-email design spec: the shared shell, the magic-link flagship, client realities, plain-text pairs, from-lines, the unsubscribe rule |

## Where the surfaces themselves live

| Surface | Code |
|---|---|
| Product landings | `web/src/products/<product>/marketing/` |
| Brand-root landing | `web/src/shell/marketing/` |
| Static pages — pricing, refunds, privacy, terms, changelog, pause, 404 | `web/public/` |
| Email templates + their `.txt` twins | `web/emails/` (its `README.md` owns the wire contract) |

**The design system is inherited, not copied.** Tokens, themes and the product-neutral
component kit live in code (`web/src/styles/tokens/`, `web/src/design-system/`). Never
fork a token — change it at the source.

## Why the whole mail family is here

Two templates are triggered by the roadmap (`reminder`, `magic-link-fork`) and two by platform
auth. They stay together: one designed family sharing one shell, one voice, and one set of
client constraints. Splitting them by trigger would fracture what makes them consistent.

## Not here

- **Foundations and the brand identity brief** — `../brand-foundations.md`,
  `../brand-identity-brief.html`.
- **Anything whose subject is the tree** — `../roadmap/`. A landing may embed a demo tree, but
  the tree's own canon (layout contract, node states, share cards) lives there.
- **Tending mechanics** — `../roadmap/guidelines/tending.md`. `pricing.md` prices tending; it
  does not specify it.
