# Windmill logo

The approved source is [Windmill, node 9:129](https://www.figma.com/design/v21I1eIsWkyIaN7byJ8GdV/Windmill?node-id=9-129).
It combines a four-colour windmill, cream house, olive hill, and a terracotta Baloo 2 Bold
wordmark. Child node `9:108` is the standalone mark.

## Assets and use

| Asset | Role |
|---|---|
| `web/public/brand-logo.svg` | Stacked lockup, exported with the wordmark outlined; native bounds 512 × 620. |
| `web/public/brand-mark.svg` | Compact mark; exported path geometry and colours with the viewBox tightened around the artwork. |
| `web/public/favicon.svg`, `favicon-32.png`, `favicon.ico` | Browser identity derived from the mark. |
| `web/public/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | Web install icons derived from the mark on a cream ground. |

`web/src/design-system/Brand.jsx` owns the web renderers: `BrandMark` for a decorative mark,
`BrandWordmark` for the mark with readable brand text, and `BrandLogo` for the complete stacked
lockup. Give each image explicit width and height and preserve its aspect ratio. The full export
includes Figma's original whitespace; size the visible artwork deliberately.

Keep the original colours on light and dark surfaces. The charcoal in the Figma screenshot is the
page canvas, not a logo background. Do not redraw, recolour, or animate the sails independently.
The logo has no approved monochrome or alternative wordmark variant. Text-only brand treatments
remain appropriate in email, where the header must stay readable with images blocked.

## Structure observation

The mark and lockup share one Figma source, and web consumers share one rendering module. Keep
raster icons derived from the compact SVG to avoid geometry drifting between sizes. The outlined
lockup needs no font download; navigation reuses the existing display font.

## Native follow-up

Apply the approved mark to the iOS app icon and Android adaptive launcher icon. Review the native
mask and safe area at small sizes, and design the supported appearance variants from this source.
This is separate from the web install icons; native asset generation and simulator/device review
remain open.

Dogfood follow-up: `windmill-native-logo` in tree `t_9362d9bc883e0a1e`.

## Verification

The web build passes 1,772 tests with no failures or skips and generates all three landing shells.
Local browser checks cover light and dark landing headers, the sign-in dialog, static pricing,
and all four app room selections at 320px with no horizontal overflow or overlapping header targets.
The backend builds and the isolated preview reaches its local session endpoint with the expected
credentialed CORS response. Native icons remain outside this verification.
