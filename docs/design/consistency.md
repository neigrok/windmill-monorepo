# Consistency ledger — one project, four products

The satellites were merged in (2026-07-31) precisely so cross-product drift becomes
visible and fixable in one place. Each entry states what diverged, the exact values, and
the direction the fix flows. Delete an entry when its fix lands (it moves to **Closed**
below, with what landed); add one whenever a product copy and the root disagree.

**Standing rule — outdated information is a defect, not a footnote.** We do not tolerate
misinformation anywhere in this project. A sentence that has stopped being true is worse
than no sentence at all, because someone will build from it in good faith: canon is read
*before* work starts, which is exactly when a stale line does its damage. So when a
decision, a rename, or a shipped surface makes a line false — here, in a guideline, in a
brief, or on a board — that line is corrected or deleted **in the same wave that made it
false**, proactively, without waiting to be asked. It is never left standing with a
correction pinned beside it, and "it's only the old copy" is not a reason to keep it. An
entry below is the record of a disagreement being actively closed; it is not a permanent
home for something we already know to be wrong.

## Open

<!-- Entries F1-F12 filed 2026-08-22 while rebuilding journal, gym and the component
     library in Figma from the shipped stylesheets. Every value below was read from source
     or recomputed; nothing was changed in the code. -->

### F1 · journal's night canvas paints the FAMILY WARM ramp, not its own cool dusk ramp        → fix toward palettes.css

`colors.css:168` is a **bare** `[data-theme="dark"]` selector, not `:root[data-theme="dark"]`.
`JournalApp.jsx:82-84` stamps `data-theme` on `.journal-root` **without** `data-brand` (that lives
on `.wm-shell`, `Shell.jsx:109`). A directly-matching declaration beats an inherited one, so inside
the journal canvas that block overwrites the cool dusk ramp `palettes.css:193` hands the shell.

| Token | Canon (dusk, cool) | **Actually painted** (family warm) |
|---|---|---|
| `--text-primary`   | `#E3ECEF` | **`#F4EEDF`** |
| `--text-secondary` | `#7E94A1` | **`#AE9A75`** |
| `--text-tertiary`  | `#4D6472` | **`#8A785A`** |
| `--border-subtle`  | `#1C2932` | **`#2E2618`** |
| `--border-default` | `#26343E` | **`#3C3223`** |
| `--border-strong`  | `#32444F` | **`#574A35`** |
| `--journal-gap`    | `#26343E` | **`#3C3223`** |

So at night the margin panel's left rule, the One sheet's top rule, every distance and fine-print
line, the trail label and the unlit energy ticks are warm brown-cream on a cool blue-black ground.
DAY is not symmetric — there is no bare `[data-theme="light"]` block, so day inherits journal's cool
ramp correctly. Two fixes are available: add `data-brand="journal"` to `.journal-root`, or narrow
`colors.css:168` to `:root[data-theme="dark"]`. **gym escapes this** — `GymApp.jsx:65,72` stamps
both attributes on the same element.

### F2 · journal.css:78 states the opposite of what the cascade does        → correct or delete

> "Nothing here fires in night, where the dusk ramp's own ink is the right one."

False, per F1. The line is read before work starts, which is when it is most expensive.

### F3 · journal.css cites contrast against `#FBF6EA`, a ground the same comment says was removed        → delete the claim

The day block's comment measures the re-pointed lamp steps "on `#FBF6EA`" — the old warm parchment.
The shipped day ground is `--surface-canvas` = `--neutral-50` = **`#F7F7F5`**. The numbers are
against a paper that no longer exists.

### F4 · gym.css:132's "3.4:1" does not reproduce at any ground        → re-measure

The comment says `--pr-ink` measures 3.4:1 on the tinted record card. Recomputed: **3.19** tinted
card, **2.83** tinted canvas, **3.73** untinted. The companion "3.6 on the family cream" figure
matches the *untinted* cream (3.69) — suggesting the original measurement was taken against the
wrong ground, and the conclusion drawn from it should be re-checked rather than inherited.

### F5 · gym's Daylight skin has no producer        → decide: build it or delete it

`routes.js:94` pins `scope: { theme: 'dark' }` and `GymApp.jsx:65,72` hardcode `data-theme="dark"`.
`.gym-root[data-theme="light"]` (gym.css:107-145) therefore never renders. Its own comment admits
this and leaves a known contrast miss standing because of it; three further misses are undocumented.
An unreachable skin that is still maintained is a standing invitation to measure against it.

### F6 · `--focus-ring` is terracotta inside gym        → re-point in the gym palette block

`shadows.css` dark sets `--focus-ring: 0 0 0 4px rgba(208,138,94,0.4)` — accent-terracotta-400 —
and neither `palettes.css`'s gym block nor `gym.css` re-points it. journal *does* (`palettes.css:224`).
A gym element consuming it would wear roadmap's ember. Latent rather than visible today.

### F7 · gym asks JetBrains Mono 700/800 at eleven sites; only 400/500/600 are loaded        → load the faces or restyle

`fonts.js:36-39` loads three weights. Eleven gym rules ask for 700 or 800 on `--font-mono`, so the
browser synthesises them. Faux-bold is not the same shape as the real face, and nothing in the file
says the shipped weight is synthetic.

### F8 · gym's big numeral tokens are declared, described as live, and read by nothing        → delete or use

`--weight-size: 104px`, `--weight-leading: 92px` and `--reps-size: 54px` are declared in both skin
blocks, and the comment above them describes the treatment as the product's loudest pixel. No rule
in the repo reads any of the three. The largest numeral that ships is `.gym-fix-kg` at **72px**.

### F9 · Avatar and Switch hardcode `#fff` rather than reading a token        → tokenize

`components/core/Avatar.jsx` sets `color: '#fff'` for the initials; `components/forms/Switch.jsx`
sets the knob `background: '#fff'`. They are the only un-tokenized colours in the component library,
and in a dark theme a hardcoded white knob is a decision nobody wrote down.

### F10 · `marketing/gymLanding.css` is a hand-copy of the product token block, and has drifted        → fix toward gym.css

Lines 14-33 restate gym's tokens. Its `--alarm-ink` is brick-400 where the product's is brick-300.
A copy that drifts is the argument for not copying.

### F11 · global `a:hover` outranks six gym anchor classes; one lands at 1.34:1        → fix toward the code

`global.css`'s `a:hover` is (0,1,1); `.gym-routine-name`, `.gym-last-name`, the history lines and
inactive tabs are (0,1,0), so all of them repaint to `#BFB8D2` on hover. Worst case: `Build a
routine`'s label does it **on top of its own iris-300 fill**, ≈**1.34:1**. This is the one entry
here that is an accessibility defect rather than a drift.

### F12 · `palettes.css` mixes colour spaces inside its own hue comments        → state the space

"sky 200° / plum 315°" are HSL; "65° from sky" is OKLCH-only; "iris ~265°" matches neither
(HSL 252, OKLCH 291). A hue angle without its space is not a measurement.

<!-- Entries F13-F27 filed 2026-08-23, the second half of the same sweep: rebuilding
     roadmap and the marketing surfaces in Figma from the shipped stylesheets. Every value
     below was read from source or recomputed; nothing was changed in the code. -->

### F13 · the tree canvas can never go dark        → an OWNER call: pick a side, then make both halves agree

`theme.js:68` sets `BACKGROUND.canvas = '#F9F5EB'` and `scene/SkillTreeScene.js:69` clears the GL
buffer to it opaquely **every frame**. `.st-root` (`skilltree.css:7-9`) reads `--surface-canvas`,
which is `#1C1712` in dark. Appearance defaults to `'system'` (`shell/appearance.js:19`), so every
dark-OS visitor gets a **cream canvas inside dark chrome** right now. Against that cream, `.st-brand`
flattens to `#403A32` and the loading veil to `#7F7B74`.

This is not a small mismatch — it decides whether roadmap has a dark mode at all. Either the scene
learns the theme (and the six kinds need a dark set the GL can read), or dark is dropped for this
room and the chrome stops claiming it. Until then the Figma file draws **Day as the hero** and says
so on the boards, because Day is the only face that is coherent end to end.

### F14 · `theme.js` says it matches the design system 1:1; in dark it does not        → correct the comment, then decide the values

`theme.js:1-4` states the GPU look matches the tokens "1:1". `colors.css:220-243` bumps every
`--kind-*` to the **400** step in dark; `theme.js:16-23` freezes the **500s**. So `SkillNode.jsx`
and `HomeCard.jsx` (CSS vars) use the dark hues while the list workbench, the plaque, `NextUp`,
`KindLegend`, `StepPanel`, `Minimap` and the whole GL scene (all reading `theme.js`) use the light
ones. Measured on the ember card: a ready fruit's ring lands at **2.84:1**.

The comment is the cheap half of the fix and should go first. The values are the real question and
they are downstream of F13.

### F15 · two documents say a complete node breathes; the shader says it does not        → delete both claims

`theme.js:14` and `products/roadmap/ARCHITECTURE.md:98-99` both describe complete as wearing
"a breathing halo". `scene/NodeBatch.js:224` reads `HALO_STEADY; // no oscillation`. Only the
crowned root breathes (`NodeBatch.js:7,286-289`). Two docs against one code line, and the code is
what ships — so the docs are the defect. The DOM specimen does still animate `wm-pulse-node` when
`pulse` is passed, which is presumably where the sentence came from; that is opt-in and is not the
scene.

### F16 · `TreeSwitcher.jsx` invents a third kind palette        → fold into the two that already exist

`TreeSwitcher.jsx:25-32` maps kinds itself rather than reading `NODE_COLORS`: `brick` becomes
`var(--color-danger)` (which drifts in dark, since the semantic token moves and the kind does not)
and `plum` is a bare `#8D4F83` literal. Roadmap now has three sources of kind colour where two was
already one too many.

### F17 · the share export wears the FAMILY night, not roadmap's room        → fix toward the room

`share/palette.js:48-52` builds its dark palette from the family neutrals rather than roadmap's
ember ramp — while the file's own header claims exports "can never drift" from the app. A shared
tree therefore looks like a different product than the one it was made in.

### F18 · one connect-ring literal is not the gold token        → replace with the token

`skilltree.css:575` uses `rgba(212,160,60,.5)` for the cost ring's glow. `--kind-gold-glow` is
`rgba(196,151,47,.5)`. The two rings beside it — valid and invalid — do use their exact tokens, so
this is a single stray literal, not a deliberate exception.

### F19 · dark's inverted surface leaves two chrome elements unreadable        → re-point both

Dark flips `--surface-inverse` to `#F1E9D8` (a light value, correctly, since it inverts). Two
elements still put light ink on it: `.st-toast-undo` lands at **1.69:1** and
`.st-ticker-item .st-event-obj` — hardcoded `#fff` — at **1.21:1**. Both are effectively invisible
in dark today.

### F20 · four roadmap class names have no CSS anywhere        → delete them or write them

`.st-list-bud`, `.st-list-jump-chip`, `.st-switcher` and `.st-action-lane` are applied in JSX and
match no rule in any stylesheet. `.st-switcher` is the interesting one: the switcher sheet works
only because it also carries `.st-list-picker`, so the extra class reads like an intent that was
never finished.

Related, same family: `skilltree.css:1` still calls the root "full-viewport", which stopped being
true when `chrome.css:113` added `contain: layout paint`; and `list.css:68-72` credits CSS with the
6px minimum bar width that actually lives in `ListView.jsx:629`.

### F21 · `/roadmap` never passes `brand`, so roadmap's own brand block never matches        → one prop

The landing renders without a `brand` prop, so `[data-brand="roadmap"]` never applies. That makes
both `landing.css:11-12` and `palettes.css:16-19` false as written — they describe a hue swap that
does not happen. The page looks right only because the family default is already terracotta. One
prop fixes the behaviour; the two comments need correcting either way.

### F22 · journal's crawlable shell uses a different accent from the live landing        → fix toward the live value

The no-JS shell for `/journal` uses `#C29A4E` (lamp-500) where the live brand is `#986B1E`
(lamp-600). Measured, the shell's CTA label lands at **2.40:1**. Roadmap's and gym's shells both
match their live values, so journal is the outlier — and this is the version crawlers and
link-preview bots actually see.

### F23 · `magic-link-fork.html` is the only email without `color-scheme: only light`        → add it, and fix the README

Every other template pins `color-scheme: only light` on root and body. This one does not, so it
**will** auto-invert in Apple Mail and iOS Mail. `emails/README.md:111-115` states that every
template carries it — so the doc is wrong at the same time, and the doc is what the next person
will read.

### F24 · `magic-link-signup` uses double-brace interpolation        → triple-brace, per the Resend contract

The template writes `{{magic_link}}`. Our Resend contract is triple-brace `{{{var}}}` for raw
values; double braces HTML-escape, which breaks a URL carrying `&`.

### F25 · `privacy.html` and `changelog.html` have stopped being true        → rewrite both

`privacy.html` stamps "Updated July 2026" but was edited 2026-08-22 (`adfbb38`), and its line
"that's every email we send today" omits both the reminder and the journal nudge. `changelog.html`
stops in July: no journal, no gym opening — against a promise `terms.html` makes **twice** that
material changes are logged there. These are the two pages a user reads when they want to know
whether to trust us.

### F26 · the gym landing's highlighted Exchange card is 1.37:1        → a designer call, not a bug

`#EDEBF0` sits on a wash that flattens to `#CFCACB` over cream. Faithful to the code, and it is the
card the section is built to draw the eye to. Raising the wash or dropping the ink both work; which
one is a design decision.

### F27 · `journal-nudge` is sent in production and has no template in the repo        → recover it from Resend

Not a drift — a hole. The nudge ships to real inboxes, and the only copy of its markup is inside
Resend. Nothing in the repo can be reviewed, versioned or corrected, and the Figma email kit cannot
honestly claim to be complete until the file exists here.

### F28 · journal's in-page echo form does not exist at any desktop width        → decide, then fix the doc or the CSS

`journal.css:925-930` sets `.je-ink` and `.je-ink-foot` to `display:none` for **every** viewport
≥1240px — the rule is gated on the media query alone, not on `.has-margin`. So the "in-page echo
form on desktop" that briefs and boards describe cannot be produced at 1280 at all; it appears only
below 1240. The Figma board therefore draws it at **1024** and says why.

Either the gate was meant to be `.has-margin`-conditional and lost that half, or the form is
deliberately margin-only above 1240 and every description of it is wrong. This one needs a decision
before anything is drawn as canon.

### F29 · three journal mono styles are authored at weights the product never loads        → drop them to 600

`.je-tab-face` asks 700 (`journal.css:695`), `.je-trail-label` 800 (`:960`), `.je-plan-price` 700
(`:1071`). `styles/fonts.js` self-hosts JetBrains Mono at **400/500/600 only**, so all three render
at 600 and the declared weight is fiction. Same family as F7, which found the identical problem in
gym at eleven sites — so this is a pattern, not an accident, and the ramp should probably be
clamped at its loaded weights rather than fixed one site at a time.

### F30 · `.journal-born` underlines a whole day's prose        → almost certainly delete the declaration

`journal.css:171-175` puts `text-decoration: underline; text-underline-offset: 2px` on the day-block
wrapper. The class is the fade-in-from-below animation, its comment mentions only the animation, and
`text-decoration` **inherits** — so any day that arrives after first paint has all of its prose
underlined. It reads as a stray line rather than a decision, but it is live.

### F31 · two gym surfaces render in the OS UI font, not Nunito        → add the family

`.gym-picker-row` (`gym.css:1150-1165`) and `.gym-fix-step` (`:1013-1022`) set neither
`font-family` nor `font: inherit`, so a `<button>` falls back to the UA default — SF Pro Text on
macOS/Chrome. The movement picker's rows and the fix sheet's step controls are therefore off-brand
today. The keypad's two siblings already carry Nunito, so this is an omission, not a house style.

### F32 · every quest-roster step draws an empty glyph circle        → give the roster icons, or stop reserving the well

`node.icon` is optional (`SkillTree.js:102`). Only a tree's **root** is given one — `'sparkles'` at
`QuestShelf.jsx:47` and `NewTreeBirth.jsx:120` — and in-app creates use `NEW_NODE_ICON`
(`SkillTreeView.jsx:106`). A roster step passes `undefined`, `Icon.jsx:161-164` returns `null`, and
`.st-step-glyph` renders as an empty 40px sunken circle on every row of the shelf.

### F33 · at night, roadmap's ghost icon buttons are cream ink on the cream canvas        → downstream of F13

A second-order consequence of the canvas that cannot go dark. The three ghost `IconButton`s and the
zoom glyphs take `--text-primary`, which is `#F1E9D8` in dark, and they have no pill of their own —
so they sit as near-white ink directly on the GL canvas, which is still `#F9F5EB`. They effectively
vanish. Fixing F13 fixes this; nothing else will.

### F34 · nine journal type declarations have no style in the ramp        → the ramp's owner decides

`.je-first .je-ink-passage` 15/27 (`journal.css:883`), `.journal-talk-state` (`:1366`),
`.journal-talk-act` (`:1381`), `.journal-talk-note` (`:1388`), `.je-sheet-buy` (`:1094`),
`.je-ink-desk .je-verdict-mark` (`:913`), `.journal-nudge-suppressed .journal-nudge-when` (`:1188`),
`.journal-week-count strong` (`:1281`), and `.journal-scale-word` under 684px (`:480`).

They ship; they are just not in the named ramp. No style was invented for them in Figma — the
specimen board lists them as an appendix instead, because minting nine styles nobody chose would be
inventing canon rather than recording it.

### F35 · two Windmill · Gym boards disagree with each other        → a board fix, not a code fix

Inside the Figma file, not the product. `A5 · Routines` reads `Lower B — 5 movements · trained
yesterday` while `A4 · The log` puts Lower B on `Sun 17 Aug` with the newest session `Tue 19 Aug`;
both cannot be true. And `B2 · Finish` prints `Bench Press e1RM 118.4`, which no clean plate load
reproduces under Epley (`backend/products/gym/domain/Review.cpp:230`).

Sample data that does not reconcile teaches the wrong arithmetic to whoever reads the board next.
The later boards use one calendar (19 Aug = Tue, today = Fri 22 Aug) and e1RMs that re-derive
exactly; these two should be brought onto it.

### F36 · on a phone, the floating tool rail sits on top of the writing        → give it a phone rule

`.journal-tools` (`journal.css:510-518`) is `position: fixed; right: 20px; bottom: 84px` with a
`z-index: 40` and **no phone override anywhere** — the only rule that ever moves it is
`journal.css:932`, which shifts it to `right: 320px` when the echo margin opens at ≥1240.

At 390 the measure is 346 wide and centred, so it runs x 22 → 368. The rail occupies x 326 → 370.
**The last ~42px of every line of prose sits under a 44px button**, and the search tool is always
mounted, so this is every phone, always — not an edge case. The buttons are
`--surface-card @88%` with an 8px backdrop blur, so the text under them is dimmed and blurred
rather than hidden, which is arguably worse than either.

`.je-home` ("Back to tonight", `journal.css:995-1013`) has the same shape — `fixed`, centred,
`bottom: 24px`, an **opaque** `--surface-card` pill — but it only mounts once you have hopped back
through the echo trail, and floating is plausibly the intent there. The rail is the one to fix.

Found by drawing the phone boards truthfully rather than by testing: on desktop there is margin to
the right of the measure for the rail to live in, so the collision only exists at phone widths and
only shows up if you draw one.

### 0a · Landing family — shipped roadmap page predates the family contract        → fix toward 00-README

The shipped windmill.works/products/roadmap page (replicated by
`marketing/briefs-landings/01-roadmap-replica.md`) carries neither the family cross-nav
(Roadmap · Journal · Gym · Pricing — role 1) nor the footer product cross-links (role 8).
Scaffold v2 (`templates/landing-roadmap`) layers both on top of the verbatim copy
inventory; 00-README wins over the replica. Siblings inherit both the same way.

**Closed on the build side 2026-08-02** (see the landing-family-unify entry below): the
shipped roadmap landing now wears the same chrome as its three siblings, cross-nav and
footer cross-links included. The template-side reconcile (0b) is still open.

### 0b · `marketing/ui_kits/marketing/roadmap.html` vs the brief-01 spec        → fix toward the spec; the ledger is the mechanism, not a silent edit

Section-by-section diff of the closest shipped ancestor against brief 01's verbatim
inventory:

- **Nav links**: kit has "All three apps" (index) + Pricing; spec ships How it works ·
  Paths · Connect (`#/connect`) · Changelog. Kit lacks Connect; auth ghost says "Log in"
  vs spec "Sign in". No skip-link in the kit. No auth-state variants at all (resolving /
  link-sent / signed-in seat / account menu).
- **Beat 01 copy**: kit "Paste a list, pick a starter quest, or plant steps by hand.
  Depth becomes dependency — your plan arrives as a tree." vs spec "Plant steps by hand —
  your plan arrives as a tree. Starter quests and paste-a-list are growing in."
- **Paths meta**: kit "24 steps · ~4 months" vs spec "~4-6 months" (frontend); kit
  "26 steps · ~4 months" vs spec "~6 months" (ML); kit "Ship v1.0" vs spec "Ship v1".
- **Missing section**: the two-column "Build with your AI tools" panel (works-with chips,
  promise line, can't-line, verb chips in kind hues) does not exist in the kit; its trio
  item "Build it with your tools" is the ancestor of it.
- **Why Windmill**: kit is an unlabelled trio (Share a tree / Build it with your tools /
  Everywhere you are); spec is an eyebrow+title duo ("Made to share, and to sync") and
  the share copy drops "or post the picture".
- **Footer**: kit Pricing / Privacy / Terms / Twitter; spec Feedback · Pricing · Connect
  your AI tools · Privacy · Terms · Refunds · Changelog (+ scaffold v2's product
  cross-links). Twitter is not in the spec.
- **Recognition**: kit hero/CTA-band have no `hasTree` swap ("Plant another tree") and no
  resume hero / fact line.

The kit page stays the shippable page until a deliberate re-sync; scaffold v2
(`templates/landing-roadmap`) is the spec-true board.

### 0c · Motion beat numbering in brief 01        → named beat wins (per the brief's own rule)

Brief 01 cites "the bloom beat (the shipped engine indexes it #14)" and "the travel beat
(indexed #4, verbatim)". In `guidelines/motion-language.md`, #14 and #4 are **ceremony**
indices (#14 share artifact — the arrival cascade verbatim; #4 first unlock), while
"bloom" and "travel" are beat names inside the ceremony sentence. The engine
(`marketing/ui_kits/marketing/tree-scenes.js`) follows the doc: arrival = #14 on #3's
constants, self-play unlock = #4 verbatim, reset = plain 280ms dim (a downward change,
no beat). Named beats win; the numbering stays as ceremony indices.

### 0g · Gym's landing opens eleven dark windows, not one        → open, needs a designer call

00-README's chrome rule reads: "A product may open a window of its own skin inside the
**moat** (journal's night canvas is the canonical case), but the page around that window
must stay the family's warm cream." Measured on the shipped page 2026-08-02: `/gym`
renders **11** `[data-theme="dark"]` regions — 1 moat + 3 beat stages + 7 proof/agent
cards — against `/journal`'s **1**. The frame itself is correctly light on both (the
landing root carries `data-brand` and never `data-theme`), so the rule holds literally
and no honesty rule is touched.

But "a window inside the moat" reads as one window, and eleven of them make gym's page a
dark page with cream gutters rather than a cream page with a lit instrument in it. Either
the rule means one window and gym's beats and proof cards should come up to daylight, or
the rule means "any window the product's skin genuinely owns" and 00-README should say
so. Not resolved in the build — the wave that found it was told to report, not restyle.
Direction of fix: 00-README, with gym/briefs consulted.

### 0h · `--kind-brick` on the roadmap landing vs "brick never appears"        → open, carried over verbatim

00-README honesty rule 6: "Brick never appears on these pages; gold is flourish, never a
state." The shipped roadmap landing paints the "Rust from zero" quest card's rule and its
first progress dot in `--kind-brick`. It predates the rule and survived the 2026-08-02
rebuild verbatim, because that wave was a chrome extraction and porting agents were told
not to touch copy or colour on their own authority.

So one of two things is true and canon should say which: either the rule means brick is
banned as *chrome and state* but a kind hue may still identify a kind (the six-hue legend
is the roadmap's own vocabulary, and Rust's card is showing the legend, not a state), or
the rule is absolute and that card needs a different hue. Gold is clean either way —
audited on all four landings, it appears only as flourish (the legend paint line, the
link-sent ember), never as a state. Direction of fix: 00-README.

### 0i · `templates/landing-main/` has no scaffold-v2 canon        → open, a brief is owed

The brief set that produced the family deliberately scoped this out: "`templates/landing-main/`
is out of scope for this set". The three product landings were rebuilt on scaffold v2 on
2026-08-01; the brand root was not, and shipped as an admitted v1 scaffold.

On 2026-08-02 the brand root was brought onto the family's **chrome** and type scale — that
was the visible defect (its nav was 1160px/18px padding/18px wordmark/14px-600 links while
every sibling was 1280/24px/22px/14.5px-700, so the header jumped whenever a visitor moved
between products). Its **content** is still v1: it fills roles 1, 2, 6, 7, 8 and 9, and has
no role 3 (the loop), no role 4 (proof), no role 5 (trust boundary — whose can't-line is
mandatory), and **no moat at all**, which is role 2's heart.

That is a known gap shipped knowingly, not a silent pass. What it needs is a brief:
what the brand root's moat *is* when the page belongs to no single product, and what
proof and trust boundary mean at brand scope. Direction of fix: a new
`marketing/briefs-landings/04-brand-landing.md`, then `templates/landing-main/` rebuilt
on scaffold v2.

### 0j · 00-README honesty rules 2–3 outlived the naming freeze        → open, 00-README to revise

Both rules were written to hold a line while the paid layer's name and numbers were
undecided. Entry 0 closed that on 2026-08-02: the layer is **Windmill One** at **$12
USD/month**. Two consequences the cover brief has not caught up with:

- Rule 3 says "every landing says 'the paid layer' generically until pricing.md settles
  the name". It is settled. Landings may now name Windmill One — the question is whether
  they *should*, or whether the generic phrasing was always the better landing voice and
  only the reason for it has changed.
- Rule 2's "landings never show price numbers" carries a parenthetical justification that
  is now void ("numbers are open until per-run cost is modelled"). The division of labour
  it states — prices are pricing.html's job — may well stand on its own; it just no
  longer rests on the reason printed beside it. The build has kept the rule as written:
  no landing prints a number.

One exception already exists and predates the freeze: the brand root's FAQ structured
data answers "How much does Windmill cost?" with the real figure. It is markup rather
than visible copy, but a search result renders it, so 00-README should say plainly
whether structured data counts as the landing showing a price.

### 0n · pricing.html sells tending, and tending is dark        → open, an OWNER call, not the build's

`windmill.works/pricing` is published, with the settled name and the settled figures. Tending
itself is not reachable: `TENDING_ENABLED` defaults to false and `main.cpp` requires it to be
set explicitly (the designed first face is "not turned on"), so **no user can run a tending**.
The live page therefore advertises a feature that does not yet answer.

This is the mission's own line — "no copy that promises what the product doesn't do" — pointed
at us. It is stated here rather than resolved because both exits are the owner's to choose:
**arm tending** (flip the flag, live Paddle), or **say plainly on the page that it is coming**.
The build has done neither on its own authority. `pricing.md` §6 now carries the same status
paragraph so the canon and the ledger cannot drift apart on it.

### 0r · `journal/onboarding.md` §2 still specifies the retired first-run placeholder        → open, the owner's call

Found 2026-08-09 while fixing §4 beside it, and not part of that change. §2's copy table gives the
first-run placeholder as "How was today?", and §8 asks whether it is "too leading". Both boards and
both builds have said **"Start anywhere. Nothing here is graded."** for longer than that — the
2026-08-04 closed entry records the flow board resolving toward exactly the shipped copy, and
`templates/journal-onboarding` draws it. So the canon file for the first run is the last surface
still specifying a line nothing draws.

Left standing rather than silently rewritten, because closing it also retires an **Open** question
and that list is the owner's. The fix is small and in one direction: §2's placeholder row takes the
shipped copy, and §8's first bullet goes with it.

### 0s · App-door copy — canon caught up 2026-08-10; one designer question remains        → the footnote divergence

The first-open wave (2026-08-09) moved the native doors to an emailed 6-digit code and made
the gym room anonymous-first; `roadmap/guidelines/auth.md` was revised on 2026-08-10 to the
shipped reality (§1 method line, §3 landing — the "link only, no codes" decision revised with
the owner's ratification: they pasted the magic-code Resend template and deployed the flow —
§7 app-door rows, §8 constants). The repo's `backend/AUTH.md` states the wire contract.

**Still open, a designer call:** the two doors now carry different reassurance footnotes —
app: "No password. What you make on this device is claimed by your account when you sign in."
· web: "…and some rooms only open once you have an account" (`SignInDialog.jsx:140`, still
true on the web where the gym log/mirror need an account). Per-surface truth, or one sentence
everywhere? Also: boards that draw the app door or the gym web surface
(`templates/superapp-flow`, gym boards with a web Start) still show the old flows — flagged,
not redrawn; the wave that found them was told to report, not restyle.

### 0t · Web's mirror home is still Today, and mobile no longer has one        → open, a designer call

The 13 Aug routine-first update retired Today on the phones: home is the routine list, the
tabs are Routines · The log · Ask. Web deliberately did **not** follow (build ruling,
2026-08-14): its Today room is the mirror charter itself — the desk drawing the phone's open
workout (§11.2) — and retiring it there would delete the mirror's home, not align a tab bar.
Web also keeps Ask as a room off Today; §L's argument (a chat is not a place you live) was
scoped to this surface by the build and still holds here. So the two surfaces now answer
"what is gym's first screen" differently, on purpose. Either that difference is the product
speaking — the desk mirrors, the phone trains, different rooms want different anchors — and
the boards should say so, or web's IA should converge on Routines-home the way mobile did.
Direction of fix: `gym/Windmill Gym Web.dc.html` and the G8 brief, with §11 consulted.

### 0u · Ask is a tab the boards never drew as one        → open, a design ask

The 13 Aug app board seats Ask third on every rail, but its tab-root form is undrawn —
screens 26/27/33 still show a back chevron and no rail — and `templates/gym-programs` §L
still says "Not a fourth tab" and "Reached from Today's bottom band", both falsified by the
promotion (and Today is retired besides). The build shipped the minimal faithful adaptation
(the rail in place of the back bar, threads door kept in the header) plus the two stances a
tab needs and a door never did: signed-out — "Ask reads your log, so it needs you signed
in." with Sign in → You — and deployment-absent — "Ask isn't available on this Windmill."
Both strings are the build's own authorship, pinned in tests; they need a copy-owner's
blessing or replacement. Direction of fix: §L redrawn with the tab-root form and the two
stances; the shipped strings are the placeholder.

### 0v · Small board drift the 13 Aug redraw left behind        → open, one redraw pass

Found while building the wave; each ruled for the build (rulings recorded on the dogfood
node `gym-routine-first-ia`) and owed a redraw:

- Screens 5 and 30 draw two routine details; built as one — 30's content (History,
  Duplicate) under 5's chrome (header Edit), with the literal locked verb **Start workout**
  (screen 30's "Start Heavy Thursday" loses to the lock).
- Screens 28 and 6 draw the editor with BOTH a header Save and a footer "Save routine";
  §M's own sentence — "Save in the header" — won, and the footer is not built. Rename
  retired into the editor's inline name.
- The user-created movement marker: "yours" (screen 7) beat "· mine" (screen 30).
- §M's "Follows" row still says "Today marks its first outing untested" — Today is
  retired; the badge lives on home cards and the detail.
- §I's heading says "Five rows"; six cards are drawn.
- Screen 22 still draws the first-run auto-start as a deliberate §J exception ("the
  session is already running", 0:12) while the update's own sentence is "nothing runs
  unless the user started it". The build retired the auto-start on both phones — the
  owner's prose won, and first-open testing named this exact confusion as a blocker. If
  the exception was meant to survive the redesign, it reverts cleanly (the stored
  first-arrival key is preserved, harmless, read by nothing).
- The "ladder · N steps" target type (the Overhead Press row, "ladder · 4 steps") is
  drawn with no authoring UI on either board and no shape in RoutineWrite — design ahead
  of the wire; not built.

### 0w · journal's two scales go 0–10 and get permanent labels        → canon rewrite owed, then a build wave

Owner report, 2026-08-23: a writer cannot tell which cluster on the canvas is mood and which is
energy, both scales should read 0–10, and setting them should feel like something. The spec that
answers it is `.claude/scratch/journal-scale-spec.md` in the repo. It is **not yet built**, and
`journal/journal.md` is stale against it as of this entry — that rewrite is the fix this entry
tracks.

FALSE AS OF THIS SPEC, in `journal/journal.md` "Journal canvas controls" (09 Aug 2026):
- the one-row strip, the two unlabelled clusters, and the single mono word at the right naming the
  last-touched value (`felt` when unset) — deleted; each scale becomes its own labelled row,
  `[label][track][numeral]`, identity carried three times over (word · hue · head shape).
- the size table (mood dot 26px / 31×44, energy bar 14px / 22×44, heights 6/10/14) — replaced by a
  snapping scrubber: a 54|1fr|30 grid at the 640px desktop measure, 58|1fr|34 at the phone measure,
  row heights 24px / 44px. The 44px touch rule is honoured by the row, not by the step.
- "press the lit step to clear" — deleted; on a scrubber that gesture is how a drag ends. The
  numeral at the right of each row is the clear affordance (Backspace/Delete on a focused track).
- the rejection "two permanent labels don't fit the measure" — the 356px it cites is the **phone**
  measure; `journal.css:151` is `min(640px, 100% - 44px)`, so desktop always had room. On the phone
  the labels cost 54–58px of a row that no longer has to hold eleven targets.

AMENDED — §10, "mood is one hue in five steps":
  → one hue in **eleven** steps where the value is entered, **five bands** everywhere it is read
    (day pip, week square, year cell). The five bands are the five colours §10 already sanctioned,
    pinned to the odd positions 1/3/5/7/9; the evens are their midpoints, 0 and 10 extend the
    slope. Mood migrates `new = 2·old − 1`, so **no shipped glyph changes colour** and the old
    "flat" (3) lands on the true midpoint 5. Energy 1/2/3 → 2/5/8. Old 0 → NULL.

NEW, and needs a canon home:
- **0 is a value on both scales; unset is SQL NULL.** A 0–10 scale whose zero secretly means "did
  not answer" lies about its range. Consequence: set-but-zero must be distinguishable from unset on
  every glyph — the energy tick gains a 1px olive baseline whenever energy is set at all, and every
  mood swatch outside the strip gains a permanent 1px ink hairline (mood-0 by day, `#EDDFB7` on
  `#FBF6EA`, is otherwise invisible).
- **motion, "the ember settle"** — head bloom 320ms `cubic-bezier(.34,1.4,.64,1)`, track wash 480ms
  `cubic-bezier(.22,.61,.36,1)` starting 60ms behind it, numeral rise 2×140ms, label answer 700ms;
  plus a once-per-local-day lamp bloom behind the strip when a commit completes the pair. Reduced
  motion keeps colour only — deliberately including the label answer, which is the piece carrying
  meaning. iOS adds a selection haptic per stop crossed; web stays silent.
- two new easing tokens: `--journal-ease-catch`, `--journal-ease-settle`.

NOT DRIFT, recorded so nobody re-checks it:
- echoes do **not** read mood or energy (`ECHOES.md:51` forbids mood scores in echo output, and no
  echo code touches the fields). Nothing in the echo surface falls out of this change.
- `marketing/JournalLanding.jsx` paints its mock week from `--lamp-*`, not `--mood-*`, so it is
  already decoupled and stays valid under the five-band rule.

### 2 · The marketing kit mirror — standing rules

- `marketing/` stays **self-contained on purpose**: its pages load `marketing/styles.css`,
  `marketing/tokens/`, `marketing/themes/`, `marketing/_ds_kit.js` — never the root files
  directly, and **never** the root `_ds_bundle.js`. The bundle concatenates every
  `explorations/*.js` self-executing specimen; loading it once injected ~126 stray specimen
  sections (32,714px of scroll) into the landing. `_ds_kit.js` must stay the trimmed build:
  `components/*` + `tree-scenes.js` + `tweaks-panel.jsx` only (the filter is described in
  its header comment).
- The rule extends to `templates/landing-*`: their `ds-base.js` loads the trimmed
  `marketing/_ds_kit.js`, never the root `_ds_bundle.js`, for the same reason (verified
  2026-07-31: loading the root bundle injected ~126 specimen sections, 32,571px of scroll).
- Now that everything is one project, resist re-pointing marketing pages at `../…` "because
  it's right there" — the mirror boundary is what keeps shippable pages immune to system
  churn until a deliberate re-mirror.
- Last full re-mirror: **2026-08-07** — the dark neutral ramp lift (below) went into
  `marketing/tokens/colors.css` in the same wave that changed root, because the landings'
  moats are the same night as the app's rooms and a half-mirrored ramp is drift by
  construction. Prior: 2026-07-31 (`tokens/colors.css`, `themes/brands.css`).

---

## Closed — 2026-08-14 both phones open on your plans — the 13 Aug board is built

The routine-first redesign shipped on iOS and Android in one wave, web aligned as the
mirror, and the backend needed nothing: every screen the board names was already served —
a start naming a routine freezes the plan server-side, and "name it after" is the
save-as-routine door that already existed.

What the build did beyond the board, each a ruling recorded on the dogfood node
`gym-routine-first-ia`:

- **Nothing starts by itself, now literally.** The §J22 first-arrival auto-start is
  deleted on both phones — it was "why is a session already running" wearing a design's
  clothes. Its screen-22 drawing survives on the board; 0v carries the confirm.
- **A start is never a silent join.** The wire joins an open session by default and
  ignores the tapped routine; both phones now send `joinOpenSession:false` on every
  user-tapped start and, on the 409, adopt the open workout through their existing resume
  paths and say so plainly. Claim replay untouched.
- **Ask's promotion is a reversal, recorded as one.** The 2026-08-11 entry below says
  "not a tab"; the 13 Aug board and this build make it one. The constraints that made Ask
  safe did not move: reads free-form, every write behind a human tap, no coach voice, no
  push, no streaks, no unread badge, never offered mid-session — a live session takes the
  whole screen, rail included, so the last rule is structural rather than a gate.
- **The ladder ask was already paid.** The update proposed the ±2.5 retier as an open
  decision; it had shipped 2026-08-11 (38e0acc). **0d closes with this entry**, three days
  after its own fix — its closing condition ("when the logger ships it") was met by a wave
  that did not come back to close it, which is its own small lesson about ledgers.
- **Web kept its charter and stopped teaching the retired thesis.** The desk's three
  "exercise" strings moved to movement vocabulary, the editor's commit reads Save, the
  empty routines list carries **Build a routine**, and the first-run copy now leads with
  the routine written first (the free-form path is named as the phone's, never offered as
  a desk button). The IA divergence this preserves is 0t.
- **Progress tab: not added**, confirming the board — a movement's history is one tap from
  its name anywhere, and W1c retired the dashboard; a trends tab would reopen it under a
  new name. Revisit trigger recorded on the node: dogfood evidence of lifters reading a
  record before choosing a routine.
- Suites at ship: iOS 498 gym tests, Android 511 per variant, web 1055 — all green; the
  ladder contract and every wire shape byte-untouched.

---

## Closed — 2026-08-13 gym opens on your plans, not on a running clock

User testing, owner-reported: two things nobody could work out on first open — **how do I assemble a
training**, and **why is a session already running**. Both traced to one decision, the 2026-08-07
§A thesis that "the first routine is a by-product of the first session": home was *Today*, its one
verb started an empty session, and the routine editor was framed as a maintenance surface people
would reach later. It is a good argument about how routines get *written*, and a bad answer to what
an app should do when you open it.

Reversed, structurally:

- **Home is the routine list.** Tabs are now `Routines · The log · Ask` + the shell's You seat.
  Today is gone as a tab — the word implied something was already happening today.
- **Nothing starts by itself.** A session begins only from a routine's detail screen (new screen 5)
  via *Start workout*. The running clock is always something the lifter asked for.
- **Every empty screen carries its call to action** — the one gap the owner named in the reference
  app they were happy with. Empty routines is a titled empty state with *Build a routine* under it.
- **The routine editor is one screen** (28), not a name-then-list sequence: name inline, movements
  under it, *Add movement* at the foot, Save in the header — you see the whole thing you are
  building the whole time.
- **The session screen says where you are**: movement dots (3 of 6), *set 3 of 5*, and Finish in the
  header rather than buried at the end of the flow.

What survived: free-form logging is still there and still offers to become a routine at the end —
it is the second path now, reached by *Just start logging*. §A's original reasoning is preserved in
the "three doors" strip on the programs board, with *before* marked as the front door.

---

## Closed — 2026-08-12 the gym board became two, and the token copy went away

The single `templates/gym-app` board had grown to 33 screens and 1,767 lines — past the point where
a reviewer can hold it — and it carried three kinds of dead weight: a deferred concept with no
screens (§E, the G7 strength tree, which the briefs own), a card documenting the logger version that
had just been deleted, and changelog voice in four ledes ("Rebuilt 2026-08-12…", "Reversal, owner's
call…") that told the history of a decision instead of stating it.

Split on the product's own seam, not down the middle:

- **`templates/gym-app`** — *Layout and screens*: the frame contract plus every screen touched while
  training or reading history (§F, A, B, C, G, H, I, J, K — screens 1–11, 15–25).
- **`templates/gym-programs`** — *Where programs come from*: authoring by hand, naming, and both
  agent doors (§M, N, D, L, O — screens 12–14, 26–33).

Screen numbers stay global and sections keep their original letters, so every citation already in
this ledger, the briefs and `guidelines/thumb-reach.md` still resolves. Within the boards, a pointer
to a screen on the other board is marked `· app` — five of them on gym-programs (§M's first door,
and four rows of §N's naming map).

And the fix that closes the other half of the 2026-08-11 stone entry: `templates/gym-app/gym-tokens.css`
is **deleted**, not re-copied. Both boards now link `../../gym/gym-tokens.css` — the canonical file —
resolved the same way `ds-base.js` already resolves the design system root. One copy in the project,
so there is nothing left to go stale.

---

## Closed — 2026-08-11 gym ships a chat after all (owner reversal)

Not drift — a decision, recorded because it falsified canon in three places and the standing rule
says those get fixed in the same wave. **Gym gets `Ask`**, a Windmill One chat surface with the
log behind it (`templates/gym-programs` §L, screens 26–27).

- `gym/briefs/01-context.md` said "there is no chat UI to design in this product" and called the
  paid surface "not a chatbot". Corrected in place, with the reasoning kept: the *constraints* it
  was defending still hold.
- `templates/gym-journeys` listed a chat interface under "what no journey contains". It now records
  the reversal as the visible decision that list exists to force.
- The board's §D lede promised "no chatbot". It now reads as two doors onto one engine.

What did **not** move, and is the reason this is safe: reads are free-form, writes are not. Ask can
read and propose; a routine change is a typed diff behind a human tap, atomic; it cannot edit or
delete a logged set, cannot touch a frozen plan snapshot, cannot start or finish a session. No coach
voice, no push, no streaks, no unread badge, not a tab, never offered mid-session.

*(2026-08-14: "not a tab" was reversed by the 13 Aug board and the build — see the entry
above. The safety constraints stand unmoved.)*

---

## Closed — 2026-08-11 the gym board was painting the wrong stone

Found while designing gym's mobile screen set (`templates/gym-app`), and both halves are the same
defect: a board can carry a *copy* of canon that stops being canon.

- **The board never scoped the brand.** Its fifteen room wrappers read `class="gym-root"
  data-theme="dark"` with no `data-brand="gym"`, so every "instrument" screen rendered the
  family night sky (clay's warm brown-black) rather than **basalt**, and its light skin would
  have come up cream rather than **pietra**. `gym-tokens.css` re-points the hue and derives the
  surfaces; it does not — and per its own header should not — restate the ground. All fifteen
  scopes now carry the brand.
- **Its `gym-tokens.css` was the retired v2**: the daylight block still restated the light ramp
  by hand (`#F9F5EB`, `#E5D9C0`, …) and its alignment note cited a night-sky hex that moved.
  Replaced with `gym/gym-tokens.css`, where both skins derive (entry 1, closed 2026-08-07).
- Same wave: the board's three legacy three-column tab bars became the shipped bar —
  three tabs, a hairline, then the shell's You seat (`superapp-shell.md` §4). A board drawing
  gym's chrome without that seat is drawing a room that no longer exists.

The general lesson is the one §1 already argued from the other direction: a product board should
reach for the scope, never for the value. Anything typed as a hex on a board is a copy, and every
copy is a future stale line.

---

## Closed — 2026-08-09 web follows native on unwritten days (0p)

**Entry 0p is closed by the first of the two exits it named: web followed.** The owner opened
the web canvas, saw "nothing written", and said the line should not be there — if nothing was
written there is nothing to render. So the disagreement lasted five days and ended where native
already was.

`web/src/products/journal/pageStore.js` was spanning earliest-written → yesterday and filling
every miss with an unwritten day; it now maps the written pages straight through, so `history`
carries no gap entries at all. The `written` flag existed only to feed them and is gone from the
snapshot shape, and with it `DayMarker`'s hollow-pip branch and `.journal-pip-hollow` — both
unreachable once every day drawn is a day that was written. A page carrying only a mood is still
a day someone showed up for and is still drawn, which is the same line iOS holds.

**What did NOT change, deliberately:** the year grid and the week readout still draw a cell for
a day nobody wrote, and the journal landing still says "hollow means nothing written". A calendar
is a grid of dates and legitimately has empty squares; the canvas is not a calendar. That is the
distinction §4 now states, rather than leaving `--neutral-300`'s "a day you didn't write" reading
as though it were still true of the canvas.

**Every surface that specified the gap moved in the same wave**, because a board is read before work
starts too: `journal/journal.md` §3.3, §4 (Gaps) and §10 — §4's web clause is gone, as 0p said it
would be if this exit was taken; `journal/Windmill Journal - System.dc.html` (the P2 phone screen,
the W1 desktop screen, the "Gap days" edge-case row, and the palette swatch that labelled
`--neutral-300` "a day you didn't write"); `journal/onboarding.md` §4; and
`templates/journal-onboarding` (the J3 screen, its caption and section 02's blurb). Where a specimen
lost a row it gained a real written day instead of a hole, so each still demonstrates the jump the
dates carry (P2 now reads 20 → 22 → 25 Jul; J3 reads Sat 02 → Mon 04).

Not touched, and correctly so: the week readout still *states* gaps in words ("Thursday is the only
gap, and it's the third Thursday in a row"), which canon §8 asks for — stating a pattern is not
grading one.

This wave opened **0r** above: one stale line it found next door and did not decide on its own
authority.

## Changed — 2026-08-07 (final) six palettes, three places

Where the day landed, after two rounds of candidates and two rejections in between. The framing
that unlocked it came from the owner: **two of the six palettes had been designed and four never
had.** Roadmap's Tuscany-at-midday and journal's night-and-candles were never in question; every
failure this day was in the other four, and every one of them had been given a hue instead of a
place.

| room | day | night | hue |
|---|---|---|---|
| roadmap | Tuscany at midday (unchanged) | **embers** — warm through, lifted, terracotta at its 400 as the lit step | terracotta |
| journal | **paper in north light** — white sheet, cool shadows | dusk and one candle (unchanged) | candle lamp |
| gym | **pietra** — warm Tuscan stone | **basalt** — volcanic, violet-leaning | **iris**, replacing steel |

- **Gym's hue changed with its ground.** Steel/sky is retired: it was the INFO semantic doing
  double duty as a brand (the note that has been riding this ledger since §1 opened), and being
  cool it could not be the warm light a cool ground needs. Iris — the giaggiolo, Florence's own
  flower — was already authored to §4's recipe in `themes/brands.css` as the worked example of a
  new hue, and sits 65° from sky so it can never be read as info.
- **Journal is one room at any hour now.** Its day was the family cream with gold bolted on —
  warm ground, warm light, the exact pairing its own night avoids. It is cool paper with a warm
  ink in both skins.
- **§4a was rewritten a second time** and now leads with PLACE and TEMPERATURE rather than with
  what is permitted. **§4b (room tint) is retired the day it was written**, kept only as a record
  so nobody re-invents it: once a room names a place, a 6% cast on the family cream is neither
  one thing nor the other. That half-measure is what produced cement.
- **Rejected, and worth keeping:** forest (a green ground the semantics had to fight), cement and
  graphite (cool on cool — the accent stops being an accent), fig dusk (violet ground, terracotta
  light: the rule-following option that lost to the warmer one).
- **The two light grounds were rebuilt once more the same day.** Their first pass (morning paper,
  Carrara) came out as two near-identical low-chroma greys — #F2F5F6 and #F1F3F4, one step apart —
  which the owner read as "artificial rather than natural", correctly. The cause is worth keeping:
  a ground with almost no chroma reads as a screen, and two of them cannot help converging. Both
  were re-authored with real chroma in opposite directions — journal's paper genuinely blue (one
  family with the dusk it becomes at night), gym's stone genuinely warm ochre-green and a full
  value step deeper than the family cream, because stone is heavier than paper. Carrara was the
  wrong stone twice over: cool near-white lands on top of journal's paper AND reads as cement.
- **Journal's day took three passes and the third is the lesson.** Family cream (warm sheet,
  warm candle — two temperatures agreeing), then a fully blue sheet (read as a web form), then
  the one that shipped: a paper-white sheet with the cool in its shadows, mids and ink. §4a
  gained a SHADOW line for it — the ground is not only the canvas, and hue belongs where the
  light would actually leave it.
- **Gym's stone took three too**, and the day moved with the night: Carrara (cool near-white —
  landed on journal's paper and read as cement), green-grey limestone (drab, and disagreeing in
  hue with its own night), then pietra + basalt — one warm stone at both hours, violet-leaning,
  sitting in iris's hue neighbourhood at a tenth of its chroma.
- **§4a's temperature rule survived a real test.** The rejected "blue hour" candidate was a cool
  ground under a chromatic accent, offered precisely because the rule had been written from two
  *desaturated* failures. Basalt reached the same place without needing the rule rewritten, so
  the rule stands as written — but the question was asked properly rather than assumed away.
- `marketing/themes/brands.css` re-mirrored in the same wave.

### Closed the same day: gym's canon graduated

Every surface that named steel now names iris and its stone, and **brief G2's open ask is
resolved rather than deleted**: the collision it raised (brand and info resolving to the identical
value inside `.gym-root`) was real, its three proposed exits are recorded, and a fourth was taken —
the brand hue changed. The brief's own unanswered first question went with it: gym reads as *one
surface with two skins, and the surface is stone*.

Moved: `gym/briefs/03-G2-palette.md`, `gym/Windmill Gym.dc.html` (accent swatches and the palette
notes), `templates/gym-app/gym-tokens.css`, `templates/landing-gym`,
`marketing/briefs-landings/03-gym-landing.md`, `guidelines/superapp-shell.md` and its card,
`templates/superapp-shell`, `readme.md`.

**Rejected on register, recorded so it is not re-proposed:** reading basalt as *sea* — coral,
breeze, wave. It would be a handsome palette and the wrong one: gym is mass and effort, and that
vocabulary belongs to release.

## Changed — 2026-08-07 three products, three grounds

The night ramp lift (below) was the first half of the day; this is the second. The owner asked
to try non-brown grounds for roadmap and gym, six candidates were built as real rooms
(`guidelines/colors-room-grounds.card.html`), and two were chosen:

- **Roadmap · forest** — a garden at night. On warm soil terracotta was earth on earth; against
  a green-black ground it is complementary, and bark/leaf stop being a metaphor the ground
  argues with. It ships as a new brand scope `[data-brand="roadmap"]` rather than by changing
  `clay`: **clay stays the family default** — the brand root, marketing, and every dark surface
  belonging to no product — and must not move when a product's room does.
- **Gym · concrete** — a neutral grey with no hue of its own, so steel is the only colour in the
  room. It replaces the warm soil that made steel read as a cousin of the brown.
- **Rejected, and worth recording:** G2 (graphite — ground and steel one material) reads as
  harmony but costs the accent its job; R3 (charcoal) gives terracotta everything and the room
  nothing.

`guidelines/system-architecture.md` §4a was **rewritten, not amended**: it said exactly one
product could own its ramp and closed with "a second product wanting this exception is the
signal to redesign the rule, not to copy it". Two asked within a day, so the rule was
redesigned. The cost is stated there in full — the warm ramp is no longer what the products
share at night; the family is type, spacing, radii, motion, voice and the semantics.

**Still open: the day.** Both grounds are night-only, so the rooms stand on the family cream by
day. The alternative (a pale forest, a pale concrete) is drawn on the grounds card and has not
been decided.

## Changed — 2026-08-07 the night ramp came up

Not a disagreement, so nothing to close — but a family-level change, which this file is the
only sensible place to record. The owner's verdict on the dark rooms was "too contrast and too
dark", and that is not a room-level complaint: roadmap paints with the raw dark ramp, so it was
a verdict on `[data-theme="dark"]` itself.

- **The ground came up two steps, the top step came down one.** Canvas `#0D0B07` → `#17110A`
  (warm soil, not black), card `#17120B` → `#221B12`, primary text `#F4EEDF` → `#EAE1CE`.
  Text on canvas goes from 17.5:1 to 13.8:1 — still past AAA, minus the glare.
- **The low steps moved furthest**, because that is where the old ramp actually failed: canvas,
  card and raised sat within half a percent of luminance, so an elevated surface could not be
  seen to be elevated. They are now separated.
- Everything derives, so every room, card, moat and landing followed without an edit. Four
  specimens that had **typed the old hexes by hand** did need one — the gym board's sibling
  palettes, gym-tokens' alignment note, the brand brief's constraint line — which is its own
  small argument for never typing a token value into a page.
- **Gym's night lost its tint** in the same wave (§4b's new TEMPERATURE line). The lift and the
  un-tint are related: a lifted warm ground makes steel read as metal without help.

## Closed — 2026-08-07 every room has both skins (1)

**Entry 1 — gym's light skin restated the light ramp — is closed**, and the fix is the one its
own header named: the shell owns theme scope. Two things had to land for the literals to go,
and the second is the part nobody had written down:

- `tokens/colors.css` publishes the light ramp under `[data-theme="light"]` as well as
  `:root` (one selector, no duplicated values). That is what makes a light subtree inside a
  dark ancestor *recoverable* — the seam that forced gym to restate ten values by hand.
- Gym's **paper** moved to `[data-brand="gym"]` in `themes/brands.css`, so both skins of the
  room are declared in one place instead of one skin per file.

`gym-tokens.css` derives in both skins now, and four values still written as literals in the
daylight block (`--warmup-ink`, `--unsynced-ink`, `--set-done-soft`, `--alarm-soft`) read
their semantic token like their instrument counterparts do.

The note that travelled with the old entry stands and is **not** closed by this: gym promotes
steel/sky from *info* to *brand*, so sky-as-brand and sky-as-info coexist. Watch shared
surfaces — a steel chip in a gym room means "gym"; the same chip in a toast still means "info".

**What else changed with it:** `guidelines/system-architecture.md` gained **§4b**, the room
tint — a product may mix its brand hue into its four surface roles at ≤6%, in both skins, and
never into borders, text or semantics. It exists because the /app shell made the question
urgent: rooms have to be told apart on sight. Journal's parchment, gym's daylight rack and
gym's instrument are the three shipped tints; roadmap takes none, which is the rule's own
default. It is also the answer to §4a's "a second product wanting this exception is the signal
to redesign the rule" — gym asked, and the rule was redesigned rather than copied.

**And the shell stopped pinning.** `templates/app-shell` mapped gym to `dark` in both
appearances because gym had no honest light skin to switch to. It has one now, so the
appearance choice reaches all four rooms — which is what §0q said the rule was.

---

## Closed — 2026-08-02 canon caught up with the build (0f · 0l · 0m)

Three entries closed in one pass, under the standing rule at the top of this file: each was a
line still asserting something we already knew to be false.

**0l — the iOS shell board said "Windmill Pro".** `templates/superapp-shell/SuperappShell.dc.html`
was the last surface in the project still using the withdrawn name, four times as a title and
thirteen more as bare "Pro". All of them now read Windmill One; where a bare "One" would scan as
a numeral ("One isn't here at all", "One — the superapp's only paywall") it was expanded to the
full name rather than left ambiguous. Its You screen also carried the static line "one account ·
signed in by magic link" — wrong on any device where Apple was used, and Apple is now the primary
door on iOS — so it states the account, not the method. The board's byte length was unchanged by
the rename, which is a small proof that nothing else moved.

**0m — `guidelines/superapp-shell.md` was claimed but absent.** `github.md`'s sync note recorded
the resolved shell as graduated to canon; only the template existed. The guideline is written
now: why not a tab bar, what the shell owns, the hub's two ordering rules (doors low; live work
outranks planned work), the two reserved seats, what each app owns, You and Windmill One, four
honesty rules for the frame, what is held open, and a constants block. It matters more than a
missing file usually would, because the shell contract is what three products have to obey and a
contract that lives only inside a board is a contract nobody finds.

**0f — pricing.md.** Closed, and part of the entry's own description had itself gone stale: it
said §6's hero "still says 'No subscription, ever.'", which §6 had already stopped saying. What
was really left: the doc said **Pro** throughout, still carried the "all numbers below are still
open" hedge that entry 0 retired, and still guaranteed "on any pack" after packs were withdrawn.
All three are fixed, the numbers are stated as settled with the date and the owner, and §6's
"Not yet publishable" — false, since the page shipped — is replaced by the true status, which
opened **0n**. §1 later gained the account rule too (see 0o): the free 30 are 30 for a
signed-in account, and there is no anonymous tending.

## Closed — 2026-08-05 one appearance, both surfaces

**0q — web adopted the app-level appearance**, so the two surfaces now answer "who chooses light or
dark" the same way. Journal's per-device toggle is gone from the web tool rail too, and with it the
last place the product carried two controls for one thing.

What web needed that native did not: a **boundary**. The choice is stamped on the `/app` shell, not
on `<html>`, so the marketing family stays warm cream — a dark landing would be a different promise,
and 00-README's chrome rule says so. And the control sits **outside** the settings page's sign-in
gate: appearance is a preference of the device, not of an account, and asking someone to sign in to
turn on a lamp would be its own small dishonesty.

The registry seam carried the change: `scope.theme` now means a room PINS its skin — gym's
instrument steel does, journal no longer does — and a room that pins nothing follows the app. That
is the same sentence `guidelines/superapp-shell.md` §5 makes for native ("a room owns its palette,
not the choice"), which is the point: one rule, two statements of it, and neither surface is the
odd one out.

## Closed — 2026-08-04 the boards and the build met in the middle

**0o — the flow board's three wrong facts are fixed at source**, and unusually the board moved
further than the build did. `SuperappFlow.dc.html` now shows **Continue with Apple** as the primary
door with the emailed link beneath it, says **Windmill One**, and — instead of promising a free
tending allowance to a signed-out device — carries a card designing the way out: the template path
(starter quests, ready routines) is the floor and must reach a real artifact with **zero agent
calls**, while the agent path is **one attested run per device, ever**, behind App Attest,
IP-bucketed, not refunded on reinstall, falling back to the template path rather than to a sign-in
wall. That is a better answer than either the build or this ledger had, and it turns an open
question into buildable work. It names its own consequence too: `pricing.md` §1 grants 30/month to
*accounts* and says nothing about anonymous devices, so pricing and backend still have to sign that
off — carried on the dogfood tree, not here.

**The journal first-run copy question resolved toward what ships.** The board now reads "Start
anywhere. Nothing here is graded." and "Nobody sees this but you." — the shipped web and native
copy — rather than the "How was today?" proposal it listed as open. Neither build had to change.

**Appearance is drawn now, and it works** (this reopens nothing; entry 0l closed on 2026-08-02
recording that it was deliberately absent). It was left out on the rule that a control which changes
nothing is worse than an absent one — the shell painted fixed clay tokens, so a Dark that darkened
nothing would have been exactly that. The ramp is adaptive now (`guidelines/superapp-shell.md` §6),
so Light · Dark · System sets the hub, the switcher, You, One and every sheet, while rooms keep
their own skin. Still NOT drawn: the plan meter, because this client has no entitlements call and a
meter that invented a number is still worse than the gap. That is recorded in `apps/ios/README.md`
as a build gap rather than here as a disagreement.

## Closed — 2026-08-02 journal §11 catches up with the native app

`journal/journal.md` §11 opened with "Journal ships as a web app; there is no native app in
this plan" — on the same day the native superapp shipped journal as its first built room.
Fixed in the wave that made it false, per the standing rule at the top of this file, rather
than left standing with a ledger note beside it.

§11 now names **four** shells instead of three. The native row states plainly what shipped
(the canvas, mood and energy, offline-first writing, claim-on-sign-in) and what did not
(search, voice, echoes, nudges, the week) — absence stated, never stubbed. The header status
line says where journal is live. Two consequences travelled with it: the native shell
inherits §11's *behaviour* rules and none of its *browser* ones (it can receive push with no
install offer to make, and has no address bar for the day chip to survive), and **"a position
is a URL" now carries a native caveat** — the app has no associated domain yet, so a
`/journal/2026-07-20` link opens the web, not the room. §10 gained one line: `roomChrome(_:)`
is the native statement of the rule that journal owns its surface inside its own scope.

## Closed — 2026-08-02 the paid layer is named

**Entry 0 — "Windmill Pro" vs "Windmill One" — is settled by the owner.** The subscription
is **Windmill One**, **$12 USD a month**. `journal/journal.md` §6 and the `gym/briefs` were
right; `marketing/guidelines/pricing.md` is the file that needs changing, and it should now
say Windmill One throughout (its $12 / 30-free / 300-included figures stand, and the "all
numbers below are still open" hedge goes).

The split ran straight through the build, along exactly the line this entry described. The
backend already agreed with the briefs — `Entitlements.h`, `EchoSweep`, `VoiceApi` and
`gym/ARCHITECTURE.md` all said One. It was the roadmap's account panel and every marketing
and legal surface that said Pro. All of them say One now: the brand root's FAQ structured
data and the SoftwareApplication Offer beside it, pricing.html, terms.html, refunds.html,
privacy.html, and the plan panel in every subscription state. The **live Paddle product was
renamed too** (`pro_01kxxp32w4mgbbss7tck870m1k`), which matters because its name is what a
customer reads at checkout and on the receipt — the one surface no repo edit could reach.
Its monthly price reads 1200 USD, confirming $12 independently.

Two related things went with it. pricing.html's **"numbers open"** badge is gone: honest
while the figure was provisional, the opposite once it is fixed. And the Paddle product's
own description still reads "Private roadmaps, a higher AI-import quota, and MCP headroom",
which describes an older shape of the paid layer than tending — left alone deliberately,
because it is a content decision rather than a rename. New entry **0j** records what closing
this does to 00-README's honesty rules 2 and 3, which were written for the freeze.

**Left one surface behind, found 2026-08-02:** the iOS shell board still says Pro. That is
entry **0l**.

## Closed — 2026-08-02 landing-family unify

The four landings were **three implementations**, and the drift was structural rather than
cosmetic. What the repo now ships, so the boards and the build agree:

- **One runtime.** `/journal` and `/gym` were self-contained static HTML under `public/`;
  they are React in the SPA now, one page per product under `products/<p>/marketing/`. The
  static ports of briefs 02 and 03 are deleted. Their copy, section order, numbers and
  vignette timings survived the port verbatim (proven by mechanical text diff against the
  deleted files) — this was a runtime move, not a redesign.
- **Why the move was forced, for the record:** roles 1 and 9 — the auth cluster contract
  and "signed-in visitors get their true state on the first frame" — are not implementable
  in static HTML. Those pages could only fake auth with a `localStorage` hint and hand the
  visitor off via a URL, and that hand-off was a live bug: a static Sign in link carrying a
  product fragment landed a signed-out visitor **inside the dark product app** with the
  modal portalled into it. Any future "just make it a static page" for a surface that must
  recognise a signed-in visitor will hit the same wall.
- **One chrome.** Roles 1, 8 and 9 are implemented once, product-neutrally, and all four
  landings wear it: 1280 frame, `24px clamp(20px,5vw,64px)` header, 22px/700 wordmark,
  14.5px/700 nav, the `1px × 16px` divider, and one footer shelf —
  Pricing · Privacy · Terms · Refunds · Changelog · Feedback, then
  Roadmap · Journal · Gym · Gallery · Connect. The eight static legal pages render the same
  chrome from one emitted stylesheet rather than eight hand-copied blocks, so the two
  runtimes can no longer drift apart by a pixel.
- **Fonts.** Every static page declared `--font-display: 'Baloo 2'` and never loaded a font
  file — the faces are self-hosted and were imported only from the SPA entry — so half the
  site silently rendered in a system fallback. It was invisible in code and obvious in a
  screenshot. The pages now link an emitted `/fonts.css`.
- **Gym's state word** is derived from the product registry, so the brand root and the gym
  landing cannot disagree about whether gym is "In design".

Entries **0g**, **0h** and **0i** above were opened by this wave: three things it found and
deliberately did not decide on its own authority.

## Closed — 2026-08-01 landing-family build

- **Journal's shipped status (old 0e)**: journal is built and live — the web SPA serves
  `#/journal` and the landing shipped at windmill.works/journal. `journal/journal.md`'s
  status line now says so. The landing badge "Now open" is true; no fallback needed.

## Closed — 2026-07-31 curation pass

- **Lamp ramp mirror was stale** (old §1): marketing carried the pre-revision ramp
  (`--lamp-400:#E3B341`…). Root's revised ramp — the values the shipped journal surface
  uses (`--lamp-400:#E0B972`, `--lamp-600:#986B1E`) — re-copied into
  `marketing/tokens/colors.css`. Fixed by re-mirror.
- **`[data-brand="journal"]` graduated to root** (old §2): the night-default sibling —
  candle lamp on a cool dusk, the full 12-step dusk neutral ramp under its dark scope —
  existed only in the marketing mirror. Root `themes/brands.css` now carries it (clay /
  plum / iris / journal), and the neutral-ramp exception it depends on is canon:
  `guidelines/system-architecture.md` §4a. Marketing re-mirrored from root, so the two
  files are byte-identical again.
- **Journal's token fork removed** (old §3): its one gain — the reduced-motion guard that
  freezes `wm-ember` at mid-breath — graduated into root `tokens/motion.css`. The copies
  themselves (`journal/src/`) were deleted: the journal boards already load the root kit
  (`../tokens/…`), nothing in the project referenced them, and the repo owns the shipped
  copies. One deliberate mirror (marketing) is enough.
- **Two product cards never compiled**: `roadmap/components/tree/tree.card.html` and
  `roadmap/guidelines/colors-node-states.card.html` had a saved-in host preamble above the
  `@dsCard` line, so the compiler skipped them (22 of 24 cards). Comment moved to line 1;
  both — plus the app kit card — regrouped under **Roadmap**, so the Design System tab
  reads as brand foundations + one group per product.
- **Artifacts discarded**: the brand-brief print-export copy
  (`…-print-1uteu5h.html`) and `journal/scraps/` (unreferenced screenshots).
- **Merge-time reference fixes** (old §6, done at merge): gym/journal boards
  `_ds/…/` → `../`; roadmap boards gained one `../`; marketing's dangling roadmap links
  resolve via `../../../roadmap/explorations/…`. `_ds_manifest.json` is regenerated from
  the merged layout (the hand-patched interim copy is gone); `_adherence.oxlintrc.json`
  stays generated and untouched.
