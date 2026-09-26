# Graph synchronization

Roadmap replicas exchange partial stamped state through one server. The server model, admission
limits, routes and persistence are specified in [the backend spec](../backend/SPEC.md). This
contract covers the shared wire format, browser coverage and offline storage.

## State and clocks

A tree contains independent LWW registers for node fields, legend fields and title, plus add-biased
LWW element sets for node, edge and kind existence. Join is pointwise: absent entries and unset
stamps contribute no information. Deletion is an explicit tombstone; node fields and incident edges
survive it, and edges with absent endpoints are masked from the derived graph.

Registers accept strictly greater HLC stamps. Element-set add wins an exact add/remove tie.
Different values for the same register must not share a stamp, because register ties keep the
incumbent. Stamps use `physicalMs:counter:actor`, with `0:0:` as unset.

Each `SyncSession` creates a fresh replica actor and one `HlcClock` shared by structural and
progress writes. Received stamps are observed before another local tick. The room clock uses
actor `srv` and observes loaded and incoming stamps. The server refuses a whole frame beyond
`now + 5 minutes`; it never restamps client content. The browser retains rejected writes and waits
for time to catch up. LWW still favors a fast clock within that allowance.

Compound gestures become concrete field writes at their origin: the browser's `materialize.js`
for user edits, the backend's command planner for server and MCP edits. Commands do not cross the
replica boundary. `seq` orders broadcasts and detects gaps; it never decides a merge.

## Wire format

A subgraph uses the same envelope in a socket frame and the HTTP tree response's `state` field:

```json
{
  "t": "subgraph",
  "v": 1,
  "treeId": "t_9362d9bc883e0a1e",
  "frameId": "1f5b7a0e-2c44-4d1e-9a0b-6d2f1c8e4b77",
  "actor": "r_example",
  "intent": "live",
  "nodes": [{"id":"n_one", "label":"Shaders", "labelAt":"1770000000123:1:r_example"}],
  "edges": [],
  "kinds": [],
  "gestures": [],
  "title": null,
  "coverage": null
}
```

Node and kind registers use flat value/stamp pairs such as `label`/`labelAt`; life uses
`createdAt`/`deletedAt`. Edges use `from`, `to`, `addedAt` and `removedAt`. Title is `{v, at}`;
coverage maps each actor to its greatest stamp. Omitted sections and fields never delete data.

| Intent | Meaning |
|---|---|
| `live` | immediate authored writes or a server broadcast |
| `flush` | accumulated offline writes |
| `delta` | subscribe response with the server's coverage frontier |
| `graft` | imported/bootstrap state; contributes content without coverage |

The server broadcasts admitted writes with `intent: live` and `seq`. A persisted write receives
`subgraphAck {treeId, frameId, seq?}`; a duplicate can be acknowledged without a new seq. The room
tracks seen frame IDs, and the op log enforces `(tree_id, op_id)` uniqueness. The op log contains
one coarse headline per frame, not the full envelope; position-only frames produce no deed.

`reject {treeId, frameId?, code, reason}` reports a refusal. Clients branch on `code`, preserving
unacknowledged state. A rejection naming a frame can strand the same delta on every retry; it must
remain visible as a durability problem. Server limits and rejection codes live in
[the WebSocket contract](../backend/SPEC.md#websocket-surface).

## Coverage and reconnect

`ackedServerVector` means content the server has acknowledged, not everything the browser has seen.
It changes through only two paths:

1. The `delta` response to `subscribe {treeId, lastSeq, vector}` replaces coverage with the
   server's stated frontier.
2. An acknowledgement joins the frontier saved for that outbound frame.

Live broadcasts, echoes and grafts join content without advancing coverage. Replacing coverage on
subscribe lets a replica resend content a restarted server no longer holds. Coverage must never
advance past content the client failed to join.

On reconnect, the server computes `deltaBetween(state, vector)` from the room's current lattice.
An empty vector gets full state. The browser joins the response, adopts its coverage and seq, then
flushes `lattice.deltaSince(ackedServerVector)`. Pending work is derived from state, not a command
queue. Flushes split above 256 KiB into independent subgraphs, with title on the first chunk.

A live frame joins only at `seq === lastSeq + 1`; already-seen seqs are ignored, and a gap or failed
join forces reconnect. A subscribe delta is the recovery path. Echoes still join idempotently;
authorship only suppresses repeated local animation.

Each send mints a new frame ID. Reconnection can therefore resend the same content under a new ID;
content convergence comes from idempotent join, not stable frame identity across restarts.

## Offline storage

`SyncStore` keeps `{frame, progress, lastSeq}` in one IndexedDB record per tree. Coverage is not
persisted; the next subscribe reconstructs it. Saving is a read-join-put in one transaction, so two
tabs preserve each other's writes instead of replacing the record blindly. Join and put run
synchronously inside `get.onsuccess`, before IndexedDB can auto-commit.

`SyncSession` snapshots both lanes synchronously and queues a save before sending. It requests
persistent storage and exposes durability risk when persistence is unavailable. Corrupt stored
state can reset a lane on load.

Current limits:

- `apply()` and `markProgress()` do not await `persistNow()` before sending, so queuing a save does
  not establish that it committed before the socket write.
- `SyncStore.save()` catches queued transaction failures; its caller's catch cannot reliably
  report them. Browser eviction, denied persistence and a failed local write remain loss risks.
- The primitive [golden corpus](../backend/test/golden/SCHEMA.md) runs only against its own
  restatement of the laws, not the shipped C++ and JavaScript lattices. Native test suites exercise
  those implementations independently; the corpus does not prevent cross-language drift.

## Private progress

Progress is a separate per-account lattice: one stamped `complete | none` register per node.
`none` is a value, so clearing a mark remains ordered against stale writes. Structural and progress
frames share a socket and clock but never an envelope; progress echoes go only to the same
account's connections.

Pending marks are `progress.deltaSince(ackedProgressVector)`. A subscribe reply with
`intent: graft` replaces progress coverage, an acknowledgement joins its sent frontier, and an
echo joins content without coverage. Both lanes are stored together in IndexedDB.

The HLC orders marks; `markedAt` is the server receipt time displayed to readers. A device clock
can be arbitrarily old, so its HLC physical time is not a reliable date of completion. Postgres
progress upserts compare only numeric `(stamp_ms, stamp_counter)`; exact ties keep the stored row.

## Implementation map

| Responsibility | Source |
|---|---|
| Shared primitives and stamp codec | `backend/platform/domain/Crdt.h`, `Ids.h` |
| Server state, vectors and deltas | `backend/products/roadmap/domain/{LooseGraph,Legend,Subgraph}.*` |
| Server wire codec | `backend/products/roadmap/adapters/json/SubgraphJson.cpp` |
| Admission, acknowledgement and broadcasts | `backend/products/roadmap/adapters/ws/Collab.cpp`, `WsPresenceBus.cpp` |
| Browser state and gesture materialization | `web/src/products/roadmap/sync/lattice.js`, `materialize.js` |
| Browser connection and coverage | `web/src/products/roadmap/sync/SyncSession.js` |
| Browser storage | `web/src/products/roadmap/sync/SyncStore.js` |
| Private lane and refusal handling | `web/src/products/roadmap/sync/progressLattice.js`, `refusals.js` |
