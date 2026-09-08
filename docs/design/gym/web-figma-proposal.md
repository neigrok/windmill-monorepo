# Gym web Figma proposal

Status: proposed design for review, updated 9 September 2026. Product implementation is unchanged.

[Open the proposal page](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=466-132). The page is separate from existing boards and contains desktop (1440px) and narrow web (390px) layouts, reusable components and Daylight routine previews.

## Main screens

| Flow | Desktop | Narrow |
|---|---|---|
| Routines | [Overview](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=475-892) | [Overview](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=475-945) |
| The log | [Progress and history](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=470-8) | [Progress and history](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=470-21) |
| Coach | [Conversation](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=471-522) | [Conversation](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=471-537) |

## Design decisions

- One navigation shell, type hierarchy, token palette and input treatment across the three areas.
- The card is the door to a draft editor. On desktop the editor is a split — movements left, the selected movement's ladder right — so targets have no sheet and no page of their own; narrow keeps the sheet. `Every set` and `Set by set` are two zooms on one scheme and both are always drawn; there is no mode and no shortcut. The commit reads its own scheme (`Set · 3 × 8 · 60`, `Set · 5 sets`), and the six-set case fits its viewport with the commit reachable.
- On desktop the log is a split: the history index left, the progress strip in the detail pane. Narrow puts progress above the history. Record back navigation preserves entry from the log or a workout.
- Saved workout correction has its own set editor. Actual workout entry requires independent weight and reps for every set, with added or removed sets and added or substituted movements. Planned targets are a reference and do not constrain actual values. Past workout shows independent set rows; `Add set` is each movement's last row and a row leaves by the `×` at its trailing edge. A movement whose sets agree collapses to one readout line, so nine sets fit one viewport. Kind is a selected control on the open row. Dense actual-set and per-set target tables use plain editable numbers with a subtle focus underline; short forms retain conventional inputs.
- Coach displays every proposed change inline in the conversation, with `Apply` beneath it and `Turn this down` beneath that — one word for one act, per `briefs/09-coach.md`. A diff row counts entries, not sets, so three set-targets on one line is one change. The same message becomes an applied or dismissed receipt; there is no Review button or review modal. Notes have separate existing-note and blank-note screens.
- Small edits stay inline and longer tasks use dedicated pages, avoiding modal dialogs. Narrow primary actions remain reachable. The phone remains responsible for live training.

## Review and prototype scope

The Figma page has desktop and narrow flow starting points. Linked examples cover Bench Press targets, workout detail, movement record, saved set 2 correction, past-workout save, Coach inline apply/dismiss and Notes navigation. Blank creation, conflict recovery, workout-in-progress and six-set views also document states for implementation.

These are illustrative navigation paths, not data entry or server simulations. Keyboard/focus behavior, drag ordering, delete/undo, other movement editors and secondary menus require implementation and testing. No production usability or accessibility test is claimed.

Visual checks covered the main screens and targeted narrow layouts including six-set targets, Every set, past workout and correction. Prototype endpoint validation accepted the linked destinations. The synthetic fixture uses nine sets and 2,160 kg external volume; the Coach proposal changes three Bench Press targets from 60 to 62.5 kg. Chart dates and values share the saved 7 September fixture, with no line spanning the 35-day gap. The separate 8 September past-workout draft demonstrates Bench Press at 60 × 8, 62.5 × 7 and 57.5 × 9, totaling 2,155 kg across the workout. Its Save prototype returns to the log; it does not simulate creating a new history entry.

The form these screens are drawn to — the three measures, the numeric row language, the rail that
replaced the ordinal column, and the microinteraction table — is [the form contract](web-form.md).

## Structure observations

Dense numeric tables share the Editable number component with default, hover and focus states. Short forms use the local compact Input derivative. Reconcile these controls with the shared library before implementation. Daylight is represented by routine previews; a complete light-theme screen audit remains an implementation follow-up.

The broader findings and priorities are in [the UX review](web-ux-review.md).

The extended history and human-coach sharing design contract, including source-inspected backend
gaps, is in [Training history exploration and coach sharing](log-exploration.md).
