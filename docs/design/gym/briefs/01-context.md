# Gym — context for the designer

Read this before any brief. It is the product, the user, the thesis, and the constraints that make
some obvious-looking designs wrong.

## The product

A training log. You are in a gym, between sets, hands chalked, phone in one hand. You log what you
just lifted. Next week the app already knows what you did and puts the number in front of you before
you ask. That is the whole product.

It is the third Windmill product — after **roadmap** (an RPG skill tree for goals, shipped) and
**journal** (a night-canvas daily journal, shipping) — behind one account and one subscription, in
one superapp with a product switcher.

## The user, named

A lifter who follows a **written barbell program**. Three to five sessions a week, the same movements
for months, weight going up in small steps (+2.5 kg). Squat, bench, deadlift, press, rows, chins.

Not a class-goer. Not a runner. Not a beginner looking for guidance. This matters for the design
because it decides what "empty" means, what the default numbers are, and how much explaining the UI
has to do. **This person knows what they are doing and wants the app to get out of the way.**

## The thesis

**The log is free. The connected log is Windmill One.**

Every competitor sells the same thing: free tracker, paid AI coach in a chat tab. Windmill has
something none of them have and already shipped it — an OAuth 2.1 MCP server. So gym's paid surface
is **your training log as an endpoint your own Claude or ChatGPT can read.** Your agent knows your
last twelve weeks of squats, drafts next block's progression, and the change arrives as a **typed
diff you tap to apply**. We never let a model write to a program directly.

**Corrected 2026-08-11, owner's call: gym also ships a chat surface** (`Ask`, board §L). This file
said "there is no chat UI to design in this product" for two weeks and that sentence is now false —
it is recorded here rather than deleted because the *reasoning* still governs the design. Ask is a
second door onto the same engine, for the lifter who has no agent of their own; it is **not** the
competitors' coach tab. What holds: it reads and proposes, never writes; a routine change is a typed
diff behind a human tap; it cannot touch a logged set or a frozen plan snapshot; it has no
personality, no encouragement, no check-in, no push, no streaks; it does not speak first; it is not
a tab; and it is never offered mid-session. The paid layer is unchanged — one Windmill One covers
both doors.

## What we are mining, and what we refuse

The inventory came from **Lift**, a real shipped iOS training log (SwiftUI, ~8.7k lines). Two things
in it are genuinely excellent and both should survive into the design:

1. **The weight ladder.** Four buttons whose step size scales with the load: ±1/±5 under 20 kg,
   ±2/±5 under 50 kg, ±5/±10 above. The button labels re-render as you climb. Stepping down from
   exactly 20 kg lands on 19, not 18. This is the difference between a form and a lifter's tool.
2. **Propose → approve → apply.** A model emits a typed diff; the human taps Apply. Nothing an agent
   suggests reaches a program without that tap.

Two things in it are the reason we are rebuilding rather than porting:

- Exercise identity was a **free-text string**, so renaming a lift forked its history.
- The plan and the log were the **same object**, so editing a program rewrote the past.

## Constraints that will bite a design

- **Web first, and the phone is the real device.** A hash-routed React SPA in mobile Safari, installed
  to the home screen. No Live Activity, no Dynamic Island, no lock-screen widgets, **no haptics**
  (iOS Safari has no Vibration API). Any confirmation must be visual, and optionally audible.
- **One hand, sweaty, mid-set.** Big targets. The primary action must be reachable by a thumb on a
  large phone. Nothing important in the top corners.
- **Landscape does not matter. Desktop barely matters.** Design the phone; let the desktop be a
  centred column.
- **Light-only is the brand default**, but gym may own a scoped palette the way journal does (see
  `G2`). Journal's night canvas lives inside `.journal-root[data-theme]` and never touches the global
  theme. Gym may do the same — and a gym is a genuinely dim, high-contrast place, so this is worth
  taking seriously rather than inheriting parchment by default.
- **The shell is not yours.** Account seat, sign-in, settings page, billing, sessions, export/delete
  are already designed and shipped. Gym registers a settings *section*; it does not redesign settings.
- **The design system is yours.** Tokens, type, motion, and 18 components (Button, Card, Badge, Tag,
  Input, Select, Switch, Checkbox, Radio, Dialog, Toast, Tooltip, Tabs, Avatar, Icon…) are at the project root (`../components/`).
  Reach for them before inventing.

## Vocabulary

Use these words consistently; they are the schema.

- **set** — one entry: exercise, weight, reps, timestamp. The atom.
- **session** — one visit to the gym; a list of sets.
- **exercise** — a movement with a stable identity (Back Squat), not a typed string.
- **routine** — a named ordered list of exercises you can start a session from.
- **plan snapshot** — what the routine said at the moment the session started. Frozen.
- **e1RM** — estimated one-rep max, Epley: `weight × (1 + reps / 30)`.
- **set kind** — warmup · working · drop · failure. A warmup does not count toward volume.

Do not use: workout *template* (it is a routine), *tracker*, *fitness*, *coach* (there is no coach —
there is your agent), XP, levels, badges, streaks.

## The feeling

Roadmap is ceremony and unlocking. Journal is quiet and warm. **Gym is neither — it is
matter-of-fact.** A tool that respects that you are tired and holding a bar. Calm, dense, legible at
arm's length, and completely uninterested in congratulating you. The one moment allowed to be loud is
a genuine PR, and even that gets one line, not confetti.
