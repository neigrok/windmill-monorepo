# Windmill Journal — the introspection surface (J1)

Journal is the second room in the Windmill superapp. Trees are how you plan what to do;
Journal is how you notice what happened. It is a peer of the tree canvas in the nav, not a
panel inside it: neither room requires the other.

**Canon:** this file, `scales.md` (the mood/energy control, its ramp, its motion ladder) and
`onboarding.md`. The `--lamp-*` ramp lives in `web/src/styles/tokens/colors.css`; the night
skin that uses it is scoped to the product, in `web/src/products/journal/journal.css`.

---

## 1. What it is

A free-form daily surface for self-reflection. No fields, no required prompts. **It is one
continuous canvas, not a set of pages** — oldest at the top, today at the bottom, the cursor
waiting where you left it. Scrolling up is going back.

Two optional scales — mood and energy, each 0–10 — are the only structure the product asks
for, and skipping them costs nothing. They are asked in words exactly once ever, on the first
page saved ("How did today feel?" · "Mood is what you see when you zoom out to the year." ·
skip), and after that they are a strip you may ignore forever.

Everything the product knows, it learned from what you already wrote.

## 2. Who it's for

Someone who already keeps — or keeps failing to keep — a journal. They write in short
sessions, usually once, usually late. The product's job is to be open when they get there and
to have something true to say when they look back.

## 3. The rules it does not break

1. **Free-form or nothing.** No mandatory fields, no forced prompts. Any scaffolding is
   skippable in one gesture and never re-asks.
2. **Private, structurally.** No share control exists in this surface — not disabled, not in
   a menu, absent. No share entity exists in the data model. Voice audio is discarded once
   transcription succeeds.
3. **No scoring.** No streaks, no percentage, no "you missed 3 days". A day you did not write
   is never coloured as failure. The product may *state* a pattern; it may not *grade* it.
4. **Observations must be true and countable.** Anything said back comes from the user's own
   words with the count visible. No interpretation, no advice.
5. **Power lives in the margins.** Trends, echoes, the week and voice history sit beside the
   canvas or one tap away — never between the user and the cursor.
6. **One nudge, at most.** See §7.
7. **The cursor never waits for motion.** Nothing animates before you can type.

## 4. The canvas

| Element | Rule |
|---|---|
| Order | Oldest at top, today at the bottom. Opening restores to the bottom, not animated |
| Day marker | Mono date + mood pip + energy tick, both quantised (`scales.md` §4); the tick carries a 1px baseline whenever energy is set at all, including 0. **Sticky**: pinned to the top edge on phone, held in a 74px gutter on desktop, while its day is under you |
| Month pill | Floats top-right, confirms month + year when you're deep in the past |
| Measure | 640px desktop, full width − 44px phone. Capped *before* the margin appears |
| Stillness | **The reading column never moves.** Above 1240px the echo margin's 300px is reserved space, held whether or not the panel has anything in it, and the measure centres in what is left. An echo arriving, leaving, or being scrolled past changes the panel's *content*; nothing may change the canvas's geometry, at any scroll speed |
| Zoom | Read → Skim → Year is one continuous compression of the same canvas, never three screens. Mood is the only thing that survives to Year — **quantised to five bands** (`scales.md` §4) |
| Gaps | **An unwritten day is not drawn at all** — the canvas is what you wrote, not a calendar with holes in it, and each marker's date shows the jump |
| Today | The last block; writing happens inline at the bottom, not in a composer |
| Mood & energy | **Two labelled rows, one per scale**, each a snapping scrubber over 0–10 — never a floating bar, never drawn twice on a screen. **0 is a real value**; unset is a separate state. **On phone the strip does not exist while the keyboard is up**; it arrives above the tab bar the instant the keyboard drops, fading in, never sliding. `scales.md` is canon for the control |
| Voice | One control, in the top bar beside search on both surfaces; no `ONE` badge on the control. Recording sheet → plain editable text, "Audio discarded" stated |
| Links | A URL in the writing is lamp and underlined wherever it appears, today included — under the composer it is paint on a layer over the field, so a tap still places the caret; on a past day it opens in a new tab. The grammar is conservative and shared by every surface (`packages/api-contract/journal-links.json`): an explicit `http(s)://` or a `www.`, never a bare `example.com`, because a false link inside a sentence is worse than a missed one. Nothing else in the writing is formatted — there is no markdown here |
| Saved state | Mono text, never a button or spinner |

## 5. Search — positions, not documents

Search is **semantic and on-device**: a feeling finds the passage that never used the word.
Every hit states why it matched ("close to · dread about the review"), and opening one **flies
the canvas to that spot with its neighbours intact**. It never opens a detail view.

**Threads** are derived semantic clusters (the review, sleep, Sam, walking). Selecting one
dims the rest of the canvas to 0.22 and leaves the trace lit. They are never stored as user
input; there is no tagging UI.

## 6. Echoes — behind Windmill One

An **echo** is Journal noticing that today repeats something you wrote months ago, and saying
so with the older line. It is marked `ONE` wherever it appears. Talk is gated the same way;
both read `Entitlements::hasWindmillOne` server-side.

- **Without One, echo marks are locked, not absent.** The lock is the *honest cut*: the mark,
  the count, the **real opening words** of the nearest passage, the withheld word count, and
  every match's date and distance. The One offer card carries the ask, one per page,
  dismissible with "Not now", which retires it for that page.
- **What the lock may never become.** No blurred or scrambled text standing in for words that
  exist, no fake preview, no count of what you're missing, no urgency, no expiry. Every
  character the cut shows is a character the reader wrote.
- If One lapses, existing echoes stay visible; new ones stop being computed. Nothing written
  is ever withdrawn.
- **The margin is a place, not a pop-up.** On desktop it is always there once the account has any echo at all, and when no page under the reading waterline has one it rests — the hairline and one true line, *No echo on this page.* It never fills with substitute content, never shows a spinner, and swapping from one page's ink to the next is a fade with a settle delay, so scrolling fast crosses pages without a strobe.
- Echoes are computed on write, not nightly. The nightly pass is the repair job
  (re-derivation after an edit, inbound edges, retries). The journal never speaks first — the
  trigger is always a page you wrote.

## 7. Nudges

One notification a day, at most, **adaptive by default**: the product learns the hour you
actually write and knocks then, drifting with you inside a bound you set (±15 min / ±30 min /
±1 hour).

The tuning surface **shows the rhythm it learned** — a histogram of your writing hours with
the chosen window marked — and states its own confidence ("Learning · 11 days"). Below 7 days
of data, adaptive is off and says so.

- Skip if already written, on by default. Never congratulate someone for showing up.
- The prompt never travels in the notification body.
- Channels: push · email · in-app only. Pause a week and turn off are one tap away.
- Never nudge about a lapse.

## 8. The weekly readout

A Sunday page you can read and close: mood and energy across seven days, the words that
recurred (counted), one line worth keeping, and the resurfaced entry from a year ago. It
states gaps plainly and then stops — no recommendation follows. It ends with *Close and write*.

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

House voice: sentence case, second person, short sentences, no emoji. **Journal drops the
game metaphor entirely** — nothing is unlocked, earned, or planted here.

## 10. Colour & motion

| Thing | Where it must live |
|---|---|
| Candle lamp — `--lamp-100/200/400/500/600`, `--lamp-glow` | design system, `web/src/styles/tokens/colors.css`. `--lamp-400` is `#E0B972`; `--lamp-600` is `#986B1E`, its counterpart on paper |
| The night skin — the surfaces the canvas floats on | the product, `web/src/products/journal/journal.css`, scoped to `.journal-root[data-theme]` |

- **Light or dark is not journal's choice**, on either surface. One Appearance setting —
  Light · Dark · System — chooses for the whole app (native: You; web: Account settings), and
  journal maps it onto its own palette: dark is the night canvas, light is the warm parchment.
  On web the choice scopes to the app surface (`/app`), never to the landings, which stay warm
  cream.
- **Journal owns its surface by overriding role tokens inside its own scope**, not by
  re-pointing the family's ramp. `.journal-root[data-theme='dark']` sets `--surface-canvas`
  and `--surface-card` directly, so the design system's ramps still resolve inside it while
  the shell, settings and the other two products are untouched. This is the house pattern; gym
  follows it. Native: `JournalSkin` is scoped to the room and `roomChrome(_:)` is the single
  value it reports outward, so the shell can dress the capsule it lays over the room.
- **No `data-brand` is involved.** `JournalApp.jsx` sets `data-theme` on `.journal-root`, and
  that is the whole wiring.
- The lit hue comes from `--lamp-*`, never from a kind token — journal has no kinds, and a
  product without kinds must not inherit kind vocabulary through its accent.
- Mood is one hue — a scale, not competing colours; energy is olive, one colour at every
  value. A day you didn't write is `--neutral-300`. Brick appears nowhere. The ramp, its bands
  and its motion ladder are `scales.md`.
- **Calm ceiling:** at most one infinite loop on screen at a time, and the scale ladder adds
  none — every scale event terminates. On **iOS** that one loop is today's breathing pip
  (`DayGlyphs.swift`); while recording, the waveform takes the slot and the pip goes static.
  On **web** there is currently none: the canvas draws no glyphs at all for today
  (`DayMarker.jsx`), so there is no dot to breathe, and `wm-ember` belongs to the shell rather
  than to journal. This line named the iOS ember as though it were both surfaces' until
  2026-08-23; the divergence underneath — today's marker drawing glyphs on one surface and not
  the other — is filed in `consistency.md` 1j and is not settled here.
- Entrances are `wm-fade-in-up` / `--ease-soft`; state changes are 180–240ms `--ease-standard`.
- **Nothing bounces.** The one overshoot the product owns, `--journal-ease-catch`, is a single
  soft overshoot with no oscillation; no springs, no elastic, anywhere.
- **Nothing celebrates.** The ends of a scale fire a named moment — wordless, soundless,
  counting nothing, and as loud at 0 as at 10, so a scale never pays more for a higher number.

## 11. Surfaces

One product, four shells:

| Shell | What it is |
|---|---|
| **Installed (PWA)** | The reference web experience. Push, app icon, no browser chrome |
| **Mobile web** | Same canvas inside browser chrome. The app's tab bar sits *above* the browser toolbar; one install offer, stating plainly that a tab can't receive nudges |
| **Desktop web** | Gutter + scroll-following margin + month rail, ⌘K, select-to-search, print |
| **Native (iOS)** | The journal room inside the Windmill superapp (`apps/ios`), entered from the hub. Same canvas, same canon. The shell owns two seats and nothing else — the capsule top-left and the You seat at the end of journal's own bar; journal owns everything below them, including the night default. Carries the canvas, mood/energy, offline-first writing and claim-on-sign-in; search, voice, echoes, nudges and the week are not there, and their absence is stated rather than stubbed |

Phone is primary. Breakpoints: 744 / 1024 / 1440.

**A position is a URL.** `/journal` (today), `/journal/<date>` (that day, in the canvas,
neighbours intact), `/journal/search?q=`, `/journal/thread/…`, `/journal/week/<iso-week>`,
`/journal/year/<year>`. Scrolling rewrites the URL by replace, so reload lands where you were
reading. **No route is public** — every one 404s for anyone but the owner, and none render a
share view. The iOS app has no associated domain, so a day link opens the web, not the room.

Browser rules that change behaviour, not layout: nudges fall back to in-app + email in a tab
(the panel says so rather than showing a dead toggle); permission is requested only when the
user turns push on; the layout tracks `visualViewport`, never `vh`; the pinned day chip
anchors to the app header; search embeddings are computed in a worker and cached locally;
offline writing works and says "offline · saved here". The native shell inherits the
*behaviour* rules and none of the browser ones.

## 12. What Journal is not

Not a note-taking app: no folders, no documents, no wiki links, no titles. Not a habit
tracker: no goals, no chains. Not a therapist: it never interprets, advises, or reassures.
Not social: no sharing, no export-to-post, no gallery. **Not a feeder for the tree** —
reflections do not become steps, and the agent does not read your pages to plan your roadmap.

---

**Open**

- Does a page seal at midnight (current answer: no)?
- Is the day spine enough at 400+ pages, or does search need a home of its own?
