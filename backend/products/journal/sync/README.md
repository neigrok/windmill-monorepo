# Journal sync binding

The v4 composition seals gym and journal together at `platform/infra/SyncProducts`. Journal binds
its two types and two commands independently, over the same rules on fakes and Postgres.
`journalState` is ranked and never establishes primary occupancy. `documentStamp` is product data;
future content clocks do not advance an engine envelope clock. Text replacement is internal to
commands, with nonempty outgoing heads archived even when the body bytes repeat.

`db/journal_sync.sql` adopts existing tables only in the isolated sync test database. Backfill freezes
original revision tuple order before envelope updates, reserves historical revision numbers, numbers
page heads by day and derives retired first-run state for written accounts. Immutable markers retain
M, policy, manifest, frozen source and precise receipt times. Independent auditing compares those
inputs with candidate envelopes, heads, receipts and projections. Migration sends no watcher work.

Revision pruning runs only on insertion: affected-day newest ten, then the account's newest prefix
bounded by 500 rows and 8 MiB, then the 90-day cutoff. PostgreSQL executes all migration and
retention vectors and round trips both TypeStores. Client/content-clock/claim-edit vectors belong to
the client role; generic supersede is already covered by that role's commit claim.

The unmounted REST intent builder delegates normalization to the existing page parser and passes
the caller's content stamp through unchanged. Journal REST retains its current repository and response contract. `/v1/sync` remains unmounted in
the production binary. Production adoption, shared write freeze and admitted REST writers require
the rollout and restored-production gates in engine Appendix D; this binding enables no rollout.
