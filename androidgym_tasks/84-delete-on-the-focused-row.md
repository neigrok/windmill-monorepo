# Every swipe row offers Delete on the node TalkBack focuses

**Status:** Not started. Accessibility conformance; nothing drawn changes.

**Context:** TalkBack offers a custom action only on the node it focuses. `DeleteSwipeRow` declares Delete on the swipe box around the row. Where the row's content is its own focus stop (clickable, or a field), a TalkBack user cannot reach Delete at all. The workout page's set rows were fixed in 5e922f92; the other callers were not.

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `ui/RowSwipe.kt:89-93` declares Delete on the swipe box unless the caller passes `declaresAction = false`.
- Already right:
  - set rows (`ui/SessionScreen.kt:484`, with Delete on the focused row at `:519`);
  - the log's workout rows (`ui/LogScreen.kt:214`, with *Discard workout* on the focused row at `:337-338`).
- Delete unreachable from the focused node:
  - the log's weigh-in rows (`ui/LogScreen.kt:222`; the row is clickable at `:301`);
  - Coach History (`coach/ThreadsScreen.kt:135`);
  - Notes (`ui/NotesScreen.kt:233`, whose row declares only Move up/down);
  - the editor's movement rows (`ui/RoutineBuilder.kt:521`);
  - target set rows (`ui/MovementForm.kt:200`, whose content is text fields);
  - This workout rows (`ui/AssemblySheet.kt:146`).
- Reachable only another way: Bodyweight (`ui/BodyweightScreen.kt:355`, through the correction sheet's Delete) and Routines (`ui/RoutinesScreen.kt:166`, through the overflow's Delete).
- The callers' tests look for Delete on an ancestor, so they pass while TalkBack cannot reach it.

**Change**
- Each caller whose row is its own focus stop passes `declaresAction = false` and declares the swipe's own action on the focused node, with the swipe's existing label (for example *Delete conversation* in `ThreadsScreen`) and the same outcome. Actions that ask first (conversation delete) still ask.
- Target set rows have one focus stop per field. Give the row a merged node that carries Delete, without taking the fields' own focus.
- Change `DeleteSwipeRow`'s default so a new caller cannot repeat the mistake: the row content declares the action unless the caller opts out.

**Done when**
- Each caller has a semantics test that finds the action on the node TalkBack focuses (`onNode(hasClickAction() and hasCustomAction(…))`, not an ancestor), in Dark and Daylight.
- On the TalkBack emulator, each row's Delete is offered in the actions menu and works. Record the result in the README's spoken-pass paragraph.

**Depends on:** 05, 64. Tree: `android-talkback-delete-on-swipe-rows`.
