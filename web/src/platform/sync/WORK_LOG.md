# Engine observations

Strict IndexedDB transactions and stable replica handles provide the durable baseline. Mutable
replica objects must be detached from the transaction's before-image: otherwise an in-place outbox
transition also changes the comparison baseline and suppresses its write. The rollback, resend and
restart tests exercise this boundary.

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
