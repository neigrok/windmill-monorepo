# iOS redesign — iteration 1

The design contract for the Windmill iOS app (`apps/ios/App`): the shell, the Journal room and the
Gym room, on iOS 26 with Liquid Glass, deploying to iOS 18. It rules how the app renders; the
product contracts it dresses stay where they are — `guidelines/superapp-shell.md` and
`superapp-flow.md` for the frame and the journey, `journal/` for the canvas, `gym/briefs/` for the
room. Where this file and a brief disagree, this file wins on iOS and the disagreement is in
`consistency.md`.

Drawings of record: the Gym file section **iOS redesign · iteration 1 · 2026-10-08** on page `iOS`
and the Design System file sections **7 · Shell chrome** and **2c · Echoes on iOS** on page
`iOS · First run · 2026-09-26` (node ids in §10). Build from §7 in order; each later iteration
reviews screenshots against §11.

---

## 1. Principles

1. **The platform draws the chrome; Windmill draws the content.** Navigation bars, toolbars, tab
   bars, menus, sheets, alerts, lists, pickers, segmented controls, text fields and the keyboard are
   the system's, unmodified. Glass is never imitated: no translucent-white fills, no hairline white
   strokes, no hand-drawn symbol paths. A control that looks like iOS must be iOS.
2. **One palette per room, by role, in one place.** A room's colours are a set of named roles
   (§2) resolved by the system for light and dark. No view declares a hex. No screen carries a
   palette of its own.
3. **Words are chrome and chrome is budgeted.** `guidelines/text-budget.md` holds: 40 words of
   chrome before the decision window closes. A sentence that explains a control is a defect in the
   control. Captions that restate a label, a footer that repeats a heading, an intro that describes
   the screen — all removed.
4. **Say a thing once.** One door per destination, one title per screen, one band for transients,
   one way to reach settings. A fact shown twice on one screen is a structure error.
5. **One primary per screen**, in the reach band (`guidelines/thumb-reach.md`); everything else is
   quiet. A screen without a primary action has no prominent button.
6. **Density is the system's.** List rows, insets, section spacing and large titles are the
   defaults. We adjust content, never the metrics.
7. **Signed out is first class.** Nothing asks for an account outside the three canon places
   (`superapp-flow.md` §5). No banners.
8. **Light and dark are one design.** Every screen is reviewed in both; a room that defines only
   one appearance is unfinished.

## 2. Colour roles

Three palettes, one role vocabulary. Every role is a colour set in `Sources/Theme/Theme.xcassets`
(light and dark appearance values, named `gym/accent`, `shell/canvas`, …) read through one enum
per palette — `GymPalette`, `JournalPalette`, `ShellPalette` — beside it in `Sources/Theme/`, the
folder `project.yml` compiles into both the app and the `WindmillWorkoutActivity` target, the way
`WorkoutActivityShared` already is. The style audit of 2026-10-08
(`.claude/scratch/ios-design/style-audit.md`, Appendix B) maps every one of the 164 literals in
the app to a role below; the refactor follows that map. Deleted: `CoachPalette`
(`Gym/Coach/CoachScreens.swift:25`), `LogPalette` (`Gym/Log/LogPresentation.swift:8`),
`WorkoutPalette` (`Gym/Workout/WorkoutScreen.swift:327`), `RoutineTint`
(`Gym/Routines/RoutinesTab.swift:232`), `WorkoutActivityStyle`
(`WorkoutActivityWidget/WorkoutActivityWidget.swift:127`), `OnboardingPalette`
(`Onboarding.swift:24`, reads `ShellPalette` and the product palettes for its glimpses), the
colour half of `Design` (`Design.swift:5`), `Color(hex:)` outside `Sources/Theme/`, and the
`scheme == .dark ? … : …` branches in views. Onboarding's illustration kind colours
(`OnboardingGlimpses.swift`) stay private to the glimpse as named specimen roles, colour sets
under `onboarding/` in the app's own `Resources/Assets.xcassets`.

**Tint.** The room accent is applied by the one page modifier (`GymPage`, §5) to the content of
each tab's `NavigationStack` and to every sheet the room raises — never to the `TabView`
(`GymRoom.swift:39` today). The tab bar's selection is the system's; the room supplies only the
symbol (`gym/briefs/12-native-idiom.md`, "A native tab bar's selected state").

### Gym — verdigris on verdigris-grey stone

| Role | Dark (Instrument) | Light (Daylight) | Use |
|---|---|---|---|
| `gym/canvas` | `#0B1111` | `#EBE7E3` | screen ground, sheet ground |
| `gym/card` | `#161C1D` | `#F8F6F4` | list rows, cards, the rack panel, composer |
| `gym/raised` | `#202627` | `#DFDAD5` | ladder keys, secondary buttons, chips, input fields |
| `gym/sunken` | `#060C0C` | `#DFDAD5` | a well a control sits in (chart plot, segmented track) |
| `gym/line` | `#202627` | `#D0CAC5` | separators, card strokes, chart grid |
| `gym/line-strong` | `#2A3133` | `#B6AFA9` | a focused field's stroke, the rack panel's edge |
| `gym/overlay` | `#030606` at 72 % | `#1A1918` at 45 % | the scrim under a sheet the room draws itself |
| `gym/ink` | `#F1F0EB` | `#1A1918` | primary text, numerals |
| `gym/ink-dim` | `#B6B5AF` | `#4C4744` | secondary text, facts, every essential label that is not primary |
| `gym/ink-faint` | `#727771` | `#625C58` | non-essential meta only: axis labels, planned rows, `+ 1 more` |
| `gym/accent` | `#5FCDB4` | `#137A6C` | tint: links, selection, the primary fill, chart dots, the current-set dot |
| `gym/accent-soft` | `#5FCDB4` at 16 % | `#137A6C` at 12 % | the lifter's bubble, a selected row's wash |
| `gym/on-accent` | `#1B1408` | `#FFFFFF` | text and symbols on the accent fill |
| `gym/done` | `#9AA859` | `#7D8C43` | a logged set's check, and nothing else |
| `gym/record` | `#D9B04C` | `#6E5217` | a personal record, and nothing else |
| `gym/alarm` | `#D08268` | `#A84E35` | destructive labels, refusal text in a field |
| `gym/alarm-fill` | `#A84E35` | `#A84E35` | a destructive swipe action's fill; `on-alarm` is white |

These are the Gym Figma `Gym · Colour` ramp values (`surface/*`, `text/*`, `border/*`,
`state/*`) with one ruling: the light accent is verdigris day `#137A6C`, as the owner decided for
the family on 2026-09-06 and as the decided onboarding boards draw it, not the Figma Daylight
`brand/base` alias to iris `#4C4374` (`consistency.md` F44). Gold is a *record*, never a warning;
brick is destructive only.

The Live Activity uses `gym/accent` and `gym/on-accent` for its one button and `gym/accent` for
the keyline; the banner ground stays the system's.

### Journal — lamp on ink

| Role | Night | Day (iteration 2) |
|---|---|---|
| `journal/canvas` | `#0B0E16` | `#F7F7F5` |
| `journal/card` | `#161921` | `#FFFFFF` |
| `journal/sunken` | `#060910` | `#E9EAEC` |
| `journal/line` | `#20232B` | `#D8DBE0` |
| `journal/line-strong` | `#2B2E38` | `#BCC2CB` |
| `journal/overlay` | `#03050A` at 72 % | `#161E28` at 45 % |
| `journal/ink` | `#F1F0EC` | `#161E28` |
| `journal/ink-dim` | `#B6B5B0` | `#4E5968` |
| `journal/ink-faint` | `#737476` | `#5E6979` |
| `journal/lamp` | `#E0B972` | `#986B1E` |
| `journal/lamp-soft` | `#E0B972` at 18 % | `#986B1E` at 12 % |
| `journal/energy` | `#9AA859` | `#7D8C43` |
| `journal/mood-*` | the eleven-step ramp in `Design.moodRamp` | `scales.md` |

Journal renders night in both appearances in iteration 1 (`WindmillApp.swift:34` forces `.dark`
on the Journal room and on Where to start?). The Day column is the web's journal day ramp — paper
in north light with cool ink (`web/src/styles/tokens/palettes.css`, `[data-theme="light"][data-brand="journal"]`)
— and is the contract for iteration 2, when Appearance arrives in You and the room answers light
with paper. The onboarding glimpse's warm day inks (`OnboardingGlimpses.swift:96-97,168-170`)
move to these values then.

### Shell — clay

You, Keep and every sign-in step, Where to start?, onboarding and the launch ground.

| Role | Dark | Light |
|---|---|---|
| `shell/canvas` | `#0B0B0C` | `#F9F5EB` |
| `shell/card` | `#171719` | `#FFFFFF` |
| `shell/raised` | `#222224` | `#FDFBF6` |
| `shell/sunken` | `#050506` | `#F2ECDD` |
| `shell/line` | `#222224` | `#E5D9C0` |
| `shell/line-strong` | `#2E2E32` | `#D3C2A0` |
| `shell/overlay` | `#030304` at 72 % | `#211B13` at 45 % |
| `shell/ink` | `#F2F0EB` | `#211B13` |
| `shell/ink-dim` | `#B4B2AC` | `#6F5F45` |
| `shell/ink-faint` | `#7E7C77` | `#92805F` |
| `shell/brand` | `#D08A5E` | `#BC6C42` |
| `shell/on-brand` | `#1B1408` | `#FFFFFF` |
| `shell/danger` | `#BF6A50` | `#A84E35` |

The shell follows the system appearance in both rooms. You is clay whatever room opened it
(`superapp-shell.md` §6): opened from Gym in light it is clay light, never `systemBackground`
with a verdigris tint (`AccountSheet.swift:21-27` today). Where to start? draws each door in its
room's accent: the Gym door's symbol and arrow are `gym/accent`, not `shell/brand`
(`WindmillApp.swift:130,135`).

### What never happens

- A hex in a view file. A `Color(hex:)` call outside `Sources/Theme/`.
- A role chosen by appearance in a view (`scheme == .dark ? … : …`): the asset resolves it.
- `.systemGroupedBackground`, `.secondarySystemBackground` or any UIKit semantic ground inside a
  room; the room's canvas and card are the grounds. System *label* colours are fine where the
  system draws the text (toolbar titles, tab labels, menus, alerts).
- A second accent. Olive, gold and brick are states, not accents.
- `.red` for a refusal (19 sites today): a refusal is `ink` in the transient band or `alarm` in
  the field it belongs to.
- `ink-faint` on an essential label — it is below 4.5:1 on both night canvases
  (`guidelines/system-architecture.md`, the grandfathered tertiaries).
- `.black` or `.white` as a CTA foreground (`LogTab.swift:35`, `BodyweightScreen.swift:278`,
  `SessionDetailScreen.swift:170`, `SessionShareSheet.swift:236`): it is `on-accent`. Apple's own
  control (Sign in with Apple) keeps its black and white.

## 3. Type ramp and spacing

### Type

Everything that is prose or a label takes a system text style and scales with Dynamic Type. The
ramp, by role:

| Role | Style | Notes |
|---|---|---|
| Root title | `.largeTitle` via the navigation bar | Routines and The log only; Coach and every pushed screen are inline |
| Pushed/sheet title | the inline navigation title | never a drawn heading repeating the bar |
| Subtitle | `.navigationSubtitle` (iOS 26) | the date of a session, the routine under a receipt |
| Row title | `.body` | semibold only when the row has a subtitle |
| Row subtitle | `.subheadline`, `ink-dim` | |
| Fact / meta | `.footnote` with `.monospacedDigit()` | never `.monospaced()` on prose |
| Eyebrow | `.caption` uppercase, `ink-faint`, no manual tracking | |
| Section header | the list's own header | sentence case |
| Prose (Coach answers) | `.body` | headings in an answer `.headline` |
| Big numeral (rack, keypad, record) | `.system(size: 68, weight: .bold, design: .rounded)`, `@ScaledMetric(relativeTo: .largeTitle)`, cap 92 | reflows vertical at accessibility sizes |
| Keypad echo | the same at 60, cap 84 | |
| Brand display | Nunito ExtraBold 34 / 28 | Where to start?, You, Keep, onboarding — never inside a room |
| Journal body | Inter 17, line spacing 7 | the one custom body face |
| Journal date | JetBrains Mono 11, tracking 0.7 | |
| Ink notes | Caveat 24 | |

Monospaced digits on every numeral that changes while shown (clocks, weights). The monospaced
*face* is reserved for the journal date line and gym read receipts.

The ramp is the public API: `Design.text(_:)`, `.strong(_:)`, `.title(_:)` and `.mono(_:)` with
an arbitrary size (`Design.swift:18-22`, 99 call sites) are replaced by named roles
(`ShellType.title`, `.body`, `.meta`, `JournalType.body`, `.date`, `.hand`), each with one size
and one `relativeTo`. A screen cannot ask for a size.

### Spacing

4-pt base: 4 · 8 · 12 · 16 · 20 · 24 · 32. Screen gutter 16 (`List` insets as the system draws
them). Card radius 16, sheet corner radius the system's (never `presentationCornerRadius`), pill for
buttons and chips. Minimum target 44 × 44. The rack panel pads 16, radius 20 on its top corners.
Compliance frame 393 × 852 (iPhone 17); checked at 375 × 667 and at the largest accessibility size.

## 4. Toolbars and buttons

### The top bar on every room root

```
[ Gym ⌄ ]                              [ + ] [ ◯ ]
```

- **Top-left: the room menu.** A `ToolbarItem(placement: .topBarLeading)` holding a native
  `Menu`. Its label is `Text(room.title)` in `.body.weight(.semibold)` followed by
  `Image(systemName: "chevron.down")` at `.caption.weight(.semibold)`, 6 pt apart. No modifier on
  the label: on iOS 26 the toolbar lays it in its own Liquid Glass capsule; on iOS 18 it is a
  plain bar button. The menu's content is the inline `Picker` of rooms with the current room
  checked, then **You** (`person.crop.circle`) after a `Divider()`, then the room's one item if it
  has one (Journal: **Show ink notes**) — `superapp-shell.md` §3.
- **Top-right: the account button.** `ToolbarItem(placement: .topBarTrailing)` holding
  `Button { } label: { Image(systemName: "person.crop.circle") }` with the accessibility label
  *You and settings*. The system symbol, default rendering, no custom shape. It sits last; on
  iOS 26 a `ToolbarSpacer(.fixed)` separates it from the room's own actions so it stands in its own
  glass circle and the room's actions share theirs.
- **The room's own actions** come before the account button: Routines `plus`
  (*New routine*); Coach `ellipsis.circle` (*More*); The log none; a pushed screen draws its own.
  Build 12 draws them the other way round on Coach (account, then More) and lets the account
  glyph paint its own disc inside the capsule the system already gives the pair — the
  "half-filled" look. Order is actions then account, and nothing is painted inside a toolbar item.
- **Deleted:** `Glass` (`Design.swift:29`), `YouGlyph` (`Design.swift:48`), the custom
  `RoomSeat`/`AccountButton` chrome (`WindmillApp.swift`, `modifier(Glass…)`), the glass `Done`
  and round buttons in `AccountSheet.swift:42,361`, the glass *Keep it* in `JournalScreen.swift:174`.
  Nothing in the app draws a white-alpha fill or stroke.
- **Journal gets a `NavigationStack`** so its bar is the system's: a visible bar filled
  `journal/canvas` with `.toolbarColorScheme(.dark)`, so it reads as the night canvas and past pages
  scroll beneath it instead of under the bar's items; no title, the room menu and account button as
  above. The ink notes anchor to the toolbar items' frames (`onGeometryChange` inside the labels).
- Symbols in bars render monochrome at the bar's default weight. No `.fill` variants in bars;
  `.fill` is for a selected tab only.

### Buttons

| Kind | iOS 26 | iOS 18 fallback | Where |
|---|---|---|---|
| Primary | `.buttonStyle(.glassProminent)`, `.controlSize(.large)`, full width, tint `accent`, label `on-accent` | `.borderedProminent` | one per screen, in the reach band |
| Secondary | `.buttonStyle(.glass)` | `.bordered` | ladder keys, chips, Previous/Next |
| Quiet | `.buttonStyle(.plain)` in `accent` | same | row actions, *Not now*, *Use email instead* |
| Destructive | `role: .destructive` in a Menu or list row | same | never a prominent fill |
| Seat | a 44 pt glass circle with one symbol, bottom-trailing, 16 pt from the edges | material circle | Journal *Write*, The log *Weigh in* |

A primary pinned above the tab bar floats: `safeAreaInset(edge: .bottom)` with 16 pt padding and
**no opaque bar behind it** (`background(.bar)` goes, `RoutinesTab.swift:171`,
`MovementPicker.swift:187,338`, `RoutineTargets.swift:311`). The content scrolls under it
through the glass.

CTA copy is at most three words: *Just start logging*, *Start workout*, *Log set · 100 × 5*,
*Save routine*, *Share with Coach*, *Keep this log*, *Weigh in*, *Save the fix*, *Set*.

### The tab bar

The system `TabView` with the `Tab` API, `.tabBarMinimizeBehavior(.onScrollDown)` on iOS 26.
Routines `list.bullet.rectangle` · The log `calendar` · Coach `bubble.left.and.bubble.right`.
No tint on the `TabView`: the system draws the selection, the room supplies the symbol
(`12-native-idiom.md`). Hidden on every pushed screen and sheet (as today).

## 5. Menus, sheets and transients

### Menus

- A **More** affordance is always `ellipsis.circle` in the toolbar presenting a native `Menu`.
  `confirmationDialog` is never used as a menu (`CoachTab.swift:87`, `RoutineTargets.swift:410`).
- Menu sections are `Section`s; destructive items last with `role: .destructive`; the current
  state is a checkmark, never a label.
- Row-level choices are `.contextMenu` and `.swipeActions` (kept as they are).

### Confirmations

- A destructive act with one consequence is a `.alert` with the act as its destructive button
  and Cancel (*Turn this down?*, *Sign out?*, *Remove Apple?*). The `UIAlertController` action
  sheet in `AccountSheet.swift:382` becomes `.confirmationDialog` presented from the row that
  asked, title visible; SwiftUI anchors it to its source on iOS 26.
- Nothing asks twice except Discard at sign-in (`superapp-flow.md` §6).

### Sheets

Every sheet is a `NavigationStack` with an inline title, a `.cancellationAction` (*Cancel* or
*Close*) or `.confirmationAction` (*Done*, *Save*), the room's palette, and a detent fitted to its
content:

| Sheet | Detent | Bar |
|---|---|---|
| Keypad | `.height(440)` | *Cancel* · title *Weight · kg* / *Reps* |
| Weigh in | `.medium` | *Cancel* · *Save weight* pinned |
| Rename movement, Share this workout | `.medium` | *Cancel* / *Close* |
| Fix set, This session, Heavier than the plan, Note, Review, Finish | `.large` | as today |
| You, Keep, sign-in steps | `.large`; Keep and the Apple questions `.medium` | *Done* / *Close* via the toolbar |

`presentationDragIndicator(.visible)` only where the bar carries no dismissal.
`presentationCornerRadius` is never set (`AccountSheet.swift:71`). A pinned primary inside a
sheet uses the same floating rule as a screen.

### Shared components

The room draws each of these once, in `Sources/Gym/Components/` (or `Sources/Theme/` when
product-neutral), and every feature uses the one. Each collapses a duplication the style audit
demonstrated (§6 there):

| Component | Replaces | Owner |
|---|---|---|
| `GymPage` modifier — canvas, hidden scroll background, tint, inline/large title | `CoachPage` (`CoachScreens.swift:32`), `WorkoutAppearance` (`WorkoutScreen.swift:342`), the inline chains in `LogTab.swift:30`, `RoutinesTab.swift:232` | Gym |
| `RoomTransient` (below) | four notice bands | Theme (shape), Gym (adapter) |
| `ActionBand` — the one floating primary, with its optional one-line footer, disabled and busy states | `RoutineActionBand` (`RoutinesTab.swift:165`), the bands in `RoutineTargets.swift:304`, `MovementPicker.swift:330`, `CoachHistory.swift:141`, `WorkoutSheets.swift:138`, `BodyweightScreen.swift:276` | Theme |
| `WeightInstrument` — the big numeral, unit, four-key ladder, accessibility reflow | `WorkoutScreen.swift:283`, `WorkoutSheets.swift:96` | Gym |
| `SetEditor` — weight, reps, effort, note, Kind (segmented), delete; validation and its refusal text; the note's byte counter only from 3,200 bytes (the finished-set sheet shows *16 / 4000 bytes* today) | `FinishedSetFixSheet` (`SessionDetailScreen.swift:118`), `WorkoutFixSheet` (`WorkoutSheets.swift:81`) | Gym |
| `RenameMovementSheet` — one sheet, `.medium`, the name field, a counter only from 48 characters, and one help line: *Renames it everywhere; the old name still finds it.* (the three explanatory rows in `MovementRecordScreen.swift:148–150` go) | `LogRenameSheet` (`MovementRecordScreen.swift:128`), `RenameMovementSheet.swift:23` | Gym |
| `MovementRow` — title, one meta line, optional trailing fact or check | `RoutineBuilder.swift:99`, `RoutinesTab.swift:129`, `MovementPicker.swift:252`, `WorkoutSheets.swift:170` | Gym |
| `FactTiles` — up to three value-over-label tiles | the receipt's `fact(_:_:)` (`WorkoutReceipt.swift:242`), session detail's head, the record screen's tiles | Gym |
| `RoomDoor` — the Where to start? card, given a title, line, symbol, accent and ground | the two cards in `WindmillApp.swift:113,128` | Shell |
| `IdentityRow`, `FactRow`, `DoorRow` in You | the custom rows in `AccountSheet.swift:308,315,358` | Shell |

Empty states are `ContentUnavailableView` for a whole screen and one secondary line for an empty
section; no third shape.

### One transient band

The room has one component, `RoomTransient`, for refusals, notices, Undo and copied-link
confirmations: a single-line `.footnote` message on `gym/card`, radius 16, with at most one
trailing action (*Undo* · *Try again* · *Dismiss* as `xmark`), floating in the reach band above the
primary, honouring the delete window (`gym/briefs/13-gestures.md`). It replaces `RoutineNotice`
(`RoutinesTab.swift:205`, list sections in red), `LogNoticeBand` (`LogPresentation.swift:151`),
`CoachNoticeBand` (`CoachScreens.swift:39`), the share message section (`LogTab.swift:125`) and the
message rows of `WorkoutNotice` (`WorkoutScreen.swift:351`). Refusal text is `gym/ink`, never
red: the band is the signal. `WorkoutAdoptionBand` (`GymWorkoutAdoption.swift:15`) keeps its
own place as a card at the head of Routines, with its three sentences cut to one: *A signed-out
workout is on this phone · 12 sets · Push A* and the one button *Keep as finished workout*.

## 6. Coach, decluttered

The conversation is the content; everything else is chrome, and the chrome is the bar, the
composer and one menu. Signed in with routines, an empty Coach shows the bar, an empty canvas
and the composer — nothing else (`gym/feedback-contract.md` "Coach conversation").

**Removed from `CoachTab.swift`:**

| Today | Line | Why |
|---|---|---|
| The pinned *Notes · what you write for Coach ›* row above the conversation | 29 | a destination drawn as a banner; Notes lives in More and Gym settings |
| *Ask about your training. Coach can create routines and propose changes — you decide on the diff.* and *Every conversation is kept so you can read it back, and yours to delete.* | 40–41 | capability text; the composer placeholder already says it |
| *Ten questions a day, three back to back.* under every composer | 138 | a limit stated when no limit is in the way (`09-coach.md` "Limits are contextual") |
| The *Done* row above the composer | 143–152 | the keyboard's own accessory bar carries Done |
| *Account* in More, and *Open You and settings in the top bar.* | 93, 71 | the account button is already in the bar |
| *Gym settings* in More | 90 | settings are reached from You |
| The bordered *Jump to latest* text button | 77 | replaced by a 36 pt glass circle with `chevron.down`, bottom-trailing above the composer |

**The More menu** (`ellipsis.circle`, trailing, before the account button) is a `Menu`:

```
New chat                 (only while a conversation exists)
─────
History
Notes
Connected log
```

**The composer** is one capsule on `gym/card`: `photo.badge.plus` (44 pt, leading, quiet) ·
the field *Ask about your training* (1–5 lines) · the send button, a 36 pt circle filled
`gym/accent` with `arrow.up` in `on-accent`, swapping to `stop.fill` while Coach answers. A chosen
photo shows as a 56 pt thumbnail above the field with an `xmark.circle.fill` on its corner, not a
*Remove photo* text button. The byte-limit refusal appears in the transient band.

**The lifter's turn** is a right-aligned bubble on `gym/accent-soft`, radius 18, max width 78 %.
**Coach's turn** is plain prose on the canvas, no bubble, 16 pt gutter. Markdown headings
`.headline`; code `.body.monospaced()`.

**The read receipt** under an answer is one `.footnote` row in `ink-dim`: *read 214 sets · 6
weeks · 18 sessions* with a trailing `chevron.right`. It is a door to a sheet *What Coach read*
listing the sources as rows (routine · date · sets · tonnage), each a door to the workout. No
`DisclosureGroup` in the conversation; no nested disclosures.

**A proposal card** on `gym/card`, radius 16, 1 pt `gym/accent` stroke:

```
PROPOSAL · PUSH A                        (eyebrow, accent)
Bench is stalling at five reps, not at load. …   (body)
Bench Press      5 × 5 → 5 × 3           (fact rows, up to 3, then "+ 1 more")
Incline Press    added · 3 × 10 · 24
Review 4 changes ›                       (one accent row, the door)
```

The *still waiting / turned down / applied* state is a trailing caption on the Review row, not a
line of its own; the promise sentence lives only in the Review sheet's band. A created routine is
one row *Open routine · Push A ›* with `list.bullet.rectangle`.

**Signed out** the room shows the canon sentence *Coach reads your log, so it needs you signed
in.* centred in the middle band with one quiet *Sign in* under it and no composer — until the
phone allowance ships, when `09-coach.md` applies.

**The Review sheet** (`ProposalReview.swift`) keeps its diff cards and its scroll-to-the-end
Apply. *proposed by Coach · 26 Sep 18:42* becomes the sheet's subtitle; the label *Coach wrote:*
goes (the quote bar is the attribution); *Ask Coach* is a quiet accent button under the cards;
the band drops the explanatory sentence under Apply when Apply is enabled (the label *Apply all
4* says it) and draws *Turn this down* in `gym/alarm`, not system red.

**History** (`CoachHistory.swift`) is a plain list of conversation rows — question, state
caption, date — each the door to its conversation. The sentence *Deleting a conversation keeps
applied routine changes, created routines and saved notes.* leaves the screen and becomes the
transient after a swipe-delete, beside its Undo. The pinned *Ask something new* goes: Back returns
to the composer.

**Notes** drops the second heading line *what you write for Coach* and keeps the one fact *Any
agent you connect can read these too.* (`10-notes.md`). **Gym settings** (`CoachScreens.swift:76`)
loses its *Account* row and the hint, and loses the Units picker until the phone draws lb: a
control whose footer says *This phone still draws kg.* is a control that does nothing here.
Gym settings is then *Notes*, *Connected log* and, when a workout is hidden, *Restore workout*.

## 7. Per-screen changes, in priority order

Each item is a buildable unit. Cite this section by number in the build log.

### 7.1 Shell chrome (§4) — every room root, Journal included

Native toolbar items for the room menu and the account button; delete `Glass`, `YouGlyph` and
every `modifier(Glass…)`; Journal in a `NavigationStack`; the You/Keep/sign-in sheets' *Done*,
*Close* and *Back* become toolbar items. Both appearances.

### 7.2 One palette per room (§2)

`Sources/Theme/` with the three palettes as asset-catalogue roles, compiled into the app and the
widget; delete the four gym palettes, the Live Activity's own accent and the colour half of
`Design`; `GymPage` carries the tint, the `TabView` none; no `scheme == .dark` branches;
`.systemGroupedBackground` gone from Coach, Notes, Settings, Connected log and Review. Light Gym
is pietra, not iOS grey. The Workout rendering tests that pin the divergent values
(`Tests/Gym/Workout/WorkoutRenderingTests.swift:211`) pin the roles instead.

### 7.3 Coach (§6)

Menu instead of the dialog; the seven removals; the composer; the receipt row; the card.

### 7.4 `RoomTransient`, `ActionBand`, `GymPage` (§5)

One band, every tab and the workout; red text gone from lists. The floating primary and the page
modifier land in the same change, since every tab's bottom and ground change with them. The other
shared components (§5) follow as each screen in 7.5–7.11 is touched.

### 7.5 Routines

- The signed-out section *Your log is saved on this device … Sign in* (`RoutinesTab.swift:48–53`)
  is removed: a banner (`superapp-flow.md` §5). The sign-in offer is the Keep row under a routine
  Coach created and *Keep this log* on the finish receipt.
- A routine row is two lines: the name (`.body.semibold`) and *4 movements · trained 3 days ago*
  (`.subheadline ink-dim`; *never trained*). The two movement names go. A waiting proposal is a
  trailing accent caption *1 proposal* on its row, not a button inside the row.
- The proposal section at the top is one row: *1 proposal* / *from Coach · today 18:42* with a
  chevron; the row is the door. The *Review changes* line goes. Settled removal receipts stay as
  one row each.
- *Movements* is the last row of the list as a `NavigationLink` with `list.bullet` and a chevron
  (a door, not a `Button`).
- Empty: `ContentUnavailableView("No routines yet", systemImage: "list.bullet.rectangle",
  description: Text("Build one, or just start logging."))`.
- The primary *Just start logging* floats (§4). Large title, `plus` and the account button in
  the bar.
- Routine detail: the sentence *Open movements have no target — you decide the numbers at the
  rack.* is the Movements section's footer, not a card of its own (`RoutinesTab.swift:135`);
  History rows read *1 working set · 1 movement* with real plurals; the detail's canvas is
  `gym/canvas`, not the system's grouped grey (the root list is on pure black in dark today).
- `RoutineMovementDoor` (`RoutinesTab.swift:176`) goes: a movement row in routine detail opens
  the Record screen directly, which already carries the equipment, Rename and the last sets.
  Three one-row cards (*Barbell · Rename movement*, *Open record ›*, *Last time · Never logged*)
  are not a screen.
- The movement picker's rows are the two-line `MovementRow`: the name, then *Barbell · last
  80 × 5 · 3 days ago* or *Barbell · never logged* in `ink-dim`; the third mono line goes
  (`MovementPicker.swift:252–259`). *Create movement* stays the pinned primary.

### 7.6 The log

- **Phones weave; the strip goes.** The movement strip (`LogTab.swift:74`) and the woven moments
  draw the same facts twice. iOS keeps the woven timeline the owner chose for Android
  (`18-progress.md`; moments `.best`, `.month`, `.weight` at `LogTab.swift:131–138`) and deletes
  the strip and the horizontal scroll inside the list. The Record stays reachable from every
  movement row on a session.
- The head is one section: *Bodyweight* · *82.4 kg · 3 days ago* › and, as its footer, the
  consistency sentence *Trained 3 of the last 4 weeks* when it exists. The footer *Coach can read
  this. It can never write it.* (`LogTab.swift:57`) leaves this screen; it stays on Bodyweight.
- A session row is two lines and a trailing date: the name, then *18 working sets · 1 h 03 m*
  (`.footnote` monospaced digits), the day label right-aligned in `ink-dim`; a record is a
  `gym/record` dot after the name, and the record fact is the row's second line instead of the
  duration. *On this device* becomes an `iphone` symbol at the trailing end, not a third line.
- *Weigh in* is the room seat: a 44 pt glass circle with `scalemass`, bottom-trailing, label
  *Weigh in* (§4). The full-width prominent button (`LogTab.swift:33–38`) goes.
- An expanded moment (`LogTab.swift:178–196`) is the compact chart, its window line and the
  *Open record* door — three rows. The *heaviest* and *best e1RM* rows go: the moment's own
  line already says the best, and the Record screen says the rest.
- Older sessions load when the last row appears; the *Load older* button (`LogTab.swift:117`)
  becomes a `ProgressView` row, and a failed read a *Try again* row.
- Large title *The log*; no room actions in the bar.
- The Record screen (`MovementRecordScreen.swift`): the equipment is the subtitle under the
  movement name, not a one-word card; *Best e1RM* and *Heaviest* are two `FactTiles` side by
  side, not two full-width cards; *Rename* moves into an `ellipsis.circle` menu with *Rename
  movement*, so the bar holds one symbol. Facts and axis labels keep monospaced digits in the
  text face, not the monospaced face (`LogTab.swift`, `MovementRecordScreen.swift`,
  `SessionDetailScreen.swift` set `.monospaced()` on prose-length facts today).

### 7.7 Workout

- The horizontal slot strip (`WorkoutScreen.swift:170–186`) and the *Last time ·* section
  (`:189–193`) go: the vertical ledger already carries every set's state, and history prefills
  the rack (`16-the-workout.md`).
- The rack has no kind picker (`WorkoutScreen.swift:309–320`): a new set is Working, as on web
  and Android; the Fix sheet keeps *Kind* as a segmented control (warmup · working · drop ·
  failure).
- The rack is a panel on `gym/card`, top radius 20, padding 16: numeral row (`68` rounded bold ·
  *kg* `.title3 ink-dim`), four glass ladder keys, the reps row (`minus` · *5 reps* `.title3` ·
  `plus`), then *Log set · 100 × 5* prominent. Previous/Next are 44 pt glass circles beside the
  movement name; *Movement 1 of 2* is the eyebrow above the name; the plan line *plan 4 × 5 @ 100*
  sits under it in `ink-dim`.
- The clocks are one `.footnote` line under the plan: *32:10 · 1:37 since last set*.
- An unsent set is marked once: the trailing `iphone` symbol on its row (as in the log, 7.6).
  The caption *on this device* under every row and the banner *3 sets are saved on this device
  only.* (`WorkoutScreen.swift:212,370`) say the same thing three times; both go.
- The bar: *This session* as `list.bullet` leading, *Finish* trailing, title the routine name,
  subtitle the start time (`.navigationSubtitle`).
- The *This session* sheet drops its section header *3 sets logged* (`WorkoutSheets.swift:185`):
  each row already carries its count. *Hide workout* keeps its one-line footer.

### 7.8 Session detail

- Title the routine name; subtitle *Tue 18 Aug · 18:12 – 19:15*. The head section becomes three
  tiles: Duration · Working sets · Volume. *Plan saved at start* (`SessionDetailScreen.swift:31`)
  goes; *Closed after four hours without a set* stays as a footer when true.
- *Share this workout* is `square.and.arrow.up` in the bar; *Discard workout* is the only item of
  an `ellipsis.circle` menu, destructive. The bottom section (`:70–73`) goes.
- Set rows keep tap-to-fix and swipe-to-delete; a set row is *1 · 100 × 5* with the comparison
  as its trailing caption (*+2.5 over plan*), effort and note as a second line only when present.

### 7.9 Finish receipt

- Title *Well done.* / *Ended early.* (`16-the-workout.md`), subtitle *Push A · Tue 18 Aug* or
  *Free session · Sat 26 Sep*; the title row inside the list (`WorkoutReceipt.swift:174`) goes
  (`consistency.md` 6o).
- Three `FactTiles`: Duration · Working sets · Top e1RM (when any), then *Personal record* in
  `gym/record` on its own card, then *Performed*, then *Against plan* / *Against last Push A*.
  The inline *4 Sets · 1600 kg · 1 Movements* row and the lone *1m* line go.
- The one full-strength button is pinned in the reach band at full width: *Share with Coach*
  signed in, *Keep this log* signed out, with its one-line footer. Today *Keep this log* is a
  small pill inside a list row (`WorkoutReceipt.swift:212`). *Save as routine* is a card beneath
  the tiles: name field, then *Save routine* as a secondary glass button; *Kept as Tuesday.*
  replaces the card on success.
- *Done* in the bar; no drag indicator.

### 7.10 Sheets (§5)

Detents and dismissals per the table; `presentationCornerRadius` removed; keypad at
`.height(440)`; Weigh in `.medium`.

### 7.11 You, Keep and sign-in (§2 shell)

- You is a native `List` (`.insetGrouped`) in a `NavigationStack`, title *You*, *Done* trailing,
  on clay in both appearances. Sections as the canon boards: the identity card (avatar or
  `person.crop.circle`, name or *Not signed in*, state line, then the Apple and email doors);
  **On this phone** (*Journal · 3 pages*, *Gym · 3 routines · 1 workout*) or **How you sign in** and
  **Your data**; **Settings** (*Gym settings* ›, *About Windmill* ›); *Sign out* / *Erase data* last,
  destructive. The sentence *One Windmill account keeps your journal and training together.*
  (`AccountSheet.swift:270`) goes.
- Keep, the Apple questions, the email and code steps keep their layout; their headings stay
  Nunito; their buttons follow §4; *Back* and *Close* are toolbar items.
- The doors are Apple and email (`superapp-flow.md` §6). *Use a sign-in link*
  (`AccountSheet.swift:162`) leaves You and Keep; it stays only on the code step, for someone
  holding a link.
- Appearance (Light · Dark · System) is iteration 2, with Journal's day palette.

### 7.12 Where to start? and onboarding

Unchanged in iteration 1 except the shell palette roles, the Gym door in `gym/accent`, the
`RoomDoor` component and the system *Sign in* link style — and the appearance: Where to start?
follows the system like the rest of the shell (`WindmillApp.swift:34` forces it dark, so the
light build opens on a black screen and then a light room).

### 7.13 Journal room

- The chrome follows 7.1; the write seat and its *Done writing* swap follow the seat rule (§4).
- A past day's scale line (`JournalScreen.swift:30`) draws only what was set — *Mood 7 ·
  Energy 4*, or *Mood 7* alone — and nothing when neither was. *Mood – Energy –* under every
  unscored page is noise the canvas never draws (`journal/journal.md` §4, "a day you didn't write
  is not drawn").
- Night in both appearances until iteration 2 (§2).

### 7.14 Echoes on iOS (§8)

Built when the port lands; drawn now.

## 8. Echoes on iOS

Journal's echoes (`journal/journal.md` §6) on the native canvas, translating the web's edge tab,
page ink and reader (Journal Figma boards 40/41 and 59/60) into the room's own controls.

- **The tab.** When a day holds passages written before, its date line ends with a lamp count:
  `SAT 26 SEP · 20 WORDS · saved` … `3` — the count in JetBrains Mono 11 inside a 22 pt capsule
  filled `journal/lamp-soft`, ink `journal/lamp`, trailing-aligned on the date row. Its
  accessibility label is *3 passages you wrote before*. No count, no capsule.
- **Arrival.** A new echo kindles the capsule from `lamp-soft` to `lamp` at 40 % over 1200 ms,
  ease-out, once, while the row is on screen; no haptic, no sound, no badge elsewhere. Reduce
  Motion: a 200 ms fade.
- **The ink.** Tapping the capsule opens the page's ink *below the page's body, pushing what is
  under it down and never moving the text above*: up to two passages, each a row of a mono date
  stamp (`14 MAR / 2026 / 5 MO`, three lines, 48 pt column, `ink-faint`) beside the older words in
  `journal/lamp`, Inter 17. Under the last passage, *Useful · Not useful* as two quiet `.footnote`
  buttons, and when more remain, one row *8 more* › that opens the reader. Tapping the capsule
  again, or anywhere outside the ink, closes it. Only one day's ink is open at a time.
- **The reader.** A `.sheet` with `.medium` and `.large` detents, title *From your journal*,
  *Close* trailing, listing every passage for that day as the same rows, grouped by year. Tapping a
  passage flies the canvas to that day and closes the sheet.
- **First echo, once.** The first echo an install ever receives shows a card above the ink the
  first time it opens: *From your journal* · *Older lines that echo what you wrote today. Only
  you see them; they cost nothing.* · *Got it*. Never again.
- **While writing**, no tab draws on today's row and no ink opens; a tab that was open closes when
  the keyboard rises.
- **Never**: a count on the room menu, a notification, a red dot, an unread total.

## 9. Known drift this spec creates or closes

Recorded in `consistency.md` under *iOS*: 9a (light gym accent vs Figma Daylight `brand/base`),
9b (phones weave, web keeps the strip), 9c (the rack's kind picker leaves iOS), 9d (two gym light
grounds in the Design System collections), 9e (the first-run boards' W capsule and hand-drawn
glass), 9h (the journal day inks in the Figma collection and the onboarding glimpse are warm; the
web's and this spec's are cool paper). 5m is closed by §7.7; 6o stays open only for the board
redraw.

## 10. Drawings

Gym file `vdmdiKWrmZoS1FtcvJRf6O`, page `iOS` (`11:2`), section
[iOS redesign · iteration 1 · 2026-10-08](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/?node-id=1055-204)
(`1055:204`) — 393 × 852 boards, Instrument unless named Daylight:

| Board | Node |
|---|---|
| Top bar anatomy — the three root bars and a pushed bar | `1055:205` · Daylight `1055:274` |
| Routines | `1056:201` · Daylight `1056:417` |
| The log | `1056:529` · Daylight `1056:779` |
| Coach — empty | `1056:903` |
| Coach — conversation | `1056:1048` · Daylight `1056:1240` |
| Coach — More menu | `1056:1335` |
| Workout — the logger and the rack | `1056:1455` · Daylight `1056:1638` |
| Finish receipt | `1056:1737` |
| Session detail | `1056:1930` |
| Colour roles and type ramp | `1057:201` |
| Transient band | `1057:383` |

The boards bind `Gym · Colour` roles and three file-local variables, `ios/accent`,
`ios/accent-soft` and `ios/on-accent` (`1055:201`–`1055:203`), which carry the verdigris accent in
both modes (9a).

Design System file `qoOwNbWOYE1GFi0yR5uGY2`, page `iOS · First run · 2026-09-26` (`112:2`),
402 × 874 boards:

| Section · board | Node |
|---|---|
| [7 · Shell chrome · 2026-10-08](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=256-5050) | `256:5050` |
| 25a · Gym root bar | dark `257:5034` · light `260:5326` |
| 25b · Journal root bar | `257:5104` |
| 25c · Room menu open | `257:5149` |
| 25d · Bar anatomy at 3× — both appearances, dimensions | `258:5134` |
| 26a · You · signed out | dark `258:5237` · light `260:5385` |
| 26b · You · signed in | dark `258:5330` · light `260:5460` |
| [2c · Echoes on iOS · 2026-10-08](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=256-5054) | `256:5054` |
| 27a · Echo tab · closed | `259:5240` |
| 27b · Echo ink · open | `259:5296` |
| 27c · Echo reader · sheet | `259:5377` |
| 27d · First echo · card | `259:5480` |
| 27e · Arrival · motion | `259:5558` |

The shell boards bind `iOS First Run · Colour`, which gained `shell/*` and `journal/lamp-soft`
(`256:5034`–`256:5044`). SF fonts do not render in Figma's cloud renderer; the boards use the
`iOS First Run · Type` stand-ins (Inter, Nunito, JetBrains Mono). Symbols are named for the SF
Symbol they stand for; the build pulls the real glyph. Glass on a board is `glass/fill` with a
1 px `glass/stroke`, standing in for what the system renders.

## 11. What the next iteration's screenshots must show

1. Top-left and top-right of every room root: one glass capsule with *Gym ⌄* (or *Journal ⌄*),
   one glass circle with `person.crop.circle`, in light and dark, with nothing drawn inside them
   but the system's rendering.
2. Coach, signed in, empty: bar, canvas, composer. Zero sentences. The More menu opens anchored
   under `ellipsis.circle` with four items and a divider.
3. Light Gym on `#EBE7E3` with `#137A6C` tint across Routines, The log, Coach, Settings and a
   sheet — one hue, one ground.
4. The log with no horizontal strip and a seat, not a band, for Weigh in.
5. The logger with no slot strip, no *Last time* line, no kind control; the rack on a card.
6. The finish sheet titled *Well done.* with three tiles and one pinned button.
7. Red text nowhere in a list; one transient band shape in every room.
8. You on clay in both appearances, as a list.
9. Each screen at 375 × 667 and at AX3 once, for the numerals and the bars.
