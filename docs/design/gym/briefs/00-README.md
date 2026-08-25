# Windmill Gym — design briefs

Read `01-context.md` first.

| Brief | Holds |
|---|---|
| `01-context.md` | Who the lifter is, the thesis, the vocabulary, the feeling. Start here. |
| `08-G7-strength-tree.md` | Gym × roadmap, as a concept. **Open** — it may still come back as "not yet". |
| `09-coach.md` | The Coach room and the four beats of the propose–review–apply loop. |
| `10-notes.md` | Notes — the context a lifter writes *for* Coach, and who else can read it. |
| `11-bodyweight.md` | Bodyweight — the reading, the writing, and the chart that refuses to interpret. |
| `12-native-idiom.md` | How web, iOS and Android are allowed to differ, and the six things that must land first. |
| `13-gestures.md` | What the platform already knows how to do — and the one row where a swipe-to-delete is safe today. |
| `14-live-activity.md` | The lock screen — a second window onto the same queue, and the one act worth doing from it. |
| `15-the-routine.md` | Building, changing and starting a routine — the heaviest screen, and five of the ten cuts. |
| `16-the-workout.md` | The live logger, the finish, the session read back — and why the keypad stays at the rack. |

## Scope

Windmill is one account and three products in one superapp. The shell owns the account seat,
sign-in, settings, billing, sessions and devices, export and delete. No gym brief redesigns those;
gym designs its own surfaces and registers a settings section.

Brand-wide canon sits beside this folder — `../../guidelines/`, `../../brand-foundations.md`. The
tokens, type and component library are `web/src/styles/tokens/` and `web/src/design-system/`. Gym
borrows all of it.

## Open, and belonging to no brief

- **The zero crossing has no detent.** Weight is signed: a chin-up logs at 0 kg, a band-assisted
  pull-up at −20. The step row is identical at 0, at +0.5 and at −0.5, so tapping − from bodyweight
  converts a bodyweight rep into a band-assisted one — a different physical setup — with no
  confirmation. A step that would cross zero should land on zero. Underneath it: the loaded side's
  step sizes come from plate granularity, and band assistance has no plate physics, so the assisted
  side's steps may want to be something else entirely.
