# Journal sync binding

`platform/infra/SyncProducts` seals gym and journal into one catalog at registry version 6, minimum
version 4 (`packages/api-contract/sync/composition.json`), and `windmill_server` always serves it at
`/v1/sync`. Journal binds its two types and two commands independently, over the same rules on fakes
and Postgres: `page`, keyed by the local day, the `journalState` singleton, `journal.savePage` and
`journal.claimPage`. `journalState` is ranked and never establishes primary occupancy.
`documentStamp` is product data; future content clocks do not advance an engine envelope clock.

A page changes only through the two commands: an intent carrying a `page` delta is refused `invalid`.
Text replacement is internal to the commands, with nonempty outgoing heads archived even when the
body bytes repeat. A claim's `claimId` receipt replays a retry, and a changed raw payload under that
id is `claim-conflict`.

`PgJournal` stores `page` in `journal_page` and `journalState` in `journal_sync_state`, claim
receipts in `journal_claim_receipts` and each account's content clock in `journal_content_clock`.
Purging a scope deletes the account's pages, revisions, state, claim receipts, content clock and
adoption record. The production tables were adopted in place (engine Appendix D); `db/schema.sql`
builds that shape, and the adoption's record, `journal_sync_adoptions` and
`journal_page_revision.migration_id`, is never updated, and no server code reads it.

Revision pruning runs only when an admission archives a revision: each affected day keeps its
newest ten, then the account keeps its newest prefix bounded by 500 rows and 8 MiB, and nothing older
than 90 days. The domain suite runs the retention vectors (`journal/revisions.json`) over the pure
rule, and Postgres runs them over `PgJournalType`. The admission vectors (`journal/admit.json`) run
over fakes and Postgres, and Postgres round-trips both type stores. The client, content-clock and
claim-edit vectors belong to the client role.

`JournalFeed` wraps the engine's live feed: after each commit it publishes the change to the live
sockets, then hands every changed page to the `PageWatcher` (`EchoDerivations`) with its body's byte
length. A failure of either is reported under `sync.publish` and leaves the admission committed.
No server door admits a journal command; `JournalRepository` and the REST reads only read.
