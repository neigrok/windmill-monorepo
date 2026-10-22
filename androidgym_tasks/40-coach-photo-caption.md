# The photo in the composer and its caption

**Figma:**
- 01.3 Screenshot, the Android photo picker: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-38808) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39781)
- 01.4 signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30368) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39355)
- 01.5 signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-30626) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39385)
- Components (Design System library, Android page):
  - `Android / Chat bubble` `337:2761`
  - `Android / Keyboard` `337:2403`: Base, on 01.4

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `coach/CoachComposer.kt`, signed in only:
  - the photo button opens `PickVisualMedia(ImageOnly)` (:74, :102)
  - the chosen photo is a 72 dp `CoachPhoto` beside a text button *Remove photo* in `inkDim` (:84-93)
  - *Preparing photo…* (:95)
  - a `LinearProgressIndicator` *Photo upload* (:97)
  - the error *Choose a supported photo.* (:79)
- No line says where the photo goes, signed in or out.
- The send key is a grey *↑* that is always drawn, and *■* while asking (:128).

**Change**
- 01.3, the way in: **Add screenshot** on the greeting (39) and the composer's photo button both launch the system photo picker (`PickVisualMedia(ImageOnly)`). No custom picker.
  - The picker is system UI: the access card *Windmill will only have access to the photos you select* with *Dismiss*, the *Photos* tab, a 3-column grid.
  - Tapping a photo selects it (*1* · *Preview* · **Done**). **Done** returns it to the composer (01.4). Back returns with nothing attached.
- The chosen photo sits in the composer above the field:
  - a 72 dp thumbnail, radius 12
  - a tonal extra-small close icon button with the label *Remove photo*
- **Send** (filled, accent) appears once there is a photo or text.
- One line above the composer: 12 sp, secondary, centred.
  - Signed out (01.4): *Sent to Coach. Saved only on this phone.*
  - Signed in (01.5): *Saved only in this chat.*
  - The line shows only while a photo is attached.
- Board text in the field: *My program, 3 days a week*. The greeting stays above (no message sent yet).
- On 01.4 the system keyboard is up and replaces the navigation bar. The composer rides above the IME (`imePadding`).
- Signed out, the photo is sent inline to the onboarding route. Signed in, it is uploaded as today. The photo limits are set in 38.

**Out of scope:** the composer pill and Send / Stop (28), the picker's own drawing (system UI), transport (38).

**Done when**
- Screenshots of 01.3, 01.4 and 01.5 match in Dark and Daylight. The rig (01) adds `01.3-photo-picker-dark` / `-light` (a fixture photo on the emulator), `01.4-photo-composer-signed-out-dark` / `-light` and `01.5-photo-composer-signed-in-dark` / `-light`.
- `gym_setup_step` adds the actions `photo_selected` and `photo_removed`. List them in `docs/ANDROID_OBSERVABILITY.md`.
- An upload failure still reports at the transport boundary (`gym.ask`). A signed-out encode failure reports under `gym.coachOnboarding`.
- No image bytes, size or file name in events.
- Tests: `coach/CoachComposerTests.kt` (caption per account state, Send only with content) and `coach/CoachPhotosTests.kt` (the signed-out 1 MiB fit).

**Depends on:** 28, 38, 39.

**Ledger:** 11h, 10v; dogfood `android-gym-target-page`.
