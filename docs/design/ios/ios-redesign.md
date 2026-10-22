# iOS rendering contract

The principles and colour roles of the Windmill iOS app (`apps/ios/App`): the shell, the Journal
room and the Gym room, on iOS 26 with Liquid Glass, deploying to iOS 18. Screens are drawn in Figma —
the Gym file's iOS page, indexed in [the flow index](../../index.md), with the Shell file's chrome
and first-run boards and the Journal file's Echoes boards — and their behaviour is the code's.
Figma uses Inter for editable specimens where its SF Pro renderer supplies no glyph metrics; the app
uses the system text styles. Native chrome is a structural drawing: SwiftUI owns its appearance.

`apps/ios/App/Tools/tests/test_theme_assets.py` reads the role tables in §2 and checks every colour set against
them, so a role row keeps its form: `` | `room/role` | dark | light | ``.

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
7. **Signed out is first class.** Nothing asks for an account outside the three places
   `brand-foundations.md` names under Honesty; an account verb the person starts opens the same
   door and resumes. No banners.
8. **Light and dark are one design.** Every screen is reviewed in both; a room that defines only
   one appearance is unfinished.
9. **Nothing floats on content.** Whatever floats — a bar, a band, the seat — keeps the system's
   scroll edge, and at rest the content clears it.

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
composer's send circle at 40 %, the one control the room draws that dims; *Continue with Apple*
at the same 40 % while offline disables it, since it is Apple's control, whose black and
white the room never recolours, and a disabled door must read disabled; and `DoorChevron` in the
ink's `.tertiary`, as the system draws a `NavigationLink`'s chevron. Opacity as motion — a view at 0
or 1 at rest and animated between, the glimpse's one beat and its one loop — is not a fade. The
system's label hierarchy also stays where the system owns the ground: the iOS 18 bar's subtitle, and
the Live Activity on the Island's black.

**Tint.** The room accent is the tint of the Gym `TabView`, so the selected tab and every control
in every tab inherit it whatever order a screen applies its modifiers in; the page modifier
(`GymPage`) carries the same tint into every sheet the room raises. Toolbar content is the
exception: bar items take the label colour. The system draws the selection; the room supplies
the symbol and the tint, and draws no capsule, badge or label of its own.
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
| `gym/raised` | `#202627` | `#DFDAD5` | ladder keys, secondary buttons, chips, input fields |
| `gym/sunken` | `#060C0C` | `#DFDAD5` | a well a control sits in (chart plot, segmented track) |
| `gym/line` | `#202627` | `#D0CAC5` | separators, card strokes, chart grid |
| `gym/line-strong` | `#2A3133` | `#B6AFA9` | a focused field's stroke, the rack panel's edge |
| `gym/overlay` | `#030606` at 72 % | `#1A1918` at 45 % | the scrim under a sheet the room draws itself |
| `gym/ink` | `#F1F0EB` | `#1A1918` | primary text, numerals |
| `gym/ink-dim` | `#B6B5AF` | `#4C4744` | secondary text, facts, every essential label that is not primary |
| `gym/ink-faint` | `#727771` | `#625C58` | non-essential meta only: a chart's scrub rule, planned rows, `+ 1 more` |
| `gym/accent` | `#5FCDB4` | `#106B5F` | tint: links, selection, the primary fill, chart dots, the current-set dot |
| `gym/accent-soft` | `#5FCDB4` at 16 % | `#106B5F` at 12 % | the lifter's bubble, a selected row's wash |
| `gym/on-accent` | `#1B1408` | `#FFFFFF` | text and symbols on the accent fill |
| `gym/done` | `#9AA859` | `#7D8C43` | a logged set's check, a fully logged movement, an applied proposal |
| `gym/record` | `#D9B04C` | `#6E5217` | a personal record, and nothing else |
| `gym/alarm` | `#D08268` | `#A84E35` | refusal text in a field, a counter past its limit |
| `gym/alarm-fill` | `#A84E35` | `#A84E35` | a removal proposal's primary; native destructive actions use the system red |

These roles bind to Figma Theme `ios/gym/*` in Dark and Light. The native light accent is
verdigris `#106B5F`, darkened from the shared Gym brand `#137A6C` so text holds 4.5:1 on the
Gym grounds. Gold is a *record*, never a warning; brick is a refusal or a removal proposal's
primary. Every destructive control is `role: .destructive` with no tint of its own, so the system
paints it red.

The Live Activity uses `gym/accent` and `gym/on-accent` for its one button and `gym/accent` for
the keyline; the banner ground stays the system's. The workout control in Control Center declares `gym/accent`
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
| `journal/mood-*` | the eleven-step ramp `journal/mood-0`…`mood-10` | each step's day value in `Theme.xcassets` |

Journal answers dark with Night and light with Day; the choice is the shell's — Appearance
(Light · Dark · System) in You's Settings, System by default, stated as
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

The shell follows the system appearance in both rooms. You is clay whatever room opened it:
opened from Gym in light it is clay light, never `systemBackground`
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
