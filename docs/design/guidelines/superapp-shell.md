# The superapp shell

The frame around the rooms. Sections 1–5, 7, 8 and 10 and You in §6 govern the iOS shell, which
carries two rooms, Journal and Gym; Roadmap does not appear on iOS. §6's Appearance rules and §9's
AI-request rules govern every surface, and the last section governs the web shell's safe areas.
Android carries Gym alone and draws no shell between rooms.

> How someone arrives is `guidelines/superapp-flow.md`. Journal's canon is `journal/journal.md`;
> Gym's is `gym/briefs/`. Web auth is `roadmap/guidelines/auth.md`. Pricing is
> `marketing/guidelines/pricing.md`. The drawings of record are the Figma page
> [iOS · First run](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=112-2).

---

## 1. Two rooms, no app-level tab bar

Each room brings its own navigation, and there is no app-level tab bar: the bottom of the screen
belongs to the room. Gym keeps its own tabs — **Routines · The log · Coach**. Journal has none.

## 2. The shell owns

1. **The room menu** at the top-left (§3).
2. **You** (§6).
3. The screens before a room: **Where to start?** and **Bringing it back** (`superapp-flow.md`).
4. **The Keep sheet**, the one sign-in door (`superapp-flow.md` §6).

Nothing else. There is no hub, no capsule, no switcher sheet, no sheet that introduces the other
room, and no gesture of the shell's own.

## 3. The room menu

The room's name, top-left, is a native `Menu` (a glass button with a chevron). Tapping it lists
**Journal · Gym · You**:

- the room you are in carries the checkmark;
- each room row is its name, its symbol and at most one short line;
- the You row's line is the account state: *Not signed in* signed out, *<name> · backed up*
  signed in;
- a room may add one item of its own between the rooms and You, shown only inside that room.
  Journal's is **Show ink notes** (`journal/onboarding.md` §2); Gym has none.

The menu is the only way between rooms inside the app. It never carries a count, a badge or an
unread total. A third room is one more row here and one more door on Where to start?; nothing
else moves.

## 4. Inside a room

- **Top-left: the room menu.** Every room reserves that seat on its stack roots; one push deep the
  seat holds the room's own back button.
- **Top-right: the account button**, the trailing item where a room's root draws one, past the
  room's own actions. It opens You.
- Everything below the top bar is the room's.

## 5. Each room owns

- Its nav bar items after the room menu, its tabs, and its gestures.
- **Its palette** — the lamp on paper or ink-black for Journal, iris on pietra or verdigris on
  verdigris-grey stone for Gym. The shell does not invent a room's colours; it only says *light or
  dark*, and the room maps that onto its own place.
- **Its own settings.** You lists them and walks you in; it never absorbs them.
- The line it lends its room-menu row, and its own room-menu item, if any (§3).

**A room reports its skin outward exactly once**, so the shell can dress the chrome it lays over
that room. It must be a live value rather than a constant on the product: journal's skin is night
*or* day by the writer's choice. In the build this is `roomChrome(_:)`. Everything else about a
room's appearance stays inside the room.

## 6. You & Appearance

**You** is a sheet with **Done**, reached from the room menu's last row or the account button.

- **Signed out:** *Not signed in · Everything lives on this phone*, the Apple/email door with its
  footnote (`superapp-flow.md` §6), **On this phone** with each room's real counts, Settings
  (Appearance and each room's settings), and **Erase data**.
- **Signed in:** the name and how they signed in, **Your data** (Backup with its state, On the
  web), Settings, **Sign out** (`superapp-flow.md` §7) and **Delete account**.

**Windmill One** is one shared plan for actively requested AI assistance; credits do not pay for
passive Echoes or ordinary product use. Purchasing is closed and allowance quantities remain a
proposal (`marketing/guidelines/pricing.md`). **It never appears while signed out**, and signed in
it appears nowhere but You. You is always clay, whatever room opened it.

On the web, the settings home is `roadmap/guidelines/auth.md` §5, with one difference of place:
Appearance is not on the settings page. On `/app` it is in the account seat's pop-up — a
Light · Dark · System bar above the menu rows. On every marketing page — the four landings and the
dressed static pages — it is a two-segment Light · Dark toggle at the head of the nav's right
cluster, and the seat's pop-up there draws no Appearance row. The iOS You Appearance row is the
phone's mirror of the seat's bar.

**Appearance is chosen in one place per page, for the whole app.** Light · Dark · System, System
by default. It sets You, every sheet, **every room** and every marketing page. A room still owns
its *palette* — journal answers dark with its night canvas and light with warm paper, gym answers
with pietra or verdigris-grey stone — but it does not own the *choice*, and no room carries a theme
control of its own; a landing is not a room, and its nav toggle is the one control on that page.
"System" is not a third palette; it is the absence of an override. One stored choice
(`windmill:appearance`) feeds every web page; the seat's bar and the nav toggle read and write the
same key.

**The marketing-page toggle.** A visitor who lands on pricing or terms first can choose there,
without an account and without opening a pop-up.

- **Where.** The first item in the nav's right cluster, on every marketing page: the order is
  the Light · Dark toggle, Sign in, the CTA, then the seat where one exists — the signed-in avatar
  or the ghost seat. On a landing that is `LandingChrome.jsx`'s cluster; on a dressed static page
  it is `.navr`'s first child, a box reserved in the HTML so the deferred script that fills it
  causes no layout shift. Never anywhere else on the page.
- **Shape.** The design-system `SegmentedControl` look: a 32px pill track on the secondary
  surface with a sliding filled thumb; two segments, each an icon with a one-word label — sun ·
  *Light*, moon · *Dark*. Under 480px the labels hide and the icons stand alone, the words kept
  as `aria-label`. Token-valued only, no literal colours, so it dresses with the page.
- **What it says.** A `radiogroup` named *Appearance*. The checked segment is the *resolved*
  appearance: with nothing stored it reads the system's side and moves when the system flips.
  No option is chosen by default; the page follows the system until the reader picks one.
- **What it does.** Picking a segment stores `light` or `dark` under the one key and repaints at
  once — `<html data-theme>` and the browser-chrome metas — on this tab and every open tab.
  Picking the segment already checked changes nothing visible but still stores the value: a
  page that was following the system now holds an explicit choice. There is no System segment;
  the way back to following the system is the seat's bar on `/app`.
- **Keys.** Arrow keys move between the two segments, as in the seat's bar.

**On iOS, state the scheme twice: once as the window's `preferredColorScheme`, once as an
environment override down the tree.** `preferredColorScheme` travels *up* to the window — it flips
the UIKit traits but does not write `\.colorScheme` back into the subtree that declared it, so a
room reading the environment would otherwise see the system's answer. Only the environment
override reaches the rooms.

No call site branches on the skin: the role tokens are aliases onto an *adaptive* neutral ramp,
exactly as `tokens/colors.css` re-authors the ramp under `[data-theme="dark"]` and lets every
role follow. `surfaceCanvas` IS `neutral50` in both skins.

## 7. Honesty rules for this frame

1. **Never a number we don't have.** Counts on Bringing it back and On this phone come from real
   records. A plan meter, a digest line or a streak is drawn only when the data behind it is real.
2. **No walls.** The app opens on a choice of rooms or on the last room, never on a sign-in screen,
   and signing in *keeps* what is already there unless the person, asked, discards it
   (`superapp-flow.md` §6).
3. **No urgency.** No countdown styling, no urgency colour, no "only 1 left" — the Coach
   allowance included.

## 8. Held open

- **Gym in light appearance on iOS.** The shell follows the system; iOS gym defines only its dark
  Instrument palette (`consistency.md` F4).

## 9. Active AI requests and accounts

These rules hold on every surface.

- **Everything a person does by hand works signed out** — writing, logging sets, building
  routines, planting steps, editing and every read.
- **Account-metered AI assistance needs an account, with one exception:** on iOS, Coach answers
  5 questions per phone without one, once, never refilling (`gym/briefs/09-coach.md`). When an
  action needs an account — an account verb, or a Coach question past the allowance — the door
  opens at that moment and the action resumes afterwards.
- Public text import on the web is anonymous; it cannot debit an account until attribution is
  defined.
- Passive Echoes use no AI credits.
- Every first run still reaches a real thing with zero agent calls: Journal's cursor, Gym's
  **Just log** and **Build it myself**, the roadmap's starter quests and blank tree.

## 10. Constants — copy into the build

```
ROOMS       iOS: Journal · Gym · Roadmap is web only · no app-level tab bar
ROOM MENU   the room name, top-left · native Menu · Journal · Gym · You
            checkmark on the room you are in · You row = Not signed in | <name> · backed up
            never a count or a badge
ACCOUNT     trailing account button on a room's root · opens You
RETIRED     hub · capsule · switcher sheet · house sheet · shell gestures
YOU         signed out: the door, On this phone, Erase data · no Windmill One
            signed in: Backup, On the web, Sign out, Delete account · always clay
APP OWNS    its bar after the room menu, tabs, gestures · its palette · its settings
            its menu line · its skin reported outward once
AI REQUESTS account-metered · iOS Coach: 5 questions per phone, once, without an account
```

## Web safe areas

The web shell fills `100dvh` with a `100vh` fallback, consumes the top safe-area inset and
passes `--content-safe-area-top: 0px` to products. Standalone roadmap falls back to
`max(env(safe-area-inset-top, 0px), 44px)`. Product content must not consume the same inset twice.
