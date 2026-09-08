# Phone viewport layout

The web shell fills the dynamic viewport with `100dvh`, with `100vh` as its fallback. The header consumes the actual top safe-area inset. The room owns content scrolling and passes `--content-safe-area-top: 0px` to its products.

Roadmap's list header, mobile chrome, and top overlays consume that inherited inset. Standalone roadmap surfaces retain their `max(env(safe-area-inset-top, 0px), 44px)` fallback. New product chrome should consume the shell-provided inset rather than reserve the viewport's top safe area again.

Validation: all 1,664 web tests and the web build pass. Chromium layout checks cover 375×664, 375×812, 360×640, 812×375, and 1440×900 viewports. Home and Journal scrolling reach their content ends. Physical iPhone Safari, including its moving browser chrome, remains unverified.
