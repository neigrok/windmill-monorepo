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

## Structure observation

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

Dogfood implementation: `windmill-android-logo` in tree `t_9362d9bc883e0a1e`.

## iOS follow-up

Apply the approved mark to the native iOS app icon. Review its mask, small sizes, and supported
appearance variants from this source. This is separate from the web install icons; iOS asset
generation and simulator/device review remain open.

Dogfood follow-up: `windmill-native-logo` in tree `t_9362d9bc883e0a1e`.

## Verification

The web build passes 1,772 tests with no failures or skips and generates all three landing shells.
Local browser checks cover light and dark landing headers, the sign-in dialog, static pricing,
and all four app room selections at 320px with no horizontal overflow or overlapping header targets.
The backend builds and the isolated preview reaches its local session endpoint with the expected
credentialed CORS response.

The Android asset review confirms all seven SVG path strings and fills match the native vector.
Every Bézier control point falls within a 32.301dp radius, conservatively inside the 33dp safe
radius; the circular hub fits inside it too. Vector-rendered circle, rounded-square, squircle,
and safe-circle previews preserve the full artwork.

The Android `./gradlew build` and lint pass. Debug and Release each report 1,032 cases: 1,020 passed
and 12 skipped live-wire tests, gated on `WM_ANDROID_WIRE_TEST` and `WM_WIRE_BEARER`. Packaged
resource inspection confirms the new vector transform and colours. Backend integration and
physical-device launcher behavior are outside these checks.

On an Android API 28 emulator, the final APK loads through `PackageManager.loadIcon` as an
`AdaptiveIconDrawable` with a vector foreground and the exact `#FFF9F5EB` background. Its native
Canvas render contains all seven logo colours and preserves the hill, tower, and blades under
the system circle mask.

## Android release status

Android 0.7.1 contains the verified icon and is a prerelease for fresh installs. Its APK uses a
different debug signing certificate from 0.7.0, so it cannot update an existing 0.7.0 installation
in place. Signing repair is tracked by `android-release-signing` in dogfood tree
`t_9362d9bc883e0a1e`.
