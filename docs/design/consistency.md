# Consistency ledger

Canon-vs-code disagreements across the products, in one place so cross-product drift is visible
and fixable once rather than rediscovered per surface. Each entry names what disagrees with what
and the direction the fix flows. Delete an entry when its fix lands; add one whenever a product
copy and the root disagree.

A line that stops being true is corrected or deleted in the same change that makes it false —
here, in a guideline, in a brief, or on a board. This ledger is for disagreements being closed,
not a home for something already known to be wrong.

**F1 · journal's night canvas paints the family warm ramp, not its own cool dusk ramp**
→ fix toward `palettes.css`.
`colors.css:168` is a bare `[data-theme="dark"]` selector, and `JournalApp.jsx` stamps `data-theme`
on `.journal-root` without `data-brand` (that lives on `.wm-shell`). A directly-matching declaration
beats an inherited one, so inside the canvas that block overwrites the cool dusk ramp `palettes.css`
hands the shell: `--text-*`, `--border-*` and `--journal-gap` all come up warm brown-cream on a cool
blue-black ground. Day is unaffected — there is no bare `[data-theme="light"]` block. Two fixes
work: add `data-brand="journal"` to `.journal-root`, or narrow the selector to
`:root[data-theme="dark"]`. gym escapes it — `GymApp.jsx` stamps both attributes on one element.

**F2 · `journal.css` states the opposite of what the cascade does** → correct or delete.
The day block's comment reads "Nothing here fires in night, where the dusk ramp's own ink is the
right one." False per F1.

**F3 · `#FBF6EA` is a retired parchment two places still believe in** → fix toward `palettes.css`.
`journal.css:89` measures its re-pointed lamp steps "on `#FBF6EA`"; the shipped day ground is
`--surface-canvas` = `--neutral-50` = `#F7F7F5`. That is a stale claim. The stale value is
`apps/ios/WindmillKit/Sources/WindmillJournal/JournalSkin.swift:31`, which paints
`canvas: 0xFBF6EA`, so the phone's day sheet is warmer than the web's.

**F4 · `--pr-ink` fails the 4.5 gate in Daylight, and the gold ramp has no darker step** → a
designer's token before Daylight renders. `gym.css:66-68` states 3.2:1 for `--pr-ink`
(`--accent-gold-600`) against `--pr-soft` over `--surface-card` in pietra, which agrees with the
ledger's own recompute (3.19 on the tinted record card; 2.83 on the tinted canvas, 3.73 untinted).
Nothing renders this skin while gym pins dark (F5), which is when the token has to be decided.

**F5 · gym's Daylight skin has no producer** → **ruled 2026-08-24: build it**, owed a build.
`routes.js` pins `theme: 'dark'` and `GymApp.jsx` hardcodes `data-theme="dark"`, so the light block
in `gym.css` has never rendered. The Coach wave rules that gym stops being dark-only, because a room
that ignores the system Appearance is not native and `superapp-shell.md:80-83` already says a room
owns its palette and never the choice. Three things the ruling found and that the build owes:
fourteen of the light declarations are byte-identical aliases onto tokens that already flip per
theme, so only four are real light decisions; `--set-done-glow` is **deleted** in light rather than
dimmed, because a token whose mechanism does not exist in a mode should not carry a value in it
(done in `gym.css`; the Figma collection still carries it — `1w`); and `--pr-ink` needs a designer's
value first — see F4, which puts it at 3.2:1 with no darker gold in the ramp.
Android takes a staged version: its skin is a compile-time object read at ~560 sites,
`LocalWindmillDark` has no producer, and the platform has no Appearance control at all.

**F6 · a focused control inside gym rings iris, not the family's terracotta** → built 2026-08-26,
nothing owed. The room answers three shared roles for itself, one named block per skin at the head
of `gym.css` (`:90-110`): `--focus-ring` in iris, `--field-focus-edge` and `--chip-selected-edge` on
`--color-brand`, beside `--text-on-accent` and `--color-danger`. That is the whole bridge and there
is no per-component override anywhere else — every other shared role a design-system component reads
already resolves to gym's palette through `[data-brand="gym"]`, and re-pointing one back at gym's
alias of it would be a CSS cycle (`--gym-surface` **is** `var(--surface-card)`). The change stays
inside `.gym-root`, so `shadows.css`'s terracotta ring still rings everywhere else.

**F7 · gym asks JetBrains Mono 700/800; only 400/500/600 are loaded** → load the faces or restyle.
`fonts.js` self-hosts three weights. Gym rules ask 700 or 800 on `--font-mono`, so the browser
synthesises them, and nothing in the file says the shipped weight is faux.

**F8 · gym's big numeral tokens are declared, described as live, and read by nothing**
→ delete or use.
`--weight-size: 104px`, `--weight-leading: 92px` and `--reps-size: 54px` are declared in both skin
blocks; no rule in the repo reads any of the three. The largest numeral that ships is `.gym-fix-kg`
at 72px.

**F9 · `Avatar.jsx` and `Switch.jsx` hardcode `#fff`** → tokenize.
`design-system/core/Avatar.jsx` sets `color: '#fff'` for initials; `design-system/forms/Switch.jsx`
sets the knob `background: '#fff'`. The only un-tokenized colours in the component library.

**F10 · `gym/marketing/gymLanding.css` hand-copies the product token block and has drifted**
→ fix toward `gym.css`.
Its `--alarm-ink` is `var(--color-danger)` where the product's is `--accent-brick-300`.

**F11 · global `a:hover` outranks gym's anchor classes** → fix toward the code.
`global.css`'s `a:hover` is (0,1,1); `.gym-routine-name`, `.gym-last-name`, the history lines and
inactive tabs are (0,1,0), so all of them repaint to `--text-link-hover`. The worst case is
`Build a routine`'s label doing it on top of its own iris-300 fill. This entry is an accessibility
defect rather than a drift.

**F12 · `palettes.css` mixes colour spaces inside its own hue comments** → state the space.
"sky 200° / plum 315°" are HSL; "65° from sky" is OKLCH-only; "iris ~265°" matches neither
(HSL 252, OKLCH 291). A hue angle without its space is not a measurement.

**F13 · the tree canvas can never go dark** → an owner call: pick a side, then make both halves agree.
`theme.js:69` sets `BACKGROUND.canvas = '#F9F5EB'` and `scene/SkillTreeScene.js` clears the GL
buffer to it opaquely every frame. `.st-root` reads `--surface-canvas`, which is `#1C1712` in dark,
and appearance defaults to `'system'` — so every dark-OS visitor gets a cream canvas inside dark
chrome. Against that cream `.st-brand` flattens to `#403A32` and the loading veil to `#7F7B74`.
Either the scene learns the theme (and the six kinds need a dark set the GL can read), or dark is
dropped for this room and the chrome stops claiming it. The Figma file draws Day as the hero.

**F14 · `theme.js` says it matches the design system 1:1; in dark it does not**
→ correct the comment, then decide the values.
`colors.css` bumps every `--kind-*` to the 400 step in dark; `theme.js` freezes the 500s. So
`SkillNode.jsx` and `HomeCard.jsx` (CSS vars) use the dark hues while the list workbench, the
plaque, `NextUp`, `KindLegend`, `StepPanel`, `Minimap` and the whole GL scene use the light ones.
On the ember card a ready fruit's ring lands at 2.84:1. The comment is the cheap half; the values
are downstream of F13.

**F15 · two documents say a complete node breathes; the shader says it does not** → delete both claims.
`theme.js:14` and `web/src/products/roadmap/ARCHITECTURE.md` describe complete as wearing "a breathing
halo". `scene/NodeBatch.js:224` reads `HALO_STEADY; // no oscillation`. Only the crowned root
breathes. The DOM specimen does animate `wm-pulse-node` when `pulse` is passed; that is opt-in and
is not the scene.

**F16 · `TreeSwitcher.jsx` invents a third kind palette** → fold into the two that already exist.
It maps kinds itself rather than reading `NODE_COLORS`: `brick` becomes `var(--color-danger)`
(which drifts in dark, since the semantic token moves and the kind does not) and `plum` is a bare
`#8D4F83` literal.

**F17 · the share export wears the family night, not roadmap's room** → fix toward the room.
`share/palette.js` builds its dark palette from the family neutrals rather than roadmap's ember
ramp, while the file's own header claims exports can never drift from the app.

**F19 · `.st-ticker-item .st-event-obj` hardcodes `#fff` on an inverted surface** → re-point it.
Dark flips `--surface-inverse` to `#F4EEDF`, a light value. The ticker item sits on it and paints
its object white, so it is effectively invisible in dark.

**F20 · three roadmap class names have no CSS anywhere** → delete them or write them.
`.st-list-bud` and `.st-list-jump-chip` (`list/ListView.jsx`) and `.st-action-lane`
(`ui/mobile/ActionLane.jsx`) are applied in JSX and match no rule in any stylesheet.
Same family: `skilltree.css:1` calls the root "full-viewport", which `chrome.css`'s
`contain: layout paint` makes false; and `list.css` credits CSS with the 6px minimum bar width
that lives in `ListView.jsx`.

**F21 · `/roadmap` never passes `brand`, so roadmap's own brand block never matches** → one prop.
`RoadmapLanding.jsx` renders `LandingPage` without a `brand` prop, so `[data-brand="roadmap"]`
never applies. That makes both `landing.css:11-12` and `palettes.css:16-19` false as written —
they describe a hue swap that does not happen. The page looks right only because the family
default is already terracotta.

**F22 · journal's crawlable shell uses a different accent from the live landing**
→ fix toward the live value.
`journal/marketing/landingHead.js` uses `#C29A4E` (lamp-500) where the live brand is `#986B1E`
(lamp-600); the shell's CTA label lands at 2.40:1. Roadmap's and gym's shells match their live
values. This is the version crawlers and link-preview bots see.

**F23 · `magic-link-fork.html` is the only email without `color-scheme: only light`**
→ add it, and fix the README.
Every other template pins it on root and body; this one does not, so it will auto-invert in Apple
Mail and iOS Mail. `emails/README.md` states that every template carries it, so the doc is wrong
at the same time.

**F24 · `magic-link-signup` uses double-brace interpolation** → triple-brace, per the Resend contract.
The template writes `{{magic_link}}`. The contract is `{{{var}}}` for raw values; double braces
HTML-escape, which breaks a URL carrying `&`.

**F25 · `privacy.html` and `changelog.html` have stopped being true** → rewrite both.
`privacy.html` stamps "Updated July 2026" and its line "that's every email we send today" omits
both the reminder and the journal nudge. `changelog.html` stops in July: no journal, no gym
opening — against a promise `terms.html` makes twice that material changes are logged there.

**F27 · `journal-nudge` is sent in production and has no template in the repo**
→ recover it from Resend.
The nudge ships to real inboxes and the only copy of its markup is inside Resend, so nothing in the
repo can be reviewed, versioned or corrected.

**F28 · journal's in-page echo form does not exist at any desktop width**
→ decide, then fix the doc or the CSS.
`journal.css:926-930` sets `.je-ink` and `.je-ink-foot` to `display: none` for every viewport
≥1240px — gated on the media query alone, not on `.has-margin`. The "in-page echo form on desktop"
that briefs and boards describe cannot be produced at 1280; it appears only below 1240. The Figma
board draws it at 1024 and says why. Either the gate lost its `.has-margin` half, or the form is
deliberately margin-only above 1240 and every description of it is wrong.

**F29 · three journal mono styles are authored at weights the product never loads** → drop them to 600.
`.je-tab-face` asks 700, `.je-trail-label` 800, `.je-plan-price` 700; `styles/fonts.js` self-hosts
JetBrains Mono at 400/500/600 only. Same shape as F7, so the ramp should be clamped at its loaded
weights rather than fixed one site at a time.

**F31 · two gym surfaces render in the OS UI font, not Nunito** → add the family.
`.gym-picker-row` and `.gym-fix-step` set neither `font-family` nor `font: inherit`, so a `<button>`
falls back to the UA default. The keypad's two siblings already carry Nunito, so this is an omission.

**F32 · every quest-roster step draws an empty glyph circle**
→ give the roster icons, or stop reserving the well.
`node.icon` is optional. Only a tree's root is given one (`'sparkles'` at `QuestShelf.jsx` and
`NewTreeBirth.jsx`); in-app creates use `NEW_NODE_ICON`. A roster step passes `undefined`,
`Icon.jsx` returns `null`, and `.st-step-glyph` renders as an empty 40px sunken circle on every row.

**F33 · at night, roadmap's ghost icon buttons are cream ink on the cream canvas** → downstream of F13.
The three ghost `IconButton`s and the zoom glyphs take `--text-primary` (`#F1E9D8` in dark) and have
no pill of their own, so they sit directly on the GL canvas, which is still `#F9F5EB`.

**F34 · nine journal type declarations have no style in the ramp** → the ramp's owner decides.
`.je-first .je-ink-passage`, `.journal-talk-state`, `.journal-talk-act`, `.journal-talk-note`,
`.je-sheet-buy`, `.je-ink-desk .je-verdict-mark`,
`.journal-nudge-suppressed .journal-nudge-when`, `.journal-week-count strong`, and
`.journal-scale-word` under 684px. They ship; they are not in the named ramp. The Figma specimen
board lists them as an appendix rather than minting nine styles nobody chose.

**F35 · two Windmill · Gym boards disagree with each other** → a board fix, not a code fix.
`A5 · Routines` reads `Lower B — 5 movements · trained yesterday` while `A4 · The log` puts Lower B
on `Sun 17 Aug` with the newest session `Tue 19 Aug`. `B2 · Finish` prints `Bench Press e1RM 118.4`,
which no clean plate load reproduces under Epley (`backend/products/gym/domain/Review.cpp`). The
later boards use one calendar and e1RMs that re-derive exactly; these two should join it.

**F36 · on a phone, the floating tool rail sits on top of the writing** → give it a phone rule.
`.journal-tools` is `position: fixed; right: 20px; bottom: 84px; z-index: 40` with no phone
override; the only rule that moves it shifts it to `right: 320px` at ≥1240. At 390 the measure runs
x 22 → 368 and the rail occupies x 326 → 370, so the last ~42px of every line sits under a 44px
button, on every phone, always. The buttons are `--surface-card @88%` with an 8px backdrop blur, so
the text is dimmed and blurred rather than hidden. `.je-home` has the same shape but only mounts
after an echo-trail hop, where floating is plausibly the intent.

**0g · gym's landing opens many dark windows, not one** → a designer call; direction of fix is 00-README.
The chrome rule reads: a product may open a window of its own skin inside the moat, but the page
around it stays the family's warm cream. `/gym` opens a `[data-theme="dark"]` region for the moat,
each beat stage and each proof card, against `/journal`'s one. The frame is light on both, so the
rule holds literally, but the result is a dark page with cream gutters. Either the rule means one
window and gym's beats come up to daylight, or 00-README should say it means any window the
product's skin genuinely owns.

**0h · `--kind-brick` on the roadmap landing vs "brick never appears"** → direction of fix is 00-README.
Honesty rule 6 says brick never appears on these pages and gold is flourish, never a state. The
roadmap landing paints the "Rust from zero" quest card's rule and its first progress dot in
`--kind-brick`. Canon should say which holds: brick banned as chrome and state while a kind hue may
still identify a kind, or the rule is absolute and that card needs a different hue. Gold is clean
either way — on all four landings it appears only as flourish.

**0i · the brand-root landing does not fill the nine roles** → a brief is owed.
It fills roles 1, 2, 6, 7, 8 and 9. It has no role 3 (the loop), no role 4 (proof), no role 5
(trust boundary, whose can't-line is mandatory), and no moat at all, which is role 2's heart. What
it needs first is `marketing/briefs-landings/04-brand-landing.md`: what the brand root's moat is
when the page belongs to no single product, and what proof and trust boundary mean at brand scope.

**0j · the brand root prints a price in structured data** → 00-README to rule.
00-README honesty rule 2 says landings carry no price numbers, and no landing prints one in its
body. The brand root's FAQ structured data (`web/index.html`, `shell/marketing/landingHeads.js`)
answers "How much does Windmill cost?" with the real figure, and a search result renders it.
00-README should say whether structured data counts as showing a price.

**0r · `journal/onboarding.md` §2 specifies a first-run placeholder nothing draws** → the owner's call.
§2's copy table gives the placeholder as "How was today?" and §8 asks whether it is too leading.
Both boards and both builds say "Start anywhere. Nothing here is graded." The fix runs one way:
§2's placeholder row takes the built copy, and §8's first bullet goes with it.

**0s · the two app doors carry different reassurance footnotes** → a designer call.
App: "No password. What you make on this device is claimed by your account when you sign in."
Web: "…and some rooms only open once you have an account" (`SignInDialog.jsx` — true on the web,
where the gym log and mirror need an account). Per-surface truth, or one sentence everywhere?

**0t · one product has one home, and the web's IA is now the phones'** → ruled 2026-08-24, built
2026-08-25, the Log head's bodyweight reading with it on 2026-08-26 (`Log.jsx:6` `BodyweightReading`,
`LogScreen.swift:158-161`, `LogScreen.kt:152`); nothing owed.
Every surface draws Routines · The log · Coach (`GymApp.jsx:24`, `GymRoom.swift:39-40`,
`GymRoom.kt:126-130`); the web has no Today, and the live-session mirror heads Routines home
(`Mirror.jsx`) with its charter whole — it never offers a Finish, it says "Not training now." over
"Workouts start on your phone." in words rather than as a greyed control, and it never says
"resting" — pinned by `screens.test.js`. The web's hash grammar was ruled with it: `#/gym` IS the
routines home and `#/gym/routines` an alias that still resolves; the routine editor stays
`#/gym/routines/<id>`; `#/gym/coach` is the Coach root and `#/gym/ask` an alias that resolves to it;
threads are `#/gym/coach/threads` and `#/gym/coach/threads/<id>`; notes are `#/gym/notes`; `home()`
and `landingAfterSignIn()` return `#/gym` (`log.js:28-59`, `:98-112`; `routes.js:21-27`). Drawn on
the Boards page, section "The Coach wave · web".

**0v · the gym app boards disagree with the built routine-first IA** → one redraw pass.
Each line below was ruled for the build and is owed a redraw:

- Screens 5 and 30 draw two routine details; built as one — 30's content (History, Duplicate)
  under 5's chrome (header Edit), with the locked verb **Start workout**.
- Screens 28 and 6 draw the editor with both a header Save and a footer "Save routine"; the editor
  has Save in the header only, and rename lives in the inline name.
- The user-created movement marker is "yours" (screen 7), not "· mine" (screen 30).
- §M's "Follows" row still cites Today; the badge lives on home cards and the detail.
- §I's heading says "Five rows"; six cards are drawn.
- Screen 22 draws a first-run auto-start as a §J exception; nothing runs unless the user started it.
- The "ladder · N steps" target type is drawn with no authoring UI on either board and no shape in
  `RoutineWrite` — design ahead of the wire, not built.

**0w · journal's scales are built; building them corrected five things in the spec** → spec and
canon patched 2026-08-23, nothing owed.
Backend, web and iOS landed. `journal/scales.md` remains the canon home for the control, the 0–10
ramp, the zero-is-a-value rule and the motion ladder; `journal.md` §4/§10 point at it; the
implementation spec is `.claude/scratch/journal-scale-spec.md`. The build gate held: the surge did
not ship without the ground and the hold.

Two were design calls and are ruled:

- **Night's `--journal-head-ring` raised `ink 55%` → `ink 78%`.** §10 claimed a 4.1:1 floor "on both
  sides" in both themes, but §2.4's 4.22/4.32 figures were the **Day** cell; night was never
  measured. The build measured composited pixels and found the next step up (`ink 68%`) at 3.31:1
  against a `mood-0` fill — matching an independent recompute of 3.30, so the method agrees and the
  token was simply too low. `78%` gives **4.25:1 vs fill, 7.75 vs bed, 10.17 vs canvas**. The build
  followed the spec as written and correctly did not move the token on its own. The ring merges with
  a bright fill at the top of the ramp in both themes and that stays intended — the fill separates
  itself at the ceiling, so the ring is optimised for the floor, the only place it is load-bearing.
  **Third occurrence of the one-theme-asserted-across-both error**; `scales.md` §8 now counts it.
- **The flare's phone rings clamped `head + 56px` → `head + 28px`.** At +56 the outer ring reaches
  37pt on a 48pt row pitch and crosses into the ENERGY row, over its track and its surge arcs —
  measured on device; the build reported rather than clamping, which was right. Ruled with a general
  rule rather than a number: **no transient in the strip may paint into the other scale's row**
  (outer radius ≤ `rowPitch/2 − 1px`), because two scales visually merging is the precise failure
  this redesign exists to fix — it attacks ask #1 directly. Transients *may* overflow **upward** into
  the writing field; the motes already do, by design, and that is not a bug. **Desktop's +44px is
  deliberately left alone**: it fails the same arithmetic but has been drawn across eleven boards
  with no reported collision, and correcting it from a calculation would be the same error wearing
  the opposite face. Render desktop, then apply the rule if it crosses.

Three were straight corrections:

- **§6.13's surge node counts were per-beat, not per-fire** — night is 30 nodes (`(5+5+3) × 2
  passes` = 26 polylines) and day 13 (9 polylines), against the stated 14/7. All three beats are
  built up front and torn down together, so the live count is the sum. §6.13 is the defect list a
  build is held to, which makes a 3× undercount the one place in this spec where a wrong number does
  real damage.
- **The glow pair cannot be declared at the root.** Night's value references the head's own fill, so
  on `.journal-root` the reference resolves against an element that has no such property and the
  declaration is dead. They are declared in **head-scoped rules under each theme** as `--glow-rest`
  / `--glow-end` — the build's names, which the spec has adopted so code and spec agree.
- **`--journal-focus` must be a solid hex, never a mix with transparent.** At `ink 88%` the missing
  12% let the head's glow through and the focus ring's contrast started tracking the value — the
  exact independence the two-tone construction exists to guarantee. The spec's own hexes land on
  12.78 / 10.24, invariant at 0/5/10 in both themes. **And paint order is now part of the
  contract**: the glow is the head's `box-shadow` and the focus ring the `::after`, never the
  reverse, or the glow paints over the ring and reintroduces the dependence by another route. A
  build that swaps them passes a colour audit and fails the behaviour.

Also corrected: **§10's §2.5 sweep listed two dead rules.** `.journal-mood-dot.is-on` and
`.journal-energy-bar.is-on` lost their last consumer with the old strip and were deleted, not
converted; only `journal-talk-pulse` was live. And **confirmed, so it stops being re-checked**:
nothing in echoes reads mood or energy — `fixtures.js` needed value migration only.

An **executing review** of the built web strip (composited pixels, CDP input, radial scans at 10×)
then falsified three more sentences, all now patched:

- **"The ring carries legibility at every value"** is false as built. Sampled across the ramp,
  night's ring runs 3.31:1 against the fill at v=0 but **1.21:1 at v=10** (day 4.81 → 1.83), while
  ring-vs-bed climbs 6.04 → 13.65. The *ruling* stands untouched — that trade is the one §2.4 was
  written to make — but the sentence was a universal asserted from one cell. It now reads **the ring
  carries the boundary at the floor, the fill carries it at the ceiling**, and §10's check samples
  the floor instead of asserting across the ramp.
- **The focus ring was specified as additive and built as a replacement, faithfully.** `inset: 0` on
  the pseudo-element resolves to the **padding** box, so both spreads started 1.5px inside the
  head's outer edge — the ink band measured edge +1.00 → +2.88 against a specified +2 → +4, and the
  canvas spacer painted over the head's own ring, erasing it from the composite. Not cosmetic: with
  the ring gone, **§2.4's four monotone axes collapse to fill + size whenever the head is focused**
  — always, for a keyboard user — and at day mood-0 the fill is 1.02:1 against the bed, so the
  inversion §2.4 exists to close comes back under focus. §2.6 now names the box (`border box`) and
  gives the declaration. *"Additive, never a replacement" is not a geometry anyone can implement.*
- **The token contract is tidied to three names.** `--glow-rest` / `--glow-end` are head-scoped per
  theme (the resolution fix); the day surge's `drop-shadow` reads a new root token **`--surge-shadow`
  declared in the day block only**, because night's arc has a halo pass and needs no shadow.
  `--journal-head-glow` / `--journal-head-glow-end` are retired — the second had survived at `:root`
  with one consumer and an unreachable night half, and a token with an unreachable half will be
  miscopied.

Also from the review: the **4ms/frame budget and the sanctioned degradation were both sized against
10 strokes** and have never been re-derived at the corrected 26 — the node counts are measured and
right, the 4ms is not measured and is now marked unverified. And one design call, refused by the
review and ruled here: **dragging through an extreme must not flash its permanent mark.** The state
classes apply on commit and clear only — a mark mid-drag is false about state, and a mark that
blinks on every crossing is a reward per scrub, which is the farming §6.9 device 6 forbids arriving
through another door.

**Confirmed by the same review, so these stop being re-checked:** all 22 ramp hexes byte-exact;
geometry exact at all three measures, pitch 52.2 / 23.0 / 16.3; `--k` measuring 1 / 0.4 / 0 / 0.4 / 1
across the scale; the five-band rule resolving to exactly five hues on pip, week square and year cell
in both themes with the set-zero mark surviving on each; focus ink invariant across values; trigger
discipline unbreakable (no spurious fire from dragging through, re-tapping, theme-flipping,
remounting, resizing or scrolling); and zero leaks under 80 interleaved events with a third
interrupted mid-animation. **Reduced motion — the part flagged as least verified — passed outright**:
the reviewer defeated Chrome's clamp by injecting the media block as a plain stylesheet and stubbing
`matchMedia`, and all six forms play as §6.7 specifies.

**The phone clamp is built and measured, and cost the flare a ring** — outer radius 22.83pt,
clearing the energy row by 3.3pt, so the rule holds exactly. But two rings 120ms apart at 2.5
head-radii fail as a pair — and the *reason* recorded first was wrong, which matters more than the
verdict. Frozen against the desktop pair on the same strip: at 180 and 300ms they are not a merged
halo but **a bullseye** — two crisp concentric edges plus the head's own, three rings of decreasing
radius around a filled dot, a target rather than an opening; only by 450ms do they become the mush
originally described, and there they are *dimmer* than the single ring because each is separately
fading. At rest the two builds are the same pixel to within a few units. So: **at a small radius,
concentric rings read as a bullseye, not as an opening** — a sharper and more transferable reason
than merging, now in `scales.md` §5, with its boundary stated so nobody applies it to the held ring
(it governs gestures that must read as *opening*; a static mark is allowed to look like a target).
Ruled: **the phone drops to a single ring** (`+28px`, 800ms, peak 0.62) — *when the ground shrinks, reduce the count; never crowd
the same count into less room*, which is the identical ruling the Day arc got for the identical
reason. **An upward-biased expansion was proposed and rejected** despite the carve-out permitting
it: opening is radially symmetric, and biasing it upward turns the gesture into *rising*, which is
what the motes already say — the flare would say one thing twice and lose the contrast between its
own parts; and every way of drawing it imports vocabulary the product forbids (ellipse = squash and
stretch, offset circle = detaching). On the phone the motes now lead and the ring supports,
deliberately. Recorded so the second ring is not "restored" later.

**Two more corrections the clamp pass found:**

- **The marks must be absent for the whole duration of a drag, not merely un-triggered by one.**
  Gating on the committed value handles a drag that *crosses* an extreme but not one that **starts
  at** it — iOS shipped a ceiling-sized glow burning under a mid-value fill all the way down from
  10. Every mark now takes `dragging == nil` as a precondition. The ordinary rest glow is *not* a
  mark and correctly does the opposite: it follows the shown value.
- **`strokeBorder` tucked the held ring's band inside the path**, giving 5pt of clearance where 6
  was specified — and `strokeBorder(…).scaleEffect(k)` additionally scales the stroke *width*, so a
  ring that lands by scaling arrives thinner than authored, an offset error that moves during the
  animation rather than sitting still. Four defects on two platforms now, all found by rendering and
  none by reading, so the spec gained **§2.0**: *an offset names the stroke's centreline, measured
  from the border-box outer edge — and you must know which face your number names before choosing an
  API.* Stated as a requirement rather than a prohibition, because `strokeBorder` is wrong for the
  held ring (a centreline clearance) and **right for the flare's rings**, whose clamp is on the
  outer face. It is `scales.md` §8's third rule.

**The drag suppression is now photographed** and comes off the unverified list. A temporary seam
rendered the exact mid-drag state without a touch (added, used, reverted): dragging *into* both ends
shows no ceiling bloom, no held ring, no ground rule, no sheen, and heads keeping their ordinary 6px
glow; dragging *out of* both ends — the case the amended rule was written for — produces a frame
**byte-identical** to the same strip with those values committed, same SHA-256. That is the
strongest available statement of the rule, and it closes the one item flagged as reasoned-but-unseen.

**The web fix pass then produced one decision and one product-wide bug.**

- **The head's ring is pinned to a whole pixel (`--head-ring-w: 1px`).** Blink floors a `1.5px`
  border to a used `1px` while honouring a `1.5px` inset, so the focus band drifted **outward** to
  edge +3→+5 at DSF1 and DSF2 alike. The builder correctly refused to hand-tune the inset to cancel
  one engine's rounding. Ruled: pin the width, because a fractional border makes the focus geometry
  *engine-dependent*, which is worse than being a pixel off in one engine, and the declared and used
  values then agree everywhere — the band lands at exactly +2→+4 (phone +2→+5) with no adjustment.
  Contrast is a property of colour, not width, and the built 1px ring measures 4.95:1 against the
  fill at night. **This is §2.0's family with the sign flipped**: the first four defects tucked the
  band inward, this one honoured one of two numbers that had to agree and rounded the other. §2.0
  gained a fifth row and a second clause — *when two declarations must agree geometrically, express
  both in units the platform cannot round differently.*
- **The held ring goes back to head + 12px, and canon's line is true again.** It had moved to +14 to
  chase the drifted band; pinning the width put the band back where it was specified, so the 1.5px
  clearance holds, `--hold-scale` reverts, and **web and iOS agree once more**. Recorded as its own
  small rule, because the near-miss was permanent divergence between two surfaces over one engine's
  rounding: **fix the cause, not the number that moved because of it.**
- **Both ring contrast figures are correct and neither should be "reconciled".** Canon quotes the
  token flattened over the **canvas** (4.25 night); the build measures the alpha ink composited over
  the **fill** it sits on (4.95). Different questions, both over the 4.1 floor. Noted in §2.4 —
  quote the ground.

**A product-wide reduced-motion bug this feature exposed** (fix owned elsewhere, in `global.css`):
`src/styles/global.css:68` forces `animation-duration: 0.001ms !important` on `*` under
`prefers-reduced-motion`, which collapses every *still* form §6.7 specifies and removes both blooms
on an instant `animationend`. Measured: **completing the pair with reduced motion on spends the
once-a-day key while the layer stays empty from t+20ms to t+1.5s** — a reduced-motion reader loses
the completion moment permanently, which is the same HIGH defect §6.6a just closed arriving by
another door. §6.7 now states that its premise requires a site-wide clamp permitting *finite*
durations rather than nuking them, because the next surface to author a still form will hit the
identical wall. And journal's own half is added as defence in depth: **never spend a once-a-day key
on an animation that did not play** — write it on `animationstart`, treat a computed duration under
50ms as not played.

Everything else ruled here is applied and measured: the press compresses on first touch, the pair
bloom survives a mood-10 completion, marks stay off through a whole drag, night's ring is at 78%,
the retired token names are gone, and the leak attack still returns byte-identical. A commit now
costs 1 layout rather than 15, and the remaining one is the numeral's digit swap — content, not an
animated layout property, so §6.13 holds.

**The pinning wave then measured a sixth offset defect, and it is the held ring being eaten again.**
A CSS `border` draws **inside** its box, so a `head + 12px` box put the 1px stroke at +5.0…+6.0 —
centreline +5.5, not the +6 the chain specifies. Desktop cleared the ink band by 1px instead of 1.5;
on the **phone** the band ended at +5 and the stroke started at +5.0, so they **abutted with no
canvas between them** and the held ring merged into the focus ring at mood 0, focused. Not a
regression from the pinning — the old band sat 1.5px further in and hid it — but it is the second
time that mark has been eaten by that ring, which is the exact failure the +12 ruling was made to
fix. **Both exits taken:**

- **Web declares the held ring as a `head + 13px` box**, which is what "centreline at +6" costs in a
  box model that draws borders inward. **iOS stays at `head + 12px`** with its centred `.stroke`,
  which already sits where the chain expects. The two numbers are one geometry in two stroke models
  and must not be reconciled.
- **The phone's focus band drops from 3px to 2px** (`0 0 0 4px`), matching desktop. The wider band
  was decided before the held ring's geometry existed; at +5 it left 0.5px of canvas, which is not
  separation. One band width is one fact instead of two, and the 1.5px clearance canon promises now
  holds on both breakpoints.

**This produced §2.0's third clause, and it is the one that has cost the most churn:** *canon states
GEOMETRY; a platform states a DECLARATION derived from it; two platforms carrying different numbers
for the same geometry is not drift, and reconciling them breaks one of them.* Last round the
surfaces were nearly left permanently divergent by chasing a declaration that had moved for an
unrelated reason; this round the same pair of numbers *looks* like drift and is not. Write the
geometry first and let every platform number be visibly derived from it, or the next reader cannot
tell a correct difference from a bug — and both mistakes are one edit away.

**Confirmed, not overruled:** the builder extended the ring-width ruling to the hover ghost, which
now reads `--head-ring-w` too. Right call — a preview heavier than the thing it previews is a
preview of something else.

**And `global.css` is fixed**, so §6.7's premise is buildable again: the duration nuke is gone,
iterations and transitions stay bounded, the shared waveforms lost their movement at the token layer
instead, and the pair bloom was verified against the counterfactual (old rule re-injected → empty
layer at every sample; new rule → a 1.02s bloom on screen). The once-a-day key rule works as
specified — clamped, the moment stays **owed** across repeated completions; at full duration it is
spent exactly once, on `animationstart`. The requirement stays written down in §6.7 even though the
bug is closed, because the next surface to author a still form will hit the identical wall.

Still open by construction, not oversight: the pair bloom was never drawn (desktop-only boards);
iOS's Core Haptics ladder cannot be validated without a Taptic Engine; and the one-ring flare is
verified **frozen, not at speed** — its frames are exact for radius and alpha but computed from the
easing curve rather than captured from a live 800ms run on a device.

**1j · journal's calm-ceiling line is surface-blind, and the surfaces really do disagree** → an
owner or journal call, not the scales spec's.
`journal.md` §10 and `scales.md` said "exactly one infinite loop on screen — today's breathing
ember." **There is no ember on web:** `DayMarker.jsx` draws no glyphs at all for today
(`{!isToday && …}`), by its own canon, because today's values live in the strip; the only two
`infinite` rules in `journal.css` are `journal-sharpen` (1047) and `journal-talk-pulse` (1728), both
conditional, and `wm-ember` is the shell's, never journal's. **On iOS the ember is real** —
`DayGlyphs.swift` breathes today's `MoodPip` under a `reduceMotion` gate. Both canon lines are
restated as a *budget* ("at most one infinite loop, and the scale ladder adds none"), which is true
on both surfaces. What is left is the actual divergence underneath: **web draws no day-marker glyphs
for today and iOS draws them, breathing.** That predates this work and is a journal-canvas decision,
so it is filed rather than settled.

**1d · `tree-layout-contract.md` specifies a layout engine that does not exist** → an owner call.
§5.1 pins `RING_GAP = 190` and §5.2 specifies a whole dagre mode with a ~48-node hysteresis
threshold. `RadialLayoutEngine.js` is the only engine in `web/src/products/roadmap/layout/`, it uses
no fixed ring gap (`RING = NODE_SIZE * 2.8`, each ring pushed out until its tightest pair clears
`MIN_ARC = NODE_SIZE * 1.7`), and no dagre appears anywhere in `web/src`. The contract's own Known
gaps section records the mismatch without resolving it. Either the contract becomes radial-only and
§5.1's numbers take the engine's, or the dagre mode is restated as a stated future need rather than
a rendering rule.

**1e · the GL renderer has no available face** → an owner call.
`tree-layout-contract.md` §3 and `SkillNode.jsx` both give available a white body
(`--surface-card`) with a solid 2px kind ring. `scene/NodeBatch.js:177` sets
`float toLit = tier == 0 ? 0.0 : 1.0`, so tiers 1–3 all paint the full base fill and ring colour:
on the GL canvas — which is production — an available node is saturated and differs from complete
only by the halo. Either the shader gains an available face, or the contract and the DOM reference
take the renderer's.

**1f · the gallery grid goes three-up in code and two-up in canon** → fix one toward the other.
`responsive.md` §8, its constants block (`GALLERY`) and the breakpoint table all say one column
below 744 and two-up at ≥744, full stop. `browse/BrowsePage.jsx:199-200` adds a third column at
≥1180. Both keep cards past 320px, so either value is defensible; all three places in the guideline
move together with whichever wins.

**1g · angular reorder is desktop-only in one guideline and touch-capable in another** → one wins.
`mobile.md` §1 rates it P4, "canvas, desktop only", "not on the phone". `angular-reorder.md`'s Touch
section specifies the gesture degrading intact — drag a node around its ring, unavailable below the
hit-disc clamp, exempt from the motion ceilings, standard 4s undo. Either the phone gets the
gesture and `mobile.md` §1 restates P4, or the Touch section goes.

**1h · `front-door.md` §2 names a route that does not exist** → fix toward the code, or build it.
§2 gives My trees as `windmill.works/trees` = the app on your newest tree with the TreeSwitcher
already unfolded. `web/src` has no `/trees` route on either the hash or the path router; the built
button (`RoadmapLanding.jsx:84`) goes to `#/app/{id}` and nothing unfolds the switcher. Either §2
takes the built destination, or the route and the unfolded-switcher arrival are owed a build.

**1i · journal's month pill and month rail are canon with nothing built** → build them, or take
the divider. `journal.md` §4 gives the month a pill that "floats top-right, confirms month + year
when you're deep in the past", and §11 lists a "month rail" among the desktop-web affordances.
`Canvas.jsx:284` renders `MonthDivider` — an in-flow `.journal-month` heading inside the reading
column — and no floating pill or rail exists anywhere in `web/src/products/journal`. Either both
canon lines take the in-flow divider, or the pill and the rail are owed a build (and the rail must
be specified against the reserved echo gutter, since it would share that side).

**1j · the scales spec §8.5 calls a journal cache "a convenience over a server of record"** → fix
toward the code. It is not one on either client: the scoped device store (`wm.journal.v2.pages.u.*`
on web, `windmill-journal-pages-v2-u.*.json` on iOS) is also the only home of `needsPush` writes
that never reached the server, so "bump the version key so every device drops its local copy"
would delete unsent diary pages. Both clients now migrate every v1 store forward onto the 0..10
scales — the unscoped blob, the quarantine and the scoped cache — rather than dropping any of
them. §8.5's sentence and its instruction both need to take that.

**1k · the shell owns the iOS leading edge, and a native NavigationStack wants it too** → proven on
the simulator 2026-08-26, nothing owed. The edge is arbitrated by **depth** and the two gestures
coexist. `Shell.swift:177` attaches the go-home swipe as `.simultaneousGesture(homeSwipe, including:
depth == 0 ? .all : .subviews)`; a room writes its depth outward once, at its root
(`RoomDepthPreference`, `Platform.swift:97`; gym at `GymRoom.swift:139` reports the VISIBLE tab's
path count and zero whenever the stacks are not what is on screen). What the proof found is not what
was predicted: over a `NavigationStack`'s own frame the system's screen-edge pan wins the touch
outright and cancels the shell's drag, so the naive "both fire" outcome never occurs there. The real
hazard is that the stack does not cover the room — the tab bar's band sits outside its frame, and a
leading stroke there at depth 1 never meets the navigation controller's recogniser, so a gesture that
only declines inside its handler still takes that touch and throws the lifter out of a room they were
only stepping back through. That is why it is **unattached** past depth 0; the negative control
(`including: .all`, nothing else changed) fails exactly that case and no other. Pinned by real
touches on iOS 26.3 in `apps/ios/UITests/RoomEdgeGestureUITests.swift`
(`testTheLeadingEdgeBesideTheTabBarDoesNotLeaveTheRoom` is the load-bearing one).
`superapp-shell.md:21-23` and `:164` carry the scope.

**1l · the You seat has no slot in a native tab bar** → built 2026-08-26, nothing owed. Both shell
doors sit in the room's own **top** chrome on both phones: on iOS `CapsuleButton()` at
`.topBarLeading` and `YouSeat()` at `.topBarTrailing` in every stack root's toolbar and in the
logger's (`GymRoom.swift:211-219`, `:260-270`), with the shell laying no capsule over a room that
declares `hostsTopChrome` (`GymModule.swift:11`, `Shell.swift:175`); on Android the avatar is the
top app bar's trailing action, past its own hairline (`ui/GymScreen.kt:194`), and the room has no
shell chrome besides it. A native `TabView` has no non-tab trailing slot and an M3 `NavigationBar`
has none either, which is what moved them. `superapp-shell.md:24-26`, `:57` and `:166` read "the
trailing slot of the room's own bar", and `thumb-reach.md:31-33` is narrowed to what it means: no
primary or destructive action in a top corner — a destination is not an action.

**1m · the reach law is written in absolute pixels on one frame and applied to three** → restate in
units. `thumb-reach.md:12-21` gives the bands as pixels on 402 × 874 (top "→ ~120px", bottom "last
~230px"), while boards are drawn at 393 × 852 and 412 × 915. Carried literally the same numbers give
a 61pt reading lane on iOS and 96dp on Android for one rule. The Coach wave restates it as anatomy:
**the reach band is the 230pt above the bottom safe inset, the top band is safe top + 60**, and 46%
stays the one fraction on the full frame. The compliance frame becomes the **smallest** supported
device, and no frame is called brand-neutral — 402 × 874 is a specific iPhone.

**1n · `superapp-shell.md:160` still gives a room its own dark default** → fix toward `:78-83`.
The constants block reads "APP OWNS … its skin incl. dark default", which contradicts the same file's
rule that Appearance is chosen once for the whole app and a room owns its palette but never the
choice. It is the line gym has been obeying while pinning dark. It becomes "its palette in both
schemes · never the scheme itself."

**1o · the proposal's kept rows are drawn on one surface and dropped on two** → built 2026-08-26,
nothing owed. One shape on all three: changed rows at full weight, and every run of consecutive kept
rows folded **in place** to *and N lines unchanged* (*and 1 line unchanged*), tappable to unfold where
it stands so the document keeps its order — `proposals.js:150-156` (`keptRunLabel`, `collapseKept`),
`Proposal.swift:300-319` (`blocks`, `unchangedLabel`), `Proposal.kt:161` and `:329` (`document`). The
wire still carries every kept row, and the system prompt still tells the model "a line you leave out
is a line you are proposing to remove".

**1q · the server's Coach strings and the three client suites are one contract** → built
2026-08-25, nothing owed; the machine tokens stay.
Every lifter-facing sentence `AskApi.cpp` sends names the room Coach and carries the typographic
apostrophe (`AskApi.cpp:16-81`), pinned whole by `AskApiTest.cpp` and repeated verbatim in the
client suites, because a client never rewrites server text. What does not move: the verdict codes
`ask-thread-taken`, `ask-thread-full`, `ask-session-open`, `ask-daily-limit`, `ask-out-of-budget`,
`ask-not-configured`, the thread turn's wire enum `from: "lifter" | "ask"` (`TrainingJson.cpp:496`)
and the proposal door `ask` — copy may change, tokens may not (`ARCHITECTURE.md:1233`). The CSV
export's `from` column is an export value, `lifter`/`coach` (`PgAskThreadRepository.cpp:224`), not
the JSON enum. The human share is "Share this workout" on every surface (`share/share.js:12`,
`CoachShare.swift:27`, `CoachShare.kt:61`) and the connect pitch contrasts on where the log lives,
not on the room (`connect.js:5-7`, `ConnectedLog.swift:111`).

**1s · `set.rpe` is drawn on the web and enterable on no surface** → ruled and built 2026-08-27 on
all three, nothing owed. **The control was given, not the render deleted.** Every fix sheet now edits
both — RPE 6 to 10 by halves with a way back to no rating at all, and a plain `Set note` field
captioned *A record for you — not an instruction to Coach.* (`FixSheet.jsx:76-120`,
`FixSheet.swift`, `FixSheet.kt`) — and both phones' session rows print them when present
(`SessionScreen.swift:80-82`, `SessionScreen.kt:527`) beside the web's row, which already did. The
two fields are the one place an omission and a clearing must not be confused: an rpe is cleared by
NAMING it null and a note by naming it the empty string, while a field nobody touched is not sent at
all (`fixOf`, `fix.js:97-104`; the server reads exactly that at
`adapters/json/TrainingJson.cpp:117-127`). A set row prints no number the lifter cannot touch.

**1v · a rail may not carry its selected state in colour alone, and on iOS 26 the room does not own
that colour at all** → re-scoped 2026-08-26; Android is built, iOS is the platform's, and what is
left is one token question for the surfaces that still honour a tint.
**Android is closed, measured.** The rail carries selection on four channels, not one:
`GymSkin.ink` `#EDEBF0` selected against `GymSkin.inkFaint` `#8D8896` (**2.91:1**, up from iris's
1.17:1), a filled glyph against an outlined one per seat, a bold label against a normal one, and the
indicator on `lineStrong` `#48444D` over the bar's `#262329` (1.63:1) — `GymRoom.kt:973-998`,
`railIcon` at `:1000-1004`.
**On iOS the question is not answerable by a token.** Sampled on the shipped build (iPhone 17, iOS
26.3), the system tab bar paints both labels itself — `#FFFFFF` selected against `#F6F3FA`
unselected, **1.10:1** — draws its own selection capsule (`#47444A` on `#262328`, 1.62:1), and
ignores `.tint`, `UITabBarAppearance` (standard and scrollEdge) and `unselectedItemTintColor` alike.
The room therefore applies **no** tint to the TabView: a `.tint` there is an environment value that
repaints every control in all three tabs and each sheet they raise, buying nothing (`GymRoom.swift`,
the comment under the TabView). The room's job on that OS is the **symbol**.
**What remains is the ramp.** No pair in `GymSkin` reaches 3:1 while both members keep 4.5:1 against
the bar's own ground — the shipped pair is 2.91:1 — so a surface that does honour a tint has no
passing token to take. Either a brighter selected ink enters the ramp, or 3:1 between two inks stops
being asked of a control the platform paints.

**1w · `glow/set-done` still carries a Daylight value in the Figma collection** → delete it from the
light mode. F5's ruling says a token whose mechanism does not exist in a mode should not be given a
value in that mode, and emitted light does not exist on pietra. `gym.css` declares `--set-done-glow`
in the dark block only (`:26`) and the light dot draws no shadow (`:592-593`); the shared
`Gym · Colour` collection still resolves `#7d8c4366` in Daylight. No board in the Coach wave uses it
in either mode, so nothing depends on it today — which is exactly when to remove it.

**1x · "Apply all N" has no defined unit, and three surfaces could count differently** → pinned
2026-08-26 in the domain and on the wire, nothing owed. A **change** is a row of the document that is
not `kept`, plus one for a renamed routine, plus one for a reorder of the surviving lines; a **line**
is an entry of the routine, so "Apply all 4" and "and 7 lines unchanged" are two true statements about
one eleven-entry document. The count is the domain's `countedChanges` (`domain/Proposal.cpp:140-162`),
travels as `changeCount` on every proposal head, and is pinned by `ProgramApiTest.cpp`
`gym_change_count_is_rows_that_are_not_kept_plus_a_rename_never_fields`: a row moving three fields is
one change, kept rows count nothing and still travel as rows, a rename adds one, and the head and the
whole document carry the same number. No client counts for itself — the band's label reads
`changeCount` (`proposals.js:66-70`, `Proposal.swift:352-355`, `Proposal.kt:235-239`) and so does the
receipt, off the server's apply reply (`proposals.js:178-181`, `Proposal.swift:342-347`,
`Proposal.kt:186-187`). The band's label is the rule on all three: **`Apply all N`** for a revision,
**`Apply`** when N is 1, **`Remove <routine>`** for a removal. One consequence stands as built: a
proposal that only reorders kept rows reads `Apply` over a document whose every row folds into *and N
lines unchanged*; the order shows on unfolding.

**1y · gym's screen titles are Nunito where the brand says Baloo 2 is the display face** → a
designer call, one way or the other. `brand-foundations.md` gives Baloo 2 the display role — "page
headers, big numbers" — and gym honours the second half only: `Gym/Weight` and `Gym/Reps` are Baloo 2
ExtraBold, while `Gym/Title` is **Nunito Bold 22** and every shipped gym board titles with it. So the
room reserves the display face for instruments and sets its prose headings in the body face. That may
be right — a 22pt heading is not a "big number" — but it is currently a divergence nobody decided,
and the Coach wave's boards inherited it. Either `brand-foundations.md` narrows the display role to
numerals inside gym, or gym's titles take Baloo 2.

**1z · one logged set feels like two different things on the two phones** → ruled and built
2026-08-27 on both phones, nothing owed. Each spends ONE vocabulary, one sensation per kind of act:
**light on a swipe that reveals · medium on a save · a closing note on a finish**
(`GymConfirm.swift:19-31`, `GymConfirm.kt:22-42`). A logged set **is** a save and spends the save's
impact rather than a fourth sensation, which is what closes the divergence — a set no longer feels
like a held gesture on one phone and a confirmation on the other. Nothing buzzes on a scroll and
nothing buzzes twice for one act. Only the set confirmation stays gated on `confirmHaptic`, the one
the settings screen names; the other three answer to the system's own haptics switch. The constants
differ by platform and that is native idiom, not drift — `.light`/`.medium` impacts and a `.success`
notification on iOS, `GestureThresholdActivate`/`Confirm`/`GestureEnd` on Android — and where an API
level lacks one the fallback is the nearest sensation it DOES have, never a stronger one, because an
unknown constant is silence.

**2c · the iOS Session board prints `w` where the product prints a numeral** → board fix.
`iOS · Session` (`16:120`) draws `w` in the set-number column for a warmup. `Performed.movements`
always prints a numeral there; the `w` index exists only in the **live logger's** today column, which
is a different surface. Found while cloning that board's session row for the gesture boards, and left
untouched rather than edited, because it is a record of what ships and the fix belongs to whoever owns
that board.

**2d · the proposal footnote on the boards no longer matches any shipped string** → owed a build.
All three codebases ship two sentences — *"Nothing changes until you tap Apply on the diff. Your
logged sets are never part of a proposal."* (`coach.js:77-78`, `Ask.swift:220`, `Ask.kt:79`), pinned by
`coach.test.js:300` and `AskTests.swift:420-421`. The Coach wave boards keep only the second sentence.
**The cut is deliberate and it stands:** the inert-until-you-act promise belongs at the moment of
consequence, and the review sheet already carries it — *"All four or none. Nothing is applied until
you tap."* On a card whose only affordance is **Review**, saying it twice is the stacking the text
budget forbids. So the strings and their tests change; the boards are ahead of the build, not wrong.

**2e · the placeholder rows' `empty · tap to write` meta is drawn on no surface** → ruled 2026-08-26:
**not drawn; the ruling to draw it is withdrawn.** Every build draws the two seeded titles alone, in
faint ink behind a dashed edge (`Notes.jsx:85-87`, `NotesScreen.swift:126-136`,
`NotesScreen.kt:195-210`), and that is the shape: the placeholder rows carry placeholder text and no
meta. A faint title behind a dashed edge beside a live chevron is structure explaining itself, and
the boards follow the build.

**2f · the `W8 · Note editor` boards draw the byte counter at 14% of the bound; canon and every
surface draw it from the last fifth** → fix the board or label it. `10-notes.md` rules the counter
*"appears only in the last fifth, so a short note carries no chrome at all"*, and all three builds
do that — from 400 of 500 bytes (`notes/notes.js:20`, `Notes.swift:56`, `Notes.kt:38`). The four
`W8 · Note editor` boards draw `70 of 500 bytes`, a reading no surface can produce. A wave board
should draw canon — so the counter comes off `W8` and a `W8b · near the bound` twin carries it.

**2g · `Routine.h` says a client never sends `revision`; the wire accepts it and the web sends it** →
fix the comment. `Routine.h:40-44` reads *"It is the STORE's to move; a client reads it and never
sends it"*, while `TrainingJson.cpp:190-198` parses a client-supplied `revision` and the web routine
editor sends one — which is how a stale-write 409 is possible at all. The header comment is the stale
half, and it is the half a reader trusts, because it sits on the type.

**2h · `That is not a number yet.` is the one pinned refusal that does not name a way out** → fix the
brief. `../guidelines/text-budget.md` budgets a refusal at *"≤ 12 words, **and it names the way out**"*.
Five of the six refusals pinned in `gym/briefs/15-the-routine.md` do: *One decimal point only.*,
*Over 500 kg — check the number.*, *Whole reps, 1 to 100.*, *Sets, 1 to 20.* and *A zero target is no
target — clear the field instead.* The sixth states the fault and stops. It is drawn as pinned on
`Web · Target sheet — what the field refuses` rather than rewritten on one surface, because a wave that
pins words exists to stop three surfaces inventing seven of them. The fix belongs in the brief, and it
has to land in one place for all three.

**2i · the refusal strings are the pinned ones, and each file says which band it holds** → built
2026-08-26, nothing owed. Two screens enforce two rep bands and each module now names the other, so
neither can be read as the other again. The **routine target's** band is 1–100 sets 1–20
(`Routine.cpp`): `routines.js:17-20` `ENTRY_SETS_MIN/MAX`, `ENTRY_REPS_MIN/MAX`;
`TargetEntry.setsBand`/`repsBand` (`TargetEntry.swift:22-24`); `TargetEntry.setsBand`/`repsBand`
(`domain/Program.kt:79-80`). The **live logger's** is 1–99: `LOGGER_REPS_MIN/MAX`
(`logger/entry.js:14-15`), `KeypadEntry.repsBand` (`KeypadSheet.swift:36`),
`KeypadEntry.maxLoggedReps` (`KeypadSheet.kt:48`). The pinned bytes are byte-identical across the
three surfaces on both screens, the rack keypad's four included — *One decimal point only.* · *That
is not a number yet.* · *Over 500 kg — check the number.* · *Whole reps, 1 to 99.* — and pinned by a
suite on each surface.

**2j · the picker shows the six and then the whole catalogue** → built 2026-08-26, nothing owed. The
seven-row cap belongs to a **typed** query and to nothing else, on all three surfaces
(`PICKER_MATCHES` `logger/movements.js:6`; `PickerOptions.shown` `MovementPicker.swift:10`;
`PickerOptions.shown` `MovementPicker.kt:62`). An empty query draws six under one head — `The six`,
the same bytes everywhere — and then the catalogue uncapped, under no second head. The six are
ranked from the account's own log over a **fixed** 50-session window, frozen for the life of an open
picker so a claim or a poll landing underneath cannot reshuffle them under a thumb, and topped up in
order from one client-side opener list (`back-squat` · `bench-press` · `deadlift` · `overhead-press`
· `barbell-row` · `chin-up`) so a log-less account still sees six. Never gated on a first session.

**2k · the Coach-wave boards draw a date shape and a row meta the web cannot produce** → fix the
boards. On the `Windmill · Gym` Boards page, the Coach section draws `7 movements · last run Sat 16
August` (nodes `125:276`, `126:55`) and `Sat 16 August · 71 min`, `Thu 14 August · 64 min`,
`Tue 12 August · 58 min` (`128:412`, `128:425`, `128:432`). No formatter in the product makes that
shape: `web/src/products/gym/log.js:116-119` gives `Sat 16 Aug` and `:122-125` gives `16 Aug`, both
with an abbreviated month, and the only full month names live in `coach/threads.js:4-7`, used alone
as a thread heading (`:64`) and never beside a day. `last run` is a string no surface ships either —
the routine row meta is `routineMetaLabel` (`log.js:313-318`), which reads `{n} movements · trained {ago}` and
`agoLabel` produces only `today`, `yesterday` and `{n} days ago`. The same three-date defect was
carried into the wave-two `R2` board and has been corrected there to `built 16 Aug · 5 movements`,
`18 Aug · applied 2 changes from Ask` and `16 Aug · created by you · 5 movements`; the Coach boards
belong to another wave and were not touched. That `R2` line now carries a second drift: the product
says `from Coach` (`proposals.js:47`, `Proposal.swift:51`, `Proposal.kt:57`), and no board may say
Ask.

**2l · the clear-refusal is one moment, and the illegal shape has two ways in** → ruled and built
2026-08-26 on all three surfaces, nothing owed. Nothing cascades anywhere: clearing sets while reps
or weight hold a value is **refused in place** — the keystroke never lands, the field keeps its
value, and the kept value is **selected**, so the next digit replaces the number the lifter was
trying to be rid of instead of appending to it (`routines.js` `withField`, `Routines.jsx`'s
`setSelectionRange`; `RoutineBuilderScreens.swift`'s `selectTheKeptValue`; `RoutineBuilder.kt`'s
`TextRange(0, sets.text.length)`). The words are the pinned *Clear reps and weight first — an open
line names neither.*
**The mirror state takes the opposite sentence, because its way out is the opposite act.** A number
typed onto a line whose sets are already **empty** does land — refusing it would drop what the
lifter just asked for — and the commit is refused instead, with *Name the sets first — an open line
names neither.* (`routines.js:177`, `TargetEntry.swift:79`, `domain/Program.kt:91`). Both are one
refusal per sheet, drawn under the field they belong to, fail-fast: the refused keystroke, then the
line's shape, then the three fields topmost first. `Routine.cpp` still only refuses the shape at the
boundary; the interface now says which half is wrong before it gets there.

**2m · the undo window is 9000 ms on every surface** → ruled 2026-08-25, built, nothing owed.
`SetQueue.swift:48` and `SetQueue.kt:52` declare `undoWindowMs = 9_000`; `fix.js:66` declares
`UNDO_MS = 9000`, with `fix.test.js:171` holding the number. `ARCHITECTURE.md:1233` states the
invariant and it is one, so `13-gestures.md`'s gate — every swipe-to-delete waits on an undo that
already exists — means the same span on all three surfaces. A board that draws a duration draws
9000.
**And it is two spans pinned equal, never one number.** `UNDO_MS` is how long a delete is still the
lifter's; `TOAST_MS` (`useTrainingLog.js:21`) is how long a SAID sentence stands. They are equal on
purpose so the room reads as one span to a lifter, and they are separate on purpose so neither can be
moved by the other: a window retires its own transient when its last clock closes, and never on a
sentence's clock. `screens.test.js:428-433` reads the two declarations separately and asserts
`UNDO_MS` is 9000 and `TOAST_MS` equals it, which is what holds the pin without collapsing the two
into one constant.

**2n · a board's own layer name is a claim, and three of them were false** → check names against
geometry, not against intent. Wave three shipped a reach band named *"266 pt"* that measured **317**,
a logger column named *"156"* that measured **98**, and a note whose word count was taken before the
rows it counts were drawn. Each was written when it was true and left standing when it stopped being.

The general form is worth keeping: **a layer name that states a measurement is canon in the same way
a caption is**, because it is what the next person builds from and nobody re-measures it. If a name
carries a number, either the number is re-derived when the layer changes, or the name should not
carry it.

**2o · a note that dates itself is a change log** → restate, do not annotate. A wave-three budget note
read *"the count above was taken before they were drawn"*, which records history on a surface whose
own rule is that docs hold the current state only. It also truncated mid-word. Rewritten to say what
the budget IS.

**2p · the rack keypad's own words live in code and in no brief** → `16-the-workout.md` takes them.
That brief keeps the keypad at the rack and says its strings are pinned before anything is drawn,
but it enumerates none of them. Two are byte-identical on three surfaces and written down nowhere in
canon: the pad's hint *kg  ·  comma or point both read as a decimal  ·  ± for band-assisted*
(`logger/entry.js` `WEIGHT_HINT`, `KeypadSheet.swift` and `KeypadSheet.kt` `weightHint`) and its
empty-buffer line *Enter a number, or cancel to keep {n}*. The only thing holding the hint's bytes
is one web test that asserts them and names the two phone files in a comment
(`test/products/gym/logger/entry.test.js`); a phone suite asserts its own constant, not the bytes,
so a phone can move it and stay green. `15-the-routine.md` pins the four refusals the pad shares
(with the logger's 1–99 band, `2i`) and both glyph names — `±` → *Flip the sign*, `⌫` → *Delete*;
these two sentences have no owner at all.

**2q · the picker says one sentence for a catalogue that never loaded, and no brief says it** →
the brief takes it, or the sentence is canon by grep. *The catalog didn’t load. It comes back when
you have signal.* ships byte-identical on all three surfaces (`logger/movements.js`,
`MovementPicker.swift`, `MovementPicker.kt`) and appears in no brief. Each surface's own suite
asserts its own copy of the bytes, so the three agree by coincidence of review rather than by canon.
`15-the-routine.md` pins the picker's placeholder, its six and its create door; this is the one state
of that screen whose words nothing written owns — exactly the shape the same brief's closing rule
exists to prevent.

**2r · Android pitches the connected log to a lifter who has already connected it** → the surface
needs the read, or the pitch needs a condition. iOS reads the account's connections once per seat
and suppresses the invitation when there are any (`ConnectedLogState.invites`, `ConnectedLog.swift`;
the one remaining call site, `GymRoom.swift:222`), and the web's settings row prints what is connected
(`settings/GymSettingsSection.jsx`). Android has **no connections read anywhere**: its settings row
is the surface's only connect door, and it draws the pitch, the precondition and *Connect my log*
unconditionally (`ui/SettingsScreen.kt` `ConnectedLogRow` — only
`isSignedIn` gates anything there). A second half of the same gap: `ConnectedLog.head`,
`sundayLabel`, `sundayLine`, `mondayLabel`, `mondayLine` and `truths` (`domain/ConnectedLog.kt`) are
live constants with no Android drawing, kept because `ConnectedLogTests` enforces that vocabulary
across surfaces. Either the surface reads its grants, or the ledger records that Android's door is
deliberately state-blind and those constants are the gate's only reason to exist.

**2s · what ends a withheld window early is one answer on all three surfaces** → built
2026-08-27, nothing owed. `13-gestures.md` rules it and every surface now spends it: leaving a SCREEN
keeps the window, and leaving the ROOM — to the background, to another product, or by the process
dying — abandons what is held. The rows come back, nothing goes on the wire, nothing is said
afterwards, because nothing happened; nothing is written to disk, so a process death abandons on its
own. iOS calls `WithheldWindow.abandon` (`Withheld.swift:190-197`) on backgrounding
(`GymRoom.swift:192`) and when the room goes away (`:207-212`). Android calls
`TrainingStore.abandonWithheld` (`TrainingStore.kt:1333-1339`) on `ON_STOP` (`GymRoom.kt:462`) and
again on the composition's disposal (`:469`), and takes the transient down with it, since an Undo
left standing over an act that was let go would offer a way back to something that never happened.
The web's room clears its clocks and its list at unmount and sends nothing
(`useTrainingLog.js:157-167`). What still leaves the room on purpose is the QUEUE's drain — sets
already logged, on disk, retried — and no delete rides out with it. *Swipe · switch apps · come
back* now costs a row nothing on either phone. **Two things this did not make identical:** a set's
delete is durable on iOS and abandoned on Android (`2y`), and the web's trigger is the room
unmounting rather than the surface leaving the foreground (`3d`).

**2t · Android draws a discard door for a past workout, so no gesture is the only path to one**
→ built 2026-08-27, nothing owed. `13-gestures.md` Law 1: a gesture may never be the
only way to reach an action, and `Discard session` joined the log row's long press on the strength of
the review screen still drawing it. iOS draws it on every past session, unconditionally
(`SessionScreen.swift:153`, the control at `:184-190`), and Android's past-session screen now draws
it too: `SessionScreen` takes `onDiscard` (`SessionScreen.kt:172`) and draws the control under the
share card (`:265-279`). **Three doors, one act, one constant** on that surface. The review screen,
the finish screen's slight-session stance (`FinishScreen.kt:394-411`) and the log row's long press
(`LogScreen.kt:279-340`, its hand-declared accessibility action at `:313-316`) all call
`GymRoom.discard` (`GymRoom.kt:540-545`), which withholds a `Deletion.Session` like every other
delete, and all three print `Finish.discard` (`FinishScreen.kt:56`) rather than their own spelling of
it. The confirmation is gone from all of them: an act with an undo does not get a dialog. The web is
not part of this entry — it draws no gesture at all, so Law 1 was never at stake there; what it does
and does not offer is `3c`.

**2u · a sheet that cannot scroll cannot be finished** → fixed on both phones 2026-08-27; recorded
for the class, not the instance. Both fix sheets laid out content shorter than the viewport, so
nothing scrolled — and with a long set note and the keyboard up, `Save the fix` and `Delete set` sat
under the keyboard with no way to reach them: the two acts the sheet exists for, behind the lifter's
own words. iOS now scrolls and pads by the measured keyboard height (`FixSheet.swift:104`,
`:119-127`); Android scrolls and takes `imePadding` (`FixSheet.kt:90-98`). The class is what earns
the entry: a sheet whose content is SHORTER than its own frame scrolls nowhere, so a raised keyboard
takes the bottom of it away with no way to get it back — and the controls at the bottom of a sheet
are the ones it exists for. **A board drawing a sheet with a text field draws it once with the
keyboard up**, or the defect stays invisible until a device finds it.

**2v · a missing `Top e1RM` draws a bare `—` on all three surfaces** → a designer's line.
`11-bodyweight.md` rules that a missing fact draws nothing — never a dash, never a zero — but it says
it of the bodyweight READING, where the line can simply be absent. The finish and review readout is a
row of exactly three tiles — Duration · Working sets · Top e1RM — and a vanishing tile changes the
row's shape, so all three surfaces print a dash instead (`FinishScreen.swift:49`,
`FinishScreen.kt:77`, `review.js:15-20`, whose own comment states the rule as *no top e1RM is a
dash, never a zero*). One screen away the same wave
ruled the opposite for the same problem — an unrated set draws the words `Not rated` and never a
dash, because a dash is read out as nothing by a screen reader. Either the honesty rule reaches a
stat grid and the tile goes, or the tile says in words what it means.

**2w · two refusals of one shape read differently in one room** → a copy owner's call, product-wide.
The note editor repeats the server's own sentence — `a note runs to 500 bytes` (`Note.cpp:85`, pinned
by `NoteTest.cpp:118-119` and `NotesApiTest.cpp:110`), a lowercase fragment, because the server's
error bodies are fragments and a client never rewrites server text. The fix sheet draws its own —
`A set note runs to 4000 bytes.` (`fix.js:58-60`, `FixSheet.swift:22`, `domain/Training.kt:555`),
sentence-cased with a full stop, because the server's refusal there is the bare `note too long`
(`Training.cpp:197`) and no lifter should read that. Each is right for its layer and a lifter meets
both in one room. Worth deciding once rather than inside a build wave: either the server's set-note
refusal becomes a sentence a client can echo, or the two shapes are recorded as deliberate and the
rule says which layer takes which.

**2x · five sentences a build minted, and no brief owns one of them** → a brief takes them, or they
are canon by grep. The gesture wave pinned words for five states nothing written covers, byte-identical
on every surface that has the state:
- **over the set-note bound** — `A set note runs to 4000 bytes.` (`fix.js:60`, `FixSheet.swift:22`,
  `domain/Training.kt:555`), the shape the notes bound already ships one screen away — see `2w`.
- **the unrated seat** — `Not rated`, as the label itself and never a bare `—` (`fix.js:19`,
  `FixSheet.swift:19`, `domain/Training.kt:544`). Its SHAPE diverges by platform and that is native
  idiom: a seat among the others on the web and Android, a clearing control on iOS that appears only
  once a rating is set, so an unrated iOS set draws nothing at all.
- **a second walk over a pending deviation** — `{Movement} first — that question is still open.`
  (`LiveSession.swift:81`, `domain/LiveSession.kt:80`); the phones alone, the web has no logger.
- **the conversation delete's detail** — `a change you applied stays in the routine’s history`, said
  at the moment of the act on both phones (`Withheld.swift:22`, `store/WithheldDelete.kt:53`) while
  the web still draws it as a standing caption inside the conversation (`coach/threads.js:76-78`).
- **the count** — `2 deleted.` while everything held is a delete, `2 to take back.` the moment a
  logged set is among them (`Withheld.swift:36-40`, `store/WithheldDelete.kt:99-107`). The web says
  only the first, because nothing appends into its window (`withheld.js:49-53`).
`13-gestures.md` owns the transient's structure — one held thing names what left, two or more can
only be counted — and none of these bytes. Each surface's own suite asserts its own copy, so the
three agree by review rather than by canon, which is the shape `15-the-routine.md`'s closing rule
exists to prevent.

**2y · a set's delete survives app death on one phone and is let go on the other** → a deliberate
divergence, and the follow-up that ends it is named. `2s` made the abandon one rule everywhere, and
the one thing it could not make identical is where a set's delete is HELD. **iOS holds it on disk.**
`SetQueue` is an atomic file (`SetQueue.swift`), a delete is an entry in it with its own held-until
instant (`:280-283`, `Entry.heldUntilMs` at `:30-31`, `isHeld(at:)` at `:41`), and
`Withheld.Kind.isHeldOnDisk` (`Withheld.swift:57`) is what excuses a set from `abandon`'s restore
(`:196`) — the queue is not reached into, so the delete outlives the process and retries. **Android
holds it in memory.** A set's delete is a `Deletion.Set` in the store's own list like every other
verb (`store/WithheldDelete.kt:34-40`), the send is a direct `deleteSet` call
(`TrainingStore.kt:1362`), and Android's `SetQueue.kt` carries appends and fixes and has no
delete verb at all. So the exemption made it strictly WORSE off than the deletes that abandon: those
put the row back honestly, that one fired into a backgrounded app, timed out with nobody to read the
answer and was dropped whichever way it went. Android therefore abandons a set's delete with
everything else — one rule for the whole window on that surface, no silent loss
(`TrainingStore.kt:1316-1339`, called from `GymRoom.kt:462` and `:469`). Nothing in the window's own
data carves the exception out any more: `WithheldDelete` carries a deletion, an instant and `sent`,
and nothing else (`store/WithheldDelete.kt:68-75`); the no-argument `settleWithheld()` that served
the exemption is gone from the store, which now exposes one settle, keyed by subject
(`TrainingStore.kt:1345`).
**What each phone does today, plainly:** iOS retries a set's delete across app death; Android
abandons it, and the row comes back. Neither is wrong for its own machinery, and the divergence is
not native idiom — it is one of them holding a fact on disk and the other not.
**What would make them one:** Android's set delete rides `SetQueue` as iOS's does, at which point the
on-disk exemption is true on both and both phones keep the delete. That is the follow-up this entry
is waiting on.

**2z · a per-row gesture state that outlives the row's absence replays the act nobody made** →
fixed on Android 2026-08-27; recorded for the CLASS, not the instance.
`rememberSwipeToDismissBoxState` is a `rememberSaveable`, and a `LazyColumn` keeps what an item held
under that item's own key and hands it straight back when the key returns. The withheld window is
what made that load-bearing: a deleted row LEAVES its list and comes back — put back by a log that
refused the settle, or taken back by an Undo — and it came back already at `EndToStart`, drawn off
its own leading edge, so the settle effect spent the act again on a stroke nobody made. A refused
delete re-fired on its own clock every nine seconds for as long as the screen stood; an Undo
re-deleted what it had just taken back, which is the way back the whole pattern exists to provide.
The row could not be swiped again either — a state already sitting at `EndToStart` cannot travel
there. Fixed by one shared builder, `rememberRowDismiss` in `ui/RowSwipe.kt:45-64`, which constructs
the state with `remember` and never the saver: a returning row is a NEW row, settled, with its own
anchors. Every row in the room that a stroke destroys takes its state from it — the set row
(`SessionScreen.kt:432`), the routine row (`RoutinesScreen.kt:261`), the thread row
(`ThreadsScreen.kt:170`), the refusal banner (`RefusalBanner.kt:54`) and the assembly sheet's row
(`AssemblySheet.kt:230`) — and `RowDeleteGround`, the one Delete lane behind them, lives in the same
file (`:69-81`). **The class is what earns the entry: any per-row gesture state that outlives the
row's absence will replay its value the moment the row returns.** A row that can come back needs its
gesture state built, not restored.

**3a · a room that clears a refusal before saying it cancels its own sentence** → fixed on Android
2026-08-27; recorded for the CLASS. The one thing the room says about a settle is a failure — the
window closed, the log was asked and it said no — and it said nothing at all. The effect keyed on
`store.deleteRefused` cleared the flag first and showed the snackbar second; clearing it changed the
key the effect was running under, and an effect that changes its own key cancels itself, so the
sentence was never said and a delete the log REFUSED looked exactly like one that worked. The order
is now said-then-cleared (`GymRoom.kt:426-437`), which also means a room torn down mid-sentence still
owes it. **The class: in a keyed effect, the state the key reads is cleared AFTER the work, never
before** — and the tell is that nothing appears rather than that something crashes, so no suite
catches it unless it asserts the sentence itself.

**3b · a refusal the log answers with words names neither what was refused nor that it is still
there** → a designer's line. When a withheld delete's clock closes and the log says no, Android says
the log's own sentence and nothing else: `WriteFailure.line(subject)`
(`TrainingStore.kt:1769-1772`) returns `said` for a `Refused` and reads its `subject` only in the
`NoAnswer` branch. The subject exists and is written for exactly this — `Deletion.stillThere`
(`store/WithheldDelete.kt:39, 45, 54, 60`) spells *that set is still on the log*, *{name} is still in
your program*, *that conversation is still here*, *that session is still on the log* — and a refused
delete throws all four away. So a lifter who has just watched a row vanish reads only the log's
fragment: something did not go through, with no name and no promise that the thing is coming back.
The rule underneath is `2w`'s and P3's — a client never rewrites server text — so this is not a
builder's fix: it wants a shape that carries the server's sentence AND names the subject, decided
once for the room rather than invented at the call site.

**3c · the web offers no way to discard an ordinary past workout** → a product decision, not a Law 1
breach. `2t` is about a gesture being the only path; the web has no gesture, and here it has no path
at all. `FinishScreen` draws `ShortSession` — the only `Discard session` control on the surface —
under `review.slight` alone (`Finish.jsx:96`, the control at `:132-141`), so a normal workout's
review screen offers Session detail and Done and nothing else, and the log's session row carries no
control but its own link (`Log.jsx:145`). Both phones reach the act from three doors. Either
the web's session review gains the door the phones draw, or the ledger records that discarding is a
phone act on purpose — which would be a defensible reading of `01-context.md`'s split, and is not
what any brief says today.

**3d · the web abandons on unmount, and a hidden tab is not an unmount** → a decision, not a defect
found. `2s` closed the abandon on all three surfaces, and the web's trigger is narrower than the
phones' by construction: the effect fires when the room's hook unmounts — leaving gym for another
product, or closing the page — and the file says exactly that
(`useTrainingLog.js:157-167`). A backgrounded browser TAB unmounts nothing, and
`visibilitychange` is watched only for the mirror poll and the start watch
(`:311-312`, `:337-338`), never for the window, so the clocks run on in a hidden tab, a settle fires
and the delete goes. *Swipe · switch tab · come back* therefore still spends a row on the web, which
is the shape `13-gestures.md`'s foreground rule exists to close on the phones. It may be the right
answer — a hidden tab is not a backgrounded app, the page is still alive and the lifter did not leave
the room — but nothing written says so, and the brief's rule is worded for a surface that has a
foreground. Either the web watches `visibilitychange` for the window as well, or the rule names the
web's trigger as the room's unmount on purpose.
