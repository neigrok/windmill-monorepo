# Onboarding — four screens that answer "so what is it?"

The once-ever introduction on the two phones: one screen for Windmill, one for each product. A
picture and a few words each. Companion to `superapp-flow.md` (the iOS journey, which the pager
precedes) and `gym/android-delivery.md` (the Android room it precedes). The drawings of record are
the Figma page [Onboarding · 2026-10-04](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=209-2)
in the Design System file. Decided by the owner on 2026-10-04: direction A · Three rooms, iOS page 4
leads to Where to start?, About Windmill in You and the account sheet, and the four screens are the
accepted exception to `superapp-flow.md` §3 and §8. Drift is ledger `consistency.md` § Onboarding.

---

## 1. Purpose

People open the app and ask "so what is it?". The pager answers at first sight: **screen 1** says
Windmill is three ways to grow under one account; **screens 2–4** show one product each in its own
palette, in plain second-person words, with the one honest line of where that product lives on this
phone.

It sells nothing, signs nobody in, asks no permission and chooses no room. It is skippable from
every page and never stands between a returning person and their data.

## 2. Placement

Drawn in section *0 · Placement* (`209:62`).

- **Shown once**, on the first cold launch of a fresh install, when the phone holds nothing: no
  account, no last room, no records, and the launch is not a deep link. On iOS it comes before
  **Where to start?** (`superapp-flow.md` §3); on Android it comes before Gym's first open
  (`gym/briefs/09-coach.md`).
- **Never shown** to a signed-in cold launch, a deep link, a launch after sign-out (that person
  knows the app) or any phone that already holds a room. A returning person on a new phone sees it
  once and taps Skip — nothing of theirs is on the phone yet, so nothing is in front of their data.
- **The shown flag is per device**, survives app updates and sign-in, and is not reset by sign-out.
- **Seen again** from **You → About Windmill** on iOS and from the account sheet → **About Windmill**
  on Android. Replayed, the iOS pager is a sheet with **Done** top-right and **Done** as the last
  page's primary; the Android pager is a destination with the back app bar, **Done** on the last page.
- **Exit:** page 4's primary **Get started** lands on Where to start? (iOS) or Gym's first open
  (Android). The pager does not pick a room.

The introduction is the journey's one carousel and its one page control, and the two screens
`superapp-flow.md` §8 allows before the core action are counted after it — the owner's accepted
exception (2026-10-04), stated in `superapp-flow.md` §2, §3 and §8.

## 3. The four screens — Three rooms

Boards: iOS dark `212:2` `212:78` `212:140` `212:203`; iOS light `213:371` `213:385` `213:402`
`213:419`; Android Instrument `213:626` `213:694` `213:748` `213:803`; Android Daylight `214:792`
`214:806` `214:823` `214:840`.

Every page has the same bones, top to bottom (`thumb-reach.md`): identity in the top band — the
wordmark on page 1, the product eyebrow on pages 2–4, **Skip** top-right on pages 1–3 — the picture
and the words in the reading band, and the page control plus one full-width primary in the reach
band, pinned above the home indicator or gesture inset.

| Page | Picture (`_Glimpse / …`) | Words | Tag | Primary |
|---|---|---|---|---|
| 1 · Windmill | Three rooms — the three products as stacked bands, each in its own palette with its shipped tagline | title + body | — | Next |
| 2 · Roadmap | A skill tree fragment: *Learn to sail* complete, three steps open, three locked | eyebrow + title + body | where it lives | Next |
| 3 · Journal | A page fragment: yesterday dimmed above, tonight with a live caret, mood and energy unasked, *saved* in mono | eyebrow + title + body | where it lives | Next |
| 4 · Gym | The logger: *Squat · set 3 of 5*, two logged rows, the current row, **100** kg × 5, last time 97.5, **Log set** | eyebrow + title + body | where it lives | Get started |

On iOS the pictures sit in cards on the family ground; the ground never changes between pages. On
Android the ground is gym's own palette because Android draws no shell between rooms
(`superapp-shell.md`); the cards keep each product's palette.

Considered and not chosen: *B · Posters* — one question, one object, centred on each product's
full-bleed palette. Its boards stay on the page, labelled not chosen (`213:190` `213:232` `213:287`
`213:329`; light `214:612` `214:635` `214:670` `214:691`), and nothing is built from them.

## 4. Every string

Chrome on first paint is counted against the forty-word decision window of `text-budget.md`. The
picture's own words — node names, the composed page, the fixture — are content and are listed
separately. Casing is sentence case; the eyebrows are mono small caps.

### The strings

| Page | Element | String | Words |
|---|---|---|---|
| 1 | identity | **Windmill** (the wordmark) | 1 |
| 1 | top-right | Skip | 1 |
| 1 | title | Three ways to grow. | 4 |
| 1 | body | One account keeps them together. You can start without one. | 10 |
| 1 | band names | Roadmap · Journal · Gym | 3 |
| 1 | band taglines | Map what you're learning · Notice what happened · Keep a training log | 11 |
| 1 | primary | Next | 1 |
| | | **first paint** | **31** |
| 2 | eyebrow | ROADMAP | 1 |
| 2 | top-right | Skip | 1 |
| 2 | title | Map what you're learning. | 4 |
| 2 | body | Your goal as a skill tree. Each step opens the next, and you watch it grow. | 16 |
| 2 | tag | *per phone — see below* | 3 |
| 2 | primary | Next | 1 |
| | | **first paint** (27 with the picture's caption) | **26** |
| 3 | eyebrow | JOURNAL | 1 |
| 3 | top-right | Skip | 1 |
| 3 | title | A page a night. | 4 |
| 3 | body | Write a line or a page, in your own words. Nothing is graded or shared. | 15 |
| 3 | tag | *per phone* | 3 |
| 3 | primary | Next | 1 |
| | | **first paint** (26 with the caption) | **25** |
| 4 | eyebrow | GYM | 1 |
| 4 | title | Log the set. | 3 |
| 4 | body | Two taps a set, and next time your numbers are already there. | 12 |
| 4 | tag | *per phone* | 3–5 |
| 4 | primary | Get started | 2 |
| | | **first paint** (24 with the caption) | **23** |

The band taglines are each product's `landing.root.tagline` in `web/src/products/<product>/routes.js`,
verbatim, so the landing and the phone say one thing. The three bodies are the landing's own claims:
a step opens only when the steps before it are done; nothing is graded or shared; load and reps are
prefilled from last time. *Only you can read it* was rejected: search and Echoes read the text
(`journal/journal.md` §12).

**Replay strings:** Skip becomes **Done** (iOS top-right; Android has the back app bar instead) and
page 4's primary becomes **Done**.

**Picture captions:** every product glimpse carries one mono caption, **EXAMPLE**, top-right — the
phone form of the landing's composed-specimen rule (`marketing/briefs-landings/00-README.md`).

**Picture content (not chrome):** page 2 — *Learn to sail · Knots & lines · Rig the mast · Points of
sail · Capsize drill · Reefing · Read the wind*; page 3 — *YESTERDAY · Walked before work. Slept
better than the week before. · Tonight · Finished the chapter I kept avoiding. Lighter than
expected · Mood · Energy · saved*; page 4 — *Squat · set 3 of 5 · 1 ✓ 100 kg × 5 · 2 ✓ 100 kg × 5 ·
Set 3 · target 100 × 5 · 100 · kg × 5 · Last time · 97.5 kg × 5 · Set 3 logged · Log set*. One
fixture, shared with the landing's gym band; the ledger rows agree with the header.

### Where each product lives — the per-phone tag

The tag states where the product is **now**. It is a per-platform string table, changed only in the
release that moves a product, and never says "soon".

| Product | iOS app | Android app |
|---|---|---|
| Roadmap | On the web | On the web |
| Journal | **In this app** | On the web |
| Gym | On the web and Android | **In this app** |

*In this app* is drawn in the product-accent style (`_Where tag / Here`); the others in the quiet
style. The table is the truth of 2026-10-04: `STRUCTURE.md` names the surfaces, and the iOS app is
the journal (`apps/ios/App`). When the iOS gym room ships, its row becomes *In this app* on iOS and
*On the web and iPhone* on Android, in that release.

## 5. The pictures

The pictures are the ownable part: a living glimpse of each product, drawn from the product's own
tokens, never a stock illustration and never a raster. They are components in section *Components ·
Onboarding* (`209:69`): `_Glimpse / Roadmap` `210:2`, `_Glimpse / Journal` `210:28`, `_Glimpse / Gym`
`210:56`, `_Glimpse / Three rooms` `210:73`, plus `_Page control` `210:147`, `_Where tag` `210:156`,
`_Brand / Wordmark` `210:157` and the Android chrome (`210:168` `210:173` `210:181`).

- **Size.** 354 × 340 pt on iOS (card radius 24, 1 pt line); the same component centred in the
  372 dp column on Android. The three-rooms glimpse is three 354 × 100 bands.
- **Palette.** Every fill is bound to the hidden collection `Onboarding · Colour` (Dark / Light),
  whose values are the shipped family, roadmap, journal and gym tokens; the roadmap kind colours
  and locked treatments come from `tokens/colors.css`. Gym day uses verdigris `#137A6C` (owner
  ruling); Android's Daylight skin still ships iris, ledger F44. The build draws the glimpses from
  its own tokens — it ships no PNGs.
- **Roadmap.** A root (*Learn to sail*, complete, olive, the crown halo), three children (one
  complete terracotta, two available with sky and gold rings), three locked grandchildren on dormant
  edges, one travel head on the lit edge to *Rig the mast*. Available nodes are card-filled with the
  kind ring (`roadmap/guidelines/tree-layout-contract.md`; the shader disagrees, ledger 1e). The fan
  runs from the root outward; it is an illustration of a skill tree, not the product's layout.
- **Journal.** Yesterday above in dim ink, tonight below in ink with a lamp caret after the last
  word, the mood and energy strip visible at 55 % and unasked, *saved* in mono, lamplight rising from
  the bottom edge.
- **Gym.** The quiet ledger (two logged rows, the current row with its accent rail), the 72 pt mono
  load high in the card, the controls low: the olive set-done check with *Set 3 logged* and the
  verdigris **Log set** pill.
- **The mark.** Page 1's wordmark is the exact `web/public/brand-mark.svg` beside *Windmill* in
  Baloo 2 Bold terracotta. It keeps its colours on both grounds and is never animated
  (`brand-logo.md`).

## 6. Motion

Beats and curves are `motion-language.md`'s; nothing here invents motion.

- **Page change** is the platform pager's own scroll. **Next** animates the same scroll.
- **First paint is still** on every page. When a page settles, it plays **one finite beat**:
  - page 1 — the three bands fade and rise 8 pt on the 320 ms cadence, 280 ms ease-soft each;
  - page 2 — the travel head runs *Learn to sail → Rig the mast* (420 ms, ease-standard) and *Rig
    the mast* ignites at 85 % of the arc (280 ms); the crown halo breathes at 2400 ms, the page's
    one loop;
  - page 3 — the caret blinks, the only moving thing (`journal/journal.md` §3.7); the lamplight
    brightens from 0 to rest over 480 ms ease-glow; the writing does not draw on;
  - page 4 — **Log set** presses to 0.97 for 150 ms, the set-done check draws on (320 ms, the SF
    Symbols Draw On shape), *Set 3 logged* fades in 120 ms later.
- A beat plays once per visit to a page; coming back replays it. Leaving mid-beat snaps it to its end
  state (150 ms fade).
- **Reduce Motion / animator scale 0:** cross-fades only. No rise, no travel head (the edge
  cross-fades lit in 150 ms), the halo frozen at α .28, the check appears without draw-on. The
  caret still blinks under iOS Reduce Motion, as the system caret does; at Android animator scale 0
  it holds still.
- **Haptics.** iOS: `.sensoryFeedback(.selection)` when a page settles; nothing on Skip or Next.
  Android: none (`gym/android-delivery.md`: no tab haptics, and none on the pager).

## 7. Accessibility

- **Dynamic Type / font scale.** The words scale to the largest accessibility sizes and wrap; the
  glimpse keeps its own type (it is a picture) and shrinks to 260 pt tall at AX sizes; when the page
  no longer fits, it scrolls vertically inside the pager and the primary stays pinned. Android must
  be checked at font scale 2.0 on a device, not on a scaled screenshot.
- **Reading order** (VoiceOver and TalkBack): Skip → eyebrow → title → body → tag → the glimpse →
  the page control (*Page 2 of 4*, adjustable) → the primary. On page 1 the wordmark comes first and
  reads *Windmill*.
- **The glimpse is one element** with a short label, never read piece by piece: *Example of three
  rooms: Roadmap, Journal, Gym* · *Example of a skill tree: Learn to sail, three steps open, three
  locked* · *Example of a journal page: yesterday above, tonight below, mood and energy unasked* ·
  *Example of a set being logged: squat, 100 kilograms for 5*.
- **Contrast** (computed from the bound values). Body ink-dim on its ground: family 9.3 dark ·
  5.7 light, journal 9.4 · 5.3, gym 9.3 · 7.5; the tag's dim ink on the raised pill 6.0 by day. The
  library terracotta primary's white label is 3.9:1 by day — 17 pt semibold is large text and passes
  at 3:1; it is the shared `_iOS / Button`, not this brief's. The mono EXAMPLE caption and *saved* are
  decorative and are not read.
- **Localisation.** A string may run 35 % longer; titles wrap to two lines, bodies to three, the
  tag to two, before anything else moves. Buttons never truncate.

## 8. Skip, back and exits

| Act | iOS | Android |
|---|---|---|
| Skip (pages 1–3) | plain button, top-right → Where to start? | TextButton in the top app bar → Gym first open |
| Next | pager scrolls one page | pager scrolls one page |
| Swipe | native pager; the last page rubber-bands forward | HorizontalPager; the last page rubber-bands |
| Back | swipe back a page; no back button | system Back → previous page; on page 1 it leaves the app, with the predictive-back preview |
| Get started (page 4) | → Where to start? | → Gym first open |
| Replay | sheet from You → About Windmill, Done top-right and on page 4 | destination from the account sheet → About Windmill, back app bar, Done on page 4 |

Nothing counts skips. No page is required reading.

## 9. What this requires of the build

1. **A per-device shown-once flag** that survives app updates and sign-in, is not reset by
   sign-out, and is read before the first frame so the launch screen's ground is the pager's.
2. **iOS:** `TabView(.page)` with the system page control, Skip as a plain `Button` top-right, the
   primary `.borderedProminent` terracotta at 52 pt above the home indicator; an **About Windmill**
   row in You (`superapp-shell.md` §6) that presents the same pager as a sheet.
3. **Android:** `HorizontalPager` with `PagerState`, a Row of 8 dp dots (Material 3 ships no page
   indicator), `TextButton` Skip in a 64 dp `TopAppBar`, a 56 dp filled `Button` with 16 dp corners
   above the gesture inset, predictive Back; an **About Windmill** destination from the account sheet
   (`gym/android-delivery.md` Profile).
4. **The glimpses are drawn from the tokens** on both platforms, with the one-beat motion and its
   reduced-motion fallbacks of §6.
5. **The per-phone tag table of §4 lives in one string table per app**, changed in the release that
   moves a product.
6. **Accessibility of §7** is tested on devices in both modes: reading order, the single-element
   glimpses, the largest text sizes.
