# MCP adapter (`adapters/mcp/`)

An AI agent reads and authors Windmill roadmaps through the same application core an HTTP or
WebSocket client drives. Edits route through the tree's `TreeRoom`, so they are merged, sequenced,
logged to `tree_ops`, and persisted to the per-entry lattice tables (`tree_nodes` / `tree_edges` /
`tree_kinds`) like any other edit.

## Layout

The engine and the HTTP transport are product-neutral and live in platform; the catalog, the
projections and the documents are roadmap's.

```
platform/adapters/mcp/
  McpServer                JSON-RPC 2.0 engine (initialize, tools/list, tools/call,
                           resources/list, resources/read, ping). Depends only on jsoncpp + an
                           injected ToolHost, a ServerInfo and a resource vector.
  CompositeToolHost        every connected product's tools behind the one ToolHost McpServer
                           binds, AND the grant gate: filters tools/list, refuses an
                           out-of-scope call, a colliding public name or alias at construction, and a key no
                           schema declares at any depth it closes with `additionalProperties:false`
                           (named by JSON path: `nodes[3].deleted`) — that last check is
                           `undeclaredArgument` on the ToolHost port itself, so a tend's
                           `ScopedToolHost`, which never passes through the composite, refuses with
                           the same sentence. A retired name answers with the sentence
                           naming its replacement, consulted only after a catalog miss;
                           construction refuses a retirement that shadows a live tool or names a
                           replacement no product declares. `windmillServerInfo()` frames the
                           handshake.
  McpHttpEndpoint          the Streamable-HTTP transport: sessions, Origin checks, the three
                           verbs, and `McpAuth`.
products/roadmap/adapters/mcp/
  RoadmapTools             roadmap's ToolHost: catalog + dispatch into RoomRegistry / TreeRoom /
                           ProgressService. It declares its tools and never its own gate.
  ToolArgs                 argument validation and the sentence a refusal is written in.
  ReadShape                the read projections (`fields`) and paging (`limit`/`cursor`).
  EditReceipt              what an edit answers about diagnostics.
  RoadmapResources         `roadmapInstructions()` and `roadmapResources()`.
  golden/wire_corpus.json  a byte-compared transcript of one authoring session (WireCorpusTest).
platform/infra/
  main.cpp                 `windmill_server`   — REST + the collab socket + MCP, one process.
  mcp_main.cpp             `windmill_mcp`      — stdio transport (local hosts spawn it).
  mcp_http_main.cpp        `windmill_mcp_http` — standalone HTTP transport (local/standalone).
```

`windmill_server`'s `/mcp` registers roadmap and gym; `windmill_mcp_http` and the local stdio root
register roadmap. Each uses `CompositeToolHost` and `windmillServerInfo()`. Public names are
`roadmap_<local>` and `gym_<local>`; only canonical names appear in `tools/list`. Unambiguous
unprefixed names remain compatibility aliases and use the same permission and argument gate.
Product-only hosts retain local names for in-process agents. Canonical descriptions and initialize
instructions use the owning product's tool names; schema literals and call payloads are never
rewritten.

Legacy edit tools reuse the `commandFromJson` codec: their argument names are the command payload
keys, save for the node handle, which the tool layer normalizes (`nodeId` → the codec's `id`)
before the decode. `commandFromJson` answers a bare yes/no, so arguments are validated in the tool
layer. `patch_nodes` and `change_edges` parse typed inputs and call pure domain planners; each
planner returns a complete command batch before the room applies anything.

## The error contract

Every failure is one line naming four things when they apply: the **tool**, the **argument** by
its published spelling (or its JSON path — `nodes[3].label`, `updates[1].status`), the **value
given** (its type when the type was wrong, its size when a cap was hit, its text when an enum
missed), and the **limit or legal set** it missed. An obvious next move rides along as a second
sentence.

```
rename_node: missing required argument "nodeId". Call get_tree with fields ["id","label"] to list the ids this tree has.
annotate_node: description would be 17181 characters, 1181 over the 16000 cap
create_node: label would be 250 characters, 50 over the 200 cap; description would be 17181 characters, 1181 over the 16000 cap
import_subgraph: nodes[0] must be an object, got string. Each item is a JSON object, not a JSON-encoded string.
set_progress: status "finished" is not one of {complete, none}
```

The checks live in `ToolArgs.{h,cpp}`. `RoadmapTools::callTool` stamps the tool name exactly once
and catches, so a malformed argument fails its own call rather than the whole HTTP request. Every
cap a tool enforces is published as `maxLength` / `maxItems` in its `inputSchema`, and every
length cap counts Unicode code points (`codePointCount`, `domain/Command.h`) — the published
`maxLength` is what a CJK or emoji string is held to, and a string that is not valid UTF-8 is
refused first, by name (`label is not valid UTF-8`), so the count only ever runs over real text.
A node's label, icon and description are capped by the domain — `validate()` for a command,
`admit()` for a graft — in one sentence that names every field over its cap and by how much, so a
caller who overran several fixes them in one round trip; `annotate_node {appendDescription}` is
judged on the body the node would then hold. Byte budgets sit above the character caps: a
`get_tree` / `find_nodes` page carrying `description` ends at 4 MB of serialized nodes and says
`pageBytes` beside `nextCursor` when that is what ended it (`ReadShape::projectPage`), and one
`import_subgraph` call carries at most 6 MB of description text (`kMaxImportDescriptionBytes`,
under the 8 MB HTTP body limit so the refusal is a named sentence, not a bare 413).
`get_nodes` bounds the complete tools/call result, including text and structured copies, to 262144
bytes and refuses oversized selections with a smaller-batch/projection retry. It never truncates
requested ids silently. Unexpected exceptions report an uncertain outcome and ask for a read-back
before retrying; they do not claim that an already-broadcast room mutation was rolled back.
An edit of one node — `annotate_node`, `rename_node`, `set_node_color`, `move_node` — names a
present node or is refused with `no node in this tree is named "x"`, the sentence `delete_node`
and `set_progress` use.

## Handles

- `treeId` — the roadmap, on every tree-scoped tool.
- `nodeId` — a node that **exists**, on every tool that edits or marks one. The `id` spelling is
  also accepted by legacy single-node tools and declared `deprecated` in their schemas. New batch
  updates accept only `nodeId`.
- `id` — the id **proposed** for a NEW thing: `create_node`, `add_kind`, `import_subgraph`'s
  `nodes[].id` and `kinds[].id`. `create_node` refuses `nodeId` outright, `add_kind` refuses
  `kindId`.
- Legend kinds publish `id` for the kind that exists too, and all six `*_kind` tools spell it
  alike. `kindId` is the silent alias there.

## Resources

`resources/list` and `resources/read` serve `windmill://quickstart` (markdown) — a tree's guide, how
guides add, edge direction, progress, diagnostics, omitted fields and the graph/progress import
boundary. Tool schemas carry arguments and limits; initialize instructions give concise shared and
product guidance.

## Transports

`McpServer::handle` is pure (`Json request → optional<Json> reply`). Two thin transports wrap it;
both speak JSON-RPC 2.0, protocol version `2025-06-18`:

- **stdio** (`windmill_mcp`) — newline-delimited frames on stdin/stdout, what local hosts launch.
  stdout is the protocol channel; logs go to stderr. No session and no bearer: it acts as
  `WINDMILL_MCP_USER`.
- **Streamable HTTP** (`McpHttpEndpoint`) — the remote transport, one endpoint (`/mcp` by
  default):
  - `POST` — the body is one JSON-RPC message. A *request* gets its JSON-RPC response as
    `application/json`; a *notification* gets `202 Accepted`. `initialize` mints an
    `Mcp-Session-Id` header that every later call must present. Sessions idle-expire after 30
    minutes, refreshed on use.
  - `GET` — would open a server→client SSE stream; there is none, so `405`.
  - `DELETE` — ends a session.
  - `POST` validates a supplied `Origin` header; requests without one pass that check.
    `windmill_mcp_http` also serves `/healthz`; in `windmill_server`
    the liveness probe is the app root (`deploy/docker-compose.yml`).

The deployed HTTP transport is `windmill_server`: `main.cpp` registers `McpHttpEndpoint` on the
REST host's `WINDMILL_MCP_PATH`, over the *same* `RoomRegistry` REST and the collab socket use, so
an agent's edit fans out to connected browsers through `WsPresenceBus` as it lands.
`windmill_mcp_http` is the standalone build of that endpoint — its own process, its own
`RoomRegistry`, a null presence bus — for local and single-purpose runs only (see *Operating
notes*).

## Auth

`McpAuth` (`platform/adapters/mcp/McpHttpEndpoint.h`) turns a request into a `ToolCaller` — the
account it acts as, the grant its credential carries, and the connection the credential is
(`ToolConnection{id, name}`: the OAuth client id and registered name, or the MCP key's public id
and the name it was minted under; both empty for the shared token and the unauthenticated shape).
`McpHttpEndpoint::resolveCaller` tries three credentials in order against the
`Authorization: Bearer …` header:

1. **An OAuth access token** — `OAuthService::resolveAccessToken` requires it unexpired *and*
   audience-bound to this server's resource URL, and answers with the token's parsed scope and
   its client as the connection. The client discovers the authorization server through the RFC
   9728 metadata document, runs authorization-code + PKCE against the API host, and acts as the
   granting account within the grant the human approved.
2. **A personal MCP API key** — `McpKeyService::resolveKey`, the fallback for clients that cannot
   do OAuth. Minted in settings, stored as a digest, resolvable to its owner until revoked or the
   account closes. Only `windmill_server` wires this one. `mcp_keys.scope` is honoured, but the
   mint endpoint asks for none, so every key is account-wide.
3. **`WINDMILL_MCP_TOKEN`** — one shared secret, compared in constant time, acting as
   `WINDMILL_MCP_USER` with `McpAuth::fallbackScope`. For CI and an agent on the box; leave it
   unset in any deployment more than one person can reach.

A request presenting none of them gets `401` with a
`WWW-Authenticate: Bearer resource_metadata="…"` challenge naming
`/.well-known/oauth-protected-resource`, served unauthenticated by both HTTP roots. With none of
the three configured, every request runs as `WINDMILL_MCP_USER` with `McpAuth::fallbackScope`.

## Scopes

A grant is `<product>:<level>`, space-delimited on the wire, with three levels that never imply
one another — `roadmap:read roadmap:write` does not carry `roadmap:delete`, and a connection
holding it does not see `delete_tree`, `delete_node` or `remove_kind` in `tools/list` at all.
Every tool declares its level beside its description (`RoadmapToolCatalog.cpp`),
`CompositeToolHost` is the one place that enforces it, and
`/.well-known/oauth-authorization-server` publishes the vocabulary in `scopes_supported`, derived
from the products actually connected. **An empty scope is the account-wide grant**
(`platform/domain/ToolScope.h`).

Tending does not go through the composite: `TendingService` holds roadmap's host directly
(`ScopedToolHost.h`). The two narrowings stack — `ScopedToolHost` pins a run to one tree, the
composite pins a credential to its grant. A run is not offered `describe_tree` either: it reads the
tree's guide through `get_tree` and never sets it. Nor is it offered the tree a node opens: the
schemas it is handed carry no `opens` argument and no `opens` field, so a run neither reads nor sets
a pointer, an import through it leaves the pointers the tree holds as they are, and a node it
creates, or brings back from a delete, opens none. The `state` it reads is the owner's: a node
that opens a tree is complete when
that tree is. Its `get_tree` reply carries `tree.guide`, the tended tree's own, and no `guides`: the
guides of the trees above are other trees' ids, titles and words, so a run is not offered
`includeGuides`, every `get_tree` it makes is sent with it `false`, and no tree above the tended
one is read; the two reads `TendingService` makes of the tree's `seq` send it `false` too. Its
`get_diagnostics` reply carries the graph's diagnostics and neither `treeLoops` nor
`danglingPointers`, which name other trees: a run is not offered `includePointers`, every
`get_diagnostics` it makes is sent with it `false`, and no pointer is followed. One
table in `ScopedToolHost.cpp` names what a run is not offered: tools by name, and words wherever a
schema carries them, each with the value it is sent as when the tool needs one. A withheld name a
run calls anyway is refused before any write is observed; a withheld argument or field is refused
in its own sentence with nothing written. A tend starts only on a tree its caller can write.

Above the auth check both HTTP roots meter by IP, keyed on the forwarded client address:
`windmill_server`'s general API ceiling (25 req/s per client, burst 50) covers `/mcp`;
`windmill_mcp_http` runs its own (20 req/s, burst 40). Traffic arriving with no proxy header is
treated as internal and is not limited.

## Tools

The table uses product-local names; external MCP prefixes each with `roadmap_`.

| | Tool | Effect |
| --- | --- | --- |
| registry | `create_tree` · `list_trees` · `delete_tree` | plant / discover / soft-delete a roadmap you own; `create_tree` plants the legend sent in `kinds` (1–6 of `import_subgraph`'s kind items, each id and hue once, replacing the default Build/Learn/Milestone whole and in order; `[]`, a repeated id or hue, or seven refuse the call and plant nothing) and answers `{treeId, url, kinds: [{id, hue, label}]}`, the legend planted; each `list_trees` row carries the tree's `url` too (see `url`); a node later written with neither `color` nor `kind` is terracotta, so a legend with no terracotta kind leaves such a node under no kind |
| registry | `describe_tree` | rename the tree with `title`, set its guide with `guide`, or both — at least one, each set only when sent, both landing as one frame at one seq or neither (`TreeRegistry::describe`). The title follows `rename`'s rule (`TreeRegistry::titleFrom`: trimmed, cut to 200 characters, a blank refused as "a tree always has a name"), and one equal to the name the tree has is not written and answers `unchanged: true` with the head; a guide is written whenever it is sent, even as the tree holds it, which is also how a fork's owner makes an inherited guide theirs; the guide is a plain-text note on what the tree is and how to work it, at most 5000 characters, and `""` or only whitespace clears it. Owner only; answers `{applied, seq}`, `seq` the head after the call, and leaves no op row; an open page receives the frame with the new title or guide |
| read | `get_tree` | title + `url` (see `url`) + `guide: {text, yours}` (the only read that carries it, on every page; `yours` is true when the caller owns the tree and wrote its current guide, false on a guide a fork copied from someone else's tree until its owner writes one) + `guides` on the first page (see `guides`) + nodes (label, icon, color, `kind`, position, description, links, `opens`, `url`) + per-node prerequisites + seq; `includeEdges: true` adds every live edge as a flat `edges: [{from, to}]` |
| read | `get_nodes` | 1–200 exact unique ids in requested order, selected fields, explicit `missingNodeIds`, seq and complete-result byte limit |
| read | `get_diagnostics` | cycles / dangling / self-edges / smells; on a tree the caller owns also `treeLoops` and `danglingPointers` (see `opens`) |
| read | `get_health` | tidiness metrics + 0–100 score (needs a valid DAG); `crossBranch` skips edges touching a `crossBranchExempt` kind and reports them as `crossBranchExempt` |
| read | `get_progress` | the caller's completed node ids, and `outOfOrder` — the subset of completed whose set_progress carried `outOfOrder: true` |
| read | `find_nodes` | search by `color`/`kind`, the derived `state`, and/or a `query` substring (id + label + description), best match first — `{state: "available"}` is the frontier |
| edit | `patch_nodes` | 1–200 existing nodes, replacement fields (`opens` among them, and a hue as `color` or legend `kind`) with omission preservation, full-batch validation, optional `expectedSeq` and `dryRun` |
| edit | `change_edges` | 1–500 combined additions/removals, existing endpoints for additions, absent removals are no-ops, optional `expectedSeq` and `dryRun` |
| edit | `create_node` | add a node — its hue as `color` or legend `kind`, `prerequisites[]`, `description`, `links`, `opens` all optional; answers `id` and the `kind` it wears |
| edit | `annotate_node` | set a node's `description` — or `appendDescription`, which joins onto the existing body after a blank line, the cap held against the result; one of the two — its `icon` (`""` clears it, which is how an `empty-icon` smell is fixed), its `links` — or `addLinks`, which joins links after the ones held, in the order sent (a held url keeps its place and takes the label sent with it; a url sent twice is refused; the 32-link cap held against the result); one of the two — and/or the tree it `opens` (`""` clears it); when no field it names would change it writes nothing (see below) |
| edit | `rename_node` · `set_node_color` · `move_node` | content edits; `set_node_color` takes `color` or legend `kind` and answers the `kind` the node wears; sent what the node already holds, each writes nothing (see below) |
| edit | `connect` · `reconnect` | prerequisite-edge edits |
| edit | `disconnect` | remove edges: one `from`+`to` or `edges: [{from,to}]` (1..500), exactly one form; one op, one seq, all or nothing; `removed` counts the edges that were present |
| edit | `delete_node` | tombstone nodes: one `nodeId` or `nodeIds` (1..200), exactly one form; a missing id refuses the whole call naming each; one op, one seq. `prune: true` also drops every edge touching a deleted node and clears the caller's marks on it, under the delete grant; receipt carries `ids` and `pruned: {edges, progress}` |
| edit | `tidy` · `prune` | transitive reduction / GC dangling edges + orphan progress |
| edit | `import_subgraph` | bulk upsert a whole `get_tree`-shaped slice as one graft frame — a field left off a re-sent node or kind keeps its value (`opens` included, but on a node the import brings back from a delete, which opens none), `prerequisiteMode` merge (union) or replace, `tombstone[]` deletes in the same frame and needs the `roadmap:delete` grant; optional `expectedSeq` and `dryRun`; a graft that changes nothing writes nothing and answers `unchanged: true` (see An edit that changes nothing) |
| legend | `add_kind` (inline label+description+crossBranchExempt) · `rename_kind` · `describe_kind` (description and/or crossBranchExempt) · `remove_kind` · `reorder_kinds` · `recolor_kind` | the legend |
| write | `set_progress` | per-user overlay: single `nodeId`+`status`, or a bulk `updates[]` (order-safe); `outOfOrder: true` on a completion is kept on the mark and answered as `acknowledged: true` |
| resource | `windmill://quickstart` | the read-me-first document; no tool slot |

Every tree-scoped tool takes `treeId`. Applied structural edits return
`{applied, seq, diagnosticsClean, introducedDiagnostics}`. Cycles and detached nodes are accepted;
arguments, permissions, revision preconditions, limits and required node existence are validated.
Dry runs, unchanged patch/edge retries, and a single-node edit or an import that changes nothing (see
An edit that changes nothing) do not produce a new structural op. The diagnostics keys
answer different questions: `diagnosticsClean` is the whole graph's state, and
`introducedDiagnostics` names the cycles, dangling and self-edges present after this edit that the
tree did not hold before it. An innocent edit on a dirty tree answers `[]`. An edit that changes
the tree a node opens also names there, after those, each loop of trees it closed, as
`loop of trees from "<nodeId>" through "<treeId>" -> … -> "<this tree>"` (see `opens`). The list
names five lines in all and counts the rest, so a loop is named only while the graph's errors
leave it a line; a loop of trees does not change `diagnosticsClean`.

### The descriptor

Every `tools/list` entry contains `{name, title, description, inputSchema, annotations, _meta}`.
The seven batch tools also declare `outputSchema` and return matching `structuredContent` plus
compatibility text generated from the same result object. The
catalog writes `name`, `description` and `inputSchema` and states two facts beside them — whether a
write edits in bulk and whether a resend leaves it unchanged; `ToolDeclaration::wire()`
(`platform/ports/ToolHost.h`) derives everything else from those facts and the grant level, so no
product can declare a tool without its annotations:

- `title` — the product word, a middle dot, the name in words: `Roadmap · Get tree`,
  `Gym · Log set`. The composite preserves that title while publishing the canonical prefixed name.
- `annotations.readOnlyHint` — true exactly for `read`-level tools.
- `annotations.destructiveHint` — true for a `delete`-level tool and for the writes that
  overwrite or remove in bulk (`patch_nodes`, `change_edges`, `import_subgraph`, `prune`, `tidy` — `kBulkEdits` beside the
  catalog), unless the declaration says `proposal`: `propose_routine_removal` sits at
  `gym:delete` and mints a card the lifter applies, so it is declared non-destructive.
- `annotations.idempotentHint` — true for every read and for the writes a resend leaves unchanged
  (`kIdempotentWrites` beside the catalog); false for `create_tree` and `create_node`, which mint
  an id, and for `annotate_node`, whose append form can duplicate text. Gym declarations describe
  each operation’s retry behavior; new set/session batches retain original identity across corrections
  and deletion.
- `annotations.openWorldHint` — false everywhere: nothing here reaches beyond the caller's account.
- `_meta.product`, `_meta.access` — the grant the composite checks the call against.

Client approval prompts are separate from server permissions. Gym instructions preserve the user's
Apply action for routine proposals; annotations describe each tool's effects.

## An edit that changes nothing

`rename_node`, `set_node_color`, `move_node` and `annotate_node` sent what the node already holds
write nothing: no seq, no op row, no frame and no save. The reply is the usual one with
`unchanged: true` added and `seq` the head the tree stands at, and the write line is `ok`. One rule
decides it, `changedPart` in `domain/Command`: a field the edit names lands only when it holds another
value on the node, so an edit lands the fields that differ and none that repeat what the node holds. A
`patch_nodes` row that changes nothing is listed under `unchangedNodeIds` by the same rule, and a
`patch_nodes` batch whose every row is unchanged answers `unchanged: true` too, as does a
`change_edges` batch that adds only held edges and removes only absent ones: each plan says whether
it `landsNothing` (`NodePatchPlan`, `EdgeChangePlan`), on the dry run and for real. An
`annotate_node` or a `patch_nodes` row naming several fields lands only those that differ — the op row
names them and nothing else — so a field it repeats is not stamped again and a client's concurrent edit
to it stamped earlier still wins, as it does against an import; an `appendDescription` with text always
lands.

`import_subgraph` follows the same word. A graft whose frame lands nothing — every register sent as
the tree holds it, no new edge, no tombstone, no edge a replace drops, no new or revived node or kind
— is not joined: no seq, no op row, no frame and no save, and the receipt adds `unchanged: true` with
`seq` the tree's head. `graftFrame` in `domain/Graft` builds the frame and says whether it
`landsNothing`; the dry run builds the same frame on a copy of the room clock and previews
`unchanged` with it. `unchanged` speaks for the graft only: a carried `progress[]` is applied and
reported by its own keys either way.

A tend does not count such a write as an edit, unless the reply carries `progress` marks it set.

## `status`, `seedStatus`, `state`, `summary`

- **`status` is the caller's own mark** — `complete` or `none`, the vocabulary
  `set_progress` writes and `get_progress` returns. Ask `get_tree` or `find_nodes` for it and
  every node answers, marked or not.
- **`seedStatus` is the document's authored baseline** — the inert seed a shared or demo tree
  carries, which every reader sees before their own marks. Readable through `fields`, writable as
  `import_subgraph`'s `nodes[].seedStatus`. An imported node carrying `status` is refused by name.
- **`state` is what the tree derives** — `locked`, `available` or `complete`, the
  unlock cascade `domain/UnlockRules` runs over a node's prerequisites and the caller's marks.
  A `fields` value on `get_tree` and `find_nodes`, never in a default, computed once per read
  over the whole tree, since a prerequisite may sit off the page. It answers on an untidy tree,
  derived over the bare node list rather than through `SkillTree`, which throws on dirt: a cycle
  locks every member, and a dangling edge locks nothing. An anonymous reader's cascade runs over
  no marks: roots available, the rest locked. `find_nodes` takes `state` as a filter too, ANDed
  with the rest and applied after the ranked selection but before the page, so `count` and the
  cursor speak of the filtered set. For the tree's owner a node that opens a tree follows that
  tree, not its mark (see `opens`).
- **`summary` is a projection of `description`** — its opening 200 characters (Unicode code
  points, so a CJK description is cut at 200 characters, not 200 bytes), never split inside a
  grapheme (a combining mark, a variation selector or a ZWJ emoji sequence backs the cut off),
  cut at a word and ellipsized when anything was cut.
- **`kind` is the legend join** — the kind id whose hue equals the node's `color`, omitted from a
  node no kind claims. A `fields` value on `get_tree` and `find_nodes`, never in a default.
  `create_node` and `set_node_color` answer `kind` too: the kind the write named, which wears the
  node's hue, or, for a write that named none, the same join over the hue it landed.

## `url`: where a tree and a step open

- **Forms.** Built by `domain/WebAddress` on the app's public origin (`WINDMILL_APP_URL`, read once
  by each composition root through `platform/infra/AppOrigin.h`; a `/` it ends with is dropped). A
  tree the caller owns opens in the app, `<origin>/#/app/<treeId>`, and its step at
  `<origin>/#/app/<treeId>?step=<id>`. A tree the caller can only read opens on its share page,
  `<origin>/t/<treeId>`, and its step at `<origin>/t/<treeId>#?step=<id>`. A tree id is always
  well-formed and written as it is; a step id is percent-encoded as the web's `encodeURIComponent`
  does. `packages/api-contract/roadmap-addresses.json` holds the forms: the backend builds every case,
  and the web test proves its router opens each one.
- **Where it is answered.** `create_tree` and every `list_trees` row (the caller's own trees),
  `get_tree`'s `tree.url`, and the node field `url` on `get_tree`, `get_nodes` and `find_nodes`, a
  `fields` value never in a default. A tend is offered it. The reminder mail's tree link and the
  share page's canonical and `og:url` are built by the same functions.

## A node's hue: `color` or `kind`

`create_node`, `set_node_color`, each `patch_nodes` row and each `import_subgraph` node name the
node's hue as a `color`, as a legend `kind` id, or as both when they agree. A `kind` lands as the
hue that kind wears in the node's `color` register: the node stores no kind of its own, so a
`recolor_kind` repaints it with the rest of the kind. The kind is read off the room's own legend
under the strand the write then takes — `TreeRoom::resolveHue` for `create_node` and
`set_node_color`, `planNodePatches` for a patch, `TreeRoom::resolveKinds` for an import, all over
`resolveHue` in `domain/Legend` — so it is never read off a legend a concurrent `recolor_kind`
could change before the write lands. An import reads the legend its batch leaves (the tree's,
with the batch's own `kinds[]` upserted), so one batch can add a kind and file nodes under it,
and a node that names a kind carries its colour register. A kind the legend does not hold refuses
the whole call, naming the argument path, the id and every kind id the legend holds (or that it
holds none, and `roadmap_add_kind`); a `color` beside a `kind` that wears another hue refuses it
naming both. Their write lines carry the outcomes `kind-unknown` and `kind-hue-mismatch`, never the
kind. A node that names neither keeps its colour, and a new one is terracotta.

## `opens`

A node may point at another tree: `opens` holds that tree's id.

- **Write.** `create_node`, `annotate_node`, a `patch_nodes` row and an `import_subgraph` node take
  `opens`, a string of at most 128 characters. On `create_node`, absent or `""` opens nothing: the
  door always writes the pointer, so an id that is present, or that a deleted node held, keeps none
  of the pointer it had. On the other three, absent leaves the pointer, `""` clears it and a value
  sets it. `null` is absent, save in a `patch_nodes` row, which refuses it as it refuses a `null`
  label. `opens` alone is something to set.
- **The target is checked at this door only.** Every non-empty `opens` in a call must name a tree
  that stands and is the caller's, asked in one read for the whole call
  (`TreeRegistry::titlesOwnedBy`), before the room is written and before a `dryRun` answers.
  Otherwise the whole call is refused naming the argument path and the id — `opens`,
  `updates[3].opens`, `nodes[2].opens` — in one sentence for a tree that is not there, a deleted one
  and someone else's, so the refusal confirms no id. Its write line carries the outcome
  `opens-not-yours`. A node may open the tree it is in.
- **Read.** `opens` is a `fields` value on `get_tree`, `get_nodes` and `find_nodes`, never in a
  default. A node answers `opens: {treeId, title, state}` when the caller can write the tree being
  read, the pointer is set, and the opened tree stands and is theirs; the key is omitted otherwise,
  so a reader of someone else's tree and a signed-out caller never receive it. `state` is
  `complete` or `open`, and the title is the opened tree's stored one.
- **The node follows the tree, for its owner.** A pointer is valid when its target stands and
  belongs to the owner of the tree the node is in. For a caller who can write the tree, a node with
  a valid pointer is `complete` exactly when the opened tree is complete for them, whatever its own
  prerequisites, and `locked` or `available` by its prerequisites until then; a mark on it is kept,
  answered as `status` and by `get_progress`, and decides nothing. A tree is complete when it holds
  at least one node and every node of it is complete, a node with a valid pointer by its tree and
  any other by the caller's mark; that is judged once over all the caller's standing trees
  (`domain/OpenedTrees.h`), so a tree on a loop of pointers is never complete, however long the
  loop, and a chain of any length completes. `state`, the `state` filter of `find_nodes`,
  `opens.state` and the `done` of `list_trees` all read that one completed set, so a step waiting
  on such a node unlocks when its tree completes. `set_progress` records a mark on such a node as on any other, and its
  `prerequisitesMet` reads marks alone.
- **Every other reader sees an ordinary node.** A reader who cannot write the tree, signed in or
  not, is answered no `opens`, and the node's `state` follows their own mark and its prerequisites
  as any node's does. A node whose pointer is not valid is ordinary for its owner too.
- **Cost.** Following is one read of the stored rows per reply (`TreeRepository::openedFrom`: one
  statement over `trees`, `tree_nodes` and the caller's `node_progress`, answering one row per
  tree and tree it opens), made only for a caller who can write the tree, when `fields` names
  `state` or `opens` or `find_nodes` filters on `state`, and when the tree holds a pointer.
  `get_tree`, `get_nodes` and `find_nodes` take what they answer from the room under the tree's
  strand and read the repositories after letting it go, so no other read of the tree waits on that
  statement. `list_trees` makes no such read: it already holds every tree of the caller's. Every
  write door saves before it answers, so the stored rows are the live ones unless a save failed.
- **What can be wrong with a pointer.** `get_diagnostics` answers two more lists to a caller who
  can write the tree (`OpenedTrees::diagnose`), each in node id order. `treeLoops` holds one
  `{node, path}` per node whose pointer leads back to the tree being read — a tree on such a loop
  is never complete. `path` is a shortest way back, `[{treeId, title}]`: the tree the node opens
  first, this tree last, so a node that opens the tree it is in has a path of this tree alone;
  where two ways are as short the smaller tree id is taken, ids compared as bytes. A loop among
  other trees that does not lead back to this one is not listed: it is reported when one of those
  trees is read. `danglingPointers` holds one `{node, treeId}` per node whose pointer is not valid
  — the tree was removed, is someone else's, or the text names none — with the pointer as it is
  stored; this door refuses to set such a pointer, and the socket and `PUT` do not. Neither makes
  a tree unclean: `diagnosticsClean`, the gate of `get_health` and `TreeDiagnostics::clean()` stay
  a statement about the graph. Both are repaired by re-pointing or clearing the node's `opens`.
  A reader who cannot write the tree is answered the graph's diagnostics alone, in the bytes a
  tree without pointers answers, and nothing is read for them.
- **The reply is bounded.** `treeLoops` lists its first 50 nodes and `danglingPointers` its first
  50 (`kMaxTreeLoops`, `kMaxDanglingPointers`, `domain/OpenedTrees.h`); `treeLoopsOmitted` and
  `danglingPointersOmitted` count the rest. A `path` lists at most 8 trees (`kMaxLoopPath`): a
  longer way is cut to its first 8, starting with the tree the node opens, so a cut path does not
  end with this tree, and `pathOmitted` counts the trees left off, this tree the last of them.
  The three counts are absent when nothing is left off. The caps are applied in the domain, which
  never builds what is past them, so both doors answer alike and the reply follows the caps and
  not the tree.
- **`includePointers`.** A boolean argument of `get_diagnostics`, default `true`. `false` leaves
  both lists out and reads no other tree. The read is the one following makes
  (`TreeRegistry::openedFrom`), once per reply, after the tree's strand is released, and only when
  the tree holds a pointer: a tree that holds none answers both lists as `[]`. Under the strand
  the read takes the tree's pointers alone (`TreeRoom::pointers`), not a copy of its nodes, and
  the walk back reads each pointer between the caller's standing trees once
  (`OpenedTrees::waysBackTo`).
- **A follow that fails does not fail the call.** The reply then carries the graph's diagnostics
  without the two lists and `pointerDiagnosticsUnavailable: true`, a key that is otherwise absent.
  The failure is reported once as `roadmap.diagnostics.follow`, door `mcp`.
- **An edit that closes a loop says so.** `create_node`, `annotate_node`, `patch_nodes` and
  `import_subgraph` follow pointers once when the call changes the tree a node opens to a tree:
  after the edit is saved and the strand is released, one read starts from the trees those nodes
  now open, and only those nodes are judged. Each of them whose tree leads back to this one is a
  loop the edit closed, named in the receipt's `introducedDiagnostics` after the graph's errors
  and within that list's five lines; a node re-pointed from one tree that leads back to another
  that does is named, as the loop runs through another tree. A sentence names the first 8 trees of
  the way and then `and N more`. A pointer the edit left as it was is neither followed nor named,
  and an edit that clears or re-points a pointer says nothing of the loop it removed, as no
  receipt names a removed diagnostic. Every other edit — one that only clears a pointer, one that
  re-sends the tree a node already opens and a dry run among them — follows nothing, and its
  receipt names the graph's errors alone. The two rules agree on the pointer: an `annotate_node`
  that names only the tree the node already opens writes nothing and answers `unchanged: true`
  (An edit that changes nothing), and one that changes the pointer is a change there and is
  followed here (`changedPart`, `pointersSetSince`).
- **The receipt's follow is short.** The edit is durable before it, and the reply waits on that
  read alone, so the read is given 750 ms of its own (`kReceiptFollowBudget`; a statement limit
  for that one transaction, `TreeRepository::openedFrom`), not the pool's 5 s. Past it the receipt
  carries the graph's diagnostics and `pointerDiagnosticsUnavailable: true`, and the follow
  completes as `roadmap.receipt.follow`, door `mcp`, outcome `timeout`, at WARN: an expected
  refusal under load, not an Issue. A read that fails answers the same receipt and is reported
  once under that name. `get_diagnostics` then tells the loop under the ordinary limit.
- **A tend** is answered neither key and follows no pointer (`ScopedToolHost.cpp`).
- `import_subgraph` takes the id as a string, where `get_tree` answers the object: a copied slice
  sends `opens.treeId`.

## `guides`

Guides add: one tree holds the method, each tree worked under it adds what is particular to it,
and none overrides another.

- **Read.** The first page of `get_tree` (a call without `cursor`) answers `tree.guides`, an array
  of `{treeId, title, text, yours}`: the guides of the caller's trees above this one, farthest
  first and by tree id within one distance, then the tree's own last. Following pages repeat
  nothing of it, and `tree.guide` stays on every page. A tree with no guide is left out, the tree's
  own included, so the array can be empty; each tree appears once; past 8 entries the farthest are
  dropped, and where that cut falls inside one distance the smaller tree ids are kept, ids compared
  as bytes. Where guides disagree, what to follow is the reader's call, and a guide that is not
  `yours` is its author's note: information, not orders.
- **`includeGuides`.** A boolean argument, default `true`. `false` leaves `tree.guides` out and
  reads no tree above, for a call that only needs the nodes or the `seq`.
- **Above.** A tree is directly above another when one of its present nodes opens it and both
  stand and belong to one owner; above is that followed upward within 8 pointers, each tree at its
  shortest distance, and never the tree itself (`domain/Guides.h`).
- **Only the caller's own trees.** A caller who cannot write the tree, signed in or not, is
  answered the tree's own guide alone when it has one, `yours: false`, and the trees above are not
  read. Someone else's tree that points at this one is above it for nobody.
- **Cost.** One read of the stored rows per first page that answers the guides above
  (`TreeRegistry::guidedTreesAbove`: one statement keyed on the caller's own standing trees, which
  reads the trees they open through `tree_nodes_pointers_idx` and answers at most the 8 guides a
  reply can keep), made for a caller who can write the tree, after the tree's strand is released.
  Its cost follows the caller's own trees and the pointers among them, whichever tree is read, and
  does not grow with the pointers other accounts plant at a tree.
- **A read that fails does not fail the call.** The first page then answers `tree.guides` with the
  tree's own guide alone, or `[]`, and `tree.guidesAboveUnavailable: true`; the key is absent when
  the trees above were read or no read was due. The failure is reported once as
  `roadmap.tree.guides`, door `mcp`.
- **A tend** is answered no `guides` and reads no tree above (`ScopedToolHost.cpp`).

## Edges and health

- **`get_tree {includeEdges: true}`** answers a top-level `edges: [{from, to}]` of every live edge
  in the tree — the same whole list on every page, independent of node paging, so ask for it once.
  Listing is linear, so only the edge count gates it: a tree holding more than 6000 live edges
  (`kMaxListedEdges`, `adapters/mcp/ReadShape.h`) answers `edgesOmitted` with the count instead
  of a cut list, whatever its node count.
- **Branches derive from colour.** `TrunkTree` elects each node's trunk parent (same-hue parents
  win) and a node's branch is the run of same-hue trunk parents above it, so an edge joining two
  hues is `crossBranch` in `get_health`, 60% of the score. A legend kind marked
  `crossBranchExempt` (on `add_kind` or `describe_kind`, read through `kindFields`) takes every
  edge touching one of its nodes out of that count; `get_health` reports those as
  `crossBranchExempt` beside `crossBranch`, and they weigh nothing: the score's fractions are over
  `edgeCount − crossBranchExempt`, while `edgeCount` stays every live edge. The flag is a kind register
  like `label` and `description` — its own LWW stamp, carried on the lattice, the document codec
  and `tree_kinds` — and `import_subgraph` round-trips it on `kinds[]`.

## Bulk

- **`patch_nodes`** preserves every omitted field and replaces every supplied field. All target ids
  must exist and be unique; every item must name at least one editable field. **`change_edges`**
  validates the full final graph capacity, additions' endpoints, duplicate pairs and add/remove
  overlap. Cycles remain valid. Both use one HLC stamp, structural op and live-room broadcast when
  anything changes. `dryRun` applies nothing; `expectedSeq` refuses a stale edit; an unchanged retry
  does not increment seq. Neither tool supplies append semantics.
- **`import_subgraph`** takes the `nodes[]` and `kinds[]` `get_tree` returns, plus an optional
  `progress[]`, and applies the graph in **one** op via the subgraph CRDT graft path. It takes
  `expectedSeq` as the two above do (one schema, `expectedSeq()` in the catalog, and one pair of
  checks, `checkExpectedSeq` and `staleExpectedSeq`): a stale one refuses the whole call — graft,
  tombstones and carried `progress[]` — before anything lands, its dry run included. A `title` is
  not an argument: the gate refuses one by name, and the import never touches the tree's title.
  Progress (max 1000 supplied marks) commits in a separate atomic repository batch under the room
  strand. Receipts distinguish `graphApplied` and `progressApplied`, with `progressError` or
  `progressSkipped` when requested progress cannot all be applied; a committed graft is not undone
  by a later overlay failure. It is **upsert by id**: an incoming id already present is reported
  in `nodeCollisions`/`kindCollisions`; a new id is added. A re-sent node or kind changes only in
  the registers the batch sends: a node's `label`, `icon`, `color`, `order`, `position`,
  `seedStatus`, `description`, `links` and `opens`, and a kind's `label`, `description` and
  `crossBranchExempt`, left out, keep the value the tree holds, because the graft stamps an
  omitted register unset (`Graft::omittedNodeRegisters` and `graftState`,
  `Graft::omittedKindRegisters` and `graftLegend`) and no stored stamp loses to that. A node the
  tree holds keeps its creation stamp, so it keeps its place among its siblings, and a delete
  stamped before the import that arrives after it still removes it; a node deleted earlier and
  re-sent is revived at the graft's stamp with the registers it had, `opens` excepted: a node the
  import brings back opens the tree the batch names for it, and none when the batch leaves `opens`
  out, as a node `create_node` makes on a deleted id does, so no batch restores a pointer it does
  not name. A sent node register lands at
  the graft's stamp when it changes what the node holds, `""` and `[]` included, which is how a
  text or list field is cleared (`position` and `seedStatus` have no empty value: `null` counts as
  left out, and a sent `position` carries both `x` and `y`, refused naming the one it lacks as
  `patch_nodes` refuses a row's); one sent as the node already holds it, like a prerequisite edge the tree already
  holds, is not stamped again. A new id's omitted register lands as its default. A re-sent kind
  follows the same rule: a kind the legend holds keeps its creation, so a remove stamped before the
  import that arrives after it still removes it, and a hue, label, description or
  `crossBranchExempt` sent as the legend holds it is not stamped again, so a `get_tree` round trip
  that carries the legend back changes nothing in it. Rank is never on the wire, so a colliding
  kind keeps its place and a new kind lands after the last one, in batch order. A re-sent kind
  with a new hue changes the kind alone: the nodes wearing the old hue keep it, where
  `recolor_kind` repaints them. The import is at most one op row — a batch that changes nothing
  writes none — and that row names only the batch's most salient change, in `headline()`'s order
  (a created node, a removed node, a legend change, a node's label, colour or annotation, an
  edge): an added edge beside a rename reads `renamed to N2`, two new edges read as the first of
  them by prerequisite then node id, `linked P → N`, a new node beside a renamed one reads
  `added Zeta`, and re-sending a node to add an edge reads `linked`, with the legend carried back
  or not. A re-sent
  node's `prerequisites` meet its existing edges by `prerequisiteMode` — `merge` (the default)
  unions them, so an edge the batch leaves out survives and is listed in `keptEdges` (first 50 as
  `{from, to}`, then one `"and N more"` string) with `keptEdgeCount`; `replace` removes every
  present prerequisite edge into that node the batch did not name — live, or left dangling by an
  earlier delete and about to revive with a re-sent id — in the same frame, and counts them as
  `removedEdges`. A node sent without `prerequisites` keeps every edge into it under either mode,
  listed in `keptEdges` (`Graft::omittedPrerequisites`, decided in `footprintOf`); `[]` is a list
  and, under `replace`, clears them. `tombstone[]` (max 500) needs the `roadmap:delete` grant — the tool is
  write-level, but a tombstone is what `delete_node` does, so a connection without that level is
  refused before the tree is read, in `CompositeToolHost`'s own sentence — and deletes nodes in
  that same frame and seq: the node and every present edge touching it in either direction,
  counted back as `tombstoned: {nodes, edges}`. The caller's own progress on them is cleared after
  the graft, the way `prune` clears an orphan's. A tombstone id
  that does not exist, or that is also in `nodes[]`, or that a batch node names as a prerequisite,
  refuses the whole call naming every offender before anything is applied. Everything lands at one
  stamp minted from the room clock, so a removal beats the edge's `addedAt` and a later re-add
  (merge or `connect`) beats the removal. The receipt counts `nodes`, `edges` and `kinds` as
  carried, so a batch whose prerequisites were put in the wrong place reads as `edges: 0`.
  `dryRun: true` previews the collisions, the kept edges, the `tombstone` list and the refusals,
  and changes nothing. The graft is held to the per-tree capacity (10000 nodes, 20000 edges),
  counted on what the tree would hold AFTER the upsert less what the batch tombstones or replaces.
  The graft path does not run the domain's `validate()`, so this tool's own item checks are the
  only admission standing there. The rule itself lives in `domain/Graft` (`footprintOf`,
  `graftState`), reached through `TreeRoom::importTree`; the handler only passes the mode, the ids
  and the registers each item left out, and reads the footprint back for the receipt.
- **`set_progress`** accepts 1–1000 `updates[]` committed in one SQL transaction and evaluates the `prerequisitesMet` advisory
  against the committed batch, so a subtree completed out of dependency order still reports
  correctly. The room strand covers node validation, commit and broadcast; delete/prune cannot
  interleave an orphan mark. Unknown node ids are rejected before any overlay mutation. A completion
  meant to land before its prerequisites carries `outOfOrder: true` (single and bulk forms, with
  `status: complete` only): the word is stored on the row beside the status, under the same stamp,
  so the next mark on that node from any surface replaces it; the receipt answers
  `acknowledged: true` beside `prerequisitesMet`, `get_progress` lists those ids under
  `outOfOrder`, and the `status` field of `get_tree`/`find_nodes` shows `outOfOrder: true` on the
  node. `prerequisitesMet: false` without `acknowledged` is therefore always an inversion nobody
  acknowledged.
- **`prune`** drops dangling/self edges in one op and clears the caller's progress rows for nodes
  no longer in the tree.
- **`find_nodes`** searches without pulling the whole tree. `color` and `kind` are one filter (a
  node's color *is* its kind); every set filter must match (AND). Matches come back best first —
  exact id, id prefix, label hit, id substring, description-only hit. Matching and ranking live in
  the pure `selectNodes` read-model (`domain/NodeQuery`); the order is deterministic, which is what
  keeps a resume `cursor` pointing at the row it was minted from.

## Build

The dependencies are in `RUNNING.md` §1 (the configure builds the patched Drogon itself), then
`cmake -S . -B build && cmake --build build`. The MCP-carrying targets are
`windmill_server` (REST + socket + MCP), `windmill_mcp` (stdio), `windmill_mcp_http` (standalone
HTTP), and the `windmill_mcp_tests` suite. The Docker image builds, smoke-tests and installs
`windmill_server` and `windmill_mcp_http`; `windmill_mcp` is a developer-machine target.

## Register — the deployed server

MCP is same-origin with the app — `https://windmill.works/mcp`, proxied to `windmill_server`.

```bash
claude mcp add --transport http windmill https://windmill.works/mcp
```

The client is challenged, discovers the authorization server from
`/.well-known/oauth-protected-resource`, and runs OAuth against the API host. A client that
cannot do OAuth uses a personal key from settings instead, as `Authorization: Bearer <key>`.

## Run — stdio (local)

```bash
claude mcp add windmill --env DATABASE_URL=postgresql://localhost/windmill \
  --env WINDMILL_MCP_USER=<your account id> \
  -- /ABS/PATH/windmill/backend/build/windmill_mcp
```

## Run — standalone HTTP (local)

```bash
DATABASE_URL=postgresql://…/windmill \
PORT=8090 \
WINDMILL_MCP_ALLOWED_ORIGINS="http://localhost:5173" \
WINDMILL_MCP_PUBLIC_URL="http://localhost:8090" \
WINDMILL_OAUTH_ISSUER="http://localhost:8088" \
  ./build/windmill_mcp_http
```

### Configuration (env)

Read by every root that serves MCP unless a row says otherwise.

| Var | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://localhost/windmill` | Postgres connection |
| `PORT` | `8090` (`windmill_mcp_http`) | listen port |
| `WINDMILL_HOST` | `0.0.0.0` (`windmill_server`) | shared backend bind address; use `127.0.0.1` for a local-only stack |
| `WINDMILL_MCP_HOST` | `0.0.0.0` (`windmill_mcp_http`) | bind address |
| `WINDMILL_MCP_THREADS` | `8` (`windmill_mcp_http`) | Drogon worker threads |
| `WINDMILL_MCP_PATH` | `/mcp` | endpoint path (HTTP roots) |
| `WINDMILL_MCP_ALLOWED_ORIGINS` | *(empty)* | comma-separated browser Origin allow-list; `*` allows all. Non-browser clients send no Origin and are always allowed. |
| `WINDMILL_MCP_PUBLIC_URL` | `windmill_server`: `WINDMILL_API_URL` · `windmill_mcp_http`: `http://localhost:8090` | the externally reachable origin. `+ WINDMILL_MCP_PATH` is the OAuth **resource** (audience) a token must be bound to, and the base of the metadata URL in the 401 challenge — get it wrong and every valid token is refused. |
| `WINDMILL_OAUTH_ISSUER` | `http://localhost:8088` (`windmill_mcp_http`) | the authorization server advertised in the protected-resource metadata. `windmill_server` is its own issuer and advertises itself. |
| `WINDMILL_MCP_TOKEN` | *(empty)* | optional shared bearer that acts as `WINDMILL_MCP_USER`. CI and local agents only — it is a second key to every tree that user owns. |
| `WINDMILL_MCP_USER` | `dev` | who an unauthenticated request acts as: the stdio caller, and the account `WINDMILL_MCP_TOKEN` maps to |

Identity is per caller: an OAuth token acts as the account that granted it, a personal key as its
owner. `WINDMILL_MCP_USER` is the fallback identity only.

## Operating notes

- **One live room, one process holding it.** Running `windmill_mcp_http` (or `windmill_mcp`)
  against the *same* database as `windmill_server` opens a second registry: each process reloads
  head on open and is the authority for a tree while it holds it, so two of them writing one tree
  can race on `(tree_id, seq)`. A local/standalone topology, never a second production writer.
- **Blocking DB on the event loop.** Repositories are synchronous libpqxx. Each borrows a
  connection for one transaction from a bounded pool of at most 20
  (`platform/adapters/postgres/PgPool.h`), opened lazily and given a 5s statement timeout. The
  call blocks its event-loop thread for the length of the query.
- **Clock.** An MCP write is stamped by the tree's room clock (`TreeRoom::nextStamp`, wall time
  from the `Clock` port), the same HLC domain a socket write joins, so the two are directly
  comparable and can never collide on a stamp.

## Open work

- `McpServer` defaults to `2025-06-18` and echoes a requested version without negotiating a
  supported set. `McpHttpEndpoint` reads `method` before the engine's type guard and ignores the
  raw JSON parser's success flag. Validate the envelope before dispatch.
- Session DELETE lacks POST's authentication and Origin checks, and session entries store expiry
  without caller ownership. These are source findings, not reproduced transport exploits.
- Tool lists are grant-filtered; combined initialize instructions and static roadmap resources
  are not. `windmill_server` registers roadmap and gym; `windmill_mcp_http` and stdio register
  roadmap only.
- Legacy tools do not all expose output schemas and structured results. Extend both from one
  result object. Description-bearing legacy read pages still allow 4 MiB; exact selected reads
  provide the smaller bounded path.

Contract tests and the wire corpus check software behavior, not model tool selection or coaching
quality. Actual-model exploration remains manual and local with an explicitly supplied key; useful
checks include target selection, scope, retries, concurrent edits, read coverage and faithful
explanations. No model success-rate or token saving has been measured.
