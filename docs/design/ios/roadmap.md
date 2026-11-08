# Roadmap — iOS, wave 1

Status: ✅ Ready for dev · Owner 2026-11-08 for the boards the owner ruled on; 🧪 Proposal for the boards
drawn or changed for the owner's later changes of the same day, until the owner reviews them. Each board's name and caption carry
its status. The boards are on the Roadmap file's
[Roadmap · iOS](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=648-2) page; the
[wave NOTE](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=661-4554) at its top holds the
rulings and the persistence rule. Every caption and section NOTE names the
SwiftUI element of each part.

Roadmap is the third room of the Windmill app, beside Journal and Gym. The model is the approved web
Board's ([proposal](../roadmap-board-proposal.md), [review](../roadmap-board-review.md)); this page
translates its presentation to iOS under the [rendering contract](ios-redesign.md).

| Section | Figma | Holds |
|---|---|---|
| 00 · Read me and map | [`661:4573`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=661-4573) | What the page holds, how to read it, the flow map |
| 01 · Where roadmap lives | [`659:3441`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=659-3441) | Room menu, title menu, first run, New roadmap, a shared link, offline, a step made offline that lands, an offline edit that brings a step back, a load error, iOS 18 |
| 02 · Board | [`652:87`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=652-87) | Sections in one List, swipe to Complete, regroup, Search tab, sort and filter, select several, 5,000 steps, 320 pt, AX5 |
| 03 · Step page | [`654:1681`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=654-1681) | Up next, the workspace, Complete and Reset in place, Locked, Done, the … menu, Delete held with Undo, History, a reader |
| 04 · Graph | [`656:2452`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=656-2452) | The native canvas, selection, Next, pan and zoom, iOS 18 |
| 05 · Create and edit a step | [`658:3076`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=658-3076) | The Form sheet with its commit at the foot, Kind, Prerequisites, Discard draft?, the revealed step, iOS 18 |
| 06 · Left for later waves | [`661:4715`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=661-4715) | Ceremonies, quests and paste, share settings and export, presence and Activity, reminders, widgets and App Intents, canvas editing, iPad |
| 🧩 Components | [`648:26`](https://www.figma.com/design/HM4d8YWzJZg5clVRJKNuDr?node-id=648-26) | The page's symbols, the Board step row, tab bars (iOS 26 and 18), bottom accessory, transient band, section header, graph node |

Boards are drawn at iPhone 17 size (402 × 874 pt): Dark on each section's top row, Light twins below for
the key screens. Fixture: *Learn to sail*, eight steps, and *Coastal navigation handbook*, 5,000 steps,
as in the web proposal.

## Rulings

The owner ruled on 2026-11-08 and accepted every default:

1. Roadmap is the third room, with its own TabView: Board · Graph · Search.
2. The Board's three groups are sections of one List, Up next first.
3. Roadmap is fully offline through a Swift client of roadmap's own graph sync, held to the web by shared
   vectors.
4. Graph layout is a Swift port of the bubble layout, checked against the web's output.
5. The Graph draws with SwiftUI Canvas, with Metal only for speed. It looks and behaves as the web
   renders it at every size: no iOS-only treatment of large roadmaps.
6. The step page is one scroll; History is one row away.
7. The app claims `/t/:id` as universal links, so shared roadmaps open in it.
8. Completing from the Board is the leading swipe only.
9. An offline edit to a step deleted on another device brings the step back, named once in the band, by
   the same rule as creations below.

## A person's own work always lands

Every change is written to the phone first and syncs later, so the network never fails a save. A step
created on the phone is kept on the phone and is added to the tree when it syncs, even if the tree
changed meanwhile. A sync conflict never drops or refuses a person's own creation. If a prerequisite it
names was deleted elsewhere, the edge resplices exactly as a delete resplices — to that step's own
prerequisites — and the step lands in whatever group that makes it. The person is told once, quietly:
the Board's band (*Reefing basics synced · it now follows Name the boat parts*, with Show) and a footer
under the step page's status row. An edit made offline to a step that another device removed brings the
step back the same way, with its edges resplicing past anything removed meanwhile, and the band says so
once (*Reefing basics is back · you edited it while it was removed elsewhere*, with Show). There is no
sync error, no refused-change alert and no Discard. An odd result is the accepted price.

## The room

`AppModel.Room` gains `.roadmap` (title *Roadmap*, symbol `map`); `RootScreen` hosts `RoadmapRoom`
beside `JournalScreen` and `GymRoom`, and the room menu lists it. `RoadmapRoom` is a `TabView` —
`Tab("Board", systemImage: "checklist")`, `Tab("Graph", systemImage: "point.3.connected.trianglepath.dotted")`,
`Tab(role: .search)` — each tab with its own `NavigationStack`. Every stack root carries `RoomMenu`
(`.topBarLeading`) and `RoomAccountButton` (`.topBarTrailing`); the roadmap's name is the navigation
title with `.toolbarTitleMenu` for switching roadmaps, and its progress is `.navigationSubtitle`
(*3 of 8 done*). The Board's bar minimises on scroll; the Graph's never does. The Graph's
`.tabViewBottomAccessory` holds Next (owner), Fork (reader) or the selected step. On iOS 18 the bar is
the classic one, the accessory's content sits in `.safeAreaInset(edge: .bottom)`, and `RoomTitle`
stacks title and subtitle in `.principal`. The Shell's *Where to start?* needs a Roadmap door, drawn in
the Shell file by its owner.

## Board rows

A Board row is the content of a stock `NavigationLink` row: the state symbol tinted by kind (ring Up
next, lock Locked, check Done), the title (`.body`), the reason line (`.footnote` semibold in
`ink-dim`; *Needs X · N to go* or *Unlocks X*, none on Done), and two lines of the authored description
(`.subheadline` in `ink-dim`, `.lineLimit(2)`, truncated with an ellipsis) on every row in every group.
Title and reason wrap freely at every size; the excerpt keeps two lines, checked at 320 pt and at AX5.

## Calm controls

The room keeps one filled control: Complete on an Up next step page, the moment the product exists for.
Every other commit or start — New roadmap, Try again, Create roadmap, Create step, Save, Reset — is
`.buttonStyle(.glass)` with its label in the accent. Kind colours sit on symbols and graph discs, never on
control fills; an arrived or new row's accent-soft wash is shown once.

## Colour roles

Roadmap's grounds and inks are the family palette the web names *Tuscany at midday* by day and the
family night after it — the values `shell/*` already holds — under roadmap's own role names, so the
room can move without moving the shell. The accent is terracotta; the six kind hues are the web's kind
ramp. They bind to the Roadmap file's *iOS · Roadmap roles* collection in Dark and Light.

| Role | Dark | Light | Use |
|---|---|---|---|
| `roadmap/canvas` | `#0B0B0C` | `#F9F5EB` | screen ground, sheet ground, the Graph canvas |
| `roadmap/card` | `#171719` | `#FFFFFF` | list rows, cards |
| `roadmap/raised` | `#222224` | `#FDFBF6` | the search field, the backing of drawn menus and dialogs |
| `roadmap/sunken` | `#050506` | `#F2ECDD` | a well a control sits in |
| `roadmap/line` | `#222224` | `#E5D9C0` | separators, card strokes |
| `roadmap/line-strong` | `#2E2E32` | `#D3C2A0` | a focused field's stroke |
| `roadmap/overlay` | `#030304` at 72 % | `#211B13` at 45 % | the dimming under a sheet or dialog the room draws |
| `roadmap/ink` | `#F2F0EB` | `#211B13` | primary text |
| `roadmap/ink-dim` | `#B4B2AC` | `#6F5F45` | reason lines, subtitles, a Locked step's title, every essential label that is not primary |
| `roadmap/ink-faint` | `#7E7C77` | `#92805F` | non-essential meta only: an unselected selection circle, placeholder text |
| `roadmap/accent` | `#D08A5E` | `#9D5330` | tint: links, selection, the primary fill, Undo, the selected tab |
| `roadmap/accent-soft` | `#D08A5E` at 20 % | `#9D5330` at 12 % | an arrived or new row's one-time wash, the Up next halo on the Graph |
| `roadmap/on-accent` | `#1B1408` | `#FFFFFF` | text and symbols on the accent fill |
| `roadmap/act` | `#9D5330` | `#9D5330` | the Complete swipe action's fill, under the system's white label |
| `roadmap/kind-build` | `#D98B5F` | `#BC6C42` | the Build kind (terracotta): row symbol, graph disc |
| `roadmap/kind-learn` | `#9DAF5C` | `#7D8C43` | the Learn kind (olive) |
| `roadmap/kind-milestone` | `#D9AE45` | `#A17822` | the Milestone kind (gold) |
| `roadmap/kind-brick` | `#C86B50` | `#A84E35` | the unnamed Brick hue |
| `roadmap/kind-sky` | `#7BA6B8` | `#5F8494` | the unnamed Sky hue |
| `roadmap/kind-plum` | `#B06FA6` | `#8D4F83` | the unnamed Plum hue |
| `roadmap/connector` | `#2E2E32` | `#D3C2A0` | a Graph connector from an unfinished step |
| `roadmap/connector-lit` | `#7E7C77` | `#9C6B44` | a Graph connector from a completed step |

A Locked step's disc on the Graph takes its kind's locked tier — fill, ring and centre dot — from the
web's `locked/<hue>-fill`, `-ring` and `-glyph` values, as named roles of this palette when built.
Destructive controls are `role: .destructive` and read in the system red; brick is a kind, never a
warning.

As text, the light accent `#9D5330` measures 5.19:1 on `roadmap/canvas`, 5.65:1 on `roadmap/card` and
5.47:1 on `roadmap/raised`; the dark `#D08A5E` measures 7.01:1, 6.38:1 and 5.66:1; `on-accent` on the
accent is 6.50:1 dark and 5.65:1 light, and white on `roadmap/act` is 5.65:1. Kind colours are never
text. As symbols they clear 3:1 on the card: light 3.68:1 (learn) to 5.87:1 (plum), dark 4.83:1 (plum)
to 8.60:1 (milestone). The light milestone is gold 600 (`#A17822`), not the web's 500, which measures
2.69:1 on white.

## Where iOS differs from the web canon

- **Groups are sections of one List** — Up next · Locked · Done, the doing order — not one column at a
  time behind segments. Done is a collapsed section behind *Show*; the List is lazy, so expanding it
  lists every completed step, newest first, in place of *12, then Show all N*.
- **The kind rail becomes the row's leading symbol**, tinted by kind: a ring for Up next, a lock for
  Locked, a check for Done. One mark carries state and kind.
- **The web's bottom band is gone.** Find is the system search tab, whose field iOS 26 already puts at
  the foot; sort, kind filter and *Select Steps* are one toolbar `Menu`, its symbol filled while
  anything is not default; *New step* is the toolbar `+`. The bottom of the screen holds the tab bar,
  the Board's transient band and, on the Graph, the accessory.
- **Next · N is the Graph's bottom accessory**, in reach, hidden at zero; the same slot shows the
  selected step and a reader's Fork.
- **Roadmaps switch from the title menu** (`.toolbarTitleMenu`), with *All Roadmaps…* past eight.
- **The step page is one scroll**: status, description, Prerequisites, Unlocks, then the private
  workspace (Subtasks, Note, Your links), then *History* as a row. The kind name is the subtitle.
  When every subtask is checked, the Subtasks footer says so and the pinned Complete is the one tap.
- **Forms commit at the foot, in thumb reach**: a full-width *Create step* (*Save* when editing, *Create
  roadmap* for a new roadmap) in `.safeAreaBar(edge: .bottom)`, riding the keyboard; the head keeps only
  ✕, `Button(role: .close)` in `.cancellationAction` (*Cancel* on iOS 18, where the commit is
  `.bordered`).
- **Kind is a pushed picker list** with the legend descriptions, not six inline swatches.
- **The prerequisites picker has no Apply**: it is bound to the draft, and only the form's commit writes. A
  *Selected* section that no query hides replaces the chip strip.
- **Sync speaks only when it must**: *Offline* joins the subtitle; a step made offline that landed in a
  changed tree is named once by the band and a footer. There is no save failure, refused-change alert,
  delete failure or Discard change. *Saving… → Saved* is not shown.
- **Signed out, no device line**: a roadmap kept on the phone shows no *Saved on this device — sign in
  to keep it*; the iOS contract allows no banners, and the account button is the door.
- **A shared link opens in a full-screen cover** with its own close button, so another person's
  roadmap never enters the room's own stack.
- **The Graph drops** its ambient frame loop, ceremonies, presence cursors, minimap, marquee and
  connect/reorder gestures, the dock and the camera pill. It redraws only on change; structure is
  edited in the step form. At every size it draws the web's picture, with no iOS-only level of detail.

## Kept exactly

Derived groups, never dragged. *Needs X · N to go* with *+N*, and *Unlocks X* on Up next only. Roadmap
order and Created newest/oldest; Done newest completed first. A full swipe never commits; only the tap
on Complete does. Board-only bands, one string per event. Complete and Reset in place on the step page,
Undo in the status row, Reset quiet with its preview line. The two-line description excerpt on every
Board row. No Complete on a locked step. The … menu's
*Copy Link · Open in Graph · Delete Step*; delete confirmed once with the cost line, then held nine
seconds with Undo. Subtasks never complete a step. Kind names travel with colour; *filter by kind*,
OR across groups, never moving progress. Multi-select recolours and deletes at equal width. The create
form's fields and placement preview, retained selection, *Comes after this step* and *after …* context.
A dirty draft asks *Discard draft?* once.
Owners land on the Board, visitors on the Graph. Every string is `copy.js`'s.
