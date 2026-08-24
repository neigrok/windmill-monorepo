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

**F4 · `gym.css:67`'s "3.4:1" does not reproduce at any ground** → re-measure.
Recomputed for `--pr-ink`: 3.19 on the tinted record card, 2.83 on the tinted canvas, 3.73
untinted. The companion "3.6 on the family cream" matches the untinted cream (3.69), so the
original measurement was taken against the wrong ground and its conclusion needs re-checking.

**F5 · gym's Daylight skin has no producer** → **ruled 2026-08-24: build it**, owed a build.
`routes.js` pins `theme: 'dark'` and `GymApp.jsx` hardcodes `data-theme="dark"`, so the light block
in `gym.css` has never rendered. The Coach wave rules that gym stops being dark-only, because a room
that ignores the system Appearance is not native and `superapp-shell.md:80-83` already says a room
owns its palette and never the choice. Three things the ruling found and that the build owes:
fourteen of the light declarations are byte-identical aliases onto tokens that already flip per
theme, so only four are real light decisions; `--set-done-glow` is **deleted** in light rather than
dimmed, because a token whose mechanism does not exist in a mode should not carry a value in it; and
`--pr-ink` must be re-measured first — see F4, which says its stated 3.4:1 reproduces at no ground.
Android takes a staged version: its skin is a compile-time object read at ~560 sites,
`LocalWindmillDark` has no producer, and the platform has no Appearance control at all.

**F6 · `--focus-ring` is terracotta inside gym** → re-point in the gym palette block, **both skins**.
`shadows.css:14` (light) sets `0 0 0 4px var(--accent-terracotta-100)` and `:23` (dark) sets
`0 0 0 4px rgba(208,138,94,0.4)`; `palettes.css:190` re-points it only for journal, and neither the
gym block (`palettes.css:199-206`) nor `gym.css` touches it. Gym's brand is iris. **It stops being
latent in the Coach wave**: it is latent only because every design-system component that reads the
token — `Button.jsx:60`, `Input.jsx:17`, `IconButton.jsx:34` — is barely used in gym today, and the
wave rules those replace the hand-rolled twins. After that every focused control rings terracotta on
pietra beside iris — a second accent that appears only on focus.

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

**0t · web's mirror home is Today; mobile has no Today** → **ruled 2026-08-24: web converges**,
owed a build. One product does not get two homes. Web's tabs become Routines · The log · Coach,
matching the phones; Today is deleted as a tab; the live-session mirror moves to the head of
Routines home, which is already the surface that says whether anything is running. The mirror keeps
its charter whole — it never offers a Finish, it says "Not training now." over "Workouts start on
your phone." in words rather than as a greyed control, and it never says "resting". The Log's head
carries the bodyweight reading line instead, because two heads on one screen is the crowding this
ruling avoids. Drawn on the Boards page, section "The Coach wave · web".

**0u · Ask is a tab the boards never drew as one** → **superseded by the Coach wave**, owed a
build. Ask is renamed **Coach** and its tab-root form is drawn on all three surface pages. The two
build-authored stances — signed-out and deployment-absent — are drawn but still **not blessed**:
they remain the build's own authorship, pinned in tests, and this wave did not adopt them. They
need a copy owner. Note the same wave found the server sends four strings saying "Ask" verbatim to
all three clients (`AskApi.cpp:33-38`); a client must never rewrite server text, so those change
too and are unassigned.

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

**1k · the shell owns the iOS leading edge, and a native NavigationStack wants it too** → a shell
change, prototyped before the boards ship. `Shell.swift:167-185` attaches the go-home swipe to the
leading 20pt as a `.simultaneousGesture` — the modifier whose meaning is *do not require
exclusivity* — and its own comment at `:148` says a hidden navigation bar is what disables the
system pop. Every `NavigationStack` in the app today lives inside a sheet, outside that subtree, so
the two gestures have never met. The Coach wave rules the edge is arbitrated by **depth**: the shell
applies its home swipe only at stack depth 0, and one push deep the edge is the room's back. That
scopes `superapp-shell.md:21` and `:155` ("two gestures, and nothing else") rather than deleting
them, and §2.3/§5/§10 take the amendment. Until it is proven on a simulator, every iOS board in the
wave rests on an untested assumption.

**1l · the You seat has no slot in a native tab bar** → canon amendment, owed a build.
`superapp-shell.md:22-23` and `:157` put the You seat "last in every app's own bar, past a
hairline", and both phones do exactly that (`GymRoom.swift:240`, `GymRoom.kt:711`). At the iOS 17
floor a native `TabView` has no non-tab trailing slot and an M3 `NavigationBar` has none either, so
the Coach wave moves both shell seats into the room's own **top** chrome — capsule leading, You
trailing, on each stack root; on Android the avatar is the top app bar's single action slot. The
canon line becomes "the trailing slot of the room's own top bar", and `thumb-reach.md:31` narrows to
what it means: no primary or destructive action in a top corner — a destination is not an action.

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

**1o · the proposal's kept rows are drawn on one surface and dropped on two** → one shape, owed a
build. Web renders them (`proposals.js:180-183`, whose header states why: "The change rows ARE the
document as well as the diff"); iOS drops them (`ProposalScreen.swift:114-115`, `case .kept:
EmptyView()`) and so does Android (`Proposal.kt:151`). The wire carries them deliberately, and the
system prompt tells the model "a line you leave out is a line you are proposing to remove". The
Coach wave rules one shape everywhere: changed rows at full weight, **kept rows as a collapsed
count** — "and 7 lines unchanged" — tappable to expand.

**1p · `AnthropicAsk.cpp:29-30` tells the model it can read the gym's settings** → already false,
fix now. `get_preferences` was retired and nothing replaced it (`GymTools.cpp:440-444`), so the
prompt promises a read that cannot happen. The Coach wave's Notes feature makes the line actively
misleading, since the distinction it ships is precisely that Coach reads notes and **not** settings.

**1q · four server strings say "Ask" to all three clients** → owed a build, unassigned.
`AskApi.cpp:33-38` sends "this conversation is as long as Ask holds", "Ask reads a log that has
stopped moving", "that's Ask for now" and "Ask isn't available right now" verbatim. A client must
never rewrite server text, so the rename reaches them. Related copy in the same sweep:
`ConnectedLog.swift:114` ("Not a coach in a chat tab") would have gym insulting its own room and is
rewritten to contrast on scope rather than quality; `ConnectedLog.swift:151` and four
marketing/head strings (`landingHead.js:7`, `:26`, `:35`, `GymLanding.jsx:368`) carry the old share
name into the search index.

**1r · the thread cap is four questions and the copy says eight** → fix the copy.
`ask.js:66-70` computes `answered * 2 + 1 > MAX_TURNS` against a ceiling of 8 turns, so a lifter gets
**four** questions. Every surface that states the ceiling should say four.

**1s · `set.rpe` is drawn on every surface and enterable on none** → give it a control or delete
the render. `Log.jsx:281` prints it, `FixSheet.jsx:44-64` edits weight, reps and kind only, the wire
already accepts it, and the prompt forbids the model estimating one. The Coach wave adds a set-note
field to the fix sheet and rules the same must happen for RPE, or the render goes: a set row never
prints a number the lifter cannot touch on any surface.

**1t · three hardcoded black shadows in `gym.css` are tuned for basalt** → move them to the per-skin
tokens. `gym.css:596` (`0 14px 34px rgba(0,0,0,0.55)`, the toast), `:652`
(`0 -18px 40px rgba(0,0,0,0.55)`, the sheet) and `:1490` (`0 12px 30px rgba(0,0,0,0.45)`, a dragging
routine entry). On pietra (`--surface-canvas: #EBE7E3`) a 55%-black drop reads as soot. `shadows.css`
already carries per-skin `--shadow-lg` and `--shadow-md`. Once the gym room takes the design system's
`Toast` and `Dialog` the first two inherit the right shadow for free; `:1490` needs a hand. Latent
until Daylight renders — see F5.
