# Native idiom — how the three surfaces are allowed to differ

Gym ships on web, iOS and Android. Until this wave the two phones were **the same custom drawing at
two sizes**: the same hand-rolled capsule rail, the same bottom-drawn back row, the same bespoke
switch, the same hand-built list. They differed on about sixty arbitrary numbers and agreed on
nothing structural. They differed by accident and agreed by accident.

This brief replaces that with a rule.

## The law

> **Where the platform has a control, the platform's control wins. Where it does not, Windmill's own
> vocabulary wins, identically on every surface.**

A tab bar, a navigation stack, a list, a switch, a segmented control, a sheet, a snackbar, a date
field, a share sheet, a progress indicator and a confirmation dialog are the **platform's**. A
weight numeral, a plate ladder, a set row, a proposal diff, a read receipt and a routine card are
**ours**, and they look the same everywhere.

The line is not aesthetic. A lifter has spent years learning what a back gesture does, what a
long-press offers, what a swipe on a row means, and where the account lives. Re-teaching them costs
them something and buys us nothing. A weight ladder, on the other hand, is ours to invent, because
nothing on the phone already means it.

## What follows on each surface

**iOS.** A real `TabView`. A real `NavigationStack`, with titles and toolbar items where the system
puts them. `List` for anything that is a list. The system's segmented picker, stepper, toggle,
confirmation dialog, share sheet and progress view. SF Symbols on every affordance that has one.
Sheets keep their detents.

**Android.** A real `Scaffold` with a real top app bar and a real navigation bar. Material's list
item, card, switch, segmented button, chip, text field, snackbar and dialog. Material Symbols on
every affordance. Modal bottom sheets keep the drag handle they currently pass `null` to. The room
opts in to predictive back and draws edge to edge.

**Web.** The shared design system, which the gym room currently reaches for four times out of
seventeen while hand-rolling a twin for the button, the input, the card, the dialog, the toast, the
tabs, the tag and the icon. Those twins go.

Where the design system genuinely lacks something the wave needs — a chat bubble, a diff card, a
note row, a weight chart — it is **authored in the design system**, not in the gym folder. Roadmap's
families are roadmap's vocabulary, not the brand's, and gym does not reach across for them either.

## Back, and the thumb

The house law says controls go to the bottom, and the room drew a back affordance at the bottom of
every pushed screen to obey it.

That was a workaround. The shell disabled the system pop gesture, so the room had no back and drew
one. Restoring a real navigation stack restores the gesture — and **the gesture is already under the
thumb on both platforms.** The house law governs controls the user must *touch*; a swipe from the
edge is not one.

**But the iOS leading edge is already taken, and this is the single largest risk in the wave.** The
shell attaches its go-home swipe to the leading twenty points as a *simultaneous* gesture — the
modifier whose whole meaning is *do not require exclusivity* — and every navigation stack that exists
in the app today lives inside a sheet, outside that subtree. So the two gestures have never met.

> **The edge is arbitrated by depth, not shared.** A room reports its stack depth outward, and the
> shell applies its home swipe **only at depth zero**. At a tab root the edge means home; one push
> deep it means back.

That amends the shell's "two gestures, and nothing else" to "the shell owns the leading edge only at
the root of a room's navigation stack" — a scope, not a deletion. It is a shell change outside gym's
files, and **it is prototyped on a simulator before any iOS board is called finished.**

So: **navigation chrome returns to where the platform puts it, and committing actions stay in the
reach band.** Apply, Save, Log set and Finish live in an iOS bottom safe-area inset or bottom toolbar,
and in an Android scaffold's bottom bar. Same law, platform spelling.

The restated rule, true on all three surfaces:

> **Every screen has one primary action, and it is reachable without changing grip. Navigation
> chrome belongs where the platform puts it.**

## The account seat

The shell's canon says the You seat is the last slot in every app's own bar, past a hairline, so it
reads as the shell's and not the app's. A hand-rolled rail could hold that. **A native tab bar
cannot** — a fourth slot in a three-tab bar is not a thing either platform draws, and jamming an
avatar into one is exactly the kind of invention this brief removes.

Both shell seats move into the room's own **top** chrome: the capsule leading, the You seat trailing,
on each stack root. On Android, which has no shell chrome at all, the avatar is the top app bar's
single action slot — the seat is the only shell thing on that surface, and the top bar is the honest
place for it.

That amends two canon lines rather than quietly disagreeing with them. "The last slot in every app's
own bar" becomes **"the trailing slot of the room's own top bar"**. And the thumb-reach line about top
corners is narrowed to what it actually means: **no primary or destructive action in a top corner. A
destination is not an action.**

**The reclaimed top eighth is a fiction unless the shell gives it back.** Of the lane the shell
reserves, most is unavoidable safe area and only about forty-six points belong to Windmill — against a
forty-four point navigation bar. The inset is applied by the shell, outside the room's view tree, so
the room cannot reclaim it by drawing differently. Either the shell stops applying that inset for a
room that hosts the capsule itself, or **native costs vertical space and no board may claim
otherwise.**

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

**And the status bar must follow the resolved skin.** The Android theme pins the status icons light
and nothing enables edge-to-edge, so turning the room to a light ground would make the clock, the
battery and the signal disappear. That is a one-line change and a real bug if it is missed.

## Type

Both phones hard-code point sizes, so **Dynamic Type and font scale do nothing on either.** That is
the largest accessibility gap in the room and the least visible one.

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
