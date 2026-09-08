# Set targets — the scheme, the ladder, and the slot it fills at the rack

The target sheet asks one question per movement — *how many sets, of how many reps, at what load* —
and can only hear one answer. A lifter whose day is a ramp (60 × 5 · 80 × 5 · 90 × 3 · 100 × 1) or a
top set with back-offs cannot write it down, so they write `5 × 5 · 80` and remember the rest. This
brief gives every set its own line, keeps `5 × 5 · 80` one gesture, and follows the line to the rack,
the mirror, the review sheet and the tool an agent calls.

Obeys `12-native-idiom.md`, `13-gestures.md`, `15-the-routine.md` (which this brief amends where it
says so), `16-the-workout.md`, `09-coach.md` and `../../guidelines/text-budget.md`.

## What is wrong today, honestly

The owner's words: *the ± button is useless; there is no way to make a pyramid; the target is not
shown during the exercise; Coach and MCP cannot write one.*

Read against the shipped sheet (`TargetEntry.swift`, `RoutineBuilder.kt` `TargetSheet`,
`Routines.jsx` `TargetSheet`), all four hold:

- **The `±` is a full-size control on every movement for a state almost no movement has.** It flips
  a load negative for band-assisted work, which is a real state (`Routine.cpp:26`) — but it is drawn
  beside a barbell's weight field, where a negative load is nonsense, and it is the most prominent
  thing on the sheet after the fields. Its accessible name, *Flip the sign — band-assisted*, is the
  one honest line about it, and it is the line nobody sighted reads.
- **One triple per line.** `targetSets · targetReps · targetWeightKg` is a straight scheme and
  nothing else. A ramp, a pyramid, a top set with back-offs, a drop set, an AMRAP last set — none
  of them is a routine line, so none of them reaches the plan snapshot, the prefill, the diff or an
  agent.
- **The rack reads the triple once and then stops.** The set line's tail says ` · target 5 @ 82.5`
  for every set; the prefill takes the plan's numbers for the first set and *today's last set*
  after that (`Prefill.of`, `Training.kt:670`), so even a plan that could say *set 4 is 100* would
  be overruled by set 3.
- **The tool cannot say it.** `entryArray()` in `GymToolCatalog.cpp` declares the triple, so an
  agent asked for a 5/3/1 week can only answer with prose.

## The object — one scheme, two zooms

> **A line's target is a scheme: an ordered list of up to twenty sets, each naming its own reps and
> its own load, either of which may be absent. A straight scheme is a scheme whose sets all agree.
> There is no second kind of line.**

`5 × 5 · 80` is five sets that agree. `60 × 5 · 80 × 5 · 90 × 3 · 100 × 1 · 80 × 5` is five sets
that do not. The domain holds one shape and the surfaces draw it at two zooms — the **head**, which
speaks about every set at once, and the **ladder**, one row per set — and both are always on the
sheet. Nothing is a mode; there is no *advanced* toggle and no *per-set* switch.

**The nulls keep their meaning, per set.** A set with no reps is `max` — that is what an AMRAP top
set is. A set with no load is `last time` — and *last time* for the Nth set is last time's Nth
working set, which is exactly what the logger's history chip already dials
(`LiveLines.lastTimeSet`). A line with no sets at all is `open`, as before.

**The wire and the store hold the scheme, and nothing else.** A line is written and read as
`sets: [{reps?, weightKg?}]`, one item per set in lifting order; an open line is an entry with no
`sets` key. There is no compressed spelling of a straight scheme: `5 × 5 · 80` travels as five
identical items, and every reader — the list row, the plan snapshot, the prefill, the diff, the
tool — derives its reading from the list.

**Bounds.** Twenty sets — the ceiling `Routine.cpp:22` already holds — reps 1–100 per set, load
inside ±500 kg per set, all refused with the pinned six strings of `15-the-routine.md`, drawn under
the row that carries the fault.

## The sheet

Two sections in the platform's own list — `List` with `.insetGrouped` sections on iOS, a
`ModalBottomSheet` holding a `LazyColumn` with two section heads on Android, the design system's
list on the web — under the head the sheet already has (the movement, `1 of 5 · Push A`, the
never-logged line).

### Every set — the head

Three fields, the ones the sheet has now: **Sets · Reps · Weight**, the platform's decimal
keyboard, the placeholders `open` · `max` · `last time`. Typing here writes every set:

- **Sets** grows or shrinks the ladder. A new row copies the row above it, so `5 → 6` on a ramp
  adds a sixth set at the top set's numbers, not a blank.
- **Reps** and **Weight** write that value into every row. That is the copy-down, and it needs no
  control of its own.

When the rows disagree, the field is empty and its placeholder reads **`varies`** — one word, and
the only new placeholder. Typing over `varies` writes every row again, which is what a lifter
reaching for that field means.

**While Sets is empty the other two fields are disabled and the ladder is not drawn**, and the one
sentence *You decide the numbers at the rack.* stands above the fields as it does today. Retyping a
count brings the same rows back — the ladder was hidden, not thrown away — and only the commit of
an open line drops it. That is the whole of the open line, and it retires two refusals:
*Clear reps and weight first — an open line names neither* and *Name the sets first — an open line
names neither* have nothing left to refuse. A field that is disabled cannot be typed into, and a
clear that keeps the rows cannot destroy anything. **`15-the-routine.md`'s two illegal-shape
sentences are struck by this brief**; the domain's refusal (`Routine.cpp:18`) stays as the last
line of defence and is never reached from a phone.

### Set by set — the ladder

One row per set, in the list's own row shape: the ordinal `1` … `n` leading, then two inline
fields — reps and load — in the numeral face, each with its own placeholder (`max` · `last time`).
Tapping a row's field edits that set alone; the keyboard's accessory bar carries the platform's
*next* so a lifter types a ramp top to bottom without leaving the keyboard. A row's fault is drawn
under that row in the pinned words, one at a time, topmost first.

**The last row is `Add set`**, the way `Add movement` is the editor's last row — one tap for the
sixth set when you are looking at the fifth, without going back up to retype a count. It is inert
at twenty and reads *Sets, 1 to 20.* under it when tapped there.

**A set row leaves by a trailing swipe — `Delete`**, complete through `.swipeActions` on iOS and
declared by hand as a custom action on Android (`13-gestures.md` Law 1). It takes no undo, for the
reason the editor's movement row takes none: the ladder is a draft on a sheet whose Cancel is the
way back, and nothing is on the wire. Deleting a row decrements Sets. A ladder of one row keeps its
delete — deleting the last set is the same act as clearing Sets and lands on the same open line.

**No reorder.** Sets are in the order they will be lifted and a lifter who wants set 2 first
retypes two numbers; a drag handle on every row would be chrome on the busiest column of the sheet.

### Fill — the one menu

A section head carries one control, **Fill**, a `Menu` on iOS and a `DropdownMenu` off a
`TextButton` on Android, holding two items:

| item | does |
|---|---|
| **Ramp up** | interpolates load and reps from set 1 to set n across the rows between, each load between them snapped onto the ladder's plate grid — the band's small step, half away from zero — so every set is loadable — the pyramid in two typed ends and one tap |
| **Match set 1** | writes set 1's reps and load into every row — the way back from a ladder to a straight scheme without retyping the head |

*Ramp up* is disabled while set 1 and set n agree, because there is nothing to ramp between. Both
are one tap and both are undone by typing; neither needs a confirmation. A long press on a ladder
row opens the same two items as a context menu, which is a shortcut and never the only path.

### The commit

The one button stays the sheet's own readout: **`Set · 5 × 5 · 80`** on a straight scheme, exactly
as now, and **`Set · 5 sets`** on a scheme whose sets disagree — a button is three words and one
line, and the ladder above it has already said the rest.

### What comes off

- **The `±` comes off every movement that is not loaded by bodyweight.** The catalog already
  answers *How is it loaded?* for every movement (`Exercise.equipment`, `Training.h:32`), and a
  negative load means one thing — band assistance on a bodyweight movement. So the control is
  drawn on a `bodyweight` movement's load fields, in the trailing slot it holds today with the
  pinned name *Flip the sign — band-assisted*, and on nothing else, on every surface and
  regardless of the keyboard the lifter has. The rack keypad keeps its `±` unchanged: at the rack
  the movement is whatever is being lifted, and a keypad with a state it cannot express is the
  wrong trade there.
- **The two shape refusals**, ruled above.
- **The line under the weight field** the boards still draw — *comma or point, both read as a
  decimal* — was already struck by `15-the-routine.md` and is not redrawn here.

## The readout — one formula on every surface

Every place that prints a line's target — the editor row, the routine's own screen, the proposal
row, the plan line on the mirror — prints:

> **`{sets} × {reps} · {load}`**, where a column whose sets disagree prints its range, `lo–hi`.

So `5 × 5 · 80` is unchanged; a ramp reads **`5 × 1–5 · 60–100`**; five sets at the same load with
descending reps read `5 × 8–12 · 80`; a top set to max reads `3 × 5–max · 100`. `Readout.target`
takes the scheme instead of the triple and nothing that calls it changes. The word `open` stays
the open line's whole readout.

**A single set is always `{load} × {reps}`** — the logged pill's own shape, `100 × 5` — with the
nulls printed as their placeholders: `100 × max`, `last × 5`. That is the vocabulary of one set on
every surface; `{sets} × {reps} · {load}` is the vocabulary of a scheme. The two are never mixed on
one line.

## The rack — the slot strip

The logger's set line already says `Set 3 of 5 · target 3 @ 90` from the plan's own count and
target (`LiveLines.counter`). With a scheme, *the target is the current slot's*, and the surface
that carries the whole scheme is the strip the room already draws:

> **The logged-sets strip becomes the slot strip.** One pill per planned set, in order. A pill
> whose set has landed reads what was lifted, in the set-done ink; the pill for the set about to be
> lifted reads its target in the target ink with the accent outline; the pills still to come read
> their targets in the faint ink. A set logged past the plan appends a plain logged pill. Warmups
> stand before slot 1 in the warmup ink, as they do now.

So a lifter mid-ramp sees `60 × 5 ✓ · 80 × 5 ✓ · [90 × 3] · 100 × 1 · 80 × 5` at a glance and knows
where they are without reading a sentence. The strip keeps every rule it has: one fixed row
scrolling sideways, every landed pill a door to the fix sheet, the cloud-off glyph on a stalled
one. A planned pill is not a door — there is nothing to fix yet — and its spoken name is *set 4,
target 100 × 1*. The set line above it keeps saying the same target in words, because a strip of
pills is not something VoiceOver reads as a sentence.

**The prefill follows the slot, not the last set — on a scheme whose sets disagree.** On a straight
scheme nothing changes: the last landed working set carries forward, as `Prefill.of` does today,
because a lifter who chose 82.5 on set 1 of `5 × 5 · 80` chose it for the day. On a scheme whose
sets disagree the Nth working set prefills from the Nth slot — its load if named, else last time's
Nth set, else today's last set, else the empty bar; its reps if named, else last time's Nth set's
reps, else the last set's. The ladder was written to be lifted in order, and a prefill that
overrules it with set 3 is the defect this brief exists to remove.

**A deviation keeps its role and its trigger.** The deviation sheet rises at the movement boundary
when the heaviest working set lifted beat the heaviest planned (`DeviationOffer.leaving`), and
offers to write the routine. On a straight scheme its offer is unchanged — *Save 82.5 to Lower A*.
On a scheme whose sets disagree the honest offer is the sets as lifted: the sheet draws the ladder
before and after, in the proposal row's own shape, and its button reads **`Save today’s sets`**. A
lifter who ran the ramp exactly as planned and only beat it on the top set gets a diff with one
moved row, which is the right size of question.

**The mirror draws the slot strip as rows.** The web's open-session mirror prints the plan line
and the landed sets; it takes the same slots, one row each, target dim and lifted full, and its
plan line takes the readout formula. It starts no sessions and changes nothing else.

**The lock screen already promises *the next set already filled in*** (`14-live-activity.md`); it
reads the current slot, so a ramp shows `100 × 1` on the glass when that is the set to come.

## Coach and the tool

### The tool

One line added to `entryArray()`, beside the triple:

> `sets: [{reps?: integer 1–100, weightKg?: number}]` — 1 to 20 items, one per set in the order
> lifted; omit `reps` for max, omit `weightKg` for last time. **Send `sets` or the
> `targetSets · targetReps · targetWeightKg` triple, never both.** A read answers the triple when
> every set agrees and `sets` when they do not.

`propose_routine_change`, `create_routine`, `list_routines`, `get_session`'s plan and `last_time`
all take it through the same shape. The description's example gains one ramp beside the straight
one, because an agent given only `5 × 5` examples writes only straight schemes.

### The review sheet — the diff

A `retargeted` row prints its moves, as it does now (`Proposal.moves`), with two additions:

- **A scheme that changed shape prints the scheme, in the readout formula:** `sets 5 × 5 · 80 →
  5 × 1–5 · 60–100`, and unfolds on tap to the ladder, one row per set, `60 × 5 · 80 × 5 · 90 × 3 ·
  100 × 1 · 80 × 5`, because a lifter deciding on a ramp has to see the ramp.
- **A scheme whose shape held and whose one set moved prints that set:** `set 4 · 100 × 1 →
  102.5 × 1`. A week's progression on a 5/3/1 top set is one line, which is what it is.

The counted changes do not change — a row is a row — and neither do the four beats, the gate, the
band or the receipt. `Applied · Lower A · 1 change` is still the store's own count.

### The Coach card

The card's *at most three changed rows* draws the compact form only — the readout, never the
unfolded ladder — because the card is a skim and the sheet is the document (`09-coach.md`).

## The strings, pinned

| where | the words |
|---|---|
| head placeholder when rows disagree | **varies** |
| ladder section head | **Set by set** |
| head section head | **Every set** |
| ladder's last row | **Add set** |
| the menu | **Fill** |
| its two items | **Ramp up** · **Match set 1** |
| a set row's swipe | **Delete** |
| a planned pill's spoken name | *set {n}, target {load} × {reps}* |
| the commit on a straight scheme | **Set · 5 × 5 · 80** (unchanged) |
| the commit on a scheme whose sets disagree | **Set · {n} sets** |
| a scheme's readout | `{sets} × {reps or lo–hi} · {load or lo–hi}` |
| one set's readout | `{load} × {reps}`, nulls as `last` and `max` |
| the deviation sheet's button on a ladder | **Save today’s sets** |
| the tool's refusal of both shapes | *a line is one scheme: send the triple or the sets, not both* |
| the per-row refusals | the six of `15-the-routine.md`, unchanged, under the row |

Struck: *Clear reps and weight first — an open line names neither.* and *Name the sets first — an
open line names neither.*, and `TargetEntry.clearOthersFirst` / `nameSetsFirst` with them on every
surface.

The chrome on the sheet at first paint, counted: *Every set · Sets · Reps · Weight · Set by set ·
Fill · Add set · Set · 5 sets* — fourteen words, inside the forty.

## The fixture

One fixture, drawn on every board:

- **Lower A**, movement 1 of 2, **Back Squat**, five sets: `60 × 5 · 80 × 5 · 90 × 3 · 100 × 1 ·
  80 × 5`. Head reads `Sets 5 · Reps varies · Weight varies`; readout `5 × 1–5 · 60–100`; the commit
  reads `Set · 5 sets`.
- The straight board is **Push A**, **Bench Press**, `3 × 8 · 60`: three identical ladder rows,
  head `3 · 8 · 60`, commit `Set · 3 × 8 · 60`.
- At the rack: sets 1 and 2 landed as planned, set 3 current — the numeral `90`, reps `3`, the set
  line `Set 3 of 5 · target 3 @ 90`, the strip `60 × 5 ✓ · 80 × 5 ✓ · [90 × 3] · 100 × 1 · 80 × 5`.
- On review: Coach proposes `set 4 · 100 × 1 → 102.5 × 1` on Lower A, one change.

## Proposals — marked as such, not ruled

- **Ramp up** and **Match set 1** above are proposals this brief recommends; the sheet stands
  without them, at the cost of typing every row of a ramp by hand.
- **A note per set** — `pause`, `belt`, `AMRAP` — twenty-four characters on a scheme's set, spoken
  with the pill and drawn in the set line's tail. Recommended **against** for now: it is a new
  column, a new field on every ladder row, and a second free-text surface beside the set note the
  rack already has (`10-notes.md` draws the trust line between those). Revisit when a lifter asks.
- **The deviation sheet's ladder offer** is ruled above on the trigger the sheet already has; a
  *lower* trigger — offering the ladder whenever any set differed — is not, because it would raise
  the sheet on every session that missed a rep.

## Open

- **Percent-of-top schemes.** A 5/3/1 week is written as percentages of a training max, and this
  brief writes kilograms. A scheme that carries `percentOfKg` per set is the same object with one
  more field; it is not drawn because nothing in the room holds a training max yet.
- **Whether `Sets` in the head should survive at all** once `Add set` and the swipe exist. It is
  kept on iOS and Android because typing `5` is one gesture and tapping `Add set` four times is
  four. `../web-form.md` drops it on web, where the ladder is the count; the two surfaces disagree
  until an owner rules, and the disagreement is ledgered as F7.

## The boards — owed to the Gym file

The Figma MCP was not reachable when this brief was written, so the boards are specified here and
owed on the Gym file (`vdmdiKWrmZoS1FtcvJRf6O`), in a section **`Set targets · 2026-09-08`** on the
page the recolour exploration lives on (`431:2`), below *Option 3*. Every board is cloned from its
canon ancestor so the chrome, the fonts (Nunito for prose and labels, JetBrains Mono for every
numeral) and the variable bindings (`gym/*`, `state/*`, `weight/ink`) are inherited, and every
board is drawn in Instrument and Daylight. The fixture is the one above.

1. **`iOS · Target sheet — straight`** (393 × 852, from `254:478`). The editor behind, dimmed; the
   sheet at `.large` with its grabber. Head: `Bench Press` / `1 of 5 · Push A`, `Done` trailing.
   Section head `EVERY SET` in the eyebrow style; the row of three fields Sets `3` · Reps `8` ·
   Weight `60 kg` (the `±` absent — barbell). Section head `SET BY SET` with `Fill` trailing in
   the accent. Three ladder rows, 52 pt each in the inset-grouped list: ordinal `1` in the faint
   ink, then `8` and `60 kg` as inline fields in the 24 pt numeral face, inset separators. Last
   row `Add set` with `sf/plus.circle`. Below the list the commit **`Set · 3 × 8 · 60`**, full
   width, 54 pt, accent fill, pinned above the home indicator.
2. **`iOS · Target sheet — set by set`** (from board 1). `Back Squat` / `1 of 2 · Lower A`. Head
   fields Sets `5`, Reps and Weight empty with the placeholder `varies` in the faint ink. Five
   rows `60 × 5 · 80 × 5 · 90 × 3 · 100 × 1 · 80 × 5`, row 3's weight field focused with the
   caret. Commit **`Set · 5 sets`**.
3. **`iOS · Target sheet — the Fill menu`** (from board 2): the `Menu` open under `Fill`, two items
   `Ramp up` with `sf/arrow.up.right` and `Match set 1` with `sf/equal`.
4. **`iOS · Target sheet — cleared`** (from board 2): Sets empty reading `open`, Reps and Weight
   disabled at the dimmed ink, *You decide the numbers at the rack.* above the fields, no ladder,
   the commit reading `Set · open`.
5. **`Android · Target sheet — set by set`** (412 × 915, from `253:142`). The `ModalBottomSheet`
   with its drag handle; `Back Squat` / `1 of 2 · Lower A`; `Every set` as an M3 list subhead;
   three `OutlinedTextField`s Sets `5` · Reps (placeholder `varies`) · Weight (placeholder
   `varies`), no `±`; subhead `Set by set` with a `TextButton` `Fill` trailing; five `ListItem`
   rows each holding the ordinal and two compact `OutlinedTextField`s; `Add set` as the last
   row; `FilledButton` **`Set · 5 sets`**. The Gboard decimal pad drawn under it, as the ancestor
   does. The board notes the swipe's custom action `Delete` by hand (`13-gestures.md` Law 1).
6. **`Android · Logger — set 3 of 5, the slot strip`** (412 × 915, from `313:361`). Title
   `Lower A`; `Back Squat`, the set line `Set 3 of 5 · target 3 @ 90` with the tail in the target
   ink; the slot strip in the reading region: `60 × 5 ✓` and `80 × 5 ✓` in the set-done ink,
   `90 × 3` outlined in the accent, `100 × 1` and `80 × 5` in the faint ink; the numeral `90`,
   reps `3`, the ladder pills off the 90 band, `Log set`.
7. **`iOS · Logger — set 3 of 5, the slot strip`** (393 × 852, from `433:86` on the same page):
   the same fixture on the iOS logger, the strip where the TODAY rows stand.
8. **`Web · Mirror — the slots`** (1440 × 900, from `432:713`): the mirrored session's set list as
   slot rows, landed rows full and the three to come dim, the plan line `5 × 1–5 · 60–100`.
9. **`Review — one set moved`** (a 393 × 852 iOS review from `123:2` and a 412 × 915 Android one
   from `124:364`): `Proposal · Lower A`, *Coach wrote:* one line, one retargeted row reading
   `Back Squat · set 4 · 100 × 1 → 102.5 × 1`, *and 1 line unchanged*, the band `Apply` · the gate ·
   the promise · *Turn this down*.
10. **`READ ME · Set targets`** on the section's own `gym/canvas` ground: the object in one
    paragraph, the readout formula, the fixture, and the two struck sentences.

## Ruled

Ratified whole, with these overrides:

- **One wire shape.** The triple is gone: a line's target is `sets: [{reps?, weightKg?}]` on the
  wire, in the store (a child table of set rows) and in every domain; an open line is an entry with
  no `sets`. No reader keeps a compressed spelling.
- **The `±` is drawn on a bodyweight movement's load fields on every surface, regardless of the
  keyboard** — nothing reads the IME.
- **Ramp up and Match set 1 are built**, not proposals.
- **Keep-as-routine on Finish transcribes the working sets per set**; the count / modal / max
  flattening goes with the triple.
- Per-set notes, percent-of-top and a lower deviation trigger stay unbuilt.
- **Pinned in the build, on every surface:** a scheme of one set prints the scheme formula
  (`1 × 5 · 100`); a placeholder stands as the top of a mixed column (`5–max`, `60–last`); a set
  past the plan has no target and the set line carries no tail; Ramp up needs three rows and snaps
  the loads between the ends onto the plate grid; while a refusal stands the commit is disabled
  and reads `Set`; a count typed lower hides rows and never discards them, so `Add set` reveals a
  hidden row before it copies one; a deviation on a ladder is offered only while the working sets
  fit a line (twenty); a document the previous app version wrote on the device is rewritten to
  the scheme on open, and one unreadable row costs that row, never the shelf.
