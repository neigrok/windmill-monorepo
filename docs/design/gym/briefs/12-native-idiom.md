# Native idiom — how the three surfaces are allowed to differ

Gym ships on web, iOS and Android. Use platform controls and navigation patterns.

## The law

> **Where the platform has a control, the platform's control wins. Where it does not, Windmill's own
> vocabulary wins, identically on every surface.**

A tab bar, a navigation stack, a list, a switch, a segmented control, a sheet, a snackbar, a date
field, a share sheet, a progress indicator and a confirmation dialog are the **platform's**. A
weight numeral, a plate ladder, a set row, a proposal diff, a read receipt and a routine card are
**ours**, and they look the same everywhere.

**A sheet is the platform's, and so is what leaving one means: a tap outside dismisses it and
commits nothing.** Every scrim in the room answers the same way — the six on the web, iOS's
interactive dismiss, Android's `onDismissRequest` — and so does the rack keypad wherever it is
raised behind one, which its own copy already promises: *cancel to keep* the number standing. A
scrim that writes is the one stroke a lifter cannot see coming.

**The finish is a sheet on both phones** — iOS's `.sheet`, Android's `ModalBottomSheet` — raised over
the session it just closed, and it is one statement about two surfaces rather than two conventions
(`16-the-workout.md`). Because back, the scrim and the handle already dismiss a sheet, the only
dismissal drawn for it is iOS's toolbar `Done`, on every state; Android draws none of its own. The
sheet's one full-strength button is `Share with Coach`, a hand-off rather than a way out, drawn only
where Coach can be reached. And because a sheet covers the room's bottom bar, a refusal raised
by a control **on** a standing sheet — the receipt's keep-as-routine — is drawn inside it, under that
control, not in the band every other refusal in the room lands in. That is the rule for a sheet that
stays up to hear the answer. A sheet that is not there when the answer comes hands its refusal back to
the room's own band, because a sentence drawn nowhere is not drawn — whether it closed first on
purpose, as Android's create step does (`15-the-routine.md`), or the lifter dismissed it mid-write.

The line is not aesthetic. A lifter has spent years learning what a back gesture does, what a
long-press offers, what a swipe on a row means, and where the account lives. Re-teaching them costs
them something and buys us nothing. A weight ladder, on the other hand, is ours to invent, because
nothing on the phone already means it.

## What follows on each surface

**iOS.** A real `TabView` over the room's three tabs. A real `NavigationStack` per tab, its path
owned by the room and unwound when a session opens or closes, with titles and toolbar items where
the system puts them and no drawn heading repeating the bar's. `List` with sections for anything
that is a list, the card frame kept through row backgrounds. `.searchable` in the pickers. The
system's segmented picker, toggle, menu, alert, share sheet and progress view;
`ContentUnavailableView` where one action fits. SF Symbols on every affordance that has one. Sheets
keep their detents, and **a sheet's chrome is the bar's**: the room's five sheets (fix, jump,
keypad, rename, review) are each a `NavigationStack` with an inline title and no drawn heading
repeating the bar's; on four of them the dismissal — *Cancel* or *Close* — is the bar's
`.cancellationAction`, and the fix sheet's bar carries the title alone because its scrim and its
swipe are the dismissal (the finish's toolbar *Done* is ruled above). The strings do not change
when they move into the bar. **No `Stepper`:** the room's only choice-shaped settings are fixed lists, and a
Stepper needs a value you increment.

**Android.** A real `Scaffold` with a real top app bar per screen and a real navigation bar drawn
only while the three tabs are what is on screen. Material's list item, switch, segmented button,
text field, snackbar and dialog, coloured from the room's **own** `ColorScheme` — gold is absent
from it, because gold in this room means a personal record. Material icons on every affordance, each
with its `contentDescription`. Modal sheets retain the handle, scrim and system Back dismissal.
The embedded Fix keypad's Cancel returns to the retained correction draft. Draft-specific toolbar
and commit controls follow `../android-delivery.md`. Predictive Back and edge-to-edge layouts must
preserve actual IME insets; `adjustResize` keeps the keyboard from panning the app bar away.

**Web.** The shared design system inside `.gym-root`: the rail, the toast, the buttons, the inputs,
the tags, the icons and the dialog are the design system's. What stays gym's own is what the law says is ours — the weight numeral, the plate
ladder, the set row, the proposal diff, the read receipt and the routine card. A dropped-in
component resolves into the room through **one bridge block per skin** naming only the roles the
room genuinely answers for itself; every other shared role already resolves through the room's brand
scope, and re-pointing one back at gym's alias of it is a cycle that resolves to nothing.

Where the design system lacks a reusable control — a chat bubble, a diff card, a
note row, a weight chart, a bottom rail — it is **authored in the design system**, not in the gym
folder. Roadmap's families are roadmap's vocabulary, not the brand's, and gym does not reach across
for them either.

## Back, and the thumb

Back uses iOS's interactive pop and navigation-bar button, and Android's system Back.
Each screen defines what Back means without replacing the native gesture.

> **The edge is arbitrated by depth, not shared.** A room reports its stack depth outward, and the
> shell applies its home swipe **only at depth zero**. At a tab root the edge means home; one push
> deep it means back.

Detach the shell's home gesture below the root, including the tab-bar band outside the
navigation stack. The shell must not leave the room while a pushed screen is open.

**Navigation chrome belongs where the platform puts it, and committing actions stay in the
reach band.** `Log set` and `Just start logging` live in an iOS bottom safe-area inset and in an
Android scaffold's bottom bar; **Apply** is the review sheet's own band; the keypad's **Set** and
the fix sheet's **Save the fix** stay in the band below the pad and the fields even now that the
sheets' titles and dismissals are the bar's. Three exceptions are ruled and are not drift:
**Finish** is a toolbar action, not a second full-strength commitment beside `Log set`
(`16-the-workout.md`); the editor's **Cancel and Save** are the navigation bar's, where the platform
puts a draft's two answers (`15-the-routine.md`); and the one-field rename sheet's **Rename** is its
bar's `.confirmationAction` (iOS `RenameSheet`) — a sheet holding one text field under a raised
keyboard has no reach band to put a commit in, and the bar is where the platform puts a single
field's answer.

**What earns the reach band, when two actions want it.** The Routines screen wants both *"start
logging"* and *"make a new routine"*, and only one can be the primary. The tie-breaker is not
importance, it is **posture**:

> The reach band holds what a lifter does **with a bar in their hands**. Planning work — creating a
> routine, editing targets, opening settings — goes to the platform's own top chrome, because nobody
> plans a training block one-handed at the rack.

So `Just start logging` is the primary in the band and `New routine` is a toolbar action. That also
keeps the narrowed top-corner rule honest: a top corner may hold an action the lifter is sitting down
to take, and may never hold one they need mid-set.

The restated rule, true on all three surfaces:

> **Every screen has one primary action, and it is reachable without changing grip. Navigation
> chrome belongs where the platform puts it.**

## The account seat

The account seat is the trailing item of the room's top bar, separated from product actions.
iOS also carries the shell capsule at the leading edge; Android has no room-switching capsule.
Rooms that host their own top bar declare that to the shell so it does not add a second top inset.
The shared contract is in `../../guidelines/superapp-shell.md`.

**A native tab bar's selected state is not the room's to paint.** On iOS 26 the system draws both tab
labels itself and its own selection capsule behind the selected item, and ignores a room's tint
outright — so the room applies none there (a tint on a `TabView` is an environment value that
repaints every control in every tab and each sheet they raise, for nothing). The room's job on that
platform is the **symbol**. Where a surface does own the selection — Android's navigation bar — it
may not carry it in colour alone: a filled glyph against an outlined one, a bold label against a
normal one, and an indicator behind the selected seat, with the brightest ink rather than the accent,
because the accent against the faint ink separates by barely one to one.

## Appearance

Appearance is owned by the shell; the room supplies Instrument and Daylight palettes.
Android follows system appearance through the shared theme context. A three-way Appearance
control remains a follow-up. iOS palette and text-scaling gaps remain in `../../consistency.md`.

Instrument uses emitted light; Daylight uses contrast, inked fills or a leading rule. Daylight
has no set-done glow. Density, tabular numerals and semantic colour keep the room recognizable.

Dynamic colour is disabled: accent identifies a proposal, olive a logged set, gold a personal
record and brick a destructive action. Wallpaper colours must not change those meanings.
Status and navigation icons follow the resolved skin. Consume actual system insets once and
check both gesture and three-button navigation.

## Type

iOS's custom fixed-size fonts still need Dynamic Type behavior. Android uses `sp`; layouts must
grow and reflow at large text sizes. Track remaining failures in `../../consistency.md`.

**Everything that is prose takes the platform's text styles** and scales with them. Nothing on a
board is specified in points again; each role is a named text style plus a design and a weight —
a screen title, a sheet title, a row title, prose, an action label, a secondary row, a fact, a meta
line, an eyebrow. Facts and meta lines take the monospaced design, and tabular digits ride on every
role that shows a number, so a running rest clock and a changing weight do not jitter.

The uppercase eyebrows keep their uppercasing and **lose their hand-set tracking**. Fixed tracking on
a scaling face breaks at accessibility sizes; let the face do it.

**The big numerals are instruments, and they scale differently.** The weight readout, the reps tail
and the correction figure are sized to be read across a rack with a bar in your hands, so:

1. They scale against the **largest title style, not body**. Body grows about three times to the
   largest accessibility size; a title grows about half as much. Tying a hero numeral to body would
   ask for three hundred points.
2. They are **capped**. Past the cap a numeral is not more legible, it is clipped — a four-glyph load
   plus a unit has to fit the content width.
3. **Above the cap the layout re-flows instead of the type growing.** At accessibility sizes the
   value block goes vertical: the numeral takes its own full-width line and the unit and rep count
   drop underneath at fact size. Someone who needs that setting needs the *labels* bigger; the
   numeral is already six times body size.
4. A minimum scale factor stays as the last-resort guard for a five-digit load. It is a guard, never
   the mechanism.

**Every screen carrying a numeral is drawn three times** — default, large, and the largest
accessibility size. That last one is where every hand-set fixed-width column in the room breaks, and
those columns become grids.

The exact point values at the largest accessibility sizes must be **checked in the simulator's
accessibility inspector before a board is signed off**. Published defaults are reliable at the
default size; the accessibility column is not something to take from memory.

## Where divergence is still legal

Only where the device's capability differs.

The phone holds the offline queue, so only the phone finishes a session. The phone has a haptic
engine. The web has a keyboard and a wide column. Android has no shell chrome and a system back
gesture; iOS has a shell capsule and an edge swipe.

**Divergence in vocabulary, palette values, motion physics or refusal codes is a defect**, not a
surface speaking. The copy may change between surfaces only where the capability it describes
changed.

## The frames

Native means the device's own frame, not one brand-neutral rectangle.

- iOS — 393 × 852, safe top 59, home indicator 34.
- Android — 412 × 915 dp, status 24, gesture nav 24 — **and a second bottom variant at 48** for
  three-button navigation, because the inset is whatever the system reports, not what the theme says.
- Web — a centred column at desktop, and the phone rule at 390.

> Reach is anatomy, not proportion. **The reach band is the 230 points above the bottom safe inset.**
> **The top band is the safe top plus 60.** Forty-six per cent stays the one fraction, taken on the
> full frame.

Stated that way the law gives identical answers on every frame. **The compliance frame is the smallest
supported device** — a layout that clears the law on the largest phone and fails on the smallest has
not cleared it. And no frame is called brand-neutral, because 402 × 874 is a specific iPhone.

Gym is **phone-portrait**. Large-screen behaviour is an accepted, filed gap rather than a claim:
declaring portrait in the manifest is not a guarantee on large displays at the SDK level gym targets.
