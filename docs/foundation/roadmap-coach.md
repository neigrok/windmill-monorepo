# Roadmap Coach

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
definitions (`D-n`), invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and
roadmap nodes can cite them.

## §0 Status and scope

**Status:** Specified; nothing is built. The roadmap's AI today is tending: a server-side agent that
edits a roadmap at once from one sentence (`backend/products/roadmap`, `TendingApi`). What a person
sees of Coach is ruled in the [design canon](../design/roadmap-coach.md); this document says how it
is built. The build order lives in the Roadmap Coach roadmap tree, which the dogfood tree
(`t_9362d9bc883e0a1e`) opens from the node `roadmap-coach`.

**Scope:** Coach in the roadmap room on the web: the turn that runs in the browser, the abilities it
calls on the browser's own copy of a roadmap, the proposals a person reviews and applies, and the
records of a conversation. The catalog, its vectors and the records are written so that the iPhone's
Roadmap room builds the same Coach on them.

**Out of scope:** The screens, which the design canon holds. The [AI service](ai-service.md), which
makes each model call. Gym Coach's own move onto the device (AI service I-3). The iPhone room, which
does not exist yet. `POST /v1/compose`. The roadmap tools an outside assistant reaches over MCP,
which stay on the server.

**Depends on:** the AI service's text door, and the backend signing passes for it (AI service I-1).

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
  each model round is one call to the AI service. (R-2)
- **P-6 One engine, a Coach a product.** The engine that runs a turn names no product. Roadmap
  gives it a prompt, a catalog and a tool host, and keeps its own conversations. (R-3)

## §2 Vocabulary

*Ability*, *catalog*, *tool host*, *gate*, *turn*, `turnId`, *model call* and *seat* mean what
[phone-hosted Coach abilities](mobile/gym_coach.md) D-1 to D-11 define. This document adds:

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
- **D-9 Profile.** What a product gives the engine: its prompt, catalog, tool host, limits and the
  model class it asks for.

Two words are kept apart throughout: a *link* joins a step to a prerequisite; a *web link* is an
address a step carries.

## §3 Where things live

```text
packages/api-contract/roadmap/
  catalog.json            the abilities Coach is offered (§4)
  abilities/              vectors: an input, a roadmap, the result or the writes it must give
  limits.json             the caps the server enforces, for every client to check first (§6)
web/src/platform/coach/   the engine: the turn, the gate's shared rules, the AI service client,
                          conversation records. Names no product (P-6)
web/src/products/roadmap/
  domain/abilities/       each ability as a pure function of a roadmap and an input
  coach/                  roadmap's profile: prompt, context, the tool host over the copy,
                          proposals, receipts
```

- An ability is a pure function: it takes a roadmap as plain data and an input, and returns what it
  read, or the writes to make, or a refusal. It touches no network, store or clock. The tool host
  hands it the roadmap and carries out the writes it returns.
- The plain data an ability is handed is the standing roadmap (D-2), together with what only the
  copy knows and diagnostics need: links to steps that are gone, links from a step to itself, and
  removed steps that still have steps after them.
- The rules a write must keep live in the ability, not in the screen that calls it. Rules the room's
  own controls enforce today, such as refusing a link that closes a cycle or a second kind of one
  hue, move into the ability the control and Coach then share.
- The vectors pin rules, not the shape of a tool: where the server's tools for an outside assistant
  keep the same rule (the caps, what a web link may be, how a step's state follows its
  prerequisites), one vector holds both to it.

## §4 The catalog

`packages/api-contract/roadmap/catalog.json` has the shape of gym's: each entry is `{name,
description, input, result, class, agent, seats, phrase, ui}`. Catalog `roadmap/1` holds:

| Ability | Class | Runs | What it does |
|---|---|---|---|
| `get_tree` | reads | on the copy | A page of a roadmap's steps with the fields asked for, its title, kinds and guide |
| `get_nodes` | reads | on the copy | Steps by exact id |
| `find_nodes` | reads | on the copy | Steps by kind, state or text; `state: available` is the frontier |
| `get_progress` | reads | on the copy | The person's completed steps, with the dates the copy holds |
| `get_diagnostics` | reads | on the copy | What is wrong with the graph: cycles, links to missing steps, self links, masked work, smells |
| `list_trees` | reads | **on the backend** | One line for each roadmap the person owns. Offered only in a conversation about all roadmaps |
| `set_progress` | writes | on the copy | Marks one step done or not done |
| `rename_node` | writes | on the copy | Changes one step's title |
| `annotate_node` | writes | on the copy | Changes one step's description or its web links |
| `create_node` | writes | on the copy | Adds one step, after the prerequisites named |
| `connect` | writes | on the copy | Adds one link between two steps |
| `propose_roadmap_change` | proposes | on the copy | Mints a proposal of one or more changes to one roadmap (§7) |

- `list_trees` is the one backend ability. The list of everything an account owns is not something
  a device holds or synchronization carries; the backend answers it, and the device adds the
  roadmaps that live on it alone. (R-5)
- The room itself reads one fact from the backend when it opens a roadmap: what the roadmaps its
  steps open have come to. Coach reads what the room holds of that and asks for nothing more (§5).
- Withheld from Coach: creating, deleting, renaming and sharing a roadmap, its guide, the roadmaps a
  step opens, removing or reordering kinds, and adding a kind outside a proposal.
- Every `writes` ability changes one step and removes nothing. Removing, merging, splitting,
  unlinking, and anything touching two or more steps exist only as changes of a proposal.
- An ability's `agent` value is fixed in the catalog. Whether the person asked for exactly this
  change in this message, which the design's rule for a direct write requires, is the prompt's to
  judge; the gate enforces what can be checked (§8). (R-8)

**INV-1.** No ability applies or rejects a proposal, and no turn does. Only the person's Apply or
Reject on the review does. Minting a proposal replaces the one pending before it (§7), and that is
all an ability can do to another proposal.

## §5 Reading

**The context.** Before the first model call of a turn the tool host builds the context from the
standing roadmap and sends it with the question. For a conversation about one roadmap it holds: the
title and kinds; every step on one line (id, label, kind, state, prerequisite ids, the count it
unlocks, the description cut to about 160 characters); the person's completed steps with the dates
the copy holds; a summary of diagnostics; and the last ten completions that carry a date. Above
about 300 steps it holds counts by kind and state, every milestone, the frontier and its two-hop
neighbourhood, and Coach pages the rest with the read abilities. A conversation started from a step
adds that step in full.

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
   offers its own controls. A reader's Coach answers questions and is offered no `writes` or
   `proposes` ability.
3. **The server will take it.** The write is inside the caps of `limits.json`: a label of 200
   characters, a description of 16,000, 10,000 steps, 20,000 links, 32 web links a step with a label
   of 200 and an address of 2,048, an id of 128, 6 kinds with a label of 24 and a description of 80.
   The server refuses a whole frame that breaks a cap and resends nothing of it until the person
   deals with the refusal, so an over-cap write is refused on the device as `over-limit` and never
   sent.
4. **The graph stays whole.** `connect` and `create_node` refuse a link that would close a cycle or
   name a step the roadmap does not hold. A web link's address starts with `http:`, `https:` or
   `mailto:`. A new step names a kind the roadmap has, or takes terracotta as the room's own control
   gives it.
5. **A new id is random.** The tool host mints a new step's id as the room's controls do, from a
   random source, so two devices that add a step offline never mint the same one.
6. **Marks keep their rules.** A step that opens a roadmap takes no mark.

The check and the write run in one synchronous task, so nothing arriving from the server or from the
person's hand comes between them. A door that answers that it wrote nothing is `roadmap-not-ready`
or `no-change`, never success.

- **INV-2.** Coach holds no door of its own to a roadmap. Every write it makes is one the room's own
  doors made, so it is saved, sent, retried, merged and refused exactly as the person's is.
- A change Coach makes is the person's own on the wire and in the room's Activity; the receipt in
  the conversation is what says Coach made it. (R-7)
- A direct write leaves a receipt and offers Undo in the room's band. For a change to structure,
  Undo reverts that one act and spares anything written since. For a mark, Undo marks the step back,
  and a completion's first date is not restored. The means to undo live in the tab's memory: after a
  reload, or once the server makes the room rebuild a part of the roadmap, the receipt stays and
  Undo is no longer offered.
- A refusal from the server after the write was made stands as the room shows every refusal, with
  Retry and Discard. The receipt then reads that the change did not land.

## §7 Proposals

`propose_roadmap_change` takes `{treeId, changes[]}` and mints one proposal. A change is one of:

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
| `rename_kind`, `recolor_kind` | A kind's label or hue |

The ability folds the changes in order over a scratch copy of the standing roadmap, validating each
as §6 validates a write, and refuses a set that could not be applied. It also refuses, as
`roadmap-changed`, a set that touches a register which has moved since this turn read it, so the
model reads again and never proposes over an edit it has not seen.

A proposal is a record (§9): `{id, treeId, threadId, messageId, base, changes[], state, act}`.

- `base` names, for every step a change mentions, whether the step exists and the stamp of its
  being there; for every register a change writes, that register's stamp; and for `set_progress`,
  the mark's. An `add_step` records that its id is unheld. They are the stamps the turn's reads
  returned, read from the copy, so they exist for a roadmap that has never reached the server.
- `state` is `pending`, `applying`, `applied`, `rejected`, `stale` or `replaced`.
- A roadmap has one pending proposal. Minting another marks the earlier one `replaced`. When two
  devices each mint one before they sync, the later stays pending and the earlier is replaced.

**Apply**, pressed by the person on the review:

1. The record must still be `pending`. The device writes it `applying`.
2. The proposal is out of date when anything in `base` differs from the copy: a stamp that is not
   the one recorded, a step that has gone or come. The changes are then folded and validated again
   over the standing roadmap as it is now; a set that no longer validates is out of date too. An
   out-of-date proposal becomes `stale` and nothing is written.
3. Otherwise the folded result is reduced to one write for each register and written as one act on
   the device: the structure under one stamp through the structure door, and the marks with it
   through the mark door. The act's stamp is written to the record as `act`.
4. The record becomes `applied`.
5. Undo is offered for 6 s in the room's band. It reverts the act, and the record returns to
   `pending`.

- **INV-3.** A proposal applies whole or not at all on the device. On the wire it is the person's
  own writes: structure and marks travel apart, and a large act travels as several frames.
- **INV-4.** An applied proposal is never set aside because the roadmap changed elsewhere. It merges
  as any two edits do, and nothing about a later sync returns it to the person for a second look. It
  can still meet a refusal that any write can meet (§6), which the checks before Apply exist to
  prevent; a person who discards a refused write discards these changes with it, and the record then
  becomes `stale`.
- A record found `applying` when the engine starts is settled by its `act`: `applied` when the copy
  holds that stamp, `pending` when it does not.
- `applied` outranks every other state when two devices' records meet. Two devices that both apply
  one proposal before they sync write the same changes with the same ids, and they merge as one.
- Reject marks the record `rejected` and writes nothing to the roadmap.
- A roadmap that lives on the device can take a new id when an account claims it. The claim rewrites
  the roadmap's id in the conversations and proposals about it.

## §8 The turn

The engine runs a turn as [phone-hosted Coach abilities](mobile/gym_coach.md) §4.2 specifies the
loop, with the device in the server's place and the AI service's text door
([AI service §6.2](ai-service.md#62-the-wire)) as the model:

1. The device writes the person's message and a Coach message in state `running`, whose id is the
   `turnId`.
2. It builds the request: the profile's system prompt and tool list from the catalog, the earlier
   conversation as text (at most 24 turns and 24,000 bytes), then the context and the question, with
   one picture when the person added one.
3. It calls the text door. The `callId` of round *n* is derived from the `turnId` and *n*, so a round
   whose answer was lost is asked for again and not paid for twice.
4. On `ended` with `stop`:
   - `completed`: the turn ends `completed`.
   - `tool_calls`: each call passes the gate, runs on the tool host, and its result goes back with
     the assistant message and its `carry`; the loop continues.
   - `truncated`: the turn ends `completed` with `truncated`.
   - `declined`: the turn ends `declined`.
5. A refusal or `failed` from the service ends the turn `failed` with its code. Writes already made
   stay made.
6. Reaching `MAX_MODEL_CALLS` without `completed` ends the turn `failed`.

**The gate.** Every ability call passes these, in order, before it runs. A refused call returns to
the model as an error result with its code, and the model continues.

| | Rule |
|---|---|
| G-1 Offered | The name is in the catalog version the turn opened with and is offered to Coach |
| G-2 Seat | The ability's `seats` admits the turn's seat, and a `writes` or `proposes` ability needs the roadmap's owner |
| G-3 Shape | The input validates against the ability's schema at every depth |
| G-4 One proposal | At most one `propose_roadmap_change` succeeds for each roadmap in a turn |
| G-5 Volume | At most `MAX_ABILITY_CALLS` calls and `MAX_DIRECT_WRITES` direct writes in a turn |
| G-6 Stop | After Stop, every remaining call is refused |

G-1, G-2's seat half, G-3, G-5 and G-6 are the engine's; the rest are roadmap's profile.

**Stop, reloads and tabs.**

- Stop takes effect before the next model call or ability call. The call in flight finishes and is
  paid for, as the AI service reads every call to its end.
- The conversation the model needs to continue lives in the tab's memory. A reload, a closed tab or
  a crash ends the turn `interrupted` when the engine next starts; the question stays on the record.
- The tab that opened a turn owns it and writes a `runningTurn` row. Another tab shows the turn as
  answering elsewhere and does not write it.
- Asking needs a connection; when there is none the question stays in the field. Reading History,
  reviewing and applying a proposal need none.

**The profile's values.** Roadmap asks for the model class `large`, which the AI service serves to
an installation as `medium`. `MAX_MODEL_CALLS` is 8, `MAX_ABILITY_CALLS` 12, `MAX_DIRECT_WRITES` 6.
A call asks for at most 2,000 output tokens and at least 1,024.

**The pass.** The engine asks the backend for a pass when it has none that is still good and
presents it on every call. It never stores a pass beyond the tab.

**The prompt** is a file of the web bundle, written with the owner. A person can read it there; it
holds no secret.

## §9 Records and History

Coach's records are private to a person and are no part of a roadmap's shared structure, which a
reader of a shared roadmap can see. They are records of the [sync engine](engine.md), in a registry
of roadmap's own, with the shapes gym's Coach uses: (R-4)

| Record | Holds |
|---|---|
| `thread` | One conversation: its scope (a roadmap's id, or all roadmaps), the step it started from if any, its title |
| `message` | One message: who wrote it, its text, and for Coach's its state, `truncated`, refusal code, what it read, its receipts and the id of a proposal it carries |
| `proposal` | §7 |
| `runningTurn` | A device row: the turn this device is running |

- A turn's states are gym's: `running`, then `completed`, `declined`, `failed`, `stopped` or
  `interrupted`.
- History is one list of every conversation, each tagged with its roadmap or with "All roadmaps".
- Deleting a roadmap deletes the conversations about it. The device that deletes it deletes them; a
  device that learns a roadmap is gone deletes the conversations it holds about it. Conversations
  about all roadmaps stay.
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
- A direct write lands only on the roadmap a conversation is about. In a conversation about all
  roadmaps Coach changes a roadmap only through a proposal, which names the one roadmap it changes.
- Applying a proposal to a roadmap other than the one on screen opens that roadmap first, so the
  review shows what is applied.

## §11 Signed out

The design rules that everything works signed out: asking, direct writes, reviewing and applying.
On the web that needs two things the browser lacks today. (R-6)

- **A credential to ask with.** The AI service admits an installation on a pass the backend signs
  for an installation credential. No such credential exists in the browser.
- **A place for the records.** A signed-out person's conversations and proposals live on the device
  and reach the account at sign-in, as a roadmap kept on the device does.

A signed-out person's roadmap already lives on the device, so abilities, receipts, review and Apply
need nothing more: they never leave the copy.

## §12 What retires, and what stays

When Coach ships on the web for a signed-in person, these go (design ruling 11):

- `POST /v1/trees/{id}/tend`, `GET /v1/tend/{runId}`, `GET /v1/tending`, the service and prompt
  behind them, the `tend_runs` table and the run quota of 30 and 300 a month;
- `web/src/products/roadmap/tending/`, the AI meter in settings, and the room's Ask AI entry; ⌘K
  opens Coach.

The roadmap tools an outside assistant reaches over MCP stay on the server as they are.

## §13 Observability

- The device emits, with no text of the person's or the model's: `roadmap_coach_turn` (outcome:
  answered, stopped, refused with its code, failed, offline), `roadmap_coach_ability` (the ability
  and its outcome or refusal code), `roadmap_proposal_decided` (applied, rejected, stale, replaced)
  and `roadmap_coach_write_undone`.
- A write Coach makes emits the product event and the Activity row the room's own control emits for
  the same change. Those are emitted by the controls today, so they move with the rules into the
  shared path (§3).
- Unexpected failures of the engine, the tool host and the AI service client report to Sentry under
  static names. A refusal the person can act on is an event, not an Issue.
- The backend logs nothing of a turn but the pass it signed and the `list_trees` read.
- They are listed in the web observability notes when built.

## §14 What the copy's sync must gain

Reading `web/src/products/roadmap/sync` and the room against §5 to §7 on 2026-11-14 found these
gaps. Each is work of this build.

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
- The claim that moves a device's roadmap to a new id rewrites no record that names it (§7).

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
| R-4 | Where conversations and proposals are stored | Open. Assumed: records of the sync engine in a registry of roadmap's own, since they are private and belong to no one roadmap's shared structure. The design's engineering note put the proposal in the roadmap's own copy. |
| R-5 | Which abilities call the backend | Open. Assumed: `list_trees` alone, with each roadmap's counts by state, frontier titles and last completion date added to what the backend lists. |
| R-6 | Signed-out Coach on the web | Open. Assumed: Coach ships first for a signed-in person, and signed out follows once the browser has an installation credential and a place for a signed-out person's records. |
| R-7 | Whether Coach's writes are told apart from the person's | Open. Assumed: not on the wire or in Activity, where a change Coach made is the person's own. The receipt in the conversation says Coach made it. Telling them apart elsewhere needs the server's log of changes to carry who acted. |
| R-8 | How "you asked for exactly this" is enforced | Open. Assumed: by the prompt. The gate enforces that a direct write touches one step, removes nothing and stays within the turn's volume. |
| R-9 | What `merge` and `split` do | Open. Assumed: as §7's table says. The design draws them as change kinds and does not say what each writes. |

What this document changes in the design's engineering note is listed in the
[consistency ledger](../design/consistency.md).
