# Graph synchronization

Roadmap replicas exchange partial stamped state through one server. The server model, admission
limits, routes and persistence are specified in [the backend spec](../backend/SPEC.md). This
contract covers the shared wire format, browser coverage and offline storage.

## State and clocks

A tree contains independent LWW registers for node fields, legend fields, title and guide, plus add-biased
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
  "guide": null,
  "coverage": null
}
```

Node and kind registers use flat value/stamp pairs such as `label`/`labelAt`; life uses
`createdAt`/`deletedAt`. A node's registers are `label`, `icon`, `color`, `order`, `status`,
`description`, `links` and `opens`, the id of the tree the node opens or `""` for none. A node holds no
position: every client lays the graph out itself, and a frame that still carries `position` or
`positionAt` lands without them. Edges use `from`, `to`, `addedAt` and `removedAt`. Title and guide are
`{v, at}`; coverage maps each actor to its greatest stamp. Omitted sections and fields never delete
data. The browser lattice joins, stores and writes the guide as it does the title: one stamped register
in the structure lane, outside the undo journal. It joins `opens` by its stamp, stores it with the
node's other registers and writes it as it writes them: the gesture `SetNodeTree` stamps the pair, the
outbox owes it until the server confirms it, and Undo restores the tree the step opened before. A frame
that says nothing of the pointer changes nothing. The server sends the pointer only to a caller who can
write the tree; every other reader's frames and `GET` state carry `opens` empty and `opensAt` unset
([the model](../backend/SPEC.md#model)). So the browser takes the server's word on pointers only from a
writer: the subscribe answer's `reach` (`writer` or `reader`). Under `writer` its pointers are the
server's word, empty and older values included, as for any register. Under `reader`, or with no `reach`,
it says nothing of them: the browser keeps the pointers it holds and keeps confirmed those the server
confirmed before, sends no pointer write, and keeps one it wrote owed until a `writer` answers. A
`reject` with `sign-in-required` or `no-such-tree` turns the session into a reader for pointers, as the
server narrows a revoked connection without a word. An answer that turns from `reader` to `writer`
subscribes again from an empty vector, because a reader's coverage counts pointers it never received.

| Intent | Meaning |
|---|---|
| `live` | immediate authored writes or a server broadcast |
| `flush` | accumulated offline writes |
| `delta` | subscribe response with the server's coverage frontier |
| `graft` | imported/bootstrap state; contributes content without coverage |

The server broadcasts admitted writes with `intent: live` and `seq`. A persisted write receives
`subgraphAck {treeId, frameId, seq?}`; one that landed and was broadcast but whose save failed
receives the same ack with `unsaved: true`, and the server retries the save, so the client confirms
the frame and does not resend it. A frame that lands nothing — a duplicate, one whose every
stamp the server holds already, or one that carries no stamp a register keeps — is acknowledged
without a seq, so its sender's gestures are confirmed, and is not saved, logged or broadcast. A frame
that carries no stamp asks for no write: anyone who may read the tree is acknowledged so, a reader and
a visitor without a session included, and only a frame that carries a stamp meets the write gate. The room
tracks seen frame IDs, and the op log enforces `(tree_id, op_id)` uniqueness. The op log contains
one coarse headline per frame, not the full envelope. A frame leaves a deed only when it creates or
deletes a node, writes a node's label, color, description or links, adds or removes an edge, creates
a legend kind or writes a kind's hue, label, description or rank. Every other frame leaves
none: one that writes only a node's icon, order, status or `opens`, removes a kind, or sets
the title or the guide.

A subtree created under one of the tree's steps takes the next seq of the tree's stream, as
`subtree {treeId, seq, step, subtree: {id, depth}}`. The browser takes that seq under the same rule as a
live frame (an older seq was seen, a later one is a gap a fresh subscribe heals) and changes nothing else.

`reject {treeId, frameId?, code, reason}` reports a refusal. Clients branch on `code`, preserving
unacknowledged state. A rejection naming a frame can strand the same delta on every retry; it must
remain visible as a durability problem. Server limits and rejection codes live in
[the WebSocket contract](../backend/SPEC.md#websocket-surface).

## Coverage and reconnect

`ackedServerVector` reduces subscribe replies; it does not decide pending work or outbound writes.
It changes through only two paths:

1. The `delta` response to `subscribe {treeId, lastSeq, vector}` replaces it with the server's stated frontier.
2. An acknowledgement joins the frontier derived from that frame's retained writes.

Live broadcasts and echoes never advance this vector. On reconnect, the server computes
`deltaBetween(state, vector)` from the room's current lattice, and adds, whole, every node, edge,
kind and tree register that landed on the server past `lastSeq`, the last seq this browser applied
([SPEC, Model](../backend/SPEC.md)). An empty vector gets full state. `lastSeq` is a position with
no gap: a live frame joins only as the next seq, and the subscribe response's seq replaces it.
The browser joins the response, adopts its coverage and seq, then flushes each register whose stamp
is greater than its confirmed baseline's stamp, excluding the same register and stamp already in
flight. Status counts the same unconfirmed registers. Actor frontiers cannot confirm individual
registers: a rejected or unanswered frame can leave a gap below an accepted frame's frontier.
Flushes pack their steps into subgraphs of whole stamps, earliest first, of at most 256 KiB of JSON text each, as a live write is packed, and send the title and the guide each in a frame of
its own in that same order, so a refused register strands no step.

The confirmed structure baseline joins grafts, other replicas' live frames and the exact writes retained
for an acknowledged frame. Own structure echoes join the lattice without confirming: the server broadcasts them
before persistence and acknowledges only after persistence. Both confirmed baselines persist with
the lanes in IndexedDB. The first subscription of every session uses an empty vector, and its full
graft replaces the confirmed structure baseline. Mid-session partial grafts join that baseline.
Actor frontiers can shrink when other actors supersede their registers, so they do not indicate a
restore. A graft whose room sequence is below the client's last sequence instead triggers an
empty-vector resubscribe; its full graft then reopens lost server writes for delivery. A restored
room whose sequence has already caught up is rechecked by the next session's full graft.
Unanswered authored frame IDs remain known across reconnects, so delayed own echoes still await
acknowledgement. Acknowledged, rejected and skewed frame IDs are released; unanswered IDs remain
until the session closes or its structure epoch changes.

A connection's write frames are handled in arrival order, with a reply in that order or no reply.
An ack, reject or skew naming a frame settles every earlier unanswered frame in that lane without
confirming it. Each heartbeat ping snapshots both lanes' in-flight boundaries. A pong settles only
frames through the oldest outstanding ping's boundaries, including a final unanswered write. The
FIFO boundary queue conservatively handles rate-limited pings: a later pong cannot settle writes
sent after the ping it is matched with. Three outstanding pings force reconnection, bounding the
queue even while other traffic arrives. The client reports `roadmap-sync-dropped` once per session
with only a bounded lane tag, and coalesces a resend starting at one second, doubling to eight seconds
until the lane drains.
No structure frame is larger than `MAX_FRAME_BYTES` of JSON text (`packages/api-contract/roadmap-socket.json`,
under the server's inbound limit), but for a single entry that alone is. A frame holds whole stamps
and never part of one, and a replica's frames go out in stamp order (`sync/frames.js`). A subscriber
is answered with everything past the stamps it covers, so a stamp half-landed when a replica grafted
would be one whose other half that replica is never sent. An act too large for one frame is therefore
stamped once per frame where the write is made (`SyncSession.apply`, `stampedPerFrame`): the first
part keeps the act's stamp and each next takes the clock's next tick of the same millisecond, so the
parts are consecutive and the lattice and the saved record hold the stamps the frames go out under; a
reload in the middle of a send resends the same frames. A kind's own registers go in the first part.
Each frame takes its own seq, op row and feed line, and the act stays one unsent edit. A write keeps
the stamp it was made under for good: a retry, a reload and a resend send it as it was. One stamp
can still be too large for a frame — in a record a bundle before this rule saved, which stamped a
whole act once — and that stamp alone is cut across frames under its one stamp, as that bundle sent
it. What this leaves: a writer that goes away after some frames of an act have landed shows its peers
the act half-applied until it returns — after the first frame of a re-hue the kind wears its new hue
and the steps still to follow hold the old one — and a peer that re-hues the same kind in that window
moves only the steps it can see wearing it, so the steps the first writer paints afterwards end
outside the kind. A write that lands after a later-stamped write of the same replica — a refused
or held bank retried late — reaches a replica that subscribed in between and was away by the
position it reconnects with, not by its vector, which is already past the write's stamp.

The server drops the connection of a message past its limit without a word, and so may a proxy in
between. The judgement is of one frame, the lane's first, whatever is queued behind it: lost
unanswered with five sockets running, and heavier than `UNSENDABLE_FROM_BYTES` (64 KiB, a size no
healthy path refuses), it stands refused as unsendable and `roadmap-sync-unlandable` is reported
once. Its stamps are held unsent until Retry, and with them every other part of the acts it
carries, so no part of an act lands while another is held; every other write goes on, and Retry
sends the held frames as they were stamped. A lighter frame is sent again with every socket, without
limit, and a frame that is acknowledged is counted afresh. A connection that dies five times running
for another reason while such a frame is unanswered is judged the same way: with the socket dying
around a 142 KiB frame at a chance of 0.5 it was judged in 3 of 48 runs, at 0.9 in 26 of 48, and
Retry landed it each time.
Resends pause while refused, offline, rebaselining or closed. A late acknowledgement for a settled
frame is ignored. Socket closure and epoch adoption clear pending ping boundaries and delivery timers.

The server sends each subscriber a tree's live frames in seq order, its own included, and a writer's
ack after the broadcast of its frame. A subscribe delta goes out before every live frame past the seq
it reports, and a subscription's progress graft before every echo. A live frame joins only at `seq === lastSeq + 1`; already-seen
seqs are ignored, and a gap or failed join forces reconnect. A subscribe delta is the recovery path. Own structure echoes suppress repeated
local animation and await their acknowledgement before confirming.

Each send mints a new frame ID. Reconnection can therefore resend the same content under a new ID;
content convergence comes from idempotent join, not stable frame identity across restarts.

## Offline storage

`SyncStore` keeps `{frame, progress, lastSeq, confirmed, epochs, gestures}` in one IndexedDB record
per tree. Actor coverage is not persisted; the next subscribe reconstructs it. Saving is a read-join-put
in one transaction, so two tabs preserve each other's writes instead of replacing the record blindly. Join and put run
synchronously inside `get.onsuccess`, before IndexedDB can auto-commit.

`SyncSession` snapshots both lanes synchronously and queues a save before sending. It requests
persistent storage and exposes durability risk when persistence is unavailable. Corrupt stored
structure can reset that lane on load; invalid progress rows leave the valid marks intact.

Current limits:

- `apply()` and `markProgress()` do not await `persistNow()` before sending, so queuing a save does
  not establish that it committed before the socket write.
- `SyncStore.save()` returns transaction failures to its caller. Browser eviction, denied persistence
  and a failed local write remain loss risks.
- The primitive [golden corpus](../backend/test/golden/SCHEMA.md) runs only against its own
  restatement of the laws, not the shipped C++ and JavaScript lattices. Native test suites exercise
  those implementations independently; the corpus does not prevent cross-language drift.

## Private progress

Progress is a separate per-account lattice: one stamped `complete | none` register per node.
`none` is a value, so clearing a mark remains ordered against stale writes. Structural and progress
frames share a socket and clock but never an envelope; progress echoes go only to the same
account's connections.

Pending marks use the same per-register outbox rule against the confirmed progress baseline,
excluding identical stamps already in flight. Outbound marks carry only `{node, status, at}`;
`markedAt` stays in the stored replica and server receipts. A subscribe reply with `intent: graft`
replaces the entire confirmed progress baseline, so a server restore exposes lost marks as pending.
An acknowledgement confirms its exact sent marks. Progress echoes include the sending connection
and follow persistence, so own progress echoes also confirm. Invalid progress rows are skipped
individually in server frames, stored records and legacy drains; valid rows still join and unset
stamps stay off the wire. Each skip invokes the static `roadmap-sync-progress-mark` report with
only the progress lane tag. Shared Sentry deduplication and rate limits bound repeated reports.
Both lanes are stored together in IndexedDB.

The HLC orders marks; `markedAt` is the server receipt time displayed to readers. A device clock
can be arbitrarily old, so its HLC physical time is not a reliable date of completion. Postgres
progress upserts compare only numeric `(stamp_ms, stamp_counter)`; exact ties keep the stored row.
The browser also compares actors, so a conflicting actor tie can reopen the local mark on each
complete graft and produce one redundant resend per reconnect. Aligning this tie rule remains open.

## Implementation map

| Responsibility | Source |
|---|---|
| Shared primitives and stamp codec | `backend/products/roadmap/domain/Crdt.h`, `backend/platform/domain/Ids.h` |
| Server state, vectors and deltas | `backend/products/roadmap/domain/{LooseGraph,Legend,Subgraph}.*` |
| Server wire codec | `backend/products/roadmap/adapters/json/SubgraphJson.cpp` |
| Admission, acknowledgement and broadcasts | `backend/products/roadmap/adapters/ws/Collab.cpp`, `WsPresenceBus.cpp` |
| Browser state and gesture materialization | `web/src/products/roadmap/sync/lattice.js`, `materialize.js` |
| Browser connection and coverage | `web/src/products/roadmap/sync/SyncSession.js` |
| Browser storage | `web/src/products/roadmap/sync/SyncStore.js` |
| Private lane and refusal handling | `web/src/products/roadmap/sync/progressLattice.js`, `refusals.js` |
