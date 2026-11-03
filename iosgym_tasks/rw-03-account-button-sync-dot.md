# The account button's sync dot

**Status:** Designed (🚧, awaiting owner approval); not built.

**Figma:** Gym iOS 00.11: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-15844) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1875-15923).

**Context:** while the lifter can act (sign in, update, a refusal) the root screens' account button points to You. Mirrors Android 00.11.

**Current implementation:** `apps/ios/App/Sources/WindmillApp.swift` `RoomAccountButton` (`:322`) is a glass circle with `person.crop.circle`, used on the log (`Gym/Log/LogTab.swift:74`) and Coach (`Gym/Coach/CoachTab.swift:68`) toolbars; it carries no state.

**Change**
- An 8 pt `gym/accent` dot at the button's top trailing edge while the rw-02 status is *Sign in to sync*, *Update to sync* or a refusal. Waiting alone draws none. One colour, never red. Not drawn in the workout.
- VoiceOver keeps "Account" and gains the value of the rw-02 status line.

**Done when:** the dot appears and clears with the status in Dark and Daylight on every root screen that shows the button; VoiceOver reads "Account, Sign in to sync".

**Depends on:** rw-02. Tree: `ios-rw-03-account-button-dot`, under `ios-review-wave-parity`.
