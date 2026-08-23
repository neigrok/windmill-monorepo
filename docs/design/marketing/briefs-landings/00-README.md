# Landing family

Three product landings — roadmap, journal, gym — share one skeleton and one set of rules.
Each is built under `web/src/products/<product>/marketing/`; the shared chrome and the brand
root's own landing are in `web/src/shell/marketing/`.

## The nine roles

Every product landing fills all nine.

| # | Role | Fixed across the family | The product's own |
|---|------|------------------------|-------------------|
| 1 | Nav | wordmark → brand root; cross-nav (Roadmap · Journal · Gym · Pricing); auth cluster (resolving slot keeps its box; link-sent chip; signed-in seat) | primary CTA verb |
| 2 | Hero | status badge · H1 claim · one concrete-uses sub · primary + secondary CTA · trust line · the moat band beneath | the claim, the voice, the moat's content and skin |
| 3 | The loop | 01/02/03, each a small live replayable scene + title + two lines | the product's core loop |
| 4 | Proof | one section of evidence with real numbers and honest attribution | quests · search specimen · the movement shelf |
| 5 | Trust boundary | a can + can't panel; the can't-line is mandatory | which boundary matters (agent · privacy · diff-gate) |
| 6 | Why Windmill | brand-level duo or trio; icon + title + copy | swap any item that would be untrue for the product |
| 7 | CTA band | repeat primary CTA + a time-honest line | the promise |
| 8 | Footer | legal shelf (Pricing · Privacy · Terms · Refunds · Changelog) + Feedback door + product cross-links + © | — |
| 9 | Recognition | signed-in visitors get their true state on the first frame; never claim zero while auth resolves | resume verb |

## The moat rule

Role 2's heart. The hero band is a live, self-playing vignette built from the product's real
vocabulary — never a screenshot, never stock, never a static illustration.

- Autoplay only in-viewport and in a visible tab.
- Defer the mount off the critical path.
- Settle to a legible end-state under `prefers-reduced-motion`.
- It is the page's one infinite-motion budget — the calm ceiling of
  `guidelines/motion-language.md`. Every other scene is finite or replay-on-click.

## Chrome and register

Page chrome is light for all three. A product may open a window of its own skin inside the
moat; the page around that window stays the family's warm cream. Type scale, 96px section
starts, the eyebrow/sectionTitle/sectionSub pattern, 744/1024 breakpoints, sentence case and
no emoji are fixed.

- Roadmap: ceremony and unlocking — the game metaphor at full volume.
- Journal: quiet and warm — zero game metaphor, and no kind colours (journal has no kinds).
  `journal/journal.md` vocabulary is binding (page, the canvas, write, nudge, echo, talk,
  "Only you").
- Gym: matter-of-fact — a tool that respects that you are tired and holding a bar. No XP,
  levels, badges, streaks, "fitness" or "coach". One quiet line for a PR.

## Honesty rules

1. The status badge states the product's true current state.
2. Landings carry no price numbers — that is `pricing.html`'s job
   (`marketing/guidelines/pricing.md`). A landing may name the paid layer as new power, never a
   re-sold default: absent-not-locked, no blurred previews, no counters of what you are
   missing, no "upgrade to unlock".
3. Attribution stays wherever content is adapted — the roadmap.sh CC BY-SA line.
4. Trust lines state true costs. "No account needed" is roadmap-true (the first tree lives in
   the browser); every other product states its own verified line.
5. Composed specimens are labelled as such; nothing fictional reads as a usage claim, and
   composed writing stays mundane rather than confession-shaped.
6. Brick never appears on these pages; gold is flourish, never a state.
7. Brand-scope copy counts only open rooms as fact.
