# Roadmap Coach

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
definitions (`D-n`), invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and
roadmap nodes can cite them.

## §0 Status and scope

**Status:** Specified, and approved by the owner on 2026-11-15; nothing is built. The roadmap's AI today is tending: a server-side agent that
edits a roadmap at once from one sentence (`backend/products/roadmap`, `TendingApi`). What a person
sees of Coach is ruled in the [design canon](../design/roadmap-coach.md); this document says how it
is built. The build order lives in the Roadmap Coach roadmap tree, which the dogfood tree
(`t_9362d9bc883e0a1e`) opens from the node `roadmap-coach`.

**Scope:** Coach in the roadmap room on the web: the turn that runs in the browser, the abilities it
calls on the browser's own copy of a roadmap, the proposals a person reviews and applies, and the
records of a conversation. The catalog, its vectors and the records are written so that the iPhone's
Roadmap room builds the same Coach on them.

**Out of scope:** The screens, which the design canon holds; a screen is built only from a board the
owner has marked ready, and the boards for the review, signed out and History are still proposals.
The [AI service](ai-service.md), which makes each model call. The engine that runs a turn, the AI
client and the pass door, which the [Coach engine](coach-engine.md) holds. Gym Coach's own move onto
the device ([Gym Coach on the AI service](gym-coach-on-ai-service.md)). The iPhone room, which does
not exist yet. `POST /v1/compose`. The roadmap tools
an outside assistant reaches over MCP, which stay on the server as a catalog of their own.

**Depends on:** the [Coach engine](coach-engine.md), and through it the AI service's text door and
the backend signing passes for it (AI service I-1).

## §1 The rule

The owner's default for every Coach, ruled on 2026-11-14. (R-1)

- **P-1 Abilities run on the device's copy.** Coach reads and changes a roadmap through the copy the
  browser already keeps of it, never through a call to the server.
- **P-2 A change is an ordinary local write.** Whatever Coach changes goes through the same door as
  the person's own gesture, and reaches the server and every other device by synchronization.
- **P-3 What is missing is brought, not asked for.** A roadmap Coach needs and the device does not
  hold is brought onto the device by synchronization and then read there.
- **P-4 A backend ability is an exception with a reason.** An ability may call the backend only for
  a fact synchronization does not carry. The catalog names each one and why. There is one (§4).
- **P-5 The turn runs on the device.** The loop, the gate and the system prompt are the device's;
  each model round is one call to the AI service ([Coach engine](coach-engine.md) P-1). (R-2)
- **P-6 One engine, a Coach a product.** The [Coach engine](coach-engine.md) that runs a turn names
  no product. Roadmap gives it a profile and a tool host, and keeps its own conversations. (R-3)

## §2 Vocabulary

*Ability*, *catalog*, *tool host*, *turn*, `turnId` and *seat* mean what
[phone-hosted Coach abilities](mobile/gym_coach.md) D-1 to D-10 define. *Round*, *profile*, *mark*
and *gate* mean what the [Coach engine](coach-engine.md) defines. This document adds:

- **D-1 Copy.** What the browser holds of one roadmap: its structure and the person's own progress,
  as `web/src/products/roadmap/sync` keeps them, durable across reloads and usable offline.
- **D-2 Standing roadmap.** A roadmap as the room shows it: the steps, links, kinds and marks on the
  screen. It is the copy, less a step under a delete the person can still undo, and with the marks
  the room shows, which for a reader are the owner's.
- **D-3 Direct write.** A change Coach makes at once, to one step, that removes nothing (§6).
- **D-4 Receipt.** The record of a direct write: what changed, in at most eight words.
- **D-5 Proposal.** A set of changes to one roadmap that Coach suggests and only the person applies
  (§7).
- **D-6 Change.** One entry of a proposal, of one kind (§7).
- **D-7 Conversation scope.** What a conversation is about: one roadmap, or all of the person's.
- **D-8 Context.** What Coach is told about a roadmap at the start of every turn, before it calls
  anything (§5).

Two words are kept apart throughout: a *link* joins a step to a prerequisite; a *web link* is an
address a step carries.

## §3 Where things live

```text
packages/api-contract/roadmap/
  catalog.json            the abilities Coach is offered (§4)
  abilities/              vectors: a roadmap, an input, the result or the writes it must give
  domain/                 vectors of a turn's opening and end, as gym's folder holds gym's
  limits.json             the caps the server enforces, for every client to check first (§6)
web/src/products/roadmap/
  domain/                 the abilities, each a pure function of a roadmap and an input, with the
                          rules they share with the room's controls
  coach/                  roadmap's profile: prompt, context, the tool host over the copy,
                          proposals, receipts
```

- An ability is a pure function: it takes a roadmap as plain data and an input, and returns what it
  read, or the writes to make, or a refusal. It touches no network, store or clock. The tool host
  hands it the roadmap and carries out the writes it returns.
- The plain data an ability is handed is the standing roadmap (D-2), together with what only the
  copy knows and diagnostics need: links to steps that are gone, links from a step to itself, and
  removed steps that still have steps after them.
- The rules a write must keep live with the abilities, not in the screen that calls them. Rules the
  room's own controls enforce today, such as refusing a link that closes a cycle or a second kind of
  one hue, move there, and so does the function that derives a step's state. The control and Coach
  then share them, under the web's rule for what a product's `domain/` may import.
- The vectors pin rules, not the shape of a tool. Where the server's tools for an outside assistant
  keep the same rule (the caps, how a step's state follows its prerequisites), one vector holds both
  to it. What a web link may be is already pinned in `packages/api-contract/roadmap-link-urls.json`
  and is read from there.
- The engine and the AI client live where the [Coach engine](coach-engine.md) §3 puts them.

## §4 The catalog

`packages/api-contract/roadmap/catalog.json` has the shape and the vocabulary of gym's: each entry
is `{name, description, input, result, class, agent, seats, phrase, ui}`, `class` is `read`, `add`,
`change` or `remove`, and `agent` is `runs`, `proposes` or `withheld`. Catalog `roadmap/1` holds:

| Ability | `class` | `agent` | Runs | What it does |
|---|---|---|---|---|
| `get_tree` | read | runs | on the copy | A page of a roadmap's steps with the fields asked for, its title, kinds and guide |
| `get_nodes` | read | runs | on the copy | Steps by exact id |
| `find_nodes` | read | runs | on the copy | Steps by kind, state or text; `state: available` is the frontier |
| `get_progress` | read | runs | on the copy | The person's completed steps, with the dates the copy holds |
| `get_diagnostics` | read | runs | on the copy | What is wrong with the graph: cycles, links to missing steps, self links, masked work, smells |
| `list_trees` | read | runs | **on the backend** | One line for each roadmap the person owns. Offered only in a conversation about all roadmaps |
| `set_progress` | change | runs | on the copy | Marks one step done or not done |
| `rename_node` | change | runs | on the copy | Changes one step's title |
| `annotate_node` | change | runs | on the copy | Changes one step's description or its web links |
| `create_node` | add | runs | on the copy | Adds one step, after the prerequisites named |
| `connect` | add | runs | on the copy | Adds one link between two steps |
| `propose_roadmap_change` | change | proposes | on the copy | Mints a proposal of one or more changes to one roadmap (§7) |

- `list_trees` is the one backend ability. The list of everything an account owns is not something
  a device holds or synchronization carries; the backend answers it, and the device adds the
  roadmaps that live on it alone. (R-5)
- The room itself reads one fact from the backend when it opens a roadmap: what the roadmaps its
  steps open have come to. Coach reads what the room holds of that and asks for nothing more (§5).
- Withheld from Coach: creating, deleting, renaming and sharing a roadmap, its guide, the roadmaps a
  step opens, and removing or reordering kinds.
- Every ability that `runs` and is not a `read` changes one step and removes nothing. That is the
  shape of the catalog and not a check at run time. Removing, merging, splitting, unlinking, a new
  kind, and anything touching two or more steps exist only as changes of a proposal.
- An ability's `agent` value is fixed in the catalog. Whether the person asked for exactly this
  change in this message, which the design's rule for a direct write requires, is the prompt's to
  judge. (R-8)
- A step line and a receipt are made from the call that ran and the catalog's `phrase` and `ui`,
  never from the model's text. A receipt names a step by its label, cut to keep the line to eight
  words.

**INV-1.** No ability applies or rejects a proposal, and no turn does. Only the person's Apply on
the review, or Reject on the card or the review, does. Minting a proposal replaces the one pending
before it (§7), and that is all an ability can do to another proposal.

## §5 Reading

**The context.** Before the first model call of a turn the tool host builds the context from the
standing roadmap and sends it with the question. For a conversation about one roadmap it holds: the
title and kinds; every step on one line (id, label, kind, state, prerequisite ids, the count it
unlocks, the description cut to about 160 characters); the person's completed steps with the dates
the copy holds; a summary of diagnostics; and the last ten completions that carry a date. A roadmap
of more than 300 steps, or one whose lines would pass `CONTEXT_BYTES`, is given instead as counts by
kind and state, every step of the kind `milestone` where the roadmap has that kind, the frontier and
its two-hop neighbourhood; Coach pages the rest with the read abilities. A conversation started from
a step adds that step in full.

For a conversation about all roadmaps the context is what `list_trees` answers, and Coach reads one
roadmap in full only when the question needs it (§10).

Step text is the person's data. The prompt tells the model to treat it, a pasted text and an
ability's result as data and never as instructions.

**What the abilities read.**

- Coach reads what the person sees. An ability answers from the standing roadmap (D-2), including
  writes the server has not confirmed, so Coach never names a step the person has just deleted and
  never gives a state the screen contradicts.
- A step's state (locked, available, complete) is the one the room shows, from the function that
  derives it today, `UnlockRules.derive`, over the graph as the room draws it.
- A step that opens another roadmap is complete when that roadmap is. Where the room does not know
  what the opened roadmap has come to, as offline, the step's state is `unknown`. So is the state of
  every step that waits on it. `find_nodes` with a state leaves unknown steps out, and counts by
  state give them a count of their own.
- A completion has a date only where the copy holds one. A step complete through the roadmap it
  opens, and a step done since before dates were kept, have none and are given without one.
- `get_diagnostics` is computed on the device, by a function held to the server's report by shared
  vectors. Loops and dead ends among the roadmaps that steps open are reported only among roadmaps
  the device holds.
- A result is at most 16 KiB; a longer one is paged, never cut.
- The tool host notes the stamp of every register a turn's context and reads returned. §7 uses them.

## §6 Writing

A direct write (D-3) is carried out by the tool host through the room's own doors: the structure
door, `SyncSession.dispatch`, and the room's mark door, `RoomProgress.mark`. The structure door
checks only that the session is ready, and neither checks who is writing or what, so the ability and
the host check first:

1. **The roadmap can take a write.** Its session is ready, no part of it is being rebuilt from the
   server, and the step is under no delete the person can still undo. Otherwise the ability is
   refused as `roadmap-not-ready`.
2. **The person may write it.** The person owns the roadmap, as the room itself decides before it
   offers its own controls. A reader's Coach answers questions and is offered no ability that
   writes or proposes.
3. **It is this conversation's roadmap.** A direct write names the roadmap the conversation is
   about. A conversation about all roadmaps is offered no direct write.
4. **The server will take it.** The write is inside the caps of `limits.json`: a label of 200
   characters, a description of 16,000, 10,000 steps, 20,000 links, 32 web links a step with a label
   of 200 and an address of 2,048, an id of 128, 6 kinds with a label of 24 and a description of 80.
   The server refuses a whole frame that breaks a cap and resends nothing of it until the person
   deals with the refusal, so an over-cap write is refused on the device as `over-limit` and never
   sent.
5. **The graph stays whole.** `connect` and `create_node` refuse a link that would close a cycle or
   name a step the roadmap does not hold. A web link's address is one the contract allows. A new
   step names a kind the roadmap has, or takes terracotta as the room's own control gives it.
6. **A new id is random.** The tool host mints a new step's id as the room's controls do, from a
   random source, so two devices that add a step offline never mint the same one. An ability call
   runs once, on the device, so nothing needs an id it could mint again.
7. **Marks keep their rules.** A step that opens a roadmap takes no mark.

The check and the write run in one synchronous task, so nothing arriving from the server or from the
person's hand comes between them. A door that answers that it wrote nothing is `roadmap-not-ready`
or `no-change`, never success.

- **INV-2.** Coach holds no door of its own to a roadmap. Every write it makes is one the room's own
  doors made, so it is saved, sent, retried, merged and refused exactly as the person's is.
- A change Coach makes is the person's own on the wire and in the room's Activity; the receipt in
  the conversation is what says Coach made it. (R-7)
- A direct write leaves a receipt and offers Undo in the room's band for 6 s. For a change to
  structure, Undo reverts that one act and spares anything written since. For a mark, Undo marks the
  step back, and a completion's first date is not restored. The means to undo live in the tab's
  memory.
- A message's receipts are final once its turn has ended. What became of a write afterwards, that it
  was undone or that the server refused it, is a record of its own (§9), so the receipt can read
  "Undone" on every device.
- A refusal from the server after the write was made stands as the room shows every refusal, with
  Retry and Discard.

## §7 Proposals

`propose_roadmap_change` takes `{treeId, changes[]}`, of at most 100 changes, and mints one
proposal. A change is one of:

| Change | Writes |
|---|---|
| `add_step` | A new step with its label, kind, description and prerequisites. Its id is minted with the proposal |
| `remove_step` | The step is removed. Each step after it follows the removed step's own prerequisites |
| `rename`, `describe` | One step's label or description |
| `set_kind` | One step takes a kind, named by the kind's id |
| `connect`, `disconnect` | One link added or removed |
| `merge` | Two steps become one: every link into and out of the second is re-pointed to the first, and the second is removed |
| `split` | One step becomes several: the new steps each follow the old step's prerequisites and precede what it unlocked, and the old step is removed |
| `set_progress` | One step marked done or not done |
| `add_kind`, `rename_kind`, `recolor_kind` | A new kind, or a kind's label or hue |

The ability folds the changes in order over a scratch copy of the standing roadmap, validating each
as §6 validates a write, and refuses a set that could not be applied. It also refuses, as
`roadmap-changed`, a set that touches a register which has moved since this turn read it, so the
model reads again and never proposes over an edit it has not seen.

A proposal is a record (§9): `{id, treeId, threadId, messageId, base, changes[], state, undone}`.

- `base` names, for every step a change mentions, whether the step exists and the stamp of its
  being there; for every register a change writes, that register's stamp; and for `set_progress`,
  the mark's. An `add_step` records that its id is unheld. They are the stamps the turn's reads
  returned, read from the copy, so they exist for a roadmap that has never reached the server.
- `state` is `pending`, then one of `applied`, `rejected`, `stale` or `replaced`, and never moves
  again. The four outrank `pending` when two devices' records meet, as the sync engine ranks a
  field, and `applied` outranks the other three.
- `undone` is set once, when the person undoes an applied proposal.
- A roadmap has one pending proposal. Minting another marks the earlier one `replaced`. Where two
  devices each mint one before they sync, the one born later stays pending, and any device that
  holds both marks the earlier `replaced`.

**Apply**, pressed by the person on the review:

1. The record must be `pending`. The device writes a row of its own, `applying`, naming the
   proposal. A proposal with such a row on this device is not applied a second time.
2. The proposal is out of date when anything in `base` differs from the copy: a stamp that is not
   the one recorded, a step that has gone or come. The changes are then folded and validated again
   over the standing roadmap as it is now; a set that no longer validates is out of date too. An
   out-of-date proposal becomes `stale` and nothing is written.
3. Otherwise the folded result is reduced to one write for each register and written as one act on
   the device: the structure under one stamp through the structure door, and the marks with it
   through the mark door. The act's stamp is written to the device's row.
4. The record becomes `applied`, and the row is removed.
5. Undo is offered for 6 s in the room's band. It reverts the act and sets `undone`. An undone
   proposal is not offered again; the person asks Coach for another.

- **INV-3.** A proposal applies whole or not at all on the device. On the wire it is the person's
  own writes: structure and marks travel apart, and a large act travels as several frames.
- **INV-4.** An applied proposal is never set aside because the roadmap changed elsewhere. It merges
  as any two edits do, and nothing about a later sync returns it to the person for a second look.
- A row found `applying` when the engine starts is settled by its act: the record becomes `applied`
  when the copy holds that stamp, and the row is removed either way.
- Two devices that both apply one proposal before they sync write the same changes with the same
  ids, and they merge as one.
- Reject marks the record `rejected` and writes nothing to the roadmap.
- A roadmap that lives on the device can take a new id when an account claims it. The claim of the
  roadmap comes first; the conversations and proposals about it then take the new id, which those
  fields allow.

## §8 The turn

A turn runs as the [Coach engine](coach-engine.md) says: its loop, Stop and what ends a turn (§5),
its gate (§6), its access states (§7) and its AI client (§4). This section says what roadmap gives
it.

**The first content.** The earlier conversation, at most 24 turns and 24,000 bytes; the context
(§5); one picture when the person added one; and the question.

**The gate.** Beyond the engine's rules, roadmap's tool host refuses:

| Rule | |
|---|---|
| Owner | An ability that writes or proposes needs the roadmap's owner |
| Scope | A direct write names the conversation's roadmap |

The profile names one group the gate allows once in a turn: `propose_roadmap_change`, for each
roadmap. It counts toward the write cap every ability that runs and is not a read. Gym's rule on
minted ids has no part here (§6).

**Tabs and the record.**

- The mark is the device row `runningTurn:<turnId>`, which holds the round in flight as the engine's
  mark does.
- A running turn's text is written to its message at most once a second, so another tab or device
  sees the answer grow.
- Asking needs a connection; when there is none the question stays in the field. Reading History,
  reviewing and applying a proposal need none.

**Access.** The words and states a person sees are gym Coach's, as the design rules. No amount is
shown.

**The profile's values.** Roadmap asks for the model class `large`, which the AI service serves to
an installation as `medium`, with the effort gym's Coach asks for and the label
`roadmap.coach.turn`. `MAX_MODEL_CALLS` is 8, `MAX_ABILITY_CALLS` 12, `MAX_WRITES` 6 and
`CONTEXT_BYTES` 64 KiB. A call asks for at most 2,000 output tokens and at least 1,024. A message, a
question and a picture keep gym's bounds.

**The words.** The prompt is a file of the web bundle, written with the owner, and so are the
words of the first content and the sentence the model reads beside each refusal code. A person can
read them there; they hold no secret.

## §9 Records and History

Coach's records are private to a person and are no part of a roadmap's shared structure, which a
reader of a shared roadmap can see. They are records of the [sync engine](engine.md), in a registry
for the product `roadmap` under the scope `self/roadmap`, beside gym's and journal's in the
composition. (R-4) The engine's own appendix sketches roadmap types for a roadmap's structure; this
registry holds Coach's records only and builds none of those.

| Type | Holds |
|---|---|
| `coachThread` | One conversation: its scope (a roadmap's id, or all roadmaps), the step it started from if any, its title. The registry's primary type |
| `coachMessage` | One message, in the shape of gym's `message`: who wrote it, its text, pictures, and for Coach's its state, `truncated`, refusal code, the calls it made, its receipts and the id of a proposal it carries |
| `coachProposal` | §7 |
| `coachWriteFate` | What became of one receipt's write after its turn ended: undone, or refused by the server |

A device also keeps rows of its own, which do not sync: the mark (§8), `applying` (§7) and a
picture's original, as gym keeps one.

- A turn's states are gym's: `running`, then `completed`, `declined`, `failed`, `stopped` or
  `interrupted`. Once a turn has ended, its message's text, calls and receipts are final.
- History is one list of every conversation, each tagged with its roadmap or with "All roadmaps",
  the current roadmap's first, filtered by roadmap from the title.
- Deleting a roadmap deletes the conversations and proposals about it. The backend, which deletes a
  roadmap for every device, deletes the records that name it; a device that deletes a roadmap living
  on it alone deletes them itself. Conversations about all roadmaps stay.
- The opening of a turn and its end are declared once in the domain kit and proven by shared
  vectors, as gym's are, so the iPhone writes the same records.

**INV-5.** Nothing the model needs to continue a turn is written to a record: not the assistant
messages' `carry`, not an ability's full result. A record holds what a person reads.

## §10 Other roadmaps

- `list_trees` answers, for each roadmap the person owns: its title, its counts by state, the titles
  of its frontier and the date of its last completion. The backend's list carries the title and the
  counts of all and of done today, and gains the rest. The device adds the roadmaps that live on it
  alone, which the backend does not know.
- To read a roadmap the device does not hold, the tool host opens it without showing it and waits,
  within a time limit, until both its structure and the person's marks have arrived; a roadmap that
  does not arrive is refused as `roadmap-unavailable`. It is then on the device like any roadmap the
  person has opened, and enters the device's list under the title `list_trees` gave. (P-3)
- A roadmap the room already holds is read through the room's own session, never a second one. A
  roadmap opened for Coach is closed when the turn ends, and before the room opens it.
- In a conversation about all roadmaps Coach changes a roadmap only through a proposal, which names
  the one roadmap it changes (§6).
- Applying a proposal to a roadmap other than the one on screen opens that roadmap first, so the
  review shows what is applied.

## §11 Signed out

The design rules that everything works signed out: asking, direct writes, reviewing and applying.
Coach goes live on the web only when it works signed out too. (R-6) A signed-out person's roadmap
already lives on the device, and the browser's sync engine already keeps a signed-out person's
records and carries them to the account at sign-in. What the web lacks, and this build adds, is:

- **A credential to ask with.** The AI service admits an installation on a pass the backend signs
  for an installation credential. No such credential exists in the browser.
- **A screen for sign-in when both sides hold conversations.** The sync engine asks a person what to
  do with a device's records when the account already has some. No board draws that for Coach.

## §12 What retires, and what stays

When Coach ships on the web, these go (design ruling 11):

- `POST /v1/trees/{id}/tend`, `GET /v1/tend/{runId}`, `GET /v1/tending`, the service and prompt
  behind them, the `tend_runs` table and the run quota of 30 and 300 a month;
- `web/src/products/roadmap/tending/`, the AI meter in settings, and the room's Ask AI entry; ⌘K
  opens Coach.

The roadmap tools an outside assistant reaches over MCP stay on the server as they are.

## §13 Observability

- The device emits, with no text of the person's or the model's:
  - `roadmap_coach_opened`, with the entry it was opened from;
  - `roadmap_coach_ask_refused`, with its reason, when a question could not be asked: offline, or an
    access state;
  - `roadmap_coach_turn`, with the turn's end state (§9), whether it was truncated, and its refusal
    code;
  - `roadmap_coach_ability`, with the ability and its outcome or refusal code;
  - `roadmap_coach_stopped`, `roadmap_coach_picture_added`, `roadmap_proposal_review_opened`;
  - `roadmap_proposal_decided` (applied, rejected, stale, replaced) and
    `roadmap_coach_write_undone`.
- A write Coach makes emits the product event and the Activity row the room's own control emits for
  the same change. Those are emitted by the controls today, so they move with the rules into the
  shared path (§3).
- Unexpected failures report to Sentry under the static names `roadmap-coach-turn`,
  `roadmap-coach-ability`, `roadmap-coach-apply` and `ai-call`. A refusal the person can act on is
  an event, not an Issue.
- The backend logs nothing of a turn but the pass it signed and the `list_trees` read.
- They are listed in the web observability notes when built.

## §14 What must be built beneath Coach

Reading `web/src/products/roadmap`, the sync engine and the backend against this document on
2026-11-14 found these gaps. Each is work of this build.

In the copy's sync:

- No gesture changes the web links of an existing step; `annotate_node` needs one.
- No gesture carries several changes of different kinds under one stamp, and none merges or splits
  steps. Apply (§7) needs one act for structure, made from a folded set of changes.
- Marks have no journal to undo from and travel apart from structure. Apply writes both, and its
  Undo must take both back.
- Reverting an act reports success even when every register it wrote has since been overwritten.
  Undo after Apply must know whether anything was taken back.
- The caps of §6 are not checked on the device, and a second kind of one hue is refused only by the
  legend's own control.
- The session does not read what the server says it refused of a batch or of a mark.
- A session says when its structure has joined and not when the person's marks have (§10).
- Sessions for a second roadmap are opened today only to claim a device's roadmaps, one at a time.
  Nothing opens one beside the room's and reads it.
- Diagnostics are computed on the server alone, and a step has no `unknown` state (§5).
- A link to a step deleted elsewhere becomes masked work with an offer to restore it. The design
  rules that it is replaced by the deleted step's own prerequisites, with a line in the band saying
  so.

In the sync engine and the backend:

- Roadmap has no registry in the composition, and the backend stores and admits none of §9's types.
- The backend's delete of a roadmap deletes no record that names it (§9).
- The backend's list of roadmaps lacks what §10 adds to it.
- Roadmap is not a consumer of the domain kit, which §9's shared vectors make it.

Not carried to the device, and so not part of Coach: the server's `outOfOrder` flag on a mark, which
only an outside assistant's mark sets, and the guides of the roadmaps above one.

## §15 Rulings

The design's eleven rulings of 2026-11-08 stand as the [design canon](../design/roadmap-coach.md)
states them. This document's own:

| | Question | Ruling |
|---|---|---|
| R-1 | Where Coach's abilities run | On the device's copy by default, with every change travelling by synchronization. An ability that calls the backend is a rare exception. (2026-11-14) |
| R-2 | Where the turn runs | On the device: the loop, the gate and the prompt. Each model round is a call to the AI service. (2026-11-14) |
| R-3 | One Coach or one per product | One engine; a separate Coach in each product with its own prompt, abilities and conversations. (2026-11-14) |
| R-4 | Where conversations and proposals are stored | As records of the sync engine in a registry of roadmap's own, since they are private and belong to no one roadmap's shared structure. (2026-11-15) |
| R-5 | Which abilities call the backend | `list_trees` alone, with each roadmap's counts by state, frontier titles and last completion date added to what the backend lists. (2026-11-15) |
| R-6 | Signed-out Coach on the web | It ships together with signed-in Coach: Coach does not go live on the web until both work. (2026-11-15) |
| R-7 | Whether Coach's writes are told apart from the person's | In the conversation only, where the receipt says Coach made the change. On the wire and in Activity a change Coach made is the person's own. (2026-11-15) |
| R-8 | How "you asked for exactly this" is enforced | By the prompt. The catalog's shape keeps a direct write to one step that removes nothing, and the gate keeps it within the turn's volume. (2026-11-15) |
| R-9 | What `merge` and `split` do | As §7's table says. (2026-11-15) |
| R-10 | An applied proposal the server then refuses | A proposal is applied on the device and then synced, and the server can refuse the synced change: a cap reached by an edit elsewhere, a roadmap deleted or no longer the person's. The refusal stands as it does for a person's own edit, with Retry and Discard, and the record stays `applied`. (2026-11-15) |
| R-11 | One allowance while gym's Coach is metered elsewhere | Roadmap Coach is built beside gym's move and goes live only after the server's gym Coach has closed ([Gym Coach on the AI service](gym-coach-on-ai-service.md) §8), so a person never holds two allowances for Coach. (2026-11-15) |
| R-12 | The Windmill One button on the web | The web shows no such button while Windmill One cannot be bought there. It says the allowance is used up and when it returns. (2026-11-15) |

The design draws none of these, and each needs a board before it is built: Coach for a person who
only reads a roadmap; a card whose proposal was applied and then undone; a replaced card; and the
sign-in question of §11.

What this document changes in the design's engineering note is listed in the
[consistency ledger](../design/consistency.md).
