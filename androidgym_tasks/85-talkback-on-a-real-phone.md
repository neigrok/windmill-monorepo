# A TalkBack pass on a real phone, and each thing said once

**Status:** Not started. Needs a physical Android phone with TalkBack: the owner's, or a tester's. Accessibility conformance; nothing drawn changes.

**Context:** the spoken pass of 2026-11-01 ran on the API 37 emulator. The speech was verified from logcat, not heard, and gestures came from emulated touches. It also found three places that are still said twice. A real phone is the only proof of gestures, audio, focus order and timing.

**Current implementation**
- `apps/android/README.md`, CI and releases, records the emulator pass: what was heard, how, and what is still said twice:
  - a rack set row (its description, then its drawn set and target);
  - the editor's movement row (the drag handle's *Move Bench Press, 1 of 1*, then the name);
  - Finish's facts, which read each value apart from its label.

**Change**
- **Said once:**
  - The rack set row merges into one node with one description.
  - The editor's movement row reads its name once; the reorder moves stay as custom actions on that node.
  - Each Finish fact reads value and label as one phrase (*Volume, 2,140 kg*).
  No drawn change in any of them.
- **The pass:** on a physical phone with TalkBack's current release, walk the main journeys by touch exploration and by swipe navigation, and listen:
  - first open;
  - start a workout from a routine;
  - log sets with the rack and the keyboard;
  - Fix set and Delete set;
  - Finish and Share;
  - the log and a workout page;
  - the record page;
  - a weigh-in with Undo;
  - the routine editor (add, reorder, discard);
  - Coach (ask, History, delete a conversation);
  - sign in;
  - sign out;
  - delete account.
  Note anything said twice, unlabelled, out of order, or unreachable.
- File each finding as a fix inside this task when it changes no drawing. A finding that needs a drawing goes to the designer as a new brief item.

**Done when**
- The three said-twice places say each thing once, with semantics tests.
- The README's spoken-pass paragraph names the phone, the Android and TalkBack versions, the journeys and what was heard, in place of the emulator-only wording.

**Depends on:** 64, 84. Tree: `android-talkback-physical-pass`.
