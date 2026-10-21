# iOS rendering contract

The design contract for the Windmill iOS app (`apps/ios/App`): the shell, the Journal room and the
Gym room, on iOS 26 with Liquid Glass, deploying to iOS 18. It rules how the app renders; the
product contracts it dresses stay where they are — `guidelines/superapp-shell.md` and
`superapp-flow.md` for the frame and the journey, `journal/` for the canvas, `gym/briefs/` for the
room. Where this file and a brief disagree, this file wins on iOS and the disagreement is in
`consistency.md`.

Drawings of record: [iOS · Gym refinement · 2026-10-18](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O/?node-id=1063-477) covers the routine summary, workout, finish and Log swipe in both appearances. The other screens use the Gym file's iOS section and Shell's chrome boards and Journal's Echoes boards (§10). Figma uses Inter for editable specimens where its SF Pro renderer supplies no glyph metrics; the app uses the system text styles below. Native chrome is a structural drawing: SwiftUI owns its appearance.

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
construction outside `Sources/Theme/` and every fade below outside its one home (the app's README
lists what it checks). Onboarding's illustration kind colours are private to the glimpse as named
specimen roles, colour sets under `onboarding/` in the app's own `Resources/Assets.xcassets`.

**A fade is a role.** A colour at another strength — a wash, a resting dot, a glow — is a named role
in `Palettes.swift` (`accent-soft`, `brandWash`, `inkResting`), or, inside the onboarding glimpse, a
named member of `OnboardingSpecimen`, so its contrast is judged where it is defined. Nowhere else,
`Sources/Theme/` included, is a colour faded: no `.opacity` or `withAlphaComponent` on a colour value
(a role, a local alias of one, a specimen), no `.mix(with:by:)`, no hierarchical level of a role or
the tint (`role.secondary`, `.tint.secondary`, a bare `.secondary` on room text), and no constant
view `.opacity` other than 0 or 1 on a view that draws text or a symbol. A journal scale thumb glows
in its own colour — one of the eleven mood steps, or energy — so its glow is a role keyed by the step,
`JournalPalette.moodGlow(_:)` and `energyGlow(_:)`: the thumb's colour at 45 %, at 78 % on the top
step. Four dimmings stay, each in one place: a disabled primary takes the system's `.secondary` label
in `RoomPrimaryStyle`, since a forced `on-accent` label would stand white on the system's disabled
fill, and a disabled control is outside the contrast floor (WCAG 1.4.3, inactive components); the
composer's send circle at 40 % (§6), the one control the room draws that dims; *Continue with Apple*
at the same 40 % while offline disables it (§5 Status), since it is Apple's control, whose black and
white the room never recolours, and a disabled door must read disabled; and `DoorChevron` in the
ink's `.tertiary`, as the system draws a `NavigationLink`'s chevron. Opacity as motion — a view at 0
or 1 at rest and animated between, the glimpse's one beat and its one loop — is not a fade. The
system's label hierarchy also stays where the system owns the ground: the iOS 18 bar's subtitle, and
the Live Activity on the Island's black.

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
| `gym/accent` | `#5FCDB4` | `#106B5F` | tint: links, selection, the primary fill, chart dots, the current-set dot |
| `gym/accent-soft` | `#5FCDB4` at 16 % | `#106B5F` at 12 % | the lifter's bubble, a selected row's wash |
| `gym/on-accent` | `#1B1408` | `#FFFFFF` | text and symbols on the accent fill |
| `gym/done` | `#9AA859` | `#7D8C43` | a logged set's check, a fully logged movement, an applied proposal |
| `gym/record` | `#D9B04C` | `#6E5217` | a personal record, and nothing else |
| `gym/alarm` | `#D08268` | `#A84E35` | destructive labels, refusal text in a field |
| `gym/alarm-fill` | `#A84E35` | `#A84E35` | a removal proposal's primary; native destructive actions use the system red |

These roles bind to Figma Theme `ios/gym/*` in Dark and Light. The native light accent is
verdigris `#106B5F`, darkened from the shared Gym brand `#137A6C` so text holds 4.5:1 on the
Gym grounds. Gold is a *record*, never a warning; brick is destructive only.

The Live Activity uses `gym/accent` and `gym/on-accent` for its one button and `gym/accent` for
the keyline; the banner ground stays the system's. The workout control (§7.19) declares `gym/accent`
as its tint; Control Center draws a button control's symbol white, so the tint shows only where the
system draws one.

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
| `shell/brand` | `#D08A5E` | `#9F5B38` |
| `shell/on-brand` | `#1B1408` | `#FFFFFF` |
| `shell/danger` | `#F2685A` | `#A62B2B` |

As text, the light `gym/accent` `#106B5F` measures 5.19:1 on `gym/canvas`, 5.92:1 on `gym/card`
and 4.60:1 on `gym/raised`, and white on it 6.38:1; the light `shell/brand` `#9F5B38` measures
4.79:1 on `shell/canvas`, 5.21:1 on `shell/card` and 5.04:1 on `shell/raised`, and white on it
5.21:1. No clay text sits on `shell/sunken` (4.42:1).

Clay is the brand and brick is destructive, so the two never share a hue: `shell/danger` is a red
brick, apart from clay by ΔE2000 14.8 in light and 15.3 in dark. *Done* above *Sign out* on You,
and *Try again* above *Cancel sign-in*, read as two colours. As text, the light `shell/danger`
measures 6.43:1 on `shell/canvas`, 7.00:1 on `shell/card` and 6.76:1 on `shell/raised`; the dark
`#F2685A` measures 6.47:1, 5.88:1 and 5.22:1. Danger is only ever text: no fill takes it.

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

**Counts and labels.** Every count passes through one formatter with real plurals — *1 workout*,
*2 working sets*, *1 movement* — and the formatter (`GymCount`) is the only place a plural is
spelled. A tile's label is a noun that agrees with its value (*1 · Working set*, *Duration ·
Working sets · Volume*), never a unit; the unit rides on the value (*1620 kg*). A chart's axis
labels round to the step the series moves in — plate loads to the nearest 5 (*110 · 60*),
bodyweight to one decimal — never to two decimals.

**Dates.** Every date in the Gym room and the shell passes through one date formatter, `GymDate`,
with six forms. It formats through `Date.FormatStyle` in the locale the system gives the app: the
person's region — its order of day and month, its hour cycle, its range format — with English
names, since English is the app's one language. *Today* and *Yesterday* are English words, like
every other word on screen.

- **row day** *Wed 23* — only inside a month-sectioned list, whose header names the month, and the
  year when it is not the current one (*September*, *September 2025*). A row day never names the
  year and never says *Today* or *Yesterday*: it is the row's place in its month, so today's row
  reads *Fri 16* like the rows under it.
- **day** *Sep 23* — the year only when it is not the current one (*Sep 23, 2025*); *Today* and
  *Yesterday* as a trailing value, lowercase inside a sentence.
- **subtitle** *Wed, Sep 23* — the year only when it is not the current one (*Wed, Sep 23, 2025*).
- **span** — the subtitle form, then the times in the locale's own range format: *Wed, Sep 23 ·
  12:00–12:45 PM* (*12:00–12:45* on a 24-hour clock). A span that crosses midnight, or one the
  clock's offset changes inside (a daylight-saving shift), keeps the first day and joins its two
  times with a spaced en dash: *Mon, Oct 12 · 11:43 PM – 12:20 AM*. A span with no end yet is its
  day and its start, *Wed, Sep 23 · 12:00 PM*.
- **time** *11:27 AM* — the time alone, where the day is already said or is today: the workout's
  bar subtitle (its start), *Open since 11:27 AM*, Inspect's *Started* and *Finished*, *From Coach
  · 6:42 PM*.
- **month** *September* — the year only when it is not the current one (*September 2025*): a
  month section's header, and the month a month moment names (§7.6).

Where a moment needs its day and its time, `GymDate` joins the day form and the time form with
` · `, so no view does: *Sep 26 · 6:42 PM*, *Yesterday · 11:43 PM* — a finish on a later day than
its start, a hidden workout open since an earlier day (*Open since yesterday · 11:43 PM*), the
Review sheet's *proposed by Coach · Sep 26 · 6:42 PM*. A run of days joins two day forms with a
spaced en dash, *Jul 7 – Aug 4*. Date pickers are the system's. No view orders a day and month by
hand. The journal's date line and echo stamp keep the journal's mono forms (§8).

**Workout, never session.** On every screen the thing a lifter starts, logs into and finishes is a
*workout*: in a title, a count, a footer, a refusal, a VoiceOver label or hint, a Siri answer and a
Shortcuts parameter. *Session* is the word in code and on the wire (`Session`, `sessionId`,
`gym_session_started`, accessibility identifiers) and never on screen. Each string that carries
the noun reads:

| Where | Drawn | Never |
|---|---|---|
| A workout with no routine, wherever its name stands: the logger's title, the Live Activity, the accessory (§7.18), The log, session detail, the receipt's subtitle, **On this phone**, Inspect, *Adding … to your log.* | *Free workout* | *Free session* |
| The log, empty | *No workouts yet*; *No finished workouts yet* while a workout is open | *No sessions yet* |
| The log's end, its last section's footer | *28 workouts* | *28 sessions* |
| The Record's window line | *last 12 weeks · 28 workouts* · *the whole series · 23 workouts* | *Last 12 weeks · 28 sessions* · *All · 23 sessions* |
| A chart's gap label, and its VoiceOver actions | *no workout · Jul 7 – Aug 4*; *Earlier workout* · *Later workout* | *no session · …*; *earlier session* · *later session* |
| Coach's read receipt | *Read 18 workouts · 6 weeks* | *read 214 sets · 6 weeks · 18 sessions* |
| The logger's leading bar button (its label) and the sheet it opens | *This workout* | *This session* |
| The logger's movement name, its VoiceOver hint | *Open this workout's movements* | *Open this session's movements* |
| The varied-scheme sheet's footer | *Today's Back Squat ran at 105 against a planned 100. Today's workout already has it. Lower A does not.* | *… Today's session already has it. …* |
| The logger's band, when the movement order cannot be read | *The workout is saved. Its movement order could not be read. Try again.* | *The session is saved. …* |
| The logger's band, removing a movement with sets or targets | *A movement with sets or planned targets stays in this workout.* | *… stays in this session.* |
| The receipt's *Share with Coach*: the line it sends | *Check my last workout.* | *Check my last session.* |
| Review while a workout is open: the caption slot, and the refusal on Apply or *Turn this down* | *Finish your workout to apply.* · *Finish your workout first.* | *Finish this session to apply.* · *Finish this session* |
| The workout parameter's title on the Live Activity's and the control's intents (§7.19) | *Workout* | *Session* |
| Sign-in, when the server's answer holds no sign-in | *Sign-in did not finish. Your pages are still on this phone.* | *Sign-in did not return a native session. …* |

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
  checked. It carries rooms only: Journal and Gym. You and settings have one account button; ink
  notes belong to onboarding and have no replay action in this menu.
- **Top-right: the account button.** `ToolbarItem(placement: .topBarTrailing)` holding
  `Button { } label: { Image(systemName: "person.crop.circle") }` with the accessibility label
  *You and settings*. The system symbol, default rendering, no custom shape. It sits last; on
  iOS 26 a `ToolbarSpacer(.fixed)` separates it from the room's own actions so it stands in its own
  glass circle and the room's actions share theirs.
- **The room's own actions** come before the account button: Routines `plus` (*New routine*); The
  log `scalemass` (*Weigh in*); Coach `clock` (*History*); a pushed screen draws its own.
  Order is actions then account, and nothing is painted inside a toolbar item. All three roots read
  `[Room ⌄] … [action] [account]`.
- **Journal sits in a `NavigationStack`** so its bar is the system's: a visible bar filled
  `journal/canvas` in the room's appearance, so past pages scroll beneath it instead of under the
  bar's items; no title, the room menu and account button as above. The ink notes anchor to the
  toolbar items' frames (`onGeometryChange` inside the labels).
- **Bar items render in the room's ink** at the bar's default weight in every room (`.roomBar`,
  applied after a screen's toolbar), the room menu and the back chevron included. The room accent
  appears in a bar only on a confirmation action: *Finish*, a sheet's
  checkmark, and *Done* on the shell's sheets in `shell/brand`. *Close*, *Cancel* and the back
  chevron are dismissals and take the ink in every room, the shell's sign-in steps, Keep and the
  journal's echo reader included. No `.fill` variants in bars; `.fill` is for a selected tab only.
- **Top bars keep the system's soft scroll-edge effect**; no page hides it, so content passing
  under a bar's title softens instead of reading through it.

### Buttons

| Kind | iOS 26 | iOS 18 fallback | Where |
|---|---|---|---|
| Primary | `.buttonStyle(.glassProminent)`, `.controlSize(.large)`, full width, tint `accent`, label `on-accent` | `.borderedProminent` | one per screen, in the reach band |
| Secondary | `.buttonStyle(.glass)` | `.bordered` | ladder keys, chips, *Ask Coach* on an empty screen |
| Quiet | `.buttonStyle(.plain)` in `accent` | same | row actions, *Not now*, *Use email instead* |
| Destructive | `role: .destructive` in a Menu or list row | same | never a prominent fill, except a removal's primary (§6) |
| Seat | a 44 pt glass circle with one symbol, bottom-trailing, 16 pt from the edges | material circle | Journal *Write* |

**The reach band.** Whatever stands at the foot of a screen — its one primary, its footer, its
transient — is placed with `.reachBand { }`: `safeAreaBar(edge: .bottom)` on iOS 26, so the
system's scroll-edge effect softens what passes beneath it; on iOS 18 `safeAreaInset(edge:
.bottom)` with the `.bar` material, drawn only while content is beneath. At rest the list's last
row clears the band. A band that carries text outside a button — an `ActionBand` footer, the Review's
caption, a quiet button such as *Turn this down* or *Revoke the link* — stands on a surface, at every
text size (`.reachBand(onSurface: true)`): while content is beneath it, the band takes the `.bar`
material on both systems, and on iOS 26 the scroll view beneath it also takes the hard scroll edge
(`.scrollEdgeEffectStyle(.hard, for: .bottom)`), so rows passing under the band stop at its edge and
nothing reads through its words. The hard edge alone is not opaque: under a band as tall as the
Review's at AX3, a row's blurred words still show. A band of buttons alone keeps the soft edge. A
band floats only where reach or a gate rules it:
*Log set*, *Start*, *Apply*, the receipt's *Done*,
*Connect a tool*, Inspect's recovery primary, and the steps of a flow (sign-in, Keep, onboarding).
A sheet that edits a record commits from its bar (§5).

CTA copy is at most three words: *Start*, *Log set*, *Save routine*,
*Share with Coach*, *Sign in to share*, *Set*.

**Doors and actions in a list.** A row that navigates is a `NavigationLink`: ink label, optional
symbol, the system's chevron — *Connected log*, *About Windmill*. A row that opens a sheet or a cover
(a note in Notes, a weigh-in in Bodyweight; on iOS 18 the **Hidden** row brings back the logger) is
a `Button` drawing the same chevron (`DoorChevron`, `chevron.forward`, never a hand-set
`chevron.right`). A row that acts is a `Button` in
`accent` with no chevron — *Add movement*, *Add a note*. A screen's one primary is never a row; it is
the band. Accent text on a door, or a chevron on an action, is a defect. The only row that unfolds
in place is a kept run in the Review diff (§6); it carries a rotating `chevron.down`, never the
navigation chevron. A `SetRow` is the one row that opens a sheet without a chevron: every set in a
ledger opens Fix set, and a chevron on each would repeat down the list; its trailing slot is the
caption (§5).

### The tab bar

The system `TabView` with the `Tab` API, `.tabBarMinimizeBehavior(.onScrollDown)` on iOS 26.
Routines `list.bullet.rectangle` · The log `calendar` · Coach `bubble.left.and.bubble.right`.
The `TabView` carries `gym/accent` as its tint, so the selected tab is verdigris; the system draws
the selection, the room supplies the symbol (`12-native-idiom.md`). Hidden on every pushed screen
and sheet, and while Coach's composer has focus (`.toolbarVisibility(.hidden, for: .tabBar)`). On
iOS 26 it carries one bottom accessory, a hidden workout's way back (§7.18), and only while the
lifter has hidden the workout.

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

- Deletion and discard have no Undo control or delay window. Discarding a whole workout or
  deleting a Coach conversation asks once using the native confirmation attached to its source,
  then queues immediately. Their swipe actions reveal a red trash button and disable full swipe.
  Explicit Delete controls for sets, routines, notes and weigh-ins commit immediately; no gesture
  deletes through a full swipe. Cancellation leaves a confirmed record untouched. Keep refusal
  and delivery recovery visible.
- An irreversible act asks once. A `.alert` carries the act as its destructive button and Cancel
  (*Turn this down?*, *Sign out?*); a choice asked from a row is a `.confirmationDialog` presented
  from that row, title visible (*Remove Apple?*), which SwiftUI anchors to its source on iOS 26.
- A `.confirmationDialog` always has a source: the control or row the lifter touched. A question
  nothing on screen raised is an `.alert`, centred by design, never a dialog floating over the
  content.
- A yes/no is never a sheet: *Heavier than the plan* is an `.alert` (§7.7).
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
| This workout | `.large` | *Close* · title · *Edit* |
| Review | `.large` | *Close* · title; *Apply* in the band |
| Finish | `.large`, one detent: it opens over the finished workout's detail, whose tiles a shorter sheet would leave showing above its own (§7.9) | no duplicate Done; the primary is in the bottom band |
| Routine summary | `.medium`, `.large`; accessibility sizes use `.large` | *Close* · title · *Edit* |
| You, sign-in steps | `.large`; Keep and the Apple questions `.medium` | *Done* / *Close* |

A sheet that edits a record commits from its bar's `.confirmationAction`, drawn once by
`.sheetCommit`: *Cancel* leading and, on iOS 26, a `role: .confirm` checkmark on `.glassProminent`
whose glyph is `on-accent` and whose accessibility label is the commit's name (✓ above); on iOS 18
the name in bold. Never a pill at its foot; its destructive act, when it has one, is the form's
last row in `alarm`. That is how Calendar, Contacts, Reminders and Health's *Add Data* commit. The
checkmark disables while the form cannot save: an empty or refused field, or an existing record
left unchanged.

A sheet with two detents (*What Coach read*, the echo reader) shows the system's grabber, since it
resizes; a sheet with one detent hides it. `presentationCornerRadius` is never
set. A pinned primary inside a sheet uses the reach-band rule of §4.

### Shared components

The room draws each of these once, in `Sources/Gym/Components/` (or `Sources/Theme/` when
product-neutral), and every feature uses the one:

| Component | What it is | Owner |
|---|---|---|
| `GymPage` modifier | the canvas, the tint, the inline or large title; it keeps the bars' scroll-edge effect | Gym |
| `RoomTransient` | the one band (below); `GymTransient` adapts it to the room | Theme (shape), Gym (adapter) |
| `roomTitle(_:subtitle:)` | the inline title with its `.navigationSubtitle`, the two stacked in the bar's principal slot on iOS 18 | Theme |
| `.reachBand { }` | the bar every bottom band stands in (§4); `onSurface: true` for a band that carries text outside a button | Theme |
| `.roomBar` | the room's ink as the toolbar's tint (§4) | Theme |
| `SoftEdge` | a 16 pt fade, with a 16 pt content margin, on the edge of a scroll view that passes under a fixed head or foot rather than a bar, where the system draws no scroll edge: the ledger's top (§7.7), an onboarding page's bottom while it scrolls (§7.12) | Theme |
| `DoorChevron` | the chevron of a door a `Button` opens, drawn as the system draws a `NavigationLink`'s | Theme |
| `ActionBand` | the one floating primary in the reach band, with its optional trailing symbol, its one-line footer on the band's surface (§4; never bare text over the list), and disabled and busy states | Theme |
| `.sheetCommit` | an edit sheet's bar: *Cancel* and the checkmark (§5 Sheets) | Gym |
| `WeightInstrument` | the big numeral with its unit at the numeral's baseline, the four-key ladder in `ink` and its accessibility reflow; centred and the same wherever it is drawn, a sheet's tint never reaching its keys | Gym |
| `SetEditor` | weight, reps, effort, note, Kind (segmented), delete; validation and its refusal text; the note's byte counter only from 3,200 bytes; over a saved workout's set also movement and time, returned to that workout's draft | Gym |
| `RenameMovementSheet` | one sheet, `.medium`, the name field, a counter only from 48 characters, and one help line: *Renames it everywhere; the old name still finds it.* | Gym |
| `GymRow` | a title over one meta line, with an optional leading symbol or dot and an optional trailing fact, `iphone`, check, progress or `DoorChevron`, and a fact followed by `DoorChevron` on a row that opens a sheet; every list row of a title over one line, The log's included. It takes the list's own row height: a title-only row is the system's one-line row, never padded to a two-line height, and the 44 pt target is the list row's | Gym |
| `SetRow` | a set read back: its place, its numbers, a trailing caption (a working set's comparison with the plan; a warmup, drop or failure set carries none, since its letter is its kind), then time, effort and note when present. Tapping it fixes the set, and it draws no chevron (§4). Its place is one rule everywhere — the ledger, session detail, Inspect and Fix workout: a working set by its count among the working sets so far (*1*, *2*), any other kind by its letter (*W*, *D*, *F*) | Gym |
| `MoreMenu` | `ellipsis.circle` in the bar presenting the native Menu | Gym |
| `FactTiles` | up to three value-over-label tiles, drawing only the facts that are known; a session's tiles come from one constructor over its readout, so Duration · Working sets · Volume read the same on session detail, the receipt and Inspect | Gym |
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
- **A section with nothing in it is not drawn** (a routine's History, You's **On this phone**); a
  row that has nothing to say is not drawn either (**Hidden**, The log's **On this phone**,
  *Bodyweight* before the first weigh-in). The end of a long list is the last section's footer (The
  log's *28 workouts*), never a card. A whole empty screen is `ContentUnavailableView`. No third shape.
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

The room has one component, `RoomTransient`, for refusals, notices and copied-link
confirmations: a `.footnote` message on the system glass or material surface. It wraps rather
than truncates and carries one control: *Try again* when recovery is possible, otherwise the
dismiss `xmark`. A dismissible notice also leaves by a downward swipe. A failed read remains
until *Try again* succeeds. The band occupies the reach band without moving its primary. Refusal text is `gym/ink`, never red: the band is the signal. A
refusal is a sentence, at most twelve words, and names the way out (*Overlaps another workout — fix
its times.*); the copy is the brief's. The signed-out workout a signed-in account has not taken is
not a band and not a card on Routines: it is the **On this phone** row at the head of The log
(§7.16).

### Motion

Each act the lifter makes answers in place, with the system's springs:

- **Log set:** the current row's dot turns into the check (`symbolEffect(.replace)`), the next
  planned row slides into the current slot, and the numeral rolls with
  `.contentTransition(.numericText())` on every ladder tap. Logging stays visual: no set-confirmation
  sound or haptic (`gym/android-delivery.md`).
- **Apply:** the button turns into the receipt *Applied* with a `checkmark` bounce and a success
  haptic (§6). The sheet stays until closed.
- **A new record at Finish:** the receipt's *Personal record* line arrives with one `gym/record`
  pulse. Never a confetti burst.
- **A moment** opens the Record with a zoom from its row (§7.6).
- **The band** rises with the system spring and leaves the way it came, by a swipe down as well as
  by its `xmark` when it has one.
- **A hidden workout coming back** on iOS 26: the logger rises from the tab bar's accessory with a
  zoom (§7.18).

With Reduce Motion each is a 200 ms fade.

## 6. Coach

The conversation is the content; everything else is chrome, and the chrome is the bar, the
composer and one menu. Signed in with routines, an empty Coach shows the bar, an empty canvas
and the composer — nothing else (`gym/feedback-contract.md` "Coach conversation"): no pinned rows,
no capability text, no allowance line until a limit is in the way (`09-coach.md` "Limits are
contextual"), no *Done* row and no account item, since the account button is in the bar. *Jump to
latest* is a 36 pt glass circle with `chevron.down`, bottom-trailing above the composer.

**History** is the trailing `clock` toolbar button before the account button. It opens the
conversation list. *New chat* belongs in History. Notes and Connected log live in the Gym section
of You and settings; they have no duplicate Coach-menu entries.

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
monospaced digits, a leading `book.closed`: *Read 18 workouts · 6 weeks* ›. It opens *What Coach
read*, whose one section lists every workout read as `GymRow`s (*Push A* · *Sat, Sep 26 · 1
working set · 400 kg*), each a door to the workout, headed by the receipt's numbers; *Also read
your notes.* is its footer when true. The sheet's numbers add up to the receipt's: it counts only
the workouts it can list. It has *Close*, opens at `.medium` and grows to `.large`, so it keeps the
system's grabber (§5). No `DisclosureGroup` in the conversation; no nested disclosures.

The receipt never states a number the sheet cannot list. An answer that listed no workout says what
it read in the phrase table's words (`09-coach.md`, "The verbs"), with no number and no chevron,
since there is nothing to open: *Read your movement history* when it read your totals
(`get_stats`), *Read nothing from your log* when it read nothing.

**A proposal card** on `gym/card`, radius 16, 1 pt `gym/accent` stroke:

```
PROPOSAL · PUSH A                        (eyebrow, accent)
→ Back Squat     1 × 5 · 80 → 1 × 3 · 90 kg   (change rows, up to 3: symbol accent, title ink, change ink-dim)
+ Bench Press    Added · open · after Back Squat
+ 1 more                                 (ink-faint)
Review changes                        ›  (the door: ink, the system chevron)
```

The change rows are the same `GymRow`s the Review sheet draws, so the card and the sheet read as
one object. No body line: the answer above is the reasoning. The door reads *Review changes*, and
*Review removal* on a removal's card. Pending, the card carries no caption, since the Review row is
the invitation; settled, the Review row's trailing caption is the settled word, the same on the
card, in History and in the Review's band:

| State | Word |
|---|---|
| applied | *Applied*, with a `gym/done` check |
| a removal applied | *Removed*, with a `gym/done` check |
| turned down | *Turned down*, `ink-dim` |
| superseded, or its routine changed since | *Out of date*, `ink-dim` |

What Coach did besides answering is one row under the answer, each a door: a created routine
*Open routine · Push A ›* with `list.bullet.rectangle`; a saved note *Saved a note ›* with
`note.text`, opening Notes — and, when the save could not be confirmed, *Could not confirm a note
save ›*, opening Notes the same way, where the note is or is not. A write is never silent.

**Signed out** the room is a `ContentUnavailableView` with `bubble.left.and.bubble.right`, no title
(the bar already says Coach), the canon sentence *Coach reads your log, so it needs you signed in.*
as its description, and *Sign in* as a `.glass` button; no composer — until the phone allowance
ships, when `09-coach.md` applies.

**The Review sheet** (`ProposalReview.swift`) lists the diff as one section of `GymRow`s headed
*3 changes*: the leading symbol is the only accent, the title is `ink` and the change is the
`ink-dim` subtitle, one row per line the proposal holds, in the proposal's order:

| Line | Symbol | Title | Subtitle |
|---|---|---|---|
| a movement retargeted | `arrow.right` | *Back Squat* | *1 × 5 · 80 → 1 × 3 · 90 kg*, then its rest when that moves: *· rest 1:30 → 2:00* |
| a movement added | `plus` | *Bench Press* | *Added · open · after Back Squat* (*first in the routine*) |
| a movement removed | `minus` | *Lunge* | *Removed · 3 × 8 · 40 kg*, the scheme it leaves with |
| the name | `pencil` | *Name* | *Push A → Push A2* |
| the order | `arrow.up.arrow.down` | *Order* | the new order in full, *Bench Press · Back Squat · Row*, wrapping, never truncated |

A rest reads as the workout's clocks do, minutes and seconds with monospaced digits; a side with no
rest of its own reads *default*. A kept run is a row *4 unchanged* that unfolds in place. The count
is the store's (`changeCount`, `09-coach.md` "Four · the return") wherever a proposal's changes are
counted — the section header, History and Routines — and the rows add up to it; a settled
proposal keeps the rows it drew while pending, *Order* included. The Apply gate is
scroll-to-the-end. *proposed by Coach · Sep 26 · 6:42 PM* (§3, a day and a time, joined once the log
has taken the proposal) is the sheet's subtitle. A proposal from a connected tool names the tool as
it named itself — its agent, else its connection — and *a connected tool* when it gave no name:
*proposed by a connected tool · Sep 26 · 6:42 PM*. The source is never left out, and the Routines
row says the same one (§7.5). The quote bar is the attribution, with no *Coach wrote:* label; the
quote is the proposal's summary, since the sheet also opens from Routines, where no answer sits
above it. *Ask Coach* is a quiet accent button under the diff. The band holds *Apply* — never a
count, which the section's header already carries — then one caption slot under it, then *Turn this
down* as a quiet `ink-dim` button; *Turn this down* raises its `.alert`, which keeps the destructive role
(`09-coach.md`). The caption slot keeps the height of its tallest line in every state, so Apply
never moves: while the diff is unseen it reads the gate's sentence *Scroll to the end to apply.*;
once the end has been seen it reads the atomic promise — *All or none. Nothing changes until you
tap.* for two changes or more, *Nothing changes until you tap.* for one, and the removal's *Your
logged sets stay. Nothing is removed until you tap.*

**A removal names its routine once on each surface**: the card's eyebrow, the Review's title. Its
diff is one row, `minus` in `alarm` · *Routine* · *Removed*, the title `ink` and the change
`ink-dim` like every diff row, so the word, not only the colour, says what goes; the card draws the
same row. Its primary is *Remove routine* in the prominent style filled `alarm-fill`, white text,
`role: .destructive`. The quote is the proposal's own summary and may name the routine; it is the
proposer's words, not chrome.

**While a decision waits on the log** the primary stays in place, disabled, naming the act in
flight with an inline `ProgressView`: *Applying…*, *Turning down…* or *Removing…* (*Sending…* when
the queue cannot be read to say which), and the caption slot is blank, since the button says the act
and the promise is no longer the news. After 15 seconds it enables as *Retry*, which resends the same
command, and the caption reads *Not confirmed yet.*; a Retry waits blank again for its own 15
seconds. A decision the phone could not write never waits: its refusal rises in the band (§5),
and Apply returns enabled over the promise, which holds once more. Never a spinner without an
end.

**The settled band.** When the log answers, the settled word of the card's table replaces Apply,
its caption and *Turn this down*: *Applied* with its check bouncing in, *Removed*, or *Turned down*
— the word alone, since the sheet's title names the routine and the header the count. A proposal
that is out of date has no Apply: the band holds its one line, `ink-dim`, naming why — *A newer
proposal replaced this one. Nothing was applied.* when a later proposal took its place; *The routine
changed after this was written. Nothing was applied.* when the routine moved under a pending one;
*This proposal is out of date. Nothing was applied.* when the store kept no reason. The diff stays
readable above it, and *Ask Coach* stays.

**History** (`CoachHistory.swift`) is a plain list of conversation rows, each the door to its
conversation: *Push A · 3 changes* (*Push A · a removal* for a removal; the question when the
conversation holds no proposal), the date trailing, and a settled proposal's word (the card's table)
as its caption.
A swipe-delete asks once, then removes the conversation without an Undo band. With none it is
`ContentUnavailableView("No conversations", systemImage: "bubble.left.and.bubble.right")`. History
has no pinned primary: Back returns to the composer.

**Notes** carries one fact as its header, *Any agent you connect can read these too.*
(`10-notes.md`), with no second heading line and no *Top note wins.* footer: the drag handle in
Edit carries the order (`consistency.md` 9s). *Add a note* is an action row. The note editor
commits from its bar with `.sheetCommit` (✓ *Save*, §5) and has no *Done* above the keyboard; a swipe
down puts the keyboard away. Signed out, Notes is the room's signed-out shape: a
`ContentUnavailableView` with `note.text`, no title, *Notes live with your account, so they need you
signed in.* as its description, and *Sign in* as a `.glass` button.

**Gym settings** is a section inside You and settings, holding Notes and Connected log. A hidden
workout returns through the tab bar's accessory on iOS 26 and the **Hidden** row at the head of
The log on iOS 18 (§7.18). The phone draws kg and offers no units control.

**Connected log** (`19-connected-log.md`) puts its one primary in the reach band: *Connect a tool*
is the floating `ActionBand` with `arrow.up.forward` trailing (*Sign in first* signed out). With
nothing connected, the head line *Your log, read by ChatGPT or Claude.* is `.subheadline
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

The History toolbar action; the composer; the receipt row and *What Coach read*; the card
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
  removal*) over *From Coach · 6:42 PM* — the time form while it came today, the day form after
  (*From Coach · Yesterday*, *From Coach · Sep 26*) — leading `bubble.left.and.bubble.right` in
  accent, the system chevron. A connected tool's proposal names the source the Review's subtitle
  names (§6): *From Claude · 6:42 PM*, or *From a connected tool · 6:42 PM* when the tool gave no
  name. Settled removal receipts are one row each.
- The root lists routines and proposals. Movement discovery belongs to routine editing and the workout.
- Empty: `ContentUnavailableView("No routines yet", systemImage: "list.bullet.rectangle")` with no
  description; signed in with Coach available it carries one `.glass` action *Ask Coach*, opening a
  new chat with *Build me a routine.* in the composer, unsent.
- Large title, `plus` and the account button in the bar. There is no free-workout primary on Routines.
- Tapping a routine opens a native summary sheet with movement targets, last-trained metadata,
  *Close* leading, *Edit* trailing, and a full-width *Start* in its bottom band. The sheet supports
  medium and large detents; accessibility sizes use large. Movement rows retain their Record door.
  History appears only when it has rows. Editing opens the routine builder after dismissing the summary.
- Edit routine ends with *Delete routine*, using the system destructive role. Its explicit tap
  closes the editor and removes the routine without an Undo band.
- Every movement search lists the two-line `GymRow`: the name, then *Barbell · 80 × 5 · 3 days
  ago*, or *Barbell* alone before the first log. A query with no exact match leads the results with a
  row **Create “<query>”** (`plus.circle.fill`, accent) opening Create movement with the name
  filled; with an empty query, `plus` in the bar (*New movement*). No floating button in a picker,
  and no pinned *Create movement* or *Add to routine*. The picker is titled *Add movement* from the
  builder and *Next movement* from the workout — never a question.
- The workout's *Next movement* and *Movements* search with `.searchable(placement:
  .navigationBarDrawer(displayMode: .always))`. The builder's *Add movement* searches from a field
  that is the list's first row — `magnifyingglass` in `ink-dim`, the field *Search movements*, a
  clear `xmark.circle.fill` with a 44 pt target while it holds text — a plain list row, never drawn
  to look like the system's search bar. Create movement is pushed inside the builder's sheet, and
  that field keeps its query visible across Create movement's Cancel (`15-the-routine.md`) while the
  pushed bar's ✓ takes its taps (`consistency.md` 10d).
- The builder's bar is *Cancel* · title · ✓ (*Save*) and nothing else: *Reorder* (*Done* while
  reordering) is the Movements section's header action; at accessibility sizes it stands under the
  header's text, which never hyphenates. Edit numbers its movements as the detail does (*1. Bench
  Press*). Its name field carries no header
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
  exists, with *Trained 3 of the last 4 weeks* as its footer when it exists. Before the first
  weigh-in the head is that footer alone, in the same place under the title, so the line never moves
  between the two states; with neither, the head is not drawn. Above it sit, on
  iOS 18, **Hidden** while the open workout is hidden, then, signed in, **On this phone** while a
  workout waits (§7.16).
- **Hidden** (iOS 18 only; iOS 26 draws the tab bar's accessory instead, §7.18). While the open
  workout is hidden, the head's first row is that workout: the routine name (*Free workout* when
  unlinked) over *Open since 11:27 AM* (the time form; *Open since yesterday · 11:43 PM* when it
  began on an earlier day), with `DoorChevron`; it brings the logger back. It sits at the head, not
  at the end: The log loads older workouts as the last row appears, so its end is no place to find
  something. At most one workout is open, so it is one row, never a list.
- **A session row** is a `GymRow`: the name, then its facts *18 working sets · 1h 03m*
  (monospaced digits), the day trailing in `ink-dim` (row day form), the system chevron; `iphone`
  before the day while unsent.
- **A record is stated once**: by its moment, woven under the session that earned it. A record
  session without a moment (the one-a-week cap in `18-progress.md`) carries an 8 pt `gym/record`
  dot after its name and nothing more; VoiceOver reads the dot as *new best*, after the name: *Push
  A, new best, 18 working sets · 1h 03m, Wed 23*.
- **A new best** is the domain's (`ProgressRecords`; vectors in
  `packages/api-contract/gym/domain/training-reads.json`). A record needs a prior estimate: a
  movement's first estimate is its baseline and sets no record, whatever sessions without an
  estimate came before it. A later estimate is a new best only when it beats the best before it as
  the log states both, to 0.1 kg, and the moment's gain is the difference of those two stated
  values, so a log never says *up 0 kg*. Over a partial history, before the first pull, nothing is
  a new best.
- **A moment is a door**, never an expander. A best moment is an 8 pt `gym/record` dot before
  *Bench Press · new best*, the facts *98 kg est · up 1.2 kg since Sep 17* as its subtitle, the
  system chevron; it opens the Record with a zoom transition from its row (the row is the
  `matchedTransitionSource` → `.navigationTransition(.zoom)`: the Record grows from what was tapped,
  where an 8 pt dot is too small a source to read as one), the chart scrolled to that session
  with its point marked by the inspected ring — marked, not read out: the moment just said its
  numbers, so the window line stays and the readout is the finger's alone. A weigh-in moment opens
  Bodyweight, and is woven only once a newer weigh-in exists — the newest is the head's. A month
  moment names its own month, never the last four weeks, which are the head's: *Trained every week
  of February* (the month form, §3), woven under that month for a past month whose every week holds
  a trained day, whatever today's weeks say. It is a plain row that opens nothing and carries no
  chevron. No `DisclosureGroup` in The log.
- **Weigh in** is the bar's action (§4), opening the Weigh in sheet. Nothing floats over the list.
- Older sessions load when the last row appears (a `ProgressView` row); a failed read is the band's,
  with *Try again*. The end is the last section's footer, the log's total, *28 workouts* (`GymCount`,
  `.footnote` `ink-dim`, monospaced digits), a fact no row states: drawn once the oldest workout is
  loaded and the log is whole (signed out, or signed in after its first pull), and only from two
  workouts, since one row needs no total. It never repeats a row's name or day.
- Empty: `ContentUnavailableView("No workouts yet", systemImage: "calendar")`, no description, no
  head row. While a workout is open — hidden, with the accessory below it on iOS 26 or the **Hidden**
  row above it on iOS 18 — and none is finished, the title is *No finished workouts yet*, so the log
  never says there are none while one is on screen.
- Discard and delete raise the band naming what went: *Workout discarded* · *Weigh-in deleted* ·
  an explicit native Delete action.
- **The Record** (`MovementRecordScreen.swift`) states each fact once: title the movement, subtitle
  the equipment, `ellipsis.circle` holding *Rename movement*; two `FactTiles` *Best e1RM* and
  *Heaviest*, the standing records; the chart, whose readout line appears only while a finger
  scrubs, in place of the window line *last 12 weeks · 28 workouts* (*the whole series · 23
  workouts*), whatever opened the screen; axis labels at the plate step; then **Earlier records**,
  every earlier best, newest first, in `ink` (*105 × 5 · e1RM 122.5* over *Sep 17*),
  drawn only when there is one. The standing best is the tile's and never a row. Facts and axis
  labels keep monospaced digits in the text face.
- **Bodyweight** (`BodyweightScreen.swift`): a weigh-in row is a `GymRow` whose title is the weight
  *82.4 kg* (monospaced digits) and whose trailing fact is its day in the day form (*Sep 26*,
  *Today*; the year only when it is not the current one), then `DoorChevron`, since it opens the
  Weigh in sheet — the same shape as a session row, the thing first and its day trailing. The chart
  follows the Record's rule and `11-bodyweight.md`'s words: its readout appears only while
  scrubbing, in place of the window line *last 90 days · 6 weigh-ins* (*the whole series · 14
  weigh-ins*), since at rest the newest weigh-in is the list's first row. The chart's caption *Every
  point is a number you typed. Nothing here is estimated.* is drawn; *Coach can read this. It can
  never write it.* is the list's footer.
- **Session detail** follows §7.8.

### 7.7 Workout

- No slot strip, no *Last time* line, no kind control: history prefills the rack (`16-the-workout.md`);
  a new set is Working, as on web and Android; the Fix sheet carries *Kind* as a segmented control
  (warmup · working · drop · failure).
- The rack is a grounded panel on `gym/card`, with 16 pt padding. Weight is a large rounded
  numeral with `kg`; four equal ladder keys are at least 48 pt tall. Reps sit in one raised
  rounded row with equal 48–56 pt minus/plus targets and a centered editable value.
  **Log set** is a 52 pt minimum full-width primary with a 17 pt headline label, scaling with
  Dynamic Type. Its visible label names no numbers; its accessibility label names load and reps.
- The movement title sits above a native page indicator. Horizontal paging follows the finger;
  there is no movement-position sentence or pair of arrows. Accessibility exposes the current
  movement count and adjustable previous/next navigation. The title opens *This workout*.
- Working-set progress is a compact visual row: completed checks, an accent current ring/dot,
  and quiet planned markers. It never counts warmups as planned working sets. VoiceOver states
  logged, current and planned totals. The native ledger stays compact, around three 48 pt rows
  at default size, with recent/current rows visible; all rows remain scrollable and editable.
- The clocks pair `clock` with workout elapsed time and `timer` with time since the latest valid
  session-wide set. No visible labels; keep complete accessible names. Before the first set,
  show only elapsed time. Numerals use monospaced digits.
- The ledger draws sets in the order they were logged, the same on every draw and every surface; a
  warmup logged between working sets stays between them. It scrolls under the rack's head, not a
  bar, so the system draws no scroll edge there: its top fades over 16 pt (`SoftEdge(.top)`), and at
  rest the current row and the one before it are fully visible.
- The current row is its place, its target (*100 × 5*, or *open*) and the accent dot — never the
  words *Current set* or *Target*, never a sentence (`16-the-workout.md`). An unsent set is marked
  once, by a trailing `iphone`.
- **VoiceOver reads each ledger row as one element**, and only a logged row is a button, since only
  a logged set opens anything. A logged row: *Set 2, logged, 100 kilograms, 5 reps* (a warmup, drop
  or failure set by its kind, *Warmup, logged, 60 kilograms, 5 reps*), then *, on this phone* while
  unsent; the button trait and the hint *Opens Fix set.*; never *Selected* — its check is drawn,
  not spoken, since the label already says *logged*. The current row: *Set 3, current, target 100
  kilograms, 5 reps* (*Set 3, current, open target*), static text with no hint and no action. A
  planned row: *Set 4, planned, 100 kilograms, 5 reps* (*Set 4, planned, open target*), static text.
  A target with only one number says that one (*target 5 reps*).
- **At accessibility sizes the rack never scrolls and never clips**: its labels cap at
  `.accessibility1`, the ladder is 2 × 2, the reps row always shows, and the ledger gives up height
  first, down to the current row alone.
- The bar: *This workout* `list.bullet` leading, *Finish* trailing in accent (a confirmation),
  title the routine (*Free workout* when unlinked), subtitle the start in the time form (§3).
- A Finish the phone cannot complete says what holds it back, in the refusal band: *Finish needs a
  connection — keep logging, or hide the workout.*, or, while the server needs a newer app (§7.15),
  *Finish needs the update — keep logging, or hide the workout.*
- *This workout* lists each movement with *2 of 4 sets* against plan (*3 sets* without one), the
  same at zero (*0 of 3 sets*, *0 sets*). The count is of working sets, the sets the ledger numbers
  (`SetRow`, §5) and the plan's targets hold; a warmup, drop or failure set carries its letter and
  is not counted. A `gym/done` check only when every planned set is logged;
  *Add movement* is the section's last row, `plus.circle.fill`. *Hide workout*'s footer names the
  way back (§7.18): *Your sets stay saved. Tap the workout above the tabs to return.* on iOS 26,
  *Your sets stay saved. Find it at the top of The log.* on iOS 18.
- **Heavier than the plan** is an `.alert`: *Save 105 to Lower A?* · *Today's workout already has
  it.* · **Save to Lower A** · *Today only* (the cancel role). Leaving a movement raises it — a swipe
  or accessible movement navigation, not a control the lifter touched for it — so a dialog would have no source to
  anchor to and would float over the ledger (§5 Confirmations). A varied scheme opens a `.medium`
  sheet with its before/after rows, *Today only* leading and ✓ (*Save*) in the bar.
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
  is *Discard workout* (`trash`, destructive). Discard pops to The log, after its confirmation, without an Undo band.
- Set rows are `SetRow`s with tap-to-fix and swipe-to-delete: *1 · 100 × 5* with the comparison as
  the trailing caption (*+2.5 over plan*), effort and note as a second line only when present; *W ·
  80 × 3* carries no caption.
- A movement's plan is its row's subtitle in `ink-dim` (*plan 1 × 5 · 60*), never an accent row of
  its own; a movement the plan did not hold reads *not in plan* in the same place.
- **Share this workout** is a `.medium` sheet with *Close*, its sentences and one primary, *Get a
  link*. Signed out, or while backup is paused, the primary is a sign-in door, *Sign in to share*,
  in place of a primary that cannot succeed: it opens the sign-in door and, signed in, returns to
  the share (`superapp-flow.md` §5). A mint that meets no account is refused in the band with
  *Sharing needs your account. Sign in first.* The bar's `square.and.arrow.up`, the session row's
  context menu and its accessibility action open the same sheet in every account state, so the
  door reads the same from every place it is offered. While a link is live the primary reads *Copy
  link* (*Copied* once copied) and *Revoke the link* stands under it, a quiet `alarm` button with
  the destructive role; that band carries text outside a button, so it stands on the band's surface
  while the link is live and keeps the soft edge otherwise (§4).

### 7.9 Finish receipt

- **The receipt is a sheet over the finished workout's detail** (`16-the-workout.md`), and it opens
  at `.large` only. Session detail and the receipt draw the same three tiles, so a half sheet would
  leave the detail's tiles showing above the receipt's and say the workout twice on one screen; at
  `.large` the detail recedes behind the receipt and says nothing until the receipt closes. One
  detent, so no grabber (§5). *Done* and a swipe down return to that workout's detail.
- Title *Well done.* / *Ended early.* (`16-the-workout.md`), subtitle *Push A · Tue, Aug 18* or
  *Free workout · Sat, Sep 26*; no title row inside the list (`consistency.md` 6o).
- The workout's three `FactTiles`, Duration · Working sets · Volume, from the one constructor over
  its readout (§5), so the receipt tells the workout as session detail and Inspect do. No Top
  e1RM tile: an estimate belongs to one movement, and the strength news is the *Personal record*
  card. Then *Personal record* in `gym/record` on its own card, then *Performed* in logged order,
  then *Against plan* / *Against last Push A* when one exists.
- The bottom band has exactly three actions, from top to bottom: quiet native destructive
  **Discard**, neutral secondary **👑 Share with Coach**, and full-width prominent **Done**.
  Each has at least a 52 pt target with 10 pt spacing. Done is the primary and appears once.
  There is no explanatory footer. The crown marks the paid Coach feature; existing account,
  trial, allowance and entitlement checks remain authoritative. No checkout is offered.
- Discard confirms once, queues removal and returns to The log. Share dismisses the receipt,
  follows the existing account/Keep door when required, and opens Coach through the normal send
  path. Done and a downward sheet dismissal return to the finished workout's detail.
- The receipt does not offer Save as routine or a second exit action.

### 7.10 Sheets (§5)

Detents, dismissals and commits per §5; `presentationCornerRadius` never set.

- **Fix set** (`SetEditor`): title *Fix set*, the movement as subtitle, *Cancel* · *Save* in the bar.
  One section: the centred `WeightInstrument`, *Reps*, *Effort* (`Picker(.menu)`), *Kind*
  (segmented), then *Note* as a `TextField(axis: .vertical)` row, 1–6 lines, no header; over a saved
  workout's set also *Movement* and *Time*. *Delete set* is the last section in `alarm`, with the one
  caption *Push A keeps its planned targets.* The set note carries no footer: a set note is a record
  and the field says nothing about Coach (`09-coach.md`). *Clear note* is drawn only while the note
  has text.
- **Keypad**: title *Weight* or *Reps*; the unit at the numeral's baseline as on the rack (*kg*,
  *reps*), dropping under it only at accessibility sizes as the rack's does; digits `ink` on
  `raised`, *Set* the only accent; digits cap at `.accessibility1`; `.large` at accessibility sizes.
  Reps are whole and positive, so the reps pad's ± and decimal slots are empty and no line explains
  it.
- **Weigh in**: the *kg* field with its suffix as the first row under the title, *Date*, then
  *Delete weigh-in* in `alarm`; *Save* in the bar. A weigh-in's day is its identity: a new one picks
  its *Date* with the system picker, and an existing one shows *Date* as a fact in the subtitle form
  (*Sat, Sep 26*).
- **Rename movement**: the name field, the help line, *Rename* in the bar.

### 7.11 You, Keep and sign-in (§2 shell)

- You is a native `List` (`.insetGrouped`) in a `NavigationStack`, title *You*, *Done* trailing,
  on clay in both appearances. The identity row is the avatar or `person.crop.circle`, the name — or
  the email when no name is set, never *You* — and one state line, the account's one status:
  *Backed up* · *Not backed up yet* · *Syncing paused · update Windmill* while the update is
  required · *Syncing paused · sign in again* while the account's sign-in on this phone has lapsed
  and backup waits on it (the Apple and email doors then follow). Signed out there is no name,
  so the row is `person.crop.circle` and *Not signed in* alone; what lives on the phone is the **On
  this phone** section's to say. The Apple and
  email doors follow it. Then **How you sign in** (signed in) or **On this phone** (signed out,
  drawn only while a room holds something, one row per such room: *Journal · 3 pages*, *Gym · 3
  routines · 1 workout*); then **Settings**: *Appearance* as a `Picker(.menu)` row (Light · Dark ·
  System, System by default) and *About Windmill* ›; then *Sign out*, destructive, alone. The
  choice of appearance sets the window and the environment (§2), and the rooms answer with their
  own palettes.
- **The address is said once.** **How you sign in** lists each way in: the *Email* row carries the
  address as its value only while the identity row shows a name; when the identity row's title is
  the address, the *Email* row is its label and `envelope` alone. The *Apple* row's value is its
  own email or *Hide My Email*.
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
  **Cancel**, and its message ends, at one change as at many, with *Everything else is in your
  account and leaves this phone.* A sign-out that cannot begin, or an answer it cannot carry out,
  closes the alert and leaves the account signed in; its reason is the **Sign out** section's
  footer in `shell/danger`, as *Finish signing in* puts its own, never the sign-in steps' error, and
  stays until *Sign out* is tapped again, which asks anew. A room that cannot save what it holds
  says so in its own sentence (*Gym could not keep pending changes. Try again.*; the journal's save
  refusal); changes that moved between the alert and the answer read *Something changed while you
  chose. Sign out again.*; any other failure reads *Couldn't sign out. Try again.* The alert never
  rises again by itself.
- Offline, the Apple and email doors disable and *Sign-in needs a connection.* is their section's
  footer, never a line inside the identity row. At accessibility sizes the email row
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
follows the system like the rest of the shell. The Gym door's line is *Log today's sets*, beside
the Journal door's *Write tonight's page*: the rack prefills from last time and draws no *Last
time* line, so the door does not promise one (`consistency.md` 10e). The onboarding gym glimpse
draws the current rack — name, the ledger with its current row, the numeral, *Log set* — never the
slot target, *Last time* or the mono face (`consistency.md` 9f).

- **Each product keeps one colour across the four pages.** A page's eyebrow dot is its product's,
  the same as that product's dot on page 1: Roadmap the glimpse's terracotta
  (`onboarding/clay-kind`), Journal `journal/lamp`, Gym `gym/accent`. `shell/brand` is the brand's —
  the wordmark and *Next* / *Get started* — never a product's.
- **Nothing cuts a sentence.** At the standard text sizes the glimpse leads and takes the height the
  text block (eyebrow, title, body, tag) leaves it, from its full 340 pt (page 1: 320) down to a 220
  pt floor, so a page a few points too tall shrinks its picture, never its words. At every width it
  scales uniformly to the column inside the 24 pt gutters and stands centred in it. At the
  accessibility sizes the text block leads, in the reading order `guidelines/onboarding.md` §7
  already gives it, and the glimpse follows it at 260 pt, so each page opens on its title and body;
  at AX3 on the 393 pt screen page 1's honesty sentence, *You can start without one.*, stands whole
  in the first screen. A page that still does not fit scrolls, its dots and primary pinned, and
  fades its bottom 16 pt under them (`SoftEdge(.bottom)`) while more lies below: a line running on
  reads as more, never as a cut. A page that fits draws no fade and does not scroll.

### 7.13 Journal room

- The chrome follows 7.1; the write seat and its *Done writing* swap follow the seat rule (§4). The
  seat stands 16 pt above the safe area, so clearing it takes 76 pt: its inset, its 44 pt and a 16
  pt gap above it. The canvas's bottom content margin is those 76 pt. Opening a day's ink or the
  first-echo card scrolls the canvas by the least that brings the end of what opened 16 pt above the
  seat, and never so far that its start passes 16 pt under the bar: the reader sees what they
  opened, from its start. Where the two cannot both hold — what opened is taller than the room
  between the bar and the seat — its start wins, and the reader scrolls for the rest, which the 76
  pt margin lets clear the seat. The day's date row stays on top whenever what opened fits beneath
  it, and leaves the top only when it does not — a long page at an accessibility size, the
  first-echo card at AX3 on the 375 pt screen — since a tap anywhere outside the ink closes it. That
  scroll moves the view, not the page: the ink still opens below the body without moving the text
  above it (§8).
- A past day's scale line draws only what was set — *Mood 7 · Energy 4*, or *Mood 7* alone — and
  nothing when neither was (`journal/journal.md` §4, "a day you didn't write is not drawn").
- Night in dark, Day in light (§2), chosen by Appearance in You; the status bar, the bar and the
  keyboard follow the window's appearance with the canvas.
- The placeholder is *Start anywhere.* whether or not the ink notes are shown; the line *Only you.
  No prompts, no fields, nothing to fill in — write a line or a page.* is the canvas's one
  disclosure.
- The echo stamp is *29 MAY* over *4 MO* in the current year, *22 AUG 2025* over *1 YR* otherwise,
  and *22 AUG* over *1 YR* in the reader, whose year header already names it; the reader has *Close*
  in the ink and keeps the system's grabber, since it resizes (§8).

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

- **The row.** Signed in, The log's head gains a section headed **On this phone** above
  Bodyweight while a workout waits — always one row under its header, one workout or many, so the
  header says where they are and the row never says it again. One workout: *Push A · Sep 23 · 12
  sets* (*Free workout* when unlinked; *1 set from Push A · Sep 23* for a stranded set), its
  subtitle the state (*Adding…* with a trailing `ProgressView` in flight, else the reason below), a
  door to Inspect. Two or more: *3 workouts*, subtitle *2 need you* (or *Adding…* when none does),
  a door to a pushed **On this phone** list in two sections, **Needs you** and **Adding**, each row
  as above. The section leaves when nothing waits.
- **The badge.** The Log tab carries the system `badge` with the count of workouts that need the
  lifter's decision — refused, or waiting on Keep — never one in flight. It is the one badge the
  room draws; Coach and the room menu draw none.
- **The reason**, at most twelve words naming the way out, is the row's subtitle, the Inspect
  head's footer and the transient after a refused retry. A saved workout's refusal never reaches the
  room's band, and the lifter cannot dismiss its notice: a queued retry answers it. A notice also
  stops standing once the phone's log, complete after its first pull, shows its cause gone: a
  `session-open` notice stands only while the log draws an open workout of the account's own, and a
  `session-overlap` notice only while the workout it names still crosses the copy — a named workout
  the log does not draw stands, since the phone may not have pulled it yet. Before the first pull
  every notice stands. A notice that no longer stands leaves the copy's own state as its reason,
  most often waiting on a retry. The table holds what iOS receives, by the reason label its events
  carry:

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
  reason as that section's footer; *Started* and *Finished* as fact rows in the time form (*9:00
  AM*), a finish on a later day than the start as its day and time (*Sep 27 · 12:20 AM*, §3), an
  open copy's *Finished* reading *Not finished*; then a section per movement of read-only `SetRow`s
  (*1 · 100 × 5*, *W* for a warmup, effort and note as the second line). A stranded set shows Working sets ·
  Volume and its own rows only. The band holds the reason's one primary, chosen by the reason alone
  and the same for a stranded set: *Keep as finished* (`session-open`), *Retry* (`session-finished`,
  `unsent`), *Fix workout* for every other reason, and none for `id-taken`, whose way out is
  *Discard workout*. A retry is offered only for a reason a retry can change. A stranded set's *Fix
  workout* edits the stranded sets alone. Keep and Retry disable until the log's first pull is
  complete, with *Adding it needs a connection.* in the band's transient above them, and while
  backup is paused, with *Sign in again to add it.*
  The bar's `ellipsis.circle` holds *Fix workout* when the copy can be fixed (every reason but
  `id-taken`) and Fix is not already the primary, and *Discard workout* (destructive). Discard
  asks once in a native confirmation, then immediately removes the saved copy and pops one step,
  to the screen that opened Inspect — The log's head for one waiting workout, the **On this phone**
  list for several; a list left empty pops on to The log.
  For stranded sets the item reads *Discard 1 set* / *Discard 3 sets* and uses the same confirmation
  (§5 Confirmations). There is no success or Undo band. A workout on its way has no recovery
  primary or menu; its transient reads *Adding [name] to your log.*
- **Fix workout** is a `.large` sheet that commits from its bar like every edit sheet: *Cancel* ·
  *Fix workout* · ✓, the checkmark's label *Save and retry* (on iOS 18 the bold words), since the
  commit both saves the copy and sends it. Sections: **Times** — *Started*
  and *Finished* as compact `DatePicker` rows, an open workout's *Finished* reading *Not finished*
  with a quiet *Mark finished* that fills it from the last set; a *Linked to Push A* toggle whose off
  state drops the saved plan; then a section per movement, each row opening the Fix set sheet
  (weight, reps, effort, kind, movement, time, note, delete). The sheet has no destructive row:
  Discard lives on Inspect, with its confirmation. Over 200 sets the bar's ✓ disables and the held reason,
  *Over 200 sets · remove 12.*, stands in the band at the sheet's foot; any other refusal the phone
  predicts (below) disables it with that reason's line in the same place. Edits touch the phone's
  copy only; the retry sends the corrected import under the same identity.
- **Keep** and **Retry** act from the band. While a kept, fixed or retried workout is on its way,
  Inspect stays on screen, its transient reads *Adding Push A to your log.* (the workout's name),
  never that it is on the log, and the row reads *Adding…*; both leave when the workout lands. On
  refusal the row's reason updates and the transient says the new one.
- **A retry sends every set or none.** Retrying an open saved workout starts it and sends each of
  its sets in one plan, so a refusal leaves nothing half-sent.
- **What the phone predicts.** A finished copy's retry is an import, with the import's checks: a
  movement the catalogue lacks, a finish after now, times that cross another workout. An open
  copy's retry is the restart the server runs — a start that does not join, its sets appended — so
  the phone refuses it only while the account has an open workout of its own, for a start after now,
  or for a set it would refuse, and never for crossing a finished workout.
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

### 7.17 Dates, counts and words (§3)

Every date on every Gym and shell screen passes through the one date formatter's six forms, and
every count through `GymCount`. No view builds a date string or a plural of its own. A tile's label
agrees with its value (*1 · Working set*). Every screen says *workout*, never *session*: the
strings of §3's table, accessibility labels and hints included, while identifiers, events and the
wire keep *session*.

### 7.18 A hidden workout

The full-screen logger is the open workout's place. *Hide workout* sets it aside with its sets
saved, and the room keeps one way back to it: the tab bar's accessory on iOS 26, the **Hidden** row
at the head of The log on iOS 18 (§7.6). Neither is a minimized logger; both exist only while the
lifter has hidden the workout.

- **The accessory** (iOS 26) is the Gym `TabView`'s `tabViewBottomAccessory(isEnabled:)`, enabled
  while the open workout is hidden; iOS 26.0, which has no `isEnabled`, draws its content
  conditionally. It stands on the system's glass and draws no ground, stroke or shadow of its own.
  Expanded above the tab bar it reads `dumbbell.fill` in `gym/accent`, then the workout's name — the
  routine, or *Free workout* — in `.subheadline.weight(.semibold)` `gym/ink`, one line truncating at
  its tail, then *· 32:10*, the workout clock counting up from the start in `.subheadline`
  `gym/ink-dim` with monospaced digits: *Lower A · 32:10*. Inline, beside the tab bar once it
  minimizes on scroll (`tabViewBottomAccessoryPlacement == .inline`), it is the symbol and the clock
  alone. The whole accessory is one button; it carries no control of its own.
- **A tap** brings the logger back through the door the accessory and the **Hidden** row share,
  `gym.openHiddenWorkout(from: .accessory)` (the row's is `from: .row`), which records the event
  below and raises the failure band: the cover rises from the accessory with
  the zoom transition (`matchedTransitionSource` on the accessory, `.navigationTransition(.zoom)` on
  the cover), as Music's player rises from its mini player. Opened any other way the cover keeps its
  own transition, and with Reduce Motion the system's. A return that fails raises the band's
  *Gym could not restore this workout. Try again.*
- **It appears** the moment the workout is hidden — *Hide workout* in *This workout*, or *Build my
  routine* on a first workout, which hides it to open Coach — and again after a relaunch while the
  workout stays hidden. It goes where the tab bar goes: on a pushed screen, and while Coach's
  composer has focus, it is not drawn.
- **It leaves** when the logger comes back by any way in (its tap, the control's *Open workout*,
  starting a workout while this one is open), when the workout stops being open (finished or
  discarded on another surface, closed after four idle hours), and when the account changes. It
  belongs to the Gym room; Journal draws nothing.
- **VoiceOver** reads it as one button: label *Lower A, in progress* (*Free workout, in progress*),
  value the elapsed time as the clock reads it; activating it brings the logger back.
- **The Hidden row** (iOS 18) is §7.6's: the workout's name over *Open since 11:27 AM*, with
  `DoorChevron`, bringing the logger back the same way without the zoom. iOS 26 draws no Hidden row.
- **Events**, content-free: `gym_hidden_workout` {action: hide} when the lifter hides the workout;
  {action: open, door: accessory · row} when the lifter brings it back from the accessory or the
  row. A return through the control or a shortcut is §7.19's `gym_intent_opened`.

### 7.19 Outside the app: the control and App Shortcuts (iOS 18 and later)

Outside the app the workout has one control and two App Shortcuts. The one act among them that
writes, *Log set*, goes through the one log the Live Activity's *Log set* uses
(`WorkoutLogSetIntent.log`), under `14-live-activity.md`'s rules: one offer bound to one pre-minted set id, the offer checked
against the rack before it writes, device authentication on a locked phone. Nothing outside the app
takes a number in — no dictation, no typed load, no Shortcuts parameter.

**The offer** is the set the Live Activity's *Log set* would log. A set is on offer exactly while a
workout is open on this phone, not hidden and not stale, with a movement chosen, the rack's numbers
valid and no account change under way — whether or not the Live Activity is on screen. Each time
the app updates the Live Activity, and when a workout opens, hides, returns or ends, it writes the
offer (or its absence, and whether a workout is open) to an App Group container shared with the
`WindmillWorkoutActivity` extension, then reloads the control
(`ControlCenter.shared.reloadControls(ofKind:)`). The control reads only that; it never works out
an offer of its own. The App Group is new to both targets' entitlements.

**The control** is one `ControlWidgetButton`, kind `works.windmill.app.workout`, in the
`WindmillWorkoutActivity` extension beside the Live Activity. The controls gallery names it
*Workout* and describes it *Start a workout, or log the set on the rack.* It goes in Control
Center, on the Lock Screen and on the Action button. A control runs one intent, made when it draws:
`WorkoutControlIntent`, carrying the offer the control drew, or nothing. It has three states:

| State | Symbol | Title | Value | Action hint | A tap's `WorkoutControlIntent` |
|---|---|---|---|---|---|
| A set on offer | `plus` | *Log set* | *100 × 5* | *Log 100 × 5* | carries that offer and logs it |
| A workout open, no set on offer | `dumbbell.fill` | *Open workout* | none | *Open workout* | carries nothing: opens the logger |
| No workout open | `dumbbell.fill` | *Start workout* | none | *Start workout* | carries nothing: opens Routines |

- Carrying nothing, the intent takes *Start workout*'s door, which opens the logger while a workout
  is open and Routines otherwise, so the two opening states differ only in what they draw. The
  intent is not discoverable: Shortcuts never shows it or its parameters.
- Control Center draws the symbol white whatever the tint; the control declares `gym/accent` as its
  tint (§2). The symbol is `plus` only where a tap writes a set, and `dumbbell.fill`, the Live
  Activity's room symbol, where a tap opens the app.
- The value is the offer's load and reps without the unit, as the rack draws them (*100 × 5*,
  *82.5 × 6*), and VoiceOver reads it as the rack's button does: *100 kilograms, 5 reps*. *Log set*
  never stands without its value: a set the control cannot show, it does not offer. Where only the
  symbol shows — Control Center's small size, the Lock Screen — the Live Activity holds the number,
  and the Action button shows it in its hint, which the system reads as *Hold to Log 100 × 5*.
- **Log set**: on a locked phone the system asks for Face ID or the passcode first. While the offer
  is still the rack's, the set logs into the same durable queue, and the ledger, the Live Activity
  and the control step to the next set; the room adds no sound or haptic of its own (§5 Motion).
  When the rack has moved past it, nothing logs and Windmill opens on the logger, as the Live
  Activity's refusal does.
- **Open workout** opens Windmill in the Gym room with the logger in front, bringing a hidden
  workout back (§7.18).
- **Start workout** opens Windmill in the Gym room on the Routines tab at its root, whichever room
  was in front and past Where to start?; a first launch still shows the introduction first, and its
  end lands there. It starts nothing: a start is a record and the routine is the lifter's choice,
  and Routines holds every routine, each opening its summary and Start action. A sheet already open in the
  room stays open. When a workout has opened since the control last drew, it opens the logger
  instead.
- The control and the Live Activity say nothing when they open the app: the app coming forward is
  the answer.

**App Shortcuts** — an `AppShortcutsProvider` with two shortcuts, so Siri, Spotlight, the Shortcuts
app and the Action button reach them without setup. Every phrase names the app through
`\(.applicationName)`. Neither has a parameter: Shortcuts shows every parameter an App Shortcut's
intent declares, so each shortcut runs an intent of its own that declares none. Their tiles take the
provider's `shortcutTileColor` `.teal`, the system tile colour nearest the room's verdigris.

| Shortcut | Intent | Title · symbol | Phrases |
|---|---|---|---|
| Log set | `WorkoutLogRackSetIntent` | *Log set* · `plus` | *Log a set in Windmill* · *Log my set in Windmill* · *Windmill log set* |
| Start workout | `WorkoutStartIntent` | *Start workout* · `dumbbell.fill` | *Start a workout in Windmill* · *Start my workout in Windmill* · *Windmill start workout* |

- *Log set* takes the published offer — the rack's set — and logs it through the one log. It
  answers with what it logged, shown *Logged 100 kg × 5 · Back Squat.* and spoken *Logged 100
  kilograms, 5 reps, Back Squat.*; when the movement's name cannot be read it says the numbers
  alone, *Logged 100 kg × 5.* · *Logged 100 kilograms, 5 reps.*, never a stand-in noun. With a
  workout open and no set on offer it logs nothing and opens the logger, as the control's *Open
  workout* does, answering *Nothing logged. Opening Windmill.*, shown and spoken. With no workout
  open it answers *No workout is open.* and opens nothing. On a locked phone it asks for
  authentication first. Each run is a deliberate command and logs the set on offer when it runs, so
  two runs log two sets, the second being the next set on offer, and each answers with what it
  logged. Nothing debounces a run: catching up a forgotten set is two runs, and an extra set is
  deleted like any other, after confirmation. Only a drawn offer is idempotent — the Live Activity's and the
  control's button log the set they drew once, however often it is pressed.
- *Start workout* is also the door the control takes when it carries no offer: Routines, or the
  logger while a workout is open.
- `WorkoutLogSetIntent` keeps its offer parameters for the Live Activity's button; it and
  `WorkoutControlIntent` are not discoverable, and their workout parameter is titled *Workout* (§3).

**Events**, content-free, each carrying `surface` — *activity* (the Live Activity's button),
*control*, *shortcut*:

- `gym_activity_set_logged` {surface}: a set an outside surface logged, durable on the phone.
- `gym_activity_offer_refused` {surface, outcome: refused · failed · absent}: every outside *Log
  set* that logs nothing says why. *refused* when the rack had moved past the offer, or a rule of
  the log refused the set, and the logger opened; *failed* when the phone could not read the log or
  save the set and the logger opened, or Windmill could not start to log it and opened instead;
  *absent* when a *Log set* shortcut found no workout open.
- `gym_intent_opened` {intent: start_workout · open_workout, surface: control · shortcut}: Windmill
  opened on Routines or on the logger, a *Log set* shortcut with nothing on offer included.
- Writing the offer to the App Group or reloading the control reports the boundary operation
  `gym_control_update` (failure kinds `storage` · `unexpected`); a log that throws reports
  `gym_activity_update`, as the Live Activity's does.

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
  under it down and never moving the text above*. That is the layout's rule: the ink inserts below
  and nothing above it reflows. When the opened ink would end under the write seat, the canvas
  scrolls until it clears the seat, never past the ink's own start (§7.13), the date row staying on
  screen whenever the ink fits beneath it. The ink holds up to two
  passages, each a row of a mono date
  stamp (*14 MAR* over *5 MO* in the current year, *22 AUG 2025* over *1 YR* otherwise; a 48 pt
  column, `ink-faint`) beside the older words in `journal/lamp`, Inter 17. A passage that is not the
  writer's own says so on one `ink-dim` line under its words, as the web's ink does: *something you
  copied down*, or *from your voice note* for a spoken one. Under the last passage,
  *Useful · Not useful* as two quiet `.footnote` buttons, and when more remain, one row *8 more* ›
  that opens the reader. Tapping the capsule again, or anywhere outside the ink, closes it. Only one
  day's ink is open at a time.
- **The reader.** A `.sheet` with `.medium` and `.large` detents and the system's grabber, title
  *From your journal*, *Close* trailing in the ink, listing every passage for that day as the same rows,
  grouped by year under a year header. The header names the year, so a row's stamp never does:
  *22 AUG* over *1 YR* under **2025**. Tapping a passage flies the canvas to that day and closes the
  sheet.
- **First echo, once.** The first echo an install ever receives shows a card above the ink the
  first time it opens: *From your journal* · *Older lines that echo what you wrote today. Only
  you see them; they cost nothing.* · *Got it*. Never again.
- **While writing**, no tab draws on today's row and no ink opens; a tab that was open closes when
  the keyboard rises.
- **Never**: a count on the room menu, a notification, a red dot, an unread total.

## 9. Where this spec and the rest of canon differ

Recorded in `consistency.md` under *iOS redesign*:

- **Colour and drawings:** 9a (light gym accent vs Figma Daylight `brand/base`), *iOS gym and shell
  day contrast* (the light `gym/accent` and `shell/brand` values, the red-brick `shell/danger`, and
  the Figma collections that follow them), 9e (the first-run
  boards' W capsule and hand-drawn glass), 9m
  (the iteration-1 boards against §5–§7), 9d under *Onboarding* (the onboarding collection's gym day
  accent).
- **Drawings against the build:** 10h (Routines' unshipped controls), 10i (Duplicate on the editor
  board), 10k (*session* on two wave-three boards),
  10l (the Live Activity double tap), 10m (screens that ship with no drawing).
- **The log and progress:** 9b (phones weave, web keeps the strip), 9o (moments are doors on iOS,
  expanders on Android), 9p (a record stated once, and what counts as one), 9q (*Weigh in* in the
  bar), 9y (the month moment named by its month).
- **The workout and routines:** 9c (the rack's kind picker), 9k (the untaken workout's row and badge
  vs Android's card and door), 9l (the Live Activity's unlabelled clocks), 9n (the set-note footer),
  10d (two search shapes in the pickers).
- **Coach:** 9i (the proposal card), 9j (the Review band's one caption slot), 9s (Notes' lines), 9t
  (Connected log with a connection), 6w (no keyboard toolbar on iOS 26), 10f (what Coach did in
  iOS's words: no step list, the saved-note row, the settled words), 10g (the server's read-receipt
  weeks, a backend fix).
- **Shell and cross-room:** 9r (no Gym settings), 9u (dates in the person's locale), 9v (the
  signed-out share door), 9w (You's sections vs `superapp-shell.md` §6), 9x (the room menu's You and
  room item), 10e (the Gym door's line on Where to start?), 9f, 9g and 9h under *Onboarding* (the gym
  glimpse, where each product lives, the text leading at accessibility sizes), 9z under *Gym*
  (*workout* on every iOS screen, web and Android to follow).

One proposal in `consistency.md` waits on the owner and is not part of this contract: one
suggestion on an empty Coach. Whether Android and the shell canon follow iOS on You and Gym
settings waits on the owner in 9r and 9w.

## 10. Drawings

Gym file `vdmdiKWrmZoS1FtcvJRf6O`, page [`iOS`](https://www.figma.com/design/vdmdiKWrmZoS1FtcvJRf6O?node-id=11-2)
(`11:2`), one section per flow; each caption names the code that ships the screen and the date of
its drawing. 393 × 852 boards, Instrument with Daylight in the row beneath:

| Section | Node | Boards |
|---|---|---|
| 00 · The room — read me, map, anatomy | `1118:1768` | top bar anatomy `1055:205` · Daylight `1055:274`; colour roles and type ramp `1057:201`; transient band `1057:383`; native anatomy `1063:478` |
| 01 · First open — Coach-led setup | `1081:565` | signed-out and signed-in first open `1081:569`, `1081:607`; photo `1081:637`, `1081:704`, `1081:1027`; preparing `1081:737`; created `1081:762`, `1081:800`; routine to Start `1081:829`; goal `1081:858`, `1081:894`; program `1081:925`; allowance used `1081:957`; after sign-in `1081:988` |
| 02 · Routines | `1113:1474` | Routines `1056:201` · `1056:417`; routine summary `1063:531` · `1065:390`; editor `252:358`, `252:767`; movement picker `258:417`; targets `254:478` |
| 03 · Workout | `1114:1513` | workout `1065:222` · `1065:441`; keypad `321:281`; fix sheet `327:922`; finish `1063:486` · `1065:343`; ended early `328:646`; no movement yet `320:318` |
| 04 · Outside the app | `1115:1576` | Live Activity `168:29`; Dynamic Island `171:29`; states `175:29`; double tap `177:29` |
| 05 · The log, past workouts & progress | `1116:1605` | The log `1056:529` · `1056:779`; discard by swipe `1065:307` · `1065:526`; workout detail `1056:1930`; a deleted set `323:29`; Record `461:60`, scrub `529:60`, panned `529:154` |
| 06 · Bodyweight | `1116:1683` | Bodyweight `128:2` |
| 07 · On this phone | `1116:1705` | not drawn |
| 08 · Coach | `1117:1703` | empty `1056:903`; conversation `1056:1048` · `1056:1240`; proposal review `123:2`; no Coach seat `133:1045`; not on this Windmill `133:1152`; the day's cap `224:309` |
| 09 · Notes & Connected log | `1117:1768` | Notes `130:1419`; note editor `135:246` |
| 10 · Not built — designed only | `1118:1810` | Apple Health (no board) |

The boards bind `Gym · Product colours` and shared Theme `ios/gym/*` roles, including
`ios/gym/accent`, `ios/gym/accent-soft` and `ios/gym/on-accent` (9a). Most predate iteration 3;
what §5–§7 rule past them is written here and not yet drawn (9m, 10m).

Shell file `tkI7GnS6TcZvQSDi9lwrBf`, page `iOS` (`1:5`),
402 × 874 boards:

| Section · board | Node |
|---|---|
| [7 · Shell chrome · 2026-10-08](https://www.figma.com/design/tkI7GnS6TcZvQSDi9lwrBf?node-id=2-3676) | `2:3676` |
| 25a · Gym root bar | dark `2:3680` · light `2:3975` |
| 25b · Journal root bar | `2:3704` |
| 25c · Room menu open | `2:3724` |
| 25d · Bar anatomy at 3× — both appearances, dimensions | `2:3769` |
| 26a · You · signed out | dark `2:3853` · light `2:3997` |
| 26b · You · signed in | dark `2:3906` · light `2:4048` |

Journal file `pC6ciOUnfLmI42oMihd7l3`, page `iOS` (`202:2`):

| Section · board | Node |
|---|---|
| [2c · Echoes on iOS · 2026-10-08](https://www.figma.com/design/pC6ciOUnfLmI42oMihd7l3?node-id=207-105) | `207:105` |
| 27a · Echo tab · closed | `207:109` |
| 27b · Echo ink · open | `207:137` |
| 27c · Echo reader · sheet | `207:189` |
| 27d · First echo · card | `207:263` |
| 27e · Arrival · motion | `207:308` |

The shell and Echoes boards bind shared Theme `ios/shell/*` and `ios/journal/*` roles.
SF fonts do not render in Figma's cloud renderer; the boards use Scale `ios/font/*`
stand-ins (Inter, Nunito, JetBrains Mono). Symbols are named for the SF
Symbol they stand for; the build pulls the real glyph. Glass on a board is `glass/fill` with a
1 px `glass/stroke`, standing in for what the system renders.

## 11. What the next iteration's screenshots must show

Iteration 3's captures show:

1. **Say it once.**
   - The log with a record stated once (a moment, or a dot when it has no moment) and session rows
     carrying their facts.
   - The newest weigh-in only in the head; no record on a movement's first estimate, and no moment
     reading *up 0 kg*.
   - A Coach answer with a body-less proposal card.
   - The Record stating the best once: the two tiles, then **Earlier records** without the standing
     best; and, opened from a moment, its point ringed under the window line, with no readout.
   - A removal's card and Review naming the routine once (the eyebrow; the title), the row
     *Routine · Removed* and the primary *Remove routine*.
   - The log at its end reading *28 workouts*, with one workout reading no footer, and empty while a
     workout is hidden reading *No finished workouts yet* over the accessory.
   - A month moment naming its month (*Trained every week of February*) under a head that reads
     another count.
   - The rack with *Log set* and no plan line over planned rows.
   - You whose identity line is the one status, with no *Your data*, the address said once, and
     *Done* and *Sign out* in two colours in both appearances.
   - The finish receipt at `.large` over session detail, no tile showing twice.
   - A settled Review reading its word alone (*Applied*, *Removed*, *Turned down*), an out-of-date
     one naming why, and a Coach answer with *Saved a note* and one with *Read your movement
     history*.
   - **On this phone** headed once over *3 workouts*; the echo reader's stamps with no year.
2. **One chevron.** The log's moments as doors with the system chevron, opening the Record with its
   point marked; no `DisclosureGroup` in The log; the Review diff as `GymRow`s in one section; Notes
   rows with `DoorChevron`.
3. **Nothing floats on content.**
   - *Weigh in* in The log's bar; no seat in Gym.
   - Every band clearing the last row at rest, and the scroll edge softening text that passes under
     bars and bands.
   - Captured scrolled mid-list on The log, the rack ledger, the Review sheet, Fix workout and a
     picker.
   - The transient band as glass over rows, in both appearances.
   - The Review band at AX3 scrolled mid-diff in both appearances, its caption and *Turn this down*
     on the band's surface, no row reading through them — no trace of *Ask Coach* under the caption
     in light; Share this workout with a live link at AX3, *Revoke the link* on the same surface;
     Review while Apply waits (*Applying…* over a blank caption) and after 15 seconds (*Retry* ·
     *Not confirmed yet.*).
4. **Sheets commit from the bar:** Fix set, Weigh in, Targets, Create movement, Fix workout.
   *Heavier than the plan* as an alert. Search-to-create in a picker with a query. *Sign out* as one
   alert. Share this workout signed out with *Sign in to share*.
5. **A hidden workout and the untaken one:** the tab bar's accessory on iOS 26, expanded and
   inline, in both appearances, and on an iOS 18 simulator the **Hidden** row as the head's first
   row. **On this phone** with one waiting workout, and with nine (one row and the pushed list); a
   queued workout reading *Adding Push A to your log.*; a stranded set with *Fix workout* for a
   fixable reason, its *Discard 1 set* and *Set discarded*; Discard returning to the screen that
   opened Inspect, the **On this phone** list among them.
6. **Update and sign-in:** the update alert signed in and signed out; You with *Finish signing in*
   offline and while the update is required; You with *Couldn't sign out. Try again.* under **Sign
   out**; a Finish refused for the update; the room menu and back chevrons in ink.
7. **One date formatter and one noun:** a screen of each form — log rows, Record, receipt
   subtitle, session subtitle (one that crosses midnight among them), Inspect's times, the workout's
   bar subtitle, weigh-in, a month header — and The log empty (*No workouts yet*) and at its end
   (*28 workouts*).
8. **AX3 in both appearances** for: the rack (reps visible), the keypad (*0* reachable), the Coach
   composer, Fix set, the receipt, Inspect, You, and onboarding's four pages, each opening on its
   title and body (page 1's *You can start without one.* whole) and running on under the bottom fade
   where it scrolls. **375 × 667** for the same, plus Journal and the shell: onboarding's four pages
   with their whole text and their glimpses centred, page 2 among them, and the first-echo card
   opened at 375 AX3 with its start under the bar.
9. **The Live Activity:** banner, expanded, compact and minimal Island, both appearances, with no
   clock labels.
10. **Six interactions as screen recordings**, since a still cannot show them: Log set, a ladder
   tap, Apply to receipt, a moment opening the Record, the band rising and dismissing (§5 Motion),
   and the logger zooming back from the accessory.
11. **Outside the app:** the control in Control Center at its medium size in each of its three
   states, both appearances, and on the Lock Screen; the Action button's hint; Siri's answer to *Log
   a set in Windmill*, with a set on offer and with none (*Nothing logged. Opening Windmill.*); the
   two shortcuts in the Shortcuts app on teal tiles with no parameters.
