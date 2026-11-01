# Coach answers during a workout on Android

**Status:** Waits for its boards: design brief item QW9. Server and domain work can be prepared; the screens cannot.

**Figma:** none yet for Android. iOS draws it in `docs/design/ios/workout-in-flight.md` and its Figma section; the Android boards come from QW9 ([design brief](design-brief-quality-wave.md)).

**Context:** iOS answers Coach mid-workout, edits the running workout's plan (logged movements stay as logged) and applies workout proposals. On Android and web, Coach refuses while a workout is open, so the moment a lifter most wants advice is the one moment Coach will not answer.

**Current implementation**
- Android posts to the Ask route (`apps/android/gym/…/net/GymHttp.kt:51,66`).
- The server refuses mid-workout with 409 `ask-session-open` (`backend/products/gym/application/AskService.cpp:669`, `AskApi.cpp:68-71`). Android renders the refusal (`AskOutcomeTests.kt:73`), and web maps it to a mid-session note (`web/src/products/gym/coach/coach.js:133`).
- The shared domain passes the workout-proposal vectors on Kotlin, Swift and web (CorpusTests has nothing pending).

**Change**
- Server: Ask answers mid-workout and may propose workout changes, as the phone Coach does for iOS. Keep `ask-session-open` for any client that has not adopted it, if the owner wants a compatibility window.
- Android, once QW9 is ready: Coach is reachable from the logger, shows workout proposals as drawn, and Apply edits the running plan through the domain's workout-proposal actions. Each step emits its event.
- Web follows in its own task once its board exists.

**Done when**
- The QW9 boards match in Dark and Daylight.
- On the local stack: start a workout, ask Coach to swap a movement, Apply. The rack shows the new movement, and the logged sets stay.
- `docs/ANDROID_OBSERVABILITY.md` lists the new events.

**Depends on:** 28, design brief QW9. Tree: `coach-mid-workout-android-web`.
