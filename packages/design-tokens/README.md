# design-tokens

**Empty on purpose — this package is this README and nothing else.** No tokens live here and
nothing consumes it.

The intent: raw, framework-neutral scales — color hues, spacing, type — that both the web CSS
and the native apps mirror, so a brand color is defined in exactly one place.

Today web owns its own scales as CSS variables under `web/src/styles/tokens/` (`colors.css`,
`spacing.css`, `typography.css`, `radius.css`, `shadows.css`, `motion.css`, `palettes.css`,
`fonts.css`), and iOS restates them in
`apps/ios/WindmillKit/Sources/WindmillPlatform/Tokens.swift`. That is two copies free to
disagree, which is the reason this slot exists. Lift the product-neutral scales here when a
third surface — or a drift — makes it worth the move; until then, edit the two real files.
