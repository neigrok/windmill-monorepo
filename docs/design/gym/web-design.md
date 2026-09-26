# Gym web design

The drawn half of the gym web canon: the Gym Figma file's **`Web · Gym`** page
([`466:132`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=466-132)). The written half is
[the form contract](web-form.md) and the briefs it names. The [build contract](web-build-contract.md) maps their acceptance states.

## The page

Six sections, left to right. Each row is one state: desktop 1440 on the left, narrow 390 on the right,
named `Area / Screen / State / Width`.

| Section | Node | Holds |
|---|---|---|
| Start | `804:5811` | `START HERE · Gym web` (`486:1334`): how to read the page and the rules every board follows |
| Components | `804:5812` | `Components · Gym web` (`534:3341`): every local component a board instances |
| Plan | `804:5813` | Routines, the routine editor (default, ladder, copy-down, six sets, conflict), new routine and its picker, Daylight |
| Record | `804:5862` | The log and its filters and density, the movement record, edit workout, fix set, add a past workout |
| Coach & Notes | `804:5932` | The conversation with a proposal, turned down, applied, workout in progress; Notes and the note editor |
| Share | `804:5975` | Log sharing setup, preview, link active and revoked, the recipient's log |

**The tag above each board is its implementation stage** (`Board status`, `802:11855`):

- **Built** — matches what ships on the web.
- **Ready** — approved; build from this board.

A superseded board leaves the page. The current per-board statuses and runtime evidence are in
[web-build-contract.md](web-build-contract.md). A board turns Built after its running implementation
passes comparison at both widths.

## Rules every board follows

- Type uses the fourteen `Gym/Web/*` styles; a title is Baloo 2 Bold 32/40, 28/36 narrow.
- Colour binds to `Gym · Colour`; radius, space and the two measures bind to `Gym · Metrics`.
- Outer containers are centered independently: Fix set 420px, focused pages 640px, routine editor
  812px, comparison states 872px, and Log, Coach, Notes and populated past-workout forms 1024px.
  Reading and numeric content keep their own 640px and 420px limits.
- Section gaps are 32px, section interiors 24px, and related elements 8/12/16px. Use auto-layout
  spacing; short content may leave quiet canvas below it.
- The back link is `Gym / Back link` (`797:11866`): leading, above the title, naming its destination
  in two words at most.
- The unit is named once per surface, in a column head or a totals line, never on a row.
- No board draws a set kind: a new set is Working and a correction keeps the stored kind.
- A routine's `⋯` holds `Log past` and `Delete`; there is no Duplicate.
- The phone owns live training, so no board starts a session.
- The Coach proposal head reads `Push A · 1 change`. A shared view says *Notes and Coach chats stay
  private.*

## The screens

- **Routines.** Each routine has one card, including its pending change review. The card is the door
  to a draft editor. Desktop centers a 360px movement index, 32px gap and 420px ladder pane; the
  movement picker takes that same right pane. Narrow opens the ladder and the picker in a sheet.
  `Every set` and `Set by set` are two zooms on one scheme, both always drawn. A stale save keeps the
  draft and offers it against the latest routine in two 420px columns with a 32px gap. Cancel and
  Save form one local action group.
- **The log.** On desktop a split: the history index left, the workout reader and progress cards in the
  detail pane; narrow puts progress above the history and opens a workout on its own screen.
  Movement totals sit beside their movement name. Filters read their value. The door is `Add past
  workout`. Back from a movement record returns to where it was opened.
- **Add a past workout.** Pick a routine, get the form filled — targets, then last time — change what
  differed, save once; the day is one tap and the Save note states the stored hour
  ([brief 20](briefs/20-past-workout.md)). After Save, desktop shows the log split with the new row
  selected and narrow shows the session detail.
- **Edit workout and fix set.** A saved workout is corrected in its own place; a refused value keeps
  what was typed and reopens the field that failed.
- **Coach.** Every proposed change is inline in the conversation, `Apply` beneath it and `Turn this
  down` beneath that ([brief 09](briefs/09-coach.md)); the same message becomes the receipt. Desktop
  Apply fits its label and padding. A diff row counts entries, not sets.
- **Notes.** A 640px reading region beside its 352px Rooms and connected-tools rail, centered
  together with a 32px gap. The connected-agent disclosure sits beneath the Notes title. The note
  editor groups its local actions.
- **Sharing.** A log leaves by a link the lifter creates and revokes — a snapshot or a live link, the
  whole history or a range; the recipient's view is read-only. The implemented contract is in
  [Training history exploration and coach sharing](log-exploration.md).

## Prototype and fixture

Prototype links cover latest and previous workout, the 2024 date jump, clearing a filter, the share
preview, create, view and revoke, Bench Press targets, the movement record, a saved-set correction,
Coach apply and turn down, and Notes. They are navigation paths, not data entry.

The main fixture is 8 September 2026: eight workouts across 2024–26, the 7 September Push A at 9 sets
and 2,160 kg. A 982-workout fixture stresses density and is never mixed with it. The past-workout
boards carry their own Push A on 24 September.

Daylight is drawn for Routines only; every other board is Instrument.
