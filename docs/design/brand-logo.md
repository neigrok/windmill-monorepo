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
| `apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml` | Native vector foreground preserving the compact mark's seven paths, colours, and circular hub. |
| `apps/android/app/src/main/res/values/colors.xml` | Android launcher background, `ic_launcher_background = #F9F5EB`. |

`web/src/design-system/Brand.jsx` owns the web renderers: `BrandMark` for a decorative mark,
`BrandWordmark` for the mark with readable brand text, and `BrandLogo` for the complete stacked
lockup. Give each image explicit width and height and preserve its aspect ratio. The full export
includes Figma's original whitespace; size the visible artwork deliberately.

Keep the original colours in the supplied artwork for light and dark surfaces. The charcoal in
the Figma screenshot is the page canvas, not a logo background. Do not redraw, recolour, or animate
the sails independently.
The logo has no approved monochrome or alternative wordmark variant. Text-only brand treatments
remain appropriate in email, where the header must stay readable with images blocked.

## Asset derivation

The mark and lockup share one Figma source, and web consumers share one rendering module. Keep
raster icons derived from the compact SVG to avoid geometry drifting between sizes. The outlined
lockup needs no font download; navigation reuses the existing display font.

Android keeps the exported paths in one vector group; scale and position are set once without
editing individual path coordinates or maintaining separate raster sizes.

## Android launcher icon

The adaptive icon uses a 108 × 108dp vector foreground over a full-bleed cream background. Its
uniform scale is `0.142`, with translation `(23.044, 10.974)`, keeping the complete windmill and
hill inside the centred 66dp safe circle. Android recommends separate foreground and background
layers and reserves the outer area for launcher masks and effects.
[Adaptive icon guidance](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive),
[safe-circle specification](https://developer.android.com/codelabs/basic-android-kotlin-compose-training-change-app-icon).

The app supplies no monochrome layer because no monochrome artwork is approved. User-selected
launcher theming can still recolour the icon: Android 16 QPR 2 can generate themed icons for apps
without a supplied monochrome layer.
[Android theming behavior](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive).

## iOS follow-up

Apply the approved mark to the native iOS app icon. Review its mask, small sizes, and supported
appearance variants from this source. This is separate from the web install icons; iOS asset
generation and simulator/device review remain open.

Dogfood follow-up: `windmill-native-logo` in tree `t_9362d9bc883e0a1e`.
