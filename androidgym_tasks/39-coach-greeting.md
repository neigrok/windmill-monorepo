# First open: Coach greets in two bubbles; an empty Gym opens on Coach

**Status:** On draft pull request [#41](https://github.com/neigrok/windmill-monorepo/pull/41), not on main. Its boards are ✅ Ready for dev. 01.1 and 01.2 match natively in Dark, Daylight and 200 % text, and the coach-setup recipe captures all of them; `gym_setup_step` `shown`, `screenshot` and `build_manually` arrive at the local intake. Open: `shown` repeats on every configuration change.

**Figma:**
- 01.1 signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-4776) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39315)
- 01.2 signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28196) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39335)
- Components (Design System library, Android page):
  - `Android / Chat bubble` `337:2761`: Coach, First and Last
  - `Android / Button` `210:181`: Tonal, for *Add screenshot* and *Build my own*
  - `Android / Top app bar` `342:2953`

**Implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)

`CoachSetup.kt` draws the two local greeting bubbles and tonal actions. `LocalChat.setup` retains
setup ownership without creating a model turn; accepted exchanges hide the greeting. The composer
and greeting use one native photo picker. `TrainingStore.initialGymEmpty` remains unread until its
owned routine and log reads succeed, with a first pull required for an account. The room resolves
its initial tab once and preserves saved or explicit navigation. `CoachAccessStance` retains task
36's approved fallback when anonymous access is unavailable. The obsolete opener list and subtitle
are removed. Focused tests pass; native visual and installed event acceptance remain pending.

**Change**
- Two Coach bubbles, written by the app (not a model turn):
  1. *Hi, I’m Coach. I can help you with:*
  2. One line per capability, with the anchor word in bold.
- Signed out (01.1):
  - **Build** — a program from a screenshot or your own words.
  - **Goals** — tell me your goals, and I will plan for them.
  - **Account** — sign in, and I can also save notes and suggest changes to your routines.
- Signed in (01.2):
  - **Build** — a program from a screenshot or your own words.
  - **Goals** — tell me your goals, and I will plan for them.
  - **Notes** — I save important facts, like an old injury.
  - **Changes** — ask me, and I suggest changes to your routines.
- Under the last bubble, two tonal buttons:
  - **Add screenshot** (image icon) opens the system photo picker: `PickVisualMedia(ImageOnly)`, the same launcher as the composer.
  - **Build my own** (add icon) opens the new-routine editor.
- The greeting belongs to the first-open/setup states on this page. A deliberate fresh Coach entry in an established Gym uses the approved empty-composer state in 28/37; it does not replay a previous conversation or insert the setup greeting. In the setup chat, the greeting stays until the first message is accepted, then it goes for good in that thread.
  - No goal flow, no *Just log*, no allowance indicator.
- The account seat sits in the bar: *•* signed out, the email initial signed in (03).
- An empty Gym opens on Coach when Coach can answer: signed in, or signed out with anonymous access available. Signed out with that access unavailable, it opens on Routines, since login is never forced.
  - "Empty" means no routines and no workouts, read once when the room opens.
  - Otherwise the room opens on Routines as today. A saved tab still wins after recreation.
- `Ask.openers` and `Ask.subtitle` are absent. Task 36 owns the `CoachAccessStance` fallback when signed-out Coach is off.

**Out of scope:** bubbles and composer (28), the photo caption (40), drafts (41), signed-out transport (38).

**Done when**
- Screenshots of 01.1 and 01.2 match in Dark and Daylight. The rig (01) adds `01.1-coach-greeting-signed-out-dark` / `-light` and `01.2-coach-greeting-signed-in-dark` / `-light`.
- New content-free event `gym_setup_step` (the iOS name), props `screen=coach` and `action`:
  - `shown`, once per greeting shown
  - `screenshot`
  - `build_manually`
- List it in `docs/ANDROID_OBSERVABILITY.md`.
- `gym_screen_viewed` `coach` still fires.
- Tests:
  - `GymTabsTests.kt`: an empty Gym opens on Coach; a Gym with routines opens on Routines.
  - `coach/AskScreenTests.kt`: the greeting shows signed in and signed out, and goes after the first message.
  - `ui/StanceReadsTheAccountTests.kt` and `coach/AskTests.kt`: they pin the deleted stance and strings.

**Depends on:** 28, 38.

**Ledger:** 11h, 12l, 6p, 10v; dogfood `android-gym-target-page`.
