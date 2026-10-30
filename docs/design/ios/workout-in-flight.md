# The workout in flight — iOS Gym

Status: ✅ Ready for dev — owner approved 2026-10-30. Built: the rest target (03.20–03.22), the typed
load and the reps wheel (03.23–03.25), Coach during a workout with its routine proposals applied for
next time (08.54, 08.56's routine card), and the rest target outside the app on the expanded Island
and the compact Lock Screen card (04.6, 04.7). Not built yet: the editable plan (03.26–03.32,
08.55–08.57's workout cards). Boards are on
the Gym file's iOS page: 03.20–03.32 in [03 · Workout](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1114-1513)
with the wave's READ ME (`1717:15737`), 04.6 and 04.7 in [04 · Outside the app](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1115-1576)
and 08.54–08.57 in [08 · Coach](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1117-1703).
Every board is drawn Dark and Daylight. Build tasks: `iosgym_tasks/60`–`69`.

## The fixture

Every board draws one workout, *Upper A* on Thursday 22 October, started 18:02.

| Movement | Equipment | Plan (frozen from the routine) | Rest |
|---|---|---|---|
| Back Squat | barbell, kg total | 4 × 5 · 100 | 3:00 |
| Dumbbell Bench Press | dumbbells, kg each | 3 × 8 · 16 | 2:00 |
| Pull-up | bodyweight, kg added | 3 × 8 · 10 | 2:00 |
| Seated Cable Row | cable, kg | 3 × 10 · 50 | none |

The rest preference is unset, its default. At 18:34:10 Back Squat has four sets and Dumbbell Bench
Press two (16 × 8, the last at 18:32:33): workout clock 32:10, since last set 1:37, target 2:00. At
18:34:47 the since clock reads 2:14 (03.21). In flight the lifter sets Pull-up's set 1 to 12.5 × 8
(03.30) and adds Face Pull (cable, 2 × 15 · 15). The workout finishes at 18:58: 56 minutes, 15 sets
(4 + 3 + 3 + 3 + 2), volume 2,000 + 768 + 260 + 1,500 + 450 = 4,978 kg (bodyweight counts only the
added load). Boards that need another state say so in their caption: 03.28 (a fourth bench set),
03.31 (swapping Pull-up), the Coach scene at 18:34 before any edit (08.54–08.57) and the Live Activity
between squat sets (04.6, 04.7).

## The live workout

- **Toolbar.** Leading: one glass group (`ToolbarItemGroup`) holding *This workout*
  (`list.bullet.clipboard`, 03.4) and *Coach* (`bubble.left.and.bubble.right`, 08.54). Trailing:
  *Finish*.
- **Movement header.** The equipment symbol, the name and a `chevron.down`; the whole header is a
  native `Menu` (03.26, 03.27).
- **Facts row.** The workout clock leads. Top right: the since-last-set clock, then the rest target
  as `/ 2:00`, static. The target is the plan entry's `restSeconds`, else the rest preference, else
  nothing; with no target the since clock stands alone (03.22). It shows once the workout has a set.
  iOS has no rest-preference control: a movement's target is set in Edit sets or the routine editor.
- **Reaching the target** (03.21). The since numeral and its timer glyph take `gym/accent`, and one
  light impact plays — once per rest, foreground only, never while a sheet is up, and not when the
  confirmation-haptic preference is off. No sound, banner, countdown or progress ring. VoiceOver reads
  the value as *2 minutes 14 seconds, target 2 minutes* and announces nothing.
- **Ledger.** Logged rows open Fix set (03.25). A movement with nothing logged opens Edit sets from
  its current or planned rows. A logged movement's planned rows are not buttons.
- **Past the plan** (03.28). Once the plan's sets are logged the ledger offers the next set as an
  open row and Log set logs it. A logged movement grows this way; no control is added.

## Load and reps

- **Load is typed** on the system `.decimalPad`. On the rack, tapping the numeral turns it into a field
  in place with its text selected, so the first key replaces it; the ladder, reps and Log set step
  aside for the keyboard and the ledger stays readable (03.23). ✓ in the keyboard row or a tap outside
  keeps a valid value; an empty or unreadable value restores the previous one. The unit follows the
  load basis (*kg each*, *kg total*, *kg added*, *kg*).
- **The sign.** The decimal pad has no minus, so bodyweight and Other add a `±` key to the keyboard
  toolbar; it flips assistance and added load (03.30). Other bases never show it.
- **Reps stay on a wheel**: one native column, 1–99. From the rack, tapping the reps value opens a
  compact sheet with Cancel and ✓ (03.24); − and + stay on the rack. In Fix set and Edit sets the
  wheel sits under the load field (03.25, 03.30).
- **Why the system pad.** It brings the locale's decimal separator, dictation, haptics and
  accessibility; a custom keypad would rebuild them. The `±` key covers its one gap.
- **Refusals.** In Edit sets a target of zero, or one that rounds to zero, refuses in `gym/alarm` under
  the field; loads stay within −500…500 kg.

## Editing this workout's plan

**A movement with a logged set keeps its plan** (owner ruling, 2026-10-30): no retargeting, no adding
or removing planned sets, no swap, no rest change, no removal. Logging more sets and Fix set still
work. Plan edits touch movements with nothing logged, and add movements.

- **Movement menu, nothing logged** (03.26): *Edit sets*, *Swap movement*, then *Add movement* and
  *Edit movement* (name and equipment, account-wide). **Logged** (03.27): *Add movement* and *Edit
  movement* only. The locked state is quiet — no lock glyph and no message.
- **Edit sets** (03.29). A `.large` sheet titled *Edit sets*, subtitled *{movement} · this workout*.
  The sets list: each row opens in place with the load field and reps wheel (03.30), swipes to delete,
  and *Add set* copies the last target. *Rest* is a `Picker(.menu)`: 15 s to 15 min, or Default (the
  preference). Then *Swap movement* and *Remove from workout* (destructive). ✓ writes the movement's
  whole entry into this workout's plan in one save; Cancel restores it. If a set lands on the movement
  while the sheet is open, the sheet closes and says the plan did not change.
- **Swap movement** (03.31). The movement picker titled *Swap {movement}*. The new movement takes the
  old one's place and planned sets; loads carry over only when the load basis matches, else they open.
- **Add movement** stays in This workout and joins the movement menu. The added movement enters this
  workout's plan with no targets; its open row leads to Edit sets.
- Every edit changes this workout only. The routine changes only through the receipt's switch or an
  applied routine proposal.

## The finish receipt

When this workout's plan changed (03.32), the receipt carries one card under the facts: *PLAN
CHANGES · {n} changes*, every edit against the routine — the lifter's and applied Coach workout
proposals alike — in the proposal card's change rows, and one row
*Save to {routine}* with a native switch, off by default. Done saves it through the routine save;
otherwise nothing is written. The receipt keeps one primary. If the routine changed since the workout
started, the switch gives way to *{routine} changed since you started.* When the phone cannot tell
which routine revision the workout started from, the card lists the changes with neither the switch
nor that sentence. The offer appears once, on
this receipt; swiping the receipt away saves nothing.

## Coach during a workout

- **The door.** *Coach* in the toolbar group opens Coach as a sheet over the workout cover, `.medium`
  and `.large` (08.54). Deliberate entry is a fresh chat; History is one tap. Close returns to the
  rack exactly as it was. The open workout is part of what Coach reads.
- **Two kinds of change**, both proposals the lifter applies on the card:
  - *CHANGES TO THIS WORKOUT*, with the running dot (08.55). Apply rewrites this workout's plan. It may
    change movements with nothing logged and add movements, never a logged movement.
  - *CHANGES TO {ROUTINE} · NEXT TIME* while a workout is open (08.56). It applies mid-workout: Apply
    changes the routine and never the running workout.
- One answer may carry one of each; they are decided apart (08.56). Applied: *Applied · this
  workout* / *Applied · {routine}*.
- **Out of date** (08.57). Nothing is applied and one sentence names why: *You logged {movement} since
  this suggestion.* · *This workout changed after this suggestion.* · *A newer suggestion replaced this
  one.* · *This workout has finished.*

## Outside the app

The expanded Dynamic Island (04.6) shows the rest target under the clock, static, from the plan. The
Lock Screen card carries it the same way in its compact form, 04.7 (✅ Ready for dev, task 69): 141 pt
tall, *Set 3 of 4* on its own line and a 150 × 52 pt Log set. Neither counts the target down, fills a
bar or changes colour on its own. Neither the card nor the island says what is unsent (owner ruling
2026-10-30); unsent sets are said in the room only, and 04.4 draws the remaining states. The island
stays black in both appearances; compact and minimal are unchanged (04.3).

## Events

Product events through `/v1/events`, allowlisted labels only:
`gym_workout_plan_changed {action: retarget | add_set | remove_set | swap | add_movement | remove_movement | rest, outcome: ok | refused | failed, door: workout | proposal}`,
`gym_rest_target_reached` (no duration), `gym_receipt_plan_saved {outcome}`, and
`gym_proposal_outcome` with `target: workout | routine`.
