# Colour roles: the M3 error role in red and the Daylight accent in verdigris

**Figma:**
- 00.2 Colour roles and type ramp (one sheet, both modes): [Dark and Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-43776)
- Native colour acceptance references (layout migrations remain with their owning tasks):
  - 02.3 Routine editor, new: [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44602)
  - 02.4 Movement picker: [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44782)
  - 05.5 Share this workout: [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31081)
  - 05.13 Share, the link is live: [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31139)

**Implementation status**
- `ui/GymSkin.kt` owns both palettes, including dedicated `error` / `onError` roles. `ui/GymMaterial.kt` maps native error slots to them; brick `alarmInk` remains a separate refusal-text role.
- Daylight uses verdigris `accent`, its bound translucent `accentSoft`, and gold-700 record text. The record wash follows the existing Figma `state/pr-soft` binding.
- The onboarding pager and gym glimpse read their accent and contrast color from the gym palette. No unused hover, pressed, warmup or on-alarm role remains.
- The routine movement picker uses the approved `surface` role in both modes; the live share sheet’s Revoke action uses `accent`.
- The approved 00.2 role board supplies the palette. All 35 focused palette, account-theme, onboarding, planning-restoration and sharing tests pass with zero skips; four capture-tool tests pass. The four native recipes pass colour acceptance in both modes; the final picker pair is captured from the final APK, with unchanged-screen provenance recorded alongside it.

**Color contract**

| Role | Dark | Daylight |
|---|---|---|
| canvas | #0B1111 | #EBE7E3 |
| surface | #161C1D | #F8F6F4 |
| raised | #202627 | #DFDAD5 |
| line | #202627 | #D0CAC5 |
| lineStrong | #2A3133 | #B6AFA9 |
| accent | #5FCDB4 | #137A6C |
| accentSoft | #5FCDB4 at 20% | #137A6C at 12% |
| onAccent | #1B1408 | #FFFFFF |
| ink | #F1F0EB | #1A1918 |
| inkDim | #B6B5AF | #4C4744 |
| inkFaint | #727771 | #625C58 |
| setDone | #9AA859 | #7D8C43 |
| prInk | #D9B04C | #6E5217 |
| prSoft | #D9B04C at 15% | #A17822 at 14% |
| error | #E46962 | #B3261E |
| onError | #410E0B | #FFFFFF |

The role sheet supplies the visible palette; `state/pr-soft` supplies the record wash. Native M3 state layers supply pressed feedback in 04; the app carries no unused hover or pressed accent role. `alarmInk` is #D08268 Dark / #A84E35 Daylight for refusal text. Individual destructive controls migrate to the native error roles in their owning tasks.

The type ramp on 00.2 is the reference for 03 and later: root title 24 Bold, sheet title 28 ExtraBold, section 17 Bold, row 16 Bold / 13, target mono 13, label 13 Bold, button 16 Bold, note line mono 12, weight numeral 104 ExtraBold. This task changes only color roles.

**Out of scope:** painting each destructive control (05, 10, 14, 22, 23, 24, 25, 26, 37); the top bar (03). Name-field anatomy and movement-picker height remain with 18 and are recorded in consistency ledger 11q. Native colour acceptance does not claim full-screen geometry parity.

**Done when**
- A colour test asserts each role's hex in both modes, including `error`, `onError`, the verdigris accent and the Daylight record ink.
- Screenshots of the four Daylight twins above match their approved colour roles on the emulator; the rig (01) adds `02.3-routine-editor-new-light`, `02.4-movement-picker-light`, `05.5-share-light`, `05.13-share-live-light`.
- No new events: colour only.
- `ui/GymMaterialTests.kt` (including `personalRecordGoldNeverBecomesANativeControlColor`) and `ui/SignInDoorSkinTests.kt` pass with the new values.

**Depends on:** 01.

**Ledger:** 11c, 9a, F4; dogfood `android-gym-target-page`.
