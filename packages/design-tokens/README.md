# design-tokens

**Empty on purpose — this package is this README and nothing else.** No tokens live here and
nothing consumes it.

The intent: raw, framework-neutral scales — color hues, spacing, type — that both the web CSS
and the native apps mirror, so a brand color is defined in exactly one place.

Today web owns its own scales as CSS variables under `web/src/styles/tokens/` (`colors.css`,
`spacing.css`, `typography.css`, `radius.css`, `shadows.css`, `motion.css`, `palettes.css`,
`fonts.css`), iOS restates them in
`apps/ios/WindmillKit/Sources/WindmillPlatform/Tokens.swift`, and Android restates them again in
`apps/android/platform/src/main/kotlin/works/windmill/platform/design/Tokens.kt`. That is three
hand-mirrored copies free to disagree, which is the reason this slot exists. The lift-trigger this
README used to name — "when a third surface makes it worth the move" — **fired with the Android
wave**, and the lift is deliberately deferred to the next surface-wide design pass rather than done
as a side effect of standing Android up. Until then, edit the three real files.
