# Roadmap Coach

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Sections, principles (`P-n`),
definitions (`D-n`), invariants (`INV-n`) and rulings (`R-n`) are numbered so reviews, code and
roadmap nodes can cite them.

## §0 Status and scope

**Status:** Specified, and approved by the owner on 2026-11-15, and again on 2026-11-17 as revised
for roadmap on the sync engine (R-13) and Coach on the iPhone in the first release (R-14). Of Coach
its contract is built: the catalog, its limits and the format of its vectors (§3); and on the web
the standing roadmap (D-2), the read abilities (§4, §5), the context (D-8, §5), the direct writes
(§6) and the proposal's fold and ability (§7), in `web/src/products/roadmap/domain/abilities/`, which claim every
vector; and the tool host that carries the reads and the direct writes out, the writes through the room's doors, in
`web/src/products/roadmap/coach/toolHost.js`, which runs no proposal yet. On the iPhone the standing roadmap, the read abilities,
the direct writes and the proposal's fold and ability are built, which claim every vector but the context's, with
the tool host's executor over the phone's copy, which runs no proposal yet, in `apps/ios/Domain/Sources/RoadmapDomain/Coach/`.
Its records are built (§9): the four types in roadmap's registry, which the server stores and admits, a roadmap's death
taking the conversations and proposals about it whatever made it, and, on the web and the iPhone, the records as
roadmap's entities with a turn's opening, end and withdrawal, the read of a conversation, a proposal minted, which
replaces the one pending about its roadmap, the read of that pending one, and a roadmap's delete taking its
conversations, in `web/src/products/roadmap/domain/conversation.js` and
`apps/ios/Domain/Sources/RoadmapDomain/Coach/Conversation.swift`, proven by
`packages/api-contract/roadmap/domain/conversation-actions.json`; and a proposal decided, applied as the person's own act
and settled, rejected, and marked undone once its Undo took something back (§7), in
`web/src/products/roadmap/domain/apply.js` and `apps/ios/Domain/Sources/RoadmapDomain/Coach/Apply.swift`, proven by
`packages/api-contract/roadmap/domain/apply-actions.json` and the `Roadmap Coach §7` scenes of `undo.json`. No surface offers
Apply or Reject yet. Signed out, the records reach the account at sign-in with the roadmaps they name, and the sign-in
question on the web and the iPhone counts the conversations (§11). What a turn writes beyond its opening and end, its calls
and receipts among them, and History's read are built on both domains (`turnRecords.js`, `TurnRecords.swift`, proven by
`turn-records-actions.json`), and the iPhone claims the context's vectors too. On the iPhone a turn runs: Coach in the room,
behind a build switch off in Release, runs on the Coach engine's Swift libraries with roadmap's profile over the phone's
copy, with its composer, conversation, receipts and Undo, History and What Coach Read (`apps/ios/App/Sources/Roadmap/Coach/`);
it offers no proposal yet. No turn runs on the web yet. The roadmap's AI today is tending: a server-side agent that edits a
roadmap at once from one sentence (`backend/products/roadmap`, `TendingApi`). What a person
sees of Coach is ruled in the [design canon](../design/roadmap-coach.md); this document says how it
is built. The build order lives in the Roadmap Coach roadmap tree, which the dogfood tree
(`t_9362d9bc883e0a1e`) opens from the node `roadmap-coach`.

**Scope:** Coach in the roadmap room, on the web and on the iPhone: the turn that runs on the
device, the abilities it calls on the device's own copy of a roadmap, the proposals a person reviews
and applies, and the records of a conversation. One catalog, one set of vectors and the same records
serve both surfaces.

**Out of scope:** The screens, which the design canon holds; a screen is built only from a board the
owner has marked ready, as the owner has marked the boards for the review, signed out and History
(the last of them, 07.1, 07.2 and 08.1, on 2026-11-24).
The [AI service](ai-service.md), which makes each model call. The engine that runs a turn, the AI
client and the pass door, which the [Coach engine](coach-engine.md) holds. Gym Coach's own move onto
the device ([Gym Coach on the AI service](gym-coach-on-ai-service.md)). The iPhone's room
([Roadmap on iOS](roadmap-ios.md)). The roadmap tools an outside assistant reaches over MCP, which
stay on the server as a catalog of their own. A paste is split into steps by the plain parser alone; making a roadmap from pasted material is
Coach's to take up.

**Depends on:** [Roadmap on the sync engine](roadmap-on-the-engine.md), whose registry and shared
domain the abilities are built on; the [Coach engine](coach-engine.md), and through it the AI
service's text door and the backend signing passes for it (AI service I-1).

## §1 The rule

The owner's default for every Coach, ruled on 2026-11-14. (R-1)

- **P-1 Abilities run on the device's copy.** Coach reads and changes a roadmap through the copy the
  device keeps of it, never through a call to the server.
- **P-2 A change is an ordinary local write.** Whatever Coach changes goes through the same door as
  the person's own gesture, and reaches the server and every other device by synchronization.
- **P-3 What is missing is brought, not asked for.** A roadmap Coach needs and the device does not
  hold is brought onto the device by synchronization and then read there.
- **P-4 A backend ability is an exception with a reason.** An ability may call the backend only for
  a fact synchronization does not carry. The catalog names each one and why. There is none (§4).
- **P-5 The turn runs on the device.** The loop, the gate and the system prompt are the device's;
  each model round is one call to the AI service ([Coach engine](coach-engine.md) P-1). (R-2)
- **P-6 One engine, a Coach a product.** The [Coach engine](coach-engine.md) that runs a turn names
  no product. Roadmap gives it a profile and a tool host, and keeps its own conversations. (R-3)

## §2 Vocabulary

*Ability*, *catalog*, *tool host*, *turn*, `turnId` and *seat* mean what
[phone-hosted Coach abilities](mobile/gym_coach.md) D-1 to D-10 define. *Round*, *profile*, *mark*
and *gate* mean what the [Coach engine](coach-engine.md) defines. This document adds:

- **D-1 Copy.** What the device holds of one roadmap in its replica of the sync engine
  ([Roadmap on the sync engine](roadmap-on-the-engine.md)): its structure and the person's own marks
  and workspace, durable and usable offline.
- **D-2 Standing roadmap.** A roadmap as the room shows it: the steps, links, kinds and marks on the
  screen, and on a roadmap of the person's own each step's checklist, its subtasks. It is the copy,
  less a step under a delete the person can still undo, and with the marks the room shows. For a
  reader those are the owner's, which the room read from the backend, with what the server said each
  subtree the roadmap's steps own has come to; Coach reads what the room holds of them and asks for
  nothing.
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
  limits.json             the caps the server enforces, for every client to check first (§6)
  abilities/              vectors: the roadmaps, an input, and the result, the writes or the refusal
                          they must give, the context's among them; its README.md has the format
  check.py                the Coach contracts workflow's check of the three against this document's
                          tables, and of each cap against the sources it names
  coach/                  the words the model reads: the system prompt, as gym's coach/ holds them
  domain/                 roadmap's shared domain corpus, where a turn's opening and end are proven
                          as gym's are (§9)
web/src/products/roadmap/
  domain/                 the abilities and the context, each a pure function of a roadmap and an
                          input, with the rules they share with the room's controls
  coach/                  roadmap's profile: prompt, first content, the tool host over the copy,
                          proposals, receipts
apps/ios/Domain/Sources/RoadmapDomain/
                          the same abilities and rules in Swift, with the tool host's executor
```

- `domain/` is roadmap's domain on the domain kit, which
  [Roadmap on the sync engine](roadmap-on-the-engine.md) §9 gives its rules, actions and reads. The
  abilities are built on those and add none of their own.

- An ability is a pure function: it takes a roadmap as plain data and an input, and returns what it
  read, or the writes to make, or a refusal. It touches no network, store or clock. The tool host
  hands it the roadmap and carries out the writes it returns.
- The plain data an ability is handed is the standing roadmap (D-2), together with what only the
  copy knows and diagnostics need: links to steps that are gone, links from a step to itself, and
  the removed steps whose records the copy holds, through which what a step follows is read.
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

`packages/api-contract/roadmap/catalog.json` has the shape and the vocabulary of gym's
`catalog-3.json`: each entry is `{name, description, input, result, class, agent, seats, strict,
phrase, ui}`, `class` is `read`, `add`, `change` or `remove`, and `agent` is `runs`, `proposes` or
`withheld`. Catalog `roadmap/1` holds:

| Ability | `class` | `agent` | Runs | What it does |
|---|---|---|---|---|
| `get_tree` | read | runs | on the copy | A page of a roadmap's steps with the fields asked for, its title, kinds and guide |
| `get_nodes` | read | runs | on the copy | Steps by exact id |
| `find_nodes` | read | runs | on the copy | Steps by kind, state or text; `state: available` is the frontier |
| `get_progress` | read | runs | on the copy | The person's completed steps, with the dates the copy holds |
| `get_diagnostics` | read | runs | on the copy | What is wrong with the graph: cycles, links to missing steps, self links, smells, and pointer loops |
| `list_trees` | read | runs | on the copy | One line for each roadmap the person owns. Offered only in a conversation about all roadmaps |
| `set_progress` | change | runs | on the copy | Marks one step done or not done |
| `update_node` | change | runs | on the copy | Changes one step's title, description or web links, or adds items to its checklist |
| `create_node` | add | runs | on the copy | Adds one step, after the prerequisites named |
| `connect` | add | runs | on the copy | Adds one link between two steps |
| `propose_roadmap_change` | change | proposes | on the copy | Mints a proposal of one or more changes to one roadmap (§7) |

- No ability calls the backend. A signed-in device holds every roadmap its person owns, so
  `list_trees` and what a step's opened roadmap has come to are read from the copy. (R-5)
- Withheld from Coach: creating, deleting, renaming and sharing a roadmap, its guide, the roadmaps a
  step opens, removing or reordering kinds, editing, checking or removing a step's subtasks, and its
  note and private links. Coach only adds a subtask, through `update_node` (R-16).
- Every ability that `runs` and is not a `read` changes one step and removes nothing. That is the
  shape of the catalog and not a check at run time; the catalog's check refuses an ability that
  `runs` and is a `remove`. Removing, merging, splitting, unlinking, a new kind, and anything
  touching two or more steps exist only as changes of a proposal.
- Every ability's `seats` is `any`, since everything works signed out (§11). Every `strict` is
  `false`, so a turn declares no tool strict to the provider; every input keeps to what each schema
  check reads and strict mode accepts, so declaring one strict is one word.
- An input names a roadmap as `treeId` and a step as `nodeId`, as the server's tools for an outside
  assistant do, and a link by the step that waits, `nodeId`, and the step it waits on,
  `prerequisiteId`. No cap of §6 is part of a schema, so a value past one reaches the ability, which
  refuses it as `over-limit`. A read takes `cursor` for the page after the first (§5.2), and its
  `result` carries `maxBytes`, 16384.
- Every ability states its answer's schema: a read's in §5.1, a direct write's in §6 (`create_node`
  answers the id it minted, `{nodeId}`, and the others `{}`), and a proposal's in §7.
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
roadmap's id, title and kinds; its guides, as the server's `get_tree` gives them to an outside
assistant, each `{treeId, title, text, yours}`: on a roadmap the person owns, the guides of their
roadmaps above it and then its own, farthest first and at most eight, and on one they only read, its
own alone, which is never theirs; every step on one line, §5.1's default fields (id, label, kind,
state, prerequisite ids, the count it unlocks and the description's summary); the person's completed
steps with the dates the copy holds; a summary of diagnostics; and the last ten completions that carry
a date. A guide is the roadmap's author's note to an AI, and Coach reads it as an outside assistant
does.

A conversation started from a step adds that step in full, every field §5.1 answers but the summary
and the subtasks, where the roadmap shows the step; Coach reads its checklist with `get_nodes`. Its
`prerequisites` carry their first 50 ids, and
`prerequisitesOmitted` counts the rest where there are more, which Coach reads with `get_nodes`; no
other field of the step in full is a list of ids. The step counts toward `CONTEXT_BYTES` and stays
whole.

A roadmap of more than 300 steps, or one whose context so given would pass `CONTEXT_BYTES` (the step
a conversation started from counted), is given instead around where the person stands: its step
lines and its completed steps give way to counts by kind and state and to the lines of the steps
around the frontier, and the rest of the context stays. Those lines are taken in this order, each
group in `get_tree`'s order and a step in the first group it falls in: the frontier, so it is never
left off while a milestone is in; every step of the kind `milestone` where the roadmap has that kind;
and the frontier's two-hop neighbourhood, every step within two links of it with each link read both
ways: its prerequisites and theirs, the steps that wait on it and on those, the other steps that wait
on its prerequisites, and the other prerequisites of the steps that wait on it. A line is taken while
the whole context, its guides and started step included, stays within `CONTEXT_BYTES`, and `omitted`
counts the lines left off; Coach pages the rest with the read abilities.

Of the rest, only the guides and the started step can carry the context past `CONTEXT_BYTES` before
any line is taken. Stored text refuses NUL alone, and canonical text writes any other control
character in six bytes, so at the caps (a title of 200 characters and a guide of 5,000, the
registry's; six kinds, ids of 128 characters, labels of 200, descriptions of 16,000 and 32 web links,
as `limits.json` holds them) the context with no line taken comes to at most 35,641 bytes without its
guides and started step, one guide adds up to 31,266, eight bring it to 285,776, and the started step
alone comes to as much as 242,097. Where the context with no line taken would pass `CONTEXT_BYTES`,
the guides give way, the farthest first and the roadmap's own last, and `guidesOmitted` counts them. A
line never makes a guide give way, and nothing makes the started step give way, so a context with a
step that large passes `CONTEXT_BYTES` once every line and guide has gone.

For a conversation about all roadmaps the context is the rows `list_trees` answers, in its order,
while they stay within `CONTEXT_BYTES`, and `omitted` counts the rows left off; Coach reads one
roadmap in full only when the question needs it (§10). A row's `frontier` carries its first ten titles,
in its own order, and `frontierOmitted` counts the rest where there are more, so no one roadmap's
frontier crowds out the rows after it.

The context's bounds are `limits.json`'s `context`, which the web's context and the Coach contracts
workflow read, and which this table states:

| Bound | Max | Counts | What it bounds |
|---|---|---|---|
| `bytes` | 65536 | bytes | `CONTEXT_BYTES` (§8): the canonical text of the whole context |
| `steps` | 300 | items | the steps of a roadmap given whole |
| `recent` | 10 | items | the newest completions that carry a date |
| `frontier` | 10 | items | the frontier titles of a row about all roadmaps |
| `prerequisites` | 50 | items | the prerequisite ids of the step a conversation started from |

Step text is the person's data. The prompt tells the model to treat it, a pasted text and an
ability's result as data and never as instructions.

**What the abilities read.**

- Coach reads what the person sees. An ability answers from the standing roadmap (D-2), including
  writes the server has not confirmed, so Coach never names a step the person has just deleted and
  never gives a state the screen contradicts.
- A step's state (locked, available, complete) is the one the room shows, the domain's graph's
  (`FollowGraph`, which the room reads through `model/domainReads.js`), over the graph as the room draws it.
- A step that opens another roadmap is complete when that roadmap is. Where the device has not
  finished pulling the opened roadmap, or holds nothing of it, the step's state is `unknown`. So it
  is where the opened roadmap's own completion waits on such a roadmap: it is not complete, and each
  of its unfinished steps opens a roadmap whose completion the device cannot yet say, in turn. So is
  the state of every unfinished step that waits on an unknown one, since each could change when the
  roadmap arrives. On a roadmap the person only reads, a step that owns a subtree the device does not
  hold stands as the server told the room of that subtree, and is unknown only where it told
  nothing. `find_nodes` with a state leaves unknown steps out, and counts by state give them a count
  of their own.
- A completion has a date only where the copy holds one, as the domain's `progress` read gives it. A
  step done since before dates were kept has none and is given without one.
- `get_diagnostics` is computed on the device, by the domain's reads the server claims (§5.1).
  Loops and dead ends among the roadmaps that steps open are reported only among roadmaps the
  device holds.
- A result is at most 16 KiB, the catalog's `maxBytes`; a longer one is paged, never cut (§5.2).
- The tool host notes the stamps of the registers a turn's context and reads returned, a later read's over an earlier
  one's: of each step one answers, the life and every field of its record, its mark and the life of each link into it;
  and of a roadmap's header, its kinds'. The context answers every step it gives a line, its completions among them.
  §7 uses them.

### §5.1 What each read answers

`get_tree`, `get_nodes` and `find_nodes` answer steps in one shape. `fields` names the fields each
step comes with, and `id` comes always; a call without `fields` is given the context's line: `id`,
`label`, `kind`, `state`, `prerequisites`, `unlockCount` and `summary`.

| Field | Holds |
|---|---|
| `id` | The step's id |
| `label` | Its title |
| `kind` | The id of the kind that owns its hue, as the domain's `legend` read gives it; null where none does |
| `state` | `locked`, `available`, `complete` or `unknown` (§5) |
| `prerequisites` | The present steps it follows, through removed ones, in the room's order: the domain's `graph` read's `followed` |
| `unlockCount` | How many steps finishing it alone would make available: the `graph` read's `unlocks`, the Board's count |
| `summary` | The description, cut after 160 Unicode scalars with `…` added where it is longer |
| `description` | The whole description |
| `links` | Its web links, `{url, label}`, in order |
| `subtasks` | Its checklist, the person's own workspace, `{label, done}`, in order; empty on a roadmap the person only reads |
| `opens` | The id of the roadmap it opens, the subtree it owns or one it points to; null where it opens none |

- `get_tree` answers `{tree?, steps, nextCursor?}`. `tree`, the roadmap's header, opens the answer:
  `{title, kinds, guide, stepCount}`, the kinds in the room's order as `{id, label, hue,
  description}`, the roadmap's own guide and how many steps it has. Each step comes after every step
  it follows; of the steps that can come next, the one first in the room's order (`ord`, then birth,
  then id) comes first. A step on a loop, or after one, comes last, in id byte order.
- `get_nodes` answers `{steps, nextCursor?}`, in the order asked. An id asked twice is
  `invalid-input`, and an id the roadmap does not hold refuses the call as `unknown-step`, naming
  the first such id in the order asked.
- `find_nodes` answers `{steps, nextCursor?}` in the order of the domain's `search` read, which the
  server claims: a step must match every filter sent, `query` folds ASCII letters alone to one case
  as that read does, and a `kind` the roadmap does not have matches no step.
- `get_progress` answers `{completed, nextCursor?}`: each step the person has completed, `{id, at}`,
  in id byte order, `at` the date the domain's `progress` read gives it, or null where it gives none.
  The server's tool calls the list `completed` too.
- `get_diagnostics` answers what the server's tool answers of a roadmap read through the shared
  domain, from the domain's `diagnostics` and `pointers` reads, which the server claims:
  `{cycles, dangling, selfEdges, smells}`, and on a roadmap the person owns `treeLoops` and
  `danglingPointers`. A cycle is `{count, nodes}`, its size and its first ten steps; `dangling` and
  `selfEdges` hold links as `{from, to}`; `smells` hold `{kind: "empty-legend"}`, then
  `{kind: "unclaimed-hue", hue, count, nodes}` for each hue no kind wears, then `{kind, count,
  nodes}` for `label-too-long`, `empty-icon` and `high-in-degree`; `treeLoops` hold
  `{node, path, pathOmitted?}`, a path of `{treeId, title}`, and `danglingPointers` hold
  `{node, treeId}`. Each list holds its first 50, with `cyclesOmitted`, `danglingOmitted`,
  `selfEdgesOmitted`, `treeLoopsOmitted` or `danglingPointersOmitted` beside it counting the rest
  where any is left off. What a step follows is read through removed steps, so a loop of removed
  steps alone is not listed and no step's work is masked.
- `list_trees` answers `{trees, nextCursor?}`: one row for each roadmap the person owns that
  stands, in the order of the domain's `list` read, newest first, as `{id, title, counts, frontier,
  lastCompletedAt}`. `counts` is `{total, done, available, locked, unknown}`, `frontier` the titles
  of its available steps in `get_tree`'s order, and `lastCompletedAt` the newest date its
  completions carry, or null where none carries one. A roadmap the device has not finished bringing
  has its `counts`, `frontier` and `lastCompletedAt` null, and the `title` its copy holds, null where
  the copy holds none. `id`, `title`, `total` and `done` are the server's names.

### §5.2 Pages

A read answers a sequence of objects in pages of at most 16,384 bytes of canonical text (the
vectors' [README](../../packages/api-contract/roadmap/abilities/README.md)), each measured as it is
sent, with its `nextCursor`, `part` and `parts`. `get_tree`'s sequence is its header and then its
steps; `get_nodes`' and `find_nodes`' are their steps, `get_progress`' its completions, `list_trees`'
its rows, and `get_diagnostics`' the entries of its lists, list after list in key order. A page
carries every list of its read, each with the entries that fall on it, and the first page carries
`get_diagnostics`' `…Omitted` counts.

1. A page takes whole objects in order while it stays within the cap. It carries `nextCursor` when
   the sequence goes on after it, and the next call sends that as `cursor`.
2. An object that would not fit a page alone is sent in parts, one a page, and starts a page of its
   own. Each part but the last fills its page as far as whole Unicode scalars of text, and whole
   elements of a list, allow. The page of the last part goes on taking whole objects after it.
3. Part 1 carries every field the object answers, each long field as far as it fits and empty where
   none of it does; each later part carries the rest of the long fields that go on there. The long
   fields are a step's `description`, `links`, `prerequisites` and `subtasks`, the header's `guide`
   and a row's `frontier`, filled in key order; no other object of a read can pass a page. A later
   part of a step or a row carries its `id`; one of the header comes under `tree`, which names it.
   Every part carries `part`, from 1, and `parts`, their number, and a reader joins the parts' texts
   and lists in order.
4. `nextCursor` is `<index>.<part>.<digest>`: the position, from 0, of the object the next page
   starts with; the part of it to start from, 1 for a whole object; and the first 16 lower-case
   hexadecimal digits of the SHA-256 of the canonical text of `{"read": …, "continues": …}`. `read`
   is what the pages stand on: the ids of the steps of `get_tree` and `find_nodes`, of the
   completions of `get_progress` and of the rows of `list_trees`, in order, and every object of
   `get_nodes` and `get_diagnostics`, whole, which is all they read. `continues` is the object the
   position is inside, whole as the read answers it, where the part is past the first, and null
   otherwise; so a text edited between its part pages changes the digest.
5. A cursor is checked in this order. One not of this form is `invalid-input`. One whose digest is
   not the read's now is `roadmap-changed`, and Coach reads again from the first page. One whose
   position the sequence does not hold, past its end or past the parts of its object, is
   `invalid-input`. The cursor holds the position alone, and each call sends its `fields` again.
   `get_nodes` reads its objects whole, so a cursor sent with other fields does not match its digest;
   the digest of `get_tree` and `find_nodes` holds their ids alone, so there a cursor sent with other
   fields goes on from its position, each step that follows with the fields now asked for.

## §6 Writing

A direct write (D-3) is carried out by the tool host as the domain's own actions, the ones the
room's controls run, and answers as this table says:

| Ability | The room's action | Answers |
|---|---|---|
| `set_progress` | `Complete` or `Reset` | `{}` |
| `update_node` | `ChangeStep`, its `label`, `description` and `links`, each sent replaced whole, and `AddSubtask` for each item added to the step's checklist, the parts of one act | `{}` |
| `create_node` | `CreateStep`, under the id the tool host mints | `{nodeId}` |
| `connect` | `ChangePrerequisites`, one link added | `{}` |

The ability and the host check first:

1. **The roadmap can take a write.** The device holds it whole, else `roadmap-unavailable`, and the
   step is under no delete the person can still undo, else `roadmap-not-ready`.
2. **The person may write it.** The person owns the roadmap, as the room itself decides before it
   offers its own controls. A reader's Coach answers questions and is offered no ability that
   writes or proposes. Otherwise the call is refused as `not-owner`.
3. **It is this conversation's roadmap.** A direct write names the roadmap the conversation is
   about, or is refused as `out-of-scope`. A conversation about all roadmaps is offered no direct
   write.
4. **The server will take it.** The write is inside the caps of `limits.json`, or it is refused on
   the device as `over-limit` and never sent. Each cap names the constant of the backend's
   `domain/Command.h` that holds it where one does, the declaration of the sync registry the engine
   admits it by, and the web domain's spec of it where there is one, and the Coach contracts
   workflow fails when any of them, or `limits.json`, differs from this table:

   | Cap | Max | Counts | Backend | Registry | Web |
   |---|---|---|---|---|---|
   | `id` | 128 | characters | `kMaxIdLength` | `node.id`, `kind.id` | |
   | `label` | 200 | characters | `kMaxNodeLabelLength` | `node.label` | `label` |
   | `description` | 16000 | characters | `kMaxNodeDescriptionLength` | `node.description` | `description` |
   | `steps` | 10000 | items | `kMaxNodes` | `node` | |
   | `links` | 20000 | items | `kMaxEdges` | `edge` | |
   | `webLinks` | 32 | items | `kMaxNodeLinks` | `node.links` | `links` |
   | `webLinkLabel` | 200 | characters | `kMaxLinkLabelLength` | `node.links.label` | `linkLabel` |
   | `webLinkAddress` | 2048 | characters | `kMaxLinkUrlLength` | `node.links.url` | `linkUrl` |
   | `subtaskLabel` | 200 | characters | | `subtask.label` | `subtask` |
   | `subtasks` | 20000 | items | | `subtask` | |
   | `kinds` | 6 | items | `kMaxKinds` | `kind` | |
   | `kindLabel` | 24 | characters | `kMaxKindLabelLength` | `kind.label` | `kindLabel` |
   | `kindDescription` | 80 | characters | `kMaxKindDescriptionLength` | `kind.description` | `kindDescription` |
   | `proposalChanges` | 100 | items | | `coachProposal.changes` | |
   | `proposalChangesBytes` | 65536 | bytes | | `coachProposal.changes` | |
   | `proposalBaseBytes` | 262144 | bytes | | `coachProposal.base` | |

   Characters are Unicode code points, and bytes those of a value's canonical text, as the engine
   measures a field that is not text. A value is measured as the domain stores it: an address after
   its trim. The last three hold a proposal's record (§7).
5. **The graph stays whole.** `connect` and `create_node` refuse a link that would close a cycle
   (`closes-cycle`) or name a step the roadmap does not hold (`unknown-step`). A web link's address
   is one the contract allows (`address-not-allowed`). A new step names a kind the roadmap's legend
   shows, as the room's own control offers them (`unknown-kind`), or takes terracotta as that control
   gives it.
6. **A new id is random.** The tool host mints a new step's id as the room's controls do, from a
   random source, so two devices that add a step offline never mint the same one. An ability call
   runs once, on the device, so nothing needs an id it could mint again.
7. **Marks keep their rules.** A step that opens a roadmap takes no mark (`opens-roadmap`), one whose
   roadmap no longer stands among them, as the room offers no mark on either. A locked
   step is not marked complete (`step-locked`): the room offers no Complete on it, and only an
   outside assistant's mark says it was done out of order (§14).
8. **It changes something.** A write that sends what the step already holds and adds no subtask, or a
   mark that already stands, is refused as `no-change`, and nothing is sent.

The check and the write run in one synchronous task, so nothing arriving from the server or from the
person's hand comes between them. A door that answers that it wrote nothing is `roadmap-not-ready`
or `no-change`, never success, and the write leaves nothing on the room's Undo stack, so the
person's next Undo takes back their own act.

- **INV-2.** Coach holds no door of its own to a roadmap. Every write it makes is one the room's own
  doors made, so it is saved, sent, retried, merged and refused exactly as the person's is.
- A change Coach makes is the person's own on the wire and in the room's Activity; the receipt in
  the conversation is what says Coach made it. (R-7)
- A direct write leaves a receipt and offers Undo in the room's band for 6 s. Undo reverts that one
  act and spares anything written since: for a change to structure, a later write of the same
  field; for a subtask it added, the person's change of the item since, and otherwise the item goes
  again; for a mark, a mark the person has set on the step since, and otherwise the step's mark goes
  back to what it was, a completion's first date not restored. An Undo a later write stood in the way
  of is skipped, and says so. The means to undo live in the process's memory.
- A message's receipts are final once its turn has ended. What became of a write afterwards, that it
  was undone or that the server refused it, is a record of its own (§9), so the receipt can read
  "Undone" on every device.
- A write that could not land afterwards joins the one list the room keeps of those
  ([Roadmap on the sync engine](roadmap-on-the-engine.md) §6).

### §6.1 Refusals

Every code an ability refuses with. A refusal names, as `id`, what the failing check is about where
that is a step, a ref, a kind or a roadmap: for a link, the step that waits; for a merge, the step
of the two that fails it. A refusal of a proposal also carries `at` (§7).

| Code | Refused when |
|---|---|
| `invalid-input` | The input breaks the ability's schema, as the gate's Shape rule finds ([Coach engine](coach-engine.md) §6), or a rule of its input this document states: a change that breaks its op's row (§7), a cursor that is not one or points past its sequence (§5.2), an id asked twice (§5.1), an `update_node` that names no field, a text a direct write sends that the domain cannot store, one that holds U+0000 or a lone surrogate or a subtask left blank, which names the step the write names, none for a new one |
| `roadmap-unavailable` | The device has not finished bringing the roadmap; it can be asked again once it has (§10) |
| `unknown-roadmap` | The roadmap is neither the conversation's nor one the person owns, and the device holds the whole list of theirs (§10) |
| `roadmap-not-ready` | A write or a proposal names a step under a delete the person can still undo; a read does not see such a step, and `get_nodes` naming one refuses it as `unknown-step`. An Apply is refused so, writing nothing, where its changes pass a cap only by the steps under such deletes, which free their slots when their holds end (§7) |
| `not-owner` | The person does not own the roadmap, and a write or a proposal needs its owner |
| `out-of-scope` | A direct write names a roadmap other than the conversation's |
| `over-limit` | A value or a count would pass a cap of `limits.json`: a step's text, links or subtasks, the roadmap's steps, links, subtasks or kinds, or a proposal's changes, counted or as its record's bytes (§7). A direct write's refusal names the step whose value passes the cap, as the call names it, whether or not the roadmap holds it; none for a new step's text; and the roadmap where its count of steps, links or subtasks is full, for `create_node`, `connect` and `update_node` alike |
| `unknown-step` | A step the roadmap does not hold, or a ref no earlier change gave |
| `closes-cycle` | A link, or a merge, would close a loop |
| `takes-every-start` | A proposal's `remove_step` would remove the roadmap's last starting step, a present step that follows nothing. It is the room's rule, which its own delete keeps ("A roadmap keeps one starting step", board 02.12), held for Coach by the domain's `effects` read, the read the room's delete asks. A merge and a split pass: no control of the room makes either, and a split's parts or a merge's survivor stand where the step stood |
| `unknown-kind` | A kind the roadmap's legend does not show, one it does not have or one wearing a hue an earlier kind owns, or a ref no earlier `add_kind` gave |
| `address-not-allowed` | A web link's address is not one `roadmap-link-urls.json` shows |
| `opens-roadmap` | A mark on a step that opens a roadmap: it is complete when that roadmap is, or by its own mark where the roadmap it points to no longer stands, and the room offers no mark on it either way |
| `step-locked` | A locked step marked complete: Coach completes what it needs first, or suggests that |
| `hue-taken` | A kind would take a hue another kind wears, as the room's own recolour refuses |
| `roadmap-changed` | A cursor from before the read changed (§5.2), or a proposal over a register that has moved since the turn read it (§7) |
| `no-change` | A write that changes nothing, or a door that wrote nothing |

## §7 Proposals

`propose_roadmap_change` takes `{treeId, changes[]}`, one to 100 changes, and mints one proposal.
A change is one flat object: its `op` and the fields its row names. A field the row does not name,
or a required one left out, is `invalid-input`.

| `op` | Required | Optional | Writes |
|---|---|---|---|
| `add_step` | `ref`, `label` | `description`, `kind`, `prerequisites`, `links` | A new step after its prerequisites; without `kind` it takes terracotta |
| `remove_step` | `nodeId` | | The step is removed. Each step after it follows the removed step's own prerequisites |
| `rename` | `nodeId`, `label` | | The step's label |
| `describe` | `nodeId` | `description`, `links` | The step's description, its web links, or both, each replaced whole; at least one of the two is sent |
| `set_kind` | `nodeId`, `kind` | | The step takes the kind's hue |
| `connect` | `nodeId`, `prerequisiteId` | | A link added: `nodeId` is the step that waits, `prerequisiteId` the step it waits on |
| `disconnect` | `nodeId`, `prerequisiteId` | | That link removed |
| `merge` | `nodeId`, `removeId` | `label`, `description` | `removeId` folds into `nodeId`, which keeps its own mark and web links and takes `label` and `description` where sent. Each prerequisite link into or out of `removeId` moves to `nodeId`, a link between the two is dropped, and two links that meet become one. `removeId` is removed, its web links with it. A link is between the two as the follow graph reads one, through deleted steps ([Roadmap on the sync engine](roadmap-on-the-engine.md) D-5): one that would have `nodeId` follow itself through deleted steps alone is dropped, as a direct one is |
| `split` | `nodeId`, `parts` | | The step becomes its parts, two or more, each `{ref, label}` and optionally `description`, `kind` and `links`, side by side (R-9): each follows the old step's prerequisites, precedes each step that followed it, takes its mark, and takes its kind unless it names one. A part's description and web links are empty unless sent. The old step is removed, and its links with it |
| `set_progress` | `nodeId`, `status` | | The step marked `complete` or `none` |
| `add_kind` | `ref`, `label`, `hue` | `description` | A new kind |
| `rename_kind` | `kind`, `label` | | A kind's label |
| `recolor_kind` | `kind`, `hue` | | A kind's hue, and the steps that wear its old hue with it, as the room's recolour repaints them |

- **Refs.** `ref` names a new step or kind within the proposal: `new:` and up to 32 lowercase
  letters, digits and hyphens. An `add_step`, a part of a `split` or an `add_kind` gives it, once,
  and a later change names that step or kind by it wherever it names one (`nodeId`,
  `prerequisites`, `prerequisiteId`, `removeId`, `kind`). A ref given twice is `invalid-input`.
  When the proposal is minted the tool host draws the proposal's id and then one id for each ref,
  in the order the changes give them, as the room's own controls mint a step's or a kind's, and the
  record's `changes` hold those ids: a new step's under `nodeId`, a new kind's under `kind`, and
  every field that named the ref names its id.
- **The fold.** The ability folds the changes in order over a scratch copy of the standing roadmap,
  validating each over the copy as the changes before it left it, and refuses a set that could not be
  applied. A new step takes the order key the room's own gives a new step, after the steps its first
  prerequisite leads to, and a split's parts each after the one before. The call is checked in this
  order, and the first failure refuses it:
  1. the Shape rule over the whole input, as the gate checks it first;
  2. the roadmap and the person (§6, rules 1 and 2): `unknown-roadmap`, `roadmap-unavailable`,
     `not-owner`; §6's rule 3 is no rule of a proposal (§10);
  3. the count of changes;
  4. each change, at its index:
     1. a step it names under a delete the person can still undo: `roadmap-not-ready`;
     2. the rules of its input, `invalid-input`: its op's row, a `merge` whose two steps are one, a
        `describe` that sends neither field, a `split` of fewer than two parts, a ref given twice, and a
        text the domain cannot store;
     3. a value past its cap, `over-limit`;
     4. a web link's address, `address-not-allowed`;
     5. a new id the copy holds, `invalid-input`, and the steps and kinds it names, `unknown-step` and
        `unknown-kind`;
     6. the roadmap's counts of steps, links and kinds, `over-limit`;
     7. its own rule of the graph: `takes-every-start` for a `remove_step`; `closes-cycle` for a
        `merge`, a `split` or a `connect`, whose link the step already follows closes nothing and
        changes nothing; and `hue-taken` for a kind, checked at each change as the room's recolour
        checks it, so two kinds do not swap hues in one proposal;
     8. `roadmap-changed`: a register it touches, whether it writes it or only names it, as a
        `disconnect` names its link, that the turn read at another stamp than the copy holds now (§5), so
        the model reads again and never proposes over an edit it has not seen. A register the turn never
        read is taken at the copy's stamp;
     9. the marks, `opens-roadmap` and `step-locked`, as `set_progress` checks them;
     10. `no-change`, where it writes nothing over the scratch;
  5. the record's size.
- **The record's size.** A set of more than 100 changes is `over-limit`, and so is a minted record
  whose `changes` pass 65,536 bytes or whose `base` passes 262,144, as the sync registry caps them
  (§6, rule 4).
- **The answer** is `{proposalId, removes}`: the minted proposal's id and, for each step the
  proposal removes (by `remove_step`, as a merge's `removeId`, or as the step a `split` replaces),
  in the order the changes remove them, `{nodeId, label, descriptionChars, links, done}` as the step
  stands when that change folds: its id, the minted one for a step the proposal itself added, its
  label, the Unicode scalars of its description, how many web links it carries and whether it is
  complete.
- **A refusal** of a change carries `at`, the index of the first change that fails, and `id` as §6.1
  says; the Shape rule's refusal of `changes[k]` carries `at: k`. A refusal of the count of changes
  carries `at: 100` and no `id`. A refusal of the record's size, and one of the call before any
  change folds, for the roadmap or the person, carry neither.

A proposal is a record (§9): `{id, treeId, threadId, messageId, base, changes[], state, undone}`.

- `base` is a list of registers, `{t, id, register, stamp}`, in the order the changes first touch
  them: for every step a change mentions, the stamp of its being there, its `life`; for every register
  a change writes, that register's stamp; for a `disconnect`, its link's, whether or not it writes it;
  and for `set_progress`, the mark's. `t` is `node`, `edge`,
  `kind` or `progress`, `id` the record's id (`[from, to]` for a link), `register` `life` or a field,
  and `stamp` the copy's, null for a record the copy does not hold. A new step or kind records its
  id's life unheld, and the records it makes are its alone. A recolour's base is the kind's hue: the
  room's recolour is one command, which repaints the steps that wear it. They are the stamps the
  turn's reads returned, read from the copy, so they exist for a roadmap that has never reached the
  server.
- `state` is `pending`, then one of `applied`, `rejected`, `stale` or `replaced`, and never goes back
  to `pending`. The four outrank `pending` when two devices' records meet, as the sync engine ranks a
  field, and `applied` outranks the other three. Of `rejected`, `stale` and `replaced`, written on two
  devices before they sync, the later written stands, as the engine joins equal ranks.
- `undone` is set once, by the Undo of an applied proposal that took something back. Nothing writes it while it is
  false, since the registry keeps its first writer's.
- A roadmap has one pending proposal. Minting another marks every earlier one `replaced`, in the
  write that makes it. Where two devices each mint one before they sync, the one born later stays
  pending: a device reads the latest-born pending proposal about a roadmap as its pending one and
  every earlier one as replaced, and the next one minted about the roadmap writes each `replaced`, as an Apply
  or a Reject of an earlier one writes it.
- Coach's message names the proposal it minted (`proposalId`, §9). In a conversation about all
  roadmaps a turn may mint one for each of two roadmaps, and a message then carries more than one;
  the card reads a message's proposals by their `messageId`.

**Apply**, pressed by the person on the review, is the domain's `ApplyProposal`
(`web/src/products/roadmap/domain/apply.js`, `RoadmapDomain/Coach/Apply.swift`), proven by
`packages/api-contract/roadmap/domain/apply-actions.json`:

1. Only a pending proposal moves. One that is not pending, or whose `applying` row this device holds,
   is left as it stands, and nothing is written. A pending one that is not its roadmap's pending one,
   where two devices each minted one before they synced, becomes `replaced`, and nothing else is
   written.
2. The proposal is out of date when anything in `base` differs from the copy: a stamp that is not
   the one recorded, a step that has gone or come. The changes are then folded and validated again
   over the standing roadmap as it is now, read of the proposal's roadmap and of the roadmaps its
   reading reaches alone; a set that no longer validates is out of date too. An out-of-date proposal
   becomes `stale` and nothing is written to the roadmap. A state that passes by itself never makes a
   proposal stale: Apply is refused and writes nothing where the device has not finished bringing the
   roadmap (`roadmap-unavailable`), or where the changes pass a cap only by the steps under a delete
   the person can still undo (`roadmap-not-ready`). Apply of a proposal about a roadmap the person's
   list no longer holds is refused as gone, and writes nothing.
3. Otherwise the folded result is reduced to one write for each register and written as one act on
   the device (Roadmap on the sync engine K-2). First comes the room's recolour of each kind the copy
   holds, one `roadmap.recolourKind` each, in the changes' order. Then the structure, one gesture over
   the roadmap's scope in as many intents as an import of it takes. Then the removed steps' deaths,
   held 9 s as every step's delete is, so an Apply that removes a step is held. Last, the person's
   overlay, for the marks. In the same transaction the device writes its own row
   `applying:<proposal>`, whose `stamp` is null: written with the act, the row's being there says the
   act landed.
4. The record becomes `applied`, and the row is removed (`SettleApplying`), in a write of its own. The
   record's state is no entry of the act, so an Undo in the act's hold cancels the act and leaves the
   state as it is.
5. Undo is offered for 6 s in the room's band: the kit's Undo of the act, across structure and marks.
   A held Apply is cancelled in place; any other is restored, drawn at once and settled as its writes
   are. The Undo reads the legend as it would leave it, each kind the act recoloured back on its hue
   and each kind it made taken away, and is refused, taking nothing back, only where a kind outside
   the act has come to wear a hue it would give back. Where the Undo took something back as the device
   draws it, the record takes `undone` (`ProposalUndone`). An undone proposal is not offered again;
   the person asks Coach for another.

- **INV-3.** A proposal applies whole or not at all on the device. On the wire it is the person's
  own writes: structure and marks are separate intents, and a large act travels as several.
- **INV-4.** An applied proposal is never set aside because the roadmap changed elsewhere. It merges
  as any two edits do, and nothing about a later sync returns it to the person for a second look.
- A row found `applying`, after a crash or written in another tab, is settled by its act, which landed
  with it: the record becomes `applied`, and the row is removed.
- Two devices that both apply one proposal before they sync write the same changes with the same
  ids. Its links and marks merge as one. The later device's creation of each new step and kind is
  refused `id-taken`, since its twin was born at the other device's stamp ([sync engine](engine.md)
  §4.3), and the step stands once, as the first device made it. Where one of them undoes it, `undone`
  says that device took back what it could: the other device's writes that came after its own stand.
- Reject (`RejectProposal`) marks a pending record `rejected` and writes nothing to the roadmap. It
  leaves a proposal that is not pending as Apply does.
- A roadmap made signed out keeps its id when a sign-in adds it to an account, and the conversations
  and proposals that name it keep naming it: they are records of the same signed-out work, which one
  answer adds or discards (§11). A subtree whose creation the server answers with the subtree its step
  already owns takes that subtree's id; by [sync engine](engine.md) §7.7 a global type's mapping renames
  its id in every scope, and `treeId` is a reference to `tree`, so the conversations and proposals
  queued about it follow, as a vector of the sync corpus's `roadmap/client.json` holds.

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
- A turn withdrawn before its answer began is a held delete, held for the 9 s of any roadmap
  delete. An Undo in that time brings back its messages without the turn's mark, which recovery
  follows, so the Coach message reads as `running` until it has stood `TURN_STALE` with no write and
  a device ends it `interrupted` ([Coach engine](coach-engine.md) §5, R-5).
- Asking needs a connection; when there is none the question stays in the field. Reading History,
  reviewing and applying a proposal need none.

**Access.** The words and states a person sees are gym Coach's, as the design rules. No amount is
shown.

**The profile's values.** Roadmap asks for the model class `large`, which the AI service serves to
an installation as `medium`, with the effort gym's Coach asks for and the label
`roadmap.coach.turn`. `MAX_MODEL_CALLS` is 8, `MAX_ABILITY_CALLS` 12, `MAX_WRITES` 6 and
`CONTEXT_BYTES` 64 KiB, the context's `bytes` bound (§5), which the profile reads from `limits.json` as
the context does. A call asks for at most 2,000 output tokens and at least 1,024. A message, a
question and a picture keep gym's bounds.

**The words.** The prompt, the words of the first content and the sentence the model reads beside
each refusal code are files under `packages/api-contract/roadmap/coach/`, written with the owner and
shipped in each app, as gym's are. A person can read them there; they hold no secret.

## §9 Records and History

Coach's records are private to a person and are no part of a roadmap's shared structure, which a
reader of a shared roadmap can see. They are records of the [sync engine](engine.md), in a registry
for the product `roadmap` under the scope `self/roadmap`, beside gym's and journal's in the
composition. (R-4) They join the registry that holds a roadmap's structure
([Roadmap on the sync engine](roadmap-on-the-engine.md) §4).

| Type | Holds |
|---|---|
| `coachThread` | One conversation: its scope (a roadmap's id, or all roadmaps), the step it started from if any, its title |
| `coachMessage` | One message, in the shape of gym's `message`: who wrote it, its text, pictures, and for Coach's its state, `truncated`, refusal code, the calls it made, its receipts and the id of a proposal it carries |
| `coachProposal` | §7 |
| `coachWriteFate` | What became of one receipt's write after its turn ended: undone, or refused by the server |

A device also keeps rows of its own, which do not sync: the mark (§8), `applying` (§7) and a
picture's original, as gym keeps one.

A Coach message's `calls` and `receipts` are facts, written once with the turn's end, never a sentence and never a word of
what a call answered (INV-5):

- `calls`: each call the turn made, in order, the context first as the ability `context`: `{ability, treeId, outcome,
  steps?, done?, nodeIds?, fields?}`, `treeId` null for a call about all roadmaps, `outcome` `ok` or the refusal code, and of
  a read how many steps it answered, `done` how many of them were done where the read answered it (the context, and a
  `get_tree` that asked each step's state), the steps it named by id (at most 50) and the fields it asked for. What Coach
  Read (board 11.8) and the line under an answer are made from them, and say no done count where a call recorded none.
- `receipts`: each direct write that landed (D-4), at most `MAX_WRITES`: `{ability, treeId, nodeId, label, change,
  fields?, items?, prerequisites?}`, `label` the step's label after the write, the person's own roadmap data in their own
  records, and `change` one of `completed`, `reset`, `changed` (with the `fields` changed, of `label`, `description` and
  `links`, and the `items` added to its checklist), `created` (with the labels of the steps it follows) and `linked` (with the
  label of the step now followed). A receipt's line is made from these and the app's words, never from the model's text, as
  `packages/api-contract/roadmap/coach/receipts.json` holds it on every surface: at most eight words, a name cut a word at a
  time where the line would pass them. A `coachWriteFate` names its receipt by index; one `undone` makes the line *Undone*.
- `refusal`: the code a turn that could not answer ended with, its underscores written as hyphens, as the registry's pattern
  takes a code (`subject_exhausted` is `subject-exhausted`).

What a turn writes beyond its opening and end, and History's read, are proven by
`packages/api-contract/roadmap/domain/turn-records-actions.json`.

- A turn's states are gym's: `running`, then `completed`, `declined`, `failed`, `stopped` or
  `interrupted`. Once a turn has ended, its message's text, calls and receipts are final.
- History is one list of every conversation, each tagged with its roadmap or with "All roadmaps",
  the current roadmap's first, filtered by roadmap from the title.
- Deleting a roadmap deletes the conversations and proposals about it and about every subtree under
  it, in the same gesture, on the device that deletes it. The server removes them, with their
  messages and write fates, whatever deleted the roadmap: a device, the backend's door or an Undo
  ([sync engine](engine.md) A.1). Conversations about all roadmaps stay, and so does another
  person's conversation about a roadmap shared with them, since each person's records are their own.
- The opening of a turn and its end are declared once in the domain kit and proven by shared
  vectors, as gym's are, so the iPhone writes the same records.

**INV-5.** Nothing the model needs to continue a turn is written to a record: not the assistant
messages' `carry`, not an ability's full result. A record holds what a person reads.

## §10 Other roadmaps

- `list_trees` answers, for each roadmap the person owns: its title, its counts by state, the titles
  of its frontier and the date of its last completion, all computed from the copy.
- A roadmap the device has not finished pulling is refused as `roadmap-unavailable` until it has
  arrived whole. (P-3)
- A `treeId` that names neither the conversation's roadmap nor one the person owns, once the device
  holds the whole list of their roadmaps, is refused as `unknown-roadmap`.
- In a conversation about all roadmaps Coach changes a roadmap only through a proposal, which names
  the one roadmap it changes (§6).
- Applying a proposal to a roadmap other than the one on screen opens that roadmap first, so the
  review shows what is applied.

## §11 Signed out

The design rules that everything works signed out: asking, direct writes, reviewing and applying.
Coach goes live, on the web and on the iPhone, only when it works signed out too. (R-6)

- **Records.** Signed out, a conversation, its messages and write fates, and a proposal are records of
  the device's `anon` replica in `self/roadmap`, beside the roadmaps they name, and the device draws
  them from its unsent work. At sign-in the sync engine's lineage rule ([sync engine](engine.md)
  §7.10) adds or discards roadmap's signed-out work as one: Add sends the records with the roadmaps
  they name, which keep their ids, and a proposal stays as it was, pending among them; Discard takes
  them from the device with roadmap's device rows, a running turn's mark among them. A roadmap
  carried over from the old bundle whose creation the server refuses at sign-in keeps them too: the
  refusal's notice holds them, and where the carry-over places the roadmap again it writes again, in
  the same act, what the device lost of the conversations and proposals about it, with their
  messages and write fates, and the notice goes once they are written ([Roadmap on the sync
  engine](roadmap-on-the-engine.md) §8.2).
- **The sign-in question.** Where the work holds conversations, it counts them beside the roadmaps
  (board 10.4 on the web, 10.7 on the iPhone), as [Roadmap on the sync engine](roadmap-on-the-engine.md)
  §5 says. Work that changes no roadmap of the device's own joins the account without a question, its
  conversations with it.
- **A credential to ask with, in the browser.** The AI service admits an installation on a pass the
  backend signs for an installation credential. The iPhone holds one already; no such credential
  exists in the browser yet.

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
  - `roadmap_coach_ability`, with the ability and its outcome or refusal code, told by the turn's
    engine for each call it runs, as it tells gym's Coach's; the tool host tells none;
  - `roadmap_coach_stopped`, `roadmap_coach_picture_added`, `roadmap_proposal_review_opened`;
  - `roadmap_proposal_decided` (applied, rejected, stale, replaced) and
    `roadmap_coach_write_undone`, which the tool host tells for each Undo of a direct write, since an
    Undo runs outside a turn, with the ability and what the Undo came to once the engine has settled
    it: `undone`, `skipped` where a later write stood in its way, or `unavailable` where the room no
    longer holds the write;
  - `roadmap_proposal_undone`, with `outcome`, what the Undo of an applied proposal came to in the
    same words, `undone`, `skipped` or `unavailable` (`ProposalUndone`'s answer), told by the surface
    that offered the Undo.
- A direct write tells the room's Activity the row the room's own Board tells of the same change,
  the person's own (R-7) and told silently, since the person is in the conversation, not on the
  canvas: a new name, `renamed`, as the Board's step document tells it. The room tells no row of a
  step's description or web links, a new step, a link or a subtask, so neither does Coach, and a mark's rows,
  `completed` and `unlocked`, come as the room adopts the copy's marks, as any mark the room did not
  make does. The tool host takes the room's Activity as a collaborator.
- A direct write's one product event is `roadmap_coach_ability`. The room's gesture events
  (`roadmap_board_edit`, `roadmap_board_complete`, `roadmap_graph_toast` and the like) count the
  person's own gestures, and a Coach write adds to none of them.
- Unexpected failures report to Sentry under the static names `roadmap-coach-turn`,
  `roadmap-coach-apply`, `agent-host` and `ai-call`. A refusal the person can act on is an event, not
  an Issue. Whatever throws in an ability's call, the ability, the standing roadmap it reads or the
  room's door, throws out of the tool host, which reports nothing of it; the turn's engine reports
  it once, as `agent-host`, and ends the turn `failed` with `host-fault`, as it does for gym's Coach.
- A write the device could not store differs by surface: on the web the room's session reports it
  as `roadmap-replica-write` and the tool host answers `roadmap-not-ready`; on the iPhone the room's
  act runner throws it out of the tool host, so the turn ends `failed` with `host-fault`, reported as
  `agent-host`.
- An Undo of a direct write runs outside a turn, so a failure of it is reported under the room's own
  write-failure operation: on the web by the room's session, as `roadmap-replica-write`, and on the
  iPhone, where the tool host throws it to its caller, by the wiring that calls it, as `roadmap_write`
  with the write `coachUndo`.
- The backend logs nothing of a turn but the pass it signed.
- The iPhone's are listed in its observability document (`docs/IOS_OBSERVABILITY.md`); the web's will be in its notes when built.

## §14 What must be built beneath Coach

[Roadmap on the sync engine](roadmap-on-the-engine.md) builds the copy, the registry and the shared
domain. Beyond what it lists, Coach needs of that domain:

- an action that changes the web links of an existing step, for `update_node`;
- one act that carries a proposal's folded changes, of different kinds, under one gesture, with
  merging and splitting steps among them, and an Undo that takes back structure and marks together
  and says whether anything was taken back (§7);
- diagnostics computed on the device and held to the server's by vectors, and a step's `unknown`
  state (§5);
- the stamp of every register a read returned, for a proposal's `base` (§7).

Not read by Coach: the `outOfOrder` flag on a mark, which only an outside assistant's mark sets.

## §15 Rulings

The design's eleven rulings of 2026-11-08 stand as the [design canon](../design/roadmap-coach.md)
states them. This document's own:

| | Question | Ruling |
|---|---|---|
| R-1 | Where Coach's abilities run | On the device's copy by default, with every change travelling by synchronization. An ability that calls the backend is a rare exception. (2026-11-14) |
| R-2 | Where the turn runs | On the device: the loop, the gate and the prompt. Each model round is a call to the AI service. (2026-11-14) |
| R-3 | One Coach or one per product | One engine; a separate Coach in each product with its own prompt, abilities and conversations. (2026-11-14) |
| R-4 | Where conversations and proposals are stored | As records of the sync engine in a registry of roadmap's own, since they are private and belong to no one roadmap's shared structure. (2026-11-15) |
| R-5 | Which abilities call the backend | None. It was `list_trees` alone while a device held only the roadmaps it had opened; with roadmap on the sync engine a device holds every roadmap its person owns (R-13). (2026-11-15, revised 2026-11-17) |
| R-6 | Signed-out Coach on the web | It ships together with signed-in Coach: Coach does not go live on the web until both work. (2026-11-15) |
| R-7 | Whether Coach's writes are told apart from the person's | In the conversation only, where the receipt says Coach made the change. On the wire and in Activity a change Coach made is the person's own. (2026-11-15) |
| R-8 | How "you asked for exactly this" is enforced | By the prompt. The catalog's shape keeps a direct write to one step that removes nothing, and the gate keeps it within the turn's volume. (2026-11-15) |
| R-9 | What `merge` and `split` do | As §7's table says. (2026-11-15) |
| R-10 | An applied proposal the server then refuses | A proposal is applied on the device and then synced, and the server can refuse the synced change: a cap reached by an edit elsewhere, a roadmap deleted or no longer the person's. The refusal stands as it does for a person's own edit, and the record stays `applied`. A person's own edit is no longer shown as refused for what happened elsewhere, and what cannot land is listed in one place ([Roadmap on the sync engine](roadmap-on-the-engine.md) §5). (2026-11-15, revised 2026-11-17) |
| R-11 | One allowance while gym's Coach is metered elsewhere | Roadmap Coach is built beside gym's move and goes live only after the server's gym Coach has closed ([Gym Coach on the AI service](gym-coach-on-ai-service.md) §8), so a person never holds two allowances for Coach. (2026-11-15) |
| R-12 | The Windmill One button on the web | The web shows no such button while Windmill One cannot be bought there. It says the allowance is used up and when it returns. (2026-11-15) |
| R-13 | The copy Coach's abilities run on | The device's replica of the sync engine, once roadmap has moved onto it. Nothing of Coach is built on roadmap's former sync. (2026-11-17) |
| R-14 | Coach on the iPhone | In the iPhone's first release of the Roadmap room, on the same catalog, vectors and records. (2026-11-17) |
| R-15 | Coach for a reader on the iPhone | None: a shared roadmap's cover on the iPhone offers Fork alone, and a reader meets Coach on the web. (2026-11-24) |
| R-16 | Coach adds subtasks | Through `update_node`, appending to a step's private checklist, never editing, checking or removing an item. (owner, 2026-11-24) |

The four states the design's first boards did not draw are each drawn and ✅ Ready for dev (owner, 2026-11-24): on
the Roadmap Coach page, section 10 (10.1 a reader's Coach on the web, 10.2 a card applied and then undone, 10.3 a
replaced card, 10.4 the sign-in question of §11); on the Roadmap · iOS page, 11.24, with the replaced card at 11.9b and
the sign-in question at 10.7. A reader meets no Coach on the iPhone (R-15).
