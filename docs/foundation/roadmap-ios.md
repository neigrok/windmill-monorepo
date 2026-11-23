# Roadmap on iOS

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and roadmap nodes can cite
them.

## §0 Status and scope

**Status:** Specified and in build; §13 lists what is not built yet, and the Roadmap on iOS
roadmap tree records each landing. The owner approved it on 2026-11-17; what it says of
plans, Export, Share, the gallery and Activity follows the boards and has not been before
the owner. The iPhone app carries journal and gym. Roadmap's design for it is
[Roadmap · iOS](../design/ios/roadmap.md), with its boards in the Roadmap Figma file, every one
✅ Ready for dev since the owner's approval of 2026-11-21. The build order lives in the Roadmap on
iOS roadmap tree, which the dogfood tree (`t_9362d9bc883e0a1e`) opens from the node `roadmap-ios`.

**Scope:** How the Roadmap room is built in the iPhone app: where its code lives, what it reads and
writes, links that open it, the Graph, nested roadmaps and guides, starting a roadmap from a
plan, pasted steps, Export and Share, the public gallery and Activity, Coach in the room, and
how it is tested.

**Out of scope:** What a person sees, which the design holds. Roadmap's records and rules, which
[Roadmap on the sync engine](roadmap-on-the-engine.md) holds. Coach's abilities, records and turn,
which [Roadmap Coach](roadmap-coach.md) holds. What the design leaves out, which its section 13
lists: ceremonies, presence, editing on the canvas, keyboard shortcuts and iPad, widgets and App
Intents, the reminder switch, the all-roadmaps export, a reader's
Activity and the web demo.

**Depends on:**

- [Roadmap on the sync engine](roadmap-on-the-engine.md): its registry and shared domain, and the
  server serving roadmap through the engine, as production's does;
- for Coach, the [Coach engine](coach-engine.md)'s Swift libraries merged, and the day gym's server
  Coach closes, before which Roadmap Coach is open to no one (Roadmap Coach R-11).

## §1 Principles

- **P-1 The room is a client of the sync engine and the roadmap domain.** It has no sync of its
  own and holds no rule of its own. (R-1)
- **P-2 The phone's copy is the roadmap.** Every read and every change of a person's own roadmap is
  local; the network never fails a save, and the room works with no connection. The server is
  for synchronization and for sharing: a public link, a shared roadmap's cover, the gallery and
  Fork, whether a person shares or Coach does it for them (R-10).
- **P-3 One domain, held by vectors.** `RoadmapDomain` reproduces every shared vector the web's
  domain does. A rule changes as a vector first.
- **P-4 The Graph draws the web's picture.** The seats, the captions, the curves and the framing
  are the web's, ported and held to the web's own output, number for number.
- **P-5 Screens come from approved boards.** A board marked a proposal is not built.

## §2 Where things live

| Part | Where | May import |
|---|---|---|
| Entities, actions and reads; the plan grammar (§7.1) | `apps/ios/Domain/Sources/RoadmapDomain` | the domain kit and the sync engine's API, as gym's and journal's domains |
| The picture: layout, caption placement, edge curves, framing | `apps/ios/Domain/Sources/RoadmapLayout` | nothing |
| The schema | generated into `apps/ios/Sync/Sources/SyncSchema` from roadmap's registry | |
| The model server's roadmap rules | `apps/ios/Sync/Sources/SyncModelServer` | |
| The room, its screens, the Graph's canvas and the requests of INV-1 | `apps/ios/App/Sources/Roadmap/` | |
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
- The app's Info.plist gains the Markdown type (§7.3).

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
- **The public gallery** is the backend's list of public roadmaps, read a page at a time and shown
  in the order the backend ranks it. It needs a connection and no account, and nothing of it is
  kept on the phone. A row opens its roadmap in a cover, as its link does (§4), and is the
  person's own where the list says `mine`. A row offers the person's copy where the phone holds
  one: a roadmap of theirs that stands and whose `meta.forkedFrom` is the row's roadmap, the first
  in their list's order, or the copy a fork made from the row has just answered. Otherwise it
  offers Fork.
- **Writing.** Every gesture is an action of `RoadmapDomain`, run through the kit's runner into the
  engine. The room writes no record another way.
- **Deletes are held** nine seconds with Undo, by the engine's hold. Roadmap's actions run with
  removals held; gym's and journal's stay immediate, as they are.
- **A limit** is checked where the gesture is made: a loop, a seventh kind, a hue already worn, a
  roadmap that is full. The gesture is refused there, and the design says how that shows.
- **A change that met one made elsewhere** is told once, by the band and the footer the design
  draws. What could not land at all is listed in one place (Roadmap on the sync engine §6). The
  room shows no save failure and no refused change otherwise.
- **Activity and History** are a read of the domain over the phone's copy (R-11): what the copy
  holds a time for, such as a step's creation and its completion, in order of time, a roadmap's
  Activity over all its steps and a step's History over that step. They make no request, and work
  with no connection and signed out. What the copy does not keep is not shown: an earlier name, a
  step that was removed, a mark that was reset. The read is shared with the web as cases under
  `packages/api-contract/roadmap/domain/`, which say exactly which rows it gives. A roadmap gone
  into has its own Activity. A reader has History and no Activity.

- **INV-1.** The room reads no roadmap from the backend and sends no change to it except through
  the sync engine. The exceptions are exactly the three requests below, all of them sharing, named as the backend's
  [HTTP surface](../../backend/SPEC.md#http-surface) names them. Each carries the account's token
  where the phone is signed in. A plan, pasted steps and Export read and write the
  phone's copy alone, Activity and History read it alone, and Share's switch is a change through
  the engine (§7.1 to §7.4). Whether the three move into synchronization is decided when links and
  readers are built (R-12).

| Request | Serves | Needs | Without it |
|---|---|---|---|
| `GET /v1/trees/{id}/progress` | the owner's progress on a cover, and what each subtree there has come to | a connection | as the cover (§4) |
| `GET /v1/gallery` | the public gallery | a connection | it says the gallery cannot be reached and offers to try again |
| `POST /v1/trees/{id}/fork` | Fork: on a cover, on a gallery row, and before attaching a roadmap the person can only read (§6) | a connection and an account | with no connection it says so and forks nothing; signed out it opens sign-in, and the fork runs when that closes signed in |

- **What the room does not show.** Activity and History show no row for a step unlocking
  (R-7). The gallery answers no author, so a row shows its roadmap's title and step count alone
  (R-8). Share has two states, public and private (R-9): the roadmaps that hold `unlisted` are
  moved to private before Share is built.

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
- The address Share hands out (§7.4) is the roadmap's share address of the same cases, `/t/<id>`
  on the site.
- Apple's fetch of the file passes the site's edge: its CDN serves the site's file. Not known
  until it is tried on a device: that the release's signing turns the capability on with no step
  in Apple's portal.

## §5 The Graph

- **Ported, pure:** the bubble layout with its fallback, the placement of captions at a zoom, the
  bow of each link, the framing of a roadmap and its floors, and the tiers a step is drawn in. Each
  is the web's rule, and the iPhone adds no level of detail of its own.
- **One arithmetic.** A last-place difference between two platforms' trigonometry can move a seat
  by more than a hundred units, because the layout rounds and compares. So the layout calls its own
  sine, cosine, arcsine, arctangent and hypotenuse, one implementation written the same in
  JavaScript and in Swift, on the web as on the iPhone, and never the platform's.
- **Input.** A step's id as its bytes, its label, its kind's hue, its `ord`, the stamp of its
  creation, which is the record's `born`, and the ids it follows
  ([Roadmap on the sync engine](roadmap-on-the-engine.md) D-5); for the tiers, the steps that stand
  complete. Ids and ties compare as the web compares them, by UTF-16 code unit, never by a rule that
  treats two spellings of a character as one. A label's length is counted in code points.
- **Fixtures.** `packages/api-contract/roadmap/layout/` holds roadmaps and what the web gives for
  each: seats, tiers, caption placements at fixed zooms and selections, link bows and framing; and
  the arithmetic's own values. Among them: the eight-step fixture, a wide one, a deep one, labels
  in several scripts, ids outside the basic plane and ids that differ only in spelling, one that
  spends the bubble layout's budget of work, two seated by the fallback, and 5,000 steps. Its
  [README](../../packages/api-contract/roadmap/layout/README.md) says how each number is derived
  and what a port must reproduce of JavaScript's arithmetic, ordering and text. The web generates
  them and checks them on every run; Swift reproduces every number exactly.
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
- Each state is built from its board in the design's sections 07 and 08.

## §7 A roadmap and its kinds

A person renames and deletes a roadmap on the phone, and adds, renames, recolours and removes its
kinds (R-6). These are the domain's actions, the web's own: a delete is held with Undo, and
recolouring a kind is the server's command. Each state is built from its board in the design's
sections 01 and 06.

### §7.1 Starting a roadmap

New Roadmap makes a roadmap blank, from a plan on the clipboard, or from a plan in a `.md` or
`.txt` file (section 01's boards). Each is the domain's `CreateRoadmap` on the phone's copy. None
makes a request, and none needs a connection or an account. The iPhone offers no quest (R-13).

- **Blank** plants one starting step, named as the roadmap.
- **A plan** is text read by the web's plan grammar, ported to `RoadmapDomain`: the same text
  gives the same name, steps, links, kinds, done marks and counts on the iPhone as on the web.
  It is read on the phone, and reading cannot fail: a line the grammar cannot place is kept as a
  note on a step. The read-back shows the grammar's counts, and the plan's first steps in the
  states the domain's reads give them over the plan as over a roadmap. Create runs
  `CreateRoadmap` with the plan's steps, links and kinds, then `Complete` for each step the plan
  brings done.
- **The grammar's cases** live in `packages/api-contract/roadmap/plan/`: a text read to a plan,
  alone and into a roadmap that has kinds of its own; a plan to the input of `CreateRoadmap`, and
  to that of `ImportSteps` under a step (§7.2); a roadmap written to its Markdown (§7.3); and
  each written file read back. A case compares what the grammar derives and no sentence of a
  catalog. The web and Swift both run every case, and the grammar changes as a case first (P-3).

### §7.2 Pasted steps

Paste Steps reads the clipboard's text into the open roadmap by the same grammar, which there
binds a heading to a kind the roadmap has or adds one, and renames none (boards 02.16 to 02.18).

- The read-back shows the steps in the states they will land in, read by the domain over the
  roadmap as the paste would leave it. Nothing is written before Add.
- Add runs, as one act with one Undo, the domain's `ImportSteps` under the roadmap's starting
  step and `CreateKind` for each kind the plan adds. The starting step is the first, in authored
  order, of the steps that follow nothing; a roadmap with none takes the steps at its root.
- It needs neither a connection nor an account. A roadmap too full for the steps refuses them
  where the gesture is made (§3).

### §7.3 Export

Export writes one roadmap as one Markdown file and hands it to the system's exporter (board 09.3).
It reads the phone's copy, makes no request, and needs neither a connection nor an account.

- The text is the plan grammar's writing of a roadmap (§7.1), so New Roadmap reads the file back
  to the same steps. It holds the roadmap's name and guide, and each step with its kind, its
  description, its links' addresses, what it follows and whether the room shows it done.
- The file holds one roadmap: a step that owns or opens another is written as a step, and that
  roadmap is not.
- The SDK's own Markdown type is available from iOS 27 and the app runs from iOS 18. The app's
  Info.plist, which `apps/ios/App/project.yml` declares, names `net.daringfireball.markdown` as
  an imported type, and the exporter and New Roadmap's file importer name it by that identifier;
  the importer also takes plain text.

### §7.4 Share

Share is one switch on a root (boards 09.1a to 09.2b). A roadmap gone into has none.

- It reads the roadmap's `visibility` from the phone's copy and writes it by the domain's
  `SetVisibility`, `public` on and `private` off, through the sync engine like any change. The
  server writes the reach of the roadmap and of every subtree that stands under it.
- The switch needs an account and a connection, because a link opens for no one until the server
  holds the change. Signed out it is disabled and the sheet offers sign-in; with no connection it
  is disabled.
- While the roadmap is public the sheet hands out its share address (§4), to the system's share
  sheet and to the pasteboard, with a connection or without.
- The sentence under the switch names subtrees where a step of the roadmap owns one.

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
  harness, and the plan cases of §7.1. Coach's executor runs roadmap's ability vectors,
  and the Coach engine's turn stories with roadmap's profile.
- **The model server** runs the engine corpus's roadmap cases.
- **The picture** runs the fixtures of §5.
- **CI.** The iPhone's workflow runs when roadmap's contract, the address cases or the layout
  fixtures change. The room's UI tests join the three shards there are; a fourth would queue.
- **The room** has unit tests on its models, among them the gallery's pages, and the opt-in captures every room has, compared with the boards.
- **End to end**, on the simulator against a local stack: a roadmap made signed out and joined at
  sign-in; one edited in a browser and on the phone at once; one edited offline against a delete
  made elsewhere; a delete held while the app goes to the background; a shared link opened signed
  out; a plan pasted into New Roadmap and planted; steps pasted into
  a roadmap and taken back by Undo; a roadmap made public on the phone and opened by its link in
  a browser signed out; the gallery read, a row forked and the copy opened; Activity showing a
  change made in a browser once it has synced; Coach making a direct write and its Undo, applying a proposal
  offline, and a signed-out conversation joined at sign-in.
- **On a device**, links from Messages and Safari open the app, the budget of §5 is measured, and
  an exported file is read back by New Roadmap.

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
- **Events of making, sharing and Activity**, under the same rule: New Roadmap opened; a creation
  by its door (blank, a copied plan, a file), with its step count as a bucket; a plan read back, by its source, and cleared; Paste Steps
  read back, added with the count as a bucket, cancelled and undone; Share opened, its switch
  turned on and off, the link shared and copied, and sign-in opened from it; a roadmap exported,
  and whether the file was saved; the gallery opened and each page read, with what the read came
  to (loaded, empty, failed), a retry, a row opened, a fork from a row and a copy opened; Activity
  opened, with what its read came to (loaded, empty), and a row opened.
- Coach's events are [Roadmap Coach](roadmap-coach.md) §13's, emitted on the iPhone as on the web.
- **Sentry**, under static names, at the room's boundaries: the owner's
  progress, the gallery and a fork that failed for a reason other than no connection, and an
  answer of theirs the room cannot read; a shared roadmap that could not be subscribed for a
  reason other than access; a view the room depends on that failed to read; an action whose
  commit failed; a creation from a plan that failed where no limit refused it, and
  done steps that could not be marked after it; a chosen file that could not be opened; an export
  the system could not write; a layout that fell back; a canvas that missed its budget on a
  roadmap within the cap. A claimed address that names no roadmap is expected and reports nothing. No report carries an address,
  a plan's text, a file's name or a roadmap's title.
- The iPhone's observability document lists them, and its telemetry allowlist gains the labels.

## §12 What the build makes false

The lines that say the iPhone carries journal and gym only, that roadmap is on the web only, that
roadmap is not a consumer of the domain kit, and that the iPhone has no Undo for a delete: in
`AGENTS.md`, `STRUCTURE.md`, the app's README, parity table and onboarding, the domain kit's and
the sync engine's documents, and the documentation index. Each is corrected in the change that
makes it false.

## §13 Gaps this build closes

- The app's third room exists only behind a build switch that is off in Release (`WM_ROADMAP_ROOM_ENABLED`), where it
  shows a roadmap's Board, its Graph and a step's page from the phone's copy, writes five gestures on a step, Create
  and Edit from the step form and Complete, Reset and Delete, each with its Undo, and makes, opens, renames and
  deletes a roadmap from the title menu, All Roadmaps and New Roadmap. The Board finds steps by the domain's read,
  orders them, narrows them to the kinds a person picks or to a step's branch, and selects several steps to recolor or
  delete, each as one gesture with its Undo; New Step at a roadmap's cap of steps is refused where it is tapped; and a
  roadmap's kinds are added, named, described, recolored and removed in the Kinds sheet, from the title menu and from
  the step form's *Edit Kinds*. The step form sets a step's name, description and kind, what it requires, what it opens
  and the links it shares, and has no *Roadmap* row or Coach composer. A step's page holds the person's workspace of
  it, subtasks, a note and links read live from their overlay on the phone's copy, each written by an act of the
  domain, and has no History or *Open Roadmap*, and its menu has no *Attach a Roadmap* or *Copy Link*; the note's field
  sets bold and italic alone, from the system's Format menu on iOS 26; the title menu has no *Guide*, *Activity*,
  *Share…* or *Export*, New Roadmap starts a blank roadmap alone, from no plan or file, and All Roadmaps has no
  gallery. The Graph draws the picture, pans and zooms it, selects a step and opens its page, lists the Up next steps
  under *Next*, brings the one chosen there or by *Open in Graph* into view, and shows the whole roadmap alone under
  *Fit*; it has no Find, no mark on a step that opens a roadmap, and draws no proposal and no reader's cover; no link
  or Coach is built, and the Board has no pasted steps. The app has no associated domain, and its onboarding says
  roadmap is on the web.
- `RoadmapDomain` holds the pure reads, the entities, the rule book, the replica read and every action of the
  room, of a roadmap, its steps, kinds, progress and workspace and of what a device tells once: no Undo scene,
  plan grammar or Coach executor.
- Activity and History have no read (§3): no case states one, and neither the web's domain nor Swift's gives it.
- One SwiftUI `Canvas` in the room's Graph draws `RoadmapLayout`'s picture (`apps/ios/App/Sources/Roadmap/Graph/`).
  The budget of §5 is measured at 5,000 steps on a Mac's simulator alone, by `apps/ios/App/Tools/graph_bench.sh` on a
  Release-configuration build: the picture's time with its layout, the domain's read taken for it, the room's part of
  a frame at five cameras, the time from the switch to the first frame, and the frames a scripted pan and pinch are
  given with the main actor's work in each. On an M3 Pro the first frame takes about a fifth of its second, and a
  frame of the whole roadmap about three fifths of its sixtieth on the main actor, which is no margin for an iPhone
  XR. `apps/ios/GraphBench` draws the same picture on a device's own screen and measures the first frame and the
  frames of a scripted pan and pinch at five cameras. On an iPhone 13 mini, the one phone that has run it, `Canvas`
  holds 60 frames a second at 1,000 steps at every camera and at 5,000 steps at every camera but a pinch with the
  whole roadmap in view, where about a seventh of the frames come late, more than the budget's tenth; the first
  frame takes about a sixth of its second. For that pinch the room holds three other ways to keep the frames while
  more than 500 steps are in view, each drawing at rest what the canvas draws now: the picture drawn at a few stops
  of the pinch and scaled between them, each disc drawn as one square, and the canvas composited through
  `drawingGroup` at every camera. The room uses none of them, and the benchmark takes each by name: the simulator holds the budget
  under all four and so cannot choose, and no phone has run the three. No older phone has measured the Graph, and a
  canvas that misses the budget on a phone reports it (§11).
- Roadmap's runner holds a removal for the engine's nine seconds (`AppRuntime.roadmapRunner`), and the room runs
  eighteen acts through it: `MarkStep` (Complete and Reset), `DeleteStep` and `DeleteRoadmap`, each with *Undo*, and
  `DeleteStep` composed for several steps chosen on the Board, with one *Undo*; `CreateStep`, `ChangeStep` and
  `ChangePrerequisites`, composed into the step form's one save with one *Undo*, and `ChangeStep` composed for several
  steps recolored on the Board, with one *Undo*; `CreateRoadmap` for a blank roadmap and `WriteRoadmap` for a roadmap's
  name, of which it keeps none; of a roadmap's kinds `CreateKind`, `ChangeKind` and `RecolourKind`, of which it keeps
  none, and `DeleteKind`, which the engine does not hold, with *Undo* for six seconds; and of a step's workspace
  `ChangeSubtask`, with *Undo* of a subtask checked, `DeleteSubtask` and `DeleteStepLink`, each held with *Undo*, and
  `AddSubtask`, `AddStepLink` and the note's draft save, `SaveStepNote`, of which it keeps none. Every other action of
  the domain has no door in the room: `MoveKind`, `MoveStep`, a subtask's or a link's change of words and its move
  among them.
- The plan grammar has no Swift port: the web's (`web/src/products/roadmap/paste/`) is its one
  implementation, and the web alone runs its cases (`packages/api-contract/roadmap/plan/`).
- The grammar's writer does not write every roadmap so that it reads back the same, as §7.3 needs.
  A description is written raw, so a line of it that looks like a list item, a heading or an
  address reads back as a step, a kind or a link; a name that begins like a checkbox reads back as
  a mark; a name with a line break breaks the file's first line; and steps on a loop are not
  written. In a file an export wrote, text before the first step is dropped, where §7.1 keeps
  every line. The cases of `write.json` and `read.json` pin each as it stands.
- The domain's read of a roadmap carries no `forkedFrom`, which the gallery's row reads (§3).
- Roadmaps that hold `unlisted` are not moved to private (R-9).
- The app's Info.plist names no Markdown type (§7.3).

## §14 Rulings

| | Question | Ruling |
|---|---|---|
| R-1 | What the room syncs through | The shared sync engine and the Swift domain kit, not a client of roadmap's former sync. (2026-11-17) |
| R-2 | Coach on the iPhone | In the first release, on the open screen as the design draws it. (2026-11-17) |
| R-3 | Nested roadmaps and guides | Full parity with the web in the first version. (2026-11-17) |
| R-4 | Which links open the app | Shared links and a person's own links. (2026-11-17) |
| R-5 | Where a form commits | In the toolbar, as every other form. (2026-11-17) |
| R-6 | Renaming and deleting a roadmap, and managing kinds, on the iPhone | All are in the first version: rename and delete a roadmap, and add, rename, recolour and remove a kind. Each is drawn as a proposal and approved first. (2026-11-17) |
| R-7 | Unlocked rows in Activity and History | Not shown in the first version; the boards are redrawn without them. (2026-11-21) |
| R-8 | The author on a gallery row | A row shows its roadmap's title and step count alone; no name of a person is made public. (2026-11-21) |
| R-9 | A roadmap whose visibility is `unlisted` | Every such roadmap is moved to private, and Share has two states, public and private. (2026-11-21) |
| R-10 | What the server is for | Synchronization and sharing, whether a person shares or Coach does it for them. Every read and change of a person's own roadmap, and every other ability of Coach, works on the device's copy. (2026-11-21) |
| R-11 | Where Activity and History come from | The device's copy, by a read of the domain; no request to the backend. (2026-11-21) |
| R-12 | Whether sharing's requests move into synchronization | Decided when links and readers are built; until then the gallery, Fork and the owner's progress on a cover stay requests. (2026-11-21) |
| R-13 | Quests on the iPhone | Not offered: New Roadmap starts a roadmap blank, from a copied plan or from a file. Quests return with a design of their own. (2026-11-23) |
