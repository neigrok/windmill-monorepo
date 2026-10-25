# First open: Coach greets in two bubbles; an empty Gym opens on Coach

**Figma:**
- 01.1 signed out: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1252-4776) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39315)
- 01.2 signed in: [Dark](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1253-28196) / [Daylight](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1254-39335)
- Components (Design System library, Android page):
  - `Android / Chat bubble` `337:2761`: Coach, First and Last
  - `Android / Button` `210:181`: Tonal, for *Add screenshot* and *Build my own*
  - `Android / Top app bar` `342:2953`

**Today** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- The room always opens on Routines: `var tab … mutableStateOf(Tab.Routines)` (`GymRoom.kt:292`).
- Signed out, Coach is the stance *Coach reads your log, so it needs you signed in.* + **Sign in** (`coach/AskScreen.kt:267-278`, `coach/Ask.kt:216`).
- Signed in, an empty thread shows nothing above the composer. `Ask.openers` (*What’s stalled?*, *Which lifts are moving?*, *Is my week too light?*, `coach/Ask.kt:220`) and `Ask.subtitle` (*reads your log · helps with your routines*, :171) are defined and never drawn.

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
- An empty Gym opens on Coach.
  - "Empty" means no routines and no workouts, read once when the room opens.
  - Otherwise the room opens on Routines as today. A saved tab still wins after recreation.
- Delete `Ask.openers`, `Ask.subtitle` and `AskSignedOutStance`. 36 owns the fallback when signed-out Coach is off.

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
