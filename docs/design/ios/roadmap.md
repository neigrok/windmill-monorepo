# Roadmap — iOS

Status: ✅ Ready for dev. The owner approved every board on 2026-11-21. Built, in Debug builds alone: the room's
row in the room menu, its door on *Where to start?*, the Board with its swipes to Complete and to Delete, their
*Undo* in the band and the long-press menu's *Complete* and *Delete Step*, an empty roadmap, every step done,
*No roadmaps yet* and the room's failed read; a step's page, opened by a Board row: its status row,
description and shared links, *Requires* and *Opens*, *Complete* and *Reset* in place with their *Undo*, the …
menu's *Delete Step* with its question, and the person's workspace: *Subtasks* checked in place, added in the list and
removed by a swipe, the *Note* on its own screen with bold and italic from the system's Format menu, and *Your links*
with New Link's two fields, without *History*; the step form, New Step from the foot's + and from an empty roadmap, and
*Edit* from a step's page: Name, Description, *Kind*, *Requires* and *Opens* pushed inside the sheet, the *Links* the
step shares, their refusals as footers, *Discard draft?*, the created step shown on the Board and each save with its
*Undo*, without its *Roadmap* row, *Edit Kinds* or Coach's composer; the room's roadmaps: the title menu with the three most recent, *All
Roadmaps…*, *New Roadmap*, *Rename* and *Delete Roadmap*, All Roadmaps with its search and its swipe to Delete, New
Roadmap for a blank roadmap, renaming in the bar, and a roadmap's delete asked once and held with *Undo*; and the Graph:
the switch row's *Board | Graph*, the canvas with its discs, connectors and captions, one finger's pan and a pinch, a
step selected with its bar in the band slot and its page from there, *Next* in that slot with its menu of the Up next
steps, *Fit*, and an empty roadmap, without Find, a step that opens a roadmap's mark or Coach's composer.
[Roadmap on iOS](../../foundation/roadmap-ios.md) §13 lists what is not built. The boards are on the Roadmap file's
[Roadmap · iOS](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=648-2) page. Each board's
caption names the SwiftUI element of every part, and each section ends with a NOTE of its stock parts, its
differences from the web and the rules it keeps.

Roadmap is the third room of the Windmill app, beside Journal and Gym. The model is the web Board's
([proposal](../roadmap-board-proposal.md), [review](../roadmap-board-review.md)); this page translates
the whole web product to iOS under the [rendering contract](ios-redesign.md). How it is built is
[Roadmap on iOS](../../foundation/roadmap-ios.md); Coach's rules are [Roadmap Coach](../roadmap-coach.md).

| Section | Figma | Holds |
|---|---|---|
| Start here · the Roadmap room | [`1435:6376`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1435-6376) | The four screens the room is made of: Board, Graph, step page, New step |
| 00 · Read me and map | [`1469:38785`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1469-38785) | How to read the page, the room in twelve lines, what was rejected before, the flow map |
| 01 · The room and its roadmaps | [`1447:8090`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1447-8090) | The room menu, the title menu, All Roadmaps, no roadmap yet, New Roadmap (blank, a quest, a copied plan, a file), rename, delete held with Undo, every step done, Activity |
| 02 · Board | [`1448:16119`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1448-16119) | Swipe to Complete and to Delete, the long-press menu, Find, sort and filter, a branch, several selected, recolor, 5,000 steps, an empty roadmap, pasted steps |
| 03 · Step page | [`1447:9390`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1447-9390) | Up next, Locked, Done; the workspace; Complete and Reset in place; the … menu; delete held with Undo; Note; a link; History |
| 04 · Graph | [`1450:31039`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1450-31039) | The canvas, Next, a step selected, pinch, Fit, a step that opens a roadmap, an empty roadmap |
| 05 · Create and edit a step | [`1448:13505`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1448-13505) | The Form sheet, Kind, Requires, Opens, Discard draft?, refusals, the created step revealed, Edit, Coach filling the draft |
| 06 · Kinds | [`1450:28724`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1450-28724) | The kinds of a roadmap: add, rename, describe, recolor, remove |
| 07 · A step that opens a roadmap | [`1448:11955`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1448-11955) | The pill, the step page's Roadmap section, going in and back, attach, fork first, change and detach, the odd ends, subtrees |
| 08 · Guide | [`1450:33621`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1450-33621) | Reading, adding and editing a guide, its limit, guides from above |
| 09 · Sharing and links | [`1447:10486`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1447-10486) | Share, Export, a shared link's cover, Fork, links that cannot open, the public gallery |
| 10 · Offline, sync and the account | [`1450:35596`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1450-35596) | Offline, a step that landed in a changed roadmap, a step that came back, changes set aside, limits, the sign-in and sign-out questions, a load error |
| 11 · Coach in the room | [`1449:15828`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1449-15828) | The composer, a turn, direct writes with Undo, the conversation sheet, History, proposals and their review, a photo, access states, the room before Coach opens |
| 12 · Largest text, 320 pt and iOS 18 | [`1466:38026`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1466-38026) | The fallbacks, with one table of what differs on iOS 18 |
| 13 · Left out, and where it lives | [`1467:38794`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1467-38794) | What the room does not do, and why |
| 🧩 Components · Roadmap iOS · kit | [`1430:6179`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=1430-6179) | The room's parts, bound to its colour roles |

Boards are drawn at iPhone 17 size (402 × 874 pt): Dark on each section's top row, Light twins below for
the key screens. Fixture: *Learn to sail*, eight steps, three done; *Become a day skipper*, whose step
*Learn to sail* opens that roadmap; *Coastal navigation handbook*, 5,000 steps.

The system's own parts — menus, confirmation dialogs, alerts, sheets, swipe actions, a sheet's bar, the
title menu, search — are drawn from screenshots of a SwiftUI probe run on the iOS 26.5 simulator, not from
memory. Glass, blur and shadow are the system's and are not imitated: those grounds are opaque roles.

## The room

One `NavigationStack`, no `TabView`.

- **The bar.** The room capsule (`RoomMenu`, `.topBarLeading`), the roadmap's name as an inline
  `.navigationTitle` with `.navigationSubtitle` (*3 of 8 done*; *Offline* joins it) and
  `.toolbarTitleMenu`, and `RoomAccountButton` (`.topBarTrailing`). The title menu shows only on an inline
  title, so the room has no large title. The bar has one trailing button because the system folds bar
  buttons into an overflow before it truncates a title: with two, any name wider than about 100 pt loses
  them. A longer name truncates in the bar and is whole in the title menu and in All Roadmaps.
- **The title menu.** The roadmaps (three most recent, each with its progress, a checkmark on the
  current), *All Roadmaps…*, *New Roadmap*, then this roadmap's *Guide*, *Kinds*, *Activity*, *Share…*,
  *Export*, *Rename* and *Delete Roadmap*. Renaming is the system's: `.navigationTitle($name)` turns the
  bar into one field.
- **The switch row**, pinned under the bar in `.safeAreaBar(edge: .top)`: a segmented `Picker` with the
  text segments *Board* and *Graph*, a Find button, and the view's one tool — the *Sort and filter* `Menu`
  on the Board, *Fit* on the Graph.
- **Find.** The Find button applies `.searchable`; its field comes at the foot above the keyboard, where
  iOS 26 places search, and `.searchPresentationToolbarBehavior(.avoidHidingContent)` keeps the bar and
  the switch row. The composer is absent while Find is up. No stock placement gives a field at the top
  that is absent at rest.
- **The foot**, one `.safeAreaBar(edge: .bottom)`: at most one band (a receipt with *Undo*, a told-once
  sync line with *Show*, a refusal; on the Graph the *Next* bar or the selected step), then the Coach
  composer and, at its trailing end, a glass `+` — New step, in thumb reach; a long press is the `Menu`
  *New Step*, *Paste Steps*. On an Up next step page the foot is *Complete* with the composer minimised to
  a Coach circle beside it. While several steps are selected the foot is the bottom toolbar (*Recolor*,
  *Delete N Steps*). A reader's cover has *Fork Roadmap* there and no composer.
- **A roadmap gone into** is pushed on the same stack: Back · its title and progress · a `…` `Menu` of its
  own verbs (*Guide*, *Kinds*, *Activity*, *Export*).

`AppModel.Room` gains `.roadmap` (title *Roadmap*, symbol `map`). The Shell's *Where to start?* gains a
Roadmap door, third after Journal and Gym: ✅ Ready for dev in the Shell file ([`326:7899`](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=326-7899)).

## Coach is on the open screen

Coach is not a tab. Its composer is at the foot of the Board, the Graph, a step page and the step form,
and nowhere else. Focused, it shows up to three suggestions as small glass buttons and an attach button
(`paperclip`) leading the field. A direct write raises nothing: its receipt is the band, with *Undo*. A
turn that produces words or a proposal raises the conversation as a `.sheet` at `.medium` with
`.presentationBackgroundInteraction(.enabled(upThrough: .medium))`, so the screen behind stays live;
*History* and *New Chat* are in the sheet's bar. A proposal's card offers *Reject* and *Review*; *Review*
opens the one review sheet (the diff on the Graph, *Changes* one segment away), and *Apply* exists only
there. Before Roadmap Coach opens to people the composer is absent and New step stays at the foot.

## Rules of the room

- **Stock first.** Lists are `List(.insetGrouped)`; forms are `Form`s in a `.large` sheet that commit from
  the bar with *Cancel* and *Create* or *Save*, two untinted glass words (the confirm semibold), so a form
  has no filled control; questions are `.confirmationDialog`, which on iOS 26 is a small popover anchored
  to its source with no Cancel and no dimming; empty and unavailable states are `ContentUnavailableView`;
  sharing, export and paste are `ShareLink`, `.fileExporter` and `PasteButton`. The one custom part is the
  Graph's `Canvas`.
- **One filled control.** *Complete* on an Up next step page, *Open Roadmap* on a step that opens one, and
  *Apply* in the review sheet. Every other button is glass on the canvas, `.bordered` on a card, or plain.
  Destructive is `role: .destructive` in the system red; kind colours sit on symbols and discs.
- **The Board's three groups disclose.** Up next, Locked and Done are each a header button that folds its
  section (`Section(isExpanded:)` draws no control of its own in this list style); Done is closed at rest.
- **A step page** is one scroll: the step's name as its first text (the bar carries no title until the
  page scrolls), the status row with the kind's name first (*Sky · Unlocks Leave the dock*), description
  and links, *Requires* and *Opens* with their counts, then the private workspace (*Subtasks*, *Note*,
  *Your links*, marked *Only you*) and *History*.
- **Persistence.** Every change is written on the phone first. There is no *Saving…*, no save failure and
  no conflict dialog. A change that met one made elsewhere is told once, by the band and one footer. A
  change to a roadmap that was deleted elsewhere is set aside and listed in one place, with *Copy* and
  *Discard*. A limit is refused where the gesture is made. A delete asks once with its cost and is then
  held nine seconds with *Undo*; every other *Undo* lasts six.
- **Signed out is first class.** Everything works on the phone's copy with no banner. Where signed out and
  signed in differ — Share, Fork, the sign-in question — both are drawn. *Activity* and a step's
  *History* are read from the phone's copy, so they work signed out and with no connection.
- **Words.** iOS says *roadmap*, never *tree*, and *step*, never *node*. Section and field names are the
  web's: *Requires*, *Opens*, *Kind*, *Guide*, *Subtasks*, *Note*, *History*. Menu items and buttons are
  Title Case; spelling follows the web's strings (*Color*, *Recolor*).

## Colour roles

Roadmap's grounds and inks are the family palette the web names *Tuscany at midday* by day and the family
night after it, under roadmap's own role names. The accent is terracotta; the six kind hues are the web's
kind ramp. They bind to the Roadmap file's *iOS · Roadmap roles* collection in Dark and Light.

| Role | Dark | Light | Use |
|---|---|---|---|
| `roadmap/canvas` | `#0B0B0C` | `#F9F5EB` | screen ground, sheet ground, the Graph canvas |
| `roadmap/card` | `#171719` | `#FFFFFF` | list rows, cards |
| `roadmap/raised` | `#222224` | `#FDFBF6` | fields, the grounds of menus and dialogs, a selected row |
| `roadmap/sunken` | `#050506` | `#F2ECDD` | a well a control sits in, a bordered button on a card |
| `roadmap/line` | `#222224` | `#E5D9C0` | separators, card strokes |
| `roadmap/line-strong` | `#2E2E32` | `#D3C2A0` | a focused field's stroke |
| `roadmap/overlay` | `#030304` at 72 % | `#211B13` at 45 % | the dimming under a large sheet |
| `roadmap/overlay-soft` | `#030304` at 40 % | `#211B13` at 22 % | the dimming under an alert or a medium sheet |
| `roadmap/ink` | `#F2F0EB` | `#211B13` | primary text |
| `roadmap/ink-dim` | `#B4B2AC` | `#6F5F45` | reason lines, subtitles, a Locked step's title, every essential label that is not primary |
| `roadmap/ink-faint` | `#7E7C77` | `#92805F` | non-essential meta only: an unselected selection ring, placeholder text |
| `roadmap/accent` | `#D08A5E` | `#9D5330` | tint: links, selection, the primary fill, Undo |
| `roadmap/accent-soft` | `#D08A5E` at 20 % | `#9D5330` at 12 % | an arrived or new row's one-time wash |
| `roadmap/on-accent` | `#1B1408` | `#FFFFFF` | text and symbols on the accent fill |
| `roadmap/act` | `#9D5330` | `#9D5330` | the Complete swipe action's fill |
| `roadmap/on-act` | `#FFFFFF` | `#FFFFFF` | the symbol on a swipe action |
| `roadmap/kind-build` | `#D98B5F` | `#BC6C42` | the Build kind (terracotta): row symbol, graph disc |
| `roadmap/kind-learn` | `#9DAF5C` | `#7D8C43` | the Learn kind (olive) |
| `roadmap/kind-milestone` | `#D9AE45` | `#A17822` | the Milestone kind (gold) |
| `roadmap/kind-brick` | `#C86B50` | `#A84E35` | the Brick hue |
| `roadmap/kind-sky` | `#7BA6B8` | `#5F8494` | the Sky hue |
| `roadmap/kind-plum` | `#B06FA6` | `#8D4F83` | the Plum hue |
| `roadmap/connector` | `#2E2E32` | `#D3C2A0` | a Graph connector from an unfinished step |
| `roadmap/connector-lit` | `#7E7C77` | `#9C6B44` | a Graph connector from a completed step |
| `roadmap/locked-build-fill` | `#3F2A1D` | `#ECD7C6` | a Locked Build disc on the Graph: its fill |
| `roadmap/locked-build-ring` | `#5F3B26` | `#DFBBA4` | a Locked Build disc on the Graph: its ring |
| `roadmap/locked-build-glyph` | `#74462C` | `#D7AA8E` | a Locked Build disc on the Graph: its dot |
| `roadmap/locked-learn-fill` | `#31311D` | `#DEDEC6` | a Locked Learn disc on the Graph: its fill |
| `roadmap/locked-learn-ring` | `#454827` | `#C5C9A4` | a Locked Learn disc on the Graph: its ring |
| `roadmap/locked-learn-glyph` | `#51572D` | `#B5BB8F` | a Locked Learn disc on the Graph: its dot |
| `roadmap/locked-milestone-fill` | `#413318` | `#EDE0C2` | a Locked Milestone disc on the Graph: its fill |
| `roadmap/locked-milestone-ring` | `#634D1E` | `#E3CE9C` | a Locked Milestone disc on the Graph: its ring |
| `roadmap/locked-milestone-glyph` | `#785D22` | `#DCC184` | a Locked Milestone disc on the Graph: its dot |
| `roadmap/locked-brick-fill` | `#3B231A` | `#E7D0C3` | a Locked Brick disc on the Graph: its fill |
| `roadmap/locked-brick-ring` | `#572E21` | `#D7AF9F` | a Locked Brick disc on the Graph: its ring |
| `roadmap/locked-brick-glyph` | `#693525` | `#CC9987` | a Locked Brick disc on the Graph: its dot |
| `roadmap/locked-sky-fill` | `#2B2F2F` | `#D7DCD8` | a Locked Sky disc on the Graph: its fill |
| `roadmap/locked-sky-ring` | `#384549` | `#B8C6C6` | a Locked Sky disc on the Graph: its ring |
| `roadmap/locked-sky-glyph` | `#41535A` | `#A4B7BB` | a Locked Sky disc on the Graph: its dot |
| `roadmap/locked-plum-fill` | `#35232B` | `#E1D0D4` | a Locked Plum disc on the Graph: its fill |
| `roadmap/locked-plum-ring` | `#4B2F41` | `#CCAFBF` | a Locked Plum disc on the Graph: its ring |
| `roadmap/locked-plum-glyph` | `#5A3650` | `#BE9AB2` | a Locked Plum disc on the Graph: its dot |

A Locked step's disc on the Graph takes its kind's locked tier — `roadmap/locked-<kind>-fill`, `-ring` and
`-glyph`, the eighteen roles above, whose values are the web's `locked/<hue>-*`. Destructive labels are the system
red (`#FF453A` dark, `#FF3B30` light), which the system supplies; brick is a kind, never a warning.

As text, the light accent `#9D5330` measures 5.19:1 on `roadmap/canvas`, 5.65:1 on `roadmap/card` and
5.47:1 on `roadmap/raised`; the dark `#D08A5E` measures 7.01:1, 6.38:1 and 5.66:1; `on-accent` on the
accent is 6.50:1 dark and 5.65:1 light, and white on `roadmap/act` is 5.65:1. Kind colours are never
text. As symbols they clear 3:1 on the card: light 3.68:1 (learn) to 5.87:1 (plum), dark 4.83:1 (plum)
to 8.60:1 (milestone). The light milestone is gold 600 (`#A17822`), not the web's 500, which measures
2.69:1 on white.

## Where iOS differs from the web

- **Groups are sections of one List**, Up next first, not one column at a time; Done folds instead of
  showing twelve and *Show all N*.
- **The kind rail is the row's leading symbol**, tinted by kind: a ring for Up next, a lock for Locked, a
  check for Done.
- **Coach replaces Ask AI**, and lives at the foot of the open screen.
- **Renaming and deleting a roadmap, and managing kinds, are on the phone**; the web's phone has none of
  the three. A deleted roadmap is held nine seconds with *Undo*; the web deletes at once.
- **Kind is a pushed list** of the six hues, the named kinds first with their descriptions, and Kinds is a
  sheet of its own.
- **Pickers have no Apply**: they are bound to the draft, and only the form's commit writes.
- **Sync speaks only when it must.** No *Saved on this device* line, no refusal card, no *Changed
  elsewhere*.
- **A shared link opens in a full-screen cover** with its own close button, on the Graph, so another
  person's roadmap never enters the room's own stack. The cover shows no guide.
- **Reset, Detach and Fork ask nothing**; each has *Undo* or is undone by an ordinary act. Only a delete
  asks.
- **The Graph** is for looking and choosing: a tap selects, the foot's bar opens the step. Structure is
  edited in the step form. At every size it draws the web's picture.
- **Left out**, each with its reason on the page's section 13: ceremonies, presence, editing on the
  canvas, keyboard shortcuts and iPad, widgets and App Intents, the weekly reminder switch and the
  all-roadmaps export (both in You), the web demo, a reader's Activity, an author's note on the cover,
  creating a subtree.

## Kept exactly

Derived groups, never dragged. *Needs X · N to go* with *+N*; *Unlocks X* only for steps that this
completion alone opens. Roadmap Order (fewest to go, then most unlocks) and Created newest or oldest;
Done newest completed first. A full swipe never commits. The two-line description excerpt on every Board
row. No Complete on a Locked step, and none on a step that opens a roadmap. Subtasks never complete a
step. Kind names travel with colour; a kind filter never moves progress. At most six kinds, one per hue;
a worn hue cannot be taken and a worn kind cannot be removed. A roadmap keeps one starting step. The
nested rule lines, the guide's 5,000 characters with its counter from 4,500, the fork sentence and the
quests' names and sizes are the web's. Owners land on the Board, readers on the Graph.
