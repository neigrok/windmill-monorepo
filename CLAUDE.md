## Project

Windmill is one brand with three self-growth products:

- **roadmap** — an animated RPG skill tree, drawn by a hand-rolled WebGL2 renderer (no three.js).
- **journal** — a night-canvas daily journal.
- **gym** — a training log.

One shared backend serves all three; each surface (web · iOS · Android) presents them as one
superapp behind one account and one paid line. Web carries all three products. iOS carries journal
and gym. Android carries gym only (Kotlin/Compose, modules `:app` `:platform` `:gym`).

The paid line — Windmill One — is one backend predicate, `Entitlements::hasWindmillOne`. It cannot
be bought: `paidPlansOpen()` in `web/src/shell/billing/checkout.js` returns `false`, so no surface
offers a checkout, and `BillingApi` answers 503 while no Paddle price id is configured.

This is a monorepo grouped by surface, then product. **Read `STRUCTURE.md` for the layout and the
one dependency rule** (platform is product-neutral; products depend on platform, never the reverse;
products never depend on each other). Each surface keeps its own `CLAUDE.md`/`NOTES.md`
(`backend/CLAUDE.md`, `web/CLAUDE.md`); each product documents itself in its own
`ARCHITECTURE.md`. The principles below apply brand-wide.

## Mission

Mission driven, not money driven: make people develop themselves. Be extremely honest with
customers — no dark patterns, no manufactured urgency, no copy that promises what the product does
not do. When a choice trades honesty or user growth for revenue, the mission wins.

## Information hygiene

Docs, comments, READMEs and product copy record the CURRENT state only — not how it used to be, not
why a decision was taken.

- No stale or wrong information anywhere. A stale line is worse than a missing one.
- When a change makes a line false, fix or delete it in the same change. Never pin a correction
  beside a wrong line.
- If the fix belongs to another owner, record it where that owner sees it —
  `docs/design/consistency.md` for design/canon drift, a dogfood-tree node for build work — and say
  so in your summary.
- Never write a claim you have not verified. "Tested", "fixed" and "works" mean you ran it. Name
  the part you could not verify, and why.

## Architecture & Design

Structure is the priority: it decides whether a system is buggy and hard to evolve or explicit and
easy to change. Good structure makes some bugs impossible. Spend the time to refactor so a solution
fits naturally, and leave the surrounding area better than the scope demanded.

- Optimize for the reader. Favor the obvious over the clever, readable over performant.
- Make structure explicit: a newcomer infers where things live from folder and file names alone.
- Push complexity to the edges, keep the core small. Business logic stays pure and
  dependency-light; I/O, vendors and frameworks live at the boundary.
- Put the bulk of the logic in the domain layer. An Action loads data through repositories, passes
  it to the domain layer, and persists the returned object via a Batch. If the domain logic needs
  more data, split it into two phases rather than loading from inside it.
- Keep the module dependency graph clear — entities do not depend on helper objects.
- Prefer composition over inheritance. Reserve inheritance for genuine interface/template
  relationships.
- Inject collaborators through constructors/factories, so tests substitute fakes with no patching.
- Write a function as an explicit, ordered, fail-fast pipeline that reads top to bottom.
- When implementations share a fixed sequence of steps, put the sequence on the shared abstract base
  and let each implementation override only the part that varies.
- Inline single-call-site indirection. A separate file needs more than one consumer, or a name that
  earns its place.
- Group a small self-contained feature area (one file format, one integration) under one
  feature-named package, parsing boundary included. Reserve the layered split for logic genuinely
  reused by more than one feature.

## Conventions

- Use constructors on entities instead of helper functions.
- API models: `Request` suffix inbound, `Response` suffix outbound.
- No docstrings, no multiline commentaries.
- Put an abstraction and its data structures in one file; each implementation gets its own file
  unless they are small enough to share one.
- Few, larger files. A class under 40 lines needs a good reason.
- Give each module one reason to exist. Group small related classes by kind in one predictable file
  (all DTOs together, all exceptions together).
- No private (underscore-prefixed) helper functions without a strong reason — inline the logic or
  fold it into the solution.

## Testing

- The test folder mirrors the project layout.
- Prefer full assertions over partial ones.

## Code Style

- In if-else, return early rather than assigning to a variable.

## Workflow

- Act autonomously; do not wait for approval on work that follows from the plan.
- Stage changes at the end of a phase. Commit and push both repos once a phase is implemented,
  reviewed and verified — house-voice messages, `Co-Authored-By` footer.
- Every wave goes through the gauntlet before it ships: adversarial review of the diff → one fix
  pass → e2e on the local stack (`.claude/skills/verify`) → push.
- Parallelize implementation across subagents: disjoint file territories, contract pinned in both
  prompts.
- For unbiased architecture advice, spin up an agent with no access to the code.
- After each phase, note observations that could improve structure or performance in a `.md` log,
  and act on the ones that matter most.
- Design canon is in two halves: `docs/design/` holds the written half (guidelines, briefs, the
  consistency ledger); five Figma files hold the drawings. Build from design specs where canon
  exists; file descriptive tasks to designers where it does not.
- `docs/PRODUCT_LOG.md` is the strategy narrative.
- Keep the running log of product progress in the Windmill dogfood tree (id `t_9362d9bc883e0a1e`)
  via the windmill MCP: create/connect nodes for new work, `set_progress` as it lands, inspect with
  `get_tree`/`get_diagnostics`. Bet id == node id; annotate outcomes and follow-ups on nodes. Every
  node carries a description — one or two sentences on what the work is and why — passed inline to
  `create_node` or backfilled with `annotate_node`.
