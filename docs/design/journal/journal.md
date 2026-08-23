# Windmill Journal — the introspection surface (J1)

Journal is the second room in the Windmill superapp. Trees are how you plan what
to do; Journal is how you notice what happened. It is a peer of the tree canvas
in the nav, not a panel inside it — you can use Windmill for a year without
opening it, and you can use Journal every night without owning a tree.

**Status:** designed Jul 2026; built and live on web (`#/journal` in the superapp; landing at windmill.works/journal since 2026-08-01) and in the native iOS superapp (`apps/ios`, since 2026-08-02 — the canvas; see §11).
**Canon:** screens, microinteractions and the data model live in
`Windmill Journal — System.dc.html`; explorations and rejected directions in
`Windmill Journal.dc.html`. The `--lamp-*` ramp lives in the **Windmill Design
System** project (`tokens/colors.css`); the night skin that uses it is scoped to
the product, in `web/src/products/journal/journal.css`.

---

## 1. What it is

A free-form daily surface for self-reflection. No fields, no required prompts.
**It is one continuous canvas, not a set of pages** — oldest at the top, today at
the bottom, the cursor waiting where you left it. Scrolling up is going back.
Two optional taps — mood and energy — are the only structure the product asks
for, and skipping them costs nothing. They are asked in words once, on the first
page saved ("How did today feel?" · "Mood is what you see when you zoom out to
the year." · skip), and after that they are a strip you may ignore forever.

Everything the product knows, it learned from what you already wrote: when you
tend to write, which words keep coming back, what you said a year ago.

## 2. Who it's for

Someone who already keeps — or keeps failing to keep — a journal. They don't want
a mood tracker with a text box attached, and they don't want a blank file in a
notes app either. They write in short sessions, usually once, usually late. The
product's job is to be open when they get there and to have something true to say
when they look back.

## 3. The rules it does not break

1. **Free-form or nothing.** No mandatory fields, no forced prompts. Any
   scaffolding is skippable in one gesture and never re-asks.
2. **Private, structurally.** No share control exists in this surface — not
   disabled, not in a menu, absent. No share entity exists in the data model.
   Voice audio is discarded once transcription succeeds.
3. **No scoring.** No streaks, no percentage, no "you missed 3 days". A day you
   did not write is never coloured as failure — and on the native canvas it is not
   drawn at all, which is the same rule taken one step further: a day that was
   never lived on the page cannot be counted, coloured, or apologised for. The
   product may *state* a pattern; it may not *grade* it.
4. **Observations must be true and countable.** Anything said back comes from the
   user's own words with the count visible. No interpretation, no advice.
5. **Power lives in the margins.** Trends, echoes, the week and voice history sit
   beside the canvas or one tap away — never between the user and the cursor.
6. **One nudge, at most.** See §7.
7. **The cursor never waits for motion.** Nothing animates before you can type.

## 4. The canvas

| Element | Rule |
|---|---|
| Order | Oldest at top, today at the bottom. Opening restores to the bottom, not animated |
| Day marker | Mono date + mood dot + energy tick. **Sticky**: pinned to the top edge on phone, held in a 74px gutter on desktop, while its day is under you |
| Month pill | Floats top-right, confirms month + year when you're deep in the past |
| Measure | 640px desktop, full width − 44px phone. Capped *before* the margin appears |
| Zoom | Read → Skim → Year is one continuous compression of the same canvas, never three screens. Mood is the only thing that survives to Year |
| Gaps | **Native: an unwritten day is not drawn at all** (2026-08-04) — the canvas is what you wrote, not a calendar with holes in it, and each marker's date still shows the jump. Web still draws a hollow dot + "nothing written" at 50% ink; the two surfaces disagree and the ledger carries it |
| Today | The last block; writing happens inline at the bottom, not in a composer |
| Mood & energy | **One anchored 44px strip**, never a floating bar and never drawn twice on a screen: five mood steps, a hairline, energy as one cycling target on phone (three separate ones on desktop), then a single word naming whatever you last set. **On phone it does not exist while the keyboard is up** — mood is not answered mid-sentence, and nothing may sit between the caret and the line; it arrives above the tab bar the instant the keyboard drops, fading in, never sliding; on desktop it collapses into today's day-marker row at 13px. Asked in words exactly **once ever** — on the first save, with the payoff sentence and a skip — and never again, for either value |
| Voice | One control, in the top bar beside search on **both** surfaces (2026-08-09; the floating 56px disc on phone is withdrawn, and the control carries no `ONE` badge). Recording sheet → plain editable text, "Audio discarded" stated |
| Saved state | Mono text, never a button or spinner |

## 5. Search — positions, not documents

Search is **semantic and on-device**: a feeling finds the passage that never used
the word. Every hit states why it matched ("close to · dread about the review"),
and opening one **flies the canvas to that spot with its neighbours intact**. It
never opens a detail view — that is the whole payoff of never paginating.

**Threads** are derived semantic clusters (the review, sleep, Sam, walking).
Selecting one dims the rest of the canvas to 0.22 and leaves the trace lit. They
are never stored as user input; there is no tagging UI.

## 6. Echoes — the one paid thing (One)

An **echo** is Journal noticing that today repeats something you wrote months ago,
and saying so with the older line. It is marked `ONE` wherever it appears.

**Why this is the honest line under `pricing.md`:** search runs locally over a
query you typed; an echo is a pass across your whole corpus, computed for you
without being asked. New power, not a re-sold default.

- **Without One, echo marks are locked, not absent** — owner ruling, 2026-08-09.
  A locked mark is a deliberate conversion surface, and the mechanism is the
  *honest cut*: the mark, the count, the **real opening words** of the nearest
  passage, the withheld word count, and every match's date and distance. The One
  offer card carries the ask, one per page, dismissible with "Not now", which
  retires it for that page. This replaces "absent, not locked", which hid the
  feature entirely and sold nothing.
- **What the lock may never become.** The cut is allowed to sell precisely because
  every character it shows is a character the reader wrote. So: no blurred or
  scrambled text standing in for words that exist, no fake preview, no count of
  what you're missing, no urgency and no expiry. A lock that converts on honest
  curiosity is the product working; one that converts on a trick is the thing this
  product exists to refuse.
- If One lapses, existing echoes stay visible; new ones stop being computed.
  Nothing written is ever withdrawn.

> **Open pricing decision.** One is currently defined as "a bigger tending
> allowance". Echoes are passive and cannot be metered per-run, so including them
> makes One *allowance + passive intelligence*. That is a change to `pricing.md`
> §3 and is not Journal's to make alone.

## 7. Nudges

One notification a day, at most, **adaptive by default**: the product learns the
hour you actually write and knocks then, drifting with you inside a bound you set
(±15 min / ±30 min / ±1 hour).

The tuning surface **shows the rhythm it learned** — a histogram of your writing
hours with the chosen window marked — and states its own confidence
("Learning · 11 days"). Below 7 days of data, adaptive is off and says so.

- Skip if already written, on by default. Never congratulate someone for showing up.
- The prompt never travels in the notification body. ("The house is quiet. Three minutes?")
- Channels: push · email · in-app only. Pause a week and turn off are one tap away.
- Never nudge about a lapse.

## 8. The weekly readout

A Sunday page you can read and close: mood and energy across seven days, the words
that recurred (counted), one line worth keeping, and the resurfaced entry from a
year ago. It states gaps plainly and then stops — no recommendation follows. It
ends with *Close and write*.

## 9. Vocabulary

| Say | Not |
|---|---|
| page | entry, note, log |
| the canvas | the feed, the timeline |
| write | journal (verb), log, capture |
| nudge | reminder, alert, notification |
| echo | insight, pattern, memory |
| thread | tag, topic, label |
| the week | weekly report, summary, digest |
| talk | record, dictate |
| Only you | private, secure, encrypted |

House voice unchanged: sentence case, second person, short sentences, no emoji.
**Journal drops the game metaphor entirely** — nothing is unlocked, earned, or
planted here. It is the one room where the RPG language is out of place.

## 10. Colour & motion

Night is the default expectation for this surface, so the night skin and the
Candle lamp were tuned here first. The *palette* graduated to the design system;
the *skin* stays scoped to the product.

**These must be true, and are checkable:**

| Thing | Where it must live |
|---|---|
| Candle lamp — `--lamp-100/200/400/500/600`, `--lamp-glow` | design system, `tokens/colors.css`. `--lamp-400` is `#E0B972` — the value the shipped skin uses — and `--lamp-600` is `#986B1E`, its counterpart on paper |
| The night skin — the surfaces the canvas floats on | the product, `web/src/products/journal/journal.css`, scoped to `.journal-root[data-theme]` |

- **Light or dark is not journal's choice** (2026-08-05), on either surface. One
  Appearance setting — Light · Dark · System — chooses for the whole app (native:
  You; web: Account settings), and journal maps it onto its own palette: dark is
  the night canvas, light is the warm parchment. Journal carried its own toggle in
  the tool rail on both surfaces until then, which meant the setting in settings
  could not reach the room and the app had two controls for one thing. **Night is
  still what this surface was designed as** — it is simply the app's dark that
  selects it now, rather than a switch in the rail. On web the choice scopes to the
  app surface (`/app`) and never to the landings, which stay warm cream by canon.
- **Journal owns its surface by overriding role tokens inside its own scope**, not
  by re-pointing the family's ramp. `.journal-root[data-theme='dark']` sets
  `--surface-canvas` and `--surface-card` directly, so the design system's ramps
  still resolve inside it while the shell, the account seat, settings and the
  other two products are untouched. This is the house pattern; gym follows it.
  The native app states the same rule in its own idiom: `JournalSkin` is scoped to
  the room, and `roomChrome(_:)` is the single value it reports outward so the
  superapp shell can dress the capsule it lays over the room.
- **No `data-brand` is involved.** `JournalApp.jsx` renders
  `className="journal-root" data-theme={theme}`, and that is the whole wiring.
- The lit hue comes from `--lamp-*`, never from a kind token. Journal has no kinds.
  `--lamp-*` is authored rather than aliased onto `--accent-gold-*` precisely
  because gold feeds `--kind-gold`, and a product without kinds must not inherit
  kind vocabulary through its accent.
- Mood is one hue in five steps — a scale, not five competing colours. Energy is
  olive. A day you didn't write is `--neutral-300`. Brick appears nowhere.
- **Calm ceiling:** exactly one infinite loop on screen — today's dot (`wm-ember`).
  While recording, the waveform takes that slot and the dot goes static.
- Full timing table (16 moments, with reduced-motion mapping) is §04 of the system
  file. Two constants: entrances are `wm-fade-in-up` / `--ease-soft`; state changes
  are 180–240ms `--ease-standard`. Nothing bounces, nothing celebrates.

## 11. Surfaces

**Journal ships on the web and in the native superapp.** One product, four shells:

| Shell | What it is |
|---|---|
| **Installed (PWA)** | The reference web experience — what the P-screens show. Push, app icon, no browser chrome |
| **Mobile web** | Same canvas inside browser chrome. The app's tab bar sits *above* the browser toolbar; one install offer that states plainly that a tab can't receive nudges |
| **Desktop web** | Gutter + scroll-following margin + month rail, ⌘K, select-to-search, print |
| **Native (iOS)** | The journal room inside the Windmill superapp (`apps/ios`), entered from the hub. Same canvas, same canon. The shell owns two seats in it and nothing else — the capsule top-left and the You seat at the end of journal's own bar (`templates/superapp-shell`); journal owns everything below them, including the night default. Shipped 2026-08-02 with the canvas, mood/energy, offline-first writing and claim-on-sign-in; search, voice, echoes, nudges and the week are **not there yet**, and their absence is stated rather than stubbed |

> This section said "there is no native app in this plan" until 2026-08-02. The
> native app is the change; the rest of §11 is what it was built from and is
> unchanged by it.

Phone is primary: P1 today · P2 scrolled back · P3 search · P4 talking ·
P5 transcript · P6 year · P7 nudges · P8 the week · P9 first run; web shells are
W1 desktop and W2 mobile. Breakpoints follow X5: 744 / 1024 / 1440.

**A position is a URL.** `/journal` (today), `/journal/2026-07-20` (that day, in
the canvas, neighbours intact), `/journal/search?q=`, `/journal/thread/…`,
`/journal/week/2026-W30`, `/journal/year/2026`. Scrolling rewrites the URL by
replace, so reload lands where you were reading. **No route is public** — every
one 404s for anyone but the owner, and none render a share view.

*Native caveat, true as of 2026-08-02:* the iOS app has no associated domain yet,
so a `/journal/2026-07-20` link opens the **web**, not the room. Until universal
links land, a position is a URL everywhere except into the app.

Browser rules that change behaviour, not layout: nudges fall back to in-app +
email in a tab (the panel says so rather than showing a dead toggle); permission
is requested only when the user turns push on; the layout tracks
`visualViewport`, never `vh`; the pinned day chip anchors to the app header so it
doesn't jump when the address bar collapses; search embeddings are computed in a
worker and cached locally; offline writing works and says "offline · saved here".
Full table in §07 of the system file. The native shell inherits the *behaviour*
rules and none of the browser ones: it can receive push with no install offer to
make, and there is no address bar for the day chip to survive.

## 12. What Journal is not

Not a note-taking app: no folders, no documents, no wiki links, no titles. Not a
habit tracker: no goals, no chains. Not a therapist: it never interprets, advises,
or reassures. Not social: no sharing, no export-to-post, no gallery. And it is
**not a feeder for the tree** — reflections do not become steps, and the agent
does not read your pages to plan your roadmap. If those two ever connect, it will
be because the user asked, explicitly, once, and can undo it.

---

**Open questions.** Does a page seal at midnight (current answer: no)? Is the day
spine enough at 400+ pages, or does search need a home of its own? And the §6
pricing change needs an owner.

**Answered 2026-08-09 — echoes are computed on write, not nightly.** The nightly
pass becomes the repair job (re-derivation after an edit, inbound edges, retries);
delivery moves onto the writer's own act, so an echo can appear in the session that
triggered it. The journal still never speaks first — the trigger is always a page
you wrote.
