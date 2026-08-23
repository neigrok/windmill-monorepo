## Project

Windmill is a brand of three self-growth products — **roadmap** (a highly animated RPG skill
tree, rendered with a hand-rolled WebGL2 renderer, no three.js), **journal** (a night-canvas
daily journal), and **gym** (training log) — served by one shared backend and presented as one
superapp per surface (web · iOS · Android), behind one account and one paid line. That paid line —
Windmill One — is one predicate in the backend (`Entitlements::hasWindmillOne`) and cannot be
bought: `paidPlansOpen()` in `web/src/shell/billing/checkout.js` returns a hardcoded `false`, so no
surface offers a checkout, and `BillingApi` 503s one anyway while no Paddle price id is configured.
Roadmap is the original product and journal shipped second; gym is BUILT on the backend, the web and
iOS through phase 2 — the log, the logger, routines, statistics, the coach share, CSV out and
sixteen MCP tools — and was OPENED on 2026-08-08 (`status: 'open'` in
`web/src/products/gym/routes.js`). Open means reachable, not vetted: the phase-1 dogfood gate has
still never run (`docs/PRODUCT_LOG.md`, `backend/products/gym/ARCHITECTURE.md`). Android now carries the gym
room — Kotlin/Compose, modules `:platform` + `:gym` + `:app`, magic-link sign-in, CI and tagged
releases in `.github/workflows/android.yml` — with roadmap and journal not yet mounted there.

This is a monorepo grouped by surface, then product. **Read `STRUCTURE.md` for the layout and
the one dependency rule** (platform is product-neutral; products depend on platform, never the
reverse; products never depend on each other). Each surface keeps its own `CLAUDE.md`/`NOTES.md`
for detail that only matters inside it (`backend/CLAUDE.md`, `web/CLAUDE.md`), and each product its
own `ARCHITECTURE.md` (e.g. `web/src/products/roadmap/ARCHITECTURE.md`).
The design/architecture principles below apply brand-wide.

## Mission

We are mission driven, not money driven. The mission is to make people develop themselves —
every product, page, and decision serves that. We build exceptional software and are extremely
honest with customers: no dark patterns, no manufactured urgency, no copy that promises what the
product doesn't do. When a choice trades user growth or honesty for revenue, the mission wins.

## No misinformation — including to ourselves

**We do not tolerate stale or wrong information anywhere: docs, canon, briefs, comments, READMEs,
commit trails, task ledgers, or product copy.** The honesty we owe customers is the same honesty we
owe the next person to read the repo — and that person is usually us, six weeks later, building
from a sentence that quietly stopped being true.

A stale line is worse than a missing one. Missing information gets looked up; wrong information gets
*believed*, and it does its damage before anyone thinks to check. Docs are read **before** work
starts, which is precisely when a false line is most expensive.

So: **when you make a line false, you fix it in the same wave that made it false.** Proactively,
without being asked, as part of the change rather than as follow-up. Correct it or delete it —
never leave it standing with a correction pinned beside it, and never let "that's just the old copy"
be a reason to keep it. If a fix is genuinely not yours to make (someone else's canon, an open
product decision), record it where that owner will see it — `docs/design/consistency.md`
for design/canon drift, a node in the dogfood tree for build work — and say so plainly in
your summary. Silence is not a handoff.

This cuts both ways: do not write a claim you have not verified. "Tested", "fixed" and "works" mean
you ran it. If you could not verify something, say which part and why, in the doc and in the summary.

## Architecture & Design
Optimize for the reader, not the writer. Code is read far more than it's written — favor the obvious over the clever
Make structure explicit. A newcomer should infer where things live from folder and file names alone; the directory tree should read like a description of the system
Push complexity to the edges, keep the core small. Business logic stays pure and dependency-light; messy details (I/O, vendors, frameworks) live at the boundary
try to place vast amount of logic into domain layer, rather than other layers. try to shape the code so you have Action that loads data using repositories and then passes it into domain layer. Domain layer does the calc and returns an object for persistence via Batch. If you need to load additional data inside the domain logic - split it into 2 phases, 1st phase load data from repo and call domain layer, then using the result load new data and call domain layer again
Keep dependency graph between modules clear, not just domain in the center, but like that entities can't depend on helper objects.
think about the shape, there are a lot of ways to write working code - real professionalism is defined by the shape
Try to make each module and each class excellent from the way it looks and the way it naturally fits the system. Aim for readable code over performant or conciese. Performance can be optimized later
We are here for the beautiful design, we are mission oriented and it's our number 1 priority. Features is 2nd priority.
Don't be afraid to spend more time thinking and refactoring system to fit the solution naturally. Beautify more than in the scope so the overall it looks better
Behave like elite level software engineer
Structure is the most important part of any system, structure decides whether the system is buggy and hard to evolve or is quite explicit, easy to read, understand and modify. Well structured code simply does not allow bugs sometimes, because structure makes them impossible. Structure the app in a right way 
Prefer composition over inheritance. Reserve inheritance for genuine interface/template relationships
Inject collaborators through constructors/factories. Make dependencies explicit and swappable — so tests substitute fakes for free, with no patching
Express a functions as an explicit, ordered, fail-fast pipeline of steps that reads top-to-bottom easily like a plain english
When several implementations share a fixed sequence of steps, put the sequence as a concrete method on the shared abstract base, and let each implementation override only the piece that actually varies. Don't let sibling classes each re-implement the same skeleton.
Audit for single-call-site indirection during refactors: if a function, method, or file has exactly one caller left, inline it into the caller. A separate file needs more than one consumer — or a name that genuinely earns its place — to justify existing.
For a small, self-contained feature area (one file format, one integration), prefer grouping all of its code — including the parsing/serialization boundary — under one feature-named package, rather than scattering it across domain/ vs infra-style layers. Reserve the layered split for logic that's genuinely reused by more than one feature.

## Conventions

use constructors on entities instead of helper functions
When working with API endpoints, for models that come in name them with Request suffix, for outgoing name with Response suffix.
Dont write docstrings or multiline commentaries.

If you have an abstraction with different implementations. put abstraction and all required data structures in a single file, but all implementations should be contained in their own files. Unless implementations are small and can be placed in a single file
Don't make a lot of small files/classes. there should be a very good reason to have class lesser than 40 lines of code
Give each module one reason to exist. Group small related classes by kind in one predictable file (all DTOs together, all exceptions together) rather than scattering them

You shouldn't write private (starting with underscore) helper functions unless you have a great reason why. The logic should be either inlined or folded into the solution naturally

## Testing

Layout of the test folder should mirror project layout.
In tests prefer full assertions, rather than partial assertions like

## Code Style

in if-else statements do early returns rather then assigning variables

## Workflow & Tooling

Stage your changes when you're done with the phase (or iteration)
After each phase note observarions you had that can enhance overall structure of the program or/and performance
Keep a running log of such observations in .md file and execute ones you find most important

If you seek for an advice, you can spin up an agent that has no access to the code, so he can give you unbiased advice on architecture or ideas

## Working agreement (how sessions run)

Act autonomously — never wait for approval on work that follows from the plan. Commit and
push both repos when a phase is implemented, reviewed, and verified (house-voice messages,
Co-Authored-By footer). Parallelize implementation across subagents (frontend/backend
halves, disjoint file territories, contracts pinned in both prompts). Every wave goes
through the gauntlet before it ships: adversarial review of the diff → one fix pass →
e2e on the local stack (see .claude/skills/verify) → push. The dogfood tree is the bet
ledger (bet id == node id; annotate outcomes + follow-ups on nodes); PRODUCT_LOG.md is the
strategy narrative; the design canon is in two halves — `docs/design/` holds the WRITTEN
half (guidelines, briefs, the consistency ledger) and five Figma files hold the DRAWN half.
Figma records what IS; the docs record what should be and why. Build
from design specs where canon exists; file descriptive tasks to designers where it doesn't.

Keep the running log of product progress in the Windmill dogfood tree (id t_9362d9bc883e0a1e) via the windmill MCP — create/connect nodes for new work and set_progress as it lands; inspect with get_tree/get_diagnostics. Every node you plant carries a description — a sentence or two on what the work is and why — passed inline to create_node, or backfilled with annotate_node. (Replaces the old src/skilltree/mock/roadmapTree.js log, now dumped into the tree.)