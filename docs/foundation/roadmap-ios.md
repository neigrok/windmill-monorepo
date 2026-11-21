# Roadmap on iOS

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and roadmap nodes can cite
them.

## §0 Status and scope

**Status:** Specified, and approved by the owner on 2026-11-17. `RoadmapDomain` holds the pure reads (§2) and runs
their vector files (§10); nothing else is built. The iPhone app carries journal and gym.
Roadmap's design for it is [Roadmap · iOS](../design/ios/roadmap.md), with its boards in
the Roadmap Figma file; every board is a proposal until the owner approves it. The build order lives in the
Roadmap on iOS roadmap tree, which the dogfood tree (`t_9362d9bc883e0a1e`) opens from the node
`roadmap-ios`.

**Scope:** How the Roadmap room is built in the iPhone app: where its code lives, what it reads and
writes, links that open it, the Graph, nested roadmaps and guides, Coach in the room, and how it is
tested.

**Out of scope:** What a person sees, which the design holds. Roadmap's records and rules, which
[Roadmap on the sync engine](roadmap-on-the-engine.md) holds. Coach's abilities, records and turn,
which [Roadmap Coach](roadmap-coach.md) holds. What the design leaves out, which its section 13
lists: ceremonies, presence, editing on the canvas, keyboard shortcuts and iPad, widgets and App
Intents, and the reminder switch.

**Depends on:**

- [Roadmap on the sync engine](roadmap-on-the-engine.md): its registry and shared domain, and the
  server serving roadmap through the engine, as production's does;
- for Coach, the [Coach engine](coach-engine.md)'s Swift libraries merged, and the day gym's server
  Coach closes, before which Roadmap Coach is open to no one (Roadmap Coach R-11).

## §1 Principles

- **P-1 The room is a client of the sync engine and the roadmap domain.** It has no sync of its
  own and holds no rule of its own. (R-1)
- **P-2 The phone's copy is the roadmap.** Every read and every change of a person's own roadmap is
  local; the network never fails a save, and the room works with no connection.
- **P-3 One domain, held by vectors.** `RoadmapDomain` reproduces every shared vector the web's
  domain does. A rule changes as a vector first.
- **P-4 The Graph draws the web's picture.** The seats, the captions, the curves and the framing
  are the web's, ported and held to the web's own output, number for number.
- **P-5 Screens come from approved boards.** A board marked a proposal is not built.

## §2 Where things live

| Part | Where | May import |
|---|---|---|
| Entities, actions and reads | `apps/ios/Domain/Sources/RoadmapDomain` | the domain kit and the sync engine's API, as gym's and journal's domains |
| The picture: layout, caption placement, edge curves, framing | `apps/ios/Domain/Sources/RoadmapLayout` | nothing |
| The schema | generated into `apps/ios/Sync/Sources/SyncSchema` from roadmap's registry | |
| The model server's roadmap rules | `apps/ios/Sync/Sources/SyncModelServer` | |
| The room, its screens and the Graph's canvas | `apps/ios/App/Sources/Roadmap/` | |
| Coach's executor on the phone's copy | `RoadmapDomain` | |

- `RoadmapDomain` is built on the kit's changes [Roadmap on the sync engine](roadmap-on-the-engine.md)
  §3 names: entities in a tree or an overlay scope, a gesture over several scopes, and Undo of an
  act.
- The ability and catalog types Coach's executor needs live in gym's domain today. They move into
  `DomainKit`, since one product's domain may not import another's.
- `RoadmapDomain` and `RoadmapLayout` join the layering tests' world and the domain kit's table of
  layers, and neither imports the app.
- The room joins the shell as its third room. The shell's sign-in and sign-out questions count
  roadmap's unsent work, and Coach's conversations with it, as they count gym's and journal's.
- Both of the app's entitlement files gain the associated domain (§4).

## §3 Reading and writing

- **A person's own roadmaps.** A signed-in phone holds every roadmap the person owns, with their
  marks and workspace. The room observes the engine's views of roadmap's types, and one read of the
  domain composes a roadmap from them. The list is the roots that stand; a subtree is reached
  through its step.
- **Someone else's roadmap** is subscribed when its link is opened, signed in or not, shown in a
  cover of its own, and dropped when the cover closes. It never enters the room's list and does not
  reopen with no connection. The cover shows the owner's progress, read from the backend, and
  offers no Complete and no workspace. A reader who wants a roadmap of their own forks it.
- **Fork** is the server's, so it needs a connection and an account, and the copy arrives by sync.
- **Writing.** Every gesture is an action of `RoadmapDomain`, run through the kit's runner into the
  engine. The room writes no record another way.
- **Deletes are held** nine seconds with Undo, by the engine's hold. Roadmap's actions run with
  removals held; gym's and journal's stay immediate, as they are.
- **A limit** is checked where the gesture is made: a loop, a seventh kind, a hue already worn, a
  roadmap that is full. The gesture is refused there, and the design says how that shows.
- **A change that met one made elsewhere** is told once, by the band and the footer the design
  draws. What could not land at all is listed in one place (Roadmap on the sync engine §6). The
  room shows no save failure and no refused change otherwise.
- **History** reads the backend's activity feed and needs a connection. A roadmap made signed out
  has none.

- **INV-1.** The room reads no roadmap from the backend and sends no change to it except through
  the sync engine. The owner's progress on a shared roadmap, History and Fork are the exceptions.

## §4 Links

Both of a roadmap's addresses open the app (R-4). The app claims exactly these, and nothing else of
the site: the sign-in link, the web's other `#/app` pages and its gym and journal rooms stay the
browser's.

```json
{"applinks": {"details": [{"appIDs": ["<team>.works.windmill.app"], "components": [
  {"/": "/t/*"},
  {"/": "/", "#": "/app/t_*"}
]}]}}
```

| Address | Opens |
|---|---|
| `/t/<id>` or `/#/app/<id>`, the person's own roadmap | its Board, or the step named |
| either, anyone else's roadmap, or signed out | the cover, on the Graph |
| either, a roadmap the phone can neither read nor hold, with a connection | the cover says it cannot be opened; signed out, it offers sign-in |
| either, with no connection and not on the phone | the cover says it needs a connection |
| a claimed address that names no roadmap | the room's list |

- The web's build ships the association file at `/.well-known/apple-app-site-association`, served
  as JSON with no redirect, and the deploy's route test checks it.
- The app parses an address by the shared address cases (`roadmap-addresses.json`), which Swift
  joins the web and the backend in running.
- Not known until it is tried on a device: that the release's signing turns the capability on with
  no step in Apple's portal, and that Apple's fetch of the file passes the site's edge.

## §5 The Graph

- **Ported, pure:** the bubble layout with its fallback, the placement of captions at a zoom, the
  bow of each link, the framing of a roadmap and its floors, and the tiers a step is drawn in. Each
  is the web's rule, and the iPhone adds no level of detail of its own.
- **One arithmetic.** A last-place difference between two platforms' trigonometry can move a seat
  by more than a hundred units, because the layout rounds and compares. So the layout calls its own
  sine, cosine, arcsine, arctangent and hypotenuse, one implementation written the same in
  JavaScript and in Swift, on the web as on the iPhone, and never the platform's.
- **Input.** A step's id as its bytes, its label, its `ord`, the stamp of its creation, which is
  the record's `born`, and the ids it follows ([Roadmap on the sync engine](roadmap-on-the-engine.md)
  D-5). Ids and ties compare as the web compares them, by UTF-16 code unit, never by a rule that
  treats two spellings of a character as one. A label's length is counted in code points.
- **Fixtures.** `packages/api-contract/roadmap/layout/` holds roadmaps and what the web gives for
  each: seats, caption placements at fixed zooms and selections, link bows and framing. Among them:
  the eight-step fixture, a wide one, a deep one, labels in several scripts, ids outside the basic
  plane and ids that differ only in spelling, and 5,000 steps. The web generates them and checks
  them on every run; Swift reproduces every number exactly.
- The canvas draws with SwiftUI's `Canvas` and redraws only on change. It also draws a proposal as
  the changes it would make, for Coach's review. Structure is edited in the step form, never on the
  canvas.
- **Budget.** From the tap that opens a roadmap of 5,000 steps to the Board's first frame, and to
  the Graph's first frame with its layout, is under a second each; the Graph pans and zooms at 60
  frames a second. Both are measured on an iPhone XR, the slowest the app supports, by a benchmark
  kept beside the sync engine's. The canvas is tried at that size before the screens are built, and
  moves to Metal only if `Canvas` misses the budget there.

## §6 Nested roadmaps and guides

The iPhone does what the web does (R-3): a step that opens a roadmap or owns a subtree shows what
that roadmap comes to and lets a person go in and come back; an owner attaches a roadmap to a step,
changes it and detaches it, forking first a roadmap they can only read; a person reads a roadmap's
guide and the guides above it, and an owner edits their own.

- These are the domain's actions and reads, the web's own.
- Forking first needs a connection, as every fork does.
- Each state is drawn as a proposal and is approved before it is built.

## §7 A roadmap and its kinds

A person renames and deletes a roadmap on the phone, and adds, renames, recolours and removes its
kinds (R-6). These are the domain's actions, the web's own: a delete is held with Undo, and
recolouring a kind is the server's command. Each state is drawn as a proposal and is approved
before it is built.

## §8 Coach

Coach is on the open screen, as the design rules: a composer at the foot of the Board, the Graph, a
step page and the step form, and a sheet for its answers.

- It runs on the Coach engine's Swift libraries with roadmap's profile, and its abilities run on
  the phone's copy through `RoadmapDomain`.
- Its conversations, proposals and receipts are roadmap's synced records, so a conversation begun
  in a browser is the same one on the phone.
- It ships in the room's first release (R-2) and opens to people when Roadmap Coach opens on the
  web: once gym's server Coach has closed (Roadmap Coach R-11). Until that day the composer is not
  shown.
- [Roadmap Coach](roadmap-coach.md) specifies it for both surfaces.

## §9 Forms, colour and words

- A form commits from the toolbar, with Cancel and Save, as every form in the app does (R-5). The
  rendering contract takes no exception for roadmap.
- Roadmap's colour roles become the app's fourth palette, and the theme test that reads the role
  tables reads roadmap's.
- A sentence a rule produces, a reason line or a refusal, comes from the shared vectors. Every
  other string is in the app's catalog and is the board's.

## §10 Testing

- **The domain** runs every file under `packages/api-contract/roadmap/domain/` and the kit's
  harness. Coach's executor runs roadmap's ability vectors, and the Coach engine's turn stories
  with roadmap's profile.
- **The model server** runs the engine corpus's roadmap cases.
- **The picture** runs the fixtures of §5.
- **CI.** The iPhone's workflow runs when roadmap's contract, the address cases or the layout
  fixtures change. The room's UI tests join the three shards there are; a fourth would queue.
- **The room** has unit tests on its models and the opt-in captures every room has, compared with
  the boards.
- **End to end**, on the simulator against a local stack: a roadmap made signed out and joined at
  sign-in; one edited in a browser and on the phone at once; one edited offline against a delete
  made elsewhere; a delete held while the app goes to the background; a shared link opened signed
  out; Coach making a direct write and its Undo, applying a proposal offline, and a signed-out
  conversation joined at sign-in.
- **On a device**, links from Messages and Safari open the app, and the budget of §5 is measured.

## §11 Observability

- **Events**, with no title or text of the person's and no id of a roadmap or a step: the room
  opened; a roadmap created, switched and deleted; a step created, edited, completed, reset and
  deleted, and each Undo; kinds changed; several steps recoloured or deleted, with their count as a
  bucket; a workspace edited; sort, filter and search used; going into a nested roadmap and back;
  attach, change and detach; a guide read and edited; a fork; a change that met one made elsewhere,
  and one that could not land, with its rule or code; the list of what could not land opened,
  copied from and discarded from; roadmap's answer to the sign-in and sign-out questions; a link
  opened, by kind of address and whether the roadmap was the person's; the Graph opened, with the
  step count as a bucket.
- Coach's events are [Roadmap Coach](roadmap-coach.md) §13's, emitted on the iPhone as on the web.
- **Sentry**, under static names, at the room's boundaries: the activity feed, the owner's progress
  and a fork that failed for a reason other than no connection; a shared roadmap that could not be
  subscribed for a reason other than access; a view the room depends on that failed to read; an
  action whose commit failed; a layout that fell back; a canvas that missed its budget on a roadmap
  within the cap. A claimed address that names no roadmap is expected and reports nothing, and no
  report carries an address.
- The iPhone's observability document lists them, and its telemetry allowlist gains the labels.

## §12 What the build makes false

The lines that say the iPhone carries journal and gym only, that roadmap is on the web only, that
roadmap is not a consumer of the domain kit, and that the iPhone has no Undo for a delete: in
`AGENTS.md`, `STRUCTURE.md`, the app's README, parity table and onboarding, the domain kit's and
the sync engine's documents, and the documentation index. Each is corrected in the change that
makes it false.

## §13 Gaps this build closes

- The app has no third room, no associated domain and no roadmap code; its onboarding says roadmap
  is on the web. Nothing serves an association file.
- `RoadmapDomain` holds the pure reads alone: no entity, action, replica read, Undo or Coach executor.
- No fixture of the web's picture exists, and the web's own layout calls the platform's
  trigonometry.
- The app's one runner deletes at once, in every room.
- Every board of the room is a proposal in Figma until the owner approves it.

## §14 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | What the room syncs through | The shared sync engine and the Swift domain kit, not a client of roadmap's former sync. (2026-11-17) |
| R-2 | Coach on the iPhone | In the first release, on the open screen as the design draws it. (2026-11-17) |
| R-3 | Nested roadmaps and guides | Full parity with the web in the first version. (2026-11-17) |
| R-4 | Which links open the app | Shared links and a person's own links. (2026-11-17) |
| R-5 | Where a form commits | In the toolbar, as every other form. (2026-11-17) |
| R-6 | Renaming and deleting a roadmap, and managing kinds, on the iPhone | All are in the first version: rename and delete a roadmap, and add, rename, recolour and remove a kind. Each is drawn as a proposal and approved first. (2026-11-17) |
