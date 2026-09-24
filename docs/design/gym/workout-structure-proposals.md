# Android workout structure proposals

Status: design exploration, 24 September 2026. The owner chose B+ · Quiet ledger
([Figma 805:4536](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=805-4536)); the
Android workout is built from it, without the after-log Undo its specimen draws. The alternatives
below remain proposals. The scope is the live Android workout screen.

The [Proposals board](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=787-4134)
is separate from the canonical screens on the same Figma page. The four primary specimens are
412 × 915. Their shared fixture is Bench Press, three planned sets at 60 kg × 8; only set 1 is
recorded, set 2 is next, and set 3 remains planned. Overhead Press, three sets at 30 kg × 8, and
Cable Fly, three sets at 15 kg × 12, have not started. Matching target and actual values in this
fixture do not imply that entry is constrained to the target.

The exploration removes the Last time block and arranges set records vertically. The horizontal
workout pager changes exercises; vertical set records leave it the only horizontal scroll, without
changing weight entry.

## Alternatives

| Proposal | Structure | Benefit | Cost |
| --- | --- | --- | --- |
| [A · Vertical cards](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=790-4134) | Movement identity and clocks, vertical set cards, fixed rack | Familiar hierarchy with the smallest structural change | Repeated cards use more height as a workout grows |
| [B · Set ledger](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=790-4204) | Compact movement identity and clocks, aligned vertical set rows, fixed rack | Actual, current and future sets are easy to compare; less repeated chrome | The current target and recorded values need distinct treatment |
| [C · Active-set focus](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=790-4285) | Current-set context and fixed rack; All sets opens a vertical sheet | Low visual load while entering sets | Inspecting and correcting older sets takes another tap |
| [D · Workout outline](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=790-4350) | Vertical exercise outline; a focused logging sheet holds the active rack | Session order and movement switching are explicit | Logging crosses a sheet boundary and requires clear active-exercise identity |

B is the recommended starting point. It directly addresses the conflicting gestures and preserves
visible set history, planned targets and the one-handed rack. A is the conservative comparison; C
and D test whether reducing main-screen context helps enough to justify another navigation step.

The supporting specimens show [B after logging](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=794-4301),
[B correcting set 1](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=794-4394),
[C All sets](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=794-4462), and
[D focused logging](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=794-4532).
The after-log state has two recorded sets, set 3 current, a zero since-set clock and a transient Undo
above the unchanged rack; the built Android screen draws no Undo after a log — a logged set is
corrected or deleted from its row. Correction edits actual set 1 while retaining the routine's targets.

## Constraints

- Remove the visible Last time block. History-based prefill remains an underlying capability; no
  proposal removes history. No replacement statistics block occupies the freed space.
- The rack keeps independent weight and reps, the existing four weight adjustments, numeral taps
  for the rack keypad, and one pinned Log set action. Planned values are references, not limits;
  different actual values, extra sets and free sessions remain valid.
- Completed rows show actual values. Current and future rows show targets. A completed check means
  recorded; offline state remains explicit rather than treating the check as server acknowledgement.
- Recorded rows open correction. Planned rows do not silently dial a target or log a set. No row
  swipe-to-complete or swipe-to-delete competes with exercise navigation.
- No Kind selector appears. New Android sets use Working and corrections preserve stored kind,
  following [Set kind · product direction](../consistency.md#set-kind--product-direction). Legacy
  warmups remain distinguishable and do not consume planned working-set numbers.
- Workout elapsed and since-set elapsed count up. Since-set uses the latest valid session-wide
  set, not the selected exercise. They are not a rest countdown. Existing optional rest alerts keep
  their own behavior; see [Gym feedback](feedback-contract.md#workout-clocks).
- One owner scrolls each vertical reading surface; do not nest a vertical set scroller in another
  vertical scroller. A–C retain horizontal exercise paging. D changes exercises through its outline.
- Interactive rows and controls have at least 48 dp touch areas without overlapping hit bounds.
  Frequently used rack controls retain their larger targets. Large text can grow the reading area;
  the primary action stays reachable.
- Logging may reveal the next current row while the reader follows the live position, but does not
  pull someone away from older records. Native insertion/selection feedback keeps the rack still;
  reduced motion resolves directly. Timer ticks are not live accessibility announcements.

## Structure and performance observations

One set-row model should express recorded, current-target and future-target states. Shared rack,
clock and row primitives keep the proposals comparable and prevent state-specific copies from
drifting. A future implementation should keep one gesture owner for exercise navigation and one
vertical scroll owner per surface. Long histories should use a lazy vertical list, preserving stable
set identities and reading position as a set is accepted or corrected. These are design and
implementation observations, not measured performance claims.

## Comparison tasks

Compare one-handed logging with changed weight/reps, finding the next target after legacy warmups,
correcting an early set in a long list, switching exercises during a superset, and logging a free
session. Measure accidental exercise changes, wrong-set edits, time to identify the next target,
and extra navigation taps. Include a narrow viewport, 200% text, TalkBack and reduced motion in
native evaluation.

## Validation

Figma screenshots were reviewed for all four primary specimens and the four supporting states.
The primary screens show the intended fixture, correct recorded/current/planned states, readable
labels and no visible text clipping or overlap. A–C retain the same fixed rack and primary-action
position. The after-log specimen keeps that rack stable with Undo above it. The final correction
and focused-logging sheets show complete Android gesture insets, visible rack button surfaces and
unobstructed actions.

Structural read-back confirms eight 412 × 915 screens, no Last time block, correct state labels,
the existing Nunito / Baloo 2 / JetBrains Mono Figma font roles, and 15–30 linked component
instances per screen. Native Android uses its own font roles. These checks establish the static
dark-screen composition only. They do not establish native gesture arbitration, TalkBack behavior,
font scaling, keyboard handling, reduced motion, offline persistence, timer behavior or performance.
The comparison tasks and the narrow/large-text/native accessibility matrix remain evaluation work.
No application code is implemented or tested by this exploration.

## Sources

- [Android accessibility defaults](https://developer.android.com/develop/ui/compose/accessibility/api-defaults):
  48 dp minimum touch targets, suitable native semantics and non-overlapping interaction bounds.
- [Compose semantics](https://developer.android.com/develop/ui/compose/accessibility/semantics):
  meaningful actions and state descriptions; restrained live-region use for changing content.
- [Android layout patterns](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns):
  a prominent primary action that remains visible and secondary actions near related content.
- [Workout interaction contract](interaction-polish.md#workout-exercise-swipes) and
  [Thumb reach](../guidelines/thumb-reach.md): current gesture ownership and fixed rack placement.
