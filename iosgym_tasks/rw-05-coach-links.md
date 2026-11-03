# Links in Coach answers

**Status:** Designed (🚧, awaiting owner approval); not built.

**Figma:** Gym iOS 08.66 a link in an answer: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16341) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16382); 08.67 context menu offers Copy link: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16423) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-16515).

**Context:** mirrors Android 08.66–08.67 as approved 2026-11-03 (primary-colour link, Copy link only for a single link).

**Current implementation:** `apps/ios/App/Sources/Gym/Coach/CoachMessages.swift` renders inline Markdown through `AttributedString(markdown:options: .inlineOnlyPreservingWhitespace)` (`:360`) inside `CoachMarkdown` (`:328`); the answer's `.contextMenu` offers Copy answer only (`:87`). No link styling, no in-app browser.

**Change**
- http(s) links draw in `gym/accent` with an underline; other schemes and relative links stay plain text. A tap opens `SFSafariViewController` over Coach.
- The answer's context menu adds Copy link (the URL alone) when the answer holds exactly one link. Copy answer writes each link as "text (url)".
- VoiceOver: the link is a link in the rotor; the bubble's actions are Copy answer and, for one link, Copy link.

**Done when:** 08.66–08.67 match in Dark and Daylight; opening and copying a link emit bounded events (Android sends `coach/open_link` and `coach/copy_link`) with no URL or host.

**Depends on:** nothing. Tree: `ios-rw-05-coach-links`, under `ios-review-wave-parity`.
