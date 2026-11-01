# Web reports sync failures the way both phones do

**Status:** Not started. Web only; nothing visual changes.

**Context:** the phones count lost network and an ended live socket as events, file a real fault once per outage, and treat a bare or HTML 503 as a fault. Web files an Issue for every ended socket and nothing for a bare 503. So a web outage floods Sentry while a real edge failure stays silent: the opposite of the phones.

**Current implementation**
- `LiveChannel.ended()` calls `onFailure('live')` on every end, lost network and a refused upgrade included (`web/src/platform/sync/transport.js:170-175`). That reaches `captureError('sync-live')`, capped only at 30 a minute (`telemetry.js:10,27-30`). engine.md (`:2426-2428`) records this.
- A bare empty 503 parses to a null body and files nothing (`transport.js:30-37`; engine.md `:2424-2425`). 4cc961a4 fixed this on Android and iOS only.
- How web classifies a thrown fetch error (network loss or fault) was not checked for this task.

**Change**
- An ended or refused live socket is a `sync_engine` event with a bounded `failure_kind`, not an Issue, matching engine.md §9.6 as the phones read it.
- Lost network (offline, or a fetch that throws while `navigator.onLine` is false) is an event. A real fault files once per outage per operation.
- A bare or HTML 503 is a fault with one Issue per outage. A 503 in the server's envelope stays a refusal.
- Update engine.md's web notes in the same change.

**Done when**
- Unit tests cover an ended socket, lost network, a bare 503 and an envelope 503.
- On the local stack: with `/v1/sync/live` refused, web files no Issue, and one bounded event per open. With the edge returning a bare 503, web files one Issue for the outage.

**Depends on:** none. Tree: `web-sync-lost-network-not-an-issue`.
