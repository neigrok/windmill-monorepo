# Routine drafts decided on their card: Apply or Reject

**Status:** Superseded by the phone Coach. A routine a turn creates lands at once with its card (01.8, 01.16). Only a retained onboarding answer still holds drafts, and they keep their Save (`coach/CoachAnswer.kt`, `CoachChats.saveRetainedDrafts`); 01.7, 01.14 and 01.15 stand for those answers alone (ledger 11h).

**Figma:**
- 01.7 three drafts, signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-8716) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39439)
- 01.14 one routine: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-8887) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39487)
- 01.15 drafts rejected: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-9021) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39521)
- Components (Design System library, Android page):
  - `Android / Change row` `337:2686`: Added
  - `Android / Diff field` `337:2531`: New
  - `Android / Button` `210:181`: Filled *Apply* and Tonal *Reject*, 56 dp, stacked
  - `Android / Chat bubble` `337:2761`

**Ledger:** 11h, 10v; dogfood `android-gym-target-page`.
