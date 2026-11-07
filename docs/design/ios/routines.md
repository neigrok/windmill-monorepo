# Routines — iOS Gym, Direction L

Status: 🚀 In production — owner approved 2026-11-07 ("yes it looks good"); every board is built. Boards are
on the Gym file's iOS page in [02 · Routines](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1113-1474):
02L.1 `1992:18823`, 02L.2 `1992:18934`, 02L.3 `1992:19044`, 02L.4 `1992:19179`, 02L.5 `1992:19295`,
02L.6 `1992:19404`, 02L.7 `1992:19539`, 02L.8 `1992:19789`, each with its Daylight twin beneath, and the
[note](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=1993-19678) (`1993:19678`) that names
the SwiftUI element of every part and records the owner's seven rulings. Direction L is Lift-shaped: the
routine and movement screens are stock `Form` parts and nothing else, with the two Windmill specifics Lift
lacks — the catalogue picker with Create-from-query, and Equipment and Rest per movement — as stock parts too.

## The fixture

Every board draws one lifter's routines, seeded on the simulator by `-coach-board routines`
(`CoachBoard.routinesL`): Push A, Pull A, Legs and Upper B, with Coach's three changes to Push A waiting at
the head of the list. Push A, as 02L.7 lists it:

| Movement | Equipment | Plan | Rest |
|---|---|---|---|
| Bench Press | barbell, kg total | 3 × 8 · 60 | 2:00 |
| Incline Dumbbell Press | dumbbells, kg each | 16×10 › 18×8 › 20×6 | 1:30 |
| Chin Up | bodyweight, kg added | 3 × 8 · bodyweight | 2:00 |
| Lateral Raise | dumbbells, kg each | 3 × 12 · 8 | 1:00 |
| Triceps Pushdown | cable, kg | 3 × 12 · 25 | 1:00 |

02L.2 builds a new routine from its first three movements; 02L.4–02L.6 and 02L.8 make a movement the catalogue
lacks on the form — the boards say *Bulgarian split squat*, which the seed catalogue already holds, so the captures
make *Zercher squat* — dumbbells, 3 × 10 at 16 each with 1:30 rest, then varied 16×10 › 18×8 › 20×6.

## The screens

- **Routines** (02L.1). The large title; *New routine* is the toolbar `+` beside the account button (owner
  ruling 1), so the reach band holds only the transient. Rows read *name* over *N movements · trained 3 days
  ago*, swipe to the trash circle and hold *Start workout* and *Delete routine* in their menu; a waiting
  proposal keeps its row at the head.
- **Routine editor** (02L.2, 02L.3). A `.large` sheet holding a `Form`: *Routine name*; a *Movements* section
  whose header carries the system `EditButton`, each movement a `MovementRow`, `.onMove` and `.onDelete` in
  edit mode, a swipe's trash circle out of it, and *Add movement* at the section's end; the routine's History
  when it has been trained; *Delete routine* as the last section when editing. The bar is *Cancel* and the
  word *Save* in the confirmation placement's capsule (ruling 3), enabled once something changed. Cancel on a changed draft
  asks *Discard routine changes?*; an interactive dismissal is refused while the draft is dirty. A name the
  lifter leaves blank or over 60 characters refuses as the name section's footer; every other refusal stands
  in the band.
- **The row** (`MovementRow`, 02L.2). The name in the headline beside its equipment, then one caption line of
  facts, each behind its symbol: `repeat` *3 sets*, `number` *8 reps* (*Max reps* for open reps), `scalemass`
  the load in the movement's basis (*60 kg total*, *16 kg each*, *bodyweight* for nothing added, *−10 kg added*
  for a band), and `timer` the rest when the movement sets one. A varied scheme reads its sets in sequence,
  *16×10 › 18×8 › 20×6*, with no badge (ruling 7); an open plan reads *Open plan*. The summary prefixes the
  place, *1. Bench Press*. VoiceOver hears the row in one breath.
- **Movement picker** (02L.4). Pushed from the editor's own stack. Stock `.searchable` in its automatic place,
  which on iOS 26 is the foot of the screen above the keyboard; the six, *All movements* and *Matches* as
  before; a query no movement is named leads with *Create “…”*, and when nothing matches its footer reads
  *No movement by that name.*; `+` in the bar opens a nameless form. A row already in the routine is checked
  and disabled. A pick opens the movement form over the picker; its Add pops the picker.
- **Movement form** (02L.5, 02L.6, 02L.8). A sheet stacked over the editor (ruling 6), titled *New movement*
  for one made here, *Add movement* for a pick, *Edit movement* for a row. *Name*; *Equipment* as a
  `Picker(.menu)` — Barbell, Dumbbells, Machine, Cable, Kettlebell, Bodyweight — and *Dumbbells* One / Two
  as a menu for dumbbells; when an existing movement is edited the section's footer says *Name and equipment
  apply everywhere. Targets stay in this routine.* **Targets**: `Stepper` *Sets: 3*, 0…20, which at 0 reads
  *Sets: Open* and hides the rest (ruling 2); `Stepper` *Reps: 10*, which at 0 reads *Reps: Max*, the plan's
  open reps; *Load* as the shared `LoadRow` drawn bare — a stock trailing decimal field, the unit the equipment
  decides (ruling 4), a leading minus for a band on bodyweight through the keyboard row's ±, and an empty field for no
  load target; *Varied sets* a `Toggle`; the basis help as the footer. Varied, each set takes its own section
  *Set N* with its Load row and Reps stepper, seeded from the shared values; the Sets stepper appends copies
  of the last or trims. Turning Varied off makes every set the first. **Rest** a `Picker(.menu)`: Default, 0:30, 1:00, 1:30, 2:00, 2:30, 3:00, 4:00, 5:00
  (ruling 5), plus the entry's own value when it is none of these. The bar is *Cancel* and *Add* (*Save* when
  editing), disabled while the name is blank or the equipment unchosen. Nothing writes until the routine
  saves: name and equipment ride with the routine's one atomic `SaveRoutinePlan`.
- **Summary** (02L.7). The sheet at 62 % or large, rows in the shape above with their place, *Close* and *Edit*
  in the bar, *Start* across the foot on the reach band over a hard scroll edge.
- **Largest text** (02L.8). Stock rows stack their label over the control; the Load field and its unit share a
  line under the label; footers wrap.

## Parity

iOS only. Android keeps its M3 editor and web its own; both carry the same data — `RoutineEntry(sets,
restSeconds)`, `Exercise(equipment, loadCount)` — so the three surfaces differ in form, not in what they save.
Recorded in `docs/design/consistency.md`.
