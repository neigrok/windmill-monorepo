# Colour roles: the M3 error role in red and the Daylight accent in verdigris

**Figma:**
- 00.2 Colour roles and type ramp (one sheet, both modes): [Dark and Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-43776)
- Daylight twins that differ from the app only by the accent (their Dark twins already match):
  - 02.3 Routine editor, new: [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44602)
  - 02.4 Movement picker: [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-44782)
  - 05.5 Share this workout: [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31081)
  - 05.13 Share, the link is live: [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-31139)

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- Roles live in `ui/GymSkin.kt`: `Instrument` (:53-61) and `Daylight` (:62-70).
- The Daylight accent is iris: `accent = Color(0xFF4C4374)`, `accentHover` #3A3358, `accentPressed` #2F2A46, `accentSoft` #EDEBF3 (:65, :68).
  - The onboarding pager and glimpses already paint verdigris #137A6C in Daylight (`ui/onboarding/OnboardingPager.kt:63`, `ui/onboarding/OnboardingGlimpses.kt:173`).
- The M3 error role is brick: `error = skin.alarmInk, onError = skin.onAlarm` (`ui/GymMaterial.kt:50`), with `alarmInk` #D08268 / #A84E35 (`ui/GymSkin.kt:60`, :69) and `onAlarm` white (:49).
- The Daylight record ink is `prInk = Color(0xFFA17822)` (:68). The board's `state/pr-ink` Daylight is #6E5217.
- `warmupInk` (:47) exists only for set types.

**Change**
- Add the M3 error role and use it for every destructive control:
  - `android/system/error` = `colorScheme.error`: #E46962 Dark, #B3261E Daylight.
  - `on-error` = `colorScheme.onError`: #410E0B Dark, #FFFFFF Daylight.
  - Map `error` / `onError` in `ui/GymMaterial.kt` to these values, not to `alarmInk`.
  - Keep `alarmInk` only for refusal text (the review door, refusal headings, field errors). It never paints a button, menu item or swipe ground again.
- Daylight accent is verdigris #137A6C. Set `accent`, `accentHover`, `accentPressed` and `accentSoft` from the board's Daylight values, and make the onboarding pager and glimpses read `skin.accent` instead of their own literal.
- Daylight `prInk` is #6E5217, and `prSoft` follows it.
- Remove `warmupInk` once 06 lands.
- Every hex on 00.2 matches the skin in both modes. The type ramp on 00.2 is the reference for 03 and later: root title 24 Bold, sheet title 28 ExtraBold, section 17 Bold, row 16 Bold / 13, target mono 13, label 13 Bold, button 16 Bold, note line mono 12, weight numeral 104 ExtraBold.

**Out of scope:** painting each destructive control (05, 10, 14, 22, 23, 24, 25, 26, 37); the top bar (03).

**Done when**
- A colour test asserts each role's hex in both modes, including `error`, `onError`, the verdigris accent and the Daylight record ink.
- Screenshots of the four Daylight twins above match their boards on the emulator; the rig (01) adds `02.3-routine-editor-new-light`, `02.4-movement-picker-light`, `05.5-share-light`, `05.13-share-live-light`.
- No new events: colour only.
- `ui/GymMaterialTests.kt` (including `personalRecordGoldNeverBecomesANativeControlColor`) and `ui/SignInDoorSkinTests.kt` pass with the new values.

**Depends on:** 01.

**Ledger:** 11c, 9a, F4; dogfood `android-gym-target-page`.
