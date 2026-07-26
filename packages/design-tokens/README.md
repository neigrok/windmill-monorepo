# design-tokens

Raw, framework-neutral scales — color hues, spacing, type — that both the web CSS and the
native apps mirror, so a brand color is defined in exactly one place. `web/design-system`
consumes these as CSS variables; the native apps mirror them per platform.

Status: **scaffold** — the web design system currently owns its tokens under
`web/styles/tokens`. Lift the product-neutral scales here when the native apps need them.
