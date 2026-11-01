# Headings TalkBack can walk

**Status:** Not started. Accessibility conformance; nothing drawn changes.

**Context:** TalkBack's heading navigation jumps between nodes marked as headings. On Android only three places set any. A workout page's movement headings are not among them, so a lifter cannot jump from Bench Press to Rows (ledger 11u).

**Current implementation** (paths under `apps/android/gym/src/main/kotlin/works/windmill/gym/`)
- `semantics { heading() }` appears only in `ui/FixSheet.kt`, `ui/GymScreen.kt` and `ui/onboarding/OnboardingPager.kt`.
- The workout page's movement heading sets none (`ui/SessionScreen.kt:463-477`).

**Change**
- Mark as headings every text that a board draws as a section title. At least:
  - the workout page's movement headings;
  - the record page's sections (*Recent sets*, *Earlier records*);
  - the routine editor's movement names;
  - the receipt's *Performed*;
  - the log's day or week dividers, if the boards draw them as titles;
  - the sheets' titles.
- Check each against its board. A row that is a button stays a button, not a heading.

**Done when**
- Semantics tests assert the headings on the workout page, the record page and the receipt.
- On the TalkBack emulator (or the phone of task 85), heading navigation steps through a workout's movements in order.

**Depends on:** 64. Tree: `android-accessibility-headings`.
