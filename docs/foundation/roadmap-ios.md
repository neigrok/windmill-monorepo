# Roadmap on iOS

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and roadmap nodes can cite
them.

## §0 Status and scope

**Status:** Specified; not approved, and nothing is built. The iPhone app carries journal and gym.
Roadmap's design for it is [Roadmap · iOS, wave 1](../design/ios/roadmap.md), with its boards in
the Roadmap Figma file; some are approved and some are proposals. The build order lives in the
Roadmap on iOS roadmap tree, which the dogfood tree (`t_9362d9bc883e0a1e`) opens from the node
`roadmap-ios`.

**Scope:** How the Roadmap room is built in the iPhone app: where its code lives, what it reads and
writes, links that open it, the Graph, nested roadmaps and guides, Coach in the room, and how it is
tested.

**Out of scope:** What a person sees, which the design holds. Roadmap's records and rules, which
[Roadmap on the sync engine](roadmap-on-the-engine.md) holds. Coach's abilities, records and turn,
which [Roadmap Coach](roadmap-coach.md) holds. What the design leaves for later waves: ceremonies,
quests and paste, share settings and export, reminders, widgets and App Intents, editing on the
canvas, and iPad.

**Depends on:** Roadmap on the sync engine, through its registry and shared domain; the
[Coach engine](coach-engine.md) for Coach.

## §1 Principles

- **P-1 The room is a client of the sync engine and the roadmap domain.** It has no sync of its
  own and holds no rule of its own. (R-1)
- **P-2 The phone's copy is the roadmap.** Every read and every change is local; the network never
  fails a save, and the room works with no connection.
- **P-3 One domain, held by vectors.** `RoadmapDomain` reproduces every shared vector the web's
  domain does. A rule changes as a vector first.
- **P-4 The Graph draws the web's picture.** The layout is the web's, ported and held to the web's
  own output.
- **P-5 Screens come from approved boards.** A board marked a proposal is not built.

## §2 Where things live

| Part | Where |
|---|---|
| Entities, actions, landing and reads | `apps/ios/Domain/Sources/RoadmapDomain`, on `DomainKit` |
| The layout, pure and without the engine | `apps/ios/Domain/Sources/RoadmapLayout` |
| The schema | generated into `apps/ios/Sync/Sources/SyncSchema` from roadmap's registry |
| The model server's roadmap rules | `apps/ios/Sync/Sources/SyncModelServer` |
| The room, its screens and the Graph's canvas | `apps/ios/App/Sources/Roadmap/` |
| Coach's executor on the phone's copy | `RoadmapDomain`, as gym's is in `GymDomain` |

- The domain kit MUST let an entity live in a tree scope or an overlay scope before `RoadmapDomain`
  is built on it; today it admits a product scope only.
- `RoadmapDomain` and `RoadmapLayout` join the layering tests' world, and neither imports the app.
- The room joins the shell as its third room, as the design's room section says. The shell's
  sign-in and sign-out questions count roadmap's unsent work as they count gym's and journal's.

## §3 Reading and writing

- A signed-in phone holds every roadmap the person owns, with their marks and workspace, and lists
  them from its copy.
- A roadmap someone else shares is subscribed when its link is opened, signed in or not, and shown
  in a cover of its own; it never enters the room's list. A signed-in reader's marks and workspace
  are their own.
- Every gesture is an action of `RoadmapDomain`, run through the kit's runner into the engine. The
  room writes no record another way.
- Deletes are held nine seconds with Undo, by the engine's hold.
- A change that landed oddly is told once, by the band and the footer the design draws. What could
  not land at all is listed in one place (Roadmap on the sync engine §5). The room shows no save
  failure and no refused change otherwise.
- History reads the backend's activity feed and needs a connection.

- **INV-1.** The room reads no roadmap from the backend and sends no change to it except through
  the sync engine.

## §4 Links

Both of a roadmap's addresses open the app (R-4):

| Address | Opens |
|---|---|
| `/t/<id>`, with or without a step | a roadmap the person owns on its Board, or at the step; anyone else's in the cover, on the Graph |
| `/#/app/<id>`, with or without a step | the person's own roadmap on its Board, or at the step |

- The app declares the associated domain, and the web serves the association file from the same
  host.
- The app parses an address by the shared address cases (`roadmap-addresses.json`), which Swift
  joins the web and the backend in running.
- A link to a roadmap the phone cannot read says so in the cover and offers nothing else.

## §5 The Graph

- `RoadmapLayout` is a port of the web's bubble layout with its fallback. Its input is a roadmap's
  steps and links as plain data; its output is a seat for each step.
- **Fixtures.** `packages/api-contract/roadmap/layout/` holds roadmaps and the seats the web's
  layout gives them: the eight-step fixture, a wide one, a deep one, labels in several scripts, and
  5,000 steps. The web generates them and checks them on every run; Swift reproduces each seat
  within `LAYOUT_TOLERANCE`.
- The port counts a label's length in code points and orders ties as the web does, and the fixtures
  pin both.
- The canvas draws with SwiftUI's `Canvas` and redraws only on change. Structure is edited in the
  step form, never on the canvas.
- **Budget.** A roadmap of 5,000 steps opens from the phone's copy in under a second and pans and
  zooms at 60 frames a second on the oldest iPhone the app supports.

## §6 Nested roadmaps and guides

The iPhone does what the web does (R-3): a step that opens a roadmap or owns a subtree shows what
that roadmap comes to and lets a person go in and come back; an owner attaches a roadmap to a step,
changes it and detaches it, forking first a roadmap they can only read; a person reads a roadmap's
guide and the guides above it, and an owner edits their own.

- These are the domain's actions and reads, the web's own.
- The iPhone design draws none of it, so each state is drawn and approved before it is built.

## §7 Coach

Coach is the room's third tab, as the design rules, with Search beside it.

- It runs on the Coach engine's Swift libraries with roadmap's profile, and its abilities run on
  the phone's copy through `RoadmapDomain`.
- Its conversations, proposals and receipts are roadmap's synced records, so a conversation begun
  in a browser is the same one on the phone.
- [Roadmap Coach](roadmap-coach.md) specifies it for both surfaces.

## §8 Forms, colour and words

- A form commits from the toolbar, with Cancel and Save, as every form in the app does (R-5). The
  rendering contract takes no exception for roadmap.
- Roadmap's colour roles become the app's fourth palette, and the theme test that reads the role
  tables reads roadmap's.
- A sentence a rule produces, a reason line or a refusal, comes from the shared vectors. Every
  other string is in the app's catalog and is the board's.

## §9 Testing

- **The domain** runs every file under `packages/api-contract/roadmap/domain/` and the kit's
  harness.
- **The layout** runs the fixtures of §5.
- **The room** has unit tests on its models and a UI shard of its own in CI, with the opt-in
  captures every room has, compared with the boards.
- **End to end**, the room is driven on the simulator against a local stack: a roadmap made signed
  out, joined at sign-in, edited in a browser and on the phone at once, edited offline against a
  delete made elsewhere, and a shared link opened signed out.
- **On a device**, links from Messages and Safari open the app, and the 5,000-step budget is
  measured.

## §10 Observability

- Events, with no title or text of the person's: the room opened; a roadmap created, switched and
  deleted; a step created, edited, completed, reset and deleted, and each Undo; a change that
  landed oddly, and one that could not land, with its rule or code; a link opened, by kind of
  address and whether the roadmap was the person's; the Graph opened, with the step count as a
  bucket.
- Sentry, under static names, at the room's boundaries: a link that could not be parsed, a layout
  that fell back, and a canvas that missed its budget on a roadmap within the cap.
- The iPhone's observability document lists them, and its telemetry allowlist gains the labels.

## §11 What the build makes false

The lines that say the iPhone carries journal and gym only, that roadmap is on the web only, and
that roadmap is not a consumer of the domain kit: in `AGENTS.md`, `STRUCTURE.md`, the app's
README, parity table and onboarding, the domain kit's and the sync engine's documents, and the
documentation index. Each is corrected in the change that makes it false.

## §12 Values

| Name | Value | Whose |
|---|---|---|
| `LAYOUT_TOLERANCE` | one hundredth of a step's body width | the layout fixtures' |
| Open a 5,000-step roadmap | under 1 s from the phone's copy | the room's |
| Pan and zoom | 60 frames a second | the canvas's |

## §13 Gaps this build closes

- The app has no third room, no associated domain and no roadmap code; its onboarding says roadmap
  is on the web.
- No fixture of the layout's output exists, and whether the port matches the web's numbers is not
  known until the first fixtures run.
- The Board, the room's entry screens, the New step form and the held delete are proposals in
  Figma, and nested roadmaps, guides and the list of what could not land are not drawn for the
  iPhone at all.
- The design's rulings 3 and 7, its form section and its persistence rule predate R-1, R-4 and R-5
  and are rewritten to them.

## §14 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | What the room syncs through | The shared sync engine and the Swift domain kit, not a client of roadmap's former sync. (2026-11-17) |
| R-2 | Coach on the iPhone | In the first release, as the room's third tab. (2026-11-17) |
| R-3 | Nested roadmaps and guides | Full parity with the web in the first version. (2026-11-17) |
| R-4 | Which links open the app | Shared links and a person's own links. (2026-11-17) |
| R-5 | Where a form commits | In the toolbar, as every other form. (2026-11-17) |
