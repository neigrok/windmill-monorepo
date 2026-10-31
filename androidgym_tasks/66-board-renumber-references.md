# Repo references follow the renumbered Android boards

**Status:** 🚀 On main (`70ec2dbe`). Docs and recipes only; the renumber itself is done in Figma (ledger 11r).

**Context:** on 2026-10-31 the designer renumbered the Android page (`56:2`) so that no number names two different screens across the phone pages. Only the Android numbers moved:

| Old | New | | Old | New |
|---|---|---|---|---|
| 02.14 | 02.22 | | 06.5 | 06.11 |
| 02.15 | 02.23 | | 07.4 | 07.11 |
| 02.18 | 02.24 | | 07.5 | 07.12 |
| 02.19 | 02.25 | | 08.6 | 08.58 |
| 03.16–03.23 | 03.37–03.44 | | 08.6b | 08.58b |
| 06.3 | 06.9 | | 08.33 | 08.59 |
| 06.4 | 06.10 | | 08.34 | 08.60 |
| | | | 08.35 / 08.36 | 08.61 / 08.62 |

**Change**
- **Capture recipes:**
  - `coach-history.json` (08.34, 08.33)
  - `bodyweight.json` (06.3)
  - `on-this-phone.json` (07.4, 07.5)
  - any recipe the 2026-10-31 acceptance added that still uses an old number
- **Task files** (never edit `done-` files): `18` (02.19), `19` (02.14), `24` (06.3), `25` (07.4, 07.5), `28` (08.33), `36` (08.6, 08.6b), `37` (08.34), `38` (08.6b), and `README.md`.
- **Engineering docs:** `docs/engineering/android-implementation.md` (02.19) and `docs/engineering/android-task-readiness.md` (08.6, 08.6b, 08.35).
- **Rig validator:** make the board-id pattern accept a letter suffix (`08.58b`). It rejects it today.
- **Keep the iOS numbers:** `docs/engineering/ios-gym-ui-flows.md` and `docs/design/ios/` use iOS numbers. Do not change them.

**Done when**
- `grep` for each old Android number over `apps/android`, `androidgym_tasks` and `docs/engineering` finds only iOS references.
- The rig's own tests pass.

**Depends on:** none.
