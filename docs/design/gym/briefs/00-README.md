# Windmill Gym — design briefs

The third Windmill product. This folder is the brief set, written 2026-07-29 from a code-verified
inventory of **Lift**, a shipped standalone iOS training log we are mining for craft rather than
migrating.

**Read `01-context.md` first** — the product, the user, the thesis and the constraints. Then the
briefs in order. `G1` and `G2` are the ones that block engineering; everything after is sequenced
behind them.

| brief | what it asks for | blocks |
|---|---|---|
| `02-G1-set-logger.md` | The logging surface — the whole product in one screen | phase 1 (`set-logger`) |
| `03-G2-palette.md` | Gym's scoped palette + the product's visual identity | everything |
| `04-G3-the-log.md` | Session list, session detail, and the fix-it path | phase 1–2 |
| `05-G4-routine-and-plan.md` | Routines, the plan snapshot, plan-vs-actual | phase 2 |
| `06-G5-pr-moment.md` | e1RM, PR detection, the finish screen | phase 2 |
| `07-G6-connected-log.md` | The MCP wedge — the paid surface, and the diff a stranger's agent proposes | phase 2 |
| `08-G7-strength-tree.md` | Gym × roadmap: the brand bet | phase 3 |
| `09-G8-web-as-mirror.md` | The web's live-session mirror + the backfill door | phase 1–2 (`gym-live-mirror`, `gym-backfill`) |

## Status — read this before picking one up

The briefs are no longer all unbuilt, and two of them are being designed *against something already
on screen* rather than into a blank.

- **`G1` — built, and now being demoted.** The web set logger shipped (keypad, ladder, sticky
  carry-forward, offline queue). The two-surface split of 2026-08-02 moved the open session to the
  phone, so this surface's future is native; `G8` covers what stands where it stood on web.
- **`G2` — delivered and in use.** `gym-tokens.css` is live.
- **`G3` — NOT fulfilled, and now partly stale.** The session list, the session detail and paging to
  the bottom of the log were built without a design because the log was unreadable without them.
  The brief is still open and still wanted; taking it means redesigning what is there. One piece in
  particular was invented by engineering and has never been designed: the four states at the foot of
  the log (*load older* / *loading* / *nothing older* / *that read failed*).
- **`G8` — new, nothing built.** It post-dates every other brief and changes what `G1` and `G3`
  assumed about who logs a set.
- **`G4`–`G7`** — unbuilt and unblocked by any of the above.

## Where the canon lives

The Windmill Design System is the root of this merged project, one level up (`../`) — tokens,
type, motion, the component library. Gym borrows all of it. Journal's product canon (the
sibling `../journal/` folder) is the closest worked example of a *second* product's identity: it owns a scoped
palette, not the global theme.

## The one rule that shapes every brief

Windmill is one account, one subscription, three products in one superapp. The shell already owns
the account seat, sign-in, settings, billing, sessions and devices, export and delete. **No gym
brief may redesign any of those.** Gym designs its own surfaces and registers a settings section;
everything else it inherits.
