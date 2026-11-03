# Share beside Copy link

**Status:** Designed (🚧, awaiting owner approval); not built.

**Figma:** Gym iOS 05.23 the link is live: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16484) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16517); 05.24 the iOS share sheet: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16550) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16594); 05.25 link copied: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16638) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1876-16669).

**Context:** mirrors Android 05.23–05.25 (owner-approved 2026-11-03).

**Current implementation:** `apps/ios/App/Sources/Gym/Log/SessionShareSheet.swift`: the live state's one action reads *Copy link* / *Copied* (`:37`); no share sheet.

**Change**
- Live link: *Copy link* (.bordered capsule, leading) and *Share* (prominent verdigris, trailing), equal width; *Revoke the link* stays a plain button below.
- Share is a `ShareLink` whose item is the link alone: no routine name, no summary.
- After copying, the capsule shows a checkmark and no word; VoiceOver keeps "Copy link" with the value "Link copied", announced once.

**Done when:** 05.23–05.25 match in Dark and Daylight; `gym_action` with `screen: session_share` records the sheet opening and the copy (Android sends `session/share_link` and `session/copy_link`); nothing about the target is sent.

**Depends on:** nothing. Tree: `ios-rw-06-share-beside-copy`, under `ios-review-wave-parity`.
