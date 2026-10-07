# Engine observations

Strict IndexedDB transactions and stable replica handles provide the durable baseline. Mutable
replica objects must be detached from the transaction's before-image: otherwise an in-place outbox
transition also changes the comparison baseline and suppresses its write. The rollback, resend and
restart tests exercise this boundary.

Store schema compatibility belongs to the IndexedDB upgrade transaction: migrating every replica's
cache generations there preserves control rows and permits a complete retry after abort. The native
browser migration test covers both completion and failure after the first migrated row.

An IndexedDB request's success does not finish its transaction; closing the connection then can leave
an upgrade blocked until that transaction completes. Migration fixtures use transaction completion as
their read barrier. Rejecting a blocked open cannot cancel its native request, so the store abandons
later upgrades and closes late successful connections. Native lifecycle regressions also check that
aborted upgrades close, retries retain every row, and version changes release all open stores.

The domain kit's nesting guard covers the synchronous execution context across runner instances and
checks before queueing storage work. Holding it across the outer Promise would mistake independent
queued actions for nested calls; checking only inside a queued transaction lets an inner write escape
the outer fault. Persisted run/save regressions wait for both outcomes and reopen the device store.

First-tab detection needs a short registration lock around `locks.query()` and acquisition of the
shared `wm-tab` lock. Querying independently in simultaneous tab starts can designate two first
tabs and release a current Undo window. Delayed push replies must also match their request's wire
replica ID, even though storage retains the same replica handle.

Writer transactions hydrate control records and explicitly selected row keys/scopes, with a type
index for governing records. Row generations keep staging swaps and cache removal independent of
cache size. Queue-to-durability timings are measured; 128-key cleanup batches bound storage work.
The observer hydrates only the scopes it needs after boot and may still do work proportional to
an observed scope. This work happens in a readonly transaction after the writer commits.

Persisted replay exercises the full fault inventory with a per-seed coverage floor. Real Chromium
checks close/crash lock handoff, BroadcastChannel observations and rollback across renderer death.
Active replica events follow durable state publication. A surviving tab therefore announces a
committed transition even when the leader dies before its BroadcastChannel notification; the real
renderer-crash test exercises this boundary. The isolated production-backend replay checks gym and journal against server rows and digests.
Nightly scheduling of that replay needs a workflow change outside web territory.

B2 shell: the session owner opens the engine before auth reconciliation, presents pinned room
Add/Discard and sign-out Keep/Discard, and retries cookie cleanup from durable metadata after an
offline finish or process death. React exposes the two agreed hooks. The worker precaches the build's
asset manifest and warms transformed modules in development, with a bounded navigation fallback.
The Node test runner discovers files explicitly and uses the Node 20-compatible test API; the
isolated browser fixture mounts before Vite's HTML fallback so it cannot accidentally boot the app.

B2 journal: pages, search and year reads use durable replica observations. Anonymous documents
supersede daily claim snapshots; bound edits behind a frozen claim remain in device rows until its
result and complete covering pull reconcile them. Source-key digests and imported data commit
atomically before localStorage deletion. Unowned legacy pages remain quarantined. A browser-only
fetch receiver failure was found by the local-stack gate and now has a regression test. Development
module responses vary by Origin; static cache matching ignores that header while APIs are excluded.
Refused journal documents remain visible from durable notices after reload; a corrected save retires
the old notice in the same transaction. Shell warming refreshes the build manifest on later deploys,
and development modules refresh online before falling back to their cached URL offline.
The early-backend-exit acceptance check found a listener-startup cleanup race: cleanup stops by port
and also terminates its owned child if it has not started listening. The database is dropped even
when another cleanup step fails. First-run scale retirement follows an answer/dismissal; imports
retire all four fields for existing writers.

R118 metadata stays in server-written registers, including immutable routine creation snapshots;
projections preserve admission times independently of later reorder writes. Command predictions
stamp removals dead and preserve keyed presence when it is omitted. A command carrying an earlier
prediction's life is dependent on its source: refusal and Undo fold that command while retaining
unrelated intent deltas. Persisted regressions cover both folds across restart.

Reference parity checks all 24 core/client ports byte for byte after exact encoding-shim substitutions.
The shared corpus covers serial overlays, keyed prediction presence, and dependent commands on Undo
and refusal. Swift and Kotlin retain predicted serials in their stored outboxes and views. The copied
files differ only in their encoding calls/imports and the omitted registry file loader. Browser-only
modules remain outside the copied core/client inventory.

Predicted deletes validate supplied serial names and values before emitting only death and born.
The shared corpus checks that malformed serials leave the whole device unchanged and nothing to push.

Epoch recovery and authenticated success results commit together. Old acknowledgements replay in
commit order before later work; without them, recovery records known successful results and product
receipts before re-identifying. Shared cases cover both reconnect orders, command birth remapping
and malformed conflicts. Persisted browser checks retain ordered replay across restart and report
invalid recovery envelopes as transport failures.

A command retains the source and resolved identity of each write map, even without a prediction.
Replay can then move a delete of a joined session to the session recreated by the server. Legacy
predictions recover unambiguous targets; unresolved targets keep affected work in a notice.
Retained commands that shared a resolved target also rebind their source arguments to it, so a
later replay cannot split one joined session into several recreated sessions before its delete.
Account-owned proposal apply receipts survive removals so a successful removal can replay without
becoming a durable refusal.

Networking checks online state and leadership after awaited storage reads as well as before request
planning. A push or pull paused on its writer cannot start a new request after going offline;
deliberate cancellation emits no transport failure and retains numbered work for reconnect.
Closing after a durable write may abandon its publication read; that shutdown emits no storage
failure. Reopening still recovers the committed work, while an active publication failure reports.
