# Journal landing — brief 02

You are rebuilding `templates/landing-journal` on the family scaffold v2. The family contract — the nine roles, the moat rule, the honesty rules, fixed chrome — lives in `marketing/briefs-landings/00-README.md`; scaffold v2 itself is defined by `marketing/briefs-landings/01-roadmap-replica.md`. Neither is restated here. This brief spends its length on what only journal can decide: the window of night, the copy, and the things this page must refuse to say.

Product canon is `journal/journal.md` and it is binding on every line of copy. The existing board `journal/Journal Landing.dc.html` is the ancestor of the page live today — much of its copy survives (see "What survives" below), but the page it produced has three defects this rebuild must fix: it prices echoes at $12/month on the landing (price numbers live on pricing.html only, and that number is not settled), it has no live moat vignette at all (the one family role it is missing), and it predates the loop/beats structure.

## The claim

The H1 stays exactly: **"A place to notice what happened."** It is the right claim; do not workshop it.

Sub (one concrete-uses line, per role 2):

> One continuous canvas — oldest at the top, tonight at the bottom, the cursor already waiting. Write to understand yourself, not to score yourself.

Primary CTA: **Start writing** (this is also the nav CTA verb, role 1). Secondary CTA: **See how it works** — scrolls to the loop.

## Status badge and trust line

Both must be journal-true, and both carry a verification flag for the build side.

- **Status badge**: journal is shipped. Propose "Now open". Do not invent a beta program — journal has none. The badge renders through the `showStatus` prop pattern; if build-side verification finds sign-ups are not open to everyone, the fallback wording is "New".
- **Trust line under the CTAs**: do NOT copy roadmap's "No account needed" — it has not been verified for journal. The safe true line is about ownership and the missing share button:

  > Every page exports as Markdown. And there is no share button — not switched off, just not there.

  Flag to build: the export claim must be verified shipped before this line renders; if export is not live, the line drops to its second sentence alone. This is one flag governing every rendering of the export claim on the page — the "Only you" panel's export item (below) rises and falls with it.

## The moat: a window of night

This is the page's heart and the thing the live page is missing. The hero band is a rounded window into the canvas at night — the one place the night skin appears on the warm light page. It must feel like 11:40pm: unhurried, warm, zero ceremony.

**Skin scoping must be true**: the window carries the journal brand scope (`.journal-root[data-theme]`), dusk surface, text lit by the candle-lamp ramp (`--lamp-*`). No kind colours exist anywhere on this page — journal has no kinds. Mood is one hue in five steps; energy is olive; brick appears nowhere.

**Staging beats** (self-play, once per entry into the viewport; gating per the family moat rule in 00):

| Beat | Duration | What happens |
|---|---|---|
| 0 · settled in | on entry | The window already shows a page in progress: day marker "Thursday · 11:41pm" with a warm mood dot, one earlier line at reduced opacity, the cursor breathing |
| 1 · the line writes | ~10–12s | Tonight's line types itself, unhurried — roughly 12 characters a second with longer rests at punctuation (the line is ~120 characters; the arithmetic is the spec). Nothing else moves |
| 2 · the pause | ~1.5s | The cursor breathes alone |
| 3 · the echo | ~1s | An echo card blooms beneath the line (bloom beat, per `guidelines/motion-language.md`): the older line, then its honest why-line — **"you wrote something close · 212 days ago"** |
| 4 · the hold | ~4s, then done | Nothing further. The sequence is over; only the breathing cursor remains |

**The fictional lines.** Tonight's line: *"Took the long way home. The kitchen still smelled of coffee, and the light on the counter was worth the extra ten minutes."* The echo's older line: *"Walked back past the bakery for no reason except the light. Some detours are the point."*

**Fictional-content rule (binding)**: everything visible in the window must read as obviously composed — mundane-tender territory only (walks, kitchens, weather, light through a window). Never confession-shaped: no health, no relationships, no work crises, no money, no real names, no full dates a visitor could mistake for their own. The why-line's count stays visible and plausible; the product states patterns with the count showing, never interprets, and the vignette must model that. The moat window itself carries no "Example" label — it is staged theatre, not evidence; the proof slot is evidence, and it labels its composed content (see Proof).

**Calm-ceiling accounting**: the page's single infinite loop must be the breathing cursor inside this window, breathing at the same rhythm as wm-ember — the product's today-dot beat. Everything else on the page must be finite — the moat sequence plays once per viewport entry and does not idle-loop; the three loop scenes replay on click only; no ambient drift anywhere else.

**Reduced motion**: the sequence never plays. The window renders directly in its settled end state — full line present, echo card visible with its why-line, cursor static. The page must be complete and legible without a single frame of motion.

## The loop: three beats

Scaffold v2's 01/02/03 pattern, each a small live replayable scene. The night skin must stay singular to the moat — these scenes draw the canvas in its lit-day rendering on the family's light chrome. If `journal/journal.md` gives you no lit-day form of the canvas to draw, choose a workaround — e.g. the night canvas relit with the family's light tokens — use it consistently across all three scenes, and ledger it per entry 3. Draft copy, journal register:

**01 · Write**
> The cursor is already waiting. No prompts, no blank-page ritual — yesterday sits just above, a little dimmed, and you keep going from where you are.

Scene: a mini canvas, yesterday's last line at reduced opacity, cursor waiting; on replay, a few words type and stop.

**02 · Look back**
> The same canvas, pinched down to a year. Mood is what survives at that height. The days you didn't write stay gaps — drawn as gaps, counted at nobody.

Scene: the canvas compresses to a year band on replay; mood dots persist; visible empty stretches remain empty.

**03 · Hear it back**
> An echo, or the week, says something true — with the count visible. "Tired" appeared four times this week. It never interprets. It never advises.

Scene: a week card assembles on replay — seven mood/energy dots, one recurring word with its count, one line worth keeping, ending "Close and write".

## Proof: search by meaning

The proof slot is a search specimen, spec'd concretely:

- The rendered search sheet with the query **"felt behind"** already typed.
- One hit: a passage that never uses those words — *"Everyone at dinner seemed further along. I kept comparing timelines instead of tasting anything."*
- The hit's why-line, in the product's honest format: **"close to · measuring yourself against others"**.
- Neighbouring lines dimmed above and below the hit — opening a hit flies the canvas to the spot with neighbours intact; it is never a detail view, and the specimen must show that.
- A small **"Example"** label on the sheet — the family's composed-specimen treatment (brief 03 captions its specimens the same way); journal never presents fictional writing as anyone's real page.
- The caption line, verbatim: **"Search runs on your device. Your pages never leave it."**

Static render is the default; a click-triggered replay that types the query is welcome, but it must not idle-loop.

## Trust: "Only you"

Journal's role-5 panel **replaces** the family's agent/MCP panel, and the brief is explicit about why: journal is not a feeder for the tree — the agent does not read your pages, and this landing says so plainly. The can't-column is the crown jewel of the page. Section title: **Only you**.

Can:
- Write on anything with a browser — install it as an app on your phone.
- Export every page as Markdown, any time. (Governed by the same build-side verification flag as the hero trust line — one flag, both renderings; if export is not live, this item is cut and the trust line falls back per the hero spec.)
- Search by meaning without your pages leaving your device.

Talk does not appear in the Can column — the shipped product gates it behind the paid layer, and a Can item would present it as a free default. Its only trust-panel appearance is the Can't item below; its capability is named in the paid-layer section, where its gating is honest.

Can't (mandatory, and phrased as structure, not policy):
- **Share a page.** There is no share button — not hidden, not disabled. The data model has no share in it.
- **Keep your voice.** Talk audio is discarded the moment the text lands.
- **Feed the tree.** The agent that helps with your roadmap does not read this room.
- **Train on your writing.** Nothing you write teaches anything.

## Why Windmill

Swap the family's "Share a tree" item — it would be untrue here, and nothing on this page may imply sharing or social. Journal runs the duo:

- **One account, three rooms.** Roadmap and Journal today, Gym when it opens — one account and one subscription across them all. No separate sign-ups, no bundle math.
- **Everywhere you are.** Phone on the nightstand at 11:40pm, desk on Sunday morning. The canvas is the same canvas wherever you open it.

## The paid layer, named honestly

Echoes get their section — they are the product's most human feature and the paid thing, and both facts appear without a price. Draft copy:

> **Echoes.** When tonight rhymes with something you wrote months ago, Journal says it back — the older line itself, and the distance: "you wrote something close · 212 days ago". It never interprets. It just remembers with you.
>
> Echoes come with the paid layer — and talk, where the product gates it. Without it they are simply not there; the canvas just stays quiet. If it ever lapses, the echoes you have stay yours.

Rules this section must uphold: no price numbers anywhere on the landing (the live page's "$12/month" dies in this rebuild); absent-not-locked framing per canon — no blurred previews, no locked marks, no counters of what you're missing — kept as rules for you, never rendered as page copy (the vocabulary guard bans the unlock family from every visible string); the paid layer is referred to generically, never named Pro or One (see ledger). Talk must not appear anywhere on the page as a free default — its gating honesty lives here, and its only other appearance is the trust panel's Can't item ("Keep your voice").

## CTA band and recognition

CTA band repeats **Start writing** with a time-honest, tonight-shaped line — never "unlock", never ceremony:

> The cursor is already waiting. Tonight's page can be three lines.

Recognition (role 9): signed-in visitors get their true state on the first frame; journal's resume verb is **Open journal**.

## Vocabulary guard

The journal.md table is binding on every visible string, including alt text and scene labels:

| Say | Never |
|---|---|
| page | entry, note |
| the canvas | feed, timeline |
| write | journal (as a verb), log |
| nudge | reminder, alert |
| echo | insight, pattern |
| thread | tag |
| the week | digest, recap |
| talk | record, dictate |
| "Only you" | private, secure, encrypted |

The game metaphor is out entirely — nothing on this page is unlocked, earned, planted, or levelled. No streaks, no "you missed", no scoring language anywhere, including in praise.

## What survives, what gets rebuilt

From `journal/Journal Landing.dc.html`, harvest the copy that is canon-true — and land each block in its named slot: the daily-loop lines (yesterday above at reduced opacity) fold into loop 01; one-canvas zoom-to-year into loop 02; the "felt behind" search example into the proof specimen; the privacy block into "Only you". Where harvested copy and this brief's draft copy overlap, this brief's copy wins. Mood/energy as two skippable taps and nudges (one a day at most, learned hour, never about a lapse) survive as facts informing the scenes and alt text — mood dots in loop 02, the week card in loop 03 — not as standalone sections; the family scaffold has no slot for them and you do not invent one. What dies with the old page: the $12/month echoes price, talk presented as a free default, and the text-only hero.

`templates/landing-journal` is rebuilt on scaffold v2 per `marketing/briefs-landings/01-roadmap-replica.md` — `data-brand` journal, `showStatus` prop carried. Cross-links to the sibling templates and the marketing kit are kept working, and the inbound links from `templates/landing-main` must survive too (00 requires it, even though landing-main itself is out of scope). Note the shipped page 01 replicates carries neither the family cross-nav (Roadmap · Journal · Gym · Pricing) nor the footer product cross-links — 01 already rules that 00 wins and layers both onto its board, with the divergence ledgered. This page carries both the same way; if you find 01's board missing them, that is a defect in 01's execution, not a licence to drop them here.

## Ledger entries

Brief 01 lands first and owns creating the Pro-vs-One entry and the shipped-page chrome entries — check they exist and append rather than duplicate. This brief adds two of its own:

1. **Paid set drift** — journal.md names echoes as the paid thing; the shipped product also gates talk. Landing wording is "echoes — and talk, where the product gates it". Open; settled by pricing.md. Append this to 01's Pro-vs-One entry rather than opening a second naming entry.
2. **Canvas day rendering** — only if the loop scenes surface a gap (no lit-day form of the canvas exists to draw), ledger it with the workaround you chose.

## Must be true before you hand it back

- The night skin appears exactly once on the page — inside the moat window.
- The breathing cursor is the page's only infinite loop; the moat sequence, loop scenes, and search replay are all finite.
- Reduced motion renders the settled moat — line complete, echo visible, cursor static.
- No price number appears anywhere; the paid layer is absent-not-locked and never named Pro or One.
- No language implying share, social, agent-integration, or game features exist — the "Only you" Can't-list's structural denials are the only place those words appear.
- Family cross-nav and footer product cross-links are present per 00 (see the scaffold note above).
- Status badge, trust line, and the Can-column export item carry their verification flags for the build side.
- Every visible string passes the vocabulary table.
