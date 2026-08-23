# Windmill — Design briefs · grounded against the Windmill Design System

> **Gym's briefs are at `docs/design/gym/briefs/`.** Written 2026-07-29 into
> their own "Gym workout plan" project (`7f9591c1…`), which the 2026-07-31 merge tombstoned —
> everything now lives in `docs/design/` beside roadmap's, journal's and marketing's. The set is
> `00-README` plus context and G1–G8: the set logger (G1), the scoped palette (G2), the log (G3),
> routines and the plan snapshot (G4), the PR moment (G5), the connected log / MCP wedge (G6),
> the strength tree (G7), and the web as mirror (G8, added after the 2026-08-02 two-surface
> split). No gym canon existed to reconcile against, so every one is a creation brief rather than
> a build-from-spec pointer. The plan behind them is `docs/PRODUCT_LOG.md` → "Gym — the third
> product"; the inventory they were written from is `docs/lift-dossier.md`.
>
> **Their `00-README` status block is stale** (checked 2026-08-07): it calls G4–G7 unbuilt and G8
> untouched, when routines, the finish, the log, a movement's record, the fix-it path, settings,
> proposals, Ask, the backfill door and seventeen MCP tools all ship. (Statistics as a surface was
> RETIRED on 2026-08-12 — the engine stays, the tab does not — and the coach panel became Ask.) Read the repo for what exists; read the briefs for what was designed.

The design canon has been in two halves since 2026-08-23: the **written** half — guidelines,
briefs and the consistency ledger — is at `docs/design/`, and the **drawn** half is five Figma
files (Design System `qoOwNbWOYE1GFi0yR5uGY2` · Roadmap `HM4d8YWzJZg5clVRJKNuDr` · Journal
`pC6ciOUnfLmI42oMihd7l3` · Gym `vdmdiKWrmZoS1FtcvJRf6O` · Marketing `uWLMdVmzTcobOh8hbeem81`).
The spec codes (X1–X7, F1–F17) still name the same things. This
doc reconciles the growth plan (dogfood tree `t_9362d9bc883e0a1e`) against that canon:
**most of what engineering needs next is already designed** — the real design queue is
short. Node annotations in the tree carry the engineering side; this doc is the
design-facing half.

---

## Part 1 — Already designed: build from spec, don't re-brief

These growth nodes have canon in the design system. Engineering pulls the spec; design
involvement is review, not creation.

| Growth node | Canon | Notes / deltas |
|---|---|---|
| `anon-first-tree` | **X6 `guidelines/auth.md`** — "claiming, not gating" | The whole flow is decided: signed-out is the product's normal state, adoption is additive and uncelebrated (the claim beat: seat wake 480ms, chip gold→olive→silence), cross-device is a feature not an edge case. Engineering note: X6 also expects the verify tab to restore place and the original tab to wake its seat — neither is built. |
| `settings-seat` | **X6 §5** — windmill.works/settings, four sections | Profile · Connected tools · Sessions & devices · Your data (export = .zip of .md in F3's paste grammar — trust as a round trip; delete = typed email, 30-day grace, undo = sign in). Deltas to design: the spec predates reminders — the reminder prefs (slot, timezone, pause/resume) need a home in section layout; and the signed-token **pause-confirm page** (one click from the email footer, no login) is unspec'd. |
| `paste-import` | **F3 `guidelines/paste-import.md`** | The door (⌘V on the bud canvas), the composer, the 8-rule parse grammar, arrival = ceremony #3, never-a-wall rules. Also defines the export format (X6's .zip round-trips through it). |
| `playable-demo` | **F4 `guidelines/playable-demo.md`** | Hosted playable demo staged 6/17, the coach chip ("one, ever"), first-run choreography, fork = re-planting with progress cleared — which the shipped fork already honors. |
| `quest-picker` | **F5 `guidelines/starter-quests.md`** | The first-run shelf, seed-packet card, nine-quest roster, card→plant = ceremony #3. |
| `mcp-listing` | **F17 `guidelines/mcp-connect.md`** | The connect workbench, OAuth grant, directory card + README. Delta: spec says `mcp.windmill.works`; production collapsed to `windmill.works/mcp` — spec needs the one-line update. |
| Share pages / mobile | **X5 `guidelines/responsive.md`** | Hosted share-page chrome, fork-on-phone, gallery rules — the shipped read-only surface implements this. |
| Reminder email | **X7 `guidelines/email.md`** + `ui_kits/email/reminder.html` | Shell, from-lines, unsubscribe rule (reminders only, never auth) all decided. |

## Part 2 — The actual design asks

~~**D1 · OG hero card + app icons + trust pages**~~ — **delivered.** `web/public/` holds
`og-image.png` (1200×630), `apple-touch-icon.png`, `favicon.ico`, `icon-192.png` /
`icon-512.png` + `site.webmanifest`, and the `privacy.html` / `terms.html` /
`changelog.html` shells. Nothing left to design here.

**D2 · Quest log — the "next 3" frontier panel** — node `quest-log` · *now, fastest win* (no spec exists)
The return-visit surface, and the reminder email's deep-link target. A calm dock panel:
the derived ready-now set, up to 3 featured, fly-to-frontier on tap, on-open behavior when
steps are ready, the two empty states (all done vs. nothing unlocked), cohabitation with
the activity feed (event-log.md owns that chip). Explicitly out: streaks, XP, gamification
chrome — XP was dropped from the system in July; step counts are the progress language.

**D3 · Ceremony extensions** — nodes `milestone-share-beat`, `return-recap` · *next* (X1 extensions)
Two new moments composed from the motion doc's beats, both build-gated on measurement:
(a) after a milestone crown-pulse, a quiet toast offers the prefilled share card — never
modal, coalesced within the 2400ms budget, yields to input; define "milestone" visually;
(b) the return recap: reopening a tree with progress since last visit replays the earned
light — travel along completed edges, settle on the frontier; skippable, reduced-motion
honored. The bar: reward, not splash screen. Respect the calm ceiling (one infinite loop:
the crowned root).

**D4 · Fork-link mail + pause-confirm page** — nodes `fork-mail`, `settings-seat` · *next* (X7/X6 extensions)
(a) A fork-variant magic-link mail: when the link carries a pending fork it must say what
the click does — signs you in *and* plants a copy of {tree} in your trees (consent
clarity; today it's the generic sign-in mail). Same X7 shell. (b) The signed-token pause
page the reminder footer promises: one click, no login, instant calm confirmation, resume
affordance. (c) Small: the reminder prefs block inside X6 §5's settings layout.

**D5 · Type & mark — a decision, not a design task** · *decision, blocks server-rendered artifacts*
The system itself asks for this (readme): Baloo 2 / Nunito / JetBrains Mono are declared
Google-Fonts stand-ins, and no logo file exists (the "spinning millstones" concept was
never provided as an asset — per policy the system won't invent one). The upcoming
server-side per-tree OG renderer (`og-tree-cards`) hard-bakes type. Either supply licensed
fonts + a mark file, or formally bless the stand-ins and the wordmark-only lockup as brand.

## Part 3 — Repo ↔ system sync debts (from the system's own Jul 2026 audit)

- **Resolved repo-side already:** plum soft is `#D3ABC9` (theme.js typo fixed); node base
  56 ✓; RadialLayoutEngine is now the engine.
- **Open divergence to re-decide:** contract §5 wants *both* layout modes (radial ≤ ~48
  nodes, dagre top-down at scale) — the July layout sweep deleted the dagre/worker engine
  entirely along with the 5k perf dataset. Either update contract §5 to radial-only, or
  keep the scale mode as a future need. One of the two docs must move.
- **Still open repo-side:** the available-tier shader re-sync (white fruit + solid kind
  ring, no saturated fill), and re-copying `src/components/` + `tokens/colors.css` from
  the system (the repo holds stale pre-kind×tier forks).
- **Spec-side updates:** MCP endpoint moved to `windmill.works/mcp` (F17); X6's
  new-tab-restores-place / old-tab-wakes behaviors are unbuilt. The Google button is **no
  longer a placeholder** — `SignInDialog.jsx:131` navigates to `/v1/auth/google/start` and
  the backend serves the start + callback pair; if the auth spec still draws it disabled,
  that is spec-side drift and belongs in the canon's `consistency.md`.
