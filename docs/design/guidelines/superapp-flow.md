# The journey — the iOS first run, signed out and signed in

Companion to `guidelines/superapp-shell.md`, which rules the frame between the rooms; this doc rules
how a person gets into the iOS app, what works before they have an account, and what each room's
first run must be. The drawings of record, including the state matrix and the flow map, are the Figma
page [iOS · First run](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=112-2).

Other surfaces: web auth is `roadmap/guidelines/auth.md`; the roadmap's first run is
`roadmap/guidelines/front-door.md` and `starter-quests.md`; Journal's first run is
`journal/onboarding.md`; Android's gym is `gym/android-delivery.md`. Two parts of this doc hold on
every surface: signing in with work already on the device (§6) and signing out with unsent changes
(§7).

---

## 1. The principle

Open on a choice, not a pitch. Make one real thing; only then does the app offer to keep it. An
account is an *adoption* of what is already on the phone, never a gate in front of making it.

**Login is never forced, so signed out and signed in are two first-class states.** The state matrix
lists every screen in both states; where they differ, both boards are drawn side by side.

## 2. Launch

- **The launch screen is the first screen's ground colour, nothing else.** No logo, no splash.
- **A cold launch with no last room on the phone** — the first launch, or the first after signing
  out — opens **Where to start?**.
- **A signed-in cold launch skips it** and reopens the last room. A signed-out launch after the
  first reopens the last room too.
- A deep link opens its room directly.

## 3. Where to start?

> **Where to start?**
> Two rooms, no account needed. Switch any time.

- **Two room doors, Journal and Gym**, each in its room's own colours with one line: *Write
  tonight's page* · *Log today's training*. One tap opens that room's first run and makes it the
  last room.
- **A quiet Sign in** under the doors, for someone returning on a new phone (§4).
- **No account wall, no skip, no permissions, no carousel.**
- After a sign-out it adds one line, once: *Signed out. Nothing of yours is left on this phone.*
  When the person kept unsent changes (§7), the line says so instead: *Signed out. 3 unsent
  changes stay on this phone until you sign back in.*

## 4. Returning on a new phone

Where to start? → **Sign in** → a sheet, *Pick up where you left off* · *Your pages and log come back
to this phone.*, with the same door as Keep (§6) → **Bringing it back**.

- **Bringing it back shows real per-room counts** as records arrive (*64 of 142 pages*,
  *31 of 38 workouts*), with a system activity indicator per row. Never a fake progress bar.
- **The last room — the one holding the newest record — opens as soon as its own data is in**,
  and says so (*Opening Gym as soon as it's ready.*). The other room keeps arriving behind it.
- When the phone already holds work from before this sign-in, any sign-in question it owes (§6)
  comes first.

## 5. Signed out is a first-class state

- **Everything done by hand works**: both rooms, unlimited writing and logging, every read, and
  every device feature that needs no identity. Nothing is disabled, dimmed or countdown-limited.
- **What is made signed out lives on this phone**, and the product says so where it is true: the
  Keep offer (§6) and You (*Not signed in · Everything lives on this phone*, with what the phone
  holds).
- **Coach answers 5 questions per phone without an account**, once, never refilling
  (`gym/briefs/09-coach.md`).
- **Windmill One is never shown signed out.**
- **The only unprompted mentions of signing in** are Where to start?'s quiet Sign in, the Keep
  offer after the first real thing, and You. An account verb the person starts — connecting a
  tool, Notes, a Coach question past the allowance — opens the same door and **resumes the action
  afterwards**.
- **Never**: on launch · on a timer · after N edits · on exit intent · as a banner · as "save your
  work" · in urgency colours. **Nothing counts declines.**

## 6. Keep — the sign-in door

**Sign-in is offered only after the first real thing exists, as a Keep offer the person opens
themselves.**

- **Where it appears, signed out:** a quiet *Only on this phone* · **Keep it** row under a kept
  journal page and under the routines Coach created; on the gym finish receipt, **Keep this log**
  under *This log is only on this phone.*
- **The Keep sheet names the value in the room's words** — the work is backed up and open on the
  web. In Journal: *Keep your pages* · *They live only on this phone. Sign in to back them up and
  open them on the web.*
- **Continue with Apple leads** — the system button, white on dark, black on light. **Use email
  instead** is the second door: one `.oneTimeCode` field, the address with **Change**, *It works
  once and lasts 15 minutes.*, and an honest resend countdown. Google does not appear in the iOS
  app.
- **The footnote guards against a forked account:** *Signed up with email before? Use email, so
  it stays one account.*
- **On success the sheet dismisses back into what the person was doing**, after the sign-in
  question below if one is owed.
- **Signed in, no Keep offer is ever shown.** A quiet *backed up* takes its place: the journal
  page's meta line ends *backed up*, the room menu's You row reads *<name> · backed up*, and You
  shows Backup with its state.

### Signing in with work already on the phone

This holds on every surface and at every sign-in: the Keep sheet, Where to start?'s Sign in, an
account verb's door. The web says *this device* where the phones say *this phone*.

- **Work made while signed in belongs to that account.** Changes made signed in, online or
  offline, go to that account without asking once it is back online or signs in again. Coming back
  from offline is never a question.
- **Signing in ends every Undo first.** Held deletes are let go before any question below
  (`gym/briefs/13-gestures.md`, "Leaving the app").
- **Work made signed out joins silently** in every room where the account holds no records of its
  own yet. A record is one of the room's own things — a page; a workout, routine, note, weigh-in or
  movement of one's own; a tree the account owns — never a setting, and never a tree it only
  follows.
- **In a room where the account already holds records, sign-in asks once**: add the work made
  signed out on this phone to the account, or discard it.
- **Work whose owner is unknown is always asked about, in its own question**, whatever the account
  holds. Work left on the phone from before Windmill kept accounts apart — quarantined pages or
  training — never joins silently. Its question counts only that work; the person's own signed-out
  work in the same room follows the two rules above, so it joins silently or gets its own question.
- **One question at a time; a room asks at most two.** Until every question is answered nothing is
  sent, and a question left unanswered — the app closed on it — is asked again at the next start.
- **Each question has no default and no "later".** Two buttons of equal weight, both in the
  platform's default style: neither is the primary fill, neither is destructive red, and there is
  no Cancel, swipe, tap outside or Escape.
- **Discard asks once more, in either question.** Choosing **Discard** opens a second alert, styled destructive, with
  the real counts and a plain *can't be undone*. Its **Cancel** returns to that question, still
  unanswered. Nothing is deleted on one tap.
- **Work that belongs to another account never joins this one.**

> **Add to your account?**
> 2 workouts · 1 routine from before you signed in are only on this phone, and your account
> already has training. Add them, or discard them for good.
> **Add** · **Discard**

When the owner is unknown, counting only that work:

> **Are these yours?**
> 3 pages on this phone are from before Windmill kept accounts apart, so it can't tell whose they
> are. Add them to your account only if they're yours, or discard them for good.
> **Add** · **Discard**

After **Discard** in *Add to your account?*:

> **Discard 2 workouts · 1 routine?**
> They never reached an account, and deleting them from this phone can't be undone.
> **Cancel** · **Discard** (destructive)

After **Discard** in *Are these yours?*:

> **Discard 3 pages?**
> This phone can't tell whose they are, and deleting them from it can't be undone.
> **Cancel** · **Discard** (destructive)

- **The counts are real, by kind, in the room's own words**, and name everything the answer
  moves or deletes: Journal *3 pages*; Gym *2 workouts · 1 routine · 1 weigh-in · 1 Coach chat*;
  the web's roadmap *2 trees*. What the account already has is named the same way: *pages*,
  *training*, *trees*.
- **Adding never matches records by content.** A routine *Push* on the account and a routine
  *Push* built signed out become two routines named *Push*. A record kept one per day joins the
  account's record for that day: a journal page's text is added to that day's page, never written
  over it, and a weigh-in follows `gym/briefs/11-bodyweight.md`, where the later write wins.

## 7. Sign out

**Signing out takes the account's data off the phone.** Tapping **Sign out** in You first lets
every held delete go and makes one attempt to send what is unsent, then raises one alert —
*Sign out?* · *Your pages and log stay in your account and leave this phone.* · **Cancel** ·
**Sign out** (destructive). Confirming returns to Where to start? with its signed-out line (§3).

**When changes still have not reached the account**, the alert is this variant instead: it says how
many and asks what happens to them. The variant holds on every surface; on the web and Android it is
the only sign-out confirmation.

> **Sign out?**
> 3 changes haven't reached your account yet. Keep them on this phone until you sign back in, or
> discard them for good. Everything else is in your account and leaves this phone.
> **Keep** · **Discard** (destructive) · **Cancel**

- **Keep** signs out and leaves the changes on the phone, hidden. They are sent the next time the
  same account signs in, and never to another account.
- **Discard** signs out and deletes them.
- The count is singular when it is one: *1 change hasn't reached your account yet. Keep it on this
  phone until you sign back in, or discard it for good.*

## 8. Each room's first run

> **One prompt · one tap to something real · nothing to dismiss.**

- **At most two screens before the core action**: Where to start?, then the room.
- The first run **is the real surface** with its opening move filled in. No carousels, no progress
  dots, no "you're all set" screen.
- Every first run can reach a real thing with zero agent calls: beside Coach's starters, Gym keeps
  **Just log** and **Build it myself**.

**Journal** — `journal/onboarding.md`.

**Gym is Coach-led, in both states.** A first open with no routines lands in Coach:

> **Set up your routines**
> Built from what you bring.

- Three starters: **Add a screenshot** · **Describe your program** · **Share your goal**.
- Two quiet escapes: **Just log** (straight to the logger) · **Build it myself** (the routine
  editor).
- Signed out, one quiet line under the starters: *5 questions without an account.* Signed in, the
  same room with no allowance line.
- Coach creates the routines: one truthful creation receipt per routine, each with **Open
  routine**, which opens the routine with **Start workout**. The goal path asks only the materially
  missing questions, answered with chips.
- With routines, Gym opens on Routines.

The full contract is `gym/briefs/09-coach.md`.

## 9. The first real thing

The first kept page and the first logged set are each **marked once**: the system success haptic
plus an SF Symbols Draw On check. No congratulation copy, no celebration, no count.

## 10. Permissions

**A permission is asked only from the feature's own tap.** No pre-permission screen.

- **Journal's nudge** is offered in context, with the writing rhythm it saw
  (`journal/onboarding.md` §3). Only its **Nudge me then** tap reaches Apple's notification alert;
  **Not now** retires the offer.
- **Apple Health** is offered on the gym finish receipt, as one switch (*Add this workout there
  too*). Turning it on raises Apple's Health sheet.
- The photo picker needs no permission.

## 11. What this requires of the build

1. **The last room is persisted per device**, survives app updates and sign-in, and is cleared by
   sign-out.
2. **Anonymous identity is stable across app updates** — a lost local identity is lost user work,
   the one unrecoverable failure in this flow.
3. **The Keep door is resumable**: whatever opened it is re-entered after success, with its state
   intact.
4. **Bringing it back** needs each room's total and newest-record date before records stream, so
   the last room can open as soon as its own data is in.
5. **Sign-out counts what is still unsent** after its one attempt to send it, so the alert's
   number is real. Kept changes survive app updates and stay hidden until the same account signs
   in.
6. **The sign-in questions need to know, per room, whether the account already holds records of
   its own**, and which work on the phone has no known owner, before anything is sent.

The backend dependencies of signed-out Coach are in `consistency.md` (6k–6n).

## 12. Held open

- **Keep offer timing** in Journal: once mood and energy are answered, or straight after the first
  kept page.
- **The first signed-out finish receipt carries two offers**, Keep this log and Apple Health. Keep
  both, or move Apple Health to the second workout.
