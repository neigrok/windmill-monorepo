# Brand foundations

The brand-level canon: the direction, the voice, the honesty rules, the visual foundations,
iconography, the standing policies on fonts and the logo, and the principles each product keeps.
Visual foundations live on the Foundations page of the Windmill · Design System Figma file; the
shipped token values are `web/src/styles/tokens/`. Product behaviour is the code's, and product
drawings are the Figma files'.

## Direction
- Minimalistic, animation-rich
- Light, airy base with a warm Tuscan earth palette (terracotta / olive / gold)
- Organic vine/branch metaphor
- Warm, rounded, friendly typography
- Soft, glowy motion (pulses, fades) rather than mechanical or bouncy
- Simple line icons (Lucide)

## Content fundamentals

- **Voice**: encouraging and a little playful, but not jokey. Copy stays domain-neutral — it
  works for a room makeover, a fitness goal, or a product launch alike.
- **Person**: second person ("your roadmap", "you unlock") in the product; first-person
  plural ("we") only in about/company copy.
- **Casing**: sentence case everywhere — headings, buttons, nav. No ALL-CAPS except tiny
  badge/eyebrow labels, which use small-caps-style letter-spacing instead of visual shouting.
- **Emoji**: not used. The metaphor is carried by icons and glow, not emoji.
- **How much**: `guidelines/text-budget.md` is canon for how many words an element may spend. The
  short of it — budget the chrome, never the content; a permanent caption is a design failure wearing
  a sentence; a long true notice is *less* honest than a short true one, because almost nobody reads
  it; and **salience and concreteness beat brevity**, so make the one fact that matters impossible to
  miss before you start cutting.
- **Sentence length**: short. One idea per sentence in UI copy; marketing copy allows one
  longer sentence per paragraph, max two clauses.

## Honesty

These hold on every surface and in every product. When one of them trades against revenue, the rule
wins.

### Accounts and sign-in

- **Login is never forced.** Signed out and signed in are both first-class states, and every screen
  is designed in both. An account adopts what is already on the device; it is never a gate in front
  of making it.
- **Everything done by hand works signed out** — writing, logging sets, building routines, planting
  steps, editing and every read. Nothing is disabled, dimmed or countdown-limited. Windmill One is
  never shown signed out.
- **The only unprompted mentions of signing in** are the quiet Sign in where a person starts (iOS
  Where to start?, the web's seat menu), the Keep offer after the first real thing, and You. An
  account verb the person starts — Share, Connect, Notes, a Coach question past the allowance —
  opens the same door and resumes the action after sign-in.
- **Never prompt** on launch, on a timer, after N edits, on exit intent, as a banner, as "save your
  work" or in urgency colours. Nothing counts declines.
- **Signing in keeps** what is on the device unless the person, asked, discards it.
- **The worst case of auth is the normal signed-out state.** No walls, no nudges, no performed
  security: safety is stated as specifics, and every failure ends in a next step.
- **For an owner, honesty is persistence.** A lapsed sign-in never takes work off the device:
  editing continues, saves go local, and the product says so (*Signed out — saved on this device*).
  Read-only is the remedy only for something that was never theirs, and then the edits already made
  are kept and offered a way forward (Fork).
- **Never say** *Warning*, *Log in to continue*, *Your changes could not be saved*, *Unsaved changes
  will be lost* or *You don't have permission*, and never answer a lost capability with a modal, red
  or a countdown. Brick stays reserved for deletion.

### Publishing

Making something public is its own explicit decision. Opening Share never changes visibility: the
owner publishes only after reading what it means — *Anyone can view and fork it, and it can appear
in the public gallery* — and success is announced only after the server confirms it. The disclosure
says **can appear**, never a promise of placement.

### Numbers and money

- **Never a number we don't have.** Counts come from real records. A meter, a digest line or a
  streak is drawn only when the data behind it is real. A failed read is unavailable, with Retry —
  never Free, never zero.
- **No urgency.** No countdown styling, no urgency colour, no *only 1 left*, AI allowance included.
  Never invent a countdown or offer an upgrade that cannot be bought.
- **The products stay useful without paid AI.** Hosted AI spends the individual's USD allowance;
  writing, editing, reading, on-device search and logging by hand never do. Existing work — a
  complete Echo passage — is never cropped or withheld to pressure an upgrade.

### Landings

1. The status badge states the product's true current state.
2. Landings carry no price numbers; `web/public/pricing.html` does. The paid layer is new power,
   never a re-sold default: absent rather than locked, no blurred previews, no counters of what you
   are missing, no "upgrade to unlock".
3. Attribution stays wherever content is adapted — the roadmap.sh CC BY-SA line.
4. Trust lines state true costs. "No account needed" appears only where it is true.
5. Composed specimens are labelled as such; nothing fictional reads as a usage claim, and composed
   writing stays mundane rather than confession-shaped.
6. Brick never appears on a landing; gold is flourish, never a state.
7. Brand-scope copy counts only open rooms as fact.

**The moat rule.** A landing's hero is a live, self-playing vignette built from the product's real
vocabulary — never a screenshot, stock or a static illustration. It autoplays only in the viewport
of a visible tab, mounts off the critical path, settles to a legible end state under reduced motion,
and is the page's one infinite-motion budget.

## Visual foundations

- **Colors**: warm Tuscan cream/sand canvas (`--neutral-50`, `#F9F5EB`) — never cold gray.
  Natural earth hues carry all brand/interactive meaning: **terracotta** (primary — CTAs),
  **olive** (available/success/growth), **gold** (ochre — warnings, small flourishes; a
  *kind*, never a state). Brick red is reserved for danger; a muted Tuscan-sky blue exists
  for info only. Nothing vivid or "chemical" — every hue is muted toward earth.
- **Theming (light + dark)**: light is the default. A full dark theme ships as a token layer
  scoped to `[data-theme="dark"]` — set it on `<html>` for the whole app, or on any element
  to darken just that subtree. Because every surface, border, text and glow token is
  redefined under that scope, all components adapt with no per-component work. Dark is a neutral
  near-black night (`#0B0B0C` canvas, `#171719` cards): slightly-elevated cards, warm off-white
  text, terracotta-400 as the brand step, and intensified glows. Each product room lights its own
  night under the same rules — journal a cool ink-black, gym a verdigris-grey stone.
- **Type**: two families. **Baloo 2** (rounded, bold, high personality) for display — page
  headers, big numbers. A product room's page title is Baloo 2 Bold 32px on a 40px line, 28px on
  a 36px line at narrow width, letter-spacing 0 (Gym Figma style `Gym/Web/Title`). **Nunito**
  (rounded, readable) for body/UI text. **JetBrains Mono** for count readouts ("6/17 done") and
  item IDs only — never for prose. **Caveat** is the ink-notes hand, used only for Journal's ink
  notes (the first-run notes under Product principles) and bundled in the app under the SIL Open Font License.
- **Spacing**: 4px base unit, scale runs 4→128px (`--space-1`…`--space-32`). Generous padding
  throughout — nothing feels cramped.
- **Backgrounds**: flat color, no photography, no gradients as backgrounds. The one gradient
  in the system is a two-stop terracotta→gold fill used only on a progress bar — a deliberate
  small flourish, not a motif.
- **Animation**: soft and glowy, never mechanical or bouncy. The full beat vocabulary,
  composition grammar, and calm ceiling are specified in `guidelines/motion-language.md` —
  treat that as canon for any animated moment.
  - Standard UI transitions: `--ease-standard` (150–280ms) for hover/press color changes.
  - Entrances: `--ease-soft` (expo-out), fade+rise (`wm-fade-in-up`) for panels, toasts,
    dropdowns.
  - `wm-pulse-node` is a colour-agnostic 2.4s breathing box-shadow loop that reads its glow
    from `--nd-glow`; `wm-ember` is the lower-amplitude sibling on the same clock, frozen at
    mid-breath under reduced motion. The calm ceiling — exactly one infinite loop on screen —
    is a motion-doc rule, and where those loops are spent is the consuming product's call.
  - No infinite decorative loops outside a product's own canvas.
- **Hover states**: backgrounds shift to a slightly darker neutral (`--surface-hover`) or the
  brand-soft tint for selected/active items — never pure opacity fades on solid fills.
- **Press states**: primary buttons scale to 0.97 (soft compress, not a bounce).
- **Borders**: 1–1.5px, always `--border-subtle`/`--border-default` (warm neutral), never
  pure black.
- **Shadows**: soft, warm-tinted, low-opacity (`rgba(33,27,19,…)`), 4 levels from `xs` to
  `lg`. A separate glow-shadow system (`--glow-olive`, `--glow-gold`, `--glow-terracotta`,
  `--glow-ember`) exists for products that light things up.
- **Corner radii**: generously rounded throughout — 8px (chips/inputs) up to 32px (large
  cards), full pill for buttons/tags/tabs.
- **Cards**: white surface, 24px radius, 1px subtle border, soft shadow; `hoverable` cards
  lift 2px and deepen their shadow on hover — no colored left-border accent.
- **Transparency/blur**: used only for the modal overlay (`--surface-overlay`, a translucent
  warm black) — no frosted-glass/backdrop-blur elsewhere.
- **Imagery**: the approved windmill logo carries the brand illustration; no photography exists
  for this brand.
- **The skill-tree metaphor** — node geometry, kind × tier colouring, connector behaviour and
  the layout contract — is the roadmap's, and lives in `roadmap/`. The palette it
  draws from (`--kind-*`, `--connector-*`, `--color-bark`, `--color-leaf`) stays here,
  because a sibling product re-points those hues rather than redefining them.

## Iconography

- **System**: [Lucide](https://lucide.dev) — simple, consistent 2px-stroke line icons, from the
  `lucide-react` package.
- **Usage**: the `Icon` wrapper (`web/src/design-system/Icon.jsx`). Components never bundle icons
  directly — `Button`/`IconButton` accept an `icon` prop so any icon source works.
- **Unicode glyphs**: used minimally for tiny UI chrome only (the `×` close glyph on
  Tag/Toast, the `▾` caret on Select) — not as illustrative icons.
- **Brand mark**: use the approved SVG logo described below; it is separate from UI iconography.

## Fonts

**Baloo 2**, **Nunito** and **JetBrains Mono** are Google-Fonts stand-ins, not licensed brand
fonts. They are self-hosted via `@fontsource`, imported in `web/src/styles/fonts.js`; the stacks
live in `web/src/styles/tokens/fonts.css`.

## Logo

The approved logo is [Windmill, node 9:129](https://www.figma.com/design/v21I1eIsWkyIaN7byJ8GdV/Windmill?node-id=9-129):
a four-colour windmill, cream house, olive hill and a terracotta "Windmill" wordmark in Baloo 2
Bold. Child node `9:108` is the standalone mark.

| Asset | Role |
|---|---|
| `web/public/brand-logo.svg` | Stacked lockup, wordmark outlined; native bounds 512 × 620. |
| `web/public/brand-mark.svg` | Compact mark, viewBox tightened around the artwork. |
| `web/public/favicon.svg`, `favicon-32.png`, `favicon.ico` | Browser identity derived from the mark. |
| `web/public/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | Install icons derived from the mark on a cream ground. |
| `apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml` | Adaptive-icon foreground keeping the mark's seven paths, colours and circular hub. |
| `apps/android/app/src/main/res/values/colors.xml` | Launcher background `ic_launcher_background = #F9F5EB`. |

- Use the exact Figma-exported vectors; preserve their shapes, colours and aspect ratio. Never
  redraw, recolour or animate the sails independently. There is no approved monochrome or
  alternative wordmark variant.
- `web/src/design-system/Brand.jsx` owns the web renderers: `BrandMark` (decorative mark),
  `BrandWordmark` (mark with readable brand text, for navigation) and `BrandLogo` (the stacked
  lockup, for standalone branding). Give each image explicit width and height; the full export
  keeps Figma's whitespace, so size the visible artwork deliberately.
- Keep the artwork's own colours on light and dark surfaces; the logo has no background of its own.
- Derive every raster icon from the compact SVG so geometry cannot drift between sizes.
- Email keeps a real-text wordmark so the header reads with images blocked.
- Android's adaptive icon is a 108 × 108dp vector foreground over a full-bleed cream background, one
  group at uniform scale `0.142` and translation `(23.044, 10.974)`, keeping the windmill and hill
  inside the centred 66dp safe circle. It supplies no monochrome layer; system themed icons may
  still recolour it. Launcher masks, small sizes and appearance variants need on-device review:
  tracking `windmill-native-logo` in tree `t_9362d9bc883e0a1e`.


## Product principles

What each product keeps whatever its screens become. Behaviour is the code's; these are the lines
a change must not cross.

### Roadmap

- **Colour and state are decoupled.** A node's hue comes from its kind — one of six palette hues
  (terracotta, olive, gold, brick, sky, plum). Progress is carried by treatment across three tiers:
  locked (dimmed), available, and complete (bright, with a halo that breathes only on the crowned
  root). The tier never re-hues a node.
- **Tokens are inherited, never forked.** Tokens and the product-neutral kit live in
  `web/src/styles/tokens/` and `web/src/design-system/`; change a token at its source, never in a
  product copy.

### Journal

The rules it does not break:

1. **Free-form or nothing.** No mandatory fields, no forced prompts. Any scaffolding is skippable in
   one gesture and never re-asks.
2. **Private, structurally.** No share control exists — not disabled, absent — and no share entity
   exists in the data model. Voice audio is discarded once transcription succeeds.
3. **No scoring.** No streaks, no percentage, no "you missed 3 days". A day not written is never
   coloured as failure. The product may *state* a pattern; it may not *grade* it.
4. **Observations must be true and countable.** Anything said back comes from the person's own words
   with the count visible. No interpretation, no advice.
5. **Power lives in the margins.** Trends, echoes, the week and voice history sit beside the canvas
   or one tap away — never between the person and the cursor.
6. **One nudge, at most.**
7. **The cursor never waits for motion.** Nothing animates before you can type.

What Journal is not: not a note-taking app (no folders, documents, wiki links or titles); not a
habit tracker (no goals, no chains); not a therapist (it never interprets, advises or reassures);
not social (no sharing, no export-to-post, no gallery); and **not a feeder for the tree** —
reflections do not become steps, and no agent reads the pages to plan a roadmap.

**The two scales.** Mood and energy, each 0–10, are optional forever. **0 is a real answer**; unset
is a third state, stored as SQL `NULL`, and set-but-zero is distinguishable from unset everywhere a
value is drawn. The rules that keep them honest:

1. **A zero pays exactly what a ten pays.** Motion strength follows `|v−5|/5`; no direction is
   rewarded more.
2. **Both ends of both scales carry a named event** of equal duration and equal permanence of mark,
   different in texture. Never build one end's event without the other's.
3. **Every end carries a permanent mark, and the middle carries none.** Values 1–9 rest unmarked.
4. **The numeral is never dressed up** — one lamp colour at every set value.
5. **No streak, no scarcity, no combination bonus.** 10/10 gets nothing 0/0 doesn't.
6. **You cannot farm it.** Re-committing the value already set fires nothing.
7. **No copy praises a value.** No "nice", no "great day", no emoji, no sound.
8. **Nothing reacts to the combination of the two values.** The interface never interprets.

**The first run.** Journal opens on a live page with hand-drawn ink notes over the real canvas, once
per install, only on a first open with no pages. The notes never block writing — the first keystroke
or tap lifts them, and nothing brings them back — and they point only at what is on that screen and
works. There is no overlay, no coach marks, no tour. A person arriving with written pages sees no
re-onboarding. The first run's only job is to get one page written and be worth reopening.

### Gym

- **The model proposes, the human applies.** A change to an existing routine is a proposal the lifter
  applies; no tool applies one, at any grant level. Coach creates a routine only when the lifter asks,
  with a truthful creation receipt, and appends to Notes what the lifter states.
- **Coach never** logs, fixes or deletes a set, finishes or discards a workout, or writes a
  bodyweight, at any grant level: a weigh-in is a fact only the lifter observed. Bodyweight is
  read-only to Coach.
- **Coach waits to be asked.** Beyond its first-open greeting it never speaks first: no check-in, no
  unread badge, count or notification. During a workout it answers from a sheet over it, and the
  routine changes it proposes there apply next time. No grades, no streaks; factual progress stays
  apart from supportive conversation.
- **A set note is a record; a note is directive.** Lifter-typed set notes are data, never
  instruction. Notes are written for Coach, and Coach follows them.
- **The read receipt is always visible**, under four rules: counts are by identity, so one workout
  read twice is one workout; a summary claims only what it named; a refused read counts nothing; and
  a reply that read nothing says so in words — never *read 0 sets*.
- **A limit is said once**, with the server's accurate reason and the recovery that exists; the draft
  is kept, and there is no countdown.
- **Progress refuses every number it lacks.** No line across a gap, no moving average, fitted trend,
  projection, goal line, percent change, arrow, green or red. Bodyweight draws no goal line,
  projection, BMI or body-fat estimate, and congratulates or alarms on no direction. The e1RM and
  new-best rules are the shared vectors (`packages/api-contract/gym/domain/training-reads.json`,
  `GymEstimate` and `ProgressRecords`).
- **The phone owns the open workout.** The web never finishes a live session; one workout is open
  per account.
- **Vocabulary.** Never *tracker*, *fitness*, XP, levels, badges or streaks. *Coach* names the room
  and nothing else; the link handed to a human coach is *Share this workout*.

---

### Components
Avatar, Badge, Button, Card, Checkbox, Dialog, IconButton, Input, Radio, Select, Switch,
Tabs, Tag, Toast, Tooltip.

The Windmill-specific families — **SkillNode**, **SkillConnector**, **Checklist**,
**KindLegend**, **ProgressBar** — live with the roadmap product
(`web/src/products/roadmap/ui/tree/`): they are the roadmap's vocabulary, not the brand's. If
journal or gym needs a generic progress bar, author one here rather than reaching across.
