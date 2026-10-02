# Journal sync binding

The v4 composition seals gym and journal together at `platform/infra/SyncProducts`. Journal binds
its two types and two commands independently, over the same rules on fakes and Postgres.
`journalState` is ranked and never establishes primary occupancy. `documentStamp` is product data;
future content clocks do not advance an engine envelope clock. Text replacement is internal to
commands, with nonempty outgoing heads archived even when the body bytes repeat.

`db/journal_sync.sql` adds the in-place adoption schema, applied after `schema.sql` during the shared cutover and in the isolated sync test database. Backfill freezes
original revision tuple order before envelope updates, reserves historical revision numbers, numbers
page heads by day and derives retired first-run state for written accounts. Immutable markers retain
M, policy, manifest, frozen source and precise receipt times. Independent auditing compares those
inputs with candidate envelopes, heads, receipts and projections. Migration sends no watcher work.

Revision pruning runs only on insertion: affected-day newest ten, then the account's newest prefix
bounded by 500 rows and 8 MiB, then the 90-day cutoff. PostgreSQL executes all migration and
retention vectors and round trips both TypeStores. Client/content-clock/claim-edit vectors belong to
the client role; generic supersede is already covered by that role's commit claim.

`JOURNAL_ENGINE_WRITES` defaults off. Enabled, `PageService` delegates normalized REST saves to
`JournalDoor`, which uses server-origin `ServerCall`, captures the winner under the scope lock,
and publishes `JournalFeed` only after commit. Internal claim and ranked-state methods use the same
door and add no REST endpoint. The old SQL save is disabled with the engine switch on. Incomplete
history or absent adoption schema refuses `503 journal-not-adopted` without creating an empty scope.
Fresh accounts need no migration marker; their subsequent admitted rows reconcile against their
scope seq and digest.

`JOURNAL_WRITE_FREEZE` defaults off and refuses journal mutations with `503 journal-frozen`.
Echo derivations, repair sweeps and nudge sweeps are quiescent; the diagnostic read skips vendor
work while frozen. REST reads retain their existing projections. Switches-off HLC-since reads use
the original three-column ordering and compare byte-for-byte with origin/main; engine reads add
the day tie-break for equal-HLC cohorts. Both frozen migration snapshots use that target engine
read ordering and compare every response byte. `SYNC_ENABLED` defaults off and mounts `/v1/sync`
over the shared gym + journal catalog when enabled. Shared gym/journal adoption and restored-production
gates live in `deploy/gym-migration/README.md` and engine Appendix D.
