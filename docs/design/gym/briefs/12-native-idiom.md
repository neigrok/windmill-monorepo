# Native idiom — how the three surfaces are allowed to differ

Gym ships on web, iOS and Android. The two phones used to be **the same custom drawing at two
sizes**: the same hand-rolled capsule rail, the same bottom-drawn back row, the same bespoke switch,
the same hand-built list — differing on about sixty arbitrary numbers and agreeing on nothing
structural.

This brief is the rule that replaced that, and the rule is built.

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
keep their detents, and the finish is a sheet over the session it closed. **No `Stepper`:** the
room's only choice-shaped settings are fixed lists, and a Stepper needs a value you increment.

**Android.** A real `Scaffold` with a real top app bar per screen and a real navigation bar drawn
only while the three tabs are what is on screen. Material's list item, switch, segmented button,
text field, snackbar and dialog, coloured from the room's **own** `ColorScheme` — gold is absent
from it, because gold in this room means a personal record. Material icons on every affordance, each
with its `contentDescription`. Modal bottom sheets keep the drag handle. The room opts in to
predictive back, draws edge to edge on every version, and pairs that with `adjustResize` — without
it the keyboard pans the top bar off the screen instead of resizing the window, which is the half
that is easy to miss.

**Web.** The shared design system inside `.gym-root`: the rail, the toast, the buttons, the inputs,
the tags, the icons and the dialog are the design system's, and the twins that used to draw them are
out of `gym.css`. What stays gym's own is what the law says is ours — the weight numeral, the plate
ladder, the set row, the proposal diff, the read receipt and the routine card. A dropped-in
component resolves into the room through **one bridge block per skin** naming only the roles the
room genuinely answers for itself; every other shared role already resolves through the room's brand
scope, and re-pointing one back at gym's alias of it is a cycle that resolves to nothing.

Where the design system genuinely lacks something the wave needs — a chat bubble, a diff card, a
note row, a weight chart, a bottom rail — it is **authored in the design system**, not in the gym
folder. Roadmap's families are roadmap's vocabulary, not the brand's, and gym does not reach across
for them either.

## Back, and the thumb

The house law says controls go to the bottom, and the room used to draw a back affordance at the
bottom of every pushed screen to obey it.

That was a workaround. The shell disabled the system pop gesture, so the room had no back and drew
one. A real navigation stack restores the gesture — and **the gesture is already under the thumb on
both platforms.** The house law governs controls the user must *touch*; a swipe from the edge is not
one. Back is now the platform's: iOS's interactive pop and the bar's own button, Android's system
back through a handler that says what back means on each screen.

> **The edge is arbitrated by depth, not shared.** A room reports its stack depth outward, and the
> shell applies its home swipe **only at depth zero**. At a tab root the edge means home; one push
> deep it means back.

That scopes the shell's "two gestures, and nothing else" to "the shell owns the leading edge only at
the root of a room's navigation stack" — a scope, not a deletion — and `superapp-shell.md` carries
it. **Proven on the simulator, and the proof moved the mechanism:** over a navigation stack's own
frame the system's edge pan takes the touch outright, so the two never actually fire together; the
hazard is the strip of screen the stack does not cover — the tab bar's band — where the shell's
gesture would otherwise run alone and leave the room. So the shell's gesture is **unattached** past
depth zero, not merely declining. A depth signal wired backwards is still the quiet failure: it
disables the way home permanently and the room goes on working.

So: **navigation chrome returns to where the platform puts it, and committing actions stay in the
reach band.** `Log set` and `Just start logging` live in an iOS bottom safe-area inset and in an
Android scaffold's bottom bar; **Apply** is the review sheet's own band. Two exceptions are ruled
elsewhere and are not drift: **Finish** is a toolbar action, not a second full-strength commitment
beside `Log set` (`16-the-workout.md`), and the editor's **Cancel and Save** are the navigation
bar's, where the platform puts a draft's two answers (`15-the-routine.md`).

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

The shell's canon says the You seat is the last slot in every app's own bar, past a hairline, so it
reads as the shell's and not the app's. A hand-rolled rail could hold that. **A native tab bar
cannot** — a fourth slot in a three-tab bar is not a thing either platform draws, and jamming an
avatar into one is exactly the kind of invention this brief removes.

Both shell seats sit in the room's own **top** chrome: the capsule leading, the You seat trailing, on
each stack root and in the logger. On Android, which has no shell chrome at all, the avatar is the
top app bar's trailing action — the seat is the only shell thing on that surface, and the top bar is
the honest place for it. Where the room also wants an action of its own there, the seat keeps the
trailing slot past its hairline and the room's action sits before it.

That amends two canon lines rather than quietly disagreeing with them, and `superapp-shell.md` and
`thumb-reach.md` carry both. "The last slot in every app's own bar" is **"the trailing slot of the
room's own top bar"**. And the thumb-reach line about top corners means what it says: **no primary or
destructive action in a top corner. A destination is not an action.**

**The reclaimed top eighth was a fiction until the shell gave it back, and it has.** Of the lane the
shell reserved, most is unavoidable safe area and only about forty-six points belonged to Windmill —
against a forty-four point navigation bar. The inset is applied outside the room's view tree, so no
room can reclaim it by drawing differently; instead a room **declares** that it hosts its own top
bar, and the shell then lays nothing over it. A room that declares nothing keeps the shell's capsule
exactly as before.

**A native tab bar's selected state is not the room's to paint.** On iOS 26 the system draws both tab
labels itself and its own selection capsule behind the selected item, and ignores a room's tint
outright — so the room applies none there (a tint on a `TabView` is an environment value that
repaints every control in every tab and each sheet they raise, for nothing). The room's job on that
platform is the **symbol**. Where a surface does own the selection — Android's navigation bar — it
may not carry it in colour alone: a filled glyph against an outlined one, a bold label against a
normal one, and an indicator behind the selected seat, with the brightest ink rather than the accent,
because the accent against the faint ink separates by barely one to one.

## Appearance

**Gym stops being dark-only.** An app that ignores the system Appearance is not a native app, and the
shell's canon already says Appearance is chosen once for the whole app while a room owns its palette
and never the choice. Gym was the last room disobeying it.

**But Daylight is a design task, not a flag flip, and the wave must not pretend otherwise.** What
exists in the stylesheet is a *ground*, not a room: most of the light declarations are byte-identical
aliases onto tokens that already flip per theme, only a handful are gym-specific light decisions, and
one of those fails its own contrast gate — excused in a comment on the grounds that nothing renders
the skin.

**Daylight needs its own idea, and here it is.** The room's one instrument cue is emitted light, and
light does not survive a light ground: the glow under a logged row becomes a smudge, not a lamp.

> In Instrument the room is a **lit panel**. In Daylight it is a **printed card** — contrast does the
> work light was doing, the logged row takes an inked fill or a leading rule, and *legible at arm's
> length* is the property that carries across.

A token whose mechanism does not exist in a mode should not be given a value in that mode: the glow
token is **deleted** from the light block rather than dimmed.

The room's identity does not live in its darkness. It lives in the density, the tabular numerals, the
one vibrant hue, and the refusal to congratulate you — all of which survive a light ground.

**Android takes a staged ruling.** Its skin is a compile-time object read at several hundred sites,
the flag that would carry light or dark has no producer anywhere in the app, and Android has no
Appearance control at all. This wave provides that flag from the system and converts the skin to the
accessor pattern the token file already uses; the three-value Appearance control is a named follow-up,
not an assumption.

**Dynamic colour is off, and it is a refusal rather than an omission.** In this room colour is
meaning, not decoration: the accent says *the agent proposed this*, olive says *logged*, gold says
*a record*, brick says *this destroys something*. A wallpaper-derived palette would recolour every
proposal edge into whatever hue a home screen happens to hold, and would collide the "done" green
with a generated tertiary. Material You recolours brands; it cannot recolour a legend. It would also
make a third mode nobody can draw a board for and nobody can review, and it would make every measured
contrast ratio in the room unassertable — which the house rule against unverified claims forbids.

The honest cost, said here so it is not discovered later: an Android user who expects Material You
does not get it in this app.

**And the status bar must follow the resolved skin.** The room draws edge to edge on every version:
the activity calls `enableEdgeToEdge` with transparent bars, the theme carries only a window
background, and the `Scaffold` owns and consumes the insets. The bar-icon style is therefore set in
**code**, against the dark ground, which is exactly where the Daylight work has to change it —
turning the room to a light ground without moving that line makes the clock, the battery and the
signal disappear. One line, and a real bug if it is missed.

## Type

iOS hard-codes every point size, so **Dynamic Type does nothing to anything the room draws**. What
the platform draws now *does* scale — the navigation bar, the tab bar, and the `List` section headers
and footers the room leaves unstyled — which makes the gap louder rather than smaller: at the largest
accessibility size a section header grows several times over beside a field that does not move.
Android's sizes are `sp` and do scale with the font-scale setting — but there is no named role scale
on the room's own text, and no cap or reflow, so at a large scale the 104 sp numeral grows while
every fixed-height row and fixed-width column does not, and the room **clips** rather than ignores.
(Material controls in gym are covered: the room's theme passes a typography built from its own faces,
tabular on every role.) That is the largest accessibility gap in the room and the
least visible one.

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

**The reach law is restated in units that transpose.** It was written as absolute pixels on one
874-tall frame; carried literally onto a 852 and a 915 frame it gives three different answers to the
same question, and the top band is worst — the same number leaves a 61-point reading lane on one phone
and 96 on the other.

> Reach is anatomy, not proportion. **The reach band is the 230 points above the bottom safe inset.**
> **The top band is the safe top plus 60.** Forty-six per cent stays the one fraction, taken on the
> full frame.

Stated that way the law gives identical answers on every frame. **The compliance frame is the smallest
supported device** — a layout that clears the law on the largest phone and fails on the smallest has
not cleared it. And no frame is called brand-neutral, because 402 × 874 is a specific iPhone.

Gym is **phone-portrait**. Large-screen behaviour is an accepted, filed gap rather than a claim:
declaring portrait in the manifest is not a guarantee on large displays at the SDK level gym targets.
