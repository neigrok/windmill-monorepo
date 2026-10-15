# iOS redesign — iteration 3

The design contract for the Windmill iOS app (`apps/ios/App`): the shell, the Journal room and the
Gym room, on iOS 26 with Liquid Glass, deploying to iOS 18. It rules how the app renders; the
product contracts it dresses stay where they are — `guidelines/superapp-shell.md` and
`superapp-flow.md` for the frame and the journey, `journal/` for the canvas, `gym/briefs/` for the
room. Where this file and a brief disagree, this file wins on iOS and the disagreement is in
`consistency.md`.

Drawings of record: the Gym file section **iOS redesign · iteration 1 · 2026-10-08** on page `iOS`
and the Design System file sections **7 · Shell chrome** and **2c · Echoes on iOS** on page
`iOS · First run · 2026-09-26` (node ids in §10). The boards draw iteration 1; where this text
rules past them the difference is in `consistency.md` under *iOS redesign*. Build from §7 in order;
each iteration reviews screenshots against §11. The iteration-3 review of the iteration-2 build is
`.claude/scratch/ios-design/phase2/designer-review-3.md`.

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
   the screen — none is drawn.
4. **Say a thing once.** One door per destination, one title per screen, one band for transients,
   one way to reach settings. A fact shown twice on one screen is a structure error.
5. **One primary per screen**, in the reach band (`guidelines/thumb-reach.md`); everything else is
   quiet. A screen without a primary action has no prominent button.
6. **Density is the system's.** List rows, insets, section spacing and large titles are the
   defaults. We adjust content, never the metrics.
7. **Signed out is first class.** Nothing asks for an account outside the three canon places
   (`superapp-flow.md` §5); an account verb the person starts opens the same door and resumes. No
   banners.
8. **Light and dark are one design.** Every screen is reviewed in both; a room that defines only
   one appearance is unfinished.
9. **Nothing floats on content.** Whatever floats — a bar, a band, the seat — keeps the system's
   scroll edge, and at rest the content clears it (§4).

## 2. Colour roles

Three palettes, one role vocabulary. Every role is a colour set in `Sources/Theme/Theme.xcassets`
(light and dark appearance values, named `gym/accent`, `shell/canvas`, …) read through one enum
per palette — `GymPalette`, `JournalPalette`, `ShellPalette` — in `Sources/Theme/Palettes.swift`,
the folder `project.yml` compiles into both the app and the `WindmillWorkoutActivity` target. No
other palette exists: no feature, screen or the Live Activity declares colours of its own, and no
view chooses a colour by appearance. `python3 Tools/check_theme_literals.py` rejects colour
construction outside `Sources/Theme/` (the app's README lists what it checks). Onboarding's
illustration kind colours are private to the glimpse as named specimen roles, colour sets under
`onboarding/` in the app's own `Resources/Assets.xcassets`.

**Tint.** The room accent is the tint of the Gym `TabView`, so the selected tab and every control
in every tab inherit it whatever order a screen applies its modifiers in; the page modifier
(`GymPage`, §5) carries the same tint into every sheet the room raises. Toolbar content is the
exception: bar items take the label colour (§4). The system draws the selection; the room supplies
the symbol and the tint (`gym/briefs/12-native-idiom.md`, "A native tab bar's selected state").
The front room also sets the hosting window's `tintColor` to its accent, so the chrome UIKit draws
outside the SwiftUI tree — text selection, the share sheet — carries the room's colour and never
the system blue. The keyboard draws its own keys and takes no tint: an emphasized return key
(*Done*, *Go*) is always the system's blue, so the room's fields keep the plain return key; a
`.searchable` field's *Search* key stays the system's.

### Gym — verdigris on verdigris-grey stone

| Role | Dark (Instrument) | Light (Daylight) | Use |
|---|---|---|---|
| `gym/canvas` | `#0B1111` | `#EBE7E3` | screen ground, sheet ground |
| `gym/card` | `#161C1D` | `#F8F6F4` | list rows, cards, the rack panel, composer |
| `gym/raised` | `#202627` | `#DFDAD5` | ladder keys, secondary buttons, chips, input fields, keypad keys |
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
| `gym/done` | `#9AA859` | `#7D8C43` | a logged set's check, a fully logged movement, an applied proposal |
| `gym/record` | `#D9B04C` | `#6E5217` | a personal record, and nothing else |
| `gym/alarm` | `#D08268` | `#A84E35` | destructive labels, refusal text in a field |
| `gym/alarm-fill` | `#A84E35` | `#A84E35` | a destructive swipe action's fill and a removal's primary; `on-alarm` is white |

These are the Gym Figma `Gym · Colour` ramp values (`surface/*`, `text/*`, `border/*`,
`state/*`) with one ruling: the light accent is verdigris day `#137A6C`, as the owner decided for
the family on 2026-09-06 and as the decided onboarding boards draw it, not the Figma Daylight
`brand/base` alias to iris `#4C4374` (`consistency.md` F44). Gold is a *record*, never a warning;
brick is destructive only.

The Live Activity uses `gym/accent` and `gym/on-accent` for its one button and `gym/accent` for
the keyline; the banner ground stays the system's.

### Journal — lamp on ink

| Role | Night | Day |
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
| `journal/lamp` | `#E0B972` | `#90651C` |
| `journal/lamp-soft` | `#E0B972` at 18 % | `#90651C` at 12 % |
| `journal/energy` | `#9AA859` | `#7D8C43` |
| `journal/mood-*` | the eleven-step ramp `journal/mood-0`…`mood-10` | `scales.md` |

Journal answers dark with Night and light with Day; the choice is the shell's — Appearance
(Light · Dark · System) in You's Settings, System by default (`superapp-shell.md` §6), stated as
the window's `preferredColorScheme` and as an environment override down the tree. The Day column
is the web's journal day ramp — paper in north light with cool ink
(`web/src/styles/tokens/palettes.css`, `[data-theme="light"][data-brand="journal"]`) — with the
lamp darkened to `#90651C` for 4.5:1 text. The onboarding glimpse's journal day inks are these
values. The status bar follows the room: a night canvas under a light status bar is a defect in
either appearance.

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

The light `gym/accent` and `shell/brand` values are below 4.5:1 as text on some grounds; the
darker candidates and their ratios wait on the owner in `consistency.md` (*iOS gym and shell day
contrast*). The build uses the values above until the owner rules.

The shell follows the system appearance in both rooms. You is clay whatever room opened it
(`superapp-shell.md` §6): opened from Gym in light it is clay light, never `systemBackground`
with a verdigris tint. Where to start? draws each door in its room's accent: the Gym door's symbol
and arrow are `gym/accent`, not `shell/brand`.

### What never happens

- A hex in a view file. A `Color(hex:)` call outside `Sources/Theme/`.
- A role chosen by appearance in a view (`scheme == .dark ? … : …`): the asset resolves it.
- `.systemGroupedBackground`, `.secondarySystemBackground` or any UIKit semantic ground inside a
  room; the room's canvas and card are the grounds. System *label* colours are fine where the
  system draws the text (toolbar items, tab labels, menus, alerts).
- A second accent. Olive, gold and brick are states, not accents.
- `.red` for a refusal: a refusal is `ink` in the transient band or `alarm` in the field it
  belongs to.
- `ink-faint` on an essential label — it is below 4.5:1 on both night canvases
  (`guidelines/system-architecture.md`, the grandfathered tertiaries).
- `.black` or `.white` as a CTA foreground: it is `on-accent` (or white on `alarm-fill`). Apple's
  own control (Sign in with Apple) keeps its black and white.

## 3. Type ramp and spacing

### Type

Everything that is prose or a label takes a system text style and scales with Dynamic Type. The
ramp, by role:

| Role | Style | Notes |
|---|---|---|
| Root title | `.largeTitle` via the navigation bar | Routines and The log only; Coach and every pushed screen are inline |
| Pushed/sheet title | the inline navigation title | never a drawn heading repeating the bar |
| Subtitle | `.navigationSubtitle` (iOS 26) | the date of a session, the routine under a receipt, the movement under Fix set |
| Row title | `.body` | semibold only when the row has a subtitle |
| Row subtitle | `.subheadline`, `ink-dim` | |
| Fact / meta | `.footnote` with `.monospacedDigit()` | never `.monospaced()` on prose |
| Eyebrow | `.caption` uppercase, `ink-faint`, no manual tracking | |
| Section header | the list's own header | sentence case |
| Prose (Coach answers) | `.body` | headings in an answer `.headline` |
| Big numeral (rack, keypad, record) | `.system(size: 68, weight: .bold, design: .rounded)`, `@ScaledMetric(relativeTo: .largeTitle)`, cap 92 | reflows vertical at accessibility sizes |
| Keypad echo | the same at 60, cap 84 | |
| Instrument labels and keys | the rack's labels, the ladder and the keypad's digits | capped at `.accessibility1` (Phone and Calculator do not scale their keys) |
| Brand display | Nunito ExtraBold 34 / 28 | Where to start?, You, Keep, onboarding — never inside a room |
| Journal body | Inter 17, line spacing 7 | the one custom body face |
| Journal date | JetBrains Mono 11, tracking 0.7 | |
| Ink notes | Caveat 24 | |

Monospaced digits on every numeral that changes while shown (clocks, weights). The monospaced
*face* is reserved for the journal date line and the echo stamp. A fact is `.footnote` in the text
face, left-aligned with the prose above it; nothing is centred under left-aligned text.

**Counts and labels.** Every count passes through one formatter with real plurals — *1 session*,
*2 working sets*, *1 movement* — and the formatter (`GymCount`) is the only place a plural is
spelled. A tile's label is a noun that agrees with its value (*1 · Working set*, *Duration ·
Working sets · Volume*), never a unit; the unit rides on the value (*1620 kg*). A chart's axis
labels round to the step the series moves in — plate loads to the nearest 5 (*110 · 60*),
bodyweight to one decimal — never to two decimals.

**Dates.** Every date in the Gym room and the shell passes through one date formatter, in the
person's locale through `Date.FormatStyle`, with four forms:

- **row day** *Wed 23* — only inside a month-sectioned list;
- **day** *Sep 23* — the year only when it is not the current one; *Today* and *Yesterday* as a
  trailing value, lowercase inside a sentence;
- **subtitle** *Wed, Sep 23*;
- **span** *Wed, Sep 23 · 12:00–12:45 PM*.

Date pickers are the system's. No view orders a day and month by hand. The journal's date line and
echo stamp keep the journal's mono forms (§8).

The ramp is the public API: named roles in `Sources/Theme/TypeScale.swift` — `ShellType`,
`JournalType`, `GymNumeral`, `GymKeypadNumeral` — each with one size and one `relativeTo`. A screen
cannot ask for a size.

### Spacing

4-pt base: 4 · 8 · 12 · 16 · 20 · 24 · 32. Screen gutter 16 (`List` insets as the system draws
them). Card radius 16, sheet corner radius the system's (never `presentationCornerRadius`), pill for
buttons and chips. Minimum target 44 × 44, and the target is the button, never only its label. The
rack panel pads 16, radius 20 on its top corners. Compliance frame 393 × 852 (iPhone 17); checked
at 375 × 667 and at the largest accessibility size.

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
  has one (Journal: **Show ink notes**). `superapp-shell.md` §3 lists rooms only; the difference
  is `consistency.md` 9x.
- **Top-right: the account button.** `ToolbarItem(placement: .topBarTrailing)` holding
  `Button { } label: { Image(systemName: "person.crop.circle") }` with the accessibility label
  *You and settings*. The system symbol, default rendering, no custom shape. It sits last; on
  iOS 26 a `ToolbarSpacer(.fixed)` separates it from the room's own actions so it stands in its own
  glass circle and the room's actions share theirs.
- **The room's own actions** come before the account button: Routines `plus` (*New routine*); The
  log `scalemass` (*Weigh in*); Coach `ellipsis.circle` (*More*); a pushed screen draws its own.
  Order is actions then account, and nothing is painted inside a toolbar item. All three roots read
  `[Room ⌄] … [action] [account]`.
- **Journal sits in a `NavigationStack`** so its bar is the system's: a visible bar filled
  `journal/canvas` in the room's appearance, so past pages scroll beneath it instead of under the
  bar's items; no title, the room menu and account button as above. The ink notes anchor to the
  toolbar items' frames (`onGeometryChange` inside the labels).
- **Bar items render in the room's ink** at the bar's default weight in every room (`.roomBar`,
  applied after a screen's toolbar), the room menu and the back chevron included. The room accent
  appears in a bar only on a confirmation action: *Finish*, the receipt's *Done*, a sheet's
  checkmark. No `.fill` variants in bars; `.fill` is for a selected tab only.
- **Top bars keep the system's soft scroll-edge effect**; no page hides it, so content passing
  under a bar's title softens instead of reading through it.

### Buttons

| Kind | iOS 26 | iOS 18 fallback | Where |
|---|---|---|---|
| Primary | `.buttonStyle(.glassProminent)`, `.controlSize(.large)`, full width, tint `accent`, label `on-accent` | `.borderedProminent` | one per screen, in the reach band |
| Secondary | `.buttonStyle(.glass)` | `.bordered` | ladder keys, chips, Previous/Next, *Ask Coach* on an empty screen |
| Quiet | `.buttonStyle(.plain)` in `accent` | same | row actions, *Not now*, *Use email instead* |
| Destructive | `role: .destructive` in a Menu or list row | same | never a prominent fill, except a removal's primary (§6) |
| Seat | a 44 pt glass circle with one symbol, bottom-trailing, 16 pt from the edges | material circle | Journal *Write* |

**The reach band.** Whatever stands at the foot of a screen — its one primary, its footer, its
transient — is placed with `.reachBand { }`: `safeAreaBar(edge: .bottom)` on iOS 26, so the
system's scroll-edge effect softens what passes beneath it; on iOS 18 `safeAreaInset(edge:
.bottom)` with the `.bar` material, drawn only while content is beneath. At rest the list's last
row clears the band. A band floats only where reach or a gate rules it:
*Log set*, *Start workout*, *Just start logging*, *Apply*, *Keep this log* / *Share with Coach*,
*Connect a tool*, Inspect's recovery primary, and the steps of a flow (sign-in, Keep, onboarding).
A sheet that edits a record commits from its bar (§5).

CTA copy is at most three words: *Just start logging*, *Start workout*, *Log set*, *Save routine*,
*Share with Coach*, *Keep this log*, *Sign in to share*, *Set*.

**Doors and actions in a list.** A row that navigates is a `NavigationLink`: ink label, optional
symbol, the system's chevron — *Movements*, *Hidden*, *About Windmill*. A row that opens a sheet is
a `Button` drawing the same chevron (`DoorChevron`, `chevron.forward`, never a hand-set
`chevron.right`). A row that acts is a `Button` in
`accent` with no chevron — *Add movement*, *Add a note*. A screen's one primary is never a row; it is
the band. Accent text on a door, or a chevron on an action, is a defect. The only row that unfolds
in place is a kept run in the Review diff (§6); it carries a rotating `chevron.down`, never the
navigation chevron.

### The tab bar

The system `TabView` with the `Tab` API, `.tabBarMinimizeBehavior(.onScrollDown)` on iOS 26.
Routines `list.bullet.rectangle` · The log `calendar` · Coach `bubble.left.and.bubble.right`.
The `TabView` carries `gym/accent` as its tint, so the selected tab is verdigris; the system draws
the selection, the room supplies the symbol (`12-native-idiom.md`). Hidden on every pushed screen
and sheet, and while Coach's composer has focus (`.toolbarVisibility(.hidden, for: .tabBar)`).

## 5. Menus, sheets and transients

### Menus

- A **More** affordance is always `ellipsis.circle` in the toolbar presenting a native `Menu`.
  `confirmationDialog` is never used as a menu.
- Menu sections are `Section`s; each item pairs its label with its SF Symbol; destructive items
  last with `role: .destructive` and no tint of their own, so the system colours symbol and label
  together (`Label("Discard workout", systemImage: "trash")`); the current state is a checkmark,
  never a label.
- Row-level choices are `.contextMenu` and `.swipeActions`.

### Confirmations

- A reversible act happens at once and raises the band with *Undo*, naming the object and the act
  (*Workout discarded*, *Set deleted*, *Weigh-in deleted*, *Conversation deleted*).
- An irreversible act asks once. A `.alert` carries the act as its destructive button and Cancel
  (*Turn this down?*, *Sign out?*, *Delete Push A?*); a choice asked from a row is a
  `.confirmationDialog` presented from that row, title visible (*Remove Apple?*), which SwiftUI
  anchors to its source on iOS 26.
- A yes/no is never a sheet: *Heavier than the plan* is a `.confirmationDialog` (§7.7).
- Nothing asks twice except Discard at sign-in (`superapp-flow.md` §6): *Sign out* is a row that
  raises its alert, never a sheet.

### Sheets

Every sheet is a `NavigationStack` with an inline title, a `.cancellationAction` (*Cancel* or
*Close*) or `.confirmationAction` (*Done*, *Save*), the room's palette, and a detent fitted to its
content:

| Sheet | Detent | Bar |
|---|---|---|
| Keypad | `.height(440)`; `.large` at accessibility sizes | *Cancel* · title *Weight* / *Reps* |
| Weigh in, Rename movement, Create movement from Movements or the workout's picker | `.medium` | *Cancel* · title · ✓ (*Save* / *Rename* / *Add*) |
| Heavier than the plan, varied scheme | `.medium` | *Today only* · title · ✓ (*Save*) |
| Share this workout | `.medium`; `.large` at accessibility sizes | *Close* |
| Fix set, Note | `.large` | *Cancel* · title · ✓ (*Save*) |
| Fix workout | `.large` | *Cancel* · title · ✓ (*Save and retry*) |
| The builder | `.large`; *Add movement*, Create movement and Targets are steps pushed inside it, each with *Cancel* and its own ✓ (*Add* / *Done*) | *Cancel* · title · ✓ (*Save*) |
| This session | `.large` | *Close* · title · *Edit* |
| Review | `.large` | *Close* · title; *Apply* in the band |
| Finish | `.medium` up to five rows, `.large` past five or at accessibility sizes | *Done* |
| You, sign-in steps | `.large`; Keep and the Apple questions `.medium` | *Done* / *Close* |

A sheet that edits a record commits from its bar's `.confirmationAction`, drawn once by
`.sheetCommit`: *Cancel* leading and, on iOS 26, a `role: .confirm` checkmark on `.glassProminent`
whose glyph is `on-accent` and whose accessibility label is the commit's name (✓ above); on iOS 18
the name in bold. Never a pill at its foot; its destructive act, when it has one, is the form's
last row in `alarm`. That is how Calendar, Contacts, Reminders and Health's *Add Data* commit.

`presentationDragIndicator(.visible)` only where the bar carries no dismissal.
`presentationCornerRadius` is never set. A pinned primary inside a sheet uses the reach-band rule
of §4.

### Shared components

The room draws each of these once, in `Sources/Gym/Components/` (or `Sources/Theme/` when
product-neutral), and every feature uses the one:

| Component | What it is | Owner |
|---|---|---|
| `GymPage` modifier | the canvas, the tint, the inline or large title; it keeps the bars' scroll-edge effect | Gym |
| `RoomTransient` | the one band (below); `GymTransient` adapts it to the room | Theme (shape), Gym (adapter) |
| `roomTitle(_:subtitle:)` | the inline title with its `.navigationSubtitle`, the two stacked in the bar's principal slot on iOS 18 | Theme |
| `.reachBand { }` | the bar every bottom band stands in (§4) | Theme |
| `.roomBar` | the room's ink as the toolbar's tint (§4) | Theme |
| `SoftTopEdge` | a 16 pt fade on a list that scrolls under a fixed head rather than a bar, where the system draws no scroll edge | Theme |
| `DoorChevron` | the chevron of a door a `Button` opens, drawn as the system draws a `NavigationLink`'s | Theme |
| `ActionBand` | the one floating primary in the reach band, with its optional trailing symbol, its one-line footer on the band's own surface (never bare text over the list), and disabled and busy states | Theme |
| `.sheetCommit` | an edit sheet's bar: *Cancel* and the checkmark (§5 Sheets) | Gym |
| `WeightInstrument` | the big numeral with its unit at the numeral's baseline, the four-key ladder and its accessibility reflow; centred wherever it is drawn | Gym |
| `SetEditor` | weight, reps, effort, note, Kind (segmented), delete; validation and its refusal text; the note's byte counter only from 3,200 bytes; over a saved workout's set also movement and time, returned to that workout's draft | Gym |
| `RenameMovementSheet` | one sheet, `.medium`, the name field, a counter only from 48 characters, and one help line: *Renames it everywhere; the old name still finds it.* | Gym |
| `GymRow` | a title over one meta line, with an optional leading symbol or dot and an optional trailing fact, `iphone`, check, progress or `DoorChevron`; every list row of a title over one line, The log's included | Gym |
| `SetRow` | a set read back: its place, its numbers, a trailing caption, then time, effort and note when present. Its place is one rule everywhere — the ledger, session detail, Inspect and Fix workout: a working set by its count among the working sets so far (*1*, *2*), any other kind by its letter (*W*, *D*, *F*) | Gym |
| `MoreMenu` | `ellipsis.circle` in the bar presenting the native Menu | Gym |
| `FactTiles` | up to three value-over-label tiles, drawing only the facts that are known | Gym |
| `RoomDoor` | the Where to start? card, given a title, line, symbol, accent and ground | Shell |

### Lists

Every list is `.insetGrouped` with the system's insets, and its sections follow four rules:

- **Rows that belong together are one section.** A list is never a stack of one-row cards: the
  routines and the proposal row are two sections at most; *Appearance* and *About Windmill* are two
  rows of one **Settings** section. A section stands alone only when it is a door to another place
  or a destructive act (*Movements*, *Sign out*, *Delete routine*).
- **A header is the list's own**, sentence case, drawn by `Section`; never a hand-set uppercase
  caption with its own padding. A field that is the section's only row carries no header: its
  placeholder is the label (*Name*, *kg*).
- **A section with nothing in it is not drawn** (a routine's History, **Hidden**, **On this
  phone**). The end of a long list is the last section's footer (*First session · Jun 13*), never a
  card. A whole empty screen is `ContentUnavailableView`. No third shape.
- **One caption per section, at most twelve words**, and never a caption that repeats a placeholder,
  a title or the label on the button below it (`guidelines/text-budget.md`).

### Status

A state the lifter did not ask for — offline, unsent, paused, refused — is never a sentence at the
head of the content. It is one of four things: the transient band (§5) when it is news; a disabled
control with the reason as that section's footer when it blocks a door (*Sign-in needs a
connection.* under the disabled Apple and email doors); a symbol on the row it describes (`iphone`
on an unsent set or session); or a row in the one place that owns it (**On this phone**, §7.16).
Signed out nothing is unsent — there is no account to send it to. Signed in, a set is unsent while
the log has not confirmed it and something holds it back — no connection, a paused session, a
server that needs a newer app (§7.15), its own refused push — never while it is merely on its way;
a workout is unsent while it or any of its sets
is. The ledger, the log's rows, session detail and the Live Activity's count follow this one rule.
*Coach needs a connection.* and *Your full training history needs a connection to finish syncing.*
are bands, not canvas text.

### One transient band

The room has one component, `RoomTransient`, for refusals, notices, Undo and copied-link
confirmations: a `.footnote` message on `.glassEffect(.regular, in: .rect(cornerRadius: 16))` on
iOS 26 and `.regularMaterial` with the system shadow on iOS 18 — never `card` — so it reads as
floating over the list it answers. It wraps rather than truncates, with at most one trailing action
in accent (*Undo* · *Try again*) and a dismiss `xmark` in `ink-dim`, floating in the reach band
above the primary, honouring the delete window (`gym/briefs/13-gestures.md`). Refusal text is
`gym/ink`, never red: the band is the signal. A refusal is a sentence, at most twelve words, and
names the way out (*Overlaps another workout — fix its times.*); the copy is the brief's. The
signed-out workout a signed-in account has not taken is not a band and not a card on Routines: it
is the **On this phone** row at the head of The log (§7.16).

### Motion

Each act the lifter makes answers in place, with the system's springs:

- **Log set:** the current row's dot turns into the check (`symbolEffect(.replace)`), the next
  planned row slides into the current slot, and the numeral rolls with
  `.contentTransition(.numericText())` on every ladder tap. Logging stays visual: no set-confirmation
  sound or haptic (`gym/android-delivery.md`).
- **Apply:** the button turns into the receipt row *Applied · Push A · 3 changes* with a `checkmark`
  bounce and a success haptic. The sheet stays until closed.
- **A new record at Finish:** the receipt's *Personal record* line arrives with one `gym/record`
  pulse. Never a confetti burst.
- **A moment** opens the Record with a zoom from its dot (§7.6).
- **The band** rises with the system spring and dismisses by a swipe down as well as by `xmark`.

With Reduce Motion each is a 200 ms fade.

## 6. Coach

The conversation is the content; everything else is chrome, and the chrome is the bar, the
composer and one menu. Signed in with routines, an empty Coach shows the bar, an empty canvas
and the composer — nothing else (`gym/feedback-contract.md` "Coach conversation"): no pinned rows,
no capability text, no allowance line until a limit is in the way (`09-coach.md` "Limits are
contextual"), no *Done* row and no account item, since the account button is in the bar. *Jump to
latest* is a 36 pt glass circle with `chevron.down`, bottom-trailing above the composer.

**The More menu** (`ellipsis.circle`, trailing, before the account button) is a `Menu`:

```
New chat        square.and.pencil   (only while a conversation exists)
─────
History         clock
Notes           note.text
Connected log   link
```

**The composer** is one capsule on `gym/card`: `photo.badge.plus` (a 44 pt target, leading,
quiet, its glyph capped at `.title3`) · the field *Ask about your training* (1–5 lines, its leading
inset following the button) · the send button, a 36 pt circle filled `gym/accent` with `arrow.up` in
`on-accent`, swapping to `stop.fill` while Coach answers. Disabled — an empty field, offline, the
allowance spent — it is the same circle at 40 % opacity, never a different size, shape or colour. A
chosen photo shows as a 56 pt thumbnail above the field with an `xmark.circle.fill` on its corner,
not a *Remove photo* text button. The byte-limit refusal appears in the transient band.

**Offline** is a band, not a sentence on the canvas: *Coach needs a connection.* rises in the
transient when the room opens offline and again on a send attempt, dismissable with `xmark`; the
canvas holds the conversation and nothing else.

**The lifter's turn** is a right-aligned bubble on `gym/accent-soft`, radius 18, max width 78 %; a
sent photo is a 56 pt thumbnail, radius 8, under the text and trailing-aligned — the composer's
draft thumbnail, not a bubble-wide image. **Coach's turn** is plain prose on the canvas, no bubble,
16 pt gutter. Markdown headings `.headline`; code `.body.monospaced()`.

**The read receipt** under an answer is one `.footnote` row in the text face, `ink-dim`,
monospaced digits, a leading `book.closed`: *Read 18 sessions · 6 weeks* ›. It opens *What Coach
read*, whose one section lists every workout read as `GymRow`s (*Push A* · *Sat, Sep 26 · 1
working set · 400 kg*), each a door to the workout, headed by the receipt's numbers; *Also read
your notes.* is its footer when true. The sheet's numbers add up to the receipt's. It has *Close*
and no drag indicator. No `DisclosureGroup` in the conversation; no nested disclosures.

**A proposal card** on `gym/card`, radius 16, 1 pt `gym/accent` stroke:

```
PROPOSAL · PUSH A                        (eyebrow, accent)
→ Back Squat     1 × 5 · 80 → 1 × 3 · 90 kg   (change rows, up to 3: symbol accent, title ink, change ink-dim)
+ Bench Press    Added · open · after Back Squat
+ 1 more                                 (ink-faint)
Review changes                        ›  (the door: ink, the system chevron)
```

The change rows are the same `GymRow`s the Review sheet draws, so the card and the sheet read as
one object. No body line: the answer above is the reasoning. Pending, the card carries no caption,
since the Review row is the invitation; settled, the Review row's trailing caption is *Applied*
(with a `gym/done` check) or *Turned down* (`ink-dim`). A created routine is one row *Open routine ·
Push A ›* with `list.bullet.rectangle`.

**Signed out** the room is a `ContentUnavailableView` with `bubble.left.and.bubble.right`, no title
(the bar already says Coach), the canon sentence *Coach reads your log, so it needs you signed in.*
as its description, and *Sign in* as a `.glass` button; no composer — until the phone allowance
ships, when `09-coach.md` applies.

**The Review sheet** (`ProposalReview.swift`) lists the diff as one section of `GymRow`s headed
*3 changes*: the leading symbol (`arrow.right` · `plus` · `pencil` · `minus`) is the only accent,
the title is `ink` (*Back Squat*, *Bench Press*, *Name*) and the change is the `ink-dim` subtitle
(*1 × 5 · 80 → 1 × 3 · 90 kg* · *Added · open · after Back Squat* · *Push A → Push A2*). A kept run
is a row *4 unchanged* that unfolds in place. The Apply gate is scroll-to-the-end. *proposed by
Coach · Sep 26, 6:42 PM* is the sheet's subtitle; the quote bar is the attribution, with no *Coach
wrote:* label; the quote is the proposal's summary, since the sheet also opens from Routines, where
no answer sits above it. *Ask Coach* is a quiet accent button under the diff. The band holds Apply,
one caption slot under it, then *Turn this down* as a quiet `ink-dim` button; *Turn this down*
raises its `.alert`, which keeps the destructive role (`09-coach.md`). The caption slot never
empties, so Apply never moves: while the diff is unseen it reads the gate's sentence *Scroll to the
end to apply.*; once the end has been seen it reads the atomic promise (*All or none. Nothing changes
until you tap.*, or the removal's *Your logged sets stay. Nothing is removed until you tap.*).

A removal's diff is one row, `minus` · *Push A* in `alarm`, with no body; its primary is the
prominent style filled `alarm-fill`, white text, `role: .destructive`. While a removal waits on the
log the primary stays in place, disabled, reading *Removing…* with an inline `ProgressView`; after 15
seconds it enables as *Retry*, which resends the same command, and the caption reads *Not confirmed
yet.* The receipt replaces both when it lands. Never a spinner without an end.

**History** (`CoachHistory.swift`) is a plain list of conversation rows, each the door to its
conversation: *Push A · 3 changes* (*Push A · a removal* for a removal; the question when the
conversation holds no proposal), the date trailing, and a settled proposal's state as its caption.
A swipe-delete raises *Conversation deleted. Routines and notes stay.* · *Undo*. With none it is
`ContentUnavailableView("No conversations", systemImage: "bubble.left.and.bubble.right")`. History
has no pinned primary: Back returns to the composer.

**Notes** carries one fact as its header, *Any agent you connect can read these too.*
(`10-notes.md`), with no second heading line and no *Top note wins.* footer: the drag handle in
Edit carries the order (`consistency.md` 9s). *Add a note* is an action row. The note editor has
*Save* in the bar and no *Done* above the keyboard; a swipe down puts the keyboard away.

**There is no Gym settings page**: Notes and Connected log are reached from Coach's More, and a
hidden workout from **Hidden** at the end of The log (§7.6). The phone draws kg and offers no units
control; nothing about the account, the update or the phone's unsent work is in the room's menus,
which You and The log own (§7.15, §7.16).

**Connected log** (`19-connected-log.md`) puts its one primary in the reach band: *Connect a tool*
is the floating `ActionBand` with `arrow.up.forward` trailing (*Sign in first* signed out). With
nothing connected, the head line *Your log, read by Claude, Cursor or Codex.* is `.subheadline
ink-dim` on the canvas, not a heading, and the Read · Write · Delete rows with the caption sit above
the band, because there they are the decision. With a connection, the list leads with
**Connected**: each row is a credential, its levels and day as the subtitle, and opens the shell's
connection settings in the browser (`arrow.up.forward`), so there is no *Manage connections* row.
**How this works** is a door row in both states, to a pushed page holding the brief's five lines;
with a connection that page also holds the Read · Write · Delete rows and the caption, which the
list then does not draw (`consistency.md` 9t).

## 7. Per screen, in build order

Each item is a buildable unit. Cite this section by number in the build log.

### 7.1 Shell chrome (§4) — every room root, Journal included

The room menu and the account button are native toolbar items; Journal sits in a
`NavigationStack`; the You, Keep and sign-in sheets' *Done*, *Close* and *Back* are toolbar items.
Bar items take the label colour. Nothing in the app draws a white-alpha fill or stroke. Both
appearances.

### 7.2 One palette per room (§2)

`Sources/Theme/` holds the three palettes as asset-catalogue roles, compiled into the app and the
widget. The Live Activity reads `gym/accent`; the `TabView` and `GymPage` carry the tint; no view
branches on the colour scheme; Coach, Notes, Connected log and Review sit on the room's grounds, not
the system's grouped grey. Light Gym is pietra, not iOS grey. Rendering tests pin roles, never hex
values.

### 7.3 Coach (§6)

The More menu with its symbols; the composer; the receipt row and *What Coach read*; the card
without a body; the Review diff as `GymRow`s; the removal's colours and wait. The keyboard's own bar
cannot carry *Done* on iOS 26 (`consistency.md` 6w), so while typing *Done* is a 36 pt glass
`keyboard.chevron.compact.down` circle above the composer's trailing edge, the slot *Jump to
latest* takes otherwise; Send, a swipe down the conversation or a tap on it also put the keyboard
away. The tab bar hides while the composer has focus. The photo button's glyph caps at `.title3`
inside its 44 pt target and the field's inset follows the button. A sent photo opens as a
full-screen cover zooming from its thumbnail, black ground in both appearances, pinch to zoom, swipe
down to close, no title. Signed out the room is the `ContentUnavailableView` of §6. Connected log
leads with **Connected** when something is connected and draws **How this works** as a door row;
with nothing connected, the capability rows sit above *Connect a tool*. The note editor has no
*Done* above the keyboard.

### 7.4 `RoomTransient`, `ActionBand`, `GymPage` (§4, §5)

One band, every tab and the workout, on glass; no red text in lists. The floating primary and the
page modifier set every tab's bottom edge and ground with one rule: top bars keep their scroll
edge, the reach band sits in `safeAreaBar`, and at rest the last row clears it. The other Gym shared
components (§5) live in `Sources/Gym/Components/`, and 7.5–7.10 build on them; the shell's follow
with 7.11 and 7.12.

### 7.5 Routines

- No signed-out section. The sign-in offer is the Keep row under a routine Coach created and *Keep
  this log* on the finish receipt.
- A routine row is two lines: the name (`.body.semibold`) and *4 movements · trained 3 days ago*
  (`.subheadline ink-dim`; *never trained*).
- A waiting proposal is one row in its own section at the top: *Push A · 3 changes* (*Push A · a
  removal*) over *From Coach · 6:42 PM*, leading `bubble.left.and.bubble.right` in accent, the
  system chevron. Settled removal receipts are one row each.
- *Movements* is the list's last section, one `NavigationLink` row with `list.bullet`.
- Empty: `ContentUnavailableView("No routines yet", systemImage: "list.bullet.rectangle")` with no
  description; signed in with Coach available it carries one `.glass` action *Ask Coach*, opening a
  new chat with *Build me a routine.* in the composer, unsent.
- The primary *Just start logging* floats (§4). Large title, `plus` and the account button in the
  bar.
- Routine detail numbers its movements (*1. Bench Press*), as Edit does; an open movement reads
  *open* and carries no footer; History is drawn only when it has rows, each *1 working set · 1
  movement* with real plurals. A movement row opens the Record. The detail sits on `gym/canvas`.
- Edit routine ends with a section *Delete routine* in `alarm`, confirmed by `.alert` *Delete
  Push A?* · *Your logged sets stay.* · **Delete**.
- Every movement search — the builder's *Add movement*, the workout's *Next movement*,
  *Movements* — is `.searchable(placement: .navigationBarDrawer(displayMode: .always))` over the
  two-line `GymRow`: the name, then *Barbell · 80 × 5 · 3 days ago*, or *Barbell* alone before the
  first log. A query with no exact match leads the results with a row **Create “<query>”**
  (`plus.circle.fill`, accent) opening Create movement with the name filled; with an empty query,
  `plus` in the bar (*New movement*). No floating button in a picker, and no pinned *Create
  movement* or *Add to routine*. Creating ends the search first (`dismissSearch`), so the pushed
  Create movement's bar takes its taps. The picker is titled *Add movement* from the builder and
  *Next movement* from the workout — never a question.
- The builder's bar is *Cancel* · title · ✓ (*Save*) and nothing else: *Reorder* (*Done* while
  reordering) is the Movements section's header action. Its name field carries no header
  (`15-the-routine.md`, "Name is the first field"). *History* is drawn only when it has rows; a new
  routine has none and shows none. A refusal (*A routine is at least one movement.*) appears on a
  Save attempt, or when the lifter leaves a name they changed, never on a keystroke; the next edit
  clears it.
- Inside the builder, *Add movement*, Create movement and Targets are steps pushed in its own sheet,
  each with *Cancel* leading and its own ✓.
- Targets is titled *Targets* with the movement as subtitle, ✓ (*Done*) in the bar; *You decide the
  numbers at the rack.* is its section footer while the scheme is open; *last time* and *max* as
  placeholders are the rest of the disclosure.
- Create movement — a step of the builder, or a `.medium` sheet from Movements and the workout's
  picker — is *Name*, *Equipment* as a `Picker(.menu)` row, *Targets* ›, and ✓ (*Add*) in the bar,
  enabled once the name is non-blank; a refusal appears on the attempt, one at a time, name first.
  An open target is a valid target, so *Choose at least one set.* is never drawn.

### 7.6 The log

- **Phones weave.** One list: the head, then month sections of sessions with moments woven between
  them (`18-progress.md`; moments `.best`, `.month`, `.weight`). No movement strip and no
  horizontal scroll inside the list; the Record is reachable from every movement row on a session.
- **The head** is one section: *Bodyweight* · *82.4 kg · 3 days ago* ›, drawn once a weigh-in
  exists, with *Trained 3 of the last 4 weeks* as its footer when it exists. Signed in, **On this
  phone** sits above it while a workout waits (§7.16).
- **A session row** is a `GymRow`: the name, then its facts *18 working sets · 1h 03m*
  (monospaced digits), the day trailing in `ink-dim` (row day form), the system chevron; `iphone`
  before the day while unsent.
- **A record is stated once**: by its moment, woven under the session that earned it. A record
  session without a moment (the one-a-week cap in `18-progress.md`) carries an 8 pt `gym/record`
  dot after its name and nothing more. A record needs a prior logged set of that movement: a
  movement's first logged session sets no record.
- **A moment is a door**, never an expander. A best moment is an 8 pt `gym/record` dot before
  *Bench Press · new best*, the facts *98 kg est · up 1.2 kg since Sep 17* as its subtitle, the
  system chevron; it opens the Record with a zoom transition from its dot
  (`matchedTransitionSource` → `.navigationTransition(.zoom)`), the chart scrolled to that session
  with its point selected. A weigh-in moment opens Bodyweight, and is woven only once a newer
  weigh-in exists — the newest is the head's. A month moment, *Trained 4 of the last 4 weeks*, is a
  plain row that opens nothing and carries no chevron. No `DisclosureGroup` in The log.
- **Weigh in** is the bar's action (§4), opening the Weigh in sheet. Nothing floats over the list.
- Older sessions load when the last row appears (a `ProgressView` row); a failed read is the band's,
  with *Try again*. The end is the last section's footer *First session · Jun 13*.
- Empty: `ContentUnavailableView("No sessions yet", systemImage: "calendar")`, no description, no
  head row.
- Discard and delete raise the band naming what went: *Workout discarded* · *Weigh-in deleted* ·
  *Set deleted*, with *Undo*.
- **Hidden.** While a workout is hidden, the list ends with a section **Hidden**: one door row
  *1 workout*, opening the hidden workouts, each with *Restore workout*.
- **The Record** (`MovementRecordScreen.swift`): title the movement, subtitle the equipment,
  `ellipsis.circle` holding *Rename movement*; two `FactTiles` *Best e1RM* and *Heaviest*; the
  chart, whose readout line appears only while scrubbing, in place of the window line *last 12
  weeks · 28 sessions*; axis labels at the plate step; then *Personal records*. Facts and axis labels
  keep monospaced digits in the text face.
- **Bodyweight** (`BodyweightScreen.swift`): a weigh-in row is *Sep 26* · *82.4 kg* with `GymRow`'s
  sheet-door chevron, the year only when it is not the current one. The chart's caption *Every point
  is a number you typed. Nothing here is estimated.* is drawn; *Coach can read this. It can never
  write it.* is the list's footer.
- **Session detail** follows §7.8.

### 7.7 Workout

- No slot strip, no *Last time* line, no kind control: history prefills the rack (`16-the-workout.md`);
  a new set is Working, as on web and Android; the Fix sheet carries *Kind* as a segmented control
  (warmup · working · drop · failure).
- The rack is a panel on `gym/card`, top radius 20, padding 16: the numeral row (`68` rounded bold ·
  *kg* `.title3 ink-dim`, centred), four glass ladder keys, the reps row (`minus` and `plus` as
  matching 44 pt glass circles either side of *5 reps*), then **Log set** prominent. The button
  names no numbers; its accessibility label does (*Log set, 100 kilograms, 5 reps*).
- Previous/Next are 44 pt glass circles beside the movement name; *Movement 1 of 2* is the eyebrow
  above it. The plan line *plan 4 × 5 · 100* is drawn only when the ledger has no planned rows to
  show it (*plan open*).
- The clocks are one `.footnote` line: *32:10 · 1:37 since last set*. The second clock anchors to
  the latest valid set; until the first set the line is the workout clock alone.
- The ledger draws sets in the order they were logged, the same on every draw and every surface; a
  warmup logged between working sets stays between them. It scrolls under the rack's head, not a
  bar, so the system draws no scroll edge there: its top fades over 16 pt (`SoftTopEdge`), and at
  rest the current row and the one before it are fully visible.
- The current row is its place, its target (*100 × 5*, or *open*) and the accent dot — never the
  words *Current set* or *Target*, never a sentence (`16-the-workout.md`). An unsent set is marked
  once, by a trailing `iphone`.
- **At accessibility sizes the rack never scrolls and never clips**: its labels cap at
  `.accessibility1`, the ladder is 2 × 2, the reps row always shows, and the ledger gives up height
  first, down to the current row alone.
- The bar: *This session* `list.bullet` leading, *Finish* trailing in accent (a confirmation), title
  the routine, subtitle the start time.
- A Finish the phone cannot complete says what holds it back, in the refusal band: *Finish needs a
  connection — keep logging, or hide the workout.*, or, while the server needs a newer app (§7.15),
  *Finish needs the update — keep logging, or hide the workout.*
- *This session* lists each movement with *2 of 4 sets* against plan (*3 sets* without one); a
  `gym/done` check only when every planned set is logged; *Add movement* is the section's last row,
  `plus.circle.fill`. *Hide workout*'s footer: *Your sets stay saved. Find it under Hidden in The
  log.*
- **Heavier than the plan** is a `.confirmationDialog`: *Save 105 to Lower A?* · *Today's workout
  already has it.* · **Save to Lower A** · **Today only**. *Today only* is drawn as an answer and is
  also the dialog's cancel, since iOS 26 hides a cancel button and runs it on a tap outside: leaving
  the dialog means today only. A varied scheme opens a `.medium` sheet with its before/after rows,
  *Today only* leading and ✓ (*Save*) in the bar.
- The refusal band is §5's glass band; its copy stays at twelve words naming the way out.

**The Live Activity** (`WorkoutActivityWidget`) is the ledger's current row on the lock screen,
not a form. Banner and expanded Island: the routine name with the room symbol leading and the
workout clock alone, unlabelled, trailing; the movement name; the prefilled set *100 kg × 5* as
the one large line; under it one `.caption` line *Set 3 of 4 · 0:12 since last set*; *3 not sent
yet* bottom-leading only while true; *Log set* bottom-trailing in `gym/accent`. No clock carries a
label (`16-the-workout.md`). Compact Island: the room symbol and the workout clock leading, the
since-last-set clock trailing. Minimal: the room symbol.

### 7.8 Session detail

- Title the routine name; subtitle the span form, *Wed, Sep 23 · 12:00–12:45 PM*. The head is three
  `FactTiles`: Duration · Working sets · Volume. *Closed after four hours without a set* is the
  head's footer when true, and *On this phone, not yet on your account.* while true; neither is a
  row.
- The bar holds `square.and.arrow.up` (*Share this workout*) and `ellipsis.circle`, whose one item
  is *Discard workout* (`trash`, destructive). Discard pops to The log, where the band reads *Workout
  discarded* · *Undo*.
- Set rows are `SetRow`s with tap-to-fix and swipe-to-delete: *1 · 100 × 5* with the comparison as
  the trailing caption (*+2.5 over plan*), effort and note as a second line only when present.
- A movement's plan is its row's subtitle in `ink-dim` (*plan 1 × 5 · 60*), never an accent row of
  its own; a movement the plan did not hold reads *not in plan* in the same place.
- **Share this workout** is a `.medium` sheet with *Close*, its sentences and one primary, *Get a
  link*. Signed out, or while backup is paused, the primary is a sign-in door, *Sign in to share*,
  in place of a primary that cannot succeed: it opens the sign-in door and, signed in, returns to
  the share (`superapp-flow.md` §5). A mint that meets no account is refused in the band with
  *Sharing needs your account. Sign in first.* The bar's `square.and.arrow.up`, the session row's
  context menu and its accessibility action open the same sheet in every account state, so the
  door reads the same from every place it is offered.

### 7.9 Finish receipt

- Title *Well done.* / *Ended early.* (`16-the-workout.md`), subtitle *Push A · Tue, Aug 18* or
  *Free session · Sat, Sep 26*; no title row inside the list (`consistency.md` 6o).
- Three `FactTiles`: Duration · Working sets · Top e1RM (when any), labelled with nouns and never a
  unit (§3), then *Personal record* in `gym/record` on its own card, then *Performed* in logged
  order, then *Against plan* / *Against last Push A* when one exists.
- The one full-strength button is pinned in the reach band at full width: *Share with Coach* signed
  in, *Keep this log* signed out, with its one-line footer on the band's surface. *Save as routine*
  is a card beneath the tiles: name field, then *Save routine* as a secondary glass button; *Kept as
  Tuesday.* replaces the card on success. The sheet opens at `.medium` under five rows and grows to
  `.large`; at rest its last row clears the band.
- *Done* in the bar; no drag indicator.

### 7.10 Sheets (§5)

Detents, dismissals and commits per §5; `presentationCornerRadius` never set.

- **Fix set** (`SetEditor`): title *Fix set*, the movement as subtitle, *Cancel* · *Save* in the bar.
  One section: the centred `WeightInstrument`, *Reps*, *Effort* (`Picker(.menu)`), *Kind*
  (segmented), then *Note* as a `TextField(axis: .vertical)` row, 1–6 lines, no header; over a saved
  workout's set also *Movement* and *Time*. *Delete set* is the last section in `alarm`, with the one
  caption *Push A keeps its planned targets.* The set note carries no footer: a set note is a record
  and the field says nothing about Coach (`09-coach.md`). *Clear note* is drawn only while the note
  has text.
- **Keypad**: title *Weight* or *Reps*; the unit at the numeral's baseline as on the rack; digits
  `ink` on `raised`, *Set* the only accent; digits cap at `.accessibility1`; `.large` at
  accessibility sizes.
- **Weigh in**: the *kg* field with its suffix as the first row under the title, *Date*, then
  *Delete weigh-in* in `alarm`; *Save* in the bar.
- **Rename movement**: the name field, the help line, *Rename* in the bar.

### 7.11 You, Keep and sign-in (§2 shell)

- You is a native `List` (`.insetGrouped`) in a `NavigationStack`, title *You*, *Done* trailing,
  on clay in both appearances. The identity row is the avatar or `person.crop.circle`, the name — or
  the email when no name is set, never *You* — and one state line, the account's one status: *Not
  signed in* · *Backed up* · *Not backed up yet* · *Syncing paused · update Windmill*. The Apple and
  email doors follow it. Then **How you sign in** (signed in) or **On this phone** (signed out,
  drawn only while a room holds something, one row per such room: *Journal · 3 pages*, *Gym · 3
  routines · 1 workout*); then **Settings**: *Appearance* as a `Picker(.menu)` row (Light · Dark ·
  System, System by default) and *About Windmill* ›; then *Sign out*, destructive, alone. The
  choice of appearance sets the window and the environment (§2), and the rooms answer with their
  own palettes.
- There is no *Your data* section and no *Gym settings* row (§6). `superapp-shell.md` §6's *Your
  data*, *Erase data* and *Delete account* are not part of this contract (`consistency.md` 9w).
- **Finish signing in.** A sign-in the phone has verified but the engine has not finished is a
  section of You, headed *Finish signing in*, above the identity row; it is never a sheet of its own,
  and You always opens. Its line is *Sign-in needs a connection. Your pages are safe on this
  phone.*, or *Your sign-in finishes once Windmill is updated.* while the update is required (§7.15).
  Then *Try again* (absent while the update is required) and *Cancel sign-in*, destructive; a refusal
  is the section's footer in `shell/danger`. While it is pending the Apple and email doors are not
  drawn, and the identity row's state line reads *Syncing paused · update Windmill* while the update
  is required.
- *Sign out* raises its `.alert` directly — *Sign out?* · *Your pages and log stay in your account
  and leave this phone.* · *Cancel* · **Sign out** — never a sheet; when the account has not
  confirmed some changes, the alert is `superapp-flow.md` §7's variant with **Keep** · **Discard** ·
  **Cancel**. Offline, the Apple and email doors disable and *Sign-in needs a connection.* is their
  section's footer, never a line inside the identity row. At accessibility sizes the email row
  stacks label over value, and the value never hyphenates.
- The sections are `Section`s with the list's own headers (§5 Lists): no hand-set uppercase
  captions, and no intro sentence.
- Keep, the Apple questions, the email and code steps keep their layout; their headings are
  Nunito; their buttons follow §4; *Back* and *Close* are toolbar items. The symbol that heads a
  shell sheet is the bare SF symbol in `shell/brand`, never in a drawn tile; Keep's is
  `icloud.and.arrow.up`, and Keep draws no bar title, only *Close*. Refusal text is `shell/danger`
  when it is needed at all.
- The gym's Keep door opens the Keep sheet in the room's words (*Keep your log* · *It lives only on
  this phone. Sign in to back it up and open it on the web.*), never You.
- The doors are Apple and email (`superapp-flow.md` §6). *Use a sign-in link* appears only on the
  code step, for someone holding a link.

### 7.12 Where to start? and onboarding

As the first-run boards draw them, with the shell palette roles, the Gym door in `gym/accent`, the
`RoomDoor` component and the system *Sign in* link style — and the appearance: Where to start?
follows the system like the rest of the shell. The onboarding gym glimpse draws the current rack —
name, the ledger with its current row, the numeral, *Log set* — never the slot target, *Last time*
or the mono face (`consistency.md` 9f).

### 7.13 Journal room

- The chrome follows 7.1; the write seat and its *Done writing* swap follow the seat rule (§4).
  The canvas's bottom content margin clears the seat (seat height + 16).
- A past day's scale line draws only what was set — *Mood 7 · Energy 4*, or *Mood 7* alone — and
  nothing when neither was (`journal/journal.md` §4, "a day you didn't write is not drawn").
- Night in dark, Day in light (§2), chosen by Appearance in You; the status bar, the bar and the
  keyboard follow the window's appearance with the canvas.
- The placeholder is *Start anywhere.* whether or not the ink notes are shown; the line *Only you.
  No prompts, no fields, nothing to fill in — write a line or a page.* is the canvas's one
  disclosure.
- The echo stamp is *29 MAY* over *4 MO* in the current year, *22 AUG 2025* over *1 YR* otherwise;
  the reader has *Close* and no drag indicator (§8).

### 7.14 Echoes on iOS (§8)

As §8 draws it. The ink's *Useful* marks the passages the ink shows; *Not useful* retires the
page's echo in one request, as the web's page-level answer does.

### 7.15 Update required (§2 shell)

When the engine reports the client too old (`engine.status.upgradeRequired`, or a 426 at
sign-in), the shell says so once and keeps the fact in one place:

- **One alert** when the flag flips to true, and once per cold launch while it holds — never
  again mid-session: *Update required* · *Update Windmill to keep syncing. Your work is saved on
  this phone.* with an account, *Update Windmill to sign in. Your work is saved on this phone.*
  without one · **Get the update** · *Keep working on this phone*. A 426 at sign-in raises the same
  alert, never `localizedDescription`. It waits behind the introduction or another alert and is
  presented once nothing else is.
- **The standing place is You**: the identity row's state line reads *Syncing paused · update
  Windmill* — for an account, or for a sign-in still finishing (§7.11) — and a *Get the update* row
  (`arrow.up.forward`) sits in the identity section while the flag holds. You is one tap from every
  room root.
- *Get the update* opens the build's configured destination (TestFlight). If it cannot open, the
  transient reads *Couldn't open the update. Try again.*
- Journal and Gym keep working on the phone; nothing is disabled, dimmed or counted down. A Finish
  the server would refuse says so (§7.7).
- Event `client_update_required`, every row carrying `trigger` (*sync*, the engine's flag; *sign_in*,
  a 426 at sign-in): {state: shown, status: 426} once the alert is on screen; {action: update} for
  *Get the update* from the alert or You, then {action: update, outcome: failed} when the destination
  cannot open; {action: keep} for *Keep working on this phone*. Dismissing the could-not-open
  transient records nothing.

### 7.16 On this phone — a workout the account has not taken (§5 Status)

A signed-out workout prepared for the account at sign-in may wait (no connection), need a
decision (the account has an open workout), or be refused by the log (an overlap, times that do
not line up, over 200 sets, a missing movement, an identity already spent). Android draws a card
per refused workout in Settings and a door on every tab; iOS draws one row and one badge:

- **The row.** Signed in, The log's head gains **On this phone** above Bodyweight while a workout
  waits — always one row. One workout: *Push A · Sep 23 · 12 sets* (*Free session* when unlinked;
  *1 set from Push A · Sep 23* for a stranded set), its subtitle the state (*Adding…* with a
  trailing `ProgressView` in flight, else the reason below), a door to Inspect. Two or more: *3
  workouts on this phone*, subtitle *2 need you* (or *Adding…* when none does), a door to a pushed
  **On this phone** list in two sections, **Needs you** and **Adding**, each row as above. The row
  leaves when nothing waits.
- **The badge.** The Log tab carries the system `badge` with the count of workouts that need the
  lifter's decision — refused, or waiting on Keep — never one in flight. It is the one badge the
  room draws; Coach and the room menu draw none.
- **The reason**, at most twelve words naming the way out, is the row's subtitle, the Inspect
  head's footer and the transient after a refused retry. A saved workout's refusal never reaches the
  room's band, and the lifter cannot dismiss its notice: only a queued retry answers it, and until
  then the reason stays. The table holds what iOS receives, by the reason label its events carry:

  | Reason | Line |
  |---|---|
  | `session-open` | *Your account has an open workout — keep this one as finished.* |
  | `session-overlap` | *Overlaps another workout — fix its times.* |
  | `id-taken` (`id-taken` · `id-spent` · `payload-conflict`) | *Already added once — discard this copy.* |
  | `bad-instant` | *Its times don't line up — fix the times.* |
  | `too-many-sets` | *Over 200 sets — remove some, then retry.* |
  | `unknown-exercise` | *A movement is missing — fix its sets, then retry.* |
  | `session-finished` | *A set missed its workout — retry puts it back.* (*2 sets missed their workout — retry puts them back.*) |
  | `unsent` (not on the log, with no refusal on record) | *Not on your log yet — retry to add it.* |
  | `invalid-set` · `other` (`parent-dead`, `too-large`, `stale`, …) | *Refused by the log — fix the workout, then retry.* (the code beside the date in Inspect's subtitle) |

  iOS imports carry no set numbers and always carry their finish, a routine the log cannot read only
  drops the plan, and the engine recovers `clock-skew` on its own, so Android's `source-numbering`,
  `source-auto-closed`, `frozen-plan-changed`/`routine-missing` and `recovery-*` rows have no iOS line.
- **Inspect** is a pushed screen: title the routine name, subtitle the date (subtitle form);
  `FactTiles` Duration · Working sets · Volume, drawing only the facts that are known, with the
  reason as that section's footer; *Started* and *Finished* as fact rows holding the time alone (a
  finish on a later day adds its day); then a section per movement of read-only `SetRow`s (*1 · 100
  × 5*, *W* for a warmup, effort and note as the second line). A stranded set shows Working sets ·
  Volume and its own rows only. The band holds the reason's one primary, chosen by the reason alone
  and the same for a stranded set: *Keep as finished* (`session-open`), *Retry* (`session-finished`,
  `unsent`), *Fix workout* for every other reason, and none for `id-taken`, whose way out is
  *Discard workout*. A retry is offered only for a reason a retry can change. A stranded set's *Fix
  workout* edits the stranded sets alone. Keep and Retry disable until the log's first pull is
  complete, with *Adding it needs a connection.* in the band's transient above them, and while
  backup is paused, with *Sign in again to add it.*
  The bar's `ellipsis.circle` holds *Fix workout* when the copy can be fixed (every reason but
  `id-taken`) and Fix is not already the primary, and *Discard workout* (destructive, the
  nine-second window). Discard pops to The log, where the band reads *Workout discarded* · *Undo*.
  For a stranded set the item reads *Discard 1 set* / *Discard 3 sets*, and the band *Set
  discarded* / *Sets discarded* · *Undo*. A workout on its way has no band and no menu.
- **Fix workout** is a `.large` sheet that commits from its bar like every edit sheet: *Cancel* ·
  *Fix workout* · ✓, the checkmark's label *Save and retry* (on iOS 18 the bold words), since the
  commit both saves the copy and sends it. Sections: **Times** — *Started*
  and *Finished* as compact `DatePicker` rows, an open workout's *Finished* reading *Not finished*
  with a quiet *Mark finished* that fills it from the last set; a *Linked to Push A* toggle whose off
  state drops the saved plan; then a section per movement, each row opening the Fix set sheet
  (weight, reps, effort, kind, movement, time, note, delete). The sheet has no destructive row:
  Discard lives on Inspect, with its window. Over 200 sets the bar's ✓ disables and the held reason,
  *Over 200 sets · remove 12.*, stands in the band at the sheet's foot; any other refusal the phone
  predicts — a movement the catalogue lacks, a finish after now, times that cross another workout —
  disables it with that reason's line in the same place. Edits touch the phone's copy only; the
  retry sends the corrected import under the same identity.
- **Keep** and **Retry** act from the band. While a kept or fixed workout is queued, Inspect's
  transient reads *Adding Push A to your log.* (the workout's name), never that it is on the log,
  and the row reads *Adding…*; both leave when the log confirms it; on refusal the row's reason
  updates and the transient says the new one.
- **A retry sends every set or none.** Retrying an open saved workout starts it and sends each of
  its sets in one plan, so a refusal leaves nothing half-sent.
- **A stranded set** (`session-finished`) goes back in one plan: the stranded sets inside its
  workout's window are appended while that workout is open, or corrected in once it is finished
  (`CorrectSession(preserveOtherSets: true)`), numbered after the sets it kept and with their times
  left alone. The sets outside the window become a saved copy of their own — a new workout from the
  first of them to the last, under a new identity — whose import is queued, so its refusal is that
  copy's own row, with Fix. This is the domain's rule (`RecoverStrandedSets`), with vectors before
  the screens.
- Events `gym_import_recovery` {action: inspect · fix · keep · retry · discard, reason}: a screen
  opening carries {state: opened}; a commit or a close carries {outcome: completed · cancelled ·
  refused · failed}. Save and retry is `fix` with an outcome. Failures `gym_import_fix` ·
  `gym_import_keep` · `gym_import_retry` · `gym_import_discard`.

### 7.17 Dates and counts (§3)

Every date on every Gym and shell screen passes through the one date formatter's four forms, and
every count through `GymCount`. No view builds a date string or a plural of its own. A tile's label
agrees with its value (*1 · Working set*).

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
  stamp (*14 MAR* over *5 MO* in the current year, *22 AUG 2025* over *1 YR* otherwise; a 48 pt
  column, `ink-faint`) beside the older words in `journal/lamp`, Inter 17. Under the last passage,
  *Useful · Not useful* as two quiet `.footnote` buttons, and when more remain, one row *8 more* ›
  that opens the reader. Tapping the capsule again, or anywhere outside the ink, closes it. Only one
  day's ink is open at a time.
- **The reader.** A `.sheet` with `.medium` and `.large` detents, title *From your journal*,
  *Close* trailing and no drag indicator, listing every passage for that day as the same rows,
  grouped by year. Tapping a passage flies the canvas to that day and closes the sheet.
- **First echo, once.** The first echo an install ever receives shows a card above the ink the
  first time it opens: *From your journal* · *Older lines that echo what you wrote today. Only
  you see them; they cost nothing.* · *Got it*. Never again.
- **While writing**, no tab draws on today's row and no ink opens; a tab that was open closes when
  the keyboard rises.
- **Never**: a count on the room menu, a notification, a red dot, an unread total.

## 9. Where this spec and the rest of canon differ

Recorded in `consistency.md` under *iOS redesign*:

- **Colour and drawings:** 9a (light gym accent vs Figma Daylight `brand/base`), *iOS gym and shell
  day contrast* (the darker light values awaiting the owner, and the Figma collections that follow
  them), 9d (two gym light grounds in the Design System collections), 9e (the first-run boards' W
  capsule and hand-drawn glass), 9h (warm journal day inks in the Figma collection), 9m (the
  iteration-1 boards against §5–§7).
- **The log and progress:** 9b (phones weave, web keeps the strip), 9o (moments are doors on iOS,
  expanders on Android), 9p (a record stated once), 9q (*Weigh in* in the bar), 9y (the progress
  strings the iOS build draws against `18-progress.md`).
- **The workout:** 9c (the rack's kind picker), 9k (the untaken workout's row and badge vs Android's
  card and door), 9l (the Live Activity's unlabelled clocks), 9n (the set-note footer).
- **Coach:** 9i (the proposal card), 9j (the Review band's one caption slot), 9s (Notes' lines), 9t
  (Connected log with a connection), 6w (no keyboard toolbar on iOS 26).
- **Shell and cross-room:** 9r (no Gym settings), 9u (dates in the person's locale), 9v (the
  signed-out share door), 9w (You's sections vs `superapp-shell.md` §6), 9x (the room menu's You and
  room item), 9f and 9g under *Onboarding* (the gym glimpse, where each product lives).

Two proposals in `consistency.md` wait on the owner and are not part of this contract: the open
workout as a tab-bar accessory, and Control Center and App Intent controls.

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
both modes (9a). They are iteration-1 drawings; what §5–§7 rule past them is written here and not
yet drawn (9m).

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

Iteration 3's captures show:

1. **Say it once.**
   - The log with a record stated once (a moment, or a dot when it has no moment) and session rows
     carrying their facts.
   - The newest weigh-in only in the head; no record on a first session.
   - A Coach answer with a body-less proposal card.
   - The Record with no readout at rest.
   - The rack with *Log set* and no plan line over planned rows.
   - You whose identity line is the one status, with no *Your data*.
2. **One chevron.** The log's moments as doors with the system chevron, opening the Record with its
   point selected; no `DisclosureGroup` in The log; the Review diff as `GymRow`s in one section.
3. **Nothing floats on content.**
   - *Weigh in* in The log's bar; no seat in Gym.
   - Every band clearing the last row at rest, and the scroll edge softening text that passes under
     bars and bands.
   - Captured scrolled mid-list on The log, the rack ledger, the Review sheet, Fix workout and a
     picker.
   - The transient band as glass over rows, in both appearances.
4. **Sheets commit from the bar:** Fix set, Weigh in, Targets, Create movement, Fix workout.
   *Heavier than the plan* as a dialog. Search-to-create in a picker with a query. *Sign out* as one
   alert. Share this workout signed out with *Sign in to share*.
5. **On this phone** with one waiting workout, and with nine (one row and the pushed list); a
   queued workout reading *Adding Push A to your log.*; a stranded set with *Fix workout* for a
   fixable reason, its *Discard 1 set* and *Set discarded*; Discard returning to The log.
6. **Update and sign-in:** the update alert signed in and signed out; You with *Finish signing in*
   offline and while the update is required; a Finish refused for the update; the room menu and back
   chevrons in ink.
7. **One date formatter:** a screen of each form — log rows, Record, receipt subtitle, session
   subtitle, Inspect, weigh-in.
8. **AX3 in both appearances** for: the rack (reps visible), the keypad (*0* reachable), the Coach
   composer, Fix set, the receipt, Inspect, You. **375 × 667** for the same, plus Journal and the
   shell.
9. **The Live Activity:** banner, expanded, compact and minimal Island, both appearances, with no
   clock labels.
10. **Five interactions as screen recordings**, since a still cannot show them: Log set, a ladder
   tap, Apply to receipt, a moment opening the Record, the band rising and dismissing (§5 Motion).
