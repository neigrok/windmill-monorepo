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

**F4 · `gym.css:132`'s "3.4:1" does not reproduce at any ground** → re-measure.
Recomputed for `--pr-ink`: 3.19 on the tinted record card, 2.83 on the tinted canvas, 3.73
untinted. The companion "3.6 on the family cream" matches the untinted cream (3.69), so the
original measurement was taken against the wrong ground and its conclusion needs re-checking.

**F5 · gym's Daylight skin has no producer** → decide: build it or delete it.
`routes.js` pins `scope: { theme: 'dark' }` and `GymApp.jsx` hardcodes `data-theme="dark"`, so
`.gym-root[data-theme="light"]` (`gym.css:107-145`) never renders. Its own comment leaves a known
contrast miss standing because of it.

**F6 · `--focus-ring` is terracotta inside gym** → re-point in the gym palette block.
`shadows.css` dark sets `--focus-ring: 0 0 0 4px rgba(208,138,94,0.4)` — accent-terracotta-400 —
and neither the gym block in `palettes.css` nor `gym.css` re-points it. journal does. Latent today.

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

**0t · web's mirror home is Today; mobile has no Today** → a designer call.
On the phones, home is the routine list and the tabs are Routines · The log · Ask. Web keeps Today
as the mirror charter — the desk drawing the phone's open workout (§11.2) — and keeps Ask as a room
off Today. Either that difference is the product speaking and the boards should say so, or web's IA
converges on Routines-home. Direction of fix: the gym web board, with §11.

**0u · Ask is a tab the boards never drew as one** → a design ask.
The app board seats Ask third on every rail, but its tab-root form is undrawn — screens 26/27/33
still show a back chevron and no rail — and the programs board's §L still says "Not a fourth tab"
and "Reached from Today's bottom band". The build ships the rail in place of the back bar, the
threads door kept in the header, plus two stances a tab needs: signed-out — "Ask reads your log, so
it needs you signed in." with Sign in → You — and deployment-absent — "Ask isn't available on this
Windmill." Both strings are the build's own authorship, pinned in tests, and need a copy owner's
blessing or replacement. Direction of fix: §L redrawn with the tab-root form and the two stances.

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

**0w · journal's mood and energy scales are canon but unbuilt** → build them.
`journal/scales.md` is the canon home for the control, the 0–10 ramp, the zero-is-a-value rule and
the motion ladder; `journal.md` §4 and §10 point at it. The implementation spec is
`.claude/scratch/journal-scale-spec.md`. Build gate, from `scales.md` §6: never build the surge
(energy 10) without the ground (energy 0) and the hold (mood 0).

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
