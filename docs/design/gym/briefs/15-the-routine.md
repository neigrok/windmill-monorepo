# Routines

Creation, editing and starting. Layout belongs to [web form](../web-form.md) and
[Android delivery](../android-delivery.md); [set targets](17-set-targets.md) owns target semantics.
Use [native controls](12-native-idiom.md), the shared [text budget](../../guidelines/text-budget.md)
and [gesture contract](13-gestures.md).

## Name and save

New routine opens the editor with an empty, focused name field and the keyboard available.
There is no naming interstitial, invented name or suggestion chip. Save requires a nonblank name
and at least one movement; it is single-flight and unavailable for an unchanged draft.

Names allow 60 Unicode code points. The editor shows a `53/60` counter from 48 characters;
Finish uses the same cap and blank-name predicate without the counter. Whitespace-only names,
including pasted newlines, are blank. Share these predicates within each surface.

Show one refusal at a time, name first: **Name it to save it.** then
**A routine is at least one movement.** An in-flight save must not show the empty-name explanation.

## Editor

- The navigation bar carries Back and Save; Name is the first field.
- Movement rows open their targets. They do not navigate away from an unsaved draft.
- Add movement is the list's last row. Routine deletion belongs to the routine row; there is no Duplicate.
- Web and Android editors contain the plan only. iOS keeps its History section.
- Reordering supports drag and accessible alternatives. Web uses the shared `rail.js` pick/place,
  ArrowUp/ArrowDown and Escape behavior; native controls expose movement actions. Announce the
  new position once and keep focus with the moved row.
- Web movement removal has an independent nine-second Undo that restores the original index.
  These are draft changes: nothing is sent, and leaving the draft closes its windows.
  Native swipe removal must retain its accessible alternative and recovery policy.

Web's Movements door on routines home reaches records and Rename for never-trained movements.
iOS routine-detail rows open movement records. Android's routine sheet contains the plan only;
movement records remain available from Log.

## Target entry

Use the platform numeric keyboard for planning. Rack and Fix use the rack keypad on phones;
web uses editable numbers. The exact native stepper/field and web ladder composition belongs to
its surface contract, not a second copy in this document.

Empty load means **last time**, empty reps **max**, and no sets **open**. While a counted scheme is
cleared to open, disable its other head fields and hide its rows without discarding the draft.
Retyping the count restores rows; committing open drops them. The sheet shows
**You decide the numbers at the rack.** above the fields only while open and not refused.
List rows show only `open`.

Accept comma and point without a permanent separator hint. Show one numeric refusal: count
first, then rows top to bottom, reps before load. A shared fault belongs under its head field;
an individual fault belongs under its row.

| Condition | Copy |
|---|---|
| Second decimal point | One decimal point only. |
| Incomplete number | That is not a number yet. |
| Load outside the stored range | Over 500 kg — check the number. |
| Invalid planned reps | Whole reps, 1 to 100. |
| Invalid set count | Sets, 1 to 20. |
| Zero target | A zero target is no target — clear the field instead. |

The planning sign control appears on bodyweight load fields. Its glyph is `±` and its accessible
name is **Flip the sign — band-assisted**. The rack keypad retains sign access for all movements;
its backspace is named **Delete**.

## Movement picker

Use native search on phones and the design system Input on web. An empty query shows **The six**
followed by the complete catalog. The six rank the account's movements over the last fifty
sessions held by that surface, topped up from Back Squat, Bench Press, Deadlift, Overhead Press,
Barbell Row and Chin Up. Freeze the ranking on the first nonempty read while the picker remains
open so paging and account claims cannot reshuffle it beneath a touch.

If a placeholder includes a catalog count, use the real count. Never invent a larger fixture count.
Create movement stays available within the picker, including with an empty query. Its nested
sheet preserves the query and frozen ranking on Cancel and uses its own keyboard inset. It asks
for a name and loading equipment. Preserve the draft on failure and prevent duplicate writes.

## Routine list and detail

A list row identifies its routine and any waiting proposal. Native rows and web cards follow
their surface contracts; do not repeat the same proposal in a row and a separate card.
Connected-log explanation belongs in Settings and Connected log, not repeated planning pitches.

Android rows name their first movements without recency. Tapping opens a bottom sheet with the
name, movement targets, pinned **Start workout** and quiet **Edit routine**. No rest lines,
last-trained line, history block or movement-record door belongs in that sheet.

iOS uses a pushed detail with movement targets, `· yours` where applicable, movement-record doors
and recent History. Web opens the editor. Where routine proposal history is shown, it covers the
newest twenty proposals and must not claim to show all changes. A failed history read is not an
empty history: retain a useful server reason, otherwise say
**the log didn’t answer — this routine’s history is out of reach**. A block failure does not add
a second primary Retry beside a reachable Start workout.

Phones pin Start workout above the safe inset. It is also available from the routine row's
long-press action. Web offers past-workout entry and never starts a live session.

## Open

- Whether routine editing should save on departure. Preserve explicit Save until the interaction
  accounts for starting a partly edited plan and the draft-exit policy in consistency entry 4k.
- Whether **The six** should name its fifty-session ranking scope. It must not imply a lifetime
  ranking while reading only that window.

When changing a control, assign every refusal and recovery it owns to a concrete state before
removing its previous presentation.
